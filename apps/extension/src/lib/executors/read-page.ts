// lib/executors/read-page.ts — read_page support (plan §5.2 item 3, M3-2).
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
// (executeScript serializes only the function body — no module-scope references),
// which keeps it directly unit-testable against jsdom.
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
  { ok: true; text: string; url: string } | { ok: false; error: string };

/** Args for the vendored buildDomTree.js compact modes. */
export interface BuildDomTreeArgs {
  mode: "outline" | "interactive";
  maxChars: number;
}

/** What ExecutorEnv.runBuildDomTree resolves to (compact-mode result of the vendored script). */
export type BuildDomTreeResult = { text: string };

const TRUNCATION_NOTE = " ... [truncated at %d chars — raise maxChars or read a narrower section]";

function capWithNote(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const note = TRUNCATION_NOTE.replace("%d", String(maxChars));
  return text.slice(0, Math.max(0, maxChars - note.length)) + note;
}

export async function juniorReadTextInPage(args: ReadTextRequest): Promise<ReadTextResponse> {
  // jsdom (tests) has no innerText — textContent is the fallback everywhere.
  function textOf(el: Element): string {
    return (el as HTMLElement).innerText || el.textContent || "";
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
