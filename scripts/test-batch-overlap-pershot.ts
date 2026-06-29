import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-batch-overlap-pershot-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.ORIGIN_BATCH_INLINE_RUNNER = '0';

async function main() {
  const { getDb } = await import('../lib/db');
  const { ActiveVideoBatchConflictError, createBatch } = await import('../lib/batches');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() as any;
  db.prepare(
    `UPDATE user_credits
        SET subscription_credits = 100,
            topup_credits = 100,
            bonus_credits = 100,
            total_credits = 300
      WHERE user_id = ?`,
  ).run(user.id);

  function insertActive(projectId: string, batchId: string, targets: any[]) {
    db.prepare(
      `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
       VALUES (?, ?, ?, 'storyboard_images', 'running', ?)`,
    ).run(batchId, user.id, projectId, targets.length);
    const insert = db.prepare(
      `INSERT INTO batch_tasks (id, batch_id, seq, task_type, status, target_json)
       VALUES (?, ?, ?, 'storyboard_images', 'running', ?)`,
    );
    targets.forEach((target, idx) => {
      insert.run(`${batchId}-task-${idx}`, batchId, idx, JSON.stringify(target));
    });
  }

  insertActive('project-reuse-shot', 'batch-shot-a', [{ groupIdx: 0, shotUid: 'shot-a' }]);
  const reused = createBatch({
    user,
    batchType: 'storyboard_images',
    projectId: 'project-reuse-shot',
    targets: [{ groupIdx: 0, shotUid: 'shot-a' }],
  });
  assert.equal(reused.reused, true, 'same group+shotUid can reuse active storyboard image batch');
  assert.equal(reused.batchId, 'batch-shot-a');

  insertActive('project-different-shot', 'batch-shot-a-different', [{ groupIdx: 0, shotUid: 'shot-a' }]);
  const differentShot = createBatch({
    user,
    batchType: 'storyboard_images',
    projectId: 'project-different-shot',
    targets: [{ groupIdx: 0, shotUid: 'shot-b' }],
  });
  assert.equal(differentShot.reused, undefined, 'same group with different shotUid does not reuse active batch');
  assert.notEqual(differentShot.batchId, 'batch-shot-a-different', 'same group with different shotUid can create a new batch');

  insertActive('project-wildcard-active', 'batch-wildcard', [{ groupIdx: 2 }]);
  assert.throws(
    () => createBatch({
      user,
      batchType: 'storyboard_images',
      projectId: 'project-wildcard-active',
      targets: [{ groupIdx: 2, shotUid: 'shot-x' }],
    }),
    ActiveVideoBatchConflictError,
    'group-level active batch conflicts with per-shot request instead of being reused',
  );

  insertActive('project-wildcard-request', 'batch-shot-specific', [{ groupIdx: 3, shotUid: 'shot-z' }]);
  assert.throws(
    () => createBatch({
      user,
      batchType: 'storyboard_images',
      projectId: 'project-wildcard-request',
      targets: [{ groupIdx: 3 }],
    }),
    ActiveVideoBatchConflictError,
    'group-level request conflicts with active per-shot batch instead of being reused',
  );

  console.log('test-batch-overlap-pershot: ok');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
