// M5-7: gate logic over the injected PermissionsGate seam (fakeBrowser has no
// permissions API — see the seam comment). The seam's delegation to the real
// browser.permissions is proven at the bottom via a minimal inline fake.
import { describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { ALL_URLS_ORIGIN, ensureHostAccess, realPermissionsGate } from "./host-permissions";

function fakeGate(granted: boolean, requestResult: boolean) {
  return {
    contains: vi.fn(async (_origins: string[]) => granted),
    request: vi.fn(async (_origins: string[]) => requestResult),
  };
}

describe("ensureHostAccess", () => {
  it("already-granted access skips the dialog — request is never called", async () => {
    const gate = fakeGate(true, false);
    await expect(ensureHostAccess(gate)).resolves.toBe("granted");
    expect(gate.contains).toHaveBeenCalledWith([ALL_URLS_ORIGIN]);
    expect(gate.request).not.toHaveBeenCalled();
  });

  it("first agent-mode send requests <all_urls> and reports the grant", async () => {
    const gate = fakeGate(false, true);
    await expect(ensureHostAccess(gate)).resolves.toBe("granted");
    expect(gate.request).toHaveBeenCalledWith([ALL_URLS_ORIGIN]);
  });

  it("a denied dialog resolves denied (the caller still runs the task + shows a notice)", async () => {
    const gate = fakeGate(false, false);
    await expect(ensureHostAccess(gate)).resolves.toBe("denied");
    expect(gate.request).toHaveBeenCalledTimes(1);
  });

  it("custom origins pass through (the default is <all_urls>)", async () => {
    const gate = fakeGate(true, true);
    await ensureHostAccess(gate, ["https://example.com/*"]);
    expect(gate.contains).toHaveBeenCalledWith(["https://example.com/*"]);
  });
});

describe("realPermissionsGate", () => {
  it("delegates contains/request to browser.permissions verbatim", async () => {
    expect.assertions(3);
    // fakeBrowser lacks the permissions API — a minimal inline fake proves the seam
    // forwards the {origins} shape and return values unchanged.
    let requested: unknown;
    (browser as { permissions?: unknown }).permissions = {
      contains: async (p: { origins?: string[] }) => p.origins?.[0] === "https://known.test/*",
      request: async (p: { origins?: string[] }) => {
        requested = p.origins;
        return false;
      },
    };
    await expect(realPermissionsGate.contains(["https://known.test/*"])).resolves.toBe(true);
    await expect(realPermissionsGate.request([ALL_URLS_ORIGIN])).resolves.toBe(false);
    expect(requested).toEqual([ALL_URLS_ORIGIN]);
    delete (browser as { permissions?: unknown }).permissions;
  });
});
