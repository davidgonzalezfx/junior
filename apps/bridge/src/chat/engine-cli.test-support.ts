// Shared fixtures for the engine-cli test files (engine-cli.test.ts units,
// engine-cli.run.test.ts spawned turns, engine-cli.route.test.ts the HTTP route):
// tmp config dirs, the node -e fixture child that stands in for `claude` (§9:
// recorded stream-json, no CLI dependency in CI), and the route app helpers.
// Test-only — excluded from the build (tsconfig.build.json).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JuniorConfigSchema } from "@junior/protocol";
import { userMessage } from "@junior/testkit/chat";
import { cliInit } from "@junior/testkit/cli-stream";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";
import type { CliTurnOutcome, SpawnFn } from "./engine-cli.js";

let dirs: string[] = [];
/** afterEach in every engine-cli test file. */
export function cleanupTmpDirs(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
}
export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-cli-test-"));
  dirs.push(dir);
  return dir;
}

export const TOKEN = "c".repeat(64);

export const init = cliInit("sess-1");

/** A node -e script: prints the fixture events after draining stdin (the CLI reads
 * `-p -` from stdin, so the drain is behaviorally faithful). `mode` picks the path. */
export function fixtureScript(events: unknown[], mode: "emit" | "exit1" | "raw"): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (${JSON.stringify(mode)} === "exit1") { process.stderr.write("boom: bad flag\\n"); process.exit(1); }
  if (${JSON.stringify(mode)} === "raw") { process.stdout.write("unparsable noise\\n" + JSON.stringify(${JSON.stringify(events[0])}) + "\\n"); return; }
  for (const e of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(e) + "\\n");
});
`;
}

export async function runFixture(
  script: string,
  prompt = "hello",
): Promise<{ chunks: Array<Record<string, unknown>>; outcome: CliTurnOutcome }> {
  const chunks: Array<Record<string, unknown>> = [];
  const { runCliTurn } = await import("./engine-cli.js");
  const outcome = await runCliTurn(
    {
      exe: process.execPath,
      args: ["-e", script],
      prompt,
      log: () => {},
    },
    (chunk) => chunks.push(chunk as Record<string, unknown>),
  );
  return { chunks, outcome };
}

export const uiMessage = userMessage("hi", "m1");

/** spawnImpl seam: records the CLI-style args, then REALLY spawns a node fixture —
 * proving the route pipes stdin/SSE through a genuine child process. */
export function makeSpawnSeam(events: unknown[]) {
  const calls: Array<{ args: string[] }> = [];
  const spawnImpl: SpawnFn = (exe, args, opts) => {
    void exe;
    calls.push({ args: [...args] });
    return spawn(process.execPath, ["-e", fixtureScript(events, "emit")], opts);
  };
  return { spawnImpl, calls };
}

export function newCliApp(spawnImpl: SpawnFn, cliPath?: string) {
  const dir = tmpDir();
  saveConfig(JuniorConfigSchema.parse(cliPath ? { cliPath } : {}), dir);
  writeToken(TOKEN, dir);
  const app = createApp({
    dir,
    log: () => {},
    chat: { cli: { spawnImpl, loopbackUrl: "http://127.0.0.1:9700" } },
  });
  return app;
}

export function postChat(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}
