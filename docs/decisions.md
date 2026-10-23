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
