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

record('storyboard_images terminal reload gates automatic tail-frame continuation', () => {
  const block = section('function _reattachImagesBatch', 'function _reattachTailFrameBatch');
  assert(block.includes('var terminalReloadKey = _storyboardBatchKey(originId, batchId);'));
  assert(block.includes('if (_storyboardTerminalReloadedByBatch[terminalReloadKey])'));
  assert(block.includes('_maybeAutoStartTailFramesFromCurrentProject(originId, batchId, {'));
  assert(block.includes('requireTerminalReload: true'));
});

record('automatic tail-frame helper reuses current project filters and existing generator', () => {
  const helper = section('async function _maybeAutoStartTailFramesFromCurrentProject', 'function _runStoryboardBatchReconcile');
  assert(helper.includes('if (_storyboardTailAutoStartedBySourceBatch[key]) return false;'));
  assert(helper.includes('if (opts.requireTerminalReload && !_storyboardTerminalReloadedByBatch[key]) return false;'));
  assert(helper.includes('_storyboardTailAutoStartedBySourceBatch[key] = true;'));
  assert(helper.includes('var targets = _tailKeyframeTargets(getStoryboardGroups(), {'));
  assert(helper.includes('await generateAllTailFrames({'));
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
