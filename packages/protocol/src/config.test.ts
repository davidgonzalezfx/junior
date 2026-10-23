import { describe, expect, it } from "vitest";

import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  ExtensionSettingsSchema,
  JuniorConfigSchema,
  ProvidersPatchSchema,
  ProvidersViewSchema,
  ProviderTestRequestSchema,
  ProviderTestResultSchema,
} from "./config.js";

describe("pinned extension identity (M2-1, docs/decisions.md 2026-10-23)", () => {
  it("EXTENSION_ORIGIN has the chrome-extension://[a-p]{32} shape Chrome generates", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });
});

describe("ExtensionSettingsSchema (plan §5.2 item 1)", () => {
  it("defaults bridgeUrl/permissionMode/allowCliNativeTools", () => {
    expect(ExtensionSettingsSchema.parse({})).toEqual({
      bridgeUrl: "http://127.0.0.1:8620",
      permissionMode: "ask",
      allowCliNativeTools: false,
    });
  });
});

describe("providers config + Settings→Providers wire shapes (M2-4)", () => {
  it("fallbackChain defaults to empty on existing configs (M1-era files still parse)", () => {
    const config = JuniorConfigSchema.parse({
      providers: { anthropicKey: "sk-old", openaiCompatible: [] },
    });
    expect(config.providers.fallbackChain).toEqual([]);
  });

  it("ProvidersViewSchema never carries a raw key — masked string or null only", () => {
    const view = ProvidersViewSchema.parse({
      anthropicKeyMasked: "sk-…abcd",
      openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", hasApiKey: true }],
      fallbackChain: ["anthropic", "openrouter"],
    });
    expect(view.openaiCompatible[0]).not.toHaveProperty("apiKey");
    expect(() =>
      ProvidersViewSchema.parse({
        anthropicKeyMasked: null,
        // a raw apiKey field would mean the GET leaks keys — reject via strictness:
        openaiCompatible: [{ id: "x", label: "x", baseUrl: "https://x/v1", hasApiKey: false, apiKey: "sk-leak" }],
        fallbackChain: [],
      }),
    ).toThrow();
  });

  it("ProvidersPatchSchema: apiKeys optional (keep-existing), full entries also parse", () => {
    const patch = ProvidersPatchSchema.parse({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
          { id: "glm", label: "GLM", baseUrl: "https://x/v1", apiKey: "sk-new" },
        ],
        fallbackChain: ["anthropic", "openrouter"],
      },
    });
    expect(patch.providers.openaiCompatible[0]?.apiKey).toBeUndefined();
    expect(patch.providers.openaiCompatible[1]?.apiKey).toBe("sk-new");
    expect(patch.providers.anthropicKey).toBeUndefined();
  });

  it("ProviderTestResult is a discriminated ok/models | ok/error union", () => {
    expect(ProviderTestResultSchema.parse({ ok: true, models: ["m1"] })).toEqual({ ok: true, models: ["m1"] });
    expect(ProviderTestResultSchema.safeParse({ ok: false, error: "401 unauthorized" }).success).toBe(true);
    expect(ProviderTestResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(ProviderTestRequestSchema.safeParse({ providerId: "" }).success).toBe(false);
  });
});
