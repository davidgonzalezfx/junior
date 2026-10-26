// M4-4/M4-5 — POST /api/chat engine=cli over the real Hono app with a spawnImpl
// seam that REALLY spawns a node fixture child: UI-chunk streaming, mcp.json
// loopback regeneration, the --session-id/--resume map, error parts, the 503/400
// pre-spawn guards, the bearer gate, and request abort killing the child.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorConfigSchema } from "@junior/protocol";
import { cliResult, cliTextDelta, cliTextStart, cliTextStop } from "@junior/testkit/cli-stream";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";
import type { SpawnFn } from "./engine-cli.js";
import {
  TOKEN,
  cleanupTmpDirs,
  fixtureScript,
  init,
  makeSpawnSeam,
  newCliApp,
  postChat,
  tmpDir,
  uiMessage,
} from "./engine-cli.test-support.js";

afterEach(cleanupTmpDirs);

describe("POST /api/chat engine=cli (M4-4)", () => {
  it("streams the fixture turn as UI chunks; mcp.json regenerated; --session-id on turn 1, --resume on turn 2", async () => {
    const seam = makeSpawnSeam([
      init,
      cliTextStart(),
      cliTextDelta(0, "CLI_OK"),
      cliTextStop(),
      cliResult(),
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
    // M5-1 usage chips: the result event's usage/cost/duration ride as message metadata.
    expect(sse1).toContain('"type":"message-metadata"');
    expect(sse1).toContain('"inputTokens":1');
    expect(sse1).toContain('"outputTokens":1');
    expect(sse1).toContain('"totalTokens":2');
    expect(sse1).toContain('"durationMs":4');
    expect(sse1).toContain('"provider":"claude-cli"');
    expect(sse1).toContain('"model":"glm-5.3-flash"');
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
