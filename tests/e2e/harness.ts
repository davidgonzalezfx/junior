// tests/e2e/harness.ts — the M3-5 fake-model harness (plan §8 M3-5): boots the
// REAL bridge (Hono app + Dispatcher + SessionGuard, imported from source) on an
// ephemeral loopback port, wires the extension's REAL AgentLoop + bridge-client +
// executors against a FakeTab, and hands the test a dispatch() that plays the
// model: raw queue items in, ActionResult out. No LLM anywhere (plan §9's "fake
// executor client"); scripted card answers stand in for the panel.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { z } from "zod";
import {
  ActionResultSchema,
  BrowserActionSchema,
  type ApprovalRequest,
  type ActionResult,
  type PermissionMode,
} from "@junior/protocol";
import { createApp } from "../../apps/bridge/src/index.js";
import { Dispatcher } from "../../apps/bridge/src/dispatcher/queue.js";
import { SessionGuard } from "../../apps/bridge/src/dispatcher/guard.js";
import { generateToken, writeToken } from "../../apps/bridge/src/config.js";
import {
  fetchNextAction,
  fetchStatus,
  postActionResult,
  postApprovalDecision,
} from "@/lib/bridge-client";
import { AgentLoop, mirrorAsk } from "@/lib/agent-loop";
import { executeAction, type ExecutorEnv } from "@/lib/executors";
import { juniorActionInPage } from "@/lib/executors/in-page";
import { juniorReadTextInPage } from "@/lib/executors/read-page";
import { addSiteGrant, getSiteGrants, grantCovers } from "@/lib/site-grants";
import type { ApprovalAnswer, ApprovalAsk } from "@/lib/panel-approvals";
import { FakeTab, type FakePage } from "./fake-tab";

export type { FakePage };

/** What a test may write in a dispatch — schema defaults (maxChars) stay optional. */
export type DispatchAction = z.input<typeof BrowserActionSchema>;

/** A 1×1 JPEG — the fake tab has no real pixels to capture. */
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

export interface HarnessOptions {
  /** URL (and origin) the tab starts on; seeds the bridge guard's seen domains. */
  tabUrl: string;
  /** The tab's "web": URL → title/html/side-effects. Must include tabUrl. */
  pages: Record<string, FakePage>;
  /** Initial permission mode — mutate `harness.mode` mid-scenario. Default "auto". */
  mode?: PermissionMode;
}

export interface Harness {
  readonly bridgeUrl: string;
  /** The bridge bearer token — clients outside this process (the M4-2 terminal-
   * Claude smoke) need it to register against /mcp. */
  readonly token: string;
  readonly tab: FakeTab;
  /** Live permission mode; the bridge guard and the guard mirror both read it. */
  mode: PermissionMode;
  /** Push one raw queue item and await its ActionResult (the model's view). */
  dispatch(action: DispatchAction, timeoutMs?: number): Promise<ActionResult>;
  /** Every card raised — wire or mirror — in order. */
  readonly cards: readonly ApprovalRequest[];
  /** Cards that arrived as bridge approval queue items (over the long-poll). */
  readonly wireCards: readonly ApprovalRequest[];
  /** Script the NEXT card's answer. Unset answers default to deny, so a test
   * that forgets to script a card fails loudly instead of passing mysteriously. */
  answerNext(answer: ApprovalAnswer | ((approval: ApprovalRequest) => ApprovalAnswer)): void;
  /** Resolves once the loop's first long-poll has pinged the bridge. */
  waitConnected(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const initialPage = opts.pages[opts.tabUrl];
  if (!initialPage) throw new Error(`pages must include the tabUrl ${opts.tabUrl}`);

  // Extension side first: the FakeTab swaps globalThis onto its active window,
  // so only one harness may run at a time within a worker (tests are sequential).
  const tab = new FakeTab(opts.tabUrl, initialPage);
  for (const [url, page] of Object.entries(opts.pages)) tab.register(url, page);

  const modeHolder: { mode: PermissionMode } = { mode: opts.mode ?? "auto" };
  const cards: ApprovalRequest[] = [];
  const wireCards: ApprovalRequest[] = [];
  const answers: Array<ApprovalAnswer | ((a: ApprovalRequest) => ApprovalAnswer)> = [];

  const sink: ApprovalAsk = {
    async request(approval) {
      cards.push(approval);
      const next = answers.shift();
      return typeof next === "function" ? next(approval) : (next ?? "deny");
    },
    // The scripted panel is always "listening"; the honest failure mode is the
    // deny default in request(), not a missing card.
    hasListener: () => true,
  };

  // Bridge side (the harness doubles as the server operator): tmp JUNIOR_HOME,
  // real app, real dispatcher, real SessionGuard seeded with the start tab.
  const dir = mkdtempSync(join(tmpdir(), "junior-harness-"));
  const token = generateToken();
  writeToken(token, dir);

  let bridgeUrl = ""; // assigned once the listener is up (guard/env close over it)
  const guard = new SessionGuard({
    permissionMode: () => modeHolder.mode,
    blockedOrigins: () => [bridgeUrl],
    startUrls: [opts.tabUrl],
  });
  const dispatcher = new Dispatcher({ guard });
  const app = createApp({ dir, dispatcher });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const env: ExecutorEnv = {
    async getActiveTab() {
      return { id: 1, url: tab.url, title: tab.document.title, status: "complete" };
    },
    async runInPage(_tabId, args) {
      return await juniorActionInPage(args);
    },
    async runReadInPage(_tabId, args) {
      return await juniorReadTextInPage(args);
    },
    async runBuildDomTree(_tabId, args) {
      tab.injectBuildDomTree();
      const w = globalThis as unknown as { window: { buildDomTree?: (a: unknown) => unknown } };
      const build = w.window.buildDomTree;
      if (typeof build !== "function") return null;
      const res = build(args);
      if (!res || typeof res !== "object" || !("text" in res)) return null;
      const text = (res as { text: unknown }).text;
      return typeof text === "string" ? { text } : null;
    },
    async captureVisibleTab() {
      return TINY_JPEG;
    },
    async permissionMode() {
      return modeHolder.mode;
    },
    async blockedOrigins() {
      return [bridgeUrl];
    },
    async navigateTab(_tabId, url) {
      tab.go(url);
    },
  };

  const loop = new AgentLoop({
    poll: (timeoutMs) => fetchNextAction(bridgeUrl, token, timeoutMs),
    postResult: async ({ id, ...outcome }) => {
      await postActionResult(bridgeUrl, token, ActionResultSchema.parse({ id, ...outcome }));
    },
    postDecision: async (decision) => {
      await postApprovalDecision(bridgeUrl, token, decision);
    },
    execute: (action) =>
      executeAction(action, env, {
        ask: mirrorAsk(sink, async (domain) => {
          await addSiteGrant(domain);
        }),
        granted: async (pageUrl) => grantCovers(await getSiteGrants(), pageUrl),
      }),
    // Bridge-guard cards ride the long-poll as approval queue items; tag them
    // before they hit the same scripted sink the mirror cards use.
    ask: {
      async request(approval, remainingMs) {
        wireCards.push(approval);
        return await sink.request(approval, remainingMs);
      },
      hasListener: () => true,
    },
  });
  loop.start();

  const harness: Harness = {
    bridgeUrl,
    token,
    tab,
    cards,
    wireCards,
    get mode() {
      return modeHolder.mode;
    },
    set mode(m: PermissionMode) {
      modeHolder.mode = m;
    },
    answerNext(answer) {
      answers.push(answer);
    },
    async waitConnected(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await fetchStatus(bridgeUrl, token).then((s) => s.browserConnected)) return;
        if (Date.now() > deadline) throw new Error("agent loop never connected to the bridge");
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    },
    dispatch(action: DispatchAction, timeoutMs = 20_000): Promise<ActionResult> {
      return dispatcher
        .dispatch(BrowserActionSchema.parse(action), timeoutMs)
        .then((r) => ActionResultSchema.parse(r));
    },
    async stop(): Promise<void> {
      loop.stop();
      dispatcher.dispose("harness stopped");
      // The loop may hold an in-flight 15 s long-poll — drop its socket so close
      // doesn't wait out the window. (serve() unions http1/http2 types; the cast
      // narrows to the http1 Server we created.)
      const httpServer = server as unknown as HttpServer;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  return harness;
}
