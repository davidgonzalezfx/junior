// Shared ChatPanel test harness: chat-panel.test.tsx (chat, picker, render states),
// chat-panel.agent.test.tsx (agent mode, tool cards, M5-7 gate, M5-10 healing) and
// chat-panel.perf.test.tsx. The wire shapes come from @junior/testkit; this file
// holds the panel-side seams — jsdom gaps, the bridge fetch stub, permissions.
// Test-only: never imported by an entrypoint, so WXT never bundles it.
import { uiTextTurn } from "@junior/testkit/wire";

/** jsdom gaps every panel render hits. RTL 16 + React 19 under vitest jsdom need
 * IS_REACT_ACT_ENVIRONMENT (M0-4 learning); Radix Dialog (under cmdk) observes
 * content size — jsdom has no ResizeObserver; cmdk scrolls the selected item into
 * view — jsdom lacks both the API and layout. Call once at module scope. */
export function installPanelJsdom(): void {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  Element.prototype.scrollIntoView = () => {};
}

/** M5-7: the agent-mode send runs the host-permission gate over browser.permissions
 * (fakeBrowser has no implementation). Panel test files default to already-granted
 * at module scope so agent flows exercise the cheap contains path; the M5-7 tests
 * override it. */
export function stubPermissions(granted: boolean, requestResult: boolean) {
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

export const UI_STREAM = uiTextTurn(["Hello ", "**world**"]);

export const STATUS = {
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

/** The paired-bridge baseline most panel tests start from: a token + the
 * openrouter/model-x default. */
export async function seedPairedDefaults(): Promise<void> {
  await browser.storage.local.set({
    junior_bridge_token: "t".repeat(64),
    junior_default_provider: { providerId: "openrouter", model: "vendor/model-x" },
  });
}

export interface ChatRequest {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** Every /api/chat request stubFetch saw; reset with resetChatRequests(). */
export const chatRequests: ChatRequest[] = [];
export function resetChatRequests(): void {
  chatRequests.length = 0;
}

/** init.headers arrives as a Headers instance — normalize for assertions. */
function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const rec = h as Record<string, string> | undefined;
  return rec?.[name] ?? null;
}

/** The bridge as the panel sees it: /api/status answers `status`, /api/chat is the
 * caller's, anything else 404s. */
export function panelFetch(
  onChat: (url: string, init?: RequestInit) => Response,
  status: unknown = STATUS,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify(status), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/chat")) return onChat(url, init);
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
}

/** Default stub: records each chat request and answers UI_STREAM. */
export function stubFetch() {
  return panelFetch((url, init) => {
    chatRequests.push({
      url,
      auth: headerOf(init, "authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(UI_STREAM, { headers: { "content-type": "text/event-stream" } });
  });
}
