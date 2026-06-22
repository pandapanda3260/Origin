import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-durable-tasks-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');

async function main() {
  const { getDb } = await import('../lib/db');
  const {
    batchHeartbeat,
    chargeTaskLedger,
    claimNextTask,
    releaseExpiredTaskLeases,
    refundTaskLedger,
    requestTaskCancel,
    transitionTaskStatus,
  } = await import('../lib/durable-tasks');

  const db = getDb();
  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  assert.equal(user.id, 1);

  const batchId = 'batch-durable-smoke';
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES (?, ?, 'project-durable-smoke', 'test', 'queued', 6)`,
  ).run(batchId, user.id);

  const insertTask = db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, priority, status, target_json, runner_id, lease_expires_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  );
  insertTask.run('task-cancel', batchId, 0, 'generation', 10, 'queued', null, null, null);
  insertTask.run('task-run', batchId, 1, 'generation', 8, 'queued', null, null, null);
  insertTask.run('task-upstream-stale', batchId, 2, 'generation', 9, 'upstream_pending', 'old-runner', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
  insertTask.run('task-for-heartbeat', batchId, 3, 'generation', 1, 'running', 'runner-heartbeat', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insertTask.run('task-charge', batchId, 4, 'generation', 1, 'completed', null, null, null);
  insertTask.run('task-illegal', batchId, 5, 'generation', 1, 'completed', null, null, null);

  const cancelled = requestTaskCancel({ taskId: 'task-cancel', nowMs: Date.parse('2026-01-01T00:00:00.000Z') });
  assert.equal(cancelled.mode, 'cancelled');
  assert.equal(
    (db.prepare("SELECT status FROM batch_tasks WHERE id = 'task-cancel'").get() as any).status,
    'cancelled',
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM task_state_history WHERE task_id = 'task-cancel' AND to_state = 'cancelled'").get() as any).c,
    1,
  );

  assert.throws(
    () => transitionTaskStatus({ taskId: 'task-illegal', to: 'queued', reason: 'must fail' }),
    /illegal task status transition/,
  );

  assert.equal(releaseExpiredTaskLeases({ nowMs: Date.parse('2026-01-01T00:00:00.000Z') }), 1);
  const stale = db.prepare("SELECT status, runner_id FROM batch_tasks WHERE id = 'task-upstream-stale'").get() as any;
  assert.equal(stale.status, 'upstream_pending');
  assert.equal(stale.runner_id, null);

  const claimed = claimNextTask({
    runnerId: 'runner-claim',
    nowMs: Date.parse('2026-01-01T00:00:01.000Z'),
    taskTypes: ['generation'],
  }) as any;
  assert.equal(claimed.id, 'task-upstream-stale');
  assert.equal(claimed.status, 'upstream_pending');

  insertTask.run('task-exclude-a', batchId, 6, 'generation', 30, 'queued', null, null, null);
  insertTask.run('task-exclude-b', batchId, 7, 'generation', 20, 'queued', null, null, null);
  const claimedWithExclude = claimNextTask({
    runnerId: 'runner-claim-exclude',
    nowMs: Date.parse('2026-01-01T00:00:01.500Z'),
    taskTypes: ['generation'],
    excludeIds: ['task-exclude-a'],
  }) as any;
  assert.equal(claimedWithExclude.id, 'task-exclude-b', 'claimNextTask should skip excluded eligible tasks');

  transitionTaskStatus({
    taskId: 'task-run',
    from: 'queued',
    to: 'running',
    reason: 'smoke start',
    runnerId: 'runner-heartbeat',
  });

  db.prepare(
    `INSERT INTO scheduled_jobs (job_name, status, catch_up_strategy, runner_id, lease_expires_at, heartbeat_at)
     VALUES ('backup-smoke', 'running', 'run_once', 'runner-heartbeat', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
  ).run();
  const heartbeat = batchHeartbeat({
    runnerId: 'runner-heartbeat',
    nowMs: Date.parse('2026-01-01T00:00:02.000Z'),
  }) as any;
  assert.equal(heartbeat.taskChanges, 1);
  assert.equal(heartbeat.jobChanges, 1);

  const before = (db.prepare('SELECT total_credits FROM user_credits WHERE user_id = ?').get(user.id) as any).total_credits;
  chargeTaskLedger({ userId: user.id, taskId: 'task-charge', amount: 7, kind: 'image', reason: 'smoke charge' });
  chargeTaskLedger({ userId: user.id, taskId: 'task-charge', amount: 7, kind: 'image', reason: 'smoke charge duplicate' });
  refundTaskLedger({ userId: user.id, taskId: 'task-charge', amount: 7, reason: 'smoke refund' });
  refundTaskLedger({ userId: user.id, taskId: 'task-charge', amount: 7, reason: 'smoke refund duplicate' });

  const ledgerCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN charge_ref_id = 'charge:task-charge' THEN 1 ELSE 0 END) AS charges,
         SUM(CASE WHEN refund_ref_id = 'refund:task-charge' THEN 1 ELSE 0 END) AS refunds
       FROM credit_ledger`,
    )
    .get() as any;
  assert.equal(ledgerCounts.charges, 1);
  assert.equal(ledgerCounts.refunds, 1);
  const after = (db.prepare('SELECT total_credits FROM user_credits WHERE user_id = ?').get(user.id) as any).total_credits;
  assert.equal(after, before);

  console.log('[durable-tasks] smoke passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
