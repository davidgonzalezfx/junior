// lib/agent-runtime.ts — the service worker's in-memory agent stack (plan §5.2
// items 2, 5, 6): PortRouter + PanelApprovalBroker + AgentLoop + work overlay +
// task status, wired exactly once per SW lifetime. The background only feeds
// chrome events into it. Kept out of the entrypoint so tests can boot the REAL
// composition, throw it away (what an MV3 suspension does to every object in
// here), and boot a fresh one over the same browser storage.
import type { ApprovalDecision, BrowserAction, QueueItem } from "@junior/protocol";
import { AgentLoop, mirrorAsk } from "./agent-loop";
import { executeAction, type ExecuteOutcome, type ExecutorEnv } from "./executors";
import { PanelApprovalBroker } from "./panel-approvals";
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
}

export interface AgentRuntime {
  readonly router: PortRouter;
  readonly broker: PanelApprovalBroker;
  readonly loop: AgentLoop;
  readonly overlay: WorkOverlayController;
  readonly taskStatus: TaskStatusTracker;
  /** browser.runtime.onConnect landing pad. */
  connect(port: PortLike): void;
  /** browser.runtime.onMessage landing pad (overlay content-script messages). */
  handleContentMessage(msg: unknown, sender: SenderLike | undefined): void;
  /** Kill path (overlay ✕ / stuck agent). */
  cancelTask(): Promise<void>;
  /** Stop the loop (teardown). */
  stop(): void;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const now = deps.now ?? Date.now;
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
  const broker = new PanelApprovalBroker(router, now);

  // §5.2 item 6: on agent activity the working tab gets the overlay; idle hides
  // it. The overlay's Pause button comes back through onOverlayAction → the
  // loop's local pause; the loop's onPausedChange re-syncs the overlay + panel.
  const syncOverlay = async (state: "idle" | "working" | "awaiting_approval") => {
    if (state === "idle") {
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
    execute: (action: BrowserAction) =>
      executeAction(action, deps.agentEnv, {
        ask: mirrorAsk(broker, async (domain) => {
          await addSiteGrant(domain);
        }),
        granted: async (pageUrl) => grantCovers(await getSiteGrants(), pageUrl),
      }),
    ask: broker,
    onStatus: (state, detail) => {
      router.broadcast(taskStatus.update(state, detail));
      void syncOverlay(state).catch(() => null);
    },
    onPausedChange: (paused) => {
      router.broadcast(taskStatus.update(paused ? "paused" : "idle"));
      void overlay.setPaused(paused).catch(() => null);
    },
    // A dead bridge never sends "idle" again — clear the overlay so it can't
    // outlive the task; the panel's red status dot tells the rest.
    onBridgeError: () => {
      void overlay.hide().catch(() => null);
    },
    now,
  });
  loop.start();

  // Crash recovery: hide any overlay an earlier (killed) SW left showing — a
  // fresh SW has no active task, so hiding is always safe.
  void overlay.recoverAfterRestart().catch(() => null);

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
    connect(port) {
      if (!router.attach(port)) return;
      // init_state once, immediately on connect (Autono background.js:5225), then
      // the task's CURRENT state — a panel opened mid-task missed every broadcast.
      void deps.permissionMode().then((permissionMode) => {
        router.broadcast({ type: "init_state", agentActive: loop.active, permissionMode });
        router.broadcast(taskStatus.snapshot());
      });
    },
    handleContentMessage: (msg, sender) => overlay.handleContentMessage(msg, sender),
    cancelTask,
    stop: () => loop.stop(),
  };
}
