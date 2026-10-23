// M2-3 acceptance at the panel level: ChatPanel → POST /api/chat with the Bearer token +
// api-engine body, markdown streamed into the DOM (jsdom; IS_REACT_ACT_ENVIRONMENT per the
// M0-4 learning — RTL 16 + React 19 under vitest jsdom).
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "@/components/chat-panel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Dialog (under cmdk) observes content size — jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
// cmdk scrolls the selected item into view — jsdom lacks both the API and layout.
Element.prototype.scrollIntoView = () => {};

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

    render(<ChatPanel />);
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

  it("⌘K flow: the badge opens the palette, picking a model retargets the next send + persists", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
    });
    vi.stubGlobal("fetch", stubFetch());

    render(<ChatPanel />);
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
});
