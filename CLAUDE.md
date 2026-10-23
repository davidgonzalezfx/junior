# Junior — Session Operating Protocol

You are working on **Junior** (see `plan.md` — the specification; `progress.md` — the live state).
Work on **one task, or one small group of related tasks, per session**. This file tells you how.

## Start of every session (mandatory, in order)

1. Read `progress.md` **fully** (it is short). It tells you the current milestone, the claimed task, and
   every learning recorded so far — including library gotchas and CLI flag findings. Do not rediscover them.
2. Skim the `plan.md` sections your task touches (§ references are given per task in `progress.md`).
   The plan is the contract. If your task contradicts it, stop and record the conflict (see "Decisions").
3. Claim your task: edit `progress.md` → "Current task" (one line: task ID + session date). This prevents
   two sessions from doing the same work.

## Task discipline

- **One task at a time.** A task is what `progress.md` lists, nothing more. Ideas discovered mid-work go to
  `progress.md → Backlog seeds`, never into the current diff.
- **Definition of done** (all required before ticking a task):
  - [ ] TypeScript strict, `pnpm -r typecheck` and `pnpm -r test` green (or the task's stated checks)
  - [ ] Task's acceptance criteria from `plan.md` §8 demonstrated (paste the command/output or a short
        transcript into the session log entry)
  - [ ] No file over ~400 lines without a note explaining why
  - [ ] Naming conventions held: `@junior/*` packages, `junior_*` storage keys, port `8620`,
        `~/.junior/` config, MCP server `junior_browser` (tools `mcp__junior_browser__*`)
- **Commits:** one commit per coherent step, message = what + why; reference the task ID
  (e.g. `M1-3: dispatcher queue with approval items (#M1-3)`).

## Library research (context7 MCP is connected)

- **Never guess library APIs from memory.** Before writing code against `ai` (Vercel AI SDK v5),
  `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, `@modelcontextprotocol/sdk`, `wxt`, `cmdk`, `virtua`,
  shadcn/ui, or zod v4 — pull current docs via the context7 MCP (`https://mcp.context7.com/mcp`) for the
  exact function/option names (`useChat` transport, `streamText` + `toUIMessageStream`, MCP streamable-HTTP
  server setup, WXT entrypoint config…).
- Verify the installed version matches the docs you fetched; pin versions in `package.json` at first use.
- **Every gotcha learned (renamed API, missing flag, surprising default) gets one line in
  `progress.md → Learnings`.** That log exists so the next session doesn't pay for this one's debugging.

## Subagents — use them liberally

Keep the main context clean. Offload to subagents (Task tool):
- **Research/exploration** ("find how Autono does X, return file:line + snippet") — point them at
  `/workspace/autono-clone/` or `/workspace/modelbridge-clone/` (read-only, never modify).
- **Independent build work**: after M1, panel tasks (plan §8 M2) and browser-tool tasks (M3) can run as
  parallel subagents — they share only the frozen `packages/protocol`. Give each subagent: the task text,
  the relevant plan §, the protocol schemas, and this protocol file.
- A subagent's findings come back as a summary + evidence (file:line), not file dumps.

## Reference code rules

- `/workspace/autono-clone/` and `/workspace/modelbridge-clone/` are **read-only reference material**.
  Copy assets out (e.g. `buildDomTree.js` → `apps/extension/public/vendor/`), keep attribution headers,
  and cite the source path in a comment above the copy.
- `plan.md` §6 has the exact file:line map of what to copy vs discard — use it instead of re-reading whole files.

## Decisions & deviations

- Anything that contradicts `plan.md`, or any fork with more than one defensible option → append to
  `docs/decisions.md`: date, context, options, choice, reason (one short paragraph). Then update the
  relevant `plan.md` section so the plan stays true. Never bypass the plan silently.
- If blocked >30 min on one error, write the state into `progress.md → Current blockers` and stop or
  switch task — record, don't thrash.

## End of every session (mandatory)

1. Update `progress.md`:
   - Move task: Current → Done (with one-line outcome + evidence).
   - Tick milestone checklist boxes if earned.
   - Append **Learnings** (library APIs, CLI flags, environment quirks — anything the next session needs).
   - Append one line to **Session log**: date · task ID · outcome · commit hash.
   - Set **Next up** to the recommended next task (per `plan.md` §8 order; M2/M3 may interleave).
2. Leave the working tree green: tests passing or the failure explicitly recorded as a blocker.

## Kickoff prompt template (paste this to start a session)

> Read `progress.md`, then `plan.md` §<relevant>. Work task **<ID>** only. Use context7 for any library
> API you're not 100% sure of. Subagent anything exploratory. Update `progress.md` when done.
