// Pure ⌘K-picker + Settings→Providers logic (plan §5.3). No React, no storage — the
// cmdk dialog (components/model-picker.tsx) and the settings UI consume these.
import type { BridgeStatus, ProviderStatus } from "@junior/protocol";
import type { RecentModel } from "./settings";
import { modelsFor } from "./chat";

export interface PickerItem {
  providerId: string;
  model: string;
  /** Model label/badges from the status catalog (empty when the provider has none). */
  badges: string[];
  /** cmdk filter text: the provider label + model id, so "openrouter sonnet" matches. */
  keywords: string[];
}

export interface PickerGroup {
  id: string;
  heading: string;
  items: PickerItem[];
}

/** cmdk onSelect hands back a string value — model ids contain "/" and ":", so the
 * (providerId, model) pair rides as JSON. decodePickerValue is the only consumer. */
export function encodePickerValue(item: PickerItem): string {
  return JSON.stringify([item.providerId, item.model]);
}

export function decodePickerValue(value: string): PickerItem | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { providerId: parsed[0], model: parsed[1], badges: [], keywords: [] };
    }
  } catch {
    // fall through
  }
  return null;
}

function providerItems(provider: ProviderStatus): PickerItem[] {
  return modelsFor(provider).map((model) => {
    const badges = provider.models.find((m) => m.id === model)?.badges ?? [];
    return {
      providerId: provider.id,
      model,
      badges: [...badges],
      keywords: [provider.label, provider.id, model],
    };
  });
}

/** Groups for the palette: Recent (if any), then one group per provider from
 * /api/status that has models to offer. Unavailable providers and claude-cli (no
 * catalog until the M4-4 engine) are omitted — they can't serve a chat today. */
export function buildPickerGroups(status: BridgeStatus, recent: RecentModel[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  const available = status.providers.filter((p) => p.available);

  const known = new Set(
    available.flatMap((p) => modelsFor(p).map((model) => `${p.id}\u0000${model}`)),
  );
  const recentSeen = new Set<string>();
  const recentItems = recent
    .filter((r) => known.has(`${r.providerId}\u0000${r.model}`))
    .filter((r) => {
      const key = `${r.providerId}\u0000${r.model}`;
      if (recentSeen.has(key)) return false;
      recentSeen.add(key);
      return true;
    })
    .map((r) => {
      const provider = available.find((p) => p.id === r.providerId);
      const item = providerItems(provider!).find((i) => i.model === r.model);
      return item ?? { providerId: r.providerId, model: r.model, badges: [], keywords: [] };
    });
  if (recentItems.length > 0) groups.push({ id: "recent", heading: "Recent", items: recentItems });

  for (const provider of available) {
    const items = providerItems(provider);
    if (items.length > 0) groups.push({ id: provider.id, heading: provider.label, items });
  }
  return groups;
}

// --- Settings → Providers: base-URL validation (plan §5.3) --------------------
// "the parseBridgeUrl-style https/loopback check on the base URL": https anywhere,
// plain http only for loopback hosts — an http URL to a public host is refused.

export function validateBaseUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true, url };
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      host === "[::ffff:127.0.0.1]"
    ) {
      return { ok: true, url };
    }
    return { ok: false, error: "plain http is only allowed for 127.0.0.1/localhost — use https" };
  }
  return { ok: false, error: `unsupported scheme ${url.protocol}` };
}
