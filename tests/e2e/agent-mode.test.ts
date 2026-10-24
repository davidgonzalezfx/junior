// M4-3 acceptance (b) — panel agent mode end-to-end through the REAL stack: a
// scripted Anthropic-wire provider (harness chatFetch seam, no LLM) drives
// streamText's tool loop; each tool call dispatches through the REAL bridge
// dispatcher → guard → long-poll → extension AgentLoop → executors on the FakeTab.
// The user-visible flow mirrors "search hn for junior and open first link"
// (plan §8 M4 accept b) on fixture pages: navigate to results, read_page,
// click the first result (side effect recorded in the page), navigate to open it.
import { describe, expect, it } from "vitest";
import { startHarness, type FakePage, type Harness } from "./harness";

const START_URL = "https://start.junior.test/index.html";
const SEARCH_URL = "https://hn.junior.test/search?q=junior";

const startPage: FakePage = { title: "Start", html: "<h1>You are here</h1>" };

const searchPage: FakePage = {
  title: "Search: junior",
  html: `
    <h1>Search results</h1>
    <p id="status">idle</p>
    <ol>
      <li><a href="https://hn.junior.test/item?id=1" id="r1">Junior — a browser assistant</a></li>
      <li><a href="https://other.example.dev/">Unrelated result</a></li>
    </ol>`,
  onShow: (doc) => {
    // jsdom anchors don't navigate a FakeTab, so "opening" the result is the
    // click's page-visible effect — the harness equivalent of the page loading.
    doc.getElementById("r1")?.addEventListener("click", () => {
      doc.getElementById("status")!.textContent = "visited";
    });
  },
};

/** SSE bytes for one Anthropic Messages-API turn. */
function anthropicSse(events: Array<Record<string, unknown>>): string {
  return (
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function toolUseTurn(id: string, name: string, input: unknown): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        content: [],
        model: "harness-mock",
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ]);
}

function textTurn(text: string): string {
  return anthropicSse([
    {
      type: "message_start",
      message: {
        id: "msg_final",
        role: "assistant",
        content: [],
        model: "harness-mock",
        usage: { input_tokens: 200, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ]);
}

/** Scripted model: navigate → read_page → click the first result (its page-visible
 * effect is the harness's "opened it") → summarize. Turn detection counts
 * tool_result blocks sent back. */
function scriptedProvider(): typeof fetch {
  return async (input, init) => {
    void input;
    const raw = String(init?.body ?? "");
    const calls = raw.split('"tool_result"').length - 1;
    const body =
      calls === 0
        ? toolUseTurn("toolu_1", "navigate", { url: SEARCH_URL })
        : calls === 1
          ? toolUseTurn("toolu_2", "read_page", { mode: "outline" })
          : calls === 2
            ? toolUseTurn("toolu_3", "click", { target: "Junior — a browser assistant" })
            : textTurn("OPENED: Junior — the assistant's page is now active.");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function postAgentChat(h: Harness, text: string): Promise<string> {
  const res = await fetch(`${h.bridgeUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${h.token}`,
    },
    body: JSON.stringify({
      engine: "api",
      provider: "anthropic",
      model: "harness-mock",
      agentMode: true,
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
  return await res.text();
}

describe("agent mode e2e (M4-3, plan §8 M4 accept b)", () => {
  it("drives navigate → read_page → click → navigate through the real dispatcher and reports back", async () => {
    const h = await startHarness({
      tabUrl: START_URL,
      pages: { [START_URL]: startPage, [SEARCH_URL]: searchPage },
      chatFetch: scriptedProvider(),
    });
    try {
      await h.waitConnected();
      const stream = await postAgentChat(h, "search hn for junior and open the first link");

      // Every tool call ran and the final text streamed back.
      for (const name of ["navigate", "read_page", "click"]) {
        expect(stream).toContain(`"toolName":"${name}"`);
      }
      expect(stream).toContain("OPENED: Junior");
      expect(stream).toContain('"type":"finish"');

      // Real executor effects, not mocks: the click fired the page's handler —
      // the harness's "the result page opened" — and the tab moved as scripted.
      expect(h.tab.url).toBe(SEARCH_URL);
      expect(h.tab.document.getElementById("status")?.textContent).toBe("visited");

      // Auto mode, nothing sensitive: the whole task ran with zero approval cards.
      expect(h.cards).toHaveLength(0);
      expect(h.wireCards).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it("a guard denial rides back to the model verbatim and the loop still finishes", async () => {
    const h = await startHarness({
      tabUrl: START_URL,
      pages: { [START_URL]: startPage, [SEARCH_URL]: searchPage },
      chatFetch: scriptedProvider(),
    });
    try {
      await h.waitConnected();
      h.mode = "ask"; // every navigation now needs a card; the scripted panel denies
      const stream = await postAgentChat(h, "search hn for junior and open the first link");

      // The navigate denial reaches the model as the tool output (§4.4: the
      // structured string rides through so the agent knows not to retry).
      expect(stream).toContain('"toolName":"navigate"');
      expect(stream).toContain("USER_DENIED: the user denied this action in the approval card");
      // The task still terminates with a model turn, not a hang.
      expect(stream).toContain('"type":"finish"');
      // Nothing executed: the tab never left the start page.
      expect(h.tab.url).toBe(START_URL);
    } finally {
      await h.stop();
    }
  });
});
