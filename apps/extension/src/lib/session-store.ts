// SessionStore — the panel's single writer of `junior_sessions` (plan §5.3).
// record() snapshots queue behind a 500 ms debounce capped at 2 s of latency;
// flush() (write-on-hide) lands them now; rename/delete edit the pending
// snapshots and order their storage write behind any in-flight flush, so a
// debounced write can never undo them.
import type { UIMessage } from "ai";
import {
  MAX_SESSIONS,
  deleteSession,
  deriveTitle,
  finalizeInterruptedToolParts,
  loadSessions,
  renameSession,
  sanitizeSessionMessages,
  saveSessions,
  saveSessionsDroppingOldest,
  trimSessions,
  type StoredSession,
} from "@/lib/history";

export const WRITE_DEBOUNCE_MS = 500;
/** A stream records on every chunk, so the debounce alone may never elapse —
 * this caps how stale storage can get while records keep arriving. */
export const MAX_WRITE_LATENCY_MS = 2000;

function sameMessages(a: UIMessage[], b: UIMessage[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/** The snapshot a messages change produces for `base`, or null when there is
 * nothing to persist: an untouched empty chat, or the very messages the session
 * already holds (the panel re-reports its seed on mount — recording that would
 * bump updatedAt and reorder history on mere viewing). */
export function snapshotFor(
  base: StoredSession,
  messages: UIMessage[],
  now: number = Date.now(),
): StoredSession | null {
  if (messages.length === 0 || sameMessages(base.messages, messages)) return null;
  return {
    ...base,
    messages,
    updatedAt: now,
    title: base.renamed ? base.title : deriveTitle(messages),
  };
}

type Timer = ReturnType<typeof setTimeout>;

/** Every write reads fresh from storage, so a flush after a panel reload is safe. */
export class SessionStore {
  private debounce: Timer | null = null;
  private deadline: Timer | null = null;
  private readonly pending = new Map<string, StoredSession>();
  // Ids are UUIDs, never reused — a record into a deleted id is a stale ref.
  private readonly deleted = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      delayMs?: number;
      maxLatencyMs?: number;
      maxSessions?: number;
      onTrimmed?: (dropped: StoredSession[]) => void;
    } = {},
  ) {}

  record(session: StoredSession): void {
    if (this.deleted.has(session.id)) return;
    this.pending.set(session.id, session);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = this.schedule(this.options.delayMs ?? WRITE_DEBOUNCE_MS);
    // Armed by the first pending record only; the next flush clears it.
    this.deadline ??= this.schedule(this.options.maxLatencyMs ?? MAX_WRITE_LATENCY_MS);
  }

  async flush(): Promise<void> {
    this.clearTimers();
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    await this.enqueue(() => this.writeBatch(batch));
  }

  /** Land pending snapshots, then read — the history view sees the live chat. */
  async list(): Promise<StoredSession[]> {
    try {
      await this.flush();
    } catch {
      // A failed flush (quota) still leaves storage readable; show what landed.
    }
    return this.enqueue(loadSessions);
  }

  /** Rename in storage and in any pending snapshot; resolves with the fresh list. */
  rename(id: string, title: string): Promise<StoredSession[]> {
    const snapshot = this.pending.get(id);
    if (snapshot !== undefined) {
      this.pending.set(id, { ...snapshot, title: title.trim() || snapshot.title, renamed: true });
    }
    return this.enqueue(() => renameSession(id, title));
  }

  /** Delete from storage, drop its pending snapshot, and ignore later records
   * into it; resolves with the fresh list. */
  delete(id: string): Promise<StoredSession[]> {
    this.deleted.add(id);
    this.pending.delete(id);
    return this.enqueue(() => deleteSession(id));
  }

  private schedule(ms: number): Timer {
    const timer = setTimeout(() => void this.flush(), ms);
    // Pending timers hang vitest workers at exit; the browser ignores unref.
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }

  private clearTimers(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.debounce = null;
    this.deadline = null;
  }

  /** Serialize storage read-modify-writes; a failed one doesn't block the next. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writes.then(op, op);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async writeBatch(batch: StoredSession[]): Promise<void> {
    const stale = new Set(batch.map((s) => s.id));
    const next = [...batch, ...(await loadSessions()).filter((s) => !stale.has(s.id))];
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    const { kept, dropped } = trimSessions(next, this.options.maxSessions ?? MAX_SESSIONS);
    // Finalize interrupted tools and trim tool payloads on the way
    // in — a panel close mid-tool must persist "failed", not "running…" — then let
    // the quota fallback shed oldest sessions if the write still fails.
    const sanitized = kept.map((s) => ({
      ...s,
      messages: sanitizeSessionMessages(finalizeInterruptedToolParts(s.messages)),
    }));
    await saveSessionsDroppingOldest(sanitized, saveSessions, this.options.onTrimmed);
    if (dropped.length > 0) this.options.onTrimmed?.(dropped);
  }
}

/** Write-on-hide (plan §5.3): the side panel closing fires
 * visibilitychange→hidden and pagehide. Returns a detach function. */
export function attachWriteOnHide(store: SessionStore): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void store.flush();
  };
  const onPageHide = () => void store.flush();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  };
}
