import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { finalizeBatchFromTasks, taskChargeRef, taskRefundRef } from '@/lib/batch-task-accounting';
import { cancelBatchForUser } from '@/lib/batches';
import { getDb } from '@/lib/db';
import { requestTaskCancel, refundTaskLedger, nowIso } from '@/lib/durable-tasks';
import { recordObservabilityEvent } from '@/lib/observability-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TaskSource = 'batch' | 'batch_task' | 'video_task' | 'export';

const SOURCES: TaskSource[] = ['batch', 'batch_task', 'video_task', 'export'];
const ACTIVE_STATUSES = new Set(['queued', 'running', 'retry_pending', 'upstream_pending', 'needs_review']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const url = new URL(req.url);
  const status = String(url.searchParams.get('status') || '').trim();
  const source = normalizeSource(url.searchParams.get('source'));
  const q = String(url.searchParams.get('q') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 80, 1, 200);
  const selectedSources = source ? [source] : SOURCES;

  const items = selectedSources
    .flatMap((src) => listTasks(src, { status, q, limit }))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, limit);

  return jsonOk({
    items,
    summary: taskSummary(),
    filters: { source: source || '', status, q, limit },
    generatedAt: new Date().toISOString(),
  });
}

export const POST = withAdminAudit(async function mutateTask(_req: NextRequest, audit) {
  const body = audit.body || {};
  const source = normalizeSource(body.source);
  const taskId = String(body.id || body.taskId || '').trim();
  const action = String(body.action || '').trim();
  const reason = String(audit.reason || body.reason || `admin ${action}`).slice(0, 500);

  if (!source) return jsonError('source required', 400);
  if (!taskId) return jsonError('id required', 400);
  if (!['cancel', 'retry', 'force_fail', 'refund_check'].includes(action)) {
    return jsonError('unsupported action', 400);
  }

  const before = readTask(source, taskId);
  if (!before) return jsonError('task not found', 404);

  audit.setAuditTarget({ type: source, ids: [taskId] });
  const plan = planTaskAction(source, before, action, reason);
  if (plan.blocked) {
    audit.setAuditDiff({ before, after: before });
    return jsonError('blockReason' in plan ? plan.blockReason : 'task action blocked', 409);
  }

  if (audit.dryRun) {
    audit.setAuditDiff({ before, after: plan.after });
    return jsonOk(dryRunPayload(`task.${action}`, { type: source, ids: [taskId] }, { before, after: plan.after }, plan.warnings));
  }

  let result: any;
  if (source === 'batch') result = commitBatchAction(before, action, reason);
  else if (source === 'batch_task') result = commitBatchTaskAction(before, action, reason, audit.admin.username);
  else if (source === 'video_task') result = commitSimpleTaskAction('video_tasks', before, action, reason);
  else result = commitSimpleTaskAction('exports', before, action, reason);

  const after = readTask(source, taskId) || plan.after;
  audit.setAuditDiff({ before, after });
  return jsonOk({ success: true, source, id: taskId, action, result, item: after });
}, 'task.unified.mutate', {
  category: 'task',
  supportDryRun: true,
  idempotent: true,
});

function listTasks(source: TaskSource, filters: { status: string; q: string; limit: number }) {
  if (source === 'batch') return listBatches(filters);
  if (source === 'batch_task') return listBatchTasks(filters);
  if (source === 'video_task') return listVideoTasks(filters);
  return listExports(filters);
}

function listBatches(filters: { status: string; q: string; limit: number }) {
  return getDb().prepare<any, any>(
    `SELECT 'batch' AS source,
            b.id,
            b.owner_id AS ownerId,
            u.username,
            b.project_id AS projectId,
            p.title AS projectTitle,
            b.batch_type AS kind,
            NULL AS taskType,
            b.status,
            COALESCE(b.error_message, '') AS reason,
            b.total,
            b.succeeded,
            b.failed,
            NULL AS progress,
            NULL AS provider,
            b.runner_id AS runnerId,
            NULL AS providerTaskId,
            COALESCE(b.runner_heartbeat_at, b.updated_at, b.created_at) AS lastSignalAt,
            b.created_at AS createdAt,
            b.updated_at AS updatedAt
       FROM batches b
       LEFT JOIN users u ON u.id = b.owner_id
       LEFT JOIN projects p ON p.id = b.project_id
      WHERE (@status = '' OR b.status = @status)
        AND (
          @q = ''
          OR b.id = @q
          OR b.project_id = @q
          OR CAST(b.owner_id AS TEXT) = @q
          OR u.username LIKE @like
          OR p.title LIKE @like
        )
      ORDER BY b.updated_at DESC
      LIMIT @limit`,
  ).all(queryParams(filters));
}

function listBatchTasks(filters: { status: string; q: string; limit: number }) {
  return getDb().prepare<any, any>(
    `SELECT 'batch_task' AS source,
            bt.id,
            b.owner_id AS ownerId,
            u.username,
            b.project_id AS projectId,
            p.title AS projectTitle,
            b.batch_type AS kind,
            bt.task_type AS taskType,
            bt.status,
            COALESCE(bt.status_reason, bt.error_message, bt.error_msg, '') AS reason,
            NULL AS total,
            NULL AS succeeded,
            NULL AS failed,
            NULL AS progress,
            bt.provider,
            bt.runner_id AS runnerId,
            bt.provider_task_id AS providerTaskId,
            COALESCE(bt.heartbeat_at, bt.updated_at, bt.created_at) AS lastSignalAt,
            bt.created_at AS createdAt,
            bt.updated_at AS updatedAt,
            bt.batch_id AS batchId,
            bt.retry_count AS retryCount,
            bt.max_retries AS maxRetries,
            bt.cancel_requested_at AS cancelRequestedAt,
            bt.cancelled_local_at AS cancelledLocalAt,
            bt.admin_disposition AS adminDisposition,
            bt.refund_checked_at AS refundCheckedAt
       FROM batch_tasks bt
       JOIN batches b ON b.id = bt.batch_id
       LEFT JOIN users u ON u.id = b.owner_id
       LEFT JOIN projects p ON p.id = b.project_id
      WHERE (@status = '' OR bt.status = @status)
        AND (
          @q = ''
          OR bt.id = @q
          OR bt.batch_id = @q
          OR b.project_id = @q
          OR CAST(b.owner_id AS TEXT) = @q
          OR u.username LIKE @like
          OR p.title LIKE @like
        )
      ORDER BY bt.updated_at DESC
      LIMIT @limit`,
  ).all(queryParams(filters));
}

function listVideoTasks(filters: { status: string; q: string; limit: number }) {
  return getDb().prepare<any, any>(
    `SELECT 'video_task' AS source,
            vt.id,
            vt.owner_id AS ownerId,
            u.username,
            vt.project_id AS projectId,
            p.title AS projectTitle,
            'video' AS kind,
            NULL AS taskType,
            vt.status,
            COALESCE(vt.error_message, vt.error_msg, '') AS reason,
            NULL AS total,
            NULL AS succeeded,
            NULL AS failed,
            vt.progress,
            vt.provider,
            NULL AS runnerId,
            vt.provider_task AS providerTaskId,
            vt.cancel_requested_at AS cancelRequestedAt,
            vt.cancelled_local_at AS cancelledLocalAt,
            vt.admin_disposition AS adminDisposition,
            vt.refund_checked_at AS refundCheckedAt,
            vt.updated_at AS lastSignalAt,
            vt.created_at AS createdAt,
            vt.updated_at AS updatedAt
       FROM video_tasks vt
       LEFT JOIN users u ON u.id = vt.owner_id
       LEFT JOIN projects p ON p.id = vt.project_id
      WHERE (@status = '' OR vt.status = @status)
        AND (
          @q = ''
          OR vt.id = @q
          OR vt.project_id = @q
          OR CAST(vt.owner_id AS TEXT) = @q
          OR vt.provider_task = @q
          OR u.username LIKE @like
          OR p.title LIKE @like
        )
      ORDER BY vt.updated_at DESC
      LIMIT @limit`,
  ).all(queryParams(filters));
}

function listExports(filters: { status: string; q: string; limit: number }) {
  return getDb().prepare<any, any>(
    `SELECT 'export' AS source,
            e.id,
            e.owner_id AS ownerId,
            u.username,
            e.project_id AS projectId,
            p.title AS projectTitle,
            'export' AS kind,
            NULL AS taskType,
            e.status,
            COALESCE(e.error_message, e.error_msg, '') AS reason,
            NULL AS total,
            NULL AS succeeded,
            NULL AS failed,
            e.progress,
            e.provider,
            NULL AS runnerId,
            e.external_export_id AS providerTaskId,
            e.cancel_requested_at AS cancelRequestedAt,
            e.cancelled_local_at AS cancelledLocalAt,
            e.admin_disposition AS adminDisposition,
            e.refund_checked_at AS refundCheckedAt,
            e.updated_at AS lastSignalAt,
            e.created_at AS createdAt,
            e.updated_at AS updatedAt
       FROM exports e
       LEFT JOIN users u ON u.id = e.owner_id
       LEFT JOIN projects p ON p.id = e.project_id
      WHERE (@status = '' OR e.status = @status)
        AND (
          @q = ''
          OR e.id = @q
          OR e.project_id = @q
          OR CAST(e.owner_id AS TEXT) = @q
          OR e.external_export_id = @q
          OR u.username LIKE @like
          OR p.title LIKE @like
        )
      ORDER BY e.updated_at DESC
      LIMIT @limit`,
  ).all(queryParams(filters));
}

function taskSummary() {
  const db = getDb();
  const rows = [
    ...db.prepare("SELECT 'batch' AS source, status, COUNT(*) AS count FROM batches GROUP BY status").all() as any[],
    ...db.prepare("SELECT 'batch_task' AS source, status, COUNT(*) AS count FROM batch_tasks GROUP BY status").all() as any[],
    ...db.prepare("SELECT 'video_task' AS source, status, COUNT(*) AS count FROM video_tasks GROUP BY status").all() as any[],
    ...db.prepare("SELECT 'export' AS source, status, COUNT(*) AS count FROM exports GROUP BY status").all() as any[],
  ];
  return rows.reduce((acc, row) => {
    const source = String(row.source);
    acc[source] = acc[source] || {};
    acc[source][String(row.status || 'unknown')] = Number(row.count || 0);
    return acc;
  }, {} as Record<string, Record<string, number>>);
}

function readTask(source: TaskSource, id: string) {
  const rows = listTasks(source, { status: '', q: id, limit: 20 });
  return rows.find((row) => String(row.id) === id) || null;
}

function planTaskAction(source: TaskSource, before: any, action: string, reason: string) {
  const after = { ...before };
  const warnings: string[] = [];
  if (action === 'refund_check') {
    const refund = refundCandidate(source, before);
    after.refundCheck = refund;
    if (refund.refundable <= 0) warnings.push('未发现可退还的扣费，提交后不会新增退款 ledger');
    return { after, warnings, blocked: false };
  }

  if (source === 'batch') {
    if (action !== 'cancel') return blocked('batch 目前只支持取消和退款检查');
    if (!ACTIVE_STATUSES.has(String(before.status))) return blocked('只有未完成 batch 可以取消');
    after.status = 'cancel_requested';
    after.reason = reason;
    return { after, warnings, blocked: false };
  }

  if (source === 'batch_task') {
    if (action === 'cancel') {
      if (!ACTIVE_STATUSES.has(String(before.status))) return blocked('只有未完成子任务可以取消');
      after.status = ['queued', 'retry_pending', 'needs_review'].includes(String(before.status)) ? 'cancelled' : before.status;
      after.cancelRequestedAt = new Date().toISOString();
      after.reason = reason;
      return { after, warnings, blocked: false };
    }
    if (action === 'retry') {
      if (!['needs_review', 'failed', 'cancelled', 'retry_pending'].includes(String(before.status))) {
        return blocked('只有 needs_review / failed / cancelled / retry_pending 子任务可以重试');
      }
      after.status = 'queued';
      after.reason = reason;
      after.retryCount = Number(before.retryCount || 0) + 1;
      return { after, warnings, blocked: false };
    }
    if (action === 'force_fail') {
      if (TERMINAL_STATUSES.has(String(before.status)) && before.status !== 'cancelled') return blocked('任务已完成或已失败，无需强制失败');
      after.status = 'failed';
      after.reason = `admin force-fail: ${reason}`;
      return { after, warnings, blocked: false };
    }
  }

  if (source === 'video_task' || source === 'export') {
    if (action === 'retry') return blocked('视频任务和导出任务暂不支持后台重试，避免制造无法被 worker 消费的假队列');
    if (action === 'cancel') {
      if (!['queued', 'running'].includes(String(before.status))) return blocked('只有 queued / running 状态可取消');
      after.status = 'cancelled';
      after.reason = reason;
      return { after, warnings, blocked: false };
    }
    if (action === 'force_fail') {
      if (!['queued', 'running'].includes(String(before.status))) return blocked('只有 queued / running 状态可强制失败');
      after.status = 'failed';
      after.reason = `admin force-fail: ${reason}`;
      return { after, warnings, blocked: false };
    }
  }

  return blocked('unsupported action for this task');
}

function blocked(blockReason: string) {
  return { after: {}, warnings: [], blocked: true, blockReason };
}

function commitBatchAction(before: any, action: string, reason: string) {
  if (action === 'refund_check') return applyRefundCheck('batch', before, reason);
  if (action !== 'cancel') throw statusError('batch only supports cancel', 400);
  const activeTasks = getDb().prepare<{ batchId: string }, any>(
    `SELECT bt.id, b.owner_id AS ownerId
       FROM batch_tasks bt
       JOIN batches b ON b.id = bt.batch_id
      WHERE bt.batch_id = @batchId
        AND bt.status IN ('queued','running','retry_pending','upstream_pending','needs_review')`,
  ).all({ batchId: String(before.id) });
  const cancel = cancelBatchForUser({ batchId: String(before.id), ownerId: Number(before.ownerId), reason: `admin cancel: ${reason}` });
  const refund = refundTaskRows(activeTasks, `admin auto-refund:batch.cancel:${reason}`);
  markBatchTaskRefundChecked(activeTasks.map((task) => String(task.id)));
  return { ...cancel, refund };
}

function commitBatchTaskAction(before: any, action: string, reason: string, adminUsername: string) {
  if (action === 'refund_check') return applyRefundCheck('batch_task', before, reason);
  if (action === 'cancel') {
    let result: any;
    if (before.status === 'needs_review') {
      forceBatchTaskStatus(String(before.id), 'cancelled', reason, adminUsername);
      result = { mode: 'cancelled' };
    } else {
      result = requestTaskCancel({ taskId: String(before.id), actor: `admin:${adminUsername}`, reason });
      markBatchTaskAdminDisposition(String(before.id), result.mode === 'cancelled' ? 'cancelled_local' : 'cancel_requested');
    }
    const refund = applyRefundCheck('batch_task', before, `admin auto-refund:batch_task.cancel:${reason}`);
    if (before.batchId) finalizeBatchFromTasks(String(before.batchId));
    return { ...result, refund };
  }
  if (action === 'retry') {
    requeueBatchTask(before, reason, adminUsername);
    if (before.batchId) finalizeBatchFromTasks(String(before.batchId));
    return { mode: 'queued' };
  }
  if (action === 'force_fail') {
    forceBatchTaskStatus(String(before.id), 'failed', `admin force-fail: ${reason}`, adminUsername);
    const refund = applyRefundCheck('batch_task', before, `admin auto-refund:batch_task.force_fail:${reason}`);
    if (before.batchId) finalizeBatchFromTasks(String(before.batchId));
    return { mode: 'failed', refund };
  }
  throw statusError('unsupported batch_task action', 400);
}

function commitSimpleTaskAction(table: 'video_tasks' | 'exports', before: any, action: string, reason: string) {
  const source = table === 'video_tasks' ? 'video_task' : 'export';
  if (action === 'refund_check') return applyRefundCheck(source, before, reason);
  if (action === 'retry') throw statusError(`${source} retry is not supported`, 400);
  const status = action === 'cancel' ? 'cancelled' : 'failed';
  const message = action === 'force_fail' ? `admin force-fail: ${reason}` : reason;
  const at = nowIso();
  const localCancel = action === 'cancel' ? markCancelledLocal(source, before) : null;
  getDb().prepare(
    `UPDATE ${table}
        SET status = @status,
            error_msg = @message,
            error_message = @message,
            cancel_requested_at = CASE WHEN @action = 'cancel' THEN COALESCE(cancel_requested_at, @at) ELSE cancel_requested_at END,
            cancelled_local_at = CASE WHEN @action = 'cancel' THEN COALESCE(cancelled_local_at, @at) ELSE cancelled_local_at END,
            admin_disposition = @disposition,
            updated_at = @at
      WHERE id = @id
        AND status IN ('queued','running')`,
  ).run({
    id: before.id,
    status,
    message,
    action,
    at,
    disposition: action === 'cancel' ? 'cancelled_local' : 'force_failed',
  });
  const refund = applyRefundCheck(source, before, `admin auto-refund:${source}.${action}:${reason}`);
  markSimpleTaskRefundChecked(table, String(before.id));
  return { mode: status, localCancel, refund };
}

function requeueBatchTask(before: any, reason: string, adminUsername: string) {
  const db = getDb();
  const id = String(before.id);
  const row = db.prepare<{ id: string }, any>('SELECT status FROM batch_tasks WHERE id = @id').get({ id });
  if (!row || !['needs_review', 'failed', 'cancelled', 'retry_pending'].includes(String(row.status))) {
    throw statusError('task cannot be retried from current status', 409);
  }
  const at = nowIso();
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE batch_tasks
          SET status = 'queued',
              runner_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              cancel_requested_at = NULL,
              next_retry_at = NULL,
              error_msg = NULL,
              error_message = NULL,
              status_reason = @reason,
              retry_count = COALESCE(retry_count, 0) + 1,
              updated_at = @at
        WHERE id = @id`,
    ).run({ id, reason, at });
    insertTaskHistory(id, String(row.status), 'queued', reason, adminUsername, at);
  });
  txn.immediate();
}

function forceBatchTaskStatus(taskId: string, to: 'failed' | 'cancelled', reason: string, adminUsername: string) {
  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT status FROM batch_tasks WHERE id = @id').get({ id: taskId });
  if (!row) throw statusError('task not found', 404);
  const from = String(row.status || '');
  if (from === to) return;
  if (!ACTIVE_STATUSES.has(from) && !(to === 'failed' && from === 'cancelled')) {
    throw statusError('task cannot be force-updated from current status', 409);
  }
  const at = nowIso();
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE batch_tasks
          SET status = @to,
              error_msg = CASE WHEN @to = 'failed' THEN @reason ELSE error_msg END,
              error_message = CASE WHEN @to = 'failed' THEN @reason ELSE error_message END,
              status_reason = @reason,
              runner_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              cancel_requested_at = NULL,
              cancelled_local_at = CASE WHEN @to = 'cancelled' THEN COALESCE(cancelled_local_at, @at) ELSE cancelled_local_at END,
              admin_disposition = CASE WHEN @to = 'cancelled' THEN 'cancelled_local' ELSE 'force_failed' END,
              updated_at = @at
        WHERE id = @taskId`,
    ).run({ taskId, to, reason, at });
    insertTaskHistory(taskId, from, to, reason, adminUsername, at);
  });
  txn.immediate();
}

function insertTaskHistory(taskId: string, from: string, to: string, reason: string, adminUsername: string, at: string) {
  getDb().prepare(
    `INSERT INTO task_state_history
      (id, task_id, from_state, to_state, reason, actor, runner_id, meta_json, created_at)
     VALUES
      (@id, @taskId, @from, @to, @reason, @actor, NULL, @metaJson, @at)`,
  ).run({
    id: randomUUID(),
    taskId,
    from,
    to,
    reason: reason.slice(0, 500),
    actor: `admin:${adminUsername}`,
    metaJson: JSON.stringify({ action: 'admin_unified_task' }),
    at,
  });
}

function applyRefundCheck(source: TaskSource, before: any, reason: string) {
  if (source === 'batch') return applyBatchRefundCheck(before, reason);
  const refund = refundCandidate(source, before);
  if (refund.refundable <= 0) return { refunded: 0, alreadyRefunded: refund.refunded, charged: refund.charged };
  const result = refundTaskLedger({
    userId: Number(before.ownerId),
    taskId: String(before.id),
    amount: refund.refundable,
    reason: `admin refund-check:${source}:${reason}`,
  });
  markRefundChecked(source, String(before.id));
  return { refunded: refund.refundable, ledger: result, charged: refund.charged, alreadyRefunded: refund.refunded };
}

function applyBatchRefundCheck(before: any, reason: string) {
  const tasks = getDb().prepare<{ batchId: string }, any>(
    `SELECT bt.id, b.owner_id AS ownerId
       FROM batch_tasks bt
       JOIN batches b ON b.id = bt.batch_id
      WHERE bt.batch_id = @batchId
        AND bt.status IN ('failed','cancelled','needs_review')`,
  ).all({ batchId: String(before.id) });
  let refunded = 0;
  const details: any[] = [];
  for (const task of tasks) {
    const candidate = refundCandidate('batch_task', { id: task.id, ownerId: task.ownerId });
    if (candidate.refundable <= 0) continue;
    const result = refundTaskLedger({
      userId: Number(task.ownerId),
      taskId: String(task.id),
      amount: candidate.refundable,
      reason: `admin refund-check:batch:${reason}`,
    });
    refunded += candidate.refundable;
    details.push({ taskId: task.id, amount: candidate.refundable, ledger: result });
  }
  markBatchTaskRefundChecked(details.map((detail) => String(detail.taskId)));
  return { refunded, details };
}

function refundTaskRows(tasks: Array<{ id: string; ownerId: number }>, reason: string) {
  let refunded = 0;
  const details: any[] = [];
  for (const task of tasks) {
    const candidate = refundCandidate('batch_task', { id: task.id, ownerId: task.ownerId });
    if (candidate.refundable <= 0) {
      details.push({ taskId: task.id, refunded: 0, charged: candidate.charged, alreadyRefunded: candidate.refunded });
      continue;
    }
    const ledger = refundTaskLedger({
      userId: Number(task.ownerId),
      taskId: String(task.id),
      amount: candidate.refundable,
      reason,
    });
    refunded += candidate.refundable;
    details.push({ taskId: task.id, refunded: candidate.refundable, ledger });
  }
  return { refunded, details };
}

function markRefundChecked(source: TaskSource, id: string) {
  if (source === 'batch_task') markBatchTaskRefundChecked([id]);
  if (source === 'video_task') markSimpleTaskRefundChecked('video_tasks', id);
  if (source === 'export') markSimpleTaskRefundChecked('exports', id);
}

function markBatchTaskRefundChecked(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  const placeholders = unique.map(() => '?').join(',');
  getDb().prepare(
    `UPDATE batch_tasks
        SET refund_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (${placeholders})`,
  ).run(...unique);
}

function markSimpleTaskRefundChecked(table: 'video_tasks' | 'exports', id: string) {
  getDb().prepare(
    `UPDATE ${table}
        SET refund_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(id);
}

function markBatchTaskAdminDisposition(taskId: string, disposition: string) {
  getDb().prepare(
    `UPDATE batch_tasks
        SET admin_disposition = @disposition,
            cancelled_local_at = CASE WHEN @disposition = 'cancelled_local' THEN COALESCE(cancelled_local_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE cancelled_local_at END
      WHERE id = @taskId`,
  ).run({ taskId, disposition });
}

function markCancelledLocal(source: 'video_task' | 'export', before: any) {
  const providerTaskId = String(before.providerTaskId || '').trim();
  const provider = String(before.provider || '').trim() || 'unknown';
  const result = {
    providerCancelAttempted: false,
    status: providerTaskId ? 'unsupported' : 'not_applicable',
    disposition: 'cancelled_local',
    provider,
    providerTaskId: providerTaskId || null,
    reason: providerTaskId
      ? 'provider_cancel_not_configured_for_this_provider'
      : 'missing_provider_task_id',
  };
  recordObservabilityEvent({
    type: 'provider_cancel',
    provider,
    status: result.status,
    message: `${source} cancelled locally; upstream provider cancel is not configured`,
    meta: {
      source,
      taskId: before.id,
      providerTaskId: providerTaskId || null,
      disposition: 'cancelled_local',
      providerCancelAttempted: false,
      reason: result.reason,
    },
  });
  return result;
}

function refundCandidate(source: TaskSource, before: any) {
  if (source === 'batch') {
    const tasks = getDb().prepare<{ batchId: string }, any>(
      `SELECT bt.id, b.owner_id AS ownerId
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.batch_id = @batchId
          AND bt.status IN ('failed','cancelled','needs_review')`,
    ).all({ batchId: String(before.id) });
    return tasks.reduce((acc, task) => {
      const item = refundCandidate('batch_task', { id: task.id, ownerId: task.ownerId });
      acc.charged += item.charged;
      acc.refunded += item.refunded;
      acc.refundable += item.refundable;
      return acc;
    }, { charged: 0, refunded: 0, refundable: 0 });
	  }
	  const id = String(before.id);
	  if (source === 'video_task') {
	    return { charged: 0, refunded: 0, refundable: 0 };
	  }
	  const chargeRef = source === 'batch_task' ? taskChargeRef(id) : '';
	  const refundRef = source === 'batch_task' ? taskRefundRef(id) : `refund:${id}`;
	  const row = source === 'batch_task'
	    ? getDb().prepare<any, any>(
	        `SELECT
	           SUM(CASE WHEN amount < 0 AND charge_ref_id = @chargeRef THEN -amount ELSE 0 END) AS charged,
	           SUM(CASE WHEN kind = 'refund' AND amount > 0 AND refund_ref_id = @refundRef THEN amount ELSE 0 END) AS refunded
	         FROM credit_ledger
	        WHERE user_id = @ownerId`,
	      ).get({ ownerId: Number(before.ownerId), chargeRef, refundRef }) || {}
	    : getDb().prepare<any, any>(
	        `SELECT
	           SUM(CASE WHEN amount < 0 AND kind = 'export' AND ref_id = @id THEN -amount ELSE 0 END) AS charged,
	           SUM(CASE WHEN kind = 'refund' AND amount > 0 AND (refund_ref_id = @refundRef OR ref_id = @id) THEN amount ELSE 0 END) AS refunded
	         FROM credit_ledger
	        WHERE user_id = @ownerId`,
	      ).get({ ownerId: Number(before.ownerId), id, refundRef }) || {};
  const charged = Number(row.charged || 0);
  const refunded = Number(row.refunded || 0);
  return { charged, refunded, refundable: Math.max(0, charged - refunded) };
}

function normalizeSource(value: unknown): TaskSource | '' {
  const src = String(value || '').trim();
  return SOURCES.includes(src as TaskSource) ? src as TaskSource : '';
}

function queryParams(filters: { status: string; q: string; limit: number }) {
  return {
    status: filters.status,
    q: filters.q,
    like: `%${filters.q}%`,
    limit: filters.limit,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function statusError(message: string, status: number) {
  const error = new Error(message);
  (error as any).status = status;
  return error;
}
