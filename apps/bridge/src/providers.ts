// @junior/bridge/providers — Settings→Providers backend (plan §5.3).
// GET/PUT /api/config + POST /api/config/test. Keys live ONLY in ~/.junior/config.json
// (docs/decisions.md 2026-10-23 — plan §5.3 said chrome.storage.local; the chat registry
// reads config, so the bridge is the single source of truth). GET returns a MASKED view
// (ProvidersViewSchema is strict — a raw apiKey on the wire fails the parse); PUT takes
// a patch where absent keys mean "keep what the bridge has", so the UI only ever sends
// a key the user actually typed. A successful POST /api/config/test also persists the
// fetched catalog onto the entry so /api/status → ⌘K picker serves real models.
import { Hono } from "hono";
import {
  ProvidersPatchSchema,
  ProvidersViewSchema,
  ProviderTestRequestSchema,
  ProviderTestResultSchema,
  JuniorConfigSchema,
  type JuniorConfig,
  type ProvidersPatch,
  type ProvidersView,
} from "@junior/protocol";
import type { Logger } from "./auth.js";
import { loadConfig, saveConfig } from "./config.js";

/** Masked key display (plan §5.3: "never rendered back in full") — last 4 chars only. */
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

/** Pure config → masked GET /api/config view. */
export function toProvidersView(config: JuniorConfig): ProvidersView {
  return ProvidersViewSchema.parse({
    anthropicKeyMasked:
      config.providers.anthropicKey !== undefined ? maskKey(config.providers.anthropicKey) : null,
    openaiCompatible: config.providers.openaiCompatible.map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      hasApiKey: p.apiKey.length > 0,
      ...(p.models !== undefined ? { models: p.models } : {}),
    })),
    fallbackChain: config.providers.fallbackChain,
  });
}

/** Pure patch application. Semantics: absent apiKey = keep existing (matched by id,
 * new ids start keyless); "" clears. Same for `models`: absent = keep the
 * persisted catalog, an explicit array replaces it — the UI never re-sends a catalog
 * it hasn't re-fetched, and a stale draft must not wipe one. The merged config is
 * re-validated by JuniorConfigSchema so a bad patch can never hit disk. */
export function applyProvidersPatch(
  config: JuniorConfig,
  patch: ProvidersPatch["providers"],
): JuniorConfig {
  const anthropicKey =
    patch.anthropicKey === undefined
      ? config.providers.anthropicKey
      : patch.anthropicKey === ""
        ? undefined
        : patch.anthropicKey;
  const openaiCompatible = patch.openaiCompatible.map((entry) => {
    const existing = config.providers.openaiCompatible.find((p) => p.id === entry.id);
    const apiKey = entry.apiKey ?? existing?.apiKey ?? "";
    const models = entry.models ?? existing?.models;
    return { ...entry, apiKey, ...(models !== undefined ? { models } : {}) };
  });
  return JuniorConfigSchema.parse({
    ...config,
    providers: { anthropicKey, openaiCompatible, fallbackChain: patch.fallbackChain },
  });
}

/** Persist a fetched model catalog onto the provider entry: the Settings "test"
 * button is the only thing that ever fetches {baseUrl}/models, so its result is stored
 * on the openai-compatible entry — GET /api/config serves it (masked view already
 * carries `models`) and /api/status → buildProviders feeds the ⌘K picker. Anthropic /
 * unknown ids return the SAME config object (anthropic uses the UI-side well-known
 * fallback list), so callers can skip the disk write when nothing changed. */
export function withPersistedModels(
  config: JuniorConfig,
  providerId: string,
  models: string[],
): JuniorConfig {
  if (!config.providers.openaiCompatible.some((p) => p.id === providerId)) return config;
  const openaiCompatible = config.providers.openaiCompatible.map((p) =>
    p.id === providerId ? { ...p, models } : p,
  );
  return JuniorConfigSchema.parse({
    ...config,
    providers: { ...config.providers, openaiCompatible },
  });
}

export interface ProviderTestDeps {
  /** Wire seam for the models fetch; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Base-URL/env seam so tests never depend on the real ANTHROPIC_BASE_URL. */
  env?: typeof process.env;
  timeoutMs?: number;
}

/** List models for one configured provider — the Settings "test"/"fetch models" button
 * (plan §5.3). Anthropic: GET {base}/v1/models with x-api-key. OpenAI-compatible:
 * GET {baseUrl}/models with Bearer (entries already store the /v1-inclusive base). */
export async function testProvider(
  config: JuniorConfig,
  providerId: string,
  deps: ProviderTestDeps = {},
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const base = modelsBase(config, providerId, env);
  if (base === null) {
    return {
      ok: false,
      error:
        providerId === "anthropic"
          ? "anthropic key not configured"
          : `provider "${providerId}" is not configured`,
    };
  }
  try {
    const res = await fetchImpl(`${base.url}/models`, {
      headers: { "x-api-key": base.key, Authorization: `Bearer ${base.key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}`.trim() };
    }
    const wire = (await res.json()) as { data?: unknown };
    const ids = Array.isArray(wire.data)
      ? wire.data
          .map((m) =>
            typeof m === "object" && m !== null && "id" in m
              ? String((m as { id: unknown }).id)
              : null,
          )
          .filter((id): id is string => id !== null)
      : [];
    if (ids.length === 0) return { ok: false, error: "response contained no models" };
    return { ok: true, models: ids };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolved models endpoint for a provider id, or null when unconfigured. Anthropic
 * mirrors anthropicBaseURL()'s /v1 normalization but with an injectable env. */
function modelsBase(
  config: JuniorConfig,
  providerId: string,
  env: typeof process.env,
): { url: string; key: string } | null {
  if (providerId === "anthropic") {
    const key = config.providers.anthropicKey;
    if (key === undefined) return null;
    const sdkBase = env.ANTHROPIC_BASE_URL
      ? env.ANTHROPIC_BASE_URL.endsWith("/v1")
        ? env.ANTHROPIC_BASE_URL
        : `${env.ANTHROPIC_BASE_URL}/v1`
      : "https://api.anthropic.com/v1";
    return { url: sdkBase, key };
  }
  const entry = config.providers.openaiCompatible.find((p) => p.id === providerId);
  if (entry === undefined) return null;
  return { url: entry.baseUrl, key: entry.apiKey };
}

export interface ProvidersDeps {
  dir: string;
  log?: Logger;
  /** Test seams for POST /api/config/test. */
  test?: ProviderTestDeps;
}

export function providersRoutes(deps: ProvidersDeps) {
  const log: Logger = deps.log ?? ((line) => console.warn(line));
  const routes = new Hono();

  routes.get("/config", (c) => c.json(toProvidersView(loadConfig(deps.dir))));

  routes.put("/config", async (c) => {
    const patch = ProvidersPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) {
      const detail = patch.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      return c.json({ error: `invalid providers patch — ${detail}` }, 400);
    }
    const merged = applyProvidersPatch(loadConfig(deps.dir), patch.data.providers);
    saveConfig(merged, deps.dir);
    log("[providers] config updated via PUT /api/config");
    return c.json({ ok: true });
  });

  routes.post("/config/test", async (c) => {
    const body = ProviderTestRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "body must be {providerId: string}" }, 400);
    const config = loadConfig(deps.dir);
    const result = await testProvider(config, body.data.providerId, deps.test);
    // A successful fetch IS the catalog — persist it so /api/status serves
    // models to the picker without a config round-trip through the UI.
    if (result.ok) {
      const merged = withPersistedModels(config, body.data.providerId, result.models);
      if (merged !== config) {
        saveConfig(merged, deps.dir);
        log(`[providers] persisted ${result.models.length} models for "${body.data.providerId}"`);
      }
    }
    return c.json(ProviderTestResultSchema.parse(result));
  });

  return routes;
}
