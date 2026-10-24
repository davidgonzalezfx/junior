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
