// @junior/bridge/dispatcher/queue — action queue + futures (plan §4.3).
// TS port of modelbridge-clone/server/routes_mcp.py:139–231 (dispatch_browser_action,
// get_pending_actions long-poll, action_result future resolution), with approvals
// riding the same queue (§4.3: no panel connected or timeout ⇒ deny — Autono
// requestExternalActionApproval, background.js:4799–4813, at 120 s instead of 60 s).
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalQueueItem,
  ApprovalRequest,
  ActionResult,
  BrowserAction,
  QueueItem,
} from "@junior/protocol";
import { APPROVAL_TIMEOUT_MS, approvalDenial } from "./approvals.js";

/** Resolvable promise handle — the futures map holds one per in-flight item. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** FIFO queue whose get() long-polls: a buffered item returns at once, otherwise the
 * caller waits for the next push up to `timeoutMs` (null on timeout). */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const wake = this.waiters.shift();
    if (wake) wake(item);
    else this.items.push(item);
  }

  get(timeoutMs: number): Promise<T | null> {
    const buffered = this.items.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref(); // an abandoned long-poll must never hold the process open
      const wake = (item: T) => {
        clearTimeout(timer);
        resolve(item);
      };
      this.waiters.push(wake);
    });
  }

  /** Drop every buffered item matching pred (already handed to a poller = gone). */
  remove(pred: (item: T) => boolean): void {
    this.items = this.items.filter((it) => !pred(it));
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}

/** Guard seam (§4.3: guard.check may deny outright or demand an approval first).
 * The dispatcher only depends on this interface. */
export type GuardVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approval"; approval: ApprovalRequest };

export interface ActionGuard {
  check(action: BrowserAction): GuardVerdict | Promise<GuardVerdict>;
  /** Called with the user's decision so "site" grants persist per session. */
  onApprovalDecision?(action: BrowserAction, decision: ApprovalDecision): void;
}

export interface DispatcherOptions {
  guard?: ActionGuard;
  /** Approval window before default-deny (tests shrink it; prod = 120 s). */
  approvalTimeoutMs?: number;
  /** Injectable clock for createdAt/connected() (tests). */
  now?: () => number;
}

/** §4.3: connected := the extension polled within the last 25 s. */
const BROWSER_FRESH_MS = 25_000;

export const DEFAULT_ACTION_TIMEOUT_MS = 120_000;

export class Dispatcher {
  private queue = new AsyncQueue<QueueItem>();
  private futures = new Map<string, Deferred<ActionResult>>();
  private approvals = new Map<string, Deferred<ApprovalDecision | null>>();
  private lastPing = 0;
  private readonly guard: ActionGuard | undefined;
  private readonly approvalTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: DispatcherOptions = {}) {
    this.guard = opts.guard;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** §4.3 — queue an action for the extension and await its result. */
  async dispatch(
    action: BrowserAction,
    timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  ): Promise<ActionResult> {
    const id = randomUUID();
    const verdict = this.guard ? await this.guard.check(action) : ({ kind: "allow" } as const);
    if (verdict.kind === "deny") return { id, status: "denied", error: verdict.reason };

    if (verdict.kind === "approval") {
      // Nobody connected to ask ⇒ deny now, never park the caller for 120 s.
      if (!this.connected()) return { id, status: "denied", error: approvalDenial("no-panel") };
      const decision = await this.requestApprovalItem(id, verdict.approval, this.approvalTimeoutMs);
      if (decision === null) return { id, status: "denied", error: approvalDenial("timeout") };
      this.guard?.onApprovalDecision?.(action, decision);
      if (decision.decision === "deny") {
        return { id, status: "denied", error: approvalDenial("user") };
      }
    }

    const fut = deferred<ActionResult>();
    this.futures.set(id, fut);
    this.queue.push({ id, kind: "action", action, createdAt: this.now(), timeoutMs });
    const res = await withTimeout(fut.promise, timeoutMs);
    this.futures.delete(id);
    if (res !== null) return res;
    // Timed out: drop the item if still buffered. A poller already holding it may
    // still execute; its late action-result finds no future and is ignored.
    this.queue.remove((it) => it.kind === "action" && it.id === id);
    return {
      id,
      status: "error",
      error: this.connected()
        ? `Timed out after ${timeoutMs} ms`
        : "Browser extension is not connected — open the Junior panel to connect it",
    };
  }

  /** GET /api/agent/next-action — extension long-poll; every poll is the ping. */
  nextAction(waitMs: number): Promise<QueueItem | null> {
    this.touch();
    return this.queue.get(waitMs);
  }

  /** POST /api/agent/action-result — resolves the future a dispatch is awaiting. */
  resolveResult(result: ActionResult): boolean {
    const fut = this.futures.get(result.id);
    if (!fut) return false; // unknown id or already timed out → {delivered: false}
    this.futures.delete(result.id);
    this.touch(); // ModelBridge refreshes last_browser_ping here too
    fut.resolve(result);
    return true;
  }

  /** POST /api/agent/approval-response — resolves a pending approval item. */
  resolveApproval(decision: ApprovalDecision): boolean {
    const fut = this.approvals.get(decision.id);
    if (!fut) return false;
    this.approvals.delete(decision.id);
    this.touch();
    fut.resolve(decision);
    return true;
  }

  /** Record extension liveness without consuming from the queue (tests, /api/status). */
  ping(): void {
    this.touch();
  }

  /** Standalone approval with no action in flight — SessionGuard.checkPage's ask path
   * (§4.4). Same default-deny rules as dispatch-time approvals: nobody connected or
   * the window lapses ⇒ "deny". */
  async requestApproval(
    approval: ApprovalRequest,
    timeoutMs = this.approvalTimeoutMs,
  ): Promise<"once" | "site" | "deny"> {
    if (!this.connected()) return "deny";
    const decision = await this.requestApprovalItem(randomUUID(), approval, timeoutMs);
    return decision?.decision ?? "deny";
  }

  /** §3 BridgeStatusSchema.browserConnected / §4.3 MCP errors. */
  connected(): boolean {
    return this.now() - this.lastPing < BROWSER_FRESH_MS;
  }

  /** §3 BridgeStatusSchema.queueDepth — items buffered, not yet handed to a poller. */
  get queueDepth(): number {
    return this.queue.size;
  }

  /** Crash/shutdown/cancel path — deny everything in flight, drop everything
   * queued. Returns what was killed so POST /api/agent/cancel can report it. */
  dispose(reason: string): { actions: number; approvals: number } {
    const actions = this.futures.size;
    for (const [id, fut] of this.futures) {
      fut.resolve({ id, status: "denied", error: reason });
    }
    this.futures.clear();
    const approvals = this.approvals.size;
    for (const fut of this.approvals.values()) fut.resolve(null); // → timeout-style deny
    this.approvals.clear();
    this.queue.clear();
    return { actions, approvals };
  }

  private async requestApprovalItem(
    id: string,
    approval: ApprovalRequest,
    timeoutMs: number,
  ): Promise<ApprovalDecision | null> {
    const fut = deferred<ApprovalDecision | null>();
    this.approvals.set(id, fut);
    const item: ApprovalQueueItem = {
      id,
      kind: "approval",
      approval,
      createdAt: this.now(),
      timeoutMs,
    };
    this.queue.push(item);
    const decision = await withTimeout(fut.promise, timeoutMs);
    if (decision !== null) return decision;
    // Lapsed (default deny): drop the future and the card if still buffered, as the
    // action path does — otherwise a reconnecting panel gets the stale card and a
    // late approve reports delivered:true for a permission already denied.
    this.approvals.delete(id);
    this.queue.remove((it) => it.kind === "approval" && it.id === id);
    return null;
  }

  private touch(): void {
    this.lastPing = this.now();
  }
}

/** Resolves null when `p` is still pending after `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer); // the executor ran synchronously — timer is assigned
  }
}
