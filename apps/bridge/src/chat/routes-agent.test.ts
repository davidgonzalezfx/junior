// POST /api/chat agentMode (M4-3, plan §4.5): the streamText tool loop over the real
// dispatcher + guard, bounded by config.maxSteps; plain chat never sends tools.
import { afterEach, describe, expect, it } from "vitest";
import { startMockOpenAI } from "@junior/testkit/openai-mock";
import { cleanupChatTests, newApp, postChat, uiMessage } from "./routes.test-support.js";

afterEach(cleanupChatTests);

describe("POST /api/chat agentMode (M4-3, plan §4.5)", () => {
  it("runs the tool loop: tool call → dispatcher (guard denial feeds back) → final text", async () => {
    // No extension is connected here, so the navigate tool's dispatch hits the
    // dispatcher guard (ask mode) → immediate no-panel deny — exactly the string
    // that must reach the model so it stops retrying (§4.4).
    const { baseUrl, bodies } = await startMockOpenAI({
      toolCall: { name: "navigate", args: { url: "https://example.com/" } },
      text: "AGENT_MOCK_DONE",
    });
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      agentMode: true,
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"tool-input-available"');
    expect(text).toContain('"tool-output-available"');
    expect(text).toContain("AGENT_MOCK_DONE");
    // Two model calls: the second carries the tool result with the verbatim guard string.
    expect(bodies).toHaveLength(2);
    const second = bodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("no panel connected to approve");
  });

  it("config.maxSteps bounds the loop (isStepCount) — maxSteps:1 stops after one step", async () => {
    const { baseUrl, bodies } = await startMockOpenAI({
      toolCall: { name: "navigate", args: { url: "https://example.com/" } },
    });
    const { app } = newApp({
      maxSteps: 1,
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      agentMode: true,
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"tool-output-available"'); // the one step's tool ran
    expect(text).not.toContain("OPENROUTER_MOCK_OK"); // no second model call happened
    expect(bodies).toHaveLength(1);
  });

  it("plain chat never sends tools on the provider wire", async () => {
    const { baseUrl, bodies } = await startMockOpenAI();
    const { app } = newApp({
      providers: {
        openaiCompatible: [{ id: "openrouter", label: "OpenRouter", baseUrl, apiKey: "sk-test" }],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    await res.text();
    const outbound = bodies[0] as { tools?: unknown };
    expect(outbound.tools).toBeUndefined();
  });
});
