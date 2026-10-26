// chat/metadata — the CLI result event → ChatMessageMetadata mapping (usage chips, plan §5.3).
// The api-engine mapper (metadataFrom) is covered on the wire by routes.test.ts.
import { describe, expect, it } from "vitest";
import { cliResultToMetadata } from "./metadata.js";

describe("cliResultToMetadata (M5-1 usage chips)", () => {
  it("maps the result event's snake_case usage to the shared metadata shape", () => {
    const metadata = cliResultToMetadata(
      {
        subtype: "success",
        isError: false,
        text: "done",
        numTurns: 1,
        durationMs: 1234,
        totalCostUsd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      },
      "glm-5.3-flash",
    );
    expect(metadata).toEqual({
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      provider: "claude-cli",
      model: "glm-5.3-flash",
      durationMs: 1234,
      costUsd: 0.0123,
    });
    // No usage block at all → no usage key (the chip renders provider/model only).
    const bare = cliResultToMetadata(
      {
        subtype: "success",
        isError: false,
        text: "done",
        numTurns: null,
        durationMs: null,
        totalCostUsd: null,
        usage: null,
      },
      "m",
    );
    expect(bare).toEqual({ provider: "claude-cli", model: "m" });
  });
});
