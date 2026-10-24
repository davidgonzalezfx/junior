// @junior/bridge/mcp/server — MCP streamable HTTP at /mcp (plan §4.6, §3 HTTP table).
// Stateless mode: a fresh McpServer + WebStandardStreamableHTTPServerTransport per POST,
// JSON responses (no SSE) — that's what the junior-mcp stdio proxy forwards and what
// terminal Claude speaks. GET (server→client listening leg) and DELETE (session teardown)
// have no meaning without sessions → 405, which the streamable-HTTP spec permits.
// Auth (bearer) is mounted in index.ts, same middleware as /api/*; the §4.2 quota-burn
// brake (rate-limit.ts, staged since M1-1) engages here on tools/call only — lifecycle
// calls (initialize/tools/list/ping) are unmetered or the SDK handshake would trip it.
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RateLimiter } from "../rate-limit.js";
import { createRateLimiter } from "../rate-limit.js";
import { registerMcpTools, type McpToolDeps } from "./tools.js";

/** §4.2: 30 tool calls/min burst as the quota-burn brake. */
export const MCP_RATE_LIMIT = { windowMs: 60_000, max: 30 } as const;

const MCP_SERVER_INFO = { name: "junior-browser", version: "0.0.0" } as const;

export interface McpRoutesDeps extends McpToolDeps {
  log?: (line: string) => void;
  /** Limiter seam for tests; a fresh 30/min limiter by default. */
  limiter?: RateLimiter;
}

function jsonRpcError(id: unknown, code: number, message: string, httpStatus: number) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: httpStatus });
}

export function mcpRoutes(deps: McpRoutesDeps) {
  const app = new Hono();
  const log = deps.log ?? ((line: string) => console.warn(line));
  const limiter = deps.limiter ?? createRateLimiter({ ...MCP_RATE_LIMIT });

  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST") {
      return jsonRpcError(
        null,
        -32_000,
        "Junior's MCP server is stateless — POST JSON-RPC requests only",
        405,
      );
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    if (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      (body as { method?: unknown }).method === "tools/call" &&
      !limiter.allow("mcp")
    ) {
      log("[mcp] rate-limited a tools/call (30/min burst)");
      return jsonRpcError(null, -32_000, "rate limited: too many tool calls (30/min burst)", 429);
    }

    const server = new McpServer(MCP_SERVER_INFO);
    registerMcpTools(server, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — every POST is self-contained
      enableJsonResponse: true, // the stdio proxy forwards plain JSON, not SSE frames
    });
    await server.connect(transport);
    // parsedBody: the rate-limit check already consumed the raw stream.
    const res = await transport.handleRequest(c.req.raw, { parsedBody: body });
    // JSON mode: handleRequest resolves only once the full response exists, but its body
    // stream is tied to the transport — drain it BEFORE tearing the per-request pair
    // down, then hand Hono a plain, materialized Response.
    const text = await res.text();
    await server.close();
    return new Response(text, { status: res.status, headers: res.headers });
  });

  return app;
}
