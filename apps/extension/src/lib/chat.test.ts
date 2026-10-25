// resolveChatTarget / modelsFor (M2-3): pure selection logic ahead of the M2-4 ⌘K picker.
// createChatTransport's wire behavior (headers/body/messages merge) is covered by the
// ChatPanel jsdom test and the M0-4 spike e2e.
import { describe, expect, it } from "vitest";
import type { BridgeStatus } from "@junior/protocol";
import { modelsFor, resolveChatTarget } from "@/lib/chat";

const status = (providers: BridgeStatus["providers"]): BridgeStatus => ({
  version: "0.0.0",
  apiLevel: 1,
  providers,
  browserConnected: true,
  queueDepth: 0,
});

const provider = (
  id: string,
  kind: BridgeStatus["providers"][number]["kind"],
  available = true,
  models: string[] = [],
) => ({
  id,
  kind,
  label: id,
  available,
  models: models.map((m) => ({ id: m, badges: [] })),
});

describe("resolveChatTarget", () => {
  it("uses the stored default provider + model when the bridge still serves it", () => {
    const target = resolveChatTarget(
      { providerId: "openrouter", model: "vendor/model-x" },
      status([
        provider("anthropic", "anthropic"),
        provider("openrouter", "openai-compatible", true, ["vendor/model-x", "vendor/model-y"]),
      ]),
    );
    expect(target).toEqual({ providerId: "openrouter", model: "vendor/model-x" });
  });

  it("keeps the default provider but upgrades a null stored model from the catalog", () => {
    const target = resolveChatTarget(
      { providerId: "openrouter", model: null },
      status([provider("openrouter", "openai-compatible", true, ["vendor/model-x"])]),
    );
    expect(target).toEqual({ providerId: "openrouter", model: "vendor/model-x" });
  });

  it("falls back to the first available provider when the stored one is gone", () => {
    const target = resolveChatTarget(
      { providerId: "deleted", model: "m" },
      status([provider("anthropic", "anthropic")]),
    );
    expect(target).toEqual({ providerId: "anthropic", model: "claude-sonnet-5-5" }); // anthropic fallback head
  });

  it("skips a catalog-less provider (no resolvable model) and falls through to one that has models", () => {
    const target = resolveChatTarget(
      null,
      status([
        provider("claude-cli", "claude-cli"),
        provider("anthropic", "anthropic", false),
        provider("catalogless", "openai-compatible", true, []),
        provider("openrouter", "openai-compatible", true, ["vendor/model-x"]),
      ]),
    );
    expect(target).toEqual({ providerId: "openrouter", model: "vendor/model-x" });
  });

  it('returns null when the only available providers have no resolvable model — never sends model:""', () => {
    const target = resolveChatTarget(
      null,
      status([
        provider("claude-cli", "claude-cli"),
        provider("anthropic", "anthropic", false),
        provider("openrouter", "openai-compatible", true, []), // no persisted catalog yet
      ]),
    );
    expect(target).toBeNull();
  });

  it("a catalog-less default provider still resolves once its Test-persisted catalog arrives", () => {
    const target = resolveChatTarget(
      { providerId: "openrouter", model: null },
      status([provider("openrouter", "openai-compatible", true, ["vendor/model-x"])]),
    );
    expect(target).toEqual({ providerId: "openrouter", model: "vendor/model-x" });
  });

  it("excludes claude-cli and unavailable providers from resolution entirely", () => {
    expect(
      resolveChatTarget(
        null,
        status([provider("claude-cli", "claude-cli"), provider("anthropic", "anthropic", false)]),
      ),
    ).toBeNull();
  });

  it("returns null when nothing is chat-capable — the UI shows the setup hint", () => {
    expect(resolveChatTarget(null, status([provider("claude-cli", "claude-cli")]))).toBeNull();
    expect(resolveChatTarget(null, status([]))).toBeNull();
  });
});

describe("modelsFor", () => {
  it("passes a fetched catalog through", () => {
    expect(modelsFor(provider("p", "openai-compatible", true, ["a", "b"]))).toEqual(["a", "b"]);
  });
  it("falls back to well-known anthropic ids; openai-compatible without a catalog yields none", () => {
    expect(modelsFor(provider("anthropic", "anthropic"))).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
    expect(modelsFor(provider("openrouter", "openai-compatible"))).toEqual([]);
  });
});
