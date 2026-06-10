#!/usr/bin/env node
/**
 * Source contract: 尾帧逐镜头自动续链 (方案: 尾帧逐镜头自动续链-方案.md, 2026-06-10)。
 *
 * 不变量 (§2): solo && (建议|已请求) && 首帧 ready 且非手动上传 && 尾帧缺图
 *             && 未失败过 && 未显式删除 && 无在途 → 自动开该镜头的尾帧。
 *
 * 锁定的行为:
 *   1. 事件层四入口: live _applyTaskCompleted / reattach _applyReattachedImageTask /
 *      5s poll(经 _applyTaskCompleted 收口) / 单卡 generateStoryboardSheet._applyResult；
 *   2. 兜底层: reconcile sweep 在 /api/batch/active 查询之前 (不受 30 分钟窗口限制)，
 *      首帧批次 finish 终态后也补扫一次；
 *   3. 资格判定排除: 手动上传首帧(不自动花积分)、已失败尾帧(防审核类无限自动重试)、
 *      已有尾帧(不自动判定"需更新")、显式删除(intent='none', 复用 wanted 一票否决)；
 *   4. "重新生成全部"期间停用续链, 终态统一 includeReady 重做 (防双扣费)；
 *   5. 三处启动中止不再完全静默: 登记 blocked 退出自动链 + 续链来源画卡片被动提示；
 *   6. 进度口径: total 不再预计数, flush 时动态加 (方案 §5)；
 *   7. 旧批末 one-shot 机制必须删干净 (双路径会互相打架)。
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

record('chain engine state and entry points exist', () => {
  assert.match(src, /var TAIL_CHAIN_FLUSH_DELAY_MS = 3000;/);
  assert.match(src, /var _tailChainPendingByProject = Object\.create\(null\);/);
  assert.match(src, /var _tailChainStartedByProject = Object\.create\(null\);/);
  assert.match(src, /var _tailChainBlockedByProject = Object\.create\(null\);/);
  assert.match(src, /function _tailChainEligible\(gIdx, groups\)/);
  assert.match(src, /function _scheduleTailChain\(projectId, gIdx, reason\)/);
  assert.match(src, /function _scheduleTailChainSweep\(reason\)/);
  assert.match(src, /async function _flushTailChain\(reason\)/);
});

record('event layer: live batch / reattach replay / single-card completions all schedule the chain', () => {
  // live (SSE+poll 都收口到 _applyTaskCompleted)
  const live = section('  function _applyTaskCompleted(groupIdx, rawUrl, extra, serverVersion) {', '  function _applyTaskFailed(');
  assert(live.includes("if (!isTail) _scheduleTailChain(originId, groupIdx, 'live-first-done');"),
    'live first-frame completion must schedule per-shot chain');
  // reattach 重放
  const reattach = section('function _applyReattachedImageTask(t)', 'tasks.forEach(_applyReattachedImageTask);');
  assert(reattach.includes("_scheduleTailChain(originId, gIdx, 'reattach-first-done');"),
    'reattached first-frame completion must schedule per-shot chain');
  // 单卡
  const single = section('    function _applyResult(rawUrl, extra, serverVersion) {', '    async function _pollOnce() {');
  assert(single.includes("if (!isTail) _scheduleTailChain(originId, gIdx, 'single-first-done');"),
    'single-card first-frame completion must schedule per-shot chain');
});

record('event layer passes explicit projectId so late events from a switched-away project are not misfiled', () => {
  const sched = section('function _scheduleTailChain(projectId, gIdx, reason)', 'function _scheduleTailChainSweep');
  assert(sched.includes('if (!projectId || _tailChainSuppressedForRun) return;'));
  assert(sched.includes('if (!project || project.id !== projectId) return;'),
    'flush timer must only arm for the current project; other projects wait for their sweep');
});

record('sweep layer: reconcile sweeps before the active-batch query, finish sweeps after terminal', () => {
  const dispatcher = section('export async function reattachStoryboardBatches()', 'function _reattachImagesBatch');
  const sweepIdx = dispatcher.indexOf("_scheduleTailChainSweep('reconcile');");
  const activeIdx = dispatcher.indexOf('getActiveBatchesShared(originId)');
  assert(sweepIdx > -1 && activeIdx > sweepIdx,
    'sweep must not depend on /api/batch/active (30-minute window) nor its empty-result early return');
  assert(src.includes("_scheduleTailChainSweep('images-finish');"), 'generateAllImages finish must sweep');
  assert(src.includes("_scheduleTailChainSweep('images-terminal-snapshot');"));
  assert(src.includes("_scheduleTailChainSweep('images-sse-completed');"));
});

record('eligibility enforces the §2 invariant exclusions', () => {
  const eligible = section('function _tailChainEligible(gIdx, groups)', '/** 事件层入口');
  assert(eligible.includes('if (!_isTailKeyframeWanted(group, sb)) return false;'),
    'merged/low-score/deleted/not-wanted must be excluded via the shared wanted check');
  assert(eligible.includes('if (!_firstFrameUrl(sb) || _isFirstFrameFailed(sb)) return false;'),
    'first frame must be ready');
  assert(eligible.includes("if (firstSource === 'uploaded') return false;"),
    'manually uploaded first frames must not auto-spend credits on tails');
  assert(eligible.includes('if (_tailFrameImageUrl(sb)) return false;'),
    'existing tails are never auto-regenerated');
  assert(eligible.includes("if (_tailFrameStatusForBatch(sb) === 'failed') return false;"),
    'failed tails leave the auto chain (manual retry only, prevents moderation-block credit burn)');
});

record('deleted-tail promise is kept: wanted check still gates on explicit delete', () => {
  // 与 test-tail-frame-delete-no-resurrect.js 的约定共享同一气门
  const wanted = section('function _isTailKeyframeWanted(group, sb)', '\n}');
  assert(wanted.includes('_isTailFrameExplicitlyDeleted(sb)'),
    '_isTailKeyframeWanted must keep the explicit-delete gate the chain relies on');
});

record('regenerate-all suppresses the per-shot chain and restores it after the explicit redo pass', () => {
  assert.match(src, /var _tailChainSuppressedForRun = false;/);
  assert(src.includes("_tailChainSuppressedForRun = tailKeyframeMode === 'all';"),
    'suppression must arm exactly for the regenerate_all run');
  const finish = section('    var explicitRedoAllTails = tailKeyframeMode === \'all\';', '_checkAndSuggest("images");');
  const redoIdx = finish.indexOf('_tailKeyframeTargets(getStoryboardGroups(), { includeReady: true })');
  const restoreIdx = finish.indexOf('_tailChainSuppressedForRun = false;');
  assert(redoIdx > -1, 'explicit redo-all pass must regenerate ready tails (existing button semantics)');
  assert(restoreIdx > redoIdx, 'suppression must be lifted after the redo pass');
  const sweep = section('function _scheduleTailChainSweep(reason)', 'async function _tailChainInflightGroupIdxs');
  assert(sweep.includes('_tailChainSuppressedForRun) return;'), 'sweep must respect suppression');
});

record('silent aborts now register blocked groups (with card note for chain runs)', () => {
  const gen = section('export async function generateAllTailFrames(opts)', '  var startResp;');
  const blockCalls = gen.match(/_markTailChainBlocked\(originId, targets,/g) || [];
  assert(blockCalls.length >= 2, 'material-limit and prompt-flush aborts must both register blocked groups');
  assert(gen.includes("opts.chainSource === 'tail-chain'"), 'card note only for chain-sourced runs');
  const marker = section('function _markTailChainBlocked(projectId, targets, message)', 'async function _flushTailChain');
  assert(marker.includes("renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: '未自动生成: ' + message });"));
});

record('progress total is dynamic: no upfront planned-tail count, flush adds its target count', () => {
  assert(!src.includes('totalCount + plannedTailKeyframeCount'),
    'keyframe progress must not pre-count planned tails anymore');
  const flush = section('async function _flushTailChain', 'function _runStoryboardBatchReconcile');
  assert(flush.includes('_activeKeyframeProgressState.total = Number(_activeKeyframeProgressState.total || 0) + targets.length;'));
  assert(src.includes('_activeKeyframeProgressState = keyframeProgressState;'),
    'generateAllImages must share its progress state with the chain');
});

record('old batch-end one-shot mechanism is fully removed', () => {
  assert(!src.includes('async function _maybeAutoStartTailFramesFromCurrentProject'),
    'old helper must be gone (only the replacement comment may mention it)');
  assert(!src.includes('var _storyboardTailAutoStartedBySourceBatch'),
    'one-shot flag map must be gone');
  assert(!src.includes('requireTerminalReload'), 'reload-gated one-shot wiring must be gone');
  assert(!src.includes('var runTailKeyframesAfterFirst'), 'batch-end planning flag must be gone');
});

if (failed.length) {
  console.error(`\n${failed.length} tail chain contract checks failed.`);
  process.exit(1);
}

console.log(`\ntail chain contract ok (${passed.length} checks)`);
