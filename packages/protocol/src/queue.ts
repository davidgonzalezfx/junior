// @junior/protocol/queue.ts — dispatcher queue envelope + action result (plan §3).
// One channel carries both actions and approval requests; `kind` discriminates so a
// consumer can never see an item missing its payload (M1-2 review: the earlier
// all-optional shape parsed {kind:"action"} with no action at all).
import { z } from "zod";
import { BrowserActionSchema } from "./actions.js";
import { ApprovalRequestSchema } from "./approval.js";

const QueueItemFields = {
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/), // unguessable (crypto.randomUUID)
  createdAt: z.number(),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
};

export const ActionQueueItemSchema = z.object({
  ...QueueItemFields,
  kind: z.literal("action"),
  action: BrowserActionSchema,
});

export const ApprovalQueueItemSchema = z.object({
  ...QueueItemFields,
  kind: z.literal("approval"),
  approval: ApprovalRequestSchema,
});

export const QueueItemSchema = z.discriminatedUnion("kind", [
  ActionQueueItemSchema,
  ApprovalQueueItemSchema,
]);

export type ActionQueueItem = z.infer<typeof ActionQueueItemSchema>;
export type ApprovalQueueItem = z.infer<typeof ApprovalQueueItemSchema>;
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const ActionResultSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "error", "denied"]),
  result: z.unknown().optional(), // capped by executor (maxChars etc.)
  error: z.string().max(500).optional(),
});

export type ActionResult = z.infer<typeof ActionResultSchema>;
