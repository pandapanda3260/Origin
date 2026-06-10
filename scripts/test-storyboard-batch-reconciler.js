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
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');

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

record('live storyboard completion feeds the per-shot tail chain, regenerate-all keeps explicit redo pass', () => {
  // 2026-06-10 逐镜头续链 (方案: 尾帧逐镜头自动续链-方案.md): live 批次里每张首帧
  // 完成即入链, 不等批末; finish 只兜底扫描。"重新生成全部"保留显式 includeReady
  // 重做语义, 期间续链被 suppress 防双扣费。
  const apply = section(storyboard, '  function _applyTaskCompleted(groupIdx, rawUrl, extra, serverVersion) {', '  function _applyTaskFailed(');
  assert(apply.includes("if (!isTail) _scheduleTailChain(originId, groupIdx, 'live-first-done');"));
  const block = section(storyboard, "    var explicitRedoAllTails = tailKeyframeMode === 'all';", '// 已经在本地标记完成的 groupIdx');
  assert(block.includes('_tailKeyframeTargets(getStoryboardGroups(), { includeReady: true })'));
  assert(block.includes('_tailChainSuppressedForRun = false;'));
  assert(block.includes('var remainingTailTargets = _tailKeyframeTargets(finalGroups);'));
  assert(block.includes("_scheduleTailChainSweep('images-finish');"));
  assert(!block.includes('_maybeAutoStartTailFramesFromCurrentProject'));
});

record('main storyboard import version stays aligned with workspace importmap', () => {
  const mainMatch = main.match(/from '\.\/modules\/storyboard\.js\?v=(\d+)'/);
  assert(mainMatch, 'main.js must import storyboard.js with an explicit cache version');
  const importMapMatch = workspace.match(/"\/modules\/storyboard\.js":\s*"\/modules\/storyboard\.js\?v=(\d+)"/);
  assert(importMapMatch, 'workspace importmap must pin storyboard.js with an explicit cache version');
  assert.equal(mainMatch[1], importMapMatch[1], 'main.js storyboard version must match workspace importmap');
});

record('main init imports and registers the reconciler after initial reattach', () => {
  assert(main.includes('registerStoryboardBatchReconciler'));
  // 起始锚点用 init 块特有的 reattachVideoPromptBatches("init")：
  // 'try { reattachStoryboardBatches(); }' 在 GlobalReconcile 块(focus/visibility
  // 对账)里也出现，indexOf 会命中前者导致切错段。
  const initBlock = section(main, 'reattachVideoPromptBatches("init")', '// Phase 3-B-10');
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
