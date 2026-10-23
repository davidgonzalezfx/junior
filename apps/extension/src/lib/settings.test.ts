// Settings storage tests: schema defaults, merge-persist, corrupt-value recovery.
import { describe, expect, it } from "vitest";
import {
  getDefaultProvider,
  getToken,
  loadSettings,
  saveSettings,
  setDefaultProvider,
  setToken,
} from "@/lib/settings";

describe("loadSettings", () => {
  it("returns §4.1 defaults when storage is empty", async () => {
    await expect(loadSettings()).resolves.toEqual({
      bridgeUrl: "http://127.0.0.1:8620",
      permissionMode: "ask",
      allowCliNativeTools: false,
    });
  });

  it("falls back to defaults on a corrupt stored value", async () => {
    await browser.storage.local.set({ junior_settings: { bridgeUrl: 42 } });
    await expect(loadSettings()).resolves.toMatchObject({ bridgeUrl: "http://127.0.0.1:8620" });
  });
});

describe("saveSettings", () => {
  it("merges a patch and persists the validated result", async () => {
    await saveSettings({ permissionMode: "auto" });
    await expect(loadSettings()).resolves.toMatchObject({
      permissionMode: "auto",
      bridgeUrl: "http://127.0.0.1:8620", // untouched sibling
    });
  });
});

describe("token + default provider", () => {
  it("round-trips the pairing token", async () => {
    await expect(getToken()).resolves.toBeNull();
    await setToken("ab".repeat(32));
    await expect(getToken()).resolves.toBe("ab".repeat(32));
  });

  it("round-trips and clears the default provider", async () => {
    await expect(getDefaultProvider()).resolves.toBeNull();
    await setDefaultProvider({ providerId: "claude-cli", model: null });
    await expect(getDefaultProvider()).resolves.toEqual({ providerId: "claude-cli", model: null });
    await setDefaultProvider(null);
    await expect(getDefaultProvider()).resolves.toBeNull();
  });
});
