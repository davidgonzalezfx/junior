// @junior/protocol/config.ts — ~/.junior/config.json schema (plan §4.1).
// Parsed by the bridge on startup; written by `junior-bridge` CLI + Settings→Providers.
import { z } from "zod";

export const OpenAICompatibleProviderConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  // Catalog persisted by POST /api/config/test (M5-6) — the only place that fetches
  // {baseUrl}/models; absent until the first successful "Test" in Settings.
  models: z.array(z.string()).optional(),
});

export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderConfigSchema>;

export const ProvidersConfigSchema = z.object({
  anthropicKey: z.string().optional(),
  openaiCompatible: z.array(OpenAICompatibleProviderConfigSchema).default([]),
  // Ordered provider ids (§4.5): on a provider-level 4xx/5xx BEFORE the first token,
  // /api/chat retries the next candidate; after the first token the error surfaces.
  // The requested provider is always tried first and never needs to appear here.
  fallbackChain: z.array(z.string()).default([]),
});

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

// --- Settings → Providers wire shapes (M2-4; plan §5.3) -----------------------
// The bridge owns the keys (~/.junior/config.json — see docs/decisions.md 2026-10-23);
// these are the only shapes that cross the wire, and none of them ever carries a key
// back to the extension (§7-5: masked views out, explicit new keys in).

/** GET /api/config — providers view with keys masked out. */
export const ProvidersViewSchema = z.object({
  anthropicKeyMasked: z.string().nullable(), // e.g. "sk-…abcd", null = not configured
  openaiCompatible: z.array(
    z.strictObject({
      // strict: a wire apiKey field here would mean the GET leaks keys — refuse, don't strip
      id: z.string(),
      label: z.string(),
      baseUrl: z.string(),
      hasApiKey: z.boolean(),
      models: z.array(z.string()).optional(),
    }),
  ),
  fallbackChain: z.array(z.string()),
});

export type ProvidersView = z.infer<typeof ProvidersViewSchema>;

/** PUT /api/config body — full replace of the providers block. `anthropicKey` and an
 * entry's `apiKey` are OPTIONAL here: absent = keep what the bridge has (GET never
 * returns keys, so the UI re-sends one only when the user typed it). `""` clears. */
export const ProvidersPatchSchema = z.object({
  providers: z.object({
    anthropicKey: z.string().optional(),
    openaiCompatible: z.array(OpenAICompatibleProviderConfigSchema.partial({ apiKey: true })),
    fallbackChain: z.array(z.string()),
  }),
});

export type ProvidersPatch = z.infer<typeof ProvidersPatchSchema>;

/** POST /api/config/test — list models for one configured provider ("test" button). */
export const ProviderTestRequestSchema = z.object({ providerId: z.string().min(1) });
export const ProviderTestResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), models: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string().max(300) }),
]);

export const JuniorConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8620),
  permissionMode: z.enum(["ask", "auto", "none"]).default("ask"),
  providers: ProvidersConfigSchema.default({ openaiCompatible: [], fallbackChain: [] }),
  codeExecution: z.literal("off").default("off"), // reserved; not implemented in v1 (plan §4.1)
  maxSteps: z.number().int().min(1).max(100).default(30), // schema enforces the 1–100 clamp
  cliPath: z.string().optional(),
  allowCliNativeTools: z.boolean().default(false),
});

export type JuniorConfig = z.infer<typeof JuniorConfigSchema>;

// Pinned extension identity (docs/decisions.md 2026-10-23): Chrome derives this id from
// the manifest `key` in apps/extension/wxt.config.ts (public half of
// ~/.junior/extension-key.pem — private key never committed). The bridge CORS allowlist
// accepts ONLY this origin (apps/bridge/src/auth.ts); rotating the key rotates the id and
// both consumers together. Tripwire test asserts the [a-p]{32} shape.
export const EXTENSION_ID = "ocjlcgidjeodnjicogfmmicpkookeabb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}` as const;

// Extension-side mirror of the bridge facts it needs (plan §5.2 item 1) — stored in
// chrome.storage.local, never in ~/.junior/. permissionMode/allowCliNativeTools mirror
// JuniorConfigSchema fields so the extension can display + pre-check them.
export const ExtensionSettingsSchema = z.object({
  bridgeUrl: z.string().default("http://127.0.0.1:8620"),
  permissionMode: z.enum(["ask", "auto", "none"]).default("ask"),
  allowCliNativeTools: z.boolean().default(false),
});

export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
