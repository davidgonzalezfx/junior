/** @vitest-environment jsdom */
// M0-4 spike: useChat + DefaultChatTransport end-to-end against the real
// handler over HTTP — hermetic (mock OpenAI-compatible provider only).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleChat, type ChatHandlerEnv } from "./chat-handler.js";
import { startMockOpenAI, type MockOpenAIServer } from "./mock-openai.js";
import { startNodeServer, type SpikeServer } from "./node-server.js";
import { SpikeChat } from "./spike-chat.js";

let mock: MockOpenAIServer;
let server: SpikeServer;
let env: ChatHandlerEnv;

beforeAll(async () => {
  mock = await startMockOpenAI();
  env = { anthropicModel: "unused", openaiCompatibleBaseUrl: mock.url };
  server = await startNodeServer((request) => handleChat(request, env));
});
afterAll(async () => {
  await server.close();
  await mock.close();
});
afterEach(cleanup);

function typeAndSubmit(screen: ReturnType<typeof render>, text: string): void {
  fireEvent.change(screen.getByLabelText("message"), {
    target: { value: text },
  });
  const form = screen.getByRole("button", { name: "send" }).closest("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

describe("useChat → DefaultChatTransport → /api/chat → streamText (v7)", () => {
  it("streams a plain chat reply into message.parts", async () => {
    mock.requests.length = 0;
    const screen = render(<SpikeChat baseUrl={server.url} />);
    typeAndSubmit(screen, "reply with the token");
    await waitFor(
      () => expect(screen.getByTestId("messages").textContent).toContain("MOCK_OPENAI_OK"),
      { timeout: 10_000 },
    );
    expect(screen.getByTestId("status").textContent).toBe("ready");
    const first = mock.requests[0];
    expect(first?.body.stream).toBe(true);
    expect(first?.headers.authorization).toBe("Bearer spike-not-a-real-key");
  });

  it("runs the agentMode tool loop: tool part rendered + final text", async () => {
    mock.requests.length = 0;
    mock.mode = "tool";
    const screen = render(<SpikeChat baseUrl={server.url} agentMode={true} />);
    typeAndSubmit(screen, "use the tool, then tell me the token");
    await waitFor(
      () => expect(screen.getByTestId("messages").textContent).toContain("MOCK_TOOL_RESULT_OK"),
      { timeout: 10_000 },
    );
    expect(screen.getAllByTestId("tool-part").length).toBeGreaterThan(0);
    // The loop itself made the second provider call carrying the tool result.
    expect(mock.requests.length).toBe(2);
    expect((mock.requests[1]?.body.messages ?? []).some((m) => m.role === "tool")).toBe(true);
    mock.mode = "text";
  });
});
