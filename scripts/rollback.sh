#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/myapp}"
COMPOSE="${COMPOSE:-docker compose}"
ROLLBACK_REF="${1:-HEAD~1}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-40}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-3}"

log() {
  printf '[rollback] %s\n' "$*"
}

show_logs() {
  log "service status:"
  $COMPOSE ps || true
  log "recent logs:"
  $COMPOSE logs --tail=200 origin-web origin-worker vevdemo-api vevdemo-fe || true
}

on_error() {
  log "failed at line $1"
  log "current git commit: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
  show_logs
}

trap 'on_error $LINENO' ERR

cd "$APP_DIR"

if [ ! -f .env ]; then
  log "missing .env in $APP_DIR; rollback cannot start services without env"
  exit 1
fi

CURRENT_COMMIT="$(git rev-parse HEAD)"
log "current commit: $CURRENT_COMMIT"
log "rolling back code to: $ROLLBACK_REF"

git fetch --all --prune
git reset --hard "$ROLLBACK_REF"

export ORIGIN_IMAGE_TAG="${ORIGIN_IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
log "rebuilding Docker images with ORIGIN_IMAGE_TAG=$ORIGIN_IMAGE_TAG"
$COMPOSE build

log "restarting services"
$COMPOSE up -d --remove-orphans

log "waiting for health endpoint: $HEALTH_URL"
for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS "$HEALTH_URL" >/tmp/origin-health.json; then
    log "rollback health check passed on attempt $attempt"
    cat /tmp/origin-health.json
    printf '\n'
    log "previous commit before rollback was: $CURRENT_COMMIT"
    exit 0
  fi
  log "health check attempt $attempt/$HEALTH_ATTEMPTS failed"
  sleep "$HEALTH_SLEEP_SECONDS"
done

log "rollback health check failed after $HEALTH_ATTEMPTS attempts"
log "previous commit before rollback was: $CURRENT_COMMIT"
show_logs
exit 1
