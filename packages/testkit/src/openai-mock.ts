// OpenAI-compatible /chat/completions SSE mock (workplan C2) — the parameterized
// descendant of the M0-4 spike mock (spikes/ai-sdk/src/mock-openai.ts keeps its
// own scripted variant; it records requests and serves fixed answers, this one is
// option-driven for route tests). Serves a genuine SSE wire on an ephemeral port
// so @ai-sdk/openai-compatible parses real bytes. Servers register in a module
// list — call closeOpenMockServers() in afterEach.
import { createServer, type Server } from "node:http";

export interface MockOpenAIOpts {
  /** Makes /chat/completions answer with that status instead (the fallback
   * chain's pre-token provider failure). */
  failStatus?: number;
  text?: string;
  /** Scripts the agent loop's first turn: when the outbound messages carry no
   * tool result yet, the mock emits a tool_calls delta (M0-4 verified the wire
   * shape); the follow-up turn gets plain text. */
  toolCall?: { name: string; args: unknown };
  /** Final-chunk usage (OpenAI wire shape) — the M5-1 message-metadata assertions. */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** model field on chunks → the SDK's response.modelId → metadata.model. */
  model?: string;
}

const openServers: Server[] = [];

/** afterEach helper: close every server startMockOpenAI opened. */
export function closeOpenMockServers(): void {
  for (const s of openServers) s.close();
  openServers.length = 0;
}

export async function startMockOpenAI(
  opts: MockOpenAIOpts = {},
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
  openServers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
}
