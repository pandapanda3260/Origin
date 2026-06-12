import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderTaskAdapter, ProviderPollResult } from '../lib/provider-recovery';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-provider-recovery-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');

async function main() {
  const { getDb } = await import('../lib/db');
  const {
    assertPollingProvider,
    createNotImplementedProviderAdapter,
    getProviderRecoveryCapability,
    listProviderRecoveryCapabilities,
    pollBatchProviderTask,
    pollDueBatchProviderTasks,
    recordBatchTaskProviderSubmission,
    resumeReviewProviderTasksForPolling,
  } = await import('../lib/provider-recovery');
  const durable = await import('../lib/durable-tasks');

  const providers = listProviderRecoveryCapabilities();
  assert.equal(providers.length, 3);

  const seedance = getProviderRecoveryCapability('volcengine_seedance_video');
  assert.equal(seedance?.integrationMode, 'polling');
  assert.equal(seedance?.supportsQueryByProviderTaskId, 'yes');
  assert.equal(seedance?.p2Implementation, 'seedance_video_first');
  assert.equal(seedance?.supportsRecoverByIdempotencyKey, 'unknown');

  const vevdemo = getProviderRecoveryCapability('vevdemo_export');
  assert.equal(vevdemo?.integrationMode, 'polling');
  assert.equal(vevdemo?.supportsQueryByProviderTaskId, 'yes');
  assert.equal(vevdemo?.p2Implementation, 'vevdemo_export_polling');
  assert.equal(assertPollingProvider('vevdemo_export')?.key, 'vevdemo_export');

  const adapter = createNotImplementedProviderAdapter('volcengine_seedream_image');
  assert.equal(await adapter.recoverByKey?.('idem-smoke'), null);
  await assert.rejects(
    () => adapter.submit({ localTaskId: 'task', idempotencyKey: 'idem', payload: {} }),
    /provider submit not implemented/,
  );

  const db = getDb();
  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  db.prepare(
    `UPDATE user_credits
        SET subscription_credits = 1000,
            topup_credits = 1000,
            bonus_credits = 1000,
            total_credits = 3000
      WHERE user_id = ?`,
  ).run(user.id);
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES ('batch-provider-recovery', ?, 'project-provider-recovery', 'video_segments', 'running', 1)`,
  ).run(user.id);
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json)
     VALUES ('task-provider-recovery', 'batch-provider-recovery', 0, 'video_segments', 'running', '{}')`,
  ).run();
  const recorded = recordBatchTaskProviderSubmission({
    batchTaskId: 'task-provider-recovery',
    provider: 'volcengine_seedance_video',
    providerTaskId: 'seedance-remote-smoke',
    idempotencyKey: 'idem-provider-smoke',
    nowIso: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(recorded.changed, true);
  const task = db.prepare("SELECT provider, provider_task_id, idempotency_key, last_checked_at FROM batch_tasks WHERE id = 'task-provider-recovery'").get() as any;
  assert.equal(task.provider, 'volcengine_seedance_video');
  assert.equal(task.provider_task_id, 'seedance-remote-smoke');
  assert.equal(task.idempotency_key, 'idem-provider-smoke');
  assert.equal(task.last_checked_at, '2026-01-01T00:00:00.000Z');

  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json)
     VALUES ('task-provider-handoff', 'batch-provider-recovery', 99, 'video_segments', 'running', '{}')`,
  ).run();
  const handoff = recordBatchTaskProviderSubmission({
    batchTaskId: 'task-provider-handoff',
    provider: 'volcengine_seedance_video',
    providerTaskId: 'seedance-remote-handoff',
    idempotencyKey: 'idem-provider-handoff',
    localVideoTaskId: 'local-video-handoff',
    transitionToUpstreamPending: true,
    nowMs: Date.parse('2026-01-01T00:01:00.000Z'),
  });
  assert.equal(handoff.changed, true);
  const handoffTask = db.prepare("SELECT status, result_json FROM batch_tasks WHERE id = 'task-provider-handoff'").get() as any;
  assert.equal(handoffTask.status, 'upstream_pending');
  assert.equal(JSON.parse(handoffTask.result_json).providerSubmission.localVideoTaskId, 'local-video-handoff');
  db.prepare("UPDATE batch_tasks SET next_retry_at = '2026-01-01T00:10:00.000Z' WHERE id = 'task-provider-handoff'").run();

  let seq = 1;
  function insertProviderTask(id: string, fields: Partial<Record<string, any>> = {}) {
    db.prepare(
      `INSERT INTO batch_tasks
        (id, batch_id, seq, task_type, status, provider, provider_task_id,
         retry_count, max_retries, target_json, next_retry_at)
       VALUES (@id, 'batch-provider-recovery', @seq, 'video_segments', @status,
               @provider, @providerTaskId, @retryCount, @maxRetries, '{}', @nextRetryAt)`,
    ).run({
      id,
      seq: seq++,
      status: fields.status || 'upstream_pending',
      provider: fields.provider || 'volcengine_seedance_video',
      providerTaskId: Object.prototype.hasOwnProperty.call(fields, 'providerTaskId') ? fields.providerTaskId : `${id}-remote`,
      retryCount: fields.retryCount ?? 0,
      maxRetries: fields.maxRetries ?? 3,
      nextRetryAt: fields.nextRetryAt ?? null,
    });
  }

  function adapterFor(poll: ProviderTaskAdapter['poll']): ProviderTaskAdapter {
    return {
      provider: 'volcengine_seedance_video',
      async submit() {
        return { providerTaskId: 'unused' };
      },
      poll,
      async recoverByKey() {
        return null;
      },
    };
  }

  const baseNow = Date.parse('2026-01-01T00:00:00.000Z');

  insertProviderTask('task-poll-pending');
  const pendingOutcome = await pollBatchProviderTask({
    taskId: 'task-poll-pending',
    adapter: adapterFor(async () => ({ status: 'pending' })),
    nowMs: baseNow,
  });
  assert.equal(pendingOutcome.status, 'pending');
  const pendingTask = db.prepare("SELECT status, last_checked_at, next_retry_at FROM batch_tasks WHERE id = 'task-poll-pending'").get() as any;
  assert.equal(pendingTask.status, 'upstream_pending');
  assert.equal(pendingTask.last_checked_at, '2026-01-01T00:00:00.000Z');
  assert.equal(pendingTask.next_retry_at, '2026-01-01T00:00:10.000Z');

  insertProviderTask('task-poll-completed');
  const completedOutcome = await pollBatchProviderTask({
    taskId: 'task-poll-completed',
    adapter: adapterFor(async () => ({ status: 'completed', result: { url: 'https://cdn.example/video.mp4' } })),
    nowMs: baseNow,
  });
  assert.equal(completedOutcome.status, 'completed');
  const completedTask = db.prepare("SELECT status, result_json FROM batch_tasks WHERE id = 'task-poll-completed'").get() as any;
  assert.equal(completedTask.status, 'completed');
  assert.equal(JSON.parse(completedTask.result_json).result.url, 'https://cdn.example/video.mp4');
  const completedHistory = db.prepare("SELECT to_state FROM task_state_history WHERE task_id = 'task-poll-completed'").get() as any;
  assert.equal(completedHistory.to_state, 'completed');

  insertProviderTask('task-poll-retry', { retryCount: 0, maxRetries: 3 });
  const rateLimit = new Error('429 too many requests') as Error & { status: number };
  rateLimit.status = 429;
  const retryOutcome = await pollBatchProviderTask({
    taskId: 'task-poll-retry',
    adapter: adapterFor(async () => {
      throw rateLimit;
    }),
    nowMs: baseNow,
  });
  assert.equal(retryOutcome.status, 'retry_scheduled');
  const retryTask = db.prepare("SELECT status, retry_count, next_retry_at, error_msg FROM batch_tasks WHERE id = 'task-poll-retry'").get() as any;
  assert.equal(retryTask.status, 'upstream_pending');
  assert.equal(retryTask.retry_count, 1);
  assert.equal(retryTask.next_retry_at, '2026-01-01T00:00:10.000Z');
  assert.match(retryTask.error_msg, /429/);

  insertProviderTask('task-poll-exhausted', { retryCount: 2, maxRetries: 3 });
  const exhaustedOutcome = await pollBatchProviderTask({
    taskId: 'task-poll-exhausted',
    adapter: adapterFor(async () => {
      throw rateLimit;
    }),
    nowMs: baseNow,
  });
  assert.equal(exhaustedOutcome.status, 'needs_review');
  const exhaustedTask = db.prepare("SELECT status, retry_count, error_msg FROM batch_tasks WHERE id = 'task-poll-exhausted'").get() as any;
  assert.equal(exhaustedTask.status, 'needs_review');
  assert.equal(exhaustedTask.retry_count, 3);
  assert.match(exhaustedTask.error_msg, /429/);
  const exhaustedHistory = db.prepare("SELECT to_state, reason FROM task_state_history WHERE task_id = 'task-poll-exhausted'").get() as any;
  assert.equal(exhaustedHistory.to_state, 'needs_review');
  assert.equal(exhaustedHistory.reason, 'provider_poll_rate_limited:retry_exhausted');

  insertProviderTask('task-poll-failed');
  durable.chargeTaskLedger({
    userId: user.id,
    taskId: 'task-poll-failed',
    amount: 200,
    kind: 'video',
    reason: 'provider failed refund smoke charge',
  });
  const failedOutcome = await pollBatchProviderTask({
    taskId: 'task-poll-failed',
    adapter: adapterFor(async () => ({ status: 'failed', reason: 'remote policy rejected' })),
    nowMs: baseNow,
  });
  assert.equal(failedOutcome.status, 'failed');
  const failedTask = db.prepare("SELECT status, error_msg FROM batch_tasks WHERE id = 'task-poll-failed'").get() as any;
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.error_msg, 'remote policy rejected');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE refund_ref_id = 'refund:task-poll-failed'").get() as any).c,
    1,
  );

  insertProviderTask('task-missing-provider-id', { providerTaskId: null });
  const missingProviderOutcome = await pollBatchProviderTask({
    taskId: 'task-missing-provider-id',
    adapter: adapterFor(async () => {
      throw new Error('poll should not run without provider_task_id');
    }),
    nowMs: baseNow,
  });
  assert.equal(missingProviderOutcome.status, 'needs_review');
  const missingProviderTask = db.prepare("SELECT status, error_msg FROM batch_tasks WHERE id = 'task-missing-provider-id'").get() as any;
  assert.equal(missingProviderTask.status, 'needs_review');
  assert.match(missingProviderTask.error_msg, /provider task id is missing/);

  insertProviderTask('task-review-resumable', { status: 'needs_review', nextRetryAt: '2026-01-01T00:10:00.000Z' });
  db.prepare(
    `UPDATE batch_tasks
        SET status_reason = 'lease expired; provider state requires review:video_segments',
            error_msg = 'stale provider state'
      WHERE id = 'task-review-resumable'`,
  ).run();
  insertProviderTask('task-review-manual', { status: 'needs_review' });
  db.prepare(
    `UPDATE batch_tasks
        SET status_reason = 'manual review requested'
      WHERE id = 'task-review-manual'`,
  ).run();
  const resumed = resumeReviewProviderTasksForPolling({
    provider: 'volcengine_seedance_video',
    limit: 10,
    nowMs: baseNow,
  });
  assert.equal(resumed.resumed, 1);
  assert.deepEqual(resumed.taskIds, ['task-review-resumable']);
  const reviewResumable = db
    .prepare("SELECT status, error_msg, next_retry_at FROM batch_tasks WHERE id = 'task-review-resumable'")
    .get() as any;
  assert.equal(reviewResumable.status, 'upstream_pending');
  assert.equal(reviewResumable.error_msg, null);
  assert.equal(reviewResumable.next_retry_at, null);
  const reviewManual = db
    .prepare("SELECT status FROM batch_tasks WHERE id = 'task-review-manual'")
    .get() as any;
  assert.equal(reviewManual.status, 'needs_review');
  db.prepare("UPDATE batch_tasks SET next_retry_at = '2026-01-01T00:10:00.000Z' WHERE id = 'task-review-resumable'").run();

  insertProviderTask('task-poll-null-due');
  insertProviderTask('task-poll-due', { nextRetryAt: '2025-12-31T23:59:59.000Z' });
  insertProviderTask('task-poll-future', { nextRetryAt: '2026-01-01T00:10:00.000Z' });
  const duePolls: string[] = [];
  const dueResult = await pollDueBatchProviderTasks({
    provider: 'volcengine_seedance_video',
    adapter: adapterFor(async (row): Promise<ProviderPollResult> => {
      duePolls.push(row.id);
      return { status: 'pending' };
    }),
    limit: 10,
    nowMs: baseNow,
  });
  assert.equal(dueResult.scanned, 2);
  assert.ok(duePolls.includes('task-poll-null-due'));
  assert.ok(duePolls.includes('task-poll-due'));
  assert.ok(!duePolls.includes('task-poll-future'));

  console.log('[provider-recovery] smoke passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
