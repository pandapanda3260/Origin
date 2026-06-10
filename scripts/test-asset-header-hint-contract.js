#!/usr/bin/env node
/**
 * Source contract: asset-page title hints use one shared slot, project-scoped
 * active batch state, and separated backend/SSE progress accounting.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');
const styles = fs.readFileSync(path.join(REPO_ROOT, 'public/styles.css'), 'utf8');
const assets = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/assets.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

assert(workspace.includes('class="workflow-title-hint asset-title-hint" id="assetImgHint"'), 'asset progress hint should use the shared title hint class');
assert(!workspace.includes('assetStylizeBadge'), 'stylize badge DOM must stay removed (asset_stylize layer deleted)');
assert(/"\/modules\/assets\.js":\s+"\/modules\/assets\.js\?v=\d+"/.test(workspace), 'workspace import map should carry an assets.js cache version');
assert(/\.\/modules\/assets\.js\?v=\d+/.test(main), 'main import should carry an assets.js cache version');

assert(styles.includes('.workflow-title-hint'), 'shared title hint class should be styled');
// 拍板：标题提示统一灰色，仅保留 is-error 红色异常态。
// is-progress/is-warning/is-success 的 tone class 仍由 JS 维护（驱动摘要
// 优先级语义），但不得再有配色规则——防止完成绿/缺失黄回归。
assert(styles.includes('.workflow-title-hint.is-error'), 'error tone should stay class-based (red)');
assert(!styles.includes('.workflow-title-hint.is-progress'), 'progress tone must not be colored (gray by base class)');
assert(!styles.includes('.workflow-title-hint.is-warning'), 'warning tone must not be colored (no amber summary)');
assert(!styles.includes('.workflow-title-hint.is-success'), 'success tone must not be colored (no green summary)');
assert(!styles.includes('.shots-keyframe-progress'), 'shots page green progress styling stays deleted — all title hints share the gray base');

assert(assets.includes('var _assetImageBatchCountsByProject = new Map();'), 'asset active batch state should be project-scoped');
assert(assets.includes('function _beginAssetImageBatch(originId)'), 'asset batch attach should increment project-scoped active state');
assert(assets.includes('function _endAssetImageBatch(originId)'), 'asset batch finish should decrement project-scoped active state');
assert(assets.includes('function _hasActiveAssetImageBatchForCurrentProject()'), 'current project active state should drive hint priority');
assert(assets.includes('_beginAssetImageBatch(originId);'), 'main and reattached asset batches should enter active state at attach');
assert(assets.includes('_endAssetImageBatch(originId);'), 'main and reattached asset batches should leave active state at finish');

const hintHelpers = section(assets, 'function _setAssetHeaderHint(text, tone)', 'function _assetVariant');
assert(hintHelpers.includes('hint.classList.remove("is-progress", "is-warning", "is-error", "is-success")'), 'asset hint helper should clear old tones');
assert(hintHelpers.includes('if (_hasActiveAssetImageBatchForCurrentProject()) return;'), 'active generation should suppress static summary hints');
assert(!assets.includes('hint.style.color'), 'asset hints should not use inline colors');

// 所有 assetImgHint 文本写入必须经过 _setAssetHeaderHint（清 tone class），
// 防止 is-error 红色残留到后续普通文案。唯一允许的 textContent 赋值在 helper 内部。
const directHintWrites = assets.match(/hint\.textContent\s*=/g) || [];
assert.equal(directHintWrites.length, 1, 'only _setAssetHeaderHint may write assetImgHint textContent directly, found ' + directHintWrites.length);

// 静态三态摘要：随时可从 project.assets 重算，刷新/切项目后不丢。
// 优先级：活跃批进度 > 部分缺失(warning) > 生成完成 N/N > 待生成… 0/N > 空。
assert(hintHelpers.includes('function _assetHeaderImageState()'), 'asset image tri-state should be statically computable');
const syncFn = section(assets, 'function _syncAssetHeaderHint(options)', 'function _assetVariant');
const partialMissingAt = syncFn.indexOf('张已生成，缺少 ');
const completedAt = syncFn.indexOf('"生成完成 " + img.done');
const pendingAt = syncFn.indexOf('"待生成… 0/" + img.total');
assert(partialMissingAt !== -1 && completedAt !== -1 && pendingAt !== -1, 'sync should handle all tri-state branches');
assert(partialMissingAt < completedAt && completedAt < pendingAt, 'summary priority should stay partial-missing > completed > pending');
const summarizeFn = section(assets, 'function _summarizeAssetImageGeneration(hint, options)', 'async function _runAssetImageTargets');
assert(summarizeFn.includes('if (hint) _syncAssetHeaderHint();'), 'batch summary should settle through the shared sync helper');

// asset_stylize（风格图转绘）层已整体摘除：不允许任何残留触发点回归。
assert(!assets.includes('asset_stylize'), 'asset_stylize batch type must stay removed from assets.js');
assert(!assets.includes('_updateStylizeBadge'), 'stylize badge updater must stay removed');
assert(!assets.includes('_runStylizeBatch'), 'stylize batch runner must stay removed');
assert(!assets.includes('_retryPencilConversion'), 'pencil retry entry must stay removed');
assert(!assets.includes('风格图'), 'no user-facing stylize copy should remain in assets.js');

const attach = section(assets, 'function _attachAssetImageBatch', '/**\n * Phase 3-B-7 · 刷新后重连活跃 batch。');
assert(attach.includes('var snapshotDoneCount = initialDoneCount;'), 'asset batch should track snapshot done count separately');
assert(attach.includes('var seenDoneSeqs = Object.create(null);'), 'asset batch should track SSE done keys separately');
assert(attach.includes('var rejectedSeqs = Object.create(null);'), 'asset batch should track panel rejected keys separately');
assert(attach.includes('function _assetBatchProgressCounts()'), 'asset batch should centralize merged progress counts');
assert(attach.includes('Math.max(initialDoneCount + seenDoneCount, snapshotDoneCount)'), 'asset batch done count should take max of event and snapshot ledgers');
assert(attach.includes('Math.max(initialFailedCount + seenFailedCount, snapshotFailedCount)'), 'asset batch failed count should take max of event and snapshot ledgers');
assert(attach.includes('failureLabel: failed + rejectedCount'), 'panel rejections should affect the failure label without double-counting backend success');
assert(attach.includes('_markAssetBatchDone(eventKey);'), 'task_completed should mark SSE done keys');
assert(attach.includes('_markAssetBatchRejected(eventKey);'), 'panel rejected task_completed should mark a separate rejected label count');
assert(attach.includes('_markAssetBatchFailed(_assetBatchEventKey(data, tgt));'), 'task_failed should mark SSE failed keys');
assert(attach.includes('snapshotDoneCount = Math.max(snapshotDoneCount, snap.succeeded)'), 'SSE snapshot should update snapshot done count');
assert(attach.includes('snapshotFailedCount = Math.max(snapshotFailedCount, snap.failed)'), 'SSE snapshot should update snapshot failed count');
assert(attach.includes('function _clampAssetEta(fresh)'), 'asset ETA needs a monotonic clamp');
assert(attach.includes('_clampAssetEta(Math.ceil(pending * avgSec / 3))'), 'asset hint ETA must pass through the monotonic clamp');

console.log('asset header hint contract ok');
