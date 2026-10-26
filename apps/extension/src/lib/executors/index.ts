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
import { downscaleDataUrl } from "./screenshot";

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
  runInPage(tabId: number, args: InPageRequest): Promise<InPageResponse>;
  /** text/section read_page — self-contained fn via executeScript({func}). */
  runReadInPage(tabId: number, args: ReadTextRequest): Promise<ReadTextResponse>;
  /** outline/interactive read_page — injects public/vendor/buildDomTree.js and
   *  calls window.buildDomTree(args); null when injection/invocation failed. */
  runBuildDomTree(tabId: number, args: BuildDomTreeArgs): Promise<BuildDomTreeResult | null>;
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
  async runInPage(tabId, args) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: juniorActionInPage,
      args: [args],
    });
    const first = results[0];
    return first?.result ?? { ok: false as const, error: "Injection returned no result" };
  },
  async runReadInPage(tabId, args) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: juniorReadTextInPage,
      args: [args],
    });
    const first = results[0];
    return first?.result ?? { ok: false as const, error: "Injection returned no result" };
  },
  async runBuildDomTree(tabId, args) {
    // Autono pattern (background.js:3553): inject the vendored file, then invoke
    // window.buildDomTree with args (executeScript serializes only the body, so
    // the call goes through a tiny trampoline that reads it off the page window).
    // Runtime path is extension-root-relative WITHOUT a leading slash (Chrome
    // rejects the slash; WXT's generated ScriptPublicPath type wants one — same
    // types-vs-Chrome mismatch as captureVisibleTab's windowId, cast it).
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["vendor/buildDomTree.js"] as unknown as ["/vendor/buildDomTree.js"],
    });
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: (a: BuildDomTreeArgs) => {
        const build = (
          window as unknown as {
            buildDomTree?: (a: BuildDomTreeArgs) => unknown;
          }
        ).buildDomTree;
        if (typeof build !== "function") return null;
        return build(a);
      },
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

export interface ExecuteOptions {
  /** Approval path for "ask" verdicts. Default: deny (§6.3-3 — closed panel included). */
  ask?: AskFn;
  /** Session site grants: when the page's registrable domain was granted,
   * ask verdicts collapse to allow (guard-mirror still denies secrets/private nets). */
  granted?: (pageUrl: string) => Promise<boolean>;
}

// Port of Autono isRestrictedUrl (background.js:1751–1773): internal pages are
// never automation targets.
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  if (lower === "") return true;
  return (
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("about:") ||
    lower.startsWith("view-source:") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("chrome-untrusted://") ||
    lower.startsWith("chrome-search://") ||
    lower.startsWith("file:") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("filesystem:") ||
    lower.startsWith("ftp:") ||
    lower.includes("chrome.google.com/webstore") ||
    lower.includes("chromewebstore.google.com")
  );
}

const RESTRICTED_TEXT = "Action omitted: not permitted on internal Chrome pages";
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

    if (action.mode === "outline" || action.mode === "interactive") {
      // Vendored buildDomTree.js caps the output in-page at maxChars (§6.3-6).
      try {
        const res = await env.runBuildDomTree(tab.id, {
          mode: action.mode,
          maxChars: action.maxChars,
        });
        if (!res) return errorOutcome("Could not read the page (reader injection failed)");
        return { status: "ok", result: res.text };
      } catch (e) {
        return errorOutcome(`read_page failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // text | section — capped in-page at maxChars (§6.3-6).
    const res = await env.runReadInPage(tab.id, {
      mode: action.mode,
      selector: action.selector,
      maxChars: action.maxChars,
    });
    return res.ok ? { status: "ok", result: res.text } : errorOutcome(res.error);
  }

  // Remaining kinds (click/type/scroll) act on the active tab.
  const tab = await env.getActiveTab();
  if (!tab?.id) return errorOutcome(`No active browser tab for ${action.kind}`);
  if (isRestrictedUrl(tab.url)) return errorOutcome(RESTRICTED_TEXT);

  if (action.kind === "scroll") {
    const res = await env.runInPage(tab.id, {
      op: "scroll",
      direction: action.direction,
      amount: action.amount,
    });
    return res.ok ? { status: "ok", result: res.message } : errorOutcome(res.error);
  }

  // click / type: probe-before-act (§5.2 item 3) — real facts first, guard verdict,
  // then act with an expect-check so the element can't change under the card.
  const mode = action.kind === "click" ? "click" : "type";
  const text = action.kind === "type" ? action.text : undefined;
  const probe = await env.runInPage(tab.id, { op: "probe", mode, target: action.target });
  if (!probe.ok) return errorOutcome(probe.error);

  const verdict: PreActCheck =
    mode === "click"
      ? checkClickFacts({
          mode: await env.permissionMode(),
          pageUrl: tab.url ?? "",
          facts: probe.facts as InPageClickFacts,
          granted: await opts.granted?.(tab.url ?? ""),
        })
      : checkTypeFacts({
          mode: await env.permissionMode(),
          pageUrl: tab.url ?? "",
          facts: probe.facts as InPageFieldFacts,
          text: text ?? "",
          granted: await opts.granted?.(tab.url ?? ""),
        });

  if (verdict.verdict === "deny") return { status: "denied", error: verdict.error };
  if (verdict.verdict === "ask") {
    const answer = await ask(verdict.approval);
    if (answer === "deny") return { status: "denied", error: USER_DENIED_TEXT };
  }

  const act: InPageRequest =
    mode === "click"
      ? { op: "click", target: action.target, expect: probe.facts as InPageClickFacts }
      : {
          op: "type",
          target: action.target,
          text: text ?? "",
          expect: probe.facts as InPageFieldFacts,
        };
  const res = await env.runInPage(tab.id, act);
  return res.ok ? { status: "ok", result: res.message } : errorOutcome(res.error);
}
