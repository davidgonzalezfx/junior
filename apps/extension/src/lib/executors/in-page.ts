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
// contract — splitting it would break executeScript serialization. See
// docs/decisions.md 2026-10-23 for the deltas vs Autono's duplicated per-op copies.
//
// Junior deltas vs Autono (deliberate):
// - the DOM map is `window.__junior_dom_map` (M3-2 vendored buildDomTree), not
//   Autono's `__antigravity_dom_map`;
// - the visible mouse-cursor animation is not ported (not in plan §6.1 copy list);
// - the A19 abort-sequence flag is not ported — §5.2 item 6 puts pause in the SW
//   (it stops polling and denies items), not in the page;
// - typing cadence is parameterized (`charDelayMs`) so tests run at 0 ms; prod
//   keeps Autono's human-like rhythm (reacts better with React controlled inputs).

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

  // ── Multi-strategy resolver (Autono background.js:4222–4340) ────────────────
  // Strategies in order: 1 index map → 2 CSS → 3 XPath → 4 semantic attributes →
  // 5 associated <label> → 6 visible text (3 passes) → 7 heuristic interactivity
  // (click pool only) → 8 input fallback (type pool only).
  function findInteractiveElement(target: string, isInputOnly: boolean): Element | null {
    const rawTarget = String(target || "").trim();
    // Empty target is only meaningful for the input pool (strategy 8: focused field
    // / single visible input). Junior delta vs Autono: attribute/text matches below
    // require a non-empty target, so "" can't accidentally match an attribute-less field.
    if (!rawTarget && !isInputOnly) return null;
    const lowerTarget = rawTarget.toLowerCase();

    // 1. Index match ([12], #12, 12, el-12)
    const indexMatch = rawTarget.match(/^(?:\[|#|el-)?(\d+)(?:\])?$/);
    if (indexMatch && indexMatch[1] !== undefined) {
      const idx = parseInt(indexMatch[1], 10);
      const indexedEl = document.querySelector(
        `[data-highlight-index="${idx}"], [data-index="${idx}"], [highlight-index="${idx}"]`,
      );
      if (indexedEl && isVisible(indexedEl)) return indexedEl;
      // The map is a cache stamped with the URL it was built for (vendored
      // buildDomTree.js) — a SPA URL change invalidates it (plan §5.2).
      const win = window as unknown as {
        __junior_dom_map?: Map<number, Element>;
        __junior_dom_map_url?: string;
      };
      const map = win.__junior_dom_map;
      if (map && win.__junior_dom_map_url === window.location.href && map.has(idx)) {
        const el = map.get(idx);
        if (el && isVisible(el)) return el;
      }
    }

    // 2. Safe CSS selector
    if (!rawTarget.includes("\n")) {
      try {
        const el = document.querySelector(rawTarget);
        if (el && isVisible(el)) return el;
      } catch {
        /* invalid selector — fall through */
      }
    }

    // 3. XPath locator
    if (
      rawTarget.startsWith("/") ||
      rawTarget.startsWith("./") ||
      rawTarget.startsWith("(") ||
      rawTarget.toLowerCase().startsWith("xpath=")
    ) {
      try {
        const cleanXpath = rawTarget.replace(/^xpath=/i, "");
        const res = document.evaluate(
          cleanXpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        if (res.singleNodeValue && isVisible(res.singleNodeValue as Element))
          return res.singleNodeValue as Element;
      } catch {
        /* invalid xpath — fall through */
      }
    }

    // Candidate pools
    const CLICK_POOL =
      'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"], summary, label, [tabindex]:not([tabindex="-1"])';
    const INPUT_POOL =
      'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], select';
    const candidates = Array.from(document.querySelectorAll(isInputOnly ? INPUT_POOL : CLICK_POOL));

    // 4. Semantic attribute match (id, name, placeholder, aria-label, data-testid, title, alt, value)
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const id = (el.id || "").toLowerCase();
      const name = attr(el, "name").toLowerCase();
      const ph = attr(el, "placeholder").toLowerCase();
      const aria = attr(el, "aria-label").toLowerCase();
      const testId = (
        attr(el, "data-testid") ||
        attr(el, "data-qa") ||
        attr(el, "data-cy")
      ).toLowerCase();
      const title = attr(el, "title").toLowerCase();
      const alt = attr(el, "alt").toLowerCase();
      const val = ((el as HTMLInputElement).value || "").toLowerCase();

      if (
        lowerTarget &&
        (id === lowerTarget ||
          name === lowerTarget ||
          ph === lowerTarget ||
          aria === lowerTarget ||
          testId === lowerTarget ||
          title === lowerTarget ||
          val === lowerTarget)
      ) {
        return el;
      }
      if (
        lowerTarget &&
        ((ph && ph.includes(lowerTarget)) ||
          (aria && aria.includes(lowerTarget)) ||
          (name && name.includes(lowerTarget)) ||
          (title && title.includes(lowerTarget)) ||
          (testId && testId.includes(lowerTarget)) ||
          (alt && alt.includes(lowerTarget)))
      ) {
        return el;
      }
    }

    // 5. Associated <label> match
    if (isInputOnly || candidates.some((c) => c.tagName === "INPUT" || c.tagName === "TEXTAREA")) {
      const labels = Array.from(document.querySelectorAll("label"));
      for (const lbl of labels) {
        if (!isVisible(lbl)) continue;
        const lblText = clean(textOf(lbl)).toLowerCase();
        if (lowerTarget && (lblText.includes(lowerTarget) || lowerTarget.includes(lblText))) {
          const htmlFor = attr(lbl, "for");
          if (htmlFor) {
            const inp = document.getElementById(htmlFor);
            if (inp && isVisible(inp)) return inp;
          }
          const innerInp = lbl.querySelector("input, textarea, select");
          if (innerInp && isVisible(innerInp)) return innerInp;
        }
      }
    }

    // 6. Smart visible text match (exact → prefix/suffix → substring)
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = clean(textOf(el)).toLowerCase();
      if (lowerTarget && txt === lowerTarget) return el;
    }
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = clean(textOf(el)).toLowerCase();
      if (lowerTarget && txt && (txt.startsWith(lowerTarget) || lowerTarget.startsWith(txt)))
        return el;
    }
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = clean(textOf(el)).toLowerCase();
      if (lowerTarget && txt && (txt.includes(lowerTarget) || lowerTarget.includes(txt))) return el;
    }

    // 7. Heuristic interactivity (click pool only — pointer cursor / class / onclick)
    if (!isInputOnly) {
      const allDivs = Array.from(document.querySelectorAll("div, span, p, li, td, th"));
      for (const el of allDivs) {
        if (!isVisible(el)) continue;
        const style = window.getComputedStyle(el);
        const hasPointer = style.cursor === "pointer";
        const hasClass = /\b(btn|button|clickable|menu-item|item|entry|link|submit|search)\b/i.test(
          el.className || "",
        );
        if (hasPointer || hasClass || typeof (el as HTMLElement).onclick === "function") {
          const txt = clean(textOf(el)).toLowerCase();
          if (
            lowerTarget &&
            (txt === lowerTarget || (txt && txt.includes(lowerTarget) && txt.length < 90))
          ) {
            const btnParent = el.closest('button, a, [role="button"]');
            return btnParent || el;
          }
        }
      }
    }

    // 8. Input fallback (type pool only): focused field, else the single visible input
    if (isInputOnly) {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      ) {
        return active;
      }
      const visibleInputs = candidates.filter((c) => {
        if (!isVisible(c)) return false;
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
      if (visibleInputs.length === 1 && first) return first;
    }

    return null;
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

  function notFound(kind: string, target: string): InPageResponse {
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
    const el = findInteractiveElement(args.target, args.mode === "type");
    if (!el) return notFound(args.mode === "type" ? "Text field" : "Element", args.target);
    return {
      ok: true,
      message: "probed",
      facts: args.mode === "type" ? fieldFactsOf(el) : clickFactsOf(el),
    };
  }

  if (args.op === "click") {
    const el = findInteractiveElement(args.target, false);
    if (!el) return notFound("Element", args.target);
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

    // Page-derived fragment: ≤ 60 chars, no newlines, JSON-encoded (Autono A17).
    const label =
      textOf(el) ||
      (el as HTMLInputElement).value ||
      attr(el, "placeholder") ||
      attr(el, "aria-label") ||
      args.target;
    return {
      ok: true,
      message: `Click performed on ${JSON.stringify(clean(label || args.target).slice(0, 60))}`,
    };
  }

  // op === "type"
  const el = findInteractiveElement(args.target, true);
  if (!el) return notFound("Text field", args.target);
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

  const label = attr(el, "placeholder") || attr(el, "name") || attr(el, "id") || args.target;
  return {
    ok: true,
    message: `Typed text in field ${JSON.stringify(clean(label).slice(0, 60))}: ${JSON.stringify(clean(cleanText).slice(0, 30))}`,
  };
}
