// Panel card reducer: add/remove by id, and approval_sync replacing the set
// wholesale so a suspended SW's cards cannot linger as ghosts.
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@junior/protocol";
import { reduceCards, removeCard, type CardMap } from "./approval-cards";

const APPROVAL: ApprovalRequest = {
  reasonCodes: ["routine_supervised"],
  reasons: ["r"],
  pageUrl: "https://example.com/",
};
const req = (id: string, remainingMs = 120_000) => ({
  type: "approval_request",
  id,
  approval: APPROVAL,
  remainingMs,
});

describe("reduceCards", () => {
  it("adds on approval_request and removes on approval_resolved", () => {
    let cards: CardMap = new Map();
    cards = reduceCards(cards, req("a"), 1_000);
    expect(cards.get("a")).toMatchObject({ deadline: 121_000, totalMs: 120_000 });
    cards = reduceCards(cards, { type: "approval_resolved", id: "a", by: "decision" }, 2_000);
    expect(cards.size).toBe(0);
  });

  it("approval_sync replaces the set: ghosts go, live cards keep their ring total", () => {
    let cards: CardMap = new Map();
    cards = reduceCards(cards, req("ghost"), 0);
    cards = reduceCards(cards, req("live"), 0);
    cards = reduceCards(
      cards,
      { type: "approval_sync", cards: [{ id: "live", approval: APPROVAL, remainingMs: 30_000 }] },
      90_000,
    );
    expect([...cards.keys()]).toEqual(["live"]);
    expect(cards.get("live")).toMatchObject({ deadline: 120_000, totalMs: 120_000 });
  });

  it("an empty sync clears everything; unrelated messages are identity", () => {
    const cards = reduceCards(new Map(), req("a"), 0);
    expect(reduceCards(cards, { type: "task_status", state: "idle" }, 0)).toBe(cards);
    expect(reduceCards(cards, null, 0)).toBe(cards);
    expect(reduceCards(cards, { type: "approval_sync", cards: [] }, 0).size).toBe(0);
    expect(removeCard(cards, "nope")).toBe(cards);
  });
});
