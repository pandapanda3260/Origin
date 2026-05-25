#!/usr/bin/env node
/**
 * SQLite 真集成测试 (需要在能加载 better-sqlite3 的机器上跑, 比如你的 Mac).
 *
 * 跑法:
 *   node scripts/test-tail-frame-no-auto-stale-sqlite.js
 *
 * 不依赖你已有的 data/qd.sqlite —— 用 mkdtemp 起一个临时 DB 和 images 目录,
 * 跑完不污染你本地数据。
 *
 * 验证:
 *   - PUT 项目时把 storyboards[0].firstFrameUrl 换成另一张图;
 *   - 之后 storyboards[0].tailFrame* 字段全部保留, referenceStatus 仍然 ready;
 *   - videoTasks[0] 没被删;
 *   - 顶层不应该有 tailFrameStaleAt / tailFrameStaleReason;
 *   - frames.tail.staleReason 不应该存在。
 */
require('./_ts-require-hook.js');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

const TMP_DIR = mkdtempSync(join(tmpdir(), 'origin-tail-stale-it-'));
process.env.ORIGIN_DATA_DIR = TMP_DIR;
process.env.DB_PATH = join(TMP_DIR, 'qd.sqlite');
process.env.FRAME_WORKFLOW_ASSERT_ALIGNMENT = '0';
process.env.NODE_ENV = 'test';

const { getDb } = require('../lib/db.ts');
const projectsDb = require('../lib/projects-db.ts');
const frameWorkflow = require('../lib/frame-workflow-state.ts');

function makeImageOnDisk(ownerId, label) {
  const id = randomUUID();
  const imagesDir = join(TMP_DIR, 'images', String(ownerId));
  mkdirSync(imagesDir, { recursive: true });
  const filename = `${label}-${id}.png`;
  const fullPath = join(imagesDir, filename);
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEUlEQVR4AWPgZGD4z0AswK4SAAvyAQXeYNvCAAAAAElFTkSuQmCC';
  writeFileSync(fullPath, Buffer.from(b64, 'base64'));
  return { id, filename, fullPath };
}

function insertImageRow(db, ownerId, projectId, image) {
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, filename, mime, size_bytes, width, height, prompt)
     VALUES (@id, @ownerId, @projectId, 'storyboard', @filename, 'image/png', 256, 1, 1, '')`,
  ).run({ id: image.id, ownerId, projectId, filename: image.filename });
}

function createTestUser(db) {
  const info = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
  ).run('tail-stale-it', 'tail-stale-it@example.com', 'Tester', 'fake-hash');
  return Number(info.lastInsertRowid);
}

const passed = [];
const failed = [];
function record(label, fn) {
  try {
    fn();
    passed.push(label);
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed.push({ label, err });
    console.error(`FAIL  ${label}`);
    console.error(err.stack || err.message);
  }
}

const db = getDb();
const userId = createTestUser(db);

const firstV1 = makeImageOnDisk(userId, 'first-v1');
const firstV2 = makeImageOnDisk(userId, 'first-v2');
const tailImg = makeImageOnDisk(userId, 'tail');

const project = projectsDb.createProjectForUser(userId, { name: 'tail-stale-it' });
const projectId = project.id;

insertImageRow(db, userId, projectId, firstV1);
insertImageRow(db, userId, projectId, firstV2);
insertImageRow(db, userId, projectId, tailImg);

const firstFrameUrlV1 = `/api/images/file/${firstV1.id}`;
const firstFrameUrlV2 = `/api/images/file/${firstV2.id}`;
const tailFrameUrl = `/api/images/file/${tailImg.id}`;

// 初始 state: 首帧 v1 + 尾帧 ready + videoTask 已成
projectsDb.patchProjectForUser(projectId, userId, () => ({
  shots: [{ idx: 0, visual: 'shot zero', characters: ['A'] }],
  styleBible: { vision: 'noir' },
  storyboards: [{
    idx: 0,
    shotIdx: 1,
    shotIndices: [0],
    firstFrameUrl: firstFrameUrlV1,
    firstFrameMode: 'structured_v1',
    firstFrameSourceHash: 'hash-v1-first',
    firstFrame: { currentUrl: firstFrameUrlV1, status: 'ready', lastKnownGoodUrl: firstFrameUrlV1 },
    tailFrameUrl,
    tailFrameMode: 'structured_v1',
    tailFrameIntent: 'requested',
    tailFrameSourceHash: 'hash-v1-tail',
    tailFrameReferenceStatus: 'ready',
    frames: {
      first: { url: firstFrameUrlV1, status: 'ready', shotIndices: [0], sourceHash: 'hash-v1-first' },
      tail: { url: tailFrameUrl, status: 'ready', shotIndices: [0], sourceHash: 'hash-v1-tail', referenceStatus: 'ready' },
    },
  }],
  videoTasks: [{
    groupIdx: 0,
    taskId: 'video-task-1',
    status: 'completed',
    url: '/fake/video-1.mp4',
    isCurrent: true,
  }],
}));

const before = projectsDb.getProjectByIdForUser(projectId, userId);
assert.equal(before.storyboards[0].firstFrameUrl, firstFrameUrlV1, 'pre-check: v1');
assert.equal(before.storyboards[0].tailFrameUrl, tailFrameUrl, 'pre-check: tail');
assert.equal(before.storyboards[0].tailFrameReferenceStatus, 'ready', 'pre-check: tail ready');
assert.ok(before.videoTasks[0], 'pre-check: video task');

// 触发首帧 URL 变化 (PUT 整片 storyboards)
const updatedSb0 = {
  ...before.storyboards[0],
  firstFrameUrl: firstFrameUrlV2,
  firstFrame: { ...before.storyboards[0].firstFrame, currentUrl: firstFrameUrlV2, lastKnownGoodUrl: firstFrameUrlV2 },
  frames: {
    ...before.storyboards[0].frames,
    first: { ...before.storyboards[0].frames.first, url: firstFrameUrlV2, sourceHash: 'hash-v2-first' },
  },
  firstFrameSourceHash: 'hash-v2-first',
};
projectsDb.updateProjectForUser(projectId, userId, { storyboards: [updatedSb0] });

const after = projectsDb.getProjectByIdForUser(projectId, userId);
const sb = after.storyboards[0];
const tail = (sb.frames && sb.frames.tail) || {};

record('首帧 URL 已切换到 v2', () => assert.equal(sb.firstFrameUrl, firstFrameUrlV2));
record('尾帧 URL 保留', () => assert.equal(sb.tailFrameUrl, tailFrameUrl));
record('尾帧 referenceStatus 仍是 ready, 没被改成 stale', () => assert.equal(sb.tailFrameReferenceStatus, 'ready'));
record('顶层不应有 tailFrameStaleAt', () => assert.equal(sb.tailFrameStaleAt, undefined));
record('顶层不应有 tailFrameStaleReason', () => assert.equal(sb.tailFrameStaleReason, undefined));
record('frames.tail 不应有 staleReason', () => assert.equal(tail.staleReason, undefined));
record('frames.tail.referenceStatus 不应是 stale', () => assert.notEqual(tail.referenceStatus, 'stale'));
record('videoTasks[0] 保留, 没有被 delete', () => {
  assert.ok(after.videoTasks[0]);
  assert.equal(after.videoTasks[0].taskId, 'video-task-1');
});
record('markTailFrameStaleForFirstFrameChange 已不导出', () => {
  assert.equal(typeof frameWorkflow.markTailFrameStaleForFirstFrameChange, 'undefined');
});
record('computeFrameWorkflowStaleFlags 不再回 tail_frame_X', () => {
  const flags = frameWorkflow.computeFrameWorkflowStaleFlags(after, userId);
  const tailKeys = Object.keys(flags).filter((k) => k.startsWith('tail_frame_'));
  assert.deepEqual(tailKeys, []);
});

console.log(`\n${passed.length}/${passed.length + failed.length} passed`);
console.log(`tmp dir: ${TMP_DIR} (跑完可手动 rm -rf)`);
if (failed.length) {
  process.exitCode = 1;
  console.error(`\n${failed.length} test(s) failed`);
  for (const f of failed) console.error(`  - ${f.label}`);
}
