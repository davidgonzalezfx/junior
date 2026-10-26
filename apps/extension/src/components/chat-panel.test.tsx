// M2-3 acceptance at the panel level: ChatPanel → POST /api/chat with the Bearer token +
// api-engine body, markdown streamed into the DOM (jsdom; IS_REACT_ACT_ENVIRONMENT per the
// M0-4 learning — RTL 16 + React 19 under vitest jsdom). M2-5: the active session is a
// prop — restored messages seed the transcript, finished exchanges flow to onRecord.
// M5-1: tool-call cards, reasoning collapse, usage chips, empty/error states. M5-7:
// agent-mode sends run the host-permission gate; plain chat never touches it.
// M5-10: mid-tool stream death finalizes the tool part (live + restored sessions).
// (~690 lines — over the ~400 budget: one shared SSE/fetch harness serves every panel
// flow; splitting the render tests out would duplicate it rather than simplify.)
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import { ChatPanel } from "@/components/chat-panel";
import { emptySession } from "@/lib/history";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Nothing in WxtVitest resets fakeBrowser automatically — do it per test.
beforeEach(() => fakeBrowser.reset());

// Radix Dialog (under cmdk) observes content size — jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
// cmdk scrolls the selected item into view — jsdom lacks both the API and layout.
Element.prototype.scrollIntoView = () => {};

// M5-7: the agent-mode send runs the host-permission gate over browser.permissions
// (fakeBrowser has no implementation). Default the whole file to already-granted so
// the agent flows above exercise the cheap contains path; the M5-7 tests override it.
function stubPermissions(granted: boolean, requestResult: boolean) {
  const calls = { contains: 0, request: 0 };
  (browser as { permissions?: unknown }).permissions = {
    contains: async () => {
      calls.contains += 1;
      return granted;
    },
    request: async () => {
      calls.request += 1;
      return requestResult;
    },
  };
  return calls;
}
stubPermissions(true, true);

const UI_STREAM = [
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
  .join("");

const STATUS = {
  version: "0.0.0",
  apiLevel: 1,
  providers: [
    { id: "claude-cli", kind: "claude-cli", label: "CLI", available: true, models: [] },
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      available: true,
      models: [{ id: "claude-sonnet-5-5", badges: ["reasoning"] }],
    },
    {
      id: "openrouter",
      kind: "openai-compatible",
      label: "OpenRouter",
      available: true,
      models: [
        { id: "vendor/model-x", badges: [] },
        { id: "vendor/model-y", badges: ["fast"] },
      ],
    },
  ],
  browserConnected: true,
  queueDepth: 0,
};

interface ChatRequest {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

let chatRequests: ChatRequest[] = [];

/** init.headers arrives as a Headers instance — normalize for assertions. */
function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const rec = h as Record<string, string> | undefined;
  return rec?.[name] ?? null;
}

function stubFetch() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify(STATUS), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/chat")) {
      chatRequests.push({
        url,
        auth: headerOf(init, "authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(UI_STREAM, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
}

describe("ChatPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    chatRequests = [];
    vi.restoreAllMocks();
  });

  it("streams markdown into the panel and targets /api/chat with the token + engine body", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "hi there" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      // strong = the **world** markdown — plain DOM assert, no jest-dom matchers here.
      expect(screen.getByRole("strong").textContent).toBe("world");
    });
    // claude-cli is available but excluded — the stored openrouter default wins.
    expect(chatRequests).toHaveLength(1);
    const req = chatRequests[0]!; // length asserted above (noUncheckedIndexedAccess)
    expect(req.url).toBe("http://127.0.0.1:8620/api/chat");
    expect(req.auth).toBe(`Bearer ${"t".repeat(64)}`);
    expect(req.body).toMatchObject({
      engine: "api",
      provider: "openrouter",
      model: "vendor/model-x",
    });
    expect(Array.isArray(req.body.messages)).toBe(true);
  });

  it("M2-5: an exchanged conversation reaches onRecord with a derived title-ready list", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());
    const onRecord = vi.fn();

    render(<ChatPanel session={emptySession()} onRecord={onRecord} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "remember BANANA42" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const last = onRecord.mock.calls.at(-1)?.[0] as UIMessage[] | undefined;
      expect(last).toHaveLength(2); // user + assistant
      expect(last?.[0]?.parts[0]).toMatchObject({ type: "text", text: "remember BANANA42" });
      // The assistant message leads with a step-start part; assert the text part.
      expect(last?.[1]?.parts.some((p) => p.type === "text" && p.text === "Hello **world**")).toBe(
        true,
      );
    });
  });

  it("M2-5: a stored session's messages render on mount (history restore)", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    const session = emptySession();
    session.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "remember BANANA42" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "BANANA42 noted." }] },
    ];
    render(<ChatPanel session={session} onRecord={vi.fn()} />);

    expect(await screen.findByText("BANANA42 noted.")).toBeTruthy();
    expect(screen.getByText("remember BANANA42")).toBeTruthy();
  });

  it("⌘K flow: the badge opens the palette, picking a model retargets the next send + persists", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    await screen.findByLabelText("message");

    // The badge IS the palette trigger (plan §5.3).
    fireEvent.click(screen.getByLabelText("Change model (⌘K)"));
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeTruthy();
    // Groups = providers from /api/status; claude-cli has no catalog → absent.
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);

    // Pick a different model; the dialog closes and the badge reflects it.
    fireEvent.click(screen.getByRole("option", { name: /vendor\/model-y/ }));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    const textarea = screen.getByLabelText("message");
    fireEvent.change(textarea, { target: { value: "to the new model" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(chatRequests).toHaveLength(1);
    });
    expect(chatRequests[0]!.body).toMatchObject({
      engine: "api",
      provider: "openrouter",
      model: "vendor/model-y",
    });

    // Selection persists: default provider + a recent entry.
    await waitFor(async () => {
      const stored = await browser.storage.local.get([
        "junior_default_provider",
        "junior_recent_models",
      ]);
      expect(stored.junior_default_provider).toEqual({
        providerId: "openrouter",
        model: "vendor/model-y",
      });
      expect(stored.junior_recent_models).toEqual([
        { providerId: "openrouter", model: "vendor/model-y" },
      ]);
    });
  });

  it("M5-2: persisted recents load into the palette and stale entries are pruned", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
      junior_recent_models: [
        { providerId: "openrouter", model: "vendor/model-y" }, // still in the catalog
        { providerId: "removed-provider", model: "m" }, // provider gone → pruned
        { providerId: "openrouter", model: "vendor/model-gone" }, // model gone → pruned
      ],
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    await screen.findByLabelText("message");
    fireEvent.click(screen.getByLabelText("Change model (⌘K)"));
    await screen.findByRole("listbox");

    // The Recent group carries the surviving entry; it also stays in its provider
    // group — so model-y appears exactly twice, and the stale entries nowhere.
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getAllByRole("option", { name: /vendor\/model-y/ })).toHaveLength(2);
    expect(screen.queryByRole("option", { name: /vendor\/model-gone/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /^m$/ })).toBeNull();

    // The pruned list is persisted back.
    await waitFor(async () => {
      const stored = await browser.storage.local.get("junior_recent_models");
      expect(stored.junior_recent_models).toEqual([
        { providerId: "openrouter", model: "vendor/model-y" },
      ]);
    });
  });

  it("M4-3: the Agent toggle sends agentMode:true on the next send (and off removes it)", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "plain question" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0]!.body.agentMode).toBeUndefined(); // plain chat: protocol default

    // Toggle agent mode; the memo key changes → the next send carries agentMode.
    fireEvent.click(screen.getByLabelText("Agent mode"));
    expect(screen.getByLabelText("Agent mode").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(textarea, { target: { value: "do a task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(2));
    expect(chatRequests[1]!.body.agentMode).toBe(true);

    // Toggling back removes the flag again.
    fireEvent.click(screen.getByLabelText("Agent mode"));
    fireEvent.change(textarea, { target: { value: "plain again" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(3));
    expect(chatRequests[2]!.body.agentMode).toBeUndefined();
  });

  it("M5-7: plain chat never touches the host-permission gate", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());
    const calls = stubPermissions(false, true); // would request if consulted at all

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "plain question" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(1));

    expect(calls.contains).toBe(0);
    expect(calls.request).toBe(0);
  });

  it("M5-7: the first agent-mode send requests <all_urls>; once granted, later sends skip it", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());
    const calls = stubPermissions(false, true);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Agent mode"));
    const textarea = screen.getByLabelText("message");
    fireEvent.change(textarea, { target: { value: "do a task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(1));

    // The dialog ran once; the send went out and no denial notice shows.
    expect(calls.contains).toBe(1);
    expect(calls.request).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();

    // Second send: access is already granted — contains only, no second dialog.
    const granted = stubPermissions(true, true);
    fireEvent.change(textarea, { target: { value: "another task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(chatRequests).toHaveLength(2));
    expect(granted.request).toBe(0);
  });

  it("M5-7: a denied gate still sends the task and shows the page-actions-will-fail notice", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());
    stubPermissions(false, false);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Agent mode"));
    const textarea = screen.getByLabelText("message");
    fireEvent.change(textarea, { target: { value: "do a task anyway" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(chatRequests).toHaveLength(1)); // the task still runs
    const notice = await screen.findByRole("alert");
    expect(notice.getAttribute("data-host-permission-denied")).not.toBeNull();

    // Toggling agent mode off dismisses the notice (it only describes agent sends).
    fireEvent.click(screen.getByLabelText("Agent mode"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("M4-3: streamed tool parts render as collapsible tool-call cards (M5-1)", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    const agentStream = [
      `data: {"type":"start"}`,
      `data: {"type":"start-step"}`,
      `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"navigate","input":{"url":"https://example.com/"}}`,
      `data: {"type":"tool-output-available","toolCallId":"call_1","output":"{\\"title\\":\\"Example\\"}"}`,
      `data: {"type":"finish-step"}`,
      `data: {"type":"start-step"}`,
      `data: {"type":"text-start","id":"1"}`,
      `data: {"type":"text-delta","id":"1","delta":"Opened it."}`,
      `data: {"type":"text-end","id":"1"}`,
      `data: {"type":"finish-step"}`,
      `data: {"type":"finish"}`,
      `data: [DONE]`,
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify(STATUS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        chatRequests.push({ url, auth: null, body: JSON.parse(String(init?.body)) });
        return new Response(agentStream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    vi.stubGlobal("fetch", stub);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Agent mode"));
    const textarea = screen.getByLabelText("message");
    fireEvent.change(textarea, { target: { value: "open example.com" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Static server tools render as tool-<name> parts — a collapsible card: header
    // shows the name + state, the body holds args + result behind the summary.
    await waitFor(() => expect(screen.getByText("Opened it.")).toBeTruthy());
    const card = screen.getByText("navigate").closest("details");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("data-state")).toBe("output-available");
    expect(card!.querySelector("summary")!.textContent).toContain("done");
    // Collapsed by default; the body (args + result) renders once open. jsdom has no
    // summary-click toggle behavior — set `open` directly, which is what the click does.
    expect(card!.open).toBe(false);
    card!.open = true;
    expect(card!.textContent).toContain("args");
    expect(card!.textContent).toContain("Example");
  });

  it("M5-1: finish metadata renders as a usage chip on the assistant message", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    // The api engine merges metadata onto the finish chunk (observed on the bridge wire).
    const metaStream = [
      `data: {"type":"start"}`,
      `data: {"type":"start-step"}`,
      `data: {"type":"text-start","id":"1"}`,
      `data: {"type":"text-delta","id":"1","delta":"Done."}`,
      `data: {"type":"text-end","id":"1"}`,
      `data: {"type":"finish-step"}`,
      `data: {"type":"finish","finishReason":"stop","messageMetadata":{"usage":{"inputTokens":12,"outputTokens":34,"totalTokens":46},"model":"vendor/model-x","provider":"openrouter"}}`,
      `data: [DONE]`,
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify(STATUS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        chatRequests.push({ url, auth: null, body: JSON.parse(String(init?.body)) });
        return new Response(metaStream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    vi.stubGlobal("fetch", stub);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Done.")).toBeTruthy());
    const chip = document.querySelector("[data-usage-chip]");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("↓12");
    expect(chip!.textContent).toContain("↑34");
    expect(chip!.textContent).toContain("vendor/model-x");
    expect(chip!.textContent).toContain("openrouter");
  });

  it("M5-1: reasoning parts render as a collapsible block, closed once done", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    const reasoningStream = [
      `data: {"type":"start"}`,
      `data: {"type":"start-step"}`,
      `data: {"type":"reasoning-start","id":"r1"}`,
      `data: {"type":"reasoning-delta","id":"r1","delta":"pondering deeply"}`,
      `data: {"type":"reasoning-end","id":"r1"}`,
      `data: {"type":"text-start","id":"1"}`,
      `data: {"type":"text-delta","id":"1","delta":"The answer."}`,
      `data: {"type":"text-end","id":"1"}`,
      `data: {"type":"finish-step"}`,
      `data: {"type":"finish"}`,
      `data: [DONE]`,
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify(STATUS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        return new Response(reasoningStream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    vi.stubGlobal("fetch", stub);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "think hard" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("The answer.")).toBeTruthy());
    const block = document.querySelector<HTMLDetailsElement>('details[data-reasoning="done"]');
    expect(block).toBeTruthy();
    expect(block!.open).toBe(false); // collapsed once the reasoning completes
    block!.open = true;
    expect(block!.textContent).toContain("pondering deeply");
  });

  it("M5-1: the empty state offers example prompts that fill the composer", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    await screen.findByText("Ask anything, or toggle Agent and give Junior a goal in this tab.");
    fireEvent.click(screen.getByRole("button", { name: "Summarize this page" }));
    const textarea = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Summarize this page");
    // Nothing was sent — picking only fills the draft.
    expect(chatRequests).toHaveLength(0);
  });

  it("M5-1: a failed turn shows the error with a Retry that re-requests", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    let calls = 0;
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify(STATUS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "all providers failed" }), { status: 502 });
        }
        return new Response(UI_STREAM, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    vi.stubGlobal("fetch", stub);

    render(<ChatPanel session={emptySession()} onRecord={vi.fn()} />);
    const textarea = await screen.findByLabelText("message");
    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("all providers failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByRole("strong").textContent).toBe("world");
    });
    expect(calls).toBe(2);
  });

  it("M5-10: a stream that dies mid-tool marks the tool part errored, not running", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    // Tool call arrives, the stream then errors before any tool output — the
    // pre-fix behavior left the card at "running…" in the live view and in history.
    const dyingStream = [
      `data: {"type":"start"}`,
      `data: {"type":"start-step"}`,
      `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"navigate","input":{"url":"https://example.com/"}}`,
      `data: {"type":"error","errorText":"boom mid-tool"}`,
      `data: [DONE]`,
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/api/status")) {
        return new Response(JSON.stringify(STATUS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        return new Response(dyingStream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };
    vi.stubGlobal("fetch", stub);
    const onRecord = vi.fn();

    render(<ChatPanel session={emptySession()} onRecord={onRecord} />);
    fireEvent.click(await screen.findByLabelText("Agent mode"));
    const textarea = screen.getByLabelText("message");
    fireEvent.change(textarea, { target: { value: "open example.com" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The card flips to the errored state (was stuck at input-available)…
    await waitFor(() => {
      const card = screen.getByText("navigate").closest("details");
      expect(card?.getAttribute("data-state")).toBe("output-error");
    });
    expect(screen.getByText("navigate").closest("details")!.textContent).toContain("interrupted");
    // …and the finalized part reaches the history record, not the running one.
    await waitFor(() => {
      const last = onRecord.mock.calls.at(-1)?.[0] as UIMessage[] | undefined;
      const part = last?.[1]?.parts.find((p) => "toolCallId" in p) as
        { state: string; errorText: string } | undefined;
      expect(part?.state).toBe("output-error");
      expect(part?.errorText).toContain("interrupted");
    });
  });

  it("M5-10: a restored session persisted broken (running tool) heals on mount", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());
    const onRecord = vi.fn();
    const session = emptySession();
    session.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "open example.com" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-navigate",
            toolCallId: "call_old",
            state: "input-available",
            input: { url: "https://example.com/" },
          },
        ],
      } as unknown as UIMessage,
    ];

    render(<ChatPanel session={session} onRecord={onRecord} />);
    await waitFor(() => {
      const card = screen.getByText("navigate").closest("details");
      expect(card?.getAttribute("data-state")).toBe("output-error");
    });
    // The healed transcript is re-recorded so storage heals too.
    await waitFor(() => {
      const last = onRecord.mock.calls.at(-1)?.[0] as UIMessage[] | undefined;
      const part = last?.[1]?.parts.find((p) => "toolCallId" in p) as { state: string } | undefined;
      expect(part?.state).toBe("output-error");
    });
  });
});
