#!/usr/bin/env node
/**
 * 沙箱可跑部分: 验证"首帧变化不再自动 stale 尾帧 / 不再删除 videoTasks"。
 *
 * 测什么:
 *   A. video-payload-decision (纯函数):
 *      - normalize: 历史脏数据里的 status='stale' 落回 ready / file_missing;
 *      - 'stale' 不再是 TailFrameReferenceStatus / VideoPayloadDecisionReason 的合法值;
 *      - resolveVideoPayloadDecision 在 status='stale' (历史脏数据) + 文件齐全时
 *        正常走 first_last_frame 模式;
 *      - 'failed' / 'missing' / 'file_missing' / 'pending' 这些分支还能正确降级或阻塞。
 *   B. 静态结构验证 (grep 源码):
 *      - markTailFrameStaleForFirstFrameChange 函数本体不存在;
 *      - 没有任何代码调用 markTailFrameStaleForFirstFrameChange;
 *      - projects-db.ts 不再有 applyPutFirstFrameChangeGuard;
 *      - computeFrameWorkflowStaleFlags 源码里不再写 tail_frame_;
 *      - video-payload-decision.ts 源码里 TailFrameReferenceStatus union 不含 'stale';
 *      - 几个调用点 (batch-executors / frames upload / set-current-from-history)
 *        不再调 markTailFrameStaleForFirstFrameChange, 也不再 delete videoTasks[groupIdx]。
 *
 * 不测什么:
 *   - SQLite 真实 PUT 流程: better-sqlite3 是 native binding, 沙箱 ELF 头不匹配, 无法加载。
 *     这部分由 scripts/test-tail-frame-no-auto-stale-sqlite.js 在 Mac 上手动跑。
 */
require('./_ts-require-hook.js');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');

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

function readSrc(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ============================================================================
// A. video-payload-decision: 纯函数行为
// ============================================================================
const videoPayload = require('../lib/video-payload-decision.ts');

record("normalize: status='stale' + url + path → ready (历史脏数据 normalize)", () => {
  const s = videoPayload.normalizeTailFrameReferenceStatus({
    status: 'stale',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailFramePath: '/tmp/whatever.png',
  });
  assert.equal(s, 'ready');
});

record("normalize: status='stale' + url, 无 path → file_missing", () => {
  const s = videoPayload.normalizeTailFrameReferenceStatus({
    status: 'stale',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
  });
  assert.equal(s, 'file_missing');
});

record("normalize: 显式 'ready' / 'failed' / 'missing' / 'pending' / 'file_missing' 都正常透传", () => {
  for (const status of ['ready', 'failed', 'missing', 'pending', 'file_missing']) {
    const out = videoPayload.normalizeTailFrameReferenceStatus({
      status,
      tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
      tailFramePath: '/tmp/whatever.png',
    });
    assert.equal(out, status, `status=${status} should pass through`);
  }
});

record("resolveVideoPayloadDecision: 首帧+尾帧 ready → first_last_frame", () => {
  const d = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailReferenceStatus: 'ready',
    tailIntentRequested: true,
    independentMultiImageCapable: true,
  });
  assert.equal(d.payloadMode, 'first_last_frame');
  assert.equal(d.reason, 'tail_ready');
  assert.equal(d.hardFail, false);
  assert.equal(d.firstLastFrameMode && d.firstLastFrameMode.firstFramePath, '/tmp/first.png');
  assert.equal(d.firstLastFrameMode && d.firstLastFrameMode.lastFramePath, '/tmp/tail.png');
});

record("resolveVideoPayloadDecision: 历史脏数据 status='stale' 自动 normalize → first_last_frame", () => {
  const d = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailReferenceStatus: 'stale', // ← 历史脏数据, 应该被 normalize
    tailIntentRequested: true,
    independentMultiImageCapable: true,
  });
  assert.equal(d.payloadMode, 'first_last_frame', 'legacy stale should normalize to ready');
  assert.equal(d.reason, 'tail_ready');
  assert.equal(d.hardFail, false);
});

record("resolveVideoPayloadDecision: 'failed' 还能软降级 (auto 模式)", () => {
  const d = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailReferenceStatus: 'failed',
    tailIntentRequested: true,
    independentMultiImageCapable: true,
  });
  assert.equal(d.payloadMode, 'first_frame_multi_ref');
  assert.equal(d.reason, 'tail_failed');
  assert.equal(d.hardFail, false);
});

record("resolveVideoPayloadDecision: 'pending' 还能硬挡", () => {
  const d = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailReferenceStatus: 'pending',
    tailIntentRequested: true,
    independentMultiImageCapable: true,
  });
  assert.equal(d.hardFail, true);
  assert.equal(d.reason, 'tail_pending');
});

record("resolveVideoPayloadDecision: 显式 first_last_frame + status=stale (normalize 后) → 走 first_last_frame", () => {
  const d = videoPayload.resolveVideoPayloadDecision({
    submitMode: 'first_last_frame',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000001',
    tailReferenceStatus: 'stale',
    tailIntentRequested: true,
    independentMultiImageCapable: true,
  });
  // 历史脏 status='stale' 在文件齐全的情况下被 normalize 成 ready, 显式 first_last_frame 也能走通,
  // 用户不会因为 DB 里残留的 stale 字段被无故 hard-fail。
  assert.equal(d.payloadMode, 'first_last_frame');
  assert.equal(d.hardFail, false);
});

// ============================================================================
// B. 静态源码结构验证 (避开 SQLite)
// ============================================================================

record('frame-workflow-state.ts: markTailFrameStaleForFirstFrameChange 函数本体不存在', () => {
  const src = readSrc('lib/frame-workflow-state.ts');
  // 注释里允许提到这个函数名 (废弃说明), 但不能再有 export function 或 function 定义。
  const hasExport = /export\s+function\s+markTailFrameStaleForFirstFrameChange/.test(src);
  const hasFn = /^function\s+markTailFrameStaleForFirstFrameChange/m.test(src);
  assert.equal(hasExport, false, 'export function 还在');
  assert.equal(hasFn, false, 'function 定义还在');
});

record('全仓库: 没有任何代码调用 markTailFrameStaleForFirstFrameChange', () => {
  const { execSync } = require('node:child_process');
  // 排除测试文件 / 注释里的提及; 只看是否还有可执行的调用。
  const out = execSync(
    "grep -rn 'markTailFrameStaleForFirstFrameChange' --include='*.ts' --include='*.js' --include='*.mjs' lib app public/modules || true",
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const lines = out.split('\n').filter(Boolean);
  const callerLines = lines.filter((line) => {
    // 注释 (//... 或 *... 开头) 和 strip 字段引用都不算调用
    const text = line.split(':').slice(2).join(':').trim();
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return false;
    // import / export 也不算调用; 但本仓库已经全删了所以不会出现
    return /markTailFrameStaleForFirstFrameChange\s*\(/.test(text);
  });
  assert.deepEqual(callerLines, [], `still has callers:\n${callerLines.join('\n')}`);
});

record('projects-db.ts: applyPutFirstFrameChangeGuard 不存在', () => {
  const src = readSrc('lib/projects-db.ts');
  assert.equal(/applyPutFirstFrameChangeGuard/.test(src), false);
});

record('projects-db.ts: 不再 import markTailFrameStaleForFirstFrameChange 或 resolveStoryboardFirstFrameUrl', () => {
  const src = readSrc('lib/projects-db.ts');
  assert.equal(/markTailFrameStaleForFirstFrameChange/.test(src), false);
  assert.equal(/resolveStoryboardFirstFrameUrl/.test(src), false);
});

record('batch-executors.ts: 首帧 executor 不再 markTailFrameStaleForFirstFrameChange / delete videoTasks', () => {
  const src = readSrc('lib/batch-executors.ts');
  assert.equal(/markTailFrameStaleForFirstFrameChange/.test(src), false, 'still references the helper');
  // 旧 pattern: `if (videoTasks.length > groupIdx) delete videoTasks[groupIdx];` 在首帧 executor 块里
  assert.equal(/delete\s+videoTasks\[groupIdx\]/.test(src), false, 'still deletes videoTasks[groupIdx]');
});

record('frames/upload/route.ts: 不再 markTailFrameStaleForFirstFrameChange', () => {
  const src = readSrc('app/api/frames/upload/route.ts');
  assert.equal(/markTailFrameStaleForFirstFrameChange/.test(src), false);
});

record('frames/set-current-from-history/route.ts: 不再 markTailFrameStaleForFirstFrameChange / 不再删 videoTasks', () => {
  const src = readSrc('app/api/frames/set-current-from-history/route.ts');
  assert.equal(/markTailFrameStaleForFirstFrameChange/.test(src), false);
  assert.equal(/delete\s+videoTasks\[/.test(src), false);
});

record('frame-workflow-state.ts: computeFrameWorkflowStaleFlags 不再写 tail_frame_${...}', () => {
  const src = readSrc('lib/frame-workflow-state.ts');
  const fnMatch = src.match(/export function computeFrameWorkflowStaleFlags[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'function not found');
  // 把注释行 strip 掉再 grep, 避免说明里出现 "tail_frame_" 被误判。
  const codeOnly = fnMatch[0]
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join('\n');
  assert.equal(/tail_frame_/.test(codeOnly), false, `tail_frame_ still produced:\n${codeOnly}`);
});

record('video-payload-decision.ts: TailFrameReferenceStatus union 不含 stale', () => {
  const src = readSrc('lib/video-payload-decision.ts');
  const m = src.match(/export type TailFrameReferenceStatus[\s\S]*?;/);
  assert.ok(m, 'union not found');
  assert.equal(/'stale'/.test(m[0]), false, `stale still in union:\n${m[0]}`);
});

record('video-payload-decision.ts: VideoPayloadDecisionReason union 不含 tail_stale', () => {
  const src = readSrc('lib/video-payload-decision.ts');
  const m = src.match(/export type VideoPayloadDecisionReason[\s\S]*?;/);
  assert.ok(m, 'union not found');
  assert.equal(/'tail_stale'/.test(m[0]), false, `tail_stale still in union:\n${m[0]}`);
});

record('app/api/batch/start/route.ts: 文案/动作映射不再有 tail_stale / first_last_frame_tail_stale', () => {
  const src = readSrc('app/api/batch/start/route.ts');
  assert.equal(/['"]tail_stale['"]/.test(src), false);
  assert.equal(/['"]first_last_frame_tail_stale['"]/.test(src), false);
});

record('public/modules/storyboard.js: 不再有 tailFrameStaleAt / tailFrameStaleReason 写入', () => {
  const src = readSrc('public/modules/storyboard.js');
  // 允许 destructure strip 的引用, 但不能再有"赋值给 existing.tailFrameStaleAt = ..."这种
  assert.equal(/existing\.tailFrameStaleAt\s*=/.test(src), false);
  assert.equal(/existing\.tailFrameStaleReason\s*=/.test(src), false);
});

// ============================================================================
// 总结
// ============================================================================
console.log(`\n${passed.length}/${passed.length + failed.length} passed`);
if (failed.length) {
  process.exitCode = 1;
  console.error(`\n${failed.length} test(s) failed`);
  for (const f of failed) console.error(`  - ${f.label}`);
}
