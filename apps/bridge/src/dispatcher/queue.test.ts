// M1-2 dispatcher unit tests — AsyncQueue long-poll mechanics and every Dispatcher
// path (§4.3): dispatch/resolve, guard deny, approvals-on-queue (once/deny/timeout/
// no-panel), action timeout, dispose. Wire-level round-trips with a fake executor
// client live in routes.test.ts.
import { describe, expect, it, vi } from "vitest";
import { ApprovalRequestSchema, type ApprovalDecision, type BrowserAction } from "@junior/protocol";
import { approvalDenial } from "./approvals.js";
import { AsyncQueue, Dispatcher, type ActionGuard, type GuardVerdict } from "./queue.js";

const nav: BrowserAction = { kind: "navigate", url: "https://example.com" };
const tab: BrowserAction = { kind: "get_active_tab" };
const approvalRequest = ApprovalRequestSchema.parse({
  reasonCodes: ["new_site"],
  reasons: ["first visit to example.com"],
  pageUrl: "https://example.com",
});

/** A dispatcher whose "extension" has just pinged (so connected() is true). */
function connectedDispatcher(opts?: ConstructorParameters<typeof Dispatcher>[0]) {
  const d = new Dispatcher(opts);
  d.ping();
  return d;
}

describe("AsyncQueue", () => {
  it("hands buffered items to get() immediately, FIFO", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    await expect(q.get(10)).resolves.toBe(1);
    await expect(q.get(10)).resolves.toBe(2);
  });

  it("long-polls: a pending get() is woken by the next push", async () => {
    const q = new AsyncQueue<number>();
    const pending = q.get(5_000);
    q.push(7);
    await expect(pending).resolves.toBe(7);
  });

  it("resolves null when the long-poll lapses", async () => {
    const q = new AsyncQueue<number>();
    await expect(q.get(20)).resolves.toBeNull();
  });

  it("remove() drops buffered items only", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.remove((n) => n === 1);
    await expect(q.get(10)).resolves.toBe(2);
    expect(q.size).toBe(0);
  });
});

describe("Dispatcher — action round trip (no guard)", () => {
  it("queues the action, and resolveResult completes the dispatch", async () => {
    const d = new Dispatcher();
    const pending = d.dispatch(nav);

    const item = await d.nextAction(1_000);
    expect(item).toMatchObject({ kind: "action", action: nav });
    if (item?.kind !== "action") throw new Error("expected an action item");
    expect(d.resolveResult({ id: item.id, status: "ok", result: { title: "Example" } })).toBe(true);

    await expect(pending).resolves.toMatchObject({
      status: "ok",
      result: { title: "Example" },
    });
  });

  it("reports delivered:false for an unknown or already-resolved id", () => {
    const d = new Dispatcher();
    expect(d.resolveResult({ id: "no-such-id", status: "ok" })).toBe(false);
  });

  it("error result from the executor surfaces verbatim", async () => {
    const d = connectedDispatcher();
    const pending = d.dispatch(tab);
    const item = await d.nextAction(1_000);
    if (item?.kind !== "action") throw new Error("expected an action item");
    d.resolveResult({ id: item.id, status: "error", error: "no active tab" });
    await expect(pending).resolves.toMatchObject({ status: "error", error: "no active tab" });
  });
});

describe("Dispatcher — action timeout (§4.3)", () => {
  it("errors with the timeout message while the extension is connected", async () => {
    const d = connectedDispatcher();
    const res = await d.dispatch(nav, 30);
    expect(res.status).toBe("error");
    expect(res.error).toBe("Timed out after 30 ms");
  });

  it("names the not-connected cause when no poller ever showed up", async () => {
    const d = new Dispatcher(); // never pinged → connected() false
    const res = await d.dispatch(nav, 30);
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/not connected/);
  });

  it("drops a timed-out item so a late poller never sees it", async () => {
    const d = new Dispatcher();
    await d.dispatch(nav, 20);
    await expect(d.nextAction(50)).resolves.toBeNull();
  });
});

describe("Dispatcher — guard deny", () => {
  it("denies without queueing anything", async () => {
    const guard: ActionGuard = { check: () => ({ kind: "deny", reason: "BLOCKED_BY_POLICY: x" }) };
    const d = new Dispatcher({ guard });
    const res = await d.dispatch(nav);
    expect(res.status).toBe("denied");
    expect(res.error).toBe("BLOCKED_BY_POLICY: x");
    expect(d.queueDepth).toBe(0);
  });
});

describe("Dispatcher — approvals on the queue (§4.3)", () => {
  function approvingGuard(): ActionGuard & {
    decisions: { action: BrowserAction; decision: ApprovalDecision }[];
  } {
    return {
      check: () => ({ kind: "approval", approval: approvalRequest }),
      decisions: [],
      onApprovalDecision(action, decision) {
        this.decisions.push({ action, decision });
      },
    };
  }

  it("approval once → decision recorded → the action item follows", async () => {
    const guard = approvingGuard();
    const d = connectedDispatcher({ guard });
    const pending = d.dispatch(nav);

    const card = await d.nextAction(1_000);
    if (card?.kind !== "approval") throw new Error("expected an approval item");
    expect(card.approval).toEqual(approvalRequest);
    expect(d.resolveApproval({ id: card.id, decision: "once" })).toBe(true);

    const item = await d.nextAction(1_000);
    if (item?.kind !== "action") throw new Error("expected the action item after approval");
    d.resolveResult({ id: item.id, status: "ok" });
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(guard.decisions).toEqual([{ action: nav, decision: { id: card.id, decision: "once" } }]);
  });

  it("deny decision → USER_DENIED and no action item", async () => {
    const guard = approvingGuard();
    const d = connectedDispatcher({ guard });
    const pending = d.dispatch(nav);

    const card = await d.nextAction(1_000);
    if (card?.kind !== "approval") throw new Error("expected an approval item");
    d.resolveApproval({ id: card.id, decision: "deny" });

    const res = await pending;
    expect(res.status).toBe("denied");
    expect(res.error).toBe(approvalDenial("user"));
    await expect(d.nextAction(20)).resolves.toBeNull(); // nothing queued behind the card
  });

  it("unanswered card → default-deny after the approval window", async () => {
    const guard = approvingGuard();
    const d = connectedDispatcher({ guard, approvalTimeoutMs: 30 });
    const res = await d.dispatch(nav);
    expect(res.status).toBe("denied");
    expect(res.error).toBe(approvalDenial("timeout"));
  });

  it("no panel connected → immediate deny, no card queued", async () => {
    const guard = approvingGuard();
    const d = new Dispatcher({ guard }); // never pinged
    const res = await d.dispatch(nav);
    expect(res.status).toBe("denied");
    expect(res.error).toBe(approvalDenial("no-panel"));
    expect(d.queueDepth).toBe(0);
  });

  it("unknown approval ids report delivered:false", () => {
    const d = new Dispatcher();
    expect(d.resolveApproval({ id: "nope", decision: "once" })).toBe(false);
  });
});

describe("Dispatcher — liveness + dispose", () => {
  it("connected() tracks the 25 s freshness window via the injectable clock", () => {
    let t = 1_000_000;
    const d = new Dispatcher({ now: () => t });
    expect(d.connected()).toBe(false);
    d.ping(); // at t
    expect(d.connected()).toBe(true);
    t += 25_000; // exactly 25 s stale → no longer connected
    expect(d.connected()).toBe(false);
  });

  it("dispose() denies in-flight dispatches and empties the queue (M4-5 seam)", async () => {
    const d = new Dispatcher();
    const pending = d.dispatch(nav);
    d.dispose("bridge shutting down");
    await expect(pending).resolves.toMatchObject({
      status: "denied",
      error: "bridge shutting down",
    });
    expect(d.queueDepth).toBe(0);
    await expect(d.nextAction(10)).resolves.toBeNull();
  });

  it("queueDepth counts buffered items only", async () => {
    const d = new Dispatcher();
    const a = d.dispatch(nav);
    const b = d.dispatch(tab);
    expect(d.queueDepth).toBe(2);
    const first = await d.nextAction(1_000);
    expect(d.queueDepth).toBe(1);
    const second = await d.nextAction(1_000);
    expect(d.queueDepth).toBe(0);
    if (first?.kind !== "action" || second?.kind !== "action") {
      throw new Error("expected action items");
    }
    d.resolveResult({ id: first.id, status: "ok" });
    d.resolveResult({ id: second.id, status: "ok" });
    await Promise.all([a, b]);
  });
});

describe("Dispatcher — guard seam", () => {
  it("async guard verdicts are awaited; the guard sees every dispatch", async () => {
    const check = vi.fn(async (): Promise<GuardVerdict> => ({ kind: "allow" }));
    const d = connectedDispatcher({ guard: { check } });
    const pending = d.dispatch(nav);
    const item = await d.nextAction(1_000);
    if (item?.kind !== "action") throw new Error("expected an action item");
    d.resolveResult({ id: item.id, status: "ok" });
    await pending;
    expect(check).toHaveBeenCalledWith(nav);
  });
});
