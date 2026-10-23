// M2-3 acceptance — POST /api/chat over the real Hono app (plan §8 M2: "chat with Claude
// (key + OpenRouter) from the panel"). Both provider wires are in-process mocks: an
// OpenAI-compatible SSE server (trimmed from the M0-4 spike mock) and an Anthropic SSE
// Response handed to the SDK through the registry's fetch seam.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JuniorConfigSchema } from "@junior/protocol";
import { createApp } from "../index.js";
import { saveConfig, writeToken } from "../config.js";

const TOKEN = "b".repeat(64);
let dirs: string[] = [];
let servers: Server[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  for (const s of servers) s.close();
  servers = [];
});

function newApp(config?: Record<string, unknown>, chatFetch?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "junior-chat-test-"));
  dirs.push(dir);
  saveConfig(JuniorConfigSchema.parse(config ?? {}), dir);
  writeToken(TOKEN, dir);
  const app = createApp({ dir, log: () => {}, chat: { fetch: chatFetch } });
  return { app };
}

const auth = { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` };

/** res.json() is unknown under this tsconfig — narrow to the bridge's error envelope. */
function wireError(json: unknown): string {
  return typeof (json as { error?: unknown }).error === "string"
    ? (json as { error: string }).error
    : "";
}
const uiMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };

/** Trimmed M0-4 spike mock: a real OpenAI-compatible /chat/completions SSE server on an
 * ephemeral port, so @ai-sdk/openai-compatible parses a genuine wire. Records bodies. */
async function startMockOpenAI(): Promise<{ baseUrl: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c as Uint8Array);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown path" }));
        return;
      }
      bodies.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      send({ role: "assistant", content: "" }, null);
      send({ content: "OPENROUTER_MOCK_OK" }, null);
      send({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}

/** Anthropic Messages-API SSE wire, served from a `fetch` function (no socket needed). */
function anthropicMockFetch(): typeof fetch {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_mock", role: "assistant", content: [], usage: { input_tokens: 9 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ANTHROPIC_MOCK_OK" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  const body =
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
}

async function postChat(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = auth,
) {
  return app.request("/api/chat", { method: "POST", headers, body: JSON.stringify(body) });
}

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

  it("501s the cli engine and agentMode until M4 wires them", async () => {
    const { app } = newApp();
    for (const body of [
      { engine: "cli", provider: "claude-cli", model: "claude-sonnet-5-5", messages: [uiMessage] },
      { agentMode: true, model: "claude-sonnet-5-5", messages: [uiMessage] },
    ]) {
      const res = await postChat(app, body);
      expect(res.status).toBe(501);
      expect(wireError(await res.json())).toMatch(/M4/);
    }
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
