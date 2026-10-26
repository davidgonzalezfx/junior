// T5a — frame-aware page actions through the REAL bridge → loop → executor chain.
// The fixture page embeds a same-origin comments iframe (the parent can script it)
// and a cross-origin player iframe (a separate realm the parent cannot reach), so
// read_page, click, type and scroll must route into the player by frameId.
//
// jsdom limits (covered by the real-Chrome checklist instead): no real layout or
// scrolling, no `src` loading (fixture HTML is mounted directly), and the
// cross-origin wall is modeled by realm separation — the parent's <iframe> is an
// empty about:blank document, not a SecurityError.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BLOCKED_SENSITIVE_TEXT } from "@junior/protocol";
import { startHarness, type FakeFrame, type FakePage, type Harness } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "../fixtures/frames", name), "utf8");

const TOP_URL = "https://recipes.example/weeknight";
const COMMENTS_FRAME = 3;
const PLAYER_FRAME = 7;

function framesPage(playerUrl = "https://player.example/embed/abc123"): FakePage {
  const frames: FakeFrame[] = [
    {
      frameId: COMMENTS_FRAME,
      url: "https://recipes.example/embed/comments.html",
      iframeId: "comments-frame",
      html: fixture("comments.html"),
    },
    {
      frameId: PLAYER_FRAME,
      url: playerUrl,
      iframeId: "player-frame",
      html: fixture("player.html"),
      onShow: (doc) => {
        doc.getElementById("play-btn")?.addEventListener("click", () => {
          doc.getElementById("player-state")!.textContent = "Player playing";
        });
      },
    },
  ];
  return { title: "Weeknight recipes", html: fixture("top.html"), frames };
}

async function withHarness(
  page: FakePage,
  mode: "auto" | "ask",
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await startHarness({ tabUrl: TOP_URL, pages: { [TOP_URL]: page }, mode });
  try {
    await h.waitConnected();
    await run(h);
  } finally {
    await h.stop();
  }
}

/** The index printed for the outline line containing `label`. */
function indexOf(outline: string, label: string): string {
  const line = outline.split("\n").find((l) => l.includes(label));
  expect(line, `no outline line for ${label}:\n${outline}`).toBeDefined();
  return /^\[([^\]]+)\]/.exec(line!)![1]!;
}

describe("T5a — iframes in the agent tab", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("outline keeps top-frame indices and adds the cross-origin frame qualified", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const res = await h.dispatch({ kind: "read_page", mode: "outline" });
      expect(res.status).toBe("ok");
      const outline = String(res.result);
      // Top frame (with its same-origin child) prints exactly what it printed before T5a.
      const [top] = outline.split("\n--- iframe");
      expect(top).toBe(
        [
          '[0] button "Save recipe"',
          "[1] input",
          '[2] button "Post comment"',
          '[3] a "About us" (/about)',
        ].join("\n"),
      );
      expect(outline).toContain(`--- iframe f${PLAYER_FRAME} https://player.example/embed/abc123`);
      expect(outline).toContain(`[f${PLAYER_FRAME}:0] button "Play"`);
      // The same-origin frame is not listed twice.
      expect(outline).not.toContain(`f${COMMENTS_FRAME}`);
    });
  });

  it("clicks a button inside the cross-origin iframe by its qualified index", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const outline = String((await h.dispatch({ kind: "read_page", mode: "outline" })).result);
      const play = indexOf(outline, '"Play"');
      expect(play).toBe(`f${PLAYER_FRAME}:0`);
      const res = await h.dispatch({ kind: "click", target: play });
      expect(res).toMatchObject({ status: "ok" });
      // T5b: the result names the element, how it matched, and the frame.
      expect(String(res.result)).toMatch(
        new RegExp(`Click performed on <button>.*matched by index.* in iframe f${PLAYER_FRAME} `),
      );
      expect(h.tab.frameDocument(PLAYER_FRAME).getElementById("player-state")!.textContent).toBe(
        "Player playing",
      );
    });
  });

  it("a plain top-frame index still clicks the top frame", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      let saved = 0;
      h.tab.document.getElementById("top-btn")!.addEventListener("click", () => saved++);
      await h.dispatch({ kind: "read_page", mode: "outline" });
      const res = await h.dispatch({ kind: "click", target: "0" });
      expect(res.status).toBe("ok");
      expect(saved).toBeGreaterThan(0);
    });
  });

  it("types into an iframe input (text target scoped to the frame)", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const res = await h.dispatch({
        kind: "type",
        target: `f${PLAYER_FRAME}:Your email`,
        text: "cook@example.com",
      });
      expect(res).toMatchObject({ status: "ok" });
      const input = h.tab.frameDocument(PLAYER_FRAME).getElementById("sub-email");
      expect((input as HTMLInputElement).value).toBe("cook@example.com");
    });
  });

  it("refuses a secret field inside an iframe exactly like the top frame", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const res = await h.dispatch({
        kind: "type",
        target: `f${PLAYER_FRAME}:Choose a password`,
        text: "hunter2",
      });
      expect(res.status).toBe("denied");
      expect(res.error).toBe(BLOCKED_SENSITIVE_TEXT);
      const pw = h.tab.frameDocument(PLAYER_FRAME).getElementById("sub-pw");
      expect((pw as HTMLInputElement).value).toBe("");
    });
  });

  it("the guard reads the frame's own site: a sensitive-origin iframe raises a card", async () => {
    await withHarness(framesPage("https://www.chase.com/widget"), "auto", async (h) => {
      h.answerNext("deny");
      const res = await h.dispatch({ kind: "click", target: `f${PLAYER_FRAME}:Play video` });
      expect(res.status).toBe("denied");
      expect(h.cards).toHaveLength(1);
      expect(h.tab.frameDocument(PLAYER_FRAME).getElementById("player-state")!.textContent).toBe(
        "Player paused",
      );
    });
  });

  it("text mode includes iframe text under frame headers; section can scope to a frame", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const text = await h.dispatch({ kind: "read_page", mode: "text" });
      expect(text.status).toBe("ok");
      expect(String(text.result)).toContain("Weeknight recipes");
      expect(String(text.result)).toContain(`--- iframe f${PLAYER_FRAME}`);
      expect(String(text.result)).toContain("Player paused");

      const section = await h.dispatch({
        kind: "read_page",
        mode: "section",
        selector: `f${PLAYER_FRAME}:#player-state`,
      });
      expect(section).toMatchObject({ status: "ok" });
      expect(String(section.result)).toContain("Player paused");

      // An unscoped selector that only matches inside a frame is still found.
      const fallback = await h.dispatch({
        kind: "read_page",
        mode: "section",
        selector: "#player-state",
      });
      expect(String(fallback.result)).toContain("Player paused");
    });
  });

  it("scroll can target a frame and refuses an unknown one", async () => {
    await withHarness(framesPage(), "auto", async (h) => {
      const scrolled: number[] = [];
      for (const f of h.tab.frames()) f.window.scrollBy = () => scrolled.push(f.frameId);
      const ok = await h.dispatch({ kind: "scroll", direction: "down", frame: `f${PLAYER_FRAME}` });
      expect(ok.status).toBe("ok");
      expect(scrolled).toEqual([PLAYER_FRAME]);
      const bad = await h.dispatch({ kind: "click", target: "f99:0" });
      expect(bad.status).toBe("error");
      expect(bad.error).toMatch(/Frame f99 not found/);
    });
  });
});
