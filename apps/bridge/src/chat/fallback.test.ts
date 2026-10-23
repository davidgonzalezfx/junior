// M2-4 fallback-chain unit tests: pure ordering, the probe/replay stream mechanics,
// and firstSuccessfulStream's attempt semantics. Streams are hand-built — no SDK.
import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import { AllProvidersFailedError, buildCandidateChain, firstSuccessfulStream, probeUiStream } from "./fallback.js";

function streamOf(...chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A stream that emits an error chunk and closes (what streamText produces when the
 * provider 4xx/5xxs before the first token). */
function errorStream(): ReadableStream<UIMessageChunk> {
  return streamOf({ type: "start" }, { type: "start-step" }, { type: "error", errorText: "401 Unauthorized" });
}

function contentStream(text: string): ReadableStream<UIMessageChunk> {
  return streamOf(
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  );
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("buildCandidateChain", () => {
  it("puts the requested provider first and dedupes chain entries", () => {
    expect(buildCandidateChain("anthropic", ["openrouter", "anthropic", "glm"])).toEqual([
      "anthropic",
      "openrouter",
      "glm",
    ]);
  });
  it("an empty chain leaves exactly the primary", () => {
    expect(buildCandidateChain("anthropic", [])).toEqual(["anthropic"]);
  });
});

describe("probeUiStream", () => {
  it("ok on first content; replays buffered lifecycle chunks ahead of the live stream", async () => {
    const probe = probeUiStream(contentStream("HELLO"));
    expect(await probe.verdict).toBe("ok");
    const chunks = await collect(probe.stream);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    const delta = chunks.find((c) => c.type === "text-delta") as { delta: string };
    expect(delta.delta).toBe("HELLO");
  });

  it("error when an error chunk lands before any content", async () => {
    const probe = probeUiStream(errorStream());
    expect(await probe.verdict).toBe("error");
  });

  it("empty when the stream ends without content or error", async () => {
    const probe = probeUiStream(streamOf({ type: "start" }, { type: "finish" }));
    expect(await probe.verdict).toBe("empty");
  });

  it("counts a tool-input chunk as content (agent streams must not trigger fallback)", async () => {
    const probe = probeUiStream(
      streamOf({ type: "start" }, { type: "tool-input-start", toolCallId: "t1", toolName: "read_page" }),
    );
    expect(await probe.verdict).toBe("ok");
    await collect(probe.stream);
  });
});

describe("firstSuccessfulStream", () => {
  it("falls back to the next attempt when the first errors pre-token, replay intact", async () => {
    const stream = await firstSuccessfulStream([() => errorStream(), () => contentStream("BACKUP_OK")]);
    const chunks = await collect(stream);
    expect(chunks[0]?.type).toBe("start");
    expect(chunks.some((c) => c.type === "text-delta" && (c as { delta: string }).delta === "BACKUP_OK")).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe("finish");
  });

  it("skips a thunk that throws (stale chain entry) without aborting the route", async () => {
    const stream = await firstSuccessfulStream([
      () => {
        throw new Error('provider "ghost" is not configured');
      },
      () => contentStream("PRIMARY_OK"),
    ]);
    const chunks = await collect(stream);
    expect(chunks.some((c) => c.type === "text-delta" && (c as { delta: string }).delta === "PRIMARY_OK")).toBe(true);
  });

  it("throws AllProvidersFailedError aggregating every failure when nothing produces content", async () => {
    await expect(
      firstSuccessfulStream([() => errorStream(), () => streamOf({ type: "finish" })]),
    ).rejects.toThrow(AllProvidersFailedError);
  });
});
