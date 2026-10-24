// Panel-approval-broker tests: card fan-out, decision routing, timeout default-deny,
// no-panel immediate deny (§4.3 / §6.3-3 semantics, SW side).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@junior/protocol";
import { PanelApprovalBroker } from "./panel-approvals";

const APPROVAL: ApprovalRequest = {
  reasonCodes: ["routine_supervised"],
  reasons: ["Supervised mode asks before every action"],
  pageUrl: "https://example.com/",
  siteDomain: "example.com",
};

function fakeRouter(connected: boolean) {
  const broadcast = vi.fn();
  return { broadcast, hasListener: () => connected };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PanelApprovalBroker", () => {
  it("no panel connected → immediate deny, no card broadcast", async () => {
    const router = fakeRouter(false);
    const broker = new PanelApprovalBroker(router);
    await expect(broker.request(APPROVAL, 120_000)).resolves.toBe("deny");
    expect(router.broadcast).not.toHaveBeenCalled();
  });

  it("delivers the card and resolves with the panel's answer", async () => {
    const router = fakeRouter(true);
    const broker = new PanelApprovalBroker(router);
    const pending = broker.request(APPROVAL, 120_000);
    const card = router.broadcast.mock.calls[0]![0] as {
      type: string;
      id: string;
      approval: ApprovalRequest;
      remainingMs: number;
    };
    expect(card.type).toBe("approval_request");
    expect(card.id).toBeTruthy();
    expect(card.approval).toEqual(APPROVAL);
    expect(card.remainingMs).toBe(120_000);

    broker.handleResponse({ type: "approval_response", id: card.id, decision: "site" });
    await expect(pending).resolves.toBe("site");
    // resolution broadcast carried the same id
    const resolved = router.broadcast.mock.calls
      .map((c) => c[0])
      .find((m) => (m as { type: string }).type === "approval_resolved") as { id: string };
    expect(resolved.id).toBe(card.id);
  });

  it("times out to deny and removes the card", async () => {
    vi.useFakeTimers();
    const router = fakeRouter(true);
    const broker = new PanelApprovalBroker(router);
    const pending = broker.request(APPROVAL, 5_000);
    const assertion = expect(pending).resolves.toBe("deny");
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(broker.pendingCount).toBe(0);
  });

  it("ignores answers for unknown or already-resolved ids", async () => {
    const router = fakeRouter(true);
    const broker = new PanelApprovalBroker(router);
    broker.handleResponse({ type: "approval_response", id: "nope", decision: "once" });
    const pending = broker.request(APPROVAL, 10_000);
    broker.handleResponse({ type: "approval_response", id: "nope", decision: "once" });
    broker.denyAll();
    await expect(pending).resolves.toBe("deny");
    broker.handleResponse({ type: "approval_response", id: "nope", decision: "once" });
  });
});
