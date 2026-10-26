// @junior/bridge/chat/tools — the api engine's browser tool set (plan §4.5 "Shared").
// One tool per §4.5 browser action; every execute() funnels through
// Dispatcher.dispatch, so the panel's agent mode traverses the SAME guard +
// approval-card path as MCP clients and the AgentLoop — there is no second
// enforcement point to bypass. Denied/error guard strings (USER_DENIED:/
// BLOCKED_BY_POLICY:/…) ride through verbatim so the model learns not to retry.
import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { FrameRef, MediaOp, ReadMode } from "@junior/protocol";
import type { Dispatcher } from "../dispatcher/queue.js";
import { MAX_SCREENSHOT_TEXT_CHARS, MAX_TOOL_TEXT_CHARS, toolResultText } from "../mcp/tools.js";

export interface BrowserToolDeps {
  dispatcher: Dispatcher;
}

/** ActionResult → model-facing tool output via the shared mapping (MCP parity):
 * ok → the result JSON (delimiter-stripped §6.3-2, size-capped); denied/error → the
 * guard/error string verbatim (§4.4: the agent must see the structured reason and
 * give up instead of retrying). */
async function runTool(
  dispatcher: Dispatcher,
  action: Parameters<Dispatcher["dispatch"]>[0],
  max = MAX_TOOL_TEXT_CHARS,
): Promise<string> {
  const res = await dispatcher.dispatch(action);
  return toolResultText(res, { max, pageDerived: action.kind !== "screenshot" });
}

/** The §4.5 browser tool set, registered only when the request is agentMode. */
export function browserTools(deps: BrowserToolDeps): ToolSet {
  const d = deps.dispatcher;
  const tools: Record<string, Tool> = {
    get_active_tab: tool({
      description:
        "Get the active browser tab (title, url, status) from the user's Chrome. Call this first to see where the user is.",
      inputSchema: z.object({}),
      execute: async () => runTool(d, { kind: "get_active_tab" }),
    }),
    read_page: tool({
      description:
        'Read the active page token-efficiently: outline (interactive elements as [index] lines), interactive (with roles/values), text, or a section via CSS selector. Content inside cross-origin iframes (embedded video players, payment or sign-in widgets) follows a `--- iframe f7 <url> ---` header with frame-qualified indices like [f7:3]; a section selector can be scoped to a frame the same way ("f7:#player"). Prefer this over screenshots and before clicking or typing. Elements without visible text show fallback labels (aria-label=, title=, icon=, data-purpose=, pressed=).',
      inputSchema: z.object({
        mode: ReadMode.default("outline"),
        selector: z.string().max(512).optional(),
        maxChars: z.number().int().min(200).max(30000).default(8000),
      }),
      execute: async ({ mode, selector, maxChars }) =>
        runTool(d, { kind: "read_page", mode, selector, maxChars }),
    }),
    navigate: tool({
      description:
        "Navigate the active tab to a URL. Public http(s) only; private/loopback targets are refused by policy. Sensitive sites trigger an approval card in the user's panel — a denial is final.",
      inputSchema: z.object({ url: z.string().max(2048) }),
      execute: async ({ url }) => runTool(d, { kind: "navigate", url }),
    }),
    click: tool({
      description:
        'Click an element on the active page. Target forms: an index exactly as read_page printed it ("[12]" → "12"; inside an iframe "[f7:3]" → "f7:3"); a CSS selector ("#play", "button[aria-label=Play]"; open shadow roots are searched); an XPath ("//button[2]"); or visible text / an accessible name ("Play"; force text matching with "text:video"). Indices, selectors and XPaths are strict: a stale index or a selector that matches nothing visible returns an error and clicks NOTHING — read_page again instead of guessing. Only text targets match fuzzily (exact before partial). Prefix any target with a frame ("f7:Play") to search inside that iframe; unprefixed targets search the top page. The result names what was hit (tag, text, link, how it matched, iframe) — check it. For video/audio use the media tool rather than player buttons.',
      inputSchema: z.object({ target: z.string().max(512) }),
      execute: async ({ target }) => runTool(d, { kind: "click", target }),
    }),
    type: tool({
      description:
        'Type text into a field on the active page. Same target forms and strictness as click (index, frame-qualified "f7:3" / "f7:Email", CSS, XPath, or label text); the result names the field it typed into. Secret/password fields are refused in every mode — never ask the user for secret material to type.',
      inputSchema: z.object({
        target: z.string().max(512),
        text: z.string().max(10000),
      }),
      execute: async ({ target, text }) => runTool(d, { kind: "type", target, text }),
    }),
    scroll: tool({
      description:
        'Scroll the active page up or down by a pixel amount (default 600). Pass frame ("f7", from a read_page iframe header) to scroll inside that iframe instead.',
      inputSchema: z.object({
        direction: z.enum(["up", "down"]),
        amount: z.number().int().positive().max(10000).optional(),
        frame: FrameRef.optional(),
      }),
      execute: async ({ direction, amount, frame }) =>
        runTool(d, { kind: "scroll", direction, amount, frame }),
    }),
    media: tool({
      description:
        'Read or control <video>/<audio> in the active tab and its iframes through the media API. op "state" (default) lists every media element as [m0] / [f7:m0] lines: playing or paused, time/duration, readiness, muted, size, drm. play / pause / seek (time = seconds from the start) / mute / unmute act on target ("m0", "f7:m0", or a CSS selector, optionally "f7:"-scoped; omit for the main video) and return the state after. Controls need the same approval as a click. If play is blocked by Chrome\'s autoplay policy, mute then play, or click the player\'s own play button. DRM video renders black in screenshots — read media state instead.',
      inputSchema: z.object({
        op: MediaOp.default("state"),
        target: z.string().max(512).optional(),
        time: z.number().min(0).max(604800).optional(),
      }),
      execute: async ({ op, target, time }) => runTool(d, { kind: "media", op, target, time }),
    }),
    screenshot: tool({
      description:
        "Screenshot of the active tab as a downscaled JPEG data URL (base64 in the payload). More expensive than read_page — prefer read_page for structure. DRM-protected video (Udemy, Netflix, …) renders black — use the media tool for playback state.",
      inputSchema: z.object({}),
      execute: async () => runTool(d, { kind: "screenshot" }, MAX_SCREENSHOT_TEXT_CHARS),
    }),
  };
  return tools;
}
