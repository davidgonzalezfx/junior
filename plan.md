# Junior — Plan & Specification

> **Junior** is a personal Chrome MV3 side-panel AI agent: a Claude-first chat with an agent mode that can
> control the browser, plus a local bridge exposing an **MCP server** so external agents (terminal Claude Code,
> Claude Desktop) can drive the same browser. Inspired by MatiasV3B's Autono + ModelBridge, rebuilt in
> TypeScript with the Vercel AI SDK, fixing their security and performance gaps.

- **Status:** planning complete, implementation not started
- **Working dir:** `/workspace/junior/` (this file is the single source of truth)
- **Reference code (cloned, read-only):**
  - `/workspace/autono-clone/` — Autono Chrome extension (JS, MV3)
  - `/workspace/modelbridge-clone/` — ModelBridge / "Antigravity Bridge" (Python FastAPI)
- **Date of plan:** 2026-10-23

---

## 0. Decisions log (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Language | **TypeScript everywhere** (extension + bridge), pnpm monorepo |
| 2 | Panel stack | **Vite + React 19 + Tailwind v4 + shadcn/ui** |
| 3 | AI SDK | **Vercel AI SDK v7** — bridge engines (Anthropic + OpenAI-compatible) and panel chat (`useChat`); pinned in M0-4 (plan originally said v5 — `docs/decisions.md` 2026-10-23) |
| 4 | MCP directions | **Both**: (a) terminal Claude → bridge MCP server → browser; (b) panel chat agent mode → browser tools |
| 5 | Providers | Claude-first: **Claude CLI** (subscription auth) + **Anthropic API** key + any **OpenAI-compatible** base URL (OpenRouter etc.). Gemini/OpenAI-native and TinyFish search **dropped** |
| 6 | CLI as brain | Bridge spawns `claude` CLI in stream-json mode **with tools enabled** (browser tools via MCP), configurable whether CLI native tools (Read/Edit/Bash) are exposed. Default: browser-only |
| 7 | Tab auto-grouping | **Dropped** (cosmetic in Autono, `background.js:904–955`; not needed by agent mode) |
| 8 | Dropped features | Mascot + all GIFs, border-beam/gradient animations, dictation + vendored Whisper (~4 MB), TinyFish web search, tab grouping, power/shadow display features |
| 9 | Kept from Autono | Work overlay (thin border + pause), approval cards, element picker, session history, streaming markdown |
| 10 | Security fixes | Bridge **enforces pairing token**, CORS locked to extension origin + localhost, default-deny approvals (MatiasV3B's bridge had zero auth — see §7) |
| 11 | UX | ⌘K model/provider command palette **plus** a full `Settings → Providers` section |
| 12 | Platform | Chrome only, MV3, min Chrome 120, **not** published to the Web Store (personal use) |
| 13 | Name | **"Junior"** — like a junior-level employee. Config dir `~/.junior/`, storage keys `junior_*`, bridge port **8620** |

---

## 1. Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│ Chrome (MV3)               │        │ Junior Bridge (Node/TS, Hono)        │
│                            │        │ http://127.0.0.1:8620                │
│ ┌────────────────────────┐ │  HTTP  │                                      │
│ │ Side Panel (React)     │◄┼───────►│ POST /api/chat        (AI SDK stream)│
│ │ chat · picker · cards  │ │        │ GET  /api/status      (providers)    │
│ └───────────▲────────────┘ │        │ POST /mcp             (JSON-RPC/MCP) │
│             │ Port          │        │ GET  /mcp/http       (streamable)    │
│ ┌───────────┴────────────┐ │        │ GET  /api/agent/next-action (poll)   │
│ │ Service Worker         │◄┼───────►│ POST /api/agent/action-result        │
│ │ executors · guard ·    │ │  poll  │ POST /api/agent/approval-response    │
│ │ approval router        │ │        │                                      │
│ └───────────▲────────────┘ │        │ ┌──────────────────────────────────┐ │
│             │ executeScript│        │ │ Dispatcher (queue + futures)     │ │
│ ┌───────────┴────────────┐ │        │ │  ← MCP tools                     │ │
│ │ Page (content scripts) │ │        │ │  ← /api/chat tool loop (AI SDK)  │ │
│ │ buildDomTree · click/  │ │        │ │  ← claude CLI engine (--mcp-config│
│ │ type/read/screenshot   │ │        │ │    loops back into MCP tools)    │ │
│ └────────────────────────┘ │        │ └──────────────────────────────────┘ │
└────────────────────────────┘        │ Engines: ai-sdk (anthropic /         │
                                      │ openai-compatible) · claude CLI      │
     Terminal Claude Code ────────────► MCP server (streamable HTTP or     │
     Claude Desktop (stdio proxy)         stdio proxy) → Dispatcher        │
                                      └──────────────────────────────────────┘
```

**The one core idea:** a single **Browser Dispatcher** in the bridge owns every browser action, and there are
exactly three frontends over it:

1. **MCP server** (`/mcp`, JSON-RPC 2.0 + streamable HTTP; plus a ~90-line stdio proxy for Claude Desktop) —
   used by terminal Claude Code / Claude Desktop / Cursor.
2. **AI SDK tool loop** (`/api/chat`, engine `api`) — panel agent mode without the CLI: the bridge registers
   the same tools via AI SDK `tool()` + zod, `streamText` executes them against the dispatcher.
3. **Claude CLI engine** (`/api/chat`, engine `cli`) — the CLI *is* the agent: bridge spawns `claude -p` with
   `--mcp-config` pointing back at the bridge's own MCP server, so the CLI's native tool/permission machinery
   drives the browser through the exact same path as (1).

The extension is the single **executor**: its service worker long-polls the dispatcher, enforces the
guard/approval policy (ported from Autono), runs page scripts, and routes approval cards to the panel.

### Why this beats the Autono design

- Autono hand-rolls the agent loop in the extension: system prompt + nonce-blocked page dump → model →
  regex-extract `{action: "click"…}` from the reply → execute. Fragile JSON-in-markdown parsing, no native
  tool calls, loop logic frozen into 5,900 lines of `background.js`. Junior deletes that layer: model-native
  tool calls (API engine) or the CLI's own loop (CLI engine).
- Autono's bridge (`ModelBridge`) runs CLIs **tool-less** as dumb completions. Junior flips it: the CLI keeps
  its tools, its permission system, and its session resume, and the browser is just another tool surface.

---

## 2. Monorepo layout

```
junior/
├─ plan.md                        ← this file
├─ package.json                   ← private, pnpm workspaces
├─ pnpm-workspace.yaml            ← apps/*, packages/*
├─ tsconfig.base.json             ← strict, NodeNext for bridge, bundler for extension
├─ .nvmrc                         ← node 22
├─ packages/
│  └─ protocol/                   ← shared zod schemas + types (single source of truth)
│     ├─ package.json             ← name: @junior/protocol
│     └─ src/
│        ├─ index.ts
│        ├─ actions.ts            ← BrowserActionSchema, ActionKind, ReadMode
│        ├─ queue.ts              ← QueueItemSchema, ActionResultSchema
│        ├─ approval.ts           ← ApprovalRequestSchema, ApprovalDecision
│        ├─ chat.ts               ← ChatRequestBody (engine, model, provider, tools…)
│        ├─ status.ts             ← BridgeStatusSchema (providers, cli detection)
│        └─ config.ts             ← BridgeConfigSchema, ExtensionSettingsSchema
├─ apps/
│  ├─ bridge/                     ← name: @junior/bridge
│  │  ├─ package.json             ← hono, @modelcontextprotocol/sdk, ai, @ai-sdk/anthropic,
│  │  │                             @ai-sdk/openai-compatible, zod, tsx (dev)
│  │  └─ src/
│  │     ├─ index.ts              ← Hono app, mounts routers, binds 127.0.0.1:8620
│  │     ├─ config.ts             ← load/save ~/.junior/config.json (port from ModelBridge core/config.py)
│  │     ├─ auth.ts               ← token middleware (Authorization: Bearer <token>), CORS allowlist
│  │     ├─ status.ts             ← /api/status: CLI detection (ports ModelBridge core/auth_status.py)
│  │     ├─ dispatcher/
│  │     │  ├─ queue.ts           ← action queue + futures (port of server/routes_mcp.py:139–175)
│  │     │  ├─ guard.ts           ← ported Autono guard (see §6.3)
│  │     │  └─ approvals.ts       ← approval items on the same queue, timeout → deny
│  │     ├─ chat/
│  │     │  ├─ route.ts           ← POST /api/chat → engine dispatch → UI message stream
│  │     │  ├─ engine-api.ts      ← AI SDK: streamText + tool(); provider registry
│  │     │  ├─ engine-cli.ts      ← claude CLI spawn, stream-json parse, session resume
│  │     │  ├─ tools.ts           ← browser tool definitions (zod) shared by both engines
│  │     │  └─ usage.ts           ← token accounting per request/session
│  │     ├─ mcp/
│  │     │  ├─ server.ts          ← MCP server over streamable HTTP (/mcp) — @modelcontextprotocol/sdk
│  │     │  ├─ stdio-proxy.ts     ← bin/junior-mcp: stdin/stdout JSON-RPC → POST /mcp
│  │     │  │                        (port of ModelBridge mcp_server.py)
│  │     │  └─ tools.ts           ← MCP tool catalog (mirrors chat/tools.ts)
│  │     ├─ health.ts             ← GET /api/health (no auth) + /api/agent/* (token)
│  │     └─ bin.ts                ← `junior-bridge` CLI: run headless, print token QR? (later)
│  └─ extension/                  ← name: @junior/extension
│     ├─ package.json             ← wxt, react, ai (useChat), tailwind, shadcn/ui, cmdk, lucide-react
│     ├─ wxt.config.ts            ← manifest v3, sidepanel, permissions (see §5.1)
│     ├─ public/vendor/
│     │  └─ buildDomTree.js       ← copied from Autono (attribution note, §6.1)
│     └─ src/
│        ├─ entrypoints/
│        │  ├─ background.ts      ← SW: agent client (poller), executors, guard, port router
│        │  ├─ sidepanel/
│        │  │  ├─ index.html / main.tsx / App.tsx
│        │  │  ├─ components/
│        │  │  │  ├─ chat/        ← message list (virtua), composer, tool-part renderers
│        │  │  │  ├─ approval-card.tsx
│        │  │  │  ├─ model-picker.tsx        ← ⌘K palette (cmdk)
│        │  │  │  ├─ settings/    ← Providers, Agent, Security, About
│        │  │  │  ├─ work-overlay-status.ts  ← task state chip (overlay itself lives in content)
│        │  │  │  └─ history/
│        │  │  ├─ hooks/          ← useBridgeStatus, useApprovals (Port), useSessions
│        │  │  └─ lib/            ← ai-sdk transport to bridge, storage wrapper
│        │  ├─ content.ts         ← overlay + pause banner + picker (port of content/content.js, trimmed)
│        │  └─ content.dom.ts     ← buildDomTree loader + element resolvers (see §6.1)
│        └─ lib/
│           ├─ bridge-client.ts   ← fetch wrappers, token handling, backoff poller
│           ├─ guard.ts           ← mirrors packages/protocol decision matrix client-side
│           ├─ executors/         ← click.ts, type.ts, scroll.ts, read.ts, screenshot.ts
│           ├─ storage.ts         ← chrome.storage.local wrapper, debounced writes, migrations
│           └─ pairing.ts         ← token generation (crypto.getRandomValues, 32 bytes hex)
└─ tests/                         ← cross-package e2e later; unit tests live beside sources
```

---

## 3. Protocol spec (`packages/protocol`)

Freeze these schemas in M0; both apps import them. zod v4. Everything crossing the bridge↔extension or
client↔bridge boundary validates here.

```ts
// actions.ts
export const ReadMode = z.enum(["outline", "interactive", "text", "section"]);
export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().max(2048) }),
  z.object({ kind: z.literal("click"), target: z.string().max(512) }),        // index / text / CSS / xpath
  z.object({ kind: z.literal("type"), target: z.string().max(512), text: z.string().max(10000) }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().optional() }),
  z.object({
    kind: z.literal("read_page"),
    mode: ReadMode.default("outline"),
    selector: z.string().max(512).optional(),   // for mode "section"
    maxChars: z.number().int().min(200).max(30000).default(8000),
  }),
  z.object({ kind: z.literal("screenshot") }),
  z.object({ kind: z.literal("get_active_tab") }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
```

```ts
// queue.ts — one envelope for both actions and approval requests (single poll channel)
export const QueueItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),      // unguessable (crypto.randomUUID + hex)
  kind: z.enum(["action", "approval"]),
  action: BrowserActionSchema.optional(),
  approval: ApprovalRequestSchema.optional(),
  createdAt: z.number(),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
});
export const ActionResultSchema = z.object({
  id: z.string(),
  status: z.enum(["ok", "error", "denied"]),
  result: z.unknown().optional(),                      // capped by executor (maxChars etc.)
  error: z.string().max(500).optional(),
});
```

```ts
// approval.ts — computed from REAL page facts, never from model text (Autono rule, keep it)
export const ApprovalRequestSchema = z.object({
  reasonCodes: z.array(z.enum([
    "new_site", "sensitive_site", "private_network", "form_submit",
    "sensitive_label", "secret_field", "incognito", "routine_supervised",
  ])).max(8),
  reasons: z.array(z.string().max(200)).max(8),        // human text for the card
  pageUrl: z.string().max(2048),
  destinationUrl: z.string().max(2048).optional(),
  element: z.object({                                  // probed element facts (Autono background.js:4222)
    tag: z.string().max(30), type: z.string().max(30).optional(),
    text: z.string().max(300).optional(), href: z.string().max(2048).optional(),
    formAction: z.string().max(2048).optional(),
  }).optional(),
  typed: z.string().max(600).nullable().optional(),     // redacted if secret field (never sent)
  siteDomain: z.string().max(300).optional(),
});
export const ApprovalDecisionSchema = z.object({
  id: z.string(),
  decision: z.enum(["once", "site", "deny"]),
});
```

```ts
// chat.ts — POST /api/chat body (AI SDK UI message stream on the response side)
export const ChatRequestBodySchema = z.object({
  engine: z.enum(["api", "cli"]).default("api"),
  provider: z.string().default("claude-cli"),   // "claude-cli" | "anthropic" | <openai-compatible id>
  model: z.string(),                            // e.g. "claude-sonnet-5-5" | "anthropic/claude-sonnet-5.5"
  agentMode: z.boolean().default(false),        // false = no browser tools registered
  cliTools: z.enum(["browser", "all"]).default("browser"),  // CLI engine: expose native tools too?
  system: z.string().max(8000).optional(),      // panel may prepend its own persona bit
});
```

```ts
// status.ts — GET /api/status (drives picker badges + settings)
export const BridgeStatusSchema = z.object({
  version: z.string(), apiLevel: z.number(),
  providers: z.array(z.object({
    id: z.string(), kind: z.enum(["claude-cli", "anthropic", "openai-compatible"]),
    label: z.string(), available: z.boolean(),
    detail: z.string().max(200).optional(),     // e.g. "claude version 2.x — logged in"
    models: z.array(z.object({ id: z.string(), label: z.string().optional(),
      badges: z.array(z.enum(["vision", "tools", "reasoning", "fast"])).default([]) })),
  })),
  browserConnected: z.boolean(),               // extension polled within 25 s
  queueDepth: z.number().int(),
});
```

### Bridge HTTP surface (complete list)

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | liveness only (no data): `{ok: true}` |
| `GET /api/status` | token | `BridgeStatusSchema` |
| `POST /api/chat` | token | AI SDK UI message stream (SSE); body `ChatRequestBodySchema` |
| `POST /mcp` | token | MCP JSON-RPC 2.0 (streamable HTTP transport) |
| `GET /mcp/http` | token | MCP streamable-HTTP GET leg |
| `GET /api/agent/next-action?timeout=15` | token | extension long-poll → `QueueItemSchema \| {item: null}` |
| `POST /api/agent/action-result` | token | `ActionResultSchema` |
| `POST /api/agent/approval-response` | token | `ApprovalDecisionSchema` |
| `GET /api/pairing` | none | `{tokenRequired: true, tokenSet: bool}` — extension onboarding |
| `POST /api/pairing` | token | extension registers/confirms token (idempotent) |

`junior-mcp` stdio proxy (bin) speaks MCP stdio with a local terminal agent and forwards to `POST /mcp` —
same shape as ModelBridge `mcp_server.py` but **sending the token** from `~/.junior/token`.

---

## 4. Bridge spec (`apps/bridge`)

### 4.1 Config & pairing

- Config file `~/.junior/config.json` (schema in `packages/protocol/config.ts`): `port: 8620`,
  `permissionMode: "ask" | "auto" | "none"` (default `ask`), `providers` (anthropic key, openai-compatible
  list `{id, label, baseUrl, apiKey, models?}`), `codeExecution: "off"` (reserved; not implemented in v1),
  `maxSteps: 30` (1–100 enforced by `JuniorConfigSchema` — fail-fast, not runtime clamped; see
  `docs/decisions.md`), `cliPath?: string`, `allowCliNativeTools: false`.
- Token file `~/.junior/token` (0600). On first start, bridge generates 32 random bytes hex
  (port `AutonoSecurity.generatePairingToken`). Extension generates its own and calls `POST /api/pairing`;
  if a token is already set and doesn't match → 403, user must click **Pair** in the bridge console
  (`junior-bridge pair`) which clears the stored token for 60 s. (Simple, explicit, and fixes the
  ModelBridge gap where tokens were sent but never checked.)

### 4.2 Auth middleware (`auth.ts`)

- All routes except `/api/health` and `GET /api/pairing` require `Authorization: Bearer <token>`.
  Constant-time compare (`crypto.timingSafeEqual`).
- CORS: `Access-Control-Allow-Origin` echoed **only** for `chrome-extension://<our-id>` and
  `http://localhost:*` / `http://127.0.0.1:*`; `Access-Control-Allow-Private-Network: true` only for those
  origins. Everything else: no ACAO header (request may still execute but the page can't read the response —
  and mutations still require the token, which a page doesn't have).
- Bind `127.0.0.1` only. Log every rejected auth attempt (origin + path), rate-limit `POST /mcp` tool calls
  (e.g. 30/min burst) as a quota-burn brake.

### 4.3 Dispatcher (`dispatcher/queue.ts`)

Direct TS port of `modelbridge-clone/server/routes_mcp.py:139–175`, plus approvals on the same channel:

```ts
const queue = new AsyncQueue<QueueItem>();            // long-poll awaited get()
const futures = new Map<string, Deferred<ActionResult>>();
let lastBrowserPing = 0;

export async function dispatch(action: BrowserAction, timeoutMs = 120_000) {
  const guardVerdict = await guard.check(action);     // may insert an approval item first
  if (guardVerdict.kind === "deny") return { status: "denied", error: guardVerdict.reason };
  const item: QueueItem = { id: newId(), kind: "action", action, createdAt: Date.now(), timeoutMs };
  const fut = deferred<ActionResult>();
  futures.set(item.id, fut);
  queue.push(item);
  const res = await withTimeout(fut.promise, timeoutMs);
  return res ?? { status: "error", error: `Timed out after ${timeoutMs} ms` };
}
// connected() := Date.now() - lastBrowserPing < 25_000 — surfaced in /api/status and MCP errors
```

`GET /api/agent/next-action` = long-poll `queue.get()` (≤20 s, like ModelBridge `get_pending_actions`).
`POST /api/agent/action-result` resolves the future. Approval items: kind `"approval"`, resolved by
`POST /api/agent/approval-response`; **no panel connected or timeout ⇒ deny** (Autono `requestExternalActionApproval`
default, `background.js:4799–4813`, but 120 s instead of 60 s).

### 4.4 Guard (`dispatcher/guard.ts`) — port Autono's, unchanged in spirit

Copy from `autono-clone/Autono/background.js` + `lib/autono-security.js` (pure string/URL logic — trivially
portable to TS):

- `validateAgentUrl` (`background.js:1876`): public http(s) only; private IPv4/IPv6 (incl. `[::1]`), localhost,
  `.internal`, dot-segments, >2000-char URLs → refuse or require confirm; `blockedOrigins` = extension origin +
  bridge origin (so the agent can't talk to Junior itself).
- `SENSITIVE_SITE_RULES` / `SENSITIVE_ACTION_RE` / `SENSITIVE_FIELD_RE` / OAuth path regex
  (`background.js:1913–1963`) — copy the tables **verbatim** (EN+ES labels).
- Permission matrix (`lib/autono-security.js:283 permissionDecision`):

| | `ask` | `auto` | `none` |
|---|---|---|---|
| new site nav/click | card | allow | allow |
| routine nav (supervised) | card | allow | allow |
| sensitive site / label / form submit | card (even auto) | card | allow |
| secret field typing | **refuse** | **refuse** | **refuse** |
| local/internal address | refuse (card) | **refuse, no card** | allow |

- Guard state per *session* (set of granted domains, page-approved domain), same as `createActionGuard`
  (`background.js:2015–2110`). `checkPage` runs on every `get_active_tab`/`read_page` to catch redirects.
- Denials return the structured strings to the model: `USER_DENIED: …` / `BLOCKED_BY_POLICY: …`
  (Autono `background.js:2007–2009`) so the agent doesn't retry.

### 4.5 Chat engines (`chat/`)

**Shared:** `tools.ts` defines the browser tool set once (zod schemas below); `agentMode: false` registers none.

```ts
// chat/tools.ts (shape; exact zod in code)
navigate({ url }) · click({ target }) · type({ target, text }) · scroll({ direction, amount })
read_page({ mode: "outline"|"interactive"|"text"|"section", selector?, maxChars? })
screenshot() · get_active_tab()
// each execute() => dispatcher.dispatch(...) with guard; results size-capped
```

**Engine `api`** (Anthropic key / OpenAI-compatible via AI SDK):

```ts
import {
  streamText,
  tool,
  isStepCount,
  convertToModelMessages,
  toUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = registry.resolve(body.provider, body.model);   // builds model instance
const result = streamText({
  model: provider.languageModel(body.model),
  instructions: JUNIOR_SYSTEM + (body.system ?? ""),   // v7 renamed `system` → `instructions` (old name = deprecated fallback)
  messages: await convertToModelMessages(body.messages),  // v7: async
  tools: body.agentMode ? browserTools : undefined,
  stopWhen: body.agentMode ? isStepCount(bridgeConfig.maxSteps) : undefined,  // v7: was `stepCountIs` (now a deprecated alias)
  onError: ({ error }) => log.warn(error),
});
return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
// ^ v7 stateless helpers — the result methods (result.toUIMessageStream()/toUIMessageStreamResponse())
//   are deprecated and removed next major (verified M0-4 against ai@7.0.151)
```

- Provider registry: `anthropic` (key from config, never echoed), N × `openai-compatible`
  (`createOpenAICompatible({ name, baseURL, apiKey })` — this is the OpenRouter path).
- Optional per-provider fallback chain: `["anthropic", "openrouter"]` — on provider-level 4xx/5xx before the
  first token, retry next; after first token, surface error (no mid-stream provider switch).

**Engine `cli`** (Claude CLI as the brain):

Port ModelBridge's spawn (`modelbridge-clone/core/bridge_engine.py:775–830`) but **invert the tool policy**:

```ts
const args = [
  cliPath, "-p", "-",
  "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  //                       ^--verbose is REQUIRED with stream-json in -p mode (verified M0-3)
  "--tools", "",                          // zero built-ins: tool surface = exactly our MCP tools
  "--mcp-config", MCP_CONFIG_PATH,        // generated ~/.junior/mcp.json → our own /mcp endpoint
  "--strict-mcp-config",                  // never inherit project/user MCP servers
  "--allowedTools", "mcp__junior_browser:*",   // pre-approve OUR tools at CLI level; the *human*
  //                                             approval still happens in the extension card, enforced
  //                                             by the bridge guard — not by CLI permissions.
  //                                             (--permission-prompt-tool exists but is rejected:
  //                                              decisions.md 2026-10-23 — guard-side approval is
  //                                              client-agnostic and the CLI has nothing to prompt for.)
  "--model", mapModel(body.model),        // ALWAYS explicit — spawned children otherwise inherit
  //                                        settings.json's model (observed in M0-3 spike)
  ...(effort ? ["--effort", effort] : []),      // low|medium|high|xhigh|max; validate before spawn —
  //                                               CLI only warns+ignores bad values (M0-3)
  // (--thinking exists as enabled|adaptive|disabled; only add if product wants a hard toggle)
  ...(sessionIds.has(convId)
    ? ["--resume", sessionIds.get(convId)!]
    : ["--session-id", sessionIds.set(convId, crypto.randomUUID()).get(convId)!]),  // convId-as-UUID
];
// stdin: stream-json user line {"type":"user","message":{"role":"user","content":…}} (verified M0-3)
//        — or plain text via `-p -` (default --input-format text)
```

- `~/.junior/mcp.json` points the CLI at `http://127.0.0.1:8620/mcp` with the token in its env/headers —
  so the CLI's browser tool calls traverse **the same dispatcher + guard + approval cards** as everyone else.
- Pre-approving at CLI level is deliberate: the *human approval* still happens in the extension card, enforced
  by the bridge guard, not by the CLI. (`--permission-prompt-tool` was evaluated in the M0 spike and rejected —
  it exists in 2.1.309 but guard-side approval is identical for every client and the flag has nothing to gate
  once `--tools ""` removes native tools. See `docs/decisions.md` 2026-10-23.)
- Session continuity: the bridge prescribes the UUID — `--session-id <uuid>` (convId-as-UUID) on first turn,
  `--resume <uuid>` on subsequent turns (round trip verified in M0-3). `session_id` from the stream-json `init`
  event is still parsed, for logs/debug only (Autono/ModelBridge never had continuity at all).
- Stream mapping: `text_delta` → text parts; `thinking_delta` → reasoning parts (rendered collapsible);
  tool_use/tool_result events → AI SDK UI message stream tool parts; `result` → finish. Parse errors and
  CLI stderr → error part, never swallowed (ModelBridge hid failures in thought blocks — fixed).
- CLI availability: `junior --version`-style probe (port ModelBridge `core/auth_status.py` detection:
  PATH, Windows npm/WinGet paths, `~/.claude` login check) surfaced in `/api/status`.

**Token accounting** (`usage.ts`): API engine → AI SDK `usage` per step; CLI engine → usage fields from
stream-json `result`. Stored per message and rolled up per session; rendered as chips in the panel.

### 4.6 MCP server (`mcp/server.ts`)

`@modelcontextprotocol/sdk` server, streamable HTTP at `/mcp` (token-auth), tools:

| Tool | Input | Notes |
|---|---|---|
| `junior_status` | – | bridge + browser-connected + providers (port ModelBridge `get_installed_providers`) |
| `get_active_tab` | – | title/url/status |
| `read_page` | mode, selector?, maxChars? | the token-efficient replacement for page dumps |
| `navigate` | url | guard-checked |
| `click` | target | guard-checked (probe → card) |
| `type` | target, text | guard-checked (secret fields refused) |
| `screenshot` | – | base64 PNG data URL, capped size |
| `agent_task` | goal, mode | runs a full agent task in the active tab (only when extension connected) |

Tool results: `content: [{type:"text", text: …}]`, JSON-stringified, size-capped; errors as `isError: true`.
Keep tool names stable — terminal-Claude users will have them in `CLAUDE.md` files.

---

## 5. Extension spec (`apps/extension`)

### 5.1 Manifest (WXT generates it)

- MV3, `side_panel` default `index.html`, `action` opens panel, `minimum_chrome_version: "120"`.
- Permissions: `storage`, `scripting`, `activeTab`, `sidePanel`, `tabs`, `alarms`.
  (`activeTab`+`scripting` programmatic injection only — **no** static `content_scripts`, same as Autono,
  so we don't run code on every page all the time. `host_permissions`: `http://127.0.0.1:8620/*` only.)
- CSP: `script-src 'self'`; `connect-src 'self' http://127.0.0.1:8620` (+`https:` if we ever allow direct
  provider calls from the panel — v1 routes **all** inference through the bridge, so keep CSP tight).
- `chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})` (Autono `background.js:38`) —
  page contexts must never read keys/history/token.
- `web_accessible_resources`: none (mascot gifs are gone).

### 5.2 Service worker (`entrypoints/background.ts`)

Responsibilities (stateless-friendly, all state in `chrome.storage.session`/`local` + bridge):

1. **Pairing**: generate token if missing (`pairing.ts`), `POST /api/pairing`, store config
   (`bridgeUrl` default `http://127.0.0.1:8620`, `permissionMode`, `allowCliNativeTools` mirror).
2. **Agent client**: single long-poll loop `GET /api/agent/next-action` while bridge enabled
   (exponential backoff 1s→30s on failure, jitter; pauses when `browserConnected` heartbeat not needed).
   Item routing:
   - `action` → guard-probe (see 5.3) → execute via executors → `action-result`.
   - `approval` → forward to panel via Port (`approval_request`); if no panel open → auto-deny at timeout.
3. **Executors** (`lib/executors/`): port of Autono's page interaction, simplified:
   - Element resolution — keep Autono's 6-strategy resolver (`background.js:4222–4340`): index map →
     CSS → XPath → semantic attributes → label → visible text. This is good code; copy nearly verbatim
     (reference `content.dom.ts`).
   - **Probe-before-act**: click/type resolve the element first and return real facts (text/href/formAction/
     field name+autocomplete) — these feed the approval card and guard, never the model's description
     (`background.js:4222–4236`).
   - `read_page`: outline = buildDomTree compact interactive list `[index] tag text (href)`; interactive =
     same with roles/values; text = innerText of selector/body capped; section = querySelector subtree.
     Element index cache (`__junior_dom_map`) invalidated on URL change.
   - `screenshot`: `chrome.tabs.captureVisibleTab` → downscale to max 1280px → JPEG q0.6 data URL.
   - Inject `content.ts` on demand (executors that need page context), `buildDomTree.js` for outline mode.
4. **Guard client-side**: mirror of bridge guard tables (so the extension can show cards with the same
   reasons even for panel-originated agent runs). Bridge remains the enforcement point; extension guard is
   for display + defense in depth.
5. **Port router** (panel ↔ SW): `init_state`, `approval_request/response`, `task_status`, `bridge_status`,
   `pick_element` (armed-picker flow, 10-min expiry — port Autono `background.js:5577–5590` but simpler).
   Message firewall: only our own extension pages may use privileged types; content script sendable types
   are an allowlist of 3 (`pick_response`, `overlay_action`, `content_ready`), top-frame only — port of
   Autono `CONTENT_SCRIPT_TYPES` + `isExtPage` checks (`background.js:113, 5592–5610`).
6. **Work overlay control**: on agent activity → inject `content.ts` overlay (thin 2px border + "Junior is
   working" pill + Pause/Resume). Pause = bridge `POST /api/agent/*`? No: pause is local — SW stops polling
   and replies `denied: paused` to items; resume re-enables. (Simpler than Autono's resolver dance.)

### 5.3 Side panel (React)

- **Chat**: AI SDK v7 `useChat` + `DefaultChatTransport({ api: bridgeUrl + "/api/chat", credentials/headers:
  Bearer token })`. Message parts render: markdown (`streamdown` or `react-markdown` + `remark-gfm`;
  KaTeX deferred to backlog), tool-call cards (collapsible: tool, args, result, duration), reasoning
  (collapsible, CLI engine), usage chips (tokens, model, provider).
- **Message list**: `virtua` (virtualized) — Autono renders every message node and slows down past a few
  hundred messages.
- **Composer**: textarea, `/` commands (`/agent`, `/chat`, `/pick`), Enter to send, Shift+Enter newline.
- **⌘K model picker** (`cmdk`): groups = providers from `/api/status`; rows show model + badges
  (vision/tools/reasoning/fast) + "recent" section (localStorage `junior_recent_models`); selection sets the
  per-conversation model badge; the badge itself is a button reopening the palette mid-conversation.
  Autono shipped a raw `<select>` of hardcoded model IDs + text input — replaced entirely.
- **Settings → Providers** (full section, user request #8):
  - Anthropic: API key input (masked, stored `chrome.storage.local`, never rendered back in full),
    "test" button (models list).
  - Claude CLI: detected path/version/login status from `/api/status`; toggle `allowCliNativeTools`.
  - OpenAI-compatible: add/edit/delete entries `{label, baseUrl, apiKey}`; per-entry "fetch models"
    (`GET {base}/v1/models`) with inline validation (port Autono `options/options.js:100` but with the
    `parseBridgeUrl`-style https/loopback check on the base URL).
  - Default provider + model + fallback chain (drag to reorder).
  - Agent & Security: permission mode radio (`ask`/`auto`/`none`) with the matrix rendered as a table,
    maxSteps slider, pairing status + "Re-pair" button.
- **Approval cards**: bottom-sheet card; shows page URL, destination, element facts (real text/href),
  typed-text preview or "secret field (hidden)", reasons; buttons `Allow once / Allow for this site / Deny`;
  120 s countdown ring, timeout = deny. Direct port of Autono's card data contract (`background.js:1966–2010`).
- **History**: sessions list (`junior_sessions` in `chrome.storage.local`), search by text, rename, delete,
  export (markdown). Debounced writes (500 ms) + write-on-hide; trimming beyond 200 sessions with export
  prompt. Single source of truth — Autono duplicated history into `localStorage` *and* `chrome.storage`.
- **Bridge status bar**: `useBridgeStatus` polls `/api/health` (5 s, backoff) → green/red dot + "Start
  bridge" hint (`junior-bridge` command copy button) — fixes Autono's silent-failure UX when the bridge is down.
- **Onboarding** (first run): 3 steps — install bridge command, pair token (auto), pick provider. Skippable.

### 5.4 What is intentionally *not* in the extension

No mascot/animation system, no dictation/Whisper/IndexedDB audio, no web search, no tab groups, no power
management, no context-menu entries (backlog), no `sidepanel.js`-style monolith (everything is a component;
any file >400 lines is a smell to refactor).

---

## 6. What to copy from MatiasV3B (and what to discard)

### 6.1 Copy near-verbatim

| Asset | Source | Notes |
|---|---|---|
| `buildDomTree.js` (1,505 lines) | `autono-clone/Autono/buildDomTree.js` | browser-use-derived interactive-element serializer (MIT lineage — keep its header + add NOTICE). Copy as `public/vendor/buildDomTree.js`, call via `chrome.scripting.executeScript({files:[…]})` then `window.buildDomTree(args)`. Junior changes: brand the map `__junior_dom_map` (Autono uses `__antigravity_dom_map`, `background.js:4250`), and add `mode:"outline"` compact output to cut tokens |
| Element resolver strategies (6 fallbacks) | `background.js:4222–4340` | index map → CSS → XPath → attributes → labels → visible text |
| Sensitive-site/label/field tables (EN+ES) | `background.js:1913–1963` | copy tables verbatim into `guard.ts` |
| Permission decision matrix | `lib/autono-security.js:283–300` | port to `packages/protocol` so bridge+extension agree |
| Untrusted-data nonce block | `lib/autono-security.js:62–120` | still used for anything we interpolate into prompts (CLI engine plain text path) |
| Work overlay + pause banner | `content/content.js:20–140` | strip Autono branding/glows → thin border + pill |
| Strict allowlist HTML sanitizer | `side-panel/sanitize.js` (244 lines) | port to TS for markdown rendering of tool results/model HTML |
| Action queue + futures | `modelbridge-clone/server/routes_mcp.py:139–175, 188–232` | the long-poll protocol works; port to TS with the token check ADDED |
| MCP stdio proxy | `modelbridge-clone/mcp_server.py` | 90 lines; add token header, fix default URL (it still says 8000) |
| CLI spawn flags | `modelbridge-clone/core/bridge_engine.py:775–800` | base flags verified against `claude -p`; we flip tool policy (see §4.5) |
| CLI binary detection | `modelbridge-clone/core/config.py:26–90`, `core/auth_status.py` | PATH/WinGet/npm path candidate lists |
| Guard classification & structured denials | `background.js:2015–2110, 2007–2009` | `USER_DENIED:` / `BLOCKED_BY_POLICY:` strings |
| CSP / manifest hygiene | `autono-clone/Autono/manifest.json` | trusted-contexts storage lock, tight CSP |

### 6.2 Discard (with reason)

- Autono's cowork loop, prompt assembly, JSON-action parsing (`background.js:3460–4130`) — replaced by
  model-native tools / CLI loop.
- All provider routing in the extension (`resolveInferenceEndpoint`, `fetchInferenceWithFallback`,
  `convertOpenAIToAnthropic`, `transformAnthropicStreamToOpenAI`, `background.js:183–775`) — AI SDK does this.
- ModelBridge's Python engine, agy/codex CLIs, quota manager, TTS/STT, updater, GUI, power routes — out of scope.
- Sub-agent `<spawn_agents>` protocol — the CLI engine delegates natively (`Task` tool) when allowed; API
  engine multi-agent deferred to backlog.
- Mascot state machine, dictation/VAD/pcm-worklet, Whisper vendor tree, TinyFish, tab grouping, power/shadow.

### 6.3 Behavioral rules carried over (do not lose these)

1. Everything shown on an approval card is computed from **real probed element/page facts**, never from
   model-provided text (Autono `background.js:4222` comment).
2. Page-derived text that enters any prompt passes through the nonce delimiter block (`stripDelimiters` to
   fixed point).
3. Default answer to any approval is **deny** (timeout or closed panel included).
4. Secret fields are refused in **every** mode; local/internal addresses are refused in `ask`/`auto`
   (`lib/autono-security.js:283` matrix).
5. The agent can never target the extension's own origin or the bridge origin (`blockedOrigins`).
6. Tool/result payloads are size-capped everywhere (`capPlain`/`capFragment` equivalents) — a 5 MB page dump
   must never enter a prompt, a card, or an MCP response.
7. The MCP poller latch: if auth fails repeatedly, the extension **stops** and shows an error; it never
   silently retries into a 401 loop (Autono `setMcpStatus` latch, `background.js:4779`).

---

## 7. Autono/ModelBridge gap analysis → Junior fixes

| # | Gap (observed in MatiasV3B) | Junior fix |
|---|---|---|
| 1 | 10,902-line `sidepanel.js`, no framework, no HMR | React+Vite+WXT; component budget ≤400 lines |
| 2 | Agent loop = regex-extract JSON from markdown; brittle | Native tool calls (API engine) / CLI loop (CLI engine); zod-validated args |
| 3 | Full-page DOM dump every step (~30k chars) → token burn | `read_page` tool with 4 modes + element cache per URL + maxChars caps |
| 4 | Cowork steps don't stream (user stares at overlay) | Everything streams: text, reasoning, tool calls, status via SSE |
| 5 | Bridge auth: pairing token sent but **never verified**; CORS `*` + PNA true | Token enforced (timing-safe), CORS allowlist, rate limit, bind 127.0.0.1 |
| 6 | Approval only exists if panel open; else instant deny (60 s) | Same default-deny but 120 s + SW notification hint to reopen panel |
| 7 | No token/cost visibility anywhere | Usage chips per message + per-session rollup |
| 8 | Model picker = hardcoded list + free-text field | ⌘K palette + Settings→Providers + per-conversation switching |
| 9 | History duplicated localStorage + chrome.storage; unbounded | Single store, debounced writes, quota-aware trimming, export |
| 10 | Chat writes storage on every token batch | Debounced 500 ms batched writes |
| 11 | `mcp_server.py` default URL `:8000` vs bridge `:8765` | One config source; stdio proxy reads `~/.junior/config.json` |
| 12 | Bridge offline = silent failures | Status bar, health poll, copyable start command, auto-reconnect |
| 13 | No CLI session continuity (each turn cold) | `--resume <session-id>` mapped per conversation |
| 14 | SSE MCP transport in ModelBridge queued results nowhere (broken) | Use SDK streamable-HTTP transport; stdio proxy as the universal fallback |
| 15 | 4 MB Whisper + katex + fonts shipped for one feature | Dropped; v1 is text-only, math on backlog |
| 16 | Bilingual strings hardcoded inline | English copy bank module; i18n-ready (not implemented v1) |

---

## 8. Milestones

> Each milestone ends with something runnable and checkable. Steps marked ★ are subagent-friendly
> (parallelizable in fresh sessions without shared context).

### M0 — Scaffold + spike (½ day)
1. `pnpm` monorepo: workspaces, `tsconfig.base.json` (strict), eslint+prettier, `.nvmrc` (22).
2. `packages/protocol` with **all** §3 schemas + unit tests (zod parse round-trips).
3. ★ Spike `claude` CLI stream-json: script that runs the exact §4.5 command set against the installed CLI;
   record which flags exist (`--resume`, `--allowedTools`, `--disallowedTools`, `--thinking`, mcp-config
   behavior) into `docs/decisions.md`. This validates the CLI engine before anything is built.
4. Spike the AI SDK: `streamText` with `@ai-sdk/anthropic` + `createOpenAICompatible` (against a mock
   OpenAI-compatible server and a real gateway), `toUIMessageStream` consumed by a `useChat` client.
   Done in M0-4 — pinned **v7** (plan text said v5; `docs/decisions.md` 2026-10-23).
- **Accept:** protocol tests green; decision doc lists verified CLI flags; spike repo commits.

### M1 — Bridge core (1–2 days)
1. Hono app, config/token/pairing, auth middleware + CORS allowlist (§4.1–4.2).
2. Dispatcher + long-poll endpoints + approvals-on-queue (§4.3) with a **fake executor** test client.
3. `/api/status` with CLI detection (port `auth_status.py`).
4. Guard port + tables + matrix + unit tests (feed it the Autono test cases from `tests/security.test.js`).
- **Accept:** curl-able health/status/pairing; queue round-trip test; guard tests green.

### M2 — Extension shell + chat (2–3 days) ★ (needs M1)
1. WXT scaffold: SW skeleton, side panel React app, Tailwind+shadcn, CSP/manifest per §5.1.
2. Pairing onboarding; `bridge-client.ts` with token + backoff.
3. `useChat` → `/api/chat` engine `api` (Anthropic + OpenRouter) — plain chat, markdown, streaming.
4. ⌘K picker (from `/api/status`) + Settings→Providers (full CRUD + model fetch + fallback chain).
5. History (sessions, debounced writes, search, export).
- **Accept:** chat with Claude (key + OpenRouter) from the panel; picker + settings usable; survives
  bridge restart (auto-reconnect).

### M3 — Browser tool layer (2–3 days) ★ (needs M1; parallel with M2)
1. Executors: click/type/scroll/screenshot/get_active_tab + probe-before-act; element resolver port.
2. `read_page` with modes + `buildDomTree.js` vendored + `__junior_dom_map`.
3. Guard on the extension side (display) + approval cards + Port routing + 120 s deny.
4. Work overlay (thin) + pause/resume.
5. Fake-model harness: script that pushes raw queue items (navigate/click/type/read/screenshot) and asserts
   results — no LLM needed.
- **Accept:** harness executes all actions on real pages incl. a sensitive-site card flow and a secret-field
  refusal.

### M4 — MCP server + both agent paths (2–3 days) (needs M1+M3)
1. MCP server (streamable HTTP) + `junior-mcp` stdio proxy; tool catalog §4.6.
2. Terminal-Claude integration: `claude mcp add --transport http junior http://127.0.0.1:8620/mcp --header
  "Authorization: Bearer <token>"` documented + smoke test ("navigate to github.com/trending and read_page").
3. API engine agent mode: tools → dispatcher loop with `maxSteps`.
4. CLI engine: spawn, mcp-config loopback, `--resume` session map, stream mapping (§4.5), native-tools
  toggle honored.
- **Accept:** (a) terminal Claude performs a guarded click end-to-end with an approval card; (b) panel agent
  mode completes "search hn for junior and open first link" via API engine; (c) same via CLI engine with
  reasoning shown; (d) kill mid-task → overlay clears, futures resolve as denied.

### M5 — Polish + hardening (2 days)
1. Usage chips; tool-call cards; reasoning collapse; empty/error/loading states; bridge-offline banner.
2. Storage migrations + trimming; picker recents; onboarding polish.
3. Security pass: replay an action id, wrong-token sweep, CORS from a https page (must fail), oversized
   payloads, unicode/delimiter-strip fuzz on `read_page` output.
4. Performance pass: 1k-message session scroll, DOM dump size audit (outline ≤ 4k chars typical),
   SW wake count audit (idle = 0 wakes beyond health poll).
- **Accept:** checklist in `docs/qa.md` all green.

### M6 — Buffer / backlog seeds
Element picker (armed tab → "use this element"), KaTeX, i18n, multi-window policy, `agent_task` MCP tool,
notifications when panel closed, Edge/Chromium smoke.

---

## 9. Testing strategy

- **Unit (every milestone):** protocol zod round-trips; guard matrix (port Autono's `tests/security.test.js`
  cases — they are excellent and dependency-free); queue/approval timeouts; token compare; config migration.
- **Bridge integration:** supertest-style with a fake executor client driving the queue; CLI engine tested
  against a **recorded** stream-json fixture (no CLI dependency in CI).
- **Extension:** Vitest for guard/executors' pure parts (element-target parsing, URL validation, capping);
  Playwright + chromium with `--load-extension` for panel e2e (chat against a **mock bridge** on a loopback
  port; agent flows against a local test page `tests/fixtures/page.html` with buttons/forms/secret fields).
- **Manual QA checklist** (`docs/qa.md`): the 4 M4 accept flows + sensitive-site matrix rows + bridge crash
  mid-task + 1k-message scroll.

---

## 10. Risks & open items

| Risk | Mitigation |
|---|---|
| Claude CLI stream-json flags drift between versions | M0 spike pins behavior against installed version; `docs/decisions.md` records the matrix; engine warns on parse gaps instead of failing |
| `--allowedTools` pre-approval weakens CLI-level permission UX | Human approval moves to the bridge guard + cards (equivalent gate); evaluate `--permission-prompt-tool` in M0 spike as upgrade |
| MV3 service worker lifecycle kills the long-poll | Poll loop is the *only* long-lived op; use `chrome.alarms` keep-alive only while an agent task is active; state lives bridge-side so SW restarts are free |
| `captureVisibleTab` needs tab focus; screenshots of background tabs fail | Screenshot tool documents "active tab only" (same as Autono); error surfaced to model |
| OpenRouter models without tool-calling support | Picker badge `tools`; agent mode disables for models without the badge |
| CORS/PNA edge cases on Chrome updates | Auth is header-based (works regardless of CORS); CORS only affects reading responses from web pages — deny by default |
| Personal-use scope creep (publishing) | Keep manifest/CSP store-clean anyway (it costs nothing and keeps options open) |

---

## 11. Fresh-session bootstrap

If you are picking this up in a new session:

1. Read **`progress.md` first** (live state + learnings log), then this file top to bottom; together they are
   self-sufficient. `CLAUDE.md` (auto-loaded in this directory) defines the per-session working protocol —
   one task per session, claim the task in `progress.md`, record learnings, context7 MCP for all library
   research (`https://mcp.context7.com/mcp` is connected for AI SDK / WXT / MCP SDK / shadcn docs).
2. Reference sources: `/workspace/autono-clone/` and `/workspace/modelbridge-clone/` (do **not** commit or
   modify them; copy assets out, note attribution for `buildDomTree.js`).
3. Implement milestones in order; M2 and M3 can run as **parallel subagents** after M1 (they share only
   `packages/protocol`, which is frozen at M0).
4. Every decision that contradicts this plan gets written into `docs/decisions.md` with the reason — the
   plan is updated, never bypassed silently.
5. **Never guess library APIs from memory** — pull current docs via the context7 MCP for `ai` (AI SDK v7),
   `@ai-sdk/*`, `@modelcontextprotocol/sdk`, `wxt`, `cmdk`, `virtua`, zod; pin versions on first use.
5. Naming: package scope `@junior/*`, storage keys `junior_*`, config dir `~/.junior/`, port `8620`,
   MCP server name `junior_browser` (tool prefix `mcp__junior_browser__*`).
