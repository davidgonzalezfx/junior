// lib/agent-runtime.ts — the service worker's in-memory agent stack (plan §5.2
// items 2, 5, 6): PortRouter + PanelApprovalBroker + AgentLoop + work overlay +
// task status, wired exactly once per SW lifetime. The background only feeds
// chrome events into it. Kept out of the entrypoint so tests can boot the REAL
// composition, throw it away (what an MV3 suspension does to every object in
// here), and boot a fresh one over the same browser storage.
// Suspension survival (review.md §3.3 + §4.1): pending cards and the paused
// flag live in storage.session with an alarm per card deadline
// (lib/approval-ledger.ts); `ready` re-derives both before the loop polls.
import {
  USER_DENIED_TEXT,
  type ApprovalDecision,
  type BrowserAction,
  type QueueItem,
} from "@junior/protocol";
import { AgentLoop, mirrorAsk } from "./agent-loop";
import {
  createSessionLedger,
  sessionPauseStore,
  type ApprovalLedger,
  type PauseStore,
  type PendingApprovalRecord,
} from "./approval-ledger";
import { executeAction, type ExecuteOutcome, type ExecutorEnv } from "./executors";
import { PanelApprovalBroker, type ApprovalAnswer, type ResolvedBy } from "./panel-approvals";
import { PortRouter, type PortLike, type SenderLike } from "./port-router";
import { addSiteGrant, getSiteGrants, grantCovers } from "./site-grants";
import { TaskStatusTracker } from "./task-status";
import { WorkOverlayController, type OverlayEnv } from "./work-overlay";

export interface AgentRuntimeDeps {
  extensionId: string;
  extensionOrigin: string;
  bridge: {
    poll(timeoutMs: number): Promise<QueueItem | null>;
    postResult(result: { id: string } & ExecuteOutcome): Promise<void>;
    postDecision(decision: ApprovalDecision): Promise<void>;
    postCancel(): Promise<void>;
  };
  /** Executor env already bound to the agent's own tab (withAgentTab). */
  agentEnv: ExecutorEnv;
  overlayEnv: OverlayEnv;
  permissionMode(): Promise<string>;
  now?: () => number;
  /** Storage seams — default to chrome.storage.session (+ chrome.alarms). */
  ledger?: ApprovalLedger;
  pauseStore?: PauseStore;
}

/** A guard-mirror card's action died with the SW that was executing it. */
export const SW_RESTART_DENIAL =
  "BLOCKED_BY_POLICY: the extension restarted while this approval was pending — default deny. The action was not performed.";

export interface AgentRuntime {
  readonly router: PortRouter;
  readonly broker: PanelApprovalBroker;
  readonly loop: AgentLoop;
  readonly overlay: WorkOverlayController;
  readonly taskStatus: TaskStatusTracker;
  /** Resolves once state a suspended predecessor left behind is re-derived
   * (cards adopted or denied, pause restored); the loop polls only after. */
  readonly ready: Promise<void>;
  /** browser.runtime.onConnect landing pad. */
  connect(port: PortLike): void;
  /** chrome.alarms.onAlarm landing pad (card deadlines). */
  handleAlarm(alarm: { name: string }): Promise<void>;
  /** browser.runtime.onMessage landing pad (overlay content-script messages). */
  handleContentMessage(msg: unknown, sender: SenderLike | undefined): void;
  /** Kill path (overlay ✕ / stuck agent). */
  cancelTask(): Promise<void>;
  /** Stop the loop and drop in-memory waits (teardown). */
  stop(): void;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const now = deps.now ?? Date.now;
  const ledger = deps.ledger ?? createSessionLedger();
  const pauseStore = deps.pauseStore ?? sessionPauseStore;
  const taskStatus = new TaskStatusTracker(); // last state for (re)connecting panels
  const router = new PortRouter({
    extensionId: deps.extensionId,
    extensionOrigin: deps.extensionOrigin,
    onApprovalResponse: (msg) => broker.handleResponse(msg),
    // The panel is the only approver — once its port is gone nobody can ever
    // answer, so deny every pending card NOW (§4.3 no-panel ⇒ deny) instead of
    // leaving it on a timer an MV3 suspension would drop. The loop awaiting the
    // card wakes, posts the deny, and unwinds (overlay hidden via onStatus idle).
    onPanelDisconnected: () => broker.denyAllNoPanel(),
  });
  // A card whose raising SW died has no awaiting caller: its answer goes to
  // the bridge through the same endpoints the loop would have used.
  const settleOrphan = async (
    rec: PendingApprovalRecord,
    answer: ApprovalAnswer,
    by: ResolvedBy,
  ): Promise<void> => {
    if (rec.origin.kind === "wire") {
      const reason = answer !== "deny" ? undefined : by === "decision" ? "user" : by;
      await deps.bridge.postDecision({
        id: rec.origin.approvalId,
        decision: answer,
        ...(reason === undefined || reason === "interrupted" ? {} : { reason }),
      });
    } else {
      await deps.bridge.postResult({
        id: rec.origin.actionId,
        status: "denied",
        error: answer === "deny" && by === "decision" ? USER_DENIED_TEXT : SW_RESTART_DENIAL,
      });
    }
  };
  const broker = new PanelApprovalBroker(router, now, { ledger, settleOrphan });

  // §5.2 item 6: the agent tab shows the overlay while the agent works or
  // waits on a card, AND while paused — a paused overlay is the Resume button,
  // so it must not vanish when the in-flight action finishes. The overlay's
  // buttons come back through onOverlayAction → the loop's local pause; the
  // loop's onPausedChange re-syncs the overlay + panel.
  let activity: "idle" | "working" | "awaiting_approval" = "idle";
  const syncOverlay = async () => {
    if (activity === "idle" && !loop.isPaused) {
      await overlay.hide();
      return;
    }
    const tab = await deps.agentEnv.getActiveTab();
    if (tab?.id !== undefined) await overlay.show(tab.id);
  };

  const overlay = new WorkOverlayController(deps.overlayEnv, {
    onOverlayAction: (action) => {
      if (action === "cancel") void cancelTask();
      else loop.setPaused(action === "pause");
    },
  });

  const loop = new AgentLoop({
    poll: (timeoutMs) => deps.bridge.poll(timeoutMs),
    postResult: (result) => deps.bridge.postResult(result),
    postDecision: (decision) => deps.bridge.postDecision(decision),
    execute: (action: BrowserAction, itemId: string) =>
      executeAction(action, deps.agentEnv, {
        ask: mirrorAsk(
          broker,
          async (domain) => {
            await addSiteGrant(domain);
          },
          { kind: "mirror", actionId: itemId },
        ),
        granted: async (pageUrl) => grantCovers(await getSiteGrants(), pageUrl),
      }),
    ask: broker,
    onStatus: (state, detail) => {
      activity = state;
      // A finished action must not report "idle" over a pause.
      const shown = state === "idle" && loop.isPaused ? "paused" : state;
      router.broadcast(taskStatus.update(shown, detail));
      void syncOverlay().catch(() => null);
    },
    onPausedChange: (paused) => {
      void pauseStore.save(paused);
      router.broadcast(taskStatus.update(paused ? "paused" : activity));
      void overlay
        .setPaused(paused)
        .then(syncOverlay)
        .catch(() => null);
    },
    // A dead bridge never sends "idle" again — clear the overlay so it can't
    // outlive the task; the panel's red status dot tells the rest.
    onBridgeError: () => {
      void overlay.hide().catch(() => null);
    },
    now,
  });

  // Wake recovery, before the first poll. Card recovery starts synchronously so
  // a panel answer arriving first queues behind it instead of finding an empty
  // broker. The overlay an earlier (killed) SW left showing is hidden; a
  // restored pause or adopted card re-shows it.
  const cardsRecovered = broker.recover();
  const ready = (async () => {
    await overlay.recoverAfterRestart().catch(() => null);
    if (await pauseStore.load()) loop.setPaused(true);
    await cardsRecovered;
    if (broker.pendingCount > 0) {
      activity = "awaiting_approval";
      if (!loop.isPaused) router.broadcast(taskStatus.update("awaiting_approval"));
      await syncOverlay().catch(() => null);
    }
  })()
    .catch(() => undefined)
    .finally(() => loop.start());

  /** Deny everything in flight bridge-side, close pending cards, drop the
   * overlay. Fire-and-forget safe. */
  const cancelTask = async (): Promise<void> => {
    if (loop.isPaused) loop.setPaused(false); // a cancelled task resumes unpaused
    try {
      await deps.bridge.postCancel();
    } catch {
      // Bridge down — nothing to cancel remotely; the loop's backoff handles it.
    }
    broker.cancelAll(); // open cards close with approval_resolved
    await overlay.hide().catch(() => null);
    router.broadcast(taskStatus.update("idle"));
  };

  return {
    router,
    broker,
    loop,
    overlay,
    taskStatus,
    ready,
    connect(port) {
      if (!router.attach(port)) return;
      // init_state once on connect (Autono background.js:5225), then the task's
      // CURRENT state and the true card set — a panel opened mid-task missed
      // every broadcast, and one reconnecting to a woken SW holds ghosts.
      void ready
        .then(() => deps.permissionMode())
        .then((permissionMode) => {
          router.broadcast({ type: "init_state", agentActive: loop.active, permissionMode });
          router.broadcast(taskStatus.snapshot());
          router.broadcast(broker.syncMessage());
        });
    },
    handleAlarm: (alarm) => broker.handleAlarm(alarm.name),
    handleContentMessage: (msg, sender) => overlay.handleContentMessage(msg, sender),
    cancelTask,
    stop: () => {
      loop.stop();
      broker.abandon();
    },
  };
}
