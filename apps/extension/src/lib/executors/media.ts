// lib/executors/media.ts — the media tool, SW side (T5b, decisions.md 2026-10-26).
//
// Reads and controls <video>/<audio> instead of hunting for a player's (often
// unlabeled, often shadow-DOM) buttons. Targets: `m<N>` = the N-th media element
// of a frame (media-in-page.ts), frame-qualified as `f7:m0` like every other T5a
// target; a CSS selector (the element or a media element inside it); or nothing
// = the largest visible video in the agent tab.
import type { BrowserAction } from "@junior/protocol";
import type { ExecuteOutcome, ExecutorEnv } from "./index";
import type { InPageClickFacts } from "./in-page";
import type { MediaInPageRequest, MediaState } from "./media-in-page";
import { isRestrictedUrl } from "./restricted";
import { parseFrameTarget, resolveFrame, TOP_FRAME_ID, type FrameInfo } from "./frames";

export { juniorMediaInPage } from "./media-in-page";
export type { MediaInPageRequest, MediaInPageResponse, MediaOp, MediaState } from "./media-in-page";

type MediaAction = Extract<BrowserAction, { kind: "media" }>;

/** Guard + approval for a media control, judged on facts about the element
 * (index.ts owns the verdict plumbing; null = go ahead). */
export type MediaGuard = (
  facts: InPageClickFacts,
  frameUrl?: string,
) => Promise<ExecuteOutcome | null>;

function fmtTime(s: number | null): string {
  if (s === null) return "?";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const READY = ["nothing", "metadata", "current-data", "future-data", "enough-data"];

/** `[f7:m0] video playing 1:05/10:32 ready=enough-data muted=no 640x360 "Lecture"`. */
export function mediaLine(m: MediaState, frameId?: number): string {
  const id =
    frameId === undefined || frameId === TOP_FRAME_ID ? `m${m.index}` : `f${frameId}:m${m.index}`;
  const parts = [
    `[${id}]`,
    m.tag,
    m.ended ? "ended" : m.paused ? "paused" : "playing",
    `${fmtTime(m.currentTime)}/${fmtTime(m.duration)} (${m.currentTime}s of ${m.duration ?? "?"}s)`,
    `ready=${READY[m.readyState] ?? m.readyState}`,
    `muted=${m.muted ? "yes" : "no"}`,
  ];
  if (m.playbackRate !== 1) parts.push(`rate=${m.playbackRate}`);
  if (m.tag === "video") parts.push(m.visible ? `${m.width}x${m.height}` : "hidden");
  if (m.drm) parts.push("drm=yes (screenshots of it render black)");
  if (m.error) parts.push(`error=${m.error}`);
  if (m.label) parts.push(JSON.stringify(m.label));
  if (m.src) parts.push(`src=${m.src}`);
  return parts.join(" ");
}

interface Located {
  frameId?: number;
  frameUrl?: string;
  req: Omit<MediaInPageRequest, "op">;
}

async function frameList(env: ExecutorEnv, tabId: number): Promise<FrameInfo[]> {
  try {
    return (await env.listFrames?.(tabId)) ?? [];
  } catch {
    return [];
  }
}

/** Child frames to search for media: every normal frame except the top. Unlike
 * the outline, same-origin frames count — querySelectorAll never crosses into
 * an iframe. */
function mediaChildren(frames: FrameInfo[]): FrameInfo[] {
  return frames
    .filter((f) => f.frameId !== TOP_FRAME_ID && !isRestrictedUrl(f.url))
    .sort((a, b) => a.frameId - b.frameId);
}

async function stateIn(env: ExecutorEnv, tabId: number, frameId?: number): Promise<MediaState[]> {
  if (!env.runMediaInPage) return [];
  try {
    const res = await env.runMediaInPage(
      tabId,
      { op: "state" },
      ...(frameId === undefined ? [] : [frameId]),
    );
    return res.ok ? res.media : [];
  } catch {
    return []; // the frame navigated or went away
  }
}

/** media across the agent tab: state of everything, or one control. */
export async function runMedia(
  env: ExecutorEnv,
  tab: { id: number; url?: string },
  action: MediaAction,
  guard: MediaGuard,
): Promise<ExecuteOutcome> {
  if (!env.runMediaInPage) return { status: "error", error: "Media control is unavailable here" };
  const tabId = tab.id;
  const op = action.op;
  const raw = (action.target ?? "").trim();

  if (op === "state" && !raw) {
    const lines: string[] = [];
    const top = await stateIn(env, tabId);
    lines.push(...top.map((m) => mediaLine(m)));
    const children = mediaChildren(await frameList(env, tabId));
    for (const f of children) {
      const found = await stateIn(env, tabId, f.frameId);
      if (found.length) {
        lines.push(`--- iframe f${f.frameId} ${f.url.slice(0, 200)} ---`);
        lines.push(...found.map((m) => mediaLine(m, f.frameId)));
      }
    }
    if (!lines.length) {
      return {
        status: "ok",
        result: `No <video> or <audio> in the agent tab (top page and ${children.length} iframe(s)).`,
      };
    }
    return { status: "ok", result: lines.join("\n") };
  }

  const located = await locate(env, tabId, raw);
  if ("error" in located) return { status: "error", error: located.error };
  const at = located.frameId === undefined ? [] : [located.frameId];

  if (op !== "state") {
    // Approval sees the real element (§6.3-1), like click's probe.
    const probe = await env.runMediaInPage(tabId, { ...located.req, op: "state" }, ...at);
    const m = probe.ok ? probe.media[0] : undefined;
    const verb = op === "seek" ? `seek to ${action.time ?? 0}s` : op;
    const facts: InPageClickFacts = {
      tag: m?.tag ?? "video",
      type: "",
      text: `${verb}: ${m?.label || m?.src || "media"}`.slice(0, 200),
      ariaLabel: m?.label ?? "",
      title: "",
      href: "",
      formAction: "",
      isSubmit: false,
    };
    const stop = await guard(facts, located.frameUrl);
    if (stop) return stop;
  }

  const res = await env.runMediaInPage(tabId, { ...located.req, op, time: action.time }, ...at);
  const where =
    located.frameId === undefined
      ? ""
      : ` in iframe f${located.frameId} (${located.frameUrl ?? ""})`;
  const after = res.media?.[0] ? `\n${mediaLine(res.media[0], located.frameId)}` : "";
  if (!res.ok) return { status: "error", error: `${res.error}${where}${after}` };
  return { status: "ok", result: `${res.message}${where}${after}` };
}

/** Target → frame + in-frame request. No target: the frame holding the largest
 * visible video (top first on ties); no media anywhere = the top frame with the
 * keyboard fallback. */
async function locate(
  env: ExecutorEnv,
  tabId: number,
  raw: string,
): Promise<Located | { error: string }> {
  const scoped = parseFrameTarget(raw);
  let rest = raw;
  let frameId: number | undefined;
  let frameUrl: string | undefined;
  if (scoped) {
    rest = scoped.target.trim();
    if (scoped.frameId !== TOP_FRAME_ID) {
      const found = await resolveFrame(env, tabId, scoped.frameId);
      if (!found.ok) return { error: found.error };
      frameId = found.frame.frameId;
      frameUrl = found.frame.url;
    }
  }
  const idx = /^\[?m(\d+)\]?$/i.exec(rest);
  if (idx?.[1]) return { frameId, frameUrl, req: { index: Number(idx[1]) } };
  if (rest) return { frameId, frameUrl, req: { selector: rest } };
  if (scoped) return { frameId, frameUrl, req: {} };

  let best: { area: number; frame?: FrameInfo; index: number } | null = null;
  const consider = (list: MediaState[], frame?: FrameInfo) => {
    for (const m of list) {
      const area = m.tag === "video" && m.visible ? m.width * m.height : 0;
      if (!best || area > best.area) best = { area, frame, index: m.index };
    }
  };
  consider(await stateIn(env, tabId));
  for (const f of mediaChildren(await frameList(env, tabId))) {
    consider(await stateIn(env, tabId, f.frameId), f);
  }
  const chosen = best as { area: number; frame?: FrameInfo; index: number } | null;
  if (!chosen) return { req: { keyboardFallback: true } };
  return {
    frameId: chosen.frame?.frameId,
    frameUrl: chosen.frame?.url,
    req: { index: chosen.index },
  };
}
