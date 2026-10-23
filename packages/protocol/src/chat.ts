// @junior/protocol/chat.ts — POST /api/chat request body (plan §3).
// The response side is an AI SDK v5 UI message stream (SSE), not this schema.
import { z } from "zod";

export const ChatRequestBodySchema = z.object({
  engine: z.enum(["api", "cli"]).default("api"),
  provider: z.string().default("claude-cli"), // "claude-cli" | "anthropic" | <openai-compatible id>
  model: z.string(), // e.g. "claude-sonnet-5-5" | "anthropic/claude-sonnet-5.5"
  agentMode: z.boolean().default(false), // false = no browser tools registered
  cliTools: z.enum(["browser", "all"]).default("browser"), // CLI engine: expose native tools too?
  system: z.string().max(8000).optional(), // panel may prepend its own persona bit
});

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;
