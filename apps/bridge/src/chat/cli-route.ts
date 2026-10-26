// @junior/bridge/chat/cli-route — the engine "cli" branch of POST /api/chat (plan §4.5
// "Engine cli"): spawns the claude CLI (chat/engine-cli.ts) and writes its mapped chunks
// as an AI SDK v7 UI message stream, same wire as the "api" engine.
import type { Context } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ChatRequestBody } from "@junior/protocol";
import type { Logger } from "../auth.js";
import { loadConfig } from "../config.js";
import { prepareCliTurn, runCliTurn, type CliSessionMap } from "./engine-cli.js";
import { cliResultToMetadata } from "./metadata.js";
import type { ChatDeps } from "./routes.js";

export interface CliRouteContext {
  log: Logger;
  /** One --resume map per app instance (owned by chatRoutes). */
  sessions: CliSessionMap;
  toErrorText: (error: unknown) => string;
}

export function cliChatResponse(
  c: Context,
  deps: ChatDeps,
  { log, sessions: cliSessions, toErrorText }: CliRouteContext,
  raw: unknown,
  body: ChatRequestBody,
) {
  const wireId = (raw as { id?: unknown } | null)?.id;
  const convId = typeof wireId === "string" && wireId ? wireId.slice(0, 200) : null;
  const config = loadConfig(deps.dir);
  const plan = prepareCliTurn(
    {
      dir: deps.dir,
      config,
      log,
      loopbackUrl: deps.cli?.loopbackUrl,
      spawnImpl: deps.cli?.spawnImpl,
      sessions: cliSessions,
    },
    body,
    convId,
  );
  if (!plan.ok) return c.json({ error: plan.error }, plan.status);
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      const outcome = await runCliTurn(
        {
          ...plan.options,
          // Panel Stop / client disconnect kills the spawned CLI —
          // otherwise the turn keeps running tools headless.
          signal: c.req.raw.signal,
        },
        (chunk) => writer.write(chunk),
      );
      // The result event's usage rides as message metadata
      // (the manual-write equivalent of toUIMessageStream's messageMetadata).
      if (outcome.result !== null && !outcome.result.isError) {
        writer.write({
          type: "message-metadata",
          messageMetadata: cliResultToMetadata(outcome.result, body.model),
        });
      }
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });
    },
    onError: toErrorText,
  });
  return createUIMessageStreamResponse({ stream });
}
