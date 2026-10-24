// Service worker (plan §5.2): M2-2 pairing + M3-3 agent loop, Port router and
// approval cards. The SW is the composition root — every capability lives in a
// tested lib module; this file only wires chrome events to them.
import { executeAction, defaultEnv } from "@/lib/executors";
import { AgentLoop, mirrorAsk } from "@/lib/agent-loop";
import { PortRouter } from "@/lib/port-router";
import { PanelApprovalBroker } from "@/lib/panel-approvals";
import { fetchNextAction, postActionResult, postApprovalDecision } from "@/lib/bridge-client";
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
    onStatus: (state, detail) => router.broadcast({ type: "task_status", state, detail }),
  });
  loop.start();
});
