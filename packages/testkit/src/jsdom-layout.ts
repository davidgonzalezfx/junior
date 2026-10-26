// jsdom layout stubs — the single home for the M3-1-era per-element rect stubbing
// that used to live copy-pasted in tests/e2e/fake-tab.ts, read-page.test.ts and
// in-page.test.ts. Two shapes exist on purpose (workplan C2: don't unify away
// genuine per-test differences): y-stacked rects when a test hit-tests through
// elementFromPoint, and the fixed origin rect when it clicks elements directly.

/** Distinct y-stacked rects per element + an honest elementFromPoint scan. */
export function stubStackedLayout(doc: Document): void {
  const els = Array.from(doc.body.querySelectorAll("*"));
  els.forEach((el, i) => {
    const top = (i + 1) * 30;
    const rect = {
      width: 100,
      height: 20,
      top,
      left: 0,
      right: 100,
      bottom: top + 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
    el.getBoundingClientRect = () => rect;
    el.getClientRects = () => [rect] as unknown as DOMRectList;
  });
  doc.elementFromPoint = ((x: number, y: number) => {
    for (const el of doc.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  }) as unknown as Document["elementFromPoint"];
}

/** One fixed 100×20 rect at the origin — the in-page resolver pattern, where
 * every element overlaps on purpose (clicks target the element directly). */
export function makeVisible(el: Element): void {
  el.getBoundingClientRect = () =>
    ({
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** jsdom prototype gaps every executor/panel test bridges: no scrollIntoView, and
 * (when the caller's code reads element boxes, e.g. buildDomTree's
 * isElementVisible) no offsetWidth/Height. `offsetSize` off by default so a
 * caller never silently starts passing a visibility check it didn't have before. */
export function stubJsdomElementBasics(opts: { offsetSize?: boolean } = {}): void {
  Element.prototype.scrollIntoView = () => {};
  if (opts.offsetSize) {
    for (const prop of ["offsetWidth", "offsetHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        get: () => 100,
        configurable: true,
      });
    }
  }
}

export interface FakeMediaOptions {
  duration?: number;
  /** play() rejects with NotAllowedError unless muted (Chrome's autoplay policy
   * for a page without a user gesture). */
  autoplayBlocked?: boolean;
  /** play() never settles (a stalled stream). */
  stalled?: boolean;
}

/** jsdom implements no media playback (play/pause log "not implemented"): give
 * one element a working paused/currentTime/duration model. */
export function fakeMedia(el: HTMLMediaElement, opts: FakeMediaOptions = {}): void {
  let paused = true;
  let time = 0;
  const define = (name: string, get: () => unknown, set?: (v: never) => void) =>
    Object.defineProperty(el, name, { configurable: true, get, set });
  define("paused", () => paused);
  define("duration", () => opts.duration ?? 600);
  define("readyState", () => 4);
  define(
    "currentTime",
    () => time,
    (v: number) => {
      time = v;
      // The element's own realm's Event (a test may run several jsdom windows).
      const Ev = (el.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event;
      queueMicrotask(() => el.dispatchEvent(new Ev("seeked")));
    },
  );
  el.play = () => {
    if (opts.stalled) return new Promise<void>(() => {});
    if (opts.autoplayBlocked && !el.muted) {
      const err = new Error(
        "play() failed because the user didn't interact with the document first.",
      );
      err.name = "NotAllowedError";
      return Promise.reject(err);
    }
    paused = false;
    return Promise.resolve();
  };
  el.pause = () => {
    paused = true;
  };
}
