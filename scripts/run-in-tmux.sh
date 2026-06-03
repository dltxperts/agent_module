#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/run-in-tmux.sh <session-name> --cwd <dir> --log <file> [--env-file <file>] [--env KEY=VALUE]... [--replace] [--dry-run] -- <command...>
EOF
  exit 1
}

[ "$#" -ge 1 ] || usage

SESSION_NAME="$1"
shift

CWD=""
LOG_FILE=""
ENV_FILE=""
REPLACE=0
DRY_RUN=0
ENV_VARS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd)
      [ "$#" -ge 2 ] || usage
      CWD="$2"
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
      ENV_VARS+=("$2")
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
    --)
      shift
      break
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$CWD" ] || usage
[ -n "$LOG_FILE" ] || usage
[ "$#" -gt 0 ] || usage

if [ "${#ENV_VARS[@]}" -gt 0 ]; then
  for kv in "${ENV_VARS[@]}"; do
    case "$kv" in
      *=*)
        key="${kv%%=*}"
        case "$key" in
          ''|*[!A-Za-z0-9_]*|[0-9]*)
            echo "invalid env name: $key" >&2
            exit 1
            ;;
        esac
        ;;
      *)
        echo "expected KEY=VALUE, got: $kv" >&2
        exit 1
        ;;
    esac
  done
fi

if [ -n "$ENV_FILE" ] && [ ! -r "$ENV_FILE" ]; then
  echo "env file is not readable: $ENV_FILE" >&2
  exit 1
fi

TMP_SCRIPT="$(mktemp "/tmp/${SESSION_NAME}.agent.XXXXXX")"

{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  if [ -n "$ENV_FILE" ]; then
    printf 'set -a\nsource %q\nset +a\n' "$ENV_FILE"
  fi
  if [ "${#ENV_VARS[@]}" -gt 0 ]; then
    for kv in "${ENV_VARS[@]}"; do
      key="${kv%%=*}"
      value="${kv#*=}"
      printf 'export %s=%q\n' "$key" "$value"
    done
  fi
  printf 'cd %q\n' "$CWD"
  printf 'exec'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf ' >%q 2>&1\n' "$LOG_FILE"
} > "$TMP_SCRIPT"

chmod +x "$TMP_SCRIPT"

if [ "$DRY_RUN" -eq 1 ]; then
  sed -n '1,200p' "$TMP_SCRIPT"
  rm -f "$TMP_SCRIPT"
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [ "$REPLACE" -ne 1 ]; then
    echo "tmux session already exists: $SESSION_NAME" >&2
    rm -f "$TMP_SCRIPT"
    exit 1
  fi
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" "$TMP_SCRIPT"
echo "$SESSION_NAME"
