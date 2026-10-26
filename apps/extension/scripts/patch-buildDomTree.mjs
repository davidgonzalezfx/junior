// One-shot patcher: applies Junior's deltas to the vendored buildDomTree.js
// (plan §6.1). Run from apps/extension: node scripts/patch-buildDomTree.mjs
// Idempotency: anchors include Junior markers, so re-running is a no-op.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "public/vendor/buildDomTree.js";
let src = readFileSync(FILE, "utf8");

function replaceOnce(needle, replacement, doneMarker = replacement) {
  if (src.includes(doneMarker)) return; // already patched
  if (!src.includes(needle)) {
    throw new Error(`anchor not found:\n${needle}`);
  }
  src = src.replace(needle, replacement);
}

// ── Patch 1: attribution NOTICE header (plan §6.1: keep the header + add NOTICE;
//    upstream has none, so Junior's NOTICE carries the MIT lineage citation). ──
const NOTICE = `/*
 * Junior NOTICE — this file is vendored from Autono's \`Autono/buildDomTree.js\`
 * (1,505 lines, browser-use-derived interactive-element serializer, MIT lineage;
 * upstream path: autono-clone/Autono/buildDomTree.js, copied 2026-10-23).
 * Junior changes, all marked with "Junior:" comments below:
 *   1. highlighted interactive elements are recorded into
 *      \`window.__junior_dom_map\` (Autono brands this map \`__antigravity_dom_map\`)
 *      with a \`data-highlight-index\` attribute and a URL stamp so the element
 *      resolver can invalidate it on navigation;
 *   2. \`args.mode: "outline" | "interactive"\` returns a compact token-cheap
 *      serialization of the highlighted elements instead of the full DOM map;
 *   3. input values in interactive mode are masked for sensitive fields.
 * Everything between this notice and those changes is upstream code, unmodified.
 */

window.buildDomTree = (`;
replaceOnce("window.buildDomTree = (", NOTICE, "Junior NOTICE"); // patch 4 extends the list

// ── Patch 1b: tolerate partial args (Junior calls with {mode, maxChars} only —
//    upstream defaults apply ONLY when `args` itself is omitted, so absent
//    startHighlightIndex made highlightIndex NaN and collapsed the map to one
//    NaN-keyed entry; viewportExpansion undefined poisons NaN comparisons too). ──
replaceOnce(
  `  let highlightIndex = startHighlightIndex; // Reset highlight index`,
  `  let highlightIndex = typeof startHighlightIndex === 'number' ? startHighlightIndex : 0; // Reset highlight index (Junior: tolerate absent startHighlightIndex)`,
);
replaceOnce(
  `  const { showHighlightElements, focusHighlightIndex, viewportExpansion, startHighlightIndex, startId, debugMode } =
    args;`,
  `  const { showHighlightElements, focusHighlightIndex, startId, debugMode } = args;
  const viewportExpansion = typeof args.viewportExpansion === 'number' ? args.viewportExpansion : 0; // Junior: numeric default (see NOTICE)
  const startHighlightIndex = typeof args.startHighlightIndex === 'number' ? args.startHighlightIndex : 0; // Junior`,
);

// ── Patch 2: record highlighted elements into __junior_dom_map (+ attribute). ──
replaceOnce(
  `      if (nodeData.isInViewport || viewportExpansion === -1) {
        nodeData.highlightIndex = highlightIndex++;`,
  `      if (nodeData.isInViewport || viewportExpansion === -1) {
        nodeData.highlightIndex = highlightIndex++;
        // Junior: element index map for the resolver (see the NOTICE above).
        if (!window.__junior_dom_map) window.__junior_dom_map = new Map();
        window.__junior_dom_map.set(nodeData.highlightIndex, node);
        try {
          node.setAttribute('data-highlight-index', String(nodeData.highlightIndex));
        } catch (e) {}`,
);

// ── Patch 3: compact serializer + reset/URL-stamp + mode-aware return. ──
replaceOnce(
  `  // Reset visited nodes for new DOM tree build
  visitedNodes = null;
  const rootId = buildDomTree(document.body);

  // Clear the cache before starting
  DOM_CACHE.clearCache();

  return { rootId, map: DOM_HASH_MAP };
};`,
  `  // ── Junior addition: compact serialization of the highlighted elements ──
  // outline = \`[index] tag "text" (href)\`; interactive adds type/role/value.
  // Values are masked for sensitive fields (Autono domExtractor.js masking).
  function juniorCompact(mode, maxChars) {
    var cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 8000;
    var SENSITIVE = /(password|passwd|pwd|passcode|token|secret|pin|cvv|cvc|creditcard|cardnumber|ssn|auth|one-time-code|otp|verification|iban|account|routing|dob|security)/i; // Autono domExtractor.js
    var map = window.__junior_dom_map || new Map();
    var lines = [];
    var used = 0;
    var truncated = false;
    var indexes = Array.from(map.keys()).sort(function (a, b) { return a - b; });
    for (var i = 0; i < indexes.length; i++) {
      var el = map.get(indexes[i]);
      if (!el || !el.isConnected) continue;
      var tag = String(el.tagName || '').toLowerCase();
      var text = ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ')).trim().slice(0, 120);
      var href = tag === 'a' && el.getAttribute ? el.getAttribute('href') || '' : '';
      var line;
      if (mode === 'interactive') {
        var type = el.getAttribute ? (el.getAttribute('type') || '').toLowerCase() : '';
        var role = el.getAttribute ? el.getAttribute('role') || '' : '';
        var ident = [el.getAttribute ? el.getAttribute('name') || '' : '', el.getAttribute ? el.getAttribute('autocomplete') || '' : '', el.getAttribute ? el.getAttribute('placeholder') || '' : ''].join(' ');
        var sensitive = (tag === 'input' && type === 'password') || SENSITIVE.test(ident);
        var value = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          var raw = String(el.value || '');
          value = sensitive ? '[PROTECTED_INPUT]' : raw.replace(/\\s+/g, ' ').trim().slice(0, 80);
        }
        var parts = ['[' + indexes[i] + ']', tag];
        if (type) parts.push('type=' + type);
        if (role) parts.push('role=' + role);
        if (text) parts.push(JSON.stringify(text));
        if (value) parts.push('value=' + JSON.stringify(value));
        if (href) parts.push('(' + href + ')');
        line = parts.join(' ');
      } else {
        line = '[' + indexes[i] + '] ' + tag + (text ? ' ' + JSON.stringify(text) : '') + (href ? ' (' + href + ')' : '');
      }
      if (used + line.length + 1 > cap) { truncated = true; break; }
      lines.push(line);
      used += line.length + 1;
    }
    if (truncated) {
      lines.push('... [truncated at ' + cap + ' chars — raise maxChars or read a narrower section]');
    }
    return lines.join('\\n');
  }

  // Reset visited nodes for new DOM tree build
  visitedNodes = null;
  // Junior: reset the element index map and stamp the URL it was built for —
  // the resolver only trusts the map while the URL is unchanged.
  if (window.__junior_dom_map) window.__junior_dom_map.clear();
  else window.__junior_dom_map = new Map();
  window.__junior_dom_map_url = window.location.href;
  const rootId = buildDomTree(document.body);

  // Clear the cache before starting
  DOM_CACHE.clearCache();

  // Junior compact output (see NOTICE): modes "outline"/"interactive" return
  // token-cheap text instead of the full DOM map.
  if (args.mode === 'outline' || args.mode === 'interactive') {
    return { text: juniorCompact(args.mode, args.maxChars) };
  }

  return { rootId, map: DOM_HASH_MAP };
};`,
  "// ── Junior addition: compact serialization", // patch 4 edits inside this block
);

// ── Patch 4 (T5b): fallback labels for elements without readable text (icon-only
//    player buttons). The labeling is Junior code — lib/executors/outline.ts
//    installs window.__junior_label_of before calling buildDomTree. ──
replaceOnce(
  ` *   3. input values in interactive mode are masked for sensitive fields.
 * Everything`,
  ` *   3. input values in interactive mode are masked for sensitive fields;
 *   4. elements without readable text get a fallback label from the Junior-owned
 *      \`window.__junior_label_of\` hook (aria-label, title, icon, data-*).
 * Everything`,
);
replaceOnce(
  `      var href = tag === 'a' && el.getAttribute ? el.getAttribute('href') || '' : '';
      var line;`,
  `      var href = tag === 'a' && el.getAttribute ? el.getAttribute('href') || '' : '';
      // Junior: fallback label when the text has no letters or digits (see NOTICE).
      var fallback = '';
      if (!/[\\p{L}\\p{N}]/u.test(text) && typeof window.__junior_label_of === 'function') {
        try { fallback = String(window.__junior_label_of(el) || '').slice(0, 200); } catch (e) {}
      }
      var line;`,
);
replaceOnce(
  `        if (text) parts.push(JSON.stringify(text));
        if (value)`,
  `        if (text) parts.push(JSON.stringify(text));
        if (fallback) parts.push(fallback);
        if (value)`,
);
replaceOnce(
  `(text ? ' ' + JSON.stringify(text) : '') + (href ? ' (' + href + ')' : '');`,
  `(text ? ' ' + JSON.stringify(text) : '') + (fallback ? ' ' + fallback : '') + (href ? ' (' + href + ')' : '');`,
);

writeFileSync(FILE, src);
console.log("patched", FILE);
