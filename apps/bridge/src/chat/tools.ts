// @junior/bridge/chat/tools — the api engine's browser tool set (plan §4.5 "Shared").
// One tool per §4.5 browser action; every execute() funnels through
// Dispatcher.dispatch, so the panel's agent mode traverses the SAME guard +
// approval-card path as MCP clients and the AgentLoop — there is no second
// enforcement point to bypass. Denied/error guard strings (USER_DENIED:/
// BLOCKED_BY_POLICY:/…) ride through verbatim so the model learns not to retry.
import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { ReadMode } from "@junior/protocol";
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
        "Read the active page token-efficiently: outline (interactive elements as [index] lines), interactive (with roles/values), text, or a section via CSS selector. Prefer this over screenshots and before clicking or typing.",
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
        'Click an element on the active page. Target is an index from read_page output ("[12]" → "12"), visible text, a CSS selector, or an XPath.',
      inputSchema: z.object({ target: z.string().max(512) }),
      execute: async ({ target }) => runTool(d, { kind: "click", target }),
    }),
    type: tool({
      description:
        "Type text into a field on the active page (same target forms as click). Secret/password fields are refused in every mode — never ask the user for secret material to type.",
      inputSchema: z.object({
        target: z.string().max(512),
        text: z.string().max(10000),
      }),
      execute: async ({ target, text }) => runTool(d, { kind: "type", target, text }),
    }),
    scroll: tool({
      description: "Scroll the active page up or down by a pixel amount (default 600).",
      inputSchema: z.object({
        direction: z.enum(["up", "down"]),
        amount: z.number().int().positive().max(10000).optional(),
      }),
      execute: async ({ direction, amount }) => runTool(d, { kind: "scroll", direction, amount }),
    }),
    screenshot: tool({
      description:
        "Screenshot of the active tab as a downscaled JPEG data URL (base64 in the payload). More expensive than read_page — prefer read_page for structure.",
      inputSchema: z.object({}),
      execute: async () => runTool(d, { kind: "screenshot" }, MAX_SCREENSHOT_TEXT_CHARS),
    }),
  };
  return tools;
}
