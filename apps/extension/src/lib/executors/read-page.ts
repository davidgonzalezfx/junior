// lib/executors/read-page.ts — read_page support (plan §5.2 item 3).
//
// Modes:
// - "outline" | "interactive" → public/vendor/buildDomTree.js (vendored, see the
//   NOTICE header there): builds the element index map `__junior_dom_map` and
//   returns compact `[index] tag "text" (href)` lines. Run through
//   ExecutorEnv.runBuildDomTree (executeScript {files} + a call), serialized in-page.
// - "text" | "section" → juniorReadTextInPage below: rendered text of body (or a
//   selector) / of a querySelector subtree, capped at maxChars.
//
// juniorReadTextInPage is SELF-CONTAINED by the same contract as juniorActionInPage
// (executeScript serializes only the function body — no module-scope references;
// serialization.test.ts rebuilds it from source to prove it), which keeps it
// directly unit-testable against jsdom.
//
// The map cache invalidation contract: buildDomTree stamps
// `window.__junior_dom_map_url = location.href` on every build; the resolver
// (in-page.ts strategy 1) only trusts `__junior_dom_map` while that URL is current.

export interface ReadTextRequest {
  mode: "text" | "section";
  selector?: string;
  maxChars: number;
}

export type ReadTextResponse =
  | { ok: true; text: string; url: string }
  /** `noMatch`: the selector matched nothing here (another frame may have it). */
  | { ok: false; error: string; noMatch?: boolean };

/** Args for the vendored buildDomTree.js compact modes. */
export interface BuildDomTreeArgs {
  mode: "outline" | "interactive";
  maxChars: number;
}

/** What ExecutorEnv.runBuildDomTree resolves to (compact-mode result of the vendored script). */
export type BuildDomTreeResult = { text: string };

export async function juniorReadTextInPage(args: ReadTextRequest): Promise<ReadTextResponse> {
  // jsdom (tests) has no innerText — textContent is the fallback everywhere.
  function textOf(el: Element): string {
    return (el as HTMLElement).innerText || el.textContent || "";
  }

  function capWithNote(text: string, max: number): string {
    if (text.length <= max) return text;
    const note = ` ... [truncated at ${max} chars — raise maxChars or read a narrower section]`;
    // Never split a surrogate pair at the cut (same rule as protocol safeSlice) —
    // a lone surrogate would serialize to invalid UTF-8 downstream.
    let cut = text.slice(0, Math.max(0, max - note.length));
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut + note;
  }

  const maxChars = args.maxChars;
  const selector = (args.selector || "").trim();

  if (args.mode === "section" && !selector) {
    return { ok: false, error: 'read_page mode "section" requires a selector' };
  }

  let target: Element | null;
  if (selector) {
    try {
      target = document.querySelector(selector);
    } catch {
      return { ok: false, error: `Invalid selector: ${JSON.stringify(selector.slice(0, 80))}` };
    }
    if (!target) {
      return {
        ok: false,
        error: `No element matches selector: ${JSON.stringify(selector.slice(0, 80))}`,
        noMatch: true,
      };
    }
  } else {
    target = document.body || document.documentElement;
  }
  if (!target) return { ok: false, error: "The page has no readable content" };

  // §6.3-6: size-capped payloads everywhere — collapse whitespace so a
  // whitespace-heavy page can't waste the whole budget.
  const raw = textOf(target).replace(/\s+/g, " ").trim();
  return { ok: true, text: capWithNote(raw, maxChars), url: window.location.href };
}
