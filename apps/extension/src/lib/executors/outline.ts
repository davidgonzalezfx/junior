// lib/executors/outline.ts — outline/interactive read_page entry (T5b).
//
// juniorBuildOutlineInPage runs in the page right after public/vendor/buildDomTree.js
// is injected: it installs `window.__junior_label_of` and then calls
// window.buildDomTree(args). The vendored compact serializer asks that hook for a
// fallback label whenever an element has no readable text — icon-only player
// buttons otherwise print as a bare `[12] button`, and picking Play/Pause becomes
// guesswork. The labeling lives here (Junior code, unit-testable) so the vendored
// patch stays a single call site.
//
// SELF-CONTAINED by the executeScript contract (see in-page.ts):
// serialization.test.ts rebuilds it from source to prove it.
import type { BuildDomTreeArgs } from "./read-page";

export function juniorBuildOutlineInPage(args: BuildDomTreeArgs): unknown {
  function clean(s: string | null | undefined): string {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function quoted(s: string): string {
    return JSON.stringify(clean(s).slice(0, 60));
  }

  /** `#icon-play` / `sprite.svg#ic_pause` → `play` / `pause`. */
  function iconName(ref: string): string {
    const id = ref.slice(ref.lastIndexOf("#") + 1);
    return id.replace(/^(?:icon|ico|ic|svg)[-_]?/i, "").slice(0, 40);
  }

  const ICON_CLASS = /(?:^|\s)(?:icon|ico|fa|bi|mdi|ud-icon|vjs-icon)[-_]([a-z0-9][a-z0-9-]*)/i;
  const CONTROL_WORD =
    /\b(play|pause|mute|unmute|volume|fullscreen|exit-fullscreen|next|prev(?:ious)?|rewind|forward|seek|settings|captions?|subtitles?|transcript|speed|replay|close|menu|search)\b/i;

  /** Fallback label for an element with no readable text: name-like attributes
   * first, then structural hints. Empty when there is nothing useful. */
  function labelOf(el: Element): string {
    const parts: string[] = [];
    const add = (key: string, value: string) => {
      const v = clean(value);
      if (v && parts.length < 3 && !parts.some((p) => p.endsWith(quoted(v))))
        parts.push(`${key}=${quoted(v)}`);
    };
    const get = (name: string) => el.getAttribute(name) || "";

    add("aria-label", get("aria-label"));
    const labelledBy = get("aria-labelledby");
    if (labelledBy) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const text = labelledBy
        .split(/\s+/)
        .map((id) => root.getElementById?.(id)?.textContent || "")
        .join(" ");
      add("labelledby", text);
    }
    add("title", get("title"));
    // Text the page hides visually but keeps for screen readers (sr-only spans).
    const hidden = el.textContent || "";
    if (/[\p{L}\p{N}]/u.test(hidden)) add("hidden-text", hidden);
    const img = el.querySelector("img[alt], svg title");
    if (img) add("alt", img.getAttribute("alt") || img.textContent || "");
    add("data-purpose", get("data-purpose"));
    add("data-testid", get("data-testid"));

    const use = el.querySelector("use");
    const href = use ? use.getAttribute("href") || use.getAttribute("xlink:href") || "" : "";
    if (href.includes("#")) add("icon", iconName(href));
    for (const node of [el, ...Array.from(el.querySelectorAll("svg, i, span"))]) {
      const cls = typeof node.className === "string" ? node.className : node.getAttribute("class");
      const m = ICON_CLASS.exec(cls || "") || CONTROL_WORD.exec(cls || "");
      if (m) {
        add("icon", (m[1] || m[0]).toLowerCase());
        break;
      }
    }

    for (const state of ["aria-pressed", "aria-checked", "aria-expanded"]) {
      const v = get(state);
      if (v) parts.push(`${state.slice(5)}=${v === "true" ? "true" : "false"}`);
    }
    return parts.join(" ");
  }

  const win = window as unknown as {
    __junior_label_of?: (el: Element) => string;
    buildDomTree?: (a: BuildDomTreeArgs) => unknown;
  };
  win.__junior_label_of = labelOf;
  if (typeof win.buildDomTree !== "function") return null;
  return win.buildDomTree(args);
}
