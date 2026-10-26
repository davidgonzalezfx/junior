// @junior/bridge/chat/engine-cli — the Claude CLI as the brain (plan §4.5 "Engine cli").
// The bridge spawns `claude -p` per POST /api/chat with --mcp-config pointing back at
// this bridge's own /mcp endpoint (generated mcp.json, token in the headers), so the
// CLI's browser tool calls traverse the SAME dispatcher + guard + approval cards as the
// panel and MCP clients. Stdout stream-json maps onto AI SDK v7 UI-message chunks so
// the panel's useChat renders the CLI engine like any other: text/thinking deltas,
// tool parts, finish. Parse gaps warn and skip; CLI stderr and a nonzero exit surface
// as an error chunk — never swallowed (ModelBridge hid failures in thought blocks).
// Session continuity: the bridge prescribes the UUID — `--session-id <uuid>` on a
// conversation's first turn, `--resume <uuid>` after (round trip verified);
// the `init` event's session_id is parsed for logs/debug only.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UIMessageChunk } from "ai";
import type { ChatRequestBody, JuniorConfig } from "@junior/protocol";
import { readToken } from "../config.js";
import { resolveClaudePath, sanitizeEnv } from "../cli-detect.js";
import type { Logger } from "../auth.js";
import { CliStreamMapper, type CliResult } from "./cli-mapper.js";

export { CliStreamMapper, type CliResult, type CliResultUsage } from "./cli-mapper.js";

export const MCP_SERVER_NAME = "junior_browser"; // CLAUDE.md naming convention

/** ~/.junior/mcp.json content — one HTTP server: this bridge's /mcp with the bearer
 * token in its headers (the exact shape `claude mcp add --transport http … --header`
 * writes). --strict-mcp-config makes this file the CLI's ENTIRE server list. */
export function buildMcpServers(loopbackUrl: string, token: string) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: `${loopbackUrl.replace(/\/+$/, "")}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** Atomic 0600 write (the file carries the bridge token — same posture as the token
 * file itself, config.ts). Returns the path for --mcp-config. Regenerated per turn so
 * a re-paired token is picked up without a bridge restart. */
export function writeMcpConfig(dir: string, loopbackUrl: string, token: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(buildMcpServers(loopbackUrl, token), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
  return path;
}

/** convId → CLI session UUID. The bridge prescribes the UUID so there is no
 * init-capture race (plan §4.5; verified `--session-id` then `--resume`). */
export class CliSessionMap {
  private readonly sessions = new Map<string, string>();

  claim(convId: string): { flag: "--session-id" | "--resume"; uuid: string } {
    const existing = this.sessions.get(convId);
    if (existing) return { flag: "--resume", uuid: existing };
    const uuid = randomUUID();
    this.sessions.set(convId, uuid);
    return { flag: "--session-id", uuid };
  }
}

export interface CliArgsOptions {
  mcpConfigPath: string;
  model: string;
  /** null = no convId on the wire → no continuity (each turn cold). */
  session: { flag: "--session-id" | "--resume"; uuid: string } | null;
  /** body.cliTools — "browser" (default) strips every built-in (`--tools ""`); "all"
   * keeps the CLI's native tools too, but only when the config gate
   * allowCliNativeTools is open (plan §4.5: configurable, default browser-only). */
  cliTools: "browser" | "all";
  nativeToolsAllowed: boolean;
}

export function buildCliArgs(o: CliArgsOptions): string[] {
  const args = [
    "-p",
    "-",
    "--output-format",
    "stream-json",
    "--verbose", // REQUIRED with stream-json in -p mode
    "--include-partial-messages",
    "--strict-mcp-config", // never inherit the cwd project's MCP servers
    "--mcp-config",
    o.mcpConfigPath,
  ];
  const native = o.cliTools === "all" && o.nativeToolsAllowed;
  if (!native) args.push("--tools", ""); // zero built-ins: tool surface = exactly our MCP tools
  // Server-wide pre-approval — the `mcp__server:*` wildcard is NOT honored in 2.1.310
  // Human approval still happens in the extension card via the bridge guard;
  // with native tools exposed, the CLI's own permission system denies them
  // non-interactively and the denial surfaces through tool_result/permission_denials.
  args.push("--allowedTools", `mcp__${MCP_SERVER_NAME}`);
  // ALWAYS explicit — spawned children otherwise inherit settings.json's model.
  args.push("--model", o.model);
  // (--effort has no wire field in ChatRequestBodySchema yet — add before spawning if
  // it ever lands; the CLI only warns+ignores bad values, so the bridge must validate.)
  if (o.session) args.push(o.session.flag, o.session.uuid);
  return args;
}

/** Last user turn's text — the CLI holds the conversation context itself (--resume),
 * so only the newest user text goes over stdin (ModelBridge parity). Reads the UIMessage
 * wire shape (`parts: [{type:"text",text}]`, what DefaultChatTransport sends) and
 * tolerates a bare string/array `content`. */
export function lastUserText(messages: Array<Record<string, unknown>>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    for (const candidate of [message.parts, message.content]) {
      if (typeof candidate === "string") return candidate || null;
      if (Array.isArray(candidate)) {
        const text = candidate
          .map((part) =>
            part !== null && typeof part === "object" && part.type === "text"
              ? String((part as { text?: unknown }).text ?? "")
              : "",
          )
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
    }
  }
  return null;
}

// --- the turn: spawn + pump ---------------------------------------------------

export interface CliTurnOptions {
  exe: string;
  args: string[];
  /** The last user turn's text, written to stdin then EOF (`-p -`). */
  prompt: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Abort (panel Stop / client disconnect) kills the spawned CLI. */
  signal?: AbortSignal;
  /** Test seam — defaults to node:child_process spawn. */
  spawnImpl?: SpawnFn;
  log?: Logger;
}

export interface CliTurnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn/pipe-level failure (ENOENT race, EPIPE) — also emitted as an error chunk. */
  error: string | null;
  result: CliResult | null;
  initSessionId: string | null;
  stderrTail: string;
  unknownLines: number;
  failedMcpServers: string[];
}

const STDERR_TAIL_CAP = 4096;

/** Narrow spawn seam — the real spawn's overload union makes 3-param test lambdas
 * unassignable; the turn only ever needs this exact call shape. */
export type SpawnFn = (
  exe: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export async function runCliTurn(
  o: CliTurnOptions,
  write: (chunk: UIMessageChunk) => void,
): Promise<CliTurnOutcome> {
  const log = o.log ?? (() => {});
  const doSpawn = o.spawnImpl ?? spawn;
  let exe = o.exe;
  let args = o.args;
  // Node ≥ 18.20 spawns of .cmd/.bat hard-fail EINVAL without a shell.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    args = ["/d", "/s", "/c", exe, ...args];
    exe = "cmd.exe";
  }
  const child = doSpawn(exe, args, {
    env: sanitizeEnv(o.env ?? process.env), // strip the parent session's CLAUDE_* wiring
    cwd: o.cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const mapper = new CliStreamMapper();
  let stderrTail = "";
  let spawnError: string | null = null;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      // Lines only ever split at the buffered boundary — a trailing "" from the final
      // newline is skipped by the JSON.parse guard below.
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        mapper.unknownLines += 1;
        log(`[chat:cli] unparsable stream-json line (skipped): ${line.slice(0, 200)}`);
        continue;
      }
      for (const out of mapper.handle(event)) write(out);
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
  });
  child.on("error", (error: Error) => {
    spawnError = error.message;
  });

  child.stdin?.on("error", () => {}); // EPIPE if the CLI exits before reading stdin
  child.stdin?.write(o.prompt);
  child.stdin?.end();

  // Client aborted (or aborted before the spawn even ran): kill the child so a
  // cancelled turn can't keep driving tools headless. "close" then fires
  // with the signal and the normal result handling reports it.
  if (o.signal !== undefined) {
    const kill = () => child.kill("SIGTERM");
    if (o.signal.aborted) kill();
    else o.signal.addEventListener("abort", kill, { once: true });
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  for (const name of mapper.failedMcpServers) {
    log(`[chat:cli] MCP server failed to connect: ${name} (init event)`);
  }
  if (mapper.unknownLines > 0)
    log(`[chat:cli] ${mapper.unknownLines} unparsed stream-json event(s)`);

  // Fatal paths surface as an error part — never swallowed (plan §4.5). A nonzero
  // exit WITH a result event (is_error) already emitted its error chunk in the mapper.
  if (spawnError !== null) {
    write({ type: "error", errorText: `Claude CLI could not start: ${spawnError}` });
  } else if (mapper.result === null) {
    write({
      type: "error",
      errorText:
        exit.code === 0
          ? "Claude CLI produced no result event"
          : `Claude CLI exited with code ${exit.code ?? `signal ${exit.signal}`}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
    });
  }

  return {
    exitCode: exit.code,
    signal: exit.signal,
    error: spawnError,
    result: mapper.result,
    initSessionId: mapper.initSessionId,
    stderrTail,
    unknownLines: mapper.unknownLines,
    failedMcpServers: [...mapper.failedMcpServers],
  };
}

// --- route-side preparation ----------------------------------------------------

export interface CliEngineDeps {
  dir: string;
  config: JuniorConfig;
  log: Logger;
  /** Override for the /mcp loopback URL — the harness binds port 0, prod binds
   * config.port. Default: http://127.0.0.1:<config.port>. */
  loopbackUrl?: string;
  spawnImpl?: SpawnFn;
  /** Shared across requests — the --resume map (one per app). */
  sessions: CliSessionMap;
}

export type CliTurnPlan =
  | { ok: false; status: 400 | 503; error: string }
  | { ok: true; options: CliTurnOptions; sessionUuid: string | null };

/** Everything the turn needs except the running of it: token, resolved CLI path,
 * regenerated mcp.json, claimed session UUID, built args, extracted prompt. */
export function prepareCliTurn(
  deps: CliEngineDeps,
  body: ChatRequestBody,
  convId: string | null,
): CliTurnPlan {
  const token = readToken(deps.dir);
  if (token === null) {
    return {
      ok: false,
      status: 503,
      error: "bridge token missing — run `junior-bridge serve` (§4.1)",
    };
  }
  const exe = resolveClaudePath({
    override: deps.config.cliPath,
    env: process.env,
    platform: process.platform,
    home: homedir(),
  });
  if (exe === null) {
    return {
      ok: false,
      status: 503,
      error: deps.config.cliPath
        ? `claude CLI not found at cliPath "${deps.config.cliPath}" — fix Settings or install Claude Code`
        : "claude CLI not found on PATH — install Claude Code or set cliPath in ~/.junior/config.json",
    };
  }
  const prompt = lastUserText(body.messages);
  if (prompt === null) {
    return {
      ok: false,
      status: 400,
      error: "invalid chat request — no user text for the CLI engine",
    };
  }
  const loopback = deps.loopbackUrl ?? `http://127.0.0.1:${deps.config.port}`;
  const mcpConfigPath = writeMcpConfig(deps.dir, loopback, token);
  const session = convId !== null ? deps.sessions.claim(convId) : null;
  return {
    ok: true,
    sessionUuid: session?.uuid ?? null,
    options: {
      exe,
      args: buildCliArgs({
        mcpConfigPath,
        model: body.model,
        session,
        cliTools: body.cliTools,
        nativeToolsAllowed: deps.config.allowCliNativeTools,
      }),
      prompt,
      spawnImpl: deps.spawnImpl,
      log: deps.log,
    },
  };
}
