// M5-10 unit tests — dropDanglingToolCalls: the bridge-side heal for history that a
// panel close mid-tool persisted with an unresolved assistant tool-call part.
// Rows: dangling call dropped, paired call kept (identity intact), multiple danglers,
// result-without-a-clean-state kept, empty assistant turns dropped, garbage parts
// arrays left for the SDK validator.
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { dropDanglingToolCalls } from "./messages-sanitize.js";

function userMsg(text: string): UIMessage {
  return { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** A tool part in an arbitrary state with arbitrary result fields. */
function toolPart(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool-navigate",
    toolCallId: "call_1",
    state: "input-available",
    input: { url: "https://example.com/" },
    ...overrides,
  };
}

function assistant(...parts: unknown[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as unknown as UIMessage;
}

describe("dropDanglingToolCalls (M5-10)", () => {
  it("drops an unresolved tool-call part (the panel-closed-mid-tool shape)", () => {
    const dangling = toolPart({});
    const out = dropDanglingToolCalls([
      userMsg("open example.com"),
      assistant({ type: "step-start" }, dangling),
    ]);
    // The dangling part is gone; the assistant turn survives with its other parts.
    expect(out).toHaveLength(2);
    expect(out[1]!.parts).toEqual([{ type: "step-start" }]);
  });

  it("keeps a paired call byte-identical (resolved output) and preserves message identity", () => {
    const paired = assistant(
      { type: "step-start" },
      toolPart({ state: "output-available", output: { title: "Example" } }),
    );
    const out = dropDanglingToolCalls([userMsg("open"), paired]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(paired); // untouched messages keep object identity
  });

  it("keeps an output-error part (an error result still pairs the call)", () => {
    const failed = assistant(toolPart({ state: "output-error", errorText: "USER_DENIED: nope" }));
    const out = dropDanglingToolCalls([failed]);
    expect(out).toHaveLength(1);
    expect(out[0]!.parts).toHaveLength(1);
  });

  it("drops multiple danglers in one message and across messages", () => {
    const out = dropDanglingToolCalls([
      assistant(
        toolPart({ toolCallId: "call_1" }),
        toolPart({ toolCallId: "call_2", type: "dynamic-tool", toolName: "click" }),
        toolPart({ toolCallId: "call_3", state: "output-available", output: "ok" }),
      ),
      assistant(toolPart({ toolCallId: "call_4", state: "input-streaming", input: {} })),
    ]);
    expect(out[0]!.parts).toEqual([
      toolPart({ toolCallId: "call_3", state: "output-available", output: "ok" }),
    ]);
    // The second assistant message held only danglers → dropped entirely.
    expect(out).toHaveLength(1);
  });

  it("counts result evidence over a stale state stamp (result without a clean call state)", () => {
    const odd = assistant(toolPart({ state: "input-available", output: "late result" }));
    const out = dropDanglingToolCalls([odd]);
    expect(out[0]!.parts).toHaveLength(1);
  });

  it("drops an assistant message left with zero parts", () => {
    const out = dropDanglingToolCalls([userMsg("hi"), assistant(toolPart({}))]);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("leaves non-array parts untouched for convertToModelMessages to 400", () => {
    const garbage = { id: "g1", role: "assistant", parts: "not-an-array" } as unknown as UIMessage;
    const out = dropDanglingToolCalls([garbage]);
    expect(out[0]).toBe(garbage);
  });
});
