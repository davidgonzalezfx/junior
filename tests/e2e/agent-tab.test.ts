// T1 (docs/workplan-post-m5.md) — the wrong-tab privacy bug. Per-action "active
// tab" resolution (chrome.tabs.query) raced the user switching tabs: the agent
// navigated the task's site, the user opened Gmail, and the next read_page
// injected into the MAIL tab — private content to the model. The fix gives the
// agent its own tab; this regression runs the scenario over the real chain
// (bridge → long-poll → AgentLoop → executors) and must hold regardless of the
// user's focus.
import { describe, expect, it } from "vitest";
import { startHarness, type FakePage } from "./harness";

const AGENT_URL = "https://fixture.junior.test/index.html";
const AGENT_NEXT_URL = "https://fixture.junior.test/after.html";
const MAIL_URL = "https://mail.junior.test/inbox";

const agentPage: FakePage = {
  title: "Junior Fixture",
  html: "<h1>Junior fixture page</h1><p>Agent workspace content.</p>",
};

const mailPage: FakePage = {
  title: "WebMail — private",
  html: "<h1>Inbox</h1><p>PRIVATE_MAIL_BODY must never reach the model.</p>",
};

describe("agent tab isolation (T1)", () => {
  it(
    "reads and navigates the agent tab even after the user switches tabs",
    { timeout: 30_000 },
    async () => {
      const h = await startHarness({
        tabUrl: AGENT_URL,
        pages: {
          [AGENT_URL]: agentPage,
          [AGENT_NEXT_URL]: {
            title: "Junior Fixture — After",
            html: "<h1>After page</h1><p>Post-navigation agent content.</p>",
          },
        },
        otherTabs: { 2: { url: MAIL_URL, page: mailPage } },
      });
      try {
        await h.waitConnected();

        // The task starts with the agent tab focused: navigation lands there.
        const nav = await h.dispatch({ kind: "navigate", url: AGENT_NEXT_URL });
        expect(nav.status).toBe("ok");
        expect(h.tabs.get(1)!.url).toBe(AGENT_NEXT_URL);

        // Mid-task the user switches to their own mail tab.
        h.focusTab(2);
        expect(h.tabs.get(2)!.url).toBe(MAIL_URL);

        // get_active_tab reports the AGENT tab within agent context…
        const active = await h.dispatch({ kind: "get_active_tab" });
        expect(active.status).toBe("ok");
        expect(active.result).toMatchObject({ url: AGENT_NEXT_URL });

        // …and the read comes from the agent tab. Pre-fix this injected into
        // the user's inbox and returned PRIVATE_MAIL_BODY to the model.
        const read = await h.dispatch({ kind: "read_page", mode: "text" });
        expect(read.status).toBe("ok");
        expect(String(read.result)).toContain("After page");
        expect(String(read.result)).not.toContain("PRIVATE_MAIL_BODY");

        // Actions after the switch still target the agent tab; the user's tab
        // is never touched.
        const nav2 = await h.dispatch({ kind: "navigate", url: AGENT_URL });
        expect(nav2.status).toBe("ok");
        expect(h.tabs.get(1)!.url).toBe(AGENT_URL);
        expect(h.tabs.get(2)!.url).toBe(MAIL_URL);
      } finally {
        await h.stop();
      }
    },
  );
});
