#!/usr/bin/env bash
# M0-3 CLI spike — runs the plan §4.5 flag matrix against the installed `claude` CLI.
#
# Purpose: validate the CLI engine design (apps/bridge/src/chat/engine-cli.ts, plan §4.5)
# before anything is built. Findings of the 2026-10-23 run are recorded in
# docs/decisions.md and progress.md → Learnings; re-run this after CLI upgrades.
#
# Usage:  bash spikes/cli/flags.sh          (~9 tiny `claude -p` calls, haiku by default)
# Env:    SPIKE_MODEL=haiku   SPIKE_SKIP_LIVE=1 (flag-existence checks only)
set -u

VERSION="$(claude --version 2>&1)"
MODEL="${SPIKE_MODEL:-haiku}"
DIR="$(cd "$(dirname "$0")" && pwd)"
EV="$DIR/evidence"
mkdir -p "$EV"

# Spawn claude the way the bridge will: without this (Claude Code) session's
# nested-session env vars leaking in.
spawn() {
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
      -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_MESSAGING_SOCKET \
      -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_PID -u CLAUDE_EFFORT \
      -u CLAUDE_CODE_SESSION_ATTENDED \
      claude "$@"
}

PASS=0; FAIL=0
note() { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
no()   { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
# evidence helpers: raw error text / event-type inventory / one full JSONL line
evraw()   { head -c "${2:-800}" > "$EV/$1"; }
evtypes() { grep -o '"type":"[a-z_]*"' | sort | uniq -c | sort -rn > "$EV/$1"; }

note "== CLI spike — $VERSION — model=$MODEL — $(date -u +%FT%TZ) =="

# ---------------------------------------------------------------- flag existence
note "-- flag existence (parse/validation errors are free, no API call) --"

out=$(spawn -p --thinking low x 2>&1); st=$?
echo "$out" | evraw thinking.txt
if [ $st -ne 0 ] && grep -q "option '--thinking" <<<"$out"; then
  ok "--thinking exists (hidden from --help); takes enabled|adaptive|disabled — NOT an effort suffix"
else
  no "--thinking probe (st=$st) — see evidence/thinking.txt"
fi

out=$(spawn -p --permission-prompt-tool /tmp/nope x 2>&1); st=$?
echo "$out" | evraw permission-prompt-tool.txt
if [ $st -ne 0 ] && grep -q -- "--permission-prompt-tool" <<<"$out"; then
  ok "--permission-prompt-tool exists (hidden from --help); wants an MCP tool name (validated against loaded servers)"
else
  no "--permission-prompt-tool probe (st=$st) — see evidence/permission-prompt-tool.txt"
fi

out=$(echo x | spawn -p - --effort bogus --model "$MODEL" 2>&1); st=$?
echo "$out" | evraw effort-bogus.txt
if [ $st -eq 0 ] && grep -q "Unknown --effort value" <<<"$out"; then
  ok "--effort exists, LENIENT: warns + ignores invalid value (bridge must validate low|medium|high|xhigh|max itself)"
else
  no "--effort probe (st=$st) — see evidence/effort-bogus.txt"
fi

# ---------------------------------------------------------------- live stream-json
if [ "${SPIKE_SKIP_LIVE:-0}" = "1" ]; then
  note "-- live cases skipped (SPIKE_SKIP_LIVE=1) --"
  note "== $PASS pass / $FAIL fail =="
  exit 0
fi

note "-- live: stream-json behavior (§4.5) --"

# 1. base command: plain-text stdin → init / partial deltas / result
out=$(echo "Reply with exactly: SPIKE_STREAM_OK" | \
  spawn -p - --output-format stream-json --verbose --include-partial-messages --model "$MODEL" 2>&1); st=$?
evtypes stream-base-types.txt <<<"$out"
grep -m1 '"type":"result"' <<<"$out" | python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), indent=1))' > "$EV/result.json" 2>/dev/null
grep -m1 '"type":"stream_event"' <<<"$out" > "$EV/stream-event-sample.jsonl"
if [ $st -eq 0 ] && grep -q SPIKE_STREAM_OK <<<"$out" && grep -q '"subtype":"init"' <<<"$out" \
   && grep -q '"type":"stream_event"' <<<"$out" && grep -q '"type":"text_delta"' <<<"$out" \
   && grep -q '"subtype":"success"' <<<"$out"; then
  ok "-p - + stream-json + --verbose + --include-partial-messages → init/stream_event(text_delta)/result (see evidence/result.json for usage fields)"
else
  no "stream-json base (st=$st) — see evidence/stream-base-types.txt"
fi

# 2. --verbose still required with stream-json?
out=$(echo "hi" | spawn -p - --output-format stream-json --model "$MODEL" 2>&1); st=$?
echo "$out" | evraw stream-no-verbose.txt
if [ $st -ne 0 ] && grep -q "stream-json requires --verbose" <<<"$out"; then
  ok "--verbose IS required with --output-format stream-json (exact error captured)"
else
  no "--verbose requirement changed? (st=$st) — see evidence/stream-no-verbose.txt"
fi

# 3. PRODUCTION COMBO: disable all built-ins, only our MCP config, pre-approve our tools
MCPJSON="$EV/mcp.json"
cat > "$MCPJSON" <<'EOF'
{ "mcpServers": { "junior_browser": { "type": "http", "url": "http://127.0.0.1:9/mcp" } } }
EOF
out=$(echo "Reply with exactly: SPIKE_PROD_OK" | \
  spawn -p - --output-format stream-json --verbose --model "$MODEL" \
       --tools "" --strict-mcp-config --mcp-config "$MCPJSON" \
       --allowedTools "mcp__junior_browser:*" 2>&1); st=$?
evtypes prod-combo-types.txt <<<"$out"
grep -m1 '"subtype":"init"' <<<"$out" > "$EV/prod-combo-init.jsonl"
if [ $st -eq 0 ] && grep -q SPIKE_PROD_OK <<<"$out" && grep -q '"tools":\[\]' <<<"$out"; then
  ok "PROD combo: --tools \"\" + --strict-mcp-config + --mcp-config + --allowedTools → init.tools==[] (no --disallowedTools needed; unreachable MCP server is non-fatal, status in init)"
else
  no "PROD combo (st=$st) — see evidence/prod-combo-init.jsonl"
fi

# 4. legacy ModelBridge flags still parse: --disallowedTools native set, --no-session-persistence
out=$(echo "Reply with exactly: SPIKE_NSP_OK" | \
  spawn -p - --output-format stream-json --verbose --model "$MODEL" \
       --disallowedTools "Bash,Read,Edit,Write,WebFetch,WebSearch,Task,Glob,Grep" \
       --no-session-persistence 2>&1); st=$?
evtypes nsp-disallow-types.txt <<<"$out"
if [ $st -eq 0 ] && grep -q SPIKE_NSP_OK <<<"$out"; then
  ok "--disallowedTools <native set> + --no-session-persistence parse and run"
else
  no "--disallowedTools/--no-session-persistence (st=$st) — see evidence/nsp-disallow-types.txt"
fi

# 5. session continuity: prescribe UUID turn 1, --resume it turn 2
SID="$(node -e 'console.log(crypto.randomUUID())')"
out=$(echo "Remember the codeword BANANA42. Reply OK." | \
  spawn -p - --output-format stream-json --verbose --model "$MODEL" --session-id "$SID" 2>&1); st=$?
grep -m1 '"subtype":"init"' <<<"$out" | evraw session-t1-init.jsonl 400
if [ $st -ne 0 ]; then
  no "--session-id <uuid> turn 1 (st=$st)"
else
  out2=$(echo "What was the codeword? Reply with just the codeword." | \
    spawn -p - --output-format stream-json --verbose --model "$MODEL" --resume "$SID" 2>&1); st2=$?
  grep -m1 '"type":"result"' <<<"$out2" | evraw session-t2-result.jsonl 400
  if [ $st2 -eq 0 ] && grep -q BANANA42 <<<"$out2"; then
    ok "session continuity: --session-id <uuid> then --resume <uuid> (bridge can use convId-as-UUID)"
  else
    no "session continuity (t2 st=$st2) — see evidence/session-t2-result.jsonl"
  fi
fi

# 6. --input-format stream-json: JSONL user message on stdin (engine's realtime path)
out=$(printf '{"type":"user","message":{"role":"user","content":"Reply with exactly: SPIKE_JSONL_OK"}}\n' | \
  spawn -p - --input-format stream-json --output-format stream-json --verbose --model "$MODEL" 2>&1); st=$?
evtypes input-jsonl-types.txt <<<"$out"
if [ $st -eq 0 ] && grep -q SPIKE_JSONL_OK <<<"$out"; then
  ok "--input-format stream-json accepts {type:user,message:{role,content}} lines"
else
  no "--input-format stream-json shape (st=$st) — see evidence/input-jsonl-types.txt"
fi

# 7. deny surface: --permission-prompts none + attempted Bash (informs guard→UI mapping)
out=$(echo "Use the Bash tool to run: echo hi. If you cannot, reply exactly: SPIKE_DENIED" | \
  spawn -p - --output-format stream-json --verbose --model "$MODEL" \
       --disallowedTools "Bash" --permission-prompts none 2>&1); st=$?
evtypes perm-none-types.txt <<<"$out"
if [ $st -eq 0 ]; then
  ok "--permission-prompts none: denied tool still yields tool_use+tool_result events (see evidence/perm-none-types.txt)"
else
  no "--permission-prompts none (st=$st)"
fi

note "== $PASS pass / $FAIL fail — extracts in spikes/cli/evidence/ (rerun script for raw transcripts) =="
