# Origin release runbook

This project currently deploys as a Next.js app backed by SQLite/local file storage, with web and worker processes managed by PM2 or systemd. There is no Vercel, Netlify, Railway, Fly.io, Render, Dockerfile, or GitHub Actions deployment config in this repository.

Current production as checked on 2026-05-25 uses systemd services `origin-web` and `origin-worker`, both with `WorkingDirectory=/opt/origin` and runtime env loaded from `/etc/origin/origin.env`.

Before first launch on a new server, create `/etc/origin/origin.env` from `deploy/origin.env.example`, keep it mode `600`, and replace every `replace-with-*` value. `JWT_SECRET`, `ADMIN_JWT_SECRET`, and `ASSET_URL_SECRET` must be three different random values, for example from `openssl rand -hex 32`. `BILLING_DEV_AUTOPAY` must stay `0` for production.

## Pre-release checks

Run from the repository root:

```bash
bash scripts/build-release-artifact.sh
```

`build-release-artifact.sh` runs `npm ci`, then `verify:release:local`, then packages the checked commit plus the generated `.next` output into `tmp/release-artifacts/origin-<release-id>.tar.gz` with a `.sha256` checksum. Prefer running it on Linux CI or a Linux staging host so the build environment matches production. `verify:release:local` runs TypeScript, the local deterministic test set, the workspace CSS build, and `next build` with a temporary SQLite database and an empty external env file. It also clears provider API key env vars for the child process so release verification does not submit real image/video/model jobs.

The workspace page uses local generated assets instead of runtime CDN CSS/fonts. Make sure release artifacts include `public/fonts.css`, `public/workspace-tailwind.css`, `public/vendor/fonts/`, `public/workspace-tailwind.src.css`, and `tailwind.workspace.config.cjs`.

`npm run health:production` always checks the anonymous workspace shell and `/api/config/client`. To make the authenticated workspace smoke a hard release gate, configure either `ORIGIN_WORKSPACE_SMOKE_TOKEN` or both `ORIGIN_WORKSPACE_SMOKE_PHONE` and `ORIGIN_WORKSPACE_SMOKE_PASSWORD`, then set `ORIGIN_WORKSPACE_SMOKE_REQUIRED=1`. Use a dedicated smoke account, not a real customer account.

When using phone/password smoke credentials, provision or rotate the account on the target environment after sourcing its env file:

```bash
set -a && . /etc/origin/origin.env && set +a
npm run provision:workspace-smoke
```

`npm run lint` is not a release gate yet: the script exists, but this repository has no ESLint config or ESLint dependency, so `next lint` prompts for interactive setup.

Production hosts must have a CJK font installed for edit-export hard subtitles. On Ubuntu, install and cache `fonts-noto-cjk` before exporting Chinese captions:

```bash
apt-get install -y fonts-noto-cjk
fc-cache -f
fc-match "Noto Sans CJK SC"
```

## Database and storage

Before production rollout, run a SQLite backup on the target server:

```bash
ORIGIN_SQLITE_BACKUP_DIR=/var/lib/origin/backups ORIGIN_SQLITE_BACKUP_RETAIN=14 npm run backup:sqlite
```

The current schema bootstrap is additive for this release. It creates asset-library, generation, token-usage, first-frame rewrite, and edit-project tables if missing, and adds `projects.version` for optimistic locking. Keep `ORIGIN_DATA_DIR` and `DB_PATH` on the persistent disk, not inside a release directory.

Current production also contains an ignored runtime bundle at `/opt/origin/vevdemo-1.0.6`. It is intentionally not in the git archive, but `/api/health` checks its Node dependency `vevdemo-1.0.6/nodejs/node_modules/@volcengine/openapi` when online editor integration is enabled. Preserve or recopy this directory into every new `/opt/origin-next-*` release before swapping directories.

This update adds the additive SQLite column `video_tasks.video_prompt_snapshot_json` and project JSON fields for video prompt draft/backup lifecycle. The column is bootstrapped automatically on app startup, but run the backfills after the new code is built and before opening traffic if old video prompt history must remain restorable:

```bash
cd /opt/origin-next-<release-id>
set -a && . /etc/origin/origin.env && set +a
npm run backup:sqlite
./node_modules/.bin/tsx scripts/backfill-video-prompt-lifecycle.ts
./node_modules/.bin/tsx scripts/backfill-video-prompt-snapshots.ts
```

Both backfills are intended to be additive/idempotent. Keep the SQLite backup from immediately before the run until post-release smoke tests pass.

Before restart, also run the read-only duplicate-key preflight on the production SQLite database. The storyboard-material image unique index is intentionally strict and deployment should pause if any count is non-zero:

```bash
cd /opt/origin
set -a && . /etc/origin/origin.env && set +a
node <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
function table(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function scalar(sql) {
  return db.prepare(sql).get()?.n ?? 0;
}
const checks = [
  ["images_storyboard_material_duplicate_groups", table("images") ? scalar("SELECT COUNT(*) AS n FROM (SELECT owner_id, project_id, asset_ref FROM images WHERE style='storyboard_material_upload' AND asset_ref IS NOT NULL GROUP BY owner_id, project_id, asset_ref HAVING COUNT(*) > 1)") : 0],
  ["credit_ledger_duplicate_charge_ref", table("credit_ledger") ? scalar("SELECT COUNT(*) AS n FROM (SELECT charge_ref_id FROM credit_ledger WHERE charge_ref_id IS NOT NULL GROUP BY charge_ref_id HAVING COUNT(*) > 1)") : 0],
  ["credit_ledger_duplicate_refund_ref", table("credit_ledger") ? scalar("SELECT COUNT(*) AS n FROM (SELECT refund_ref_id FROM credit_ledger WHERE refund_ref_id IS NOT NULL GROUP BY refund_ref_id HAVING COUNT(*) > 1)") : 0],
  ["batch_tasks_duplicate_provider_task", table("batch_tasks") ? scalar("SELECT COUNT(*) AS n FROM (SELECT provider, provider_task_id FROM batch_tasks WHERE provider IS NOT NULL AND provider_task_id IS NOT NULL GROUP BY provider, provider_task_id HAVING COUNT(*) > 1)") : 0],
  ["exports_duplicate_provider_external", table("exports") ? scalar("SELECT COUNT(*) AS n FROM (SELECT provider, external_export_id FROM exports WHERE provider IS NOT NULL AND external_export_id IS NOT NULL GROUP BY provider, external_export_id HAVING COUNT(*) > 1)") : 0],
  ["admin_actions_duplicate_active_idempotency", table("admin_actions") ? scalar("SELECT COUNT(*) AS n FROM (SELECT action, idempotency_key FROM admin_actions WHERE dry_run=0 AND idempotency_key IS NOT NULL AND status IN ('in_progress','completed') GROUP BY action, idempotency_key HAVING COUNT(*) > 1)") : 0],
];
let failed = false;
for (const [name, value] of checks) {
  console.log(`${name}=${value}`);
  if (value !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
NODE
```

## Staging rollout

Use a staging host or staging process group with its own `ORIGIN_DATA_DIR`, `DB_PATH`, and `/etc/origin/origin.env`.

```bash
npm ci
npm run build:workspace-css
npm run verify:release:local
ORIGIN_ENV_FILE=/etc/origin/origin.env ORIGIN_APP_DIR=/opt/origin-staging pm2 start deploy/pm2/ecosystem.config.cjs --update-env
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health ORIGIN_WORKSPACE_SMOKE_REQUIRED=1 npm run health:production
```

Smoke test staging:

```bash
curl -f http://127.0.0.1:3000/workspace >/dev/null
curl -f http://127.0.0.1:3000/api/config/client >/dev/null
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health ORIGIN_WORKSPACE_SMOKE_REQUIRED=1 npm run health:production
```

Also check the browser-visible flows that changed in this release: workspace load, storyboard/material panels, first-frame editor draft save/restore, video prompt generation state, admin token stats, admin time stats, and protected image thumbnails.

## Production rollout

Do not deploy uncommitted local state. Commit the release, build one release artifact, record the release id and commit SHA, and upload the artifact plus its `.sha256` file to the server. Because current production systemd units point directly at `/opt/origin`, extract the artifact outside `/opt/origin`, then swap directories during a short maintenance window. Do not run `next build` again on production; production should consume the already-built `.next` output from the artifact.

```bash
# on server, after uploading origin-<release-id>.tar.gz and .sha256
cd /opt
sha256sum -c /path/to/origin-<release-id>.tar.gz.sha256
mkdir -p /opt/origin-next-<release-id>
tar -xzf /path/to/origin-<release-id>.tar.gz -C /opt/origin-next-<release-id>

cd /opt/origin-next-<release-id>
set -a && . /etc/origin/origin.env && set +a
npm ci

cp -a /opt/origin/vevdemo-1.0.6 ./vevdemo-1.0.6

ORIGIN_SQLITE_BACKUP_DIR=/var/lib/origin/backups ORIGIN_SQLITE_BACKUP_RETAIN=14 npm run backup:sqlite

mkdir -p /opt/origin-backups
systemctl stop origin-worker
systemctl stop origin-web
mv /opt/origin /opt/origin-backups/origin-<previous-release-id>
mv /opt/origin-next-<release-id> /opt/origin
systemctl start origin-web
systemctl start origin-worker
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health ORIGIN_WORKSPACE_SMOKE_REQUIRED=1 npm run health:production
```

Do not use the PM2 rollout command unless production has first been switched back to `pm2-origin.service` or a PM2-managed process list.

## Production smoke test

After reload:

```bash
systemctl is-active origin-web origin-worker nginx
journalctl -u origin-web -n 100 --no-pager
journalctl -u origin-worker -n 100 --no-pager
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health ORIGIN_WORKSPACE_SMOKE_REQUIRED=1 npm run health:production
curl -f http://127.0.0.1:3000/workspace >/dev/null
curl -f http://127.0.0.1:3000/api/config/client >/dev/null
```

Then validate through the public domain and admin pages:

- `/workspace`
- `/admin/key-pool`
- `/admin/token-stats`
- `/admin/time-stats`
- one protected image URL with thumbnail query, for example `/api/images/file/<id>?w=256`

Also verify the runtime model routing after every env or key change. This catches stale production provider settings before users submit real generation jobs:

```bash
cd /opt/origin
set -a && . /etc/origin/origin.env && set +a
./node_modules/.bin/tsx - <<'TS'
import { chatComplete } from "./lib/llm";
import { getModelRoutingStatus } from "./lib/model-routing";

const status = getModelRoutingStatus(null);
for (const slot of ["brain", "structured", "image", "video"]) {
  const cfg = status[slot];
  const host = new URL(cfg.baseUrl).host;
  console.log(`${slot} provider=${cfg.provider} model=${cfg.model} host=${host}`);
}

for (const role of ["structured", "brain"]) {
  const started = Date.now();
  const reply = await chatComplete(null, [
    { role: "system", content: "Reply with exactly: pong" },
    { role: "user", content: "health check" },
  ], {
    modelRole: role,
    temperature: 0,
    maxTokens: 32,
    requestTimeoutMs: 45000,
    traceName: `prod-smoke-${role}`,
    reasoningEffort: role === "structured" ? "none" : undefined,
  });
  console.log(`${role} ok latencyMs=${Date.now() - started} reply=${reply.trim().slice(0, 80)}`);
}
TS
```

Do not print provider API keys or full `/etc/origin/origin.env` contents in release logs.

For gpt-image-only production mode, also confirm the image route reports `fallbackConfigs=0` and watch `origin-worker` logs after restart. `seedream` should not appear in new image-generation attempts when `IMAGE_FALLBACK_ENABLED=false`.

## Rollback

Use code rollback first when the database changes are additive:

```bash
systemctl stop origin-worker
systemctl stop origin-web
mv /opt/origin /opt/origin-failed-<release-id>
mv /opt/origin-backups/origin-<previous-release-id> /opt/origin
systemctl start origin-web
systemctl start origin-worker
ORIGIN_HEALTH_URL=http://127.0.0.1:3000/api/health ORIGIN_WORKSPACE_SMOKE_REQUIRED=1 npm run health:production
```

Restore SQLite only if the new code wrote data that the previous code cannot tolerate, or if health/smoke tests show data corruption. Restore from a backup created with `npm run backup:sqlite`, stop web and worker before restore, then start both again.
