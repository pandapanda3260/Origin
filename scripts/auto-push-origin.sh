#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

export GIT_SSH_COMMAND="ssh -i /Users/mark/.ssh/id_ed25519_origin_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -p 443"

retry() {
  local attempts="$1"
  local delay="$2"
  shift
  shift

  local n=1
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

if command -v nc >/dev/null 2>&1; then
  if ! nc -z -G 15 ssh.github.com 443 >/dev/null 2>&1 && ! nc -z -w 15 ssh.github.com 443 >/dev/null 2>&1; then
    echo "auto-push warning: TCP probe to ssh.github.com:443 failed; continuing so git fetch/push can report the authoritative error." >&2
  fi
else
  echo "auto-push warning: nc not found; skipping TCP probe and letting git fetch/push validate GitHub access." >&2
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

retry 5 5 git fetch origin main

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

retry 5 5 git push origin main
