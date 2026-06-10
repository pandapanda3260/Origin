#!/usr/bin/env node
/**
 * Source contract: keyframe batch progress is rendered under the shots page title,
 * not only in the legacy storyboard diagnostic area.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');
const styles = fs.readFileSync(path.join(REPO_ROOT, 'public/styles.css'), 'utf8');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

assert(workspace.includes('id="shotsKeyframeProgress" class="workflow-title-hint"'), 'keyframe progress line should use only the shared gray title hint class');
assert(styles.includes('.workflow-title-hint'), 'title hint base class should be styled');
// 拍板：镜头页绿色加粗的页面级配色已删除，统一灰色基类；进度行移出
// header（避免把标题顶离其他页的基线），由 #shotsKeyframeProgress 负 margin 定位。
assert(!styles.includes('.shots-keyframe-progress'), 'green page-level progress styling must not come back');
assert(styles.includes('#shotsKeyframeProgress'), 'keyframe progress line should keep its layout anchor below the header');
const headerBlock = section(workspace, '<header class="shots-dashboard-header">', 'id="shotsNeedScript"');
assert(headerBlock.indexOf('id="shotsKeyframeProgress"') > headerBlock.indexOf('</header>'), 'keyframe progress line should live outside the shots header flexbox');

assert(storyboard.includes('function _formatKeyframeProgress'), 'storyboard module should format keyframe progress centrally');
assert(storyboard.includes('function _showKeyframeHeaderProgress'), 'storyboard module should show keyframe progress in the header');
assert(storyboard.includes('function _hideKeyframeHeaderProgress'), 'storyboard module should hide keyframe progress on terminal states');
assert(storyboard.includes('pending * avg / _keyframeProgressConcurrency()'), 'ETA should use the configured image concurrency helper');
assert(storyboard.includes('"生成中… " + visibleDone'), 'keyframe progress should use the unified single-ellipsis wording');
assert(!storyboard.includes('生成中……'), 'legacy double-ellipsis wording should not come back');

// ETA 只降不升：动态均值在两次完成之间会上漂，显示层必须做单调钳制。
assert(storyboard.includes('function _clampKeyframeEta(fresh, total, startTs)'), 'keyframe ETA needs a monotonic clamp');
assert(storyboard.includes('_clampKeyframeEta(_keyframeRemainingSeconds(done, fail, total, startTs)'), 'formatted ETA must pass through the monotonic clamp');

// 静态三态摘要：批次不活跃时按首帧口径显示 生成完成 N/N / 缺失明细 / 待生成。
const staticSync = section(storyboard, 'function _syncShotsKeyframeHeaderHint()', 'function _ffeInitialAutoSaveState');
assert(staticSync.includes('if (_imagesGenerating || _imagesStarting || _tailFramesGenerating) return;'), 'static summary must not preempt active batch progress');
assert(staticSync.includes('"生成完成 " + done'), 'all-ready storyboards should show 生成完成 N/N');
assert(staticSync.includes('"待生成… 0/" + groups.length'), 'never-generated storyboards should show 待生成… 0/N');
assert(staticSync.includes('张已生成，缺少镜头 '), 'partially generated storyboards should list missing shots');
const confirmFn = section(storyboard, 'export function checkImagesConfirm()', 'Phase 3-B-8');
assert(confirmFn.includes('_syncShotsKeyframeHeaderHint();'), 'page render and batch terminals should restore the static summary via checkImagesConfirm');

// 防双订阅闪烁：主流程启动的批必须立即登记为"本地已订阅"，否则周期性
// reconcile 会对同一个 running 批再挂 reattach——两个 1s tick 用跨批/单批
// 两种口径交替写标题行（"7/18" vs "0/10" 半秒闪烁）。
assert(storyboard.includes('function _markStoryboardBatchLocallyAttached(projectId, batchId)'), 'locally started batches need an attach registry helper');
const attachMarks = storyboard.match(/_markStoryboardBatchLocallyAttached\(originId, startResp\.batchId\)/g) || [];
assert(attachMarks.length >= 4, 'all four batch-start paths (bulk/single x first/tail) must register locally-attached, found ' + attachMarks.length);

const reattachFirst = section(storyboard, 'function _reattachImagesBatch', 'function _reattachTailFrameBatch');
assert(reattachFirst.includes('_showKeyframeHeaderProgress(rDoneCount, rTotal, rFailCount, rStartTs)'), 'first-frame reattach should restore header progress');
assert(reattachFirst.includes('_hideKeyframeHeaderProgress();'), 'first-frame terminal reattach should hide header progress');
assert(reattachFirst.includes('function _applyReattachedImageTask(t)'), 'first-frame reattach should replay snapshot tasks through a deduped task handler');
assert(reattachFirst.includes('_markRDone(groupIdx)'), 'first-frame reattach should dedupe completed groupIdx before counting');
assert(reattachFirst.includes('s.tasks'), 'first-frame reattach snapshot should inspect tasks, not only absolute counters');

const reattachTail = section(storyboard, 'function _reattachTailFrameBatch', 'function _reattachPromptsBatch');
assert(reattachTail.includes('_showKeyframeHeaderProgress(tailDoneCount, tailTotal, tailFailCount, tailStartTs)'), 'tail-frame reattach should restore header progress');
assert(reattachTail.includes('_clearTailEtaR();'), 'tail-frame terminal reattach should clear header progress');
assert(reattachTail.includes('function _applyReattachedTailTask(t)'), 'tail-frame reattach should replay snapshot tasks through a deduped task handler');
assert(reattachTail.includes('_markTailRDone(gIdx2)'), 'tail-frame reattach should dedupe completed groupIdx before counting');
assert(reattachTail.includes('s.tasks'), 'tail-frame reattach snapshot should inspect tasks, not only absolute counters');

const allTail = section(storyboard, 'export async function generateAllTailFrames', 'export async function generateAllImages');
assert(allTail.includes('_showKeyframeHeaderProgress(tailProgress.done, tailProgress.total, tailProgress.fail, tailProgress.startTs)'), 'tail-frame batch generation should update header progress');
assert(allTail.includes('opts.progressState'), 'tail-frame batch generation should accept shared keyframe progress state');
assert(allTail.includes('_hideKeyframeHeaderProgress();'), 'tail-frame batch generation should hide header progress when finished');
assert(allTail.includes('function _applyTailBatchSnapshotTask(t)'), 'tail-frame snapshot should replay tasks through the existing completedIdx dedupe path');
assert(allTail.includes('tasks.forEach(_applyTailBatchSnapshotTask)'), 'tail-frame snapshot and poll should share task handling');
assert(allTail.includes('_markStoryboardBatchLocallyAttached(originId, startResp.batchId)'), 'generateAllTailFrames must register its batch against reconcile re-attach');

const allFirst = section(storyboard, 'export async function generateAllImages', 'export async function confirmImages');
// 2026-06-10 逐镜头续链 (方案 §5): 尾帧不再预计数进 total, 改为排程器 flush 时动态加。
assert(!allFirst.includes('totalCount + plannedTailKeyframeCount'), 'first-frame batch generation must not pre-count planned tail keyframes anymore');
assert(allFirst.includes('_activeKeyframeProgressState = keyframeProgressState;'), 'first-frame batch generation should share progress state with the tail chain scheduler');
assert(allFirst.includes('progressState: keyframeProgressState'), 'first-frame batch generation should pass shared progress into the tail batch');
assert(allFirst.includes('_showKeyframeHeaderProgress('), 'first-frame batch generation should update header progress');
assert(allFirst.includes('_hideKeyframeHeaderProgress();'), 'first-frame batch generation should hide header progress when finished');
assert(allFirst.includes('function _applyStoryboardBatchSnapshotTask(t)'), 'first-frame snapshot should replay tasks through existing seen-set handlers');
assert(allFirst.includes('tasks.forEach(_applyStoryboardBatchSnapshotTask)'), 'first-frame snapshot and poll should share task handling');
assert(allFirst.includes('_markStoryboardBatchLocallyAttached(originId, startResp.batchId)'), 'generateAllImages must register its batch against reconcile re-attach');
assert(allFirst.includes('Math.min(snap.total, doneCount + failCount)'), 'first-frame snapshot should not overwrite cross-batch header progress with single-batch succeeded');

assert(/\.\/modules\/storyboard\.js\?v=\d+/.test(main), 'main import should carry a storyboard.js cache version');
assert(/"\/modules\/storyboard\.js":\s+"\/modules\/storyboard\.js\?v=\d+"/.test(workspace), 'workspace import map should carry a storyboard.js cache version');
assert(/src="main\.js\?v=\d+"/.test(workspace), 'workspace should carry a main.js cache version');
assert(/styles\.css\?v=\d+/.test(workspace), 'workspace should carry a styles.css cache version');

console.log('keyframe header progress contract ok');
