// @junior/bridge — Hono server on 127.0.0.1:8620 (plan §4).
// Scaffold stub: config/auth (M1-1), dispatcher (M1-2), status (M1-3),
// guard (M1-4), chat engines + MCP (M4) mount here.
import { PROTOCOL_API_LEVEL } from "@junior/protocol";

export const BRIDGE_STUB = true;

if (BRIDGE_STUB && process.env.JUNIOR_RUN_STUB === "1") {
  console.log(
    `junior bridge: scaffold stub — no server yet (M1-1), protocol level ${PROTOCOL_API_LEVEL}`,
  );
}
