#!/usr/bin/env node
/**
 * 真集成测试: 验证"首帧变化不再自动 stale 尾帧 / 不再删除 videoTasks"。
 *
 * 跑法:
 *   node --experimental-strip-types scripts/test-tail-frame-no-auto-stale.mjs
 *
 * 做法:
 *   1. 把 ORIGIN_DATA_DIR 指到一个临时目录, 让 projects-db / image-gen 用全新 SQLite + 全新 images 目录;
 *   2. 直接往 users / images 表插数据, 在磁盘上真造两张 PNG 文件 (1x1 灰色);
 *   3. createProjectForUser 起一个空项目, 再用 patchProjectForUser 写入 storyboards / videoTasks;
 *   4. 调 updateProjectForUser, patch 把 storyboards[0].firstFrameUrl 换成另一张图 (模拟"重新生成首帧/上传首帧/切历史");
 *   5. 读回项目, 断言:
 *        - storyboards[0].tailFrameUrl 不变
 *        - storyboards[0].tailFrameReferenceStatus 仍是 'ready' (而不是 'stale')
 *        - 不存在 tailFrameStaleAt / tailFrameStaleReason
 *        - frames.tail 上没有 staleReason
 *        - videoTasks[0] 仍然在
 *   6. 额外: import frame-workflow-state, 断言 markTailFrameStaleForFirstFrameChange 已经不导出;
 *   7. 额外: 调 computeFrameWorkflowStaleFlags, 断言不会再产出 tail_frame_${groupIdx};
 *   8. 额外: 验 video-payload-decision 把历史脏数据里的 'stale' 状态 normalize 成 ready/file_missing。
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'origin-tail-stale-test-'));
process.env.ORIGIN_DATA_DIR = TMP_DIR;
process.env.DB_PATH = join(TMP_DIR, 'qd.sqlite');
process.env.ORIGIN_FRAME_WORKFLOW_ASSERT_ALIGNMENT = '0';
process.env.NODE_ENV = 'test';

// 必须在 set env 之后再 import, 不然 db.ts 拿到的是默认 cwd/data
const { getDb } = await import('../lib/db.ts');
const projectsDb = await import('../lib/projects-db.ts');
const frameWorkflow = await import('../lib/frame-workflow-state.ts');
const videoPayload = await import('../lib/video-payload-decision.ts');

function makeImageOnDisk(ownerId, imageId, label) {
  const imagesDir = join(TMP_DIR, 'images', String(ownerId));
  mkdirSync(imagesDir, { recursive: true });
  const filename = `${label}-${imageId}.png`;
  const fullPath = join(imagesDir, filename);
  // 1x1 灰色 PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEUlEQVR4AWPgZGD4z0AswK4SAAvyAQXeYNvCAAAAAElFTkSuQmCC';
  writeFileSync(fullPath, Buffer.from(b64, 'base64'));
  return { id: imageId, filename, fullPath };
}

function insertImageRow(db, ownerId, projectId, kind, image) {
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, filename, mime, size_bytes, width, height, prompt)
     VALUES (@id, @ownerId, @projectId, @kind, @filename, 'image/png', 256, 1, 1, '')`,
  ).run({ id: image.id, ownerId, projectId, kind, filename: image.filename });
}

function createTestUser(db) {
  const info = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
  ).run('tail-stale-tester', 'tail-stale-tester@example.com', 'Tester', 'fake-hash');
  return Number(info.lastInsertRowid);
}

const passed = [];
const failed = [];
function recordTest(label, fn) {
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

// === 0. 准备真实数据库 + 用户 + 两张图 ===
const db = getDb();
const userId = createTestUser(db);

const firstFrameImg1 = makeImageOnDisk(userId, randomUUID(), 'first-v1');
const firstFrameImg2 = makeImageOnDisk(userId, randomUUID(), 'first-v2');
const tailFrameImg = makeImageOnDisk(userId, randomUUID(), 'tail');

const project = projectsDb.createProjectForUser(userId, { name: 'tail-stale-it' });
const projectId = project.id;

insertImageRow(db, userId, projectId, 'storyboard', firstFrameImg1);
insertImageRow(db, userId, projectId, 'storyboard', firstFrameImg2);
insertImageRow(db, userId, projectId, 'storyboard', tailFrameImg);

const firstFrameUrlV1 = `/api/images/file/${firstFrameImg1.id}`;
const firstFrameUrlV2 = `/api/images/file/${firstFrameImg2.id}`;
const tailFrameUrl = `/api/images/file/${tailFrameImg.id}`;

// 写入完整的 storyboards[0] + videoTasks[0]: 首帧 ready + 尾帧 ready + 视频已生成
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
assert.equal(before.storyboards[0].firstFrameUrl, firstFrameUrlV1, 'pre-check: v1 first frame written');
assert.equal(before.storyboards[0].tailFrameUrl, tailFrameUrl, 'pre-check: tail frame written');
assert.equal(before.storyboards[0].tailFrameReferenceStatus, 'ready', 'pre-check: tail ready');
assert.ok(before.videoTasks[0], 'pre-check: video task written');

// === 1. 触发首帧 URL 变化 (模拟 PUT 项目) ===
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
const tail = sb.frames?.tail || {};

recordTest('首帧 URL 已切换到 v2', () => {
  assert.equal(sb.firstFrameUrl, firstFrameUrlV2);
});
recordTest('尾帧 URL 保留不动', () => {
  assert.equal(sb.tailFrameUrl, tailFrameUrl);
});
recordTest('尾帧 referenceStatus 仍是 ready, 没有被改成 stale', () => {
  assert.equal(sb.tailFrameReferenceStatus, 'ready');
});
recordTest('storyboard 顶层不应有 tailFrameStaleAt', () => {
  assert.equal(sb.tailFrameStaleAt, undefined);
});
recordTest('storyboard 顶层不应有 tailFrameStaleReason', () => {
  assert.equal(sb.tailFrameStaleReason, undefined);
});
recordTest('frames.tail 上不应有 staleReason', () => {
  assert.equal(tail.staleReason, undefined);
});
recordTest('frames.tail.referenceStatus 不应被改成 stale', () => {
  assert.notEqual(tail.referenceStatus, 'stale');
});
recordTest('videoTasks[0] 保留, 没有被 delete', () => {
  assert.ok(after.videoTasks[0], 'videoTasks[0] missing');
  assert.equal(after.videoTasks[0].taskId, 'video-task-1');
  assert.equal(after.videoTasks[0].url, '/fake/video-1.mp4');
});

// === 2. markTailFrameStaleForFirstFrameChange 已废弃 ===
recordTest('markTailFrameStaleForFirstFrameChange 不再被导出', () => {
  assert.equal(typeof frameWorkflow.markTailFrameStaleForFirstFrameChange, 'undefined');
});

// === 3. computeFrameWorkflowStaleFlags 不再产出 tail_frame_${groupIdx} ===
recordTest('computeFrameWorkflowStaleFlags 不再回 tail_frame_X', () => {
  const flags = frameWorkflow.computeFrameWorkflowStaleFlags(after, userId);
  const tailKeys = Object.keys(flags).filter((k) => k.startsWith('tail_frame_'));
  assert.deepEqual(tailKeys, [], `unexpected tail flags: ${tailKeys.join(',')}`);
});

// === 4. video-payload-decision 把历史脏数据里的 'stale' normalize 掉 ===
recordTest("normalize: status='stale' + url + path  → ready", () => {
  const s = videoPayload.normalizeTailFrameReferenceStatus({
    status: 'stale',
    tailFrameUrl: tailFrameUrl,
    tailFramePath: tailFrameImg.fullPath,
  });
  assert.equal(s, 'ready');
});
recordTest("normalize: status='stale' + url, 无 path → file_missing", () => {
  const s = videoPayload.normalizeTailFrameReferenceStatus({
    status: 'stale',
    tailFrameUrl: tailFrameUrl,
  });
  assert.equal(s, 'file_missing');
});

// === 5. video 决策: 首帧 ready + 尾帧 ready → first_last_frame 模式 ===
recordTest('video 决策: 首帧 + 尾帧都 ready → first_last_frame', () => {
  const decision = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: firstFrameImg2.fullPath,
    tailFramePath: tailFrameImg.fullPath,
    tailFrameUrl,
    tailReferenceStatus: sb.tailFrameReferenceStatus,
    tailIntentRequested: sb.tailFrameIntent === 'requested',
  });
  assert.equal(decision.payloadMode, 'first_last_frame');
  assert.equal(decision.reason, 'tail_ready');
  assert.equal(decision.hardFail, false);
  assert.equal(decision.firstLastFrameMode?.firstFramePath, firstFrameImg2.fullPath);
  assert.equal(decision.firstLastFrameMode?.lastFramePath, tailFrameImg.fullPath);
});

// === 6. video 决策: 历史脏数据里残留 status='stale' 也能落到 first_last_frame ===
recordTest('video 决策: 历史脏数据 status="stale" 也走 first_last_frame', () => {
  const decision = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: firstFrameImg2.fullPath,
    tailFramePath: tailFrameImg.fullPath,
    tailFrameUrl,
    tailReferenceStatus: 'stale', // 历史脏数据
    tailIntentRequested: true,
  });
  assert.equal(decision.payloadMode, 'first_last_frame', 'legacy stale should normalize to ready');
  assert.equal(decision.reason, 'tail_ready');
});

// === 总结 ===
console.log(`\n${passed.length}/${passed.length + failed.length} passed`);
if (failed.length) {
  process.exitCode = 1;
  console.error(`\n${failed.length} test(s) failed`);
  for (const f of failed) console.error(`  - ${f.label}`);
}
