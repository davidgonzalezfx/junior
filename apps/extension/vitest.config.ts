import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// WxtVitest (wxt.dev/guide/essentials/unit-testing): polyfills `browser` with the
// in-memory fakeBrowser (auto-reset per test), mirrors wxt.config aliases (@/) and env.
export default defineConfig({
  plugins: [WxtVitest()],
});
