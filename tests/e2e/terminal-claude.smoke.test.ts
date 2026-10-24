// tests/e2e/terminal-claude.smoke.test.ts — M4-2 terminal-Claude e2e (plan §8
// M4-2, M4 acceptance (a)): the REAL `claude` CLI registers the harness bridge
// as an MCP server (`claude mcp add --transport http`), then drives a guarded
// click on the sensitive bank fixture. The tool call surfaces as the SAME
// approval card the panel would show; the scripted user answers "once"; the
// click executes and the model reports the post-click banner — the headline
// demo, end to end, with no Junior chat engine involved.
//
// Gated behind JUNIOR_E2E_TERMINAL_CLAUDE=1: it spawns the real CLI and spends
// real model tokens, so the default `pnpm -r test` gate stays hermetic (same
// pattern as the M0-4 real-gateway leg). Run:
//   JUNIOR_E2E_TERMINAL_CLAUDE=1 pnpm --filter @junior/tests-e2e exec vitest run terminal-claude
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startHarness, type FakePage } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNIN_URL = "https://www.chase.com/sign-in";
const BANNER_AFTER = "Signed in attempt recorded";

// Server name per the Junior naming convention (CLAUDE.md): the CLI exposes the
// catalog as mcp__junior_browser__* — verified by the tool-name assertions below.
const SERVER_NAME = "junior_browser";

/** Claude Code session-wiring vars a nested `claude` must not inherit (spikes/cli/flags.sh). */
const SESSION_ENV_STRIP = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_SESSION_ATTENDED",
] as const;

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SESSION_ENV_STRIP) delete env[key];
  return env;
}

/** Sync run — only for fast config commands; safe to block the loop (long-polls tolerate it). */
function runClaudeSync(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("claude", args, {
    cwd,
    env: claudeEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface StreamEvent {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  message?: { content?: Array<{ type: string; name?: string }> };
}

/** Async run of `claude -p` with stream-json — must not block the harness event loop. */
function runClaudePrint(
  cwd: string,
  prompt: string,
  timeoutMs: number,
): Promise<{
  code: number | null;
  events: StreamEvent[];
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose", // REQUIRED with stream-json in -p mode (M0-3 learning)
        "--tools",
        "", // zero built-ins; MCP tools remain (M0-3 prod combo)
        "--allowedTools",
        // Server-wide form: 2.1.310 does NOT honor the mcp__server:* wildcard
        // for pre-approval (permission_denials in the first smoke run) — the
        // bare server name approves all its tools.
        `mcp__${SERVER_NAME}`,
      ],
      { cwd, env: claudeEnv() },
    );
    const events: StreamEvent[] = [];
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("{")) {
          try {
            events.push(JSON.parse(line) as StreamEvent);
          } catch {
            // partial/truncated line — the next chunk reassembles it
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, events, stderr });
    });
  });
}

const RUN = process.env.JUNIOR_E2E_TERMINAL_CLAUDE === "1";

function bankPage(): FakePage {
  return {
    title: "First Meridian Bank — Sign in",
    html: readFileSync(join(HERE, "../fixtures/bank.html"), "utf8"),
    onShow: (doc) => {
      doc.getElementById("signin-btn")?.addEventListener("click", () => {
        doc.getElementById("banner")!.textContent = BANNER_AFTER;
      });
    },
  };
}

describe.skipIf(!RUN)("terminal-Claude e2e (M4-2)", () => {
  beforeEach(() => {
    fakeBrowser.reset(); // session site grants must not leak between scenarios
  });

  it(
    "claude mcp add → guarded click through an approval card → model reports the outcome",
    { timeout: 300_000 },
    async () => {
      const h = await startHarness({
        tabUrl: SIGNIN_URL,
        pages: { [SIGNIN_URL]: bankPage() },
        mode: "auto",
      });
      // LOCAL scope (the CLI default): project-scope (.mcp.json) servers sit
      // "⏸ Pending approval" until an interactive `claude` run approves them —
      // a headless -p run would never see the tools. Local entries live under
      // projects.<cwd> in ~/.claude.json keyed by the tmp cwd; `mcp remove`
      // deletes the server, and the tmp key litters nothing in the repo.
      const cwd = mkdtempSync(join(tmpdir(), "junior-m4-2-"));
      try {
        await h.waitConnected();

        // 1. Register the bridge with the REAL CLI, exactly as documented.
        const add = runClaudeSync(cwd, [
          "mcp",
          "add",
          "--transport",
          "http",
          SERVER_NAME,
          `${h.bridgeUrl}/mcp`,
          "--header",
          `Authorization: Bearer ${h.token}`,
          "--scope",
          "local",
        ]);
        expect(add.status).toBe(0);

        // 2. The CLI's own health check reaches /mcp (initialize + tools/list).
        const list = runClaudeSync(cwd, ["mcp", "list"]);
        expect(list.status).toBe(0);
        expect(list.stdout).toContain(SERVER_NAME);

        // 3. The guarded click: the card fires while the click tool call is in
        //    flight; pre-script enough "once" answers for strays (unscripted ⇒ deny).
        h.answerNext("once");
        h.answerNext("once");
        h.answerNext("once");

        const run = await runClaudePrint(
          cwd,
          "The browser tab Junior controls is already open. Use only the " +
            `${SERVER_NAME} tools: call get_active_tab, then read_page with mode ` +
            '"outline", then click the sign-in button. Finally report the exact ' +
            "text shown in the page's status banner.",
          240_000,
        );
        expect(run.code).toBe(0);

        // 4. Tool naming proof (M4-1 backlog): the CLI addressed the catalog as
        //    mcp__junior_browser__*, including the guarded click.
        const toolCalls = run.events.flatMap((e) =>
          (e.message?.content ?? [])
            .filter((b) => b.type === "tool_use")
            .map((b) => ({ name: b.name ?? "", input: (b as { input?: unknown }).input })),
        );
        // Compact transcript — session-log evidence + failure diagnostics.
        console.log("[m4-2] tool calls:", JSON.stringify(toolCalls));
        const result = run.events.find((e) => e.type === "result");
        console.log("[m4-2] result:", JSON.stringify(result));
        expect(toolCalls.length).toBeGreaterThan(0);
        expect(toolCalls.some((c) => c.name === `mcp__${SERVER_NAME}__click`)).toBe(true);
        expect(result).toBeDefined();
        expect(result!.is_error).toBe(false);
        expect(result!.result).toContain(BANNER_AFTER);

        // 5. The card path really happened: one sensitive_site mirror card for
        //    the click (clicks never ride the wire), answered "once", executed.
        expect(h.cards.length).toBeGreaterThanOrEqual(1);
        expect(h.cards[0]!.reasonCodes).toContain("sensitive_site");
        expect(h.tab.document.getElementById("banner")!.textContent).toBe(BANNER_AFTER);
      } finally {
        runClaudeSync(cwd, ["mcp", "remove", SERVER_NAME, "--scope", "local"]);
        rmSync(cwd, { recursive: true, force: true });
        await h.stop();
      }
    },
  );
});
