// Provider- and panel-facing SSE wire builders (workplan C2). These reproduce the
// exact byte sequences the originals did — the wire.test.ts smoke test pins them
// to the literal strings the copies used before dedup, so a builder change that
// would have altered what a consumer test sees fails here first.

/** Frame an Anthropic Messages-API turn (or any `event:`/`data:` SSE pair list)
 * into wire bytes, terminated the way the SDK expects. */
export function anthropicSse(events: Array<Record<string, unknown>>): string {
  return (
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

/** SSE frames from plain chunk objects (`data: <json>\n\n` each) — the
 * bridge→panel UI message stream shape. */
export function sseData(frames: unknown[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
}

export interface AnthropicTurnOpts {
  messageId: string;
  /** model field on message_start — omitted entirely when absent (some recorded
   * mocks don't carry it; the bytes must stay exactly what each test saw). */
  model?: string;
  inputTokens: number;
  /** output_tokens inside message_start's usage — only some turns carry it. */
  startOutputTokens?: number;
  outputTokens: number;
}

function messageStart(o: AnthropicTurnOpts): Record<string, unknown> {
  const message: Record<string, unknown> = { id: o.messageId, role: "assistant", content: [] };
  if (o.model !== undefined) message.model = o.model;
  const usage: Record<string, unknown> = { input_tokens: o.inputTokens };
  if (o.startOutputTokens !== undefined) usage.output_tokens = o.startOutputTokens;
  message.usage = usage;
  return { type: "message_start", message };
}

/** One complete Anthropic text turn (stop_reason end_turn) as SSE bytes. */
export function anthropicTextTurn(text: string, o: AnthropicTurnOpts): string {
  return anthropicSse([
    messageStart(o),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: o.outputTokens },
    },
    { type: "message_stop" },
  ]);
}

/** One complete Anthropic tool-use turn (stop_reason tool_use): an empty text
 * block, then the tool_use block with the input as a single JSON delta. */
export function anthropicToolUseTurn(
  id: string,
  name: string,
  input: unknown,
  o: AnthropicTurnOpts,
): string {
  return anthropicSse([
    messageStart(o),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: o.outputTokens },
    },
    { type: "message_stop" },
  ]);
}

/** A complete UI message stream for one text answer (ids "1", no metadata unless
 * `finish` overrides the terminal frame) — the panel test harness wire. */
export function uiTextTurn(deltas: string[], opts: { finish?: Record<string, unknown> } = {}) {
  return (
    sseData([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "1" },
      ...deltas.map((delta) => ({ type: "text-delta", id: "1", delta })),
      { type: "text-end", id: "1" },
      { type: "finish-step" },
      opts.finish ?? { type: "finish" },
    ]) + "data: [DONE]\n\n"
  );
}
