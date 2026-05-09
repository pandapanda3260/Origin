#!/usr/bin/env bash
set -u

PROJECT_DIR="/Users/mark/Documents/origin"
PORT="3000"
DEV_SCREEN="origin-dev"
INTERVAL="${ORIGIN_WATCHDOG_INTERVAL:-30}"
WATCHDOG_LOG="/tmp/origin-watchdog.log"
DEV_LOG="/tmp/origin-next-dev.log"
DEV_PID_FILE="/tmp/origin-next-dev.pid"
LOCK_DIR="/tmp/origin-dev-watchdog.lock"
HEALTH_URL="http://127.0.0.1:${PORT}/api/settings"
AUTH_HEALTH_URL="http://127.0.0.1:${PORT}/api/projects"
BUILD_ERROR_REGEX='Cannot find module.*(vendor-chunks|\.next)|ENOENT.*\.next|webpack\.cache.*ENOENT|MODULE_NOT_FOUND'
MIN_RESTART_INTERVAL="${ORIGIN_WATCHDOG_MIN_RESTART_INTERVAL:-120}"
LOG_BASELINE=0
LAST_AUTO_RESTART=0

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WATCHDOG_LOG"
}

release_lock() {
  local locked_pid
  locked_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$locked_pid" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
}

acquire_lock() {
  local locked_pid

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    trap release_lock EXIT
    trap 'release_lock; exit 0' INT TERM
    return 0
  fi

  locked_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$locked_pid" ]] && kill -0 "$locked_pid" 2>/dev/null; then
    log "another watchdog is already running (pid=$locked_pid); exiting"
    exit 0
  fi

  log "removing stale watchdog lock"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    trap release_lock EXIT
    trap 'release_lock; exit 0' INT TERM
    return 0
  fi

  log "could not acquire watchdog lock; exiting"
  exit 1
}

listening_pids() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

is_origin_process() {
  local pid="$1"
  local cwd cmd cur ppid

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  if [[ "$cwd" == "$PROJECT_DIR"* ]]; then
    return 0
  fi

  cur="$pid"
  for _ in 1 2 3 4 5; do
    cmd="$(ps -p "$cur" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"$PROJECT_DIR"* ]]; then
      return 0
    fi
    ppid="$(ps -p "$cur" -o ppid= 2>/dev/null | tr -d ' ')"
    if [[ -z "$ppid" || "$ppid" == "0" || "$ppid" == "1" ]]; then
      break
    fi
    cur="$ppid"
  done

  return 1
}

ensure_next_vendor_link() {
  local target="$PROJECT_DIR/.next/server/vendor-chunks"
  local link="$PROJECT_DIR/.next/server/chunks/vendor-chunks"

  if [[ -L "$link" && ! -e "$link/next.js" ]]; then
    rm -f "$link"
    log "removed stale Next dev vendor-chunks compatibility link"
  fi

  if [[ -f "$target/next.js" && ! -e "$link" ]]; then
    mkdir -p "$PROJECT_DIR/.next/server/chunks"
    ln -s ../vendor-chunks "$link" 2>/dev/null || true
    log "created Next dev vendor-chunks compatibility link"
  fi
}

origin_related_pids() {
  {
    pgrep -f "$PROJECT_DIR/node_modules/.bin/next dev -p $PORT" 2>/dev/null || true
    pgrep -f "cd $PROJECT_DIR && npm run dev" 2>/dev/null || true
    if [[ -f "$DEV_PID_FILE" ]]; then cat "$DEV_PID_FILE" 2>/dev/null || true; fi
  } | while read -r pid; do
    [[ -n "$pid" ]] || continue
    if is_origin_process "$pid"; then
      echo "$pid"
      pgrep -P "$pid" 2>/dev/null || true
    fi
  done | sort -n -u
}

stop_origin_dev() {
  local pids
  pids="$(origin_related_pids | tr '\n' ' ')"
  if [[ -n "${pids// }" ]]; then
    log "stopping origin dev pids: $pids"
    kill $pids >/dev/null 2>&1 || true
    sleep 2
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

clean_next_cache() {
  log "cleaning Next dev cache: $PROJECT_DIR/.next"
  rm -rf "$PROJECT_DIR/.next"
}

latest_auth_token() {
  if [[ ! -f "$DEV_LOG" ]]; then
    return 0
  fi

  rg -o 'token=[A-Za-z0-9._-]+' "$DEV_LOG" 2>/dev/null \
    | tail -n 1 \
    | sed 's/^token=//'
}

start_origin_dev() {
  log "starting $DEV_SCREEN on port $PORT"
  stop_origin_dev
  clean_next_cache

  LOG_BASELINE=$(wc -l < "$DEV_LOG" 2>/dev/null | tr -d ' ')
  LOG_BASELINE="${LOG_BASELINE:-0}"

  (
    trap - EXIT INT TERM
    cd "$PROJECT_DIR" || exit 1
    exec npm run dev >> "$DEV_LOG" 2>&1
  ) &
  echo "$!" > "$DEV_PID_FILE"
}

log_has_build_errors() {
  [[ -f "$DEV_LOG" ]] || return 1
  local current new_lines scan_lines
  current=$(wc -l < "$DEV_LOG" 2>/dev/null | tr -d ' ')
  current="${current:-0}"
  if (( current <= LOG_BASELINE )); then
    return 1
  fi
  new_lines=$((current - LOG_BASELINE))
  scan_lines=$(( new_lines > 2000 ? 2000 : new_lines ))
  tail -n "$scan_lines" "$DEV_LOG" 2>/dev/null \
    | grep -Eq "$BUILD_ERROR_REGEX"
}

should_auto_restart() {
  local now
  now=$(date +%s)
  (( now - LAST_AUTO_RESTART >= MIN_RESTART_INTERVAL ))
}

mark_auto_restart() {
  LAST_AUTO_RESTART=$(date +%s)
}

status_for_port() {
  local pids pid saw_origin=0
  pids="$(listening_pids | tr '\n' ' ')"

  if [[ -z "${pids// }" ]]; then
    echo "stopped"
    return
  fi

  for pid in $pids; do
    if is_origin_process "$pid"; then
      saw_origin=1
      break
    fi
  done

  if [[ "$saw_origin" == "1" ]]; then
    echo "origin-running:$pids"
  else
    echo "occupied-by-other:$pids"
  fi
}

health_status() {
  local settings_code projects_code token

  settings_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null || true)"
  if [[ -z "$settings_code" || "$settings_code" == "000" ]]; then
    echo "down:settings"
    return
  elif [[ "$settings_code" =~ ^5 ]]; then
    echo "bad:settings:$settings_code"
    return
  fi

  token="$(latest_auth_token)"
  if [[ -n "$token" ]]; then
    projects_code="$(
      curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
        -H "Authorization: Bearer $token" \
        "$AUTH_HEALTH_URL" 2>/dev/null || true
    )"
    if [[ -z "$projects_code" || "$projects_code" == "000" ]]; then
      echo "down:projects"
      return
    elif [[ "$projects_code" =~ ^5 ]]; then
      echo "bad:projects:$projects_code"
      return
    fi
    echo "ok:settings:$settings_code,projects:$projects_code"
    return
  fi

  echo "ok:settings:$settings_code"
}

main() {
  acquire_lock
  log "watchdog started: project=$PROJECT_DIR port=$PORT interval=${INTERVAL}s"
  local last_status="" status health

  while true; do
    ensure_next_vendor_link
    status="$(status_for_port)"

    case "$status" in
      stopped)
        log "port $PORT is not listening"
        start_origin_dev
        last_status="restarted"
        ;;
      origin-running:*)
        health="$(health_status)"
        if [[ "$health" == bad:* || "$health" == down:* ]]; then
          if should_auto_restart; then
            log "origin dev is unhealthy ($health); restarting with clean cache"
            start_origin_dev
            mark_auto_restart
            last_status="restarted-unhealthy"
          else
            log "origin dev unhealthy ($health) but restart throttled (<${MIN_RESTART_INTERVAL}s); skipping"
          fi
          sleep "$INTERVAL"
          continue
        fi
        if log_has_build_errors; then
          if should_auto_restart; then
            log "origin dev log shows Next build/chunk corruption; restarting with clean cache"
            start_origin_dev
            mark_auto_restart
            last_status="restarted-build-errors"
          else
            log "origin dev log shows build errors but restart throttled (<${MIN_RESTART_INTERVAL}s); skipping"
          fi
          sleep "$INTERVAL"
          continue
        fi
        if [[ "$last_status" != origin-running:* ]]; then
          log "origin dev is running on port $PORT (${status#origin-running:}); health=$health"
        fi
        last_status="$status"
        ;;
      occupied-by-other:*)
        if [[ "$last_status" != "$status" ]]; then
          log "port $PORT is occupied by another process (${status#occupied-by-other:}); not touching it"
        fi
        last_status="$status"
        ;;
    esac

    sleep "$INTERVAL"
  done
}

main "$@"
