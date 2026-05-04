#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

export GIT_SSH_COMMAND="ssh -i /Users/mark/.ssh/id_ed25519_origin_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p 443"

retry() {
  local attempts="$1"
  shift

  local n=1
  local delay=2
  while true; do
    if "$@"; then
      return 0
    fi

    if (( n >= attempts )); then
      return 1
    fi

    echo "auto-push retrying: $* (attempt $((n + 1))/$attempts)" >&2
    sleep "$delay"
    n=$((n + 1))
    delay=$((delay * 2))
  done
}

if ! retry 2 bash -lc 'ssh -i /Users/mark/.ssh/id_ed25519_origin_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p 443 -T git@ssh.github.com 2>&1 | grep -q "successfully authenticated"' ; then
  echo "auto-push stopped: unable to reach GitHub over SSH on port 443. Check local network access or GitHub SSH availability." >&2
  exit 4
fi

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

retry 2 git fetch origin main

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

retry 2 git push origin main
