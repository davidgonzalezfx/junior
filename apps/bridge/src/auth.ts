// @junior/bridge/auth — bearer-token middleware + CORS allowlist (plan §4.2).
// Fixes the ModelBridge gaps (zero token verification, CORS "*", PNA always on): every
// non-public route demands `Authorization: Bearer <token>` compared constant-time, and
// responses carry CORS headers only for the extension/loopback origins.
import { createHash, timingSafeEqual } from "node:crypto";

import { EXTENSION_ORIGIN } from "@junior/protocol";
import { createMiddleware } from "hono/factory";

export type Logger = (line: string) => void;

// Digest first: timingSafeEqual throws on length mismatch (and leaks length via timing).
function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function tokensMatch(presented: string, stored: string): boolean {
  return timingSafeEqual(digest(presented), digest(stored));
}

// Reader origins: our pinned extension (EXTENSION_ORIGIN — manifest key in
// apps/extension/wxt.config.ts, docs/decisions.md 2026-10-23) + loopback pages. A foreign
// page/origin gains nothing: without the token its mutations still fail auth, it just
// can't read responses.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return origin === EXTENSION_ORIGIN || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// §4.2: only /api/health and GET /api/pairing are open. Checked inside the middleware (not by
// registration order) so a future route can't silently skip auth.
export const PUBLIC_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/pairing" },
];

export function bearerAuth(
  getToken: () => string | null,
  log: Logger = (line) => console.warn(line),
) {
  return createMiddleware(async (c, next) => {
    if (c.req.method === "OPTIONS") return next(); // preflights never carry Authorization
    if (PUBLIC_ROUTES.some((r) => r.method === c.req.method && r.path === c.req.path)) {
      return next();
    }
    const presented = /^Bearer (\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? null;
    const stored = getToken();
    if (presented === null) {
      log(
        `[auth] reject path=${c.req.path} origin=${c.req.header("origin") ?? "-"} reason=no-token`,
      );
      return c.json({ error: "missing bearer token" }, 401);
    }
    if (stored === null || !tokensMatch(presented, stored)) {
      log(
        `[auth] reject path=${c.req.path} origin=${c.req.header("origin") ?? "-"} reason=bad-token`,
      );
      return c.json({ error: "invalid token" }, 403);
    }
    await next();
  });
}

// Deny-by-default CORS: echo the origin — and answer preflights with the private-network
// allowance — ONLY for allowlisted origins. Everything else gets no ACAO: the request may
// still execute, but the page can't read the response (and mutations still need the token).
export function corsAllowlist() {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = isAllowedOrigin(origin);
    c.header("Vary", "Origin"); // ACAO varies per request — keep caches honest
    if (allowed && origin) c.header("Access-Control-Allow-Origin", origin);
    if (c.req.method === "OPTIONS") {
      if (allowed) {
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
        c.header("Access-Control-Allow-Private-Network", "true");
        c.header("Access-Control-Max-Age", "600");
      }
      return c.body(null, 204);
    }
    await next();
  });
}
