// lib/executors/in-page.ts — the single entrypoint that runs INSIDE the target tab
// (plan §5.2 item 3, executor port). Port of Autono background.js:4222–4340 (the
// multi-strategy element resolver) and 4360–4743 (click/type/scroll), unified into
// one function with an `op` discriminator so click/type share a single resolver.
//
// SELF-CONTAINED BY CONTRACT: chrome.scripting.executeScript({func}) serializes the
// function body alone — nothing inside juniorActionInPage may reference module
// scope, imports or helpers defined outside it. It must stay a plain function over
// its `args` and the page's DOM globals. That also makes it directly unit-testable
// against jsdom.
//
// NOTE (file >400 lines, protocol definition-of-done): this file is one function by
// contract — splitting it would break executeScript serialization.
//
// Deliberate properties (not accidents of the port):
// - pause lives in the SW (it stops polling and denies items), not in the page —
//   there is no in-page abort flag;
// - typing cadence is parameterized (`charDelayMs`) so tests run at 0 ms; prod
//   keeps a human-like rhythm (reacts better with React controlled inputs).

export interface InPageClickFacts {
  tag: string;
  type: string;
  text: string;
  ariaLabel: string;
  title: string;
  href: string;
  formAction: string;
  isSubmit: boolean;
}

export interface InPageFieldFacts {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  formAction: string;
}

export type InPageRequest =
  | { op: "probe"; mode: "click" | "type"; target: string }
  | { op: "click"; target: string; expect: InPageClickFacts | null }
  | {
      op: "type";
      target: string;
      text: string;
      expect: InPageFieldFacts | null;
      charDelayMs?: number;
    }
  | { op: "scroll"; direction: "up" | "down"; amount?: number };

export type InPageResponse =
  | { ok: true; message: string; facts?: InPageClickFacts | InPageFieldFacts }
  | { ok: false; error: string };

export async function juniorActionInPage(args: InPageRequest): Promise<InPageResponse> {
  function isVisible(el: Element | null): boolean {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clean(str: string | null | undefined): string {
    return (str || "").replace(/\s+/g, " ").trim();
  }

  // jsdom (tests) has no innerText — textContent is the fallback everywhere.
  function textOf(el: Element): string {
    return (el as HTMLElement).innerText || el.textContent || "";
  }

  function attr(el: Element, name: string): string {
    try {
      return Element.prototype.getAttribute.call(el, name) || "";
    } catch {
      return "";
    }
  }

  function absolute(v: string): string {
    try {
      return v ? new URL(v, document.baseURI).href : "";
    } catch {
      return "";
    }
  }

  // ── Element resolver (Autono background.js:4222–4340, made strict in T5b) ────
  // Precise targets never fall through to fuzzy matching — a miss is an error:
  // - index (`12`, `[12]`, `#12`, `el-12`): the URL-stamped __junior_dom_map only.
  //   buildDomTree never removes old `data-highlight-index` attributes, so after
  //   a re-read the attribute can sit on an element that index no longer names.
  // - CSS selector / XPath: first VISIBLE match, open shadow roots included.
  // Free text (or `text:…`) runs the fuzzy passes, exact before partial:
  // attribute → text → <label> → attribute substring → text prefix → text
  // substring → heuristic interactivity (click) / input fallback (type).
  type Resolved = { el: Element; strategy: string } | { error: string };

  function shadowRoots(): (Document | ShadowRoot)[] {
    const roots: (Document | ShadowRoot)[] = [document];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i] as Document | ShadowRoot;
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  /** querySelectorAll across the document and every open shadow root (throws on
   * an invalid selector, like querySelectorAll). */
  function deepQueryAll(selector: string): Element[] {
    return shadowRoots().flatMap((r) => Array.from(r.querySelectorAll(selector)));
  }

  function isCssSelector(t: string): boolean {
    try {
      document.querySelector(t);
    } catch {
      return false; // "Save & continue", "1.5x", "Next ›" are not selectors
    }
    if (/[#[\]>~+*=():]/.test(t)) return true;
    // Words and dots only ("Play", "Sign in", "example.com"): a selector only
    // when every compound starts with a class or a lowercase known tag name.
    return t.split(/\s+/).every((part) => {
      const type = part.split(".")[0] ?? "";
      if (!type) return true;
      if (type !== type.toLowerCase()) return false;
      if (type.includes("-")) return document.getElementsByTagName(type).length > 0;
      return !(document.createElement(type) instanceof HTMLUnknownElement);
    });
  }

  function isXPath(t: string): boolean {
    if (!/^(\/|\.\/|\(|xpath=)/i.test(t)) return false;
    try {
      document.evaluate(t.replace(/^xpath=/i, ""), document, null, XPathResult.ANY_TYPE, null);
      return true;
    } catch {
      return false; // "(1) Notifications" is text
    }
  }

  function missed(kind: string, t: string, hidden: number): Resolved {
    const quoted = JSON.stringify(t.slice(0, 80));
    const why = hidden ? ` (${hidden} hidden match${hidden === 1 ? "" : "es"})` : "";
    return {
      error:
        `${kind} ${quoted} matched nothing visible${why}. Nothing was clicked — there is no ` +
        `fallback to text matching. read_page for current targets, prefix "text:" to match ` +
        `visible text, or use the media tool for video/audio.`,
    };
  }

  function findInteractiveElement(target: string, isInputOnly: boolean): Resolved | null {
    let rawTarget = String(target || "").trim();
    let freeText = false;
    if (/^text:/i.test(rawTarget)) {
      rawTarget = rawTarget.slice(5).trim();
      freeText = true;
    }
    // Empty target is only meaningful for the input pool (focused field / single
    // visible input), so "" can't accidentally match an attribute-less field.
    if (!rawTarget && !isInputOnly) return null;
    const lowerTarget = rawTarget.toLowerCase();

    if (!freeText) {
      const indexMatch = rawTarget.match(/^(?:\[|#|el-)?(\d+)(?:\])?$/);
      if (indexMatch && indexMatch[1] !== undefined) {
        const idx = parseInt(indexMatch[1], 10);
        // The map is a cache stamped with the URL it was built for (vendored
        // buildDomTree.js) — a SPA URL change invalidates it (plan §5.2).
        const win = window as unknown as {
          __junior_dom_map?: Map<number, Element>;
          __junior_dom_map_url?: string;
        };
        const map = win.__junior_dom_map;
        const el = map && win.__junior_dom_map_url === window.location.href ? map.get(idx) : null;
        if (!el || !el.isConnected)
          return { error: `Index ${idx} not found — read_page again for current targets.` };
        if (!isVisible(el))
          return {
            error: `Index ${idx} is no longer visible — read_page again for current targets.`,
          };
        return { el, strategy: "index" };
      }

      if (isXPath(rawTarget)) {
        const res = document.evaluate(
          rawTarget.replace(/^xpath=/i, ""),
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        for (let i = 0; i < res.snapshotLength; i++) {
          const node = res.snapshotItem(i) as Element | null;
          if (node && isVisible(node)) return { el: node, strategy: "xpath" };
        }
        return missed("XPath", rawTarget, res.snapshotLength);
      }

      if (!rawTarget.includes("\n") && isCssSelector(rawTarget)) {
        const matches = deepQueryAll(rawTarget);
        const el = matches.find(isVisible);
        if (el) return { el, strategy: "css" };
        return missed("Selector", rawTarget, matches.length);
      }
    }

    // Candidate pools (open shadow roots included)
    const CLICK_POOL =
      'button, a, input, textarea, select, video, audio, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"], summary, label, [tabindex]:not([tabindex="-1"])';
    const INPUT_POOL =
      'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], select';
    const candidates = deepQueryAll(isInputOnly ? INPUT_POOL : CLICK_POOL).filter(isVisible);
    if (!lowerTarget) return inputFallback(candidates);

    // Exact attribute values, then substrings — for each candidate in order.
    // [id, name, placeholder, aria-label, test id, title, alt, value]
    const attrValues = (el: Element) => [
      (el.id || "").toLowerCase(),
      attr(el, "name").toLowerCase(),
      attr(el, "placeholder").toLowerCase(),
      attr(el, "aria-label").toLowerCase(),
      (
        attr(el, "data-testid") ||
        attr(el, "data-qa") ||
        attr(el, "data-cy") ||
        attr(el, "data-purpose")
      ).toLowerCase(),
      attr(el, "title").toLowerCase(),
      attr(el, "alt").toLowerCase(),
      ((el as HTMLInputElement).value || "").toLowerCase(),
    ];
    for (const el of candidates) {
      if (attrValues(el).includes(lowerTarget)) return { el, strategy: "attribute" };
    }
    const textOfCandidate = (el: Element) => clean(textOf(el)).toLowerCase();
    for (const el of candidates) {
      if (textOfCandidate(el) === lowerTarget) return { el, strategy: "text" };
    }

    // Associated <label> match
    if (isInputOnly || candidates.some((c) => c.tagName === "INPUT" || c.tagName === "TEXTAREA")) {
      const labels = deepQueryAll("label");
      for (const lbl of labels) {
        if (!isVisible(lbl)) continue;
        const lblText = clean(textOf(lbl)).toLowerCase();
        if (lblText && (lblText.includes(lowerTarget) || lowerTarget.includes(lblText))) {
          const htmlFor = attr(lbl, "for");
          if (htmlFor) {
            const inp = document.getElementById(htmlFor);
            if (inp && isVisible(inp)) return { el: inp, strategy: "label" };
          }
          const innerInp = lbl.querySelector("input, textarea, select");
          if (innerInp && isVisible(innerInp)) return { el: innerInp, strategy: "label" };
        }
      }
    }

    for (const el of candidates) {
      if (attrValues(el).some((v, i) => i > 0 && i < 7 && v.includes(lowerTarget)))
        return { el, strategy: "attribute" };
    }
    // Reverse containment ("Sign up now" → a "Sign up" button) needs a few
    // characters, or a lone "0" link would match any target containing a zero.
    const contains = (outer: string, inner: string) => inner.length >= 3 && outer.includes(inner);
    for (const el of candidates) {
      const txt = textOfCandidate(el);
      if (txt && (txt.startsWith(lowerTarget) || (txt.length >= 3 && lowerTarget.startsWith(txt))))
        return { el, strategy: "text" };
    }
    for (const el of candidates) {
      const txt = textOfCandidate(el);
      if (txt && (txt.includes(lowerTarget) || contains(lowerTarget, txt)))
        return { el, strategy: "text" };
    }

    // Heuristic interactivity (click pool only — pointer cursor / class / onclick)
    if (!isInputOnly) {
      const allDivs = deepQueryAll("div, span, p, li, td, th");
      for (const el of allDivs) {
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        const hasPointer = style.cursor === "pointer";
        const hasClass = /\b(btn|button|clickable|menu-item|item|entry|link|submit|search)\b/i.test(
          typeof el.className === "string" ? el.className : "",
        );
        if (hasPointer || hasClass || typeof (el as HTMLElement).onclick === "function") {
          const txt = textOfCandidate(el);
          if (txt === lowerTarget || (txt && txt.includes(lowerTarget) && txt.length < 90)) {
            const btnParent = el.closest('button, a, [role="button"]');
            return { el: btnParent || el, strategy: "heuristic" };
          }
        }
      }
      return null;
    }
    return inputFallback(candidates);
  }

  /** Type pool only: the focused field, else the single visible text input. */
  function inputFallback(candidates: Element[]): Resolved | null {
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        (active as HTMLElement).isContentEditable)
    ) {
      return { el: active, strategy: "focused field" };
    }
    const visibleInputs = candidates.filter((c) => {
      const type = attr(c, "type").toLowerCase();
      return (
        type !== "hidden" &&
        type !== "submit" &&
        type !== "button" &&
        type !== "checkbox" &&
        type !== "radio"
      );
    });
    const first = visibleInputs[0];
    if (visibleInputs.length === 1 && first) return { el: first, strategy: "only field" };
    return null;
  }

  /** `<a> "Home" → https://…/ (matched by text)` — what a click/type landed on. */
  function describeHit(el: Element, strategy: string): string {
    const tag = String(el.tagName || "").toLowerCase();
    const label = clean(
      textOf(el) ||
        attr(el, "aria-label") ||
        attr(el, "title") ||
        attr(el, "placeholder") ||
        attr(el, "name") ||
        (el as HTMLInputElement).value ||
        "",
    ).slice(0, 60);
    const anchor = el.closest("a[href]");
    const href = anchor ? absolute(attr(anchor, "href")).slice(0, 200) : "";
    return (
      `<${tag}>` +
      (label ? ` ${JSON.stringify(label)}` : "") +
      (href ? ` → ${href}` : "") +
      ` (matched by ${strategy})`
    );
  }

  function clickFactsOf(el: Element): InPageClickFacts {
    const anchor = el.closest("a[href]");
    const form = (el as HTMLInputElement).form || el.closest("form");
    const type = attr(el, "type").toLowerCase();
    const tag = String(el.tagName || "").toLowerCase();
    return {
      tag,
      type,
      text: clean(textOf(el) || (el as HTMLInputElement).value || "").slice(0, 200),
      ariaLabel: attr(el, "aria-label").slice(0, 200),
      title: attr(el, "title").slice(0, 200),
      href: anchor ? absolute(attr(anchor, "href")) : "",
      formAction: form
        ? absolute(attr(el, "formaction") || attr(form, "action") || document.location.href)
        : "",
      isSubmit:
        !!form && (type === "submit" || type === "image" || (tag === "button" && type === "")),
    };
  }

  function fieldFactsOf(el: Element): InPageFieldFacts {
    const form = (el as HTMLInputElement).form || el.closest("form");
    let label: HTMLLabelElement | null = null;
    try {
      const id = attr(el, "id");
      label =
        (id &&
          (document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLLabelElement | null)) ||
        (el.closest("label") as HTMLLabelElement | null);
    } catch {
      /* malformed id — label stays null */
    }
    return {
      tag: String(el.tagName || "").toLowerCase(),
      type: attr(el, "type").toLowerCase(),
      name: attr(el, "name").slice(0, 120),
      id: attr(el, "id").slice(0, 120),
      autocomplete: attr(el, "autocomplete").toLowerCase().slice(0, 120),
      placeholder: attr(el, "placeholder").slice(0, 120),
      ariaLabel: attr(el, "aria-label").slice(0, 120),
      labelText: label ? clean(label.textContent).slice(0, 120) : "",
      formAction: form ? absolute(attr(form, "action") || document.location.href) : "",
    };
  }

  function resolve(
    target: string,
    isInputOnly: boolean,
  ): { el: Element; strategy: string } | { ok: false; error: string } {
    const found = findInteractiveElement(target, isInputOnly);
    if (found && "el" in found) return found;
    if (found) return { ok: false, error: found.error };
    const kind = isInputOnly ? "Text field" : "Element";
    return {
      ok: false,
      error: `${kind} not found: ${JSON.stringify(clean(target).slice(0, 60))}.`,
    };
  }

  // ── Ops ──────────────────────────────────────────────────────────────────────

  if (args.op === "scroll") {
    const base =
      typeof args.amount === "number" && args.amount > 0
        ? args.amount
        : Math.round(window.innerHeight * 0.7);
    const delta = args.direction === "up" ? -base : base;
    window.scrollBy({ top: delta, behavior: "smooth" });
    return { ok: true, message: `Scrolled ${args.direction === "up" ? "up" : "down"}` };
  }

  if (args.op === "probe") {
    const hit = resolve(args.target, args.mode === "type");
    if (!("el" in hit)) return hit;
    const el = hit.el;
    return {
      ok: true,
      message: describeHit(el, hit.strategy),
      facts: args.mode === "type" ? fieldFactsOf(el) : clickFactsOf(el),
    };
  }

  if (args.op === "click") {
    const hit = resolve(args.target, false);
    if (!("el" in hit)) return hit;
    const el = hit.el;
    const facts = clickFactsOf(el);

    // Guard contract (§6.3-1): the card showed real facts — refuse if the element
    // changed between probe and act (Autono background.js:4434).
    const expect = args.expect;
    if (
      expect &&
      (expect.tag !== facts.tag ||
        expect.text !== facts.text ||
        expect.href !== facts.href ||
        expect.formAction !== facts.formAction)
    ) {
      return {
        ok: false,
        error: "The element changed after it was shown to the user. Try again.",
      };
    }

    el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });

    // Brief highlight ring for visual feedback (Autono keeps 1200 ms).
    const prevOutline = (el as HTMLElement).style.outline;
    const prevBoxShadow = (el as HTMLElement).style.boxShadow;
    (el as HTMLElement).style.outline = "3px solid #38bdf8";
    (el as HTMLElement).style.boxShadow = "0 0 16px rgba(56, 189, 248, 0.85)";
    setTimeout(() => {
      (el as HTMLElement).style.outline = prevOutline;
      (el as HTMLElement).style.boxShadow = prevBoxShadow;
    }, 1200);

    const isTextInput =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    if (isTextInput) {
      (el as HTMLElement).focus();
      if (typeof (el as HTMLInputElement).select === "function") (el as HTMLInputElement).select();
    }

    const rect = el.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      // `view` omitted: optional in UIEventInit and jsdom rejects a cross-realm
      // window member; Chrome behaves identically without it.
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    // jsdom (tests) has no PointerEvent — MouseEvent fallback is behaviorally fine there.
    const PointerCtor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent;
    const pointer = (type: string) =>
      PointerCtor ? new PointerCtor(type, eventInit) : new MouseEvent(type, eventInit);

    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    if (isTextInput) el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    el.dispatchEvent(pointer("pointerup"));
    el.dispatchEvent(new MouseEvent("mouseup", eventInit));
    el.dispatchEvent(new MouseEvent("click", eventInit));
    try {
      (el as HTMLElement).click();
    } catch {
      /* a listener may throw — the synthetic sequence already ran */
    }

    // Page-derived fragments: label ≤ 60 chars, no newlines, JSON-encoded.
    return { ok: true, message: `Click performed on ${describeHit(el, hit.strategy)}` };
  }

  // op === "type"
  const hit = resolve(args.target, true);
  if (!("el" in hit)) return hit;
  const el = hit.el;
  const facts = fieldFactsOf(el);

  const expect = args.expect;
  if (
    expect &&
    (expect.tag !== facts.tag ||
      expect.type !== facts.type ||
      expect.name !== facts.name ||
      expect.id !== facts.id)
  ) {
    return { ok: false, error: "The field changed after it was shown to the user. Try again." };
  }

  el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
  (el as HTMLElement).focus();

  const rawText = args.text || "";
  const hasEnter = rawText.includes("\n");
  const cleanText = rawText.replace(/\r?\n$/, "");
  const baseDelay =
    typeof args.charDelayMs === "number" && args.charDelayMs >= 0 ? args.charDelayMs : -1;
  const delay = () => {
    if (baseDelay === 0) return 0;
    if (baseDelay > 0) return baseDelay;
    return Math.round(45 + Math.random() * 55); // Autono's human cadence
  };
  const wait = () => new Promise<void>((r) => setTimeout(r, delay()));

  if ((el as HTMLElement).isContentEditable) {
    document.execCommand("selectAll", false, "");
    for (const ch of Array.from(cleanText)) {
      document.execCommand("insertText", false, ch);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: ch,
        }),
      );
      if (baseDelay !== 0) await wait();
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  } else {
    // Set value via the native descriptor so React/Vue controlled inputs notice.
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setValue = (v: string) => {
      if (descriptor && descriptor.set) descriptor.set.call(el, v);
      else (el as HTMLInputElement).value = v;
    };

    let currentTyped = "";
    for (const ch of Array.from(cleanText)) {
      currentTyped += ch;
      setValue(currentTyped);
      try {
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: ch,
          }),
        );
      } catch {
        /* beforeinput unsupported — input below still fires */
      }
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: ch,
        }),
      );
      const keyInit = { key: ch, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
      el.dispatchEvent(new KeyboardEvent("keyup", keyInit));
      if (baseDelay !== 0) await wait();
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  if (hasEnter) {
    // Typing text containing "\n" ends with a submit (Autono's Enter behavior).
    const enterInit = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", enterInit));
    el.dispatchEvent(new KeyboardEvent("keyup", enterInit));
    const form = (el as HTMLInputElement).form;
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
      } catch {
        /* form may be invalid — the key events already fired */
      }
    }
  }

  return {
    ok: true,
    message: `Typed ${JSON.stringify(clean(cleanText).slice(0, 30))} into ${describeHit(el, hit.strategy)}`,
  };
}
