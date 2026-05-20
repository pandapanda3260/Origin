#!/usr/bin/env bash
set -u

ORIGIN_DIR="${ORIGIN_DIR:-/Users/mark/Documents/origin}"
VEVDEMO_DIR="${VEVDEMO_DIR:-$ORIGIN_DIR/vevdemo-1.0.6}"
BACKEND_DIR="$VEVDEMO_DIR/nodejs"
FRONTEND_DIR="$VEVDEMO_DIR/fe"
ORIGIN_ENV_FILE="${ORIGIN_ENV_FILE:-/Users/mark/Documents/key/origin.env.local}"

INTERVAL="${VEVDEMO_WATCHDOG_INTERVAL:-20}"
MIN_RESTART_INTERVAL="${VEVDEMO_WATCHDOG_MIN_RESTART_INTERVAL:-60}"
WATCHDOG_LOG="${VEVDEMO_WATCHDOG_LOG:-/tmp/vevdemo-watchdog.log}"
BACKEND_LOG="${VEVDEMO_BACKEND_LOG:-/tmp/vevdemo-backend.log}"
FRONTEND_LOG="${VEVDEMO_FRONTEND_LOG:-/tmp/vevdemo-frontend.log}"
BACKEND_PID_FILE="${VEVDEMO_BACKEND_PID_FILE:-/tmp/vevdemo-backend.pid}"
FRONTEND_PID_FILE="${VEVDEMO_FRONTEND_PID_FILE:-/tmp/vevdemo-frontend.pid}"
LOCK_DIR="${VEVDEMO_WATCHDOG_LOCK_DIR:-/tmp/vevdemo-dev-watchdog.lock}"

LAST_BACKEND_RESTART=0
LAST_FRONTEND_RESTART=0

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WATCHDOG_LOG"
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

env_value() {
  local file="$1"
  local key="$2"
  local line value

  [[ -f "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%% #*}"
  trim_value "$value"
}

url_port() {
  local url="$1"
  local fallback="$2"
  local without_scheme host_port port

  [[ -n "$url" ]] || {
    printf '%s' "$fallback"
    return 0
  }
  without_scheme="${url#*://}"
  host_port="${without_scheme%%/*}"
  if [[ "$host_port" == *:* ]]; then
    port="${host_port##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] && {
      printf '%s' "$port"
      return 0
    }
  fi
  printf '%s' "$fallback"
}

configured_backend_port() {
  local port api_url

  port="${VEVDEMO_BACKEND_PORT:-$(env_value "$ORIGIN_ENV_FILE" VEVDEMO_BACKEND_PORT)}"
  [[ "$port" =~ ^[0-9]+$ ]] && {
    printf '%s' "$port"
    return 0
  }

  api_url="${VEVDEMO_API_URL:-$(env_value "$ORIGIN_ENV_FILE" VEVDEMO_API_URL)}"
  [[ -n "$api_url" ]] || api_url="${VEVDEMO_BACKEND_URL:-$(env_value "$ORIGIN_ENV_FILE" VEVDEMO_BACKEND_URL)}"
  url_port "$api_url" "3002"
}

configured_frontend_port() {
  local port editor_url

  port="${VITE_DEV_PORT:-$(env_value "$FRONTEND_DIR/.env.local" VITE_DEV_PORT)}"
  [[ -n "$port" ]] || port="$(env_value "$ORIGIN_ENV_FILE" VITE_DEV_PORT)"
  [[ "$port" =~ ^[0-9]+$ ]] && {
    printf '%s' "$port"
    return 0
  }

  editor_url="${VEVDEMO_EDITOR_URL:-$(env_value "$ORIGIN_ENV_FILE" VEVDEMO_EDITOR_URL)}"
  [[ -n "$editor_url" ]] || editor_url="${VEVDEMO_FRONTEND_URL:-$(env_value "$ORIGIN_ENV_FILE" VEVDEMO_FRONTEND_URL)}"
  url_port "$editor_url" "8084"
}

frontend_host() {
  local host
  host="${VITE_DEV_HOST:-$(env_value "$FRONTEND_DIR/.env.local" VITE_DEV_HOST)}"
  [[ -n "$host" ]] || host="$(env_value "$ORIGIN_ENV_FILE" VITE_DEV_HOST)"
  printf '%s' "${host:-127.0.0.1}"
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
    log "another VevDemo watchdog is already running (pid=$locked_pid); exiting"
    exit 0
  fi

  log "removing stale VevDemo watchdog lock"
  rm -rf "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    trap release_lock EXIT
    trap 'release_lock; exit 0' INT TERM
    return 0
  fi

  log "could not acquire VevDemo watchdog lock; exiting"
  exit 1
}

listening_pids() {
  local port="$1"
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

is_process_for_dir() {
  local pid="$1"
  local dir="$2"
  local cwd cmd cur ppid

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  if [[ "$cwd" == "$dir"* ]]; then
    return 0
  fi

  cur="$pid"
  for _ in 1 2 3 4 5; do
    cmd="$(ps -p "$cur" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"$dir"* ]]; then
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

related_pids() {
  local dir="$1"
  local port="$2"
  local pid_file="$3"

  {
    pgrep -f "$dir" 2>/dev/null || true
    [[ -f "$pid_file" ]] && cat "$pid_file" 2>/dev/null || true
    listening_pids "$port"
  } | while read -r pid; do
    [[ -n "$pid" && "$pid" != "$$" ]] || continue
    if is_process_for_dir "$pid" "$dir"; then
      echo "$pid"
      pgrep -P "$pid" 2>/dev/null || true
    fi
  done | sort -n -u
}

service_status() {
  local port="$1"
  local dir="$2"
  local pids pid saw_service=0

  pids="$(listening_pids "$port" | tr '\n' ' ')"
  if [[ -z "${pids// }" ]]; then
    echo "stopped"
    return 0
  fi

  for pid in $pids; do
    if is_process_for_dir "$pid" "$dir"; then
      saw_service=1
      break
    fi
  done

  if [[ "$saw_service" == "1" ]]; then
    echo "running:$pids"
  else
    echo "occupied-by-other:$pids"
  fi
}

http_status() {
  local url="$1"
  local code

  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  if [[ -z "$code" || "$code" == "000" ]]; then
    echo "down"
    return 0
  fi
  if [[ "$code" =~ ^5 ]]; then
    echo "bad:$code"
    return 0
  fi
  echo "ok:$code"
}

stop_service() {
  local name="$1"
  local dir="$2"
  local port="$3"
  local pid_file="$4"
  local pids

  pids="$(related_pids "$dir" "$port" "$pid_file" | tr '\n' ' ')"
  if [[ -n "${pids// }" ]]; then
    log "stopping $name pids: $pids"
    kill $pids >/dev/null 2>&1 || true
    sleep 2
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

sync_vevdemo_env() {
  if [[ ! -f "$ORIGIN_DIR/scripts/sync-vevdemo-env.cjs" ]]; then
    log "env sync skipped: missing scripts/sync-vevdemo-env.cjs"
    return 0
  fi
  if [[ ! -f "$ORIGIN_ENV_FILE" ]]; then
    log "env sync skipped: missing $ORIGIN_ENV_FILE"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    log "env sync skipped: node is not in PATH"
    return 0
  fi

  (
    cd "$ORIGIN_DIR" || exit 1
    ORIGIN_ENV_FILE="$ORIGIN_ENV_FILE" node scripts/sync-vevdemo-env.cjs
  ) >> "$WATCHDOG_LOG" 2>&1 || log "env sync failed"
}

start_backend() {
  local port="$1"

  if [[ ! -d "$BACKEND_DIR" ]]; then
    log "backend start skipped: missing $BACKEND_DIR"
    return 0
  fi

  log "starting VevDemo backend on port $port"
  stop_service "VevDemo backend" "$BACKEND_DIR" "$port" "$BACKEND_PID_FILE"
  : >> "$BACKEND_LOG" 2>/dev/null || true
  (
    trap - EXIT INT TERM
    cd "$BACKEND_DIR" || exit 1
    exec npm run dev >> "$BACKEND_LOG" 2>&1
  ) &
  echo "$!" > "$BACKEND_PID_FILE"
}

start_frontend() {
  local port="$1"
  local host="$2"

  if [[ ! -d "$FRONTEND_DIR" ]]; then
    log "frontend start skipped: missing $FRONTEND_DIR"
    return 0
  fi

  sync_vevdemo_env
  log "starting VevDemo frontend on ${host}:${port}"
  stop_service "VevDemo frontend" "$FRONTEND_DIR" "$port" "$FRONTEND_PID_FILE"
  : >> "$FRONTEND_LOG" 2>/dev/null || true
  (
    trap - EXIT INT TERM
    cd "$FRONTEND_DIR" || exit 1
    exec npm run dev -- --host "$host" --port "$port" >> "$FRONTEND_LOG" 2>&1
  ) &
  echo "$!" > "$FRONTEND_PID_FILE"
}

can_restart_backend() {
  local now
  now="$(date +%s)"
  (( now - LAST_BACKEND_RESTART >= MIN_RESTART_INTERVAL ))
}

can_restart_frontend() {
  local now
  now="$(date +%s)"
  (( now - LAST_FRONTEND_RESTART >= MIN_RESTART_INTERVAL ))
}

main() {
  acquire_lock
  log "watchdog started: vevdemo=$VEVDEMO_DIR interval=${INTERVAL}s"

  local backend_port frontend_port frontend_bind_host
  local backend_status frontend_status backend_health frontend_health
  local backend_health_url frontend_health_url
  local last_backend_status="" last_frontend_status=""

  while true; do
    backend_port="$(configured_backend_port)"
    frontend_port="$(configured_frontend_port)"
    frontend_bind_host="$(frontend_host)"
    backend_health_url="${VEVDEMO_BACKEND_HEALTH_URL:-http://127.0.0.1:${backend_port}/}"
    frontend_health_url="${VEVDEMO_FRONTEND_HEALTH_URL:-http://127.0.0.1:${frontend_port}/}"

    backend_status="$(service_status "$backend_port" "$BACKEND_DIR")"
    case "$backend_status" in
      stopped)
        log "VevDemo backend port $backend_port is not listening"
        start_backend "$backend_port"
        LAST_BACKEND_RESTART="$(date +%s)"
        last_backend_status="restarted"
        ;;
      running:*)
        backend_health="$(http_status "$backend_health_url")"
        if [[ "$backend_health" == down || "$backend_health" == bad:* ]]; then
          if can_restart_backend; then
            log "VevDemo backend is unhealthy ($backend_health); restarting"
            start_backend "$backend_port"
            LAST_BACKEND_RESTART="$(date +%s)"
            last_backend_status="restarted-unhealthy"
          else
            log "VevDemo backend unhealthy ($backend_health) but restart throttled (<${MIN_RESTART_INTERVAL}s)"
          fi
        elif [[ "$last_backend_status" != running:* ]]; then
          log "VevDemo backend is running on port $backend_port (${backend_status#running:}); health=$backend_health"
          last_backend_status="$backend_status"
        fi
        ;;
      occupied-by-other:*)
        if [[ "$last_backend_status" != "$backend_status" ]]; then
          log "VevDemo backend port $backend_port is occupied by another process (${backend_status#occupied-by-other:}); not touching it"
          last_backend_status="$backend_status"
        fi
        ;;
    esac

    frontend_status="$(service_status "$frontend_port" "$FRONTEND_DIR")"
    case "$frontend_status" in
      stopped)
        log "VevDemo frontend port $frontend_port is not listening"
        start_frontend "$frontend_port" "$frontend_bind_host"
        LAST_FRONTEND_RESTART="$(date +%s)"
        last_frontend_status="restarted"
        ;;
      running:*)
        frontend_health="$(http_status "$frontend_health_url")"
        if [[ "$frontend_health" == down || "$frontend_health" == bad:* ]]; then
          if can_restart_frontend; then
            log "VevDemo frontend is unhealthy ($frontend_health); restarting"
            start_frontend "$frontend_port" "$frontend_bind_host"
            LAST_FRONTEND_RESTART="$(date +%s)"
            last_frontend_status="restarted-unhealthy"
          else
            log "VevDemo frontend unhealthy ($frontend_health) but restart throttled (<${MIN_RESTART_INTERVAL}s)"
          fi
        elif [[ "$last_frontend_status" != running:* ]]; then
          log "VevDemo frontend is running on port $frontend_port (${frontend_status#running:}); health=$frontend_health"
          last_frontend_status="$frontend_status"
        fi
        ;;
      occupied-by-other:*)
        if [[ "$last_frontend_status" != "$frontend_status" ]]; then
          log "VevDemo frontend port $frontend_port is occupied by another process (${frontend_status#occupied-by-other:}); not touching it"
          last_frontend_status="$frontend_status"
        fi
        ;;
    esac

    sleep "$INTERVAL"
  done
}

main "$@"
