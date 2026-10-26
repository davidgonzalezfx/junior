// ChatPanel agent mode: M4-3 the Agent toggle on the wire + tool-call cards (M5-1);
// M5-7 agent-mode sends run the host-permission gate, plain chat never touches it;
// M5-10 mid-tool stream death finalizes the tool part (live + restored sessions).
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import { userMessage } from "@junior/testkit/chat";
import { sseData } from "@junior/testkit/wire";
import { ChatPanel } from "@/components/chat-panel";
import { emptySession } from "@/lib/history";
import {
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

describe("ChatPanel agent mode", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetChatRequests();
    vi.restoreAllMocks();
  });

  it("M4-3: the Agent toggle sends agentMode:true on the next send (and off removes it)", async () => {
    await seedPairedDefaults();
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
    await seedPairedDefaults();
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
    await seedPairedDefaults();
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
    await seedPairedDefaults();
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
    await seedPairedDefaults();
    const agentStream =
      sseData([
        { type: "start" },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "call_1",
          toolName: "navigate",
          input: { url: "https://example.com/" },
        },
        { type: "tool-output-available", toolCallId: "call_1", output: '{"title":"Example"}' },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "Opened it." },
        { type: "text-end", id: "1" },
        { type: "finish-step" },
        { type: "finish" },
      ]) + "data: [DONE]\n\n";
    const stub = panelFetch((url, init) => {
      chatRequests.push({ url, auth: null, body: JSON.parse(String(init?.body)) });
      return new Response(agentStream, { headers: { "content-type": "text/event-stream" } });
    });
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

  it("M5-10: a stream that dies mid-tool marks the tool part errored, not running", async () => {
    await seedPairedDefaults();
    // Tool call arrives, the stream then errors before any tool output — the
    // pre-fix behavior left the card at "running…" in the live view and in history.
    const dyingStream =
      sseData([
        { type: "start" },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "call_1",
          toolName: "navigate",
          input: { url: "https://example.com/" },
        },
        { type: "error", errorText: "boom mid-tool" },
      ]) + "data: [DONE]\n\n";
    const stub = panelFetch(() => {
      return new Response(dyingStream, { headers: { "content-type": "text/event-stream" } });
    });
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
    await seedPairedDefaults();
    vi.stubGlobal("fetch", stubFetch());
    const onRecord = vi.fn();
    const session = emptySession();
    session.messages = [
      userMessage("open example.com", "u1"),
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
