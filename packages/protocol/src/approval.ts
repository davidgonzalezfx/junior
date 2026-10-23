// @junior/protocol/approval.ts — approval requests + user decision (plan §3).
// Approval facts are computed from REAL page facts, never from model text
// (Autono rule, keep it — plan §6.3).
import { z } from "zod";

// Why a card would be raised (plan §4.4 matrix). Named so the pure guard tables
// (guard.ts) and the approval card share one vocabulary.
export const GuardReasonCodeSchema = z.enum([
  "new_site",
  "sensitive_site",
  "private_network",
  "form_submit",
  "sensitive_label",
  "secret_field",
  "incognito",
  "routine_supervised",
]);

export type GuardReasonCode = z.infer<typeof GuardReasonCodeSchema>;

export const ApprovalRequestSchema = z.object({
  reasonCodes: z.array(GuardReasonCodeSchema).max(8),
  reasons: z.array(z.string().max(200)).max(8), // human text for the card
  pageUrl: z.string().max(2048),
  destinationUrl: z.string().max(2048).optional(),
  element: z
    .object({
      // probed element facts (Autono background.js:4222)
      tag: z.string().max(30),
      type: z.string().max(30).optional(),
      text: z.string().max(300).optional(),
      href: z.string().max(2048).optional(),
      formAction: z.string().max(2048).optional(),
    })
    .optional(),
  typed: z.string().max(600).nullable().optional(), // redacted if secret field (never sent)
  siteDomain: z.string().max(300).optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  id: z.string(),
  decision: z.enum(["once", "site", "deny"]),
});

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
