#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/myapp}"
COMPOSE="${COMPOSE:-docker compose}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-40}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-3}"

log() {
  printf '[deploy] %s\n' "$*"
}

show_logs() {
  log "service status:"
  $COMPOSE ps || true
  log "recent logs:"
  $COMPOSE logs --tail=200 origin-web origin-worker vevdemo-api vevdemo-fe || true
}

on_error() {
  log "failed at line $1"
  show_logs
}

trap 'on_error $LINENO' ERR

cd "$APP_DIR"

if [ ! -f .env ]; then
  log "missing .env in $APP_DIR; copy .env.example to .env and fill CHANGE_ME values first"
  exit 1
fi

log "updating git checkout"
git fetch --all --prune
git pull --ff-only

export ORIGIN_IMAGE_TAG="${ORIGIN_IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
log "building Docker images with ORIGIN_IMAGE_TAG=$ORIGIN_IMAGE_TAG"
$COMPOSE build

log "starting services"
$COMPOSE up -d --remove-orphans

log "waiting for health endpoint: $HEALTH_URL"
for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS "$HEALTH_URL" >/tmp/origin-health.json; then
    log "health check passed on attempt $attempt"
    cat /tmp/origin-health.json
    printf '\n'
    exit 0
  fi
  log "health check attempt $attempt/$HEALTH_ATTEMPTS failed"
  sleep "$HEALTH_SLEEP_SECONDS"
done

log "health check failed after $HEALTH_ATTEMPTS attempts"
show_logs
exit 1
