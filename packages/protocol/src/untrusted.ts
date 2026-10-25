// @junior/protocol/untrusted — the untrusted-data delimiter block (plan §6.3-2).
// Port of Autono lib/autono-security.js:40–127 (verbatim in spirit; two Junior deltas,
// see docs/decisions.md 2026-10-25): everything a web page controls and that reaches a
// model prompt gets its delimiter/nonce tokens stripped to a fixed point first, so a
// malicious page cannot close — or fake — its untrusted block and inject instructions.
// Pure and environment-neutral (webcrypto only) so the bridge and the extension share it.
//
// Deltas from Autono:
// - randomHex uses globalThis.crypto.getRandomValues only (Node ≥ 19 and every
//   Chrome context have webcrypto; Autono's require() fallback path is dead here).
// - safeSlice never splits a UTF-16 surrogate pair — Autono's capFragment could emit a
//   lone surrogate at the boundary, which serializes to invalid UTF-8 on the wire.

const TOKEN_RE = /UNTRUSTED[\s_-]*WEB[\s_-]*DATA/gi;

/** Remove everything that could be used to close (or fake) the untrusted block from
 * website-derived text: the delimiter words, the nonce, any run of three or more "<"/">",
 * and "END nonce=…" tails. Runs to a fixed point so a delimiter cannot be rebuilt by the
 * removal of an inner one. */
export function stripDelimiters(value: unknown, nonce?: string): string {
  let s = value === null || value === undefined ? "" : String(value);
  for (let i = 0; i < 8; i++) {
    const before = s;
    if (nonce) s = s.split(String(nonce)).join("");
    s = s.replace(TOKEN_RE, "");
    s = s.replace(/<{3,}/g, "<<").replace(/[>]{3,}/g, ">>"); // same 3+ collapse as Autono, char-class form
    s = s.replace(/\bEND\s+nonce\s*=\s*[A-Za-z0-9]*/gi, "");
    if (s === before) break;
  }
  return s;
}

/** Slice to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate (D800–DBFF) whose pair went past the cut would become lone.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Recursively strip delimiters from every string of a JSON-like value (Autono parity:
 * arrays cap at 200, objects at 100 keys, depth beyond 8 → null). */
export function sanitizeDeep(value: unknown, nonce: string, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return stripDelimiters(value, nonce);
  if (Array.isArray(value))
    return value.slice(0, 200).map((v) => sanitizeDeep(v, nonce, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).slice(0, 100)) {
      out[stripDelimiters(k, nonce)] = sanitizeDeep(
        (value as Record<string, unknown>)[k],
        nonce,
        depth + 1,
      );
    }
    return out;
  }
  return value;
}

/** Cap one page-derived fragment: no newlines, delimiters removed, at most `max`
 * characters, returned JSON-encoded (quotes/control characters cannot break out of the
 * line it sits in). Autono parity, with the surrogate-safe slice. */
export function capFragment(value: unknown, max: number, nonce?: string): string {
  const limit = Math.max(1, max || 60);
  let s = stripDelimiters(value, nonce)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point (M1-4 learning)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > limit) s = safeSlice(s, limit);
  return JSON.stringify(s);
}

/** Same as capFragment but without the surrounding JSON quotes (text already inside a
 * labelled field). */
export function capPlain(value: unknown, max: number, nonce?: string): string {
  return JSON.parse(capFragment(value, max, nonce)) as string;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Per-request nonce for the untrusted-data delimiter (Autono parity: 12 bytes hex). */
export function newNonce(): string {
  return randomHex(12);
}

export function wrapUntrusted(nonce: string, body: string): string {
  return `<<<UNTRUSTED_WEB_DATA nonce=${nonce}>>>\n${body}\n<<<END nonce=${nonce}>>>`;
}
