#!/usr/bin/env node
/**
 * Source contract: storyboard batch reconciliation should be registered once
 * from app init and should reuse /api/batch/active via reattachStoryboardBatches.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

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

record('reconciler has explicit throttle and interval constants', () => {
  assert.match(storyboard, /var STORYBOARD_REATTACH_RECONCILE_THROTTLE_MS = 30000;/);
  assert.match(storyboard, /var STORYBOARD_REATTACH_RECONCILE_INTERVAL_MS = 60000;/);
  assert.match(storyboard, /var STORYBOARD_REATTACH_RECENT_ACTIVITY_MS = 30 \* 60 \* 1000;/);
});

record('reconciler is idempotent and does not capture a project snapshot', () => {
  const block = section(storyboard, 'export function registerStoryboardBatchReconciler()', '/**');
  assert(block.includes('if (_storyboardBatchReconcilerRegistered) return;'));
  assert(block.includes('_storyboardBatchReconcilerRegistered = true;'));
  assert(!block.includes('var originId = project.id'));
});

record('focus, visibility, and light interval trigger the shared reattach path', () => {
  const runner = section(storyboard, 'function _runStoryboardBatchReconcile', 'export function registerStoryboardBatchReconciler');
  assert(runner.includes('reattachStoryboardBatches()'));
  assert(runner.includes("reason === 'interval'"));
  assert(runner.includes('!_isDocumentVisibleForStoryboardReconcile()'));
  assert(runner.includes('!_hasRecentStoryboardBatchActivity()'));
  assert(!runner.includes('/api/projects'));
  const block = section(storyboard, 'export function registerStoryboardBatchReconciler()', '/**');
  assert(block.includes("window.addEventListener('focus'"));
  assert(block.includes("document.addEventListener('visibilitychange'"));
  assert(block.includes("document.visibilityState === 'visible'"));
  assert(block.includes('window.setInterval(function ()'));
  assert(block.includes('STORYBOARD_REATTACH_RECONCILE_INTERVAL_MS'));
});

record('recent batch activity is learned from /api/batch/active results', () => {
  const block = section(storyboard, 'export async function reattachStoryboardBatches()', 'function _reattachImagesBatch');
  assert(block.includes('if (!batches.length) return;'));
  assert(block.includes('_markStoryboardBatchActivity();'));
});

record('main init imports and registers the reconciler after initial reattach', () => {
  assert(main.includes('registerStoryboardBatchReconciler'));
  const initBlock = section(main, 'try { reattachStoryboardBatches(); }', '// Phase 3-B-10');
  const reattachIdx = initBlock.indexOf('reattachStoryboardBatches()');
  const registerIdx = initBlock.indexOf('registerStoryboardBatchReconciler()');
  assert(reattachIdx > -1, 'missing initial reattach');
  assert(registerIdx > -1, 'missing reconciler registration');
  assert(reattachIdx < registerIdx, 'register after initial reattach');
});

if (failed.length) {
  console.error(`\n${failed.length} storyboard batch reconciler contract checks failed.`);
  process.exit(1);
}

console.log(`\nstoryboard batch reconciler contract ok (${passed.length} checks)`);
