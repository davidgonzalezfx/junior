// junior-bridge CLI (plan §2 bin.ts): `serve` (default) runs the bridge headless;
// `pair` implements §4.1's re-pairing — clear the stored token and open a 60 s window in
// which the extension's POST /api/pairing may set a new one.
import { serve } from "@hono/node-server";
import { createApp } from "./index.js";
import { Dispatcher } from "./dispatcher/queue.js";
import { defaultGuard } from "./dispatcher/guard.js";
import {
  clearToken,
  ensureToken,
  juniorDir,
  loadConfig,
  openPairingWindow,
  PAIRING_WINDOW_MS,
} from "./config.js";

function serveCommand(): void {
  const dir = juniorDir();
  const config = loadConfig(dir);
  const token = ensureToken(dir);
  if (token === null) {
    console.log("pairing window open — waiting for the extension to POST /api/pairing");
  } else {
    console.log(`pairing token stored at ${dir}/token (first 8 chars: ${token.slice(0, 8)}…)`);
  }
  // Owned here so shutdown can deny in-flight futures (M4-5) — createApp accepts
  // an injected dispatcher, and the guard seam mirrors createApp's own default.
  const dispatcher = new Dispatcher({ guard: defaultGuard(dir) });
  const app = createApp({ dir, dispatcher });
  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }); // §4.2: loopback only
  console.log(`junior bridge listening on http://127.0.0.1:${config.port}`);
  const shutdown = () => {
    const killed = dispatcher.dispose("bridge shutting down");
    if (killed.actions + killed.approvals > 0) {
      console.log(
        `junior bridge: denied ${killed.actions} action(s) / ${killed.approvals} approval(s) on shutdown`,
      );
    }
    // Yield one tick so the just-resolved futures' HTTP responses flush before
    // exit — a killed task's caller sees "bridge shutting down", not a reset socket.
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function pairCommand(): void {
  const dir = juniorDir();
  clearToken(dir);
  openPairingWindow(dir);
  console.log(`stored token cleared — pairing window open for ${PAIRING_WINDOW_MS / 1000}s.`);
  console.log("Open the Junior panel now and click Pair (it will POST /api/pairing).");
}

function main(argv: string[]): number {
  const [cmd = "serve"] = argv;
  switch (cmd) {
    case "serve":
      serveCommand();
      return 0;
    case "pair":
      pairCommand();
      return 0;
    default:
      console.error(`unknown command "${cmd}" — usage: junior-bridge [serve|pair]`);
      return 1;
  }
}

const exitCode = main(process.argv.slice(2));
if (exitCode !== 0) process.exit(exitCode);
