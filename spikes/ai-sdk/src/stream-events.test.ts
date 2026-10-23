// M0-4 spike: server-side evidence — what does toUIMessageStream actually put
// on the wire in v7? Feeds M2 part rendering and the M4 CLI part-mapping.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleChat, type ChatHandlerEnv } from "./chat-handler.js";
import { startMockOpenAI, type MockOpenAIServer } from "./mock-openai.js";

let mock: MockOpenAIServer;
let env: ChatHandlerEnv;

beforeAll(async () => {
  mock = await startMockOpenAI();
  env = { anthropicModel: "unused", openaiCompatibleBaseUrl: mock.url };
});
afterAll(async () => {
  await mock.close();
});

interface StreamPart {
  type: string;
  [key: string]: unknown;
}

async function readUIStream(request: Request): Promise<StreamPart[]> {
  const response = await handleChat(request, env);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no response body");
  const decoder = new TextDecoder();
  const parts: StreamPart[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const payload = event.slice("data: ".length);
      if (payload === "[DONE]") continue; // UI message stream terminator
      parts.push(JSON.parse(payload) as StreamPart);
    }
  }
  return parts;
}

function userRequest(body: Record<string, unknown>): Request {
  return new Request("http://spike/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("toUIMessageStream wire shape (AI SDK v7)", () => {
  it("plain chat: SSE frames, start/finish, text-delta carries the content", async () => {
    const parts = await readUIStream(
      userRequest({
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "reply with the token" }],
          },
        ],
      }),
    );
    const typeSequence = parts.map((p) => p.type).join(" → ");
    console.log("[spike] plain-chat part types:", typeSequence);
    expect(typeSequence).toContain("start");
    expect(typeSequence).toContain("finish");
    expect(
      parts.some((p) => p.type === "text-delta" && JSON.stringify(p).includes("MOCK_OPENAI_OK")),
    ).toBe(true);
  });

  it("agentMode: tool loop surfaces tool-* parts and a follow-up text answer", async () => {
    mock.mode = "tool";
    mock.requests.length = 0;
    const parts = await readUIStream(
      userRequest({
        agentMode: true,
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "use the tool, then tell me the token" }],
          },
        ],
      }),
    );
    const typeSequence = parts.map((p) => p.type).join(" → ");
    console.log("[spike] agentMode part types:", typeSequence);
    expect(parts.some((p) => p.type.startsWith("tool-"))).toBe(true);
    // After the tool result went back to the model, the second step answered.
    expect(
      parts.some(
        (p) => p.type === "text-delta" && JSON.stringify(p).includes("MOCK_TOOL_RESULT_OK"),
      ),
    ).toBe(true);
    expect(mock.requests.length).toBe(2);
    const second = mock.requests[1];
    expect((second?.body.messages ?? []).some((m) => m.role === "tool")).toBe(true);
    mock.mode = "text";
  });
});
