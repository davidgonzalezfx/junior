// Versioned chrome.storage.local migrations (plan §5.2 storage layer).
// One registered migration per storage-shape change, applied strictly in order at
// panel boot (before sessions restore) and SW startup. A stored version NEWER than
// the code (extension downgrade) leaves data untouched — never downgrade user data.
import { browser } from "wxt/browser";
import type { UIMessage } from "ai";
import { sanitizeSessionMessages } from "./history";

export const STORAGE_VERSION_KEY = "junior_storage_version";
export const STORAGE_VERSION = 1;

interface Migration {
  toVersion: number;
  description: string;
  migrate(data: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: readonly Migration[] = [
  {
    toVersion: 1,
    // Older builds stored full tool outputs; one screenshot ≈ up to 1 MB of base64
    // inside junior_sessions (quota 10 MB). Compact the payloads once, up front.
    description: "compact oversized tool outputs stored in junior_sessions",
    migrate(data) {
      const sessions = data["junior_sessions"];
      if (!Array.isArray(sessions)) return data;
      data["junior_sessions"] = sessions.map((session) => compactSession(session));
      return data;
    },
  },
];

function compactSession(session: unknown): unknown {
  if (typeof session !== "object" || session === null) return session;
  const messages = (session as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return session;
  return { ...session, messages: sanitizeSessionMessages(messages as UIMessage[]) };
}

/** Pure core: apply every migration newer than `fromVersion`, in order. A version
 * that is not a non-negative integer counts as 0; one newer than the code (and the
 * resulting `applied` list) tells the caller whether a write is needed. */
export function applyMigrations(
  fromVersion: number,
  data: Record<string, unknown>,
): { version: number; data: Record<string, unknown>; applied: string[] } {
  const current = Number.isInteger(fromVersion) && fromVersion >= 0 ? fromVersion : 0;
  if (current > STORAGE_VERSION) return { version: current, data, applied: [] };
  const applied: string[] = [];
  let next = data;
  for (const migration of MIGRATIONS) {
    if (migration.toVersion <= current) continue;
    next = migration.migrate(next);
    applied.push(`v${migration.toVersion}: ${migration.description}`);
  }
  return { version: Math.max(current, STORAGE_VERSION), data: next, applied };
}

/** Read every key, run pending migrations, write back + stamp the version.
 * Idempotent: a second run finds the stamp and writes nothing. Migrations must
 * be idempotent too — a corrupt version stamp re-runs them from 0. */
export async function runStorageMigrations(): Promise<string[]> {
  const stored = await browser.storage.local.get(null);
  const raw = stored[STORAGE_VERSION_KEY];
  const from = typeof raw === "number" ? raw : 0;
  const { version, data, applied } = applyMigrations(from, stored);
  if (applied.length === 0 && version === from) return [];
  await browser.storage.local.set({ ...data, [STORAGE_VERSION_KEY]: version });
  return applied;
}
