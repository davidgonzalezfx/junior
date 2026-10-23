// Session history — single source of truth in chrome.storage.local under
// `junior_sessions` (plan §5.3): sessions list, text search, rename, delete,
// markdown export; debounced writes (500 ms) + write-on-hide; trimming beyond
// 200 sessions with a dropped-list callback so the UI can offer an export
// prompt. Autono duplicated history into localStorage AND chrome.storage —
// Junior keeps exactly one store.
import { browser } from "wxt/browser";
import type { UIMessage } from "ai";

const SESSIONS_KEY = "junior_sessions";
const ACTIVE_KEY = "junior_active_session";

export const MAX_SESSIONS = 200;
export const WRITE_DEBOUNCE_MS = 500;

export interface StoredSession {
  id: string;
  /** Auto-derived from the first user message unless the user renamed the session. */
  title: string;
  renamed: boolean;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
}

// --- pure list math (unit-tested; the storage wrappers below are thin) --------

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function emptySession(now: number = Date.now()): StoredSession {
  return {
    id: newSessionId(),
    title: "New chat",
    renamed: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function textOf(message: UIMessage): string {
  let out = "";
  for (const part of message.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

const TITLE_MAX = 60;

/** First user text, whitespace-collapsed, ellipsized at TITLE_MAX. */
export function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const collapsed = (firstUser === undefined ? "" : textOf(firstUser)).trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "New chat";
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1)}…` : collapsed;
}

export function searchSessions(list: StoredSession[], query: string): StoredSession[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return list;
  return list.filter((s) =>
    [s.title, ...s.messages.map(textOf)].join("\n").toLowerCase().includes(q),
  );
}

/** Newest-first insert/replace — callers keep the list sorted by updatedAt. */
export function upsertSession(list: StoredSession[], session: StoredSession): StoredSession[] {
  return [session, ...list.filter((s) => s.id !== session.id)];
}

export function trimSessions(
  list: StoredSession[],
  max: number = MAX_SESSIONS,
): { kept: StoredSession[]; dropped: StoredSession[] } {
  return { kept: list.slice(0, max), dropped: list.slice(max) };
}

export function sessionToMarkdown(session: StoredSession, now: number = Date.now()): string {
  const lines: string[] = [
    `# ${session.title}`,
    "",
    `> Exported from Junior · ${new Date(now).toISOString()} · ${session.messages.length} messages`,
    "",
  ];
  for (const message of session.messages) {
    const text = textOf(message).trim();
    lines.push(
      message.role === "user" ? "## You" : "## Junior",
      "",
      text || "_(no text content)_",
      "",
    );
  }
  return lines.join("\n");
}

export function exportFilename(session: StoredSession): string {
  const slug =
    session.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
  return `junior-${slug}.md`;
}

/** Trigger a browser download of one session as markdown. */
export function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// --- storage (defensive parsing per the settings.ts convention) ---------------

function parseSession(value: unknown): StoredSession | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.title !== "string" || typeof v.renamed !== "boolean") return null;
  if (typeof v.createdAt !== "number" || typeof v.updatedAt !== "number") return null;
  if (!Array.isArray(v.messages)) return null;
  // Message shape is AI-SDK-owned; the renderer tolerates unknown part types.
  return {
    id: v.id,
    title: v.title,
    renamed: v.renamed,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    messages: v.messages as UIMessage[],
  };
}

/** Newest-first; malformed entries are dropped, not fatal. */
export function parseSessions(value: unknown): StoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseSession)
    .filter((s): s is StoredSession => s !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSessions(): Promise<StoredSession[]> {
  const stored = await browser.storage.local.get(SESSIONS_KEY);
  return parseSessions(stored[SESSIONS_KEY]);
}

export async function saveSessions(list: StoredSession[]): Promise<void> {
  await browser.storage.local.set({ [SESSIONS_KEY]: list });
}

export async function renameSession(id: string, title: string): Promise<StoredSession[]> {
  const list = await loadSessions();
  const next = list.map((s) =>
    s.id === id ? { ...s, title: title.trim() || s.title, renamed: true } : s,
  );
  await saveSessions(next);
  return next;
}

export async function deleteSession(id: string): Promise<StoredSession[]> {
  const next = (await loadSessions()).filter((s) => s.id !== id);
  await saveSessions(next);
  return next;
}

// --- last active session (restored on open; the write-on-hide counterpart) ----

export async function getActiveSessionId(): Promise<string | null> {
  const stored = await browser.storage.local.get(ACTIVE_KEY);
  const value = stored[ACTIVE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setActiveSessionId(id: string | null): Promise<void> {
  if (id === null) {
    await browser.storage.local.remove(ACTIVE_KEY);
  } else {
    await browser.storage.local.set({ [ACTIVE_KEY]: id });
  }
}

// --- debounced store -----------------------------------------------------------

/** Client-side persistence gate: record() queues a single debounced write;
 * flush() (panel hide / pagehide) lands any pending snapshot immediately.
 * Every flush reads fresh from storage, so a flush after a panel reload is safe. */
export class SessionStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, StoredSession>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      delayMs?: number;
      maxSessions?: number;
      onTrimmed?: (dropped: StoredSession[]) => void;
    } = {},
  ) {}

  record(session: StoredSession): void {
    this.pending.set(session.id, session);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.delayMs ?? WRITE_DEBOUNCE_MS);
    // Pending timers hang vitest workers at exit (M1-2 learning); the browser
    // ignores unref.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.writes = this.writes.then(
      () => this.writeBatch(batch),
      () => this.writeBatch(batch),
    );
    await this.writes;
  }

  private async writeBatch(batch: StoredSession[]): Promise<void> {
    const stale = new Set(batch.map((s) => s.id));
    const next = [...batch, ...(await loadSessions()).filter((s) => !stale.has(s.id))];
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    const { kept, dropped } = trimSessions(next, this.options.maxSessions ?? MAX_SESSIONS);
    await saveSessions(kept);
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
