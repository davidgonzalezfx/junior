// T5b — the media tool through the REAL bridge → loop → executor chain: the
// lecture video sits in a cross-origin player iframe (YouTube-embed shape), so
// state, play and pause must find it there and run in that frame; controls take
// the same approval path as click.
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { fakeMedia } from "@junior/testkit/jsdom";
import { startHarness, type FakePage, type Harness } from "./harness";

const TOP_URL = "https://course.example/lecture/3";
const PLAYER_FRAME = 9;

function lecturePage(opts: { autoplayBlocked?: boolean } = {}): FakePage {
  return {
    title: "Lecture 3",
    html: `<h1>Lecture 3</h1><a href="/">Home</a><iframe id="player" width="640" height="360"></iframe>`,
    frames: [
      {
        frameId: PLAYER_FRAME,
        url: "https://player.example/embed/xyz",
        iframeId: "player",
        html: `<div id="movie_player" aria-label="Lecture player"><video src="https://cdn.example/l3.mp4"></video></div>`,
        onShow: (doc) => fakeMedia(doc.querySelector("video")!, { duration: 754, ...opts }),
      },
    ],
  };
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

describe("T5b — media tool", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("reads state across frames, plays, reads again, pauses, confirms paused", async () => {
    await withHarness(lecturePage(), "auto", async (h) => {
      const state = await h.dispatch({ kind: "media" });
      expect(state.status).toBe("ok");
      expect(String(state.result)).toContain(
        `--- iframe f${PLAYER_FRAME} https://player.example/embed/xyz ---`,
      );
      expect(String(state.result)).toMatch(
        new RegExp(`\\[f${PLAYER_FRAME}:m0\\] video paused 0:00/12:34`),
      );

      const play = await h.dispatch({ kind: "media", op: "play" });
      expect(play.status).toBe("ok");
      expect(String(play.result)).toContain(`Playing in iframe f${PLAYER_FRAME}`);

      const pause = await h.dispatch({ kind: "media", op: "pause", target: `f${PLAYER_FRAME}:m0` });
      expect(String(pause.result)).toContain("Paused");
      const after = await h.dispatch({ kind: "media", op: "state", target: `f${PLAYER_FRAME}:m0` });
      expect(String(after.result)).toMatch(/video paused/);
    });
  });

  it("autoplay-blocked play is an error that names the policy, then muted play works", async () => {
    await withHarness(lecturePage({ autoplayBlocked: true }), "auto", async (h) => {
      const blocked = await h.dispatch({ kind: "media", op: "play" });
      expect(blocked.status).toBe("error");
      expect(blocked.error).toContain("autoplay policy");
      await h.dispatch({ kind: "media", op: "mute" });
      expect((await h.dispatch({ kind: "media", op: "play" })).status).toBe("ok");
    });
  });

  it("ask mode: a control raises a card on the video; deny leaves it paused", async () => {
    await withHarness(lecturePage(), "ask", async (h) => {
      h.answerNext("deny");
      const res = await h.dispatch({ kind: "media", op: "play" });
      expect(res.status).toBe("denied");
      expect(h.cards.at(-1)?.element).toMatchObject({ tag: "video" });
      const state = await h.dispatch({ kind: "media" });
      expect(String(state.result)).toMatch(/video paused/);
    });
  });
});
