// M4-3 — browserTools unit tests: each §4.5 tool maps to exactly one dispatcher
// action, ok results surface as size-capped JSON, and denied/error guard strings
// ride through verbatim (§4.4). The dispatcher is a stub here — the full loop
// through the real app lives in routes.test.ts; end-to-end in tests/e2e.
import { describe, expect, it, vi } from "vitest";
import { browserTools } from "./tools.js";
import { MAX_TOOL_TEXT_CHARS } from "../mcp/tools.js";
import type { Dispatcher } from "../dispatcher/queue.js";

function stubDispatcher(result: Awaited<ReturnType<Dispatcher["dispatch"]>>): Dispatcher {
  return { dispatch: vi.fn(async () => result) } as unknown as Dispatcher;
}

const OK = (result: unknown) => ({
  id: "a1",
  status: "ok" as const,
  result,
});

describe("browserTools (M4-3)", () => {
  it("registers the seven §4.5 browser tools", () => {
    const tools = browserTools({ dispatcher: stubDispatcher(OK({})) });
    expect(Object.keys(tools).sort()).toEqual(
      [
        "click",
        "get_active_tab",
        "media",
        "navigate",
        "read_page",
        "screenshot",
        "type",
        "scroll",
      ].sort(),
    );
  });

  it("each tool dispatches its matching action (args carried through)", async () => {
    const d = stubDispatcher(OK({ title: "Example", url: "https://example.com/" }));
    const tools = browserTools({ dispatcher: d });
    const dispatch = d.dispatch as ReturnType<typeof vi.fn>;

    await tools.get_active_tab!.execute!({}, { messages: [], toolCallId: "t" } as never);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "get_active_tab" });

    await tools.navigate!.execute!({ url: "https://example.com/" }, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "navigate", url: "https://example.com/" });

    await tools.click!.execute!({ target: "12" }, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "click", target: "12" });

    await tools.type!.execute!({ target: "q", text: "hello" }, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "type", target: "q", text: "hello" });

    await tools.scroll!.execute!({ direction: "down" }, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "scroll",
      direction: "down",
      amount: undefined,
    });

    await tools.media!.execute!({ op: "pause", target: "f7:m0" }, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "media",
      op: "pause",
      target: "f7:m0",
      time: undefined,
    });

    await tools.read_page!.execute!(
      { mode: "interactive", selector: "#form", maxChars: 4000 },
      {} as never,
    );
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "read_page",
      mode: "interactive",
      selector: "#form",
      maxChars: 4000,
    });

    await tools.screenshot!.execute!({}, {} as never);
    expect(dispatch).toHaveBeenLastCalledWith({ kind: "screenshot" });
  });

  it("an ok result surfaces as the result JSON", async () => {
    const tools = browserTools({ dispatcher: stubDispatcher(OK({ title: "Page" })) });
    const out = await tools.get_active_tab!.execute!({}, {} as never);
    expect(out).toBe(JSON.stringify({ title: "Page" }));
  });

  it("a denied action's guard string rides through verbatim", async () => {
    const denied = {
      id: "a1",
      status: "denied" as const,
      error: "USER_DENIED: the user denied this action in the approval card",
    };
    const tools = browserTools({ dispatcher: stubDispatcher(denied) });
    const out = await tools.click!.execute!({ target: "3" }, {} as never);
    expect(out).toBe("USER_DENIED: the user denied this action in the approval card");
  });

  it("read_page's schema applies the protocol defaults (the SDK validates before execute)", () => {
    const tools = browserTools({ dispatcher: stubDispatcher(OK({})) });
    // The Tool type widens inputSchema to FlexibleSchema; it is our zod object.
    const schema = tools.read_page!.inputSchema as unknown as { parse(i: unknown): unknown };
    expect(schema.parse({})).toEqual({
      mode: "outline",
      selector: undefined,
      maxChars: 8000,
    });
  });

  it("oversized ok results are capped with a truncation note (§6.3-6)", async () => {
    const big = "x".repeat(MAX_TOOL_TEXT_CHARS + 5000);
    const tools = browserTools({ dispatcher: stubDispatcher(OK({ text: big })) });
    const out = await tools.read_page!.execute!({ mode: "text" }, {} as never);
    expect(out!.length).toBeLessThan(MAX_TOOL_TEXT_CHARS + 100);
    // The count covers the JSON wrapper too, so match loosely.
    expect(out).toMatch(/\[truncated 50\d\d chars\]/);
  });
});
