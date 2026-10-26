// lib/approval-ledger.ts — what an MV3 suspension must not erase (review.md
// §3.3 + §4.1): every pending approval card and the loop's paused flag, kept in
// chrome.storage.session, plus one one-shot chrome.alarms alarm per card
// deadline. The SW's in-memory timers and Maps die ~30 s into an idle wait; the
// session area and the alarms survive it, so a woken SW re-derives its state
// from here (docs/decisions.md 2026-10-26 "T4"). Session — not local — because
// both facts are meaningless after a browser restart or extension reload: the
// bridge futures they answer are gone by then, and a fresh browser must not
// start paused. storage.session is TRUSTED_CONTEXTS by default (content scripts
// cannot read the card contents).
import { browser } from "wxt/browser";
import type { ApprovalRequest } from "@junior/protocol";

/** One storage.session key per card (no read-modify-write races between cards). */
export const PENDING_APPROVAL_PREFIX = "junior_pending_approval:";
export const PAUSED_KEY = "junior_paused";
export const APPROVAL_ALARM_PREFIX = "junior_approval:";

/** Packed extensions: an alarm never fires sooner than 30 s after it is set
 * (Chrome alarms docs; unpacked has no floor). A deadline closer than that is
 * armed at the floor and is already expired when it fires. */
export const ALARM_MIN_DELAY_MS = 30_000;

/** Where a card's answer must go once the SW that raised it is gone. */
export type ApprovalOrigin =
  /** A bridge approval queue item — answered with POST approval-response. */
  | { kind: "wire"; approvalId: string }
  /** A guard-mirror card raised mid-execution of this action item. */
  | { kind: "mirror"; actionId: string };

export interface PendingApprovalRecord {
  /** The card id the panel sees. */
  id: string;
  approval: ApprovalRequest;
  createdAt: number;
  /** Epoch ms at which the card default-denies. */
  deadline: number;
  origin: ApprovalOrigin;
}

export interface ApprovalLedger {
  /** Persist the card and (re)arm its deadline alarm. */
  save(record: PendingApprovalRecord, now: number): Promise<void>;
  /** Forget the card and clear its alarm. */
  drop(id: string): Promise<void>;
  list(): Promise<PendingApprovalRecord[]>;
}

export function alarmNameFor(cardId: string): string {
  return `${APPROVAL_ALARM_PREFIX}${cardId}`;
}

export function cardIdFromAlarm(name: string): string | null {
  return name.startsWith(APPROVAL_ALARM_PREFIX) ? name.slice(APPROVAL_ALARM_PREFIX.length) : null;
}

/** When the deadline alarm can actually fire. */
export function alarmTimeFor(deadline: number, now: number): number {
  return Math.max(deadline, now + ALARM_MIN_DELAY_MS);
}

/** The production ledger. Operations run strictly in call order (a card that
 * resolves while its save is still in flight must end up dropped), and every
 * failure is swallowed: persistence is the suspension backstop, never a reason
 * to fail a live card. */
export function createSessionLedger(): ApprovalLedger {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(op).catch(() => fallback);
    chain = next;
    return next;
  };
  return {
    save: (record, now) =>
      serial(async () => {
        await browser.storage.session.set({ [PENDING_APPROVAL_PREFIX + record.id]: record });
        await browser.alarms.create(alarmNameFor(record.id), {
          when: alarmTimeFor(record.deadline, now),
        });
      }, undefined),
    drop: (id) =>
      serial(async () => {
        await browser.storage.session.remove(PENDING_APPROVAL_PREFIX + id);
        await browser.alarms.clear(alarmNameFor(id));
      }, undefined),
    list: () =>
      serial(async () => {
        const all = await browser.storage.session.get(null);
        return Object.entries(all)
          .filter(([key]) => key.startsWith(PENDING_APPROVAL_PREFIX))
          .map(([, value]) => value as PendingApprovalRecord);
      }, [] as PendingApprovalRecord[]),
  };
}

export interface PauseStore {
  load(): Promise<boolean>;
  save(paused: boolean): Promise<void>;
}

export const sessionPauseStore: PauseStore = {
  async load() {
    try {
      return (await browser.storage.session.get(PAUSED_KEY))[PAUSED_KEY] === true;
    } catch {
      return false;
    }
  },
  async save(paused) {
    try {
      if (paused) await browser.storage.session.set({ [PAUSED_KEY]: true });
      else await browser.storage.session.remove(PAUSED_KEY);
    } catch {
      // Same best-effort posture as the ledger.
    }
  },
};
