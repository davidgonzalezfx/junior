// Claude CLI stream-json event builders (workplan C2) — fixtures for the shapes
// the real CLI 2.1.310 emits on stdout (see cli-mapper.ts). Granular on purpose:
// mapper tests pin event ORDER (e.g. the assistant event landing between the
// deltas and content_block_stop), so no builder assembles a whole turn.

export function cliInit(sessionId: string): Record<string, unknown> {
  return { type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] };
}

export function cliTextStart(index = 0): Record<string, unknown> {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text" } },
  };
}

export function cliTextDelta(index: number, text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

export function cliTextStop(index = 0): Record<string, unknown> {
  return { type: "stream_event", event: { type: "content_block_stop", index } };
}

export function cliAssistantText(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

/** The successful-turn result event; override any field for variants. */
export function cliResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    duration_ms: 4,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  };
}
