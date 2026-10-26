# Junior — QA checklist

> Plan §8 M5 accept: "checklist in `docs/qa.md` all green." §9 defines the manual items.
> Automated sections carry their test evidence; manual sections get ticked with a
> date + one-line outcome when run. Security pass (M5-3) green; perf pass (M5-4)
> green; the remaining boxes need a human at a real Chrome profile (evidence notes
> say what automation already covers).

## Security pass (M5-3, 2026-10-25) — ✅ green

Automated (`apps/bridge/src/security-pass.test.ts` · `packages/protocol/src/untrusted.test.ts` ·
`apps/extension/src/lib/executors/read-page.test.ts` fuzz block):

- [x] **Replay an action id** — same `action-result` twice → `delivered:true` then
      `delivered:false`; a stale id cannot resolve a *new* dispatch; approval decisions
      replay inert and cannot double-spend a card.
- [x] **Wrong-token sweep** — all 10 data routes (agent×4, status, chat, config GET/PUT,
      config/test, /mcp): no token → 401, wrong token → 403; prefix/extension token
      games fail (sha256-digest compare); pairing honors only its window.
- [x] **CORS from an https page must fail** — preflight → bare 204, zero
      access-control-* headers; a *valid* token + https origin gets 200 but zero ACAO
      (the call works, the page cannot read it); loopback/extension still echo.
- [x] **Oversized payloads** — global `bodyLimit` 8 MiB (decisions.md 2026-10-25):
      9 MB bodies → 413 JSON on action-result/chat//mcp, rejected before auth and
      before any handler parses; normal bodies pass.
- [x] **Unicode/delimiter fuzz on read_page output** — 3×500-iteration seeded fuzz over
      delimiter-token mutations/nonce reinsertion/bracket runs (protocol, fixed-point +
      invariant assertions); extension text-mode fuzz (no lone surrogates at the cap,
      whitespace collapsed); tool outputs delimiter-stripped §6.3-2 with screenshots
      exempt; `capToolText`/`capWithNote` surrogate-safe.

Live transcript (real `dist` bridge, 2026-10-25): health ok; sweep 401/403 across 5
sampled routes; https preflight 204 with only `vary: Origin`; valid-token + evil origin
→ 200, zero CORS headers; MCP `get_active_tab` → action id → result `delivered:true` →
byte-identical replay `delivered:false` (tool call answered once); 9 MB POST → 413
`{"error":"request body too large"}`; small POST → 200.

## M4 accept flows — ✅ automated legs green (M5-4, 2026-10-25); real-panel pass pending

- [x] **Panel chat turn (api engine) streams into the panel with usage chip** —
      2026-10-25, real Chrome pass: streamed reply + collapsed Reasoning (401 chars) +
      usage chip (`↓27 ↑99 tok · recursive/flint-v1.0:free`) via OpenRouter
      (provider-mvocrjra). Exposed + fixed M5-6 on the way (openai-compatible model
      catalogs were never persisted → empty picker; commit c661c15).
- [x] **Agent-mode turn drives navigate → read_page → click on `fixtures/page.html`**
      — harness e2e green (`tests/e2e/agent-mode.test.ts`, re-run 2026-10-25): real
      bridge + guard + AgentLoop + executors, scripted provider, zero cards in auto;
      guard-denial-rides-back-verbatim leg also green.
- [x] **Terminal Claude guarded click through a card** — gated smoke re-run green
      2026-10-25 (`JUNIOR_E2E_TERMINAL_CLAUDE=1`, 69 s): real CLI `claude mcp add` →
      ✔ Connected → sensitive_site card → "once" → click executes, model reports.
- [x] **CLI engine turn end-to-end** — gated smoke re-run green 2026-10-25
      (`JUNIOR_E2E_CLI_ENGINE=1`, 40 s): bridge spawns real CLI → mcp-config loopback →
      get_active_tab → read_page → guarded click, full part map on the SSE wire.

## Sensitive-site matrix rows (§9) — ✅ automated legs green (M3-5 harness, re-run 2026-10-25); real-Chrome pass pending

- [x] **Sensitive site navigate → card → once / site / deny** — 2026-10-25, real
      Chrome pass: once → nav + read execute (post-M5-7 permission dialog on first
      agent send); deny → `USER_DENIED` rides back verbatim, model reports "denied
      action is final, won't retry"; site grant → second same-host nav silent, no card.
      (Stripe.com live site.)
- [x] **Secret field refused in every mode (auto + ask)** — 2026-10-25, real Chrome
      pass: agent asked to type into github.com/login's password field → typing
      refused in both modes, "that action is refused in every mode, and it's final,"
      field left untouched. Site grants did not override.
- [x] **Panel-closed default-deny within the 120 s window** — 2026-10-26, real Chrome
      pass: panel open + unanswered card → 120 s auto-deny ✅; panel closed mid-card →
      immediate deny on port disconnect (M5-9 fix; the SW setTimeout died with the
      suspended worker pre-fix) → reopen shows Idle + the tool part rendered
      "navigate failed" (M5-10 fix), task unwound, no hang. A panel-close mid-turn
      also exposed the dangling-tool-call history bug (M5-10: bridge sanitizes replayed
      history; per-provider errors now surface in the panel).

## Crash / perf (§9) — ✅ green (M5-4, 2026-10-25)

- [x] **Bridge crash mid-task** — M4-5 automated tests (dispose denies futures,
      cards default-deny, overlay cleared, SW-crash recovery) + live pass 2026-10-25:
      real `dist` bridge, long-poll in flight, `kill -9` → client socket dropped
      (curl exit 52); graceful SIGTERM path was live-proven in M4-5 ("bridge
      shutting down").
- [x] **1k-message session scroll** — `chat-panel.perf.test.tsx` (React Profiler,
      jsdom): 1000 rendered messages mount ≈ 420 ms; an appended exchange on top of
      the 1k list costs ≈ 3 ms per commit with the memoized `MessageRow` (was ≈
      272 ms un-memoized — the O(n)-per-delta regression this test now pins).
      `virtua` formally dropped → decisions.md 2026-10-25.
- [x] **DOM dump audit: outline ≤ 4k chars typical** — `read-page.test.ts` M5-4
      audit block (real vendored buildDomTree, whole-page viewport): plan fixture
      page = **136 chars**; representative landing page (~90 interactive elements) =
      **1457 chars**; 1500-element stress page bounded by the maxChars cap
      (**8069** = 8000 + truncation note). Typical pages run 3× under budget.
- [x] **SW wake count audit: idle = 0 wakes beyond the health poll** — built
      `.output/chrome-mv3/background.js` grepped 2026-10-25: **zero** `alarms.*`,
      **zero** `setInterval`; listeners = onInstalled, onStartup, onConnect,
      runtime.onMessage (+ per-port onDisconnect — only exists once a panel port
      exists). Wake matrix: panel closed + idle → **0 wakes** (no
      alarms, no manifest content scripts, no tabs/webNavigation listeners); panel
      open → 1 wake (onConnect port, keeps SW alive by design); the 5 s health
      poll is a fetch from the panel document — it never routes through the SW;
      during a task the 15 s long-poll keeps the SW alive (plan §10). `alarms`
      permission retained as the documented §10 contingency, intentionally unused.
- [x] **Panel Stop mid-agent-turn → no further dispatcher activity** — M4-5 route
      tests green: aborting the turn's signal ends the api engine's tool loop
      (streamText `onAbort`) and SIGTERMs the spawned CLI; verified over
      `app.request`'s RequestInit.signal (the same object the server reads from
      the client-disconnected socket). Real-browser-disconnect socket leg noted in
      the M4-5 backlog seed as the only untested hop.
