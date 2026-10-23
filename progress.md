# Junior — Progress & Learnings

> Live state. Every session starts by reading this file and ends by updating it (protocol in `CLAUDE.md`).
> Plan of record: `plan.md` · Decision log: `docs/decisions.md` (created on first entry)

**Updated:** 2026-10-23
**Current milestone:** M2 — Extension shell + chat (2/5)
**Current task:** none claimed (**next up: M2-3** useChat → /api/chat engine api; M3-1 may run in parallel per plan §8)
**Current blockers:** none

---

## Milestone tracker

| Milestone | State | Notes |
|---|---|---|
| M0 Scaffold + spike (protocol schemas, CLI flags spike, AI SDK spike) | ✅ done (4/4) | AI SDK pinned to **v7** in M0-4 (plan said v5 — decisions.md); M1 unblocked |
| M1 Bridge core (Hono, auth, dispatcher, guard, status) | ✅ done (4/4) | M1-4 guard: pure tables/matrix in `@junior/protocol` + SessionGuard in bridge; M2/M3 unblocked (parallelizable per plan §8) |
| M2 Extension shell + chat (WXT, useChat, ⌘K picker, settings, history) | ◐ 2/5 in progress | M2-1 scaffold + M2-2 pairing/bridge-client done; M2-3 next |
| M3 Browser tool layer (executors, read_page, approvals, overlay) | ⬜ blocked by M1 | parallelizable with M2 |
| M4 MCP server + agent paths (streamable HTTP, stdio proxy, CLI engine) | ⬜ blocked by M1+M3 | terminal-Claude e2e is the headline demo |
| M5 Polish + hardening | ⬜ blocked by M4 | security + perf passes per plan §8 |
| M6 Buffer / backlog seeds | ⬜ | |

## M0 checklist

- [x] M0-1 pnpm monorepo scaffold (workspaces, strict tsconfig, eslint/prettier, node 22) — gates green: `pnpm -r typecheck/test/build` + lint + format; commit de84cf1
- [x] M0-2 `packages/protocol` — all plan §3 schemas + round-trip tests — zod@4.6.5 pinned; actions/queue/approval/chat/status + `config.ts` (§4.1); 20 tests green: `pnpm -r typecheck/test/build` + lint + format OK; 2 forks recorded in `docs/decisions.md`; commit 3cd22f4
- [x] M0-3 ★ CLI spike: run plan §4.5 flag matrix against installed `claude`; record results in Learnings — `spikes/cli/flags.sh` 10/10 PASS vs Claude Code 2.1.309; 3 forks → docs/decisions.md (args updated in plan §4.5); evidence extracts in spikes/cli/evidence/; commit c56ef25
- [x] M0-4 ★ AI SDK spike: `streamText` (anthropic + openai-compatible) → `toUIMessageStream` → `useChat` — **pinned v7** (ai@7.0.151 + @ai-sdk/anthropic@4.0.87 + @ai-sdk/openai-compatible@2.0.87 + @ai-sdk/react@4.0.155; plan said v5 → fork in decisions.md, plan §2/§4.5/§5.3/§8 updated). 5/5 tests in `spikes/ai-sdk/`: hermetic useChat e2e vs a hand-rolled OpenAI-compatible SSE mock (plain + agentMode tool loop), server-side wire-shape evidence, and a **real-gateway** streaming leg (`@ai-sdk/anthropic` custom baseURL → glm-5.3-flash; skips without `ANTHROPIC_API_KEY`). Green gate: `pnpm -r typecheck/test` + lint + format:check

## M1 checklist

> Annotated by the post-M0 architect review (2026-10-23) — those "+ review" items are part of the task now.

- [x] M1-1 Hono app + config/token/pairing + auth middleware + CORS allowlist (plan §4.1–4.2) **+ review: complete the "frozen" protocol (add `ExtensionSettingsSchema` per plan §3 config block; add `PairingStatusSchema` for `GET /api/pairing` §HTTP-table; fix plan.md's stale `BridgeConfigSchema` name) + bridge `build`/`dev` scripts + protocol watch path (bridge is silently skipped by `pnpm -r build` today)** — all done. Protocol: `pairing.ts` (Status/Request/Result) + `ExtensionSettingsSchema`, plan §2/§3 updated (commit 90cf4a4). Bridge: config (fail-fast load, atomic save, JUNIOR_HOME override), 0600 token, §4.1 pairing window via marker file (`junior-bridge pair`), bearer auth (sha256-digest constant-time compare, per-request token read), deny-by-default CORS (echo + PNA for chrome-extension://[a-p]{32} wildcard + loopback — decisions.md), rate-limit.ts staged for M4 /mcp, `junior-bridge serve|pair` bin, build/dev/start scripts. Gates: `pnpm -r typecheck/test` (26 protocol + 29 bridge), lint, format:check all green. Acceptance (live curl vs `node apps/bridge/dist/bin.js serve`, JUNIOR_HOME=tmpdir): health `{"ok":true} 200`; pairing status `{tokenRequired:true,tokenSet:true}`; mismatch POST → 403 + hint; `pair` → POST → `{"ok":true,"alreadyPaired":false}` + token file mode 600 + window consumed; idempotent re-POST → `alreadyPaired:true`; wrong token → 403; `/api/status` no-token 401 / with-token 404 (route lands M1-3); evil Origin → zero access-control headers, extension Origin echoed, preflight 204 with methods/headers/PNA/max-age; `ss` shows `127.0.0.1:8620` only. Commits 90cf4a4, d4656c6
- [x] M1-2 Dispatcher: queue, futures, long-poll endpoints, approvals-on-queue (§4.3) + fake executor tests **+ review: tighten `QueueItemSchema` to a discriminated union (kind↔payload — currently both members optional, queue.ts) + cross-check `engine`/`provider` defaults in `ChatRequestBodySchema` (currently sanctions invalid api+claude-cli combo)** — all done. Protocol: `queue.ts` is a `z.discriminatedUnion("kind", …)` (payload-less items can't parse; consumers narrow for free); `chat.ts` provider default → `anthropic` + `.refine((b) => (b.engine === "cli") === (b.provider === "claude-cli"))` (decisions.md 2026-10-23, commit 75e0c32). Bridge: `dispatcher/queue.ts` — AsyncQueue FIFO long-poll (unref'd timers), futures Map, `dispatch` with ActionGuard seam (deny / approval / allow), 120 s default timeout distinguishing not-connected, `dispose()` seam for M4-5; `dispatcher/approvals.ts` — 120 s window, USER_DENIED / BLOCKED_BY_POLICY strings, no-panel ⇒ immediate deny; `dispatcher/routes.ts` — `?timeout` clamp 1–20 s (default 15), next-action returns frozen QueueItem JSON or `{item: null}`, bad bodies 400, unknown ids `{delivered: false}`. Gates: `pnpm -r typecheck/test` (27 protocol + 58 bridge) + lint + format:check green. Acceptance: FakeExecutor wire round-trips through the real Hono app (poll → execute → `ok` with result; approval "once" → action executes; "deny" → `USER_DENIED`, zero executions; unanswered card → default-deny; no panel → immediate deny) + live curl vs `node apps/bridge/dist/bin.js serve` (JUNIOR_HOME=tmpdir): health ok; next-action 401 no-token / 403 wrong-token; idle `?timeout=2` held the socket 2.018 s → `{"item":null}`; garbage body 400; stale ids `{delivered:false}`. Commits 75e0c32, 1b3c41b
- [x] M1-3 `/api/status` + CLI detection (port `modelbridge-clone/core/auth_status.py`) — done. `apps/bridge/src/cli-detect.ts`: `resolveClaudePath` (cliPath override fail-loud > PATH scan > WinGet `*ClaudeCode*` glob + npm-roaming candidates, port of config.py:49–71) + `parseClaudeAuthStatus` (brace-scan port, + `authMethod`) + `probeClaude` (concurrent `--version` + `auth status`, 12 s cap, CLAUDE_* env stripped, win32 `.cmd` via `cmd.exe /d /s /c`); `apps/bridge/src/status.ts`: `statusRoutes` — config loaded per request, `buildProviders` pure (claude-cli / anthropic / openai-compatible entries), `apiLevel: 1`, bridge version from package.json relative to module. Gates: `pnpm -r typecheck/test/build` + lint + format:check green (27 protocol + **82 bridge** + 5 spikes). Acceptance: unit suites cover parse/resolve/probe/route (incl. queueDepth 1→0 around an in-flight dispatch, browserConnected ping flip, cliPath passthrough, malformed config → 500); live curl vs `node apps/bridge/dist/bin.js serve` (JUNIOR_HOME=tmpdir): no-token 401, wrong-token 403, with-token → real detection `{"id":"claude-cli","available":true,"detail":"claude 2.1.309 — logged in (api_key)"}`, anthropic unavailable (no key), `browserConnected:false` → `true` after one next-action poll, `queueDepth:0`. plan §4.5 probe description rewritten to match. Commits 7b36372, 0f6d4ed
- [x] M1-4 Guard port: URL validation, sensitive tables, permission matrix + unit tests (§4.4, §6.3) **+ review: land the PURE guard tables/matrix in `@junior/protocol` (bridge keeps stateful enforcement only) — M3's extension-guard subagent must share it without importing bridge internals (plan §5.2 guard + §11.3)** — done. **Pure:** `packages/protocol/src/guard.ts` — verbatim port of Autono background.js:1784–1957 (`validateAgentUrl` + private IPv4/IPv6 reason detection + registrable domain + SENSITIVE_* tables verbatim EN+ES) and autono-security.js:269–290 (`normalizePermissionMode` + `permissionDecision` per plan §4.4 matrix); `blockedOrigins` are a HARD reject per §6.3-5 (Autono confirmed — plan says "never"); denial strings USER_DENIED/BLOCKED_BY_POLICY/BLOCKED_SENSITIVE + `denialTextFor`. `GuardReasonCodeSchema` named in approval.ts (no wire-shape change). **Stateful:** `apps/bridge/src/dispatcher/guard.ts` `SessionGuard` (port of createActionGuard background.js:2015–2158: seenDomains/grantedSites/pageApprovedFor; navigate enforced in full, other kinds pass — page-fact checks are the §5.2 extension mirror's job) + `defaultGuard(dir)` (permissionMode + bridge origin live from config, fail-safe to ask) wired as createApp's default dispatcher guard; new standalone `Dispatcher.requestApproval` for `checkPage` (M4 engines), same no-panel/timeout default-deny. **Tests:** Autono battery ported (security-sprint2.test.js + autono-security.test.cjs) → protocol 146 tests; bridge 102 (SessionGuard matrix per mode, checkPage ask/deny/grant, defaultGuard config reads, wired dispatch→card→"site"→execute→no-card-next-visit + deny→USER_DENIED). Gates: `pnpm -r typecheck/test/build` + lint + format:check green. Acceptance: live boot `node apps/bridge/dist/bin.js serve` (JUNIOR_HOME=tmpdir) — health ok, /api/status unchanged (claude 2.1.309 detected), idle `?timeout=1` held 1.012 s → `{item:null}`. Two plan-specified deltas from Autono recorded in plan §4.4: secret fields refused in every mode (§6.3-4), sensitive site/label/form submit carded even in auto (§4.4 row 3). Commits 53a62d9, 1f969e9

## M2 checklist

- [x] M2-1 WXT scaffold: SW skeleton, React panel, Tailwind+shadcn, manifest per plan §5.1 — done. `apps/extension/`: wxt@0.21.4 (`srcDir:"src"`, `@wxt-dev/module-react`, `alias @→src`), manifest per §5.1 (verified in `.output/chrome-mv3/manifest.json`: MV3, min chrome 120, perms storage/scripting/activeTab/sidePanel/tabs/alarms, host_permissions `http://127.0.0.1:8620/*` only, tight CSP `script-src 'self'; connect-src 'self' http://127.0.0.1:8620`, no web_accessible_resources, no static content_scripts) + **pinned id**: RSA-2048 keypair → `manifest.key` ↔ `EXTENSION_ORIGIN` in `@junior/protocol` (tripwire test) ↔ bridge allowlist (id `ocjlcgidjeodnjicogfmmicpkookeabb`; private key `~/.junior/extension-key.pem` 0600, uncommitted; derivation key→id verified programmatically). SW skeleton (`defineBackground`: setPanelBehavior on action click + storage.local.setAccessLevel TRUSTED_CONTEXTS port of Autono background.js:38); sidepanel React 19 + Tailwind v4 (`@tailwindcss/vite`) + shadcn vendored by hand (components.json, cn, Button; decisions.md). Gates: `pnpm -r typecheck/test/build` + lint + format:check green (extension builds 267 kB; 148 protocol + 103 bridge + 5 spike tests). Acceptance: `wxt build` output inspected vs §5.1; live bridge boot — preflight with pinned origin → 204 + ACAO echo + PNA, well-formed foreign `[a-p]{32}` id → bare 204, **zero** access-control headers. Commits (see session log)
- [x] M2-2 Pairing onboarding + `bridge-client.ts` (token, backoff, health poll) — done. `lib/bridge-client.ts` (fetch wrapper → `BridgeUnreachableError`/`BridgeHttpError` with `authFailed` for 401/403; wire parsing via `@junior/protocol` schemas; pure `nextDelayMs` backoff 1 s→30 s + ≤250 ms jitter) + `hooks/use-bridge-status.ts` (5 s healthy poll, backoff on failure, `recheck()`); `lib/pairing.ts` (`generateToken` 32-byte hex, `ensureToken` persisted, `pairWithBridge` → paired/mismatch/unreachable); `lib/settings.ts` (`junior_settings`/`junior_bridge_token`/`junior_onboarded`/`junior_default_provider` keys, corrupt-value fallback to §4.1 defaults); onboarding component (§5.3: 1 install-bridge command+check, 2 auto-pair with mismatch → `junior-bridge pair` copy + retry, 3 provider pick from /api/status seeding M2-4; skippable at every step) + `bridge-status-bar.tsx` (green/red dot + start hint). SW `onInstalled`/`onStartup`: ensureToken + settings materialize + best-effort idempotent pair. Tests: vitest + `WxtVitest` plugin added to the extension (22 tests — wire shapes, error classification, backoff bounds, storage round-trips, pairing decision tree via fakeBrowser). Gates: `pnpm -r typecheck/test/build` + lint + format:check green (148 protocol + 103 bridge + 22 extension + 5 spikes). Acceptance (live, bridge on 127.0.0.1:8620): health `{ok:true}`; bridge auto-minted token → POST → 403 + `junior-bridge pair` hint (mismatch step); after `pair` → the REAL `pairWithBridge()` module (temp live vitest, since deleted) → `{status:"paired",alreadyPaired:false}` → re-pair `{alreadyPaired:true}` → `/api/status` 200 with stored token (`apiLevel:1`, claude-cli available). Commit eee34f6
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

### 2026-10-23 (M0-4 AI SDK spike session — ai@7.0.151)
- [ai-sdk] **Pin v7 line**: `ai@7.0.151`, `@ai-sdk/anthropic@4.0.87`, `@ai-sdk/openai-compatible@2.0.87`, `@ai-sdk/react@4.0.155`. Peer matrix: `@ai-sdk/*` major 2 ↔ ai@5, 3 ↔ ai@6, 4 ↔ ai@7. zod peer `^3.25.76 || ^4.1.8` (our 4.6.5 OK); react peer `^18 || ^19` OK.
- [ai-sdk] v7 renames vs plan's v5-era snippet: `stepCountIs` → `isStepCount` (old name kept as deprecated alias); `result.toUIMessageStream()`/`toUIMessageStreamResponse()` deprecated → stateless `toUIMessageStream({ stream: result.stream })` + `createUIMessageStreamResponse(...)`; `system` → `instructions` (old name = deprecated fallback); `convertToModelMessages` is **async** (await it). `useChat`/`DefaultChatTransport`/`createOpenAICompatible`/`onError: ({error})` unchanged.
- [ai-sdk] UI message stream wire (v7, observed): plain chat `start → start-step → text-start → text-delta → text-end → finish-step → finish`; agent tool loop `start → start-step → tool-input-start → tool-input-delta → tool-input-available → tool-output-available → finish-step → start-step → text-* → finish-step → finish`. Stream terminates with a bare `data: [DONE]` SSE frame — parsers must skip it.
- [ai-sdk] `createAnthropic({ baseURL })` prefix must **include `/v1`** (default `https://api.anthropic.com/v1`); z.ai gateway = `$ANTHROPIC_BASE_URL/v1`. Gateway model code is `glm-5.3-flash` — the `[1m]` suffix from `ANTHROPIC_DEFAULT_OPUS_MODEL` gets rejected (`[1211] Unknown Model`); strip it. Unknown model codes also trigger a SDK warning capping `maxOutputTokens` at 4096 — pass it explicitly for long replies.
- [ai-sdk] `useChat` status lifecycle observed: `submitted` → `streaming` → `ready` (error → `error`). In e2e waits assert the **assistant** message, never the user text — the prompt usually contains your token, making `waitFor` vacuously true while status is still `submitted`.
- [toolchain] pnpm 12 `minimumReleaseAge`: brand-new npm releases are auto-excluded — install writes `minimumReleaseAgeExclude` entries into `pnpm-workspace.yaml` (happened for all seven ai@7 packages).
- [toolchain] vitest jsdom env resolves `jsdom` as an **optional peer of vitest** → keep it a **workspace-root devDep** (pnpm resolves peers from the importer = root); per-file opt-in via `/** @vitest-environment jsdom */` pragma.
- [react] RTL 16 + React 19 under vitest jsdom: set `globalThis.IS_REACT_ACT_ENVIRONMENT = true`; streaming state updates land fine via `waitFor`. jsdom has no fetch → `DefaultChatTransport` transparently uses Node's undici fetch, including SSE streaming.
- [toolchain] `new Request(url, { body: Readable.toWeb(req), duplex: "half" })` — `duplex` is an undici extension absent from DOM `RequestInit`; type the init as `RequestInit & { duplex?: "half" }` (plain `as any` on the value doesn't silence TS2353).


### 2026-10-23 (M1-1 bridge session — hono@4.13.13, @hono/node-server@2.1.5, tsx@4.23.15)
- [pnpm] pnpm 12.15 replaced the `onlyBuiltDependencies` yaml list with an `allowBuilds: {pkg: true}` map — a NEW transitive dep with build scripts (tsx → esbuild@0.28.2) hard-errors `pnpm add`/`pnpm install` (`ERR_PNPM_IGNORED_BUILDS`) even though the old list names it; fix = `pnpm approve-builds <pkg>` (rewrites the yaml itself).
- [pnpm] `pnpm add` writes caret ranges — Junior convention is exact pins; rewrite `^x.y.z` → `x.y.z` after adding (hono 4.13.13, @hono/node-server 2.1.5, tsx 4.23.15).
- [hono] `serve({ fetch: app.fetch, port, hostname })` from `@hono/node-server` — `hostname` IS honored (acceptance: `ss -tln` shows `127.0.0.1:8620` only). Built-in `hono/cors` is unusable for deny-by-default: its `origin` function form must return SOME origin (falls back to a default), never "none". Custom middleware (`c.header()` before `await next()`, early `c.body(null, 204)` for OPTIONS) is ~30 lines and exact.
- [hono] middleware + handlers run in registration order, but bearer auth is route-order-proof: it checks `PUBLIC_ROUTES` (health, GET /api/pairing) inside the middleware instead of relying on registration order. `createMiddleware` from `hono/factory`; `app.request()` = in-process Request/Response harness for tests, no listener needed.
- [hono] headers are case-insensitive in `c.header()`/`res.headers.get()` — tests use lowercase wire names (`access-control-allow-private-network`).
- [bridge] `junior-bridge pair` (separate process) talks to the running server via a marker file (`~/.junior/pairing-window.json`, expiry inside) — the server reads the token file per request (no cache) so clears/sets land immediately; no admin endpoint needed. POST /api/pairing can only SET a token while a window is open, so a CORS-blinded page can't pre-seed the token.
- [hono] preflights never carry `Authorization` — the CORS middleware must answer OPTIONS before/without auth (bearerAuth skips OPTIONS too).

### 2026-10-23 (M1-3 status + CLI detection session — Claude Code 2.1.309)
- [cli] `claude auth status` EXISTS in 2.1.309, exits 0, prints pretty JSON: `{loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, apiKeySource}` — `email`/`orgName` appear only on OAuth logins (api_key logins have account=null); ModelBridge's parser ports verbatim. `--version` prints `2.1.309 (Claude Code)`.
- [node] Node ≥ 18.20 spawns of `.cmd`/`.bat` hard-fail EINVAL without a shell (CVE-2024-27980) → cli-detect routes those through `cmd.exe /d /s /c` with the exe quoted; branch is untestable on this linux box (flagged as an M5 seed).
- [node] `spawn`'s `stdio` needs a MUTABLE tuple — `["ignore","pipe","pipe"] as const` fails TS2769 against `StdioOptions`; type it `as ["ignore","pipe","pipe"]`.
- [hono] Nested `app.route("/api", …)` alongside `app.route("/api/agent", …)` composes fine under the `/api/*` auth middleware — status lands behind the token with zero auth changes.

### 2026-10-23 (M1-2 dispatcher session — zod 4.6.5, hono 4.13.13)
- [zod] `z.discriminatedUnion` members take `.default()` on non-discriminator fields fine, but discriminators should stay plain literals (docs list literal/enum/null/undefined) — no defaulted-discriminator `{model}`-shorthand; ChatRequestBodySchema stayed a flat object + `.refine` instead (decisions.md).
- [zod] Object-level `.refine` sees the post-defaults output (defaults fill in before refinements run); unrelated field issues SKIP refinements by default (`when` opt-in exists) — test refine failures with otherwise-valid siblings.
- [zod] A missing discriminator fails as `invalid_union … "No matching discriminator"` — i.e. `{item: null}` does NOT parse as a QueueItem; always check `"item" in body` before parsing an idle long-poll response (the FakeExecutor does).
- [bridge] `createApp({ dispatcher: undefined })` silently builds its own Dispatcher — a test helper must inject the SAME instance it holds, or dispatches vanish into a private queue (cost one debug cycle; helper now defaults the param to `new Dispatcher()` and passes the same one in).
- [hono] `app.request()` supports CONCURRENT in-flight requests — the fake-executor harness (long-poll pending while dispatch pushes) needs no real listener; pair with `writeToken(dir)` for the bearer gate.
- [node] Long-poll timers must `unref()` or vitest workers hang at exit with pending 1–20 s polls.
- [toolchain] Bridge imports `@junior/protocol` through its built dist — after protocol source edits, run `pnpm --filter @junior/protocol build` BEFORE bridge typecheck, or TS errors describe the stale schema (hit twice this session).


### 2026-10-23 (M1-4 guard session — protocol guard.ts + SessionGuard)
- [security] WHATWG URL normalizes numeric IPv4 hosts before JS ever sees them: `0x7f.1`, `2130706433`, `0177.0.0.1`, `127.1` all become `127.0.0.1`, and `[::ffff:127.0.0.1]` → `[::7f00:1]` — the private-host checks rely on this; holds identically in Node and Chrome (Autono test cases pass unmodified).
- [ts] `noUncheckedIndexedAccess` makes regex-exec group and IPv6-group indexes `T | undefined` — non-null `!` is honest where the regex/length check provably guarantees the index (guard.ts annotates each).
- [eslint] `no-control-regex` fires on the guard's control-character *rejection* regex — inline disable with a reason comment, not a rule change.
- [vitest] Awaiting a dispatch BEFORE polling its action item deadlocks the test: after an approval answers, `dispatch` proceeds straight to execution and waits for an action-result the test hasn't polled yet. Order: poll → answer → poll again → then await (cost one 5 s-timeout debug cycle).
- [bridge] A long-poll landing between `dispatch()` and the guard verdict pings `connected()` (poll ⇒ touch), so the "no panel ⇒ deny" early-return is timing-dependent in tests — with a concurrent poller the card IS delivered. Correct prod behavior; tests must answer cards they caused.
- [zod] Object-literal reason-code arrays in tests widen to `string[]` and fail `.enum` typing — `as const` on the test arrays (runtime parse unaffected).

### 2026-10-23 (M2-1 WXT scaffold session — wxt@0.21.4, tailwindcss@4.3.3, react@19.3.1)
- [wxt] `@wxt-dev/module-react` configures Vite only — it does NOT set `jsx` in the generated `.wxt/tsconfig.json`; add `"jsx": "react-jsx"` yourself or `wxt build` is green while `tsc --noEmit` fails with TS17004.
- [wxt] Generated `.wxt/tsconfig.json` already carries strict + noUncheckedIndexedAccess + noImplicitOverride + verbatimModuleSyntax + `paths` mirrored from wxt.config `alias` (`@`/`~`/`@@`/`~~`) — the extension tsconfig only adds extras on top of `extends`.
- [wxt] Prefer WXT's auto-imported `browser` global (typed via @wxt-dev/browser 0.3.6) over `chrome.*` + `@types/chrome`: `sidePanel.setPanelBehavior` AND `storage.local.setAccessLevel` are both typed (setAccessLevel doc: local/sync default to trusted+untrusted contexts — the Autono background.js:38 call is what keeps content scripts out).
- [wxt] Manifest wiring: a `sidepanel/` entrypoint auto-adds the `sidePanel` permission and `side_panel.default_path`; opening the panel on toolbar click is NOT manifest-wired in MV3 — call `browser.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` in the SW; `manifest.key` passes straight through and Chrome derives the stable id.
- [chrome] Unpacked-id derivation: SHA-256 of the manifest key's SPKI DER, first 16 bytes, hex-encoded, each hex digit 0-9a-f mapped to a-p (32 chars). Verified key→id programmatically; id `ocjlcgidjeodnjicogfmmicpkookeabb`.
- [pnpm] `pnpm add` runs root postinstall (`pnpm -r build`) mid-add — a first add that introduces a new build tool fails its postinstall (`wxt build` before wxt is linked); complete the dependent add and the gate re-runs clean.
- [env] This mac runs nvm node 22.22.1 with `corepack enable` (user-writable nvm bin — the `/usr/local` EACCES from earlier sessions doesn't apply). CLAUDE.md's `/workspace/autono-clone` reference path does NOT exist here; the clones live at `~/Personal/rea/{autono,modelbridge}-clone` (read-only rules unchanged).

### 2026-10-23 (M2-2 pairing + bridge-client session — wxt@0.21.4 testing, vitest@5.0.5)
- [wxt] Testing setup: `WxtVitest()` from `wxt/testing/vitest-plugin` (NOT the removed `wxt/testing` barrel — 0.21 split it into `/vitest-plugin` + `/fake-browser`); it polyfills the `wxt/browser` `browser` export with in-memory fakeBrowser, auto-resets storage per test, and mirrors wxt.config aliases/env into vitest. Plain node env suffices (no jsdom) for storage/fetch-mock tests.
- [wxt] `browser` in lib modules: import explicitly (`import { browser } from "wxt/browser"`) — auto-imports are entrypoint-centric; explicit import resolves to the same fakeBrowser under tests.
- [vitest] `vi.stubGlobal("fetch", …)` pairs with the module-level `fetch()` calls fine in node env; `Response`/`Request` globals exist in node 22 — no undici imports needed for JSON-mock tests.
- [pairing] First-run UX reality: `junior-bridge serve` AUTO-mints a token at startup when none exists (bridge config.ts `ensureToken`) → the extension's first POST always 403s with the `junior-bridge pair` hint unless the server was started with a window open. Onboarding step 2 is built around this: auto-attempt → mismatch → "run `junior-bridge pair`, retry within 60 s". (Plan §4.1 reads as if the extension token wins first run; it doesn't — the onboarding flow is the resolution.)
- [pnpm] `pnpm --filter <pkg> exec vitest run <file>` runs a single extension test file despite the workspace not exposing a script arg passthrough.

### 2026-10-23 (M0-2 protocol session)

- [zod] `zod@4.6.5` pinned exact in `@junior/protocol`; with package major 4, root `import { z } from "zod"` **is** the v4 API (no `zod/v4` subpath needed).
- [zod] v4 `.default()` short-circuits parsing and requires the value to match the schema's **output** type: `ProvidersConfigSchema.default({})` fails to compile when a member field has its own default → `.default({ openaiCompatible: [] })`. Keys with `.default()` are optional in `z.input`, required in `z.output`/`z.infer`.
- [docs] context7 accepts pinned versions as libraryId — `/colinhacks/zod/v4.6.5` returns version-exact docs.
- [toolchain] `pnpm add` triggers root postinstall (`pnpm -r build`) **at install time** — dist is stale if you add deps before writing source; `pnpm -r build` in the green gate catches it, but don't trust a freshly-installed dist mid-session.
- [toolchain] Green-gate lint is **`pnpm lint` (root `eslint .`)** — `pnpm -r lint` hard-fails while the extension stub has no scripts; switch to `-r` only when workspaces define their own lint scripts. (M0-3 session hit this; also `pnpm -r build` failed once with a transient recursive-exec error and passed on immediate rerun.)


## Backlog seeds

> Ideas discovered mid-work land here (protocol: CLAUDE.md). Never into the current diff.

- (from post-M0 review 2026-10-23) **Early M4-1 probe (~30 min, could ride along any M1 session with the bridge up):** verify a *reachable* MCP loopback — `--mcp-config` → `http://127.0.0.1:8620/mcp` **with the token in headers** (`~/.junior/mcp.json` header shape unverified; M0-3 only proved unreachable = non-fatal) and confirm stream-json `tool_use` events carry `mcp__junior_browser__*` names.
- (from post-M0 review 2026-10-23) M2 must not assume the OpenAI-compatible happy path: mock doesn't cover in-stream error frames on HTTP 200 (OpenRouter's documented failure mode), reasoning-token deltas, slashed routing model names. Revisit when M2-3 wires the fallback chain.
- (from M1-1, 2026-10-23) **M2-1 must pin the extension id** (manifest `key` field) and then tighten `isAllowedOrigin` in `apps/bridge/src/auth.ts` from the `chrome-extension://[a-p]{32}` wildcard to the exact id (decisions.md 2026-10-23 — wildcard is safe only because every data route still demands the token).
- (from M1-1, 2026-10-23) §4.2's "rate-limit POST /mcp" is implemented as `apps/bridge/src/rate-limit.ts` (30/min burst, tested) but NOT yet mounted anywhere — M4 must wire it into the `/mcp` route or the brake silently never engages.
- (from M1-2, 2026-10-23) `ActionResultSchema` could tighten status↔payload consistency (`ok` ⇒ no `error`; `error`/`denied` ⇒ `error` present) — left loose for M3 executor ergonomics; revisit only if a real bug demands it.
- (from M1-3, 2026-10-23) cli-detect's win32 branches (WinGet glob, npm-roaming shims, `cmd.exe /d /s /c` for `.cmd`) are unit-tested with fixtures but never exercised on real Windows — verify on a Windows box in the M5 hardening pass.
- (from M1-3, 2026-10-23) `/api/status` spawns `claude --version` + `auth status` per call (ModelBridge parity, ~100 ms); if M2's picker ever polls it continuously, add a short TTL cache then — not before.

## Session log

> One line per session: `date · task(s) · outcome · commit`

- 2026-10-23 · planning · plan.md + CLAUDE.md + progress.md written from RE of Autono/ModelBridge · —
- 2026-10-23 · M0-1 · monorepo scaffold green (typecheck/test/build/lint/format, protocol↔bridge import verified) · de84cf1
- 2026-10-23 · M0-2 · all §3 schemas + config.ts frozen, 20 round-trip tests green, 2 forks → docs/decisions.md · 3cd22f4
- 2026-10-23 · M0-3 · CLI flag matrix 10/10 vs CLI 2.1.309; --thinking/--permission-prompt-tool/--session-id surprises; plan §4.5 args rewritten; 3 forks → docs/decisions.md · c56ef25
- 2026-10-23 · M0-4 · AI SDK pinned v7 (plan said v5); 5/5 spike tests incl. real-gateway streaming + tool-loop wire map; plan §2/§4.5/§5.3/§8 updated; 1 fork → docs/decisions.md; M0 complete → M1-1 next · 0f1e6fa
- 2026-10-23 · post-M0 review · architect subagent: green overall, protocol completeness amber; 5 course corrections folded into M1 checklist + 2 backlog seeds; gates re-verified live by reviewer · (bookkeeping commit)
- 2026-10-23 · M1-1 · bridge core green: protocol pairing/settings schemas, Hono app + auth/CORS + §4.1 pairing flow, 29 tests + live curl acceptance; plan/decisions updated; M1 1/4 · 90cf4a4, d4656c6
- 2026-10-23 · M1-2 · dispatcher green: AsyncQueue/futures + long-poll /api/agent/* + approvals-on-queue with fake-executor wire tests + live curl; review items landed (queue union, chat engine/provider check) → protocol 27 + bridge 58 tests; M1 2/4 · 75e0c32, 1b3c41b
- 2026-10-23 · M1-3 · /api/status green: cli-detect port (auth_status.py + config.py:49–71) verified live against CLI 2.1.309, provider entries from config + detection, dispatcher freshness/queue depth; 82 bridge tests + live curl acceptance; plan §4.5 updated; M1 3/4 · 7b36372, 0f6d4ed
- 2026-10-23 · M1-4 · guard green: pure tables/matrix in @junior/protocol (Autono battery ported) + SessionGuard enforcement wired as createApp default; navigate→card→site→execute + deny→USER_DENIED proven over the real app; 146 protocol + 102 bridge tests + live boot; plan §4.4/§5.2 updated; **M1 complete → M2-1 next (M3-1 parallel)** · 53a62d9, 1f969e9
- 2026-10-23 · M2-1 · WXT scaffold green: manifest per §5.1 verified in build output, extension id pinned (key ↔ EXTENSION_ORIGIN ↔ bridge allowlist), SW skeleton + React/Tailwind-v4/shadcn panel, CORS tightened live (pinned echo, foreign bare-204); 148 protocol + 103 bridge tests · 3fa0992, 9fc6003
- 2026-10-23 · M2-2 · pairing onboarding + bridge-client green: token gen/storage, pairWithBridge decision tree, 5 s health poll with backoff, 3-step skippable onboarding + status bar; 22 extension tests (WxtVitest) + live acceptance vs real bridge (pair → re-pair idempotent → /api/status 200); M2 2/5 · eee34f6
