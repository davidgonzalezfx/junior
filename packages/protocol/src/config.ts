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
