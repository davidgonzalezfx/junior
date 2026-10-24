// M4-5 acceptance (d) — kill mid-task over the REAL stack: the bridge's cancel
// route denies every in-flight future, and the agent loop + bridge recover so
// the next task still runs. The overlay-side legs (✕ button, SW-crash recovery,
// bridge-loss hide) are unit-covered in work-overlay*/agent-loop/panel-approvals
// tests; this file proves the wire semantics end to end, no LLM anywhere.
import { describe, expect, it } from "vitest";
import { startHarness, type FakePage } from "./harness";

const START_URL = "https://start.junior.test/index.html";
const OTHER_URL = "https://other.junior.test/index.html";

const startPage: FakePage = { title: "Start", html: "<h1>You are here</h1>" };
const otherPage: FakePage = {
  title: "Other",
  html: '<h1>Other page</h1><p id="marker">untouched</p>',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function cancelOverWire(bridgeUrl: string, token: string): Promise<Record<string, number>> {
  const res = await fetch(`${bridgeUrl}/api/agent/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
}

describe("POST /api/agent/cancel (M4-5 accept d)", () => {
  it("denies an in-flight dispatch as 'cancelled by user'; the next task still runs", async () => {
    const h = await startHarness({
      tabUrl: START_URL,
      pages: { [START_URL]: startPage, [OTHER_URL]: otherPage },
    });
    try {
      await h.waitConnected();

      // Park the loop. A pause landing mid-poll denies the fetched item
      // ("denied: paused", §5.2 item 6) then parks; landing between polls parks
      // with nothing in flight. Flush whichever case happened with a warmup
      // dispatch, then pin an item in the bridge queue — parked means no poller.
      h.loop.setPaused(true);
      const warmup = h.dispatch({ kind: "get_active_tab" });
      const warm = await Promise.race([warmup, sleep(200).then(() => null)]);
      const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await sleep(50); // guard verdict + queue.push settle (microtask-only chain)

      // The overlay ✕'s wire call, over REAL HTTP with the REAL token.
      const body = await cancelOverWire(h.bridgeUrl, h.token);
      expect(body).toMatchObject({ ok: true });
      expect((body.actions ?? 0) + (body.approvals ?? 0)).toBeGreaterThanOrEqual(1);

      // The future resolves DENIED — the engine sees cancellation, not a 120 s
      // timeout — and the navigate never executed.
      await expect(pending).resolves.toMatchObject({
        status: "denied",
        error: "cancelled by user",
      });
      await expect(warmup).resolves.toMatchObject({ status: "denied" });
      void warm;
      expect(h.tab.url).toBe(START_URL);

      // Recovery: resume the loop and run the next task normally.
      h.loop.setPaused(false);
      const after = await h.dispatch({ kind: "get_active_tab" });
      expect(after.status).toBe("ok");
    } finally {
      await h.stop();
    }
  });

  it("a buffered approval card is default-denied by the cancel too", async () => {
    const h = await startHarness({
      tabUrl: START_URL,
      pages: { [START_URL]: startPage, [OTHER_URL]: otherPage },
      mode: "ask",
    });
    try {
      await h.waitConnected();
      h.loop.setPaused(true);
      const warmup = h.dispatch({ kind: "get_active_tab" });
      await Promise.race([warmup, sleep(200).then(() => null)]);
      const pending = h.dispatch({ kind: "navigate", url: OTHER_URL });
      await sleep(50);

      const body = await cancelOverWire(h.bridgeUrl, h.token);
      expect(body).toMatchObject({ ok: true });
      // Whatever was still pending — the parked item or the held approval card —
      // the cancel denied it, and the dispatch never executes.
      expect((body.approvals ?? 0) + (body.actions ?? 0)).toBeGreaterThanOrEqual(1);
      await expect(pending).resolves.toMatchObject({ status: "denied" });
      await expect(warmup).resolves.toMatchObject({ status: "denied" });
      expect(h.tab.url).toBe(START_URL);
    } finally {
      await h.stop();
    }
  });
});
