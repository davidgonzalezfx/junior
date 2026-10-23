// @junior/protocol/chat.ts — POST /api/chat request body (plan §3).
// The response side is an AI SDK v7 UI message stream (SSE), not this schema.
import { z } from "zod";

// engine/provider must agree: the cli engine drives the `claude` binary (provider
// "claude-cli"); the api engine drives a real provider ("anthropic" or an
// openai-compatible id). The defaults form the valid api+anthropic pair — M1-2
// review: the old defaults (api + claude-cli) combined into the one invalid combo.
export const ChatRequestBodySchema = z
  .object({
    engine: z.enum(["api", "cli"]).default("api"),
    provider: z.string().min(1).default("anthropic"),
    model: z.string(), // e.g. "claude-sonnet-5-5" | "anthropic/claude-sonnet-5.5"
    agentMode: z.boolean().default(false), // false = no browser tools registered
    cliTools: z.enum(["browser", "all"]).default("browser"), // CLI engine: expose native tools too?
    system: z.string().max(8000).optional(), // panel may prepend its own persona bit
    // UIMessages as sent by DefaultChatTransport (M2-3). Deliberately loose here — the AI
    // SDK owns the UIMessage shape and `convertToModelMessages` is the real validator
    // (the bridge turns its throw into a 400); duplicating that union in zod would rot
    // with every ai@ release. Other transport fields (id/trigger/messageId) pass through
    // unvalidated.
    messages: z.array(z.record(z.string(), z.unknown())),
  })
  .refine((b) => (b.engine === "cli") === (b.provider === "claude-cli"), {
    message:
      'engine/provider mismatch — engine "cli" requires provider "claude-cli"; engine "api" requires "anthropic" or an openai-compatible provider id',
  });

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;
