#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

failures=0

run() {
  printf "\n==> %s\n" "$*"
  "$@"
  local status=$?
  printf "<== %s [%s]\n" "$*" "$status"
  if [ "$status" -ne 0 ]; then failures=1; fi
}

run_isolated() {
  local tmp
  tmp="$(mktemp -d /tmp/origin-release-check.XXXXXX)"
  mkdir -p "$tmp/data"
  : > "$tmp/empty.env"
  printf "\n==> %s\n" "$*"
  ORIGIN_DATA_DIR="$tmp/data" \
    DB_PATH="$tmp/data/qd.sqlite" \
    ORIGIN_ENV_FILE="$tmp/empty.env" \
    NODE_ENV=test \
    IMAGE_API_KEY= \
    IMAGE_SEEDREAM_API_KEY= \
    VIDEO_API_KEY= \
    OPENAI_API_KEY= \
    "$@"
  local status=$?
  printf "<== %s [%s]\n" "$*" "$status"
  if [ "$status" -ne 0 ]; then failures=1; fi
}

run_build() {
  local tmp
  tmp="$(mktemp -d /tmp/origin-release-build.XXXXXX)"
  : > "$tmp/empty.env"
  printf "\n==> npm run build\n"
  NEXT_TELEMETRY_DISABLED=1 \
    ORIGIN_ENV_FILE="$tmp/empty.env" \
    IMAGE_API_KEY= \
    IMAGE_SEEDREAM_API_KEY= \
    VIDEO_API_KEY= \
    OPENAI_API_KEY= \
    npm run build
  local status=$?
  printf "<== npm run build [%s]\n" "$status"
  if [ "$status" -ne 0 ]; then failures=1; fi
}

run npm run typecheck

run_isolated npm run check:admin-governance
run_isolated npm run test:image-provider-routing
run_isolated npm run test:frame-workflow-state
run_isolated npm run test:frame-image-plan
run_isolated npm run test:llm-background-mode
run_isolated npm run test:first-frame-edit-draft
run_isolated npm run test:first-frame-rewrite-rate-limit
run_isolated npm run test:first-frame-rewrite-patch
run_isolated npm run test:first-frame-rewrite-disabled
run_isolated npm run test:first-frame-editor-ui-contract
run_isolated npm run test:batch-preflight
run_isolated npm run test:responses-input-role-mapping
run_isolated npm run test:project-dependency-state
run_isolated npm run test:video-payload-decision
run_isolated npm run test:video-reference-manifest
run_isolated npm run test:video-prompt-dialogue-regression
run_isolated npm run test:visual-reference-state
run_isolated npm run test:provider-recovery
run_isolated npm run test:online-editor-expiry

run_isolated npx tsx scripts/test-asset-library-backfill.ts
run_isolated npx tsx scripts/test-asset-library-dual-write.ts
run_isolated node scripts/test-asset-inline-edit.mjs
run_isolated npx tsx scripts/test-casting-profile.ts
run_isolated npx tsx scripts/test-character-reference-update.ts
run_isolated npx tsx scripts/test-image-character-fallback-policy.ts
run_isolated npx tsx scripts/test-project-create-sanitization.ts
run_isolated npx tsx scripts/test-proxy-fetch-status-text.ts
run_isolated node scripts/test-script-consult-abort-wiring.js
run_isolated npx tsx scripts/test-script-consult-contamination.ts
run_isolated npx tsx scripts/test-script-consult-state.ts
run_isolated npx tsx scripts/test-script-consult-turn-state.ts
run_isolated node scripts/test-sentinel-artifact-usage.js
run_isolated npx tsx scripts/test-shot-tail-frame-signals.ts
run_isolated npx tsx scripts/test-video-generation-estimate.ts
run_isolated node scripts/test-video-submit-image-data-url.js
run_isolated node scripts/test-first-frame-material-panels-route.mjs
run_isolated node scripts/test-material-image-panel-state.mjs
run_isolated node scripts/test-storyboard-material-panel-contract.mjs
run_isolated node scripts/test-tail-frame-no-auto-stale.js
run_isolated node scripts/test-tail-frame-no-auto-stale-sqlite.js
run_isolated npx tsx scripts/test-tail-frame-no-auto-stale.mjs

run_build

exit "$failures"
