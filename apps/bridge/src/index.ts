// @junior/bridge — Hono app on 127.0.0.1:8620 (plan §1, §4).
// M1-1: health + pairing + auth/CORS. M1-2: dispatcher long-poll (/api/agent/*).
// M1-3: /api/status. M2-3: /api/chat (engine api). M2-4: /api/config + /api/config/test
// (Settings→Providers) + chat fallback chain. Guard (M1-4), the cli engine + MCP
// server (M4) mount below the auth middleware as they land.
import { Hono } from "hono";
import { PairingRequestSchema, PairingResultSchema, PairingStatusSchema } from "@junior/protocol";
import { Dispatcher, type ActionGuard } from "./dispatcher/queue.js";
import { defaultGuard } from "./dispatcher/guard.js";
import { agentRoutes } from "./dispatcher/routes.js";
import { chatRoutes } from "./chat/routes.js";
import { providersRoutes } from "./providers.js";
import { bearerAuth, corsAllowlist, tokensMatch, type Logger } from "./auth.js";
import { mcpRoutes } from "./mcp/server.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  consumePairingWindow,
  juniorDir,
  pairingWindowOpen,
  readToken,
  writeToken,
} from "./config.js";
import { statusRoutes } from "./status.js";
import type { probeClaude } from "./cli-detect.js";
import type { ProviderTestDeps } from "./providers.js";

export interface BridgeDeps {
  /** Config dir (~/.junior or $JUNIOR_HOME) — injected so tests run hermetically. */
  dir: string;
  /** Operational log (rejected auth, pairing) — defaults to console.warn. */
  log?: Logger;
  /** Dispatcher seam for tests; each app gets a fresh one by default. */
  dispatcher?: Dispatcher;
  /** §4.4 guard seam — the default SessionGuard when the dispatcher is built here.
   * Ignored when `dispatcher` is injected: construct that one with its own guard. */
  guard?: ActionGuard;
  /** /api/status seams for tests — real detection + package.json version by default. */
  status?: { probe?: typeof probeClaude; version?: string };
  /** /api/chat test seam — handed to resolveModel (in-process mock provider wires). */
  chat?: { fetch?: typeof fetch };
  /** /api/config/test seams — models-fetch wire + env for the "test provider" button. */
  providers?: { test?: ProviderTestDeps };
  /** /mcp seams — rate-limiter injection for tests. */
  mcp?: { limiter?: RateLimiter };
}

export function createApp(deps: BridgeDeps = { dir: juniorDir() }) {
  const log: Logger = deps.log ?? ((line) => console.warn(line));
  const guard = deps.guard ?? defaultGuard(deps.dir); // §4.4 enforcement point
  const dispatcher = deps.dispatcher ?? new Dispatcher({ guard });
  const app = new Hono();

  app.use("*", corsAllowlist());

  // Liveness only — no data, no auth (plan §3 HTTP table).
  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/pairing", (c) =>
    c.json(
      PairingStatusSchema.parse({
        tokenRequired: true, // v1: every other route demands the token (plan §4.2)
        tokenSet: readToken(deps.dir) !== null,
      }),
    ),
  );

  // Registered before bearerAuth on purpose: a first-time pairing presents the extension's
  // own token, which the bridge cannot verify against anything yet — §4.1's pairing window
  // is the guard for token-setting, and bearerAuth skips GET /api/pairing itself anyway.
  app.post("/api/pairing", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PairingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "body must be {token: <64 hex chars>}" }, 400);
    }

    const stored = readToken(deps.dir);
    if (stored !== null) {
      if (!tokensMatch(parsed.data.token, stored)) {
        log(`[pairing] reject origin=${c.req.header("origin") ?? "-"} reason=mismatch`);
        return c.json(
          { error: "token mismatch — run `junior-bridge pair` to open a 60 s pairing window" },
          403,
        );
      }
      return c.json(PairingResultSchema.parse({ ok: true, alreadyPaired: true })); // idempotent
    }
    if (!pairingWindowOpen(deps.dir)) {
      return c.json(
        { error: "no token set and no pairing window open — run `junior-bridge pair`" },
        403,
      );
    }
    writeToken(parsed.data.token, deps.dir);
    consumePairingWindow(deps.dir);
    log("[pairing] token set from extension (window consumed)");
    return c.json(PairingResultSchema.parse({ ok: true, alreadyPaired: false }));
  });

  // Everything below requires the pairing token (plan §4.2). The token file is read per
  // request (no cache) so `junior-bridge pair` — a separate process — takes effect at once.
  app.use(
    "/api/*",
    bearerAuth(() => readToken(deps.dir), log),
  );

  // M1-2: dispatcher long-poll + result/approval posts (fall under auth above).
  app.route("/api/agent", agentRoutes(dispatcher));

  // M4-1: MCP streamable HTTP (§4.6) — same bearer gate as /api/*, mounted explicitly
  // on /mcp (the /api/* pattern above doesn't cover it).
  app.use(
    "/mcp",
    bearerAuth(() => readToken(deps.dir), log),
  );
  app.route(
    "/",
    mcpRoutes({
      dir: deps.dir,
      dispatcher,
      log,
      limiter: deps.mcp?.limiter,
      probe: deps.status?.probe, // same seams as /api/status — junior_status shares it
      version: deps.status?.version,
    }),
  );

  // M1-3: /api/status — bridge facts + provider availability + CLI detection.
  app.route("/api", statusRoutes({ dir: deps.dir, dispatcher, ...deps.status }));

  // M2-3: /api/chat — engine "api" streaming (plan §4.5); cli engine lands M4-4.
  // M4-3: agentMode dispatches through the same dispatcher the extension polls.
  app.route("/api", chatRoutes({ dir: deps.dir, dispatcher, log, fetch: deps.chat?.fetch }));

  // M2-4: Settings→Providers — masked GET, patch PUT, models test (plan §5.3).
  app.route("/api", providersRoutes({ dir: deps.dir, log, test: deps.providers?.test }));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    log(`[bridge] ${c.req.method} ${c.req.path} failed: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
