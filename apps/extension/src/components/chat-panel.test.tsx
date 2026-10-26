// M2-3 acceptance at the panel level: ChatPanel → POST /api/chat with the Bearer token +
// api-engine body, markdown streamed into the DOM. M2-5: the active session is a
// prop — restored messages seed the transcript, finished exchanges flow to onRecord.
// ⌘K picker + M5-2 recents. M5-1: usage chips, reasoning collapse, empty/error
// states. Agent-mode flows: chat-panel.agent.test.tsx; harness: chat-panel.test-support.ts.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import { assistantMessage, userMessage } from "@junior/testkit/chat";
import { sseData } from "@junior/testkit/wire";
import { ChatPanel } from "@/components/chat-panel";
import { emptySession } from "@/lib/history";
import {
  UI_STREAM,
  chatRequests,
  installPanelJsdom,
  panelFetch,
  resetChatRequests,
  seedPairedDefaults,
  stubFetch,
  stubPermissions,
} from "./chat-panel.test-support";

installPanelJsdom();

// Nothing in WxtVitest resets fakeBrowser automatically — do it per test.
beforeEach(() => fakeBrowser.reset());

// Default the whole file to already-granted host access (M5-7 tests override it).
stubPermissions(true, true);

describe("ChatPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetChatRequests();
    vi.restoreAllMocks();
  });

  it("streams markdown into the panel and targets /api/chat with the token + engine body", async () => {
    await seedPairedDefaults();
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
    await seedPairedDefaults();
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
    await seedPairedDefaults();
    vi.stubGlobal("fetch", stubFetch());

    const session = emptySession();
    session.messages = [
      userMessage("remember BANANA42", "u1"),
      assistantMessage("BANANA42 noted.", "a1"),
    ];
    render(<ChatPanel session={session} onRecord={vi.fn()} />);

    expect(await screen.findByText("BANANA42 noted.")).toBeTruthy();
    expect(screen.getByText("remember BANANA42")).toBeTruthy();
  });

  it("⌘K flow: the badge opens the palette, picking a model retargets the next send + persists", async () => {
    await seedPairedDefaults();
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

  it("M5-1: finish metadata renders as a usage chip on the assistant message", async () => {
    await seedPairedDefaults();
    // The api engine merges metadata onto the finish chunk (observed on the bridge wire).
    const metaStream =
      sseData([
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "Done." },
        { type: "text-end", id: "1" },
        { type: "finish-step" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
            model: "vendor/model-x",
            provider: "openrouter",
          },
        },
      ]) + "data: [DONE]\n\n";
    const stub = panelFetch((url, init) => {
      chatRequests.push({ url, auth: null, body: JSON.parse(String(init?.body)) });
      return new Response(metaStream, { headers: { "content-type": "text/event-stream" } });
    });
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
    await seedPairedDefaults();
    const reasoningStream =
      sseData([
        { type: "start" },
        { type: "start-step" },
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "pondering deeply" },
        { type: "reasoning-end", id: "r1" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "The answer." },
        { type: "text-end", id: "1" },
        { type: "finish-step" },
        { type: "finish" },
      ]) + "data: [DONE]\n\n";
    const stub = panelFetch(() => {
      return new Response(reasoningStream, {
        headers: { "content-type": "text/event-stream" },
      });
    });
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
    await seedPairedDefaults();
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
    await seedPairedDefaults();
    let calls = 0;
    const stub = panelFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "all providers failed" }), { status: 502 });
      }
      return new Response(UI_STREAM, { headers: { "content-type": "text/event-stream" } });
    });
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
});
