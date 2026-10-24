# Using Junior from terminal Claude

Terminal Claude Code talks to Junior through the bridge's MCP server (plan §4.6):
the browser tools traverse the **same dispatcher, guard, and approval-card path**
as the panel chat engines — there is no second enforcement point.

## Prerequisites

1. Bridge running: `junior-bridge serve` (or `pnpm --filter @junior/bridge start`).
   It listens on `127.0.0.1:8620` and auto-mints the token at `~/.junior/token`.
2. The Chrome extension installed and paired (onboarding in the side panel).
   Approval cards surface in the side panel — keep it open while an agent works;
   unanswered cards default-deny after 120 s (`BLOCKED_BY_POLICY`).

## Register the MCP server

```sh
claude mcp add --transport http junior_browser http://127.0.0.1:8620/mcp \
  --header "Authorization: Bearer $(cat ~/.junior/token)"
```

- Default scope is `local` (this project only); use `--scope user` for all projects.
  **Avoid `--scope project`**: `.mcp.json` servers sit "⏸ Pending approval" until an
  interactive `claude` run approves them, so headless `-p` runs never see the tools.
- Pre-approving tools for `-p` runs: pass the **server-wide** form —
  `--allowedTools mcp__junior_browser`. The `mcp__junior_browser:*` wildcard is
  **not** honored by Claude Code 2.1.310 (tools silently land in `permission_denials`).
- Verify: `claude mcp list` → `junior_browser: … - ✔ Connected`.

## Tools

The catalog is exposed as `mcp__junior_browser__*`:

| Tool | Notes |
|---|---|
| `junior_status` | bridge version, `browserConnected`, queue depth, providers |
| `get_active_tab` | title/url/status of the active tab |
| `read_page` | `outline` (default) / `interactive` / `text` / `section` — prefer over screenshots |
| `navigate` | public http(s) only; loopback/private refused; sensitive sites carded |
| `click` / `type` | target = `[index]` from `read_page`, visible text, CSS selector, or XPath; password fields refused in every mode |
| `screenshot` | downscaled JPEG data URL (active tab only) |
| `agent_task` | lands with the agent engine (plan §8 M4-3/M4-4) |

## stdio alternative (Claude Desktop & friends)

`junior-mcp` forwards stdio JSON-RPC to the same `/mcp` endpoint and reads the
same config/token — one source of truth:

```sh
claude mcp add junior_browser -- node <repo>/apps/bridge/dist/mcp/stdio-proxy.js
```

## Smoke test

The guarded-click e2e (M4 acceptance (a)) runs the real CLI against the test
harness — it spends real model tokens, so it is gated behind an env var and
skipped in the normal `pnpm -r test` gate:

```sh
JUNIOR_E2E_TERMINAL_CLAUDE=1 pnpm --filter @junior/tests-e2e exec vitest run terminal-claude
```

Flow: `claude mcp add` registers the ephemeral harness bridge, terminal Claude
calls `get_active_tab` → `read_page outline` → `click` on the sensitive bank
fixture, the `sensitive_site` approval card fires (answered "once" by the
scripted panel), the click executes, and the model reports the post-click
status banner.
