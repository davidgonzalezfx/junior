// M4-4/M4-5 — runCliTurn against a REAL spawned child (node -e), never a real
// `claude`: the full-turn mapping, fatal-path error parts (nonzero exit, parse
// gaps, no result event), and abort → SIGTERM.
import { afterEach, describe, expect, it } from "vitest";
import {
  cliAssistantText,
  cliResult,
  cliTextDelta,
  cliTextStart,
  cliTextStop,
} from "@junior/testkit/cli-stream";
import { cleanupTmpDirs, fixtureScript, init, runFixture } from "./engine-cli.test-support.js";

afterEach(cleanupTmpDirs);

describe("runCliTurn (spawned node fixture)", () => {
  it("writes the prompt to stdin, maps the full turn, and resolves the result", async () => {
    const { chunks, outcome } = await runFixture(
      fixtureScript(
        [
          init,
          cliTextStart(),
          cliTextDelta(0, `SAW:hello`),
          cliTextStop(),
          cliAssistantText("SAW:hello"),
          cliResult(),
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
