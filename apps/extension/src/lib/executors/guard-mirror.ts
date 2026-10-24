// lib/executors/guard-mirror.ts — the extension-side guard over probed page facts
// (plan §5.2 item 4, §4.4 matrix). The bridge enforces what it can see (navigate);
// click/type page facts only exist here, so this module maps them onto the SAME
// pure tables from @junior/protocol — never a re-implementation. Verdicts:
// deny → refusal string goes back to the model; ask → an ApprovalRequest for the
// card flow (M3-3 Port routing; until then the runner default-asks-deny, §6.3-3).
import {
  ApprovalRequestSchema,
  BLOCKED_SENSITIVE_TEXT,
  denialTextFor,
  fieldIsSensitive,
  labelIsSensitive,
  normalizePermissionMode,
  permissionDecision,
  sensitiveSiteReason,
  validateAgentUrl,
  type ApprovalRequest,
  type GuardReason,
  type GuardReasonCode,
} from "@junior/protocol";
import type { InPageClickFacts, InPageFieldFacts } from "./in-page";

export type PreActCheck =
  | { verdict: "allow" }
  | { verdict: "deny"; error: string }
  | { verdict: "ask"; approval: ApprovalRequest };

export interface ClickCheckInput {
  mode: unknown;
  pageUrl: string;
  facts: InPageClickFacts;
  /** The user already allowed this site (M3-3 session grants): suppresses the ask,
   * never a deny. private_network asks stay — a site grant can't waive the network. */
  granted?: boolean;
}

export interface TypeCheckInput {
  mode: unknown;
  pageUrl: string;
  facts: InPageFieldFacts;
  text: string;
  /** See ClickCheckInput.granted. */
  granted?: boolean;
}

/** Guard check for `click`, from real probed element facts (§6.3-1: never model text). */
export function checkClickFacts(input: ClickCheckInput): PreActCheck {
  const mode = normalizePermissionMode(input.mode);
  const { facts } = input;
  const reasons: GuardReason[] = [];
  const codes: GuardReasonCode[] = [];
  const pageUrl = clip(input.pageUrl, 2048);

  const destination = facts.href || "";
  const pageSens = sensitiveSiteReason(pageUrl);
  if (pageSens) {
    codes.push("sensitive_site");
    reasons.push({ code: "sensitive_site", text: clip(`Sensitive site: ${pageSens}`, 200) });
  }
  if (destination) {
    const destSens = sensitiveSiteReason(destination);
    if (destSens) {
      codes.push("sensitive_site");
      reasons.push({
        code: "sensitive_site",
        text: clip(`Link leads to a sensitive site: ${destSens}`, 200),
      });
    }
    const destCheck = validateAgentUrl(destination);
    if (destCheck.ok && destCheck.needsConfirm) {
      codes.push("private_network");
      reasons.push({
        code: "private_network",
        text: clip(
          `Link leads to a local or internal address: ${destCheck.needsConfirm.reason}`,
          200,
        ),
      });
    }
  }
  const labelHit =
    labelIsSensitive(facts.text) ||
    labelIsSensitive(facts.ariaLabel) ||
    labelIsSensitive(facts.title);
  if (labelHit) {
    codes.push("sensitive_label");
    reasons.push({ code: "sensitive_label", text: "Element label suggests a sensitive action" });
  }
  if (facts.isSubmit) {
    codes.push("form_submit");
    reasons.push({ code: "form_submit", text: "Element submits a form" });
  }

  const decision = permissionDecision(mode, codes);
  if (decision === "allow") return { verdict: "allow" };
  if (decision === "deny") return { verdict: "deny", error: denialTextFor(mode) };
  if (input.granted && !codes.includes("private_network")) return { verdict: "allow" };
  // Card-parity with the bridge's SessionGuard: a supervised ask with no specific
  // reason still says why it asked (routine_supervised).
  if (codes.length === 0) {
    codes.push("routine_supervised");
    reasons.push({ code: "routine_supervised", text: "Supervised mode asks before every action" });
  }
  return {
    verdict: "ask",
    approval: ApprovalRequestSchema.parse({
      reasonCodes: codes,
      reasons: reasons.map((r) => r.text),
      pageUrl,
      destinationUrl: destination ? clip(destination, 2048) : undefined,
      element: {
        tag: facts.tag,
        type: facts.type || undefined,
        text: facts.text || undefined,
        href: facts.href ? clip(facts.href, 2048) : undefined,
        formAction: facts.formAction ? clip(facts.formAction, 2048) : undefined,
      },
      siteDomain: siteDomainOf(pageUrl),
    }),
  };
}

/** Guard check for `type`. Secret fields are refused in EVERY mode (§6.3-4). */
export function checkTypeFacts(input: TypeCheckInput): PreActCheck {
  const mode = normalizePermissionMode(input.mode);
  const pageUrl = clip(input.pageUrl, 2048);

  if (fieldIsSensitive(input.facts)) return { verdict: "deny", error: BLOCKED_SENSITIVE_TEXT };

  const codes: GuardReasonCode[] = [];
  const reasons: GuardReason[] = [];
  const pageSens = sensitiveSiteReason(pageUrl);
  if (pageSens) {
    codes.push("sensitive_site");
    reasons.push({ code: "sensitive_site", text: clip(`Sensitive site: ${pageSens}`, 200) });
  }
  // Typing text with "\n" ends in a form submit (in-page Enter → requestSubmit).
  if (input.text.includes("\n") && input.facts.formAction) {
    codes.push("form_submit");
    reasons.push({ code: "form_submit", text: "Typing ends with Enter, which submits the form" });
  }

  const decision = permissionDecision(mode, codes);
  if (decision === "allow") return { verdict: "allow" };
  if (decision === "deny") return { verdict: "deny", error: denialTextFor(mode) };
  if (input.granted && !codes.includes("private_network")) return { verdict: "allow" };
  if (codes.length === 0) {
    codes.push("routine_supervised");
    reasons.push({ code: "routine_supervised", text: "Supervised mode asks before every action" });
  }
  return {
    verdict: "ask",
    approval: ApprovalRequestSchema.parse({
      reasonCodes: codes,
      reasons: reasons.map((r) => r.text),
      pageUrl,
      element: {
        tag: input.facts.tag,
        type: input.facts.type || undefined,
        text: input.facts.placeholder || input.facts.labelText || undefined,
      },
      typed: clip(input.text, 600), // never a secret field here — those are denied above
      siteDomain: siteDomainOf(pageUrl),
    }),
  };
}

// Site-grant state ("allow for this site") arrives via the `granted` input on the
// two check functions above — callers (the M3-3 agent loop) read lib/site-grants.ts
// and pass `grantCovers(...)`; this module holds no storage or module state.

function siteDomainOf(url: string): string | undefined {
  const v = validateAgentUrl(url);
  return v.ok ? v.registrable : undefined;
}

function clip(s: string, n: number): string {
  return s.length > n ? (s.slice(0, n - 1) + "…").slice(0, n) : s;
}
