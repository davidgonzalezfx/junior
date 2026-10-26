// POST /api/chat fallback chain (M2-4, plan §4.5): pre-first-token failures retry
// the next chain entry; M5-10: the 502 body carries the providers' real error text.
import { afterEach, describe, expect, it } from "vitest";
import { startMockOpenAI } from "@junior/testkit/openai-mock";
import { cleanupChatTests, newApp, postChat, wireError, uiMessage } from "./routes.test-support.js";

afterEach(cleanupChatTests);

describe("POST /api/chat fallback chain (M2-4, plan §4.5)", () => {
  it("retries the next chain entry when the primary 401s before the first token", async () => {
    const down = await startMockOpenAI({ failStatus: 401 });
    const backup = await startMockOpenAI({ text: "BACKUP_MOCK_OK" });
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: down.baseUrl, apiKey: "sk-test" },
          { id: "backup", label: "Backup", baseUrl: backup.baseUrl, apiKey: "sk-test" },
        ],
        fallbackChain: ["openrouter", "backup"],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("BACKUP_MOCK_OK");
    expect(text).toContain('"type":"start"'); // winner replays a complete UI stream
    expect(text).toContain('"type":"finish"');
    expect(down.bodies).toHaveLength(1); // primary was really tried
    expect(backup.bodies).toHaveLength(1);
  });

  it("502s when every candidate fails before the first token", async () => {
    const a = await startMockOpenAI({ failStatus: 401 });
    const b = await startMockOpenAI({ failStatus: 500 });
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: a.baseUrl, apiKey: "sk-test" },
          { id: "backup", label: "Backup", baseUrl: b.baseUrl, apiKey: "sk-test" },
        ],
        fallbackChain: ["openrouter", "backup"],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(502);
    expect(wireError(await res.json())).toMatch(/all providers failed/);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(1);
  });

  it("M5-10: the 502 body carries the providers' real error text, not just the aggregate", async () => {
    // The live M5-10 repro: the panel saw only "provider returned no content" while
    // the bridge log held the actionable message. The wire error must name it.
    const down = await startMockOpenAI({ failStatus: 401 });
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: down.baseUrl, apiKey: "sk-test" },
        ],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(502);
    const message = wireError(await res.json());
    expect(message).toMatch(/all providers failed/);
    expect(message).toContain("openrouter:");
    expect(message).toContain("mock failure 401");
  });

  it("a stale chain entry (unconfigured id) is skipped, not fatal", async () => {
    const primary = await startMockOpenAI();
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: primary.baseUrl, apiKey: "sk-test" },
        ],
        fallbackChain: ["openrouter", "ghost"],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OPENROUTER_MOCK_OK");
  });

  it("no chain configured → single-provider behavior is unchanged", async () => {
    const down = await startMockOpenAI({ failStatus: 401 });
    const { app } = newApp({
      providers: {
        openaiCompatible: [
          { id: "openrouter", label: "OpenRouter", baseUrl: down.baseUrl, apiKey: "sk-test" },
        ],
      },
    });
    const res = await postChat(app, {
      provider: "openrouter",
      model: "vendor/model-name",
      messages: [uiMessage],
    });
    expect(res.status).toBe(502);
  });
});
