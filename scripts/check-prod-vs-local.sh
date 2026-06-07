#!/usr/bin/env bash
# Read-only diagnostic: compare local origin checkout against the production
# server. Does NOT modify anything on either side.
#
# Usage (just run it, output auto-saved next to this script):
#   bash /Users/mark/Documents/origin/scripts/check-prod-vs-local.sh
#
# Output file:
#   /Users/mark/Documents/origin/scripts/check-prod-vs-local.out
#
# The host/key are pinned to the values the user gave; override via env if needed.

set -u

OUT_FILE="${OUT_FILE:-/Users/mark/Documents/origin/scripts/check-prod-vs-local.out}"
exec > >(tee "$OUT_FILE") 2>&1
echo "# Output is also being written to: $OUT_FILE"
echo "# Started at $(date)"

HOST="${ORIGIN_HOST:-115.190.238.3}"
USER_NAME="${ORIGIN_USER:-root}"
KEY="${ORIGIN_KEY:-/Users/mark/Documents/key/origin2.pem}"
LOCAL_REPO="${LOCAL_REPO:-/Users/mark/Documents/origin}"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes)

section() {
  echo
  echo "============================================================"
  echo "== $1"
  echo "============================================================"
}

run_remote() {
  ssh "${SSH_OPTS[@]}" "${USER_NAME}@${HOST}" "$1"
}

# -------- LOCAL --------
section "LOCAL: host + node + git"
echo "-- uname / sw_vers --"
uname -a
sw_vers 2>/dev/null || true
echo "-- node / npm --"
node --version 2>/dev/null || echo "(no node on PATH)"
npm --version 2>/dev/null || echo "(no npm on PATH)"
echo "-- git HEAD --"
( cd "$LOCAL_REPO" && git rev-parse --abbrev-ref HEAD && git log --oneline -5 && git status --short )

section "LOCAL: build artifacts"
( cd "$LOCAL_REPO" && \
  echo "BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo none)"; \
  stat -f "mtime=%Sm size=%z" .next/BUILD_ID 2>/dev/null || true; \
  ls -1 .next 2>/dev/null | head -20 )

section "LOCAL: package.json key fields"
( cd "$LOCAL_REPO" && \
  awk '/"name"|"version"|"next"|"react"|"better-sqlite3"|"@napi-rs\/canvas"|"@langchain"/' package.json | head -30 )

section "LOCAL: .env.local keys (values masked)"
( cd "$LOCAL_REPO" && \
  if [ -f .env.local ]; then
    sed -E 's/=.*/=***/' .env.local
  else
    echo "(no .env.local)"
  fi )

# -------- REMOTE --------
section "REMOTE: reachability"
if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "${USER_NAME}@${HOST}" 'echo ok' 2>/tmp/origin-ssh-err; then
  echo "SSH FAILED:"
  cat /tmp/origin-ssh-err
  echo "Aborting remote checks."
  exit 0
fi

section "REMOTE: host + kernel + uptime"
run_remote 'uname -a; cat /etc/os-release 2>/dev/null | head -6; uptime; date'

section "REMOTE: node / npm / pm2 versions"
run_remote 'echo "-- node --"; node --version 2>/dev/null || echo none; echo "-- npm --"; npm --version 2>/dev/null || echo none; echo "-- pm2 --"; pm2 -v 2>/dev/null || echo none; echo "-- ffmpeg --"; ffmpeg -version 2>/dev/null | head -1 || echo none'

section "REMOTE: services (systemd)"
run_remote 'for svc in origin-web origin-worker pm2-origin nginx; do printf "%-18s active=%s enabled=%s\n" "$svc" "$(systemctl is-active $svc 2>&1)" "$(systemctl is-enabled $svc 2>&1)"; done'

section "REMOTE: services (PM2 list, if any)"
run_remote 'pm2 list 2>/dev/null || echo "(pm2 not running or no list)"'

section "REMOTE: listening ports"
run_remote 'ss -tlnp 2>/dev/null | grep -E ":3000|:80|:443" || (netstat -tlnp 2>/dev/null | grep -E ":3000|:80|:443")'

section "REMOTE: /opt/origin layout"
run_remote 'ls -la /opt/origin 2>/dev/null | head -40; echo; echo "-- backups --"; ls -la /opt/origin-backups 2>/dev/null | head -10'

section "REMOTE: deployed git HEAD"
run_remote 'cd /opt/origin && git rev-parse --abbrev-ref HEAD 2>/dev/null; git log --oneline -5 2>/dev/null; git status --short 2>/dev/null'

section "REMOTE: deployed BUILD_ID + .next mtime"
run_remote 'cat /opt/origin/.next/BUILD_ID 2>/dev/null; stat -c "mtime=%y size=%s" /opt/origin/.next/BUILD_ID 2>/dev/null'

section "REMOTE: deployed package.json key fields"
run_remote 'awk "/\"name\"|\"version\"|\"next\"|\"react\"|\"better-sqlite3\"|\"@napi-rs\\/canvas\"|\"@langchain\"/" /opt/origin/package.json | head -30'

section "REMOTE: /etc/origin/origin.env keys (values masked)"
run_remote 'if [ -f /etc/origin/origin.env ]; then sed -E "s/=.*/=***/" /etc/origin/origin.env; else echo "(no /etc/origin/origin.env)"; fi'

section "REMOTE: ORIGIN_DATA_DIR layout + disk"
run_remote 'echo "-- /var/lib/origin --"; ls -la /var/lib/origin 2>/dev/null; echo; echo "-- data dir size --"; du -sh /var/lib/origin/data 2>/dev/null; echo; echo "-- df --"; df -h /var/lib/origin 2>/dev/null; df -h /opt/origin 2>/dev/null'

section "REMOTE: SQLite db sanity"
run_remote 'ls -la /var/lib/origin/data/qd.sqlite* 2>/dev/null; echo; echo "-- backups --"; ls -la /var/lib/origin/backups 2>/dev/null | head -10'

section "REMOTE: vevdemo runtime bundle"
run_remote 'ls -la /opt/origin/vevdemo-1.0.6 2>/dev/null | head -10 || echo "(not present)"'

section "REMOTE: health endpoint"
run_remote 'curl -sS -m 8 http://127.0.0.1:3000/api/health || echo "(health endpoint not reachable)"'

section "REMOTE: workspace / client config smoke"
run_remote 'curl -s -o /dev/null -w "workspace HTTP=%{http_code}\n" -m 8 http://127.0.0.1:3000/workspace; curl -s -o /dev/null -w "client-config HTTP=%{http_code}\n" -m 8 http://127.0.0.1:3000/api/config/client'

section "REMOTE: recent web/worker logs (last 30 lines)"
run_remote 'journalctl -u origin-web -n 30 --no-pager 2>/dev/null || echo "(no journalctl for origin-web)"'
run_remote 'echo "--- worker ---"; journalctl -u origin-worker -n 30 --no-pager 2>/dev/null || echo "(no journalctl for origin-worker)"'

section "REMOTE: nginx config presence"
run_remote 'ls /etc/nginx/sites-enabled/ 2>/dev/null; nginx -t 2>&1 | head -5'

section "DONE"
echo "Finished at $(date)"
