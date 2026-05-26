import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-batch-durable-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.ORIGIN_BATCH_INLINE_RUNNER = '1';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBatch(getBatchSnapshot: (id: string) => any, batchId: string) {
  for (let i = 0; i < 80; i++) {
    const snap = getBatchSnapshot(batchId);
    if (snap && !['queued', 'running'].includes(String(snap.status))) return snap;
    await sleep(50);
  }
  throw new Error(`batch did not settle: ${batchId}`);
}

async function main() {
  const { getDb } = await import('../lib/db');
  const { getRuntimeHealth } = await import('../lib/runtime-health');
  const { signAdminToken } = await import('../lib/admin-auth');
  const {
    cancelBatchForUser,
    createBatch,
    getBatchSnapshot,
    recoverStaleBatches,
    registerExecutor,
    resolveTaskStartTransitionConflict,
  } = await import('../lib/batches');
  const {
    costForBatchType,
    creditKindForBatchType,
    finalizeBatchFromTasks,
    taskChargeRef,
    taskRefundRef,
  } = await import('../lib/batch-task-accounting');
  const { bulkRequeueIdempotencyKey } = await import('../lib/problem-queue-actions');
  const { chargeTaskLedger, refundTaskLedger, transitionTaskStatus } = await import('../lib/durable-tasks');
  const { POST: postProblemQueue } = await import('../app/api/admin/problem-queue/route');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() as any;
  const admin = db.prepare('SELECT * FROM admin_users ORDER BY id ASC LIMIT 1').get() as any;
  const adminToken = await signAdminToken(admin);

  async function postAdminProblemQueue(body: any) {
    const req = new NextRequest('http://localhost:3000/api/admin/problem-queue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        cookie: `admin_token=${encodeURIComponent(adminToken)}`,
      },
      body: JSON.stringify(body),
    });
    const res = await postProblemQueue(req);
    return { status: res.status, json: await res.json() };
  }

  assert.equal(costForBatchType('asset_images'), 30);
  assert.equal(costForBatchType('video_prompts'), 1);
  assert.equal(creditKindForBatchType('video_segments'), 'video');
  assert.equal(creditKindForBatchType('video_prompts'), 'text');
  assert.equal(taskChargeRef('task-ref-smoke'), 'charge:task-ref-smoke');
  assert.equal(taskRefundRef('task-ref-smoke'), 'refund:task-ref-smoke');

  const emptyBatchId = 'batch-empty-finalize';
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-empty-finalize', 'asset_images', 'queued', 0)`,
  ).run(emptyBatchId, user.id);
  const emptyFinal = finalizeBatchFromTasks(emptyBatchId);
  assert.equal(emptyFinal.status, 'queued');
  assert.equal((db.prepare('SELECT status FROM batches WHERE id = ?').get(emptyBatchId) as any).status, 'queued');

  db.prepare(
    `UPDATE user_credits
        SET subscription_credits = 20,
            topup_credits = 30,
            bonus_credits = 50,
            total_credits = 100
      WHERE user_id = ?`,
  ).run(user.id);
  chargeTaskLedger({
    userId: user.id,
    taskId: 'task-bucket-refund',
    amount: 70,
    kind: 'image',
    reason: 'bucket refund smoke charge',
  });
  refundTaskLedger({
    userId: user.id,
    taskId: 'task-bucket-refund',
    amount: 70,
    reason: 'bucket refund smoke refund',
  });
  const refundBucketRow = db
    .prepare("SELECT buckets_json FROM credit_ledger WHERE refund_ref_id = 'refund:task-bucket-refund'")
    .get() as any;
  assert.deepEqual(JSON.parse(refundBucketRow.buckets_json), { bonus: 50, topup: 20, subscription: 0 });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE refund_ref_id = 'refund:task-bucket-refund'").get() as any).c,
    1,
  );

  registerExecutor('asset_images', async (ctx) => ({
    resultUrl: `/fake/${ctx.taskId}.png`,
    extra: { seq: ctx.seq },
  }));

  const ok = createBatch({
    user,
    batchType: 'asset_images',
    projectId: 'project-batch-durable-ok',
    targets: [{ idx: 0, type: 'char' }, { idx: 1, type: 'scene' }],
  });
  const okSnap = await waitForBatch(getBatchSnapshot, ok.batchId);
  assert.equal(okSnap.status, 'completed');
  assert.equal(okSnap.tasks.every((task: any) => task.status === 'completed'), true);

  const okHistory = db
    .prepare(
      `SELECT COUNT(*) AS c FROM task_state_history
       WHERE task_id IN (SELECT id FROM batch_tasks WHERE batch_id = ?)`,
    )
    .get(ok.batchId) as any;
  assert.equal(okHistory.c, 4);
  const idempotencyRows = db
    .prepare(
      `SELECT COUNT(*) AS c FROM batch_tasks
       WHERE batch_id = ?
         AND idempotency_key IS NOT NULL
         AND idempotency_key = 'task:' || id`,
    )
    .get(ok.batchId) as any;
  assert.equal(idempotencyRows.c, 2);

  const okCharges = db
    .prepare(
      `SELECT COUNT(*) AS c FROM credit_ledger
       WHERE charge_ref_id IN (
         SELECT 'charge:' || id FROM batch_tasks WHERE batch_id = ?
       )`,
    )
    .get(ok.batchId) as any;
  assert.equal(okCharges.c, 2);

  registerExecutor('storyboard_images', async () => {
    throw new Error('planned failure');
  });

  const fail = createBatch({
    user,
    batchType: 'storyboard_images',
    projectId: 'project-batch-durable-fail',
    targets: [{ groupIdx: 0 }],
  });
  const failSnap = await waitForBatch(getBatchSnapshot, fail.batchId);
  assert.equal(failSnap.status, 'failed');
  assert.equal(failSnap.tasks[0].status, 'failed');

  const failLedger = db
    .prepare(
      `SELECT
         SUM(CASE WHEN charge_ref_id IS NOT NULL THEN 1 ELSE 0 END) AS charges,
         SUM(CASE WHEN refund_ref_id IS NOT NULL THEN 1 ELSE 0 END) AS refunds
       FROM credit_ledger
       WHERE ref_id IN (SELECT id FROM batch_tasks WHERE batch_id = ?)`,
    )
    .get(fail.batchId) as any;
  assert.equal(failLedger.charges, 1);
  assert.equal(failLedger.refunds, 1);

  registerExecutor('video_prompts', async (ctx) => {
    await sleep(80);
    ctx.throwIfCancelled();
    return { extra: { ok: true } };
  });
  const cancelRun = createBatch({
    user,
    batchType: 'video_prompts',
    projectId: 'project-batch-durable-cancel',
    targets: [{ groupIdx: 0 }],
  });
  for (let i = 0; i < 40; i++) {
    const row = db.prepare("SELECT status FROM batch_tasks WHERE batch_id = ?").get(cancelRun.batchId) as any;
    if (row?.status === 'running') break;
    await sleep(10);
  }
  const cancelResult = cancelBatchForUser({
    batchId: cancelRun.batchId,
    ownerId: user.id,
    reason: 'smoke cancel',
  });
  assert.equal(cancelResult.requested, 1);
  const cancelSnap = await waitForBatch(getBatchSnapshot, cancelRun.batchId);
  assert.equal(cancelSnap.status, 'cancelled');
  assert.equal(cancelSnap.tasks[0].status, 'cancelled');
  const cancelLedger = db
    .prepare(
      `SELECT
         SUM(CASE WHEN charge_ref_id IS NOT NULL THEN 1 ELSE 0 END) AS charges,
         SUM(CASE WHEN refund_ref_id IS NOT NULL THEN 1 ELSE 0 END) AS refunds
       FROM credit_ledger
       WHERE ref_id IN (SELECT id FROM batch_tasks WHERE batch_id = ?)`,
    )
    .get(cancelRun.batchId) as any;
  assert.equal(cancelLedger.charges, 1);
  assert.equal(cancelLedger.refunds, 1);

  registerExecutor('upstream_test', async (ctx) => {
    transitionTaskStatus({
      taskId: ctx.taskId,
      from: 'running',
      to: 'upstream_pending',
      reason: 'upstream handoff smoke',
      actor: 'test',
    });
    return { extra: { upstreamPending: true } };
  });
  const upstreamRun = createBatch({
    user,
    batchType: 'upstream_test',
    projectId: 'project-batch-durable-upstream',
    targets: [{ idx: 0 }],
  });
  for (let i = 0; i < 80; i++) {
    const snap = getBatchSnapshot(upstreamRun.batchId);
    if (snap?.tasks?.[0]?.status === 'upstream_pending') break;
    await sleep(50);
  }
  const upstreamSnap = getBatchSnapshot(upstreamRun.batchId);
  assert.equal(upstreamSnap.status, 'running');
  assert.equal(upstreamSnap.tasks[0].status, 'upstream_pending');
  db.prepare(
    `UPDATE batches
        SET runner_id = NULL,
            runner_heartbeat_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?`,
  ).run(upstreamRun.batchId);
  db.prepare(
    `UPDATE batch_tasks
        SET runner_id = NULL,
            lease_expires_at = '2020-01-01T00:00:00.000Z',
            heartbeat_at = '2020-01-01T00:00:00.000Z'
      WHERE batch_id = ?`,
  ).run(upstreamRun.batchId);
  recoverStaleBatches(10);
  const recoveredUpstreamSnap = getBatchSnapshot(upstreamRun.batchId);
  assert.equal(recoveredUpstreamSnap.status, 'running');
  assert.equal(recoveredUpstreamSnap.tasks[0].status, 'upstream_pending');

  const videoPendingBatchId = 'batch-video-upstream-active';
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-video-upstream-active', 'video_segments', 'running', 1)`,
  ).run(videoPendingBatchId, user.id);
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json)
     VALUES ('task-video-upstream-active', ?, 0, 'video_segments', 'upstream_pending', '{"groupIdx":0}')`,
  ).run(videoPendingBatchId);
  const upstreamReused = createBatch({
    user,
    batchType: 'video_segments',
    projectId: 'project-video-upstream-active',
    targets: [{ groupIdx: 0 }],
  });
  assert.equal(upstreamReused.reused, true);
  assert.equal(upstreamReused.batchId, videoPendingBatchId);

  const raceBatchId = 'batch-cancel-race-unit';
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-cancel-race-unit', 'video_prompts', 'running', 1)`,
  ).run(raceBatchId, user.id);
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json, runner_id, lease_expires_at, heartbeat_at)
     VALUES ('task-cancel-race', ?, 0, 'video_prompts', 'cancelled', '{}', 'runner-race', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(raceBatchId);
  const raceResolved = resolveTaskStartTransitionConflict({
    taskId: 'task-cancel-race',
    runnerId: 'runner-race',
    batchId: raceBatchId,
    targetSeq: 0,
    target: { groupIdx: 0 },
  });
  assert.equal(raceResolved.mode, 'cancelled');
  const raceTask = db.prepare("SELECT status, runner_id, lease_expires_at FROM batch_tasks WHERE id = 'task-cancel-race'").get() as any;
  assert.equal(raceTask.status, 'cancelled');
  assert.equal(raceTask.runner_id, null);
  assert.equal(raceTask.lease_expires_at, null);

  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json, runner_id)
     VALUES ('task-lost-race', ?, 1, 'video_prompts', 'running', '{}', 'other-runner')`,
  ).run(raceBatchId);
  const lostRace = resolveTaskStartTransitionConflict({
    taskId: 'task-lost-race',
    runnerId: 'runner-race',
  });
  assert.equal(lostRace.mode, 'lost_race');

  assert.throws(
    () => resolveTaskStartTransitionConflict({ taskId: 'task-missing-race', runnerId: 'runner-race' }),
    /task start conflict unreadable/,
  );
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json, runner_id)
     VALUES ('task-conflict-queued-self', ?, 2, 'video_prompts', 'queued', '{}', 'runner-race')`,
  ).run(raceBatchId);
  assert.throws(
    () => resolveTaskStartTransitionConflict({ taskId: 'task-conflict-queued-self', runnerId: 'runner-race' }),
    /task start transition conflict/,
  );

  const bulkBatchA = 'batch-bulk-requeue-a';
  const bulkBatchB = 'batch-bulk-requeue-b';
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-bulk-requeue', 'asset_images', 'running', 3)`,
  ).run(bulkBatchA, user.id);
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-bulk-requeue', 'asset_images', 'running', 1)`,
  ).run(bulkBatchB, user.id);
  const bulkInsert = db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json, retry_count, max_retries)
     VALUES (?, ?, ?, 'asset_images', ?, '{}', ?, ?)`,
  );
  bulkInsert.run('task-bulk-ok-a1', bulkBatchA, 0, 'needs_review', 0, 3);
  bulkInsert.run('task-bulk-ok-a2', bulkBatchA, 1, 'needs_review', 1, 3);
  bulkInsert.run('task-bulk-max-b1', bulkBatchB, 0, 'needs_review', 3, 3);
  bulkInsert.run('task-bulk-status-a3', bulkBatchA, 2, 'completed', 0, 3);

  const nonForceIds = ['task-bulk-ok-a1', 'task-bulk-ok-a2', 'task-bulk-max-b1', 'task-bulk-status-a3', 'task-bulk-missing'];
  const nonForceKey = bulkRequeueIdempotencyKey(nonForceIds, false);
  const nonForce = await postAdminProblemQueue({
    action: 'bulk_requeue',
    taskIds: nonForceIds,
    reason: 'bulk requeue smoke',
  });
  assert.equal(nonForce.status, 200);
  assert.deepEqual(nonForce.json.ok.map((item: any) => item.taskId).sort(), ['task-bulk-ok-a1', 'task-bulk-ok-a2']);
  assert.deepEqual(
    nonForce.json.failed.map((item: any) => item.reason).sort(),
    ['retry_count_exceeded', 'status_not_allowed', 'task_not_found'],
  );
  assert.deepEqual(nonForce.json.finalizedBatchIds.sort(), [bulkBatchA].sort());
  assert.equal(nonForce.json.idempotencyKey, nonForceKey);
  const bulkOkRows = db
    .prepare("SELECT id, status, retry_count FROM batch_tasks WHERE id IN ('task-bulk-ok-a1','task-bulk-ok-a2') ORDER BY id")
    .all() as any[];
  assert.deepEqual(bulkOkRows.map((row) => row.status), ['queued', 'queued']);
  assert.deepEqual(bulkOkRows.map((row) => row.retry_count), [1, 2]);

  const forceIds = ['task-bulk-max-b1'];
  const forceKey = bulkRequeueIdempotencyKey(forceIds, true);
  const force = await postAdminProblemQueue({
    action: 'bulk_requeue',
    taskIds: forceIds,
    force: true,
    reason: 'bulk force requeue smoke',
  });
  assert.equal(force.status, 200);
  assert.equal(force.json.idempotencyKey, forceKey);
  assert.equal(force.json.ok[0].taskId, 'task-bulk-max-b1');
  const forceAudit = db
    .prepare<{ key: string }, any>(
      `SELECT result_json
         FROM admin_actions
        WHERE action = 'task.problem_queue.resolve'
          AND idempotency_key = @key
          AND status = 'completed'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get({ key: forceKey });
  assert.equal(JSON.parse(forceAudit.result_json).meta.force, true);

  bulkInsert.run('task-single-requeue-ok', bulkBatchA, 4, 'needs_review', 0, 3);
  const singleOk = await postAdminProblemQueue({
    action: 'requeue',
    taskId: 'task-single-requeue-ok',
    reason: 'single requeue smoke',
    idempotencyKey: 'single-requeue-ok-key',
  });
  assert.equal(singleOk.status, 200, JSON.stringify(singleOk.json));
  const singleOkRow = db.prepare("SELECT status, retry_count FROM batch_tasks WHERE id = 'task-single-requeue-ok'").get() as any;
  assert.equal(singleOkRow.status, 'queued');
  assert.equal(singleOkRow.retry_count, 1);

  bulkInsert.run('task-single-requeue-boundary', bulkBatchA, 5, 'needs_review', 2, 3);
  const singleBoundary = await postAdminProblemQueue({
    action: 'requeue',
    taskId: 'task-single-requeue-boundary',
    reason: 'single requeue boundary smoke',
    idempotencyKey: 'single-requeue-boundary-key',
  });
  assert.equal(singleBoundary.status, 200);
  const singleBoundaryRow = db.prepare("SELECT status, retry_count FROM batch_tasks WHERE id = 'task-single-requeue-boundary'").get() as any;
  assert.equal(singleBoundaryRow.status, 'queued');
  assert.equal(singleBoundaryRow.retry_count, 3);

  bulkInsert.run('task-single-requeue-max', bulkBatchB, 2, 'needs_review', 3, 3);
  const singleMax = await postAdminProblemQueue({
    action: 'requeue',
    taskId: 'task-single-requeue-max',
    reason: 'single requeue max smoke',
    idempotencyKey: 'single-requeue-max-key',
  });
  assert.equal(singleMax.status, 409);
  assert.equal(singleMax.json.detail, 'retry_count_exceeded');
  const singleForce = await postAdminProblemQueue({
    action: 'requeue',
    taskId: 'task-single-requeue-max',
    force: true,
    reason: 'single force requeue smoke',
    idempotencyKey: 'single-requeue-force-key',
  });
  assert.equal(singleForce.status, 200);
  const singleForceRow = db.prepare("SELECT status, retry_count FROM batch_tasks WHERE id = 'task-single-requeue-max'").get() as any;
  assert.equal(singleForceRow.status, 'queued');
  assert.equal(singleForceRow.retry_count, 4);

  process.env.ORIGIN_HEALTH_NEEDS_REVIEW_THRESHOLD = '0';
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, target_json)
     VALUES ('task-health-needs-review', ?, 3, 'asset_images', 'needs_review', '{}')`,
  ).run(bulkBatchA);
  const health = getRuntimeHealth();
  const needsReviewCheck = health.checks.find((check: any) => check.name === 'tasks.needsReview') as any;
  assert.equal(needsReviewCheck.status, 'warn');
  assert.equal(needsReviewCheck.detail.count >= 1, true);

  console.log('[batch-durable] integration passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
