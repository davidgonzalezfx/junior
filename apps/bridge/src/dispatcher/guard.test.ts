// M1-4 acceptance — the stateful SessionGuard (plan §4.4) over the pure protocol
// tables, unit-tested directly and wired through the real Hono app with the M1-2
// FakeExecutor pattern: a navigate dispatch must raise an approval card on the queue,
// survive a "site" answer, and re-ask nothing on the next visit to the same site.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JuniorConfigSchema,
  QueueItemSchema,
  type ApprovalDecision,
  type BrowserAction,
} from "@junior/protocol";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";
import { Dispatcher } from "./queue.js";
import { SessionGuard, defaultGuard, type GuardAsk } from "./guard.js";

const TOKEN = "a".repeat(64);
let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-guard-test-"));
  dirs.push(dir);
  return dir;
}

const nav = (url: string): BrowserAction => ({ kind: "navigate", url });
const decision = (d: ApprovalDecision["decision"]): ApprovalDecision => ({ id: "x", decision: d });
const askWith = (d: ApprovalDecision["decision"]): GuardAsk => vi.fn().mockResolvedValue(d);
const codesOf = (g: SessionGuard, a: BrowserAction) => {
  const v = g.check(a);
  return v.kind === "approval" ? v.approval.reasonCodes : v.kind;
};

describe("SessionGuard.check — navigate", () => {
  it("ask mode: a brand-new public site raises a new_site card", () => {
    const g = new SessionGuard();
    const v = g.check(nav("https://example.com"));
    expect(v.kind).toBe("approval");
    if (v.kind !== "approval") return;
    expect(v.approval.reasonCodes).toEqual(["new_site"]);
    expect(v.approval.siteDomain).toBe("example.com");
    expect(v.approval.pageUrl).toBe("https://example.com/");
    expect(v.approval.destinationUrl).toBe("https://example.com/");
  });

  it('a "site" answer persists; "once" only covers the current page', () => {
    const g = new SessionGuard();
    const action = nav("https://example.com");
    expect(codesOf(g, action)).toEqual(["new_site"]);
    g.onApprovalDecision(action, decision("site"));
    expect(g.check(nav("https://example.com/other"))).toEqual({ kind: "allow" });
    expect(g.allowedDomains()).toEqual(["example.com"]);
  });

  it('"once" leaves the domain ungranted (ask mode re-asks with routine_supervised)', () => {
    const g = new SessionGuard();
    const action = nav("https://example.com");
    g.onApprovalDecision(action, decision("once"));
    expect(codesOf(g, nav("https://example.com/other"))).toEqual(["routine_supervised"]);
  });

  it("auto mode lets routine traffic through and grants the site", () => {
    const g = new SessionGuard({ permissionMode: () => "auto" });
    expect(g.check(nav("https://example.com"))).toEqual({ kind: "allow" });
    expect(g.allowedDomains()).toEqual(["example.com"]);
  });

  it("auto mode still cards sensitive sites (§4.4 row 3 — even auto)", () => {
    const g = new SessionGuard({ permissionMode: () => "auto" });
    // First visit is both new AND sensitive; the card carries both reasons.
    expect(codesOf(g, nav("https://www.paypal.com/"))).toEqual(["new_site", "sensitive_site"]);
  });

  it("auto mode refuses local addresses with BLOCKED_BY_POLICY, no card", () => {
    const g = new SessionGuard({ permissionMode: () => "auto" });
    const v = g.check(nav("http://192.168.1.1/admin"));
    expect(v).toMatchObject({ kind: "deny" });
    if (v.kind === "deny") expect(v.reason.startsWith("BLOCKED_BY_POLICY:")).toBe(true);
    expect(codesOf(g, nav("http://192.168.1.1/admin"))).toBe("deny"); // still no card next time
  });

  it("none mode allows local addresses (matrix column none)", () => {
    const g = new SessionGuard({ permissionMode: () => "none" });
    expect(g.check(nav("http://192.168.1.1/admin"))).toEqual({ kind: "allow" });
  });

  it("the bridge's own origin is hard-denied in every mode (§6.3-5)", () => {
    for (const mode of ["ask", "auto", "none"]) {
      const g = new SessionGuard({
        permissionMode: () => mode,
        blockedOrigins: () => ["http://127.0.0.1:8620"],
      });
      const v = g.check(nav("http://127.0.0.1:8620/api/status"));
      expect(v.kind, mode).toBe("deny");
      if (v.kind === "deny") expect(v.reason).toContain("can never target it");
    }
  });

  it("non-web schemes are refused before any card", () => {
    const g = new SessionGuard();
    const v = g.check(nav("javascript:alert(1)"));
    expect(v).toMatchObject({ kind: "deny" });
    if (v.kind === "deny") expect(v.reason).toContain("Navigation blocked");
  });

  it("scheme-less targets get https (assumeHttps, Autono navigate behavior)", () => {
    const g = new SessionGuard({ permissionMode: () => "auto" });
    expect(g.check(nav("example.com/x"))).toEqual({ kind: "allow" });
  });

  it("startUrls seed the seen domains", () => {
    const g = new SessionGuard({ startUrls: ["https://example.com/task"] });
    expect(codesOf(g, nav("https://example.com/next"))).toEqual(["routine_supervised"]);
  });

  it("non-navigate actions pass through (page-fact checks live in the §5.2 mirror)", () => {
    const g = new SessionGuard();
    expect(g.check({ kind: "click", target: "3" })).toEqual({ kind: "allow" });
    expect(g.check({ kind: "type", target: "3", text: "hello" })).toEqual({ kind: "allow" });
  });
});

describe("SessionGuard.checkPage", () => {
  it("asks about a sensitive page and denies on 'deny'", async () => {
    const g = new SessionGuard();
    const ask = vi.fn<GuardAsk>().mockResolvedValue("deny");
    await expect(g.checkPage("https://www.paypal.com/", ask)).resolves.toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0].reasonCodes).toContain("sensitive_site");
    // deny records nothing → next checkPage asks again
    await expect(g.checkPage("https://www.paypal.com/", ask)).resolves.toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("'site' grants the domain so later checkPages skip the ask", async () => {
    const g = new SessionGuard();
    const ask = askWith("site");
    await expect(g.checkPage("https://www.paypal.com/", ask)).resolves.toBe(true);
    await expect(g.checkPage("https://www.paypal.com/again", askWith("deny"))).resolves.toBe(true);
  });

  it("an unparseable page URL is not this guard's problem", async () => {
    const g = new SessionGuard();
    const ask = askWith("deny");
    await expect(g.checkPage("chrome://settings", ask)).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("defaultGuard reads live config (fail-safe to ask)", () => {
  it("config permissionMode + port drive the matrix and blockedOrigins", () => {
    const dir = tmpDir();
    saveConfig(JuniorConfigSchema.parse({ port: 9999, permissionMode: "auto" }), dir);
    const g = defaultGuard(dir);
    // The configured port is Junior's own origin → hard deny even in auto.
    expect(g.check(nav("http://127.0.0.1:9999/mcp")).kind).toBe("deny");
    // auto + private → deny; auto + new public site → allow.
    expect(g.check(nav("http://10.0.0.5/")).kind).toBe("deny");
    expect(g.check(nav("https://example.com"))).toEqual({ kind: "allow" });
  });

  it("no config file → ask mode, default bridge origin blocked", () => {
    const g = defaultGuard(tmpDir());
    expect(codesOf(g, nav("https://example.com"))).toEqual(["new_site"]);
    expect(g.check(nav("http://127.0.0.1:8620/")).kind).toBe("deny");
  });
});

describe("wired through createApp: navigate → card → execute (§4.3+§4.4)", () => {
  const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  /** createApp's default pairing, built explicitly so the test holds the SAME
   * dispatcher it dispatches on (M1-2 learning: never let createApp build its own). */
  function newApp() {
    const dir = tmpDir();
    writeToken(TOKEN, dir);
    const dispatcher = new Dispatcher({ guard: defaultGuard(dir) });
    return { dispatcher, app: createApp({ dir, log: vi.fn(), dispatcher }) };
  }

  it("a site answer lets the action run and skips the card next time", async () => {
    const { dispatcher, app } = newApp();
    const first = dispatcher.dispatch(nav("https://example.com"));
    const poll = await app.request("/api/agent/next-action?timeout=1", { headers: AUTH });
    const item = QueueItemSchema.parse(await poll.json());
    expect(item).toMatchObject({ kind: "approval", approval: { siteDomain: "example.com" } });
    const answered = await app.request("/api/agent/approval-response", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ id: item.id, decision: "site" }),
    });
    expect(answered.status).toBe(200);

    // After "site" the first dispatch proceeds to execution: its action (same id) is
    // already buffered. The granted domain's second navigate raises NO card — it goes
    // straight through as an action. Answer both futures, then assert.
    const second = dispatcher.dispatch(nav("https://example.com/other"));
    for (const pending of [first, second]) {
      const actionPoll = await app.request("/api/agent/next-action?timeout=1", { headers: AUTH });
      const actionItem = QueueItemSchema.parse(await actionPoll.json());
      expect(actionItem).toMatchObject({ kind: "action", action: { kind: "navigate" } });
      await app.request("/api/agent/action-result", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ id: actionItem.id, status: "ok", result: { executed: true } }),
      });
      await expect(pending).resolves.toMatchObject({ status: "ok" });
    }
  });

  it("a deny answer resolves the dispatch as USER_DENIED", async () => {
    const { dispatcher, app } = newApp();
    const dispatch = dispatcher.dispatch(nav("https://example.com"));
    const poll = await app.request("/api/agent/next-action?timeout=1", { headers: AUTH });
    const item = QueueItemSchema.parse(await poll.json());
    await app.request("/api/agent/approval-response", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ id: item.id, decision: "deny" }),
    });
    const res = await dispatch;
    expect(res.status).toBe("denied");
    expect(res.error?.startsWith("USER_DENIED:")).toBe(true);
  });

  it("Dispatcher.requestApproval (checkPage's ask path) denies with nobody connected", async () => {
    const { dispatcher } = newApp();
    const verdict = await dispatcher.requestApproval({
      reasonCodes: ["new_site"],
      reasons: ["New site for this task: example.com"],
      pageUrl: "https://example.com/",
      siteDomain: "example.com",
    });
    expect(verdict).toBe("deny");
  });
});
