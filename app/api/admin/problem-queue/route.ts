import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { withAdminAudit, type AdminAuditContext } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { ADMIN_THRESHOLDS, hoursAgoIso, minutesAgoIso } from '@/lib/admin-thresholds';
import { getModelRoutingStatus } from '@/lib/model-routing';
import { modelMetricsSnapshot } from '@/lib/observability-events';
import { refundTaskLedger, transitionTaskStatus } from '@/lib/durable-tasks';
import { costForBatchType, finalizeBatchFromTasks, taskChargeRef } from '@/lib/batch-task-accounting';
import {
  bulkRequeueIdempotencyKey,
  normalizeTaskIds,
  type BulkRequeueFailureReason,
} from '@/lib/problem-queue-actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const BULK_REQUEUE_MAX_TASKS = 100;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const db = getDb();
  const staleSince = minutesAgoIso(ADMIN_THRESHOLDS.staleTaskMinutes);
  const failureSince = minutesAgoIso(ADMIN_THRESHOLDS.heavyFailureWindowMinutes);
  const refundSince = hoursAgoIso(ADMIN_THRESHOLDS.refundRatioWindowHours);

  const staleTasks = [
    ...db.prepare<{ since: string }, any>(
      `SELECT 'batch' AS source, id, owner_id AS ownerId, project_id AS projectId, batch_type AS kind,
              status, COALESCE(error_message, '') AS reason,
              COALESCE(runner_heartbeat_at, updated_at, created_at) AS lastSignalAt,
              created_at AS createdAt
         FROM batches
        WHERE status = 'running'
          AND COALESCE(runner_heartbeat_at, updated_at, created_at) < @since
        ORDER BY COALESCE(runner_heartbeat_at, updated_at, created_at) ASC
        LIMIT 30`,
    ).all({ since: staleSince }),
    ...db.prepare<{ since: string }, any>(
      `SELECT 'batch_task' AS source, bt.id, b.owner_id AS ownerId, b.project_id AS projectId, b.batch_type AS kind,
              bt.status, COALESCE(bt.error_message, bt.error_msg, '') AS reason,
              bt.updated_at AS lastSignalAt, bt.created_at AS createdAt
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.status = 'running'
          AND bt.updated_at < @since
        ORDER BY bt.updated_at ASC
        LIMIT 30`,
    ).all({ since: staleSince }),
    ...db.prepare<{ since: string }, any>(
      `SELECT 'video_task' AS source, id, owner_id AS ownerId, project_id AS projectId, 'video' AS kind,
              status, COALESCE(error_message, error_msg, '') AS reason,
              updated_at AS lastSignalAt, created_at AS createdAt
         FROM video_tasks
        WHERE status = 'running'
          AND updated_at < @since
        ORDER BY updated_at ASC
        LIMIT 30`,
    ).all({ since: staleSince }),
    ...db.prepare<{ since: string }, any>(
      `SELECT 'export' AS source, id, owner_id AS ownerId, project_id AS projectId, 'export' AS kind,
              status, COALESCE(error_message, error_msg, '') AS reason,
              updated_at AS lastSignalAt, created_at AS createdAt
         FROM exports
        WHERE status = 'running'
          AND updated_at < @since
        ORDER BY updated_at ASC
        LIMIT 30`,
    ).all({ since: staleSince }),
  ].sort((a, b) => String(a.lastSignalAt || '').localeCompare(String(b.lastSignalAt || ''))).slice(0, 40);

  const needsReviewTasks = db.prepare<[], any>(
    `SELECT bt.id,
            bt.batch_id AS batchId,
            b.owner_id AS ownerId,
            b.project_id AS projectId,
            b.batch_type AS kind,
            bt.task_type AS taskType,
            bt.status,
            COALESCE(bt.status_reason, bt.error_message, bt.error_msg, '') AS reason,
            bt.provider,
            bt.provider_task_id AS providerTaskId,
            bt.idempotency_key AS idempotencyKey,
            bt.retry_count AS retryCount,
            bt.max_retries AS maxRetries,
            bt.updated_at AS updatedAt,
            bt.created_at AS createdAt
       FROM batch_tasks bt
       JOIN batches b ON b.id = bt.batch_id
      WHERE bt.status = 'needs_review'
      ORDER BY bt.updated_at ASC
      LIMIT 80`,
  ).all();

  const contentRisks = db.prepare<[], any>(
    `SELECT id, owner_id AS ownerId, project_id AS projectId, source_type AS sourceType,
            source_id AS sourceId, scan_reason AS scanReason, severity, created_at AS createdAt
       FROM content_flags
      WHERE status = 'pending'
      ORDER BY
        CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 40`,
  ).all();

  const negativeBalances = db.prepare<[], any>(
    `SELECT u.id AS userId, u.username, c.total_credits AS totalCredits,
            'negative_balance' AS reason
       FROM user_credits c
       JOIN users u ON u.id = c.user_id
      WHERE c.total_credits < 0
      ORDER BY c.total_credits ASC
      LIMIT 20`,
  ).all();

  const refundAnomalies = db.prepare<{ since: string; ratio: number }, any>(
    `WITH ledger AS (
       SELECT user_id,
              SUM(CASE WHEN kind='refund' AND amount > 0 THEN amount ELSE 0 END) AS refunds,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS charges
         FROM credit_ledger
        WHERE created_at > @since
        GROUP BY user_id
     )
     SELECT u.id AS userId, u.username, ledger.refunds, ledger.charges,
            'refund_ratio' AS reason
       FROM ledger
       JOIN users u ON u.id = ledger.user_id
      WHERE ledger.charges > 0
        AND CAST(ledger.refunds AS REAL) / ledger.charges > @ratio
      ORDER BY CAST(ledger.refunds AS REAL) / ledger.charges DESC
      LIMIT 20`,
  ).all({ since: refundSince, ratio: ADMIN_THRESHOLDS.refundChargeRatio });

  const failureRows = db.prepare<{ since: string }, any>(
    `WITH failures AS (
       SELECT b.owner_id AS user_id, COUNT(*) AS failed
         FROM batch_tasks bt JOIN batches b ON b.id = bt.batch_id
        WHERE bt.updated_at > @since AND bt.status = 'failed'
        GROUP BY b.owner_id
       UNION ALL
       SELECT owner_id AS user_id, COUNT(*) AS failed
         FROM video_tasks
        WHERE updated_at > @since AND status = 'failed'
        GROUP BY owner_id
       UNION ALL
       SELECT owner_id AS user_id, COUNT(*) AS failed
         FROM exports
        WHERE updated_at > @since AND status = 'failed'
        GROUP BY owner_id
     )
     SELECT u.id AS userId, u.username, SUM(f.failed) AS failed,
            'heavy_failures' AS reason
       FROM failures f
       JOIN users u ON u.id = f.user_id
      GROUP BY u.id, u.username
     HAVING SUM(f.failed) >= ${ADMIN_THRESHOLDS.heavyFailureMinCount}
      ORDER BY failed DESC
      LIMIT 20`,
  ).all({ since: failureSince });

  const abnormalAccounts = [...negativeBalances, ...refundAnomalies, ...failureRows].slice(0, 50);

  const status = getModelRoutingStatus(null);
  const modelMetrics = modelMetricsSnapshot(10);
  const keyPoolAlerts = (['brain', 'structured', 'styleBible', 'profileDerive', 'continuity', 'image', 'video'] as const)
    .map((slot) => {
      const cfg = status[slot];
      const metric = aggregateSlotMetrics(modelMetrics.rows.filter((row: any) => String(row.slot || '') === slot));
      const metricAlert = metric.failed > 0 || metric.rateLimited > 0 || metric.fallbackUsed > 0;
      return {
        slot,
        mode: cfg.mode,
        source: cfg.source,
        provider: cfg.provider,
        model: cfg.model,
        metrics: metric,
        alert: cfg.mode !== 'real' || metricAlert,
        reason: cfg.mode !== 'real'
          ? 'not_configured_or_fallback'
          : metric.fallbackUsed > 0
            ? `fallback_used:${metric.fallbackUsed}`
            : metric.rateLimited > 0
              ? `rate_limited:${metric.rateLimited}`
              : metric.failed > 0
                ? `failed:${metric.failed}`
                : '',
      };
    })
    .filter((item) => item.alert);

  return jsonOk({
    thresholds: ADMIN_THRESHOLDS,
    staleTasks,
    needsReviewTasks,
    contentRisks,
    abnormalAccounts,
    keyPoolAlerts,
    generatedAt: new Date().toISOString(),
  });
}

function aggregateSlotMetrics(rows: any[]) {
  return {
    failed: rows.reduce((sum, row) => sum + Number(row.failed || 0), 0),
    rateLimited: rows.reduce((sum, row) => sum + Number(row.rateLimited || 0), 0),
    fallbackUsed: rows.reduce((sum, row) => sum + Number(row.fallbackUsed || 0), 0),
  };
}

function bulkFailure(taskId: string, reason: BulkRequeueFailureReason, detail?: string) {
  return { taskId, reason, detail: detail || reason };
}

function isConcurrentTransitionError(error: any) {
  const msg = String(error?.message || error || '');
  return /status mismatch|transition race/i.test(msg);
}

async function handleBulkRequeue(audit: AdminAuditContext, reason: string) {
  const body = audit.body || {};
  const taskIds = normalizeTaskIds(body?.taskIds);
  const force = body?.force === true;
  if (taskIds.length === 0) return jsonError('taskIds required', 400);
  if (taskIds.length > BULK_REQUEUE_MAX_TASKS) {
    return jsonError(`bulk_requeue supports at most ${BULK_REQUEUE_MAX_TASKS} tasks`, 400);
  }

  const db = getDb();
  const ok: Array<{ taskId: string; from: 'needs_review'; to: 'queued' }> = [];
  const failed: Array<ReturnType<typeof bulkFailure>> = [];
  const diffItems: Array<{ id: string; before: unknown; after: unknown }> = [];
  const affectedBatchIds = new Set<string>();

  audit.setAuditTarget({ type: 'batch_task', ids: taskIds });

  for (const id of taskIds) {
    const before = db
      .prepare<{ id: string }, any>(
        `SELECT bt.*, b.owner_id, b.batch_type
           FROM batch_tasks bt
           JOIN batches b ON b.id = bt.batch_id
          WHERE bt.id = @id`,
      )
      .get({ id });
    if (!before) {
      failed.push(bulkFailure(id, 'task_not_found'));
      continue;
    }
    if (before.status !== 'needs_review') {
      failed.push(bulkFailure(id, 'status_not_allowed', String(before.status || '')));
      continue;
    }

    const retryCount = Number(before.retry_count || 0);
    const maxRetries = Number(before.max_retries ?? 3);
    if (!force && retryCount >= maxRetries) {
      failed.push(bulkFailure(id, 'retry_count_exceeded'));
      continue;
    }

    try {
      const update = db.prepare(
        `UPDATE batch_tasks
            SET runner_id = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                cancel_requested_at = NULL,
                next_retry_at = NULL,
                error_msg = NULL,
                error_message = NULL,
                status_reason = @reason,
                retry_count = COALESCE(retry_count, 0) + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @taskId
            AND status = 'needs_review'`,
      ).run({ taskId: id, reason });
      transitionTaskStatus({
        taskId: id,
        from: 'needs_review',
        to: 'queued',
        reason,
        actor: `admin:${audit.admin.username}`,
        runnerId: null,
        meta: { adminUserId: audit.admin.id, action: 'bulk_requeue', force },
      });
      const after = db.prepare<{ id: string }, any>('SELECT * FROM batch_tasks WHERE id = @id').get({ id });
      ok.push({ taskId: id, from: 'needs_review', to: 'queued' });
      affectedBatchIds.add(String(before.batch_id));
      diffItems.push({ id, before, after });
    } catch (e: any) {
      failed.push(bulkFailure(id, isConcurrentTransitionError(e) ? 'concurrent_modification' : 'internal_error', e?.message || String(e)));
    }
  }

  const finalizedBatchIds: string[] = [];
  const batchResults: Record<string, unknown> = {};
  for (const batchId of affectedBatchIds) {
    batchResults[batchId] = finalizeBatchFromTasks(batchId);
    finalizedBatchIds.push(batchId);
  }
  audit.setAuditDiff({ items: diffItems });
  return jsonOk({
    success: true,
    action: 'bulk_requeue',
    idempotencyKey: audit.idempotencyKey,
    ok,
    failed,
    finalizedBatchIds,
    batches: batchResults,
    meta: { force },
  });
}

export const POST = withAdminAudit(async function resolveProblemQueueTask(_req: NextRequest, audit) {
  const body = audit.body || {};
  const taskId = String(body?.taskId || '').trim();
  const action = String(body?.action || '').trim();
  const reason = String(audit.reason || body?.reason || `admin ${action}`).slice(0, 500);
  if (action === 'bulk_requeue') {
    return handleBulkRequeue(audit, reason);
  }
  if (!taskId) return jsonError('taskId required', 400);
  if (!['requeue', 'force_fail', 'cancel'].includes(action)) return jsonError('unsupported action', 400);

  const db = getDb();
  const task = db
    .prepare<{ id: string }, any>(
      `SELECT bt.*, b.owner_id, b.batch_type
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.id = @id`,
    )
    .get({ id: taskId });
  if (!task) return jsonError('task not found', 404);
  if (task.status !== 'needs_review') return jsonError('task is not in needs_review', 409);
  audit.setAuditTarget({ type: 'batch_task', ids: [taskId] });
  audit.setAuditDiff({ before: { task } });

  try {
    if (action === 'requeue') {
      const force = body?.force === true;
      const retryCount = Number(task.retry_count || 0);
      const maxRetries = Number(task.max_retries ?? 3);
      if (!force && retryCount >= maxRetries) {
        return jsonError('retry_count_exceeded', 409);
      }
      const update = db.prepare(
        `UPDATE batch_tasks
            SET runner_id = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                cancel_requested_at = NULL,
                next_retry_at = NULL,
                error_msg = NULL,
                error_message = NULL,
                status_reason = @reason,
                retry_count = COALESCE(retry_count, 0) + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @taskId
            AND status = 'needs_review'`,
      ).run({ taskId, reason });
      if (update.changes !== 1) {
        return jsonError('concurrent_modification', 409);
      }
      transitionTaskStatus({
        taskId,
        from: 'needs_review',
        to: 'queued',
        reason,
        actor: `admin:${audit.admin.username}`,
        runnerId: null,
        meta: { adminUserId: audit.admin.id, action, force },
      });
    } else if (action === 'force_fail') {
      const amount = costForBatchType(String(task.batch_type || ''));
      const hasCharge = db
        .prepare<{ ref: string }, any>('SELECT id FROM credit_ledger WHERE charge_ref_id = @ref LIMIT 1')
        .get({ ref: taskChargeRef(taskId) });
      if (body?.refund === true && amount > 0 && hasCharge) {
        refundTaskLedger({
          userId: Number(task.owner_id),
          taskId,
          amount,
          reason: `admin force_fail refund:${task.batch_type || 'batch'}`,
        });
      }
      db.prepare(
        `UPDATE batch_tasks
            SET error_msg = @reason,
                error_message = @reason,
                status_reason = @reason,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @taskId`,
      ).run({ taskId, reason });
      transitionTaskStatus({
        taskId,
        from: 'needs_review',
        to: 'failed',
        reason,
        actor: `admin:${audit.admin.username}`,
        runnerId: null,
        meta: { adminUserId: audit.admin.id, action, refund: body?.refund === true },
      });
    } else if (action === 'cancel') {
      db.prepare(
        `UPDATE batch_tasks
            SET status_reason = @reason,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = @taskId`,
      ).run({ taskId, reason });
      transitionTaskStatus({
        taskId,
        from: 'needs_review',
        to: 'cancelled',
        reason,
        actor: `admin:${audit.admin.username}`,
        runnerId: null,
        meta: { adminUserId: audit.admin.id, action },
      });
    }
    const batch = finalizeBatchFromTasks(String(task.batch_id));
    const after = db.prepare<{ id: string }, any>('SELECT * FROM batch_tasks WHERE id = @id').get({ id: taskId });
    audit.setAuditDiff({ before: { task }, after: { task: after, batch } });
    return jsonOk({ success: true, taskId, action, batch });
  } catch (e: any) {
    return jsonError(e?.message || 'problem queue action failed', 500);
  }
}, 'task.problem_queue.resolve', {
  category: 'task',
  idempotent: true,
  deriveIdempotencyKey(body) {
    if (String(body?.action || '').trim() !== 'bulk_requeue') return '';
    return bulkRequeueIdempotencyKey(normalizeTaskIds(body?.taskIds), body?.force === true);
  },
});
