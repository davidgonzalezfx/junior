// tests/e2e/cli-engine.smoke.test.ts — M4-4 live leg (plan §8 M4-4, M4 acceptance (c)):
// the bridge's OWN cli engine spawns the real `claude` CLI with the generated
// mcp-config loopback — the CLI's browser tool calls come back through /mcp and
// traverse the same dispatcher → guard → AgentLoop → executors stack, on the bank
// fixture. The engine's stream→UI-parts mapping is asserted on the actual SSE wire.
//
// Gated behind JUNIOR_E2E_CLI_ENGINE=1 (spawns the real CLI, spends real tokens —
// same pattern as the M4-2 smoke; the default `pnpm -r test` gate stays hermetic).
// Model comes from JUNIOR_E2E_CLI_MODEL (default: the glm gateway's flash model,
// reachable via ANTHROPIC_BASE_URL on this box; the CLI passes unknown ids through).
//   JUNIOR_E2E_CLI_ENGINE=1 pnpm --filter @junior/tests-e2e exec vitest run cli-engine
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startHarness, type FakePage } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNIN_URL = "https://www.chase.com/sign-in";
const BANNER_AFTER = "Signed in attempt recorded";
const MODEL = process.env.JUNIOR_E2E_CLI_MODEL ?? "glm-5.3-flash";
const RUN = process.env.JUNIOR_E2E_CLI_ENGINE === "1";

function bankPage(): FakePage {
  return {
    title: "First Meridian Bank — Sign in",
    html: readFileSync(join(HERE, "../fixtures/bank.html"), "utf8"),
    onShow: (doc) => {
      doc.getElementById("signin-btn")?.addEventListener("click", () => {
        doc.getElementById("banner")!.textContent = BANNER_AFTER;
      });
    },
  };
}

describe.skipIf(!RUN)("cli-engine e2e (M4-4)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it(
    "engine=cli spawns claude → mcp-config loopback → guarded click executes → parts stream back",
    { timeout: 300_000 },
    async () => {
      const h = await startHarness({ tabUrl: SIGNIN_URL, pages: { [SIGNIN_URL]: bankPage() } });
      try {
        await h.waitConnected();

        // The CLI engine runs in ask mode here: the click raises the SAME approval
        // card any client would get — pre-script "once" answers for it (unscripted
        // cards deny; M4-2 proved the card flow over `claude mcp add`, this proves
        // it through the engine's own spawn).
        h.answerNext("once");
        h.answerNext("once");

        const res = await fetch(`${h.bridgeUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${h.token}` },
          body: JSON.stringify({
            engine: "cli",
            provider: "claude-cli",
            model: MODEL,
            id: "m4-4-live",
            messages: [
              {
                id: "m1",
                role: "user",
                parts: [
                  {
                    type: "text",
                    text:
                      "Use only the junior_browser tools: call get_active_tab, then " +
                      'read_page with mode "outline", then click the sign-in button. ' +
                      "Finally report the exact text shown in the page's status banner.",
                  },
                ],
              },
            ],
          }),
        });
        expect(res.status).toBe(200);
        const sse = await res.text();
        if (process.env.JUNIOR_E2E_DEBUG_SSE) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync("/tmp/m44-sse.txt", sse);
        }

        // The engine's mapping on the real wire: lifecycle + streamed text + tool
        // parts (the CLI reports MCP tools under their full mcp__server__name id).
        expect(sse).toContain('"type":"start"');
        expect(sse).toContain('"type":"text-delta"');
        expect(sse).toContain('"toolName":"mcp__junior_browser__get_active_tab"');
        expect(sse).toContain('"toolName":"mcp__junior_browser__read_page"');
        expect(sse).toContain('"toolName":"mcp__junior_browser__click"');
        expect(sse).toContain('"type":"tool-output-available"');
        expect(sse).toContain('"type":"finish"');

        // The click really executed on the fixture page (not a canned reply).
        expect(h.tab.document.getElementById("banner")?.textContent).toBe(BANNER_AFTER);
        // Auto mode, nothing sensitive: the whole turn ran with zero approval cards.
        expect(h.wireCards).toHaveLength(0);
      } finally {
        await h.stop();
      }
    },
  );
});
