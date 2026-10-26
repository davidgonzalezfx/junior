// M4-1 — /mcp streamable-HTTP tests: raw JSON-RPC wire + the real SDK Client.
// The SDK-client leg matters: terminal Claude speaks MCP through this exact client,
// so a pass here is the M4-2 compatibility bet paying off early.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../index.js";
import { Dispatcher } from "../dispatcher/queue.js";
import { writeToken } from "../config.js";
import { createRateLimiter, type RateLimiter } from "../rate-limit.js";
import { MCP_RATE_LIMIT, mcpRoutes } from "./server.js";
import type { QueueItem } from "@junior/protocol";

const TOKEN = "c".repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_RPC_HEADERS = {
  ...AUTH,
  "content-type": "application/json",
  accept: "application/json, text/event-stream", // streamable HTTP requires both
};

let dirs: string[] = [];
function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-mcp-test-"));
  dirs.push(dir);
  return dir;
}
function newApp(
  opts: { dispatcher?: Dispatcher; limiter?: RateLimiter; probe?: () => unknown } = {},
) {
  const dir = newDir();
  writeToken(TOKEN, dir);
  const dispatcher = opts.dispatcher ?? new Dispatcher();
  const app = createApp({
    dir,
    dispatcher,
    log: vi.fn(),
    mcp: { limiter: opts.limiter },
    status: { probe: opts.probe as never, version: "0.0.0-test" },
  });
  return { dir, app, dispatcher };
}
/** Full SDK session against the in-process app (global fetch → app.fetch). */
async function withClient<T>(
  app: ReturnType<typeof createApp>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
  const client = new Client({ name: "test-client", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8620/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return await fn(client);
  } finally {
    try {
      await client.close(); // stateless server: the teardown leg may reject — best effort
    } catch {
      // ignored
    }
    globalThis.fetch = realFetch;
  }
}
/** One extension poll. Per the §3 HTTP table an action item arrives BARE; idle is {item:null}. */
async function pollOnce(app: ReturnType<typeof createApp>): Promise<QueueItem> {
  const res = await app.request("/api/agent/next-action?timeout=5", { headers: AUTH });
  const raw = (await res.json()) as QueueItem | { item: null };
  if (!("item" in raw)) return raw;
  throw new Error(`expected a queued item, got idle: ${JSON.stringify(raw)}`);
}
async function resolveAction(
  app: ReturnType<typeof createApp>,
  id: string,
  result: unknown,
): Promise<void> {
  const res = await app.request("/api/agent/action-result", {
    method: "POST",
    body: JSON.stringify({ id, status: "ok", result }),
    headers: JSON_RPC_HEADERS,
  });
  if (res.status !== 200) throw new Error(`action-result failed: ${res.status}`);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("POST /mcp — auth (same bearer gate as /api/*)", () => {
  it("401 without a token, 403 with the wrong token", async () => {
    const { app } = newApp();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await app.request("/mcp", { method: "POST", body })).status).toBe(401);
    expect(
      (
        await app.request("/mcp", {
          method: "POST",
          body,
          headers: { authorization: `Bearer ${"d".repeat(64)}` },
        })
      ).status,
    ).toBe(403);
  });
});

describe("POST /mcp — raw JSON-RPC wire", () => {
  it("initialize answers with the Junior server info; tools/list shows the §4.6 catalog", async () => {
    const { app } = newApp();
    const init = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "wire-test", version: "0.0.0" },
        },
      }),
      headers: JSON_RPC_HEADERS,
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(initBody.result.serverInfo.name).toBe("junior-browser");

    const list = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      headers: JSON_RPC_HEADERS,
    });
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agent_task",
      "click",
      "get_active_tab",
      "junior_status",
      "media",
      "navigate",
      "read_page",
      "screenshot",
      "type",
    ]);
  });

  it("malformed JSON body → JSON-RPC parse error, still 200-level transport handling", async () => {
    const { app } = newApp();
    const res = await app.request("/mcp", {
      method: "POST",
      body: "not json",
      headers: JSON_RPC_HEADERS,
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("GET and DELETE → 405 (stateless server has no session leg)", async () => {
    const { app } = newApp();
    expect((await app.request("/mcp", { method: "GET", headers: AUTH })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE", headers: AUTH })).status).toBe(405);
  });
});

describe("tools/call over the real dispatcher", () => {
  it("navigate: polled by the extension, result rides back as JSON text content", async () => {
    const { app, dispatcher } = newApp();
    const dispatch = dispatcher.dispatch({ kind: "navigate", url: "https://example.com" });
    const item = await pollOnce(app);
    expect(item.kind).toBe("action");
    if (item.kind !== "action") throw new Error("unreachable");
    expect(item.action.kind).toBe("navigate");
    await resolveAction(app, item.id, { url: "https://example.com" });
    expect(await dispatch).toMatchObject({ status: "ok" });

    // Now the same trip through MCP: tool call → dispatch → poll → result.
    // (No pre-made dispatch here — the tool call creates its own queue item; a
    // pre-made one would steal the poll and strand the tool until its 120 s timeout.)
    const call = app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "navigate", arguments: { url: "https://example.com/2" } },
      }),
      headers: JSON_RPC_HEADERS,
    });
    const item2 = await pollOnce(app);
    await resolveAction(app, item2.id, { navigated: true });
    const callRes = await call;
    const wire = (await callRes.json()) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(wire.result.isError).toBeFalsy();
    expect(wire.result.content[0]!.type).toBe("text");
    expect(JSON.parse(wire.result.content[0]!.text)).toEqual({ navigated: true });
  });

  it("media: the tool call queues a media action with its op and target", async () => {
    const { app } = newApp();
    const call = app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "media", arguments: { op: "seek", target: "f7:m0", time: 90 } },
      }),
      headers: JSON_RPC_HEADERS,
    });
    const item = await pollOnce(app);
    if (item.kind !== "action") throw new Error("expected an action item");
    expect(item.action).toEqual({ kind: "media", op: "seek", target: "f7:m0", time: 90 });
    await resolveAction(app, item.id, "Seeked to 90s");
    const wire = (await (await call).json()) as { result: { isError?: boolean } };
    expect(wire.result.isError).toBeFalsy();
  });

  it("a guard denial comes back as isError with the structured reason", async () => {
    // The app's DEFAULT dispatcher carries defaultGuard (§4.4): private-network
    // navigations are refused in ask mode before any queueing happens.
    const dir = newDir();
    writeToken(TOKEN, dir);
    const app = createApp({ dir, log: vi.fn(), status: { version: "0.0.0-test" } });
    const res = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "navigate", arguments: { url: "http://127.0.0.1:9/x" } },
      }),
      headers: JSON_RPC_HEADERS,
    });
    const wire = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(wire.result.isError).toBe(true);
    expect(wire.result.content[0]!.text).toContain("BLOCKED_BY_POLICY");
  });

  it("junior_status answers without the extension connected (available:false facts)", async () => {
    const { app } = newApp({
      probe: async () => ({ found: true, loggedIn: true, version: "0.0.0", authMethod: "api_key" }),
    });
    const res = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "junior_status" },
      }),
      headers: JSON_RPC_HEADERS,
    });
    const wire = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(wire.result.isError).toBeFalsy();
    const status = JSON.parse(wire.result.content[0]!.text) as {
      browserConnected: boolean;
      apiLevel: number;
    };
    expect(status.browserConnected).toBe(false);
    expect(status.apiLevel).toBe(1);
  });

  it("oversized results are capped with a truncation note (§6.3-6)", async () => {
    const { app } = newApp();
    const call = app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "read_page", arguments: { mode: "text", maxChars: 30000 } },
      }),
      headers: JSON_RPC_HEADERS,
    });
    const item = await pollOnce(app);
    await resolveAction(app, item.id, { text: "x".repeat(50_000) });
    const wire = (await (await call).json()) as { result: { content: { text: string }[] } };
    expect(wire.result.content[0]!.text.length).toBeLessThan(21_000);
    expect(wire.result.content[0]!.text).toContain("[truncated");
  });
});

describe("rate limit — §4.2 quota-burn brake on tools/call only", () => {
  it("30/min burst: the 31st tools/call gets 429; lifecycle calls are unmetered", async () => {
    const { app } = newApp({ limiter: createRateLimiter({ ...MCP_RATE_LIMIT }) });
    // agent_task is the one catalog entry that answers WITHOUT dispatching (M4-3 stub),
    // so the burst measures the limiter, not dispatcher timeouts.
    const call = () =>
      app.request("/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "agent_task", arguments: { goal: "x" } },
        }),
        headers: JSON_RPC_HEADERS,
      });
    for (let i = 0; i < MCP_RATE_LIMIT.max; i++) {
      const res = await call();
      expect(res.status).toBe(200);
    }
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { message: string } }).error.message).toContain(
      "rate limited",
    );
    // initialize is not a tool call — must never be braked
    const init = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
      headers: JSON_RPC_HEADERS,
    });
    expect(init.status).toBe(200);
  });
});

describe("real SDK Client against the in-process app", () => {
  it("connect → listTools → guarded tool call round-trips through the dispatcher", async () => {
    const { app } = newApp();
    await withClient(app, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("navigate");

      // The tool call itself dispatches; the poll must answer THAT item.
      const callPromise = client.callTool({ name: "get_active_tab" });
      const item = await pollOnce(app);
      await resolveAction(app, item.id, {
        title: "Example",
        url: "https://example.com",
      });
      const result = (await callPromise) as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        title: "Example",
        url: "https://example.com",
      });
    });
  });
});

describe("mcpRoutes — mount shape", () => {
  it("the router answers on /mcp for all methods it owns", async () => {
    const dir = newDir();
    writeToken(TOKEN, dir);
    const routes = mcpRoutes({ dir, dispatcher: new Dispatcher(), log: vi.fn() });
    const res = await routes.request("/mcp", { method: "GET", headers: AUTH });
    expect(res.status).toBe(405);
  });
});
