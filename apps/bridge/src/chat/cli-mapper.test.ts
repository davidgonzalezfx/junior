// M4-4 — CliStreamMapper unit tests (plan §4.5 "Stream mapping"): stream-json events
// in, UI-message chunks out. Pure — no process spawned. The live shape was captured
// off the real CLI 2.1.310 (assistant event lands between the deltas and
// content_block_stop; message 2 reuses message 1's block indexes).
import { describe, expect, it } from "vitest";
import { CliStreamMapper } from "./cli-mapper.js";

// --- stream-json → UI chunks ---------------------------------------------------

const init = { type: "system", subtype: "init", session_id: "sess-1", mcp_servers: [] };

describe("CliStreamMapper", () => {
  it("maps text + thinking deltas into well-formed start/delta/end parts", () => {
    const m = new CliStreamMapper();
    const chunks = [
      init,
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm " },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "hello" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "signature_delta", signature: "x" },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
      },
    ].flatMap((e) => m.handle(e));
    expect(chunks).toEqual([
      { type: "reasoning-start", id: "cli-1" },
      { type: "reasoning-delta", id: "cli-1", delta: "hmm " },
      { type: "reasoning-end", id: "cli-1" },
      { type: "text-start", id: "cli-2" },
      { type: "text-delta", id: "cli-2", delta: "hello" },
      { type: "text-end", id: "cli-2" },
    ]);
  });

  it("maps assistant tool_use → tool-input-available and user tool_result → tool-output-available", () => {
    const m = new CliStreamMapper();
    const chunks = [
      m.handle({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "navigate", input: { url: "https://x" } },
          ],
        },
      }),
      m.handle({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "navigated" }],
            },
          ],
        },
      }),
    ].flat();
    expect(chunks).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "toolu_1",
        toolName: "navigate",
        input: { url: "https://x" },
      },
      { type: "tool-output-available", toolCallId: "toolu_1", output: "navigated" },
    ]);
  });

  it("a text block that never streamed deltas is emitted once as a catch-up trio; streamed text is NOT duplicated", () => {
    const streamed = new CliStreamMapper();
    streamed.handle({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    });
    streamed.handle({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "STREAMED" },
      },
    });
    streamed.handle({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "text", text: "STREAMED" }] },
    };
    expect(streamed.handle(assistant)).toEqual([]); // dedupe: identical delta text already went out

    const gapped = new CliStreamMapper();
    const chunks = gapped.handle(assistant);
    expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
  });

  it("delta accumulation is PER MESSAGE: message 2's assistant event doesn't see message 1's residue", () => {
    // Real CLI shape (2.1.310): the assistant event lands between the deltas and
    // content_block_stop, and message 2 reuses message 1's block indexes.
    const m = new CliStreamMapper();
    const turn = (text: string) => [
      { type: "stream_event", event: { type: "message_start", message: {} } },
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      },
      // assistant event BEFORE content_block_stop — the observed order
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    const msg1 = turn("FIRST").flatMap((e) => m.handle(e));
    expect(msg1.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]); // deduped
    const msg2 = turn("SECOND").flatMap((e) => m.handle(e));
    expect(msg2.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]); // deduped again
    // and the emitted text is exactly message 2's — no residue prepended
    const delta = msg2.find((c) => c.type === "text-delta") as { delta: string };
    expect(delta.delta).toBe("SECOND");
  });

  it("result event: usage parsed for later chips; is_error → an error chunk", () => {
    const m = new CliStreamMapper();
    expect(m.handle(init)).toEqual([]);
    expect(m.initSessionId).toBe("sess-1");
    expect(
      m.handle({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        num_turns: 3,
        duration_ms: 1200,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ).toEqual([]);
    expect(m.result).toMatchObject({ isError: false, numTurns: 3, usage: { input_tokens: 10 } });

    const bad = new CliStreamMapper();
    const chunks = bad.handle({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "model overloaded",
    });
    expect(chunks).toEqual([{ type: "error", errorText: "model overloaded" }]);
  });

  it("failed MCP servers from init are collected (non-fatal, M0-3)", () => {
    const m = new CliStreamMapper();
    m.handle({
      type: "system",
      subtype: "init",
      session_id: "s",
      mcp_servers: [
        { name: "junior_browser", status: "connected" },
        { name: "junior_browser", status: "failed", source: "dynamic" },
      ],
    });
    expect(m.failedMcpServers).toEqual(["junior_browser"]);
  });

  it("garbage lines count as parse gaps and map to nothing (warn-and-skip)", () => {
    const m = new CliStreamMapper();
    expect(m.handle("not json")).toEqual([]);
    expect(m.handle({ type: "mystery" })).toEqual([]);
    expect(m.unknownLines).toBe(2);
  });
});
