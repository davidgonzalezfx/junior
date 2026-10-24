// lib/work-overlay.ts — SW side of the work overlay (plan §5.2 item 6): inject
// the unlisted overlay.js into the working tab on agent activity, relay
// show/hide/pause, and apply the port-router firewall (contentMessageAllowed —
// top frame, 3-type allowlist) to every inbound content-script message before
// acting on it. Pause itself is LOCAL (plan §5.2 item 6): the controller only
// syncs visuals; AgentLoop.setPaused stops polling and denies held items.
// M4-5: the ✕ "cancel" action routes to the background's cancelTask, and the
// showing tab is recorded in storage so a SW killed mid-task can clear the
// orphaned overlay on its next wake (the page-side overlay outlives the SW).
import { browser } from "wxt/browser";
import { contentMessageAllowed, type SenderLike } from "./port-router";
import type { OverlayCommand } from "./work-overlay-content";

/** storage.local key holding the tab currently showing the overlay. */
const OVERLAY_TAB_KEY = "junior_overlay_tab";

export interface OverlayEnv {
  injectOverlay(tabId: number): Promise<void>;
  sendToTab(tabId: number, msg: OverlayCommand): Promise<void>;
}

export const defaultOverlayEnv: OverlayEnv = {
  async injectOverlay(tabId) {
    await browser.scripting.executeScript({
      target: { tabId },
      // Extension-root-relative WITHOUT a leading slash at runtime (Chrome
      // rejects the slash; WXT's generated type wants one — see executors/
      // index.ts runBuildDomTree for the same cast).
      files: ["overlay.js"] as unknown as ["/overlay.js"],
    });
  },
  async sendToTab(tabId, msg) {
    await browser.tabs.sendMessage(tabId, msg);
  },
};

export interface WorkOverlayOptions {
  /** Validated overlay_action from the page's Pause/Resume/✕ buttons. */
  onOverlayAction(action: "pause" | "resume" | "cancel"): void;
}

export class WorkOverlayController {
  private tabId: number | null = null;
  private pausedState = false;

  constructor(
    private readonly env: OverlayEnv,
    private readonly opts: WorkOverlayOptions,
  ) {}

  /** The tab currently showing (or last told to show) the overlay. */
  get showingTab(): number | null {
    return this.tabId;
  }

  get paused(): boolean {
    return this.pausedState;
  }

  /** Show the overlay on the agent's tab, (re)injecting when the page has no
   * listener yet. Injection is best-effort: restricted pages just don't show it. */
  async show(tabId: number, title?: string): Promise<void> {
    this.tabId = tabId;
    await this.recordTab(tabId);
    try {
      await this.env.sendToTab(tabId, { type: "overlay_show", title, paused: this.pausedState });
    } catch {
      try {
        await this.env.injectOverlay(tabId); // installWorkOverlay answers content_ready
      } catch {
        return; // restricted/discarded tab — the overlay is display, never control flow
      }
    }
  }

  async hide(): Promise<void> {
    const tabId = this.tabId;
    this.tabId = null;
    await this.recordTab(null);
    if (tabId === null) return;
    try {
      await this.env.sendToTab(tabId, { type: "overlay_hide" });
    } catch {
      // Page navigated away and took the overlay with it.
    }
  }

  /** M4-5: a SW killed mid-task leaves the page-side overlay orphaned (it
   * outlives the SW until the page navigates). On every SW wake, hide whatever
   * the dead SW last showed — a fresh SW has no active task, so this is always
   * safe, and a task started later re-shows via show(). */
  async recoverAfterRestart(): Promise<void> {
    try {
      const stored = await browser.storage.local.get(OVERLAY_TAB_KEY);
      const tabId = stored[OVERLAY_TAB_KEY];
      await browser.storage.local.remove(OVERLAY_TAB_KEY);
      if (typeof tabId !== "number") return;
      this.tabId = tabId;
      await this.hide();
    } catch {
      // Storage unavailable (tests without fakeBrowser) — display-only, never
      // control flow.
    }
  }

  private async recordTab(tabId: number | null): Promise<void> {
    try {
      if (tabId === null) await browser.storage.local.remove(OVERLAY_TAB_KEY);
      else await browser.storage.local.set({ [OVERLAY_TAB_KEY]: tabId });
    } catch {
      // Same display-only posture as recoverAfterRestart.
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    this.pausedState = paused;
    const tabId = this.tabId;
    if (tabId === null) return;
    try {
      await this.env.sendToTab(tabId, { type: "overlay_paused", paused });
    } catch {
      // The overlay re-syncs via content_ready after the next injection.
    }
  }

  /** browser.runtime.onMessage landing pad: firewall first, then dispatch. */
  handleContentMessage(msg: unknown, sender: SenderLike | undefined): void {
    const type =
      typeof msg === "object" && msg !== null ? String((msg as { type?: unknown }).type ?? "") : "";
    if (!contentMessageAllowed(type, sender)) return;

    if (type === "content_ready") {
      // Fresh injection (navigation or first show): re-apply our current state.
      const tabId = tabIdOf(sender);
      if (tabId !== undefined && tabId === this.tabId) {
        void this.env
          .sendToTab(tabId, { type: "overlay_show", paused: this.pausedState })
          .catch(() => null);
      }
      return;
    }
    if (type === "overlay_action") {
      const action = (msg as { action?: unknown }).action;
      if (action === "pause" || action === "resume" || action === "cancel") {
        if (action !== "cancel") this.pausedState = action === "pause";
        this.opts.onOverlayAction(action);
      }
    }
    // pick_response is allowlisted for the future armed-picker flow (M5/backlog)
    // — nothing to dispatch yet.
  }
}

function tabIdOf(sender: SenderLike | undefined): number | undefined {
  const tab = sender?.tab;
  if (typeof tab === "object" && tab !== null && typeof (tab as { id?: unknown }).id === "number") {
    return (tab as { id: number }).id;
  }
  return undefined;
}
