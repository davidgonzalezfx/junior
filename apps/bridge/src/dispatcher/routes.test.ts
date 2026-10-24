// M1-2 acceptance — /api/agent/* over the real Hono app (plan §8 M1: "queue round-trip
// test"). A FakeExecutor plays the extension service worker: it long-polls
// next-action and posts action-result / approval-response, exactly per §10.2's agent
// client loop, no LLM involved.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  QueueItemSchema,
  type ApprovalDecision,
  type BrowserAction,
  type QueueItem,
} from "@junior/protocol";
import { createApp } from "../index.js";
import { writeToken } from "../config.js";
import { Dispatcher, type ActionGuard } from "./queue.js";
import { pollSeconds } from "./routes.js";

const TOKEN = "a".repeat(64);
let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function newApp(dispatcher = new Dispatcher()) {
  const dir = mkdtempSync(join(tmpdir(), "junior-agent-test-"));
  dirs.push(dir);
  writeToken(TOKEN, dir);
  // The SAME instance goes into the app and comes back out — createApp would
  // otherwise quietly build its own, and the test would dispatch into a void.
  return { dir, dispatcher, app: createApp({ dir, log: vi.fn(), dispatcher }) };
}

const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** The §10.2 agent client: long-poll → execute / show card → post the outcome. */
class FakeExecutor {
  private stopped = false;
  executed: BrowserAction[] = [];

  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly decision: ApprovalDecision["decision"] = "once",
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const res = await this.app.request("/api/agent/next-action?timeout=1", {
        headers: AUTH,
      });
      const body = (await res.json()) as QueueItem | { item: null };
      if ("item" in body) continue; // idle poll — loop and long-poll again
      const item = QueueItemSchema.parse(body); // the wire shape must be the frozen one
      if (item.kind === "action") {
        this.executed.push(item.action);
        await this.app.request("/api/agent/action-result", {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ id: item.id, status: "ok", result: { executed: item.action } }),
        });
      } else {
        await this.app.request("/api/agent/approval-response", {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ id: item.id, decision: this.decision }),
        });
      }
    }
  }
}

describe("GET /api/agent/next-action", () => {
  it("answers {item: null} on an idle queue (long-poll expiry)", async () => {
    const { app } = newApp();
    const res = await app.request("/api/agent/next-action?timeout=1", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ item: null });
  });

  it("requires the token like every other data route", async () => {
    const { app } = newApp();
    expect((await app.request("/api/agent/next-action?timeout=1")).status).toBe(401);
  });

  it("delivers queued items as frozen QueueItem JSON", async () => {
    const { app, dispatcher } = newApp();
    void dispatcher.dispatch({ kind: "scroll", direction: "down", amount: 300 });
    const res = await app.request("/api/agent/next-action?timeout=1", { headers: AUTH });
    const body = QueueItemSchema.parse(await res.json());
    expect(body).toMatchObject({ kind: "action", action: { kind: "scroll", amount: 300 } });
  });
});

describe("POST /api/agent/action-result + /api/agent/approval-response", () => {
  it("400s on bodies that are not the frozen schemas", async () => {
    const { app } = newApp();
    for (const path of ["/api/agent/action-result", "/api/agent/approval-response"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ nonsense: true }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("reports delivered:false for results that match no in-flight dispatch", async () => {
    const { app } = newApp();
    const res = await app.request("/api/agent/action-result", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ id: "stale-or-unknown", status: "ok" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: false });
  });
});

describe("queue round trip with a fake executor (plan §8 M1)", () => {
  const nav: BrowserAction = { kind: "navigate", url: "https://example.com" };
  const approvalRequest = ApprovalRequestSchema.parse({
    reasonCodes: ["new_site"],
    reasons: ["first visit to example.com"],
    pageUrl: "https://example.com",
  });
  const approvingGuard: ActionGuard = {
    check: () => ({ kind: "approval", approval: approvalRequest }),
  };

  it("executor polls the action and its result completes the dispatch", async () => {
    const { app, dispatcher } = newApp();
    const executor = new FakeExecutor(app);
    executor.start();
    const result = await dispatcher.dispatch(nav);
    executor.stop();
    expect(result).toMatchObject({
      status: "ok",
      result: { executed: { kind: "navigate", url: "https://example.com" } },
    });
    expect(executor.executed).toHaveLength(1);
  });

  it("approving the card once lets the action through the same channel", async () => {
    const { app, dispatcher } = newApp(new Dispatcher({ guard: approvingGuard }));
    const executor = new FakeExecutor(app, "once");
    executor.start();
    const result = await dispatcher.dispatch(nav);
    executor.stop();
    expect(result.status).toBe("ok");
    expect(executor.executed).toEqual([nav]); // card first, then the action executed
  });

  it("denying the card never executes the action", async () => {
    const { app, dispatcher } = newApp(new Dispatcher({ guard: approvingGuard }));
    const executor = new FakeExecutor(app, "deny");
    executor.start();
    const result = await dispatcher.dispatch(nav);
    executor.stop();
    expect(result.status).toBe("denied");
    expect(result.error).toMatch(/^USER_DENIED/);
    expect(executor.executed).toHaveLength(0);
  });
});

describe("pollSeconds (?timeout clamping, §4.3 ≤ 20 s)", () => {
  it("defaults to 15, clamps to [1, 20], ignores garbage", () => {
    expect(pollSeconds(undefined)).toBe(15);
    expect(pollSeconds("")).toBe(15);
    expect(pollSeconds("abc")).toBe(15);
    expect(pollSeconds("1")).toBe(1);
    expect(pollSeconds("15")).toBe(15);
    expect(pollSeconds("999")).toBe(20);
    expect(pollSeconds("0")).toBe(1);
    expect(pollSeconds("-5")).toBe(1);
  });
});

describe("POST /api/agent/cancel (M4-5 kill path — plan §8 accept d)", () => {
  const approvalRequest = ApprovalRequestSchema.parse({
    reasonCodes: ["new_site"],
    reasons: ["first visit to example.com"],
    pageUrl: "https://example.com",
  });
  const approvingGuard: ActionGuard = {
    check: () => ({ kind: "approval", approval: approvalRequest }),
  };

  it("requires the token like every other data route", async () => {
    const { app } = newApp();
    expect((await app.request("/api/agent/cancel", { method: "POST" })).status).toBe(401);
  });

  it("resolves an in-flight dispatch as denied and reports what it killed", async () => {
    const { app, dispatcher } = newApp();
    const pending = dispatcher.dispatch({ kind: "scroll", direction: "down", amount: 300 });
    const res = await app.request("/api/agent/cancel", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actions: 1, approvals: 0 });
    await expect(pending).resolves.toMatchObject({
      status: "denied",
      error: "cancelled by user",
    });
    expect(dispatcher.queueDepth).toBe(0);
  });

  it("resolves a pending approval card as deny (default-deny semantics)", async () => {
    const { app, dispatcher } = newApp(new Dispatcher({ guard: approvingGuard }));
    dispatcher.ping(); // panel "connected" so the card is raised, not instant-denied
    const pending = dispatcher.dispatch({ kind: "navigate", url: "https://example.com" });
    // app.request runs on microtasks — dispatch is suspended at its first await
    // until the guard's verdict lands; wait for the card to actually be queued.
    await vi.waitFor(() => expect(dispatcher.queueDepth).toBe(1));
    const res = await app.request("/api/agent/cancel", { method: "POST", headers: AUTH });
    expect(await res.json()).toMatchObject({ ok: true, actions: 0, approvals: 1 });
    await expect(pending).resolves.toMatchObject({ status: "denied" });
  });

  it("a late action-result after cancel reports delivered:false", async () => {
    const { app, dispatcher } = newApp();
    const pending = dispatcher.dispatch({ kind: "scroll", direction: "down", amount: 300 });
    await app.request("/api/agent/cancel", { method: "POST", headers: AUTH });
    await expect(pending).resolves.toMatchObject({ status: "denied" });
    // The extension may still post the real outcome — no future, no delivery.
    const res = await app.request("/api/agent/action-result", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ id: (await pending).id, status: "ok", result: {} }),
    });
    expect(await res.json()).toEqual({ delivered: false });
  });
});
