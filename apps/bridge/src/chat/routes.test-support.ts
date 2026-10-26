// Shared app + wire helpers for the POST /api/chat (engine api) test files:
// routes.test.ts (streaming, validation, history healing), routes-fallback.test.ts
// (the fallback chain), routes-agent.test.ts (agentMode tool loop). The provider
// wire mocks themselves live in @junior/testkit. Test-only — excluded from the
// build (tsconfig.build.json).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JuniorConfigSchema } from "@junior/protocol";
import { userMessage } from "@junior/testkit/chat";
import { closeOpenMockServers } from "@junior/testkit/openai-mock";
import { anthropicTextTurn } from "@junior/testkit/wire";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";

export const TOKEN = "b".repeat(64);
let dirs: string[] = [];
/** afterEach in every routes test file: tmp config dirs + mock provider servers. */
export function cleanupChatTests(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  closeOpenMockServers();
}

export function newApp(config?: Record<string, unknown>, chatFetch?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "junior-chat-test-"));
  dirs.push(dir);
  saveConfig(JuniorConfigSchema.parse(config ?? {}), dir);
  writeToken(TOKEN, dir);
  const app = createApp({ dir, log: () => {}, chat: { fetch: chatFetch } });
  return { app };
}

export const auth = { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` };

/** res.json() is unknown under this tsconfig — narrow to the bridge's error envelope. */
export function wireError(json: unknown): string {
  return typeof (json as { error?: unknown }).error === "string"
    ? (json as { error: string }).error
    : "";
}
export const uiMessage = userMessage("hi", "m1");

/** Anthropic Messages-API SSE wire, served from a `fetch` function (no socket needed). */
export function anthropicMockFetch(): typeof fetch {
  const body = anthropicTextTurn("ANTHROPIC_MOCK_OK", {
    messageId: "msg_mock",
    inputTokens: 9,
    outputTokens: 4,
  });
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
}

export async function postChat(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = auth,
) {
  return app.request("/api/chat", { method: "POST", headers, body: JSON.stringify(body) });
}
