// @junior/bridge/dispatcher/guard — stateful enforcement over the pure §4.4 tables in
// @junior/protocol (plan §4.4). Port of Autono createActionGuard
// (background.js:2015–2158): one guard per session, holding the seen/granted domain
// sets and the page-approved domain. Navigate is fully enforced here (the action
// carries the whole URL); click/type page-fact checks run in the extension's guard
// mirror built from the same protocol tables — the bridge has no probed page facts
// (plan §5.2 item 4: "bridge remains the enforcement point" for what it can see).
import {
  ApprovalRequestSchema,
  denialTextFor,
  normalizePermissionMode,
  permissionDecision,
  sensitiveSiteReason,
  validateAgentUrl,
  type ApprovalDecision,
  type ApprovalRequest,
  type BrowserAction,
  type GuardReason,
  type JuniorConfig,
  type PermissionMode,
  type UrlCheck,
} from "@junior/protocol";
import { loadConfig } from "../config.js";
import type { ActionGuard, GuardVerdict } from "./queue.js";

type OkUrl = Extract<UrlCheck, { ok: true }>;

/** The ask path for checkPage — the dispatcher's requestApproval in prod. */
export type GuardAsk = (approval: ApprovalRequest) => Promise<"once" | "site" | "deny">;

export interface SessionGuardOptions {
  /** Live permission-mode supplier — config is reread per check). Defaults to "ask". */
  permissionMode?: () => unknown;
  /** Live blocked-origins supplier (§4.4: the bridge's own origin; the extension
   * origin can never pass validateAgentUrl's http(s) check, so it needs no entry). */
  blockedOrigins?: () => readonly string[];
  /** Registrable domains of the task's starting pages — seed seenDomains. */
  startUrls?: readonly string[];
}

export class SessionGuard implements ActionGuard {
  private readonly opts: SessionGuardOptions;
  private readonly seenDomains = new Set<string>(); // registrable domains visited or approved
  private readonly grantedSites = new Set<string>(); // domains allowed "for this task"
  private pageApprovedFor = ""; // domain whose page view was approved (next step doesn't re-ask)

  constructor(opts: SessionGuardOptions = {}) {
    this.opts = opts;
    for (const raw of opts.startUrls ?? []) {
      const v = validateAgentUrl(raw);
      if (v.ok) this.seenDomains.add(v.registrable);
    }
  }

  private get mode(): PermissionMode {
    return normalizePermissionMode(this.opts.permissionMode?.());
  }

  private get blockedOrigins(): readonly string[] {
    return this.opts.blockedOrigins?.() ?? [];
  }

  /** Autono api.allowedDomains — for /api/status-style surfacing later. */
  allowedDomains(): string[] {
    return [...this.seenDomains];
  }

  /** Dispatcher seam (§4.3). navigate is enforced in full; other kinds pass — their
   * guard work needs probed page facts the bridge doesn't have (§5.2 item 4). */
  check(action: BrowserAction): GuardVerdict {
    if (action.kind !== "navigate") return { kind: "allow" };
    return this.checkNavigate(action.url);
  }

  /** Called by the dispatcher with the card's answer; "site" grants persist. */
  onApprovalDecision(action: BrowserAction, decision: ApprovalDecision): void {
    if (action.kind !== "navigate" || decision.decision === "deny") return;
    const v = validateAgentUrl(action.url, {
      assumeHttps: true,
      blockedOrigins: this.blockedOrigins,
    });
    if (!v.ok) return;
    this.noteVisit(v);
    if (decision.decision === "site") this.grantedSites.add(v.registrable);
  }

  /** §4.4 checkPage — run at the top of every agent step with the URL the tab is
   * really on (covers redirects and click navigations). M4's engines supply `ask`
   * (dispatcher.requestApproval). Resolves false when the page was refused. */
  async checkPage(currentUrl: string, ask: GuardAsk): Promise<boolean> {
    const v = validateAgentUrl(String(currentUrl || ""));
    if (!v.ok) return true; // unparseable → not this guard's problem (executors handle it)
    if (this.grantedSites.has(v.registrable) || this.pageApprovedFor === v.registrable) return true;
    const reasons = this.classify(v);
    if (!reasons.length) return true;
    const decision = await ask(this.card(v, reasons));
    if (decision === "deny") return false;
    this.noteVisit(v);
    if (decision === "site") this.grantedSites.add(v.registrable);
    return true;
  }

  private checkNavigate(rawUrl: string): GuardVerdict {
    const v = validateAgentUrl(rawUrl, { assumeHttps: true, blockedOrigins: this.blockedOrigins });
    if (!v.ok) {
      return {
        kind: "deny",
        reason: `Navigation blocked: ${v.error}. Use a normal public http(s) address.`,
      };
    }
    const reasons = this.classify(v);
    if (this.mode === "ask" && !this.grantedSites.has(v.registrable) && reasons.length === 0) {
      reasons.push({
        code: "routine_supervised",
        text: "Supervised mode asks before every navigation",
      });
    }
    if (!reasons.length) {
      this.allowVisit(v);
      return { kind: "allow" };
    }
    const decision = permissionDecision(
      this.mode,
      reasons.map((r) => r.code),
    );
    if (decision === "deny") return { kind: "deny", reason: denialTextFor(this.mode) };
    if (decision === "allow") {
      this.allowVisit(v); // auto/none: Autono's ask() grants the site without a card
      return { kind: "allow" };
    }
    return { kind: "approval", approval: this.card(v, reasons) };
  }

  /** Autono classifyDestination: static (private/sensitive) + stateful (new site). */
  private classify(v: OkUrl): GuardReason[] {
    const reasons: GuardReason[] = [];
    if (v.needsConfirm) {
      reasons.push({
        code: "private_network",
        text: `Local or internal address: ${v.needsConfirm.reason}`,
      });
    }
    if (!this.seenDomains.has(v.registrable) && !this.grantedSites.has(v.registrable)) {
      reasons.push({ code: "new_site", text: `New site for this task: ${v.registrable}` });
    }
    const sens = this.grantedSites.has(v.registrable) ? "" : sensitiveSiteReason(v.url);
    if (sens)
      reasons.push({
        code: "sensitive_site",
        text: clip(`Sensitive site (${sens}): ${v.registrable}`, 200),
      });
    return reasons;
  }

  /** Approval card from real probed URL facts — never model text (§6.3-1). */
  private card(v: OkUrl, reasons: GuardReason[]): ApprovalRequest {
    return ApprovalRequestSchema.parse({
      reasonCodes: reasons.map((r) => r.code),
      reasons: reasons.map((r) => clip(r.text, 200)),
      pageUrl: v.url,
      destinationUrl: v.url,
      siteDomain: v.registrable,
    });
  }

  private allowVisit(v: OkUrl): void {
    this.grantedSites.add(v.registrable); // matches Autono ask()'s allow-path grant
    this.noteVisit(v);
  }

  private noteVisit(v: OkUrl): void {
    this.seenDomains.add(v.registrable);
    this.pageApprovedFor = v.registrable;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? (s.slice(0, n - 1) + "…").slice(0, n) : s;
}

/** The createApp default: permissionMode + bridge origin read live from config
 * (§4.1); a broken config degrades to "ask" — fail-safe, never fail-open. */
export function defaultGuard(dir: string): SessionGuard {
  const fromConfig = <T>(read: (c: JuniorConfig) => T, fallback: T): T => {
    try {
      return read(loadConfig(dir));
    } catch {
      return fallback;
    }
  };
  return new SessionGuard({
    permissionMode: () => fromConfig((c) => c.permissionMode, "ask"),
    blockedOrigins: () => [`http://127.0.0.1:${fromConfig((c) => c.port, 8620)}`],
  });
}
