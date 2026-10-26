# Post-M5 Work Plan — cleanup, correctness, features

> Created 2026-10-26 by the director session (`junior:0.1`). Tracking file for the post-M5
> effort: repo clean-up, review-driven fixes, and the user's feature list. M6 milestone stays
> parked — stories here may overlap M6 seeds where the user called them out (MCP-via-CLI).
>
> Evidence sources: `review.md` (full architectural review, root — line refs quoted here as
> `R§x.y`), the tab-resolution bug report (tmux `junior:2.0`, 2026-10-26), and the user's list.
>
> **Status legend:** `[ ]` todo · `[~]` in progress · `[x]` done (with commit hash)

---

## Process (applies to every story)

- **Worker:** tmux `junior:0.0`. The director (`junior:0.1`) dispatches and verifies. One story
  per worker turn: **send `/clear` first**, then the story brief (long briefs go via
  `printf '%s' "$MSG" | tmux load-buffer -b N -` + `tmux paste-buffer -t junior:0.0 -b N -d`).
- **Verify dispatch started:** capture the pane — expect a spinner line + context ~1% after /clear.
  If Enter won't submit (stale-input quirk), `/clear` wipes it and resend via paste-buffer.
- **DoD per story** (from CLAUDE.md): `pnpm -r typecheck/test/build` + `pnpm lint` +
  `format:check` green; tests for every behavior change; **fail-first regression test for every
  bug fix**; no file over ~400 lines without a stated reason; commits reference the story ID
  (`Wn-n:`) with the session's own attribution trailer; progress notes go in
  THIS file (tick the box + commit hash), not in code comments.
- **Comment policy (whole effort):** remove process-narrative comments (session IDs, "M5-9
  flake" stories, "director's constraints", "Junior delta vs Autono" bookkeeping). Keep
  invariants, gotchas, and why-explanations. Vendored files keep their attribution headers
  (CLAUDE.md rule — never strip those).
- **Don't touch:** `docs/qa.md` (frozen record), `plan.md` except where a story says to update it,
  `review.md` (evidence reference).
- Known red herring to ignore: `read-page.test.ts` 1500-element stress test flakes under full
  parallel load; passes in isolation (seen M5-9 + M5-5 close-out). Rerun isolated before debugging.

---

## Wave C — Clean-up (behavior-preserving; gates + full suite must stay green)

- [x] **C1 — Dead code + comment hygiene sweep** *(~half session)* **DONE 2026-10-26
  (commits f0f2341 + e9f8505):** deleted `PROTOCOL_API_LEVEL` + its tripwire test,
  `wrapUntrusted` (strip half untouched), select()-before-typing in the in-page type op, and
  `PortRouterOptions.onContentMessage` (**deleted, not wired** — content messages travel via
  `browser.runtime.onMessage` and are enforced in `work-overlay.ts` with `contentMessageAllowed`;
  `handleMessage` could only ever dispatch approval_response, so the seam was uninvokable by
  construction and wiring it would have moved the overlay path onto port connections — a behavior
  change). Comment sweep done per policy across apps/ + packages/ (ID tags, learning tags,
  Autono-delta bookkeeping, stale "until X lands" out; invariants/plan refs/attributions/
  decisions.md cites in; the Mx-y inside `mcp/tools.ts` is a runtime string, untouched). Zero-
  caller proofs per item in the commit message. Gates green (166 protocol = −2 deleted tripwires,
  229 bridge, 290 ext, 13 tests incl. 2 gated skip, 5 spikes; the read-page 1500-element flake
  rerun isolated → green).
  - Dead-code inventory (verify zero callers before deleting; delete, don't comment out):
    `PROTOCOL_API_LEVEL = 0` dead constant + its tripwire test (`packages/protocol/src/index.ts:3`,
    R§5.1) — subsumed by H2 if that runs first, skip here to avoid double work;
    `wrapUntrusted` (`packages/protocol/src/untrusted.ts:96`, R§5.7 — decide: implement or
    delete; default **delete**, the strip half stays); `select()`-before-typing dead code
    (`in-page.ts`, R§6.5); `PortRouterOptions.onContentMessage` declared-never-wired seam
    (R§6.5 — delete or wire to the work-overlay firewall check, builder's choice, one paragraph
    in the commit message).
  - Comment sweep per the policy above: process-narrative out, invariants stay. Files with the
    most process comments: `apps/extension/src/lib/executors/in-page.ts`,
    `apps/extension/src/lib/history.ts`, `apps/bridge/src/chat/routes.ts`,
    `packages/protocol/src/untrusted.ts`.
  - DoD: `grep` proof of zero callers for each deletion; gates green; test count unchanged
    (minus deleted dead tripwires).
- [x] **C2 — `@junior/testkit` + test dedup** *(R§6.3, ~1 session)* **DONE 2026-10-26
  (commits 2a2bc3e, 400ffbf, eb5dc0b, fd19b62):** new `packages/testkit` with subpaths
  `./jsdom` (stacked-rect and fixed-origin layout factories kept separate, because they are
  genuinely different layouts), `./wire` (Anthropic + UI-stream SSE), `./cli-stream`, `./chat`
  (UIMessage factories) and `./openai-mock`. Byte-equality pins hold each builder to the
  pre-dedup literals. Over-budget notes retired by extraction + describe-block splits (the
  shared harness was the only reason the files stayed whole): chat-panel 689→299+252,
  engine-cli 630→250+106+182, routes 578→245+118+81, read-page 427→393. Package-local
  harnesses live in `*.test-support.ts` (bridge build excludes them). The spike OpenAI mock
  stays put with a pointer, since it records headers and has a mutable mode. Assertions
  verbatim (407 expect statements, identical multiset); test counts unchanged + 6 testkit pins.
  - New workspace package `packages/testkit`: jsdom layout stub (dedupe 3 copies:
    `tests/e2e/fake-tab.ts:141-166`, `read-page.test.ts:50-58`, `in-page.test.ts:46-65`),
    SSE wire builders (`agent-mode.test.ts:22-93`, `engine-cli.test.ts`, spikes), fake
    UIMessage factories. Retire the over-budget notes on `chat-panel.test.tsx` (689),
    `engine-cli.test.ts` (630), `routes.test.ts` (578) by extraction;
    `read-page.test.ts` (427) shrinks or keeps its note.
  - DoD: no test *behavior* changes — moves + assertions preserved; all suites green; file
    budgets respected.
- [x] **C3 — Light abstractions** *(R§7.4, §5.5, ~1 session)* **DONE 2026-10-26
  (commits ed2040e + cd05e19):** `chat/routes.ts` 269→186 keeps validation + api engine +
  fallback orchestration. The engine "cli" branch moves verbatim to `chat/cli-route.ts`
  (`cliChatResponse`, 70). Both metadata mappers (`cliResultToMetadata` out of
  `engine-cli.ts`, `metadataFrom` out of the handler closure) move to `chat/metadata.ts` (53), and
  the mapper test moves with them to `metadata.test.ts`. Permission-mode enum: one source,
  `PERMISSION_MODES` in `protocol/guard.ts`. Both config schemas use `z.enum(PERMISSION_MODES)`,
  and `PermissionMode`/`normalizePermissionMode` already derived from it. Test counts unchanged.
  **Wave C closed.**
  - Split `chat/routes.ts` (269 lines): CLI branch → `chat/cli-route.ts`, metadata mappers →
    `chat/metadata.ts`. Permission-mode enum written 4× → one exported constant
    (`config.ts:72,94`, `guard.ts:280,285`, R§5.5).
  - DoD: pure moves/renames; no signature changes beyond what the dedup forces.

## Wave T — Correctness (bug fixes; each needs a fail-first regression test)

- [x] **T1 — Agent tab isolation + wrong-tab fix** *(the privacy bug — candidate to jump the queue)*
  **DONE 2026-10-26 (commits 0e12edb + f676d79):** `lib/agent-tab.ts` — `AgentTabManager`
  (cached id re-verified → `junior_agent_tab` recall → tabGroups "Junior" search → create pinned +
  grouped; grouping best-effort) + `withAgentTab` env wrapper; background + harness wire the loop's
  `execute` and the overlay through it; screenshot reveals the agent tab and captures by its
  `windowId`; `tabGroups` permission added. No protocol change (tab targeting never reaches the
  wire). Fail-first: `tests/e2e/agent-tab.test.ts` red pre-fix (`get_active_tab` reported the
  user's mail tab after a focus switch — the reported Gmail/WhatsApp leak), green post-fix.
  Multi-window policy noted in decisions.md (v1: tab lives where created; cross-window = M6 seed).
  - Evidence: tmux `junior:2.0` (2026-10-26): `read_page` outline/text/section returned
    **Gmail and WhatsApp Web content** while `get_active_tab` reported tldr.tech; text/section
    modes fail "Injection returned no result" on the real target page. suspected root: per-action
    "active tab" resolution (`get_active_tab` → chrome.tabs.query) races the user switching tabs;
    injection then targets a different tab than navigation did.
  - Design (user-driven): give the agent **its own tab** — at task start, reuse/create a pinned
    tab in a dedicated **"Junior" Chrome tab group** (`chrome.tabs.group` + `tabGroups` permission,
    color-labeled). All actions (navigate/read/click/type/screenshot) target that tab's **id**
    for the whole task instead of resolving "active" per call. `get_active_tab` returns the agent
    tab within agent context. Overlay injection only in the agent tab. Multi-window policy note
    (M6 seed) folds in here.
  - First step: reproduce the wrong-tab read in the harness (two tabs, switch between probe and
    read) — fail-first. Then implement. Update `docs/qa.md`? No — record the repro in the commit +
    this file instead.
  - Files: `apps/extension/src/entrypoints/background.ts`, `lib/agent-loop.ts`,
    `lib/executors/*` (they take tabId today — verify), `lib/port-router.ts`, manifest
    (`tabGroups` permission), protocol if the action schema needs an explicit tabId field.
- [x] **T2 — CLI stdout line-buffering** *(R§3.1)*
  **DONE 2026-10-26 (commit fcc8e23):** `runCliTurn` holds the trailing partial line until its
  newline and flushes it on close; `setEncoding("utf8")` already decodes split multi-byte chars.
  False-invariant comment removed. Fail-first: `chat/engine-cli.chunking.test.ts` (fake child via
  the spawnImpl seam, deterministic chunk boundaries) 6/8 red pre-fix → 8/8 green.
  - `apps/bridge/src/chat/engine-cli.ts:219-234`: `chunk.split("\n")` loses events split across
    chunk boundaries → "produced no result event" on successful turns. Fix: accumulate + split on
    `\n`, keep the trailing fragment (or `readline.createInterface` like `mcp/stdio-proxy.ts:137`).
    Regression: feed the parser chunks split mid-JSON (the existing tests use tidy chunks — that's
    why it survived).
- [ ] **T3 — Approval-timeout cleanup symmetry** *(R§3.2)*
  - `apps/bridge/src/dispatcher/queue.ts:222-238` + `:188-195`: timeout denies the caller but
    leaves the queued card + orphaned future → a later approve returns `delivered: true` for a
    permission that was already denied. Fix: mirror the action path's cleanup (`futures.delete` +
    `queue.remove`, cf. `queue.ts:140-144`). Regression: queue card with no poller → lapse →
    late approve must be `delivered: false`.
- [ ] **T4 — Alarms-backed deadlines + persisted pause** *(R§3.3 + §4.1, one mechanism)*
  - SW suspension kills the 120 s approval timer + pending map (`agent-loop.ts:146-163`,
    `panel-approvals.ts:62`) and silently un-pauses paused loops (`agent-loop.ts:39,65-70`).
  - Fix: one-shot `chrome.alarms` at the card deadline (permission already declared, never used);
    persist pending-approval ids + `createdAt` AND pause state in `storage.local`; a woken SW
    re-derives both. Ghost-card cleanup panel-side on reconnect.
  - Note: overlaps the reviewed M5-9 area — write the regression against the suspension seam the
    M5-9 test used.
- [ ] **T5 — Video / custom-player / iframe clicking** *(user-reported; partial repro done)*
  - User findings while reproducing: the video was **inside an iframe**; on YouTube the agent
    could **play but not pause**; the model claimed it "can't use CSS selectors" (the resolver HAS
    a CSS strategy, `in-page.ts:132` — so the real gaps are below).
  - Three sub-problems: (a) **iframe targeting** — executors inject into the main frame only;
    a cross-origin iframe needs `chrome.scripting` `frameIds`/`allFrames`, and the outline/`__junior_dom_map`
    must become frame-qualified (index N in frame M); (b) **player controls** — play worked
    (big overlay button is in the click pool) but pause didn't (the `<video>` element and player
    chrome aren't in the CLICK_POOL and live in player shadow DOM; consider a keyboard fallback —
    space/k on the focused player — plus shadow-DOM piercing in the resolver); (c) tool-description
    guidance so models target `<video>`/frame-qualified elements instead of giving up.
  - Verify against YouTube (iframe player) AND a same-origin `<video>` page.
- [ ] **T7 — Screenshot tool consistently fails: "Screenshot failed: Failed to fetch"** *(user-reported 2026-10-26)*
  - Screenshot fails every time with a fetch error — "Failed to fetch" implies a `fetch()` call
    inside the chain is dying (in-page executor ↔ SW message path, or SW ↔ bridge). Trace the
    screenshot path end-to-end (`executors/` → `captureVisibleTab` → dataURL transport), write a
    fail-first test at the seam that actually breaks, fix, and verify against a real page.
  - Order note: T7 before T5 — screenshots are also the debugging tool for T5's player work.
- [ ] **T6 — SessionStore single-writer repair** *(R§4.8)*
  - Rename lost (`App.tsx:102-110` bypasses the store), deleted-active-session resurrection
    (`history-panel.tsx:180`), debounce starvation during long streams (`history.ts:349-352` +
    `chat-panel.tsx:152-154`). Fix: route rename/delete through the store (delete purges pending
    + detaches active); max-latency cap (flush ≤2 s after first pending record). Fail-first tests
    per symptom.

## Wave F — User features

- [ ] **F1 — Claude Code (CLI) as a panel-chat target** *(user: "pick claude-code as the brain")*
  - The CLI engine + `--resume` session map are live since M4-4 (bridge `/api/chat` accepts
    `engine:"cli"`); the panel still filters claude-cli out (`lib/chat.ts` `resolveChatTarget`,
    rewritten comment from M5-6). Wire it: `createChatTransport` gains the `engine:"cli"` branch;
    `resolveChatTarget` admits claude-cli when `status.providers` marks it available; the ⌘K
    picker shows a "Claude Code (CLI)" group (single entry, no model catalog — the CLI owns its
    model map; picker item value encodes provider+model as today). Plain chat + agent-mode
    behaviors must both be covered by tests (agent-mode on CLI = the M4-4 path).
  - Watch: usage metadata for CLI turns already exists (`cliResultToMetadata`, M5-1).
- [ ] **F2 — "New chat" without the History detour** *(user request)*
  - A "＋ New" affordance in the main chat header (beside History/Settings in `App.tsx`): starts a
    fresh session immediately (same code path History's new-session uses), no navigation.
  - Trivial, but do it after F1 or independently — no deps.
- [ ] **F3 — MCP via terminal Claude** *(user: "I plan to use the mcp tools via claude-code cli")*
  - Three parts: (a) **declarative tool catalog** (R§7.2): one source of truth in/next to
    `@junior/protocol` (name → zod schema + action builder + description + caps) rendering BOTH
    `chat/tools.ts` and `mcp/tools.ts` — kills the confirmed 3-copy drift (scroll exists in one,
    not the other); (b) **`scroll` in the MCP catalog** (falls out of (a)); (c) **`agent_task`
    MCP tool** (M6 seed): terminal Claude can delegate a full agent task (plan §4.6 already
    sketches it — check; dispatches through the same queue/approval path).
  - Update `docs/terminal-claude.md` (tool table) at the end.

## Wave H — Hardening + contract (from review.md; recommended subset)

- [ ] **H1 — Death/cleanup hygiene batch** *(R§7.1 remainder; ~1 session, several small fixes)*
  - `AbortSignal.timeout(POLL_TIMEOUT_MS + 5_000)` in `bridgeFetch` (`bridge-client.ts:61-68`,
    R§4.2); fallback-probe first-content deadline 20–30 s (`chat/fallback.ts:59-78`, R§4.6);
    config keys 0600 + chmod-on-load (`config.ts:42-48`, R§4.4); MCP array-body → 400
    (`mcp/server.ts:46-55`, R§4.3); probe→act expect includes `location.href`
    (`in-page.ts:383-394,459-468`, R§4.5 — one line, big security win); CLI session claim on
    success only (`engine-cli.ts:351`, R§4.7). Each with its own small test.
- [ ] **H2 — Mechanical contract gates** *(R§5.1, §5.3, §5.4, §6.4)*
  - Bridge `API_LEVEL` derives from the protocol constant + `fetchStatus` compares it (visible
    "bridge too old" state); real EXTENSION_ID tripwire (derive the id from `MANIFEST_KEY` in the
    test); `no-restricted-imports` eslint rule (extension ↛ bridge); minimal CI (GitHub Action
    running the root gate scripts); gated dist-boot smoke (R§6.5 — e2e boots source, prod runs dist).
- [ ] **H3 — Guard strings + policy consistency** *(R§5.6, §5.8)*
  - Structured denial prefixes (`USER_DENIED:`/`BLOCKED_BY_POLICY:`) as protocol constants; fix
    the unprefixed cancel/timeout paths (`queue.ts:145-151`, `dispatcher/routes.ts:44`) — today
    the model is told only prefixed denials are final, so it may retry a cancelled action.
    Blocked-origin hard block by host+port (not origin-string). SessionGuard `site` grants:
    reset per task (dispose hook) or re-label card copy.

## Wave U — UX (optional; only if the user green-lights)

- From R§8.11, the recommended picks: dark mode wiring (8.1, ~15 lines), Deny=destructive +
  countdown urgency + focus/announce (8.2 subset — doubles as safety-communication),
  smart auto-scroll (8.3), Esc-to-stop, copy-message button, auto-grow composer, loading
  skeletons, paused-dot color. The full 23-item roadmap lives in `review.md` §8.11.
- Already promoted out of this wave: "New chat" → F2.

---

## Suggested order (user-approved 2026-10-26: T1 first)

```
T1                       (privacy leak — approved to jump the queue)
C1 → C2 → C3             (cleanup)
T2 → T3 → T4 → T6        (correctness)
T7 → T5                  (screenshot first — it's T5's debugging tool)
F1 → F2 → F3             (user features)
H1 → H2 → H3             (hardening)
U…                       (optional)
```

## Open questions — ANSWERED 2026-10-26

1. ~~Order~~ → T1 first (user approved).
2. ~~Video repro~~ → iframe player; play-yes/pause-no on YouTube; + new T7 (screenshot "Failed to fetch").
3. ~~MCP scope~~ → BOTH: full catalog + `agent_task` (terminal Claude delegates whole long-running tasks to the agent).
4. ~~New chat placement~~ → top bar beside History/Settings approved.
5. ~~Window 2~~ → ignore its worker; the user now runs the **bridge server there** (bridge console moved from window 1 → `junior:2.0`).

## Progress log (append one line per finished story)

- 2026-10-26 — plan created by director session; nothing dispatched yet.
- 2026-10-26 — T1 done · agent tab isolation (pinned "Junior" group tab; per-action active-tab
  resolution retired) · fail-first wrong-tab e2e red→green + 10 unit tests; gates green
  (168 protocol + 229 bridge + 290 ext + 11 harness incl. 2 gated skip + 5 spikes) · 0e12edb, f676d79
- 2026-10-26 — C1 done · dead-code removal (PROTOCOL_API_LEVEL + tripwire, wrapUntrusted,
  select-before-typing, PortRouterOptions.onContentMessage — deleted not wired) + comment sweep
  across apps/ + packages/ · behavior-preserving; gates green, test count −2 (the deleted dead
  tripwires) · f0f2341, e9f8505
- 2026-10-26 — C2 done · `@junior/testkit` (jsdom stubs, SSE/CLI wire builders, UIMessage
  factories, OpenAI mock) + dedup of the named copies; over-budget notes on chat-panel/engine-cli/
  routes/read-page retired · behavior-preserving, assertions verbatim; gates green (166 protocol +
  229 bridge + 290 ext + 13 tests incl. 2 gated skip + 5 spikes + 6 testkit) · 2a2bc3e, 400ffbf,
  eb5dc0b, fd19b62
- 2026-10-26 — C3 done · chat/routes.ts split (cli-route.ts + metadata.ts) + permission-mode
  enum single-sourced on PERMISSION_MODES · pure moves, zero behavior change; gates green
  (166 protocol + 229 bridge + 290 ext + 13 tests incl. 2 gated skip + 5 spikes + 6 testkit;
  read-page flake rerun isolated → green) · ed2040e, cd05e19 · **Wave C closed**
- 2026-10-26 — T2 done · CLI stdout line-buffering (partial line carried across data chunks,
  flushed on close) · fail-first chunking test red 6/8 → green 8/8 (mid-JSON, mid-UTF-8, 4-chunk
  line, 7-byte chunks, CRLF, no final newline); gates green (166 protocol + 237 bridge + 290 ext +
  13 tests incl. 2 gated skip + 5 spikes + 6 testkit; read-page flake + one engine-cli.route
  5 s timeout under full parallel load, both rerun green) · fcc8e23
