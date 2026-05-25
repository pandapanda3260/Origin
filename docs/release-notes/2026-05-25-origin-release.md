# Origin release notes - 2026-05-25

Release branch: `codex/release-20260525`. Deploy the final reviewed HEAD commit from this branch.

## Summary

- Adds first-frame edit draft persistence, rewrite/rate-limit support, material/reference selection, and related frame upload/reference APIs.
- Adds asset-library persistence, generated asset backfill/dual-write helpers, material image panel UI, protected image thumbnail routing, and image performance telemetry.
- Adds video prompt generation hardening: preflight state checks, run/writeback mismatch handling, reaper support, retry/deadline controls, and video generation estimate API.
- Adds admin observability for token usage and time usage, plus related admin routes and smoke tests.
- Adds script-consult contamination guards and state helpers for cleaner project creation/adaptation flows.
- Adds release tooling: `npm run typecheck`, `npm run verify:release:local`, local isolated release checks, and this runbook.

## Production Impact

- Existing users may see new workspace UI behavior around storyboard materials, first-frame drafts, protected thumbnails, video prompt state, and admin observability pages.
- The release touches static assets under `public/`, so users should hard-refresh if stale browser assets are suspected after deployment.
- Web and worker should remain split. Current production uses systemd services `origin-web` and `origin-worker`; do not use PM2 reload commands unless the host is intentionally migrated to PM2.

## Data and Migration Notes

- SQLite bootstrap is additive for this release: new tables and columns are created if missing.
- `projects.version` is added with default `1` for optimistic locking.
- New token/time usage and asset-library tables are created if absent.
- Unique indexes are added for provider/task/export idempotency and storyboard material image identity. Run the duplicate-key preflight in `docs/release-runbook.md` before restart.
- Back up SQLite before swapping the release.

## Environment Notes

- `RELAX_VIDEO_PROMPT_BLOCKERS=1` is the expected behavior for this release. Missing this key currently has the same behavior because strict blocking only happens when the value is exactly `0`.
- Production may continue to rely on defaults for optional tuning keys. Required secrets and provider credentials remain in `/etc/origin/origin.env`; do not print them in logs or release notes.
- Confirm `ORIGIN_DATA_DIR` and `DB_PATH` remain outside `/opt/origin` before swapping directories.
- Preserve `/opt/origin/vevdemo-1.0.6` in the new release directory before swapping. It is an ignored runtime bundle and is required by the online editor material registration health check.

## Verification

Required before production:

```bash
npm ci
npm run verify:release:local
```

Required after production restart:

```bash
systemctl is-active origin-web origin-worker nginx
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health npm run health:production
curl -f http://127.0.0.1:3000/workspace >/dev/null
curl -f http://127.0.0.1:3000/api/config/client >/dev/null
```

Smoke the browser-visible flows: `/workspace`, `/admin/key-pool`, `/admin/token-stats`, `/admin/time-stats`, first-frame draft save/restore, storyboard material panels, video prompt generation state, and one protected image thumbnail URL.

## Rollback

Rollback is code-first because the schema changes are additive:

```bash
systemctl stop origin-worker
systemctl stop origin-web
mv /opt/origin /opt/origin-failed-<release-id>
mv /opt/origin-backups/origin-<previous-release-id> /opt/origin
systemctl start origin-web
systemctl start origin-worker
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health npm run health:production
```

Restore SQLite only if smoke tests show data corruption or if new writes are confirmed incompatible with the previous code.
