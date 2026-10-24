// lib/port-router.ts — the panel↔SW Port channel + message firewall (plan §5.2
// item 5). Port of Autono's onConnect/onMessage gating (background.js:113,
// 5214–5222, 5592–5610), trimmed to Junior's message set:
//  - privileged types (extension pages only): approval_response (+ future picker cmds)
//  - content-script sendable allowlist: pick_response | overlay_action | content_ready
//    (content scripts connect in M3-4; the allowlist exists from day one so the
//    firewall is already shaped — plan §5.2 item 5 names exactly these three).
// Everything chrome-port-shaped goes through PortLike so tests run the REAL
// router against stub ports.
import type { ApprovalRequest } from "@junior/protocol";

/** Port name the panel must connect with (Autono: "antigravity-panel"). */
export const PANEL_PORT_NAME = "junior-panel";

// --- wire shapes ---------------------------------------------------------------

/** SW → panel. Sent once, immediately on connect (Autono background.js:5225). */
export interface InitStateMessage {
  type: "init_state";
  agentActive: boolean;
  permissionMode: string;
}

/** SW → panel — one approval card (the panel may hold several at once, keyed by id). */
export interface ApprovalRequestMessage {
  type: "approval_request";
  id: string;
  approval: ApprovalRequest;
  /** Remaining window; the card counts down and auto-denies at zero. */
  remainingMs: number;
}

/** SW → panel — a card went away (answered, timed out, or nobody was listening). */
export interface ApprovalResolvedMessage {
  type: "approval_resolved";
  id: string;
  by: "decision" | "timeout" | "no-panel";
}

/** SW → panel — coarse agent activity indicator (M3-4 overlay builds on this). */
export interface TaskStatusMessage {
  type: "task_status";
  state: "idle" | "working" | "awaiting_approval";
  detail?: string;
}

/** Panel → SW — the user's answer to a card (shape mirrors ApprovalDecisionSchema). */
export interface ApprovalResponseMessage {
  type: "approval_response";
  id: string;
  decision: "once" | "site" | "deny";
}

export type PanelOutboundMessage =
  InitStateMessage | ApprovalRequestMessage | ApprovalResolvedMessage | TaskStatusMessage;

export type PanelInboundMessage = ApprovalResponseMessage;

/** M3-4 content scripts may send exactly these (plan §5.2 item 5 allowlist). */
export const CONTENT_SCRIPT_TYPES = ["pick_response", "overlay_action", "content_ready"] as const;

// --- firewall (pure, ports of Autono background.js:113 + 5593–5603) -------------

/** Minimal shape of chrome MessageSender we rely on. */
export interface SenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
  frameId?: number;
}

/** Port of Autono isExtPage (background.js:113): OUR extension page, not a
 * content script (content scripts get the page URL, not the chrome-extension:// one). */
export function isExtPage(
  sender: SenderLike | undefined,
  extensionId: string,
  extensionOrigin: string,
): boolean {
  return (
    !!sender &&
    sender.id === extensionId &&
    typeof sender.url === "string" &&
    sender.url.startsWith(`${extensionOrigin}/`)
  );
}

/** Content-script senders sit in a tab, top frame only (Autono background.js:5597). */
export function isContentScriptSender(sender: SenderLike | undefined): boolean {
  return !!sender && sender.tab !== undefined && sender.frameId === 0;
}

/** Panel→SW messages are privileged: extension pages only (verified per message,
 * not just at connect — Autono re-checks port.sender on every message). */
export function panelMessageAllowed(
  msgType: string,
  sender: SenderLike | undefined,
  extensionId: string,
  extensionOrigin: string,
): boolean {
  return msgType === "approval_response" && isExtPage(sender, extensionId, extensionOrigin);
}

/** Content scripts are restricted to the 3-type allowlist, top frame only. */
export function contentMessageAllowed(msgType: string, sender: SenderLike | undefined): boolean {
  return (
    (CONTENT_SCRIPT_TYPES as readonly string[]).includes(msgType) && isContentScriptSender(sender)
  );
}

// --- router (SW side) ------------------------------------------------------------

/** The slice of chrome.runtime.Port the router touches. */
export interface PortLike {
  name?: string;
  sender?: SenderLike;
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(cb: (msg: unknown, port: PortLike) => void): void;
    removeListener(cb: (msg: unknown, port: PortLike) => void): void;
  };
  onDisconnect: {
    addListener(cb: (port: PortLike) => void): void;
  };
}

export interface PortRouterOptions {
  extensionId: string;
  extensionOrigin: string;
  /** Called when a validated panel page answers a card. */
  onApprovalResponse: (msg: ApprovalResponseMessage, port: PortLike) => void;
  /** Called when an allowed content-script message arrives (M3-4 wires handlers). */
  onContentMessage?: (msgType: string, msg: unknown, port: PortLike) => void;
}

export function isApprovalResponseMessage(msg: unknown): msg is ApprovalResponseMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "approval_response" &&
    typeof (msg as { id?: unknown }).id === "string" &&
    ["once", "site", "deny"].includes(String((msg as { decision?: unknown }).decision))
  );
}

/**
 * Tracks connected panel ports, fans out broadcasts, and enforces the firewall:
 * wrong port name or non-extension sender → disconnect (Autono background.js:5218);
 * unknown message shapes → ignored. Re-validates the sender on EVERY message.
 */
export class PortRouter {
  readonly ports = new Set<PortLike>();
  private readonly opts: PortRouterOptions;

  constructor(opts: PortRouterOptions) {
    this.opts = opts;
  }

  /** browser.runtime.onConnect landing pad. Returns false when the port was rejected. */
  attach(port: PortLike): boolean {
    if (
      port.name !== PANEL_PORT_NAME ||
      !isExtPage(port.sender, this.opts.extensionId, this.opts.extensionOrigin)
    ) {
      port.disconnect();
      return false;
    }
    this.ports.add(port);
    port.onDisconnect.addListener((p) => {
      this.ports.delete(p);
    });
    port.onMessage.addListener((msg, p) => this.handleMessage(msg, p));
    return true;
  }

  hasListener(): boolean {
    return this.ports.size > 0;
  }

  broadcast(msg: PanelOutboundMessage): void {
    for (const port of [...this.ports]) {
      try {
        port.postMessage(msg);
      } catch {
        this.ports.delete(port); // dead port — Autono background.js:1745 does the same
      }
    }
  }

  private handleMessage(msg: unknown, port: PortLike): void {
    if (!isExtPage(port.sender, this.opts.extensionId, this.opts.extensionOrigin)) {
      port.disconnect();
      return;
    }
    if (!isApprovalResponseMessage(msg)) return; // unknown/privileged-else shape: ignore
    if (!this.ports.has(port)) return; // answered after disconnect
    this.opts.onApprovalResponse(msg, port);
  }
}
