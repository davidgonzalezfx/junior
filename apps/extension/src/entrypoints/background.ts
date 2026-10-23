// SW skeleton (plan §5.2) — pairing + the agent long-poll loop land in M2-2; executors,
// guard and the Port router in M3. This entry fixes the manifest wiring that must exist
// from day one and proves the WXT service-worker pipeline end-to-end.
export default defineBackground(() => {
  // MV3 wires nothing automatically: the toolbar icon opens the side panel via API.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("junior: setPanelBehavior failed", err));

  // §5.1: content scripts (untrusted contexts) must never read keys/history/token.
  // Port of Autono background.js:38 — defensive catch for older Chrome (<102).
  browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => null);

  browser.runtime.onInstalled.addListener((details) => {
    console.log(`junior: installed (${details.reason})`);
  });
});
