// tests/e2e/panel-close.test.ts — M5-9 regression for the real-Chrome repro:
// closing the side panel while an approval card was pending lost the card AND
// its 120 s default-deny timer (an idle MV3 SW is suspended; the broker's
// setTimeout dies with it), so the task hung with the item parked. Contract
// (docs/qa.md "Panel-closed default-deny" + §4.3): once the panel is gone nobody
// can ever answer, so the last panel-port disconnect must resolve the pending
// card as DENY within the contract window, unwind the task, and execute nothing.
// Runs the REAL chain: bridge Dispatcher/guard → queue → long-poll → real
// AgentLoop → real PanelApprovalBroker → real PortRouter → stub panel port.
import { describe, expect, it, vi } from "vitest";
import { startHarness, type FakePage } from "./harness";

const START_URL = "https://start.junior.test/index.html";
const OTHER_URL = "https://other.junior.test/index.html";

const startPage: FakePage = { title: "Start", html: "<h1>You are here</h1>" };
const otherPage: FakePage = {
  title: "Other",
  html: '<h1>Other page</h1><p id="marker">untouched</p>',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("panel closes while an approval card is pending (M5-9)", () => {
  it(
    "last panel-port disconnect denies the card within the contract window, zero executions",
    { timeout: 15_000 },
    async () => {
      const h = await startHarness({
        tabUrl: START_URL,
        pages: { [START_URL]: startPage, [OTHER_URL]: otherPage },
        mode: "ask",
        panel: "real",
      });
      try {
        await h.waitConnected();
        const panel = h.connectPanel();

        const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });

        // The card is actually DELIVERED over the real chain (bridge guard →
        // approval queue item → long-poll → AgentLoop → broker → port broadcast).
        await vi.waitFor(() => {
          expect(h.wireCards).toHaveLength(1);
          expect(
            panel.messages.some((m) => (m as { type?: string }).type === "approval_request"),
          ).toBe(true);
        });
        expect(h.tab.url).toBe(START_URL); // nothing executed while awaiting

        // The user closes the side panel — the port dies mid-card.
        panel.disconnect();

        // Denied well inside the 120 s contract window. Pre-M5-9 this only
        // resolved when the broker's timer fired ~120 s later — a timer an MV3
        // suspension silently drops, which is the hang this test pins.
        const raced = await Promise.race([
          pending.then((r) => ({ settled: true as const, r })),
          sleep(5_000).then(() => ({ settled: false as const })),
        ]);
        if (!raced.settled) {
          throw new Error(
            "panel-close denial did not resolve within 5 s — the card is parked (the M5-9 hang)",
          );
        }
        expect(raced.r).toMatchObject({ status: "denied" });
        expect(h.tab.url).toBe(START_URL); // zero executions
      } finally {
        await h.stop();
      }
    },
  );

  it("a reopened panel recovers: the next card is delivered and answered through the real port", async () => {
    const h = await startHarness({
      tabUrl: START_URL,
      pages: { [START_URL]: startPage, [OTHER_URL]: otherPage },
      mode: "ask",
      panel: "real",
    });
    try {
      await h.waitConnected();
      const first = h.connectPanel();
      first.disconnect(); // panel closed before anything was asked
      const reopened = h.connectPanel(); // user reopens the panel

      const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await vi.waitFor(() => {
        expect(
          reopened.messages.some((m) => (m as { type?: string }).type === "approval_request"),
        ).toBe(true);
      });
      const card = reopened.messages.find(
        (m) => (m as { type?: string }).type === "approval_request",
      ) as { id: string };
      reopened.respond(card.id, "once");

      await expect(pending).resolves.toMatchObject({ status: "ok" });
      expect(h.wireCards).toHaveLength(1);
      expect(h.tab.url).toBe(OTHER_URL);
    } finally {
      await h.stop();
    }
  });
});
