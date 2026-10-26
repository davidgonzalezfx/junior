# Junior — Decision log

> One short paragraph per fork with more than one defensible option (protocol: CLAUDE.md →
> "Decisions & deviations"). The plan section it affects is updated in the same commit.

## 2026-10-23 · Config schema details frozen as `JuniorConfigSchema` (M0-2)

Context: plan §4.1 names the config fields but not their exact shape. Options: (a) flat config with
`anthropicKey`/`cliPath` at top level, `providers` as a bare list; (b) nested `providers: {anthropicKey,
openaiCompatible: [...]}`. Choice: **(b)**, matching the plan's parenthetical "(anthropic key,
openai-compatible list …)" — keeps provider auth in one place, mirrors `BridgeStatusSchema.providers`.
Field names: `anthropicKey`, `openaiCompatible[]` with `{id, label, baseUrl, apiKey, models?}`.
Affects: `packages/protocol/src/config.ts`, plan §4.1.

## 2026-10-23 · `maxSteps` enforced by schema, not runtime clamp (M0-2)

Context: plan §4.1 says `maxSteps: 30` "(clamp 1–100)" — ambiguous between reject-out-of-range and
silent-clamp. Options: (a) `z.number().int().min(1).max(100)` — config parse fails loudly; (b) unconstrained
in the schema, clamped at use site. Choice: **(a)** — `~/.junior/config.json` is user-authored; a visible
validation error beats silently running a different value than written. The bridge parses config with
`JuniorConfigSchema` at startup, so the error surfaces immediately with a path+message.
Affects: `packages/protocol/src/config.ts`, plan §4.1.

## 2026-10-23 · CLI engine spawn flags — verified matrix for Claude Code 2.1.309 (M0-3)

Context: plan §4.5's spawn args were transcribed from ModelBridge's `bridge_engine.py:775` (built for an
older CLI) and needed verification. Spike: `spikes/cli/flags.sh`, evidence extracts in `spikes/cli/evidence/`.
Findings that fork the plan's args:

1. `--thinking` exists but takes `enabled|adaptive|disabled` — **not** an effort/budget suffix as §4.5
   assumed. Effort is a separate flag: `--effort low|medium|high|xhigh|max` (lenient — invalid values warn
   and are ignored, so the bridge must validate before spawning).
2. `--output-format stream-json` **requires `--verbose`** in `--print` mode (hard error otherwise).
3. `--tools ""` disables **all** built-in tools (verified: init event `"tools":[]`), so the ModelBridge-style
   `--disallowedTools Bash,Read,Edit,…` deny-list is unnecessary churn — new built-ins would silently appear
   unless the list tracks CLI releases. `--tools ""` + `--strict-mcp-config` + `--mcp-config` yields a tool
   surface of exactly our MCP tools.

Choice: production args become `claude -p - --output-format stream-json --verbose --include-partial-messages
--tools "" --strict-mcp-config --mcp-config <~/.junior/mcp.json> --allowedTools mcp__junior_browser:* --model
<m> [--effort <level>] [--resume <sid>]`; drop the `--disallowedTools` block from §4.5 (keep the flag noted
for the `allowCliNativeTools` escape hatch, where the deny-list is the *fallback*, not the default).
Affects: plan §4.5 args snippet.

## 2026-10-23 · `--permission-prompt-tool` evaluated and rejected (M0-3)

Context: plan §4.5 asked the M0 spike to evaluate `--permission-prompt-tool` as a nicer alternative to
CLI-level pre-approval. It exists in 2.1.309 (hidden from `--help`) and routes permission prompts to a named
MCP tool. Options: (a) wire approval prompts to a bridge MCP tool via this flag; (b) keep the plan's design —
pre-approve `mcp__junior_browser:*` with `--allowedTools`, and do human approval inside the bridge guard
(approval cards on the queue, 120 s default-deny). Choice: **(b)**. Reasons: (i) Junior's approval flow must
be identical for every client (extension chat, terminal Claude, MCP), and only guard-side approval gives that;
(ii) with `--tools ""` the CLI has no native tools left to prompt for, so the flag has nothing to gate;
(iii) one approval path = one guard = one audit trail. Affects: plan §4.5 (question closed).

## 2026-10-23 · Session continuity via prescribed `--session-id` UUID, not init-capture (M0-3)

Context: §4.5 planned to capture `session_id` from the stream-json init event and pass `--resume` next turn.
2.1.309 adds `--session-id <uuid>` (prescribe an ID). Verified end-to-end: turn 1 with `--session-id
<uuid>`, turn 2 with `--resume <uuid>` recalls context. Choice: the bridge generates a UUID per conversation
(convId can be that UUID) and passes `--session-id` on first turn, `--resume` after — no capture race, and
`--resume` failures mean "session truly missing" rather than "we never learned the ID". Keep reading
`session_id` from init as a log/debug field. Affects: plan §4.5 session-continuity bullet.

## 2026-10-23 · AI SDK pinned to v7, not the plan's v5 (M0-4)

Context: plan §2 row 3 pinned "Vercel AI SDK v5" and §4.5/§5.3 snippets used v5-era names. npm `latest`
is now `ai@7.0.151` (v5 line still tagged `ai-v5` at 5.0.280 but two majors old). The M0-4 spike
(`spikes/ai-sdk/`) verified every Junior surface against v7 + the official 7.0 migration guide: identical
`useChat`/`DefaultChatTransport`/`createOpenAICompatible` shapes; mechanical renames only — `stepCountIs`
→ `isStepCount` (alias kept), `result.toUIMessageStream()`/`toUIMessageStreamResponse()` deprecated in
favor of stateless `toUIMessageStream({ stream: result.stream })` + `createUIMessageStreamResponse`,
`system` → `instructions` (deprecated fallback), `convertToModelMessages` now async. Options: (a) honor
the plan's v5 pin; (b) pin v7 and update the plan. Choice: **(b)** — `ai@7.0.151`,
`@ai-sdk/anthropic@4.0.87`, `@ai-sdk/openai-compatible@2.0.87`, `@ai-sdk/react@4.0.155` (peer matrix:
`@ai-sdk/*` 2.x ↔ ai 5, 3.x ↔ ai 6, 4.x ↔ ai 7; zod peer `^3.25 || ^4.1` covers our 4.6.5; react
`^18 || ^19` covers M2). Reasons: (i) greenfield, no compat debt either way; (ii) context7 serves
current-major docs by default — a v5 pin would force version-pinned doc pulls every session forever
(the exact drift CLAUDE.md's research rules guard against); (iii) all renames were caught now, in the
spike, instead of mid-M2. Note: CLAUDE.md's library list still says "Vercel AI SDK v5" — left untouched
(user-owned file); this entry is the source of truth. Affects: plan §2 row 3, §3 comment, §4.5 snippet,
§5.3, §7 rules, §8 M0-4.

> **Amendment (2026-10-23, post-M0 review):** the note above saying CLAUDE.md was "left untouched" was
> superseded the same day — the user directed the update, and CLAUDE.md's library list now says
> "Vercel AI SDK v7" (commit 60f8937).

## 2026-10-23 · CORS allowlist takes any Chrome extension id until the manifest pins one (M1-1)

Context: plan §4.2 scopes CORS to `chrome-extension://<our-id>`, but unpacked extensions get a
machine-generated id (the manifest has no `key` field yet), so the bridge cannot know our id at M1.
Options: (a) an `allowedOrigins` config field (frozen-protocol churn for a value we can't fill yet);
(b) accept any `chrome-extension://[a-p]{32}` origin plus explicit loopback patterns, tightening to the
exact id when M2-1 adds a manifest key. Choice: **(b)**. A foreign origin gains nothing readable: every
data route demands the pairing token (401/403), so the wildcard only exposes `GET /api/health` +
`GET /api/pairing` booleans to other installed extensions — acceptable until the pin lands. Follow-up
recorded as a backlog seed (tighten `isAllowedOrigin` in M2-1). Affects: plan §4.2, `apps/bridge/src/auth.ts`.

## 2026-10-23 · Queue envelope tightened to a kind↔payload union; chat engine/provider validated (M1-2)

Context: the post-M0 architect review flagged two protocol holes, both now fixed as part of M1-2.
(1) `QueueItemSchema` had `action`/`approval` both optional, so `{kind:"action"}` parsed with no
payload. Options: (a) flat object + `.refine` on kind↔payload; (b) `z.discriminatedUnion("kind", …)`
with one member per payload. Choice: **(b)** — narrowing comes free at every consumer
(`item.kind === "action"` ⇒ `item.action` is present and typed), a wrong kind reports once instead of
leaking payload errors, and the wire shape is unchanged. (2) `ChatRequestBodySchema`'s defaults
(`engine:"api"` + `provider:"claude-cli"`) combined into the one invalid engine/provider pair. Options:
(a) a second discriminated union over the whole body (zod v4 discriminators are plain literals — a
defaulted `engine` would cost the `{model}` minimal-body shorthand); (b) flat object, `provider`
default flipped to `"anthropic"`, plus a `.refine` biconditional
`(engine === "cli") === (provider === "claude-cli")`. Choice: **(b)** — keeps the plan's flat body
shape and minimal-body ergonomics, and mismatches get one clear error message.
Affects: `packages/protocol/src/queue.ts`, `packages/protocol/src/chat.ts`, plan §3 snippets.

## 2026-10-23 · Extension id pinned via manifest `key` (M2-1) — CORS wildcard retired

Context: M1-1 allowed any `chrome-extension://[a-p]{32}` origin because an unpacked extension's id is
only stable once the manifest carries a `key`. Options: (a) keep the wildcard until store publication;
(b) generate an RSA-2048 keypair now, put the public half in the manifest `key`, and tighten the bridge
allowlist to the derived id. Choice: **(b)** — the id (`ocjlcgidjeodnjicogfmmicpkookeabb`, derived as
SHA-256 of the SPKI DER, first 16 bytes, hex digits mapped a–p) is stable across reinstalls of the
unpacked build, so CORS can be exact. Private key lives at `~/.junior/extension-key.pem` (0600, never
committed); the id is exported as `EXTENSION_ORIGIN` from `@junior/protocol` (single source for the
bridge allowlist and the extension, tripwire test asserts the shape).
Affects: `apps/extension/wxt.config.ts`, `packages/protocol/src/config.ts`, `apps/bridge/src/auth.ts`, plan §4.2.

## 2026-10-23 · shadcn/ui vendored by hand (M2-1), not via the init CLI

Context: plan §5.3 calls for shadcn/ui in the panel. Options: (a) run `pnpm dlx shadcn@latest init` in
the WXT app; (b) follow shadcn's documented manual-install path — `components.json`, Tailwind v4
`@theme inline` CSS variables, `cn()` util, components copied into `src/components/ui`. Choice: **(b)**
— the CLI assumes a framework-shaped project (framework detection, src-dir guesses) and would fight
WXT's `srcDir`/alias layout; manual install is the upstream-supported path, keeps every component
reviewable, and future `shadcn add <component>` still works because `components.json` is present.
Affects: `apps/extension/{components.json,tsconfig.json}`, `apps/extension/src/{lib/utils.ts,components/ui/*,entrypoints/sidepanel/style.css}`.

## 2026-10-23 · Provider keys live in `~/.junior/config.json`, edited via new `/api/config` routes (M2-4)

Context: plan §5.3 said the Anthropic key is "stored `chrome.storage.local`", but the chat registry
(`apps/bridge/src/chat/registry.ts`) resolves keys from bridge config, and the §3 HTTP table (labeled
"complete") had no config route. Options: (a) keys in `chrome.storage.local`, sent per chat request —
splits the key store in two and puts secrets on every request body; (b) keys stay bridge-side in
`config.json` (per §4.1), and Settings→Providers edits them through new token-gated routes
`GET/PUT /api/config` + `POST /api/config/test`. Choice: **(b)** — single source of truth, keys never
cross the wire back (GET returns a masked view; `ProvidersViewSchema` is a strict object so a raw
`apiKey` field fails the parse), and PUT patches use absent-key-means-keep semantics so the UI only
ever sends a key the user typed. Affects: plan §3 HTTP table, §5.3; `packages/protocol/src/config.ts`,
`apps/bridge/src/providers.ts`, `apps/extension/src/lib/bridge-client.ts`.

## 2026-10-23 · Fallback chain lives in bridge config; same model id per candidate (M2-4)

Context: plan §4.5 frames the fallback chain as engine behavior ("on provider-level 4xx/5xx before the
first token, retry next") while §5.3 puts its editor in the extension. Options: (a) chain sent per chat
request in the body; (b) stored as `providers.fallbackChain` in `config.json`, read per request like
every other provider fact. Choice: **(b)** — the chain is bridge behavior and belongs next to the
provider entries it references; the chat wire schema stays untouched. Documented limitation (plan §5.3
does not address it): the requested model id is sent to every candidate unchanged, so chain entries must
understand the same id namespace (e.g. two gateways of the same upstream). Also: `streamText` runs with
`maxRetries: 0` — the chain owns retries, and the SDK's default exponential backoff masked pre-token 5xx
failures in testing. Affects: plan §4.5; `packages/protocol/src/config.ts`, `apps/bridge/src/chat/{routes,fallback}.ts`.

## 2026-10-23 · Chain reorder uses ↑/↓ buttons, not drag (M2-4)

Context: plan §5.3 says "fallback chain (drag to reorder)". Options: (a) HTML5 drag-and-drop now;
(b) up/down buttons. Choice: **(b)** — reorder is a 30-second interaction in a 380 px side panel, and
drag needs a library or fragile DnD plumbing; revisit only if the settings section grows other
drag-orderable lists. Affects: plan §5.3 wording, `apps/extension/src/components/settings/providers-settings.tsx`.

## 2026-10-23 · Executor port deltas — unified in-page entry, hardened empty targets (M3-1)

Context: plan §5.2.3 says "port of Autono's page interaction, simplified" and §6.1 lists the resolver as
copy-near-verbatim. Autono ships one duplicated resolver per executor (click/type each embed their own
copy, background.js:4283–4400 vs 4495–4600). Options: (a) duplicate verbatim per op; (b) one self-contained
`juniorActionInPage(args)` with an `op` discriminator. Choice: **(b)** — `chrome.scripting.executeScript`
serializes only the function body, so a single entry is the only way to share the resolver without
string-building source; it is also directly unit-testable against jsdom. Junior deltas baked in: empty
targets never attribute/text-match (Autono's `"" === ""` id check resolves any attribute-less field —
strategy 8's focused-field fallback stays reachable); UIEvent `view` omitted (jsdom rejects cross-realm
windows; Chrome behavior identical); typing cadence parameterized (`charDelayMs`) so tests run at 0 ms;
the visible mouse cursor and A19 abort-sequence flag are not ported (cursor not in §6.1's copy list;
§5.2.6 puts pause in the SW). Navigate + scroll ride along in the runner for switch exhaustiveness —
navigate re-validates via `validateAgentUrl` as defense-in-depth (full enforcement stays bridge-side, M1-4).
Affects: `apps/extension/src/lib/executors/*`, plan §5.2 (no text change — deltas are within "simplified").

## 2026-10-23 · Approval routing deltas — no-panel denies now; grants are session-scoped storage (M3-3)

Context: plan §5.2 item 2 says "approval → forward to panel via Port (`approval_request`); if no panel
open → auto-deny at timeout", and §5.3 specs a 120 s countdown ring. Autono (reference) denies at a
5-minute background-only timer, keeps cards in a Map with no queueing, and does NOT deny when the panel
disconnects. Choices: (a) no-panel waits out the 120 s; (b) no-panel denies immediately with the 120 s
window as the backstop while a card is showing. Choice: **(b)** — the bridge dispatcher already denies
immediately when nobody is connected (§4.3, M1-2), and an approval that can never be answered wastes the
agent's whole action timeout; the plan's "at timeout" wording is honored for the case that matters (card
showing, nobody answers). Panel cards coexist keyed by id (Autono parity), and the countdown ring is
display only — the SW broker's timer is authoritative, so a closed panel still default-denies at 120 s.
Site grants ("Allow … for this session") are stored in `chrome.storage.local` under
`junior_site_grants` and cleared on `browser.runtime.onStartup` — session-scoped like the bridge's
in-memory `grantedSites`, because fakeBrowser (wxt testing) has no `storage.session` to test against.
The "site" button is hidden when the approval has no `siteDomain` (private-network asks can never mint
a grant — Autono's `allowSite: false` rule, background.js:2041). Affects: plan §5.2 item 2 wording,
`apps/extension/src/lib/{port-router,panel-approvals,site-grants,agent-loop}.ts`.

## 2026-10-23 · Work overlay ships as an on-demand unlisted script, not a content-script entrypoint (M3-4)

Context: plan §5.2 item 6 says "inject `content.ts` overlay" and the §5 file tree lists an
`entrypoints/content.ts`. WXT offers two content-script registration modes: `registration:"manifest"`
puts a static `content_scripts` entry in the manifest — M2-1 explicitly built the manifest with none
(§5.1 hygiene) — and `registration:"runtime"` registers via `scripting.registerContentScripts` but
**adds the entrypoint's `matches` to `host_permissions`** (verified against current WXT docs), i.e.
`*://*/*`, gutting the bridge-only host_permissions posture. Choice: **`defineUnlistedScript`
(`entrypoints/overlay.ts` → built `overlay.js`), injected on demand with
`scripting.executeScript({files:["overlay.js"]})`** — the same mechanics buildDomTree already uses, no
manifest surface, and the SW controls exactly when/where the overlay exists. The script is idempotent
(window flag) so repeated injections are no-ops, and it announces `content_ready` so the SW can
re-apply state after a navigation. Autono's ✕-cancel button is trimmed (Junior has no cancel_task
until M4-5 kill/crash; noted as a backlog seed); Write button trimmed (instructions live in the panel).
jsdom quirk folded into the module: `Event.isTrusted` is an own non-configurable getter there, so the
overlay takes a gesture predicate (prod: `e.isTrusted`) that tests inject.
Affects: plan §5.2 item 6 + §5 file tree, `apps/extension/src/entrypoints/overlay.ts`,
`apps/extension/src/lib/work-overlay{,-content}.ts`.

## 2026-10-24 · The M3-5 fake-model harness lands as a `tests/` vitest workspace package, not a standalone script (M3-5)

Context: plan §8 M3-5 says "script that pushes raw queue items … and asserts results — no LLM needed",
and plan §9 mentions Playwright+chromium for the panel e2e. Choice: **`tests/` becomes a pnpm workspace
package (`@junior/tests-e2e`) whose vitest suite IS the harness** — `e2e/harness.ts` boots the REAL
bridge (source, `createApp` + `Dispatcher` + `SessionGuard`) on an ephemeral loopback port and drives
the REAL extension `AgentLoop` + `bridge-client` + executors with raw queue items, so "asserts results"
is a first-class `expect` instead of an ad-hoc exit code, and `pnpm -r test` gates it. Reasons: (a) the
previous milestones' live-wire acceptances used exactly this shape as throwaway harnesses — M3-5 makes
the pattern permanent; (b) real-Chrome Playwright e2e is still plan §9's separate workstream and needs
no LLM either — this harness deliberately stops at the seam Chrome would fill. The "browser" is
`e2e/fake-tab.ts`: a jsdom document per origin with the window's globals blanket-stamped onto
globalThis (Node's own globals snapshotted and preserved, DOM event classes force-stamped because
Node's native `Event` is wire-incompatible with jsdom `dispatchEvent`) so the extension's self-contained
in-page functions run against the active page exactly as `executeScript` would inject them.
Cross-origin navigations swap JSDOM instances (jsdom pushState is same-origin only); same-origin ones
pushState, which keeps the M3-2 `__junior_dom_map` URL-stamp invalidation honest. Sensitive-site flows
use a real domain from the SENSITIVE_SITES table (`chase.com`) with `tests/fixtures/bank.html` as the
page — no network is ever touched; the harness tab is the only "web". Card answers are scripted
(`answerNext`; unscripted cards default to deny so tests fail loudly).
Affects: plan §8 M3-5 wording, `tests/` (new workspace member), `pnpm-workspace.yaml`.

## 2026-10-24 · MCP transport: stateless JSON-mode streamable HTTP (M4-1)

Context: plan §4.6/§3 lists `POST /mcp` + a `GET /mcp/http` "GET leg", transport unspecified beyond
"@modelcontextprotocol/sdk, streamable HTTP". Options: (a) stateful sessions (sessionIdGenerator +
session map, SSE responses, live GET leg); (b) stateless — a fresh `McpServer` +
`WebStandardStreamableHTTPServerTransport` per POST with `enableJsonResponse: true`. Choice: **(b)**.
Tool calls are self-contained request→result round-trips through the dispatcher; persistent sessions
add restart-state and a second lifetime to manage for no capability the browser tools use, and plain
JSON responses are exactly what the `junior-mcp` stdio proxy forwards (ModelBridge's SSE path queued
responses nowhere — plan §7-14). Consequence: the GET listening leg returns 405 (streamable HTTP
permits refusing it; the SDK client treats 405 as "server has no listening leg" and carries on) —
plan §3's `GET /mcp/http` row updated to say so. The per-request server+transport pair is torn down
after the JSON body is drained (its body stream is tied to the transport).
Affects: `apps/bridge/src/mcp/server.ts`, plan §3 HTTP table.

## 2026-10-24 · The §4.2 rate limit meters `tools/call` only (M4-1)

Context: plan §4.2 says "rate-limit `POST /mcp` tool calls (e.g. 30/min burst)" — ambiguous between
all POSTs and tool calls only. Choice: **`tools/call` only**, 30/min burst (rate-limit.ts finally
mounted; the M1-1 backlog seed resolves here). Rationale: the brake exists for quota burn — a model
looping browser actions — while `initialize`/`tools/list`/`ping` are cheap lifecycle calls that a
client may legitimately burst on (re)connect; metering them would false-trip handshakes.
Affects: `apps/bridge/src/mcp/server.ts`, plan §4.2 unchanged (reads correctly under this reading).

## 2026-10-24 · `agent_task` registered as an explicit stub (M4-1)

Context: plan §4.6's catalog includes `agent_task` but the agent engines land in M4-3/M4-4; §4.6 also
says keep tool names stable because terminal-Claude users put them in CLAUDE.md files. Options:
(a) omit the tool until M4-3; (b) register it now, returning `isError` with a pointer to the browse
tools. Choice: **(b)** — the catalog is wire-stable from day one, and an honest "not available yet"
beats a silent tool-list difference between M4-1 and M4-3 clients.
Affects: `apps/bridge/src/mcp/tools.ts`.

## 2026-10-24 · Terminal-Claude integration shape (M4-2)

Context: plan §8 M4-2 names the server `junior` in its `claude mcp add` example and sketches the smoke
test as "navigate to github.com/trending and read_page" against the live web. Two forks. (1) Name: the
CLAUDE.md convention fixes the MCP server as `junior_browser` (tools `mcp__junior_browser__*`) — that
name is what users put in CLAUDE.md files and what `--allowedTools` patterns must match, so the
registration command uses `junior_browser` (plan example updated). (2) Smoke test: an env-gated vitest
suite (`tests/e2e/terminal-claude.smoke.test.ts`, `JUNIOR_E2E_TERMINAL_CLAUDE=1`) runs the REAL CLI
against the M3-5 harness — real bridge + real AgentLoop + the bank fixture — instead of a live
github.com navigation. Rationale: the acceptance criterion is "(a) terminal Claude performs a guarded
click end-to-end with an approval card"; the fixture proves the same guard→card→"once"→execute path
hermetically (no external-site flakiness, no network dependence in CI-shaped runs, and the gating keeps
the default `pnpm -r test` green gate free of model-token spend, same pattern as M0-4's real-gateway
leg). Registration lessons (project-scope approval limbo, `--allowedTools` server-wide form) live in
`progress.md → Learnings` and docs/terminal-claude.md.
Affects: `tests/e2e/terminal-claude.smoke.test.ts`, `tests/e2e/harness.ts` (token exposed), plan §8 M4-2.

## 2026-10-24 · Panel agent-mode trigger: toggle chip, not the §5.3 `/agent` slash command (M4-3)

Context: plan §5.3 sketches the composer with `/` commands (`/agent`, `/chat`, `/pick`); M4-3 needs some
panel affordance that sends `agentMode:true` (acceptance b). Options: (a) implement the `/agent `
prefix command now (and leave `/chat`/`/pick` stubbed), (b) a persistent Agent toggle chip beside the
model badge that applies to subsequent sends until switched off. Choice: **(b)** — a visible toggle
communicates the current mode (slash commands are invisible once sent), it retargets the transport's
memo key exactly like the M2-4 model switch (zero new transport machinery), and `/pick` is already
superseded by the ⌘K palette while `/chat` is the default. The remaining `/` command surface is
recorded as an M5/backlog candidate if real usage wants it; plan §5.3 composer line updated.
Affects: `apps/extension/src/components/chat-panel.tsx`, `apps/extension/src/lib/chat.ts`, plan §5.3.

## 2026-10-24 · Cancel/kill semantics: one global cancel route, timeout-style approval denial (M4-5)

Context: plan §8 accept (d) says "kill mid-task → overlay clears, futures resolve as denied" but names no
wire surface, and the dispatcher's approvals future only resolves `null` (→ the timeout denial string
"approval not answered within 120 s"), so a *cancelled* approval reports BLOCKED_BY_POLICY-timeout text
rather than "cancelled by user". Forks considered: (a) per-conversation/per-engine cancel with scoped
future disposal, (b) one global `POST /api/agent/cancel` → `Dispatcher.dispose` (kills ALL in-flight
actions + approvals + queued items), with approvals resolving as the existing timeout-style deny.
Choice: **(b)** — Junior is a single-user personal bridge; "the user pressed cancel" is inherently global
(the overlay ✕, panel Stop and SIGTERM all mean the same thing), and `dispose()` has existed as the M1-2
seam for exactly this. Per-scope cancel would need conversation tags threaded through queue items for no
real user benefit. The approval-string mismatch is left as-is: the model-visible signal in every case is
a final denial (the agent prompts already treat any deny as final), and threading a third denial flavor
through ApprovalDecision buys nothing. Also: bin SIGINT/SIGTERM disposes then yields ~100 ms before
`process.exit` so the resolved futures' HTTP responses flush (callers see "bridge shutting down" instead
of a reset socket — verified live). Client disconnects (panel Stop) abort via streamText `abortSignal`
+ SIGTERM to the spawned CLI rather than dispose — an aborted chat turn must not nuke a concurrent
terminal-Claude task sharing the dispatcher.
Affects: `apps/bridge/src/dispatcher/{queue,routes}.ts`, `apps/bridge/src/bin.ts`,
`apps/bridge/src/chat/{routes,engine-cli}.ts`, `apps/extension/src/entrypoints/background.ts`, plan §3 table / §5.2 item 6 / §8 M4.

## 2026-10-25 · Security pass (M5-3): one global 8 MiB body limit; delimiter strip without the wrapper; surrogate-safe truncation

Context: plan §8 M5-3 asks for a security pass — replay, wrong-token sweep, https-CORS, oversized
payloads, unicode/delimiter fuzz on `read_page`. Three forks surfaced. (1) Body limits: per-route
ceilings (chat 5 MiB, mcp 256 KiB, …) vs one global limit. Choice: **one global 8 MiB** via hono's
`bodyLimit` mounted right after CORS, before auth — `/api/chat` messages are the largest legitimate
body (a 1k-message session with tool outputs, M5-4's perf pass) and 8 MiB is generous headroom above
it; everything else is far smaller; screenshots ride *out* of the bridge in action-results, never in.
Per-route tuning is deferred until a real body size demands it. (2) §6.3-2's "nonce delimiter block":
Junior's prompt assembly is AI-SDK-owned, so `wrapUntrusted` markers around tool output would be noise
without a system-prompt contract explaining them. Choice: **apply the strip, not the wrapper** —
`stripDelimiters`/`sanitizeDeep` (ported verbatim to `@junior/protocol/untrusted.ts`, pure, shared)
run on page-derived ok payloads in BOTH model-facing tool surfaces (chat `runTool`, MCP
`dispatchTool`), with a per-call nonce generated *after* capture (a page can never know it), removing
exactly the tokens that could close or fake an untrusted block. Screenshots are exempt — base64 can
legitimately contain the delimiter words and stripping would corrupt the data URL. Denied/error guard
strings ride through verbatim (bridge-generated, §4.4). (3) Autono's `capFragment`/cap paths can slice
a UTF-16 surrogate pair at the cut (lone surrogate → invalid UTF-8 on the wire); Junior adds
`safeSlice` and uses it in `capToolText`, `capFragment`, and the extension's `capWithNote`. The fuzz
batteries (500-iteration seeded protocol fuzz + extension unicode fuzz + bridge strip tests) pin all
three. `docs/qa.md` created with the security-pass section green (tests + live curl transcript).
Affects: `packages/protocol/src/untrusted.ts`, `apps/bridge/src/{index,mcp/tools,chat/tools}.ts`,
`apps/extension/src/lib/executors/read-page.ts`, plan §6.3-2 unchanged (implemented as specified).

## 2026-10-25 · Perf pass (M5-4): memoized message rows instead of a virtua virtualized list

Context: plan §5.3 specifies a `virtua` virtualized message list ("Autono renders every message node
and slows down past a few hundred messages"), and M5-4 requires a 1k-message session to scroll
responsively. Measured in jsdom (React Profiler, `chat-panel.perf.test.tsx`): rendering 1000 messages
mounts in ~420 ms, but the un-memoized list re-renders EVERY row (re-parsing every markdown body) on
each streamed delta — an appended exchange costs ~272 ms per commit, and real streaming emits many
commits per second. Choice: **keep plain rendering, extract a `React.memo`-ized `MessageRow` keyed on
message identity** (useChat v7 replaces only the last message object per delta) — the same appended
exchange drops to ~3 ms per commit (~85×), mount unchanged, and the `durations` callback is stabilized
so memo never busts. Virtualization would additionally complicate auto-scroll-to-newest, jsdom tests,
and the session restore (which must render enough to anchor scroll position), for a mount-cost win we
don't need: the 200-session trim + the 20k tool-output sanitize (M5-2) bound a session's rendered
size. `virtua` stays a backlog seed if real-world sessions grow past what memoization covers.
Affects: `apps/extension/src/components/chat-panel.tsx`, plan §5.1 tree + §5.3 message-list bullet.

## 2026-10-25 · Model catalogs persist via `POST /api/config/test`; patch keeps absent `models` (M5-6)

Context: M5-5's real-Chrome pass found OpenAI-compatible providers never got a catalog — `models?` existed
in the config schema with a comment saying "fetched from /models when omitted", but nothing ever fetched
it; Settings Save omitted `models` from the PUT patch; the Test button's fetched list (e.g. 467 OpenRouter
ids) was displayed and discarded. Options: (a) fetch catalogs lazily in `/api/status`; (b) extension Save
sends models; (c) persist the catalog bridge-side when the Test button fetches it. Choice: **(c)** — the
Test button is already the only thing that fetches `{baseUrl}/models`, so its result is stored on the
entry (`withPersistedModels`) and flows out through the existing masked view + `/api/status` with zero new
wire shapes; a lazy `/api/status` fetch would add a 10 s network stall to the picker's bootstrap route.
Two supporting semantics: PUT patches treat absent `models` like absent `apiKey` (keep existing; explicit
array replaces, `[]` clears) so a stale Settings draft can't wipe a persisted catalog; and
`resolveChatTarget` skips providers with no resolvable model instead of emitting `model: ""` (an empty
string would 400 at the bridge). Anthropic stays on the UI-side well-known fallback list — persisting its
catalog too would need a `ProvidersConfigSchema` field for no user-visible gain. Affects:
`apps/bridge/src/providers.ts`, `apps/extension/src/lib/chat.ts`, plan §4.1 + §5.3, protocol `config.ts`
comment only.

## 2026-10-25 · Agent page actions get runtime `<all_urls>` via `optional_host_permissions` (M5-7)

Context: the real-Chrome pass (M5-5) found every agent-mode page action failing on real sites with
"Extension manifest must request permission to access this host": navigation (`tabs.update`) needs no
origin access, but `chrome.scripting.executeScript` (read_page/click/type + overlay injection) needs the
tab origin's, and the manifest pinned `host_permissions` to the bridge only per plan §5.1's clean-install
posture. `activeTab` grants die on cross-origin navigation, so the agent loop was broken on all real
sites — every prior e2e smoke ran on localhost fixtures, so this was never exercised. Options:
(a) static `host_permissions: ["<all_urls>"]` — installs as "read and change all your data on all
websites", gutting §5.1's posture at install time; (b) per-site grants surfaced/approved one card at a
time — heavy UI, and the approval card is already the behavioral gate on top of site access; (c) —
CHOSEN — `optional_host_permissions: ["<all_urls>"]` keeps install-time access bridge-only, and the
agent-mode composer send (a user gesture — the only context Chrome allows the dialog in) checks
`chrome.permissions.contains({origins:["<all_urls>"]})` and calls `chrome.permissions.request` once when
absent, showing Chrome's one-time all-sites dialog. Plain chat never triggers the gate. A denial still
runs the task (navigation works) but surfaces a visible "page actions will fail" notice (the
bridge-offline banner pattern). `activeTab` stays as-is for gesture-granted one-shot cases. After a
denial, Chrome resolves subsequent `request` calls false without re-showing the dialog — the notice
points at the extension's site-access settings instead of a retry button. Tests seam `chrome.permissions`
behind a two-method `PermissionsGate` (wxt's fakeBrowser implements none of the permissions API).
Affects: `apps/extension/wxt.config.ts`, `apps/extension/src/lib/host-permissions.ts`,
`apps/extension/src/components/chat-panel.tsx`, plan §5.1.

## 2026-10-25 · Last-panel-port disconnect denies pending approvals immediately (M5-9)

Context: the real-Chrome pass reproduced a hard hang — with a card pending, CLOSING the side panel lost
the card and its 120 s default-deny; the task never resolved (open panel: card + 120 s deny worked).
Root cause: the extension-side window is a `setTimeout` in `PanelApprovalBroker` inside the MV3 service
worker. While a card is pending the AgentLoop is not long-polling (no fetch keepalive), and once the
panel closes there are no port events either — the SW goes idle and Chrome suspends it, destroying the
timer and the pending promise; nothing ever posts a decision, and the bridge item sits answered-by-
nobody until the bridge's own `withTimeout` backstop fires. The SW-owned disconnect path did nothing:
`PortRouter` just evicted the port. Options: (a) deny pending cards when the LAST panel port
disconnects; (b) keep the SW alive across the card window (alarms/keepalive gymnastics); (c) rely on
the bridge's 120 s backstop and treat the lost card as cosmetic. Choice: **(a)** — nobody is left who
could ever answer, so waiting out the window serves nothing (§4.3's own "no-panel ⇒ deny now" rule,
applied at disconnect instead of only at request time); it closes the hang by construction (a closed
panel leaves ZERO pending timers, so there is nothing for a suspension to drop), the awaiting loop
wakes and unwinds normally (decision posted, overlay hidden, status idle), and cards close with the
already-defined `approval_resolved by:"no-panel"`. Residual: a card pending while the panel stays OPEN
but fully idle could still lose its SW timer to suspension — there the bridge `withTimeout` backstop
(denies at the window; now pinned by its own delivered-but-unanswered test) is the contract, and the
user's repro showed the open-panel case works live. Reopen truth: `task_status` broadcasts are
fire-and-forget, so a panel connecting mid-task had to guess "idle" — a `TaskStatusTracker` now holds
the SW's last state and every connect receives it right after `init_state`. Affects:
`apps/extension/src/lib/port-router.ts`, `panel-approvals.ts`, `task-status.ts` (new),
`entrypoints/background.ts`, plan §5.2 item 2.

## 2026-10-26 · Agent tab isolation: one pinned "Junior" tab, no per-action active-tab resolution (T1)

Context: the user reported `read_page` outline/text/section returning **Gmail and WhatsApp Web
content** while `get_active_tab` reported the task's site (tldr.tech). Root cause: every action
resolved "active tab" per call (`executeAction` → `chrome.tabs.query({active, lastFocusedWindow})`),
so the user switching tabs mid-task retargeted the injection — a privacy leak (private page content
to the model) and broken reads. Options: (a) pin a task-scoped tabId in the SW and thread it through
every executor call; (b) give the agent its OWN tab — reuse/create a pinned tab in a dedicated
"Junior" tab group and resolve every action against it; (c) keep active-tab resolution but re-check
task start. Choice: **(b)** (user-driven design) — it fixes the race by construction (the same id
answers for the whole task regardless of focus), makes the agent visible and inspectable (the user
can watch its tab), keeps `get_active_tab` honest within agent context ("the agent tab IS the active
tab"), and confines the work overlay to the agent tab. The tab persists across tasks (it is Junior's
workspace) and is recovered after an SW restart via `storage.local` `junior_agent_tab` + a tabGroups
title search; grouping is labeling only (a working ungrouped tab beats a failed create — fakeBrowser
and older Chrome degrade). Multi-window policy (v1): the tab lives in the window where it was
created; cross-window agent tasks stay an M6 seed. No protocol change: tab targeting is an extension
compose-root concern (`withAgentTab` wraps the ExecutorEnv), so the bridge and the model never see
tab ids. Screenshot follow-on: `captureVisibleTab` only sees the ACTIVE tab of a window, so the
screenshot op now reveals the agent tab (`tabs.update {active:true}`, no window focus change) and
captures by that tab's `windowId` — the user's page can never leak into an agent screenshot. Affects:
`apps/extension/src/lib/agent-tab.ts` (new), `executors/index.ts`, `entrypoints/background.ts`,
`wxt.config.ts` (`tabGroups` permission), harness (`tests/e2e/`).

## 2026-10-26 · Pending cards + pause survive MV3 suspension: storage.session ledger + deadline alarms (T4)

Context (review.md §3.3 + §4.1): while a card is pending (no long-poll in flight) or the loop is
paused (polling stopped), Chrome suspends the idle SW ~30 s in; the broker's pending Map + 120 s
`setTimeout` and the loop's `paused` flag die. A panel Deny posted to the fresh SW was dropped,
the old card lingered as a ghost, and a paused agent silently resumed. **Storage:** options were
`storage.local` (the workplan's wording) or `storage.session`. Choice: **session**. It is in-memory
for as long as the extension is loaded, so it survives SW termination, and Chrome clears it on
browser restart, extension reload/update and disable. That is exactly the lifetime of the facts
stored: the bridge futures a card answers and the task a pause froze are gone after a restart, and
a fresh browser must not boot paused or replay cards. It is also TRUSTED_CONTEXTS by default
(content scripts cannot read card contents) and 10 MB. One key per card
(`junior_pending_approval:<id>`: id, approval, createdAt, deadline, origin) avoids
read-modify-write races between cards, and `junior_paused` holds the pause. **Alarms:** one one-shot
`chrome.alarms` alarm per card (`junior_approval:<id>`, `when`). Per the current Chrome docs a packed
extension's alarm never fires sooner than 30 s after it is set (unpacked has no floor), so the alarm
is armed at `max(deadline, now + 30 s)`. A card whose deadline falls inside that floor is already
expired when the alarm fires and is denied then. An alarm that fires before the deadline re-arms.
While the SW lives, the precise in-memory timer still fires first. Every SW start re-arms the alarms
of the cards it adopts, because the docs warn that alarm persistence can be unpredictable. **Wake
(`createAgentRuntime().ready`, before the first poll):** pause is restored. Expired wire cards are
denied to the bridge with `ApprovalDecision.reason: "timeout"` (a new optional protocol field, so the
bridge answers `BLOCKED_BY_POLICY: approval not answered…` and not a fake `USER_DENIED`). Live wire
cards are adopted with their original deadline, and their answer goes straight to the bridge.
Guard-mirror cards are always denied at wake (`postResult` denied, `SW_RESTART_DENIAL`), because the
execution that raised them died with the SW and cannot resume. Panel answers that arrive before
recovery queue behind it. Every (re)connect sends `approval_sync`, the true card set, which the
panel uses to replace its cards wholesale (no ghosts). Answers clicked while the port is down go to
an outbox. M5-9's last-disconnect deny-all is unchanged. **Deviation found on the way:** the
overlay hid on every `idle`, even while paused. A pause therefore usually left no visible Resume
button, and the panel chip read "idle" after the in-flight action finished. Rule now: the overlay
is visible ⇔ working ∨ awaiting approval ∨ paused, and a finished action reports "paused" while
paused. A woken SW with no panel keeps adopted cards until their alarm (≤ 120 s). It does not deny
them at once, because an open panel reconnects within ~1 s. Affects: `lib/approval-ledger.ts`
(new), `lib/panel-approvals.ts`, `lib/agent-runtime.ts` (new, extracted from `background.ts`),
`lib/agent-loop.ts`, `lib/approval-cards.ts` (new reducer), `hooks/use-approval-cards.ts`,
`protocol/approval.ts`, `bridge/dispatcher/queue.ts`.

## 2026-10-26 · Frame-aware page actions: stateless `f<frameId>:<target>` targets (T5a)

**Context:** executors injected into the top frame only, so a cross-origin iframe (YouTube embed,
payment or sign-in widget) was invisible to `read_page` and unreachable for click/type/scroll.
**Options for the target encoding:** (a) a SW-side global index map (one flat numbering, SW
remembers index → `{frameId, localIndex}`); (b) frame-qualified targets that carry Chrome's own
frameId, `f7:12`. **Choice: (b).** It is stateless: the SW can be suspended between `read_page`
and `click` (T4), and MCP clients replay targets they read earlier. A map would silently go stale
or be lost in both cases, while a stale `f7:` fails loudly ("Frame f7 not found … read_page
again"). The same prefix scopes any target (`f7:Play`, `f7:#player`, an XPath) and a section
selector, and scroll gets an optional `frame: "f7"` (additive protocol field, `FrameRef`).
**Top frame unchanged:** plain targets and `f0:` mean the top frame, through the same
executeScript call as before (no `frameIds`). The top frame's buildDomTree keeps descending
into same-origin iframes it can script, so those elements keep their plain indices and the top
outline is byte-identical to pre-T5a. A child frame reports `coveredByParent`
(`window.frameElement !== null`) and outline modes skip it, so nothing is listed twice. Text
reads include covered frames, because `innerText` never crosses an iframe. **Enumeration:**
`executeScript({target:{tabId, allFrames:true}})` results carry `frameId`, so no
`webNavigation` permission is needed (that permission's warning reads as browsing-history
access). Frames are enumerated for the agent tab only (T1). Without enumeration (or if it
throws), reads see the top frame only and frame targets fail closed. **Safety:** frames whose
URL is restricted (other extensions' iframes, `about:`, `chrome://`) are never read or targeted.
The secret-field refusal runs on the in-frame probe's facts, as in the top frame. The guard
judges both the tab URL and the frame URL and the stricter verdict wins (deny > ask > allow), so
a page grant never covers a frame from another site. **Output:** child frames follow the top
frame under `--- iframe f7 <url> ---` headers, with indices rewritten `[f7:N]`, inside the one
`maxChars` budget. Frames that don't fit are counted in a trailing note. The rewrite can add a few
characters per line beyond the budget. **Found on the way (T1 note):** text/section reads
returned "Injection returned no result" on real pages. The cause was not frames.
`juniorReadTextInPage` called a module-scope helper (`capWithNote` → `safeSlice`), which
`executeScript({func})` does not serialize, so it threw a ReferenceError in the page. The helper
is now inlined. `serialization.test.ts` rebuilds every in-page function from its source text to
catch this class of bug. `plan.md` is unchanged: the post-M5 workplan freezes it unless a story
says to update it. Affects: `lib/executors/frames.ts` (new), `restricted.ts` (moved out of
`index.ts`), `index.ts`, `read-page.ts`, `protocol/actions.ts`, both tool catalogs.

## 2026-10-26 · Strict targets, outline fallback labels, and a separate `media` tool (T5b)

**Context:** on a real Udemy lecture the agent clicked "Home" for `[0]` and a "Photo & Video
Editing Tools" banner for the selector `video`, and had no way to read or reliably toggle
playback. **Root cause of the misclicks:** the vendored buildDomTree sets
`data-highlight-index` on every indexed element and never removes it, while the map is rebuilt
per read. The resolver queried the attribute first (`querySelector`, document order), so after a
re-read (the outline is viewport-scoped, so a scroll renumbers) a stale `0` on the header link
won over the current `0`. Any miss then fell through to fuzzy attribute/text passes, which is how
`video` (the player was zero-size before load, so "not visible") reached a banner containing
"Video". **Choice — strict targets:** an index resolves through the URL-stamped
`__junior_dom_map` only; a syntactically valid CSS selector or XPath must match something visible
or the action fails with "matched nothing visible — no fallback"; only free text runs the fuzzy
passes, exact (attribute, then text) before partial, and reverse containment needs ≥ 3 characters.
Whether a bare word is CSS or text: it is a selector when it contains selector syntax
(`# [ ] > ~ + * = ( ) :`) or every compound starts with a class or a lowercase known tag
(`video`, `button.primary`); `Play`, `Sign in`, `example.com` stay text, and `text:` forces text
(for the rare lowercase tag-like label). Results name the hit (tag, text, href, strategy,
iframe). **Labels:** the labeling is Junior code (`outline.ts`, installed as
`window.__junior_label_of` right before the build); the vendored serializer gains one call site
(patch 4 in `scripts/patch-buildDomTree.mjs`). **Media — new tool vs a `read_page` mode:** a
separate `media` action (`op` state | play | pause | seek | mute | unmute) was chosen. `read_page`
modes are text views of the DOM with no side effects and no per-element targets; media state is
structured, and is useful exactly because it pairs with control on the same `m<N>` / `f7:m<N>`
targets (T5a's stateless scheme — the index is the element's position among the frame's media,
recomputed per call). One tool keeps read and control together, gives one description to teach,
and makes the state read cheap enough to poll after every control. `op: "state"` is a read (no
card, like read_page); every other op takes the click guard + approval path on the media
element's facts. **No `chrome.debugger`** (user decision): autoplay-policy rejections
(`NotAllowedError`) are reported with the muted-play workaround instead of trusted input; when a
frame has no media element at all, play/pause fall back to focusing the player and sending its
key (`k` on YouTube, space elsewhere), reported as best-effort. `plan.md` unchanged (workplan
freeze); the protocol gains the additive `media` action. Affects: `in-page.ts`, `outline.ts`,
`media.ts`, `media-in-page.ts`, `index.ts`, vendored `buildDomTree.js` + patcher,
`protocol/actions.ts`, both tool catalogs (kept in sync by hand until F3 unifies them).
