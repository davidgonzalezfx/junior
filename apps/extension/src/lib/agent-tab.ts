// lib/agent-tab.ts — the agent's dedicated tab (T1, docs/workplan-post-m5.md).
// Per-action "active tab" resolution raced the user switching tabs and injected
// into THEIR page (the reported Gmail/WhatsApp leak). Every action now targets
// the agent's own tab: the cached id re-verified, else a tab recovered from the
// "Junior" tab group, else a new pinned tab created and grouped. The tab
// persists across tasks — it is Junior's workspace, and the user's tabs are
// never a target (get_active_tab within agent context reports the agent tab).
//
// Multi-window policy (v1): the tab lives in the window where it was created;
// cross-window agent tasks remain an M6 seed. Grouping is labeling only — a
// working ungrouped tab beats a failed create, so tabGroups failures degrade.
import { browser } from "wxt/browser";
import type { ActiveTab, ExecutorEnv } from "./executors";

export const JUNIOR_TAB_GROUP_TITLE = "Junior";
const AGENT_TAB_KEY = "junior_agent_tab";

/** The slice of chrome.tabs.Tab the manager needs (browser Tab is assignable). */
export interface TabLike {
  id?: number;
  url?: string;
  title?: string;
  status?: string;
  windowId?: number;
}

/** Browser surface of the tab manager — injected so tests run the REAL logic
 * against fakes (fakeBrowser has no tabs.group / tabGroups). */
export interface AgentTabHost {
  /** Last remembered agent tab id (storage.local), or null. */
  recall(): Promise<number | null>;
  remember(id: number): Promise<void>;
  /** The tab by id, or null once it no longer exists. */
  getTab(id: number): Promise<TabLike | null>;
  /** An existing tab in the "Junior" group, or null. */
  findExisting(): Promise<TabLike | null>;
  /** Create the agent tab pinned, grouped "Junior" (grouping best effort). */
  create(): Promise<TabLike>;
}

export class AgentTabManager {
  private cachedId: number | null = null;

  constructor(private readonly host: AgentTabHost) {}

  /** The agent tab — same id for the whole task regardless of user focus. */
  async resolve(): Promise<ActiveTab | null> {
    const remembered = this.cachedId ?? (await this.host.recall());
    if (remembered !== null) {
      const tab = await this.host.getTab(remembered);
      if (tab?.id !== undefined) return await this.hold(tab);
      this.cachedId = null; // closed — fall through to group/create
    }
    const existing = await this.host.findExisting();
    if (existing?.id !== undefined) return await this.hold(existing);
    const created = await this.host.create();
    if (created.id === undefined) return null;
    return await this.hold(created);
  }

  private async hold(tab: TabLike): Promise<ActiveTab> {
    this.cachedId = tab.id!; // every caller checked id !== undefined
    await this.host.remember(this.cachedId);
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      windowId: tab.windowId,
    };
  }
}

export const defaultAgentTabHost: AgentTabHost = {
  async recall() {
    const stored = await browser.storage.local.get(AGENT_TAB_KEY);
    const id = stored[AGENT_TAB_KEY];
    return typeof id === "number" ? id : null;
  },
  async remember(id) {
    await browser.storage.local.set({ [AGENT_TAB_KEY]: id });
  },
  async getTab(id) {
    // Chrome rejects unknown ids; fakeBrowser resolves undefined instead —
    // both mean "gone".
    const tab = await browser.tabs.get(id).catch(() => null);
    return tab ?? null;
  },
  async findExisting() {
    try {
      const groups = await browser.tabGroups.query({ title: JUNIOR_TAB_GROUP_TITLE });
      for (const group of groups) {
        const [first] = await browser.tabs.query({ groupId: group.id });
        if (first?.id !== undefined) return first;
      }
    } catch {
      return null;
    }
    return null;
  },
  async create() {
    const tab = await browser.tabs.create({ active: false, pinned: true });
    try {
      if (tab.id !== undefined) {
        const groupId = await browser.tabs.group({
          tabIds: tab.id,
          createProperties: tab.windowId === undefined ? undefined : { windowId: tab.windowId },
        });
        await browser.tabGroups.update(groupId, {
          title: JUNIOR_TAB_GROUP_TITLE,
          color: "blue",
        });
      }
    } catch {
      // Grouping is cosmetic labeling — see the module comment.
    }
    return tab;
  },
};

/** ExecutorEnv view where "the active tab" IS the agent tab — the T1 isolation
 * point. Wiring the loop with this makes every action (and the work overlay,
 * which resolves its tab through the same env) target the agent tab. */
export function withAgentTab(env: ExecutorEnv, manager: AgentTabManager): ExecutorEnv {
  return { ...env, getActiveTab: () => manager.resolve() };
}
