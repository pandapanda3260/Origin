# Origin production operations plan

## Service split

| Service | Responsibility | Process owner |
| --- | --- | --- |
| `origin-web` | `/workspace`, `/admin`, auth, project APIs, status APIs, callback APIs | PM2/systemd |
| `origin-worker` | Reclaim queued/stale batches, resume pending VevDemo downloads, poll recoverable video tasks and VevDemo export tasks | PM2/systemd |
| VevDemo frontend | Static editor shell, usually behind Nginx/CDN | Vite build output or official hosting |
| VevDemo backend | Volcengine tokens, project binding, upload/import/export calls | PM2/systemd or vendor backend |
| SQLite/Postgres | Durable business state: users, projects, batches, tasks, exports, ledger, audit | Persistent disk or managed DB |
| Object/media storage | Images, videos, uploads, exports, BGM | `ORIGIN_DATA_DIR` persistent disk now; S3/TOS/COS adapter later |

## Production defaults

Run web and worker as separate services:

- Web: `ORIGIN_BATCH_INLINE_RUNNER=0`, `ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD=0`, `ORIGIN_REAP_ORPHANS_ON_START=0`
- Worker: `ORIGIN_PROCESS_ROLE=worker`, `ORIGIN_BATCH_RECOVERY_ENABLED=1`, `ORIGIN_INLINE_ONLINE_EDITOR_DOWNLOAD=1`
- Shared durable state: `ORIGIN_DATA_DIR=/var/lib/origin/data`, `DB_PATH=/var/lib/origin/data/qd.sqlite`

With that split, a web restart does not kill active business state. New batches stay `queued` in SQLite until the worker claims them. If a worker dies mid-task, the next worker heartbeat pass renews task leases in bulk. Interrupted `running` tasks move to `needs_review` instead of automatic failure/refund, so operators can reconcile provider state before touching the ledger.

SQLite production baseline:

- The app opens SQLite with WAL, `synchronous=NORMAL`, `busy_timeout=5000`, and `foreign_keys=ON`.
- Put `DB_PATH` on local persistent disk only. Do not use NFS, network sync folders, or shared remote volumes for the SQLite file.
- Keep PM2 web at `exec_mode: fork`, `instances: 1` while SQLite is the production DB. Move to Postgres before PM2 cluster mode.
- Worker heartbeats are batched by `runner_id`, including `batch_tasks` and long-running `scheduled_jobs`.

Before first production traffic and after hardware changes, run a SQLite write-contention probe on the target disk:

```bash
ORIGIN_SQLITE_STRESS_DURATION_MS=86400000 npm run stress:sqlite
```

The default pass criteria are lock/busy rate <= `0.1%`, write p99 <= `200ms`, and zero unexpected errors. If the probe fails on expected workload shape, move the Postgres migration ahead of more provider work.

## Health checks

`GET /api/health` is safe for process managers. It checks:

- Release identity from `RELEASE_ID`, `REVISION`, and `.next/BUILD_ID`.
- SQLite can open and query.
- `ORIGIN_DATA_DIR` is readable and writable.
- Free disk under `ORIGIN_DATA_DIR`, with default warn threshold `min(20%, 10GiB)` and fail threshold `min(10%, 5GiB)`.
- Storage mode and persistent-volume risk.
- `needs_review` backlog against `ORIGIN_HEALTH_NEEDS_REVIEW_THRESHOLD`.
- User JWT, admin JWT, and signed-media URL secret readiness. Production health fails on missing, duplicate, or example placeholder secrets.
- Production runtime guardrails: simulated payment must be off, insecure downloads must be off, worker expectation must be on, and the web process must not own long-running job runners.
- VevDemo config completeness when enabled.
- `origin-worker` heartbeat when `ORIGIN_EXPECT_WORKER=1`.

Use `npm run health:production` for a CLI check against `http://127.0.0.1:3000/api/health`.

## SQLite backups

Back up SQLite with the SQLite backup API rather than copying the live file:

```bash
ORIGIN_SQLITE_BACKUP_DIR=/var/lib/origin/backups ORIGIN_SQLITE_BACKUP_RETAIN=14 npm run backup:sqlite
```

The command creates a timestamped `.bak`, runs `PRAGMA integrity_check` against the backup, and removes older backups beyond the retention count. Put this under systemd timer or cron and rehearse restore before production launch.

## Deployment options

PM2:

```bash
npm ci
npm run build
ORIGIN_ENV_FILE=/etc/origin/origin.env ORIGIN_APP_DIR=/opt/origin pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
sudo cp deploy/systemd/pm2-origin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pm2-origin
```

The PM2 ecosystem file intentionally uses `exec_mode: fork`, `instances: 1`, and `kill_timeout: 60000`. PM2 itself should be guarded by systemd via `pm2-origin.service`; otherwise the PM2 daemon becomes the unguarded single point.

systemd:

```bash
sudo mkdir -p /etc/origin /var/lib/origin/data
sudo install -m 600 deploy/origin.env.example /etc/origin/origin.env
sudo cp deploy/systemd/origin-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now origin-web origin-worker
```

## Durable task rules

- Legal task states: `queued`, `running`, `upstream_pending`, `retry_pending`, `completed`, `failed`, `cancelled`, `needs_review`.
- `queued -> cancelled` is legal and is used by batch cancel/reap before provider submission.
- `completed`, `failed`, and `cancelled` are terminal. Manual retry creates a new task linked by `parent_task_id`; do not flip `failed` back to `queued`.
- Any task with `needs_review` keeps the parent batch in `running` so the UI/admin queue does not hide unresolved work.
- Every status change must go through `transitionTaskStatus(...)`, which appends `task_state_history`.
- Task charge/refund uses `charge:<taskId>` and `refund:<taskId>` unique refs. Retry does not create another charge or refund.

## Online editor downloads

VevDemo export URLs are temporary. Origin stores `remoteUrlExpiresAt` under `exports.edl_json.vevDemo` and the worker scan uses a `scheduled_jobs` row named `online_editor_download_scan`.

- Near expiry writes `nearExpiryWarning` metadata for observability and a structured JSON warning with `severity="warn"` and `event="online_editor_download_near_expiry"`.
- Expired URLs are marked `local_download_status='download_failed'`, `error_msg='url_expired_need_reexport'`, and `vevDemo.needsReviewReason='url_expired_need_reexport'`.
- The frontend treats that reason as a re-export case and shows a `重新导出` action instead of retrying a dead URL.
- Local download retry is capped by `ORIGIN_ONLINE_EDITOR_DOWNLOAD_MAX_ATTEMPTS` and uses exponential backoff from `ORIGIN_ONLINE_EDITOR_DOWNLOAD_RETRY_BASE_MS`.
- Production download URLs must be `https:`. Non-production can set `ORIGIN_ALLOW_INSECURE_DOWNLOAD=1` for `http:` mock providers, but SSRF checks still apply.
- The downloader rejects private/link-local IPv4 and IPv6 ranges, validates every redirect hop, and enforces a stream byte cap. DNS rebinding remains a known P2 limitation; see `docs/known-limitations.md`.
- Download content types are intentionally narrow in P1: `video/*`, `application/octet-stream`, and `binary/octet-stream`. Extend this allowlist before connecting providers that return PDFs, subtitles, or other artifact types.

## Problem queue operations

P1 exposes the problem queue API and audit trail first. If the admin page has no action button for a one-off repair, operators can use an authenticated admin cookie and a fresh idempotency key:

```bash
curl -X POST https://origin.example.com/api/admin/problem-queue \
  -H "content-type: application/json" \
  -H "x-admin-reason: manual requeue after provider reconciliation" \
  -H "x-idempotency-key: $(uuidgen)" \
  -b "admin_token=<admin_cookie>" \
  -d '{"action":"requeue","taskId":"<batch_task_id>"}'
```

Bulk requeue derives its idempotency key from the sorted task list plus the `force` flag, so callers do not need to provide one:

```bash
curl -X POST https://origin.example.com/api/admin/problem-queue \
  -H "content-type: application/json" \
  -H "x-admin-reason: bulk requeue after provider incident" \
  -b "admin_token=<admin_cookie>" \
  -d '{"action":"bulk_requeue","taskIds":["task_a","task_b"],"force":false}'
```

## Provider integration modes

| Provider | Integration mode | P1 state |
| --- | --- | --- |
| 火山 Seedream image | `polling` | Capability row is tracked as `volcengine_seedream_image`; submit/query/recoverByKey remain research items before implementation. |
| 火山 Seedance video | `polling` | Implemented for durable video batches: submit persists `provider_task_id`, moves the task to `upstream_pending`, and `origin-worker` polls `/contents/generations/tasks/{id}` through `lib/provider-polling-worker.ts`. |
| VevDemo export | `polling` | Implemented for online-editor exports: browser submit events persist `provider_task_id` in `vevdemo_export_tasks`, `origin-worker` polls Volcengine `GetTaskList`, resolves output Vid to a playable URL when needed, then hands the URL to the existing `exports` download path. `vevdemo:exportComplete` with a URL remains a fast path. |

The code-level capability registry lives in `lib/provider-recovery.ts`. Unknown support means "do not assume"; if a task only has a local `idempotency_key` and no `provider_task_id`, the recovery path must enter `needs_review` until a provider-specific `recoverByKey` implementation is verified.

## VevDemo callback security

`POST /api/volcengine/export-callback` supports HMAC enforcement. In production, or when `ORIGIN_REQUIRE_VEVDEMO_HMAC=1`, missing `VEVDEMO_CALLBACK_SECRET` is a hard failure:

- VevDemo signs `${timestamp}.${rawBody}` with HMAC-SHA256.
- Headers: `x-vevdemo-timestamp` and `x-vevdemo-signature` (`sha256=<hex>` or raw hex).
- Timestamp skew over 5 minutes is rejected.
- `VEVDEMO_CALLBACK_SECRET_PREV` is accepted during rotation.
- `exports(provider, external_export_id)` is unique. The handler uses `INSERT OR IGNORE` plus readback, so simultaneous duplicate callbacks return the existing export record and do not enqueue another download.

## Current limits

This phase keeps SQLite and local file serving, but moves them behind `ORIGIN_DATA_DIR` so the release directory can be replaced safely. Real object storage is intentionally not half-wired: once S3/TOS/COS is chosen, the next step is to move images/videos/uploads/exports writes behind a storage adapter and store object keys in the existing tables.
