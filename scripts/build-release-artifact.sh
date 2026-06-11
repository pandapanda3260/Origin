#!/usr/bin/env bash
# Build a release tarball from one checked commit plus the generated Next.js
# production build. Run this on Linux CI or a Linux staging host when possible.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${ORIGIN_RELEASE_OUT_DIR:-$ROOT/tmp/release-artifacts}"
SKIP_VERIFY="${ORIGIN_RELEASE_SKIP_VERIFY:-0}"
ALLOW_DIRTY="${ORIGIN_RELEASE_ALLOW_DIRTY:-0}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "fatal: $ROOT is not a git worktree" >&2
  exit 1
fi

if [ "$ALLOW_DIRTY" != "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "fatal: worktree is dirty. Commit or stash changes, or set ORIGIN_RELEASE_ALLOW_DIRTY=1 for a local dry run." >&2
    git status --short >&2
    exit 1
  fi
fi

REVISION="$(git rev-parse HEAD)"
SHORT_REVISION="$(git rev-parse --short=7 HEAD)"
RELEASE_ID="${ORIGIN_RELEASE_ID:-${SHORT_REVISION}-$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$OUT_DIR" "$ROOT/tmp"
WORK_DIR="$(mktemp -d "$ROOT/tmp/release-artifact.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [ "$SKIP_VERIFY" != "1" ]; then
  npm ci
  npm run verify:release:local
  if [ "$ALLOW_DIRTY" != "1" ]; then
    POST_VERIFY_DIRTY="$(git status --porcelain | grep -v ' tsconfig.tsbuildinfo$' || true)"
    if [ -n "$POST_VERIFY_DIRTY" ]; then
      echo "fatal: release verification changed tracked files. Review and commit generated outputs before packaging." >&2
      echo "$POST_VERIFY_DIRTY" >&2
      exit 1
    fi
  fi
elif [ ! -f "$ROOT/.next/BUILD_ID" ]; then
  echo "fatal: .next/BUILD_ID is missing. Run npm run build first or leave ORIGIN_RELEASE_SKIP_VERIFY unset." >&2
  exit 1
fi

RELEASE_DIR="$WORK_DIR/origin"
mkdir -p "$RELEASE_DIR"

git archive --format=tar HEAD | tar -x -C "$RELEASE_DIR"
cp -a "$ROOT/.next" "$RELEASE_DIR/.next"
printf '%s\n' "$RELEASE_ID" > "$RELEASE_DIR/RELEASE_ID"
printf '%s\n' "$REVISION" > "$RELEASE_DIR/REVISION"

ARTIFACT="$OUT_DIR/origin-${RELEASE_ID}.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
tar -czf "$ARTIFACT" -C "$RELEASE_DIR" .

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$(basename "$ARTIFACT")" > "$(basename "$CHECKSUM")")
else
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$ARTIFACT")" > "$(basename "$CHECKSUM")")
fi

echo "release_id=$RELEASE_ID"
echo "revision=$REVISION"
echo "artifact=$ARTIFACT"
echo "checksum=$CHECKSUM"
