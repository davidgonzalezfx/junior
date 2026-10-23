// Settings storage tests: schema defaults, merge-persist, corrupt-value recovery.
import { describe, expect, it } from "vitest";
import {
  addRecentModel,
  getDefaultProvider,
  getRecentModels,
  getToken,
  loadSettings,
  pushRecentModel,
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

describe("recent models (M2-4 ⌘K picker)", () => {
  it("round-trips through storage and drops malformed entries", async () => {
    await expect(getRecentModels()).resolves.toEqual([]);
    await browser.storage.local.set({
      junior_recent_models: [{ providerId: "p1", model: "m1" }, { providerId: 42 }, "junk"],
    });
    await expect(getRecentModels()).resolves.toEqual([{ providerId: "p1", model: "m1" }]);
  });

  it("pushRecentModel: most-recent-first, deduped, capped at 5", () => {
    const base = [
      { providerId: "p", model: "m1" },
      { providerId: "p", model: "m2" },
      { providerId: "p", model: "m3" },
      { providerId: "p", model: "m4" },
      { providerId: "p", model: "m5" },
    ];
    const next = pushRecentModel(base, { providerId: "p", model: "m1" }); // re-push moves to front
    expect(next[0]).toEqual({ providerId: "p", model: "m1" });
    expect(next).toHaveLength(5);
    expect(next.filter((m) => m.model === "m1")).toHaveLength(1);
    expect(pushRecentModel([], { providerId: "q", model: "z" })[0]).toEqual({
      providerId: "q",
      model: "z",
    });
  });

  it("addRecentModel persists the pushed list", async () => {
    await browser.storage.local.remove("junior_recent_models"); // hermetic vs the test above
    await addRecentModel({ providerId: "p", model: "m1" });
    await addRecentModel({ providerId: "p", model: "m2" });
    await expect(getRecentModels()).resolves.toEqual([
      { providerId: "p", model: "m2" },
      { providerId: "p", model: "m1" },
    ]);
  });
});
