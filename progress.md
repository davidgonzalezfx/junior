# Junior — Progress & Learnings

> Live state. Every session starts by reading this file and ends by updating it (protocol in `CLAUDE.md`).
> Plan of record: `plan.md` · Decision log: `docs/decisions.md` (created on first entry)

**Updated:** 2026-10-23
**Current milestone:** M0 — Scaffold + spike
**Current task:** none claimed (M0-3 done; **next up: M0-4** AI SDK v5 spike)
**Current blockers:** none

---

## Milestone tracker

| Milestone | State | Notes |
|---|---|---|
| M0 Scaffold + spike (protocol schemas, CLI flags spike, AI SDK spike) | 🔶 in progress (3/4) | M0-3 verified the full §4.5 flag matrix vs CLI 2.1.309 — 3 forks in docs/decisions.md, plan §4.5 args rewritten |
| M1 Bridge core (Hono, auth, dispatcher, guard, status) | ⬜ blocked by M0 | |
| M2 Extension shell + chat (WXT, useChat, ⌘K picker, settings, history) | ⬜ blocked by M1 | parallelizable with M3 |
| M3 Browser tool layer (executors, read_page, approvals, overlay) | ⬜ blocked by M1 | parallelizable with M2 |
| M4 MCP server + agent paths (streamable HTTP, stdio proxy, CLI engine) | ⬜ blocked by M1+M3 | terminal-Claude e2e is the headline demo |
| M5 Polish + hardening | ⬜ blocked by M4 | security + perf passes per plan §8 |
| M6 Buffer / backlog seeds | ⬜ | |

## M0 checklist

- [x] M0-1 pnpm monorepo scaffold (workspaces, strict tsconfig, eslint/prettier, node 22) — gates green: `pnpm -r typecheck/test/build` + lint + format; commit de84cf1
- [x] M0-2 `packages/protocol` — all plan §3 schemas + round-trip tests — zod@4.6.5 pinned; actions/queue/approval/chat/status + `config.ts` (§4.1); 20 tests green: `pnpm -r typecheck/test/build` + lint + format OK; 2 forks recorded in `docs/decisions.md`; commit 3cd22f4
- [x] M0-3 ★ CLI spike: run plan §4.5 flag matrix against installed `claude`; record results in Learnings — `spikes/cli/flags.sh` 10/10 PASS vs Claude Code 2.1.309; 3 forks → docs/decisions.md (args updated in plan §4.5); evidence extracts in spikes/cli/evidence/; commit c56ef25
- [ ] M0-4 ★ AI SDK v5 spike: `streamText` (anthropic + openai-compatible) → `toUIMessageStream` → `useChat`

## M1 checklist

- [ ] M1-1 Hono app + config/token/pairing + auth middleware + CORS allowlist (plan §4.1–4.2)
- [ ] M1-2 Dispatcher: queue, futures, long-poll endpoints, approvals-on-queue (§4.3) + fake executor tests
- [ ] M1-3 `/api/status` + CLI detection (port `modelbridge-clone/core/auth_status.py`)
- [ ] M1-4 Guard port: URL validation, sensitive tables, permission matrix + unit tests (§4.4, §6.3)

## M2 checklist

- [ ] M2-1 WXT scaffold: SW skeleton, React panel, Tailwind+shadcn, manifest per plan §5.1
- [ ] M2-2 Pairing onboarding + `bridge-client.ts` (token, backoff, health poll)
- [ ] M2-3 `useChat` → `/api/chat` engine `api` (Anthropic + OpenRouter), markdown streaming
- [ ] M2-4 ⌘K picker (cmdk) from `/api/status` + Settings→Providers CRUD + fallback chain
- [ ] M2-5 History: sessions, debounced writes, search, export

## M3 checklist

- [ ] M3-1 Executors: click/type/scroll/screenshot/get_active_tab + probe-before-act (§6.1 resolver)
- [ ] M3-2 `read_page` 4 modes + vendored `buildDomTree.js` + `__junior_dom_map` cache
- [ ] M3-3 Approval cards + Port routing + 120 s default-deny + guard display
- [ ] M3-4 Work overlay (thin border + pause) — port of Autono `content/content.js` trimmed
- [ ] M3-5 Fake-model harness driving all actions on `tests/fixtures/page.html`

## M4 checklist

- [ ] M4-1 MCP server (streamable HTTP) + `junior-mcp` stdio proxy + token
- [ ] M4-2 Terminal-Claude e2e: `claude mcp add` + guarded click through approval card
- [ ] M4-3 API engine agent mode (tools → dispatcher, maxSteps)
- [ ] M4-4 CLI engine: spawn, mcp-config loopback, `--resume` session map, stream→UI parts mapping
- [ ] M4-5 Kill/crash mid-task: overlay clears, futures resolve denied

*(M5/M6 checklists get added when M4 lands — don't pre-tick.)*

---

## Learnings

> Append-only. One line per fact, newest section per date. Format: `- [topic] fact (source)`.
> This is the anti-rediscovery log: CLI flags, renamed library APIs, environment quirks.

### 2026-10-23 (M0-1 scaffold session)
- [toolchain] typescript@7.x (native compiler) is OUTSIDE typescript-eslint@8's peer range (`>=4.8.4 <6.1.0`) → pinned `typescript@5.9.3`; re-evaluate when typescript-eslint supports 7.
- [toolchain] pnpm not preinstalled; `corepack enable` fails EACCES (`/usr/local/bin` not writable) → installed `pnpm@12.15.0` via `npm i -g` (user-owned `/usr/local/share/npm-global`). Store: `/workspace/.pnpm-store`.
- [toolchain] Host node is **24.22.1**; `.nvmrc` says 22 per plan, root `engines: >=22` admits both. ESLint 10 / vitest 5 / @types/node 26 all fine on 24.
- [toolchain] pnpm 10+ blocks lifecycle scripts; `onlyBuiltDependencies: [esbuild]` pre-approved in `pnpm-workspace.yaml`.
- [toolchain] vitest 5 resolves NodeNext-style `./x.js` → `./x.ts` relative imports natively — protocol can keep NodeNext source imports in tests, no plugin.
- [toolchain] `@junior/protocol` ships **built dist** via exports map (bridge is NodeNext, needs real d.ts); root `postinstall: pnpm -r build` keeps dist fresh on fresh clones. pnpm `-r` runs topological.
- [toolchain] prettier ignores `*.md` (plan/progress/CLAUDE.md keep their hand formatting); prettier is NOT in the green gate, `format:check` is.

### 2026-10-23 (planning session — reverse engineering)
- [security] ModelBridge never verifies the pairing token; CORS `allow_origins=["*"]` + `allow_private_network` — Junior must enforce token + origin allowlist (plan §4.2, §7-5).
- [mcp] ModelBridge `mcp_server.py` stdio proxy defaults to port 8000 while the server listens on 8765 — stale constant; Junior stdio proxy reads `~/.junior/config.json`.
- [mcp] ModelBridge SSE transport queues responses into `sse_sessions` but dispatch results only reach `pending_action_futures` — SSE path incomplete; use SDK streamable-HTTP instead (plan §7-14).
- [cli] ModelBridge spawns `claude -p - --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence` (modelbridge-clone/core/bridge_engine.py:775) — verified against *its* CLI version; Junior flips tool policy, must re-verify flags in M0-3.
- [extension] Autono element resolver = 6 fallback strategies (background.js:4222–4340); copy nearly verbatim (plan §6.1).
- [extension] Autono work overlay blocks *trusted* user clicks via `e.isTrusted` filter while automation proceeds (content/content.js:29) — keep this trick.
- [security] Autono permission matrix + sensitive-site tables at background.js:1913–1963 and lib/autono-security.js:283 — port verbatim (plan §4.4).

### 2026-10-23 (M0-3 CLI spike session — Claude Code 2.1.309)
- [cli] **`--verbose` is REQUIRED with `--output-format stream-json` in `-p` mode** — hard error "When using --print, --output-format=stream-json requires --verbose" (spikes/cli/flags.sh).
- [cli] `--thinking` exists but takes `enabled|adaptive|disabled` — NOT a budget/effort suffix; effort is `--effort low|medium|high|xhigh|max`. `--effort` is LENIENT: invalid values warn+ignore (exit 0) → bridge must validate before spawn.
- [cli] `--permission-prompt-tool` exists (hidden from `--help`) and takes an MCP tool name; rejected — see docs/decisions.md (guard-side approval is client-agnostic; with `--tools ""` there's nothing for the CLI to prompt for).
- [cli] **PROD combo verified**: `--tools ""` + `--strict-mcp-config` + `--mcp-config <file>` + `--allowedTools "mcp__junior_browser:*"` → init event `"tools":[]` (zero built-ins, zero inherited servers). No `--disallowedTools` deny-list needed — it would rot as CLI adds built-ins.
- [cli] Without `--strict-mcp-config`, spawned `claude` **inherits the cwd project's MCP servers** (.mcp.json/settings) and without `--model` it inherits settings.json's model — always pass both explicitly.
- [cli] `--mcp-config` with unreachable HTTP server is **non-fatal**: run completes; init shows `"mcp_servers":[{"name":"junior_browser","status":"failed","source":"dynamic"}]` → CLI engine can surface MCP health from init.
- [cli] Session continuity: `--session-id <uuid>` (turn 1) then `--resume <uuid>` (turn 2) round-trips context (verified BANANA42 recall) → bridge uses convId-as-UUID, no init-capture race. `--no-session-persistence` opt-out still works.
- [cli] stream-json event map (with `--include-partial-messages`): `system/init` (cwd, session_id, tools[], mcp_servers[], model, permissionMode) → `stream_event` wrappers around raw Anthropic events (`message_start`, `content_block_start/delta` with `text_delta`, `content_block_stop`, `message_delta`, `message_stop`) → `assistant` (full blocks incl. `tool_use`) → `user` (tool_result) → `result` (`is_error`, `result` text, `usage`{input/output_tokens, cache_*}, `total_cost_usd`, `num_turns`, `duration_ms`) — usage.ts maps this 1:1.
- [cli] Denied tools (e.g. `--disallowedTools Bash` + `--permission-prompts none`) still emit `tool_use` + `tool_result` events — denial surfaces to the UI through the normal tool-part mapping, no special event type.
- [cli] `--input-format stream-json` accepts `{"type":"user","message":{"role":"user","content":"…"}}` lines on stdin (verified) — engine's realtime turn path.
- [env] Nested `claude` spawn: unset `CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_SESSION_ATTENDED` to avoid inheriting the parent session's wiring (flags.sh `spawn()`).
- [env] `--effort`/flag probes with `--version` exit 0 before validation — commander-style short-circuit; probe flags with a real `-p` call, not `--version`.

### 2026-10-23 (M0-2 protocol session)
- [zod] `zod@4.6.5` pinned exact in `@junior/protocol`; with package major 4, root `import { z } from "zod"` **is** the v4 API (no `zod/v4` subpath needed).
- [zod] v4 `.default()` short-circuits parsing and requires the value to match the schema's **output** type: `ProvidersConfigSchema.default({})` fails to compile when a member field has its own default → `.default({ openaiCompatible: [] })`. Keys with `.default()` are optional in `z.input`, required in `z.output`/`z.infer`.
- [docs] context7 accepts pinned versions as libraryId — `/colinhacks/zod/v4.6.5` returns version-exact docs.
- [toolchain] `pnpm add` triggers root postinstall (`pnpm -r build`) **at install time** — dist is stale if you add deps before writing source; `pnpm -r build` in the green gate catches it, but don't trust a freshly-installed dist mid-session.
- [toolchain] Green-gate lint is **`pnpm lint` (root `eslint .`)** — `pnpm -r lint` hard-fails while the extension stub has no scripts; switch to `-r` only when workspaces define their own lint scripts. (M0-3 session hit this; also `pnpm -r build` failed once with a transient recursive-exec error and passed on immediate rerun.)


## Session log

> One line per session: `date · task(s) · outcome · commit`

- 2026-10-23 · planning · plan.md + CLAUDE.md + progress.md written from RE of Autono/ModelBridge · —
- 2026-10-23 · M0-1 · monorepo scaffold green (typecheck/test/build/lint/format, protocol↔bridge import verified) · de84cf1
- 2026-10-23 · M0-2 · all §3 schemas + config.ts frozen, 20 round-trip tests green, 2 forks → docs/decisions.md · 3cd22f4
- 2026-10-23 · M0-3 · CLI flag matrix 10/10 vs CLI 2.1.309; --thinking/--permission-prompt-tool/--session-id surprises; plan §4.5 args rewritten; 3 forks → docs/decisions.md · c56ef25
