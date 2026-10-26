// M2-3 acceptance — POST /api/chat over the real Hono app (plan §8 M2: "chat with Claude
// (key + OpenRouter) from the panel"). Both provider wires are in-process mocks
// (@junior/testkit): an OpenAI-compatible SSE server (trimmed from the M0-4 spike mock)
// and an Anthropic SSE Response handed to the SDK through the registry's fetch seam.
// M5-10: broken-history healing. Fallback chain: routes-fallback.test.ts; agentMode:
// routes-agent.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { startMockOpenAI } from "@junior/testkit/openai-mock";
import {
  cleanupChatTests,
  newApp,
  postChat,
  wireError,
  uiMessage,
  anthropicMockFetch,
} from "./routes.test-support.js";

afterEach(cleanupChatTests);

describe("POST /api/chat (engine api)", () => {
  it("streams a UI message stream for an openai-compatible provider (OpenRouter path)", async () => {
    const { baseUrl } = await startMockOpenAI();
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"text-start"');
    expect(text).toContain("OPENROUTER_MOCK_OK");
    expect(text).toContain('"type":"finish"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("M5-1: attaches usage metadata on finish (message-metadata chunk with tokens/model/provider)", async () => {
    const { baseUrl } = await startMockOpenAI({
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      model: "mock-model-1",
    });
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The metadata rides ON the finish chunk (no separate message-metadata chunk —
    // observed on the wire; toUIMessageStream merges the callback result into finish).
    expect(text).toContain('"messageMetadata"');
    expect(text).toContain('"inputTokens":12');
    expect(text).toContain('"outputTokens":34');
    expect(text).toContain('"totalTokens":46');
    expect(text).toContain('"model":"anthropic/claude-sonnet-5.5"');
    expect(text).toContain('"provider":"openrouter"');
  });

  it("merges the Junior instructions with the panel's system bit on the provider wire", async () => {
    const { baseUrl, bodies } = await startMockOpenAI();
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
      system: "Be terse.",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(bodies).toHaveLength(1);
    const outbound = bodies[0] as { messages: Array<{ role: string; content: string }> };
    const system = outbound.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("You are Junior");
    expect(system?.content).toContain("Be terse.");
  });

  it("streams via the anthropic branch (config key)", async () => {
    const { app } = newApp({ providers: { anthropicKey: "sk-ant-test" } }, anthropicMockFetch());
    const res = await postChat(app, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ANTHROPIC_MOCK_OK");
    expect(text).toContain('"type":"finish"');
  });

  it("400s an unconfigured provider without touching the stream", async () => {
    const { app } = newApp(); // no keys at all
    const res = await postChat(app, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      messages: [uiMessage],
    });
    expect(res.status).toBe(400);
    expect(wireError(await res.json())).toMatch(/not configured/);
  });

  it("400s an unknown openai-compatible id", async () => {
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "other", label: "Other", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" },
        ],
      },
    });
    const res = await postChat(app, { provider: "openrouter", model: "m", messages: [uiMessage] });
    expect(res.status).toBe(400);
  });

  it("400s a body without messages (protocol schema)", async () => {
    const { app } = newApp({ providers: { anthropicKey: "sk-ant-test" } });
    const res = await postChat(app, { model: "claude-sonnet-5-5" });
    expect(res.status).toBe(400);
    expect(wireError(await res.json())).toMatch(/messages/);
  });

  it("400s garbage UIMessages (convertToModelMessages is the real validator)", async () => {
    const { app } = newApp({ providers: { anthropicKey: "sk-ant-test" } });
    const res = await postChat(app, {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      messages: [{ id: "m1", role: "bogus", parts: [{ type: "text", text: "x" }] }], // unsupported role
    });
    expect(res.status).toBe(400);
    expect(wireError(await res.json())).toMatch(/invalid messages/);
  });

  it("M5-10: a dangling tool call in replayed history is dropped before the provider sees it", async () => {
    // The M5-9 panel-close scenario persisted: assistant tool call, no result. The
    // provider used to reject the whole turn ("Tool result is missing …"); the route
    // must heal the history instead.
    const { baseUrl, bodies } = await startMockOpenAI({ text: "HEALED_OK" });
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "open example.com" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "Opening example.com" },
            {
              type: "tool-navigate",
              toolCallId: "call_broken",
              state: "input-available",
              input: { url: "https://example.com/" },
            },
          ],
        },
        { id: "u2", role: "user", parts: [{ type: "text", text: "did it work?" }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("HEALED_OK");
    // The provider wire carries no trace of the dangling call.
    const wire = JSON.stringify(bodies[0]);
    expect(wire).not.toContain("call_broken");
    expect(wire).not.toContain('"tool_calls"');
    // The resolved text parts still made it through (history isn't nuked).
    expect(wire).toContain("Opening example.com");
  });

  it("M5-10: a paired tool call + result in history survives sanitization (agent continue)", async () => {
    const { baseUrl, bodies } = await startMockOpenAI({ text: "CONTINUED_OK" });
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "open example.com" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-navigate",
              toolCallId: "call_paired",
              state: "output-available",
              input: { url: "https://example.com/" },
              output: '{"title":"Example"}',
            },
          ],
        },
        { id: "u2", role: "user", parts: [{ type: "text", text: "and now?" }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CONTINUED_OK");
    // The paired call converts to assistant tool_calls + a tool-role result message.
    const wire = JSON.stringify(bodies[0]);
    expect(wire).toContain("call_paired");
    expect(wire).toContain('"role":"tool"');
  });

  it("rejects a missing cliPath override before spawning (M4-4; the engine's own tests cover the happy paths)", async () => {
    const { app } = newApp({ cliPath: "/no/such/claude" });
    const res = await postChat(app, {
      engine: "cli",
      provider: "claude-cli",
      model: "claude-sonnet-5-5",
      messages: [uiMessage],
    });
    expect(res.status).toBe(503);
    expect(wireError(await res.json())).toMatch(/\/no\/such\/claude/);
  });

  it("sits behind the bearer gate like every other data route", async () => {
    const { app } = newApp({ providers: { anthropicKey: "sk-ant-test" } });
    const res = await postChat(
      app,
      { model: "m", messages: [uiMessage] },
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(401);
  });
});
