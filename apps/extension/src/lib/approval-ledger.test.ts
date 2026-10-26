// Approval-ledger tests: storage.session records + deadline alarms through
// fakeBrowser, the 30 s alarm floor, and the paused flag.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  ALARM_MIN_DELAY_MS,
  alarmNameFor,
  alarmTimeFor,
  cardIdFromAlarm,
  createSessionLedger,
  sessionPauseStore,
  type PendingApprovalRecord,
} from "./approval-ledger";

const record = (over: Partial<PendingApprovalRecord> = {}): PendingApprovalRecord => ({
  id: "local-1",
  approval: { reasonCodes: ["routine_supervised"], reasons: ["r"], pageUrl: "https://a.example/" },
  createdAt: 1_000,
  deadline: 121_000,
  origin: { kind: "wire", approvalId: "ap-1" },
  ...over,
});

beforeEach(() => fakeBrowser.reset());

describe("approval ledger", () => {
  it("save persists the record in storage.session and arms a one-shot alarm at the deadline", async () => {
    const ledger = createSessionLedger();
    await ledger.save(record(), 1_000);
    expect(await ledger.list()).toEqual([record()]);
    const alarm = await fakeBrowser.alarms.get(alarmNameFor("local-1"));
    expect(alarm).toMatchObject({ scheduledTime: 121_000 });
    expect(alarm?.periodInMinutes).toBeUndefined();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({}); // session, not local
  });

  it("a deadline inside the 30 s alarm floor is armed at the floor", () => {
    expect(alarmTimeFor(5_000, 0)).toBe(ALARM_MIN_DELAY_MS);
    expect(alarmTimeFor(120_000, 0)).toBe(120_000);
  });

  it("drop removes record and alarm; operations apply in call order", async () => {
    const ledger = createSessionLedger();
    void ledger.save(record(), 1_000);
    await ledger.drop("local-1"); // resolved while its save was in flight
    expect(await ledger.list()).toEqual([]);
    expect(await fakeBrowser.alarms.getAll()).toEqual([]);
  });

  it("lists only card records, one key per card", async () => {
    const ledger = createSessionLedger();
    await ledger.save(record(), 0);
    await ledger.save(record({ id: "local-2" }), 0);
    await fakeBrowser.storage.session.set({ junior_unrelated: 1 });
    expect((await ledger.list()).map((r) => r.id).sort()).toEqual(["local-1", "local-2"]);
  });

  it("alarm names round-trip; foreign alarms are not cards", () => {
    expect(cardIdFromAlarm(alarmNameFor("local-9"))).toBe("local-9");
    expect(cardIdFromAlarm("something-else")).toBeNull();
  });

  it("the paused flag round-trips and clears", async () => {
    expect(await sessionPauseStore.load()).toBe(false);
    await sessionPauseStore.save(true);
    expect(await sessionPauseStore.load()).toBe(true);
    await sessionPauseStore.save(false);
    expect(await sessionPauseStore.load()).toBe(false);
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });
});
