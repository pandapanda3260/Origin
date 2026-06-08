#!/usr/bin/env node
/**
 * Source contract: storyboard batch reattach must dedupe running batches at the
 * reattach layer, before any UI timer or EventSource is created.
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

record('running guard state and helpers exist', () => {
  assert.match(src, /var _storyboardReattachRunningByBatch = Object\.create\(null\);/);
  assert.match(src, /var _storyboardTerminalReloadScheduledByBatch = Object\.create\(null\);/);
  assert.match(src, /var _storyboardTerminalSnapshotHandledByBatch = Object\.create\(null\);/);
  assert.match(src, /var _storyboardTailAutoStartedBySourceBatch = Object\.create\(null\);/);
  assert.match(src, /function _storyboardBatchKey\(projectId, batchId\)/);
  assert.match(src, /function _shouldSkipStoryboardRunningReattach\(projectId, batchId, b\)/);
});

record('terminal statuses do not stay in the running guard and handled terminals are skipped', () => {
  const block = section('function _isStoryboardBatchTerminalStatus(status)', 'function _clearStoryboardReattachRunning');
  for (const status of ['completed', 'done', 'partial', 'failed', 'cancelled', 'canceled']) {
    assert(block.includes(`status === '${status}'`), `missing terminal status ${status}`);
  }
  const guard = section('function _shouldSkipStoryboardRunningReattach', 'function _scheduleStoryboardTerminalProjectReload');
  assert(guard.includes('_clearStoryboardReattachRunning(projectId, batchId);'));
  assert(guard.includes('_storyboardTerminalReloadedByBatch[key]'));
  assert(guard.includes('_storyboardTerminalReloadScheduledByBatch[key]'));
  assert(guard.includes('_storyboardTerminalSnapshotHandledByBatch[key]'));
  assert(guard.includes('return false;'));
});

record('reattach dispatcher skips tracked running batches before branch handlers', () => {
  const block = section('export async function reattachStoryboardBatches()', 'function _reattachImagesBatch');
  assert(block.includes('var originId = project.id;'));
  const guardIdx = block.indexOf('_shouldSkipStoryboardRunningReattach(originId, batchId, b)');
  assert(guardIdx > -1, 'dispatcher must call the running guard');
  for (const call of ['_reattachImagesBatch(b)', '_reattachTailFrameBatch(b)', '_reattachPromptsBatch(b)']) {
    const idx = block.indexOf(call);
    assert(idx > -1, `missing ${call}`);
    assert(guardIdx < idx, `guard must run before ${call}`);
  }
});

record('running guard is cleared by all reattach subscription exits', () => {
  const reattachBlock = section('function _reattachImagesBatch', 'function _snapshotTaskTarget');
  const clearCalls = reattachBlock.match(/_clearStoryboardReattachRunning\(originId, batchId\);/g) || [];
  assert(clearCalls.length >= 6, 'images, tail, and prompts should each clear on terminal and close');
});

record('prompts failed/cancelled terminal snapshots do not subscribe repeatedly', () => {
  const block = section('function _reattachPromptsBatch', 'function _snapshotTaskTarget');
  const terminalIdx = block.indexOf('var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));');
  const subscribeIdx = block.indexOf('subscribeBatch(batchId');
  assert(terminalIdx > -1, 'prompts reattach must use shared terminal status helper');
  assert(block.includes('_markStoryboardTerminalSnapshotHandled(originId, batchId);'));
  assert(subscribeIdx > -1, 'prompts reattach still subscribes for running batches');
  assert(terminalIdx < subscribeIdx, 'terminal check must run before prompt subscribeBatch');
});

record('automatic tail-frame continuation is guarded once per source storyboard batch', () => {
  const helper = section('async function _maybeAutoStartTailFramesFromCurrentProject', 'function _runStoryboardBatchReconcile');
  const guardIdx = helper.indexOf('if (_storyboardTailAutoStartedBySourceBatch[key]) return false;');
  const markIdx = helper.indexOf('_storyboardTailAutoStartedBySourceBatch[key] = true;');
  const targetIdx = helper.indexOf('var targets = _tailKeyframeTargets(getStoryboardGroups(), {');
  assert(guardIdx > -1, 'helper must skip already handled source batches');
  assert(markIdx > guardIdx, 'helper must mark after checking the source batch guard');
  assert(targetIdx > markIdx, 'helper must mark before computing targets so empty targets are not retried forever');
});

record('tail-frame running state participates in the shared image button state', () => {
  assert.match(src, /var _tailFramesGenerating = false;/);
  assert.match(src, /function _setTailFramesGenerating\(active\)/);
  const state = section('function _computeImagesBatchState', 'function _allFirstFramesReady');
  assert(state.includes('_imagesGenerating || _imagesStarting || _tailFramesGenerating'));
  const tail = section('function _reattachTailFrameBatch', 'function _reattachPromptsBatch');
  assert(tail.includes('_setTailFramesGenerating(true);'));
  assert(tail.includes('_setTailFramesGenerating(false);'));
});

if (failed.length) {
  console.error(`\n${failed.length} storyboard reattach dedupe contract checks failed.`);
  process.exit(1);
}

console.log(`\nstoryboard reattach dedupe contract ok (${passed.length} checks)`);
