// tests/e2e/wxt-browser-shim.ts — vitest alias target for "wxt/browser" in this
// package: the same in-memory fakeBrowser the extension tests get from WxtVitest,
// re-exported under the name extension lib modules import. (fakeBrowser does NOT
// auto-reset between tests here — reset it in beforeEach where storage matters.)
import { fakeBrowser } from "wxt/testing/fake-browser";

export const browser = fakeBrowser;
