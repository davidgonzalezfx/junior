// T2 (review R§3.1) — Node delivers child stdout at arbitrary byte boundaries, so a
// stream-json line can arrive split mid-JSON, mid multi-byte UTF-8 character, or
// across 3+ chunks. runCliTurn must map exactly what the unsplit stream maps. A fake
// child behind the spawnImpl seam pins the chunk boundaries deterministically (a real
// pipe coalesces writes unpredictably).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  cliAssistantText,
  cliInit,
  cliResult,
  cliTextDelta,
  cliTextStart,
  cliTextStop,
} from "@junior/testkit/cli-stream";
import type { CliTurnOutcome, SpawnFn } from "./engine-cli.js";

const BIG_INPUT = { text: "héllo — 日本語 🎉 ".repeat(400), selector: "#main > .row" };

const EVENTS: unknown[] = [
  cliInit("sess-1"),
  cliTextStart(),
  cliTextDelta(0, "Ünïcödé 👋 hi"),
  cliTextStop(),
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_1", name: "mcp__junior_browser__type", input: BIG_INPUT },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "typed ✓" }] },
  },
  cliAssistantText("done ✅"),
  cliResult({ result: "finished — ✅ ".repeat(200) }),
];

function streamBytes(eol = "\n"): Buffer {
  return Buffer.from(EVENTS.map((e) => JSON.stringify(e) + eol).join(""), "utf8");
}

/** A child whose stdout emits exactly `chunks` (one data event each), then closes 0. */
function chunkedChild(chunks: Buffer[]): SpawnFn {
  return () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.resume();
    Object.assign(child, { stdout, stderr, stdin, kill: () => true });
    void (async () => {
      for (const c of chunks) {
        stdout.write(c);
        await new Promise((r) => setImmediate(r)); // one data event per chunk
      }
      stdout.end();
      stderr.end();
      await new Promise((r) => setImmediate(r));
      child.emit("close", 0, null);
    })();
    return child as unknown as ChildProcess;
  };
}

function splitAt(buf: Buffer, offsets: number[]): Buffer[] {
  const out: Buffer[] = [];
  let prev = 0;
  for (const o of [...offsets].sort((a, b) => a - b)) {
    out.push(buf.subarray(prev, o));
    prev = o;
  }
  out.push(buf.subarray(prev));
  return out.filter((b) => b.length > 0);
}

async function run(chunks: Buffer[]): Promise<{
  chunks: Array<Record<string, unknown>>;
  outcome: CliTurnOutcome;
}> {
  const written: Array<Record<string, unknown>> = [];
  const { runCliTurn } = await import("./engine-cli.js");
  const outcome = await runCliTurn(
    { exe: "claude", args: [], prompt: "x", log: () => {}, spawnImpl: chunkedChild(chunks) },
    (chunk) => written.push(chunk as Record<string, unknown>),
  );
  return { chunks: written, outcome };
}

describe("runCliTurn stdout line buffering (T2)", () => {
  it("baseline: the unsplit stream maps the tool step and the result", async () => {
    const { chunks, outcome } = await run([streamBytes()]);
    expect(outcome.unknownLines).toBe(0);
    expect(outcome.result).toMatchObject({ isError: false });
    expect(chunks).toContainEqual({
      type: "tool-input-available",
      toolCallId: "toolu_1",
      toolName: "mcp__junior_browser__type",
      input: BIG_INPUT,
    });
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  const bytes = streamBytes();
  // Byte offsets inside interesting spots.
  const emoji = bytes.indexOf(Buffer.from("🎉"));
  const toolLineStart = bytes.indexOf(Buffer.from('{"type":"assistant"'));
  const toolLineEnd = bytes.indexOf(0x0a, toolLineStart);
  const crlf = streamBytes("\r\n");
  const resultStart = bytes.indexOf(Buffer.from('{"type":"result"'));
  const cjk = bytes.indexOf(Buffer.from("本"));

  const cases: Array<[string, Buffer[]]> = [
    [
      "mid-JSON of the tool_use and result lines",
      splitAt(bytes, [toolLineStart + 50, resultStart + 30]),
    ],
    [
      "mid multi-byte UTF-8 characters (4-byte emoji, 3-byte CJK)",
      splitAt(bytes, [emoji + 2, cjk + 1]),
    ],
    [
      "the tool_use line across 4 chunks",
      splitAt(bytes, [
        toolLineStart + 10,
        toolLineStart + Math.floor((toolLineEnd - toolLineStart) / 2),
        toolLineEnd - 3,
      ]),
    ],
    [
      "right before and right after each newline",
      splitAt(bytes, [toolLineEnd, toolLineEnd + 1, resultStart - 1]),
    ],
    [
      "7-byte chunks across the whole stream",
      Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) =>
        bytes.subarray(i * 7, i * 7 + 7),
      ),
    ],
    ["CRLF line endings, split mid-CRLF", splitAt(crlf, [crlf.indexOf(0x0d) + 1, 333])],
  ];

  it.each(cases)("maps identically when split %s", async (_label, chunks) => {
    const reference = await run([bytes]);
    const split = await run(chunks);
    expect(split.outcome.unknownLines).toBe(0);
    expect(split.chunks).toEqual(reference.chunks);
    expect(split.outcome).toEqual(reference.outcome);
  });

  it("flushes a final line that has no trailing newline", async () => {
    const reference = await run([bytes]);
    const noFinalEol = bytes.subarray(0, bytes.length - 1);
    const split = await run(splitAt(noFinalEol, [resultStart + 5]));
    expect(split.outcome.result).toEqual(reference.outcome.result);
    expect(split.chunks).toEqual(reference.chunks);
  });
});
