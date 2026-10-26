// Host-access gate (decisions.md 2026-10-25): agent-mode page actions
// (read_page/click/type + overlay injection) run through chrome.scripting.executeScript,
// which needs origin access to the tab's site — navigation works without it, so the
// breakage only surfaced on real sites ("Extension manifest must request permission to
// access this host"). The manifest installs with bridge-only host_permissions (§5.1
// posture); <all_urls> is an OPTIONAL host permission granted at runtime. The agent-mode
// composer send is a user gesture — the one context Chrome allows the dialog in — so the
// gate runs there; plain chat must never trigger it.
import { browser } from "wxt/browser";

export const ALL_URLS_ORIGIN = "<all_urls>";

/** The two chrome.permissions calls the gate needs — a seam because wxt's fakeBrowser
 * doesn't implement the permissions API, so tests inject fakes at these two methods. */
export interface PermissionsGate {
  contains: (origins: string[]) => Promise<boolean>;
  request: (origins: string[]) => Promise<boolean>;
}

export const realPermissionsGate: PermissionsGate = {
  contains: (origins) => browser.permissions.contains({ origins }),
  request: (origins) => browser.permissions.request({ origins }),
};

export type HostAccess = "granted" | "denied";

/** Ask once for the origins when not yet granted: `contains` is the cheap path (an
 * already-granted install skips the dialog entirely), otherwise `request` resolves the
 * user's dialog choice — or false immediately, once the user has denied in Chrome's
 * extension settings. Call from a user gesture (composer send), never on a timer. */
export async function ensureHostAccess(
  gate: PermissionsGate = realPermissionsGate,
  origins: string[] = [ALL_URLS_ORIGIN],
): Promise<HostAccess> {
  if (await gate.contains(origins)) return "granted";
  return (await gate.request(origins)) ? "granted" : "denied";
}
