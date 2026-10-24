// M4-4 — engine "cli" tests (plan §4.5 "Engine cli", §8 M4-4): arg matrix, mcp.json
// loopback, the --resume session map, the stream-json → UI-chunk mapping, fatal-path
// error parts, and the full POST /api/chat engine=cli route over the real Hono app
// with a spawned-for-real fixture child (node -e), never a real `claude` (§9: recorded
// stream-json, no CLI dependency in CI).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorConfigSchema, type ChatRequestBody } from "@junior/protocol";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";
import {
  CliSessionMap,
  buildCliArgs,
  lastUserText,
  prepareCliTurn,
  writeMcpConfig,
  type CliTurnOutcome,
  type SpawnFn,
} from "./engine-cli.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-cli-test-"));
  dirs.push(dir);
  return dir;
}

const TOKEN = "c".repeat(64);

describe("mcp.json loopback (§4.5: the CLI traverses OUR /mcp)", () => {
  it("writes one HTTP server with the bearer token, 0600, token never in the URL", () => {
    const dir = tmpDir();
    const path = writeMcpConfig(dir, "http://127.0.0.1:8620/", TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const server = parsed.mcpServers.junior_browser;
    expect(server?.type).toBe("http");
    expect(server?.url).toBe("http://127.0.0.1:8620/mcp"); // trailing slash normalized
    expect(server?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("buildCliArgs (M0-3 spike matrix)", () => {
  const base = { mcpConfigPath: "/x/mcp.json", model: "glm-5.3-flash" };
  it('first turn: --session-id <uuid>, --tools "", strict mcp config, explicit model', () => {
    const args = buildCliArgs({
      ...base,
      session: { flag: "--session-id", uuid: "u1" },
      cliTools: "browser",
      nativeToolsAllowed: false,
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--mcp-config") + 1)).toContain("/x/mcp.json");
    expect(args.slice(args.indexOf("--tools") + 1)).toContain("");
    // Server-wide pre-approval: the `:*` wildcard is NOT honored in 2.1.310 (M4-2)
    expect(args).toContain("mcp__junior_browser");
    expect(args.slice(args.indexOf("--model") + 1)).toContain("glm-5.3-flash");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("u1");
    expect(args).not.toContain("--resume");
  });
  it("later turn: --resume with the SAME uuid", () => {
    const args = buildCliArgs({
      ...base,
      session: { flag: "--resume", uuid: "u1" },
      cliTools: "browser",
      nativeToolsAllowed: false,
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("u1");
    expect(args).not.toContain("--session-id");
  });
  it('cliTools "all" keeps native tools ONLY when the config gate is open', () => {
    const native = buildCliArgs({
      ...base,
      session: null,
      cliTools: "all",
      nativeToolsAllowed: true,
    });
    expect(native).not.toContain("--tools");
    const gated = buildCliArgs({
      ...base,
      session: null,
      cliTools: "all",
      nativeToolsAllowed: false,
    });
    expect(gated).toContain("--tools");
    expect(gated[gated.indexOf("--tools") + 1]).toBe("");
  });
});

describe("CliSessionMap + prepareCliTurn", () => {
  it("claims --session-id then --resume with the same uuid per convId", () => {
    const sessions = new CliSessionMap();
    const first = sessions.claim("conv-1");
    const second = sessions.claim("conv-1");
    expect(first.flag).toBe("--session-id");
    expect(second).toEqual({ flag: "--resume", uuid: first.uuid });
    expect(sessions.claim("conv-2").uuid).not.toBe(first.uuid); // conversations are independent
    expect(first.uuid).toMatch(/^[0-9a-f-]{36}$/); // CLI demands a UUID (M0-3)
  });

  function planFor(dir: string, body: Partial<ChatRequestBody>, convId: string | null) {
    return prepareCliTurn(
      {
        dir,
        config: JuniorConfigSchema.parse({}),
        log: () => {},
        loopbackUrl: "http://127.0.0.1:8620",
        sessions: new CliSessionMap(),
      },
      {
        engine: "cli",
        provider: "claude-cli",
        model: "glm-5.3-flash",
        agentMode: false,
        cliTools: "browser",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        ...body,
      } as ChatRequestBody,
      convId,
    );
  }

  it("builds the full turn: mcp.json written, session claimed, prompt = last user text", () => {
    const dir = tmpDir();
    writeToken(TOKEN, dir);
    const plan = planFor(
      dir,
      {
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "earlier" }] },
          { id: "m2", role: "assistant", parts: [{ type: "text", text: "reply" }] },
          { id: "m3", role: "user", parts: [{ type: "text", text: "latest" }] },
        ],
      },
      "conv-9",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.options.prompt).toBe("latest");
    expect(plan.options.args).toContain("--session-id");
    expect(plan.sessionUuid).toBe(plan.options.args[plan.options.args.indexOf("--session-id") + 1]);
    const mcpConfigPath = plan.options.args[plan.options.args.indexOf("--mcp-config") + 1];
    expect(mcpConfigPath).toBe(join(dir, "mcp.json"));
    expect(readFileSync(mcpConfigPath!, "utf8")).toContain(TOKEN);
  });

  it("no token → 503 with the serve hint; missing cliPath → 503; no user text → 400", () => {
    const noToken = tmpDir(); // no writeToken
    expect(planFor(noToken, {}, "conv-1")).toMatchObject({
      ok: false,
      status: 503,
      error: expect.stringContaining("junior-bridge serve"),
    });
    const dir = tmpDir();
    writeToken(TOKEN, dir);
    // cliPath override fail-loud: a path that doesn't exist reports not-found
    const config = JuniorConfigSchema.parse({ cliPath: "/no/such/claude" });
    const plan = prepareCliTurn(
      {
        dir,
        config,
        log: () => {},
        sessions: new CliSessionMap(),
      },
      {
        engine: "cli",
        provider: "claude-cli",
        model: "m",
        agentMode: false,
        cliTools: "browser",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      } as ChatRequestBody,
      null,
    );
    expect(plan).toMatchObject({
      ok: false,
      status: 503,
      error: expect.stringContaining("/no/such/claude"),
    });
    expect(planFor(dir, { messages: [] }, null)).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("no user text"),
    });
  });

  it("no convId → no session flags (each turn cold)", () => {
    const dir = tmpDir();
    writeToken(TOKEN, dir);
    const plan = planFor(dir, {}, null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.options.args).not.toContain("--session-id");
    expect(plan.options.args).not.toContain("--resume");
  });
});

describe("lastUserText", () => {
  it("walks back to the last user turn; string content; parts joined; null when none", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "r" }] },
      { role: "user", content: "plain string" },
    ];
    expect(lastUserText(messages)).toBe("plain string");
    expect(lastUserText(messages.slice(0, 1))).toBe("one\ntwo");
    expect(
      lastUserText([{ role: "assistant", content: [{ type: "text", text: "r" }] }]),
    ).toBeNull();
  });
});

const init = { type: "system", subtype: "init", session_id: "sess-1", mcp_servers: [] };

// --- runCliTurn: real spawned child (node -e), never a real claude ----------------

/** A node -e script: prints the fixture events after draining stdin (the CLI reads
 * `-p -` from stdin, so the drain is behaviorally faithful). `mode` picks the path. */
function fixtureScript(events: unknown[], mode: "emit" | "exit1" | "raw"): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (${JSON.stringify(mode)} === "exit1") { process.stderr.write("boom: bad flag\\n"); process.exit(1); }
  if (${JSON.stringify(mode)} === "raw") { process.stdout.write("unparsable noise\\n" + JSON.stringify(${JSON.stringify(events[0])}) + "\\n"); return; }
  for (const e of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(e) + "\\n");
});
`;
}

async function runFixture(
  script: string,
  prompt = "hello",
): Promise<{ chunks: Array<Record<string, unknown>>; outcome: CliTurnOutcome }> {
  const chunks: Array<Record<string, unknown>> = [];
  const { runCliTurn } = await import("./engine-cli.js");
  const outcome = await runCliTurn(
    {
      exe: process.execPath,
      args: ["-e", script],
      prompt,
      log: () => {},
    },
    (chunk) => chunks.push(chunk as Record<string, unknown>),
  );
  return { chunks, outcome };
}

describe("runCliTurn (spawned node fixture)", () => {
  it("writes the prompt to stdin, maps the full turn, and resolves the result", async () => {
    const { chunks, outcome } = await runFixture(
      fixtureScript(
        [
          init,
          {
            type: "stream_event",
            event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
          },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `SAW:hello` },
            },
          },
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "SAW:hello" }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            num_turns: 1,
            duration_ms: 4,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ],
        "emit",
      ),
    );
    expect(chunks.map((c) => c.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      // assistant event deduped against the deltas — no second trio
    ]);
    expect(chunks.some((c) => c.type === "text-delta" && c.delta === "SAW:hello")).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({ isError: false, text: "done" });
    expect(outcome.initSessionId).toBe("sess-1");
    expect(outcome.error).toBeNull();
  });

  it("nonzero exit with no result → error chunk carrying the stderr tail (never swallowed)", async () => {
    const { chunks, outcome } = await runFixture(fixtureScript([], "exit1"));
    expect(outcome.exitCode).toBe(1);
    expect(chunks).toEqual([
      { type: "error", errorText: expect.stringContaining("boom: bad flag") },
    ]);
    expect(outcome.stderrTail).toContain("boom");
  });

  it("unparsable output counts a parse gap and still maps the good line; a clean exit with no result event errors", async () => {
    const { chunks, outcome } = await runFixture(fixtureScript([init], "raw"));
    expect(outcome.unknownLines).toBe(1);
    expect(outcome.initSessionId).toBe("sess-1");
    expect(chunks).toEqual([{ type: "error", errorText: "Claude CLI produced no result event" }]);
  });
});

// --- the route: POST /api/chat engine=cli over the real app ----------------------

const uiMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };

/** spawnImpl seam: records the CLI-style args, then REALLY spawns a node fixture —
 * proving the route pipes stdin/SSE through a genuine child process. */
function makeSpawnSeam(events: unknown[]) {
  const calls: Array<{ args: string[] }> = [];
  const spawnImpl: SpawnFn = (exe, args, opts) => {
    void exe;
    calls.push({ args: [...args] });
    return spawn(process.execPath, ["-e", fixtureScript(events, "emit")], opts);
  };
  return { spawnImpl, calls };
}

function newCliApp(spawnImpl: SpawnFn, cliPath?: string) {
  const dir = tmpDir();
  saveConfig(JuniorConfigSchema.parse(cliPath ? { cliPath } : {}), dir);
  writeToken(TOKEN, dir);
  const app = createApp({
    dir,
    log: () => {},
    chat: { cli: { spawnImpl, loopbackUrl: "http://127.0.0.1:9700" } },
  });
  return app;
}

function postChat(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat engine=cli (M4-4)", () => {
  it("streams the fixture turn as UI chunks; mcp.json regenerated; --session-id on turn 1, --resume on turn 2", async () => {
    const seam = makeSpawnSeam([
      init,
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "CLI_OK" },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        num_turns: 1,
        duration_ms: 4,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const app = newCliApp(seam.spawnImpl);
    const body = {
      engine: "cli",
      provider: "claude-cli",
      model: "glm-5.3-flash",
      messages: [uiMessage],
    };

    const res1 = await postChat(app, { ...body, id: "conv-a" });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/event-stream");
    const sse1 = await res1.text();
    expect(sse1).toContain('"type":"start"');
    expect(sse1).toContain("CLI_OK");
    expect(sse1).toContain('"type":"finish"');
    expect(seam.calls).toHaveLength(1);

    const call1 = seam.calls[0];
    expect(call1).toBeDefined();
    if (!call1) return;
    expect(call1.args).toContain("--tools");
    const mcpConfigPath = call1.args[call1.args.indexOf("--mcp-config") + 1];
    expect(mcpConfigPath).toMatch(/mcp\.json$/);
    const mcpJson = JSON.parse(readFileSync(mcpConfigPath!, "utf8")) as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
    };
    expect(mcpJson.mcpServers.junior_browser?.url).toBe("http://127.0.0.1:9700/mcp"); // harness loopback override
    expect(mcpJson.mcpServers.junior_browser?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const uuid1 = call1.args[call1.args.indexOf("--session-id") + 1];

    // Turn 2, same convId → --resume with the SAME uuid; new conv → fresh uuid.
    const res2 = await postChat(app, { ...body, id: "conv-a" });
    await res2.text();
    const res3 = await postChat(app, { ...body, id: "conv-b" });
    await res3.text();
    expect(seam.calls).toHaveLength(3);
    expect(seam.calls[1]!.args[seam.calls[1]!.args.indexOf("--resume") + 1]).toBe(uuid1);
    expect(seam.calls[2]!.args[seam.calls[2]!.args.indexOf("--session-id") + 1]).not.toBe(uuid1);
  });

  it("a spawned child's failure surfaces as an error part inside the UI stream", async () => {
    const spawnImpl: SpawnFn = (exe, args, opts) => {
      void exe;
      void args;
      return spawn(process.execPath, ["-e", fixtureScript([], "exit1")], opts);
    };
    const app = newCliApp(spawnImpl);
    const res = await postChat(app, {
      engine: "cli",
      provider: "claude-cli",
      model: "m",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200); // the SSE stream is the envelope; the failure rides inside
    const sse = await res.text();
    expect(sse).toContain("boom: bad flag");
    expect(sse).toContain('"type":"error"');
  });

  it("503s before spawning when the CLI is missing; 400s without user text", async () => {
    const seam = makeSpawnSeam([]);
    const dir = tmpDir();
    saveConfig(JuniorConfigSchema.parse({ cliPath: "/no/such/claude" }), dir);
    writeToken(TOKEN, dir);
    const app = createApp({ dir, log: () => {}, chat: { cli: { spawnImpl: seam.spawnImpl } } });
    const res = await postChat(app, {
      engine: "cli",
      provider: "claude-cli",
      model: "m",
      messages: [uiMessage],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("/no/such/claude");
    expect(seam.calls).toHaveLength(0); // never spawned

    const dir2 = tmpDir();
    saveConfig(JuniorConfigSchema.parse({}), dir2);
    writeToken(TOKEN, dir2);
    const app2 = createApp({
      dir: dir2,
      log: () => {},
      chat: { cli: { spawnImpl: seam.spawnImpl } },
    });
    const res2 = await postChat(app2, {
      engine: "cli",
      provider: "claude-cli",
      model: "m",
      messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "no user turn" }] }],
    });
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toContain("no user text");
    expect(seam.calls).toHaveLength(0);
  });

  it("stays behind the bearer gate like every other data route", async () => {
    const seam = makeSpawnSeam([]);
    const app = newCliApp(seam.spawnImpl);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        engine: "cli",
        provider: "claude-cli",
        model: "m",
        messages: [uiMessage],
      }),
    });
    expect(res.status).toBe(401);
    expect(seam.calls).toHaveLength(0);
  });
});

describe("runCliTurn abort (M4-5: panel Stop kills the spawned CLI)", () => {
  it("SIGTERMs the child on abort and surfaces the kill as an error chunk", async () => {
    const ac = new AbortController();
    const chunks: Array<Record<string, unknown>> = [];
    const { runCliTurn } = await import("./engine-cli.js");
    // A child that never exits on its own and never reads stdin — the abort
    // signal is the only way this turn ends.
    const pending = runCliTurn(
      {
        exe: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        prompt: "x",
        signal: ac.signal,
        log: () => {},
      },
      (chunk) => chunks.push(chunk as Record<string, unknown>),
    );
    await new Promise((r) => setTimeout(r, 300)); // let the child actually start
    ac.abort();
    const outcome = await pending;
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.result).toBeNull();
    // Fatal path surfaces as an error part — never swallowed (plan §4.5).
    expect(
      chunks.some((c) => c.type === "error" && String(c.errorText).includes("signal SIGTERM")),
    ).toBe(true);
  });

  it("kills immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks: Array<Record<string, unknown>> = [];
    const { runCliTurn } = await import("./engine-cli.js");
    const outcome = await runCliTurn(
      {
        exe: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        prompt: "x",
        signal: ac.signal,
        log: () => {},
      },
      (chunk) => chunks.push(chunk as Record<string, unknown>),
    );
    expect(outcome.signal).toBe("SIGTERM");
  });
});

describe("POST /api/chat abort (M4-5)", () => {
  it("aborting the request kills the spawned CLI mid-turn — the stream ends with an error part", async () => {
    // app.request passes RequestInit.signal straight into the Request — the same
    // object the route forwards to runCliTurn as c.req.raw.signal.
    const ac = new AbortController();
    const app = newCliApp((_exe, _args, opts) =>
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], opts),
    );
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        engine: "cli",
        provider: "claude-cli",
        model: "m",
        messages: [uiMessage],
      }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // child is up and hanging
    ac.abort(); // the panel's Stop — must not leave the turn running headless
    const sse = await res.text(); // resolves only once the killed child ends the turn
    expect(sse).toContain('"type":"error"');
    expect(sse).toContain("signal SIGTERM");
  });
});
