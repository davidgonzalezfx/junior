// T5b media tool: juniorMediaInPage against jsdom (fake playback model), and the
// runner's media path — state across frames, the guard/approval path, and the
// keyboard fallback.
/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMedia, makeVisible, stubJsdomElementBasics } from "@junior/testkit/jsdom";
import type { ApprovalRequest, PermissionMode } from "@junior/protocol";
import { executeAction, type ExecutorEnv } from "./index";
import { juniorMediaInPage, mediaLine } from "./media";

beforeAll(() => {
  stubJsdomElementBasics();
});

function setBody(html: string): void {
  document.body.innerHTML = html;
  document.body.querySelectorAll("*").forEach(makeVisible);
}

function video(id: string): HTMLVideoElement {
  return document.getElementById(id) as HTMLVideoElement;
}

describe("juniorMediaInPage", () => {
  beforeEach(() => {
    setBody(`
      <div data-purpose="video-player"><video id="lecture" src="https://cdn.example/l.mp4"></video></div>
      <audio id="ping" src="https://cdn.example/ping.mp3"></audio>
    `);
    fakeMedia(video("lecture"), { duration: 632.4 });
    fakeMedia(document.getElementById("ping") as HTMLMediaElement, { duration: 2 });
  });

  it("state lists every media element with a stable index", async () => {
    const res = await juniorMediaInPage({ op: "state" });
    expect(res).toMatchObject({
      ok: true,
      media: [
        { index: 0, tag: "video", paused: true, duration: 632.4, label: "video-player" },
        { index: 1, tag: "audio", paused: true },
      ],
    });
  });

  it("play / pause / seek / mute run the media API and report the state after", async () => {
    expect(await juniorMediaInPage({ op: "play", index: 0 })).toMatchObject({
      ok: true,
      message: "Playing",
      media: [{ paused: false }],
    });
    expect(await juniorMediaInPage({ op: "seek", index: 0, time: 90 })).toMatchObject({
      ok: true,
      media: [{ currentTime: 90 }],
    });
    expect(
      await juniorMediaInPage({ op: "mute", selector: "[data-purpose=video-player]" }),
    ).toMatchObject({
      ok: true,
      media: [{ muted: true, index: 0 }],
    });
    expect(await juniorMediaInPage({ op: "pause" })).toMatchObject({
      ok: true,
      message: "Paused",
      media: [{ paused: true, index: 0 }],
    });
  });

  it("an autoplay-policy rejection says so and offers the muted play", async () => {
    fakeMedia(video("lecture"), { autoplayBlocked: true });
    const res = await juniorMediaInPage({ op: "play", index: 0 });
    expect(res).toMatchObject({ ok: false, media: [{ paused: true }] });
    if (!res.ok) {
      expect(res.error).toContain("autoplay policy");
      expect(res.error).toContain("media mute, then play");
    }
    await juniorMediaInPage({ op: "mute", index: 0 });
    expect(await juniorMediaInPage({ op: "play", index: 0 })).toMatchObject({ ok: true });
  });

  it("a play() that never settles is reported as pending, not hung", async () => {
    fakeMedia(video("lecture"), { stalled: true });
    const res = await juniorMediaInPage({ op: "play", index: 0, playTimeoutMs: 10 });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.message).toContain("still pending");
  });

  it("a missing target is an error with the count, never another element", async () => {
    const res = await juniorMediaInPage({ op: "pause", index: 5 });
    expect(res).toMatchObject({ ok: false, noMedia: false });
    if (!res.ok) expect(res.error).toContain("m5");
  });

  it("finds media inside open shadow roots", async () => {
    setBody(`<div id="host"></div>`);
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<video src="x.mp4"></video>`;
    expect(await juniorMediaInPage({ op: "state" })).toMatchObject({ media: [{ tag: "video" }] });
  });

  it("keyboard fallback: no media element → the player gets the play/pause key", async () => {
    setBody(`<div id="movie_player" class="html5-player"></div>`);
    const keys: string[] = [];
    document.getElementById("movie_player")!.addEventListener("keydown", (e) => keys.push(e.key));
    const res = await juniorMediaInPage({ op: "pause", keyboardFallback: true });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.message).toContain("key was sent to <div#movie_player>");
    expect(keys).toEqual([" "]);
  });
});

describe("mediaLine", () => {
  it("prints a frame-qualified target and the DRM screenshot note", () => {
    const line = mediaLine(
      {
        index: 0,
        tag: "video",
        paused: false,
        ended: false,
        currentTime: 65,
        duration: 632.4,
        readyState: 4,
        muted: false,
        playbackRate: 1.5,
        width: 640,
        height: 360,
        visible: true,
        drm: true,
        src: "blob: (stream)",
        label: "Lecture 3",
        error: "",
      },
      7,
    );
    expect(line).toBe(
      '[f7:m0] video playing 1:05/10:32 (65s of 632.4s) ready=enough-data muted=no rate=1.5 640x360 drm=yes (screenshots of it render black) "Lecture 3" src=blob: (stream)',
    );
  });
});

describe("executeAction media", () => {
  function env(mode: PermissionMode, frames = false): ExecutorEnv {
    return {
      getActiveTab: async () => ({ id: 1, url: "https://learn.example/lecture/1" }),
      runInPage: async () => ({ ok: false, error: "unused" }),
      runReadInPage: async () => ({ ok: false, error: "unused" }),
      runBuildDomTree: async () => null,
      runMediaInPage: async (_tab, args) => await juniorMediaInPage(args),
      listFrames: frames
        ? async () => [
            { frameId: 0, url: "https://learn.example/lecture/1", coveredByParent: false },
          ]
        : undefined,
      captureVisibleTab: async () => "",
      permissionMode: async () => mode,
      blockedOrigins: async () => [],
      navigateTab: async () => {},
    };
  }

  beforeEach(() => {
    setBody(`<video id="v" aria-label="Lecture 3" src="https://cdn.example/l.mp4"></video>`);
    fakeMedia(video("v"));
  });

  it("state is a read: no approval card even in ask mode", async () => {
    const ask = vi.fn(async () => "deny" as const);
    const res = await executeAction({ kind: "media", op: "state" }, env("ask", true), { ask });
    expect(res).toMatchObject({ status: "ok" });
    expect(String(res.result)).toMatch(/^\[m0\] video paused 0:00\/10:00/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("controls go through the approval path with the element's facts", async () => {
    let card: ApprovalRequest | undefined;
    const ask = vi.fn(async (a: ApprovalRequest) => {
      card = a;
      return "deny" as const;
    });
    const denied = await executeAction({ kind: "media", op: "play" }, env("ask"), { ask });
    expect(denied.status).toBe("denied");
    expect(card?.element).toMatchObject({ tag: "video", text: "play: Lecture 3" });
    expect(video("v").paused).toBe(true);

    const ok = await executeAction({ kind: "media", op: "play", target: "m0" }, env("auto"));
    expect(ok).toMatchObject({ status: "ok" });
    expect(String(ok.result)).toMatch(/^Playing\n\[m0\] video playing/);
  });
});
