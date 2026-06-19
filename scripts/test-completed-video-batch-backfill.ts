import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-video-batch-backfill-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');

async function main() {
  const { getDb } = await import('../lib/db');
  const {
    backfillCompletedVideoBatchResults,
    countDirtyCompletedVideoBatchTasks,
  } = await import('./backfill-completed-video-batch-results');

  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash)
     VALUES (501, 'backfill-user', 'Backfill User', 'hash')`,
  ).run();
  db.prepare(
    `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total)
     VALUES ('batch-backfill', 501, 'project-backfill', 'video_segments', 'completed', 4)`,
  ).run();
  db.prepare(
    `INSERT INTO video_tasks
      (id, owner_id, project_id, group_idx, prompt, provider, provider_task, status, progress, filename, duration_sec, cover_image_id)
     VALUES
      ('video-local', 501, 'project-backfill', 0, '', 'seedance', 'remote-local', 'completed', 100, '片段1测试项目.mp4', 6.5, 'cover-local'),
      ('video-fallback', 501, 'project-backfill', 1, '', 'seedance', 'remote-fallback', 'completed', 100, '片段2测试项目.mp4', 7.25, 'cover-fallback')`,
  ).run();

  const emptyCompleted = {
    resultUrl: '',
    patch: { type: 'video_segment', url: '', taskId: 'empty' },
    extra: { protectedUrl: '', mode: 'real' },
  };
  db.prepare(
    `INSERT INTO batch_tasks
      (id, batch_id, seq, task_type, status, provider, provider_task_id, result_json, target_json)
     VALUES
      ('task-local', 'batch-backfill', 0, 'video_segments', 'completed', 'volcengine_seedance_video', 'remote-local', @localJson, '{}'),
      ('task-fallback', 'batch-backfill', 1, 'video_segments', 'completed', 'volcengine_seedance_video', 'remote-fallback', @fallbackJson, '{}'),
      ('task-skipped', 'batch-backfill', 2, 'video_segments', 'completed', 'volcengine_seedance_video', 'remote-missing', @skippedJson, '{}'),
      ('task-image', 'batch-backfill', 3, 'image', 'completed', 'volcengine_seedream_image', 'remote-image', @imageJson, '{}')`,
  ).run({
    localJson: JSON.stringify({
      ...emptyCompleted,
      providerSubmission: {
        localVideoTaskId: 'video-local',
      },
    }),
    fallbackJson: JSON.stringify(emptyCompleted),
    skippedJson: JSON.stringify(emptyCompleted),
    imageJson: JSON.stringify(emptyCompleted),
  });

  assert.equal(countDirtyCompletedVideoBatchTasks(db), 3);
  const dryRun = await backfillCompletedVideoBatchResults({ db, apply: false, requireBackup: false });
  assert.equal(dryRun.scanned, 3);
  assert.equal(dryRun.matched, 2);
  assert.equal(dryRun.skippedCount, 1);
  assert.deepEqual(dryRun.skipped, ['task-skipped']);
  assert.equal(dryRun.updated, 0);
  assert.equal(countDirtyCompletedVideoBatchTasks(db), 3);

  const applied = await backfillCompletedVideoBatchResults({ db, apply: true, requireBackup: false });
  assert.equal(applied.updated, 2);
  assert.equal(applied.skippedCount, 1);
  assert.deepEqual(applied.skipped, ['task-skipped']);
  assert.equal(applied.fullyClean, false);
  assert.equal(applied.remainingDirtyCompletedVideoBatches, 1);
  assert.equal(countDirtyCompletedVideoBatchTasks(db), 1);

  const localResult = JSON.parse((db.prepare("SELECT result_json FROM batch_tasks WHERE id = 'task-local'").get() as any).result_json);
  assert.equal(localResult.resultUrl, '/api/videos/file/video-local');
  assert.equal(localResult.patch.url, '/api/videos/file/video-local');
  assert.equal(localResult.extra.protectedUrl, '/api/videos/file/video-local');
  assert.equal(localResult.patch.filename, '片段1测试项目.mp4');
  assert.equal(localResult.patch.coverUrl, '/api/images/file/cover-local');
  assert.equal(localResult.patch.durationSec, 6.5);
  assert.equal(localResult.extra.mode, 'real');

  const fallbackResult = JSON.parse((db.prepare("SELECT result_json FROM batch_tasks WHERE id = 'task-fallback'").get() as any).result_json);
  assert.equal(fallbackResult.resultUrl, '/api/videos/file/video-fallback');
  assert.equal(fallbackResult.patch.filename, '片段2测试项目.mp4');

  const imageResult = JSON.parse((db.prepare("SELECT result_json FROM batch_tasks WHERE id = 'task-image'").get() as any).result_json);
  assert.equal(imageResult.resultUrl, '');

  console.log('[completed-video-batch-backfill] smoke passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
