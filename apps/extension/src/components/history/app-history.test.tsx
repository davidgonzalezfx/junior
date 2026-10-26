// App ↔ SessionStore wiring (review R§4.8 + R§6.5): the panel shell routes
// rename/delete through the store, detaches a deleted active session, and does
// not re-record (or reorder) a session merely by viewing it. ChatPanel is a stub
// that records like the real one (on mount + on demand); HistoryPanel is real.
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { useEffect } from "react";
import type { UIMessage } from "ai";
import { assistantMessage, userMessage } from "@junior/testkit/chat";
import App from "@/entrypoints/sidepanel/App";
import { loadSessions, saveSessions, type StoredSession } from "@/lib/history";
import { MAX_WRITE_LATENCY_MS, WRITE_DEBOUNCE_MS } from "@/lib/session-store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The live ChatPanel props — tests "stream" by calling onRecord on them.
let chat: { session: StoredSession; onRecord: (m: UIMessage[]) => void } | null = null;

vi.mock("@/components/chat-panel", () => ({
  ChatPanel: (props: { session: StoredSession; onRecord: (m: UIMessage[]) => void }) => {
    chat = props;
    const { session, onRecord } = props;
    // The real panel's effect fires onRecord with the seeded messages on mount.
    useEffect(() => onRecord(session.messages), [session, onRecord]);
    return <div data-testid="chat">{session.id}</div>;
  },
}));
vi.mock("@/components/bridge-status-bar", () => ({ BridgeStatusBar: () => null }));
vi.mock("@/components/work-overlay-status", () => ({ WorkOverlayStatus: () => null }));
vi.mock("@/components/approvals/approval-card", () => ({ ApprovalCardStack: () => null }));
vi.mock("@/hooks/use-approval-cards", () => ({
  useApprovalCards: () => ({ cards: [], respond: () => {}, status: null, init: null }),
}));

const T0 = 1_000_000;
const flushAsync = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function stored(overrides: Partial<StoredSession>): StoredSession {
  return {
    id: "s1",
    title: "hello",
    renamed: false,
    createdAt: T0,
    updatedAt: T0,
    messages: [userMessage("hello"), assistantMessage("hi")],
    ...overrides,
  };
}

async function openPanel(sessions: StoredSession[], activeId: string): Promise<void> {
  await saveSessions(sessions);
  await fakeBrowser.storage.local.set({
    junior_onboarded: true,
    junior_active_session: activeId,
  });
  render(<App />);
  await flushAsync();
  expect(screen.getByTestId("chat").textContent).toBe(activeId);
}

/** Append one message to the live transcript, as a streamed chunk would. */
let recorded: UIMessage[] = [];
function streamChunk(text: string): void {
  recorded = [...recorded, assistantMessage(text)];
  act(() => chat!.onRecord(recorded));
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0 + 60_000);
  chat = null;
  recorded = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("App history wiring", () => {
  it("A: renaming the active session survives the pending debounced snapshot", async () => {
    await openPanel([stored({})], "s1");
    recorded = [...chat!.session.messages];
    streamChunk("chunk"); // pending snapshot with the derived title

    fireEvent.click(screen.getByRole("button", { name: "Open History" }));
    await flushAsync();
    fireEvent.click(screen.getByLabelText("Rename hello"));
    const input = screen.getByLabelText("Rename conversation (hello)");
    fireEvent.change(input, { target: { value: "My title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await advance(MAX_WRITE_LATENCY_MS);

    expect((await loadSessions())[0]).toMatchObject({ title: "My title", renamed: true });
  });

  it("B: deleting the active session sticks and detaches it from recording", async () => {
    await openPanel([stored({}), stored({ id: "s2", title: "other", updatedAt: T0 - 1 })], "s1");
    recorded = [...chat!.session.messages];
    streamChunk("chunk"); // pending snapshot for s1

    fireEvent.click(screen.getByRole("button", { name: "Open History" }));
    await flushAsync();
    fireEvent.click(screen.getByLabelText("Delete hello"));
    await advance(MAX_WRITE_LATENCY_MS);
    expect((await loadSessions()).map((s) => s.id)).toEqual(["s2"]);

    // Back to chat: the panel is on a fresh session, not the deleted one.
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await flushAsync();
    expect(screen.getByTestId("chat").textContent).not.toBe("s1");
    recorded = [userMessage("new conversation")];
    act(() => chat!.onRecord(recorded));
    await advance(MAX_WRITE_LATENCY_MS);
    expect((await loadSessions()).some((s) => s.id === "s1")).toBe(false);
  });

  it("R6.5: opening the panel on a restored session does not re-record or reorder it", async () => {
    await openPanel([stored({}), stored({ id: "s2", title: "newer", updatedAt: T0 + 5 })], "s1");
    await advance(MAX_WRITE_LATENCY_MS);
    const list = await loadSessions();
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(list[1]!.updatedAt).toBe(T0);
  });

  it("History → Back re-seeds the chat with the live transcript, not the stale one", async () => {
    await openPanel([stored({})], "s1");
    recorded = [...chat!.session.messages];
    streamChunk("newest reply");

    fireEvent.click(screen.getByRole("button", { name: "Open History" }));
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    await flushAsync();

    expect(chat!.session.messages).toHaveLength(3);
    await advance(MAX_WRITE_LATENCY_MS);
    expect((await loadSessions())[0]!.messages).toHaveLength(3);
  });

  it("debounce still lands a recorded exchange after 500 ms", async () => {
    await openPanel([stored({})], "s1");
    act(() => chat!.onRecord([...chat!.session.messages, userMessage("again")]));
    await advance(WRITE_DEBOUNCE_MS);
    expect((await loadSessions())[0]!.messages).toHaveLength(3);
  });
});
