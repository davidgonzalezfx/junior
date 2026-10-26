// lib/approval-cards.ts — the panel's pending-card set as a pure reducer over
// SW → panel port messages (use-approval-cards holds the React state; tests
// replay the same messages through the same function). Deadlines are DISPLAY:
// the SW broker's timer is authoritative and approval_resolved removes the card.
import type { ApprovalRequestMessage } from "./port-router";

export interface PendingCard {
  id: string;
  approval: ApprovalRequestMessage["approval"];
  /** Epoch ms at which the card expires (deny) — drives the countdown ring. */
  deadline: number;
  totalMs: number;
}

export type CardMap = ReadonlyMap<string, PendingCard>;

/** Apply one port message; returns `prev` itself when nothing changed. */
export function reduceCards(prev: CardMap, msg: unknown, now: number): CardMap {
  if (typeof msg !== "object" || msg === null) return prev;
  const m = msg as { type?: string; id?: string };
  if (m.type === "approval_request") {
    const req = msg as ApprovalRequestMessage;
    return new Map(prev).set(req.id, {
      id: req.id,
      approval: req.approval,
      deadline: now + req.remainingMs,
      totalMs: req.remainingMs,
    });
  }
  if (m.type === "approval_resolved" && typeof m.id === "string") return removeCard(prev, m.id);
  return prev;
}

export function removeCard(prev: CardMap, id: string): CardMap {
  if (!prev.has(id)) return prev;
  const next = new Map(prev);
  next.delete(id);
  return next;
}
