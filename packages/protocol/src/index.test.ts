import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  BridgeStatusSchema,
  BrowserActionSchema,
  ChatRequestBodySchema,
  ExtensionSettingsSchema,
  JuniorConfigSchema,
  PairingRequestSchema,
  PairingResultSchema,
  PairingStatusSchema,
  PROTOCOL_API_LEVEL,
  QueueItemSchema,
  ActionResultSchema,
} from "./index.js";

describe("@junior/protocol scaffold", () => {
  it("exports the API level stub", () => {
    expect(PROTOCOL_API_LEVEL).toBe(0);
  });
});

describe("BrowserActionSchema (plan §3)", () => {
  it("parses every kind", () => {
    for (const action of [
      { kind: "navigate", url: "https://example.com" },
      { kind: "click", target: "42" },
      { kind: "type", target: "#email", text: "hi@example.com" },
      { kind: "scroll", direction: "down" },
      { kind: "scroll", direction: "up", amount: 500 },
      { kind: "screenshot" },
      { kind: "get_active_tab" },
    ]) {
      expect(BrowserActionSchema.parse(action)).toMatchObject(action);
    }
  });

  it("applies read_page defaults (mode outline, maxChars 8000)", () => {
    expect(BrowserActionSchema.parse({ kind: "read_page" })).toEqual({
      kind: "read_page",
      mode: "outline",
      maxChars: 8000,
    });
  });

  it("rejects unknown kinds and constraint violations", () => {
    expect(() => BrowserActionSchema.parse({ kind: "hover", target: "x" })).toThrow();
    expect(() =>
      BrowserActionSchema.parse({ kind: "navigate", url: "https://a".repeat(1000) }),
    ).toThrow();
    expect(() => BrowserActionSchema.parse({ kind: "scroll", direction: "left" })).toThrow();
    expect(() =>
      BrowserActionSchema.parse({ kind: "read_page", mode: "text", maxChars: 100 }),
    ).toThrow();
  });

  it("narrows on the discriminator", () => {
    const action = BrowserActionSchema.parse({ kind: "click", target: "42" });
    if (action.kind === "click") expect(action.target).toBe("42");
    else throw new Error("discriminator did not narrow");
  });
});

describe("ApprovalRequestSchema + ApprovalDecisionSchema (plan §3)", () => {
  const request = {
    reasonCodes: ["sensitive_site", "form_submit"],
    reasons: ["github.com is on the sensitive-site list"],
    pageUrl: "https://github.com/settings",
    destinationUrl: "https://github.com/settings/delete",
    element: { tag: "button", type: "submit", text: "Delete repository" },
    siteDomain: "github.com",
  };

  it("parses a full request and JSON round-trips it", () => {
    const parsed = ApprovalRequestSchema.parse(request);
    expect(ApprovalRequestSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("allows typed: null (redacted secret field)", () => {
    expect(ApprovalRequestSchema.parse({ ...request, typed: null })).toMatchObject({ typed: null });
  });

  it("rejects unknown reason codes and >8 entries", () => {
    expect(() => ApprovalRequestSchema.parse({ ...request, reasonCodes: ["yolo"] })).toThrow();
    expect(() =>
      ApprovalRequestSchema.parse({
        ...request,
        reasonCodes: Array(9).fill("new_site"),
      }),
    ).toThrow();
  });

  it("parses once/site/deny and nothing else", () => {
    for (const decision of ["once", "site", "deny"] as const) {
      expect(ApprovalDecisionSchema.parse({ id: "abcdefgh", decision })).toMatchObject({
        decision,
      });
    }
    expect(() => ApprovalDecisionSchema.parse({ id: "abcdefgh", decision: "always" })).toThrow();
  });
});

describe("QueueItemSchema + ActionResultSchema (plan §3)", () => {
  it("wraps an action item and applies the 120 s timeout default", () => {
    const item = QueueItemSchema.parse({
      id: "9f1c0a2b-3e4d5c6b",
      kind: "action",
      action: { kind: "click", target: "17" },
      createdAt: 1_760_000_000_000,
    });
    expect(item.kind).toBe("action");
    expect(item.timeoutMs).toBe(120_000);
  });

  it("wraps an approval item on the same channel", () => {
    const item = QueueItemSchema.parse({
      id: "aaaaaaaaaaaaaaaa",
      kind: "approval",
      approval: {
        reasonCodes: ["new_site"],
        reasons: ["first visit to example.com"],
        pageUrl: "https://example.com",
      },
      createdAt: 1_760_000_000_000,
    });
    if (item.kind !== "approval") throw new Error("discriminator did not narrow");
    expect(item.approval.reasonCodes).toEqual(["new_site"]);
  });

  it("rejects kind/payload mismatches — an item without its payload never parses", () => {
    const createdAt = 1_760_000_000_000;
    const click = { kind: "click", target: "17" };
    expect(
      () => QueueItemSchema.parse({ id: "aaaaaaaa", kind: "action", createdAt }), // no action payload
    ).toThrow();
    expect(
      () => QueueItemSchema.parse({ id: "aaaaaaaa", kind: "approval", createdAt }), // no approval payload
    ).toThrow();
    expect(() =>
      QueueItemSchema.parse({ id: "aaaaaaaa", kind: "action", approval: click, createdAt }),
    ).toThrow(); // wrong payload for the kind
  });

  it("rejects unguessable-id violations and out-of-range timeouts", () => {
    const base = { kind: "action" as const, action: { kind: "click", target: "1" }, createdAt: 0 };
    expect(() => QueueItemSchema.parse({ ...base, id: "short" })).toThrow(); // <8 chars
    expect(() => QueueItemSchema.parse({ ...base, id: "has spaces!!!" })).toThrow();
    expect(() => QueueItemSchema.parse({ ...base, id: "aaaaaaaa", timeoutMs: 1000 })).toThrow(); // <5s
    expect(() => QueueItemSchema.parse({ ...base, id: "aaaaaaaa", timeoutMs: 301_000 })).toThrow(); // >5min
  });

  it("parses a denied result", () => {
    expect(ActionResultSchema.parse({ id: "aaaaaaaa", status: "denied" })).toMatchObject({
      status: "denied",
    });
    expect(() => ActionResultSchema.parse({ id: "aaaaaaaa", status: "maybe" })).toThrow();
  });
});

describe("ChatRequestBodySchema (plan §3)", () => {
  it("applies all defaults to a minimal body as the valid api+anthropic pair", () => {
    expect(ChatRequestBodySchema.parse({ model: "claude-sonnet-5-5", messages: [] })).toEqual({
      engine: "api",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      agentMode: false,
      cliTools: "browser",
      messages: [],
    });
  });

  it("keeps unknown engines/providers and mismatched engine/provider pairs out", () => {
    expect(() =>
      ChatRequestBodySchema.parse({ model: "m", messages: [], engine: "ssh" }),
    ).toThrow();
    expect(() =>
      ChatRequestBodySchema.parse({ model: "m", messages: [], cliTools: "none" }),
    ).toThrow();
    // The M1-2 review case: api engine can never drive the claude-cli provider…
    expect(() =>
      ChatRequestBodySchema.parse({
        model: "m",
        messages: [],
        engine: "api",
        provider: "claude-cli",
      }),
    ).toThrow(/claude-cli/);
    // …and engine cli implies provider claude-cli (the anthropic default is rejected).
    expect(() =>
      ChatRequestBodySchema.parse({ model: "m", messages: [], engine: "cli" }),
    ).toThrow();
    expect(
      ChatRequestBodySchema.parse({
        model: "m",
        messages: [],
        engine: "cli",
        provider: "claude-cli",
      }),
    ).toMatchObject({ engine: "cli", provider: "claude-cli", cliTools: "browser" });
  });
});

describe("BridgeStatusSchema (plan §3)", () => {
  const status = {
    version: "0.0.0",
    apiLevel: 0,
    providers: [
      {
        id: "claude-cli",
        kind: "claude-cli",
        label: "Claude CLI",
        available: true,
        detail: "claude version 2.x — logged in",
        models: [{ id: "claude-sonnet-5-5", badges: ["tools", "reasoning"] }],
      },
      { id: "openrouter", kind: "openai-compatible", label: "OpenRouter", available: false },
    ],
    browserConnected: true,
    queueDepth: 0,
  };

  it("parses a full status, defaulting badges and models", () => {
    const parsed = BridgeStatusSchema.parse(status);
    expect(parsed.providers[0]?.models[0]?.badges).toEqual(["tools", "reasoning"]);
    expect(parsed.providers[1]?.models).toEqual([]);
    expect(BridgeStatusSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown badges and non-int queueDepth", () => {
    const badBadge = {
      ...status,
      providers: [{ ...status.providers[0], models: [{ id: "m", badges: ["telepathy"] }] }],
    };
    expect(() => BridgeStatusSchema.parse(badBadge)).toThrow();
    expect(() => BridgeStatusSchema.parse({ ...status, queueDepth: 1.5 })).toThrow();
  });
});

describe("JuniorConfigSchema (plan §4.1)", () => {
  it("fills every default from an empty file", () => {
    expect(JuniorConfigSchema.parse({})).toEqual({
      port: 8620,
      permissionMode: "ask",
      providers: { openaiCompatible: [], fallbackChain: [] },
      codeExecution: "off",
      maxSteps: 30,
      allowCliNativeTools: false,
    });
  });

  it("parses a full config and JSON round-trips it", () => {
    const config = JuniorConfigSchema.parse({
      permissionMode: "auto",
      providers: {
        anthropicKey: "sk-ant-...",
        openaiCompatible: [
          {
            id: "openrouter",
            label: "OpenRouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-or-...",
            models: ["anthropic/claude-sonnet-5.5"],
          },
        ],
      },
      maxSteps: 100,
      allowCliNativeTools: true,
    });
    expect(JuniorConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it("rejects out-of-range port/maxSteps", () => {
    expect(() => JuniorConfigSchema.parse({ port: 0 })).toThrow();
    expect(() => JuniorConfigSchema.parse({ maxSteps: 101 })).toThrow();
  });
});

describe("ExtensionSettingsSchema (plan §5.2)", () => {
  it("fills every default from an empty store", () => {
    expect(ExtensionSettingsSchema.parse({})).toEqual({
      bridgeUrl: "http://127.0.0.1:8620",
      permissionMode: "ask",
      allowCliNativeTools: false,
    });
  });

  it("parses an overridden settings object and JSON round-trips it", () => {
    const settings = ExtensionSettingsSchema.parse({
      bridgeUrl: "http://127.0.0.1:9999",
      permissionMode: "auto",
      allowCliNativeTools: true,
    });
    expect(ExtensionSettingsSchema.parse(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it("rejects unknown permission modes", () => {
    expect(() => ExtensionSettingsSchema.parse({ permissionMode: "yolo" })).toThrow();
  });
});

describe("Pairing schemas (plan §3 HTTP table + §4.1)", () => {
  const token = "a".repeat(64); // 32 bytes hex

  it("parses the onboarding probe shape", () => {
    expect(PairingStatusSchema.parse({ tokenRequired: true, tokenSet: false })).toEqual({
      tokenRequired: true,
      tokenSet: false,
    });
  });

  it("requires the token to be 32 bytes hex in a pairing request", () => {
    expect(PairingRequestSchema.parse({ token })).toEqual({ token });
    expect(() => PairingRequestSchema.parse({ token: "abc" })).toThrow(); // too short
    expect(() => PairingRequestSchema.parse({ token: token.replace(/a/g, "g") })).toThrow(); // not hex
  });

  it("parses the idempotent result and JSON round-trips it", () => {
    const result = PairingResultSchema.parse({ ok: true, alreadyPaired: true });
    expect(PairingResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => PairingResultSchema.parse({ ok: false, alreadyPaired: false })).toThrow();
  });
});
