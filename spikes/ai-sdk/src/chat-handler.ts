// M0-4 spike core: plan §4.5 "Engine api" shape, verified against AI SDK v7.
// Names that changed vs the plan's v5-era snippet: isStepCount (was stepCountIs),
// stateless toUIMessageStream({stream}) (was result.toUIMessageStream()),
// instructions (system is a deprecated fallback), await convertToModelMessages.
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

export interface ChatHandlerEnv {
  anthropicApiKey?: string;
  /** Must include /v1 (default prefix is https://api.anthropic.com/v1). */
  anthropicBaseUrl?: string;
  anthropicModel: string;
  openaiCompatibleBaseUrl: string;
}

export interface ChatRequestBody {
  messages: UIMessage[];
  provider?: "mock-openai" | "anthropic";
  agentMode?: boolean;
}

export async function handleChat(request: Request, env: ChatHandlerEnv): Promise<Response> {
  const body = (await request.json()) as ChatRequestBody;
  const messages = body.messages ?? [];
  const agentMode = body.agentMode === true;

  const model =
    body.provider === "anthropic" && env.anthropicApiKey
      ? createAnthropic({
          apiKey: env.anthropicApiKey,
          baseURL: env.anthropicBaseUrl,
        }).languageModel(env.anthropicModel)
      : createOpenAICompatible({
          name: "junior-spike-openai",
          baseURL: env.openaiCompatibleBaseUrl,
          apiKey: "spike-not-a-real-key",
          includeUsage: true,
        }).languageModel("mock-1");

  const result = streamText({
    model,
    instructions: "You are Junior's spike assistant. Reply with the exact token the user asks for.",
    messages: await convertToModelMessages(messages),
    ...(agentMode
      ? {
          tools: {
            now: tool({
              description:
                "Returns the bridge server's current time. Stand-in for the browser tools of plan §4.5.",
              inputSchema: z.object({}),
              execute: async () => new Date().toISOString(),
            }),
          },
          stopWhen: isStepCount(5),
        }
      : {}),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
