# tests/

Cross-package e2e + fixtures (plan §2, §9). Unit tests live beside their sources.

- `fixtures/` — static pages the harness loads into jsdom: `page.html` (buttons,
  forms, secret fields per plan §9) and `bank.html` (the page the harness serves
  on a sensitive origin).
- `e2e/fake-tab.ts` — the harness "browser tab": jsdom per origin, globals stamped
  so the extension's self-contained in-page functions run against the active page.
- `e2e/harness.ts` — the M3-5 fake-model harness: boots the REAL bridge (source,
  ephemeral loopback port) and drives the REAL extension AgentLoop + executors
  with raw queue items — no LLM. Scripted card answers stand in for the panel
  (unanswered cards default to deny, so tests fail loudly).
- `e2e/harness-*.test.ts` — the scenarios. Run with `pnpm --filter @junior/tests-e2e
  test` (or the root `pnpm -r test`).
- `e2e/terminal-claude.smoke.test.ts` — the M4-2 terminal-Claude e2e: the REAL
  `claude` CLI, registered via `claude mcp add`, drives a guarded click on the
  bank fixture through an approval card. Spends real model tokens, so it is
  **gated**: `JUNIOR_E2E_TERMINAL_CLAUDE=1 pnpm --filter @junior/tests-e2e
  exec vitest run terminal-claude` (see docs/terminal-claude.md).
