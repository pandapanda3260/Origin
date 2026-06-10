import { getDb } from './db';
import { refundTaskLedger, transitionTaskStatus } from './durable-tasks';
import { costForBatchType, finalizeBatchFromTasks } from './batch-task-accounting';

export type ProviderIntegrationMode = 'polling' | 'callback';
export type ProviderCapabilityFlag = 'yes' | 'no' | 'unknown';
export type ProviderRecoveryKey =
  | 'volcengine_seedream_image'
  | 'volcengine_seedance_video'
  | 'vevdemo_export';

export const DEFAULT_PROVIDER_POLL_INTERVAL_MS = 10_000;
export const MAX_PROVIDER_POLL_INTERVAL_MS = 5 * 60_000;

export type ProviderRecoveryCapability = {
  key: ProviderRecoveryKey;
  label: string;
  integrationMode: ProviderIntegrationMode;
  supportsSubmitIdempotencyKey: ProviderCapabilityFlag;
  supportsQueryByProviderTaskId: ProviderCapabilityFlag;
  supportsRecoverByIdempotencyKey: ProviderCapabilityFlag;
  recoveryStrategy: string;
  p2Implementation: 'interface_only' | 'seedance_video_first' | 'callback_only';
};

export type ProviderSubmitContext = {
  localTaskId: string;
  idempotencyKey: string;
  payload: unknown;
};

export type ProviderSubmitResult = {
  providerTaskId: string;
  raw?: unknown;
};

export type ProviderPollResult =
  | { status: 'pending'; progress?: number; raw?: unknown }
  | { status: 'completed'; result: unknown; raw?: unknown }
  | { status: 'failed'; reason: string; raw?: unknown };

export type ProviderRecoverByKeyResult = {
  providerTaskId: string;
  status?: ProviderPollResult['status'];
  raw?: unknown;
} | null;

export type ProviderTaskRow = {
  id: string;
  batch_id: string;
  seq: number;
  task_type: string;
  status: string;
  provider: string | null;
  provider_task_id: string | null;
  idempotency_key: string | null;
  retry_count: number;
  max_retries: number;
  result_json: string;
  error_msg: string | null;
  last_checked_at: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProviderTaskAdapter = {
  provider: ProviderRecoveryKey;
  submit(ctx: ProviderSubmitContext): Promise<ProviderSubmitResult>;
  poll(taskRow: ProviderTaskRow): Promise<ProviderPollResult>;
  recoverByKey?(idempotencyKey: string): Promise<ProviderRecoverByKeyResult>;
};

export type ProviderPollTaskOutcome =
  | { status: 'missing' }
  | { status: 'ignored'; reason: string }
  | { status: 'pending'; nextRetryAt: string }
  | { status: 'completed' }
  | { status: 'failed'; reason: string }
  | { status: 'retry_scheduled'; reason: string; nextRetryAt: string; retryCount: number }
  | { status: 'needs_review'; reason: string };

export function recordBatchTaskProviderSubmission(opts: {
  batchTaskId: string;
  provider: ProviderRecoveryKey;
  providerTaskId: string;
  idempotencyKey?: string | null;
  localVideoTaskId?: string | null;
  transitionToUpstreamPending?: boolean;
  nowMs?: number;
  nowIso?: string;
}) {
  const at = opts.nowIso || isoFromMs(opts.nowMs ?? Date.now());
  const db = getDb();
  const row = db
    .prepare<{ id: string }, { result_json: string }>('SELECT result_json FROM batch_tasks WHERE id = @id')
    .get({ id: opts.batchTaskId });
  const resultPayload = (() => {
    try {
      return row ? JSON.parse(row.result_json || '{}') : {};
    } catch {
      return {};
    }
  })();
  if (opts.localVideoTaskId) {
    resultPayload.providerSubmission = {
      provider: opts.provider,
      providerTaskId: opts.providerTaskId,
      localVideoTaskId: opts.localVideoTaskId,
      idempotencyKey: opts.idempotencyKey || null,
      submittedAt: at,
    };
  }
  const result = db
    .prepare(
      `UPDATE batch_tasks
          SET provider = @provider,
              provider_task_id = @providerTaskId,
              idempotency_key = COALESCE(idempotency_key, @idempotencyKey),
              result_json = @resultJson,
              last_checked_at = COALESCE(last_checked_at, @at),
              updated_at = @at
        WHERE id = @batchTaskId`,
    )
    .run({
      batchTaskId: opts.batchTaskId,
      provider: opts.provider,
      providerTaskId: opts.providerTaskId,
      idempotencyKey: opts.idempotencyKey || null,
      resultJson: stringifyProviderPayload(resultPayload),
      at,
    });
  if (result.changes === 1 && opts.transitionToUpstreamPending) {
    try {
      transitionTaskStatus({
        taskId: opts.batchTaskId,
        from: 'running',
        to: 'upstream_pending',
        reason: `provider_submitted:${opts.provider}`,
        actor: 'provider-submission',
        nowMs: opts.nowMs,
      });
    } catch (error: any) {
      const current = db
        .prepare<{ id: string }, { status: string }>('SELECT status FROM batch_tasks WHERE id = @id')
        .get({ id: opts.batchTaskId });
      if (!current || current.status !== 'upstream_pending') throw error;
    }
  }
  return { changed: result.changes === 1 };
}

function isoFromMs(nowMs: number) {
  return new Date(nowMs).toISOString();
}

export function providerPollingDelayMs(retryCount: number) {
  const exponent = Math.max(0, Math.min(12, retryCount - 1));
  return Math.min(DEFAULT_PROVIDER_POLL_INTERVAL_MS * 2 ** exponent, MAX_PROVIDER_POLL_INTERVAL_MS);
}

function stringifyProviderPayload(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function providerCompletedResultPayload(provider: ProviderRecoveryKey, result: ProviderPollResult & { status: 'completed' }) {
  const payload = result.result as any;
  if (payload && typeof payload === 'object' && ('resultUrl' in payload || 'patch' in payload || 'extra' in payload)) {
    return payload;
  }
  return { provider, result: result.result, raw: result.raw };
}

function providerPollErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  if (typeof error === 'string') return error.slice(0, 500);
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return 'provider poll failed';
  }
}

function isProviderRateLimit(error: unknown) {
  const err = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 429) return true;
  const code = String(err?.code || '').toLowerCase();
  if (code.includes('rate') && code.includes('limit')) return true;
  const message = String(err?.message || '').toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('too many requests');
}

function readProviderTask(taskId: string): ProviderTaskRow | null {
  return getDb()
    .prepare<{ taskId: string }, ProviderTaskRow>(
      `SELECT id, batch_id, seq, task_type, status, provider, provider_task_id,
              idempotency_key, retry_count, max_retries, result_json, error_msg,
              last_checked_at, next_retry_at, created_at, updated_at
         FROM batch_tasks
        WHERE id = @taskId`,
    )
    .get({ taskId }) || null;
}

function markProviderTaskNeedsReview(opts: { taskId: string; reason: string; errorMsg?: string; nowMs: number }) {
  const at = isoFromMs(opts.nowMs);
  const update = getDb()
    .prepare(
      `UPDATE batch_tasks
          SET error_msg = @errorMsg,
              last_checked_at = @at,
              next_retry_at = NULL,
              updated_at = @at
        WHERE id = @taskId
          AND status = 'upstream_pending'`,
    )
    .run({ taskId: opts.taskId, errorMsg: opts.errorMsg || opts.reason, at });
  if (update.changes !== 1) return false;
  try {
    transitionTaskStatus({
      taskId: opts.taskId,
      from: 'upstream_pending',
      to: 'needs_review',
      reason: opts.reason,
      actor: 'provider-poller',
      nowMs: opts.nowMs,
    });
    return true;
  } catch (error: any) {
    const current = getDb()
      .prepare<{ taskId: string }, { status: string }>('SELECT status FROM batch_tasks WHERE id = @taskId')
      .get({ taskId: opts.taskId });
    if (current && current.status !== 'upstream_pending') return false;
    throw error;
  }
}

function refundProviderFailedTask(taskId: string, reason: string) {
  const row = getDb()
    .prepare<{ taskId: string }, { owner_id: number; batch_type: string }>(
      `SELECT b.owner_id, b.batch_type
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.id = @taskId`,
    )
    .get({ taskId });
  if (!row) return { refunded: false, reason: 'task_owner_missing' };
  const amount = costForBatchType(row.batch_type);
  if (amount <= 0) return { refunded: false, reason: 'zero_cost' };
  const hasLegacyCharge = getDb()
    .prepare<{ ref: string }, any>('SELECT id FROM credit_ledger WHERE charge_ref_id = @ref LIMIT 1')
    .get({ ref: `charge:${taskId}` });
  if (!hasLegacyCharge) return { refunded: false, reason: 'legacy_charge_missing' };
  refundTaskLedger({
    userId: row.owner_id,
    taskId,
    amount,
    reason,
  });
  return { refunded: true, amount };
}

export async function pollBatchProviderTask(opts: {
  taskId: string;
  adapter: ProviderTaskAdapter;
  nowMs?: number;
}): Promise<ProviderPollTaskOutcome> {
  const nowMs = opts.nowMs ?? Date.now();
  const at = isoFromMs(nowMs);
  const task = readProviderTask(opts.taskId);
  if (!task) return { status: 'missing' };
  if (task.status !== 'upstream_pending') return { status: 'ignored', reason: `status:${task.status}` };
  if (task.provider !== opts.adapter.provider) {
    return { status: 'ignored', reason: `provider:${task.provider || 'missing'}` };
  }
  if (!task.provider_task_id) {
    const marked = markProviderTaskNeedsReview({
      taskId: opts.taskId,
      reason: 'missing_provider_task_id',
      errorMsg: 'provider task id is missing for upstream_pending task',
      nowMs,
    });
    if (!marked) return { status: 'ignored', reason: 'concurrent_modification' };
    return { status: 'needs_review', reason: 'missing_provider_task_id' };
  }

  try {
    const result = await opts.adapter.poll(task);
    if (result.status === 'pending') {
      const nextRetryAt = isoFromMs(nowMs + providerPollingDelayMs(task.retry_count));
      getDb()
        .prepare(
          `UPDATE batch_tasks
              SET last_checked_at = @at,
                  next_retry_at = @nextRetryAt,
                  updated_at = @at
            WHERE id = @taskId
              AND status = 'upstream_pending'`,
        )
        .run({ taskId: opts.taskId, at, nextRetryAt });
      return { status: 'pending', nextRetryAt };
    }

    if (result.status === 'completed') {
      getDb()
        .prepare(
          `UPDATE batch_tasks
              SET result_json = @resultJson,
                  error_msg = NULL,
                  last_checked_at = @at,
                  next_retry_at = NULL,
                  updated_at = @at
            WHERE id = @taskId
              AND status = 'upstream_pending'`,
        )
        .run({
          taskId: opts.taskId,
          resultJson: stringifyProviderPayload(providerCompletedResultPayload(opts.adapter.provider, result)),
          at,
        });
      transitionTaskStatus({
        taskId: opts.taskId,
        from: 'upstream_pending',
        to: 'completed',
        reason: 'provider_poll_completed',
        actor: 'provider-poller',
        nowMs,
      });
      finalizeBatchFromTasks(task.batch_id);
      return { status: 'completed' };
    }

    refundProviderFailedTask(opts.taskId, `provider_poll_failed:${opts.adapter.provider}`);
    getDb()
      .prepare(
        `UPDATE batch_tasks
            SET error_msg = @reason,
                last_checked_at = @at,
                next_retry_at = NULL,
                updated_at = @at
          WHERE id = @taskId
            AND status = 'upstream_pending'`,
      )
      .run({ taskId: opts.taskId, reason: result.reason.slice(0, 500), at });
    transitionTaskStatus({
      taskId: opts.taskId,
      from: 'upstream_pending',
      to: 'failed',
      reason: 'provider_poll_failed',
      actor: 'provider-poller',
      meta: { providerReason: result.reason, raw: result.raw },
      nowMs,
    });
    finalizeBatchFromTasks(task.batch_id);
    return { status: 'failed', reason: result.reason };
  } catch (error) {
    const retryCount = task.retry_count + 1;
    const maxRetries = task.max_retries || 3;
    const reason = isProviderRateLimit(error) ? 'provider_poll_rate_limited' : 'provider_poll_error';
    const errorMsg = providerPollErrorMessage(error);
    if (retryCount >= maxRetries) {
      getDb()
        .prepare(
          `UPDATE batch_tasks
              SET retry_count = @retryCount,
                  error_msg = @errorMsg,
                  last_checked_at = @at,
                  next_retry_at = NULL,
                  updated_at = @at
            WHERE id = @taskId
              AND status = 'upstream_pending'`,
        )
        .run({ taskId: opts.taskId, retryCount, errorMsg, at });
      transitionTaskStatus({
        taskId: opts.taskId,
        from: 'upstream_pending',
        to: 'needs_review',
        reason: `${reason}:retry_exhausted`,
        actor: 'provider-poller',
        meta: { error: errorMsg, retryCount, maxRetries },
        nowMs,
      });
      return { status: 'needs_review', reason: `${reason}:retry_exhausted` };
    }

    const nextRetryAt = isoFromMs(nowMs + providerPollingDelayMs(retryCount));
    getDb()
      .prepare(
        `UPDATE batch_tasks
            SET retry_count = @retryCount,
                error_msg = @errorMsg,
                last_checked_at = @at,
                next_retry_at = @nextRetryAt,
                updated_at = @at
          WHERE id = @taskId
            AND status = 'upstream_pending'`,
      )
      .run({ taskId: opts.taskId, retryCount, errorMsg, at, nextRetryAt });
    return { status: 'retry_scheduled', reason, nextRetryAt, retryCount };
  }
}

export function resumeReviewProviderTasksForPolling(opts: {
  provider: ProviderRecoveryKey;
  limit?: number;
  nowMs?: number;
}) {
  const nowMs = opts.nowMs ?? Date.now();
  const at = isoFromMs(nowMs);
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const rows = getDb()
    .prepare<{ provider: string; limit: number }, {
      id: string;
      batch_id: string;
      status_reason: string | null;
      error_msg: string | null;
      error_message: string | null;
    }>(
      `SELECT id, batch_id, status_reason, error_msg, error_message
         FROM batch_tasks
        WHERE status = 'needs_review'
          AND provider = @provider
          AND provider_task_id IS NOT NULL
          AND provider_task_id != ''
          AND (
            COALESCE(status_reason, '') LIKE '%provider state requires review%'
            OR COALESCE(status_reason, '') LIKE '%provider reconciliation%'
            OR COALESCE(error_msg, '') LIKE '%provider state requires review%'
            OR COALESCE(error_msg, '') LIKE '%provider reconciliation%'
            OR COALESCE(error_message, '') LIKE '%provider state requires review%'
            OR COALESCE(error_message, '') LIKE '%provider reconciliation%'
          )
        ORDER BY updated_at ASC
        LIMIT @limit`,
    )
    .all({ provider: opts.provider, limit });

  const resumed: string[] = [];
  const batchIds = new Set<string>();
  for (const row of rows) {
    const previousReason = row.status_reason || row.error_msg || row.error_message || '';
    try {
      const update = getDb()
        .prepare(
          `UPDATE batch_tasks
              SET runner_id = NULL,
                  lease_expires_at = NULL,
                  heartbeat_at = NULL,
                  cancel_requested_at = NULL,
                  next_retry_at = NULL,
                  error_msg = NULL,
                  error_message = NULL,
                  last_checked_at = COALESCE(last_checked_at, @at),
                  updated_at = @at
            WHERE id = @taskId
              AND status = 'needs_review'`,
        )
        .run({ taskId: row.id, at });
      if (update.changes !== 1) continue;
      transitionTaskStatus({
        taskId: row.id,
        from: 'needs_review',
        to: 'upstream_pending',
        reason: `provider_review_resumed:${opts.provider}`,
        actor: 'provider-recovery',
        meta: { previousReason },
        nowMs,
      });
      resumed.push(row.id);
      batchIds.add(row.batch_id);
    } catch (error) {
      console.error('[provider-recovery] resume review task failed:', row.id, error);
    }
  }

  for (const batchId of batchIds) {
    finalizeBatchFromTasks(batchId);
  }
  return { resumed: resumed.length, taskIds: resumed };
}

export async function pollDueBatchProviderTasks(opts: {
  provider: ProviderRecoveryKey;
  adapter: ProviderTaskAdapter;
  limit?: number;
  nowMs?: number;
}) {
  if (opts.provider !== opts.adapter.provider) {
    throw new Error(`provider adapter mismatch: ${opts.provider} vs ${opts.adapter.provider}`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const at = isoFromMs(nowMs);
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const rows = getDb()
    .prepare<{ provider: string; at: string; limit: number }, { id: string }>(
      `SELECT id
         FROM batch_tasks
        WHERE status = 'upstream_pending'
          AND provider = @provider
          AND provider_task_id IS NOT NULL
          AND (next_retry_at IS NULL OR next_retry_at <= @at)
        ORDER BY priority DESC, COALESCE(last_checked_at, created_at) ASC
        LIMIT @limit`,
    )
    .all({ provider: opts.provider, at, limit });
  const results = [];
  for (const row of rows) {
    results.push({ taskId: row.id, outcome: await pollBatchProviderTask({ taskId: row.id, adapter: opts.adapter, nowMs }) });
  }
  return { scanned: rows.length, results };
}

export const PROVIDER_RECOVERY_CAPABILITIES: Record<ProviderRecoveryKey, ProviderRecoveryCapability> = {
  volcengine_seedream_image: {
    key: 'volcengine_seedream_image',
    label: 'Volcengine Seedream image generation',
    integrationMode: 'polling',
    supportsSubmitIdempotencyKey: 'unknown',
    supportsQueryByProviderTaskId: 'unknown',
    supportsRecoverByIdempotencyKey: 'unknown',
    recoveryStrategy: 'P2 research item. Do not assume safe recoverByKey until provider docs or live probe confirm it.',
    p2Implementation: 'interface_only',
  },
  volcengine_seedance_video: {
    key: 'volcengine_seedance_video',
    label: 'Volcengine Seedance video generation',
    integrationMode: 'polling',
    supportsSubmitIdempotencyKey: 'unknown',
    supportsQueryByProviderTaskId: 'yes',
    supportsRecoverByIdempotencyKey: 'unknown',
    recoveryStrategy: 'Persist provider_task_id immediately after submit, then poll /contents/generations/tasks/{id}. If only idempotency_key exists and recoverByKey is unconfirmed, move to needs_review.',
    p2Implementation: 'seedance_video_first',
  },
  vevdemo_export: {
    key: 'vevdemo_export',
    label: 'VevDemo export',
    integrationMode: 'callback',
    supportsSubmitIdempotencyKey: 'no',
    supportsQueryByProviderTaskId: 'no',
    supportsRecoverByIdempotencyKey: 'no',
    recoveryStrategy: 'Callback-only. Origin does not poll VevDemo; missing callback or expired URL is handled by near-expiry scan and re-export UI.',
    p2Implementation: 'callback_only',
  },
};

export function listProviderRecoveryCapabilities() {
  return Object.values(PROVIDER_RECOVERY_CAPABILITIES);
}

export function getProviderRecoveryCapability(key: string): ProviderRecoveryCapability | null {
  return PROVIDER_RECOVERY_CAPABILITIES[key as ProviderRecoveryKey] || null;
}

export function assertPollingProvider(key: ProviderRecoveryKey): ProviderRecoveryCapability {
  const capability = PROVIDER_RECOVERY_CAPABILITIES[key];
  if (!capability || capability.integrationMode !== 'polling') {
    throw new Error(`provider is not polling-capable: ${key}`);
  }
  return capability;
}

export function createNotImplementedProviderAdapter(provider: ProviderRecoveryKey): ProviderTaskAdapter {
  return {
    provider,
    async submit() {
      throw new Error(`provider submit not implemented: ${provider}`);
    },
    async poll() {
      throw new Error(`provider poll not implemented: ${provider}`);
    },
    async recoverByKey() {
      return null;
    },
  };
}
