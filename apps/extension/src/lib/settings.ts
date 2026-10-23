// Typed chrome.storage.local wrapper (plan §5.2 item 1). All keys follow the
// `junior_*` convention. `chrome.storage.local` is a TRUSTED_CONTEXTS store since the
// M2-1 SW calls setAccessLevel — content scripts can never read the token (§5.1).
import { browser } from "wxt/browser";
import { ExtensionSettingsSchema, type ExtensionSettings } from "@junior/protocol";

const SETTINGS_KEY = "junior_settings";
const TOKEN_KEY = "junior_bridge_token";
const ONBOARDED_KEY = "junior_onboarded";
const DEFAULT_PROVIDER_KEY = "junior_default_provider";

/** Read + validate settings; missing or corrupt storage falls back to §4.1 defaults. */
export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const parsed = ExtensionSettingsSchema.safeParse(stored[SETTINGS_KEY] ?? {});
  return parsed.success ? parsed.data : ExtensionSettingsSchema.parse({});
}

/** Merge a patch over the stored settings and persist the result. */
export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const merged = ExtensionSettingsSchema.parse({ ...(await loadSettings()), ...patch });
  await browser.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

// --- pairing token -----------------------------------------------------------

export async function getToken(): Promise<string | null> {
  const stored = await browser.storage.local.get(TOKEN_KEY);
  const value = stored[TOKEN_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token });
}

// --- onboarding flag ---------------------------------------------------------

export async function isOnboarded(): Promise<boolean> {
  const stored = await browser.storage.local.get(ONBOARDED_KEY);
  return stored[ONBOARDED_KEY] === true;
}

export async function setOnboarded(onboarded: boolean): Promise<void> {
  await browser.storage.local.set({ [ONBOARDED_KEY]: onboarded });
}

// --- default provider (seed for M2-4 ⌘K picker + Settings→Providers) ---------

export interface DefaultProvider {
  providerId: string;
  model: string | null;
}

export async function getDefaultProvider(): Promise<DefaultProvider | null> {
  const stored = await browser.storage.local.get(DEFAULT_PROVIDER_KEY);
  const value = stored[DEFAULT_PROVIDER_KEY];
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefaultProvider).providerId === "string"
  ) {
    const { providerId, model } = value as DefaultProvider;
    return { providerId, model: typeof model === "string" ? model : null };
  }
  return null;
}

export async function setDefaultProvider(provider: DefaultProvider | null): Promise<void> {
  if (provider === null) {
    await browser.storage.local.remove(DEFAULT_PROVIDER_KEY);
  } else {
    await browser.storage.local.set({ [DEFAULT_PROVIDER_KEY]: provider });
  }
}
