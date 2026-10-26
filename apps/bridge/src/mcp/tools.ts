// @junior/bridge/mcp/tools — the MCP tool catalog (plan §4.6) over the dispatcher.
// Every browser tool funnels through Dispatcher.dispatch, so MCP clients (terminal
// Claude, Claude Desktop via the stdio proxy) traverse the SAME guard + approval-card
// path as the panel chat engines — there is no second enforcement point to bypass.
// Tool names are part of the contract (§4.6: users have them in CLAUDE.md files).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BridgeStatusSchema,
  ReadMode,
  newNonce,
  safeSlice,
  sanitizeDeep,
  type ActionResult,
} from "@junior/protocol";
import type { Dispatcher } from "../dispatcher/queue.js";
import { loadConfig } from "../config.js";
import { buildProviders, API_LEVEL, bridgeVersion } from "../status.js";
import { probeClaude } from "../cli-detect.js";

// §6.3-6: tool payloads are size-capped everywhere. Screenshots get their own (much
// larger) ceiling — a 1280px JPEG data URL is legitimately a few hundred KB, while a
// 5 MB dump must never reach a model context. safeSlice means the cut can never
// split a UTF-16 surrogate pair (a lone surrogate serializes to invalid UTF-8).
export const MAX_TOOL_TEXT_CHARS = 20_000;
export const MAX_SCREENSHOT_TEXT_CHARS = 1_000_000;

export function capToolText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${safeSlice(text, max)}\n…[truncated ${text.length - max} chars]`;
}

/** ActionResult → model-facing tool text (shared by the MCP catalog and the chat agent
 * tools — one mapping, two surfaces). ok → the result JSON, size-capped; denied/error →
 * the guard/error string verbatim (§4.4: the agent must see the structured reason and
 * give up instead of retrying). Page-derived ok payloads first pass the §6.3-2
 * delimiter strip with a per-call nonce, so a page cannot close or fake its untrusted
 * block inside a prompt. Screenshots are exempt: base64 can legitimately contain the
 * delimiter words, and stripping would corrupt the data URL. */
export function toolResultText(
  res: ActionResult,
  opts: { max: number; pageDerived?: boolean },
): string {
  if (res.status === "ok") {
    const body =
      opts.pageDerived === false
        ? JSON.stringify(res.result ?? {})
        : JSON.stringify(sanitizeDeep(res.result ?? {}, newNonce()));
    return capToolText(body, opts.max);
  }
  return capToolText(res.error ?? `action ended with status "${res.status}"`, opts.max);
}

/** ActionResult → MCP tool result (§4.6: JSON-stringified text content, errors as isError). */
export function actionResultToToolResult(
  res: ActionResult,
  opts: { max: number; pageDerived?: boolean } = { max: MAX_TOOL_TEXT_CHARS },
): CallToolResult {
  const text = toolResultText(res, opts);
  if (res.status === "ok") return { content: [{ type: "text", text }] };
  return { content: [{ type: "text", text }], isError: true };
}

export interface McpToolDeps {
  /** Config dir (~/.junior or $JUNIOR_HOME) — junior_status reads it per call. */
  dir: string;
  dispatcher: Dispatcher;
  /** /api/status seams for tests. */
  probe?: typeof probeClaude;
  version?: string;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: capToolText(text, MAX_TOOL_TEXT_CHARS) }] };
}

async function dispatchTool(
  dispatcher: Dispatcher,
  action: Parameters<Dispatcher["dispatch"]>[0],
  opts: { max: number; pageDerived?: boolean } = { max: MAX_TOOL_TEXT_CHARS },
): Promise<CallToolResult> {
  const res = await dispatcher.dispatch(action);
  return actionResultToToolResult(res, opts);
}

/** Registers the §4.6 catalog on a fresh McpServer (one per request — stateless). */
export function registerMcpTools(server: McpServer, deps: McpToolDeps): void {
  const probe = deps.probe ?? probeClaude;
  const version = deps.version ?? bridgeVersion();

  server.registerTool(
    "junior_status",
    {
      description:
        "Junior bridge status: version, whether the browser extension is connected, queue depth, and which model providers are configured/available.",
    },
    async () => {
      try {
        const config = loadConfig(deps.dir);
        const cli = await probe({ overridePath: config.cliPath });
        const status = BridgeStatusSchema.parse({
          version,
          apiLevel: API_LEVEL,
          providers: buildProviders(config, cli),
          browserConnected: deps.dispatcher.connected(),
          queueDepth: deps.dispatcher.queueDepth,
        });
        return textResult(JSON.stringify(status));
      } catch (cause) {
        return { ...textResult(`junior_status failed: ${String(cause)}`), isError: true };
      }
    },
  );

  server.registerTool(
    "get_active_tab",
    { description: "Get the active browser tab (title, url, status) from the user's Chrome." },
    async () => dispatchTool(deps.dispatcher, { kind: "get_active_tab" }),
  );

  server.registerTool(
    "read_page",
    {
      description:
        'Read the active page token-efficiently: outline (interactive elements as [index] lines), interactive (with roles/values), text, or a section via CSS selector. Content inside cross-origin iframes (embedded video players, payment or sign-in widgets) follows a `--- iframe f7 <url> ---` header with frame-qualified indices like [f7:3]; a section selector can be scoped to a frame the same way ("f7:#player"). Prefer this over screenshots.',
      inputSchema: z.object({
        mode: ReadMode.default("outline"),
        selector: z.string().max(512).optional(),
        maxChars: z.number().int().min(200).max(30000).default(8000),
      }),
    },
    async (args) =>
      dispatchTool(deps.dispatcher, {
        kind: "read_page",
        mode: args.mode,
        selector: args.selector,
        maxChars: args.maxChars,
      }),
  );

  server.registerTool(
    "navigate",
    {
      description:
        "Navigate the active tab to a URL. Public http(s) only; private/loopback targets are refused by policy. Sensitive sites trigger an approval card in the user's panel.",
      inputSchema: z.object({ url: z.string().max(2048) }),
    },
    async (args) => dispatchTool(deps.dispatcher, { kind: "navigate", url: args.url }),
  );

  server.registerTool(
    "click",
    {
      description:
        'Click an element on the active page. Target is an index exactly as read_page printed it ("[12]" → "12"; inside an iframe "[f7:3]" → "f7:3"), visible text, a CSS selector, or an XPath. Prefix text/CSS/XPath with the frame ("f7:Play") to search inside that iframe; unprefixed targets search the top page.',
      inputSchema: z.object({ target: z.string().max(512) }),
    },
    async (args) => dispatchTool(deps.dispatcher, { kind: "click", target: args.target }),
  );

  server.registerTool(
    "type",
    {
      description:
        'Type text into a field on the active page (same target forms as click, including frame-qualified "f7:3" / "f7:Email"). Secret/password fields are refused in every mode — the agent is never given secret material.',
      inputSchema: z.object({
        target: z.string().max(512),
        text: z.string().max(10000),
      }),
    },
    async (args) =>
      dispatchTool(deps.dispatcher, { kind: "type", target: args.target, text: args.text }),
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Screenshot of the active tab as a downscaled JPEG data URL (base64 in the text payload). More expensive than read_page — prefer read_page for structure.",
    },
    async () =>
      dispatchTool(
        deps.dispatcher,
        { kind: "screenshot" },
        {
          max: MAX_SCREENSHOT_TEXT_CHARS,
          pageDerived: false, // base64 — the delimiter strip would corrupt the data URL
        },
      ),
  );

  server.registerTool(
    "agent_task",
    {
      description:
        "Run a full agent task toward a goal in the active tab. Requires the Junior agent engine.",
      inputSchema: z.object({
        goal: z.string().min(1).max(4000),
        mode: z.string().max(64).default("auto"),
      }),
    },
    async () => ({
      ...textResult(
        "agent_task is not available yet — it needs the Junior agent engine (plan §8 M4-3/M4-4). Use the individual browse tools instead.",
      ),
      isError: true,
    }),
  );
}
