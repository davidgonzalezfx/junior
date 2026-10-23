// M0-4 spike: minimal local OpenAI-compatible chat-completions mock.
// Gives @ai-sdk/openai-compatible a real SSE wire to parse — offline and
// deterministic — standing in for OpenRouter (plan §4.5 provider path).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockOpenAIRequest {
  headers: Record<string, string | string[] | undefined>;
  body: {
    model?: string;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    messages?: Array<{ role: string; content?: unknown }>;
  };
}

export interface MockOpenAIServer {
  url: string;
  requests: MockOpenAIRequest[];
  /** Script for the next turn that has no tool result yet: "text" | "tool". */
  mode: "text" | "tool";
  close: () => Promise<void>;
}

interface OutboundChunk {
  choices?: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: Record<string, number>;
}

export async function startMockOpenAI(): Promise<MockOpenAIServer> {
  const requests: MockOpenAIRequest[] = [];
  let mode: "text" | "tool" = "text";

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c as Uint8Array);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as MockOpenAIRequest["body"]) : {};

      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown path" }));
        return;
      }
      if (body.stream !== true) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "spike mock only supports stream:true" }));
        return;
      }

      requests.push({ headers: req.headers, body });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (chunk: OutboundChunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      const delta = (d: Record<string, unknown>, finish: string | null) => {
        send({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
      };

      const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
      if (hasToolResult) {
        // Turn 2 of the tool loop: model saw the tool result, answers in text.
        delta({ role: "assistant", content: "" }, null);
        delta({ content: "MOCK_TOOL_RESULT_OK" }, null);
        delta({}, "stop");
      } else if (mode === "tool") {
        delta(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_mock_1",
                type: "function",
                function: { name: "now", arguments: "" },
              },
            ],
          },
          null,
        );
        delta({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, null);
        delta({}, "tool_calls");
      } else {
        delta({ role: "assistant", content: "" }, null);
        delta({ content: "MOCK_OPENAI_OK" }, null);
        delta({}, "stop");
      }

      if (body.stream_options?.include_usage) {
        send({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get mode() {
      return mode;
    },
    set mode(value: "text" | "tool") {
      mode = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
