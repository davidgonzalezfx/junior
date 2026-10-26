// M2-3 acceptance — POST /api/chat over the real Hono app (plan §8 M2: "chat with Claude
// (key + OpenRouter) from the panel"). Both provider wires are in-process mocks: an
// OpenAI-compatible SSE server (trimmed from the M0-4 spike mock) and an Anthropic SSE
// Response handed to the SDK through the registry's fetch seam.
// M5-10: broken-history healing + per-provider error text in the 502 body.
// (~575 lines — over the ~400 budget: the two provider-wire mocks + the app helper are
// shared by every chat describe block; per-block copies would triple the mock code.)
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
 * ephemeral port, so @ai-sdk/openai-compatible parses a genuine wire. Records bodies.
 * `failStatus` makes /chat/completions answer with that status instead (the fallback
 * chain's pre-token provider failure). `toolCall` scripts the agent loop's first turn:
 * when the outbound messages carry no tool result yet, the mock emits a tool_calls
 * delta (M0-4 verified the wire shape); the follow-up turn gets plain text. */
async function startMockOpenAI(
  opts: {
    failStatus?: number;
    text?: string;
    toolCall?: { name: string; args: unknown };
    /** Final-chunk usage (OpenAI wire shape) — the M5-1 message-metadata assertions. */
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    /** model field on chunks → the SDK's response.modelId → metadata.model. */
    model?: string;
  } = {},
): Promise<{ baseUrl: string; bodies: unknown[] }> {
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
      if (opts.failStatus !== undefined) {
        res.writeHead(opts.failStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock failure ${opts.failStatus}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const hasToolResult = (
        bodies.at(-1) as { messages?: Array<{ role?: string }> }
      )?.messages?.some((m) => m.role === "tool");
      if (!hasToolResult && opts.toolCall !== undefined) {
        send(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_mock_1",
                type: "function",
                function: { name: opts.toolCall.name, arguments: "" },
              },
            ],
          },
          null,
        );
        send(
          {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(opts.toolCall.args) } }],
          },
          null,
        );
        send({}, "tool_calls");
      } else {
        const modelField = opts.model !== undefined ? { model: opts.model } : {};
        send({ role: "assistant", content: "", ...modelField }, null);
        send({ content: opts.text ?? "OPENROUTER_MOCK_OK" }, null);
        const stopPayload = {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
        };
        res.write(`data: ${JSON.stringify(stopPayload)}\n\n`);
      }
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
