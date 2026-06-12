import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-vevdemo-export-api-worker-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.JWT_SECRET = 'origin-vevdemo-export-jwt-secret-000000000000';
process.env.SEED_PHONE = '13800000001';
process.env.SEED_PASSWORD = 'Origin123!';

async function main() {
  const [
    { getDb },
    { signToken, createUser },
    submitRoute,
    statusRoute,
    { extractVevDemoPlayUrl, parseVevDemoRemoteTaskResult },
    { getLatestVevDemoExportTaskForProject, serializeVevDemoExportTask },
    { runVevDemoExportPollingPass },
  ] = await Promise.all([
    import('../lib/db'),
    import('../lib/auth'),
    import('../app/api/online-editor/vevdemo-export/submit/route'),
    import('../app/api/online-editor/vevdemo-export/status/route'),
    import('../lib/vevdemo-vod-openapi'),
    import('../lib/vevdemo-export-tasks'),
    import('../lib/vevdemo-export-worker'),
  ]);

  const db = getDb();
  const user = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() as any;
  const token = await signToken(user);
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, description, data_json)
     VALUES ('project-vevdemo-export-api', ?, 'VevDemo Export API', '', '{}')`,
  ).run(user.id);

  const submitRes = await submitRoute.POST(new NextRequest('http://localhost:3000/api/online-editor/vevdemo-export/submit', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      projectId: 'project-vevdemo-export-api',
      vevProjectId: 'vev-project-api',
      vevGroupId: 'vev-group-api',
      vevSpace: 'origin',
      submitRequest: { ProjectId: 'vev-project-api' },
      submitResult: {
        ResponseMetadata: { RequestId: 'req-submit-api' },
        Result: { TaskId: 'vev-task-api' },
      },
    }),
  }));
  assert.equal(submitRes.status, 200);
  const submitBody = await submitRes.json();
  assert.equal(submitBody.task.providerTaskId, 'vev-task-api');
  assert.equal(submitBody.task.vevSpace, 'origin');

  const statusRes = await statusRoute.GET(new NextRequest('http://localhost:3000/api/online-editor/vevdemo-export/status?projectId=project-vevdemo-export-api', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.task.status, 'submitted');

  const otherUser = await createUser({
    phone: '13800000002',
    password: 'Origin123!',
    displayName: 'Other',
  });
  const otherToken = await signToken(otherUser);
  const forbiddenStatus = await statusRoute.GET(new NextRequest('http://localhost:3000/api/online-editor/vevdemo-export/status?projectId=project-vevdemo-export-api', {
    headers: { authorization: `Bearer ${otherToken}` },
  }));
  assert.equal(forbiddenStatus.status, 404);

  const parsed = parseVevDemoRemoteTaskResult({
    Result: {
      TaskList: [
        { TaskId: 'other', Status: 'Running' },
        { TaskId: 'vev-task-api', Status: 'Success', VideoId: 'vid-output-api' },
      ],
    },
  }, 'vev-task-api');
  assert.equal(parsed.state, 'completed');
  assert.equal(parsed.outputVid, 'vid-output-api');
  assert.equal(
    extractVevDemoPlayUrl({ Result: { PlayInfoList: [{ MainPlayUrl: 'https://cdn.example.com/worker.mp4' }] } }),
    'https://cdn.example.com/worker.mp4',
  );

  const pass = await runVevDemoExportPollingPass({
    intervalMs: 10_000,
    limit: 5,
    nowMs: Date.parse('2026-06-13T00:05:00.000Z'),
    resolveRemoteTask: async () => ({
      providerTaskId: 'vev-task-api',
      state: 'completed',
      outputUrl: 'https://cdn.example.com/worker.mp4',
      outputVid: 'vid-output-api',
      errorMsg: null,
      raw: { Result: { TaskList: [{ TaskId: 'vev-task-api', Status: 'Success' }] } },
      task: { TaskId: 'vev-task-api' },
    }),
    saveExportRecord: (input: any) => {
      assert.equal(input.userId, user.id);
      assert.equal(input.taskId, 'vev-task-api');
      assert.equal(input.outputUrl, 'https://cdn.example.com/worker.mp4');
      db.prepare(
        `INSERT INTO exports
          (id, owner_id, project_id, status, progress, provider, external_export_id, filename, local_download_status, edl_json)
         VALUES
          ('export-worker-api', ?, 'project-vevdemo-export-api', 'completed', 100, 'vevdemo', 'vev-task-api', NULL, 'pending', '{}')`,
      ).run(user.id);
      return { success: true, exportId: 'export-worker-api', status: 'completed' } as any;
    },
  });
  assert.equal(pass.claimed, true);
  assert.equal(pass.processed, 1);
  const task = serializeVevDemoExportTask(getLatestVevDemoExportTaskForProject({
    ownerId: user.id,
    projectId: 'project-vevdemo-export-api',
  }));
  assert.equal(task?.status, 'origin_downloading');
  assert.equal(task?.exportId, 'export-worker-api');
  assert.equal(task?.outputVid, 'vid-output-api');

  console.log('[vevdemo-export-api-worker] smoke passed');
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(tempDir, { recursive: true, force: true }));
