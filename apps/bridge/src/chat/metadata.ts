// @junior/bridge/chat/metadata — the two ChatMessageMetadata mappers behind the usage
// chips (plan §5.3): one per engine.
import type { ChatMessageMetadata } from "@junior/protocol";
import type { CliResult } from "./cli-mapper.js";

/** The result event → ChatMessageMetadata (usage chips, plan §5.3). Only a successful
 * result reaches the caller (errors surface as error chunks), so this maps unconditionally. */
export function cliResultToMetadata(result: CliResult, model: string): ChatMessageMetadata {
  const usage: NonNullable<ChatMessageMetadata["usage"]> = {};
  if (typeof result.usage?.input_tokens === "number") usage.inputTokens = result.usage.input_tokens;
  if (typeof result.usage?.output_tokens === "number")
    usage.outputTokens = result.usage.output_tokens;
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined)
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const metadata: ChatMessageMetadata = {
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    provider: "claude-cli",
    model,
  };
  if (result.durationMs !== null) metadata.durationMs = result.durationMs;
  if (result.totalCostUsd !== null) metadata.costUsd = result.totalCostUsd;
  return metadata;
}

// Usage chips: `finish` carries totalUsage + response.modelId — attach them as
// message metadata (v7 docs: the messageMetadata callback on toUIMessageStream).
// The metadata lands ON the finish chunk itself, not as a separate chunk (observed
// on the wire). response.modelId is provider-dependent — fall back to the requested
// model id (the CLI engine does the same).
export const metadataFrom =
  (providerId: string, requestedModel: string) =>
  ({
    part,
  }: {
    part: { type: string; totalUsage?: unknown; response?: { modelId?: unknown } };
  }) => {
    if (part.type !== "finish") return undefined;
    const usage = (part.totalUsage ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const model =
      typeof part.response?.modelId === "string" && part.response.modelId
        ? part.response.modelId
        : requestedModel;
    return {
      usage: {
        ...(num(usage.inputTokens) !== undefined ? { inputTokens: num(usage.inputTokens) } : {}),
        ...(num(usage.outputTokens) !== undefined ? { outputTokens: num(usage.outputTokens) } : {}),
        ...(num(usage.totalTokens) !== undefined ? { totalTokens: num(usage.totalTokens) } : {}),
      },
      model,
      provider: providerId,
    } satisfies ChatMessageMetadata;
  };
