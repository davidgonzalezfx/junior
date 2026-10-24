// Bridge-client tests: wire shapes vs @junior/protocol, error classification, backoff.
// `browser` (settings storage) resolves to WXT's fakeBrowser under the WxtVitest plugin.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeHttpError,
  BridgeUnreachableError,
  fetchHealth,
  fetchNextAction,
  fetchPairingStatus,
  fetchStatus,
  nextDelayMs,
  postApprovalDecision,
  postActionResult,
  postPairing,
} from "@/lib/bridge-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHealth", () => {
  it("returns true on the §3 liveness body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHealth("http://127.0.0.1:8620")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8620/api/health", {
      method: "GET",
      headers: {},
    });
  });

  it("classifies a dead bridge as BridgeUnreachableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchHealth("http://127.0.0.1:8620")).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
  });
});

describe("fetchStatus", () => {
  it("sends the bearer token and parses a BridgeStatus", async () => {
    const body = {
      version: "0.0.0",
      apiLevel: 1,
      providers: [{ id: "claude-cli", kind: "claude-cli", label: "Claude CLI", available: true }],
      browserConnected: false,
      queueDepth: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal("fetch", fetchMock);

    const status = await fetchStatus("http://127.0.0.1:8620", "cafe".repeat(16));
    expect(status.providers[0]?.id).toBe("claude-cli");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${"cafe".repeat(16)}`,
    );
  });

  it("marks 401/403 as auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "bad token" })));
    const err = await fetchStatus("http://127.0.0.1:8620", "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect((err as BridgeHttpError).authFailed).toBe(true);
    expect((err as BridgeHttpError).wireError).toBe("bad token");
  });
});

describe("pairing wire calls", () => {
  it("fetchPairingStatus parses the §4.1 probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { tokenRequired: true, tokenSet: false })),
    );
    await expect(fetchPairingStatus("http://127.0.0.1:8620")).resolves.toEqual({
      tokenRequired: true,
      tokenSet: false,
    });
  });

  it("postPairing POSTs the token as JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, alreadyPaired: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(postPairing("http://127.0.0.1:8620", "ab".repeat(32))).resolves.toEqual({
      ok: true,
      alreadyPaired: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8620/api/pairing");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ token: "ab".repeat(32) }));
  });

  it("surfaces the bridge's 403 hint text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          error: "token mismatch — run `junior-bridge pair` to open a 60 s pairing window",
        }),
      ),
    );
    const err = await postPairing("http://127.0.0.1:8620", "ab".repeat(32)).catch(
      (e: unknown) => e,
    );
    expect((err as BridgeHttpError).wireError).toContain("junior-bridge pair");
  });

  it("rejects non-JSON 500s with a BridgeHttpError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>boom</html>", { status: 500 })),
    );
    await expect(fetchHealth("http://127.0.0.1:8620")).rejects.toBeInstanceOf(BridgeHttpError);
  });
});

describe("nextDelayMs", () => {
  it("doubles from 1 s and caps at 30 s, jitter under 250 ms", () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const delay = nextDelayMs(attempt);
      const exp = Math.min(1000 * 2 ** attempt, 30_000);
      expect(delay).toBeGreaterThanOrEqual(exp);
      expect(delay).toBeLessThan(exp + 250);
    }
    expect(nextDelayMs(0)).toBeGreaterThanOrEqual(1000);
    expect(nextDelayMs(10)).toBeGreaterThanOrEqual(30_000); // capped
  });
});

// --- Agent loop endpoints (M3-3) ----------------------------------------------

describe("agent loop endpoints", () => {
  const token = "tok";

  it("fetchNextAction returns the parsed QueueItem", async () => {
    const item = {
      id: "a".repeat(8),
      kind: "action",
      action: { kind: "get_active_tab" },
      createdAt: 1,
      timeoutMs: 120_000,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, item));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchNextAction("http://127.0.0.1:8620", token, 15_000)).resolves.toEqual(item);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:8620/api/agent/next-action?timeout=15",
    );
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("fetchNextAction maps the idle {item: null} body to null (not a parse failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { item: null })));
    await expect(fetchNextAction("http://127.0.0.1:8620", token, 15_000)).resolves.toBeNull();
  });

  it("fetchNextAction throws on a malformed non-idle body (never silently drops it)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { item: { kind: "nonsense" } })),
    );
    await expect(fetchNextAction("http://127.0.0.1:8620", token, 15_000)).rejects.toThrow();
  });

  it("postActionResult / postApprovalDecision hit their routes with the token", async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, _init: unknown) =>
        jsonResponse(200, { delivered: true }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await postActionResult("http://127.0.0.1:8620", token, {
      id: "x",
      status: "ok",
      result: "r",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      id: "x",
      status: "ok",
      result: "r",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8620/api/agent/action-result");
    await expect(
      postApprovalDecision("http://127.0.0.1:8620", token, { id: "x", decision: "once" }),
    ).resolves.toBe(true);
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:8620/api/agent/approval-response");
  });
});
