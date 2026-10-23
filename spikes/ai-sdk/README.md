# M0-4 spike — AI SDK (v7) chat path

Verifies plan §4.5 "Engine api" + §5.3 chat client end-to-end:

```
mock OpenAI-compatible SSE ─┐
                            ├─► handleChat(): streamText → toUIMessageStream ─► node:http
z.ai Anthropic gateway ─────┘                                                        │
les front-end: useChat + DefaultChatTransport (jsdom/RTL test) ◄─────────────────────┘
```

- `src/chat-handler.ts` — the surviving shape: `streamText` + `instructions` +
  `await convertToModelMessages` + `tools`/`isStepCount` →
  `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`.
- `src/mock-openai.ts` — hand-rolled OpenAI `/v1/chat/completions` SSE mock (the
  OpenRouter wire shape), scriptable: plain text or a tool-call round trip.
- `src/spike-chat.tsx` — `useChat` scratch client (text + tool parts, status).
- Tests: `stream-events` (wire shape evidence), `use-chat` (hermetic e2e),
  `gateway-anthropic` (real network; **skips without `ANTHROPIC_API_KEY`**).

Run: `pnpm --filter @junior/spike-ai-sdk test`

Findings live in `progress.md → Learnings` (2026-10-23, M0-4) and
`docs/decisions.md` (v5 → v7 pin). This package is throwaway — M1/M2 re-do it
properly; do not import from apps/.
