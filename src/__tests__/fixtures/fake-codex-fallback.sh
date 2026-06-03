#!/usr/bin/env bash
# Test fixture for R5 / INV-SESSION-5 fall-through verification.
#
# Behaviour controlled by env vars set by the test:
#   FAKE_CODEX_STATE_DIR   — directory holding the call-count file
#
# Call protocol:
#   - `--version` → prints "codex-cli 0.999.0" (matches readCodexCliVersion regex)
#   - `mcp add`/`mcp remove` → exit 0, no output (silently succeed)
#   - `exec resume <uuid> <prompt>` → first call: emit "no rollout found
#     for thread id <uuid>" on stderr, exit 2. Second call (post-bootstrap):
#     same failure (so engine falls through to plain exec).
#   - `exec <prompt>` (no resume): emit a fake item.completed agent_message
#     on stdout, exit 0.
#
# The state file counts resume-attempt invocations so the test can drive
# the "second attempt also fails → fall-through" path.

set -eu

STATE_DIR="${FAKE_CODEX_STATE_DIR:-/tmp/magnis-fake-codex}"
mkdir -p "$STATE_DIR"
COUNT_FILE="$STATE_DIR/resume_count"

# Helper: log every invocation (debug)
echo "[fake-codex] argv: $*" >> "$STATE_DIR/log" || true

case "${1:-}" in
  --version)
    echo "codex-cli 0.999.0"
    exit 0
    ;;
  mcp)
    # mcp add/remove — silently succeed.
    exit 0
    ;;
  exec)
    shift
    if [ "${1:-}" = "resume" ]; then
      # `exec resume <uuid> <prompt>` — always fail with missing-rollout.
      shift
      uuid="${1:-}"
      # bump counter
      count=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
      echo $((count + 1)) > "$COUNT_FILE"
      echo "Error: thread/resume: thread/resume failed: no rollout found for thread id $uuid" >&2
      exit 2
    else
      # `exec <prompt>` — emit a fake agent_message and exit 0.
      cat <<'EOF'
{"type":"item.started","item":{"id":"agent-1","type":"agent_message"}}
{"type":"item.completed","item":{"id":"agent-1","type":"agent_message","text":"fallback ran"}}
EOF
      exit 0
    fi
    ;;
  *)
    echo "[fake-codex] unknown command: $*" >&2
    exit 1
    ;;
esac
