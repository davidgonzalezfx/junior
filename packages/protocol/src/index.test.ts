import { describe, expect, it } from "vitest";
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  BridgeStatusSchema,
  BrowserActionSchema,
  ChatRequestBodySchema,
  JuniorConfigSchema,
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
    expect(item.approval?.reasonCodes).toEqual(["new_site"]);
  });

  it("rejects unguessable-id violations and out-of-range timeouts", () => {
    const base = { kind: "action" as const, createdAt: 0 };
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
  it("applies all defaults to a minimal body", () => {
    expect(ChatRequestBodySchema.parse({ model: "claude-sonnet-5-5" })).toEqual({
      engine: "api",
      provider: "claude-cli",
      model: "claude-sonnet-5-5",
      agentMode: false,
      cliTools: "browser",
    });
  });

  it("keeps unknown engines/providers out", () => {
    expect(() => ChatRequestBodySchema.parse({ model: "m", engine: "ssh" })).toThrow();
    expect(() => ChatRequestBodySchema.parse({ model: "m", cliTools: "none" })).toThrow();
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
      providers: { openaiCompatible: [] },
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
