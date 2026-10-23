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

  it("excludes claude-cli (engine api 501s until M4-4) and unavailable providers", () => {
    const target = resolveChatTarget(
      null,
      status([
        provider("claude-cli", "claude-cli"),
        provider("anthropic", "anthropic", false),
        provider("openrouter", "openai-compatible", true, []),
      ]),
    );
    expect(target).toEqual({ providerId: "openrouter", model: "" }); // no catalog → composer free-text
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
  it("falls back to well-known anthropic ids until M2-4 fetches the catalog", () => {
    expect(modelsFor(provider("anthropic", "anthropic"))).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
    ]);
  });
});
