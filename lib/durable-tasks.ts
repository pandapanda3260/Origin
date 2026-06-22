import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { chargeCredits, refundCredits, type CreditKind } from './credits';
import { taskChargeRef, taskRefundRef } from './batch-task-accounting';

export type DurableTaskStatus =
  | 'queued'
  | 'running'
  | 'upstream_pending'
  | 'retry_pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_review';

export const TASK_STATUS_TRANSITIONS: Record<DurableTaskStatus, DurableTaskStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'retry_pending', 'upstream_pending', 'needs_review', 'cancelled'],
  upstream_pending: ['completed', 'failed', 'retry_pending', 'needs_review', 'cancelled'],
  retry_pending: ['queued', 'needs_review', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  needs_review: ['queued', 'upstream_pending', 'failed', 'cancelled'],
};

export const DEFAULT_TASK_LEASE_MS = 60_000;

export function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

export function assertTaskTransition(from: DurableTaskStatus, to: DurableTaskStatus) {
  if (from === to) return;
  const allowed = TASK_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`illegal task status transition: ${from} -> ${to}`);
  }
}

function parseStatus(value: unknown): DurableTaskStatus {
  const status = String(value || '');
  if (Object.prototype.hasOwnProperty.call(TASK_STATUS_TRANSITIONS, status)) {
    return status as DurableTaskStatus;
  }
  throw new Error(`unknown task status: ${status || '(empty)'}`);
}

function stringifyMeta(meta: unknown) {
  if (!meta || typeof meta !== 'object') return '{}';
  try { return JSON.stringify(meta); } catch { return '{}'; }
}

export function transitionTaskStatus(opts: {
  taskId: string;
  to: DurableTaskStatus;
  from?: DurableTaskStatus;
  reason: string;
  actor?: string;
  runnerId?: string | null;
  meta?: Record<string, any>;
  nowMs?: number;
}) {
  const db = getDb();
  const at = nowIso(opts.nowMs);
  const actor = opts.actor || 'system';
  let changed = false;
  const txn = db.transaction(() => {
    const row = db
      .prepare<{ id: string }, { status: string }>('SELECT status FROM batch_tasks WHERE id = @id')
      .get({ id: opts.taskId });
    if (!row) throw new Error(`task not found: ${opts.taskId}`);
    const from = parseStatus(row.status);
    if (opts.from && from !== opts.from) {
      throw new Error(`task ${opts.taskId} status mismatch: expected ${opts.from}, got ${from}`);
    }
    if (from === opts.to) return;
    assertTaskTransition(from, opts.to);
    const result = db
      .prepare(
        `UPDATE batch_tasks
            SET status = @to,
                status_reason = @reason,
                updated_at = @at
          WHERE id = @taskId
            AND status = @from`,
      )
      .run({ taskId: opts.taskId, from, to: opts.to, reason: opts.reason.slice(0, 500), at });
    if (result.changes !== 1) {
      throw new Error(`task status transition race: ${opts.taskId} ${from} -> ${opts.to}`);
    }
    db
      .prepare(
        `INSERT INTO task_state_history
          (id, task_id, from_state, to_state, reason, actor, runner_id, meta_json, created_at)
         VALUES (@id, @taskId, @from, @to, @reason, @actor, @runnerId, @metaJson, @at)`,
      )
      .run({
        id: randomUUID(),
        taskId: opts.taskId,
        from,
        to: opts.to,
        reason: opts.reason.slice(0, 500),
        actor,
        runnerId: opts.runnerId || null,
        metaJson: stringifyMeta(opts.meta),
        at,
      });
    changed = true;
  });
  txn.immediate();
  return { changed };
}

export function releaseExpiredTaskLeases(opts: { nowMs?: number } = {}) {
  const now = nowIso(opts.nowMs);
  return getDb()
    .prepare(
      `UPDATE batch_tasks
          SET runner_id = NULL,
              heartbeat_at = NULL,
              updated_at = @now
        WHERE status IN ('running', 'upstream_pending')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < @now`,
    )
    .run({ now }).changes;
}

export function claimNextTask(opts: {
  runnerId: string;
  nowMs?: number;
  leaseMs?: number;
  taskTypes?: string[];
  batchId?: string;
  statuses?: DurableTaskStatus[];
  excludeIds?: string[];
}) {
  const db = getDb();
  const at = nowIso(opts.nowMs);
  const lease = nowIso((opts.nowMs ?? Date.now()) + (opts.leaseMs ?? DEFAULT_TASK_LEASE_MS));
  const taskTypes = (opts.taskTypes || []).map((s) => String(s).trim()).filter(Boolean);
  const excludeIds = Array.from(new Set((opts.excludeIds || []).map((s) => String(s).trim()).filter(Boolean)));
  const statuses = (opts.statuses && opts.statuses.length ? opts.statuses : ['queued', 'retry_pending', 'running', 'upstream_pending'])
    .map((status) => parseStatus(status));
  const taskTypeSql = taskTypes.length
    ? `AND task_type IN (${taskTypes.map(() => '?').join(',')})`
    : '';
  const batchSql = opts.batchId ? 'AND batch_id = ?' : '';
  const excludeSql = excludeIds.length
    ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})`
    : '';
  const sql = `
    UPDATE batch_tasks
       SET runner_id = ?,
           lease_expires_at = ?,
           heartbeat_at = ?,
           idempotency_key = COALESCE(idempotency_key, 'task:' || id),
           updated_at = ?
     WHERE id = (
       SELECT id FROM batch_tasks
        WHERE status IN (${statuses.map(() => '?').join(',')})
          AND (runner_id IS NULL OR runner_id = '' OR lease_expires_at IS NULL OR lease_expires_at < ?)
          AND (next_retry_at IS NULL OR next_retry_at = '' OR next_retry_at <= ?)
          ${excludeSql}
          ${taskTypeSql}
          ${batchSql}
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
     )
     RETURNING *`;
  const params = [
    opts.runnerId,
    lease,
    at,
    at,
    ...statuses,
    at,
    at,
    ...excludeIds,
    ...taskTypes,
    ...(opts.batchId ? [opts.batchId] : []),
  ];
  return db.prepare(sql).get(...params) as any | undefined;
}

export function batchHeartbeat(opts: { runnerId: string; nowMs?: number; leaseMs?: number }) {
  const at = nowIso(opts.nowMs);
  const lease = nowIso((opts.nowMs ?? Date.now()) + (opts.leaseMs ?? DEFAULT_TASK_LEASE_MS));
  const db = getDb();
  const txn = db.transaction(() => {
    const taskChanges = db
      .prepare(
        `UPDATE batch_tasks
            SET lease_expires_at = @lease,
                heartbeat_at = @at,
                updated_at = @at
          WHERE runner_id = @runnerId
            AND status IN ('running', 'upstream_pending')`,
      )
      .run({ runnerId: opts.runnerId, lease, at }).changes;
    const jobChanges = db
      .prepare(
        `UPDATE scheduled_jobs
            SET lease_expires_at = @lease,
                heartbeat_at = @at,
                updated_at = @at
          WHERE runner_id = @runnerId
            AND status = 'running'`,
      )
      .run({ runnerId: opts.runnerId, lease, at }).changes;
    return { taskChanges, jobChanges };
  });
  return txn.immediate();
}

export function requestTaskCancel(opts: {
  taskId: string;
  actor?: string;
  reason?: string;
  nowMs?: number;
}) {
  const db = getDb();
  const at = nowIso(opts.nowMs);
  const reason = opts.reason || 'cancel requested';
  const row = db
    .prepare<{ id: string }, { status: string }>('SELECT status FROM batch_tasks WHERE id = @id')
    .get({ id: opts.taskId });
  if (!row) throw new Error(`task not found: ${opts.taskId}`);
  const status = parseStatus(row.status);
  if (status === 'queued' || status === 'retry_pending') {
    transitionTaskStatus({
      taskId: opts.taskId,
      from: status,
      to: 'cancelled',
      reason,
      actor: opts.actor || 'user',
      nowMs: opts.nowMs,
    });
    return { mode: 'cancelled' as const };
  }
  if (status === 'running' || status === 'upstream_pending') {
    db
      .prepare(
        `UPDATE batch_tasks
            SET cancel_requested_at = COALESCE(cancel_requested_at, @at),
                status_reason = @reason,
                updated_at = @at
          WHERE id = @taskId`,
      )
      .run({ taskId: opts.taskId, at, reason });
    return { mode: 'requested' as const };
  }
  return { mode: 'ignored' as const };
}

export function chargeTaskLedger(opts: {
  userId: number;
  taskId: string;
  amount: number;
  kind: CreditKind;
  reason: string;
}) {
  return chargeCredits({
    userId: opts.userId,
    amount: opts.amount,
    kind: opts.kind,
    reason: opts.reason,
    refId: opts.taskId,
    chargeRefId: taskChargeRef(opts.taskId),
    idempotencyKey: taskChargeRef(opts.taskId),
  });
}

export function refundTaskLedger(opts: {
  userId: number;
  taskId: string;
  amount: number;
  reason: string;
}) {
  return refundCredits({
    userId: opts.userId,
    amount: opts.amount,
    reason: opts.reason,
    refId: opts.taskId,
    refundRefId: taskRefundRef(opts.taskId),
    idempotencyKey: taskRefundRef(opts.taskId),
  });
}
