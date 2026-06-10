#!/usr/bin/env node
/**
 * Source contract: 删除尾帧 (delete-tail, tailFrameIntent='none') 之后，
 * 迟到的失败回写不得把卡片"复活"成生成失败。
 *
 * 背景: /api/batch/active 会把 failed 批次保留 30 分钟 (lib/batches.ts
 * getActiveBatchesForUser)，期间每次 focus/刷新/重连 reconcile 都会重放失败任务。
 * 修复前 _clearFailedTailFrameLocally 会无条件把 tailFrameLastError 写回并把
 * intent 翻回 'requested'，导致用户点了"删除"后失败横幅反复出现。
 *
 * 锁定的行为 (2026-06-10):
 *   1. 前端 _clearFailedTailFrameLocally 对 intent='none' 跳过回写并返回 false；
 *   2. 失败渲染调用点检查返回值，false 时不渲染失败卡片；
 *   3. 自动批量/续链选择跳过显式删除的组 (删除按钮承诺"下次批量重做不会再生成")；
 *   4. 服务端 _markFailedTailFrameState 同样不回写 intent='none' 的组；
 *   5. delete-tail 把失败元数据 (failedAt/safetyAudit/errorCode/recoveryHint) 清干净。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');
const batches = fs.readFileSync(path.join(REPO_ROOT, 'lib/batches.ts'), 'utf8');

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

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

record('helper _isTailFrameExplicitlyDeleted only treats explicit none as deleted', () => {
  const block = section(storyboard, 'function _isTailFrameExplicitlyDeleted(', '\n}');
  assert(block.includes("String(sb.tailFrameIntent || '') === 'none'"));
});

record('_clearFailedTailFrameLocally gates on deleted intent and reports applied', () => {
  const block = section(storyboard, 'function _clearFailedTailFrameLocally(', '\n  return applied;\n}');
  assert(block.includes('if (_isTailFrameExplicitlyDeleted(sb)) return;'), 'missing intent gate inside write-back');
  assert(block.includes('applied = true;'), 'missing applied flag');
  // gate 必须在所有失败字段写入之前
  assert(block.indexOf('_isTailFrameExplicitlyDeleted(sb)') < block.indexOf('sb.tailFrameLastError = msg'), 'gate must run before failure fields are written');
  assert(!block.includes('sb.tailFrameIntentUpdatedAt = sb.tailFrameIntentUpdatedAt ||') || block.indexOf('applied = true;') < block.indexOf("sb.tailFrameIntent = \"requested\""), 'intent flip must be behind the gate');
});

record('reattach terminal snapshot path skips render when failure write was gated', () => {
  const block = section(storyboard, 'function _applyReattachedTailTask(t)', 'tasks.forEach(_applyReattachedTailTask);');
  assert(block.includes('if (!_clearFailedTailFrameLocally(gIdx, errMsg, extra, originId)) return;'));
});

record('reattach SSE onTaskFailed path skips render when failure write was gated', () => {
  const block = section(storyboard, 'function _reattachTailFrameBatch(b)', 'function _reattachPromptsBatch');
  assert(block.includes('if (_clearFailedTailFrameLocally(gIdx2, errMsg2, extra, originId)) {'));
});

record('single-flow poll and SSE failure paths respect deleted intent', () => {
  const block = section(storyboard, 'export async function generateStoryboardTailFrame(', 'export async function generateAllTailFrames(');
  assert(block.includes('if (_isTailFrameExplicitlyDeleted(latestSb)) {'), 'poll path missing gate');
  assert(block.includes('if (!_clearFailedTailFrameLocally(gIdx, errMsgInner, extra, originId)) {'), 'SSE onTaskFailed missing gate');
});

record('bulk flow _failOne respects deleted intent', () => {
  const block = section(storyboard, 'function _failOne(extra, errMsg)', '\n    }');
  assert(block.includes('if (_clearFailedTailFrameLocally(gIdx, errMsg, extra, originId)) {'));
});

record('auto batch selection skips explicitly deleted tails', () => {
  const block = section(storyboard, 'export async function generateAllTailFrames(', '_setTailFramesGenerating(true);');
  assert(block.includes('if (_isTailFrameExplicitlyDeleted(sb)) { skipDeleted++; continue; }'));
});

record('_isTailKeyframeWanted excludes explicitly deleted tails (auto-chain)', () => {
  const block = section(storyboard, 'function _isTailKeyframeWanted(group, sb)', '\n}');
  assert(block.includes('if (_isTailFrameExplicitlyDeleted(sb)) return false;'));
});

record('delete-tail clears failure metadata so nothing re-triggers safety notice', () => {
  const block = section(storyboard, '} else if (action === "delete-tail") {', '} else if (action === "upload-tail") {');
  assert(block.includes("delSb.tailFrameIntent = 'none';"));
  assert(block.includes('delete delSb.tailFrameFailedAt;'));
  assert(block.includes('delete delSb.tailFrameSafetyAudit;'));
  assert(block.includes('delete delSb.tailFrameErrorCode;'));
  assert(block.includes('delete delSb.tailFrameRecoveryHint;'));
});

record('server _clearFailedTailFrameImageState does not resurrect deleted tails', () => {
  const block = section(batches, 'function _clearFailedTailFrameImageState(', 'function _markFailedAssetImageState(');
  assert(block.includes("if (String((prev as any).tailFrameIntent || '') === 'none') return null;"));
  // gate 必须在失败字段写入 storyboards 之前
  assert(block.indexOf("=== 'none') return null;") < block.indexOf('tailFrameFailedAt: failedAt'), 'server gate must run before failure fields are written');
});

if (failed.length) {
  console.error(`\n${failed.length} tail-frame delete no-resurrect contract checks failed.`);
  process.exit(1);
}

console.log(`\ntail-frame delete no-resurrect contract ok (${passed.length} checks)`);
