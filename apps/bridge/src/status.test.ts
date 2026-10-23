// M1-3 acceptance — GET /api/status over the real Hono app (plan §8 M1: "/api/status
// with CLI detection"). probe + version are injected so tests never spawn `claude`;
// the live-probe leg runs against the built server (see progress.md entry).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStatusSchema, JuniorConfigSchema } from "@junior/protocol";
import { createApp } from "./index.js";
import { saveConfig, writeToken } from "./config.js";
import { Dispatcher } from "./dispatcher/queue.js";
import { probeClaude, type ClaudeCliStatus } from "./cli-detect.js";

const TOKEN = "a".repeat(64);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const DETECTED: ClaudeCliStatus = {
  found: true,
  path: "/usr/local/bin/claude",
  version: "2.1.309",
  loggedIn: true,
  account: null,
  authMethod: "api_key",
};

interface Fixture {
  dir: string;
  dispatcher: Dispatcher;
  app: ReturnType<typeof createApp>;
  probe: ReturnType<typeof vi.fn>;
}

/** config goes through JuniorConfigSchema.parse first — same path a real config.json
 * takes — so partial fixtures get the schema defaults filled in. */
function newApp(detected: ClaudeCliStatus = DETECTED, config?: Record<string, unknown>): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "junior-status-test-"));
  dirs.push(dir);
  writeToken(TOKEN, dir);
  if (config) saveConfig(JuniorConfigSchema.parse(config), dir);
  const dispatcher = new Dispatcher();
  const probe = vi.fn(async (_opts: Parameters<typeof probeClaude>[0]) => detected);
  const app = createApp({
    dir,
    log: vi.fn(),
    dispatcher,
    status: { probe: probe as unknown as typeof probeClaude, version: "9.9.9-test" },
  });
  return { dir, dispatcher, app, probe };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("GET /api/status", () => {
  it("401s without the pairing token", async () => {
    const { app } = newApp();
    const res = await app.request("/api/status");
    expect(res.status).toBe(401);
  });

  it("reports providers, CLI detection, browser freshness, queue depth", async () => {
    const { app, dispatcher } = newApp(undefined, {
      providers: {
        anthropicKey: "sk-ant-test",
        openaiCompatible: [
          {
            id: "zai",
            label: "Z.ai",
            baseUrl: "https://api.z.ai/api",
            apiKey: "k",
            models: ["glm-5.3-flash"],
          },
        ],
      },
    });
    dispatcher.ping(); // extension polled recently
    const res = await app.request("/api/status", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = BridgeStatusSchema.parse(body); // throws on drift from plan §3
    expect(parsed.version).toBe("9.9.9-test");
    expect(parsed.apiLevel).toBe(1);
    expect(parsed.browserConnected).toBe(true);
    expect(parsed.queueDepth).toBe(0);

    const [cli, anthropic, zai] = parsed.providers;
    if (!cli || !anthropic || !zai) throw new Error("expected three provider entries");
    expect(cli.id).toBe("claude-cli");
    expect(cli.available).toBe(true);
    expect(cli.detail).toBe("claude 2.1.309 — logged in (api_key)");
    expect(anthropic.id).toBe("anthropic");
    expect(anthropic.available).toBe(true);
    expect(anthropic.detail).toBe("API key configured");
    expect(zai.id).toBe("zai");
    expect(zai.available).toBe(true);
    expect(zai.detail).toBe("https://api.z.ai/api");
    expect(zai.models).toEqual([{ id: "glm-5.3-flash", badges: [] }]);
  });

  it("an absent CLI/key reads as unavailable, not an error", async () => {
    const { app } = newApp(
      { found: false, path: null, version: null, loggedIn: false, account: null, authMethod: null },
      { providers: { openaiCompatible: [] } },
    );
    const res = await app.request("/api/status", { headers: AUTH });
    const body = BridgeStatusSchema.parse(await res.json());
    const [cli, anthropic] = body.providers;
    if (!cli || !anthropic) throw new Error("expected two provider entries");
    expect(cli.available).toBe(false);
    expect(cli.detail).toBeUndefined();
    expect(anthropic.available).toBe(false);
  });

  it("hands the config cliPath override to the probe", async () => {
    const cliPath = join(tmpdir(), "junior-fake-claude");
    const { app, probe } = newApp(undefined, {
      cliPath,
      providers: { openaiCompatible: [] },
    });
    await app.request("/api/status", { headers: AUTH });
    expect(probe).toHaveBeenCalledWith({ overridePath: cliPath });
  });

  it("queueDepth counts buffered items only — an in-flight dispatch shows 1, then 0", async () => {
    const { app, dispatcher } = newApp();
    const pending = dispatcher.dispatch({ kind: "navigate", url: "https://example.com" }, 50);
    const busy = BridgeStatusSchema.parse(
      await (await app.request("/api/status", { headers: AUTH })).json(),
    );
    expect(busy.queueDepth).toBe(1);

    await pending; // 50 ms timeout → error result, buffered item dropped
    const idle = BridgeStatusSchema.parse(
      await (await app.request("/api/status", { headers: AUTH })).json(),
    );
    expect(idle.queueDepth).toBe(0);
    expect(idle.browserConnected).toBe(false); // never pinged in this fixture
  });

  it("a malformed config fails loud (500), per the fail-fast config policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-status-badcfg-"));
    dirs.push(dir);
    writeToken(TOKEN, dir);
    writeFileSync(join(dir, "config.json"), "{not json");
    const app = createApp({ dir, log: vi.fn(), dispatcher: new Dispatcher() });
    const res = await app.request("/api/status", { headers: AUTH });
    expect(res.status).toBe(500);
  });
});
