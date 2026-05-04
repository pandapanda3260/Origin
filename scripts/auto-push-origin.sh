#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

export GIT_SSH_COMMAND="ssh -i /Users/mark/.ssh/id_ed25519_origin_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p 443"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "auto-push skipped: current branch is '$branch', expected 'main'." >&2
  exit 2
fi

git remote get-url origin >/dev/null

git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: automated hourly sync $(date '+%Y-%m-%d %H:%M:%S %Z')"
fi

git fetch origin main

if git rev-parse --verify origin/main >/dev/null 2>&1; then
  if git merge-base --is-ancestor origin/main HEAD; then
    :
  elif git merge-base --is-ancestor HEAD origin/main; then
    git merge --ff-only origin/main
  else
    echo "auto-push stopped: local main and origin/main diverged; resolve manually first." >&2
    exit 3
  fi
fi

git push origin main
