import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-vevdemo-export-tasks-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.SEED_PHONE = process.env.SEED_PHONE || '13800000000';
process.env.SEED_PASSWORD = process.env.SEED_PASSWORD || 'Origin123!';

async function main() {
  const { getDb } = await import('../lib/db');
  const {
    attachVevDemoExportRecord,
    extractVevDemoTaskIdFromSubmitResult,
    getVevDemoExportTaskById,
    getLatestVevDemoExportTaskForProject,
    listDueVevDemoExportTasks,
    markVevDemoExportRemoteCompleted,
    reconcileVevDemoExportDownloadStatuses,
    recordVevDemoExportSubmission,
    serializeVevDemoExportTask,
  } = await import('../lib/vevdemo-export-tasks');

  const db = getDb();
  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  assert.ok(user?.id, 'seed user must exist');
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, description, data_json)
     VALUES ('project-vevdemo-export', ?, 'VevDemo Export', '', '{}')`,
  ).run(user.id);

  const rawSubmit = {
    ResponseMetadata: { RequestId: 'req-submit-1' },
    Result: { TaskId: 'vev-task-1', Other: true },
  };
  assert.equal(extractVevDemoTaskIdFromSubmitResult(rawSubmit), 'vev-task-1');
  assert.equal(extractVevDemoTaskIdFromSubmitResult({ Result: { TaskIds: ['vev-task-2'] } }), 'vev-task-2');

  const recorded = recordVevDemoExportSubmission({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
    vevProjectId: 'vev-project-1',
    vevGroupId: 'vev-group-1',
    vevSpace: 'origin',
    providerTaskId: 'vev-task-1',
    submitRequest: { ProjectId: 'vev-project-1' },
    submitResult: rawSubmit,
    nowIso: '2026-06-13T00:00:00.000Z',
  });
  assert.equal(recorded.duplicate, false);
  assert.equal(recorded.task.status, 'submitted');

  const exportCountBeforeRemoteComplete = db.prepare('SELECT COUNT(*) AS c FROM exports').get() as { c: number };
  assert.equal(exportCountBeforeRemoteComplete.c, 0, 'submit tracking must not pre-create exports rows');

  const duplicate = recordVevDemoExportSubmission({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
    providerTaskId: 'vev-task-1',
    submitRequest: { ProjectId: 'ignored' },
    submitResult: { Result: { TaskId: 'vev-task-1' } },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task.id, recorded.task.id);

  const latest = getLatestVevDemoExportTaskForProject({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
  });
  assert.equal(latest?.id, recorded.task.id);
  assert.equal(listDueVevDemoExportTasks({ nowIso: '2026-06-13T00:00:01.000Z' }).length, 1);

  const completed = markVevDemoExportRemoteCompleted({
    id: recorded.task.id,
    outputUrl: 'https://cdn.example.com/render.mp4',
    outputVid: 'vid-output-1',
    pollResult: { ResponseMetadata: { RequestId: 'req-poll-1' }, Result: { TaskId: 'vev-task-1' } },
    nowIso: '2026-06-13T00:01:00.000Z',
  });
  assert.equal(completed.status, 'remote_completed');
  assert.equal(completed.output_url, 'https://cdn.example.com/render.mp4');

  db.prepare(
    `INSERT INTO exports
      (id, owner_id, project_id, status, progress, provider, external_export_id, filename, local_download_status, edl_json)
     VALUES
      ('export-vev-1', ?, 'project-vevdemo-export', 'completed', 100, 'vevdemo', 'vev-task-1', NULL, 'pending', '{}')`,
  ).run(user.id);
  const attached = attachVevDemoExportRecord({
    id: recorded.task.id,
    exportId: 'export-vev-1',
    outputUrl: 'https://cdn.example.com/render.mp4',
    outputVid: 'vid-output-1',
  });
  assert.equal(attached.status, 'origin_downloading');

  db.prepare(
    `UPDATE exports
        SET local_download_status = 'completed',
            filename = 'data/exports/1/export-vev-1.mp4'
      WHERE id = 'export-vev-1'`,
  ).run();
  const reconciledReady = reconcileVevDemoExportDownloadStatuses({
    nowIso: '2026-06-13T00:02:00.000Z',
  });
  assert.deepEqual(reconciledReady, { scanned: 1, ready: 1, failed: 0, needsReview: 0 });
  const ready = getLatestVevDemoExportTaskForProject({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
  });
  assert.equal(ready?.status, 'ready');
  assert.equal(ready?.output_url, 'https://cdn.example.com/render.mp4');
  assert.equal(ready?.output_vid, 'vid-output-1');
  assert.equal(ready?.export_id, 'export-vev-1');

  const recorded2 = recordVevDemoExportSubmission({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
    providerTaskId: 'vev-task-2',
    submitResult: { Result: { TaskId: 'vev-task-2' } },
  });
  db.prepare(
    `INSERT INTO exports
      (id, owner_id, project_id, status, progress, provider, external_export_id, filename, local_download_status, edl_json, error_msg)
     VALUES
      ('export-vev-2', ?, 'project-vevdemo-export', 'completed', 100, 'vevdemo', 'vev-task-2', NULL, 'download_failed', '{}', 'remote_http_403')`,
  ).run(user.id);
  attachVevDemoExportRecord({ id: recorded2.task.id, exportId: 'export-vev-2' });
  const reconciledFailed = reconcileVevDemoExportDownloadStatuses({
    nowIso: '2026-06-13T00:03:00.000Z',
  });
  assert.deepEqual(reconciledFailed, { scanned: 1, ready: 0, failed: 1, needsReview: 0 });
  const failed = serializeVevDemoExportTask(getLatestVevDemoExportTaskForProject({
    ownerId: user.id,
    projectId: 'project-vevdemo-export',
  }));
  assert.equal(failed?.status, 'origin_download_failed');
  assert.equal(failed?.errorMsg, 'remote_http_403');
  const firstTask = serializeVevDemoExportTask(getVevDemoExportTaskById(recorded.task.id, user.id));
  assert.equal((firstTask?.submitResult as any)?.ResponseMetadata?.RequestId, 'req-submit-1');

  console.log('[vevdemo-export-tasks] smoke passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
