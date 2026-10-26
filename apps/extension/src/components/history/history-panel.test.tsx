// HistoryPanel acceptance (plan §5.3): list + active highlight, text search,
// open/rename/delete callbacks, markdown export via the download seam, and the
// trim notice with export prompt.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { HistoryPanel } from "@/components/history/history-panel";
import {
  deleteSession,
  loadSessions,
  renameSession,
  saveSessions,
  type StoredSession,
} from "@/lib/history";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Nothing in WxtVitest resets fakeBrowser automatically — do it per test.
beforeEach(() => fakeBrowser.reset());

function makeSession(overrides: Partial<StoredSession>): StoredSession {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    title: "t",
    renamed: false,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    ...overrides,
  };
}

function setupPanel(overrides: Partial<Parameters<typeof HistoryPanel>[0]> = {}) {
  const props = {
    activeId: "s1",
    trimmed: [],
    onDismissTrimmed: vi.fn(),
    listSessions: loadSessions,
    onOpen: vi.fn(),
    onRename: vi.fn(renameSession),
    onDelete: vi.fn(deleteSession),
    onNew: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  render(<HistoryPanel {...props} />);
  return props;
}

describe("HistoryPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists sessions newest-first with the active one highlighted, and opens on click", async () => {
    await saveSessions([
      makeSession({ id: "s1", title: "First chat", updatedAt: 10 }),
      makeSession({ id: "s2", title: "Second chat", updatedAt: 20 }),
    ]);
    const props = setupPanel();

    const first = await screen.findByRole("button", { name: "Second chat" });
    expect(first).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "First chat" }));
    expect(props.onOpen).toHaveBeenCalledWith("s1");
  });

  it("search filters by title and message text", async () => {
    await saveSessions([
      makeSession({
        id: "s1",
        title: "Deploy",
        messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "rollback plan" }] }],
      }),
      makeSession({ id: "s2", title: "Cooking", messages: [] }),
    ]);
    setupPanel();
    await screen.findByRole("button", { name: "Cooking" });

    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "rollback" } });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Cooking" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "zzz" } });
    await waitFor(() => {
      expect(screen.getByText("No conversations match.")).toBeTruthy();
    });
  });

  it("renames the ACTIVE session through onRename (App's store, not direct storage)", async () => {
    await saveSessions([makeSession({ id: "s1", title: "Before", updatedAt: 1 })]);
    const props = setupPanel();
    await screen.findByRole("button", { name: "Before" });

    fireEvent.click(screen.getByLabelText("Rename Before"));
    const input = screen.getByLabelText("Rename conversation (Before)");
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(props.onRename).toHaveBeenCalledWith("s1", "After");
  });

  it("renames an INACTIVE session and re-renders from the returned list", async () => {
    await saveSessions([
      makeSession({ id: "s1", title: "Active", updatedAt: 2 }),
      makeSession({ id: "s2", title: "Other", updatedAt: 1 }),
    ]);
    setupPanel({ activeId: "s1" });
    await screen.findByRole("button", { name: "Other" });

    fireEvent.click(screen.getByLabelText("Rename Other"));
    const input = screen.getByLabelText("Rename conversation (Other)");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Renamed" })).toBeTruthy();
    });
  });

  it("deletes a session through onDelete and drops it from the list", async () => {
    await saveSessions([
      makeSession({ id: "s1", title: "Keep", updatedAt: 2 }),
      makeSession({ id: "s2", title: "Gone", updatedAt: 1 }),
    ]);
    const props = setupPanel();
    await screen.findByRole("button", { name: "Gone" });

    fireEvent.click(screen.getByLabelText("Delete Gone"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Gone" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(props.onDelete).toHaveBeenCalledWith("s2");
  });

  it("exports a session as a markdown download", async () => {
    await saveSessions([makeSession({ id: "s1", title: "Export me", updatedAt: 1 })]);
    // jsdom has no blob URL factory — swap the statics, restore after.
    const createObjectURL = vi.fn(() => "blob:test-1");
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      setupPanel();
      fireEvent.click(await screen.findByLabelText("Export Export me"));
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalled();
      });
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("shows the trim notice with an Export prompt and dismiss", async () => {
    const props = setupPanel({
      trimmed: [makeSession({ id: "old", title: "Old chat" })],
    });
    expect(screen.getByText(/trimmed \(200 cap\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(props.onDismissTrimmed).toHaveBeenCalled();
  });
});
