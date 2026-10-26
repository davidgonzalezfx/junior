// @junior/bridge/status — GET /api/status (plan §3 HTTP table + BridgeStatusSchema).
// Provider entries = config facts (which keys are configured) + CLI detection (§4.5,
// cli-detect.ts); browserConnected/queueDepth come from the dispatcher (§4.3's 25 s
// freshness). Config is loaded per request so Settings→Providers edits (M2) land
// without a bridge restart — same policy as the per-request token read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { BridgeStatusSchema, type JuniorConfig, type ProviderStatus } from "@junior/protocol";
import type { Dispatcher } from "./dispatcher/queue.js";
import { loadConfig } from "./config.js";
import { cliDetail, probeClaude, type ClaudeCliStatus } from "./cli-detect.js";

/** Bump when /api/status's shape breaks — the extension pins one for compat checks. */
export const API_LEVEL = 1;

export interface StatusDeps {
  dir: string;
  dispatcher: Dispatcher;
  /** Detection seam for tests; defaults to the real probeClaude. */
  probe?: typeof probeClaude;
  /** Bridge version seam for tests; defaults to apps/bridge/package.json. */
  version?: string;
}

/** Bridge package version, resolved relative to this module (works from src via tsx
 * and from dist alike). Unreadable file ⇒ "0.0.0" rather than a failed status call. */
export function bridgeVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Pure function of config + CLI status (unit-tested without HTTP). Order is stable:
 * claude-cli, anthropic, then each openai-compatible entry in config order. */
export function buildProviders(config: JuniorConfig, cli: ClaudeCliStatus): ProviderStatus[] {
  const providers: ProviderStatus[] = [
    {
      id: "claude-cli",
      kind: "claude-cli",
      label: "Claude Code (CLI)",
      available: cli.found && cli.loggedIn,
      detail: cliDetail(cli),
      models: [], // the CLI engine owns its model map
    },
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      available: Boolean(config.providers.anthropicKey),
      detail: config.providers.anthropicKey ? "API key configured" : undefined,
      models: [], // model-catalog fetch lands with the Settings→Providers picker
    },
  ];
  for (const p of config.providers.openaiCompatible) {
    providers.push({
      id: p.id,
      kind: "openai-compatible",
      label: p.label,
      available: p.apiKey.length > 0,
      detail: p.baseUrl,
      models: (p.models ?? []).map((id) => ({ id, badges: [] })), // badges is output-required (zod .default)
    });
  }
  return providers;
}

export function statusRoutes(deps: StatusDeps) {
  const routes = new Hono();
  const probe = deps.probe ?? probeClaude;
  const version = deps.version ?? bridgeVersion();

  routes.get("/status", async (c) => {
    const config = loadConfig(deps.dir);
    const cli = await probe({ overridePath: config.cliPath });
    return c.json(
      BridgeStatusSchema.parse({
        version,
        apiLevel: API_LEVEL,
        providers: buildProviders(config, cli),
        browserConnected: deps.dispatcher.connected(),
        queueDepth: deps.dispatcher.queueDepth,
      }),
    );
  });

  return routes;
}
