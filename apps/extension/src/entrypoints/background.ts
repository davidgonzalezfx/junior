// SW skeleton (plan §5.2 item 1 + M2-2): manifest wiring from M2-1, plus first-run
// pairing — generate token if missing, POST /api/pairing (idempotent), mirror settings.
// Executors, guard and the Port router land in M3.
import { ensureToken, pairWithBridge } from "@/lib/pairing";
import { saveSettings } from "@/lib/settings";

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

  browser.runtime.onStartup.addListener(() => {
    void pairIfNeeded("browser startup").catch((err) =>
      console.error("junior: pairing failed", err),
    );
  });
});
