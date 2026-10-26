// @junior/extension — WXT config (plan §5.1).
// WXT generates the MV3 manifest from this file + entrypoint meta tags; the sidepanel
// entrypoint supplies `side_panel.default_path` and auto-adds the `sidePanel` permission.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Pinned unpacked identity (docs/decisions.md 2026-10-23): the public half of
// ~/.junior/extension-key.pem (RSA-2048, private key NEVER committed). Chrome derives the
// stable extension id from this key; it must keep matching EXTENSION_ORIGIN in
// @junior/protocol (tripwire test in packages/protocol). Rotating the key changes the id
// and the bridge CORS allowlist together.
const MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyw2uM7CljgFrz0t4KA8nON+1LESuZEiU940glv8oJ5w5ZJTnHt6eU6mkP7aFrqejSOREkXWK/tIc9eNQxku3R+z+4AWsYnvG2YNlQGUFkdhQSAS0nU84fmLRBkhHn+SwcBKhdlgWqJYNxJzK4uPske4xL58Oqn+BsRP9gpkJQrzP8y2JKUVbH/0HjV00kvnRDCm0aNnJsg/nRe0QjnUBjiFfggoxNbzfJld5uaBtQOB8fs1Z44yhcDH9+Oaojgqtrz74T6gN53pfTLIcI5QGqbhV/72RWLYeNMCcPr2/udTi+N78mkUkDnUGF+ElW4tR+bOkJNrLOrQ22ANERF+2tQIDAQAB";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  alias: {
    "@": "./src", // shadcn-style `@/` imports; WXT mirrors this into .wxt/tsconfig.json paths
  },
  manifest: {
    name: "Junior",
    description: "Junior — browser copilot over the local bridge (plan §5).",
    key: MANIFEST_KEY,
    minimum_chrome_version: "120",
    // §5.1: programmatic injection only — no static content_scripts (code does not run on
    // every page all the time). `sidePanel` is also auto-added by the sidepanel entrypoint.
    // `tabGroups` (T1): the agent's dedicated tab is pinned and labeled in a
    // "Junior" tab group so it is visible, reusable, and never the user's tab.
    permissions: ["storage", "scripting", "activeTab", "sidePanel", "tabs", "alarms", "tabGroups"],
    // §5.1: the bridge is the ONLY host at install time. v1 routes all inference through
    // the bridge. (M5-7 — decisions.md 2026-10-25: agent page actions — read_page/click/
    // type + overlay injection — need origin access to the TAB's site, which this grant
    // can never cover; <all_urls> is declared optional below and requested at runtime.)
    host_permissions: ["http://127.0.0.1:8620/*"],
    // M5-7: install stays clean ("on click" posture intact); the agent-mode composer
    // send (user gesture — the only place Chrome allows it) requests <all_urls> once
    // via chrome.permissions.request. Plain chat never triggers the dialog.
    optional_host_permissions: ["<all_urls>"],
    // Toolbar icon exists so the SW can wire openPanelOnActionClick (background.ts).
    action: { default_title: "Open Junior" },
    // §5.1 CSP: scripts only from the bundle; network only to the extension itself and the
    // loopback bridge. Tighter than Autono's (no 'wasm-unsafe-eval', no https:).
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:8620",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
