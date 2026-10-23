/** @vitest-environment jsdom */
// M0-4 spike: the REAL provider leg — @ai-sdk/anthropic against the configured
// gateway (custom baseURL), streamed through useChat. Skips when no key is in
// the environment so the green gate stays hermetic.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleChat, type ChatHandlerEnv } from "./chat-handler.js";
import { startNodeServer, type SpikeServer } from "./node-server.js";
import { SpikeChat } from "./spike-chat.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const baseUrl = process.env.ANTHROPIC_BASE_URL;
// Strip Claude-Code-style context suffixes ("glm-5.3-flash[1m]" → "glm-5.3-flash");
// the gateway rejects model codes it doesn't know (verified M0-4).
const model = (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "claude-sonnet-5-5").replace(
  /\[.*\]$/,
  "",
);

let server: SpikeServer;

beforeAll(async () => {
  const env: ChatHandlerEnv = {
    anthropicApiKey: apiKey,
    anthropicBaseUrl: baseUrl ? `${baseUrl}/v1` : undefined,
    anthropicModel: model,
    openaiCompatibleBaseUrl: "http://127.0.0.1:9", // unused in this file
  };
  server = await startNodeServer((request) => handleChat(request, env));
});
afterAll(async () => {
  await server.close();
});
afterEach(cleanup);

describe.skipIf(!apiKey)("anthropic provider over real gateway", () => {
  it(`streams a real completion (${model}) into useChat parts`, { timeout: 90_000 }, async () => {
    const screen = render(<SpikeChat baseUrl={server.url} provider="anthropic" />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "Reply with exactly: JUNIOR_GATEWAY_OK" },
    });
    const form = screen.getByRole("button", { name: "send" }).closest("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);
    // The user's own prompt contains the token — assert on the assistant
    // message so the wait is real.
    await waitFor(
      () =>
        expect(
          screen
            .getAllByTestId("message-assistant")
            .map((node) => node.textContent)
            .join(""),
        ).toContain("JUNIOR_GATEWAY_OK"),
      { timeout: 80_000 },
    );
    expect(screen.getByTestId("status").textContent).toBe("ready");
    expect(screen.queryByTestId("error")).toBeNull();
  });
});
