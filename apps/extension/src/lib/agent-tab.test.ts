// Agent tab manager tests (T1): the REAL resolve/fallback logic against fake
// hosts, and defaultAgentTabHost against fakeBrowser — where tabs.group and
// tabGroups don't exist, so the graceful-degradation paths are the honest ones.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  AgentTabManager,
  JUNIOR_TAB_GROUP_TITLE,
  defaultAgentTabHost,
  type AgentTabHost,
  type TabLike,
} from "./agent-tab";

function fakeHost(
  seed: { tabs?: Map<number, TabLike>; groupTab?: TabLike | null } = {},
): AgentTabHost & {
  created: number;
  remembered: number[];
  tabs: Map<number, TabLike>;
} {
  const tabs = seed.tabs ?? new Map<number, TabLike>();
  return {
    tabs,
    created: 0,
    remembered: [],
    async recall() {
      return this.remembered.at(-1) ?? null;
    },
    async remember(id) {
      this.remembered.push(id);
    },
    async getTab(id) {
      return tabs.get(id) ?? null;
    },
    async findExisting() {
      return seed.groupTab ?? null;
    },
    async create() {
      this.created++;
      const tab: TabLike = {
        id: 100 + this.created,
        url: "about:blank",
        title: "",
        status: "unloaded",
      };
      tabs.set(tab.id!, tab);
      return tab;
    },
  };
}

interface StubGroup {
  id: number;
  title: string;
  color: string;
  windowId?: number;
}

/** Stub the unimplemented tabs.group / tabGroups APIs onto fakeBrowser (M5-7
 * pattern). fakeBrowser's tabs.query ignores groupId — stand in a groupId-aware
 * one (tabs.get hands back a copy, so the mapping lives in a Map). */
function stubTabGroups() {
  let nextGroupId = 1;
  const groups = new Map<number, StubGroup>();
  const groupIdOfTab = new Map<number, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyBrowser = fakeBrowser as any;
  const prevGroup = anyBrowser.tabs.group;
  const prevQuery = anyBrowser.tabs.query;
  const prevTabGroups = anyBrowser.tabGroups;
  anyBrowser.tabs.group = async (opts: { tabIds: number; groupId?: number }) => {
    let id = opts.groupId;
    if (id === undefined) {
      id = nextGroupId++;
      groups.set(id, { id, title: "", color: "grey" });
    }
    groupIdOfTab.set(opts.tabIds, id);
    return id;
  };
  anyBrowser.tabs.query = async (qi: Record<string, unknown>) =>
    (await prevQuery.call(anyBrowser.tabs, qi)).filter(
      (t: { id: number }) => qi.groupId === undefined || groupIdOfTab.get(t.id) === qi.groupId,
    );
  anyBrowser.tabGroups = {
    query: async (qi: { title?: string }) =>
      [...groups.values()].filter((g) => qi.title === undefined || g.title === qi.title),
    update: async (id: number, props: { title?: string; color?: string }) => {
      const g = groups.get(id);
      if (g) Object.assign(g, props);
      return g;
    },
  };
  return {
    groups,
    groupIdOfTab,
    restore() {
      anyBrowser.tabs.group = prevGroup;
      anyBrowser.tabs.query = prevQuery;
      if (prevTabGroups === undefined) delete anyBrowser.tabGroups;
      else anyBrowser.tabGroups = prevTabGroups;
    },
  };
}

beforeEach(() => fakeBrowser.reset());

describe("AgentTabManager", () => {
  it("creates once and reuses the cached tab — user focus changes cannot retarget it", async () => {
    const host = fakeHost();
    const manager = new AgentTabManager(host);
    const first = await manager.resolve();
    expect(first?.id).toBe(101);
    expect(host.created).toBe(1);
    const again = await manager.resolve();
    expect(again?.id).toBe(101);
    expect(host.created).toBe(1); // no second create
  });

  it("recovers via the group search when the remembered tab was closed", async () => {
    const host = fakeHost();
    const manager = new AgentTabManager(host);
    const first = await manager.resolve();
    expect(first?.id).toBe(101); // created
    host.tabs.delete(101); // the user closed it
    host.tabs.set(7, { id: 7, url: "https://fixture.junior.test/", title: "t" });
    host.findExisting = async () => host.tabs.get(7) ?? null; // the "Junior" group
    const second = await manager.resolve();
    expect(second?.id).toBe(7); // group recovery, not a new tab
    expect(host.created).toBe(1);
    expect(host.remembered.at(-1)).toBe(7);
  });

  it("recalls the remembered id across a manager restart (SW death)", async () => {
    const host = fakeHost();
    await new AgentTabManager(host).resolve();
    // A fresh SW = a fresh manager; the remembered id short-circuits the search.
    const second = new AgentTabManager(host);
    const tab = await second.resolve();
    expect(tab?.id).toBe(101);
    expect(host.created).toBe(1);
  });

  it("concurrent resolves at task start share ONE create (overlay + first action)", async () => {
    for (const callers of [2, 3]) {
      const host = fakeHost();
      // A real create is slow (tabs.create + group + label) — yield so the
      // callers genuinely overlap.
      const realCreate = host.create.bind(host);
      host.create = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return await realCreate();
      };
      const manager = new AgentTabManager(host);
      const tabs = await Promise.all(Array.from({ length: callers }, () => manager.resolve()));
      expect(host.created).toBe(1);
      expect(new Set(tabs.map((t) => t?.id))).toEqual(new Set([101]));
    }
  });

  it("a failed resolve does not wedge later calls", async () => {
    const host = fakeHost();
    const realCreate = host.create.bind(host);
    host.create = async () => {
      throw new Error("tabs.create failed");
    };
    const manager = new AgentTabManager(host);
    await expect(Promise.all([manager.resolve(), manager.resolve()])).rejects.toThrow(
      "tabs.create failed",
    );
    host.create = realCreate;
    await expect(manager.resolve()).resolves.toMatchObject({ id: 101 });
  });

  it("resolves null when create yields an id-less tab", async () => {
    const host = fakeHost();
    host.create = async () => ({ url: "about:blank" });
    await expect(new AgentTabManager(host).resolve()).resolves.toBeNull();
  });
});

describe("defaultAgentTabHost (fakeBrowser)", () => {
  it("creates a background pinned tab and degrades to ungrouped without tabGroups", async () => {
    const tab = await defaultAgentTabHost.create();
    expect(tab.id).toBeDefined();
    const stored = await fakeBrowser.tabs.get(tab.id!);
    expect(stored.pinned).toBe(true);
  });

  it("groups + labels the created tab when the tabGroups APIs exist", async () => {
    const stub = stubTabGroups();
    try {
      const tab = await defaultAgentTabHost.create();
      const group = [...stub.groups.values()][0];
      expect(group).toBeDefined();
      expect(group!.title).toBe(JUNIOR_TAB_GROUP_TITLE);
      expect(group!.color).toBe("blue");
      await expect(defaultAgentTabHost.findExisting()).resolves.toMatchObject({ id: tab.id });
    } finally {
      stub.restore();
    }
  });

  it("create joins an existing Junior group instead of making a second one", async () => {
    const stub = stubTabGroups();
    // A leftover "Junior" group with no tab findExisting can adopt (the
    // remembered tab is gone).
    stub.groups.set(9, { id: 9, title: JUNIOR_TAB_GROUP_TITLE, color: "blue", windowId: 1 });
    try {
      const tab = await defaultAgentTabHost.create();
      expect(stub.groups.size).toBe(1);
      expect(stub.groupIdOfTab.get(tab.id!)).toBe(9);
    } finally {
      stub.restore();
    }
  });

  it("findExisting returns null with no Junior group; getTab nulls on closed ids", async () => {
    await expect(defaultAgentTabHost.findExisting()).resolves.toBeNull();
    await expect(defaultAgentTabHost.getTab(424242)).resolves.toBeNull();
  });

  it("recall/remember round-trips through storage.local", async () => {
    await expect(defaultAgentTabHost.recall()).resolves.toBeNull();
    await defaultAgentTabHost.remember(31);
    await expect(defaultAgentTabHost.recall()).resolves.toBe(31);
  });
});
