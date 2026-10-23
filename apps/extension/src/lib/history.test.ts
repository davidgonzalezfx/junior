// History unit tests: pure list math (title/search/upsert/trim/export), storage
// round-trips with corrupt-entry filtering, and the debounced SessionStore
// (fake timers; fakeBrowser auto-resets per test via WxtVitest).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import {
  MAX_SESSIONS,
  SessionStore,
  WRITE_DEBOUNCE_MS,
  deleteSession,
  deriveTitle,
  emptySession,
  exportFilename,
  loadSessions,
  parseSessions,
  renameSession,
  saveSessions,
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
