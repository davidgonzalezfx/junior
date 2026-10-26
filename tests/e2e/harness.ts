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
  JuniorConfigSchema,
  type ApprovalRequest,
  type ActionResult,
  type PermissionMode,
} from "@junior/protocol";
import { createApp } from "../../apps/bridge/src/index.js";
import { Dispatcher } from "../../apps/bridge/src/dispatcher/queue.js";
import { SessionGuard } from "../../apps/bridge/src/dispatcher/guard.js";
import { generateToken, saveConfig, writeToken } from "../../apps/bridge/src/config.js";
import {
  fetchNextAction,
  fetchStatus,
  postActionResult,
  postApprovalDecision,
} from "@/lib/bridge-client";
import { AgentLoop, mirrorAsk } from "@/lib/agent-loop";
import { AgentTabManager, withAgentTab, type AgentTabHost } from "@/lib/agent-tab";
import { executeAction, type ExecutorEnv } from "@/lib/executors";
import { juniorActionInPage } from "@/lib/executors/in-page";
import { juniorReadTextInPage } from "@/lib/executors/read-page";
import { juniorFrameInfoInPage } from "@/lib/executors/frames";
import { addSiteGrant, getSiteGrants, grantCovers } from "@/lib/site-grants";
import { PANEL_PORT_NAME, PortRouter, type PortLike } from "@/lib/port-router";
import { PanelApprovalBroker } from "@/lib/panel-approvals";
import type { ApprovalAnswer, ApprovalAsk } from "@/lib/panel-approvals";
import { FakeTab, type FakeFrame, type FakePage } from "./fake-tab";

export type { FakeFrame, FakePage };

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
  /** /api/chat provider seam (M4-3): a scripted Anthropic-wire fetch so agent-mode
   * tests run the REAL chat tool loop with no LLM. Also writes a dummy
   * anthropicKey into the harness config so resolveModel accepts "anthropic". */
  chatFetch?: typeof fetch;
  /** M5-9: "real" wires the REAL PortRouter + PanelApprovalBroker behind a stub
   * panel port (connectPanel), so panel-closed semantics run over the real chain.
   * Default "scripted" keeps the always-listening sink with scripted answers. */
  panel?: "scripted" | "real";
  /** T1: extra tabs the "user" has open (tab 2, 3, …), each its own FakeTab
   * realm. Tab 1 stays the agent's tab (`harness.tab`). */
  otherTabs?: Record<number, { url: string; page: FakePage }>;
  /** "external": the harness does NOT start its own AgentLoop — the test boots
   * the production SW stack (createAgentRuntime) against `agentEnv` and the
   * bridge itself, so it can discard and re-boot it (MV3 suspension). */
  sw?: "harness" | "external";
}

export interface Harness {
  readonly bridgeUrl: string;
  /** The bridge bearer token — clients outside this process (the M4-2 terminal-
   * Claude smoke) need it to register against /mcp. */
  readonly token: string;
  readonly tab: FakeTab;
  /** T1: every harness tab by id (1 = the agent tab). */
  readonly tabs: ReadonlyMap<number, FakeTab>;
  /** T1: the "user" focuses a tab — what chrome.tabs.query would report active.
   * Agent tab isolation must not depend on this. */
  focusTab(id: number): void;
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
  /** M5-9 (panel: "real"): attach a stub panel port to the REAL PortRouter —
   * messages it receives, disconnect() to close it mid-anything, respond() to
   * answer a card through the real router→broker→loop chain. */
  connectPanel(): {
    /** Every message the SW broadcast to this port, in order. */
    readonly messages: readonly unknown[];
    /** Simulates the panel closing: fires the port's onDisconnect. */
    disconnect(): void;
    /** Panel-side card answer through the REAL inbound chain. */
    respond(id: string, decision: "once" | "site" | "deny"): void;
  };
  /** The REAL AgentLoop — M4-5 tests pause it to pin an item in the bridge queue. */
  readonly loop: AgentLoop;
  /** The executor env bound to the agent tab — what a test-booted SW executes with. */
  readonly agentEnv: ExecutorEnv;
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
  // T1: the user's own tabs. Injection seams focus the TARGET tab's realm first
  // (executeScript is per-tab), while getActiveTab reports the USER's focused
  // tab — exactly the chrome state the per-action "active tab" resolution raced
  // against before the agent tab isolation landed.
  const tabsById = new Map<number, FakeTab>([[1, tab]]);
  for (const [id, def] of Object.entries(opts.otherTabs ?? {})) {
    tabsById.set(Number(id), new FakeTab(def.url, def.page));
  }
  let userFocusedId = 1;

  const modeHolder: { mode: PermissionMode } = { mode: opts.mode ?? "auto" };
  const cards: ApprovalRequest[] = [];
  const wireCards: ApprovalRequest[] = [];
  const answers: Array<ApprovalAnswer | ((a: ApprovalRequest) => ApprovalAnswer)> = [];

  // M5-9: the real panel stack — a PortRouter whose ports are the stub ports
  // connectPanel() attaches, fronting a real PanelApprovalBroker as the ask().
  const HARNESS_EXT_ID = "junior-harness-extension-id";
  const HARNESS_EXT_ORIGIN = `chrome-extension://${HARNESS_EXT_ID}`;
  let panelRouter: PortRouter | null = null;
  let panelBroker: PanelApprovalBroker | null = null;
  if (opts.panel === "real") {
    panelRouter = new PortRouter({
      extensionId: HARNESS_EXT_ID,
      extensionOrigin: HARNESS_EXT_ORIGIN,
      onApprovalResponse: (msg) => panelBroker?.handleResponse(msg),
      // M5-9: last panel port gone ⇒ deny pending cards now (the fix under test)
      onPanelDisconnected: () => panelBroker?.denyAllNoPanel(),
    });
    panelBroker = new PanelApprovalBroker(panelRouter);
  }

  const scriptedSink: ApprovalAsk = {
    async request(approval) {
      cards.push(approval);
      const next = answers.shift();
      return typeof next === "function" ? next(approval) : (next ?? "deny");
    },
    // The scripted panel is always "listening"; the honest failure mode is the
    // deny default in request(), not a missing card.
    hasListener: () => true,
  };
  const sink: ApprovalAsk = panelBroker ?? scriptedSink;

  // Bridge side (the harness doubles as the server operator): tmp JUNIOR_HOME,
  // real app, real dispatcher, real SessionGuard seeded with the start tab.
  const dir = mkdtempSync(join(tmpdir(), "junior-harness-"));
  const token = generateToken();
  writeToken(token, dir);
  if (opts.chatFetch !== undefined) {
    // resolveModel("anthropic") demands a key; the scripted chatFetch never sees it.
    saveConfig(JuniorConfigSchema.parse({ providers: { anthropicKey: "harness-not-real" } }), dir);
  }

  let bridgeUrl = ""; // assigned once the listener is up (guard/env close over it)
  const guard = new SessionGuard({
    permissionMode: () => modeHolder.mode,
    blockedOrigins: () => [bridgeUrl],
    startUrls: [opts.tabUrl],
  });
  const dispatcher = new Dispatcher({ guard });
  // M4-4: the CLI engine's --mcp-config must point at THIS listener (port 0 binds
  // ephemeral) — the holder is filled in once the port is known; chatRoutes reads
  // it lazily per request.
  const cliSeams: { loopbackUrl?: string } = {};
  const app = createApp({ dir, dispatcher, chat: { fetch: opts.chatFetch, cli: cliSeams } });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cliSeams.loopbackUrl = bridgeUrl;

  const env: ExecutorEnv = {
    async getActiveTab() {
      const t = tabsById.get(userFocusedId);
      if (!t) return null;
      return { id: userFocusedId, url: t.url, title: t.document.title, status: "complete" };
    },
    async runInPage(tabId, args, frameId) {
      tabsById.get(tabId)?.focus(frameId);
      return await juniorActionInPage(args);
    },
    async runReadInPage(tabId, args, frameId) {
      tabsById.get(tabId)?.focus(frameId);
      return await juniorReadTextInPage(args);
    },
    async listFrames(tabId) {
      // T5a: run the REAL frame probe in every realm, as executeScript({allFrames})
      // would. A same-origin jsdom frame sits at about:blank, so the URL is the
      // one the fixture declares (what Chrome would report).
      const t = tabsById.get(tabId);
      if (!t) return [];
      return t.frames().map((f) => {
        t.focus(f.frameId);
        return { ...juniorFrameInfoInPage(), frameId: f.frameId, url: f.url };
      });
    },
    async runBuildDomTree(tabId, args, frameId) {
      const t = tabsById.get(tabId);
      t?.focus(frameId);
      t?.injectBuildDomTree(frameId);
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
    async navigateTab(tabId, url) {
      tabsById.get(tabId)?.go(url);
    },
  };

  // T1: the same composition as the background — the loop's actions resolve
  // through the agent tab manager, so the user's focus cannot retarget them.
  // Tab 1 plays the "Junior" group tab (created once by the harness itself).
  const agentTabHost: AgentTabHost = {
    recall: async () => null,
    remember: async () => {},
    getTab: async (id) => {
      const t = tabsById.get(id);
      return t ? { id, url: t.url, title: t.document.title, status: "complete" } : null;
    },
    findExisting: async () => {
      const t = tabsById.get(1)!;
      return { id: 1, url: t.url, title: t.document.title, status: "complete" };
    },
    create: async () => {
      throw new Error("harness: the agent tab (1) always exists — create() is unreachable");
    },
  };
  const agentEnv = withAgentTab(env, new AgentTabManager(agentTabHost));

  const loop = new AgentLoop({
    poll: (timeoutMs) => fetchNextAction(bridgeUrl, token, timeoutMs),
    postResult: async ({ id, ...outcome }) => {
      await postActionResult(bridgeUrl, token, ActionResultSchema.parse({ id, ...outcome }));
    },
    postDecision: async (decision) => {
      await postApprovalDecision(bridgeUrl, token, decision);
    },
    execute: (action) =>
      executeAction(action, agentEnv, {
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
  if (opts.sw !== "external") loop.start();

  const harness: Harness = {
    bridgeUrl,
    token,
    tab,
    tabs: tabsById,
    focusTab(id: number) {
      if (!tabsById.has(id)) throw new Error(`focusTab: no tab ${id} in this harness`);
      userFocusedId = id;
    },
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
    connectPanel() {
      if (!panelRouter) throw new Error(`connectPanel() requires panel: "real"`);
      const messages: unknown[] = [];
      const onMessage: ((msg: unknown, port: PortLike) => void)[] = [];
      const onDisconnect: ((port: PortLike) => void)[] = [];
      const port: PortLike = {
        name: PANEL_PORT_NAME,
        sender: { id: HARNESS_EXT_ID, url: `${HARNESS_EXT_ORIGIN}/sidepanel.html` },
        postMessage: (msg) => {
          messages.push(msg);
        },
        disconnect() {
          onDisconnect.forEach((cb) => cb(port));
        },
        onMessage: { addListener: (cb) => onMessage.push(cb), removeListener: () => {} },
        onDisconnect: { addListener: (cb) => onDisconnect.push(cb) },
      };
      if (!panelRouter.attach(port)) throw new Error("harness panel port rejected by the router");
      return {
        messages,
        disconnect: () => port.disconnect(),
        respond: (id: string, decision: "once" | "site" | "deny") =>
          onMessage.forEach((cb) => cb({ type: "approval_response", id, decision }, port)),
      };
    },
    loop,
    agentEnv,
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
      panelBroker?.denyAll(); // M5-9: clear pending card timers so the worker can exit
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
