// @junior/bridge/chat/routes — POST /api/chat (plan §4.5 "Engine api", §3 HTTP table).
// M2-3 scope: engine "api", plain chat (agentMode tools land with M4-3, the cli engine
// with M4-4). Response is an AI SDK v7 UI message stream (SSE) straight from
// toUIMessageStream — the extension's useChat consumes it unchanged.
import { Hono } from "hono";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { ChatRequestBodySchema } from "@junior/protocol";
import type { Logger } from "../auth.js";
import { loadConfig } from "../config.js";
import { UnknownProviderError, resolveModel } from "./registry.js";

/** v7: `system` was renamed `instructions` (old name is a deprecated fallback). */
const JUNIOR_SYSTEM =
  "You are Junior, a browser-side assistant. Answer directly in markdown. " +
  "You have no tools in plain chat mode.";

export const ENGINE_NOT_WIRED =
  "engine not available yet — the cli engine lands in M4 (plan §8 M4-4) and agentMode tools in M4-3";

export interface ChatDeps {
  dir: string;
  log?: Logger;
  /** Test seam — handed to resolveModel so tests hit in-process mock wires. */
  fetch?: typeof fetch;
}

export function chatRoutes(deps: ChatDeps) {
  const log: Logger = deps.log ?? ((line) => console.warn(line));
  const routes = new Hono();

  routes.post("/chat", async (c) => {
    const body = ChatRequestBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const detail = body.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      return c.json({ error: `invalid chat request — ${detail}` }, 400);
    }
    if (body.data.engine === "cli" || body.data.agentMode) {
      return c.json({ error: ENGINE_NOT_WIRED }, 501);
    }

    const config = loadConfig(deps.dir); // per request: Settings edits land without a restart
    let model;
    try {
      model = resolveModel(body.data.provider, body.data.model, config, deps.fetch);
    } catch (error) {
      if (error instanceof UnknownProviderError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    let messages;
    try {
      // v7: async. This is the real validator for the loose `messages` wire — garbage
      // UIMessages throw here and surface as a 400, not a mid-stream error part.
      messages = await convertToModelMessages(body.data.messages as unknown as UIMessage[]);
    } catch (error) {
      return c.json(
        { error: `invalid messages — ${String(error instanceof Error ? error.message : error)}` },
        400,
      );
    }

    const result = streamText({
      model,
      instructions: body.data.system ? `${JUNIOR_SYSTEM}\n\n${body.data.system}` : JUNIOR_SYSTEM,
      messages,
      onError: ({ error }) => log(`[chat] stream error: ${String(error)}`),
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  });

  return routes;
}
