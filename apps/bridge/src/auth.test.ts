import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { bearerAuth, corsAllowlist, isAllowedOrigin, tokensMatch } from "./auth.js";

const TOKEN = "a".repeat(64);
const EXT_ORIGIN = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`; // 32 chars of [a-p]

function appWithAuth(token: string | null, log = vi.fn()) {
  const app = new Hono()
    .use("*", corsAllowlist())
    .use(
      "/api/*",
      bearerAuth(() => token, log),
    )
    .get("/api/ping", (c) => c.json({ pong: true }))
    .get("/api/health", (c) => c.json({ ok: true }));
  return { app, log };
}

describe("bearerAuth (plan §4.2)", () => {
  it("passes a valid bearer token through", async () => {
    const { app, log } = appWithAuth(TOKEN);
    const res = await app.request("/api/ping", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(log).not.toHaveBeenCalled();
  });

  it("401s without a token and 403s with a wrong one, logging origin + path", async () => {
    const { app, log } = appWithAuth(TOKEN);
    const noToken = await app.request("/api/ping", { headers: { origin: "https://evil.example" } });
    expect(noToken.status).toBe(401);
    const badToken = await app.request("/api/ping", {
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    expect(badToken.status).toBe(403);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain("path=/api/ping");
    expect(log.mock.calls[0]?.[0]).toContain("origin=https://evil.example");
    expect(log.mock.calls[1]?.[0]).toContain("reason=bad-token");
  });

  it("403s (not crash) when no token is stored yet but one is presented", async () => {
    const { app } = appWithAuth(null);
    const res = await app.request("/api/ping", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(403);
  });

  it("leaves /api/health and GET /api/pairing public even with no token set", async () => {
    const { app } = appWithAuth(null);
    expect((await app.request("/api/health")).status).toBe(200);
    // /api/pairing isn't mounted here; 404 (not 401/403) proves the middleware let it through.
    expect((await app.request("/api/pairing")).status).toBe(404);
  });
});

describe("tokensMatch (§4.2 constant-time compare)", () => {
  it("matches equal tokens and rejects different ones — any lengths, no throw", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, "b".repeat(64))).toBe(false);
    expect(tokensMatch("short", "a-much-longer-token-value")).toBe(false);
  });
});

describe("isAllowedOrigin (§4.2 allowlist)", () => {
  it("accepts our extension origin and loopback pages", () => {
    expect(isAllowedOrigin(EXT_ORIGIN)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8620")).toBe(true);
  });

  it("rejects web origins, weird schemes, and missing headers", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("chrome-extension://evil")).toBe(false);
    expect(isAllowedOrigin("file:///etc/passwd")).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
  });
});

describe("corsAllowlist (plan §4.2)", () => {
  const app = new Hono().use("*", corsAllowlist()).get("/x", (c) => c.text("ok"));

  it("echoes allowed origins so the panel can read responses", async () => {
    for (const origin of [EXT_ORIGIN, "http://localhost:5173", "http://127.0.0.1:8620"]) {
      const res = await app.request("/x", { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(await res.text()).toBe("ok");
    }
  });

  it("sends no ACAO to web origins — the request runs but can't be read (§4.2)", async () => {
    const res = await app.request("/x", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflights for allowed origins, including private-network access", async () => {
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: { origin: EXT_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("answers preflights for other origins with bare 204 (browser blocks the read)", async () => {
    const res = await app.request("/x", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-private-network")).toBeNull();
  });

  it("answers origin-less preflights too (curl / same-origin checks)", async () => {
    const res = await app.request("/x", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
