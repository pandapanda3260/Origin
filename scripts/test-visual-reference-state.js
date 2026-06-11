/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 测试 lib/visual-reference-state.ts 的 tail frame 部分 (P2.5a.T0 新增):
 *   - checkTailFramePreflight 对不同首帧状态的判定;
 *   - normalizeTailFrameState / markTailFrameReady / markTailFrameFailed / markTailFrameDeleted 基本行为。
 *
 * 约定与其它 test:xxx 脚本一致, 用 ts.transpileModule + vm.runInNewContext。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function compileTs(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    sourcePath,
    code: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadVisualReferenceState() {
  const compiled = compileTs('lib/visual-reference-state.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    compiled.code,
    { require, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assert failed: ${message}\n  actual:   ${a}\n  expected: ${e}`);
}

// ---------- tests ----------

async function testPreflightStructuredV1Passes() {
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000a1',
    firstFrameMode: 'structured_v1',
    frames: { first: { url: '/api/images/file/00000000-0000-0000-0000-0000000000a1', status: 'ready' } },
  };
  assertEqual(mod.checkTailFramePreflight(sb), null, 'structured_v1 should pass');
}

async function testPreflightMultiRefV1Passes() {
  // 兼容旧字段: P0 时落库用的 multi_ref_v1, 尾帧 executor 也要能跑
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000b2',
    firstFrameMode: 'multi_ref_v1',
  };
  assertEqual(mod.checkTailFramePreflight(sb), null, 'multi_ref_v1 should pass');
}

async function testPreflightLegacyPencilRejected() {
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000c3',
    firstFrameMode: 'legacy_pencil',
    firstFrame: { status: 'legacy_sketch_only' },
  };
  const err = mod.checkTailFramePreflight(sb);
  assert(err, 'legacy_pencil should be rejected');
  assertEqual(err.reason, 'invalid_first_frame_mode', 'reason = invalid_first_frame_mode');
  assertEqual(err.firstFrameMode, 'legacy_pencil', 'reports the actual mode');
  // 确认提示文案点名 legacy_pencil 不适用
  const msg = mod.formatTailFramePreflightError(0, err);
  assert(/legacy_pencil/i.test(msg) || /手稿/.test(msg), 'error message should mention legacy_pencil');
}

async function testPreflightLegacyPencilWithReadyStatusStillRejected() {
  // 混合数据: mode='legacy_pencil' 但 frames.first.status='ready' (手工上传或旧数据迁移)
  // 必须仍然被拒, legacy_pencil 的 override 优先级高于 status。
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000c4',
    firstFrameMode: 'legacy_pencil',
    frames: { first: { url: '/api/images/file/00000000-0000-0000-0000-0000000000c4', status: 'ready' } },
  };
  const err = mod.checkTailFramePreflight(sb);
  assert(err, 'legacy_pencil + frames.first.status=ready must still be rejected');
  assertEqual(err.reason, 'invalid_first_frame_mode', 'reason');
  assertEqual(err.firstFrameMode, 'legacy_pencil', 'mode reported');
}

async function testPreflightMissingFirstFrame() {
  const mod = loadVisualReferenceState();
  const err = mod.checkTailFramePreflight({});
  assert(err, 'empty sb should be rejected');
  assertEqual(err.reason, 'missing_first_frame', 'reason');
  const msg = mod.formatTailFramePreflightError(2, err);
  assert(/片段 3/.test(msg), 'error message should include 1-based groupIdx (3 = idx 2 + 1)');
}

async function testPreflightIndependentTailWithoutFirstFramePasses() {
  const mod = loadVisualReferenceState();
  assertEqual(
    mod.checkTailFramePreflight({}, { dependency: 'independent' }),
    null,
    'independent tail frame should not require first frame',
  );
}

async function testPreflightFirstFrameFailed() {
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000d4',
    firstFrameMode: 'structured_v1',
    frames: { first: { url: '/api/images/file/00000000-0000-0000-0000-0000000000d4', status: 'failed' } },
  };
  const err = mod.checkTailFramePreflight(sb);
  assert(err, 'failed first frame should be rejected');
  assertEqual(err.reason, 'first_frame_failed', 'reason = first_frame_failed');
}

async function testPreflightFallbackStatusReady() {
  // 只有 frames.first.status='ready', firstFrameMode 为空也放行 (兼容: 新上传的首帧可能没写 mode)
  const mod = loadVisualReferenceState();
  const sb = {
    firstFrameUrl: '/api/images/file/00000000-0000-0000-0000-0000000000e5',
    frames: { first: { url: '/api/images/file/00000000-0000-0000-0000-0000000000e5', status: 'ready' } },
  };
  assertEqual(mod.checkTailFramePreflight(sb), null, 'ready status alone should pass');
}

async function testNormalizeAndMarkTail() {
  const mod = loadVisualReferenceState();
  // 空 storyboard → missing
  const empty = mod.normalizeTailFrameState({});
  assertEqual(empty.status, 'missing', 'empty → missing');

  // markTailFrameReady
  const ready = mod.markTailFrameReady({}, '/local/tail.png', '/local/tail.png');
  assertEqual(ready.status, 'ready', 'markReady → ready');
  assertEqual(ready.source, 'generated', 'default source = generated');
  assertEqual(ready.currentUrl, '/local/tail.png', 'currentUrl set');

  // markTailFrameReady with uploaded source (为 P2.5b 预留)
  const uploaded = mod.markTailFrameReady({}, '/local/upload.png', undefined, 'uploaded');
  assertEqual(uploaded.source, 'uploaded', 'uploaded source preserved');

  // markTailFrameFailed with previous success → degraded
  const prevSb = { frames: { tail: { url: '/local/prev.png', status: 'ready' } } };
  const degraded = mod.markTailFrameFailed(prevSb, { message: 'moderation blocked' });
  assertEqual(degraded.status, 'degraded', 'with fallback → degraded, not failed');
  assertEqual(degraded.source, 'last_known_good', 'source = last_known_good');
  assertEqual(degraded.currentUrl, '/local/prev.png', 'keep last good url for display');

  // markTailFrameFailed without any previous → failed
  const failed = mod.markTailFrameFailed({}, { message: 'first attempt crashed' });
  assertEqual(failed.status, 'failed', 'no fallback → failed');
}

async function testMarkTailFrameDeletedClearsTailOnly() {
  const mod = loadVisualReferenceState();
  const prev = {
    idx: 12,
    shotIdx: 13,
    shotIndices: [12],
    tailFrameUrl: '/api/images/file/tail',
    tailFramePrompt: 'old prompt',
    tailFrameIntent: 'requested',
    tailFrameIntentUpdatedAt: '2026-06-10T00:00:00.000Z',
    tailFrameSourceHash: 'tail-hash',
    tailFrameReferenceStatus: 'failed',
    tailFrameLastError: 'blocked',
    tailFrameFailedAt: '2026-06-10T00:01:00.000Z',
    tailFrameSafetyAudit: { blocked: true },
    tailFrameErrorCode: 'moderation_blocked',
    tailFrameRecoveryHint: 'rewrite',
    tailFrameHistory: [{ url: '/api/images/file/history-tail' }],
    tailFrameBasePrompt: { content: 'base prompt' },
    tailFrameBackup: { content: 'backup prompt' },
    tailFrameEditDraft: { content: 'draft prompt' },
    originalTailFramePrompt: 'original prompt',
    tailFramePlanSummary: { ok: true },
    frames: {
      first: { url: '/api/images/file/first', status: 'ready' },
      tail: { url: '/api/images/file/tail', status: 'failed' },
    },
  };
  const deleted = mod.markTailFrameDeleted(prev, { at: '2026-06-11T00:00:00.000Z' });

  assertEqual(deleted.idx, 12, 'idx preserved by helper');
  assertEqual(deleted.shotIdx, 13, 'shotIdx preserved by helper');
  assertEqual(deleted.shotIndices, [12], 'shotIndices preserved by helper');
  assertEqual(deleted.frames.first.url, '/api/images/file/first', 'first frame preserved');
  assertEqual(deleted.frames.tail, undefined, 'frames.tail deleted');
  assertEqual(deleted.tailFrameUrl, '', 'tailFrameUrl cleared');
  assertEqual(deleted.tailFramePrompt, '', 'tailFramePrompt cleared');
  assertEqual(deleted.tailFrameIntent, 'none', 'intent = none');
  assertEqual(deleted.tailFrameIntentUpdatedAt, '2026-06-11T00:00:00.000Z', 'intent timestamp set');
  assertEqual(deleted.tailFrameSourceHash, null, 'source hash cleared');
  assertEqual(deleted.tailFrameReferenceStatus, 'missing', 'reference status missing');
  assertEqual(deleted.tailFrameLastError, '', 'last error cleared');
  assertEqual(deleted.tailFrameFailedAt, undefined, 'failedAt deleted');
  assertEqual(deleted.tailFrameSafetyAudit, undefined, 'safety audit deleted');
  assertEqual(deleted.tailFrameErrorCode, undefined, 'error code deleted');
  assertEqual(deleted.tailFrameRecoveryHint, undefined, 'recovery hint deleted');
  assertEqual(deleted.tailFrameHistory, prev.tailFrameHistory, 'tail history preserved');
  assertEqual(deleted.tailFrameBasePrompt, prev.tailFrameBasePrompt, 'base prompt preserved');
  assertEqual(deleted.tailFrameBackup, prev.tailFrameBackup, 'backup preserved');
  assertEqual(deleted.tailFrameEditDraft, prev.tailFrameEditDraft, 'edit draft preserved');
  assertEqual(deleted.originalTailFramePrompt, prev.originalTailFramePrompt, 'original prompt preserved');
  assertEqual(deleted.tailFramePlanSummary, prev.tailFramePlanSummary, 'plan summary preserved');
}

async function testFirstFrameFailureDoesNotFallbackToStoryboardSketch() {
  const mod = loadVisualReferenceState();
  const sb = {
    url: '/api/images/file/00000000-0000-0000-0000-000000000101',
    imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000101',
    rawUrl: '/api/images/file/00000000-0000-0000-0000-000000000101',
    firstFrameLastError: '生成失败',
  };
  assertEqual(mod.resolveStoryboardFirstFrameUrl(sb), '', 'generic storyboard URLs must not resolve as first frame');
  const failed = mod.markFirstFrameFailed(sb, { message: '生成失败' });
  assertEqual(failed.status, 'failed', 'failed first frame without canonical fallback stays failed');
  assertEqual(failed.currentUrl, undefined, 'failed first frame must not keep storyboard sketch as currentUrl');
  assertEqual(failed.lastKnownGoodUrl, undefined, 'failed first frame must not keep storyboard sketch as lastKnownGoodUrl');
}

async function main() {
  const tests = [
    ['preflight: structured_v1 passes', testPreflightStructuredV1Passes],
    ['preflight: multi_ref_v1 passes (legacy P0 compat)', testPreflightMultiRefV1Passes],
    ['preflight: legacy_pencil rejected with clear msg', testPreflightLegacyPencilRejected],
    ['preflight: legacy_pencil + frames.first.status=ready still rejected', testPreflightLegacyPencilWithReadyStatusStillRejected],
    ['preflight: missing first frame rejected', testPreflightMissingFirstFrame],
    ['preflight: independent tail without first frame passes', testPreflightIndependentTailWithoutFirstFramePasses],
    ['preflight: first frame failed rejected', testPreflightFirstFrameFailed],
    ['preflight: frames.first.status=ready alone passes', testPreflightFallbackStatusReady],
    ['normalize + markReady + markFailed basics', testNormalizeAndMarkTail],
    ['markTailFrameDeleted clears only tail frame state', testMarkTailFrameDeletedClearsTailOnly],
    ['first frame failure does not fallback to storyboard sketch', testFirstFrameFailureDoesNotFallbackToStoryboardSketch],
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      pass += 1;
    } catch (err) {
      console.error(`FAIL  ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n${pass}/${tests.length} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
