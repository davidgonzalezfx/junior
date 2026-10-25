// Storage migrations (M5-2): the pure applyMigrations core (ordering, downgrade
// guard, session compaction) and the fakeBrowser runner (stamp, idempotency).
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import { STORAGE_VERSION, applyMigrations, runStorageMigrations } from "@/lib/storage-migrations";

// Nothing in WxtVitest resets fakeBrowser automatically — do it per test.
beforeEach(() => fakeBrowser.reset());

function sessionWithToolOutput(chars: number): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "here is the shot" },
      {
        type: "tool-screenshot",
        toolCallId: "t1",
        state: "output-available",
        input: {},
        output: "x".repeat(chars),
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("applyMigrations (pure)", () => {
  it("v0 → v1 compacts oversized tool outputs in junior_sessions", () => {
    const data = {
      junior_settings: { bridgeUrl: "http://127.0.0.1:8620" },
      junior_sessions: [
        { id: "s1", messages: [sessionWithToolOutput(30_000)] },
        { id: "s2", messages: [sessionWithToolOutput(10)] }, // small output stays
      ],
    };
    const { version, applied } = applyMigrations(0, data);
    expect(version).toBe(1);
    expect(applied).toHaveLength(1);

    const sessions = data["junior_sessions"] as Array<{ messages: UIMessage[] }>;
    // The stub REPLACES the output — the size note rides inside `output`.
    const output = (
      sessions[0]!.messages[0]!.parts[1] as {
        output: { juniorTrimmed: boolean; originalChars: number };
      }
    ).output;
    expect(output.juniorTrimmed).toBe(true);
    expect(output.originalChars).toBe(30_000);
    // Untouched: small output, text parts, sibling keys.
    const small = sessions[1]!.messages[0]!.parts[1] as { output: string };
    expect(small.output).toBe("x".repeat(10));
    expect((sessions[0]!.messages[0]!.parts[0] as { text: string }).text).toBe("here is the shot");
    expect(data["junior_settings"]).toEqual({ bridgeUrl: "http://127.0.0.1:8620" });
  });

  it("leaves non-session shapes and corrupt entries alone", () => {
    const data = {
      junior_sessions: ["junk", { noMessages: true }, null],
      other_key: { junior_sessions: [{ messages: [sessionWithToolOutput(30_000)] }] },
    };
    const { applied } = applyMigrations(0, data);
    expect(applied).toHaveLength(1);
    expect(data["junior_sessions"]).toEqual(["junk", { noMessages: true }, null]);
    // The nested (non-top-level) session is untouched — output stays the raw string.
    const nested = (data["other_key"] as { junior_sessions: Array<{ messages: UIMessage[] }> })
      .junior_sessions[0]!;
    expect((nested.messages[0]!.parts[1] as { output: string }).output).toBe("x".repeat(30_000));
  });

  it("is idempotent: re-applying v1 to already-migrated data changes nothing", () => {
    const data = { junior_sessions: [{ id: "s1", messages: [sessionWithToolOutput(30_000)] }] };
    const first = applyMigrations(0, data);
    const second = applyMigrations(first.version, first.data);
    expect(second.applied).toHaveLength(0);
    expect(second.data).toEqual(first.data);
  });

  it("never downgrades: a stored version newer than the code is left untouched", () => {
    const data = { junior_sessions: [{ id: "s1", messages: [sessionWithToolOutput(30_000)] }] };
    const { version, data: out, applied } = applyMigrations(STORAGE_VERSION + 3, data);
    expect(version).toBe(STORAGE_VERSION + 3);
    expect(applied).toHaveLength(0);
    expect(out["junior_sessions"]).toBe(data["junior_sessions"]);
  });

  it("counts a corrupt version stamp as 0 and re-runs (migrations are idempotent)", () => {
    const data = { junior_sessions: [{ id: "s1", messages: [sessionWithToolOutput(30_000)] }] };
    const { version, applied } = applyMigrations("bogus" as unknown as number, data);
    expect(version).toBe(STORAGE_VERSION);
    expect(applied).toHaveLength(1);
  });
});

describe("runStorageMigrations (storage)", () => {
  it("migrates, stamps the version, and writes nothing on a second run", async () => {
    await browser.storage.local.set({
      junior_sessions: [{ id: "s1", messages: [sessionWithToolOutput(30_000)] }],
      junior_bridge_token: "t".repeat(64),
    });

    const applied = await runStorageMigrations();
    expect(applied).toHaveLength(1);

    const stored = await browser.storage.local.get(null);
    expect(stored["junior_storage_version"]).toBe(STORAGE_VERSION);
    expect(stored["junior_bridge_token"]).toBe("t".repeat(64)); // sibling keys ride along
    const session = (stored["junior_sessions"] as unknown[])[0] as {
      messages: Array<{ parts: Array<{ output: { juniorTrimmed?: boolean } }> } | undefined>;
    };
    expect(session.messages[0]?.parts[1]?.output.juniorTrimmed).toBe(true);

    await expect(runStorageMigrations()).resolves.toEqual([]); // idempotent
  });
});
