// Service worker (plan §5.2): M2-2 pairing + M3-3 agent loop, Port router and
// approval cards. The SW is the composition root — every capability lives in a
// tested lib module; this file only wires chrome events to them.
import { executeAction, defaultEnv } from "@/lib/executors";
import { AgentLoop, mirrorAsk } from "@/lib/agent-loop";
import { PortRouter } from "@/lib/port-router";
import { PanelApprovalBroker } from "@/lib/panel-approvals";
import { WorkOverlayController, defaultOverlayEnv } from "@/lib/work-overlay";
import {
  fetchNextAction,
  postActionResult,
  postApprovalDecision,
  postCancel,
} from "@/lib/bridge-client";
import { addSiteGrant, clearSiteGrants, getSiteGrants, grantCovers } from "@/lib/site-grants";
import { ensureToken, pairWithBridge } from "@/lib/pairing";
import { getToken, loadSettings, saveSettings } from "@/lib/settings";

export default defineBackground(() => {
  // MV3 wires nothing automatically: the toolbar icon opens the side panel via API.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("junior: setPanelBehavior failed", err));

  // §5.1: content scripts (untrusted contexts) must never read keys/history/token.
  // Port of Autono background.js:38 — defensive catch for older Chrome (<102).
  browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => null);

  /** §5.2 item 1: token + settings mirror + best-effort pairing. Idempotent, safe to rerun. */
  const pairIfNeeded = async (why: string) => {
    await ensureToken();
    await saveSettings({}); // materialize §4.1 defaults (bridgeUrl, permissionMode, …)
    const outcome = await pairWithBridge();
    console.log(`junior: pairing after ${why}: ${outcome.status}`);
  };

  browser.runtime.onInstalled.addListener((details) => {
    console.log(`junior: installed (${details.reason})`);
    void pairIfNeeded(`install (${details.reason})`).catch((err) =>
      console.error("junior: pairing failed", err),
    );
  });

  // Site grants are session-scoped (lib/site-grants.ts): a fresh browser session
  // starts without yesterday's "allow for this site".
  browser.runtime.onStartup.addListener(() => {
    void pairIfNeeded("browser startup").catch((err) =>
      console.error("junior: pairing failed", err),
    );
    void clearSiteGrants().catch(() => null);
  });

  // --- Port router + approval broker (§5.2 item 5) -----------------------------
  const router = new PortRouter({
    extensionId: browser.runtime.id,
    extensionOrigin: location.origin,
    onApprovalResponse: (msg) => broker.handleResponse(msg),
  });
  const broker = new PanelApprovalBroker(router);

  browser.runtime.onConnect.addListener((port) => {
    if (!router.attach(port)) return;
    // init_state once, immediately on connect (Autono background.js:5225).
    void loadSettings().then((settings) => {
      router.broadcast({
        type: "init_state",
        agentActive: loop.active,
        permissionMode: settings.permissionMode,
      });
    });
  });

  // --- Agent loop (§5.2 item 2) -------------------------------------------------
  const bridgeCall = async <T>(fn: (baseUrl: string, token: string) => Promise<T>): Promise<T> => {
    const { bridgeUrl } = await loadSettings();
    const token = await getToken();
    if (!token) throw new Error("junior: no bridge token yet");
    return fn(bridgeUrl, token);
  };

  // §5.2 item 6: on agent activity the working tab gets the overlay; idle hides
  // it. The overlay's Pause button comes back through onOverlayAction → the
  // loop's local pause; the loop's onPausedChange re-syncs the overlay + panel.
  const syncOverlay = async (state: "idle" | "working" | "awaiting_approval") => {
    if (state === "idle") {
      await overlay.hide();
      return;
    }
    const tab = await defaultEnv.getActiveTab();
    if (tab?.id !== undefined) await overlay.show(tab.id);
  };

  const overlay = new WorkOverlayController(defaultOverlayEnv, {
    onOverlayAction: (action) => {
      if (action === "cancel") void cancelTask();
      else loop.setPaused(action === "pause");
    },
  });

  const loop = new AgentLoop({
    poll: (timeoutMs) => bridgeCall((url, token) => fetchNextAction(url, token, timeoutMs)),
    postResult: (result) => bridgeCall((url, token) => postActionResult(url, token, result)),
    postDecision: async (decision) => {
      await bridgeCall((url, token) => postApprovalDecision(url, token, decision));
    },
    execute: (action) =>
      executeAction(action, defaultEnv, {
        ask: mirrorAsk(broker, async (domain) => {
          await addSiteGrant(domain);
        }),
        granted: async (pageUrl) => grantCovers(await getSiteGrants(), pageUrl),
      }),
    ask: broker,
    onStatus: (state, detail) => {
      router.broadcast({ type: "task_status", state, detail });
      void syncOverlay(state).catch(() => null);
    },
    onPausedChange: (paused) => {
      router.broadcast({ type: "task_status", state: paused ? "paused" : "idle" });
      void overlay.setPaused(paused).catch(() => null);
    },
    // M4-5: a dead bridge never sends "idle" again — clear the overlay so it
    // can't outlive the task; the panel's red status dot tells the rest.
    onBridgeError: () => {
      void overlay.hide().catch(() => null);
    },
  });
  loop.start();

  // M4-5 crash recovery: hide any overlay an earlier (killed) SW left showing.
  // Deferred past the declarations above; every wake finds either nothing or a
  // stale record — a fresh SW has no active task, so hiding is always safe.
  void overlay.recoverAfterRestart().catch(() => null);

  /** M4-5 kill path (overlay ✕ / stuck agent): deny everything in flight
   * bridge-side, close pending cards, drop the overlay. Fire-and-forget safe. */
  const cancelTask = async (): Promise<void> => {
    if (loop.isPaused) loop.setPaused(false); // a cancelled task resumes unpaused
    try {
      await bridgeCall((url, token) => postCancel(url, token));
    } catch {
      // Bridge down — nothing to cancel remotely; the loop's backoff handles it.
    }
    broker.cancelAll(); // open cards close with approval_resolved
    await overlay.hide().catch(() => null);
    router.broadcast({ type: "task_status", state: "idle" });
  };

  // Content-script one-shot messages (overlay_action / content_ready) — the
  // controller applies the port-router firewall before acting.
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    overlay.handleContentMessage(msg, sender);
  });
});
