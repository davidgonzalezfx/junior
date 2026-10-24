import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The extension tests get these from WxtVitest (which mirrors the extension's
// own wxt.config — this package has none): `@` → extension src, and
// "wxt/browser" → the same in-memory fakeBrowser under the import name the
// extension lib modules use.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../apps/extension/src", import.meta.url)),
      "wxt/browser": fileURLToPath(new URL("./e2e/wxt-browser-shim.ts", import.meta.url)),
    },
  },
});
