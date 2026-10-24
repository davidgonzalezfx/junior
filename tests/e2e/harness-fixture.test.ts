// M3-5 fake-model harness — fixture-origin scenarios (plan §8 M3-5): the harness
// plays the model, pushing raw queue items through the REAL bridge (Hono app +
// Dispatcher + SessionGuard, from source) and the REAL extension loop/executors
// against tests/fixtures/page.html. No LLM anywhere. This file covers the
// routine matrix on a normal site: every action kind, zero cards in auto mode;
// secret-field refusal in every mode; policy denials for javascript:/private.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCKED_BY_POLICY_TEXT, BLOCKED_SENSITIVE_TEXT } from "@junior/protocol";
import { startHarness, type FakePage, type Harness } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = "https://fixture.junior.test/index.html";
const PAGE2_URL = "https://fixture.junior.test/second.html";

const fixturePage: FakePage = {
  title: "Junior Fixture",
  html: readFileSync(join(HERE, "../fixtures/page.html"), "utf8"),
  onShow: (doc) => {
    doc.getElementById("save-btn")?.addEventListener("click", () => {
      doc.getElementById("status")!.textContent = "saved!";
    });
  },
};

async function withHarness(
  mode: Harness["mode"],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await startHarness({
    tabUrl: FIXTURE_URL,
    pages: {
      [FIXTURE_URL]: fixturePage,
      [PAGE2_URL]: {
        title: "Junior Fixture — Second",
        html: "<h1>Second page</h1><p>After navigation.</p>",
      },
    },
    mode,
  });
  try {
    await run(h);
  } finally {
    await h.stop();
  }
}

describe("fake-model harness — fixture page (M3-5)", () => {
  it(
    "drives every action kind on the fixture page with zero cards in auto mode",
    { timeout: 30_000 },
    async () => {
      await withHarness("auto", async (h) => {
        await h.waitConnected();

        const active = await h.dispatch({ kind: "get_active_tab" });
        expect(active.status).toBe("ok");
        expect(active.result).toMatchObject({ url: FIXTURE_URL, title: "Junior Fixture" });

        const text = await h.dispatch({ kind: "read_page", mode: "text" });
        expect(text.status).toBe("ok");
        expect(String(text.result)).toContain("Junior fixture page");

        const outline = await h.dispatch({ kind: "read_page", mode: "outline" });
        expect(outline.status).toBe("ok");
        expect(String(outline.result)).toMatch(/^\[\d+\]/m);
        expect(String(outline.result)).toContain("Save changes");

        const interactive = await h.dispatch({ kind: "read_page", mode: "interactive" });
        expect(interactive.status).toBe("ok");
        expect(String(interactive.result)).toContain("input type=text");
        expect(String(interactive.result)).toContain("Save changes");

        const click = await h.dispatch({ kind: "click", target: "#save-btn" });
        expect(click.status).toBe("ok");
        expect(h.tab.document.getElementById("status")!.textContent).toBe("saved!");

        const typed = await h.dispatch({ kind: "type", target: "#username", text: "junior-fan" });
        expect(typed.status).toBe("ok");
        expect((h.tab.document.getElementById("username") as HTMLInputElement).value).toBe(
          "junior-fan",
        );

        const scroll = await h.dispatch({ kind: "scroll", direction: "down" });
        expect(scroll.status).toBe("ok");

        const shot = await h.dispatch({ kind: "screenshot" });
        expect(shot.status).toBe("ok");
        expect(String((shot.result as { dataUrl?: string }).dataUrl)).toMatch(
          /^data:image\/jpeg;base64,/,
        );

        // Seen-domain navigate is silently allowed in auto…
        const nav = await h.dispatch({ kind: "navigate", url: PAGE2_URL });
        expect(nav.status).toBe("ok");
        expect(h.tab.url).toBe(PAGE2_URL);
        // …and the next read lands on the NEW page (stale DOM map healed).
        const after = await h.dispatch({ kind: "read_page", mode: "text" });
        expect(String(after.result)).toContain("After navigation");

        expect(h.cards).toHaveLength(0);
      });
    },
  );

  it("refuses secret fields in every mode — rule, never a card", { timeout: 30_000 }, async () => {
    await withHarness("auto", async (h) => {
      await h.waitConnected();

      const denied = await h.dispatch({ kind: "type", target: "#password", text: "hunter2" });
      expect(denied.status).toBe("denied");
      expect(denied.error).toBe(BLOCKED_SENSITIVE_TEXT);
      expect((h.tab.document.getElementById("password") as HTMLInputElement).value).toBe("");

      h.mode = "ask";
      const deniedAgain = await h.dispatch({ kind: "type", target: "#password", text: "hunter2" });
      expect(deniedAgain.status).toBe("denied");
      expect(deniedAgain.error).toBe(BLOCKED_SENSITIVE_TEXT);

      expect(h.cards).toHaveLength(0);
    });
  });

  it(
    "blocks javascript: and private-network navigations bridge-side",
    { timeout: 30_000 },
    async () => {
      await withHarness("auto", async (h) => {
        await h.waitConnected();

        const js = await h.dispatch({ kind: "navigate", url: "javascript:alert(1)" });
        expect(js.status).toBe("denied");
        expect(js.error).toContain("Navigation blocked");

        const local = await h.dispatch({ kind: "navigate", url: "http://127.0.0.1:8620/health" });
        expect(local.status).toBe("denied");
        expect(local.error).toBe(BLOCKED_BY_POLICY_TEXT);

        // Nothing reached the panel: both are policy, not user questions.
        expect(h.cards).toHaveLength(0);
      });
    },
  );
});
