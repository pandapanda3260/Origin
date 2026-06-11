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
const visualReferenceState = fs.readFileSync(path.join(REPO_ROOT, 'lib/visual-reference-state.ts'), 'utf8');
const deleteRoute = fs.readFileSync(path.join(REPO_ROOT, 'app/api/frames/delete/route.ts'), 'utf8');

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

record('delete-tail calls authoritative API and reloads project', () => {
  const block = section(storyboard, '} else if (action === "delete-tail") {', '} else if (action === "upload-tail") {');
  assert(block.includes("var deleteResp = await apiPost('/api/frames/delete'"), 'delete-tail must call frames/delete and keep response');
  assert(block.includes("frameType: 'tail_frame'"), 'delete-tail must pass tail_frame');
  assert(block.includes('try {'), 'delete-tail must catch API errors');
  assert(block.includes('} catch (err) {'), 'delete-tail must catch API errors');
  assert(block.includes('_diagnoseApiError'), 'delete-tail error toast must diagnose API errors');
  assert(block.includes('await _reloadProjectFromServerForStoryboard(deleteOriginId)'), 'delete-tail must reload authoritative project');
  assert(block.includes('_applyDeletedTailFrameLocally(gIdx, deleteResp, deleteOriginId)'), 'delete-tail must apply server-confirmed delete locally if reload fails');
  assert(block.includes("showToast('已删除，请刷新页面查看', 'warn');"), 'delete-tail must report reload fallback when local apply is impossible');
  assert(block.includes('renderImageGrid();'), 'delete-tail must refresh grid after reload');
  assert(block.includes('checkImagesConfirm();'), 'delete-tail must refresh confirm state after reload');
  assert(!block.includes('saveProject();'), 'delete-tail must not use debounced full-project PUT');
  assert(!block.includes('delSb.'), 'delete-tail must not locally author deletion fields');
});

record('_applyDeletedTailFrameLocally mirrors confirmed delete without persistence', () => {
  const block = section(storyboard, 'function _applyDeletedTailFrameLocally(', '\n  return true;\n}');
  assert(block.includes('project.id !== projectId'), 'local delete mirror must guard project switch');
  [
    "next.tailFrameUrl = '';",
    "next.tailFramePrompt = '';",
    "next.tailFrameIntent = 'none';",
    'next.tailFrameSourceHash = null;',
    "next.tailFrameReferenceStatus = 'missing';",
    "next.tailFrameLastError = '';",
    'delete frames.tail;',
    'delete next.tailFrameFailedAt;',
    'delete next.tailFrameSafetyAudit;',
    'delete next.tailFrameErrorCode;',
    'delete next.tailFrameRecoveryHint;',
    "delete project._staleFlags['tail_frame_' + groupIdx];",
    'project.version = serverVersion;',
  ].forEach((needle) => assert(block.includes(needle), `missing ${needle}`));
  assert(!block.includes('saveProject();'), 'local delete mirror must not enqueue full-project PUT');
  assert(!block.includes('_safeWriteBack'), 'local delete mirror must not call safe write-back');
});

record('server _clearFailedTailFrameImageState does not resurrect deleted tails', () => {
  const block = section(batches, 'function _clearFailedTailFrameImageState(', 'function _markFailedAssetImageState(');
  assert(block.includes("if (String((prev as any).tailFrameIntent || '') === 'none') return null;"));
  // gate 必须在失败字段写入 storyboards 之前
  assert(block.indexOf("=== 'none') return null;") < block.indexOf('tailFrameFailedAt: failedAt'), 'server gate must run before failure fields are written');
});

record('markTailFrameDeleted centralizes tail delete field list', () => {
  const block = section(visualReferenceState, 'export function markTailFrameDeleted(', 'export type TailFramePreflightError');
  [
    "next.tailFrameUrl = '';",
    "next.tailFramePrompt = '';",
    "next.tailFrameIntent = 'none';",
    'next.tailFrameSourceHash = null;',
    "next.tailFrameReferenceStatus = 'missing';",
    "next.tailFrameLastError = '';",
    'delete frames.tail;',
    'delete next.tailFrameFailedAt;',
    'delete next.tailFrameSafetyAudit;',
    'delete next.tailFrameErrorCode;',
    'delete next.tailFrameRecoveryHint;',
  ].forEach((needle) => assert(block.includes(needle), `missing ${needle}`));
  assert(!block.includes('shotIdx'), 'helper must not own shotIdx');
  assert(!block.includes('shotIndices'), 'helper must not own shotIndices');
});

record('/api/frames/delete uses authoritative patch route', () => {
  assert(deleteRoute.includes('patchProjectForUser(projectId, user.id'), 'route must use patchProjectForUser');
  assert(deleteRoute.includes('markTailFrameDeleted(prev'), 'route must call markTailFrameDeleted');
  assert(deleteRoute.includes("frameType !== 'tail_frame'"), 'route must reject non-tail frame types');
  assert(deleteRoute.includes("jsonError('当前仅支持删除尾帧'"), 'route must not open first-frame delete behavior');
  assert(deleteRoute.includes('tailFrameIntentUpdatedAt'), 'route must return delete timestamp for local UI fallback');
});

record('/api/frames/delete writes shot alignment and clears stale flag safely', () => {
  assert(deleteRoute.includes("storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' })"), 'route must use single-shot-strict shot indices');
  assert(deleteRoute.includes('maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, \'tail-frame-delete\')'), 'route must assert alignment');
  assert(deleteRoute.includes('const nextStaleFlags: Record<string, any> = { ...prevStaleFlags };'), 'route must copy stale flags map');
  assert(deleteRoute.includes('delete nextStaleFlags[staleKey];'), 'route must delete only the tail stale key');
  assert(deleteRoute.includes('return { storyboards, _staleFlags: nextStaleFlags };'), 'route must return whole stale flags map');
});

if (failed.length) {
  console.error(`\n${failed.length} tail-frame delete no-resurrect contract checks failed.`);
  process.exit(1);
}

console.log(`\ntail-frame delete no-resurrect contract ok (${passed.length} checks)`);
