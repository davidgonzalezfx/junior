import { describe, expect, it } from "vitest";

import { EXTENSION_ID, EXTENSION_ORIGIN, ExtensionSettingsSchema } from "./config.js";

describe("pinned extension identity (M2-1, docs/decisions.md 2026-10-23)", () => {
  it("EXTENSION_ORIGIN has the chrome-extension://[a-p]{32} shape Chrome generates", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });
});

describe("ExtensionSettingsSchema (plan §5.2 item 1)", () => {
  it("defaults bridgeUrl/permissionMode/allowCliNativeTools", () => {
    expect(ExtensionSettingsSchema.parse({})).toEqual({
      bridgeUrl: "http://127.0.0.1:8620",
      permissionMode: "ask",
      allowCliNativeTools: false,
    });
  });
});
