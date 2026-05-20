import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-online-editor-expiry-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');

async function main() {
  const { getDb } = await import('../lib/db');
  const { ensureScheduledJob } = await import('../lib/scheduled-jobs');
  const {
    ONLINE_EDITOR_REEXPORT_REASON,
    assertOnlineEditorDownloadUrlAllowed,
    assertOnlineEditorRedirectAllowed,
    isForbiddenOnlineEditorDownloadAddress,
    runOnlineEditorDownloadScheduledPass,
  } = await import('../lib/online-editor-downloads');

  const db = getDb();
  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  assert.equal(isForbiddenOnlineEditorDownloadAddress('127.0.0.1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('10.1.2.3'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('172.16.1.1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('192.168.1.10'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('169.254.1.10'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('0.1.2.3'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('::1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('fe80::1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('fc00::1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('::ffff:127.0.0.1'), true);
  assert.equal(isForbiddenOnlineEditorDownloadAddress('93.184.216.34'), false);

  await assert.rejects(
    () => assertOnlineEditorDownloadUrlAllowed('ftp://example.com/render.mp4'),
    /forbidden_scheme/,
  );
  await assert.rejects(
    () => assertOnlineEditorDownloadUrlAllowed('http://example.com/render.mp4', {
      lookup: async () => ['93.184.216.34'],
    }),
    /forbidden_scheme/,
  );
  await assert.doesNotReject(() => assertOnlineEditorDownloadUrlAllowed('http://example.com/render.mp4', {
    allowInsecure: true,
    lookup: async () => ['93.184.216.34'],
  }));
  await assert.rejects(
    () => assertOnlineEditorDownloadUrlAllowed('https://127.0.0.1/render.mp4'),
    /forbidden_host/,
  );
  await assert.rejects(
    () => assertOnlineEditorRedirectAllowed('https://cdn.example.com/render.mp4', 'http://127.0.0.1/private', {
      allowInsecure: true,
      lookup: async (hostname) => (hostname === 'cdn.example.com' ? ['93.184.216.34'] : ['127.0.0.1']),
    }),
    /forbidden_redirect/,
  );

  const expiredMeta = {
    vevDemo: {
      remoteUrl: 'https://example.com/render.mp4?Expires=1700000000',
      remoteUrlExpiresAt: '2020-01-01T00:00:00.000Z',
      localDownloadStatus: 'pending',
    },
  };
  db.prepare(
    `INSERT INTO exports
      (id, owner_id, project_id, status, progress, filename, local_download_status, edl_json, error_msg)
     VALUES ('export-expired', ?, 'project-expiry', 'completed', 100, NULL, 'pending', ?, NULL)`,
  ).run(user.id, JSON.stringify(expiredMeta));

  ensureScheduledJob({
    jobName: 'online_editor_download_scan',
    catchUpStrategy: 'current_state_only',
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  });
  const pass = runOnlineEditorDownloadScheduledPass(10_000);
  assert.equal(pass.claimed, true);
  assert.equal(pass.expiry.expired, 1);

  const row = db.prepare("SELECT * FROM exports WHERE id = 'export-expired'").get() as any;
  assert.equal(row.local_download_status, 'download_failed');
  assert.equal(row.error_msg, ONLINE_EDITOR_REEXPORT_REASON);
  const meta = JSON.parse(row.edl_json);
  assert.equal(meta.vevDemo.needsReviewReason, ONLINE_EDITOR_REEXPORT_REASON);
  assert.equal(meta.vevDemo.reexportRequired, true);

  const job = db.prepare("SELECT * FROM scheduled_jobs WHERE job_name = 'online_editor_download_scan'").get() as any;
  assert.equal(job.status, 'idle');
  assert.ok(job.last_run_at);

  console.log('[online-editor-expiry] smoke passed');
}

main().finally(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
