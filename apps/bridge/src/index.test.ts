import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { openPairingWindow, pairingWindowOpen, readToken, writeToken } from "./config.js";

const TOKEN = "a".repeat(64);
let dirs: string[] = [];

function newApp() {
  const dir = mkdtempSync(join(tmpdir(), "junior-bridge-test-"));
  dirs.push(dir);
  return { dir, app: createApp({ dir, log: vi.fn() }) };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("bridge app — M1-1 acceptance (curl-able health/pairing)", () => {
  it("GET /api/health is open and data-free", async () => {
    const { app } = newApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /api/pairing reports tokenSet honestly, no auth", async () => {
    const { dir, app } = newApp();
    expect(await (await app.request("/api/pairing")).json()).toEqual({
      tokenRequired: true,
      tokenSet: false,
    });
    writeToken(TOKEN, dir);
    expect(await (await app.request("/api/pairing")).json()).toEqual({
      tokenRequired: true,
      tokenSet: true,
    });
  });

  it("POST /api/pairing: 400 on a bad body; 403 while locked; sets within the window; idempotent", async () => {
    const { dir, app } = newApp();
    const extToken = "b".repeat(64);
    const post = (token: unknown) =>
      app.request("/api/pairing", {
        method: "POST",
        body: JSON.stringify({ token }),
        headers: { "content-type": "application/json" },
      });

    expect((await post("nothex")).status).toBe(400);
    expect((await post(extToken)).status).toBe(403); // no token stored, no window → locked

    openPairingWindow(dir);
    const ok = await post(extToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, alreadyPaired: false });
    expect(readToken(dir)).toBe(extToken);
    expect(pairingWindowOpen(dir)).toBe(false); // window consumed by the successful pairing
    const again = await post(extToken);
    expect(await again.json()).toEqual({ ok: true, alreadyPaired: true });
    expect((await post("c".repeat(64))).status).toBe(403); // different token → mismatch → 403
  });

  it("authenticates everything else: 401 without a token, 404 (not 401) for unknown+authorized", async () => {
    const { dir, app } = newApp();
    writeToken(TOKEN, dir);
    expect((await app.request("/api/agent/nope")).status).toBe(401);
    const ok = await app.request("/api/agent/nope", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(404);
    expect(await ok.json()).toEqual({ error: "not found" });
  });

  it("403s protected routes with a wrong token", async () => {
    const { dir, app } = newApp();
    writeToken(TOKEN, dir);
    const res = await app.request("/api/agent/nope", {
      headers: { authorization: `Bearer ${"f".repeat(64)}` },
    });
    expect(res.status).toBe(403);
  });
});
