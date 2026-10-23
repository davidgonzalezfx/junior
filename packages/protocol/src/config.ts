// @junior/protocol/config.ts — ~/.junior/config.json schema (plan §4.1).
// Parsed by the bridge on startup; written by `junior-bridge` CLI + Settings→Providers.
import { z } from "zod";

export const OpenAICompatibleProviderConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  models: z.array(z.string()).optional(), // fetched from /models when omitted
});

export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderConfigSchema>;

export const ProvidersConfigSchema = z.object({
  anthropicKey: z.string().optional(),
  openaiCompatible: z.array(OpenAICompatibleProviderConfigSchema).default([]),
});

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export const JuniorConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8620),
  permissionMode: z.enum(["ask", "auto", "none"]).default("ask"),
  providers: ProvidersConfigSchema.default({ openaiCompatible: [] }),
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
