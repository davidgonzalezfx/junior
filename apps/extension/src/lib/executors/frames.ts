// lib/executors/frames.ts — frame-aware page actions (T5a, decisions.md 2026-10-26).
//
// Chrome runs an injected function in ONE frame per target, and the top frame's
// buildDomTree can only descend into iframes it can script (same-origin). Every
// other frame — embedded players, payment and sign-in widgets — is read and acted
// on through its own executeScript target `{tabId, frameIds:[id]}`.
//
// Target encoding: `f<frameId>:<target>`, where frameId is Chrome's own id for the
// frame. Stateless on purpose: the SW can be suspended between read_page and
// click (T4), and MCP clients replay targets they read earlier. Plain targets
// (`12`, text, CSS, XPath) mean the top frame, exactly as before.
import type { BrowserAction } from "@junior/protocol";
import type { ExecuteOutcome, ExecutorEnv } from "./index";
import { isRestrictedUrl } from "./restricted";

/** What juniorFrameInfoInPage reports from inside one frame. */
export interface FrameProbe {
  url: string;
  /** The parent document can script this frame (same-origin), so the parent's
   * buildDomTree already walked it: its elements appear under the parent's
   * plain indices and the frame must not be listed a second time. */
  coveredByParent: boolean;
}

export interface FrameInfo extends FrameProbe {
  frameId: number;
}

export const TOP_FRAME_ID = 0;

/** SELF-CONTAINED (executeScript serializes the body only): runs in every frame. */
export function juniorFrameInfoInPage(): FrameProbe {
  let covered: boolean;
  try {
    // null when the parent is cross-origin (or this is the top frame).
    covered = window !== window.top && window.frameElement !== null;
  } catch {
    covered = false;
  }
  return { url: window.location.href, coveredByParent: covered };
}

// ── SW side ────────────────────────────────────────────────────────────────────

type ReadPageAction = Extract<BrowserAction, { kind: "read_page" }>;

/** The smallest budget worth spending on one more frame. */
const MIN_FRAME_CHARS = 200;

const FRAME_RESTRICTED_TEXT =
  "Action omitted: not permitted inside this frame (an internal or extension page)";

/** `f7:12` / `[f7:12]` / `f7:Play` → frame 7 + the in-frame target; null = top frame. */
export function parseFrameTarget(raw: string): { frameId: number; target: string } | null {
  let t = raw.trim();
  const bracketed = /^\[(f\d{1,10}:[^\]]*)\]$/.exec(t);
  if (bracketed?.[1]) t = bracketed[1];
  const m = /^f(\d{1,10}):([\s\S]*)$/.exec(t);
  if (!m?.[1]) return null;
  return { frameId: Number(m[1]), target: m[2] ?? "" };
}

/** `f7` (the scroll `frame` field) → 7. */
export function frameRefId(ref: string): number {
  return Number(ref.replace(/^f/, ""));
}

/** Every frame of the AGENT tab, or null when frames can't be enumerated here
 * (then reads and actions see the top frame only, as before T5a). */
async function listFrames(env: ExecutorEnv, tabId: number): Promise<FrameInfo[] | null> {
  if (!env.listFrames) return null;
  try {
    return await env.listFrames(tabId);
  } catch {
    return null;
  }
}

export type FrameResolution = { ok: true; frame: FrameInfo } | { ok: false; error: string };

/** A child frame an action may run in: it must exist now and be a normal page. */
export async function resolveFrame(
  env: ExecutorEnv,
  tabId: number,
  frameId: number,
): Promise<FrameResolution> {
  const frames = await listFrames(env, tabId);
  const frame = frames?.find((f) => f.frameId === frameId);
  if (!frame) {
    return {
      ok: false,
      error: `Frame f${frameId} not found in the agent tab — read_page again for current targets.`,
    };
  }
  if (isRestrictedUrl(frame.url)) return { ok: false, error: FRAME_RESTRICTED_TEXT };
  return { ok: true, frame };
}

function frameHeader(f: FrameInfo): string {
  return `--- iframe f${f.frameId} ${f.url.slice(0, 200)} ---`;
}

/** `[12] button …` → `[f7:12] button …` so the model can copy the target as printed. */
function qualifyIndices(text: string, frameId: number): string {
  return text.replace(/^\[(\d+)\]/gm, `[f${frameId}:$1]`);
}

/** Child frames worth reading, in frameId order. Outline modes skip frames the
 * parent's buildDomTree already walked; text reads include them (innerText never
 * crosses into an iframe). Restricted frames (extensions' own iframes, about:)
 * are never read. */
function readableChildren(frames: FrameInfo[], indexed: boolean): FrameInfo[] {
  return frames
    .filter((f) => f.frameId !== TOP_FRAME_ID && !isRestrictedUrl(f.url))
    .filter((f) => !indexed || !f.coveredByParent)
    .sort((a, b) => a.frameId - b.frameId);
}

/** executeScript target args: undefined frameId = the tab's top frame. */
function at(frameId: number | undefined): [] | [number] {
  return frameId === undefined ? [] : [frameId];
}

function ok(result: string): ExecuteOutcome {
  return { status: "ok", result };
}

/** One frame's read (undefined = top): the same calls and errors as before T5a. */
async function readOne(
  env: ExecutorEnv,
  tabId: number,
  action: ReadPageAction,
  frameId?: number,
): Promise<ExecuteOutcome & { noMatch?: boolean }> {
  if (action.mode === "outline" || action.mode === "interactive") {
    // Vendored buildDomTree.js caps the output in-page at maxChars (§6.3-6).
    try {
      const args = { mode: action.mode, maxChars: action.maxChars };
      const res = await env.runBuildDomTree(tabId, args, ...at(frameId));
      if (!res)
        return { status: "error", error: "Could not read the page (reader injection failed)" };
      return ok(res.text);
    } catch (e) {
      return {
        status: "error",
        error: `read_page failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  // text | section — capped in-page at maxChars (§6.3-6).
  const args = { mode: action.mode, selector: action.selector, maxChars: action.maxChars };
  const res = await env.runReadInPage(tabId, args, ...at(frameId));
  if (res.ok) return ok(res.text);
  return { status: "error", error: res.error, noMatch: res.noMatch };
}

/** read_page across the agent tab's frames: the top frame first, exactly as
 * before, then each readable child frame under a header, within maxChars. */
export async function readPageFrames(
  env: ExecutorEnv,
  tabId: number,
  action: ReadPageAction,
): Promise<ExecuteOutcome> {
  if (action.mode === "section") return readSection(env, tabId, action);

  const top = await readOne(env, tabId, action);
  if (top.status !== "ok") return { status: top.status, error: top.error };
  const frames = await listFrames(env, tabId);
  if (!frames) return top;

  const indexed = action.mode !== "text";
  let out = String(top.result);
  let skipped = 0;
  for (const f of readableChildren(frames, indexed)) {
    const head = frameHeader(f);
    const budget = action.maxChars - out.length - head.length - 2;
    if (budget < MIN_FRAME_CHARS) {
      skipped++;
      continue;
    }
    let res: ExecuteOutcome;
    try {
      res = await readOne(env, tabId, { ...action, maxChars: budget }, f.frameId);
    } catch {
      continue; // the frame navigated or went away mid-read
    }
    const body = res.status === "ok" ? String(res.result).trim() : "";
    if (!body) continue;
    out += `${out ? "\n" : ""}${head}\n${indexed ? qualifyIndices(body, f.frameId) : body}`;
  }
  if (skipped) out += `\n--- ${skipped} more iframe(s) not read: raise maxChars ---`;
  return ok(out);
}

/** section: `f7:<selector>` reads in that frame; a plain selector tries the top
 * frame, then every child frame, first match wins. */
async function readSection(
  env: ExecutorEnv,
  tabId: number,
  action: ReadPageAction,
): Promise<ExecuteOutcome> {
  const scoped = parseFrameTarget(action.selector ?? "");
  if (scoped && scoped.frameId !== TOP_FRAME_ID) {
    const found = await resolveFrame(env, tabId, scoped.frameId);
    if (!found.ok) return { status: "error", error: found.error };
    const res = await readOne(env, tabId, { ...action, selector: scoped.target }, scoped.frameId);
    if (res.status !== "ok") return { status: res.status, error: res.error };
    return ok(`${frameHeader(found.frame)}\n${String(res.result)}`);
  }

  const topAction = scoped ? { ...action, selector: scoped.target } : action;
  const top = await readOne(env, tabId, topAction);
  if (top.status === "ok" || !top.noMatch)
    return { status: top.status, result: top.result, error: top.error };
  for (const f of readableChildren((await listFrames(env, tabId)) ?? [], false)) {
    try {
      const res = await readOne(env, tabId, topAction, f.frameId);
      if (res.status === "ok") return ok(`${frameHeader(f)}\n${String(res.result)}`);
    } catch {
      /* frame gone — keep looking */
    }
  }
  return { status: "error", error: top.error };
}
