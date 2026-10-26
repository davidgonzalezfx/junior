// @junior/bridge/chat/registry — provider id → AI SDK LanguageModel (plan §4.5 "Engine api").
// Keys come from ~/.junior/config.json (per-request load, same policy as the token) and are
// handed to the SDK constructors only — never logged, never echoed (§7-5). The fallback
// resolveModel resolves exactly one provider today.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { JuniorConfig } from "@junior/protocol";

/** The request named a provider the config doesn't serve (unconfigured anthropic,
 * unknown openai-compatible id) — a 400-class problem, not a 500. */
export class UnknownProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`provider "${providerId}" is not configured — add its key in Settings → Providers`);
    this.name = "UnknownProviderError";
  }
}

export function resolveModel(
  providerId: string,
  modelId: string,
  config: JuniorConfig,
  fetchImpl?: typeof fetch, // test seam: point the SDK at an in-process mock wire
): LanguageModel {
  if (providerId === "anthropic") {
    if (config.providers.anthropicKey === undefined) throw new UnknownProviderError(providerId);
    const baseURL = anthropicBaseURL();
    return createAnthropic({
      apiKey: config.providers.anthropicKey,
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }).languageModel(modelId);
  }
  const entry = config.providers.openaiCompatible.find((p) => p.id === providerId);
  if (entry === undefined) throw new UnknownProviderError(providerId);
  // This is the OpenRouter path (§4.5): any OpenAI-compatible /chat/completions endpoint.
  return createOpenAICompatible({
    name: entry.id,
    baseURL: entry.baseUrl,
    apiKey: entry.apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }).languageModel(modelId);
}

/** ANTHROPIC_BASE_URL passthrough (shared with POST /api/config/test): same env the CLI
 * and Claude Code honor, so gateway users get the bridge for free. The SDK's baseURL must
 * INCLUDE /v1 (default is https://api.anthropic.com/v1) while Claude
 * Code's env var is a bare host, so append /v1 unless it's already there. */
export function anthropicBaseURL(): string | undefined {
  const gateway = process.env.ANTHROPIC_BASE_URL;
  if (gateway === undefined || gateway === "") return undefined;
  return gateway.endsWith("/v1") ? gateway : `${gateway}/v1`;
}
