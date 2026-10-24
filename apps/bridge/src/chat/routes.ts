// @junior/bridge/chat/routes — POST /api/chat (plan §4.5, §3 HTTP table).
// M2-3 scope: engine "api", plain chat. M4-3: agentMode registers the §4.5 browser
// tool set (chat/tools.ts) and runs streamText's multi-step loop bounded by
// config.maxSteps — tool calls execute through the dispatcher (guard + approval
// cards) and their results feed the next step. M4-4: engine "cli" spawns the claude
// CLI (chat/engine-cli.ts) with --mcp-config looping back at this bridge's /mcp —
// the CLI's tool calls traverse the same dispatcher + guard + cards.
// Response is an AI SDK v7 UI message stream (SSE) either way — the extension's
// useChat consumes it unchanged.
// M2-4: provider fallback chain from config — a provider 4xx/5xx BEFORE the first token
// retries the next candidate (chat/fallback.ts); after the first token the error surfaces.
import { Hono } from "hono";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { ChatRequestBodySchema } from "@junior/protocol";
import type { Logger } from "../auth.js";
import { loadConfig } from "../config.js";
import type { Dispatcher } from "../dispatcher/queue.js";
import { UnknownProviderError, resolveModel } from "./registry.js";
import { AllProvidersFailedError, buildCandidateChain, firstSuccessfulStream } from "./fallback.js";
import { browserTools } from "./tools.js";
import { CliSessionMap, prepareCliTurn, runCliTurn, type SpawnFn } from "./engine-cli.js";

/** v7: `system` was renamed `instructions` (old name is a deprecated fallback). */
const JUNIOR_SYSTEM =
  "You are Junior, a browser-side assistant. Answer directly in markdown. " +
  "You have no tools in plain chat mode.";

const JUNIOR_AGENT_SYSTEM =
  "You are Junior, a browser-side assistant with controlled access to the user's " +
  "Chrome through the provided tools. Work step by step toward the user's goal: " +
  "get_active_tab / read_page (outline) to see the page, then click/type/navigate as " +
  "needed; verify with read_page before acting on guesses. Finish with a short " +
  "markdown summary of what you did. A denied action (USER_DENIED:, BLOCKED_BY_POLICY:) " +
  "is final — never retry it; say so and continue or stop.";

export interface ChatDeps {
  dir: string;
  /** Agent mode's tools dispatch through the same queue the extension polls. */
  dispatcher: Dispatcher;
  log?: Logger;
  /** Test seam — handed to resolveModel so tests hit in-process mock wires. */
  fetch?: typeof fetch;
  /** CLI engine (M4-4) seams — loopback URL override (harness binds port 0) and a
   * spawnImpl for tests that must not spawn a real `claude`. */
  cli?: { loopbackUrl?: string; spawnImpl?: SpawnFn };
}

export function chatRoutes(deps: ChatDeps) {
  const log: Logger = deps.log ?? ((line) => console.warn(line));
  const routes = new Hono();
  const cliSessions = new CliSessionMap(); // one --resume map per app instance
  const toErrorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  routes.post("/chat", async (c) => {
    // Raw body kept for convId — DefaultChatTransport sends the useChat id beside the
    // schema'd fields; z.object strips it, but it's the §4.5 session-map key.
    const raw: unknown = await c.req.json().catch(() => null);
    const body = ChatRequestBodySchema.safeParse(raw);
    if (!body.success) {
      const detail = body.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      return c.json({ error: `invalid chat request — ${detail}` }, 400);
    }

    if (body.data.engine === "cli") {
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
        body.data,
        convId,
      );
      if (!plan.ok) return c.json({ error: plan.error }, plan.status);
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: "start" });
          writer.write({ type: "start-step" });
          await runCliTurn(plan.options, (chunk) => writer.write(chunk));
          writer.write({ type: "finish-step" });
          writer.write({ type: "finish" });
        },
        onError: toErrorText,
      });
      return createUIMessageStreamResponse({ stream });
    }

    const config = loadConfig(deps.dir); // per request: Settings edits land without a restart
    const agentMode = body.data.agentMode;
    // §4.5: agentMode registers the browser tools and bounds the loop at config.maxSteps.
    const tools = agentMode ? browserTools({ dispatcher: deps.dispatcher }) : undefined;
    const stopWhen = agentMode ? isStepCount(config.maxSteps) : undefined;
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
      ? `${agentMode ? JUNIOR_AGENT_SYSTEM : JUNIOR_SYSTEM}\n\n${body.data.system}`
      : agentMode
        ? JUNIOR_AGENT_SYSTEM
        : JUNIOR_SYSTEM;

    // The requested provider first, then configured chain entries (§4.5). A thunk that
    // throws (stale chain entry → UnknownProviderError) counts as a failed attempt.
    // Every candidate runs the SAME agent options — a mid-chain fallback must not
    // silently drop the tool loop.
    const candidates = buildCandidateChain(body.data.provider, config.providers.fallbackChain);
    const buildStream = (model: LanguageModel, providerId: string) =>
      streamText({
        model,
        instructions,
        messages,
        ...(tools !== undefined ? { tools, stopWhen } : {}),
        maxRetries: 0, // the fallback chain owns retries — SDK backoff would mask pre-token 5xxes
        onError: ({ error }) => log(`[chat] stream error (${providerId}): ${toErrorText(error)}`),
      });

    try {
      const stream = await firstSuccessfulStream([
        () =>
          toUIMessageStream({
            stream: buildStream(primaryModel, body.data.provider).stream,
            onError: toErrorText,
          }),
        ...candidates
          .filter((id) => id !== body.data.provider)
          .map((providerId) => () => {
            const model = resolveModel(providerId, body.data.model, config, deps.fetch);
            return toUIMessageStream({
              stream: buildStream(model, providerId).stream,
              onError: toErrorText,
            });
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
