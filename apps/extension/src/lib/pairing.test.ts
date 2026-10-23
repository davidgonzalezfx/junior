// Pairing tests (plan §5.2 item 1 / §4.1): token generation + storage via fakeBrowser,
// and the full pairWithBridge decision tree against a stubbed fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingRequestSchema } from "@junior/protocol";
import { generateToken, ensureToken, pairWithBridge } from "@/lib/pairing";
import { getToken } from "@/lib/settings";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateToken", () => {
  it("produces 64 hex chars that satisfy the wire schema", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(PairingRequestSchema.safeParse({ token }).success).toBe(true);
  });

  it("does not repeat across calls", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("ensureToken", () => {
  it("generates and persists on first call, then returns the same token", async () => {
    const first = await ensureToken();
    expect(await getToken()).toBe(first);
    await expect(ensureToken()).resolves.toBe(first);
  });
});

describe("pairWithBridge", () => {
  it("reports freshly-paired when the bridge accepts the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, alreadyPaired: false })),
    );
    await expect(pairWithBridge()).resolves.toEqual({ status: "paired", alreadyPaired: false });
  });

  it("reports alreadyPaired:true on idempotent re-pair", async () => {
    const token = await ensureToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, alreadyPaired: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pairWithBridge()).resolves.toEqual({ status: "paired", alreadyPaired: true });
    // The stored token went over the wire to the configured bridge URL.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ token }));
  });

  it("maps a 403 to mismatch with the bridge's hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          error: "token mismatch — run `junior-bridge pair` to open a 60 s pairing window",
        }),
      ),
    );
    const outcome = await pairWithBridge();
    expect(outcome).toEqual({
      status: "mismatch",
      message: "token mismatch — run `junior-bridge pair` to open a 60 s pairing window",
    });
  });

  it("maps a dead bridge to unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(pairWithBridge()).resolves.toEqual({ status: "unreachable" });
  });

  it("targets the configured bridgeUrl, not a hardcoded one", async () => {
    const { saveSettings } = await import("@/lib/settings");
    await saveSettings({ bridgeUrl: "http://127.0.0.1:9999" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, alreadyPaired: false }));
    vi.stubGlobal("fetch", fetchMock);
    await pairWithBridge();
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://127.0.0.1:9999/api/pairing");
  });
});
