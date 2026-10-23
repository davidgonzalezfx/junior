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
