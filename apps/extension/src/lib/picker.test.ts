// Pure ⌘K-picker + base-URL validation logic (plan §5.3, M2-4). Node env — no DOM.
import { describe, expect, it } from "vitest";
import type { BridgeStatus } from "@junior/protocol";
import {
  buildPickerGroups,
  decodePickerValue,
  encodePickerValue,
  validateBaseUrl,
} from "@/lib/picker";

const STATUS: BridgeStatus = {
  version: "0.0.0",
  apiLevel: 1,
  providers: [
    {
      id: "claude-cli",
      kind: "claude-cli",
      label: "Claude Code (CLI)",
      available: true,
      models: [],
    },
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      available: true,
      models: [{ id: "claude-sonnet-5-5", badges: ["vision", "reasoning"] }],
    },
    {
      id: "openrouter",
      kind: "openai-compatible",
      label: "OpenRouter",
      available: true,
      models: [
        { id: "vendor/model-x", badges: ["fast"] },
        { id: "vendor/model-y", badges: [] },
      ],
    },
    {
      id: "dead",
      kind: "openai-compatible",
      label: "Dead",
      available: false,
      models: [{ id: "m", badges: [] }],
    },
  ],
  browserConnected: true,
  queueDepth: 0,
};

describe("buildPickerGroups", () => {
  it("one group per provider with models; badges ride along; claude-cli and unavailable providers are omitted", () => {
    const groups = buildPickerGroups(STATUS, []);
    expect(groups.map((g) => g.id)).toEqual(["anthropic", "openrouter"]);
    const anthropic = groups[0]!;
    expect(anthropic.items).toHaveLength(1);
    expect(anthropic.items[0]).toMatchObject({
      providerId: "anthropic",
      model: "claude-sonnet-5-5",
      badges: ["vision", "reasoning"],
    });
    expect(groups[1]!.items.map((i) => i.model)).toEqual(["vendor/model-x", "vendor/model-y"]);
  });

  it("a leading Recent group lists only entries that exist and are available, deduped", () => {
    const recent = [
      { providerId: "openrouter", model: "vendor/model-x" },
      { providerId: "openrouter", model: "vendor/model-x" }, // duplicate
      { providerId: "dead", model: "m" }, // unavailable — filtered
      { providerId: "openrouter", model: "not-in-catalog" }, // unknown — filtered
    ];
    const groups = buildPickerGroups(STATUS, recent);
    expect(groups[0]!.id).toBe("recent");
    expect(groups[0]!.items).toEqual([
      expect.objectContaining({ providerId: "openrouter", model: "vendor/model-x" }),
    ]);
  });

  it("no recent entries → no Recent group", () => {
    expect(buildPickerGroups(STATUS, []).map((g) => g.id)).not.toContain("recent");
  });
});

describe("picker value encoding", () => {
  it("round-trips provider/model pairs whose ids contain / and :", () => {
    const value = encodePickerValue({
      providerId: "openrouter",
      model: "vendor/model-x:free",
      badges: [],
      keywords: [],
    });
    expect(decodePickerValue(value)).toMatchObject({
      providerId: "openrouter",
      model: "vendor/model-x:free",
    });
  });

  it("garbage values decode to null instead of throwing", () => {
    expect(decodePickerValue("not json")).toBeNull();
    expect(decodePickerValue('{"a":1}')).toBeNull();
    expect(decodePickerValue('["one-provider-id-only"]')).toBeNull();
  });
});

describe("validateBaseUrl (plan §5.3 parseBridgeUrl-style check)", () => {
  it("https anywhere is fine", () => {
    expect(validateBaseUrl("https://openrouter.ai/api/v1")).toMatchObject({ ok: true });
  });

  it("plain http is loopback-only", () => {
    expect(validateBaseUrl("http://127.0.0.1:8620/v1")).toMatchObject({ ok: true });
    expect(validateBaseUrl("http://localhost:8000/v1")).toMatchObject({ ok: true });
    expect(validateBaseUrl("http://api.example.com/v1")).toMatchObject({
      ok: false,
      error: expect.stringContaining("https"),
    });
  });

  it("garbage and non-http(s) schemes are refused", () => {
    expect(validateBaseUrl("not a url").ok).toBe(false);
    expect(validateBaseUrl("ftp://x/v1").ok).toBe(false);
    expect(validateBaseUrl("javascript:alert(1)").ok).toBe(false);
  });
});
