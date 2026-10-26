// Service worker (plan §5.2): pairing, agent loop, Port router and
// approval cards. The SW is the composition root — every capability lives in a
// tested lib module; this file only wires chrome events to them.
import { defaultEnv } from "@/lib/executors";
import { AgentTabManager, defaultAgentTabHost, withAgentTab } from "@/lib/agent-tab";
import { createAgentRuntime } from "@/lib/agent-runtime";
import { defaultOverlayEnv } from "@/lib/work-overlay";
import {
  fetchNextAction,
  postActionResult,
  postApprovalDecision,
  postCancel,
} from "@/lib/bridge-client";
import { clearSiteGrants } from "@/lib/site-grants";
import { ensureToken, pairWithBridge } from "@/lib/pairing";
import { getToken, loadSettings, saveSettings } from "@/lib/settings";
import { runStorageMigrations } from "@/lib/storage-migrations";

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
    await runStorageMigrations().catch(() => null); // SW wake also migrates storage
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

  // --- Agent stack (§5.2 items 2, 5, 6 — lib/agent-runtime.ts) -----------------
  const bridgeCall = async <T>(fn: (baseUrl: string, token: string) => Promise<T>): Promise<T> => {
    const { bridgeUrl } = await loadSettings();
    const token = await getToken();
    if (!token) throw new Error("junior: no bridge token yet");
    return fn(bridgeUrl, token);
  };

  // The agent gets its own tab (pinned, "Junior" group — lib/agent-tab.ts).
  // Every action resolves to that tab id for the whole task regardless of the
  // user's focus; get_active_tab within agent context reports it, and the
  // overlay only ever lands on it.
  const agentEnv = withAgentTab(defaultEnv, new AgentTabManager(defaultAgentTabHost));

  const runtime = createAgentRuntime({
    extensionId: browser.runtime.id,
    extensionOrigin: location.origin,
    bridge: {
      poll: (timeoutMs) => bridgeCall((url, token) => fetchNextAction(url, token, timeoutMs)),
      postResult: (result) => bridgeCall((url, token) => postActionResult(url, token, result)),
      postDecision: async (decision) => {
        await bridgeCall((url, token) => postApprovalDecision(url, token, decision));
      },
      postCancel: async () => {
        await bridgeCall((url, token) => postCancel(url, token));
      },
    },
    agentEnv,
    overlayEnv: defaultOverlayEnv,
    permissionMode: async () => (await loadSettings()).permissionMode,
  });

  browser.runtime.onConnect.addListener((port) => runtime.connect(port));

  // Card deadlines (lib/approval-ledger.ts): the alarm may be what woke this SW.
  // Registered synchronously at top level so Chrome delivers the waking event.
  browser.alarms.onAlarm.addListener((alarm) => {
    void runtime.handleAlarm(alarm);
  });

  // Content-script one-shot messages (overlay_action / content_ready) — the
  // controller applies the port-router firewall before acting.
  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    runtime.handleContentMessage(msg, sender);
  });
});
