// SessionStore as the single writer of `junior_sessions` (review R§4.8):
// rename and delete go through the store so a pending debounced snapshot can't
// undo them, and a max-latency cap keeps a long stream from starving the write.
// Fake timers + the in-memory fakeBrowser storage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage, userMessage } from "@junior/testkit/chat";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { emptySession, loadSessions, saveSessions, type StoredSession } from "@/lib/history";
import {
  MAX_WRITE_LATENCY_MS,
  SessionStore,
  WRITE_DEBOUNCE_MS,
  snapshotFor,
} from "@/lib/session-store";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return { ...emptySession(), ...overrides };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStore.rename (symptom A — rename lost)", () => {
  it("a pending snapshot recorded before the rename does not overwrite it", async () => {
    const store = new SessionStore();
    await saveSessions([makeSession({ id: "a", title: "auto title", updatedAt: 1 })]);
    // A chunk landed just before the user renamed: snapshot still has the old title.
    store.record(makeSession({ id: "a", title: "auto title", updatedAt: 2 }));

    await store.rename("a", "Mine");
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);

    const [stored] = await loadSessions();
    expect(stored).toMatchObject({ id: "a", title: "Mine", renamed: true });
  });

  it("a rename issued while a flush is in flight still wins", async () => {
    const store = new SessionStore();
    await saveSessions([makeSession({ id: "a", title: "auto title", updatedAt: 1 })]);
    store.record(makeSession({ id: "a", title: "auto title", updatedAt: 2 }));

    const flushing = store.flush(); // reads storage, then writes the old title
    const renaming = store.rename("a", "Mine");
    await Promise.all([flushing, renaming]);

    expect((await loadSessions())[0]).toMatchObject({ title: "Mine", renamed: true });
  });

  it("resolves with the fresh list (the history view re-renders from it)", async () => {
    const store = new SessionStore();
    await saveSessions([makeSession({ id: "a", title: "old" })]);
    const list = await store.rename("a", "new");
    expect(list.map((s) => s.title)).toEqual(["new"]);
  });
});

describe("SessionStore.delete (symptom B — deleted session resurrects)", () => {
  it("purges the pending snapshot so the debounced flush cannot re-write it", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "doomed", messages: [userMessage("hi")] }));
    await store.flush();
    store.record(makeSession({ id: "doomed", messages: [userMessage("hi"), userMessage("more")] }));

    const list = await store.delete("doomed");
    expect(list).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_WRITE_LATENCY_MS);
    expect(await loadSessions()).toEqual([]);
  });

  it("a late record into the deleted id (stale active ref) is ignored", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "doomed" }));
    await store.flush();
    await store.delete("doomed");

    store.record(makeSession({ id: "doomed", updatedAt: Date.now() + 1 }));
    await store.flush();
    expect(await loadSessions()).toEqual([]);
  });

  it("leaves other pending sessions alone", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "keep" }));
    store.record(makeSession({ id: "doomed" }));
    await store.delete("doomed");
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);
    expect((await loadSessions()).map((s) => s.id)).toEqual(["keep"]);
  });
});

describe("SessionStore max-latency cap (symptom C — debounce starvation)", () => {
  it("flushes within MAX_WRITE_LATENCY_MS while records keep arriving", async () => {
    expect(MAX_WRITE_LATENCY_MS).toBe(2000);
    const store = new SessionStore();
    // A long stream: one record per 100 ms chunk — the 500 ms debounce never elapses.
    let chunk = 0;
    const tick = () => {
      chunk += 1;
      store.record(makeSession({ id: "stream", title: `chunk ${chunk}` }));
    };
    tick();
    for (let t = 100; t < MAX_WRITE_LATENCY_MS; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      tick();
    }
    expect(await loadSessions()).toEqual([]); // still inside the cap window
    await vi.advanceTimersByTimeAsync(100); // t = 2000 ms after the first record

    const stored = await loadSessions();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe(`chunk ${chunk}`); // the newest snapshot, not the first
  });

  it("re-arms the cap for the next burst after a capped flush", async () => {
    const store = new SessionStore();
    let chunk = 0;
    for (let t = 0; t < 2 * MAX_WRITE_LATENCY_MS + 100; t += 100) {
      chunk += 1;
      store.record(makeSession({ id: "stream", title: `chunk ${chunk}` }));
      await vi.advanceTimersByTimeAsync(100);
    }
    // Two cap windows elapsed (≈2 s and ≈4 s) — storage is at most ~2 s behind.
    const title = (await loadSessions())[0]!.title;
    expect(Number(title.replace("chunk ", ""))).toBeGreaterThanOrEqual(40);
  });

  it("keeps the 500 ms debounce for a quiet single record", async () => {
    const store = new SessionStore();
    store.record(makeSession({ id: "quiet" }));
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1);
    expect(await loadSessions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await loadSessions()).toHaveLength(1);
  });
});

describe("snapshotFor (R§6.5 — no re-record on view)", () => {
  const seed = [userMessage("first question"), assistantMessage("answer")];
  const base = makeSession({ updatedAt: 1, messages: seed });

  it("is null for an empty chat and for the session's own messages", () => {
    expect(snapshotFor(base, [])).toBeNull();
    expect(snapshotFor(base, seed)).toBeNull();
    expect(snapshotFor(base, [...seed])).toBeNull(); // new array, same messages
  });

  it("stamps updatedAt and derives the title once the transcript changes", () => {
    const next = snapshotFor(base, [...seed, userMessage("follow-up")], 42);
    expect(next).toMatchObject({ updatedAt: 42, title: "first question" });
  });

  it("keeps a user-renamed title", () => {
    const renamed = { ...base, title: "Mine", renamed: true };
    expect(snapshotFor(renamed, [...seed, userMessage("x")])!.title).toBe("Mine");
  });
});
