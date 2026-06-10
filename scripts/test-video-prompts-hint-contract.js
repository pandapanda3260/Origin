#!/usr/bin/env node
/**
 * Source contract: video-prompts page progress hint must settle after the batch
 * ends — terminal reattach and late SSE snapshots must not leave or restore a
 * stale "生成中… N/N" line.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const vp = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/videoPrompts.js'), 'utf8');
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

const attach = section(vp, 'function _attachVideoPromptBatch(opts)', 'function _videoPromptBatchStatus');

// 进度文案只在"批仍在跑"时允许写：terminal reattach 的任务回放、finish 之后的
// 迟到回放都不得制造"生成中…"。
const refreshFn = section(attach, 'function _refreshRunningHint()', 'function _videoPromptFailureToast');
assert(refreshFn.includes('if (!hint || finished || terminalAtAttach) return;'), 'running hint must be guarded against finished and terminal-attach replay');

// SSE 重连会重发 snapshot 帧；finish 之后不允许覆盖完成文案。
const snapshotCb = section(attach, 'onSnapshot: function (snap)', 'onTaskStarted');
assert(snapshotCb.includes('if (finished) return;'), 'late SSE snapshot must not overwrite the settled hint');

// finish（含 terminal reattach）统一通过 sync 写完成/缺失/待生成摘要。
const finishFn = section(attach, 'async function finish()', 'function _applyTaskCompleted');
assert(finishFn.includes('_syncVideoPromptsHeaderHint();'), 'finish should settle the hint through the shared sync helper');

// 静态摘要：页面渲染与 finish 共用一个 sync，按优先级显示
// 生成中(不抢占) > 缺失摘要 > 生成完成 N/N > 待生成… 0/N > 空。
const syncFn = section(vp, 'function _syncVideoPromptsHeaderHint()', 'function _shouldBatchTargetVideoPrompt');
assert(syncFn.includes('if (_videoPromptsGenerating) return;'), 'active bulk generation must keep owning the hint');
assert(syncFn.includes('"生成完成 " + ready + "/" + groups.length'), 'all-ready projects should show 生成完成 N/N');
assert(syncFn.includes('"待生成… 0/" + groups.length'), 'never-generated projects should show 待生成… 0/N');
assert(syncFn.includes('条已生成，缺少镜头'), 'partially generated projects should list missing shots');
const refreshPage = section(vp, 'export function refreshPromptsPage()', 'function _scheduleVideoPromptBatchReattach');
assert(refreshPage.includes('_syncVideoPromptsHeaderHint();'), 'page render should restore the static summary');

console.log('video prompts hint contract ok');
