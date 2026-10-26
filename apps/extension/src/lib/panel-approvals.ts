// lib/panel-approvals.ts — SW-side approval broker: raises approval cards
// over the PortRouter and awaits the panel's answer with the §4.3 default-deny
// window (120 s). One broker, many concurrent cards (the panel holds a Map keyed
// by id — Autono does the same, background.js:10103). The window is authoritative
// HERE: the card's countdown is display; a closed panel or a lapsed timer both
// resolve "deny" (§6.3-3), and the caller decides what a deny means.
import type { ApprovalRequest } from "@junior/protocol";
import {
  cardIdFromAlarm,
  type ApprovalLedger,
  type ApprovalOrigin,
  type PendingApprovalRecord,
} from "./approval-ledger";
import type { ApprovalResponseMessage, ApprovalSyncMessage, PortRouter } from "./port-router";

/** Decision answer for an approval ask — mirrors ApprovalDecisionSchema.decision. */
export type ApprovalAnswer = "once" | "site" | "deny";

/** How a card closed; "interrupted" = its raising SW died mid-action. */
export type ResolvedBy = "decision" | "timeout" | "no-panel" | "interrupted";

export interface ApprovalAsk {
  /** `origin` says where the answer goes if this SW dies before it arrives;
   * without it the card is in-memory only. */
  request(
    approval: ApprovalRequest,
    remainingMs: number,
    origin?: ApprovalOrigin,
  ): Promise<ApprovalAnswer>;
  hasListener(): boolean;
}

/** MV3 suspension backstop (lib/approval-ledger.ts). */
export interface BrokerPersistence {
  ledger: ApprovalLedger;
  /** Deliver the answer of a card whose raising SW died — nobody awaits it, so
   * it goes straight to the bridge. Must not throw. */
  settleOrphan(
    record: PendingApprovalRecord,
    answer: ApprovalAnswer,
    by: ResolvedBy,
  ): Promise<void>;
}

interface PendingEntry {
  approval: ApprovalRequest;
  deadline: number;
  record: PendingApprovalRecord | undefined;
  finish: (answer: ApprovalAnswer, by: ResolvedBy) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PanelApprovalBroker implements ApprovalAsk {
  private pending = new Map<string, PendingEntry>();
  private seq = 0;
  /** Until recover() finishes, panel answers wait for it (a reconnecting panel
   * can answer before the woken SW has re-read its cards). */
  private ready: Promise<void> = Promise.resolve();
  private recovered = true;

  constructor(
    private readonly router: Pick<PortRouter, "broadcast" | "hasListener">,
    private readonly now: () => number = Date.now,
    private readonly persistence?: BrokerPersistence,
  ) {}

  hasListener(): boolean {
    return this.router.hasListener();
  }

  /** Cards awaiting an answer (tests + teardown diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Show the card and wait. NEVER rejects: timeout and missing panel are "deny". */
  request(
    approval: ApprovalRequest,
    remainingMs: number,
    origin?: ApprovalOrigin,
  ): Promise<ApprovalAnswer> {
    if (!this.router.hasListener()) {
      // No panel can ever answer — resolve without waiting out the window
      // (bridge-side mirror: Dispatcher's no-panel immediate deny, §4.3).
      return Promise.resolve("deny");
    }
    const id = `local-${Date.now().toString(36)}-${this.seq++}`;
    const createdAt = this.now();
    const deadline = createdAt + Math.max(1_000, remainingMs);
    const record =
      origin && this.persistence ? { id, approval, createdAt, deadline, origin } : undefined;
    return new Promise((resolve) => {
      this.open(id, approval, deadline, record, (answer) => resolve(answer));
      this.router.broadcast({ type: "approval_request", id, approval, remainingMs });
    });
  }

  /**
   * SW wake: re-derive the cards a dead SW left in the ledger. Expired cards are
   * denied to the bridge (by: "timeout"); mirror cards always are (by:
   * "interrupted" — the execution that raised them died with the SW); live wire
   * cards are adopted with their ORIGINAL deadline and their answer goes to the
   * bridge directly. Idempotent per card; never rejects.
   */
  recover(): Promise<void> {
    const persistence = this.persistence;
    if (!persistence) return Promise.resolve();
    this.recovered = false;
    this.ready = (async () => {
      const settle = async (rec: PendingApprovalRecord, answer: ApprovalAnswer, by: ResolvedBy) => {
        try {
          await persistence.settleOrphan(rec, answer, by);
        } catch {
          // Bridge unreachable — its own approval window default-denies.
        }
      };
      for (const rec of await persistence.ledger.list()) {
        if (this.pending.has(rec.id)) continue;
        const by: ResolvedBy | null =
          rec.origin.kind === "mirror"
            ? "interrupted"
            : this.now() >= rec.deadline
              ? "timeout"
              : null;
        if (by !== null) {
          await persistence.ledger.drop(rec.id);
          await settle(rec, "deny", by);
          continue;
        }
        this.open(rec.id, rec.approval, rec.deadline, rec, (answer, how) => {
          void settle(rec, answer, how);
        });
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.recovered = true;
      });
    return this.ready;
  }

  /** chrome.alarms.onAlarm landing pad: a card deadline alarm fired (possibly
   * the event that woke this SW). Never fires before the deadline it was armed
   * for; if it somehow does, it is re-armed. Non-card alarms are ignored. */
  async handleAlarm(name: string): Promise<void> {
    const id = cardIdFromAlarm(name);
    if (id === null) return;
    await this.ready;
    const entry = this.pending.get(id);
    if (!entry) {
      await this.persistence?.ledger.drop(id); // stale: the card closed already
      return;
    }
    if (this.now() >= entry.deadline) entry.finish("deny", "timeout");
    else if (entry.record) await this.persistence?.ledger.save(entry.record, this.now());
  }

  /** The true pending-card set, for a (re)connecting panel: it replaces the
   * panel's cards wholesale, so cards a dead SW raised cannot linger as ghosts. */
  syncMessage(): ApprovalSyncMessage {
    const now = this.now();
    return {
      type: "approval_sync",
      cards: [...this.pending].map(([id, e]) => ({
        id,
        approval: e.approval,
        remainingMs: Math.max(0, e.deadline - now),
      })),
    };
  }

  private open(
    id: string,
    approval: ApprovalRequest,
    deadline: number,
    record: PendingApprovalRecord | undefined,
    onAnswer: (answer: ApprovalAnswer, by: ResolvedBy) => void,
  ): void {
    // finish only ever runs after `timer` is assigned below (deferred
    // execution — same shape as the bridge dispatcher's withTimeout).
    const finish = (answer: ApprovalAnswer, by: ResolvedBy) => {
      clearTimeout(timer);
      if (!this.pending.delete(id)) return;
      if (record) void this.persistence?.ledger.drop(id);
      this.router.broadcast({
        type: "approval_resolved",
        id,
        by: by === "interrupted" ? "timeout" : by,
      });
      onAnswer(answer, by);
    };
    const timer = setTimeout(() => finish("deny", "timeout"), Math.max(0, deadline - this.now()));
    this.pending.set(id, { approval, deadline, record, finish, timer });
    if (record) void this.persistence?.ledger.save(record, this.now());
  }

  /** PortRouter.onApprovalResponse landing pad. Unknown/late ids are ignored. */
  handleResponse(msg: ApprovalResponseMessage): void {
    if (!this.recovered) {
      void this.ready.then(() => this.handleResponse(msg));
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    entry.finish(msg.decision, "decision");
  }

  /** Test/teardown seam — deny everything pending without firing the timers. */
  denyAll(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "decision");
  }

  /** Kill path (overlay ✕ / task cancel): resolve every pending card as
   * "deny" AND close it panel-side with the same approval_resolved broadcast a
   * timeout produces (by: "timeout" — policy default-deny, not a user decision). */
  cancelAll(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "timeout");
  }

  /** The last panel port disconnected — nobody is left who could ever
   * answer, so waiting out the window only leaves a timer for an MV3 suspension
   * to lose (the real-Chrome hang). Resolve every pending card "deny" now,
   * closing cards with by: "no-panel" (§4.3 no-panel deny, the bridge mirror). */
  denyAllNoPanel(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "no-panel");
  }

  /** What an MV3 suspension does to this object: every in-memory wait is gone,
   * nothing is settled, storage is untouched (teardown/test seam). */
  abandon(): void {
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
  }
}
