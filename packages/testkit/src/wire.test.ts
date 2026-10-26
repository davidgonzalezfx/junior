// Byte-equality pins (workplan C2): every builder must emit exactly the literal
// string the deduplicated copies used before extraction — a builder change that
// would silently alter what a consumer test's code under test receives fails here.
import { describe, expect, it } from "vitest";
import { assistantMessage, userMessage } from "./chat.js";
import {
  cliAssistantText,
  cliInit,
  cliResult,
  cliTextDelta,
  cliTextStart,
  cliTextStop,
} from "./cli-stream.js";
import { anthropicTextTurn, anthropicToolUseTurn, sseData, uiTextTurn } from "./wire.js";

describe("wire builders emit the pre-dedup literal bytes", () => {
  it("anthropicTextTurn = agent-mode textTurn", () => {
    expect(
      anthropicTextTurn("OPENED: done.", {
        messageId: "msg_final",
        model: "harness-mock",
        inputTokens: 200,
        startOutputTokens: 1,
        outputTokens: 10,
      }),
    ).toBe(
      `event: message_start\n` +
        `data: {"type":"message_start","message":{"id":"msg_final","role":"assistant","content":[],"model":"harness-mock","usage":{"input_tokens":200,"output_tokens":1}}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OPENED: done."}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n` +
        `data: [DONE]\n\n`,
    );
  });

  it("anthropicTextTurn = routes.test's model-less anthropicMockFetch body", () => {
    expect(
      anthropicTextTurn("ANTHROPIC_MOCK_OK", {
        messageId: "msg_mock",
        inputTokens: 9,
        outputTokens: 4,
      }),
    ).toBe(
      `event: message_start\n` +
        `data: {"type":"message_start","message":{"id":"msg_mock","role":"assistant","content":[],"usage":{"input_tokens":9}}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ANTHROPIC_MOCK_OK"}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n` +
        `data: [DONE]\n\n`,
    );
  });

  it("anthropicToolUseTurn = agent-mode toolUseTurn", () => {
    expect(
      anthropicToolUseTurn(
        "toolu_1",
        "navigate",
        { url: "https://x" },
        {
          messageId: "msg_toolu_1",
          model: "harness-mock",
          inputTokens: 100,
          startOutputTokens: 1,
          outputTokens: 30,
        },
      ),
    ).toBe(
      `event: message_start\n` +
        `data: {"type":"message_start","message":{"id":"msg_toolu_1","role":"assistant","content":[],"model":"harness-mock","usage":{"input_tokens":100,"output_tokens":1}}}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
        `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"navigate","input":{}}}\n\n` +
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":\\"https://x\\"}"}}\n\n` +
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n` +
        `data: [DONE]\n\n`,
    );
  });

  it("uiTextTurn = the chat-panel UI_STREAM literal", () => {
    expect(uiTextTurn(["Hello ", "**world**"])).toBe(
      [
        `data: {"type":"start"}`,
        `data: {"type":"start-step"}`,
        `data: {"type":"text-start","id":"1"}`,
        `data: {"type":"text-delta","id":"1","delta":"Hello "}`,
        `data: {"type":"text-delta","id":"1","delta":"**world**"}`,
        `data: {"type":"text-end","id":"1"}`,
        `data: {"type":"finish-step"}`,
        `data: {"type":"finish"}`,
        `data: [DONE]`,
      ]
        .map((line) => `${line}\n\n`)
        .join(""),
    );
    expect(
      uiTextTurn(["Done."], {
        finish: { type: "finish", finishReason: "stop", messageMetadata: { provider: "p" } },
      }),
    ).toContain(
      `data: {"type":"finish","finishReason":"stop","messageMetadata":{"provider":"p"}}\n\n`,
    );
    expect(sseData([{ type: "start" }, { type: "finish" }])).toBe(
      `data: {"type":"start"}\n\ndata: {"type":"finish"}\n\n`,
    );
  });
});

describe("cli-stream builders", () => {
  it("match the engine-cli fixture literals", () => {
    expect(cliInit("sess-1")).toEqual({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      mcp_servers: [],
    });
    expect(cliTextStart()).toEqual({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    });
    expect(cliTextDelta(0, "SAW:hello")).toEqual({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "SAW:hello" },
      },
    });
    expect(cliTextStop()).toEqual({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    expect(cliAssistantText("SAW:hello")).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "SAW:hello" }] },
    });
    expect(cliResult()).toEqual({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      num_turns: 1,
      duration_ms: 4,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
});

describe("chat factories", () => {
  it("default ids follow the u-/a- convention; explicit ids win", () => {
    expect(userMessage("hi")).toEqual({
      id: "u-hi",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(assistantMessage("hey")).toEqual({
      id: "a-hey",
      role: "assistant",
      parts: [{ type: "text", text: "hey" }],
    });
    expect(userMessage("hi", "m1")).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });
});
