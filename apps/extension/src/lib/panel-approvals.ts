// lib/panel-approvals.ts — SW-side approval broker (M3-3): raises approval cards
// over the PortRouter and awaits the panel's answer with the §4.3 default-deny
// window (120 s). One broker, many concurrent cards (the panel holds a Map keyed
// by id — Autono does the same, background.js:10103). The window is authoritative
// HERE: the card's countdown is display; a closed panel or a lapsed timer both
// resolve "deny" (§6.3-3), and the caller decides what a deny means.
import type { ApprovalRequest } from "@junior/protocol";
import type { ApprovalResponseMessage, PortRouter } from "./port-router";

/** Decision answer for an approval ask — mirrors ApprovalDecisionSchema.decision. */
export type ApprovalAnswer = "once" | "site" | "deny";

export interface ApprovalAsk {
  request(approval: ApprovalRequest, remainingMs: number): Promise<ApprovalAnswer>;
  hasListener(): boolean;
}

export class PanelApprovalBroker implements ApprovalAsk {
  private pending = new Map<
    string,
    {
      finish: (answer: ApprovalAnswer, by: "decision" | "timeout" | "no-panel") => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;

  constructor(
    private readonly router: Pick<PortRouter, "broadcast" | "hasListener">,
    private readonly now: () => number = Date.now,
  ) {}

  hasListener(): boolean {
    return this.router.hasListener();
  }

  /** Cards awaiting an answer (tests + teardown diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Show the card and wait. NEVER rejects: timeout and missing panel are "deny". */
  request(approval: ApprovalRequest, remainingMs: number): Promise<ApprovalAnswer> {
    if (!this.router.hasListener()) {
      // No panel can ever answer — resolve without waiting out the window
      // (bridge-side mirror: Dispatcher's no-panel immediate deny, §4.3).
      return Promise.resolve("deny");
    }
    const id = `local-${Date.now().toString(36)}-${this.seq++}`;
    const deadline = this.now() + Math.max(1_000, remainingMs);
    return new Promise((resolve) => {
      // finish only ever runs after `timer` is assigned below (deferred
      // execution — same shape as the bridge dispatcher's withTimeout).
      // by includes "no-panel" (M5-9 denyAllNoPanel) — the wire shape already
      // carried it; there's just never a panel connected to see it.
      const finish = (answer: ApprovalAnswer, by: "decision" | "timeout" | "no-panel") => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.router.broadcast({ type: "approval_resolved", id, by });
        resolve(answer);
      };
      const timer = setTimeout(() => finish("deny", "timeout"), deadline - this.now());
      this.pending.set(id, { finish, timer });
      this.router.broadcast({ type: "approval_request", id, approval, remainingMs });
    });
  }

  /** PortRouter.onApprovalResponse landing pad. Unknown/late ids are ignored. */
  handleResponse(msg: ApprovalResponseMessage): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    entry.finish(msg.decision, "decision");
  }

  /** Test/teardown seam — deny everything pending without firing the timers. */
  denyAll(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "decision");
  }

  /** M4-5 kill path (overlay ✕ / task cancel): resolve every pending card as
   * "deny" AND close it panel-side with the same approval_resolved broadcast a
   * timeout produces (by: "timeout" — policy default-deny, not a user decision). */
  cancelAll(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "timeout");
  }

  /** M5-9: the last panel port disconnected — nobody is left who could ever
   * answer, so waiting out the window only leaves a timer for an MV3 suspension
   * to lose (the real-Chrome hang). Resolve every pending card "deny" now,
   * closing cards with by: "no-panel" (§4.3 no-panel deny, the bridge mirror). */
  denyAllNoPanel(): void {
    for (const [, entry] of this.pending) entry.finish("deny", "no-panel");
  }
}
