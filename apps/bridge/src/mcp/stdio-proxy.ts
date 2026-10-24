// @junior/bridge/mcp/stdio-proxy — `junior-mcp` bin (plan §2 tree, §3 HTTP table):
// speaks MCP stdio JSON-RPC with a local agent (Claude Desktop, any MCP client) and
// forwards each line to the bridge's POST /mcp with the pairing token attached.
// Port of modelbridge-clone/mcp_server.py with Junior's fixes (plan §7-11/§6.1): the
// URL and token come from ONE config source ($JUNIOR_HOME or ~/.junior — ModelBridge's
// stale :8000 default is gone), the token header is actually sent, and transport
// notifications (HTTP 202, no body) produce no stdout line.
// stdout carries ONLY JSON-RPC — diagnostics go to stderr.
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { loadConfig, juniorDir, readToken } from "../config.js";

const JSON_RPC_VERSION = "2.0" as const;

/** Streamable HTTP requires both media types in Accept (the bridge's transport
 * enforces it); the timeout covers the dispatcher's full 120 s action window. */
const FORWARD_TIMEOUT_MS = 130_000;

export interface StdioProxyDeps {
  /** Lines of JSON-RPC as they arrive on stdin (one per line). */
  lines: AsyncIterable<string> | Iterable<string>;
  /** stdout — must receive at most one JSON line per request-bearing message. */
  write: (line: string) => void;
  /** Bridge /mcp endpoint, e.g. http://127.0.0.1:8620/mcp. */
  url: string;
  /** Pairing token from ~/.junior/token (null = unset; the bridge 401s and the
   * error tells the user to pair). */
  token: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function errorResponse(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });
}

function requestId(message: unknown): unknown {
  if (typeof message === "object" && message !== null && "id" in message) {
    return (message as { id: unknown }).id;
  }
  return null;
}

export async function runStdioProxy(deps: StdioProxyDeps): Promise<void> {
  const doFetch = deps.fetchFn ?? fetch;
  for await (const raw of deps.lines) {
    const line = raw.trim();
    if (line === "") continue;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      deps.write(errorResponse(null, -32_700, "Parse error"));
      continue;
    }

    let res: Response;
    try {
      res = await doFetch(deps.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(deps.token !== null ? { Authorization: `Bearer ${deps.token}` } : {}),
        },
        body: line,
        signal: AbortSignal.timeout(deps.timeoutMs ?? FORWARD_TIMEOUT_MS),
      });
    } catch (cause) {
      // Port of mcp_server.py's URLError branch, with the actual fix instruction.
      deps.write(
        errorResponse(
          requestId(message),
          -32_603,
          `Could not connect to the Junior bridge at ${deps.url} — is it running? Start it with: junior-bridge serve (${String(cause)})`,
        ),
      );
      continue;
    }

    if (res.status === 202) continue; // notification accepted — no response body, no stdout line
    const text = await res.text();
    if (res.ok) {
      // 200 with a JSON (JSON-RPC) body — forward verbatim, compacted to one line.
      try {
        deps.write(JSON.stringify(JSON.parse(text)));
      } catch {
        deps.write(
          errorResponse(
            requestId(message),
            -32_603,
            `Junior bridge returned non-JSON body (HTTP ${res.status}): ${text.slice(0, 200)}`,
          ),
        );
      }
      continue;
    }
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    } catch {
      // keep the raw body snippet
    }
    if (res.status === 401 || res.status === 403) {
      detail = `authentication failed (${res.status}) — run \`junior-bridge pair\` and re-pair the extension, or check ~/.junior/token`;
    }
    deps.write(
      errorResponse(
        requestId(message),
        -32_603,
        `Junior bridge error (HTTP ${res.status}): ${detail}`,
      ),
    );
  }
}

/** bin entry: one config source for URL + token (plan §7-11). */
export function resolveProxyTarget(dir: string): { url: string; token: string | null } {
  const config = loadConfig(dir);
  return { url: `http://127.0.0.1:${config.port}/mcp`, token: readToken(dir) };
}

export async function main(
  stream: NodeJS.ReadableStream = process.stdin,
  dir: string = juniorDir(),
): Promise<number> {
  let target: { url: string; token: string | null };
  try {
    target = resolveProxyTarget(dir);
  } catch (cause) {
    process.stderr.write(`junior-mcp: cannot read Junior config (${String(cause)})\n`);
    return 1;
  }
  process.stderr.write(`junior-mcp: forwarding stdio JSON-RPC to ${target.url}\n`);
  const lines = createInterface({ input: stream });
  await runStdioProxy({
    lines: lines,
    write: (line) => process.stdout.write(`${line}\n`),
    url: target.url,
    token: target.token,
  });
  return 0;
}

// Main-module check that holds for BOTH `node dist/mcp/stdio-proxy.js` and a tsx run of
// src — vitest imports (argv[1] = vitest's cli) never match. (An endsWith-on-filename
// guard here once silently disabled the whole bin — this spawn is test-covered.)
const invokedAsBin =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
      return false;
    }
  })();
if (invokedAsBin) {
  void main().then((code) => code !== 0 && process.exit(code));
}
