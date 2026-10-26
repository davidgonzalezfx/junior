// tests/e2e/fake-tab.ts — the harness "browser tab": a jsdom document per origin
// (fresh JSDOM on cross-origin navigations, pushState within one), with the
// window/document globals stamped onto globalThis so the extension's self-contained
// in-page functions (juniorActionInPage / juniorReadTextInPage / buildDomTree) run
// against the ACTIVE page exactly as executeScript would inject them. jsdom layout
// stubs follow the proven M3-1/M3-2 extension-test pattern (rects, elementFromPoint,
// offsetWidth/Height, scrollIntoView).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { stubStackedLayout } from "@junior/testkit/jsdom";

const VENDOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/extension/public/vendor/buildDomTree.js",
);
const BUILD_DOM_TREE_SOURCE = readFileSync(VENDOR_PATH, "utf8");

export interface FakePage {
  title: string;
  html: string;
  /** Runs after each load — wire per-page side effects (button handlers). */
  onShow?: (doc: Document) => void;
}

// Bare globals the in-page code resolves dynamically. Node's OWN globals are
// snapshotted once at module load (before any stamping) and never shadowed; every
// other own property of the active jsdom window (Node, Element, MouseEvent, …)
// is copied onto globalThis so the page's realm is fully reachable. Re-stamped
// per window — events and prototype value descriptors then always come from the
// page's own realm.
const NODE_OWN_GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));

// Node ships its own incompatible `Event` (and friends) — if the native one stays
// global, jsdom's dispatchEvent rejects the constructed events ("parameter 1 is
// not of type 'Event'"). These DOM classes are force-stamped from the active
// window even though Node owns same-named globals; this is a harness process.
const FORCE_STAMP = new Set([
  "Event",
  "EventTarget",
  "UIEvent",
  "CustomEvent",
  "MessageEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "WheelEvent",
  "CompositionEvent",
  "AnimationEvent",
  "TransitionEvent",
  "ProgressEvent",
  "ErrorEvent",
  "CloseEvent",
  "StorageEvent",
]);

function stampGlobals(dom: JSDOM): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (NODE_OWN_GLOBALS.has(key) && !FORCE_STAMP.has(key)) continue;
    try {
      g[key] = (dom.window as unknown as Record<string, unknown>)[key];
    } catch {
      // Accessor that throws on read (cross-origin guards) — nothing needs it.
    }
  }
}

export class FakeTab {
  /** The URL the bridge/loop believe the tab is on (window.location always agrees). */
  url: string;
  private dom: JSDOM;
  private pages = new Map<string, FakePage>();

  constructor(initialUrl: string, initialPage: FakePage) {
    this.pages.set(initialUrl, initialPage);
    this.dom = this.newDom(initialUrl);
    this.url = initialUrl;
    this.show(initialPage);
  }

  register(url: string, page: FakePage): void {
    this.pages.set(url, page);
  }

  get document(): Document {
    return this.dom.window.document;
  }

  /** Fake navigation (the ExecutorEnv.navigateTab seam). Cross-origin = fresh
   * JSDOM (jsdom pushState is same-origin only); same-origin = pushState, so the
   * resolver's __junior_dom_map URL stamp invalidates like a real SPA hop. */
  go(url: string): void {
    const page = this.pages.get(url) ?? { title: "Untitled", html: "" };
    this.pages.set(url, page);
    if (new URL(url).origin === new URL(this.url).origin) {
      this.dom.window.history.pushState({}, "", url);
    } else {
      this.dom = this.newDom(url);
    }
    this.url = url;
    this.show(page);
  }

  /** Re-stamps this tab's window globals onto globalThis — the harness models
   * executeScript's per-tab injection by focusing the target tab's realm before
   * running the self-contained in-page functions (T1 multi-tab support). */
  focus(): void {
    stampGlobals(this.dom);
  }

  /** Evaluates the REAL vendored buildDomTree into the active window, idempotent
   * per window — mirrors executeScript({files:["vendor/buildDomTree.js"]}). */
  injectBuildDomTree(): void {
    const w = this.dom.window as unknown as Record<string, unknown>;
    if (!w.buildDomTree) new Function(BUILD_DOM_TREE_SOURCE)();
  }

  private newDom(url: string): JSDOM {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url });
    stampGlobals(dom);
    // Per-window layout stubs — a new window loses the previous ones.
    dom.window.Element.prototype.scrollIntoView = () => {};
    for (const prop of ["offsetWidth", "offsetHeight"] as const) {
      Object.defineProperty(dom.window.HTMLElement.prototype, prop, {
        get: () => 100,
        configurable: true,
      });
    }
    return dom;
  }

  private show(page: FakePage): void {
    const doc = this.dom.window.document;
    doc.title = page.title;
    doc.body.innerHTML = page.html;
    // Fresh page: the M3-2 DOM map and its URL stamp belong to the previous one.
    const w = this.dom.window as unknown as Record<string, unknown>;
    delete w.__junior_dom_map;
    delete w.__junior_dom_map_url;
    // Distinct y-stacked rects per element + an honest elementFromPoint scan
    // (the shared @junior/testkit/jsdom stub).
    stubStackedLayout(doc);
    page.onShow?.(doc);
  }
}
