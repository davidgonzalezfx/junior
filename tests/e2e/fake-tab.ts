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
  /** T5a: child frames, keyed to an `<iframe id>` in `html`. */
  frames?: FakeFrame[];
}

/** One iframe document. A frame whose origin matches the page lives in the
 * iframe's own contentWindow (so the parent can read it and `frameElement` is
 * set, as in Chrome); any other origin gets a separate JSDOM realm the parent
 * cannot reach. jsdom does not load iframe `src`, so `url` is what listFrames
 * reports (Chrome's frame URL); a same-origin realm itself stays about:blank. */
export interface FakeFrame {
  /** The Chrome frameId this frame reports (0 is the top frame — never use it). */
  frameId: number;
  url: string;
  iframeId: string;
  html: string;
  onShow?: (doc: Document) => void;
}

/** A frame as the harness's listFrames/executeScript seams see it. */
export interface FakeFrameRealm {
  frameId: number;
  url: string;
  window: Window;
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

function stampGlobals(win: Window): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (NODE_OWN_GLOBALS.has(key) && !FORCE_STAMP.has(key)) continue;
    try {
      g[key] = (win as unknown as Record<string, unknown>)[key];
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
  private childFrames: FakeFrameRealm[] = [];

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
  focus(frameId = 0): void {
    stampGlobals(this.realm(frameId));
  }

  /** Every frame of the current page, top first (frameId 0) — what
   * executeScript({allFrames:true}) would visit. */
  frames(): FakeFrameRealm[] {
    const top = this.dom.window as unknown as Window;
    return [{ frameId: 0, url: this.url, window: top }, ...this.childFrames];
  }

  /** The document of one frame (0 = top). */
  frameDocument(frameId: number): Document {
    return this.realm(frameId).document;
  }

  /** Evaluates the REAL vendored buildDomTree into the focused window, idempotent
   * per window — mirrors executeScript({files:["vendor/buildDomTree.js"]}). */
  injectBuildDomTree(frameId = 0): void {
    const w = this.realm(frameId) as unknown as Record<string, unknown>;
    if (!w.buildDomTree) new Function(BUILD_DOM_TREE_SOURCE)();
  }

  /** Throws like executeScript does for a frameId the tab doesn't have. */
  private realm(frameId: number): Window {
    if (frameId === 0) return this.dom.window as unknown as Window;
    const f = this.childFrames.find((c) => c.frameId === frameId);
    if (!f) throw new Error(`No frame with id ${frameId} in tab.`);
    return f.window;
  }

  private newDom(url: string): JSDOM {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url });
    stampGlobals(dom.window as unknown as Window);
    stubWindow(dom.window as unknown as Window);
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
    this.childFrames = (page.frames ?? []).map((f) => this.mountFrame(doc, f));
    stampGlobals(this.dom.window as unknown as Window);
    page.onShow?.(doc);
  }

  private mountFrame(parent: Document, f: FakeFrame): FakeFrameRealm {
    const iframe = parent.getElementById(f.iframeId) as HTMLIFrameElement | null;
    if (!iframe) throw new Error(`FakeFrame: no <iframe id="${f.iframeId}"> in the page`);
    let win: Window;
    if (new URL(f.url).origin === new URL(this.url).origin && iframe.contentWindow) {
      win = iframe.contentWindow;
    } else {
      win = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: f.url })
        .window as unknown as Window;
    }
    stubWindow(win);
    if (!win.document.body) {
      // jsdom's initial about:blank frame document has no <body> yet.
      win.document.open();
      win.document.write("<!doctype html><html><head></head><body></body></html>");
      win.document.close();
    }
    win.document.body.innerHTML = f.html;
    stubStackedLayout(win.document);
    f.onShow?.(win.document);
    return { frameId: f.frameId, url: f.url, window: win };
  }
}

/** Per-window layout stubs — every realm has its own prototypes. */
function stubWindow(win: Window): void {
  const w = win as unknown as typeof globalThis;
  w.Element.prototype.scrollIntoView = () => {};
  for (const prop of ["offsetWidth", "offsetHeight"] as const) {
    Object.defineProperty(w.HTMLElement.prototype, prop, {
      get: () => 100,
      configurable: true,
    });
  }
}
