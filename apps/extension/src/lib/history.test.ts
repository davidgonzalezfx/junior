// History unit tests: pure list math (title/search/upsert/trim/export), storage
// round-trips with corrupt-entry filtering, and the debounced SessionStore
// (fake timers; fakeBrowser auto-resets per test via WxtVitest).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import {
  MAX_SESSIONS,
  INTERRUPTED_TOOL_ERROR,
  SessionStore,
  WRITE_DEBOUNCE_MS,
  deleteSession,
  deriveTitle,
  emptySession,
  exportFilename,
  finalizeInterruptedToolParts,
  loadSessions,
  parseSessions,
  renameSession,
  sanitizeSessionMessages,
  saveSessions,
  saveSessionsDroppingOldest,
  searchSessions,
  sessionToMarkdown,
  trimSessions,
  upsertSession,
  type StoredSession,
} from "@/lib/history";

function userMsg(text: string): UIMessage {
  return { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(text: string): UIMessage {
  return { id: `a-${text}`, role: "assistant", parts: [{ type: "text", text }] };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return { ...emptySession(), ...overrides };
}

// Nothing in WxtVitest resets fakeBrowser automatically — do it per test.
beforeEach(() => fakeBrowser.reset());

describe("deriveTitle", () => {
  it("takes the first user text, whitespace-collapsed", () => {
    expect(deriveTitle([userMsg("  hello   world "), assistantMsg("hi")])).toBe("hello world");
  });

  it("ellipsizes at 60 chars and falls back to New chat", () => {
    const long = "x".repeat(100);
    expect(deriveTitle([userMsg(long)])).toHaveLength(60);
    expect(deriveTitle([userMsg(long)]).endsWith("…")).toBe(true);
    expect(deriveTitle([])).toBe("New chat");
    // assistant-only conversations stay untitled until a user message exists
    expect(deriveTitle([assistantMsg("hi")])).toBe("New chat");
  });
});

describe("searchSessions", () => {
  const list = [
    makeSession({ id: "1", title: "Deploy notes", messages: [userMsg("how do I roll back")] }),
    makeSession({ id: "2", title: "Cooking", messages: [userMsg("pasta recipe")] }),
  ];

  it("matches title OR message text, case-insensitively", () => {
    expect(searchSessions(list, "deploy").map((s) => s.id)).toEqual(["1"]);
    expect(searchSessions(list, "PASTA").map((s) => s.id)).toEqual(["2"]);
    expect(searchSessions(list, "roll back").map((s) => s.id)).toEqual(["1"]);
  });

  it("returns everything for a blank query", () => {
    expect(searchSessions(list, "   ")).toHaveLength(2);
  });
});

describe("upsert + trim", () => {
  it("moves the session to the front on upsert", () => {
    const a = makeSession({ id: "a" });
    const b = makeSession({ id: "b" });
    expect(upsertSession([a, b], a).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("keeps the newest max and reports the rest as dropped", () => {
    // Newest-first input (updatedAt descending) — trim keeps the head.
    const list = Array.from({ length: MAX_SESSIONS + 3 }, (_, i) =>
      makeSession({ id: `s${i}`, updatedAt: 10_000 - i }),
    );
    const { kept, dropped } = trimSessions(list);
    expect(kept).toHaveLength(MAX_SESSIONS);
    expect(dropped.map((s) => s.id)).toEqual(["s200", "s201", "s202"]);
  });
});

describe("markdown export", () => {
  it("renders title, header note, and per-message sections", () => {
    const session = makeSession({
      title: "Q&A",
      messages: [userMsg("what is 2+2"), assistantMsg("**4**")],
    });
    const md = sessionToMarkdown(session, 0);
    expect(md).toContain("# Q&A");
    expect(md).toContain("## You\n\nwhat is 2+2");
    expect(md).toContain("## Junior\n\n**4**");
  });

  it("derives a filename slug from the title", () => {
    expect(exportFilename(makeSession({ title: "Fix the /api/chat bug!" }))).toBe(
      "junior-fix-the-api-chat-bug.md",
    );
    expect(exportFilename(makeSession({ title: "???" }))).toBe("junior-chat.md");
  });
});

describe("storage round-trip", () => {
  it("persists and reloads newest-first", async () => {
    const older = makeSession({ id: "old", updatedAt: 1 });
    const newer = makeSession({ id: "new", updatedAt: 2 });
    await saveSessions([older, newer]);
    expect((await loadSessions()).map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("drops malformed entries instead of failing", async () => {
    await browser.storage.local.set({
      junior_sessions: [
        { id: "ok", title: "t", renamed: false, createdAt: 1, updatedAt: 2, messages: [] },
        { title: "no id" },
        "junk",
      ],
    });
    const parsed = parseSessions(
      (await browser.storage.local.get("junior_sessions")).junior_sessions,
    );
    expect(parsed.map((s) => s.id)).toEqual(["ok"]);
  });

  it("rename marks the session and persists; delete removes", async () => {
    const s = makeSession({ id: "r1", title: "derived" });
    await saveSessions([s]);
    expect((await renameSession("r1", "  Mine  ")).map((x) => x.title)).toEqual(["Mine"]);
    expect((await loadSessions())[0]!.renamed).toBe(true);
    expect((await renameSession("r1", "   "))[0]!.title).toBe("Mine"); // blank keeps title
    expect(await deleteSession("r1")).toEqual([]);
  });
});

describe("SessionStore (debounced writes)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid records into one write after the debounce window", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "a", title: "v1" }));
    store.record(makeSession({ id: "a", title: "v2" }));
    expect(await loadSessions()).toEqual([]); // nothing written yet

    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    const stored = await loadSessions();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe("v2"); // last snapshot wins
  });

  it("flush() writes immediately (write-on-hide path)", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "f1", title: "flushed" }));
    await store.flush();
    expect((await loadSessions()).map((s) => s.id)).toEqual(["f1"]);

    // And a subsequent debounce timer is not left behind.
    store.record(makeSession({ id: "f2" }));
    await store.flush();
    expect(await loadSessions()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS); // no-op, must not throw
  });

  it("merges with sessions already in storage and sorts by updatedAt", async () => {
    await saveSessions([makeSession({ id: "existing", updatedAt: 100 })]);
    const store = new SessionStore();
    store.record(makeSession({ id: "fresh", updatedAt: 200 }));
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect((await loadSessions()).map((s) => s.id)).toEqual(["fresh", "existing"]);
  });

  it("trims beyond the cap and reports the dropped list once", async () => {
    const dropped: StoredSession[] = [];
    const store = new SessionStore({ maxSessions: 2, onTrimmed: (d) => dropped.push(...d) });
    await saveSessions([
      makeSession({ id: "old-1", updatedAt: 1 }),
      makeSession({ id: "old-2", updatedAt: 2 }),
    ]);
    store.record(makeSession({ id: "newest", updatedAt: 3 }));
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect((await loadSessions()).map((s) => s.id)).toEqual(["newest", "old-2"]);
    expect(dropped.map((s) => s.id)).toEqual(["old-1"]);
  });
});

// --- M5-2: oversized-output trimming + quota fallback ---------------------------

function assistantWithToolOutput(chars: number): UIMessage {
  return {
    id: "a-tool",
    role: "assistant",
    parts: [
      { type: "text", text: "screenshot taken" },
      {
        type: "tool-screenshot",
        toolCallId: "t1",
        state: "output-available",
        input: {},
        output: "x".repeat(chars),
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("sanitizeSessionMessages (M5-2)", () => {
  it("replaces oversized tool outputs with a size stub and keeps the rest", () => {
    const messages = [
      userMsg("shoot the page"),
      assistantWithToolOutput(30_000),
      assistantMsg("done"),
    ];
    const [first, tool, last] = sanitizeSessionMessages(messages, 20_000);
    // The stub REPLACES the output — the size note rides inside `output`.
    const output = (tool!.parts[1] as { output: { juniorTrimmed: boolean; originalChars: number } })
      .output;
    expect(output.juniorTrimmed).toBe(true);
    expect(output.originalChars).toBe(30_000);
    expect((first!.parts[0] as { text: string }).text).toBe("shoot the page");
    expect((tool!.parts[0] as { text: string }).text).toBe("screenshot taken");
    expect(last!.parts[0]).toEqual({ type: "text", text: "done" });
  });

  it("leaves small outputs, user messages, and string outputs under the cap intact", () => {
    const messages = [userMsg("hi"), assistantWithToolOutput(100)];
    const [first, tool] = sanitizeSessionMessages(messages, 20_000);
    expect(first).toBe(messages[0]); // same reference — untouched
    expect((tool!.parts[1] as { output: string }).output).toBe("x".repeat(100));
  });
});

// --- M5-10: interrupted-tool finalization ---------------------------------------

function toolMessage(state: string, extra: Record<string, unknown> = {}): UIMessage {
  return {
    id: "a-tool",
    role: "assistant",
    parts: [
      { type: "text", text: "on it" },
      {
        type: "tool-navigate",
        toolCallId: "t1",
        state,
        input: { url: "https://example.com/" },
        ...extra,
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("finalizeInterruptedToolParts (M5-10)", () => {
  it("marks a mid-tool part output-error with the interrupted note", () => {
    const [first, tool] = finalizeInterruptedToolParts([
      userMsg("go"),
      toolMessage("input-available"),
    ]);
    expect((first!.parts[0] as { text: string }).text).toBe("go");
    const part = tool!.parts[1] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe(INTERRUPTED_TOOL_ERROR);
  });

  it("covers input-streaming too and leaves resolved parts byte-identical", () => {
    const running = toolMessage("output-available", { output: '{"title":"Example"}' });
    const streaming = toolMessage("input-streaming");
    const out = finalizeInterruptedToolParts([running, streaming]);
    expect(out[0]).toBe(running); // resolved — same reference
    expect((out[1]!.parts[1] as { state: string }).state).toBe("output-error");
  });

  it("keeps an errored part (errorText counts as resolved) and empty sessions untouched", () => {
    const failed = toolMessage("output-error", { errorText: "USER_DENIED: no" });
    const out = finalizeInterruptedToolParts([failed]);
    expect(out[0]).toBe(failed);
    expect(finalizeInterruptedToolParts([])).toEqual([]);
  });
});

describe("SessionStore persist-time tool finalization (M5-10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a session persisted mid-tool (panel close) is stored as failed, not running", async () => {
    const store = new SessionStore();
    const session = makeSession({ id: "dangling", updatedAt: 5 });
    session.messages = [toolMessage("input-available")];
    store.record(session);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    const [stored] = await loadSessions();
    const part = stored!.messages[0]!.parts[1] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe(INTERRUPTED_TOOL_ERROR);
  });
});

describe("saveSessionsDroppingOldest (M5-2 quota fallback)", () => {
  const list = (ids: [string, number][]) =>
    ids.map(([id, updatedAt]) => makeSession({ id, updatedAt }));

  it("saves when there is no quota error", async () => {
    const sessions = list([["a", 1]]);
    const save = vi.fn(async (_kept: StoredSession[]) => {});
    await saveSessionsDroppingOldest(sessions, save);
    expect(save.mock.calls[0]![0].map((s) => s.id)).toEqual(["a"]);
  });

  it("drops the oldest 20% per retry until the write fits and reports drops", async () => {
    // 10 sessions, quota allows only the newest 8 (two 20% drops of 2).
    const fitsAt = 8;
    const save = vi.fn(async (kept: StoredSession[]) => {
      if (kept.length > fitsAt) {
        throw Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
      }
    });
    const dropped: StoredSession[] = [];
    const sessions = list([
      ["n1", 10],
      ["n2", 9],
      ["n3", 8],
      ["n4", 7],
      ["n5", 6],
      ["n6", 5],
      ["n7", 4],
      ["n8", 3],
      ["n9", 2],
      ["n10", 1],
    ]);
    await saveSessionsDroppingOldest(sessions, save, (d) => dropped.push(...d));
    const lastCall = save.mock.calls.at(-1)![0];
    expect(lastCall.map((s) => s.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
    expect(dropped.map((s) => s.id)).toEqual(["n9", "n10"]);
  });

  it("rethrows non-quota errors and quota errors with nothing left to drop", async () => {
    const boom = new Error("disk on fire");
    await expect(
      saveSessionsDroppingOldest(list([["a", 1]]), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const quota = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    const save = vi.fn(async () => {
      throw quota;
    });
    await expect(saveSessionsDroppingOldest(list([["a", 1]]), save)).rejects.toBe(quota);
    expect(save).toHaveBeenCalledTimes(2); // full list, then the empty list
  });
});

describe("SessionStore persist-time sanitization (M5-2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("compacts oversized tool outputs on the way to storage", async () => {
    const store = new SessionStore();
    const session = makeSession({ id: "big", updatedAt: 5 });
    session.messages = [assistantWithToolOutput(30_000)];
    store.record(session);
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    const [stored] = await loadSessions();
    const output = (stored!.messages[0]!.parts[1] as { output: { juniorTrimmed?: boolean } })
      .output;
    expect(output.juniorTrimmed).toBe(true);
  });
});
