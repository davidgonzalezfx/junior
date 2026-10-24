// @junior/bridge/dispatcher/routes — /api/agent/* (plan §3 HTTP table, §4.3).
// Mounted under the bearer-auth middleware; the extension's service worker is the
// only intended client (long-poll + result/approval posts).
import { Hono } from "hono";
import { ActionResultSchema, ApprovalDecisionSchema } from "@junior/protocol";
import type { Dispatcher } from "./queue.js";

// §4.3: long-poll ≤ 20 s, like ModelBridge get_pending_actions.
const MIN_POLL_S = 1;
const MAX_POLL_S = 20;
const DEFAULT_POLL_S = 15;

export function pollSeconds(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return DEFAULT_POLL_S;
  return Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, n));
}

export function agentRoutes(dispatcher: Dispatcher) {
  const routes = new Hono();

  // Response shape per the §3 HTTP table: the QueueItem itself, or {item: null}.
  routes.get("/next-action", async (c) => {
    const item = await dispatcher.nextAction(pollSeconds(c.req.query("timeout")) * 1000);
    return c.json(item ?? { item: null });
  });

  routes.post("/action-result", async (c) => {
    const parsed = ActionResultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "body must be an ActionResult" }, 400);
    return c.json({ delivered: dispatcher.resolveResult(parsed.data) });
  });

  routes.post("/approval-response", async (c) => {
    const parsed = ApprovalDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "body must be an ApprovalDecision" }, 400);
    return c.json({ delivered: dispatcher.resolveApproval(parsed.data) });
  });

  // M4-5 kill path (plan §8 accept d): the overlay ✕ / panel cancel lands here —
  // every in-flight future resolves denied and the queue empties, so no engine
  // (MCP client, agent loop, CLI turn) is left hanging on the 120 s timeout.
  routes.post("/cancel", (c) => {
    const killed = dispatcher.dispose("cancelled by user");
    return c.json({ ok: true, ...killed });
  });

  return routes;
}
