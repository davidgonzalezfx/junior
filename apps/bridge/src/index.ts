// @junior/bridge — Hono app on 127.0.0.1:8620 (plan §1, §4).
// M1-1: health + pairing + auth/CORS. M1-2: dispatcher long-poll (/api/agent/*).
// /api/status (M1-3), guard (M1-4), chat engines + MCP server (M4) mount below the
// auth middleware as they land.
import { Hono } from "hono";
import { PairingRequestSchema, PairingResultSchema, PairingStatusSchema } from "@junior/protocol";
import { Dispatcher } from "./dispatcher/queue.js";
import { agentRoutes } from "./dispatcher/routes.js";
import { bearerAuth, corsAllowlist, tokensMatch, type Logger } from "./auth.js";
import {
  consumePairingWindow,
  juniorDir,
  pairingWindowOpen,
  readToken,
  writeToken,
} from "./config.js";

export interface BridgeDeps {
  /** Config dir (~/.junior or $JUNIOR_HOME) — injected so tests run hermetically. */
  dir: string;
  /** Operational log (rejected auth, pairing) — defaults to console.warn. */
  log?: Logger;
  /** Dispatcher seam for tests; each app gets a fresh one by default. */
  dispatcher?: Dispatcher;
}

export function createApp(deps: BridgeDeps = { dir: juniorDir() }) {
  const log: Logger = deps.log ?? ((line) => console.warn(line));
  const dispatcher = deps.dispatcher ?? new Dispatcher();
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
  // M1-3 mounts /api/status here.
  app.route("/api/agent", agentRoutes(dispatcher));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    log(`[bridge] ${c.req.method} ${c.req.path} failed: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}
