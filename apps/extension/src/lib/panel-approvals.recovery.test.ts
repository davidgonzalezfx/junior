// Broker suspension recovery (review.md §3.3): a fresh broker over the ledger a
// dead one left behind — expired cards denied, mirror cards interrupted, live
// cards adopted with their original deadline, alarms, and the sync set.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { ApprovalRequest } from "@junior/protocol";
import { alarmNameFor, createSessionLedger, type ApprovalLedger } from "./approval-ledger";
import { PanelApprovalBroker, type BrokerPersistence } from "./panel-approvals";

const APPROVAL: ApprovalRequest = {
  reasonCodes: ["routine_supervised"],
  reasons: ["Supervised mode asks before every action"],
  pageUrl: "https://example.com/",
};

function setup(ledger: ApprovalLedger = createSessionLedger()) {
  const clock = { t: 1_000_000 };
  const router = { broadcast: vi.fn(), hasListener: () => true };
  const settleOrphan = vi.fn<BrokerPersistence["settleOrphan"]>(async () => {});
  const boot = () => new PanelApprovalBroker(router, () => clock.t, { ledger, settleOrphan });
  return { clock, router, settleOrphan, boot, ledger };
}

const sent = (router: { broadcast: ReturnType<typeof vi.fn> }, type: string) =>
  router.broadcast.mock.calls.map((c) => c[0]).filter((m) => m.type === type);

beforeEach(() => fakeBrowser.reset());

describe("PanelApprovalBroker — suspension recovery", () => {
  it("persists a card with an origin and drops it once answered", async () => {
    const s = setup();
    const broker = s.boot();
    const pending = broker.request(APPROVAL, 120_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    const [rec] = await s.ledger.list();
    expect(rec).toMatchObject({ deadline: s.clock.t + 120_000, origin: { approvalId: "ap-1" } });
    broker.handleResponse({ type: "approval_response", id: rec!.id, decision: "once" });
    await expect(pending).resolves.toBe("once");
    await vi.waitFor(async () => expect(await s.ledger.list()).toEqual([]));
    expect(await fakeBrowser.alarms.getAll()).toEqual([]);
    expect(s.settleOrphan).not.toHaveBeenCalled(); // a live caller got the answer
  });

  it("cards without an origin stay in-memory only", async () => {
    const s = setup();
    void s.boot().request(APPROVAL, 120_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(await s.ledger.list()).toEqual([]);
  });

  it("adopts a live card with its ORIGINAL deadline; a later Deny settles to the bridge", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 120_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    dead.abandon(); // suspended
    s.clock.t += 50_000;

    const fresh = s.boot();
    const recovering = fresh.recover();
    const [rec] = await s.ledger.list();
    fresh.handleResponse({ type: "approval_response", id: rec!.id, decision: "deny" }); // early
    await recovering;
    await vi.waitFor(() => expect(s.settleOrphan).toHaveBeenCalledTimes(1));
    expect(s.settleOrphan).toHaveBeenCalledWith(rec, "deny", "decision");
    expect(fresh.pendingCount).toBe(0);
  });

  it("the sync set lists adopted cards with their remaining window", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 120_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    dead.abandon();
    s.clock.t += 20_000;
    const fresh = s.boot();
    await fresh.recover();
    const sync = fresh.syncMessage();
    expect(sync.cards).toHaveLength(1);
    expect(sync.cards[0]!.remainingMs).toBe(100_000);
    expect(sync.cards[0]!.approval).toEqual(APPROVAL);
  });

  it("an expired card is denied at wake with by: timeout", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 120_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    dead.abandon();
    s.clock.t += 121_000;
    const fresh = s.boot();
    await fresh.recover();
    expect(s.settleOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: "wire", approvalId: "ap-1" } }),
      "deny",
      "timeout",
    );
    expect(fresh.pendingCount).toBe(0);
    expect(await s.ledger.list()).toEqual([]);
  });

  it("a mirror card is denied at wake as interrupted, even inside its window", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 120_000, { kind: "mirror", actionId: "act-7" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    dead.abandon();
    const fresh = s.boot();
    await fresh.recover();
    expect(s.settleOrphan).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: "mirror", actionId: "act-7" } }),
      "deny",
      "interrupted",
    );
    expect(fresh.syncMessage().cards).toEqual([]);
  });

  it("the deadline alarm denies an adopted card once the window has lapsed", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 120_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    const [rec] = await s.ledger.list();
    dead.abandon();
    const fresh = s.boot();
    await fresh.recover();

    await fresh.handleAlarm(alarmNameFor(rec!.id)); // early fire: re-armed, not denied
    expect(fresh.pendingCount).toBe(1);
    s.clock.t += 120_000;
    await fresh.handleAlarm(alarmNameFor(rec!.id));
    expect(fresh.pendingCount).toBe(0);
    expect(s.settleOrphan).toHaveBeenCalledWith(rec, "deny", "timeout");
    expect(sent(s.router, "approval_resolved")).toContainEqual({
      type: "approval_resolved",
      id: rec!.id,
      by: "timeout",
    });
  });

  it("stale and foreign alarms are harmless", async () => {
    const s = setup();
    const broker = s.boot();
    await broker.recover();
    await expect(broker.handleAlarm(alarmNameFor("gone"))).resolves.toBeUndefined();
    await expect(broker.handleAlarm("other-alarm")).resolves.toBeUndefined();
    expect(s.settleOrphan).not.toHaveBeenCalled();
  });

  it("a settleOrphan failure never rejects recovery", async () => {
    const s = setup();
    const dead = s.boot();
    void dead.request(APPROVAL, 1_000, { kind: "wire", approvalId: "ap-1" });
    await vi.waitFor(async () => expect(await s.ledger.list()).toHaveLength(1));
    dead.abandon();
    s.clock.t += 5_000;
    s.settleOrphan.mockRejectedValueOnce(new Error("bridge down"));
    await expect(s.boot().recover()).resolves.toBeUndefined();
  });
});
