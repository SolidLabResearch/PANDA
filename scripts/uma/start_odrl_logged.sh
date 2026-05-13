#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANDA_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_DIR="$(cd "$PANDA_DIR/.." && pwd)"
UMA_DIR="${PANDA_UMA_REPO_DIR:-$WORKSPACE_DIR/user-managed-access}"
LOG_ROOT="${PANDA_UMA_LOG_DIR:-$PANDA_DIR/benchmark-results/uma-live-logs}"
WAIT_SECONDS="${PANDA_UMA_START_WAIT_SECONDS:-120}"
SEED_DERIVED="${PANDA_UMA_SEED_DERIVED:-true}"
CLEAR_STATE="${PANDA_UMA_CLEAR_STATE:-true}"
CSS_STATE_REL="${PANDA_UMA_CSS_STATE_DIR_REL:-packages/css/tmp-file-backed}"
UMA_STATE_REL="${PANDA_UMA_UMA_STATE_DIR_REL:-packages/uma/tmp-file-backed}"
USE_PAT_INIT="${PANDA_UMA_USE_PAT_INIT:-false}"
MODE="${1:---foreground}"

if [[ ! -d "$UMA_DIR" ]]; then
  echo "[uma:start:logged] ERROR: UMA repo not found at $UMA_DIR" >&2
  exit 1
fi

mkdir -p "$LOG_ROOT"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="$LOG_ROOT/uma-odrl-$TIMESTAMP.log"
LATEST_LINK="$LOG_ROOT/latest.log"
ENV_FILE="$LOG_ROOT/latest-odrl-log.env"
PID_FILE="$LOG_ROOT/latest.pid"
CSS_STATE_PATH="$UMA_DIR/$CSS_STATE_REL"
UMA_STATE_PATH="$UMA_DIR/$UMA_STATE_REL"
START_CMD="corepack yarn start:odrl"

ln -sfn "$LOG_FILE" "$LATEST_LINK"
printf 'export PANDA_UMA_ODRL_LOG_FILE="%s"\n' "$LOG_FILE" > "$ENV_FILE"

wait_for_stack() {
  local ready_as=0
  local ready_css=0
  for ((i=0; i<WAIT_SECONDS; i++)); do
    if curl -fsS "http://localhost:4000/uma/.well-known/uma2-configuration" >/dev/null 2>&1; then
      ready_as=1
    fi
    local css_code
    css_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/" || true)
    if [[ "$css_code" != "000" ]]; then
      ready_css=1
    fi

    if [[ "$ready_as" -eq 1 && "$ready_css" -eq 1 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

mkdir -p "$(dirname "$CSS_STATE_PATH")"
mkdir -p "$(dirname "$UMA_STATE_PATH")"
if [[ "$CLEAR_STATE" == "true" ]]; then
  echo "[uma:start:logged] Clearing previous state ($CSS_STATE_PATH, $UMA_STATE_PATH)..."
  rm -rf "$CSS_STATE_PATH"
  rm -rf "$UMA_STATE_PATH"
fi
mkdir -p "$CSS_STATE_PATH"
mkdir -p "$UMA_STATE_PATH"

if [[ "$MODE" == "--foreground" ]]; then
  {
    echo "[uma:start:logged] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting UMA in foreground"
    echo "[uma:start:logged] repo=$UMA_DIR"
    echo "[uma:start:logged] log=$LOG_FILE"
    echo "[uma:start:logged] css_state=$CSS_STATE_PATH"
    echo "[uma:start:logged] uma_state=$UMA_STATE_PATH"
    echo "[uma:start:logged] PANDA_UMA_ODRL_LOG_FILE=$LOG_FILE"
  } | tee -a "$LOG_FILE"
  cd "$UMA_DIR"
  exec bash -lc "$START_CMD" 2>&1 | tee -a "$LOG_FILE"
fi

{
  echo "[uma:start:logged] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting UMA in detached mode"
  echo "[uma:start:logged] repo=$UMA_DIR"
  echo "[uma:start:logged] log=$LOG_FILE"
  echo "[uma:start:logged] css_state=$CSS_STATE_PATH"
  echo "[uma:start:logged] uma_state=$UMA_STATE_PATH"
} >> "$LOG_FILE"

cd "$UMA_DIR"
nohup bash -lc "$START_CMD" >> "$LOG_FILE" 2>&1 &
UMA_PID=$!
printf '%s\n' "$UMA_PID" > "$PID_FILE"

if ! wait_for_stack; then
  echo "[uma:start:logged] ERROR: UMA stack did not become ready (AS :4000 + CSS :3000) within ${WAIT_SECONDS}s" >&2
  echo "[uma:start:logged] See log: $LOG_FILE" >&2
  if ! kill -0 "$UMA_PID" >/dev/null 2>&1; then
    echo "[uma:start:logged] Start process exited early (pid $UMA_PID)." >&2
  fi
  exit 1
fi

if [[ "$SEED_DERIVED" == "true" ]]; then
  # Re-create the derived resources that the missing script:setup-alice-derived would have created
  echo "[uma:start:logged] Seeding derived resources (alice/spo2/, alice/derived/)..." >> "$LOG_FILE"
  mkdir -p "$CSS_STATE_PATH/alice/spo2"
  mkdir -p "$CSS_STATE_PATH/alice/derived/acc-x"
  mkdir -p "$CSS_STATE_PATH/alice/derived/acc-y"
  
  if corepack yarn run script:seed >> "$LOG_FILE" 2>&1; then
    echo "[uma:start:logged] Derived policies seeded via script:seed" >> "$LOG_FILE"
  else
    echo "[uma:start:logged] WARNING: script:seed failed (check $LOG_FILE)" >&2
  fi
fi

echo "[uma:start:logged] UMA stack is ready (AS :4000, CSS :3000)."
echo "[uma:start:logged] Log file: $LOG_FILE"
echo "[uma:start:logged] PID: $UMA_PID"
echo "[uma:start:logged] Export for strict preflight:"
echo "export PANDA_UMA_ODRL_LOG_FILE=\"$LOG_FILE\""
echo "[uma:start:logged] Env file: $ENV_FILE"
