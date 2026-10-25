# Junior — QA checklist

> Plan §8 M5 accept: "checklist in `docs/qa.md` all green." §9 defines the manual items.
> Automated sections carry their test evidence; manual sections get ticked with a
> date + one-line outcome when run. Security pass (M5-3) is green; perf (M5-4) owns the rest.

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

## M4 accept flows (manual, §9) — ⬜ M5-4 / end-of-M5

- [ ] Panel chat turn (api engine) streams into the panel with usage chip.
- [ ] Agent-mode panel turn drives navigate → read_page → click on `fixtures/page.html`.
- [ ] Terminal Claude (gated smoke `JUNIOR_E2E_TERMINAL_CLAUDE=1`) guarded click through a card.
- [ ] CLI engine turn (gated smoke `JUNIOR_E2E_CLI_ENGINE=1`) end-to-end.

## Sensitive-site matrix rows (manual, §9) — ⬜ M5-4 / end-of-M5

- [ ] Sensitive site navigate → card → once / site / deny outcomes (automated in the M3-5
      harness; manual pass = the same flows against a real Chrome profile).
- [ ] Secret field refused in every mode (auto + ask).
- [ ] Panel-closed default-deny within the 120 s window.

## Crash / perf (manual, §9) — ⬜ M5-4

- [ ] Bridge crash mid-task → overlay clears, futures denied (automated in M4-5; manual
      pass = kill the real bridge process mid-turn).
- [ ] 1k-message session scroll (panel stays responsive).
- [ ] DOM dump audit: outline ≤ 4k chars typical.
- [ ] SW wake count audit: idle = 0 wakes beyond the health poll.
- [ ] Panel Stop mid-agent-turn → no further dispatcher activity (backlog seed, M4-5).
