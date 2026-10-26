// tests/e2e/sw-suspension.test.ts — MV3 service-worker suspension (review.md
// §3.3 + §4.1). While a card is pending (no long-poll in flight) or the loop is
// paused (polling stopped), Chrome suspends the idle SW ~30 s in and every
// in-memory object dies: the broker's pending Map + 120 s timer, the loop's
// paused flag. The panel survives and reconnects to a FRESH SW.
// Suspension seam: the production stack (createAgentRuntime) is booted against
// the REAL bridge, then "killed" — its loop stopped and every outbound effect
// gated off (a dead SW executes nothing) — and a second one is booted over the
// same fakeBrowser storage + alarms. The panel model replays port messages
// through the panel's own reducer (lib/approval-cards.ts), so ghost cards show.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ActionResultSchema, type ActionResult } from "@junior/protocol";
import {
  fetchNextAction,
  postActionResult,
  postApprovalDecision,
  postCancel,
} from "@/lib/bridge-client";
import { createAgentRuntime, type AgentRuntime } from "@/lib/agent-runtime";
import { reduceCards, removeCard, type CardMap } from "@/lib/approval-cards";
import { PANEL_PORT_NAME, type PortLike } from "@/lib/port-router";
import type { OverlayCommand } from "@/lib/work-overlay-content";
import { startHarness, type FakePage, type Harness } from "./harness";

const START_URL = "https://start.junior.test/index.html";
const OTHER_URL = "https://other.junior.test/index.html";
const THIRD_URL = "https://third.junior.test/index.html";
const pages: Record<string, FakePage> = {
  [START_URL]: { title: "Start", html: "<h1>You are here</h1>" },
  [OTHER_URL]: { title: "Other", html: "<h1>Other</h1>" },
  [THIRD_URL]: { title: "Third", html: "<h1>Third</h1>" },
};

const EXT_ID = "junior-sw-suspension-ext";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const AGENT_TAB = 1;
const WINDOW_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mutable wall clock shared by every SW boot (time passes while the SW is dead). */
const clock = { offset: 0, now: () => Date.now() + clock.offset };

interface Sw {
  rt: AgentRuntime;
  overlaySent: OverlayCommand[];
  kill(): void;
}

/** Boot one SW lifetime — the background's wiring, chrome events included. */
function bootSw(h: Harness): Sw {
  let alive = true;
  // A dead SW never runs again: its pending awaits simply never resume.
  const gate = <T>(fn: () => Promise<T>): Promise<T> => (alive ? fn() : new Promise<T>(() => {}));
  const overlaySent: OverlayCommand[] = [];
  const rt = createAgentRuntime({
    extensionId: EXT_ID,
    extensionOrigin: EXT_ORIGIN,
    bridge: {
      poll: (t) => gate(() => fetchNextAction(h.bridgeUrl, h.token, t)),
      postResult: ({ id, ...outcome }) =>
        gate(() =>
          postActionResult(h.bridgeUrl, h.token, ActionResultSchema.parse({ id, ...outcome })),
        ),
      postDecision: (d) =>
        gate(async () => void (await postApprovalDecision(h.bridgeUrl, h.token, d))),
      postCancel: () => gate(() => postCancel(h.bridgeUrl, h.token)),
    },
    agentEnv: h.agentEnv,
    overlayEnv: {
      injectOverlay: async () => {},
      sendToTab: async (_tab, msg) => {
        if (alive) overlaySent.push(msg);
      },
    },
    permissionMode: async () => h.mode,
    now: clock.now,
  });
  const onAlarm = (alarm: { name: string }) => {
    if (alive) void rt.handleAlarm(alarm);
  };
  fakeBrowser.alarms.onAlarm.addListener(onAlarm);
  return {
    rt,
    overlaySent,
    kill() {
      alive = false;
      fakeBrowser.alarms.onAlarm.removeListener(onAlarm);
      rt.stop();
    },
  };
}

/** The side panel: its card state survives SW death; its port does not. */
function panel() {
  let cards: CardMap = new Map();
  let port: PortLike | null = null;
  let onMessage: ((msg: unknown, port: PortLike) => void)[] = [];
  const messages: unknown[] = [];
  return {
    get cardIds() {
      return [...cards.keys()];
    },
    messages,
    /** (Re)connect to whichever SW is alive now. */
    attach(sw: Sw) {
      onMessage = [];
      const p: PortLike = {
        name: PANEL_PORT_NAME,
        sender: { id: EXT_ID, url: `${EXT_ORIGIN}/sidepanel.html` },
        postMessage: (msg) => {
          messages.push(msg);
          cards = reduceCards(cards, msg, Date.now());
        },
        disconnect() {},
        onMessage: { addListener: (cb) => onMessage.push(cb), removeListener: () => {} },
        onDisconnect: { addListener: () => {} },
      };
      port = p;
      sw.rt.connect(p);
    },
    respond(id: string, decision: "once" | "site" | "deny") {
      cards = removeCard(cards, id);
      const p = port!;
      onMessage.forEach((cb) => cb({ type: "approval_response", id, decision }, p));
    },
  };
}

async function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([p, sleep(ms).then(() => "pending" as const)]);
}

async function boot(mode: "ask" | "auto") {
  const h = await startHarness({ tabUrl: START_URL, pages, mode, sw: "external" });
  return h;
}

beforeEach(() => {
  fakeBrowser.reset();
  clock.offset = 0;
});

describe("MV3 SW suspension (T4)", () => {
  it("(a) Deny clicked after a suspension reaches the bridge as a user deny", async () => {
    const h = await boot("ask");
    const sws: Sw[] = [];
    try {
      const sw1 = bootSw(h);
      sws.push(sw1);
      await h.waitConnected();
      const ui = panel();
      ui.attach(sw1);
      const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await vi.waitFor(() => expect(ui.cardIds).toHaveLength(1));
      const cardId = ui.cardIds[0]!;

      sw1.kill(); // idle SW suspended mid-card
      const sw2 = bootSw(h);
      sws.push(sw2);
      ui.attach(sw2); // panel port reconnects to the fresh SW
      ui.respond(cardId, "deny"); // clicked before the woken SW re-read its cards

      const r = await settledWithin(pending, 3_000);
      if (r === "pending") throw new Error("the user's Deny after suspension was dropped");
      expect((r as ActionResult).status).toBe("denied");
      expect((r as ActionResult).error).toMatch(/^USER_DENIED/);
      expect(h.tab.url).toBe(START_URL);
    } finally {
      sws.forEach((s) => s.kill());
      await h.stop();
    }
  });

  it("(b) an unanswered card is denied by its alarm after a suspension", async () => {
    const h = await boot("ask");
    const sws: Sw[] = [];
    try {
      const sw1 = bootSw(h);
      sws.push(sw1);
      await h.waitConnected();
      const ui = panel();
      ui.attach(sw1);
      const raisedAt = Date.now();
      const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await vi.waitFor(() => expect(ui.cardIds).toHaveLength(1));

      // A one-shot alarm sits at the card deadline (≥ the 30 s alarm minimum).
      const alarms = await fakeBrowser.alarms.getAll();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.scheduledTime).toBeGreaterThanOrEqual(raisedAt + WINDOW_MS - 2_000);

      sw1.kill();
      const sw2 = bootSw(h);
      sws.push(sw2);
      ui.attach(sw2);
      await sw2.rt.ready;
      expect(await settledWithin(pending, 300)).toBe("pending"); // still live: keeps its deadline

      clock.offset = WINDOW_MS + 5_000; // the window lapses while the SW is dead
      await fakeBrowser.alarms.onAlarm.trigger(alarms[0]!);

      const r = await settledWithin(pending, 3_000);
      if (r === "pending") throw new Error("the lapsed card was never denied after suspension");
      expect((r as ActionResult).status).toBe("denied");
      expect((r as ActionResult).error).toMatch(/^BLOCKED_BY_POLICY: approval not answered/);
      await vi.waitFor(() => expect(ui.cardIds).toEqual([])); // card closed panel-side
      expect(h.tab.url).toBe(START_URL);
    } finally {
      sws.forEach((s) => s.kill());
      await h.stop();
    }
  });

  it("(c) pause survives a suspension: nothing executes, the overlay stays paused", async () => {
    const h = await boot("auto");
    const sws: Sw[] = [];
    try {
      const sw1 = bootSw(h);
      sws.push(sw1);
      await h.waitConnected();
      // A task runs (overlay shows on the agent tab), then the user pauses it.
      await expect(h.dispatch({ kind: "navigate", url: OTHER_URL })).resolves.toMatchObject({
        status: "ok",
      });
      const pageSender = { tab: { id: AGENT_TAB }, frameId: 0 };
      sw1.rt.handleContentMessage({ type: "overlay_action", action: "pause" }, pageSender);
      expect(sw1.rt.loop.isPaused).toBe(true);
      // Drain sw1's in-flight long-poll (a paused loop answers it "paused").
      const drained = h.dispatch({ kind: "navigate", url: THIRD_URL }, 10_000);
      await sleep(300);

      sw1.kill(); // polling stopped ⇒ suspension is guaranteed
      const sw2 = bootSw(h);
      sws.push(sw2);
      await sw2.rt.ready;
      const later = h.dispatch({ kind: "navigate", url: THIRD_URL }, 10_000);
      // The page's overlay re-announces itself (navigation / fresh injection).
      sw2.rt.handleContentMessage({ type: "content_ready" }, pageSender);

      await sleep(1_500);
      expect(h.tab.url).toBe(OTHER_URL); // zero executions after the wake
      expect(sw2.rt.loop.isPaused).toBe(true);
      expect(sw2.rt.taskStatus.snapshot().state).toBe("paused");
      expect(sw2.overlaySent.some((m) => "paused" in m && m.paused === false)).toBe(false);
      expect(sw2.overlaySent).toContainEqual(expect.objectContaining({ paused: true }));

      // Resume through the fresh SW — the held work proceeds.
      sw2.rt.handleContentMessage({ type: "overlay_action", action: "resume" }, pageSender);
      await expect(later).resolves.toMatchObject({ status: "ok" });
      await drained;
      expect(h.tab.url).toBe(THIRD_URL);
    } finally {
      sws.forEach((s) => s.kill());
      await h.stop();
    }
  });

  it("(d) panel reconnect after a suspension shows exactly the live cards", async () => {
    const h = await boot("ask");
    const sws: Sw[] = [];
    try {
      const sw1 = bootSw(h);
      sws.push(sw1);
      await h.waitConnected();
      const ui = panel();
      ui.attach(sw1);
      const first = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await vi.waitFor(() => expect(ui.cardIds).toHaveLength(1));
      const ghost = ui.cardIds[0]!;

      sw1.kill();
      const second = h.dispatch({ kind: "navigate", url: THIRD_URL }); // queued, nobody polling
      clock.offset = WINDOW_MS + 5_000; // the first card lapsed while the SW was dead
      const sw2 = bootSw(h);
      sws.push(sw2);
      ui.attach(sw2);
      await sw2.rt.ready;
      clock.offset = 0; // (keep the second card's window real-time)

      await vi.waitFor(() => {
        expect(ui.cardIds).toHaveLength(1);
        expect(ui.cardIds).not.toContain(ghost);
      });
      await expect(first).resolves.toMatchObject({ status: "denied" });
      ui.respond(ui.cardIds[0]!, "deny");
      await expect(second).resolves.toMatchObject({ status: "denied" });
      expect(h.tab.url).toBe(START_URL);
    } finally {
      sws.forEach((s) => s.kill());
      await h.stop();
    }
  });
});
