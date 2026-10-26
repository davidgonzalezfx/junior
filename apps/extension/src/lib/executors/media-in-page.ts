// lib/executors/media-in-page.ts — the in-page half of the media tool (T5b):
// reads and controls <video>/<audio> through the HTMLMediaElement API in the
// frame that owns the element. `index` is the element's position among the
// frame's media in document order (open shadow roots included) — the `m<N>`
// of a media target.
//
// juniorMediaInPage is SELF-CONTAINED by the executeScript contract (see
// in-page.ts); serialization.test.ts rebuilds it from source to prove it.

export type MediaOp = "state" | "play" | "pause" | "seek" | "mute" | "unmute";

export interface MediaInPageRequest {
  op: MediaOp;
  /** `m<N>` → N. Omitted with no selector = state of all, or the largest video. */
  index?: number;
  selector?: string;
  /** seek: seconds from the start. */
  time?: number;
  /** play: how long to wait for play() to settle before reporting "pending". */
  playTimeoutMs?: number;
  /** play/pause with no media element in this frame: focus the player and send
   * its keyboard shortcut instead (synthetic keys — players may ignore them). */
  keyboardFallback?: boolean;
}

export interface MediaState {
  index: number;
  tag: "video" | "audio";
  paused: boolean;
  ended: boolean;
  currentTime: number;
  /** null while unknown (NaN) or for a live stream (Infinity). */
  duration: number | null;
  readyState: number;
  muted: boolean;
  playbackRate: number;
  width: number;
  height: number;
  visible: boolean;
  /** Encrypted (EME) playback: screenshots of it render black. */
  drm: boolean;
  src: string;
  label: string;
  error: string;
}

export type MediaInPageResponse =
  | { ok: true; message: string; media: MediaState[] }
  | { ok: false; error: string; media?: MediaState[]; noMedia?: boolean };

export async function juniorMediaInPage(args: MediaInPageRequest): Promise<MediaInPageResponse> {
  function clean(s: string | null | undefined): string {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function deepQueryAll(selector: string): Element[] {
    const roots: (Document | ShadowRoot)[] = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from((roots[i] as Document | ShadowRoot).querySelectorAll("*"))) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots.flatMap((r) => Array.from(r.querySelectorAll(selector)));
  }

  const all = deepQueryAll("video, audio") as HTMLMediaElement[];

  function stateOf(el: HTMLMediaElement): MediaState {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const labelled = el.closest("[aria-label]");
    const purpose = el.closest("[data-purpose]");
    const src = el.currentSrc || el.getAttribute("src") || "";
    const codes = ["", "aborted", "network", "decode", "unsupported source"];
    return {
      index: all.indexOf(el),
      tag: el.tagName === "AUDIO" ? "audio" : "video",
      paused: el.paused,
      ended: el.ended,
      currentTime: Math.round((el.currentTime || 0) * 10) / 10,
      duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null,
      readyState: el.readyState,
      muted: el.muted,
      playbackRate: el.playbackRate,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
      drm: !!(el as HTMLMediaElement & { mediaKeys?: unknown }).mediaKeys,
      src: src.startsWith("blob:") ? "blob: (stream)" : src.slice(0, 200),
      label: clean(
        el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          (labelled && labelled.getAttribute("aria-label")) ||
          (purpose && purpose.getAttribute("data-purpose")) ||
          "",
      ).slice(0, 80),
      error: el.error ? codes[el.error.code] || `code ${el.error.code}` : "",
    };
  }

  if (args.op === "state" && args.index === undefined && !args.selector) {
    return { ok: true, message: `${all.length} media element(s)`, media: all.map(stateOf) };
  }

  let el: HTMLMediaElement | undefined;
  if (args.selector) {
    let matches: Element[];
    try {
      matches = deepQueryAll(args.selector);
    } catch {
      return {
        ok: false,
        error: `Invalid selector: ${JSON.stringify(args.selector.slice(0, 80))}`,
      };
    }
    for (const m of matches) {
      const found = /^(VIDEO|AUDIO)$/.test(m.tagName) ? m : m.querySelector("video, audio");
      if (found) {
        el = found as HTMLMediaElement;
        break;
      }
    }
  } else if (args.index !== undefined) {
    el = all[args.index];
  } else {
    // The largest visible video, else the first media element.
    el = all
      .filter((m) => m.tagName === "VIDEO")
      .map((m) => ({ m, s: stateOf(m) }))
      .filter((x) => x.s.visible)
      .sort((a, b) => b.s.width * b.s.height - a.s.width * a.s.height)[0]?.m;
    el = el || all[0];
  }

  if (!el) {
    if (args.keyboardFallback && (args.op === "play" || args.op === "pause")) return pressPlayKey();
    const what = args.selector
      ? `selector ${JSON.stringify(args.selector.slice(0, 80))}`
      : args.index !== undefined
        ? `m${args.index}`
        : "this frame";
    return {
      ok: false,
      error: `No <video> or <audio> for ${what} (${all.length} in this frame) — run media state for current targets.`,
      noMedia: all.length === 0,
    };
  }
  const media = el;
  const done = (message: string): MediaInPageResponse => ({
    ok: true,
    message,
    media: [stateOf(media)],
  });

  /** No media element (a canvas/closed-shadow player): focus the player and send
   * its play/pause key. YouTube's shortcut is "k"; space is everyone else's. */
  function pressPlayKey(): MediaInPageResponse {
    const player =
      (args.selector ? deepQueryAll(args.selector)[0] : null) ||
      deepQueryAll(
        '#movie_player, [data-purpose*="player" i], [class*="player" i], [id*="player" i]',
      ).find((p) => p.getBoundingClientRect().width > 0) ||
      document.body;
    const youtube = /(^|\.)youtube(-nocookie)?\.com$/.test(window.location.hostname);
    const key = youtube ? "k" : " ";
    const code = youtube ? "KeyK" : "Space";
    const keyCode = youtube ? 75 : 32;
    if (!player.hasAttribute("tabindex") && player !== document.body)
      player.setAttribute("tabindex", "-1");
    (player as HTMLElement).focus();
    for (const type of ["keydown", "keyup"]) {
      player.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    const name = player.tagName.toLowerCase() + (player.id ? `#${player.id}` : "");
    return {
      ok: true,
      message: `No <video>/<audio> to control here, so the ${youtube ? '"k"' : "space"} key was sent to <${name}>. Synthetic keys can be ignored — confirm with read_page or a screenshot.`,
      media: [],
    };
  }

  if (args.op === "state") return done("state");

  if (args.op === "mute" || args.op === "unmute") {
    media.muted = args.op === "mute";
    return done(args.op === "mute" ? "Muted" : "Unmuted");
  }

  if (args.op === "seek") {
    const t = Number(args.time);
    if (!Number.isFinite(t) || t < 0)
      return { ok: false, error: "seek needs time: seconds from the start (0 or more)" };
    const target = Number.isFinite(media.duration) ? Math.min(t, media.duration) : t;
    const seeked = new Promise<void>((resolve) => {
      media.addEventListener("seeked", () => resolve(), { once: true });
      setTimeout(resolve, 2000);
    });
    media.currentTime = target;
    await seeked;
    return done(`Seeked to ${Math.round(target * 10) / 10}s`);
  }

  if (args.op === "pause") {
    media.pause();
    if (media.paused) return done("Paused");
    return {
      ok: false,
      error: "pause() returned but the media is still playing (the player restarted it).",
      media: [stateOf(media)],
    };
  }

  // play
  const wait = typeof args.playTimeoutMs === "number" ? args.playTimeoutMs : 3000;
  let outcome: "played" | "pending" | Error;
  try {
    const started = Promise.resolve(media.play()).then(() => "played" as const);
    const timeout = new Promise<"pending">((r) => setTimeout(() => r("pending"), wait));
    outcome = await Promise.race([started, timeout]);
  } catch (e) {
    outcome = e instanceof Error ? e : new Error(String(e));
  }
  if (outcome === "played") return done("Playing");
  if (outcome === "pending") {
    return done(
      `play() is still pending after ${wait} ms (buffering, readyState ${media.readyState}) — read media state again shortly`,
    );
  }
  if (outcome.name === "NotAllowedError") {
    return {
      ok: false,
      error: media.muted
        ? `play() was blocked by the browser even while muted (NotAllowedError: ${clean(outcome.message).slice(0, 160)}). Click the player's own play button instead.`
        : "play() was blocked by Chrome's autoplay policy: the page has no user gesture, so unmuted playback is refused (NotAllowedError). Muted playback is allowed — run media mute, then play — or click the player's own play button.",
      media: [stateOf(media)],
    };
  }
  return {
    ok: false,
    error: `play() failed: ${outcome.name}: ${clean(outcome.message).slice(0, 160)}`,
    media: [stateOf(media)],
  };
}
