// @junior/protocol/guard.ts — PURE guard tables + permission matrix (plan §4.4, §6.3).
// TS port of Autono background.js:1784–1957 (URL validation, private-host detection,
// sensitive-site/label/field tables) and lib/autono-security.js:269–290 (permission
// modes/decisions). No state, no I/O, no chrome.*/node:* imports: both enforcement
// points share this file — the bridge's stateful SessionGuard
// (apps/bridge/src/dispatcher/guard.ts) and the extension's client-side guard mirror
// built by M3 (plan §5.2 item 4). The Autono test battery from
// autono-clone/tests/security-sprint2.test.js is ported in guard.test.ts.
//
// WHATWG URL note: `new URL()` normalizes numeric IPv4 hosts (0x7f.1 → 127.0.0.1,
// 2130706433 → 127.0.0.1, …) and inside brackets ([::ffff:127.0.0.1] → [::7f00:1]),
// so the parsers below see canonical forms in both Node and Chrome.

// --- URL validation (Autono background.js:1784–1909) ---------------------------------

import type { GuardReasonCode } from "./approval.js";

export const AGENT_URL_MAX_LEN = 2000;

const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "com.br",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.in",
  "co.nz",
  "co.za",
  "com.cn",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "co.kr",
]);

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number) as [number, number, number, number];
  return p.some((n) => n > 255) ? null : p;
}

function privateIPv4Reason(p: readonly [number, number, number, number]): string {
  const [a, b] = p;
  if (a === 0) return "the 0.0.0.0/8 range";
  if (a === 10) return "a private network address (10.0.0.0/8)";
  if (a === 127) return "a loopback address (127.0.0.0/8)";
  if (a === 169 && b === 254) return "a link-local address (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "a private network address (172.16.0.0/12)";
  if (a === 192 && b === 168) return "a private network address (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address (100.64.0.0/10)";
  if (a === 198 && (b === 18 || b === 19)) return "a benchmark-network address (198.18.0.0/15)";
  if (a >= 224) return "a multicast or reserved address";
  return "";
}

function parseIPv6(text: string): number[] | null {
  let str =
    String(text || "")
      .toLowerCase()
      .split("%")[0] ?? "";
  const tail4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail4) {
    const p = parseIPv4(tail4[2]!); // the regex guarantees group 2
    if (!p) return null;
    str = tail4[1] + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** Human reason when the host is local / private / internal, "" when it looks public. */
export function privateHostReason(hostname: string): string {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!h) return "an empty host name";
  if (h.startsWith("[") && h.endsWith("]")) {
    const g = parseIPv6(h.slice(1, -1));
    if (!g) return "an IPv6 address that could not be parsed";
    // parseIPv6 returns exactly 8 groups, so the indexes below are in range.
    const g0 = g[0]!,
      g5 = g[5]!,
      g6 = g[6]!,
      g7 = g[7]!;
    const embedded = (hi: number, lo: number) =>
      privateIPv4Reason([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (g.every((n) => n === 0)) return "the unspecified IPv6 address";
    if (g.slice(0, 7).every((n) => n === 0) && g7 === 1) return "the IPv6 loopback address";
    if ((g0 & 0xfe00) === 0xfc00) return "a unique-local IPv6 address (fc00::/7)";
    if ((g0 & 0xffc0) === 0xfe80) return "a link-local IPv6 address";
    if ((g0 & 0xffc0) === 0xfec0) return "a site-local IPv6 address";
    if ((g0 & 0xff00) === 0xff00) return "an IPv6 multicast address";
    if (g.slice(0, 5).every((n) => n === 0) && (g5 === 0xffff || g5 === 0))
      return embedded(g6, g7) || "an IPv4-mapped IPv6 address";
    if (g0 === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0))
      return embedded(g6, g7) || "a NAT64 IPv6 address";
    if (g0 === 0x2002) return embedded(g[1]!, g[2]!) || "";
    return "";
  }
  const v4 = parseIPv4(h);
  if (v4) return privateIPv4Reason(v4);
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (/\.(local|internal|lan|home|home\.arpa|localdomain|intranet|corp|private)$/.test(h))
    return "a local-network host name";
  if (!h.includes(".")) return "a single-label (intranet) host name";
  return "";
}

/** Best-effort registrable domain (two-level suffix list, no PSL). */
export function registrableDomain(hostname: string): string {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!h || h.startsWith("[") || parseIPv4(h)) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

export interface ValidateAgentUrlOptions {
  /** Add https:// to scheme-less values (model-provided navigation targets). */
  assumeHttps?: boolean;
  /** Origins the agent may never target — these HARD REJECT, no card can approve
   * them (plan §6.3-5: "the agent can never target the extension's own origin or
   * the bridge origin"). Autono confirmed instead; Junior refuses. */
  blockedOrigins?: readonly string[];
}

export type UrlNeedsConfirm = { kind: "private_network"; reason: string };

/** {ok:false, error} or {ok:true, url, origin, host, registrable, needsConfirm}. */
export type UrlCheck =
  | { ok: false; error: string }
  | {
      ok: true;
      url: string;
      origin: string;
      host: string;
      registrable: string;
      needsConfirm: UrlNeedsConfirm | null;
    };

/** Every place where the agent (or a sub-agent, or the MCP bridge) chooses a
 * destination goes through validateAgentUrl (Autono background.js:1876). */
export function validateAgentUrl(raw: unknown, opts: ValidateAgentUrlOptions = {}): UrlCheck {
  const fail = (error: string): UrlCheck => ({ ok: false, error });
  if (typeof raw !== "string") return fail("the address is missing");
  let text = raw.trim();
  if (!text) return fail("the address is empty");
  if (text.length > AGENT_URL_MAX_LEN)
    return fail(`the address is longer than ${AGENT_URL_MAX_LEN} characters`);
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(text)) return fail("the address contains control characters");
  if (opts.assumeHttps) {
    const hasScheme =
      /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(\/|$|\?|#)/i.test(text);
    if (!hasScheme) text = "https://" + text.replace(/^\/\//, "");
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return fail("the address is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return fail(`the "${u.protocol}" scheme is not allowed (only http and https)`);
  if (u.username || u.password) return fail("the address contains embedded credentials");
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return fail("the address has no host");
  // §6.3-5 — Junior's own services are never a destination (harder than Autono,
  // which only demanded confirmation; see ValidateAgentUrlOptions.blockedOrigins).
  if ((opts.blockedOrigins ?? []).includes(u.origin)) {
    return fail(`${u.origin} is the address of your Junior bridge — the agent can never target it`);
  }
  const privateReason = privateHostReason(host);
  const needsConfirm: UrlNeedsConfirm | null = privateReason
    ? { kind: "private_network", reason: `${host} is ${privateReason}` }
    : null;
  return {
    ok: true,
    url: u.href,
    origin: u.origin,
    host,
    registrable: registrableDomain(host),
    needsConfirm,
  };
}

// --- Sensitive action classifier (Autono background.js:1912–1957, verbatim tables) ---

export const SENSITIVE_ACTION_RE =
  /\b(pay|buy|order|purchase|send|delete|remove|transfer|authorize|allow|grant|publish|confirm|submit|checkout|pagar|comprar|enviar|eliminar|borrar|transferir|autorizar|permitir|publicar|confirmar|pago|compra)\b/i;
export const SENSITIVE_FIELD_RE =
  /(password|passwd|pwd|passcode|\bpin\b|token|secret|cvv|cvc|credit.?card|card.?number|ssn|auth(?!or)|one-time-code|otp|verification|iban|account|routing|\bdob\b|security)/i;

export const SENSITIVE_SITE_RULES: readonly (readonly [RegExp, string])[] = [
  // webmail
  [/^(web)?mail\./, "webmail"],
  [
    /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|proton\.me|protonmail\.com|fastmail\.com|icloud\.com|zoho\.com)$/,
    "webmail",
  ],
  // banking and payments
  [
    /(^|\.)(paypal\.com|paypal\.me|stripe\.com|wise\.com|revolut\.com|venmo\.com|cash\.app|payoneer\.com|mercadopago\.[a-z.]+|binance\.com|coinbase\.com|kraken\.com|chase\.com|bankofamerica\.com|wellsfargo\.com|citi\.com|capitalone\.com|americanexpress\.com|pay\.google\.com|hsbc\.[a-z.]+|santander\.[a-z.]+|bbva\.[a-z.]+|barclays\.[a-z.]+|nubank\.com\.br)$/,
    "banking / payments",
  ],
  [/(^|[.-])(bank|banco|banking|banca)([.-]|$)/, "banking / payments"],
  // password managers
  [
    /(^|\.)(1password\.com|bitwarden\.com|lastpass\.com|dashlane\.com|keepersecurity\.com|nordpass\.com)$/,
    "password manager",
  ],
  // cloud consoles
  [
    /(^|\.)(console\.aws\.amazon\.com|signin\.aws\.amazon\.com|portal\.azure\.com|console\.cloud\.google\.com|dash\.cloudflare\.com|console\.firebase\.google\.com|cloud\.digitalocean\.com|vercel\.com|netlify\.com|supabase\.com|heroku\.com|admin\.google\.com)$/,
    "cloud console",
  ],
  [/^(console|admin)\./, "cloud console"],
  // code hosts
  [/(^|\.)(github\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|codeberg\.org)$/, "code host"],
  // account / login portals
  [/^(accounts?|login|signin|sso|auth|id|myaccount|secure)\./, "account / sign-in portal"],
];

export const SENSITIVE_PATH_RE =
  /\/(oauth2?|o\/oauth2|authorize|consent|signin\/oauth|saml|checkout)(\/|$|\?)|[?&]client_id=/i;

/** Short reason string when the URL is on the built-in always-ask list, "" otherwise. */
export function sensitiveSiteReason(urlString: string): string {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  for (const [re, label] of SENSITIVE_SITE_RULES) if (re.test(host)) return label;
  if (SENSITIVE_PATH_RE.test(u.pathname + u.search)) return "sign-in / authorization page";
  return "";
}

export function labelIsSensitive(text: unknown): boolean {
  return SENSITIVE_ACTION_RE.test(String(text || ""));
}

/** Field facts as the M3 probe-before-act reports them (§5.2 item 3). */
export interface ProbedFieldFacts {
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelText?: string;
  autocomplete?: string;
}

export function fieldIsSensitive(f: ProbedFieldFacts | null | undefined): boolean {
  if (!f) return false;
  const ac = String(f.autocomplete || "").toLowerCase();
  if (String(f.type || "").toLowerCase() === "password") return true;
  if (ac.includes("password") || ac.includes("cc-") || ac.includes("one-time-code")) return true;
  return SENSITIVE_FIELD_RE.test(
    `${f.name || ""} ${f.id || ""} ${f.placeholder || ""} ${f.ariaLabel || ""} ${f.labelText || ""}`,
  );
}

// --- Permission matrix (plan §4.4; lib/autono-security.js:269–290) --------------------
//
// |                                      | ask   | auto             | none  |
// |--------------------------------------|-------|------------------|-------|
// | new site nav/click                   | card  | allow            | allow |
// | routine nav (supervised)             | card  | allow            | allow |
// | sensitive site / label / form submit | card  | card (even auto) | allow |
// | secret field typing                  | refuse| refuse           | refuse|
// | local/internal address               | card  | refuse, no card  | allow |
//
// Two deliberate deltas from Autono's permissionDecision, both plan-specified:
//  1. secret fields are refused in EVERY mode (§6.3-4) — Autono still showed a card in ask;
//  2. sensitive sites/labels/form submits get a card even in auto (§4.4 row 3) — Autono allowed.

export const PERMISSION_MODES = ["ask", "auto", "none"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** ask is the default for anything unknown/unparseable. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  const v = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  return (PERMISSION_MODES as readonly string[]).includes(v) ? (v as PermissionMode) : "ask";
}

export type PermissionDecision = "ask" | "allow" | "deny";

/** What to do with reasons carrying these codes: "ask" = show the approval card,
 * "allow" = approve without asking, "deny" = refuse (no card). */
export function permissionDecision(
  mode: PermissionMode,
  reasonCodes?: readonly GuardReasonCode[],
): PermissionDecision {
  const m = normalizePermissionMode(mode);
  const codes = reasonCodes ?? [];
  if (codes.includes("secret_field")) return "deny"; // §6.3-4: every mode
  if (m === "ask") return "ask";
  if (m === "auto") {
    if (codes.includes("private_network")) return "deny";
    if (codes.some((c) => c === "sensitive_site" || c === "sensitive_label" || c === "form_submit"))
      return "ask";
    return "allow";
  }
  return "allow"; // none: only secret fields are ever refused
}

// --- Structured denial strings (Autono background.js:2010–2012, 2151) -----------------
// §4.4: denials return these strings to the model so it doesn't retry.

export const USER_DENIED_TEXT =
  "USER_DENIED: the user did not approve this action. Do not retry it. Choose a different approach or finish and explain.";
// In "auto" / "none" nothing is asked, so a refusal is a rule, not an answer from the user.
export const BLOCKED_BY_POLICY_TEXT =
  "BLOCKED_BY_POLICY: this action is never done without the user (a secret field, or a local or internal address). Do not retry it. Choose a different approach or tell the user to do it themselves.";
export const BLOCKED_SENSITIVE_TEXT =
  "BLOCKED_SENSITIVE: typing into a password, card, one-time-code or other secret field is never done. Do not retry it. Tell the user to enter it themselves.";

/** ask-mode refusals are the user's answer; auto/none refusals are policy. */
export function denialTextFor(mode: PermissionMode): string {
  return normalizePermissionMode(mode) === "ask" ? USER_DENIED_TEXT : BLOCKED_BY_POLICY_TEXT;
}

/** A guard reason ready for an approval card. */
export interface GuardReason {
  code: GuardReasonCode;
  text: string;
}
