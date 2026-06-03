#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/start-agent.sh <session-name> --backend-url <url> --port <port> --log <file> [--cwd <dir>] [--env-file <file>] [--env KEY=VALUE]... [--replace] [--dry-run]
EOF
  exit 1
}

[ "$#" -ge 1 ] || usage

SESSION_NAME="$1"
shift

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

CWD="$AGENT_DIR"
BACKEND_URL=""
PORT=""
LOG_FILE=""
ENV_FILE=""
REPLACE=0
DRY_RUN=0
EXTRA_ENVS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd)
      [ "$#" -ge 2 ] || usage
      CWD="$2"
      shift 2
      ;;
    --backend-url)
      [ "$#" -ge 2 ] || usage
      BACKEND_URL="$2"
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] || usage
      PORT="$2"
      shift 2
      ;;
    --log)
      [ "$#" -ge 2 ] || usage
      LOG_FILE="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || usage
      ENV_FILE="$2"
      shift 2
      ;;
    --env)
      [ "$#" -ge 2 ] || usage
      EXTRA_ENVS+=("$2")
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$BACKEND_URL" ] || usage
[ -n "$PORT" ] || usage
[ -n "$LOG_FILE" ] || usage

CMD=(
  "$SCRIPT_DIR/run-in-tmux.sh"
  "$SESSION_NAME"
  --cwd "$CWD"
  --log "$LOG_FILE"
  --env "BACKEND_URL=$BACKEND_URL"
  --env "AGENT_PORT=$PORT"
)

if [ -n "$ENV_FILE" ]; then
  CMD+=(--env-file "$ENV_FILE")
fi

if [ "${#EXTRA_ENVS[@]}" -gt 0 ]; then
  for kv in "${EXTRA_ENVS[@]}"; do
    CMD+=(--env "$kv")
  done
fi

if [ "$REPLACE" -eq 1 ]; then
  CMD+=(--replace)
fi

if [ "$DRY_RUN" -eq 1 ]; then
  CMD+=(--dry-run)
fi

CMD+=(-- bun src/index.ts)

"${CMD[@]}"
