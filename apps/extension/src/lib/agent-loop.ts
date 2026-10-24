// lib/agent-loop.ts — the SW agent client (plan §5.2 item 2, M3-3): a single
// long-poll loop over GET /api/agent/next-action while the bridge is configured,
// routing queue items to the executors and approval cards. Backoff 1 s → 30 s
// with jitter on failures (nextDelayMs); every poll doubles as the bridge's
// connected() ping. All I/O arrives via AgentLoopDeps so tests drive the REAL
// loop against stubs.
import type { ApprovalDecision, ApprovalRequest, BrowserAction, QueueItem } from "@junior/protocol";
import { registrableDomain } from "@junior/protocol";
import { nextDelayMs } from "./bridge-client";
import type { ApprovalAnswer, ApprovalAsk } from "./panel-approvals";
import type { ExecuteOutcome } from "./executors";

/** Long-poll window (bridge clamps 1–20 s; M1-2 default 15 s). */
export const POLL_TIMEOUT_MS = 15_000;

export interface AgentLoopDeps {
  /** One long-poll; throws when the bridge is unreachable or rejects the token. */
  poll(timeoutMs: number): Promise<QueueItem | null>;
  postResult(result: { id: string } & ExecuteOutcome): Promise<void>;
  postDecision(decision: ApprovalDecision): Promise<void>;
  execute(action: BrowserAction): Promise<ExecuteOutcome>;
  /** Raises a card in the panel; resolves with the user's answer or "deny". */
  ask: ApprovalAsk;
  onStatus?(state: "idle" | "working" | "awaiting_approval", detail?: string): void;
  now?: () => number;
  /** Injectable sleep — defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
}

export class AgentLoop {
  private running = false;
  private failures = 0;

  constructor(private readonly deps: AgentLoopDeps) {}

  start(): void {
    if (this.running) return; // single loop, ever (§5.2 item 2)
    this.running = true;
    void this.run();
  }

  stop(): void {
    this.running = false;
  }

  get active(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    const delay = this.deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (this.running) {
      try {
        const item = await this.deps.poll(POLL_TIMEOUT_MS);
        this.failures = 0;
        if (item) await this.handleItem(item);
      } catch {
        // Unreachable / 401 / 5xx — back off and retry; the status bar tells the
        // user the bridge is down, the loop never crashes (plan §5.2 cadence).
        await delay(nextDelayMs(this.failures++));
      }
    }
  }

  private async handleItem(item: QueueItem): Promise<void> {
    if (item.kind === "approval") {
      await this.handleApproval(item.id, item.approval, item.timeoutMs, item.createdAt);
      return;
    }
    this.deps.onStatus?.("working", `${item.action.kind} ${actionTargetOf(item.action)}`);
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.deps.execute(item.action);
    } catch (e) {
      outcome = { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
    try {
      await this.deps.postResult({ id: item.id, ...outcome });
    } catch {
      // The future will time out bridge-side; nothing more the SW can do.
    }
    this.deps.onStatus?.("idle");
  }

  private async handleApproval(
    id: string,
    approval: ApprovalRequest,
    timeoutMs: number,
    createdAt: number,
  ): Promise<void> {
    const now = this.deps.now ?? Date.now;
    // Queue latency counts against the card's window; keep ≥ 1 s for the user.
    const remainingMs = Math.max(1_000, timeoutMs - (now() - createdAt));
    this.deps.onStatus?.("awaiting_approval");
    const answer = await this.deps.ask.request(approval, remainingMs);
    try {
      await this.deps.postDecision({ id, decision: answer });
    } catch {
      // Bridge went away mid-card; the approval future times out bridge-side.
    }
    this.deps.onStatus?.("idle");
  }
}

/** §4.3 approval window for locally-raised (mirror) cards — matches the bridge. */
export const APPROVAL_WINDOW_MS = 120_000;

/**
 * The executor runner's ask() seam (guard-mirror "ask" verdicts): show the SAME
 * card flow and persist "site" grants under the approval's registrable domain.
 * Grant CONSUMPTION happens in executeAction (granted input on the check fns).
 * Standalone (not on AgentLoop) so the background can wire it without a
 * use-before-init reference to the loop itself.
 */
export function mirrorAsk(
  ask: ApprovalAsk,
  onGrantSite: (domain: string) => Promise<void>,
): (approval: ApprovalRequest) => Promise<ApprovalAnswer> {
  return async (approval) => {
    const answer = await ask.request(approval, APPROVAL_WINDOW_MS);
    if (answer === "site") {
      const domain =
        approval.siteDomain ??
        (() => {
          try {
            return registrableDomain(new URL(approval.pageUrl).hostname);
          } catch {
            return "";
          }
        })();
      if (domain) await onGrantSite(domain);
    }
    return answer;
  };
}

function actionTargetOf(action: BrowserAction): string {
  if (action.kind === "navigate") return action.url;
  if (action.kind === "click" || action.kind === "type") return action.target;
  if (action.kind === "read_page") return action.mode;
  return "";
}
