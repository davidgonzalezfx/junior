// M4-4 — engine "cli" tests (plan §4.5 "Engine cli", §8 M4-4): arg matrix, mcp.json
// loopback, the --resume session map. Spawned turns: engine-cli.run.test.ts; the HTTP
// route: engine-cli.route.test.ts; the result → usage-metadata mapping: metadata.test.ts.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorConfigSchema, type ChatRequestBody } from "@junior/protocol";
import { writeToken } from "../config.js";
import {
  CliSessionMap,
  buildCliArgs,
  lastUserText,
  prepareCliTurn,
  writeMcpConfig,
} from "./engine-cli.js";
import { TOKEN, cleanupTmpDirs, tmpDir } from "./engine-cli.test-support.js";

afterEach(cleanupTmpDirs);

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
