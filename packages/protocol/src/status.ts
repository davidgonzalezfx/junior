// @junior/protocol/status.ts — GET /api/status response (plan §3).
// Drives the ⌘K picker badges and Settings→Providers.
import { z } from "zod";

export const ProviderStatusSchema = z.object({
  id: z.string(),
  kind: z.enum(["claude-cli", "anthropic", "openai-compatible"]),
  label: z.string(),
  available: z.boolean(),
  detail: z.string().max(200).optional(), // e.g. "claude version 2.x — logged in"
  models: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        badges: z.array(z.enum(["vision", "tools", "reasoning", "fast"])).default([]),
      }),
    )
    .default([]),
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const BridgeStatusSchema = z.object({
  version: z.string(),
  apiLevel: z.number(),
  providers: z.array(ProviderStatusSchema),
  browserConnected: z.boolean(), // extension polled within 25 s
  queueDepth: z.number().int(),
});

export type BridgeStatus = z.infer<typeof BridgeStatusSchema>;
