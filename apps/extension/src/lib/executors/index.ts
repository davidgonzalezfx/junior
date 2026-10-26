// lib/executors/index.ts — the executor runner (plan §5.2 items 2–3): one
// BrowserAction in, an ActionResult-shaped outcome out. Probe-before-act for
// click/type (real facts → guard mirror → act with an expect-check), restricted-
// page refusal, and the screenshot/get_active_tab/navigate/scroll ops. The SW
// agent loop attaches queue ids and POSTs these as action-results.
//
// Everything chrome.* goes through ExecutorEnv so tests run the REAL in-page
// function against jsdom with fakeBrowser tabs.
import {
  USER_DENIED_TEXT,
  validateAgentUrl,
  type ApprovalRequest,
  type BrowserAction,
  type PermissionMode,
} from "@junior/protocol";
import { browser } from "wxt/browser";
import { loadSettings } from "@/lib/settings";
import { checkClickFacts, checkTypeFacts, type PreActCheck } from "./guard-mirror";
import {
  juniorActionInPage,
  type InPageClickFacts,
  type InPageFieldFacts,
  type InPageRequest,
  type InPageResponse,
} from "./in-page";
import {
  juniorReadTextInPage,
  type BuildDomTreeArgs,
  type BuildDomTreeResult,
  type ReadTextRequest,
  type ReadTextResponse,
} from "./read-page";
import { juniorBuildOutlineInPage } from "./outline";
import { downscaleDataUrl } from "./screenshot";
import {
  frameRefId,
  juniorFrameInfoInPage,
  parseFrameTarget,
  readPageFrames,
  resolveFrame,
  TOP_FRAME_ID,
  type FrameInfo,
} from "./frames";
import { isRestrictedUrl, RESTRICTED_TEXT } from "./restricted";

export { isRestrictedUrl };

/** Matches ActionResultSchema minus the queue id (the SW loop owns the id). */
export interface ExecuteOutcome {
  status: "ok" | "error" | "denied";
  result?: unknown;
  error?: string;
}

export interface ActiveTab {
  id?: number;
  url?: string;
  title?: string;
  status?: string;
  windowId?: number;
}

/** The user's answer to an "ask" verdict; once/site proceed (grants persist per session). */
export type AskFn = (approval: ApprovalRequest) => Promise<"once" | "site" | "deny">;

export interface ExecutorEnv {
  getActiveTab(): Promise<ActiveTab | null>;
  /** T1: bring a tab to the front of its window (no window focus change).
   * captureVisibleTab only sees the ACTIVE tab of a window, so the screenshot
   * op reveals the target tab before capturing — optional; without it the
   * capture sees whatever the user has on screen. */
  revealTab?(tabId: number): Promise<void>;
  /** The in-page seams run in the tab's top frame, or in ONE child frame when
   * `frameId` is given (T5a: executeScript `target.frameIds`). */
  runInPage(tabId: number, args: InPageRequest, frameId?: number): Promise<InPageResponse>;
  /** text/section read_page — self-contained fn via executeScript({func}). */
  runReadInPage(tabId: number, args: ReadTextRequest, frameId?: number): Promise<ReadTextResponse>;
  /** outline/interactive read_page — injects public/vendor/buildDomTree.js and
   *  calls window.buildDomTree(args); null when injection/invocation failed. */
  runBuildDomTree(
    tabId: number,
    args: BuildDomTreeArgs,
    frameId?: number,
  ): Promise<BuildDomTreeResult | null>;
  /** T5a: every frame of the tab (executeScript allFrames — no webNavigation
   * permission). Optional: without it reads and actions see the top frame only. */
  listFrames?(tabId: number): Promise<FrameInfo[]>;
  captureVisibleTab(windowId?: number): Promise<string>;
  permissionMode(): Promise<PermissionMode>;
  blockedOrigins(): Promise<readonly string[]>;
  navigateTab(tabId: number, url: string): Promise<void>;
}

export const defaultEnv: ExecutorEnv = {
  async getActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const first = tab ?? (await browser.tabs.query({ active: true }))[0];
    if (!first) return null;
    return {
      id: first.id,
      url: first.url,
      title: first.title,
      status: first.status,
      windowId: first.windowId,
    };
  },
  async revealTab(tabId) {
    await browser.tabs.update(tabId, { active: true });
  },
  async runInPage(tabId, args, frameId) {
    const results = await browser.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      func: juniorActionInPage,
      args: [args],
    });
    const first = results[0];
    return first?.result ?? { ok: false as const, error: "Injection returned no result" };
  },
  async runReadInPage(tabId, args, frameId) {
    const results = await browser.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      func: juniorReadTextInPage,
      args: [args],
    });
    const first = results[0];
    return first?.result ?? { ok: false as const, error: "Injection returned no result" };
  },
  async listFrames(tabId) {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: juniorFrameInfoInPage,
    });
    return results.flatMap((r) => (r.result ? [{ ...r.result, frameId: r.frameId }] : []));
  },
  async runBuildDomTree(tabId, args, frameId) {
    // Autono pattern (background.js:3553): inject the vendored file, then invoke
    // window.buildDomTree with args (executeScript serializes only the body, so
    // the call goes through juniorBuildOutlineInPage, which reads it off the page
    // window after installing the fallback-label hook).
    // Runtime path is extension-root-relative WITHOUT a leading slash (Chrome
    // rejects the slash; WXT's generated ScriptPublicPath type wants one — same
    // types-vs-Chrome mismatch as captureVisibleTab's windowId, cast it).
    await browser.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      files: ["vendor/buildDomTree.js"] as unknown as ["/vendor/buildDomTree.js"],
    });
    const results = await browser.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      func: juniorBuildOutlineInPage,
      args: [args],
    });
    const res = results[0]?.result;
    if (!res || typeof res !== "object" || !("text" in res)) return null;
    const text = (res as { text: unknown }).text;
    return typeof text === "string" ? { text } : null;
  },
  async captureVisibleTab(windowId?: number) {
    // wxt types demand a number windowId, but Chrome's current-window form takes
    // null — same call Autono makes (background.js:2368).
    const dataUrl = await browser.tabs.captureVisibleTab((windowId ?? null) as unknown as number, {
      format: "jpeg",
      quality: 100,
    });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      throw new Error("Capture did not return an image data URL");
    }
    return downscaleDataUrl(dataUrl);
  },
  async permissionMode() {
    return (await loadSettings()).permissionMode;
  },
  async blockedOrigins() {
    return [(await loadSettings()).bridgeUrl];
  },
  async navigateTab(tabId, url) {
    await browser.tabs.update(tabId, { url });
  },
};

function frameTarget(tabId: number, frameId: number | undefined) {
  return frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };
}

export interface ExecuteOptions {
  /** Approval path for "ask" verdicts. Default: deny (§6.3-3 — closed panel included). */
  ask?: AskFn;
  /** Session site grants: when the page's registrable domain was granted,
   * ask verdicts collapse to allow (guard-mirror still denies secrets/private nets). */
  granted?: (pageUrl: string) => Promise<boolean>;
}

const MAX_SCREENSHOT_CHARS = 3_000_000; // §6.3-6: size-capped payloads everywhere

function errorOutcome(error: string): ExecuteOutcome {
  return { status: "error", error };
}

/** Execute one browser action end-to-end: probe → guard → act. */
export async function executeAction(
  action: BrowserAction,
  env: ExecutorEnv = defaultEnv,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const ask = opts.ask ?? (async () => "deny");

  if (action.kind === "get_active_tab") {
    const tab = await env.getActiveTab();
    if (!tab) return errorOutcome("No active browser tab found");
    return {
      status: "ok",
      result: {
        title: (tab.title ?? "").slice(0, 300),
        url: (tab.url ?? "").slice(0, 2048),
        status: tab.status ?? "",
      },
    };
  }

  if (action.kind === "screenshot") {
    const tab = await env.getActiveTab();
    if (tab?.id === undefined) return errorOutcome("No browser tab to screenshot");
    try {
      // T1: capture the AGENT tab, never whatever the user is looking at —
      // reveal it in its window and capture that window's visible tab.
      await env.revealTab?.(tab.id);
      const dataUrl = await env.captureVisibleTab(tab.windowId);
      if (dataUrl.length > MAX_SCREENSHOT_CHARS) {
        return errorOutcome("Screenshot too large even after downscaling");
      }
      return { status: "ok", result: { dataUrl } };
    } catch (e) {
      return errorOutcome(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (action.kind === "navigate") {
    const tab = await env.getActiveTab();
    if (!tab?.id) return errorOutcome("No active browser tab to navigate");
    const check = validateAgentUrl(action.url, {
      assumeHttps: true,
      blockedOrigins: await env.blockedOrigins(),
    });
    if (!check.ok) {
      return {
        status: "denied",
        error: `Navigation blocked: ${check.error}. Use a normal public http(s) address.`,
      };
    }
    // The bridge's SessionGuard fully enforced this navigate before the action was
    // queued; the validate above is the extension-side defense-in-depth mirror.
    await env.navigateTab(tab.id, check.url);
    return { status: "ok", result: `Navigated to ${check.url}` };
  }

  if (action.kind === "read_page") {
    const tab = await env.getActiveTab();
    if (!tab?.id) return errorOutcome("No active browser tab to read");
    if (isRestrictedUrl(tab.url)) return errorOutcome(RESTRICTED_TEXT);

    return await readPageFrames(env, tab.id, action);
  }

  // Remaining kinds (click/type/scroll) act on the active tab.
  const tab = await env.getActiveTab();
  if (!tab?.id) return errorOutcome(`No active browser tab for ${action.kind}`);
  if (isRestrictedUrl(tab.url)) return errorOutcome(RESTRICTED_TEXT);

  if (action.kind === "scroll") {
    let frameId: number | undefined;
    if (action.frame && frameRefId(action.frame) !== TOP_FRAME_ID) {
      const found = await resolveFrame(env, tab.id, frameRefId(action.frame));
      if (!found.ok) return errorOutcome(found.error);
      frameId = found.frame.frameId;
    }
    const res = await env.runInPage(
      tab.id,
      { op: "scroll", direction: action.direction, amount: action.amount },
      ...(frameId === undefined ? [] : [frameId]),
    );
    return res.ok ? { status: "ok", result: res.message } : errorOutcome(res.error);
  }

  // T5a: `f7:<target>` runs in that child frame; anything else in the top frame.
  let target = action.target;
  let frameId: number | undefined;
  let frameUrl: string | undefined;
  const scoped = parseFrameTarget(action.target);
  if (scoped) {
    target = scoped.target;
    if (scoped.frameId !== TOP_FRAME_ID) {
      const found = await resolveFrame(env, tab.id, scoped.frameId);
      if (!found.ok) return errorOutcome(found.error);
      frameId = found.frame.frameId;
      frameUrl = found.frame.url;
    }
  }
  const inFrame: [] | [number] = frameId === undefined ? [] : [frameId];

  // click / type: probe-before-act (§5.2 item 3) — real facts first, guard verdict,
  // then act with an expect-check so the element can't change under the card.
  const mode = action.kind === "click" ? "click" : "type";
  const text = action.kind === "type" ? action.text : undefined;
  const probe = await env.runInPage(tab.id, { op: "probe", mode, target }, ...inFrame);
  if (!probe.ok) return errorOutcome(probe.error);

  // Inside a frame the guard judges BOTH sites — the page the user sees and the
  // frame the action lands in — and the stricter verdict wins.
  const permissionMode = await env.permissionMode();
  const checkAt = async (pageUrl: string): Promise<PreActCheck> =>
    mode === "click"
      ? checkClickFacts({
          mode: permissionMode,
          pageUrl,
          facts: probe.facts as InPageClickFacts,
          granted: await opts.granted?.(pageUrl),
        })
      : checkTypeFacts({
          mode: permissionMode,
          pageUrl,
          facts: probe.facts as InPageFieldFacts,
          text: text ?? "",
          granted: await opts.granted?.(pageUrl),
        });
  const verdicts = [await checkAt(tab.url ?? "")];
  if (frameUrl !== undefined) verdicts.push(await checkAt(frameUrl));
  const verdict = strictest(verdicts);

  if (verdict.verdict === "deny") return { status: "denied", error: verdict.error };
  if (verdict.verdict === "ask") {
    const answer = await ask(verdict.approval);
    if (answer === "deny") return { status: "denied", error: USER_DENIED_TEXT };
  }

  const act: InPageRequest =
    mode === "click"
      ? { op: "click", target, expect: probe.facts as InPageClickFacts }
      : { op: "type", target, text: text ?? "", expect: probe.facts as InPageFieldFacts };
  const res = await env.runInPage(tab.id, act, ...inFrame);
  if (!res.ok) return errorOutcome(res.error);
  // T5b: say where it landed, so the model can notice a wrong hit.
  const where = frameId === undefined ? "" : ` in iframe f${frameId} (${frameUrl ?? ""})`;
  return { status: "ok", result: `${res.message}${where}` };
}

/** deny beats ask beats allow; among asks the LAST one (the frame's) is shown. */
function strictest(verdicts: PreActCheck[]): PreActCheck {
  const deny = verdicts.find((v) => v.verdict === "deny");
  if (deny) return deny;
  return verdicts.filter((v) => v.verdict === "ask").at(-1) ?? { verdict: "allow" };
}
