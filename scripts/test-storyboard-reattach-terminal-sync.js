#!/usr/bin/env node
/**
 * Source contract: terminal storyboard/tail reattach paths must schedule one
 * authoritative project reload, and tail reattach completion must not stay as a
 * local-only UI update.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');

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

function section(start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

record('terminal reload scheduler exists and dedupes by batch key', () => {
  assert.match(src, /var _storyboardTerminalReloadedByBatch = Object\.create\(null\);/);
  assert.match(src, /var _storyboardTerminalReloadPendingByBatch = Object\.create\(null\);/);
  assert.match(src, /function _scheduleStoryboardTerminalProjectReload\(projectId, batchId, opts\)/);
  const helper = section('function _scheduleStoryboardTerminalProjectReload', '/**');
  assert(helper.includes('if (_storyboardTerminalReloadedByBatch[key]) return Promise.resolve(false);'));
  assert(helper.includes('await _reloadProjectFromServerForStoryboard(first.projectId);'));
  assert(helper.includes('renderImageGrid();'));
});

record('storyboard_images terminal snapshot schedules authoritative reload with confirm check', () => {
  const block = section('function _reattachImagesBatch', 'function _reattachTailFrameBatch');
  assert(block.includes('var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));'));
  assert(block.includes('reason: "storyboard_images_terminal_snapshot"'));
  assert(block.includes('confirmImages: true'));
});

record('storyboard_images reattached SSE completion uses terminal reload scheduler', () => {
  const block = section('function _reattachImagesBatch', 'function _reattachTailFrameBatch');
  assert(block.includes('reason: "storyboard_images_sse_completed"'));
  assert(block.includes('await _scheduleStoryboardTerminalProjectReload(originId, batchId, {'));
});

record('storyboard_images terminal paths hand off to the per-shot tail chain sweep', () => {
  // 2026-06-10 起批末 one-shot 续链被逐镜头续链取代 (方案: 尾帧逐镜头自动续链-方案.md):
  // 终态快照/SSE 完成两条路径在权威 reload 之后做状态驱动的兜底扫描, 不再依赖
  // requireTerminalReload 一次性 flag (旧 flag 在条件不满足的瞬间被消费后永不重试)。
  const block = section('function _reattachImagesBatch', 'function _reattachTailFrameBatch');
  const snapReloadIdx = block.indexOf('reason: "storyboard_images_terminal_snapshot"');
  const snapSweepIdx = block.indexOf("_scheduleTailChainSweep('images-terminal-snapshot');");
  assert(snapSweepIdx > snapReloadIdx && snapReloadIdx > -1, 'terminal snapshot must sweep after scheduling reload');
  const sseReloadIdx = block.indexOf('reason: "storyboard_images_sse_completed"');
  const sseSweepIdx = block.indexOf("_scheduleTailChainSweep('images-sse-completed');");
  assert(sseSweepIdx > sseReloadIdx && sseReloadIdx > -1, 'SSE completion must sweep after awaiting reload');
  // 逐张完成事件 (reattach 重放) 也即时入链, 不等批次终态
  assert(block.includes("_scheduleTailChain(originId, gIdx, 'reattach-first-done');"));
});

record('tail chain sweep runs on reconcile regardless of active batches', () => {
  const dispatcher = section('export async function reattachStoryboardBatches()', 'function _reattachImagesBatch');
  const sweepIdx = dispatcher.indexOf("_scheduleTailChainSweep('reconcile');");
  const activeIdx = dispatcher.indexOf('getActiveBatchesShared(originId)');
  assert(sweepIdx > -1, 'reconcile must trigger the tail chain sweep');
  assert(activeIdx > sweepIdx, 'sweep must run before the active-batch query and its empty-result early return');
  const flush = section('async function _flushTailChain', 'function _runStoryboardBatchReconcile');
  assert(flush.includes('generateAllTailFrames({'), 'chain flush must reuse the existing batch generator');
  assert(flush.includes("chainSource: 'tail-chain'"), 'chain flush must mark its source for abort visibility');
});

record('tail_frame_images terminal snapshot schedules authoritative reload without confirm check', () => {
  const block = section('function _reattachTailFrameBatch', 'function _reattachPromptsBatch');
  assert(block.includes('var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));'));
  assert(block.includes('reason: "tail_frame_images_terminal_snapshot"'));
  assert(block.includes('confirmImages: false'));
});

record('tail_frame_images onBatchCompleted is no longer local-only', () => {
  const block = section('function _reattachTailFrameBatch', 'function _reattachPromptsBatch');
  assert(block.includes('reason: "tail_frame_images_sse_completed"'));
  assert(!block.includes('不强制 reload project'));
});

if (failed.length) {
  console.error(`\n${failed.length} storyboard terminal sync contract checks failed.`);
  process.exit(1);
}

console.log(`\nstoryboard reattach terminal sync contract ok (${passed.length} checks)`);
