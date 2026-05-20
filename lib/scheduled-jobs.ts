import { getDb } from './db';
import { DEFAULT_TASK_LEASE_MS, nowIso } from './durable-tasks';

export type ScheduledJobCatchUpStrategy = 'run_once' | 'replay_intervals' | 'current_state_only';

export function ensureScheduledJob(opts: {
  jobName: string;
  catchUpStrategy: ScheduledJobCatchUpStrategy;
  nextRunAt?: string | null;
  meta?: Record<string, any>;
}) {
  const at = nowIso();
  getDb()
    .prepare(
      `INSERT INTO scheduled_jobs
        (job_name, status, catch_up_strategy, next_run_at, meta_json, created_at, updated_at)
       VALUES (@jobName, 'idle', @catchUpStrategy, @nextRunAt, @metaJson, @at, @at)
       ON CONFLICT(job_name) DO UPDATE SET
         catch_up_strategy = excluded.catch_up_strategy,
         next_run_at = COALESCE(scheduled_jobs.next_run_at, excluded.next_run_at),
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`,
    )
    .run({
      jobName: opts.jobName,
      catchUpStrategy: opts.catchUpStrategy,
      nextRunAt: opts.nextRunAt || at,
      metaJson: JSON.stringify(opts.meta || {}),
      at,
    });
}

export function claimDueScheduledJob(opts: {
  jobName: string;
  runnerId: string;
  nowMs?: number;
  leaseMs?: number;
}) {
  const at = nowIso(opts.nowMs);
  const lease = nowIso((opts.nowMs ?? Date.now()) + (opts.leaseMs ?? DEFAULT_TASK_LEASE_MS));
  return getDb()
    .prepare(
      `UPDATE scheduled_jobs
          SET status = 'running',
              runner_id = @runnerId,
              lease_expires_at = @lease,
              heartbeat_at = @at,
              updated_at = @at
        WHERE job_name = @jobName
          AND (next_run_at IS NULL OR next_run_at = '' OR next_run_at <= @at)
          AND (
            status <> 'running'
            OR runner_id IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at < @at
          )
        RETURNING *`,
    )
    .get({ jobName: opts.jobName, runnerId: opts.runnerId, lease, at }) as any | undefined;
}

export function completeScheduledJob(opts: {
  jobName: string;
  runnerId: string;
  nextRunAt?: string | null;
  nowMs?: number;
  meta?: Record<string, any>;
}) {
  const at = nowIso(opts.nowMs);
  const result = getDb()
    .prepare(
      `UPDATE scheduled_jobs
          SET status = 'idle',
              last_run_at = @at,
              next_run_at = @nextRunAt,
              runner_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              meta_json = @metaJson,
              updated_at = @at
        WHERE job_name = @jobName
          AND runner_id = @runnerId`,
    )
    .run({
      jobName: opts.jobName,
      runnerId: opts.runnerId,
      nextRunAt: opts.nextRunAt || null,
      metaJson: JSON.stringify(opts.meta || {}),
      at,
    });
  return result.changes === 1;
}

export function failScheduledJob(opts: {
  jobName: string;
  runnerId: string;
  nextRunAt?: string | null;
  error: string;
  nowMs?: number;
}) {
  const at = nowIso(opts.nowMs);
  const result = getDb()
    .prepare(
      `UPDATE scheduled_jobs
          SET status = 'failed',
              next_run_at = @nextRunAt,
              runner_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              meta_json = @metaJson,
              updated_at = @at
        WHERE job_name = @jobName
          AND runner_id = @runnerId`,
    )
    .run({
      jobName: opts.jobName,
      runnerId: opts.runnerId,
      nextRunAt: opts.nextRunAt || null,
      metaJson: JSON.stringify({ error: opts.error.slice(0, 1000) }),
      at,
    });
  return result.changes === 1;
}
