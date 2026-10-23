// @junior/bridge/chat/routes — POST /api/chat (plan §4.5 "Engine api", §3 HTTP table).
// M2-3 scope: engine "api", plain chat (agentMode tools land with M4-3, the cli engine
// with M4-4). Response is an AI SDK v7 UI message stream (SSE) straight from
// toUIMessageStream — the extension's useChat consumes it unchanged.
// M2-4: provider fallback chain from config — a provider 4xx/5xx BEFORE the first token
// retries the next candidate (chat/fallback.ts); after the first token the error surfaces.
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
import { AllProvidersFailedError, buildCandidateChain, firstSuccessfulStream } from "./fallback.js";

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
    let primaryModel;
    try {
      primaryModel = resolveModel(body.data.provider, body.data.model, config, deps.fetch);
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

    const instructions = body.data.system
      ? `${JUNIOR_SYSTEM}\n\n${body.data.system}`
      : JUNIOR_SYSTEM;
    const toErrorText = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    // The requested provider first, then configured chain entries (§4.5). A thunk that
    // throws (stale chain entry → UnknownProviderError) counts as a failed attempt.
    const candidates = buildCandidateChain(body.data.provider, config.providers.fallbackChain);
    const primary = streamText({
      model: primaryModel,
      instructions,
      messages,
      maxRetries: 0, // the fallback chain owns retries — SDK backoff would mask pre-token 5xxes
      onError: ({ error }) =>
        log(`[chat] stream error (${body.data.provider}): ${toErrorText(error)}`),
    });

    try {
      const stream = await firstSuccessfulStream([
        () => toUIMessageStream({ stream: primary.stream, onError: toErrorText }),
        ...candidates
          .filter((id) => id !== body.data.provider)
          .map((providerId) => () => {
            const model = resolveModel(providerId, body.data.model, config, deps.fetch);
            const result = streamText({
              model,
              instructions,
              messages,
              maxRetries: 0, // chain owns retries
              onError: ({ error }) =>
                log(`[chat] stream error (${providerId}): ${toErrorText(error)}`),
            });
            return toUIMessageStream({ stream: result.stream, onError: toErrorText });
          }),
      ]);
      return createUIMessageStreamResponse({ stream });
    } catch (error) {
      if (error instanceof AllProvidersFailedError) {
        log(`[chat] ${error.message}`);
        return c.json({ error: error.message }, 502);
      }
      throw error;
    }
  });

  return routes;
}
