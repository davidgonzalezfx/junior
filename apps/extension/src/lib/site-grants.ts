// lib/site-grants.ts — extension-side "Allow for this site" persistence.
// The BRIDGE's SessionGuard keeps its own grantedSites in bridge memory;
// these grants serve the extension guard-mirror's ask verdicts only. Session-
// scoped like the bridge's: stored in storage.local (fakeBrowser has no
// storage.session to test against) and cleared on browser startup by the SW,
// so grants die with the browser session the user made them in.
import { browser } from "wxt/browser";
import { registrableDomain } from "@junior/protocol";

const GRANTS_KEY = "junior_site_grants";

export async function getSiteGrants(): Promise<string[]> {
  const stored = await browser.storage.local.get(GRANTS_KEY);
  const value = stored[GRANTS_KEY];
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : [];
}

export async function addSiteGrant(domain: string): Promise<string[]> {
  const grants = await getSiteGrants();
  if (!grants.includes(domain)) grants.push(domain);
  await browser.storage.local.set({ [GRANTS_KEY]: grants });
  return grants;
}

export async function clearSiteGrants(): Promise<void> {
  await browser.storage.local.remove(GRANTS_KEY);
}

/** A grant covers a URL when its registrable domain matches an entry (pure —
 * the storage wrappers above stay thin so this is where the logic is tested). */
export function grantCovers(grants: readonly string[], url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const registrable = registrableDomain(hostname);
  return hostname !== "" && registrable !== "" && grants.includes(registrable);
}
