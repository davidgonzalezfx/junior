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
