// @junior/protocol/queue.ts — dispatcher queue envelope + action result (plan §3).
// One envelope for both actions and approval requests (single poll channel).
import { z } from "zod";
import { BrowserActionSchema } from "./actions.js";
import { ApprovalRequestSchema } from "./approval.js";

export const QueueItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), // unguessable (crypto.randomUUID + hex)
  kind: z.enum(["action", "approval"]),
  action: BrowserActionSchema.optional(),
  approval: ApprovalRequestSchema.optional(),
  createdAt: z.number(),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
});

export type QueueItem = z.infer<typeof QueueItemSchema>;

export const ActionResultSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "error", "denied"]),
  result: z.unknown().optional(), // capped by executor (maxChars etc.)
  error: z.string().max(500).optional(),
});

export type ActionResult = z.infer<typeof ActionResultSchema>;
