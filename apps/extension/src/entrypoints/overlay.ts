// Work overlay content script (plan §5.2 item 6, M3-4) — unlisted script
// injected on demand via executeScript({files:["overlay.js"]}). M2-1 keeps the
// manifest free of static content_scripts and registration:"runtime" would add
// matches to host_permissions, so this is the trimmed port of Autono
// content/content.js as an on-demand injection instead of the plan-tree's
// `content.ts` entrypoint (decisions.md 2026-10-23).
import { browser } from "wxt/browser";
import { installWorkOverlay } from "@/lib/work-overlay-content";

export default defineUnlistedScript(() => {
  installWorkOverlay(
    (msg) => {
      void browser.runtime.sendMessage(msg).catch(() => null); // SW may be asleep
    },
    (cb) => {
      browser.runtime.onMessage.addListener((msg) => {
        cb(msg);
      });
    },
  );
});
