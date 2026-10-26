// M5-4 performance pass — 1k-message session scroll (plan §8 M5-4, qa.md). The
// panel renders the WHOLE session (no virtualization, decisions: history stayed
// plain in M2-5), so the contract that keeps it responsive is MessageRow's
// memoization: a streaming delta replaces only the last message object, and
// untouched rows must skip their react-markdown re-parse. This file mounts a
// 1k-message session, measures the mount commit and every commit of an appended
// exchange via the React Profiler, and holds both under budget. Numbers are
// jsdom-relative (no layout), so budgets are generous and calibrated with
// headroom — they catch O(n)-per-delta regressions, not absolute browser speed.
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { UIMessage } from "ai";
import { ChatPanel } from "@/components/chat-panel";
import { emptySession, type StoredSession } from "@/lib/history";
import { uiTextTurn } from "@junior/testkit/wire";
import { installPanelJsdom, panelFetch } from "./chat-panel.test-support";

installPanelJsdom();

beforeEach(() => fakeBrowser.reset());

const STATUS = {
  version: "0.0.0",
  apiLevel: 1,
  providers: [
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      available: true,
      models: [{ id: "claude-sonnet-5-5", badges: ["reasoning"] }],
    },
  ],
  browserConnected: true,
  queueDepth: 0,
};

const UI_STREAM = uiTextTurn(["Reply **with** markdown."]);

function stubFetch() {
  return panelFetch(
    () => new Response(UI_STREAM, { headers: { "content-type": "text/event-stream" } }),
    STATUS,
  );
}

/** A representative transcript: alternating user/assistant rows with markdown
 * bodies of realistic chat length (~200 chars, bold + list + link). */
function bigSession(messages: number): StoredSession {
  const session = emptySession();
  session.title = "1k-message perf session";
  const list: UIMessage[] = [];
  for (let i = 0; i < messages; i += 2) {
    list.push({
      id: `u${i}`,
      role: "user",
      parts: [{ type: "text", text: `Question number ${i}` }],
    });
    list.push({
      id: `a${i}`,
      role: "assistant",
      parts: [
        {
          type: "text",
          text:
            `Answer ${i}: here is **formatted** prose with [a link](https://example.com/x), ` +
            `a short list:\n\n- item one\n- item two\n\nand a closing sentence for length.`,
        },
      ],
    });
  }
  session.messages = list;
  return session;
}

interface Commit {
  phase: string;
  actualDuration: number;
}

describe("ChatPanel perf — 1k-message session (M5-4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts 1000 messages and appends an exchange with memoized rows under budget", async () => {
    await browser.storage.local.set({
      junior_bridge_token: "t".repeat(64),
      junior_default_provider: { providerId: "anthropic", model: "claude-sonnet-5-5" },
    });
    vi.stubGlobal("fetch", stubFetch());

    const commits: Commit[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      commits.push({ phase, actualDuration });
    };

    render(
      <Profiler id="chat" onRender={onRender}>
        <ChatPanel session={bigSession(1000)} onRecord={vi.fn()} />
      </Profiler>,
    );

    // Mount of the 1000-message transcript (setup resolves → Chat mounts seeded).
    const textarea = await screen.findByLabelText("message");
    expect(screen.getByText("Question number 998")).toBeTruthy();
    const mountMs = Math.max(...commits.map((c) => c.actualDuration));

    // Append an exchange (the streaming-shaped update: new user + assistant rows
    // on top of a 1000-message list; memoized rows make this O(new), not O(n)).
    commits.length = 0;
    fireEvent.change(textarea, { target: { value: "one more" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      // "with" is unique — the seeded rows all bold "formatted".
      expect(screen.getAllByRole("strong").some((el) => el.textContent === "with")).toBe(true);
    });
    const updateMaxMs = Math.max(...commits.map((c) => c.actualDuration));

    // Budgets: calibrated against the memoized implementation with headroom.
    // A non-memoized row list blows the update budget by ~2 orders of magnitude
    // (every delta re-parses 1000 markdown bodies). Recorded in docs/qa.md.
    expect(mountMs).toBeLessThan(20_000);
    expect(updateMaxMs).toBeLessThan(1_000);
    console.log(
      `perf: mount(1000 msgs)=${mountMs.toFixed(1)}ms, append-exchange max commit=${updateMaxMs.toFixed(1)}ms`,
    );

    // The scroll container still exists beside the composer (auto-scroll runs per
    // messages change — property assignment, not scrollTo(); jsdom has no layout,
    // so the observable contract here is presence + no throw at 1k rows).
    expect(document.querySelector("div.overflow-y-auto")).not.toBeNull();
  });
});
