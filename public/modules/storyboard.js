import { $, escapeHtml, showToast, apiPost, apiPostStream, apiGet, getAuthHeaders, getActiveBatchesShared,
  consumeStreamStepTags, ApiError, hydrateProtectedImageElements } from './utils.js?v=300';
import {
  materialPanelCandidateTilesForRole,
  materialPanelOrderedTiles,
  materialPanelReferenceAddDisabled,
  materialPanelReferenceCapMessage,
  materialPanelRoleIcon,
  materialPanelRoleLabel,
  materialPanelSelectedTileIdSet,
  materialPanelTileIds,
  fetchMaterialPanels,
  getMaterialPanel,
  materialPanelState,
  materialPanelNeedsPostInteractionRefresh,
  renderMaterialImagePanelHtml,
  renderMaterialImageWithFallbackHtml,
  renderMaterialPickerHtml,
  setMaterialPanelActivePicker,
  setMaterialPanelActiveRolePicker,
  setMaterialPanelProject,
  setMaterialPanelUploading,
  shouldRefreshMaterialPanel,
  setMaterialPanel,
} from './material_image_panel.js?v=104';
import { attachDiagnostic } from './diagnostic.js?v=300';
import { renderStoryboardCard, renderStoryboardFrameCard } from './render_hooks.js?v=300';
import { subscribeBatch } from './backend_stream.js?v=300';
import { showBillingPaywall } from './billing.js?v=114';
import {
  canGenerateTailFrame as _canGenerateTailFrame,
  firstFrameImageUrl as _firstFrameImageUrl,
  frameCollapseKeyForGroup as _frameCollapseKeyForGroup,
  frameRecommendationForGroup as _frameRecommendationForGroup,
  isTailRequested as _isTailRequested,
  segmentInfoForShot as _segmentInfoForShot,
  tailFrameImageUrl as _tailFrameImageUrl,
  tailFrameGenerationIntentForGroup as _tailFrameGenerationIntentForGroup,
  tailFrameSuggestionForGroup as _tailFrameSuggestionForGroup,
} from './frameRecommendations.js?v=1';

let _ctx = {};
let project = null;

var _imagesGenerating = false;
var _imagesStarting = false;
var _tailFramesGenerating = false;
var _promptsConverting = false;
var IMG_PARALLEL = 3;
var MAX_SHOTS_PER_GROUP = 5;
var KEYFRAME_PROGRESS_INITIAL_SEC = 70;
var _sbCurrentIdx = 0;
var _sbProgrammaticScrolling = false;
var _sbScrollSettleTimer = null;
var SB_INDEX_RAIL_ANCHOR_EPSILON = 2;
var _sbIndexRailActiveShotIdx = null;
var _sbIndexRailProgrammaticScrolling = false;
var _sbIndexRailScrollSettleTimer = null;
var _sbIndexRailSyncRaf = 0;
var _sbIndexRailViewportSyncBound = false;
var _sbIndexRailResizeObserver = null;
var _firstFramePreflightState = { key: "", status: "idle", payload: null, message: "", promise: null };
var FIRST_FRAME_DEFAULT_HINT = "基于片段镜头与资产生成关键帧，并管理可选尾帧";
var FIRST_FRAME_REWRITE_CHAT_ENABLED = false;
var FFE_AUTOSAVE_DEBOUNCE_MS = 800;
var FFE_AUTOSAVE_MAX_WAIT_MS = 4000;
var FFE_AUTOSAVE_SAVING_VISIBLE_MS = 500;
// 必须与服务端 lib/first-frame-edit-draft.ts 中
// MAX_PROMPT_OVERRIDE_CHARS / MAX_NEGATIVE_PROMPT_CHARS 保持一致。
// 用于 textarea maxlength、计数器，以及 _ffeDraftForCompare 保存前比较规范化。
var FFE_PROMPT_OVERRIDE_MAX_CHARS = 5000;
var FFE_NEGATIVE_PROMPT_MAX_CHARS = 500;

function _keyframeProgressConcurrency() {
  return Math.max(1, Number(IMG_PARALLEL) || 3);
}

function _keyframeRemainingSeconds(done, fail, total, startTs) {
  total = Math.max(0, Number(total) || 0);
  done = Math.max(0, Number(done) || 0);
  fail = Math.max(0, Number(fail) || 0);
  var pending = Math.max(0, total - done - fail);
  if (!pending) return 0;
  var completed = done + fail;
  var avg = completed >= 1 && startTs
    ? Math.max(8, (Date.now() - startTs) / 1000 / completed)
    : KEYFRAME_PROGRESS_INITIAL_SEC;
  return Math.max(1, Math.ceil(pending * avg / _keyframeProgressConcurrency()));
}

// 进度提示统一时间格式："x分x秒"（<60s 只显 "x秒"）。各模块各持一份，避免动 utils.js 引发全量 cache-bust。
function _fmtMinSec(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return m > 0 ? m + "分" + (s < 10 ? "0" + s : s) + "秒" : s + "秒";
}

// ETA 单调钳制：估算值 = 已耗时/已完成 的动态均值，两次完成之间没有新事件时
// 均值被持续拉大，"约剩 8 秒"会回升到 13、18——倒计时上涨非常怪。
// 这里记住上次显示值并按墙钟自然倒数（-1/秒），新估算只有更小（来了新完成）
// 才允许跳变；同一轮生成用 total+startTs 做签名，换批/换轮自动重置。
var _kfEtaClamp = { signature: "", remain: 0, wallTs: 0 };

function _clampKeyframeEta(fresh, total, startTs) {
  if (!(fresh > 0)) return fresh;
  var sig = String(total || 0) + ":" + String(startTs || 0);
  var now = Date.now();
  if (_kfEtaClamp.signature !== sig) {
    _kfEtaClamp = { signature: sig, remain: fresh, wallTs: now };
    return fresh;
  }
  var decayed = Math.max(1, Math.round(_kfEtaClamp.remain - (now - _kfEtaClamp.wallTs) / 1000));
  var next = Math.min(decayed, fresh);
  _kfEtaClamp.remain = next;
  _kfEtaClamp.wallTs = now;
  return next;
}

function _formatKeyframeProgress(done, total, fail, startTs) {
  total = Math.max(0, Number(total) || 0);
  done = Math.max(0, Number(done) || 0);
  fail = Math.max(0, Number(fail) || 0);
  var visibleDone = Math.min(total || done + fail, done + fail);
  var lines = ["生成中… " + visibleDone + "/" + (total || "?")];
  if (fail > 0) lines.push(fail + " 张失败");
  var remain = _clampKeyframeEta(_keyframeRemainingSeconds(done, fail, total, startTs), total, startTs);
  if (remain > 0) lines.push("约剩 " + _fmtMinSec(remain));
  return lines.join("，");
}

function _showKeyframeHeaderProgress(done, total, fail, startTs) {
  var el = $("shotsKeyframeProgress");
  if (!el) return;
  el.hidden = false;
  el.textContent = _formatKeyframeProgress(done, total, fail, startTs);
}

function _hideKeyframeHeaderProgress() {
  var el = $("shotsKeyframeProgress");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

/**
 * 镜头页标题静态三态摘要（首帧口径）：
 *   生成完成 N/N > 部分缺失 "x/N 张已生成，缺少镜头 …" > 待生成… 0/N。
 * 批次活跃时（含 reattach）进度文案归批流程管，这里不抢占。
 * 挂在 checkImagesConfirm 末尾：页面渲染与各批次终态都会经过它。
 */
function _syncShotsKeyframeHeaderHint() {
  var el = $("shotsKeyframeProgress");
  if (!el) return;
  if (_imagesGenerating || _imagesStarting || _tailFramesGenerating) return;
  var groups = (project && project.shots && project.shots.length) ? getStoryboardGroups() : [];
  if (!groups.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  var done = 0;
  var missing = [];
  for (var i = 0; i < groups.length; i++) {
    var sb = project.storyboards && project.storyboards[i];
    if (_firstFrameUrl(sb)) done++;
    else missing.push(String(i + 1));
  }
  el.hidden = false;
  if (!missing.length) {
    el.textContent = "生成完成 " + done + "/" + groups.length;
  } else if (done === 0) {
    el.textContent = "待生成… 0/" + groups.length;
  } else {
    el.textContent = done + "/" + groups.length + " 张已生成，缺少镜头 " + missing.join("、");
  }
}

function _ffeInitialAutoSaveState() {
  return {
    lastSavedDraftJson: "{}",
    pendingDraftJson: "{}",
    expectedFingerprint: "",
    dirtyAt: null,
    debounceTimer: null,
    maxWaitTimer: null,
    savingVisibleTimer: null,
    inFlightPromise: null,
    currentFlushPromise: null,
    composing: false,
    forceSaveOnce: false,
    staleWasShown: false,
    staleNoticeShown: false,
    errorMessage: "",
    conflict: false,
    touched: {
      content: false,
      negativePromptOverride: false,
    },
    fieldStatus: {
      content: "initial",
      negativePromptOverride: "initial",
    },
    fieldSaving: {
      content: false,
      negativePromptOverride: false,
    },
  };
}

function _ffeInitialEditorState(overrides) {
  return Object.assign({
    open: false,
    groupIdx: null,
    loading: false,
    payload: null,
    originalDraftJson: "",
    baselineDraftJson: "",
    savedDraftFingerprint: "",
    baselineFingerprint: "",
    saving: false,
    generating: false,
    generatingText: "",
    restoring: false,
    rewriting: false,
    generateBlock: null,
    dismissedAlerts: {},
    referenceRolePickerOpen: false,
    referenceMaterialPicker: {
      open: false,
      role: null,
      selectedId: "",
      uploading: false,
      error: "",
    },
    chat: [],
    autoSave: _ffeInitialAutoSaveState(),
  }, overrides || {});
}

var _firstFrameEditor = _ffeInitialEditorState();
var _firstFrameEditorScrollY = 0;
var _firstFrameCardPromptAutosave = {};
var _tailFrameCardPromptAutosave = {};
var _firstFrameCardPromptProjectId = '';
var _storyboardReattachRunningByBatch = Object.create(null);
var _storyboardTerminalReloadedByBatch = Object.create(null);
var _storyboardTerminalReloadPendingByBatch = Object.create(null);
var _storyboardTerminalReloadScheduledByBatch = Object.create(null);
var _storyboardTerminalSnapshotHandledByBatch = Object.create(null);
var _storyboardTailAutoStartedBySourceBatch = Object.create(null);
var _storyboardTerminalReloadInFlight = null;
var _storyboardBatchReconcilerRegistered = false;
var _storyboardLastReconcileAt = 0;
var _storyboardLastBatchActivityAt = 0;
var STORYBOARD_REATTACH_RECONCILE_THROTTLE_MS = 30000;
var STORYBOARD_REATTACH_RECONCILE_INTERVAL_MS = 60000;
var STORYBOARD_REATTACH_RECENT_ACTIVITY_MS = 30 * 60 * 1000;

function _setTailFramesGenerating(active) {
  var next = !!active;
  if (_tailFramesGenerating === next) return;
  _tailFramesGenerating = next;
  if (project && project.id) {
    try { _updateImagesActionButton(getStoryboardGroups()); } catch (_) {}
  }
}

export function initStoryboard(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncStoryboardProject(p) {
  var nextProjectId = p && p.id || '';
  if (nextProjectId !== _firstFrameCardPromptProjectId) {
    _firstFrameCardPromptAutosave = {};
    _tailFrameCardPromptAutosave = {};
    _firstFrameCardPromptProjectId = nextProjectId;
  }
  project = p || null;
  setMaterialPanelProject(project && project.id || '', project && project.updatedAt || '');
}

function _storyboardBatchKey(projectId, batchId) {
  return String(projectId || '') + ':' + String(batchId || '');
}

function _storyboardBatchStatus(b) {
  return String((b && b.status) || (b && b.snapshot && b.snapshot.status) || '').toLowerCase();
}

function _isStoryboardBatchTerminalStatus(status) {
  status = String(status || '').toLowerCase();
  return status === 'completed' || status === 'done' || status === 'partial' ||
    status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function _clearStoryboardReattachRunning(projectId, batchId) {
  if (!projectId || !batchId) return;
  delete _storyboardReattachRunningByBatch[_storyboardBatchKey(projectId, batchId)];
}

/**
 * 主流程（generateAllImages / generateAllTailFrames / 单卡重生成）启动批次后
 * 立即登记：本前端已有活订阅。否则周期性 reconcile（interval/focus）会对同一个
 * running 批再挂一个 reattach 订阅——两个 1s tick 用不同口径（跨批 vs 单批）
 * 交替写标题进度行，表现为 "7/18" 和 "0/10" 半秒闪烁。
 * 终态时 _shouldSkipStoryboardRunningReattach 的 terminal 分支会自动清掉该 key。
 */
function _markStoryboardBatchLocallyAttached(projectId, batchId) {
  if (!projectId || !batchId) return;
  _storyboardReattachRunningByBatch[_storyboardBatchKey(projectId, batchId)] = true;
}

function _markStoryboardBatchActivity() {
  _storyboardLastBatchActivityAt = Date.now();
}

function _hasRecentStoryboardBatchActivity() {
  return !!(_storyboardLastBatchActivityAt &&
    Date.now() - _storyboardLastBatchActivityAt < STORYBOARD_REATTACH_RECENT_ACTIVITY_MS);
}

function _isDocumentVisibleForStoryboardReconcile() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function _markStoryboardTerminalSnapshotHandled(projectId, batchId) {
  if (!projectId || !batchId) return;
  _storyboardTerminalSnapshotHandledByBatch[_storyboardBatchKey(projectId, batchId)] = true;
}

function _shouldSkipStoryboardRunningReattach(projectId, batchId, b) {
  if (!projectId || !batchId) return true;
  var key = _storyboardBatchKey(projectId, batchId);
  if (_isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b))) {
    _clearStoryboardReattachRunning(projectId, batchId);
    if (_storyboardTerminalReloadedByBatch[key] ||
        _storyboardTerminalReloadScheduledByBatch[key] ||
        _storyboardTerminalSnapshotHandledByBatch[key]) return true;
    return false;
  }
  if (_storyboardReattachRunningByBatch[key]) return true;
  _storyboardReattachRunningByBatch[key] = true;
  return false;
}

function _scheduleStoryboardTerminalProjectReload(projectId, batchId, opts) {
  if (!projectId || !batchId) return Promise.resolve(false);
  opts = opts || {};
  var key = _storyboardBatchKey(projectId, batchId);
  if (_storyboardTerminalReloadedByBatch[key]) return Promise.resolve(false);
  _storyboardTerminalReloadScheduledByBatch[key] = true;
  _storyboardTerminalReloadPendingByBatch[key] = {
    projectId: projectId,
    batchId: batchId,
    reason: opts.reason || '',
    confirmImages: !!opts.confirmImages,
  };
  if (_storyboardTerminalReloadInFlight) return _storyboardTerminalReloadInFlight;

  _storyboardTerminalReloadInFlight = (async function () {
    try {
      while (Object.keys(_storyboardTerminalReloadPendingByBatch).length) {
        var pending = _storyboardTerminalReloadPendingByBatch;
        _storyboardTerminalReloadPendingByBatch = Object.create(null);
        var keys = Object.keys(pending);
        var first = pending[keys[0]];
        var confirmImages = keys.some(function (k) { return !!(pending[k] && pending[k].confirmImages); });
        var ok = await _reloadProjectFromServerForStoryboard(first.projectId);
        if (ok) {
          keys.forEach(function (k) {
            _storyboardTerminalReloadedByBatch[k] = true;
            delete _storyboardTerminalReloadScheduledByBatch[k];
          });
          renderImageGrid();
          if (confirmImages) checkImagesConfirm();
        } else {
          keys.forEach(function (k) { delete _storyboardTerminalReloadScheduledByBatch[k]; });
          console.warn("[StoryboardReattach] terminal project reload failed:", first.reason || first.batchId);
        }
      }
      return true;
    } catch (e) {
      Object.keys(_storyboardTerminalReloadPendingByBatch).forEach(function (k) {
        delete _storyboardTerminalReloadScheduledByBatch[k];
      });
      console.warn("[StoryboardReattach] terminal project reload failed:", (e && e.message) || e);
      return false;
    }
  })();

  _storyboardTerminalReloadInFlight.then(function () {
    _storyboardTerminalReloadInFlight = null;
  }, function () {
    _storyboardTerminalReloadInFlight = null;
  });
  return _storyboardTerminalReloadInFlight;
}

async function _maybeAutoStartTailFramesFromCurrentProject(projectId, sourceBatchId, opts) {
  if (!projectId || !sourceBatchId || !project || project.id !== projectId) return false;
  opts = opts || {};
  var key = _storyboardBatchKey(projectId, sourceBatchId);
  if (_storyboardTailAutoStartedBySourceBatch[key]) return false;
  if (opts.requireTerminalReload && !_storyboardTerminalReloadedByBatch[key]) return false;
  _storyboardTailAutoStartedBySourceBatch[key] = true;

  var targets = _tailKeyframeTargets(getStoryboardGroups(), {
    failedOnly: !!opts.failedOnly,
    includeReady: !!opts.includeReady,
  });
  if (!targets.length) return false;
  var hint = opts.hintId === false ? null : $(opts.hintId || 'imagesHint');
  if (hint) hint.textContent = "正在生成 " + targets.length + " 张尾帧关键帧…";

  try {
    await generateAllTailFrames({
      targets: targets,
      buttonId: opts.buttonId || 'btnGenAllImages',
      progressState: opts.progressState || null,
    });
    return true;
  } catch (e) {
    console.warn('[StoryboardTailAuto] auto tail-frame start failed:', (e && e.message) || e);
    return false;
  }
}

function _runStoryboardBatchReconcile(reason) {
  if (!project || !project.id) return;
  if (reason === 'interval' && (!_isDocumentVisibleForStoryboardReconcile() || !_hasRecentStoryboardBatchActivity())) return;
  var now = Date.now();
  if (_storyboardLastReconcileAt && now - _storyboardLastReconcileAt < STORYBOARD_REATTACH_RECONCILE_THROTTLE_MS) return;
  _storyboardLastReconcileAt = now;
  Promise.resolve(reattachStoryboardBatches()).catch(function (e) {
    console.warn("[StoryboardReattach] reconcile failed:", reason || "unknown", (e && e.message) || e);
  });
}

export function registerStoryboardBatchReconciler() {
  if (_storyboardBatchReconcilerRegistered) return;
  _storyboardBatchReconcilerRegistered = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', function () {
      _runStoryboardBatchReconcile('focus');
    });
    window.setInterval(function () {
      _runStoryboardBatchReconcile('interval');
    }, STORYBOARD_REATTACH_RECONCILE_INTERVAL_MS);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') _runStoryboardBatchReconcile('visibilitychange');
    });
  }
}

/**
 * 刷新 / 关 tab 后重连后端仍在跑的分镜图 & 分镜提示词 batch。
 * 模仿 videoTasks._reattachVideoBatches / assets.reattachActiveBatches。
 * 后端 batch_runner 不受前端刷新影响，apply_patch_and_save 会权威落盘；
 * 这里只重挂 SSE 订阅让 UI 恢复进度，并把已完成的结果同步到前端 project。
 */
export async function reattachStoryboardBatches() {
  _syncRefs();
  if (!project || !project.id) return;
  var originId = project.id;
  var resp;
  try {
    resp = await getActiveBatchesShared(originId);
  } catch (e) {
    console.warn("[StoryboardReattach] /api/batch/active failed:", (e && e.message) || e);
    return;
  }
  var batches = (resp && resp.batches) || [];
  if (!batches.length) return;
  _markStoryboardBatchActivity();

  batches.forEach(function (b) {
    var bt = b.batchType || "";
    var batchId = b.batchId;
    if (!batchId) return;

    if (bt === "storyboard_images") {
      if (_shouldSkipStoryboardRunningReattach(originId, batchId, b)) return;
      _reattachImagesBatch(b);
    } else if (bt === "tail_frame_images") {
      if (_shouldSkipStoryboardRunningReattach(originId, batchId, b)) return;
      _reattachTailFrameBatch(b);
    } else if (bt === "storyboard_prompts") {
      if (_shouldSkipStoryboardRunningReattach(originId, batchId, b)) return;
      _reattachPromptsBatch(b);
    }
  });
}

function _reattachImagesBatch(b) {
  var batchId = b.batchId;
  var snap = b.snapshot || {};
  var tasks = b.tasks || [];
  var originId = project.id;

  console.log("[StoryboardReattach] Reattaching storyboard_images batch:", batchId,
    "total:", snap.total, "succeeded:", snap.succeeded);

  if (!project.storyboards) project.storyboards = [];

  var rSeenDone = Object.create(null);
  var rSeenFailed = Object.create(null);
  function _markRDone(groupIdx) {
    if (typeof groupIdx !== 'number') return false;
    if (rSeenDone[groupIdx] || rSeenFailed[groupIdx]) return false;
    rSeenDone[groupIdx] = true;
    return true;
  }
  function _markRFailed(groupIdx) {
    if (typeof groupIdx !== 'number') return false;
    if (rSeenFailed[groupIdx] || rSeenDone[groupIdx]) return false;
    rSeenFailed[groupIdx] = true;
    return true;
  }
  function _bumpRDone() {
    if (!rTotal || rDoneCount + rFailCount < rTotal) rDoneCount++;
  }
  function _bumpRFailed() {
    if (!rTotal || rDoneCount + rFailCount < rTotal) rFailCount++;
  }
  function _applyReattachedImageTask(t) {
    var extra = _snapshotTaskExtra(t);
    var target = _snapshotTaskTarget(t);
    var gIdx = _firstTaskNumber([target.groupIdx, extra.groupIdx, t.target_idx, t.seq]);
    if (gIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";
    var url = _snapshotTaskImageUrl(t);

    if (isDone && url) {
      if (!_markRDone(gIdx)) return;
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      if (_isTailPatchExtra(extra)) {
        // 尾帧任务: 独立 apply, 只更新尾帧图位, 不触碰卡片主分镜/首帧 img。
        _applyTailFrameFields(project.storyboards[gIdx], url, extra, target.shotIndices || null);
        renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: url });
      } else {
        var displayUrl = url;
        if (project.storyboards[gIdx].imageUrl) {
          displayUrl = project.storyboards[gIdx].rawUrl || project.storyboards[gIdx].imageUrl;
        } else {
          _applyStoryboardImageFields(project.storyboards[gIdx], url, extra, target.shotIndices || null);
        }
        updateStoryboardCard(gIdx, "done", displayUrl);
      }
    } else if (isFailed) {
      if (!_markRFailed(gIdx)) return;
      updateStoryboardCard(gIdx, "error", null, _snapshotTaskError(t, 120));
    } else {
      updateStoryboardCard(gIdx, "loading", null, "生成中…");
    }
  }
  tasks.forEach(_applyReattachedImageTask);

  var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));
  if (isComplete) {
    _clearStoryboardReattachRunning(originId, batchId);
    _imagesGenerating = false;
    _hideKeyframeHeaderProgress();
    checkImagesConfirm();
    var terminalReloadKey = _storyboardBatchKey(originId, batchId);
    _scheduleStoryboardTerminalProjectReload(originId, batchId, {
      reason: "storyboard_images_terminal_snapshot",
      confirmImages: true,
    }).then(function () {
      if (_storyboardTerminalReloadedByBatch[terminalReloadKey]) {
        _maybeAutoStartTailFramesFromCurrentProject(originId, batchId, {
          requireTerminalReload: true,
          buttonId: 'btnGenAllImages',
        });
      }
    });
    return;
  }

  _imagesGenerating = true;
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  if (btn) btn.disabled = true;
  var rDoneCount = snap.succeeded || 0;
  var rFailCount = snap.failed || 0;
  var rTotal = snap.total || 0;
  // 刷新后没有"本次生成开始时刻"，从 batch 创建时间近似（不准但够用）
  var rStartTs = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
  if (hint) hint.textContent = "生成中… " + rDoneCount + "/" + (rTotal || "?");
  function _renderEtaR() {
    if (!rTotal) return;
    _showKeyframeHeaderProgress(rDoneCount, rTotal, rFailCount, rStartTs);
  }
  _renderEtaR();
  var rTick = setInterval(_renderEtaR, 1000);
  function _stopTickR() { if (rTick) { clearInterval(rTick); rTick = null; } }
  function _clearEtaR() {
    _hideKeyframeHeaderProgress();
    var rDiagBox = $("sbDiagnostic");
    if (rDiagBox) rDiagBox.innerHTML = '';
  }

  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (s && typeof s.total === 'number') {
        if (Array.isArray(s.tasks)) s.tasks.forEach(_applyReattachedImageTask);
        rTotal = s.total;
        if (typeof s.succeeded === 'number') rDoneCount = s.succeeded;
        if (typeof s.failed === 'number') rFailCount = s.failed;
        if (hint) hint.textContent = "生成中… " + rDoneCount + "/" + rTotal;
        _renderEtaR();
      }
    },
    onTaskStarted: function (data) {
      var extra = data.target || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : data.targetSeq;
      if (typeof groupIdx === 'number') updateStoryboardCard(groupIdx, "loading", null, "生成中…");
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      var rawUrl = extra.rawUrl || patch.value || data.resultUrl || '';
      if (typeof groupIdx !== 'number' || !rawUrl) return;
      if (!_markRDone(groupIdx)) return;

      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[groupIdx] || {};
        _archiveOldImage(existing, "storyboard");
        _applyFrameImagePatch(existing, rawUrl, extra, null);
        proj.storyboards[groupIdx] = existing;
        if (proj._staleFlags) delete proj._staleFlags["storyboard_" + groupIdx];
      }, data && data.serverVersion);
      if (!_isTailPatchExtra(extra)) {
        updateStoryboardCard(groupIdx, "done", rawUrl);
      } else {
        renderStoryboardFrameCard(groupIdx, 'tail', 'done', { imgUrl: rawUrl });
      }
      _bumpRDone();
      _renderEtaR();
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 120);
      if (!_markRFailed(groupIdx)) return;
      if (typeof groupIdx === 'number') updateStoryboardCard(groupIdx, "error", null, errMsg);
      _bumpRFailed();
      _renderEtaR();
    },
    onBatchCompleted: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      (async function () {
        _imagesGenerating = false;
        if (btn) btn.disabled = false;
        _stopTickR();
        _clearEtaR();
        var terminalReloadKey = _storyboardBatchKey(originId, batchId);
        await _scheduleStoryboardTerminalProjectReload(originId, batchId, {
          reason: "storyboard_images_sse_completed",
          confirmImages: true,
        });
        if (_storyboardTerminalReloadedByBatch[terminalReloadKey]) {
          await _maybeAutoStartTailFramesFromCurrentProject(originId, batchId, {
            requireTerminalReload: true,
            buttonId: 'btnGenAllImages',
          });
        }
      })();
    },
    onClose: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      _imagesGenerating = false;
      if (btn) btn.disabled = false;
      _stopTickR();
      _clearEtaR();
    },
  });
}

/**
 * 刷新/重连时恢复 tail_frame_images batch 的 UI 进度 (P2.5a.T5)。
 * 只更新尾帧格, 不触碰首帧/主图。
 */
function _reattachTailFrameBatch(b) {
  var batchId = b.batchId;
  var snap = b.snapshot || {};
  var tasks = b.tasks || [];
  var originId = project.id;

  console.log("[StoryboardReattach] Reattaching tail_frame_images batch:", batchId,
    "total:", snap.total, "succeeded:", snap.succeeded);

  if (!project.storyboards) project.storyboards = [];

  var tailSeenDone = Object.create(null);
  var tailSeenFailed = Object.create(null);
  function _markTailRDone(groupIdx) {
    if (typeof groupIdx !== 'number') return false;
    if (tailSeenDone[groupIdx] || tailSeenFailed[groupIdx]) return false;
    tailSeenDone[groupIdx] = true;
    return true;
  }
  function _markTailRFailed(groupIdx) {
    if (typeof groupIdx !== 'number') return false;
    if (tailSeenFailed[groupIdx] || tailSeenDone[groupIdx]) return false;
    tailSeenFailed[groupIdx] = true;
    return true;
  }
  function _bumpTailRDone() {
    if (!tailTotal || tailDoneCount + tailFailCount < tailTotal) tailDoneCount++;
  }
  function _bumpTailRFailed() {
    if (!tailTotal || tailDoneCount + tailFailCount < tailTotal) tailFailCount++;
  }
  function _applyReattachedTailTask(t) {
    var extra = _snapshotTaskExtra(t);
    var target = _snapshotTaskTarget(t);
    var gIdx = _firstTaskNumber([target.groupIdx, extra.groupIdx, t.target_idx, t.seq]);
    if (gIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";
    var url = _snapshotTaskImageUrl(t);

    if (isDone && url) {
      if (!_markTailRDone(gIdx)) return;
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      _applyTailFrameFields(project.storyboards[gIdx], url, extra, target.shotIndices || null);
      renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: url });
    } else if (isFailed) {
      if (!_markTailRFailed(gIdx)) return;
      var errMsg = _snapshotTaskError(t, 120);
      var extraRecord = _tailFrameErrorRecordFromExtra(extra, errMsg);
      _clearFailedTailFrameLocally(gIdx, errMsg, extra, originId);
      var displayMsg = _tailFrameErrorDisplay(_tailFrameErrorRecordFromStoryboard(project.storyboards[gIdx], errMsg), errMsg);
      if (_tailFrameSafetyInfo(project.storyboards[gIdx]) || _isImageSafetyBlocked(extraRecord.imageSafetyAudit, extraRecord.message || displayMsg)) renderImageGrid();
      else renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: displayMsg });
    } else {
      renderStoryboardFrameCard(gIdx, 'tail', 'loading', { loadingText: "生成尾帧中…" });
    }
  }
  tasks.forEach(_applyReattachedTailTask);

  var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));
  if (isComplete) {
    _clearStoryboardReattachRunning(originId, batchId);
    _setTailFramesGenerating(false);
    _hideKeyframeHeaderProgress();
    _scheduleStoryboardTerminalProjectReload(originId, batchId, {
      reason: "tail_frame_images_terminal_snapshot",
      confirmImages: false,
    });
    return;
  }

  // 订阅剩余进度。尾帧不复用首帧 _imagesGenerating 锁, 但需要独立标记全局按钮为生成中。
  _setTailFramesGenerating(true);
  var tailDoneCount = snap.succeeded || 0;
  var tailFailCount = snap.failed || 0;
  var tailTotal = snap.total || tasks.length || 0;
  var tailStartTs = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
  function _renderTailEtaR() {
    if (!tailTotal) return;
    _showKeyframeHeaderProgress(tailDoneCount, tailTotal, tailFailCount, tailStartTs);
  }
  _renderTailEtaR();
  var tailEtaTick = setInterval(_renderTailEtaR, 1000);
  function _stopTailEtaR() { if (tailEtaTick) { clearInterval(tailEtaTick); tailEtaTick = null; } }
  function _clearTailEtaR() {
    _stopTailEtaR();
    _hideKeyframeHeaderProgress();
  }
  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (!s || typeof s.total !== 'number') return;
      if (Array.isArray(s.tasks)) s.tasks.forEach(_applyReattachedTailTask);
      tailTotal = s.total;
      if (typeof s.succeeded === 'number') tailDoneCount = s.succeeded;
      if (typeof s.failed === 'number') tailFailCount = s.failed;
      _renderTailEtaR();
    },
    onTaskCompleted: function (data) {
      var extra = (data && data.extra) || {};
      var target = (data && data.target) || {};
      var gIdx2 = _firstTaskNumber([target.groupIdx, extra.groupIdx, data.targetSeq]);
      var patch = (data && data.patch) || {};
      var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || (data && data.resultUrl) || '';
      if (typeof gIdx2 !== 'number' || !rawUrl) return;
      if (!_markTailRDone(gIdx2)) return;
      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx2] || {};
        _applyTailFrameFields(existing, rawUrl, extra, target.shotIndices || null);
        proj.storyboards[gIdx2] = existing;
      });
      renderStoryboardFrameCard(gIdx2, 'tail', 'done', { imgUrl: rawUrl });
      _bumpTailRDone();
      _renderTailEtaR();
    },
    onTaskFailed: function (data) {
      var extra = (data && data.extra) || {};
      var target = (data && data.target) || {};
      var gIdx2 = _firstTaskNumber([target.groupIdx, extra.groupIdx, data.targetSeq]);
      var errMsg2 = ((data && data.errorMsg) || '生成失败').toString().slice(0, 120);
      if (typeof gIdx2 !== 'number') return;
      if (!_markTailRFailed(gIdx2)) return;
      var errRecord2 = _tailFrameErrorRecordFromExtra(extra, errMsg2);
      var displayMsg2 = _tailFrameErrorDisplay(errRecord2, errMsg2);
      _clearFailedTailFrameLocally(gIdx2, errMsg2, extra, originId);
      if (_isImageSafetyBlocked(errRecord2.imageSafetyAudit, errRecord2.message || displayMsg2)) renderImageGrid();
      else renderStoryboardFrameCard(gIdx2, 'tail', 'error', { errMsg: displayMsg2 });
      _bumpTailRFailed();
      _renderTailEtaR();
    },
    onBatchCompleted: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      _setTailFramesGenerating(false);
      _clearTailEtaR();
      _scheduleStoryboardTerminalProjectReload(originId, batchId, {
        reason: "tail_frame_images_sse_completed",
        confirmImages: false,
      });
    },
    onClose: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      _setTailFramesGenerating(false);
      _clearTailEtaR();
      /* SSE 断开由 polling 兜底, 或由后端最终 snapshot 修正 */
    },
  });
}

function _reattachPromptsBatch(b) {
  var batchId = b.batchId;
  var snap = b.snapshot || {};
  var tasks = b.tasks || [];
  var originId = project.id;

  console.log("[StoryboardReattach] Reattaching storyboard_prompts batch:", batchId,
    "total:", snap.total, "succeeded:", snap.succeeded);

  tasks.forEach(function (t) {
    var extra = _snapshotTaskExtra(t);
    var target = _snapshotTaskTarget(t);
    var shotIdx = _firstTaskNumber([target.shotIdx, target.idx, extra.shotIdx, t.target_idx, t.seq]);
    if (shotIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";

    if (isDone) {
      var prompt = _snapshotTaskPrompt(t);
      if (prompt && project.shots && project.shots[shotIdx]) {
        if (!project.shots[shotIdx].imagePrompt) {
          project.shots[shotIdx].imagePrompt = prompt;
          project.shots[shotIdx].imagePromptGenerated = true;
        } else {
          prompt = project.shots[shotIdx].imagePrompt;
        }
      }
      updatePromptCard(shotIdx, "done", prompt);
    } else if (isFailed) {
      updatePromptCard(shotIdx, "error", null, _snapshotTaskError(t, 100));
    } else {
      updatePromptCard(shotIdx, "loading");
    }
  });

  var isComplete = _isStoryboardBatchTerminalStatus(_storyboardBatchStatus(b));
  if (isComplete) {
    _clearStoryboardReattachRunning(originId, batchId);
    _promptsConverting = false;
    checkConvertConfirm();
    _markStoryboardTerminalSnapshotHandled(originId, batchId);
    return;
  }

  _promptsConverting = true;
  var btn = $("btnConvertAll");
  var hint = $("convertHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + (snap.total || "?");

  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (hint && s && typeof s.total === 'number') {
        hint.textContent = "生成中… " + (s.succeeded || 0) + "/" + s.total;
      }
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : null;
      if (shotIdx == null) return;
      var cleaned = extra.imagePrompt || patch.value || "";
      _safeWriteBack(originId, function (proj) {
        if (proj.shots && proj.shots[shotIdx]) {
          proj.shots[shotIdx].imagePrompt = cleaned;
          proj.shots[shotIdx].imagePromptGenerated = true;
          if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + shotIdx];
        }
      }, data && data.serverVersion);
      updatePromptCard(shotIdx, "done", cleaned);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : null;
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 100);
      if (typeof shotIdx === 'number') updatePromptCard(shotIdx, "error", null, errMsg);
    },
    onBatchCompleted: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      _promptsConverting = false;
      if (btn) btn.disabled = false;
      checkConvertConfirm();
    },
    onClose: function () {
      _clearStoryboardReattachRunning(originId, batchId);
      _promptsConverting = false;
      if (btn) btn.disabled = false;
    },
  });
}

function _snapshotTaskTarget(t) {
  return (t && t.target) || {};
}

function _snapshotTaskResult(t) {
  return (t && t.result) || {};
}

function _snapshotTaskExtra(t) {
  var result = _snapshotTaskResult(t);
  return result.extra || (t && t.extra) || {};
}

function _snapshotTaskPatch(t) {
  var result = _snapshotTaskResult(t);
  return result.patch || (t && t.patch) || {};
}

function _firstTaskNumber(values) {
  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (raw === null || raw === undefined || raw === '') continue;
    var n = (typeof raw === 'number') ? raw : parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function _snapshotTaskImageUrl(t) {
  var result = _snapshotTaskResult(t);
  var extra = _snapshotTaskExtra(t);
  var patch = _snapshotTaskPatch(t);
  return extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || result.resultUrl || t.resultUrl || t.result_url || "";
}

function _snapshotTaskPrompt(t) {
  var result = _snapshotTaskResult(t);
  var extra = _snapshotTaskExtra(t);
  var patch = _snapshotTaskPatch(t);
  return extra.imagePrompt || patch.imagePrompt || patch.value || result.imagePrompt || result.resultText || "";
}

function _snapshotTaskError(t, limit) {
  limit = limit || 120;
  return ((t && (t.errorMsg || t.error_msg)) || "生成失败").toString().slice(0, limit);
}

function _syncRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _safeWriteBack(id, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(id, fn, serverVersion) : false; }
function switchPage(p) { if (_ctx.switchPage) _ctx.switchPage(p); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function _applyServerStaleFlags(prefixes, serverFlags) { return _ctx.applyServerStaleFlags ? _ctx.applyServerStaleFlags(prefixes, serverFlags) : false; }
function _markDownstreamStale(scope, detail) { if (_ctx.markDownstreamStale) _ctx.markDownstreamStale(scope, detail); }
function _checkAndSuggest(stage) { if (_ctx.checkAndSuggest) _ctx.checkAndSuggest(stage); }
function _archiveOldImage(item, source) { if (_ctx.archiveOldImage) _ctx.archiveOldImage(item, source); }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function _openLightbox(url, title) { if (_ctx.openLightbox) _ctx.openLightbox(url, title); }
async function _acceptShotPlanForStoryboard() {
  if (_ctx.acceptShotPlanForStoryboard) return !!(await _ctx.acceptShotPlanForStoryboard());
  showToast("镜头表保存入口不可用，请刷新页面", "error");
  return false;
}
function _historyBtnHtml(item, variant) { return _ctx.historyBtnHtml ? _ctx.historyBtnHtml(item, variant) : ''; }
function _openHistoryPopover(btn, item, onApply) { if (_ctx.openHistoryPopover) _ctx.openHistoryPopover(btn, item, onApply); }
function _setHistoryAsCurrent(item, hi) { return _ctx.setHistoryAsCurrent ? _ctx.setHistoryAsCurrent(item, hi) : false; }
function emotionBadgeHtml(emotion, intensity) { return _ctx.emotionBadgeHtml ? _ctx.emotionBadgeHtml(emotion, intensity) : ''; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }

async function _reloadProjectFromServerForStoryboard(originId) {
  if (!_ctx.reloadProjectFromServer) return false;
  try {
    var ok = await _ctx.reloadProjectFromServer();
    _syncRefs();
    return !!ok && (!originId || (project && project.id === originId));
  } catch (e) {
    console.warn("[Storyboard] reloadProjectFromServer failed:", e);
    return false;
  }
}

function _applyStoryboardImageFields(existing, rawUrl, extra, fallbackShotIndices) {
  extra = extra || {};
  var shouldInvalidateVideo = !!(extra.invalidateVideo || extra.firstFrameUrl || extra.firstFrameMode || extra.imagePrompt);
  var groupIdx = (typeof extra.groupIdx === "number") ? extra.groupIdx : ((typeof existing.idx === "number") ? existing.idx : null);
  if (shouldInvalidateVideo) {
    delete existing.videoUrl;
    delete existing._originVideoUrl;
    delete existing.videoTaskId;
    delete existing.videoCoverUrl;
    delete existing.videoStatus;
    delete existing.videoMode;
    delete existing.videoTaskFinishedAt;
    delete existing.videoDurationSec;
    if (_ctx.invalidateVideoForGroup && groupIdx !== null) _ctx.invalidateVideoForGroup(groupIdx);
  }
  existing.url = rawUrl;
  existing.imageUrl = rawUrl;
  existing.rawUrl = rawUrl;
  if (extra.firstFrameUrl || extra.firstFrameMode) {
    var firstFrameSource = extra.firstFrameSource || "generated";
    existing.firstFrameUrl = extra.firstFrameUrl || rawUrl;
    existing.firstFrameMode = extra.firstFrameMode || "multi_ref_v1";
    existing.firstFrameSourceHash = Object.prototype.hasOwnProperty.call(extra, "firstFrameSourceHash")
      ? extra.firstFrameSourceHash
      : (existing.firstFrameSourceHash || null);
    existing.firstFrame = {
      currentUrl: existing.firstFrameUrl,
      rawUrl: rawUrl,
      status: extra.firstFrameStatus || "ready",
      source: firstFrameSource,
      lastKnownGoodUrl: existing.firstFrameUrl,
      sourceHash: existing.firstFrameSourceHash,
      history: [{
        url: existing.firstFrameUrl,
        at: new Date().toISOString(),
        source: firstFrameSource
      }].concat((existing.firstFrame && Array.isArray(existing.firstFrame.history)) ? existing.firstFrame.history.filter(function (item) {
        return item && item.url && item.url !== existing.firstFrameUrl;
      }) : []).slice(0, 20)
    };
    delete existing.firstFrameLastError;
    delete existing.firstFrameFailedAt;
    // 用户原则: 首帧变化不再连带把尾帧标记为 stale, 由用户自己决定要不要重做尾帧。
    // D: 首帧刚写入/就绪 → 作废该组尾帧就绪缓存, 否则首帧未就绪期拉取的陈旧 preflight
    // 会残留"首帧未就绪"提示。见 docs/first-frame-url-field-alignment-proposal.md (选项 D)。
    _invalidateTailFramePromptReadiness(groupIdx);
  }
  if (extra.firstFramePrompt) existing.firstFramePrompt = extra.firstFramePrompt;
  if (extra.imagePrompt) {
    existing.imagePrompt = extra.imagePrompt;
    if (extra.firstFrameMode && !existing.firstFramePrompt) existing.firstFramePrompt = extra.imagePrompt;
  }
  if (extra.debugSketchUrl) existing.debugSketchUrl = extra.debugSketchUrl;
  if (extra.assetId) existing.imageAssetId = extra.assetId;
  if (extra.fetchStatus) existing.fetchStatus = extra.fetchStatus;
  if (Array.isArray(extra.shotIndices)) existing.shotIndices = extra.shotIndices;
  else if (Array.isArray(fallbackShotIndices)) existing.shotIndices = fallbackShotIndices;
  if (existing.realPhotoUrl) delete existing.realPhotoUrl;
  return existing;
}

/**
 * 判断 extra 是否属于尾帧 patch/extra。尾帧事件绝不能走 _applyStoryboardImageFields,
 * 否则会把 existing.url/imageUrl/rawUrl 覆盖成尾帧图, 主分镜/首帧显示立即错乱。
 */
function _isTailPatchExtra(extra) {
  if (!extra) return false;
  return !!(
    extra.tailFrameUrl ||
    extra.tailFrameMode ||
    (extra.frames && extra.frames.tail) ||
    extra.type === 'tail_frame_image'
  );
}

/**
 * 尾帧专用 merge。独立于首帧/分镜图路径:只写 tailFrameUrl / tailFrameMode /
 * tailFramePrompt / tailFrameSafetyAudit / tailFramePlanSummary / frames.tail。
 * 不动 existing.url / imageUrl / rawUrl。尾帧现在会进入视频阶段, 因此这里同时维护
 * tailFrameIntent / tailFrameReferenceStatus, 让刷新后的状态和视频输入链路一致。
 */
function _applyTailFrameFields(existing, rawUrl, extra, fallbackShotIndices) {
  extra = extra || {};
  var tailUrl = extra.tailFrameUrl || rawUrl;
  if (!tailUrl) return existing;
  existing.tailFrameUrl = tailUrl;
  existing.tailFrameMode = extra.tailFrameMode || "structured_v1";
  existing.tailFrameIntent = extra.tailFrameIntent || "requested";
  existing.tailFrameIntentUpdatedAt = extra.tailFrameIntentUpdatedAt || new Date().toISOString();
  existing.tailFrameSourceHash = Object.prototype.hasOwnProperty.call(extra, "tailFrameSourceHash")
    ? extra.tailFrameSourceHash
    : (existing.tailFrameSourceHash || null);
  existing.tailFrameReferenceStatus = extra.tailFrameReferenceStatus || "ready";
  if (extra.tailFramePrompt) existing.tailFramePrompt = extra.tailFramePrompt;
  if (extra.originalTailFramePrompt) existing.originalTailFramePrompt = extra.originalTailFramePrompt;
  if (extra.tailFrameSafetyAudit) existing.tailFrameSafetyAudit = extra.tailFrameSafetyAudit;
  if (extra.tailFramePlanSummary) existing.tailFramePlanSummary = extra.tailFramePlanSummary;
  if (Array.isArray(extra.tailFrameHistory)) existing.tailFrameHistory = extra.tailFrameHistory;
  var incomingTail = (extra.frames && extra.frames.tail) ? extra.frames.tail : {
    url: tailUrl,
    prompt: extra.tailFramePrompt,
    mode: existing.tailFrameMode,
    status: "ready",
    source: "generated",
    generatedAt: new Date().toISOString(),
  };
  incomingTail = Object.assign({}, incomingTail, {
    sourceHash: Object.prototype.hasOwnProperty.call(extra, "tailFrameSourceHash")
      ? extra.tailFrameSourceHash
      : incomingTail.sourceHash,
    referenceStatus: extra.tailFrameReferenceStatus || incomingTail.referenceStatus || "ready",
  });
  existing.frames = Object.assign({}, existing.frames || {}, { tail: incomingTail });
  delete existing.tailFrameLastError;
  delete existing.tailFrameFailedAt;
  if (Array.isArray(extra.shotIndices)) existing.shotIndices = extra.shotIndices;
  else if (Array.isArray(fallbackShotIndices)) existing.shotIndices = fallbackShotIndices;
  return existing;
}

/**
 * 统一分发: tail 走 _applyTailFrameFields, 其它走 _applyStoryboardImageFields。
 * 调用点不用自己判断字段归属。
 */
function _applyFrameImagePatch(existing, rawUrl, extra, fallbackShotIndices) {
  if (_isTailPatchExtra(extra)) {
    return _applyTailFrameFields(existing, rawUrl, extra, fallbackShotIndices);
  }
  return _applyStoryboardImageFields(existing, rawUrl, extra, fallbackShotIndices);
}

function _tailFrameErrorRecordFromExtra(extra, fallbackMsg) {
  extra = extra || {};
  var tail = (extra.frames && extra.frames.tail) || {};
  var lastError = tail.lastError || {};
  var message = lastError.message || extra.tailFrameLastError || fallbackMsg || '生成失败';
  return {
    message: String(message || '生成失败').slice(0, 500),
    errorCode: lastError.errorCode || extra.tailFrameErrorCode || extra.errorCode || '',
    recoveryHint: lastError.recoveryHint || extra.tailFrameRecoveryHint || extra.recoveryHint || '',
    imageSafetyAudit: lastError.imageSafetyAudit ||
      tail.safetyAudit ||
      tail.imageSafetyAudit ||
      extra.tailFrameSafetyAudit ||
      _imageSafetyAuditFromExtra(extra) ||
      null,
  };
}

function _tailFrameErrorRecordFromStoryboard(sb, fallbackMsg) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || {};
  var lastError = tail.lastError || {};
  var message = lastError.message || sb.tailFrameLastError || fallbackMsg || '';
  return {
    message: String(message || '').slice(0, 500),
    errorCode: lastError.errorCode || sb.tailFrameErrorCode || '',
    recoveryHint: lastError.recoveryHint || sb.tailFrameRecoveryHint || '',
    imageSafetyAudit: lastError.imageSafetyAudit ||
      tail.safetyAudit ||
      tail.imageSafetyAudit ||
      sb.tailFrameSafetyAudit ||
      null,
  };
}

function _tailFrameErrorDisplay(record, fallbackMsg) {
  record = record || {};
  if (record.recoveryHint) return record.recoveryHint.toString().slice(0, 200);
  // message 走一遍诊断: 内容安全审核拦截会被翻成"提示词违规，未通过安全审核"等友好文案。
  var raw = (record.message || fallbackMsg || '生成失败').toString();
  return _diagnoseApiError(raw).toString().slice(0, 200);
}

function _clearFailedStoryboardLocally(groupIdx, errMsg, extra, projectId) {
  if (typeof groupIdx !== 'number' || !project) return;
  var originProjectId = projectId || (project && project.id);
  if (!originProjectId) return;
  var audit = _imageSafetyAuditFromExtra(extra);
  var msg = _firstFrameFailureDisplay(errMsg || '生成失败', extra).slice(0, 500);
  _safeWriteBack(originProjectId, function (proj) {
    if (!proj.storyboards) proj.storyboards = [];
    var sb = proj.storyboards[groupIdx] || {};
    // Keep this optimistic client mirror aligned with lib/visual-reference-state.ts markFirstFrameFailed.
    // Only first-frame-specific fields can be reused here; url/imageUrl/rawUrl are storyboard sketches.
    var fallbackUrl = (sb.firstFrame && (sb.firstFrame.currentUrl || sb.firstFrame.lastKnownGoodUrl)) ||
      (sb.frames && sb.frames.first && sb.frames.first.url) ||
      sb.firstFrameUrl ||
      "";
    sb.firstFrameLastError = msg;
    sb.firstFrameFailedAt = new Date().toISOString();
    sb.firstFrame = Object.assign({}, sb.firstFrame || {}, {
      currentUrl: fallbackUrl || undefined,
      status: fallbackUrl ? "degraded" : "failed",
      source: fallbackUrl ? "last_known_good" : ((sb.firstFrame && sb.firstFrame.source) || "generated"),
      lastKnownGoodUrl: fallbackUrl || ((sb.firstFrame && sb.firstFrame.lastKnownGoodUrl) || undefined),
      lastError: {
        message: msg,
        failedAt: sb.firstFrameFailedAt,
        imageSafetyAudit: audit || undefined
      },
      history: (sb.firstFrame && Array.isArray(sb.firstFrame.history)) ? sb.firstFrame.history : []
    });
    if (audit) sb.firstFrameSafetyAudit = audit;
    else delete sb.firstFrameSafetyAudit;
    proj.storyboards[groupIdx] = sb;
  });
}

function _clearFailedTailFrameLocally(groupIdx, errMsg, extra, projectId) {
  if (typeof groupIdx !== 'number' || !project) return;
  var originProjectId = projectId || (project && project.id);
  if (!originProjectId) return;
  var errRecord = _tailFrameErrorRecordFromExtra(extra, errMsg);
  var audit = errRecord.imageSafetyAudit || null;
  var msg = errRecord.message;
  _safeWriteBack(originProjectId, function (proj) {
    if (!proj.storyboards) proj.storyboards = [];
    var sb = proj.storyboards[groupIdx] || {};
    var prevTail = (sb.frames && sb.frames.tail) || null;
    var fallbackUrl = (prevTail && (prevTail.url || prevTail.lastKnownGoodUrl)) || sb.tailFrameUrl || "";
    sb.tailFrameLastError = msg;
    sb.tailFrameFailedAt = new Date().toISOString();
    sb.tailFrameIntent = "requested";
    sb.tailFrameIntentUpdatedAt = sb.tailFrameIntentUpdatedAt || sb.tailFrameFailedAt;
    sb.tailFrameReferenceStatus = fallbackUrl ? "ready" : "missing";
    var nextTail = Object.assign({}, prevTail || {}, {
      url: fallbackUrl || undefined,
      status: fallbackUrl ? "degraded" : "failed",
      source: fallbackUrl ? "last_known_good" : ((prevTail && prevTail.source) || "generated"),
      lastKnownGoodUrl: fallbackUrl || ((prevTail && prevTail.lastKnownGoodUrl) || undefined),
      referenceStatus: fallbackUrl ? "ready" : "missing",
      lastError: {
        message: msg,
        errorCode: errRecord.errorCode || undefined,
        recoveryHint: errRecord.recoveryHint || undefined,
        failedAt: sb.tailFrameFailedAt,
        imageSafetyAudit: audit || undefined
      }
    });
    if (audit) {
      nextTail.safetyAudit = audit;
      sb.tailFrameSafetyAudit = audit;
    } else {
      delete nextTail.safetyAudit;
      delete nextTail.imageSafetyAudit;
      delete sb.tailFrameSafetyAudit;
    }
    sb.frames = Object.assign({}, sb.frames || {}, { tail: nextTail });
    proj.storyboards[groupIdx] = sb;
  });
}

function _imageSafetyAuditFromExtra(extra) {
  extra = extra || {};
  return extra.imageSafetyAudit ||
    (extra.extra && extra.extra.imageSafetyAudit) ||
    (extra.result && extra.result.imageSafetyAudit) ||
    null;
}

function _isImageSafetyModerationCode(code) {
  return /moderation_blocked|content_policy_violation|safety_violation|policy_violation|content_filter/i.test(String(code || ''));
}

function _isImageSafetyModerationMessage(msg) {
  return /moderation_blocked|content_policy|content_filter|safety system|image_generation_user_error|内容安全|内容审核|安全审核|安全系统|未通过(?:内容)?(?:安全)?审核/i.test(String(msg || ''));
}

function _isImageSafetyBlocked(audit, errMsg) {
  var attempts = Array.isArray(audit && audit.attempts) ? audit.attempts : [];
  if (attempts.some(function (attempt) {
    return _isImageSafetyModerationCode(attempt && attempt.errorCode) ||
      (Array.isArray(attempt && attempt.safetyViolations) && attempt.safetyViolations.length);
  })) return true;
  var diagnostics = audit && audit.safetyDiagnostics || {};
  var categories = Array.isArray(diagnostics.providerCategory) ? diagnostics.providerCategory : [];
  if (categories.length) return true;
  return _isImageSafetyModerationMessage(errMsg);
}

function _imageSafetyAuditTargets(audit, limit) {
  var diagnostics = audit && audit.safetyDiagnostics || {};
  var diagnosticItems = Array.isArray(diagnostics.likelySensitiveFragments)
    ? diagnostics.likelySensitiveFragments
    : [];
  var seenWords = {};
  var words = [];
  var pushWord = function (text) {
    text = String(text || '').trim();
    if (!text || seenWords[text]) return;
    seenWords[text] = true;
    words.push(text);
  };
  diagnosticItems.forEach(function (item) {
    var text = (item && item.text || '').toString().trim();
    if (!text) return;
    _extractCompactSafetyWords(text).forEach(pushWord);
    if (_isCompactSafetyWord(text)) pushWord(text);
  });
  if (!words.length) {
    _imageSafetyRewriteTerms(audit).forEach(function (text) {
      _extractCompactSafetyWords(text).forEach(pushWord);
    });
  }
  var max = limit || 6;
  return {
    words: words.slice(0, max),
  };
}

function _isCompactSafetyWord(text) {
  text = String(text || '').trim();
  return text.length >= 2 && text.length <= 8 && !/[，,。；;、\s]/.test(text);
}

function _extractCompactSafetyWords(text) {
  var source = String(text || '');
  var out = [];
  var seen = {};
  var push = function (term) {
    term = String(term || '').trim();
    if (!_isCompactSafetyWord(term) || seen[term]) return;
    seen[term] = true;
    out.push(term);
  };
  var rules = [
    /人群挤压|挤出|挤入|拥挤|围堵|推搡|争相/g,
    /盯着|瞪大|嘴微张|张望|屏住呼吸|屏息/g,
    /惊恐|惊惧|惊吓|脸色发白|惨白|紧张|震惊|震撼/g,
    /巨大暗影|暗影|压迫|爆发|喷薄|冲击|裂开|炸裂|引信/g,
    /膜拜|跪拜|审判|献祭/g,
  ];
  rules.forEach(function (re) {
    re.lastIndex = 0;
    var match;
    while ((match = re.exec(source)) !== null) push(match[0]);
  });
  return out;
}

function _imageSafetyRewriteTerms(audit) {
  var terms = [];
  var seen = {};
  var push = function (text) {
    text = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^[-:：\s]+/, '')
      .trim();
    if (text.length < 2 || text.length > 36 || seen[text]) return;
    seen[text] = true;
    terms.push(text);
  };
  var visualDiffs = audit &&
    audit.visualAnchorDescription &&
    Array.isArray(audit.visualAnchorDescription.rewriteDiff)
      ? audit.visualAnchorDescription.rewriteDiff
      : [];
  var attemptDiffs = [];
  (Array.isArray(audit && audit.attempts) ? audit.attempts : []).forEach(function (attempt) {
    (Array.isArray(attempt && attempt.rewriteDiff) ? attempt.rewriteDiff : []).forEach(function (diff) {
      attemptDiffs.push(diff);
    });
  });
  visualDiffs.concat(attemptDiffs).forEach(function (diff) {
    var from = diff && (diff.from || diff.fromPreview);
    var to = diff && (diff.to || diff.toPreview);
    if (!from || !to) return;
    _extractChangedSafetyPhrases(from, to).forEach(push);
  });
  return terms;
}

function _extractSafetyUiScope(text) {
  var source = String(text || '');
  var sections = [];
  var sectionRe = /【(主镜头|用户原文约束)】[\s\S]*?(?=\n【[^】]+】|$)/g;
  var match;
  while ((match = sectionRe.exec(source)) !== null) sections.push(match[0]);
  return sections.length ? sections.join('\n') : source;
}

function _normalizeSafetyCompareText(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[“”"']/g, '');
}

function _extractChangedSafetyPhrases(fromText, toText) {
  var from = _extractSafetyUiScope(fromText);
  var toNorm = _normalizeSafetyCompareText(_extractSafetyUiScope(toText));
  var rawParts = from
    .replace(/【[^】]+】/g, '\n')
    .split(/[，,。；;、\n]/g);
  var out = [];
  var seen = {};
  rawParts.forEach(function (part) {
    var text = String(part || '')
      .replace(/^\s*-\s*/, '')
      .replace(/^(画面|台词\/声音提示|景别|角度\/视点|焦距|景深\/焦点|光线组合|构图组合|运镜)\s*[：:]/, '')
      .trim();
    if (text.length < 2 || text.length > 36) return;
    if (/^(以镜头\s*\d+|中近景|平视|固定镜头|浅景深|此钟在|路人甲|帝兵惊叹)/.test(text)) return;
    if (/侧光|柔和|照亮|视线方向/.test(text)) return;
    var textNorm = _normalizeSafetyCompareText(text);
    if (!textNorm || toNorm.indexOf(textNorm) >= 0 || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function _imageSafetyAuditHint(audit) {
  var targets = _imageSafetyAuditTargets(audit, 4);
  if (targets.words.length) return '图像服务没有返回具体拦截词，系统推测可先弱化：' + targets.words.join('、') + '。';
  var attempts = Array.isArray(audit && audit.attempts) ? audit.attempts : [];
  var hadRewrite = attempts.some(function (attempt) {
    return Array.isArray(attempt && attempt.rewriteDiff) && attempt.rewriteDiff.length;
  });
  if (hadRewrite) return '系统已自动改写并重试，仍被拦截；请进一步弱化惊恐、压迫、爆发、人群挤压等描写，或减少参考图后重试。';
  return '图像服务未返回具体拦截词；建议先弱化惊恐/压迫/爆发/人群挤压等描述，或更换、减少参考图后重试。';
}

function _frameSafetyInfo(kind, sb) {
  sb = sb || {};
  var isTail = kind === 'tail';
  var tail = isTail ? ((sb.frames && sb.frames.tail) || {}) : {};
  var currentLastError = isTail
    ? (tail.lastError || null)
    : (sb.firstFrame && sb.firstFrame.lastError || null);
  var currentLastErrorAudit = currentLastError && currentLastError.imageSafetyAudit || null;
  var audit = isTail
    ? (currentLastErrorAudit || sb.tailFrameSafetyAudit || tail.safetyAudit || tail.imageSafetyAudit || null)
    : (currentLastErrorAudit || _firstFrameSafetyExtraFromStoryboard(sb).imageSafetyAudit);
  var rawMsg = isTail
    ? (sb.tailFrameLastError || (currentLastError && currentLastError.message) || '')
    : (sb.firstFrameLastError || (currentLastError && currentLastError.message) || '');
  if (!_isImageSafetyModerationMessage(rawMsg) && !currentLastErrorAudit) return null;
  if (!_isImageSafetyBlocked(audit, rawMsg)) return null;
  var targets = _imageSafetyAuditTargets(audit, 8);
  var words = targets.words;
  var label = isTail ? '尾帧' : '首帧';
  return {
    terms: words,
    words: words,
    reasonLine: '原因：图片生成服务判定这次' + label + '请求有敏感内容，已拒绝生成。',
    termsLine: words.length
      ? '疑似触发词：' + words.join('、')
      : '疑似触发词：未能定位到具体词。',
  };
}

function _firstFrameSafetyInfo(sb) {
  return _frameSafetyInfo('first', sb);
}

function _tailFrameSafetyInfo(sb) {
  return _frameSafetyInfo('tail', sb);
}

function _sbFrameSafetyNoticeHtml(info, kind) {
  if (!info) return '';
  return '<div class="sb-frame-safety-notice" data-sb-frame-safety-notice="' + escapeHtml(kind || 'first') + '">' +
    '<div>' + escapeHtml(info.reasonLine) + '</div>' +
    '<div>' + escapeHtml(info.termsLine) + '</div>' +
  '</div>';
}

function _sbFirstFrameSafetyNoticeHtml(info) {
  return _sbFrameSafetyNoticeHtml(info, 'first');
}

function _firstFrameFailureDisplay(errMsg, extra) {
  var audit = _imageSafetyAuditFromExtra(extra);
  var diagnosed = _diagnoseApiError((errMsg || '生成失败').toString());
  var hint = (_isImageSafetyModerationMessage(errMsg) && _isImageSafetyBlocked(audit, errMsg)) ? _imageSafetyAuditHint(audit) : '';
  if (hint && diagnosed === '提示词违规，未通过安全审核') {
    return ('首帧未通过内容安全审核：' + hint).slice(0, 260);
  }
  if (hint && diagnosed.indexOf(hint) < 0 && diagnosed.length < 180) {
    return (diagnosed + '。' + hint).slice(0, 260);
  }
  return diagnosed.toString().slice(0, 260);
}

function _firstFrameSafetyExtraFromStoryboard(sb) {
  sb = sb || {};
  return {
    imageSafetyAudit: sb.firstFrameSafetyAudit ||
      (sb.firstFrame && sb.firstFrame.lastError && sb.firstFrame.lastError.imageSafetyAudit) ||
      (sb.frames && sb.frames.first && sb.frames.first.safetyAudit) ||
      null
  };
}

function _tailFrameUiState(sb, group) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  var tailUrl = _tailFrameImageUrl(sb);
  var tailStatus = (tail && tail.status) || (sb.tailFrameLastError ? 'failed' : (tailUrl ? 'ready' : 'missing'));
  var intent = _tailFrameGenerationIntentForGroup(group || {}, sb);
  var requiresFirstFrame = !!intent.requiresFirstFrame;
  var canGenerate = !!intent.canGenerate;
  var isLegacyPencil = String(sb.firstFrameMode || '') === 'legacy_pencil';
  var preflightMsg;
  if (requiresFirstFrame && isLegacyPencil) preflightMsg = '当前首帧是手稿版 (legacy_pencil), 需先升级为彩色首帧';
  else if (requiresFirstFrame && !canGenerate) preflightMsg = '需先生成彩色首帧 (structured_v1)';
  else preflightMsg = '';

  var statusText;
  if (tailStatus === 'ready') statusText = '已生成';
  else if (tailStatus === 'failed') statusText = '生成失败';
  else if (tailStatus === 'degraded') statusText = '已降级 (展示上次成功)';
  else if (tailStatus === 'missing') {
    if (requiresFirstFrame && isLegacyPencil) statusText = '需升级首帧';
    else statusText = canGenerate ? '待生成' : '等待首帧';
  } else statusText = tailStatus;

  var btnText;
  if (tailStatus === 'ready' || tailStatus === 'degraded') btnText = '重新生成';
  else if (tailStatus === 'failed') btnText = '重试';
  else btnText = '生成尾帧';

  return {
    url: tailUrl,
    status: tailStatus,
    statusText: statusText,
    btnText: btnText,
    canGenerate: canGenerate,
    requiresFirstFrame: requiresFirstFrame,
    dependency: intent.dependency || 'independent',
    isLegacyPencil: isLegacyPencil,
    preflightMsg: preflightMsg,
    errorMsg: _tailFrameErrorDisplay(_tailFrameErrorRecordFromStoryboard(sb, '')),
  };
}

// 标记尾帧意图为 requested 并触发后续生成。供正向尾帧建议点击复用。
function _acceptTailFrameSuggestion(gIdx) {
  if (!project.storyboards) project.storyboards = [];
  var suggestSb = project.storyboards[gIdx] || {};
  var acceptedAt = new Date().toISOString();
  suggestSb.tailFrameIntent = "requested";
  suggestSb.tailFrameIntentUpdatedAt = acceptedAt;
  suggestSb.tailFrameReferenceStatus = _tailFrameImageUrl(suggestSb) ? "ready" : "missing";
  project.storyboards[gIdx] = suggestSb;
  saveProject();
  renderImageGrid();
  checkImagesConfirm();
  var groups = getStoryboardGroups();
  var group = groups[gIdx] || {};
  var intent = _tailFrameGenerationIntentForGroup(group, suggestSb);
  if (intent.canGenerate) {
    generateStoryboardTailFrame(gIdx).then(function () {
      saveProject();
      checkImagesConfirm();
    }).catch(function (err) {
      console.warn('[TailFrame] accept suggestion failed:', (err && err.message) || err);
    });
  } else {
    showToast(intent.requiresFirstFrame ? "已标记这段需要尾帧，请先生成首帧" : "已标记这段需要尾帧", "info");
  }
}

function _tailFrameSuggestionBadgeHtml(group, sb, gIdx) {
  var suggestion = _tailFrameSuggestionForGroup(group, sb);
  if (suggestion.level === 'none') return '';
  var cls = suggestion.level === 'strong'
    ? 'bg-error/10 text-error border-error/20 hover:bg-error/15'
    : (suggestion.level === 'requested'
      ? 'bg-primary/10 text-primary border-primary/20'
      : 'bg-amber-100 text-amber-700 border-amber-200 hover:bg-amber-200/70');
  var actionAttr = suggestion.level === 'requested'
    ? ''
    : ' data-action="accept-tail-suggestion" data-gidx="' + gIdx + '"';
  var cursorCls = suggestion.level === 'requested' ? 'cursor-default' : 'cursor-pointer';
  return '<button type="button" class="tail-suggestion-badge px-2.5 py-1 rounded-full border text-[10px] font-black tracking-widest uppercase transition-colors ' + cursorCls + ' ' + cls + '"' +
    actionAttr +
    ' title="点击采纳建议并生成尾帧，评分 ' + suggestion.score + '">' +
    escapeHtml(suggestion.label) +
    '</button>';
}

function _materialLimitBlockMessage(groups, groupIdxs) {
  groups = groups || getStoryboardGroups();
  var wanted = null;
  if (Array.isArray(groupIdxs) && groupIdxs.length) {
    wanted = {};
    groupIdxs.forEach(function (idx) { wanted[Number(idx)] = true; });
  }
  for (var i = 0; i < groups.length; i += 1) {
    var gIdx = Number(groups[i] && groups[i].groupIdx);
    if (!Number.isFinite(gIdx)) continue;
    if (wanted && !wanted[gIdx]) continue;
    var panel = getMaterialPanel(gIdx);
    var message = panel && panel.invalid && panel.invalid.message || '';
    if (message) return '分镜板 ' + (gIdx + 1) + ' ' + message;
  }
  return '';
}

function _materialCheckGroupIdxs(groups, groupIdxs) {
  groups = groups || getStoryboardGroups();
  var wanted = null;
  if (Array.isArray(groupIdxs) && groupIdxs.length) {
    wanted = {};
    groupIdxs.forEach(function (idx) { wanted[Number(idx)] = true; });
  }
  return groups.reduce(function (out, group) {
    var gIdx = Number(group && group.groupIdx);
    if (!Number.isFinite(gIdx)) return out;
    if (wanted && !wanted[gIdx]) return out;
    out.push(gIdx);
    return out;
  }, []);
}

async function _ensureMaterialPanelsForChecks(groups, groupIdxs) {
  if (!project || !project.id) return;
  groups = groups || getStoryboardGroups();
  var gIdxs = _materialCheckGroupIdxs(groups, groupIdxs);
  if (!gIdxs.length) return;
  var needsFetch = gIdxs.some(function (gIdx) {
    return !getMaterialPanel(gIdx) || shouldRefreshMaterialPanel(gIdx);
  });
  if (!needsFetch) return;
  var entries;
  if (gIdxs.length === 1) entries = await fetchMaterialPanels(project.id, { groupIdx: gIdxs[0] });
  else entries = await fetchMaterialPanels(project.id);
  _refreshMaterialPanelSlots(entries);
}

function _isShotMaterialRolePickerOpen(gIdx) {
  var active = materialPanelState.activeRolePicker;
  return !!(active && active.surface === 'shot' && Number(active.groupIdx) === Number(gIdx));
}

function _shotMaterialPickerState(gIdx) {
  var picker = materialPanelState.activePicker;
  if (picker && picker.surface === 'shot' && Number(picker.groupIdx) === Number(gIdx)) {
    return Object.assign({ open: true }, picker);
  }
  return { open: false };
}

function _shotMaterialPanelInnerHtml(gIdx) {
  var panel = getMaterialPanel(gIdx);
  return renderMaterialImagePanelHtml({
    panel: panel,
    scope: 'shot',
    groupIdx: gIdx,
    rolePickerOpen: _isShotMaterialRolePickerOpen(gIdx),
    actionAttr: 'data-material-action',
  });
}

function _rerenderMaterialPanelSlot(groupIdx) {
  var key = String(Number(groupIdx));
  document.querySelectorAll('[data-material-slot="' + key + '"]').forEach(function (slot) {
    var roleOpen = _isShotMaterialRolePickerOpen(Number(groupIdx));
    slot.classList.toggle('is-role-picker-open', roleOpen);
    var card = slot.closest && slot.closest('.sb-sheet, .shot-workbench-card');
    if (card) card.classList.toggle('is-material-role-picker-open', roleOpen);
    slot.innerHTML = _shotMaterialPanelInnerHtml(Number(groupIdx));
    hydrateProtectedImageElements(slot);
  });
}

function _ensureShotMaterialPickerRoot() {
  var root = document.getElementById('shotMaterialPickerRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'shotMaterialPickerRoot';
    document.body.appendChild(root);
  }
  return root;
}

function _renderShotMaterialPickerOverlay() {
  var root = _ensureShotMaterialPickerRoot();
  var picker = materialPanelState.activePicker;
  if (!picker || picker.surface !== 'shot' || picker.groupIdx == null || !picker.open) {
    root.innerHTML = '';
    return;
  }
  var groupIdx = Number(picker.groupIdx);
  root.innerHTML = renderMaterialPickerHtml({
    panel: getMaterialPanel(groupIdx) || {},
    picker: Object.assign({ open: true }, picker),
    scope: 'shot',
    groupIdx: groupIdx,
    actionAttr: 'data-material-action',
  });
  hydrateProtectedImageElements(root);
}

function _syncFirstFrameEditorMaterialPanelFromCache(groupIdx) {
  if (!_firstFrameEditor.open || Number(_firstFrameEditor.groupIdx) !== Number(groupIdx)) return;
  if (!_firstFrameEditor.payload) return;
  var panel = getMaterialPanel(groupIdx);
  if (!panel) return;
  _firstFrameEditor.payload.firstFrameMaterialPanel = panel;
  if (_firstFrameEditor.payload.plan) _firstFrameEditor.payload.plan.firstFrameMaterialPanel = panel;
}

function _refreshMaterialPanelSlots(entries) {
  (Array.isArray(entries) ? entries : []).forEach(function (entry) {
    if (entry && entry.groupIdx != null) {
      _syncFirstFrameEditorMaterialPanelFromCache(entry.groupIdx);
      _rerenderMaterialPanelSlot(entry.groupIdx);
    }
  });
  _renderShotMaterialPickerOverlay();
}

function _ensureShotMaterialPanels(groups) {
  if (!project || !project.id || !Array.isArray(groups) || !groups.length) return;
  var needsRefresh = groups.some(function (group) {
    if (_firstFrameEditor.open && Number(_firstFrameEditor.groupIdx) === Number(group && group.groupIdx)) return false;
    return group && shouldRefreshMaterialPanel(group.groupIdx);
  });
  if (!needsRefresh) return;
  fetchMaterialPanels(project.id).then(_refreshMaterialPanelSlots).catch(function (err) {
    console.warn('[MaterialPanel] refresh failed:', (err && err.message) || err);
  });
}

export function refreshStoryboardMaterialPanels(opts) {
  if (!project || !project.id) return;
  opts = opts || {};
  var groups = getStoryboardGroups();
  if (!groups.length) return;
  if (opts.force) {
    fetchMaterialPanels(project.id).then(_refreshMaterialPanelSlots).catch(function (err) {
      console.warn('[MaterialPanel] forced refresh failed:', (err && err.message) || err);
    });
    return;
  }
  _ensureShotMaterialPanels(groups);
}

function _storyboardAssetsHtml(group) {
  var gIdx = group && typeof group.groupIdx === 'number' ? group.groupIdx : -1;
  var roleOpenClass = _isShotMaterialRolePickerOpen(gIdx) ? ' is-role-picker-open' : '';
  return '<div class="shot-material-panel-slot' + roleOpenClass + '" data-material-slot="' + gIdx + '">' +
    _shotMaterialPanelInnerHtml(gIdx) +
  '</div>';
}

function _frameButtonHtml(action, gIdx, icon, text, title, variant, disabled, extraAttrs) {
  var cls = variant === 'primary'
    ? 'bg-primary text-on-primary border-primary/20 shadow-sm hover:opacity-90'
    : 'bg-white/80 text-on-surface-variant border-white/60 hover:bg-white';
  return '<button type="button" class="flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] font-bold tracking-widest uppercase border backdrop-blur-md transition-all active:scale-95 ' + cls + '"' +
    (action ? ' data-action="' + action + '" data-gidx="' + gIdx + '"' : '') +
    (extraAttrs ? ' ' + extraAttrs : '') +
    (title ? ' title="' + escapeHtml(title) + '"' : '') +
    (disabled ? ' disabled' : '') +
    '>' +
      '<span class="material-symbols-outlined text-sm">' + icon + '</span>' +
      '<span>' + escapeHtml(text) + '</span>' +
    '</button>';
}

function _firstFrameEditButtonHtml(gIdx, sb) {
  var legacy = String((sb && sb.firstFrameMode) || '') === 'legacy_pencil';
  var title = legacy
    ? '旧版手稿首帧没有结构化生成计划，请先点击“重新生成”升级为彩色首帧后再使用编辑控制台。'
    : '查看并编辑当前首帧的生成计划';
  return _frameButtonHtml(legacy ? '' : 'edit-first-frame', gIdx, 'tune', '编辑图片', title, 'secondary', legacy);
}

function _groupShotText(group, fields, joiner) {
  fields = Array.isArray(fields) ? fields : [fields];
  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  return shots.map(function (shot) {
    for (var i = 0; i < fields.length; i += 1) {
      var value = String((shot && shot[fields[i]]) || '').trim();
      if (value) return value;
    }
    return '';
  }).filter(Boolean).join(joiner || '\n');
}

function _framePromptForPanel(kind, sb, group) {
  sb = sb || {};
  var isTail = kind === 'tail';
  var frame = (sb.frames && sb.frames[isTail ? 'tail' : 'first']) || {};
  var visualFallback = _groupShotText(group, ['visual', 'description', 'desc'], ' ');
  var cardPromptState = !isTail && group && group.groupIdx != null
    ? _firstFrameCardPromptAutosave[String(group.groupIdx)]
    : null;
  var tailCardPromptState = isTail && group && group.groupIdx != null
    ? _tailFrameCardPromptAutosave[String(group.groupIdx)]
    : null;
  var firstFrameDraftPrompt = sb.firstFrameEditDraft && sb.firstFrameEditDraft.content;
  var firstFrameBasePrompt = sb.firstFrameBasePrompt && sb.firstFrameBasePrompt.content;
  var firstFramePlanPrompt = (cardPromptState && cardPromptState.plan && cardPromptState.plan.finalPrompt)
    || (sb.plan && sb.plan.finalPrompt);
  var tailFrameDraftPrompt = sb.tailFrameEditDraft && sb.tailFrameEditDraft.content;
  var tailFrameBasePrompt = sb.tailFrameBasePrompt && sb.tailFrameBasePrompt.content;
  var tailFramePlanPrompt = (tailCardPromptState && tailCardPromptState.plan && tailCardPromptState.plan.finalPrompt) || '';
  var candidates = isTail
    ? [
      { text: tailFrameDraftPrompt, source: '尾帧草稿提示词' },
      { text: tailFrameBasePrompt, source: '尾帧当前正式提示词' },
      { text: tailFramePlanPrompt, source: '尾帧实时计划提示词' },
      { text: frame.originalPrompt, source: '尾帧原始提示词' },
      { text: sb.originalTailFramePrompt, source: '尾帧原始提示词' },
      { text: frame.prompt, source: '尾帧生成记录' },
      { text: sb.tailFramePrompt, source: '尾帧生成记录' },
    ]
    : [
      { text: firstFrameDraftPrompt, source: '首帧草稿提示词' },
      { text: firstFrameBasePrompt, source: '首帧当前正式提示词' },
      { text: firstFramePlanPrompt, source: '首帧实时计划提示词' },
    ];
  for (var i = 0; i < candidates.length; i += 1) {
    var text = String(candidates[i].text || '').trim();
    if (text) return { text: text, source: candidates[i].source };
  }
  return {
    text: isTail ? visualFallback : '',
    source: isTail ? '镜头画面描述（尾帧未生成）' : '镜头画面描述',
  };
}

function _sbFirstFrameCardPromptStatusInner(gIdx, status) {
  status = status || 'initial';
  var retryHtml = status === 'error'
    ? '<button type="button" class="sb-frame-prompt-status-retry" data-action="retry-first-frame-prompt-save" data-gidx="' + escapeHtml(gIdx) + '">重试</button>'
    : '';
  return '<span>' + escapeHtml(_ffeFieldStatusText(status)) + '</span>' + retryHtml;
}

function _sbFirstFrameCardPromptState(gIdx) {
  var key = String(gIdx);
  if (!_firstFrameCardPromptAutosave[key]) {
    _firstFrameCardPromptAutosave[key] = {
      hydrated: false,
      hydrating: null,
      draft: null,
      plan: null,
      sourceHash: '',
      savedDraftFingerprint: '',
      expectedFingerprint: '',
      lastSavedDraftJson: '{}',
      pendingDraftJson: '{}',
      pendingDraft: null,
      dirtyAt: null,
      debounceTimer: null,
      maxWaitTimer: null,
      inFlightPromise: null,
      composing: false,
      status: 'initial',
      errorCode: '',
      errorMessage: '',
      staleWasShown: false,
      staleNoticeShown: false,
      draftCommitRefreshPending: false,
    };
  }
  return _firstFrameCardPromptAutosave[key];
}

function _sbFirstFrameCardPromptTextarea(gIdx) {
  return document.querySelector('textarea[data-sb-first-prompt-field="content"][data-gidx="' + String(gIdx) + '"]');
}

function _sbFirstFrameCardPromptStatus(gIdx, sb) {
  var state = _firstFrameCardPromptAutosave[String(gIdx)];
  if (state && state.status) return state.status;
  return _ffeSavedFieldStatus('content', sb && sb.firstFrameEditDraft);
}

function _sbFirstFrameCardPromptStatusHtml(gIdx, sb) {
  var status = _sbFirstFrameCardPromptStatus(gIdx, sb);
  return '<div class="sb-frame-prompt-status" data-sb-first-prompt-status="' + escapeHtml(gIdx) + '" data-status="' + escapeHtml(status) + '">' +
    _sbFirstFrameCardPromptStatusInner(gIdx, status) +
  '</div>';
}

function _sbSetFirstFrameCardPromptStatus(gIdx, status, message, code) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  state.status = status || 'initial';
  state.errorMessage = message || '';
  state.errorCode = code || '';
  var node = document.querySelector('[data-sb-first-prompt-status="' + String(gIdx) + '"]');
  if (!node) return;
  node.dataset.status = state.status;
  node.title = state.errorMessage || '';
  node.innerHTML = _sbFirstFrameCardPromptStatusInner(gIdx, state.status);
}

function _sbFramePromptReadonlyStatusHtml(text) {
  return '<div class="sb-frame-prompt-status" data-status="readonly">' + escapeHtml(text || '只读展示') + '</div>';
}

function _sbEscapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _sbFrameSafetyHighlightHtml(text, terms) {
  text = String(text || '');
  terms = Array.isArray(terms) ? terms : [];
  if (!text || !terms.length) return escapeHtml(text);
  var ranges = [];
  terms.forEach(function (rawTerm) {
    var term = String(rawTerm || '').trim();
    if (term.length < 2) return;
    var re = new RegExp(_sbEscapeRegExp(term), 'g');
    var match;
    while ((match = re.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) re.lastIndex++;
    }
  });
  if (!ranges.length) return escapeHtml(text);
  ranges.sort(function (a, b) {
    return a.start === b.start ? b.end - a.end : a.start - b.start;
  });
  var merged = [];
  ranges.forEach(function (range) {
    var last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ start: range.start, end: range.end });
    else if (range.end > last.end) last.end = range.end;
  });
  var html = '';
  var cursor = 0;
  merged.forEach(function (range) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += '<mark class="sb-frame-safety-mark">' + escapeHtml(text.slice(range.start, range.end)) + '</mark>';
    cursor = range.end;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

function _sbSyncFramePromptSafetyHighlight(el) {
  if (!el || !el.matches) return;
  var isFirstPrompt = el.matches('textarea[data-sb-first-prompt-field="content"]');
  var isTailPrompt = el.matches('textarea[data-sb-tail-prompt-field="content"]');
  if (!isFirstPrompt && !isTailPrompt) return;
  var wrap = el.closest('.sb-frame-prompt-highlight-wrap');
  if (!wrap) return;
  var layer = wrap.querySelector('.sb-frame-prompt-highlight');
  if (!layer) return;
  var gIdx = parseInt(el.dataset.gidx, 10);
  var sb = !isNaN(gIdx) && project && project.storyboards ? project.storyboards[gIdx] : null;
  var info = isTailPrompt ? _tailFrameSafetyInfo(sb || {}) : _firstFrameSafetyInfo(sb || {});
  var terms = info && Array.isArray(info.terms) ? info.terms : [];
  layer.innerHTML = _sbFrameSafetyHighlightHtml(el.value || '', terms);
  layer.scrollTop = el.scrollTop || 0;
  layer.scrollLeft = el.scrollLeft || 0;
}

function _sbSyncFramePromptSafetyHighlights(root) {
  if (!root) return;
  Array.prototype.slice.call(root.querySelectorAll(
    'textarea[data-sb-first-prompt-field="content"], textarea[data-sb-tail-prompt-field="content"]'
  )).forEach(_sbSyncFramePromptSafetyHighlight);
}

function _sbFirstFramePromptEditorHtml(gIdx, text, opts) {
  opts = opts || {};
  var readOnly = opts.readOnly === true;
  var mirror = opts.mirror === true;
  var placeholder = opts.placeholder || '首帧提示词待生成。';
  var safetyInfo = opts.safetyInfo || null;
  var safetyTerms = safetyInfo && Array.isArray(safetyInfo.terms) ? safetyInfo.terms : [];
  var useHighlight = !readOnly && !mirror && safetyTerms.length > 0;
  var dataAttrs = mirror
    ? ' data-sb-prompt-mirror="first" data-source-gidx="' + escapeHtml(gIdx) + '"'
    : ' data-sb-first-prompt-field="content" data-gidx="' + escapeHtml(gIdx) + '"';
  var readOnlyAttrs = readOnly
    ? ' readonly aria-readonly="true" title="' + escapeHtml(opts.title || '此处为片段提示词展示') + '"'
    : '';
  var textareaHtml = '<textarea class="sb-frame-text-box sb-frame-prompt-editor' + (useHighlight ? ' has-safety-highlight' : '') + '" ' + dataAttrs + ' maxlength="' + FFE_PROMPT_OVERRIDE_MAX_CHARS + '" rows="18" placeholder="' + escapeHtml(placeholder) + '"' + readOnlyAttrs + '>' +
    escapeHtml(text || '') +
  '</textarea>';
  if (!useHighlight) return textareaHtml;
  return '<div class="sb-frame-prompt-highlight-wrap" data-sb-safety-highlight-wrap="first" data-gidx="' + escapeHtml(gIdx) + '">' +
    '<div class="sb-frame-prompt-highlight" aria-hidden="true">' + _sbFrameSafetyHighlightHtml(text || '', safetyTerms) + '</div>' +
    textareaHtml +
  '</div>';
}

function _sbFirstFrameCardBaseDraft(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (state.draft && typeof state.draft === 'object') return _ffeCloneDraft(state.draft);
  var sb = project && project.storyboards && project.storyboards[gIdx] || {};
  return _ffeCloneDraft(sb.firstFrameEditDraft || {});
}

function _sbFirstFrameCardDraftWithContent(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  var el = _sbFirstFrameCardPromptTextarea(gIdx);
  if (!el) return _ffeCloneDraft(state.pendingDraft || state.draft || (project && project.storyboards && project.storyboards[gIdx] && project.storyboards[gIdx].firstFrameEditDraft) || {});
  var content = _ffeCleanDraftText(el ? el.value : '', FFE_PROMPT_OVERRIDE_MAX_CHARS);
  var draft = _sbFirstFrameCardBaseDraft(gIdx);
  if (content) draft.content = content;
  else delete draft.content;
  return draft;
}

function _sbRefreshFirstFrameCardPendingDraft(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  var draft = _sbFirstFrameCardDraftWithContent(gIdx);
  state.pendingDraft = draft;
  state.pendingDraftJson = _ffeDraftJson(draft);
  return { draft: draft, json: state.pendingDraftJson };
}

function _sbFirstFrameCardHasPendingChanges(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  _sbRefreshFirstFrameCardPendingDraft(gIdx);
  return state.pendingDraftJson !== state.lastSavedDraftJson;
}

function _sbApplyFirstFrameCardPromptDraftResponse(gIdx, resp, options) {
  options = options || {};
  resp = resp || {};
  var hasDraft = Object.prototype.hasOwnProperty.call(resp, 'draft');
  if (project) {
    if (!project.storyboards) project.storyboards = [];
    if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
    if (hasDraft) project.storyboards[gIdx].firstFrameEditDraft = resp.draft || null;
    if (resp.firstFrameBasePrompt) project.storyboards[gIdx].firstFrameBasePrompt = resp.firstFrameBasePrompt;
    if (resp.firstFrameBackup) project.storyboards[gIdx].firstFrameBackup = resp.firstFrameBackup;
  }

  var state = _firstFrameCardPromptAutosave[String(gIdx)];
  if (!state) return;
  var hadDirtyAt = !!state.dirtyAt;
  var nextDraft = hasDraft
    ? _ffeCloneDraft(resp.draft || {})
    : _ffeCloneDraft(project && project.storyboards && project.storyboards[gIdx] && project.storyboards[gIdx].firstFrameEditDraft || {});
  if (resp.plan) state.plan = resp.plan;
  if (Object.prototype.hasOwnProperty.call(resp, 'sourceHash')) state.sourceHash = String(resp.sourceHash || '');
  if (Object.prototype.hasOwnProperty.call(resp, 'savedDraftFingerprint')) {
    state.savedDraftFingerprint = String(resp.savedDraftFingerprint || '');
    state.expectedFingerprint = state.savedDraftFingerprint;
  }
  if (options.clearDraftCommitRefreshPending === true || !hasDraft || !resp.draft) {
    state.draftCommitRefreshPending = false;
  }
  state.draft = nextDraft;
  state.lastSavedDraftJson = _ffeDraftJson(state.draft);
  state.pendingDraftJson = state.lastSavedDraftJson;
  state.pendingDraft = _ffeCloneDraft(state.draft);
  state.hydrated = true;

  if (options.preserveTextarea === true) {
    var pending = _sbRefreshFirstFrameCardPendingDraft(gIdx);
    state.dirtyAt = hadDirtyAt && pending.json !== state.lastSavedDraftJson ? (state.dirtyAt || Date.now()) : null;
  } else {
    state.dirtyAt = null;
  }

  state.errorCode = '';
  state.errorMessage = '';
  if (state.status !== 'saving') {
    state.status = _ffeSavedFieldStatus('content', state.draft);
    _sbSetFirstFrameCardPromptStatus(gIdx, state.status);
  }
}

function _sbMarkFirstFrameCardPromptDraftCommitPending(gIdx) {
  var state = _firstFrameCardPromptAutosave[String(gIdx)];
  if (!state) return;
  state.draftCommitRefreshPending = true;
}

function _sbMarkFirstFrameCardPromptDraftCommitPendingForTargets(targets) {
  (Array.isArray(targets) ? targets : []).forEach(function (target) {
    var gIdx = Number(target && target.groupIdx);
    if (Number.isFinite(gIdx)) _sbMarkFirstFrameCardPromptDraftCommitPending(gIdx);
  });
}

async function _sbRefreshFirstFrameCardPromptBaselineFromServer(gIdx, options) {
  options = options || {};
  if (!project || !project.id || gIdx == null) return null;
  var payload = await apiGet('/api/frames/plan?projectId=' + encodeURIComponent(project.id) + '&groupIdx=' + encodeURIComponent(gIdx) + '&frameType=first_frame');
  _sbApplyFirstFrameCardPromptDraftResponse(gIdx, payload, {
    preserveTextarea: options.preserveTextarea !== false,
    clearDraftCommitRefreshPending: options.clearDraftCommitRefreshPending === true,
  });
  return payload;
}

async function _sbRefreshFirstFrameCardPromptBaselinesFromServer(targets, options) {
  var seen = {};
  for (var i = 0; i < (Array.isArray(targets) ? targets.length : 0); i += 1) {
    var gIdx = Number(targets[i] && targets[i].groupIdx);
    if (!Number.isFinite(gIdx) || seen[gIdx]) continue;
    seen[gIdx] = true;
    try {
      await _sbRefreshFirstFrameCardPromptBaselineFromServer(gIdx, options);
    } catch (err) {
      console.warn('[first-frame-card-prompt] baseline refresh after draft commit failed:', {
        groupIdx: gIdx,
        error: (err && err.message) || err,
      });
    }
  }
}

var _sbFirstFramePromptHydrateToast = { message: '', at: 0 };

function _sbShowFirstFramePromptHydrateError(gIdx, err) {
  var message = '首帧提示词状态加载失败，请稍后重试';
  var detail = _diagnoseApiError(((err && err.message) || err || '').toString());
  console.warn('[first-frame-card-prompt] interactive hydrate failed:', {
    groupIdx: gIdx,
    detail: detail,
    error: err,
  });
  var now = Date.now();
  var key = message + '|' + detail;
  if (_sbFirstFramePromptHydrateToast.message === key && now - _sbFirstFramePromptHydrateToast.at < 3500) return;
  _sbFirstFramePromptHydrateToast = { message: key, at: now };
  showToast(message, 'error');
}

function _sbMergeFirstFrameCardPlanPayload(gIdx, payload) {
  payload = payload || {};
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var sb = project.storyboards[gIdx];
  if (Object.prototype.hasOwnProperty.call(payload, 'draft')) sb.firstFrameEditDraft = payload.draft || null;
  if (payload.firstFrameBasePrompt) sb.firstFrameBasePrompt = payload.firstFrameBasePrompt;
  if (payload.firstFrameBackup) sb.firstFrameBackup = payload.firstFrameBackup;
  state.plan = payload.plan || state.plan || null;
  state.sourceHash = String(payload.sourceHash || '');
  state.savedDraftFingerprint = String(payload.savedDraftFingerprint || '');
  state.expectedFingerprint = state.savedDraftFingerprint;
  state.draft = _ffeCloneDraft(payload.draft || {});
  state.lastSavedDraftJson = _ffeDraftJson(state.draft);
  state.pendingDraftJson = state.lastSavedDraftJson;
  state.pendingDraft = _ffeCloneDraft(state.draft);
  state.hydrated = true;
  state.staleWasShown = !!(payload.draftStale || payload.firstFrameBasePromptStale);
  if (state.status !== 'saving') {
    state.status = _ffeSavedFieldStatus('content', state.draft);
    state.errorCode = '';
    state.errorMessage = '';
  }
  _sbSetFirstFrameCardPromptStatus(gIdx, state.status);
}

async function _sbEnsureFirstFrameCardPromptState(gIdx, options) {
  options = options || {};
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (state.hydrated && options.force !== true) return state;
  if (state.hydrating) return await state.hydrating;
  state.hydrating = (async function () {
    try {
      if (!project || !project.id) throw new Error('项目未加载');
      var payload = await apiGet('/api/frames/plan?projectId=' + encodeURIComponent(project.id) + '&groupIdx=' + encodeURIComponent(gIdx) + '&frameType=first_frame');
      _sbMergeFirstFrameCardPlanPayload(gIdx, payload);
      return _sbFirstFrameCardPromptState(gIdx);
    } catch (err) {
      _sbSetFirstFrameCardPromptStatus(gIdx, 'error', _diagnoseApiError(((err && err.message) || err).toString()), 'hydrate_failed');
      throw err;
    } finally {
      state.hydrating = null;
    }
  })();
  return await state.hydrating;
}

function _sbFirstFrameCardPromptText(gIdx) {
  var sb = project && project.storyboards && project.storyboards[gIdx] || {};
  var groups = getStoryboardGroups();
  var group = groups.find(function (item) { return Number(item.groupIdx) === Number(gIdx); }) || { groupIdx: gIdx };
  return _framePromptForPanel('first', sb, group).text || '';
}

async function _sbHydrateFirstFramePromptEditor(gIdx, el) {
  var beforeValue = String(el && el.value || '');
  var state = _sbFirstFrameCardPromptState(gIdx);
  try {
    await _sbEnsureFirstFrameCardPromptState(gIdx);
    var currentEl = _sbFirstFrameCardPromptTextarea(gIdx);
    if (currentEl && currentEl === el && !state.dirtyAt && String(currentEl.value || '') === beforeValue) {
      currentEl.value = _sbFirstFrameCardPromptText(gIdx);
    }
    _sbSyncFramePromptSafetyHighlight(currentEl || el);
    _sbRefreshFirstFrameCardPendingDraft(gIdx);
    _sbSetFirstFrameCardPromptStatus(gIdx, _sbFirstFrameCardPromptStatus(gIdx, project.storyboards && project.storyboards[gIdx]));
  } catch (err) {
    _sbShowFirstFramePromptHydrateError(gIdx, err);
  }
}

function _sbHydrateFirstFramePromptEditors(root) {
  if (!root || !project || !project.id) return;
  Array.prototype.slice.call(root.querySelectorAll('textarea[data-sb-first-prompt-field="content"]')).forEach(function (el) {
    var gIdx = parseInt(el.dataset.gidx, 10);
    if (isNaN(gIdx)) return;
    var state = _sbFirstFrameCardPromptState(gIdx);
    if (state.hydrated || state.hydrating) return;
    var beforeValue = String(el.value || '');
    _sbEnsureFirstFrameCardPromptState(gIdx).then(function () {
      var currentEl = _sbFirstFrameCardPromptTextarea(gIdx);
      if (!currentEl) return;
      var nextText = _sbFirstFrameCardPromptText(gIdx);
      if (!state.dirtyAt && String(currentEl.value || '') === beforeValue) {
        currentEl.value = nextText;
      }
      _sbSyncFramePromptSafetyHighlight(currentEl);
      _sbRefreshFirstFrameCardPendingDraft(gIdx);
      _sbSetFirstFrameCardPromptStatus(gIdx, _sbFirstFrameCardPromptStatus(gIdx, project.storyboards && project.storyboards[gIdx]));
    }).catch(function (err) {
      console.warn('[first-frame-card-prompt] hydrate failed:', err);
    });
  });
}

function _sbClearFirstFrameCardPromptTimers(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.maxWaitTimer) clearTimeout(state.maxWaitTimer);
  state.debounceTimer = null;
  state.maxWaitTimer = null;
}

async function _sbRunFirstFrameCardPromptSave(gIdx, options) {
  options = options || {};
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (!project || !project.id) return { ok: false, code: 'missing_project' };
  if (state.inFlightPromise) return await state.inFlightPromise;
  _sbClearFirstFrameCardPromptTimers(gIdx);
  state.inFlightPromise = (async function () {
    try {
      await _sbEnsureFirstFrameCardPromptState(gIdx);
      if (state.draftCommitRefreshPending) {
        await _sbRefreshFirstFrameCardPromptBaselineFromServer(gIdx, { preserveTextarea: true });
      }
      var snapshot = _sbRefreshFirstFrameCardPendingDraft(gIdx);
      if (!options.forceSave && snapshot.json === state.lastSavedDraftJson) {
        _sbSetFirstFrameCardPromptStatus(gIdx, _ffeSavedFieldStatus('content', state.draft));
        return { ok: true, skipped: true };
      }
      _sbSetFirstFrameCardPromptStatus(gIdx, 'saving');
      var postSnapshot = async function (draftSnapshot) {
        return await apiPost('/api/frames/edit-draft', {
          projectId: project.id,
          groupIdx: gIdx,
          draft: draftSnapshot.draft || {},
          expectedSavedDraftFingerprint: state.expectedFingerprint || state.savedDraftFingerprint || '',
          force: options.force === true,
        }, 'PUT');
      };
      var resp;
      try {
        resp = await postSnapshot(snapshot);
      } catch (postErr) {
        var postPayload = postErr && postErr.payload || {};
        if (postPayload.code !== 'saved_draft_changed' || !state.draftCommitRefreshPending || options.force === true) throw postErr;
        await _sbRefreshFirstFrameCardPromptBaselineFromServer(gIdx, {
          preserveTextarea: true,
          clearDraftCommitRefreshPending: true,
        });
        snapshot = _sbRefreshFirstFrameCardPendingDraft(gIdx);
        resp = await postSnapshot(snapshot);
      }
      _sbApplyFirstFrameCardPromptDraftResponse(gIdx, resp);
      var nextStatus = _ffeSavedFieldStatus('content', state.draft);
      _sbSetFirstFrameCardPromptStatus(gIdx, nextStatus);
      if (state.staleWasShown && !state.staleNoticeShown) {
        state.staleNoticeShown = true;
        showToast('已按当前镜头/资产/风格上下文保存', 'success');
      }
      return { ok: true, resp: resp };
    } catch (err) {
      var payload = err && err.payload || {};
      var code = payload.code || 'save_failed';
      var msg = payload.error || _diagnoseApiError(((err && err.message) || err).toString());
      _sbSetFirstFrameCardPromptStatus(gIdx, 'error', msg, code);
      if (code === 'saved_draft_changed') showToast('草稿在另一处被修改，请重试或刷新后继续。', 'warn');
      else if (code === 'validation_failed') showToast('草稿校验失败，请检查提示词。', 'warn');
      else showToast('自动保存失败: ' + msg, 'error');
      return { ok: false, code: code, payload: payload };
    } finally {
      state.inFlightPromise = null;
    }
  })();
  return await state.inFlightPromise;
}

function _sbScheduleFirstFrameCardPromptSave(gIdx, options) {
  options = options || {};
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (state.composing) return;
  _sbRefreshFirstFrameCardPendingDraft(gIdx);
  if (state.pendingDraftJson === state.lastSavedDraftJson) {
    state.dirtyAt = null;
    _sbSetFirstFrameCardPromptStatus(gIdx, _ffeSavedFieldStatus('content', state.draft));
    return;
  }
  if (!state.dirtyAt) state.dirtyAt = Date.now();
  _sbClearFirstFrameCardPromptTimers(gIdx);
  var run = function () {
    _sbRunFirstFrameCardPromptSave(gIdx, { source: options.source || 'card-autosave' }).then(function (result) {
      _sbRefreshFirstFrameCardPendingDraft(gIdx);
      if (result && result.ok && _sbFirstFrameCardPromptState(gIdx).pendingDraftJson !== _sbFirstFrameCardPromptState(gIdx).lastSavedDraftJson) {
        _sbScheduleFirstFrameCardPromptSave(gIdx, { source: 'card-autosave-followup' });
      }
    });
  };
  if (options.immediate) {
    run();
    return;
  }
  state.debounceTimer = setTimeout(run, FFE_AUTOSAVE_DEBOUNCE_MS);
  var waitMs = Math.max(0, state.dirtyAt + FFE_AUTOSAVE_MAX_WAIT_MS - Date.now());
  state.maxWaitTimer = setTimeout(run, waitMs);
}

async function _sbRetryFirstFrameCardPromptSave(gIdx) {
  var state = _sbFirstFrameCardPromptState(gIdx);
  if (state.errorCode === 'saved_draft_changed') {
    var overwrite = window.confirm('草稿在另一处被修改，是否用本卡片里的版本覆盖？');
    if (!overwrite) {
      var refresh = window.confirm('是否刷新到最新草稿？刷新会放弃本卡片未保存修改。');
      if (refresh) {
        state.hydrated = false;
        state.dirtyAt = null;
        await _sbEnsureFirstFrameCardPromptState(gIdx, { force: true });
        var el = _sbFirstFrameCardPromptTextarea(gIdx);
        if (el) el.value = _sbFirstFrameCardPromptText(gIdx);
      }
      return;
    }
    await _sbRunFirstFrameCardPromptSave(gIdx, { force: true, forceSave: true });
    return;
  }
  await _sbRunFirstFrameCardPromptSave(gIdx, { forceSave: true });
}

function _sbAnyFirstFrameCardPromptUnsaved() {
  return Object.keys(_firstFrameCardPromptAutosave).some(function (key) {
    var state = _firstFrameCardPromptAutosave[key];
    if (!state) return false;
    var gIdx = Number(key);
    if (!Number.isFinite(gIdx)) return false;
    return _sbFirstFrameCardHasPendingChanges(gIdx);
  });
}

function _sbFlushFirstFrameCardPromptsOnPageHide() {
  Object.keys(_firstFrameCardPromptAutosave).forEach(function (key) {
    var gIdx = Number(key);
    var state = _firstFrameCardPromptAutosave[key];
    if (!Number.isFinite(gIdx) || !state || !project || !project.id) return;
    var pending = _sbRefreshFirstFrameCardPendingDraft(gIdx);
    if (pending.json === state.lastSavedDraftJson) return;
    try {
      fetch('/api/frames/edit-draft', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          projectId: project.id,
          groupIdx: gIdx,
          draft: pending.draft || {},
          expectedSavedDraftFingerprint: state.expectedFingerprint || state.savedDraftFingerprint || '',
          force: true,
        }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  });
}

function _sbTailFrameCardPromptStatusInner(gIdx, status) {
  status = status || 'initial';
  var retryHtml = status === 'error'
    ? '<button type="button" class="sb-frame-prompt-status-retry" data-action="retry-tail-frame-prompt-save" data-gidx="' + escapeHtml(gIdx) + '">重试</button>'
    : '';
  var restoreHtml = '<button type="button" class="sb-frame-prompt-status-action" data-action="restore-tail-frame-prompt" data-gidx="' + escapeHtml(gIdx) + '">恢复</button>';
  return '<span>' + escapeHtml(_ffeFieldStatusText(status)) + '</span>' + retryHtml + restoreHtml;
}

function _sbTailFrameCardPromptState(gIdx) {
  var key = String(gIdx);
  if (!_tailFrameCardPromptAutosave[key]) {
    _tailFrameCardPromptAutosave[key] = {
      hydrated: false,
      hydrating: null,
      draft: null,
      plan: null,
      sourceHash: '',
      savedDraftFingerprint: '',
      expectedFingerprint: '',
      lastSavedDraftJson: '{}',
      pendingDraftJson: '{}',
      pendingDraft: null,
      dirtyAt: null,
      debounceTimer: null,
      maxWaitTimer: null,
      inFlightPromise: null,
      composing: false,
      status: 'initial',
      errorCode: '',
      errorMessage: '',
      staleWasShown: false,
      staleNoticeShown: false,
      preflight: null,
    };
  }
  return _tailFrameCardPromptAutosave[key];
}

/**
 * D (字段对齐方案选项 D): 首帧刚写入/就绪时, 作废该组尾帧提示词的就绪缓存。
 * _sbEnsureTailFrameCardPromptState 在 hydrated=true 时会短路返回缓存的 preflight
 * (line 1764); 若该缓存是"首帧未就绪"时拉取的, 首帧补齐后仍会残留陈旧 preflight,
 * 导致点"生成尾帧"时 _sbRunTailFrameCardPromptSave 仍判 readOnly 并弹出旧的
 * "片段 N 首帧未就绪"提示 (generateStoryboardTailFrame line 6343)。
 * 这里清掉缓存的 preflight, 并在安全时 (无在途请求/无未保存草稿) 重置 hydrated,
 * 强制下次重新向后端拉取真实就绪态。见 docs/first-frame-url-field-alignment-proposal.md。
 */
function _invalidateTailFramePromptReadiness(gIdx) {
  if (gIdx === null || gIdx === undefined) return;
  var state = _tailFrameCardPromptAutosave[String(gIdx)];
  if (!state) return;
  state.preflight = null;
  // 首帧未就绪期尾帧提示词为只读, 正常不会有脏草稿; 这里仍兜底避免覆盖在途请求/用户编辑。
  if (!state.hydrating && !state.inFlightPromise && !state.dirtyAt) {
    state.hydrated = false;
  }
}

function _sbTailFrameCardPromptTextarea(gIdx) {
  return document.querySelector('textarea[data-sb-tail-prompt-field="content"][data-gidx="' + String(gIdx) + '"]');
}

function _sbTailFrameCardPromptStatus(gIdx, sb) {
  var state = _tailFrameCardPromptAutosave[String(gIdx)];
  if (state && state.status) return state.status;
  return _ffeSavedFieldStatus('content', sb && sb.tailFrameEditDraft);
}

function _sbTailFramePromptReadOnly(gIdx, sb) {
  sb = sb || (project && project.storyboards && project.storyboards[gIdx]) || {};
  var groups = getStoryboardGroups();
  var group = groups[gIdx] || {};
  var intent = _tailFrameGenerationIntentForGroup(group, sb);
  if (!intent.canGenerate) return true;
  var state = _tailFrameCardPromptAutosave[String(gIdx)];
  return !!(state && state.preflight && state.preflight.allowed === false);
}

function _sbTailFrameCardPromptStatusHtml(gIdx, sb) {
  var status = _sbTailFrameCardPromptStatus(gIdx, sb);
  return '<div class="sb-frame-prompt-status" data-sb-tail-prompt-status="' + escapeHtml(gIdx) + '" data-status="' + escapeHtml(status) + '">' +
    _sbTailFrameCardPromptStatusInner(gIdx, status) +
  '</div>';
}

function _sbSetTailFrameCardPromptStatus(gIdx, status, message, code) {
  var state = _sbTailFrameCardPromptState(gIdx);
  state.status = status || 'initial';
  state.errorMessage = message || '';
  state.errorCode = code || '';
  var node = document.querySelector('[data-sb-tail-prompt-status="' + String(gIdx) + '"]');
  if (!node) return;
  node.dataset.status = state.status;
  node.title = state.errorMessage || '';
  node.innerHTML = _sbTailFrameCardPromptStatusInner(gIdx, state.status);
}

function _sbTailFramePromptEditorHtml(gIdx, text, opts) {
  opts = opts || {};
  var readOnly = opts.readOnly === true;
  var mirror = opts.mirror === true;
  var safetyInfo = opts.safetyInfo || null;
  var safetyTerms = safetyInfo && Array.isArray(safetyInfo.terms) ? safetyInfo.terms : [];
  var useHighlight = !readOnly && !mirror && safetyTerms.length > 0;
  var dataAttrs = mirror
    ? ' data-sb-prompt-mirror="tail" data-source-gidx="' + escapeHtml(gIdx) + '"'
    : ' data-sb-tail-prompt-field="content" data-gidx="' + escapeHtml(gIdx) + '"';
  var readOnlyAttrs = readOnly
    ? ' readonly aria-readonly="true" title="' + escapeHtml(opts.title || '需先完成彩色视频首帧后才能编辑尾帧提示词') + '"'
    : '';
  var textareaHtml = '<textarea class="sb-frame-text-box sb-frame-prompt-editor' + (useHighlight ? ' has-safety-highlight' : '') + '" ' + dataAttrs + ' maxlength="' + FFE_PROMPT_OVERRIDE_MAX_CHARS + '" rows="18" placeholder="尾帧提示词待生成。"' + readOnlyAttrs + '>' +
    escapeHtml(text || '') +
  '</textarea>';
  if (!useHighlight) return textareaHtml;
  return '<div class="sb-frame-prompt-highlight-wrap" data-sb-safety-highlight-wrap="tail" data-gidx="' + escapeHtml(gIdx) + '">' +
    '<div class="sb-frame-prompt-highlight" aria-hidden="true">' + _sbFrameSafetyHighlightHtml(text || '', safetyTerms) + '</div>' +
    textareaHtml +
  '</div>';
}

function _sbTailFrameCardBaseDraft(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  if (state.draft && typeof state.draft === 'object') return _ffeCloneDraft(state.draft);
  var sb = project && project.storyboards && project.storyboards[gIdx] || {};
  return _ffeCloneDraft(sb.tailFrameEditDraft || {});
}

function _sbTailFrameCardDraftWithContent(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  var el = _sbTailFrameCardPromptTextarea(gIdx);
  if (!el) return _ffeCloneDraft(state.pendingDraft || state.draft || (project && project.storyboards && project.storyboards[gIdx] && project.storyboards[gIdx].tailFrameEditDraft) || {});
  var content = _ffeCleanDraftText(el ? el.value : '', FFE_PROMPT_OVERRIDE_MAX_CHARS);
  var draft = _sbTailFrameCardBaseDraft(gIdx);
  if (content) draft.content = content;
  else delete draft.content;
  return draft;
}

function _sbRefreshTailFrameCardPendingDraft(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  var draft = _sbTailFrameCardDraftWithContent(gIdx);
  state.pendingDraft = draft;
  state.pendingDraftJson = _ffeDraftJson(draft);
  return { draft: draft, json: state.pendingDraftJson };
}

function _sbTailFrameCardHasPendingChanges(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  _sbRefreshTailFrameCardPendingDraft(gIdx);
  return state.pendingDraftJson !== state.lastSavedDraftJson;
}

function _sbMergeTailFrameCardPlanPayload(gIdx, payload) {
  payload = payload || {};
  var state = _sbTailFrameCardPromptState(gIdx);
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var sb = project.storyboards[gIdx];
  if (Object.prototype.hasOwnProperty.call(payload, 'draft')) sb.tailFrameEditDraft = payload.draft || null;
  if (payload.tailFrameBasePrompt) sb.tailFrameBasePrompt = payload.tailFrameBasePrompt;
  if (payload.tailFrameBackup) sb.tailFrameBackup = payload.tailFrameBackup;
  if (Array.isArray(payload.tailFrameHistory)) sb.tailFrameHistory = payload.tailFrameHistory;
  state.plan = payload.plan || state.plan || null;
  state.preflight = payload.preflight || null;
  state.sourceHash = String(payload.sourceHash || '');
  state.savedDraftFingerprint = String(payload.savedDraftFingerprint || '');
  state.expectedFingerprint = state.savedDraftFingerprint;
  state.draft = _ffeCloneDraft(payload.draft || {});
  state.lastSavedDraftJson = _ffeDraftJson(state.draft);
  state.pendingDraftJson = state.lastSavedDraftJson;
  state.pendingDraft = _ffeCloneDraft(state.draft);
  state.hydrated = true;
  state.staleWasShown = !!(payload.draftStale || payload.tailFrameBasePromptStale);
  if (state.status !== 'saving') {
    state.status = _ffeSavedFieldStatus('content', state.draft);
    state.errorCode = '';
    state.errorMessage = '';
  }
  var el = _sbTailFrameCardPromptTextarea(gIdx);
  if (el) {
    var readOnly = _sbTailFramePromptReadOnly(gIdx, sb);
    el.readOnly = readOnly;
    if (readOnly) {
      el.setAttribute('aria-readonly', 'true');
      el.title = (state.preflight && state.preflight.message) || '需先完成彩色视频首帧后才能编辑尾帧提示词';
    } else {
      el.removeAttribute('aria-readonly');
      el.title = '';
    }
  }
  _sbSetTailFrameCardPromptStatus(gIdx, state.status);
}

async function _sbEnsureTailFrameCardPromptState(gIdx, options) {
  options = options || {};
  var state = _sbTailFrameCardPromptState(gIdx);
  if (state.hydrated && options.force !== true) return state;
  if (state.hydrating) return await state.hydrating;
  state.hydrating = (async function () {
    try {
      if (!project || !project.id) throw new Error('项目未加载');
      var payload = await apiGet('/api/frames/plan?projectId=' + encodeURIComponent(project.id) + '&groupIdx=' + encodeURIComponent(gIdx) + '&frameType=tail_frame');
      _sbMergeTailFrameCardPlanPayload(gIdx, payload);
      return _sbTailFrameCardPromptState(gIdx);
    } catch (err) {
      _sbSetTailFrameCardPromptStatus(gIdx, 'error', _diagnoseApiError(((err && err.message) || err).toString()), 'hydrate_failed');
      throw err;
    } finally {
      state.hydrating = null;
    }
  })();
  return await state.hydrating;
}

function _sbTailFrameCardPromptText(gIdx) {
  var sb = project && project.storyboards && project.storyboards[gIdx] || {};
  var groups = getStoryboardGroups();
  var group = groups.find(function (item) { return Number(item.groupIdx) === Number(gIdx); }) || { groupIdx: gIdx };
  return _framePromptForPanel('tail', sb, group).text || '';
}

async function _sbHydrateTailFramePromptEditor(gIdx, el) {
  var beforeValue = String(el && el.value || '');
  var state = _sbTailFrameCardPromptState(gIdx);
  try {
    await _sbEnsureTailFrameCardPromptState(gIdx);
    var currentEl = _sbTailFrameCardPromptTextarea(gIdx);
    if (currentEl && currentEl === el && !state.dirtyAt && String(currentEl.value || '') === beforeValue) {
      currentEl.value = _sbTailFrameCardPromptText(gIdx);
    }
    _sbSyncFramePromptSafetyHighlight(currentEl || el);
    _sbRefreshTailFrameCardPendingDraft(gIdx);
    _sbSetTailFrameCardPromptStatus(gIdx, _sbTailFrameCardPromptStatus(gIdx, project.storyboards && project.storyboards[gIdx]));
  } catch (_) {
    showToast('尾帧提示词状态加载失败，请稍后重试', 'error');
  }
}

function _sbHydrateTailFramePromptEditors(root) {
  if (!root || !project || !project.id) return;
  Array.prototype.slice.call(root.querySelectorAll('textarea[data-sb-tail-prompt-field="content"]')).forEach(function (el) {
    var gIdx = parseInt(el.dataset.gidx, 10);
    if (isNaN(gIdx)) return;
    var state = _sbTailFrameCardPromptState(gIdx);
    if (state.hydrated || state.hydrating) return;
    var beforeValue = String(el.value || '');
    _sbEnsureTailFrameCardPromptState(gIdx).then(function () {
      var currentEl = _sbTailFrameCardPromptTextarea(gIdx);
      if (!currentEl) return;
      var nextText = _sbTailFrameCardPromptText(gIdx);
      if (!state.dirtyAt && String(currentEl.value || '') === beforeValue) {
        currentEl.value = nextText;
      }
      _sbSyncFramePromptSafetyHighlight(currentEl);
      _sbRefreshTailFrameCardPendingDraft(gIdx);
      _sbSetTailFrameCardPromptStatus(gIdx, _sbTailFrameCardPromptStatus(gIdx, project.storyboards && project.storyboards[gIdx]));
    }).catch(function (err) {
      console.warn('[tail-frame-card-prompt] hydrate failed:', err);
    });
  });
}

function _sbClearTailFrameCardPromptTimers(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  if (state.maxWaitTimer) clearTimeout(state.maxWaitTimer);
  state.debounceTimer = null;
  state.maxWaitTimer = null;
}

async function _sbRunTailFrameCardPromptSave(gIdx, options) {
  options = options || {};
  var state = _sbTailFrameCardPromptState(gIdx);
  if (!project || !project.id) return { ok: false, code: 'missing_project' };
  if (state.inFlightPromise) return await state.inFlightPromise;
  _sbClearTailFrameCardPromptTimers(gIdx);
  state.inFlightPromise = (async function () {
    try {
      await _sbEnsureTailFrameCardPromptState(gIdx);
      if (_sbTailFramePromptReadOnly(gIdx, project && project.storyboards && project.storyboards[gIdx])) {
        _sbSetTailFrameCardPromptStatus(gIdx, 'initial');
        return { ok: false, code: 'tail_frame_preflight_blocked', readOnly: true };
      }
      var el = _sbTailFrameCardPromptTextarea(gIdx);
      var currentText = _ffeCleanDraftText(el && el.value, FFE_PROMPT_OVERRIDE_MAX_CHARS);
      var baselineText = _ffeCleanDraftText(_sbTailFrameCardPromptText(gIdx), FFE_PROMPT_OVERRIDE_MAX_CHARS);
      if (!options.forceSave && !state.dirtyAt && !(state.draft && state.draft.content) && currentText === baselineText) {
        _sbSetTailFrameCardPromptStatus(gIdx, 'initial');
        return { ok: true, skipped: true, unchangedBaseline: true };
      }
      var snapshot = _sbRefreshTailFrameCardPendingDraft(gIdx);
      if (!options.forceSave && snapshot.json === state.lastSavedDraftJson) {
        _sbSetTailFrameCardPromptStatus(gIdx, _ffeSavedFieldStatus('content', state.draft));
        return { ok: true, skipped: true };
      }
      _sbSetTailFrameCardPromptStatus(gIdx, 'saving');
      var resp = await apiPost('/api/frames/edit-draft', {
        projectId: project.id,
        groupIdx: gIdx,
        frameType: 'tail_frame',
        draft: snapshot.draft || {},
        expectedSavedDraftFingerprint: state.expectedFingerprint || state.savedDraftFingerprint || '',
        force: options.force === true,
      }, 'PUT');
      state.draft = _ffeCloneDraft(resp.draft || {});
      state.savedDraftFingerprint = String(resp.savedDraftFingerprint || '');
      state.expectedFingerprint = state.savedDraftFingerprint;
      state.lastSavedDraftJson = _ffeDraftJson(state.draft);
      state.pendingDraftJson = state.lastSavedDraftJson;
      state.pendingDraft = _ffeCloneDraft(state.draft);
      state.dirtyAt = null;
      state.errorCode = '';
      state.errorMessage = '';
      if (!project.storyboards) project.storyboards = [];
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      project.storyboards[gIdx].tailFrameEditDraft = resp.draft || null;
      if (resp.tailFrameBasePrompt) project.storyboards[gIdx].tailFrameBasePrompt = resp.tailFrameBasePrompt;
      if (resp.tailFrameBackup) project.storyboards[gIdx].tailFrameBackup = resp.tailFrameBackup;
      var nextStatus = _ffeSavedFieldStatus('content', state.draft);
      _sbSetTailFrameCardPromptStatus(gIdx, nextStatus);
      if (state.staleWasShown && !state.staleNoticeShown) {
        state.staleNoticeShown = true;
        showToast('已按当前镜头/资产/风格上下文保存', 'success');
      }
      return { ok: true, resp: resp };
    } catch (err) {
      var payload = err && err.payload || {};
      var code = payload.code || 'save_failed';
      var msg = payload.error || _diagnoseApiError(((err && err.message) || err).toString());
      _sbSetTailFrameCardPromptStatus(gIdx, 'error', msg, code);
      if (code === 'saved_draft_changed') showToast('草稿在另一处被修改，请重试或刷新后继续。', 'warn');
      else if (code === 'validation_failed') showToast('草稿校验失败，请检查提示词。', 'warn');
      else showToast('自动保存失败: ' + msg, 'error');
      return { ok: false, code: code, payload: payload };
    } finally {
      state.inFlightPromise = null;
    }
  })();
  return await state.inFlightPromise;
}

function _sbScheduleTailFrameCardPromptSave(gIdx, options) {
  options = options || {};
  var state = _sbTailFrameCardPromptState(gIdx);
  if (_sbTailFramePromptReadOnly(gIdx)) return;
  if (state.composing) return;
  _sbRefreshTailFrameCardPendingDraft(gIdx);
  if (state.pendingDraftJson === state.lastSavedDraftJson) {
    state.dirtyAt = null;
    _sbSetTailFrameCardPromptStatus(gIdx, _ffeSavedFieldStatus('content', state.draft));
    return;
  }
  if (!state.dirtyAt) state.dirtyAt = Date.now();
  _sbClearTailFrameCardPromptTimers(gIdx);
  var run = function () {
    _sbRunTailFrameCardPromptSave(gIdx, { source: options.source || 'tail-card-autosave' }).then(function (result) {
      _sbRefreshTailFrameCardPendingDraft(gIdx);
      if (result && result.ok && _sbTailFrameCardPromptState(gIdx).pendingDraftJson !== _sbTailFrameCardPromptState(gIdx).lastSavedDraftJson) {
        _sbScheduleTailFrameCardPromptSave(gIdx, { source: 'tail-card-autosave-followup' });
      }
    });
  };
  if (options.immediate) {
    run();
    return;
  }
  state.debounceTimer = setTimeout(run, FFE_AUTOSAVE_DEBOUNCE_MS);
  var waitMs = Math.max(0, state.dirtyAt + FFE_AUTOSAVE_MAX_WAIT_MS - Date.now());
  state.maxWaitTimer = setTimeout(run, waitMs);
}

async function _sbRetryTailFrameCardPromptSave(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  if (state.errorCode === 'saved_draft_changed') {
    var overwrite = window.confirm('草稿在另一处被修改，是否用本卡片里的版本覆盖？');
    if (!overwrite) {
      var refresh = window.confirm('是否刷新到最新草稿？刷新会放弃本卡片未保存修改。');
      if (refresh) {
        state.hydrated = false;
        state.dirtyAt = null;
        await _sbEnsureTailFrameCardPromptState(gIdx, { force: true });
        var el = _sbTailFrameCardPromptTextarea(gIdx);
        if (el) el.value = _sbTailFrameCardPromptText(gIdx);
      }
      return;
    }
    await _sbRunTailFrameCardPromptSave(gIdx, { force: true, forceSave: true });
    return;
  }
  await _sbRunTailFrameCardPromptSave(gIdx, { forceSave: true });
}

async function _sbRestoreTailFrameCardPrompt(gIdx) {
  var state = _sbTailFrameCardPromptState(gIdx);
  if (!project || !project.id) return;
  try {
    await _sbEnsureTailFrameCardPromptState(gIdx);
    _sbClearTailFrameCardPromptTimers(gIdx);
    _sbSetTailFrameCardPromptStatus(gIdx, 'saving');
    var resp = await apiPost('/api/frames/edit-draft', {
      projectId: project.id,
      groupIdx: gIdx,
      frameType: 'tail_frame',
      expectedSavedDraftFingerprint: state.expectedFingerprint || state.savedDraftFingerprint || '',
      force: true,
    }, 'DELETE');
    state.draft = _ffeCloneDraft(resp.draft || {});
    state.savedDraftFingerprint = String(resp.savedDraftFingerprint || '');
    state.expectedFingerprint = state.savedDraftFingerprint;
    state.lastSavedDraftJson = _ffeDraftJson(state.draft);
    state.pendingDraftJson = state.lastSavedDraftJson;
    state.pendingDraft = _ffeCloneDraft(state.draft);
    state.dirtyAt = null;
    if (!project.storyboards) project.storyboards = [];
    if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
    project.storyboards[gIdx].tailFrameEditDraft = resp.draft || null;
    if (resp.tailFrameBasePrompt) project.storyboards[gIdx].tailFrameBasePrompt = resp.tailFrameBasePrompt;
    if (resp.tailFrameBackup) project.storyboards[gIdx].tailFrameBackup = resp.tailFrameBackup;
    var el = _sbTailFrameCardPromptTextarea(gIdx);
    if (el) el.value = _sbTailFrameCardPromptText(gIdx);
    if (el) _sbSyncFramePromptSafetyHighlight(el);
    _sbSetTailFrameCardPromptStatus(gIdx, 'restored');
    showToast('已恢复尾帧初始 prompt', 'success');
  } catch (err) {
    var payload = err && err.payload || {};
    var code = payload.code || 'restore_failed';
    var msg = payload.error || _diagnoseApiError(((err && err.message) || err).toString());
    _sbSetTailFrameCardPromptStatus(gIdx, 'error', msg, code);
    if (code === 'no_backup_to_restore') showToast('暂无可恢复的初始 prompt', 'warn');
    else showToast('恢复尾帧 prompt 失败: ' + msg, 'error');
  }
}

function _sbAnyTailFrameCardPromptUnsaved() {
  return Object.keys(_tailFrameCardPromptAutosave).some(function (key) {
    var state = _tailFrameCardPromptAutosave[key];
    if (!state) return false;
    var gIdx = Number(key);
    if (!Number.isFinite(gIdx)) return false;
    return _sbTailFrameCardHasPendingChanges(gIdx);
  });
}

function _sbFlushTailFrameCardPromptsOnPageHide() {
  Object.keys(_tailFrameCardPromptAutosave).forEach(function (key) {
    var gIdx = Number(key);
    var state = _tailFrameCardPromptAutosave[key];
    if (!Number.isFinite(gIdx) || !state || !project || !project.id) return;
    var pending = _sbRefreshTailFrameCardPendingDraft(gIdx);
    if (pending.json === state.lastSavedDraftJson) return;
    try {
      fetch('/api/frames/edit-draft', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          projectId: project.id,
          groupIdx: gIdx,
          frameType: 'tail_frame',
          draft: pending.draft || {},
          expectedSavedDraftFingerprint: state.expectedFingerprint || state.savedDraftFingerprint || '',
          force: true,
        }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  });
}

async function _sbFlushTailFrameCardPromptsForTargets(targets, source) {
  var seen = Object.create(null);
  for (var i = 0; i < targets.length; i += 1) {
    var gIdx = Number(targets[i] && targets[i].groupIdx);
    if (!Number.isFinite(gIdx) || seen[gIdx]) continue;
    seen[gIdx] = true;
    var result = await _sbRunTailFrameCardPromptSave(gIdx, { source: source || 'tail-frame-generate-flush' });
    if (result && result.ok === false) return result;
  }
  return { ok: true };
}

function _frameDialogueHtml(group) {
  var dialogue = _groupShotText(group, ['dialogue', 'audio'], '\n');
  if (!dialogue || dialogue === '——') dialogue = '---';
  // tabindex=0 同 .sb-frame-text-box, 触发 :focus 视觉效果。
  return '<div class="sb-frame-dialogue-box" tabindex="0">' + escapeHtml(dialogue) + '</div>';
}

// 首帧/尾帧 card 折叠状态: localStorage 持久化用户手动覆盖值。
//   key 形式绑定 projectId + shotIndices + kind, value 为 true 表示折叠。
//   默认值仍来自推荐逻辑；用户一旦手动折叠/展开, 刷新页面后继续保留该覆盖值。
var _frameCardCollapsed = {};
var _frameCardCollapsedStorageKey = "";
function _frameCardCollapsedLocalStorageKey() {
  return String((_ctx && _ctx.uPrefix) || "") + "sw_frame_card_collapsed_v1";
}
function _frameCardStorageProjectPrefix() {
  var projectKey = project && project.id != null ? String(project.id) : "local";
  return "frame:" + projectKey + ":";
}
function _readFrameCardCollapsedStorage(storageKey) {
  try {
    var raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    var cleaned = {};
    Object.keys(parsed).forEach(function (key) {
      if (typeof key !== "string" || key.indexOf("frame:") !== 0) return;
      cleaned[key] = !!parsed[key];
    });
    return cleaned;
  } catch (_) {
    return {};
  }
}
function _ensureFrameCardCollapsedLoaded() {
  var storageKey = _frameCardCollapsedLocalStorageKey();
  if (_frameCardCollapsedStorageKey === storageKey) return;
  _frameCardCollapsedStorageKey = storageKey;
  _frameCardCollapsed = _readFrameCardCollapsedStorage(storageKey);
}
function _persistFrameCardCollapsed() {
  _ensureFrameCardCollapsedLoaded();
  try {
    window.localStorage.setItem(_frameCardCollapsedStorageKey, JSON.stringify(_frameCardCollapsed));
  } catch (_) {}
}
function _frameCardCollapseKey(gIdx, kind, group) {
  return _frameCollapseKeyForGroup(project && project.id, group, gIdx, kind);
}
function _frameCardCollapseKeySet(groups) {
  var keys = {};
  (groups || []).forEach(function (group, gIdx) {
    keys[_frameCardCollapseKey(gIdx, 'first', group)] = true;
    keys[_frameCardCollapseKey(gIdx, 'tail', group)] = true;
  });
  return keys;
}
function _pruneFrameCardCollapsed(groups) {
  _ensureFrameCardCollapsedLoaded();
  var valid = _frameCardCollapseKeySet(groups);
  var currentProjectPrefix = _frameCardStorageProjectPrefix();
  var changed = false;
  Object.keys(_frameCardCollapsed).forEach(function (key) {
    if (key.indexOf(currentProjectPrefix) === 0 && !valid[key]) {
      delete _frameCardCollapsed[key];
      changed = true;
    }
  });
  if (changed) _persistFrameCardCollapsed();
}
function _frameCardDefaultCollapsed(kind, group, sb, opts) {
  opts = opts || {};
  if (opts.mergedChild === true || opts.readOnlyActions === true) return true;
  var recommendation = _frameRecommendationForGroup(group, sb || {});
  if (kind === 'first') return !!(recommendation.first && recommendation.first.defaultCollapsed);
  if (kind === 'tail') return !!(recommendation.tail && recommendation.tail.defaultCollapsed);
  return kind === 'tail';
}
function _isFrameCardCollapsed(gIdx, kind, group, sb, opts) {
  _ensureFrameCardCollapsedLoaded();
  var key = _frameCardCollapseKey(gIdx, kind, group);
  if (Object.prototype.hasOwnProperty.call(_frameCardCollapsed, key)) {
    return !!_frameCardCollapsed[key];
  }
  return _frameCardDefaultCollapsed(kind, group, sb, opts);
}
function _setFrameCardCollapsedByKey(key, collapsed) {
  _ensureFrameCardCollapsedLoaded();
  if (!key) return;
  _frameCardCollapsed[key] = !!collapsed;
  _persistFrameCardCollapsed();
}
function _frameCardToggleButtonHtml(gIdx, kind, group, sb, opts) {
  var key = _frameCardCollapseKey(gIdx, kind, group);
  var collapsed = _isFrameCardCollapsed(gIdx, kind, group, sb, opts);
  var label = collapsed ? '点击展开' : '点击折叠';
  var icon = collapsed ? 'expand_more' : 'expand_less';
  return '<button type="button" class="sb-frame-toggle" ' +
    'data-action="toggle-frame-card" data-gidx="' + gIdx + '" data-frame="' + escapeHtml(kind) + '" ' +
    'data-frame-collapse-key="' + escapeHtml(key) + '" ' +
    'aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
      '<span class="sb-frame-toggle-label">' + label + '</span>' +
      '<span class="material-symbols-outlined sb-frame-toggle-icon">' + icon + '</span>' +
	    '</button>';
}

function _setFramePanelCollapsedFromToggle(btn, nextCollapsed) {
  if (!btn) return false;
  var toggleGIdx = parseInt(btn.dataset.gidx, 10);
  var toggleKind = btn.dataset.frame === 'tail' ? 'tail' : 'first';
  if (isNaN(toggleGIdx)) return false;
  var toggleGroups = getStoryboardGroups();
  var toggleGroup = toggleGroups[toggleGIdx];
  var toggleSb = (project.storyboards && project.storyboards[toggleGIdx]) || {};
  var collapseKey = btn.dataset.frameCollapseKey || _frameCardCollapseKey(toggleGIdx, toggleKind, toggleGroup);
  var panel = btn.closest('.sb-frame-panel');
  if (typeof nextCollapsed !== 'boolean') {
    var currentCollapsed = Object.prototype.hasOwnProperty.call(_frameCardCollapsed, collapseKey)
      ? !!_frameCardCollapsed[collapseKey]
      : (panel ? panel.classList.contains('is-collapsed') : _isFrameCardCollapsed(toggleGIdx, toggleKind, toggleGroup, toggleSb));
    nextCollapsed = !currentCollapsed;
  }
  _setFrameCardCollapsedByKey(collapseKey, nextCollapsed);
  if (panel) panel.classList.toggle('is-collapsed', nextCollapsed);
  btn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
  var labelEl = btn.querySelector('.sb-frame-toggle-label');
  if (labelEl) labelEl.textContent = nextCollapsed ? '点击展开' : '点击折叠';
  var iconEl = btn.querySelector('.sb-frame-toggle-icon');
  if (iconEl) iconEl.textContent = nextCollapsed ? 'expand_more' : 'expand_less';
  return true;
}

function _frameCompactStatusForPanel(kind, sb, group, opts, state, recommendation) {
  opts = opts || {};
  sb = sb || {};
  var isTail = kind === 'tail';
  var hasFrame = isTail ? !!_tailFrameImageUrl(sb) : !!_firstFrameImageUrl(sb);
  var mergedChild = opts.mergedChild === true;
  var readOnlyActions = opts.readOnlyActions === true;
  var rec = recommendation || _frameRecommendationForGroup(group, sb);
  if (!isTail && (mergedChild || readOnlyActions)) {
    var shotRangeText = _storyboardGroupShotRangeText(group);
    return {
      text: '无需生成',
      tone: 'muted',
      title: shotRangeText
        ? '此镜头随镜头 ' + shotRangeText + ' 统一生成首帧，无需单独生成。'
        : '此镜头随片段统一生成首帧，无需单独生成。',
    };
  }
  if (!isTail && _isFirstFrameFailed(sb)) {
    return {
      text: '生成失败',
      tone: 'error',
      title: sb.firstFrameLastError ? _firstFrameFailureDisplay(sb.firstFrameLastError, _firstFrameSafetyExtraFromStoryboard(sb)) : '首帧图生成失败',
    };
  }
  if (hasFrame) {
    return {
      text: '已生成',
      tone: 'recommended',
      title: isTail ? '尾帧已生成' : '首帧已生成',
    };
  }
  if (!isTail) {
    if (rec.first && rec.first.recommended) {
      return {
        text: '待生成（建议生成）',
        tone: 'recommended',
        title: rec.first.reason || '片段开场锚点',
      };
    }
    return {
      text: '无需生成',
      tone: 'muted',
      title: '当前镜头不需要单独生成首帧',
    };
  }

  var tailState = state || _tailFrameUiState(sb, group);
  if (tailState.status === 'failed') {
    return {
      text: '生成失败',
      tone: 'error',
      title: tailState.errorMsg || '尾帧生成失败',
    };
  }
  if (tailState.status === 'degraded') {
    return {
      text: '已生成',
      tone: 'recommended',
      title: '尾帧已生成，当前展示上次成功结果',
    };
  }
  if (mergedChild || readOnlyActions) {
    return {
      text: '无需生成',
      tone: 'muted',
      title: '此镜头随片段统一处理，不建议单独生成。',
    };
  }

  var tailRec = rec.tail || {};
  var shouldGenerateTail = !!tailRec.requested || !!tailRec.recommended;
  if (shouldGenerateTail) {
    if (tailState.canGenerate) {
      return {
        text: '待生成（建议生成）',
        tone: 'recommended',
        title: tailRec.reason || '建议生成尾帧',
      };
    }
    return {
      text: '待生成（建议生成 · 等待首帧）',
      tone: 'recommended',
      title: tailState.preflightMsg || '需先生成彩色首帧',
    };
  }

  return {
    text: '无需生成',
    tone: 'muted',
    title: (tailRec.reason || '当前镜头不建议生成尾帧'),
  };
}

function _storyboardFramePanelHtml(kind, sb, gIdx, group, opts) {
  opts = opts || {};
  sb = sb || {};
  var isTail = kind === 'tail';
  var mergedChild = opts.mergedChild === true;
  var readOnlyActions = opts.readOnlyActions === true;
  var frameRecommendation = _frameRecommendationForGroup(group, sb);
  var sourceImgUrl = isTail ? _tailFrameImageUrl(sb) : _firstFrameImageUrl(sb);
  var suppressReadOnlyFirstImage = !isTail && (mergedChild || readOnlyActions);
  var imgUrl = suppressReadOnlyFirstImage ? '' : sourceImgUrl;
  var hasImg = !!imgUrl;
  var hasSourceImg = !!sourceImgUrl;
  var state = isTail ? _tailFrameUiState(sb, group) : null;
  var firstFrameFailed = !isTail && _isFirstFrameFailed(sb);
  var firstFrameSafetyInfo = firstFrameFailed ? _firstFrameSafetyInfo(sb) : null;
  var tailFrameSafetyInfo = isTail ? _tailFrameSafetyInfo(sb) : null;
  var label = isTail ? '尾帧' : '首帧';
  var labelEn = isTail ? 'TAIL FRAME' : 'FIRST FRAME';
  var icon = isTail ? 'skip_next' : 'play_arrow';
  var statusText = isTail
    ? state.statusText
    : (firstFrameFailed ? '生成失败' : (hasSourceImg ? (String(sb.firstFrameMode || '') === 'legacy_pencil' ? '手稿首帧' : '已生成') : '待生成'));
  var compactStatus = _frameCompactStatusForPanel(kind, sb, group, opts, state, frameRecommendation);
  var primaryAction = isTail ? 'regen-tail' : 'regen-sb';
  var primaryIcon = isTail ? 'skip_next' : 'auto_awesome';
  var primaryText = isTail ? state.btnText : (hasImg ? '重新生成' : '生成首帧');
  var canPrimary = isTail ? state.canGenerate : true;
  var primaryTitle = isTail ? state.preflightMsg : '';
  var groupsForChecks = getStoryboardGroups();
  var materialBlockMessage = _materialLimitBlockMessage(groupsForChecks, [gIdx]);
  var materialBlocked = !!materialBlockMessage;
  if (materialBlocked) primaryTitle = materialBlockMessage;
  if (!isTail && !_isFirstFramePreflightAllowedNow(groupsForChecks)) {
    canPrimary = false;
    primaryTitle = _firstFramePreflightTitleNow(groupsForChecks);
  }

  var placeholderIcon = isTail ? 'skip_next' : 'image';
  var placeholderText = firstFrameFailed
    ? '生成失败，请重新生成'
    : ((suppressReadOnlyFirstImage && compactStatus && compactStatus.text) ? compactStatus.text : statusText);
  var placeholderToneClass = ' text-on-surface-variant/25';
  // hover 放大: 不用 Tailwind `group-hover:` — 因为外层 .shot-workbench-card 已经带 `group`,
  // 会让"鼠标在大卡任意位置(画面描述/对白等)"都触发图片放大, 而且图片首次生成出来时,
  // 如果鼠标已经在大卡范围内, 新 img 挂载瞬间就会动一下。
  // 改用纯 CSS `.sb-frame-preview-stage:hover img` 限定只在图片容器上 hover 才触发, 见 styles.css。
  var imgHtml = hasImg
    ? '<img data-frame-img class="w-full h-full object-contain cursor-pointer" data-action="lightbox" loading="lazy" decoding="async" src="' + escapeHtml(imgUrl) + '" />'
    : '<div class="sb-frame-placeholder w-full h-full flex flex-col items-center justify-center bg-surface-container' + placeholderToneClass + '" data-img-class="w-full h-full object-contain cursor-pointer">' +
        '<span class="material-symbols-outlined text-5xl mb-2">' + placeholderIcon + '</span>' +
        '<span class="text-[10px] font-bold uppercase tracking-[0.28em]">' + escapeHtml(placeholderText) + '</span>' +
      '</div>';

  var errorMsg = isTail ? state.errorMsg : (sb.firstFrameLastError ? _firstFrameFailureDisplay(sb.firstFrameLastError, _firstFrameSafetyExtraFromStoryboard(sb)) : '');
  var errorHtml = '<div class="sb-frame-error absolute inset-0 flex items-center justify-center bg-white/95 p-2 text-center"' +
    ((isTail && state.status === 'failed') ? '' : ' hidden') + '>' +
    '<span class="sb-frame-error-msg text-[10px] text-error leading-snug">' + escapeHtml(errorMsg || '生成失败') + '</span>' +
    '</div>';

  var buttons = '';
  // 按设计要求, 底部所有按钮统一为 secondary 白底外框样式 (编辑图片同款),
  // 不再单独把"重新生成"做成 primary 黑底, 保持视觉一致。
  if (readOnlyActions) {
    if (hasImg) buttons += _frameButtonHtml(isTail ? 'download-tail' : 'download-sb', gIdx, 'download', '下载图片', isTail ? '下载尾帧' : '下载首帧', 'secondary', false);
    buttons += _frameButtonHtml(
      '',
      gIdx,
      isTail ? 'skip_next' : 'auto_awesome',
      isTail ? '随片段生成' : '不建议单独生成',
      isTail ? '此处展示片段尾帧；请在片段起点镜头调整尾帧。' : '此镜头随片段统一生成首帧，不建议单独生成。',
      'secondary',
      true
    );
  } else if (isTail && state.isLegacyPencil) {
    buttons += _frameButtonHtml('', gIdx, primaryIcon, primaryText, primaryTitle || '当前首帧是旧版手稿图，不能作为尾帧锚点；请重新生成首帧', 'secondary', true);
  } else {
    if (!isTail) buttons += _firstFrameEditButtonHtml(gIdx, sb);
    buttons += _frameButtonHtml(isTail ? 'upload-tail' : 'upload-first', gIdx, 'upload', isTail ? '上传尾帧' : '上传首帧', isTail ? '手动上传一张已有尾帧图' : '手动上传一张已有首帧图', 'secondary', false);
    if (hasImg) buttons += _frameButtonHtml(isTail ? 'download-tail' : 'download-sb', gIdx, 'download', '下载图片', isTail ? '下载尾帧' : '下载首帧', 'secondary', false);
    if (isTail && Array.isArray(sb.tailFrameHistory) && sb.tailFrameHistory.length) {
      buttons += _frameButtonHtml('show-tail-history', gIdx, 'history', '历史', '查看尾帧历史版本', 'secondary', false);
    }
    buttons += _frameButtonHtml((canPrimary && !materialBlocked) ? primaryAction : '', gIdx, primaryIcon, primaryText, primaryTitle, 'secondary', !canPrimary || materialBlocked, 'data-frame-primary="' + (isTail ? 'tail' : 'first') + '"');
    // Tail-only: 删除按钮 = 清图 + 清意图。只有"已生成尾帧"或"已请求但尚未生成"才暴露该按钮。
    if (isTail && (hasImg || sb.tailFrameIntent === 'requested')) {
      buttons += _frameButtonHtml('delete-tail', gIdx, 'delete', '删除', '删除该尾帧并清除"需要尾帧"的意图（下次批量重做不会再生成）', 'secondary', false);
    }
  }

  // Tail-only: 仅保留真·broken 状态的徽章 (服务器文件已不可解析)。
  // 用户原则: 不再给尾帧贴"需更新"提示, 用户自己判断是否要重生。
  var tailBadgesHtml = '';
  if (isTail) {
    var tailRefStatus = String(sb.tailFrameReferenceStatus || '').toLowerCase();
    if (tailRefStatus === 'unresolvable' || tailRefStatus === 'file_missing') {
      tailBadgesHtml += '<span class="shrink-0 ml-1 px-2 py-0.5 rounded-full text-[9px] font-black tracking-widest uppercase bg-error/10 text-error border border-error/20" title="尾帧文件在服务器上已不可解析，视频生成会降级到首帧+多图通道">文件不可解析</span>';
    }
  }

  var promptInfo = _framePromptForPanel(kind, sb, group);
  var promptText = promptInfo.text || (isTail ? '尾帧提示词待生成。' : '');
  var promptDisplay = promptText;
  var firstPromptPlaceholder = (!isTail && !hasImg && !promptDisplay && compactStatus && compactStatus.text === '无需生成')
    ? '无需首帧图提示词。'
    : '首帧提示词待生成。';
  var promptStatusHtml = mergedChild
    ? _sbFramePromptReadonlyStatusHtml('只读展示')
    : (isTail ? _sbTailFrameCardPromptStatusHtml(gIdx, sb) : _sbFirstFrameCardPromptStatusHtml(gIdx, sb));
  var safetyNoticeHtml = (!mergedChild && !readOnlyActions)
    ? _sbFrameSafetyNoticeHtml(isTail ? tailFrameSafetyInfo : firstFrameSafetyInfo, isTail ? 'tail' : 'first')
    : '';
  // 注: "来源：xxx" 行、sb-frame-plan-note 构图指导段, 以及"关键信息"chips 段
  // 均已按产品要求从首尾帧卡片移除。promptInfo.source / planSummary 仍保留在数据层
  // (便于排查), 但不再渲染。

  var isCollapsed = _isFrameCardCollapsed(gIdx, kind, group, sb, opts);
  return '<section data-frame="' + kind + '" class="sb-frame-panel' + (isCollapsed ? ' is-collapsed' : '') + '">' +
           '<div class="sb-frame-panel-head">' +
             '<div class="sb-frame-panel-title">' +
               '<span class="material-symbols-outlined">' + icon + '</span>' +
               '<strong>分镜板 · ' + escapeHtml(label) + '</strong>' +
               '<em>' + escapeHtml(labelEn) + '</em>' +
             '</div>' +
             '<div class="sb-frame-head-right">' +
               '<div class="sb-frame-status is-' + escapeHtml(compactStatus.tone || 'muted') + '">' +
                 '<span title="' + escapeHtml(compactStatus.title || statusText) + '">' + escapeHtml(compactStatus.text || statusText) + '</span>' +
                 tailBadgesHtml +
               '</div>' +
		               _frameCardToggleButtonHtml(gIdx, kind, group, sb, opts) +
             '</div>' +
           '</div>' +
           '<div class="sb-frame-layout">' +
             '<div class="sb-frame-copy-col">' +
               '<div class="sb-frame-field-label-row">' +
                 '<div class="sb-frame-field-label">画面描述</div>' +
                 promptStatusHtml +
               '</div>' +
               (isTail
                 ? _sbTailFramePromptEditorHtml(gIdx, promptDisplay, {
                     readOnly: mergedChild || !state.canGenerate,
                     title: mergedChild ? '此处为片段尾帧提示词展示' : state.preflightMsg,
                     mirror: mergedChild,
                     safetyInfo: tailFrameSafetyInfo,
                   })
	                 : _sbFirstFramePromptEditorHtml(gIdx, promptDisplay, {
	                     readOnly: mergedChild,
	                     title: '此处为片段首帧提示词展示',
	                     mirror: mergedChild,
	                     placeholder: firstPromptPlaceholder,
	                     safetyInfo: firstFrameSafetyInfo,
	                   })) +
             '</div>' +
             '<div class="sb-frame-context-col">' +
               '<div class="sb-frame-field-label">参考素材</div>' +
               _storyboardAssetsHtml(group) +
               (isTail ? '' : (
                 '<div class="sb-frame-field-label">对白/旁白（本帧）</div>' +
                 _frameDialogueHtml(group)
               )) +
             '</div>' +
             '<div class="sb-frame-preview-col">' +
               '<div class="sb-frame-field-label">图片展示</div>' +
               '<div class="sb-frame-preview-stage" style="--sb-stage-ar: ' + _sbStageAspectCss(sb) + '">' +
                 imgHtml +
                 '<div class="sb-frame-loading" hidden>' +
                   '<div class="sb-frame-loading-card">' +
                     '<div class="sb-frame-loading-spinner"></div>' +
                     '<span class="sb-frame-loading-text">生成中…</span>' +
                   '</div>' +
                 '</div>' +
                 errorHtml +
               '</div>' +
               '<div class="sb-frame-actions">' + buttons + '</div>' +
               safetyNoticeHtml +
             '</div>' +
           '</div>' +
         '</section>';
}

function _ffeShort(text, limit) {
  text = String(text || '').trim();
  limit = limit || 180;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function _ffeReferenceLabel(ref) {
  if (!ref) return '参考图';
  var roleMap = { character: '角色', crowd: '人群', scene: '场景', prop: '道具', self_first_frame: '首帧', prev_tail: '尾帧' };
  var role = roleMap[ref.role] || ref.role || '参考';
  var name = ref.assetName || ref.assetId || ('#' + (ref.imageNo || ref.slot || ''));
  return role + ' · ' + name;
}

function _ffePanelHtml(title, eyebrow, body, extraClass, headerExtraHtml) {
  return '<section class="ffe-panel ' + (extraClass || '') + '">' +
    '<div class="ffe-panel-head">' +
      '<div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        (eyebrow ? '<span>' + escapeHtml(eyebrow) + '</span>' : '') +
      '</div>' +
      (headerExtraHtml || '') +
    '</div>' +
    '<div class="ffe-panel-body">' + (body || '<span class="ffe-muted">暂无</span>') + '</div>' +
  '</section>';
}

function _ffeFieldLabel(label) {
  return '<div class="ffe-field-label">' + escapeHtml(label) + '</div>';
}

function _ffeAutoSaveState() {
  if (!_firstFrameEditor.autoSave) _firstFrameEditor.autoSave = _ffeInitialAutoSaveState();
  return _firstFrameEditor.autoSave;
}

function _ffeSetGenerateBlock(message, meta) {
  var text = String(message || '').trim();
  if (!text) {
    _firstFrameEditor.generateBlock = null;
    return;
  }
  meta = meta || {};
  _firstFrameEditor.generateBlock = {
    message: text,
    code: meta.code || 'batch_failed',
    reason: meta.reason || ''
  };
}

function _ffeClearGenerateBlock() {
  _firstFrameEditor.generateBlock = null;
}

function _ffeSetGeneratingPreviewText(message) {
  var text = String(message || '').trim() || '生成首帧中…';
  _firstFrameEditor.generatingText = text;
  var root = document.getElementById('firstFrameEditorRoot');
  var textNode = root && root.querySelector ? root.querySelector('[data-ffe-generating-text]') : null;
  if (textNode) textNode.textContent = text;
}

function _ffeClearGeneratingPreviewText() {
  _firstFrameEditor.generatingText = '';
}

function _ffeDraftHasTextOverride(draft, field) {
  if (field === 'content') return _ffePromptContentFromDraft(draft).length > 0;
  return typeof (draft && draft[field]) === 'string' && String(draft[field]).trim().length > 0;
}

function _ffePromptContentFromDraft(draft) {
  return String((draft && draft.content) || '').trim();
}

function _ffeBasePromptContent(payload) {
  var base = payload && payload.firstFrameBasePrompt || {};
  var plan = payload && payload.plan || {};
  return String(base.content || plan.finalPrompt || '').trim();
}

function _ffeSavedFieldStatus(field, draft) {
  return _ffeDraftHasTextOverride(draft, field) ? 'saved' : 'initial';
}

function _ffeFieldStatusText(status) {
  if (status === 'saving') return '保存中...';
  if (status === 'saved') return '已修改保存';
  if (status === 'restored') return '已恢复初始';
  if (status === 'error') return '保存失败';
  return '初始内容';
}

function _ffeFieldStatusHtml(field) {
  var auto = _ffeAutoSaveState();
  var status = auto.fieldStatus && auto.fieldStatus[field] || 'initial';
  var retryHtml = status === 'error'
    ? '<button type="button" class="ffe-field-status-retry" data-ffe-action="retry-autosave">重试</button>'
    : '';
  return '<div class="ffe-field-status" data-ffe-status-field="' + escapeHtml(field) + '" data-status="' + escapeHtml(status) + '">' +
    '<span>' + escapeHtml(_ffeFieldStatusText(status)) + '</span>' +
    retryHtml +
  '</div>';
}

function _ffeSetFieldStatus(field, status) {
  var auto = _ffeAutoSaveState();
  if (!auto.fieldStatus) auto.fieldStatus = {};
  auto.fieldStatus[field] = status;
  var root = document.getElementById('firstFrameEditorRoot');
  var node = root && root.querySelector('[data-ffe-status-field="' + field + '"]');
  if (!node) return;
  node.dataset.status = status;
  node.innerHTML = '<span>' + escapeHtml(_ffeFieldStatusText(status)) + '</span>' +
    (status === 'error' ? '<button type="button" class="ffe-field-status-retry" data-ffe-action="retry-autosave">重试</button>' : '');
}

// 字数计数器：只是"温柔提示"，不阻断保存。超过上限时服务端 / _ffeDraftForCompare
// 会按 FFE_PROMPT_OVERRIDE_MAX_CHARS / FFE_NEGATIVE_PROMPT_MAX_CHARS 截断，
// 这里只负责把"你现在敲了多少 / 最多多少"以小字形式展示在状态徽标左侧。
function _ffeFieldCounterLimit(field) {
  return field === 'negativePromptOverride'
    ? FFE_NEGATIVE_PROMPT_MAX_CHARS
    : FFE_PROMPT_OVERRIDE_MAX_CHARS;
}

function _ffeFieldCounterState(length, limit) {
  if (length > limit) return 'over';
  if (length >= Math.floor(limit * 0.9)) return 'near';
  return 'normal';
}

// 读取字段当前长度：优先用 DOM 中 textarea 的实际值（含 IME 组合中状态）；
// DOM 还没渲染（首次渲染那一帧）时回退到 payload，正向 prompt 还会再回退到 plan.finalPrompt，
// 行为与 _ffePromptHtml / _ffeNegativePromptHtml 的初值取法保持一致。
function _ffeFieldCurrentLength(field, payload) {
  var root = document.getElementById('firstFrameEditorRoot');
  var el = root && root.querySelector('[data-ffe-field="' + field + '"]');
  if (el) return String(el.value || '').length;
  var fallbackPayload = payload || (_firstFrameEditor && _firstFrameEditor.payload) || {};
  var draft = (fallbackPayload && fallbackPayload.draft) || {};
  if (field === 'content') {
    return String(_ffePromptContentFromDraft(draft) || _ffeBasePromptContent(fallbackPayload)).length;
  }
  if (field === 'negativePromptOverride') {
    return String(draft.negativePromptOverride || '').length;
  }
  return 0;
}

function _ffeFieldCounterHtml(field, payload) {
  var limit = _ffeFieldCounterLimit(field);
  var length = _ffeFieldCurrentLength(field, payload);
  var state = _ffeFieldCounterState(length, limit);
  return '<span class="ffe-field-counter" data-ffe-counter-field="' + escapeHtml(field) + '" data-state="' + state + '">' +
    length + '/' + limit +
  '</span>';
}

function _ffeFieldMetaHtml(field, payload) {
  return '<div class="ffe-field-meta">' +
    _ffeFieldCounterHtml(field, payload) +
    _ffeFieldStatusHtml(field) +
  '</div>';
}

function _ffeSetFieldCounter(field) {
  if (field !== 'content' && field !== 'negativePromptOverride') return;
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return;
  var node = root.querySelector('[data-ffe-counter-field="' + field + '"]');
  if (!node) return;
  var limit = _ffeFieldCounterLimit(field);
  var length = _ffeFieldCurrentLength(field);
  node.dataset.state = _ffeFieldCounterState(length, limit);
  node.textContent = length + '/' + limit;
}

function _ffeResetFieldStatusesFromDraft(draft, restored) {
  _ffeSetFieldStatus('content', restored ? 'restored' : _ffeSavedFieldStatus('content', draft));
  _ffeSetFieldStatus('negativePromptOverride', restored ? 'restored' : _ffeSavedFieldStatus('negativePromptOverride', draft));
}

function _ffeFormatDateTime(value) {
  var raw = String(value || '').trim();
  if (!raw || raw === '当前') return raw || '时间未知';
  var d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  try {
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\//g, '-');
  } catch (_) {
    return raw;
  }
}

// 图片展示 stage 的画幅 → CSS aspect-ratio 值 (styles.css 的 --sb-stage-ar)。
// 取值链对齐生成侧: plan.aspectRatio → planSummary.aspectRatio →
// project.styleOptions.aspectRatio, 缺省 9:16 (对齐 main.js 项目默认)。
// 白名单映射, 不直接拼接外部字符串进 style。
function _sbStageAspectCss(sb) {
  sb = sb || {};
  var plan = sb.plan || {};
  var summary = plan.planSummary || {};
  var styleOpts = (typeof project !== 'undefined' && project && project.styleOptions) || {};
  var ratio = String(plan.aspectRatio || summary.aspectRatio || styleOpts.aspectRatio || '').trim();
  if (ratio === '1:1') return '1 / 1';
  if (ratio === '16:9') return '16 / 9';
  return '9 / 16';
}

function _ffeImageSizeForRatio(ratio) {
  ratio = String(ratio || '').trim();
  if (ratio === '9:16') return '1024×1536';
  if (ratio === '1:1') return '1024×1024';
  return '1536×1024';
}

function _ffeImagePreviewEyebrow(payload) {
  var plan = payload && payload.plan || {};
  var summary = plan.planSummary || (payload && payload.planSummary) || {};
  var ratio = plan.aspectRatio || summary.aspectRatio || '';
  var size = _ffeImageSizeForRatio(ratio);
  return ['IMAGE PREVIEW', ratio, size].filter(Boolean).join(' · ');
}

function _ffePromptHtml(payload) {
  var draft = payload && payload.draft || {};
  var prompt = _ffePromptContentFromDraft(draft) || _ffeBasePromptContent(payload);
  return '<textarea class="ffe-textarea ffe-prompt-textarea" data-ffe-field="content" maxlength="' + FFE_PROMPT_OVERRIDE_MAX_CHARS + '" placeholder="填写或调整最终首帧 Prompt">' + escapeHtml(prompt) + '</textarea>';
}

function _ffeNegativePromptHtml(payload) {
  var draft = payload && payload.draft || {};
  return '<textarea class="ffe-small-textarea" data-ffe-field="negativePromptOverride" maxlength="' + FFE_NEGATIVE_PROMPT_MAX_CHARS + '" placeholder="仅影响当前首帧的负向约束">' + escapeHtml(draft.negativePromptOverride || '') + '</textarea>';
}

function _ffeReadonlyList(items, emptyText) {
  if (!items || !items.length) return '<span class="ffe-muted">' + escapeHtml(emptyText || '暂无') + '</span>';
  return '<div class="ffe-chip-list">' + items.map(function (item) {
    return '<span class="ffe-chip">' + escapeHtml(item) + '</span>';
  }).join('') + '</div>';
}

function _ffeMaterialPanelData(payload) {
  return (payload && payload.firstFrameMaterialPanel)
    || (payload && payload.plan && payload.plan.firstFrameMaterialPanel)
    || null;
}

function _ffeMaterialRoleLabel(role) {
  return materialPanelRoleLabel(role);
}

function _ffeMaterialRoleIcon(role) {
  return materialPanelRoleIcon(role);
}

function _ffeReferenceMaterialPickerState() {
  if (!_firstFrameEditor.referenceMaterialPicker) {
    _firstFrameEditor.referenceMaterialPicker = {
      open: false,
      role: null,
      selectedId: "",
      uploading: false,
      error: "",
    };
  }
  return _firstFrameEditor.referenceMaterialPicker;
}

function _ffeCandidateTilesForRole(panel, role) {
  return materialPanelCandidateTilesForRole(panel, role);
}

function _ffeSelectedTileIdSet(panel) {
  return materialPanelSelectedTileIdSet(panel);
}

function _ffePanelTileIds(panel) {
  return materialPanelTileIds(panel);
}

function _ffeReferenceCapMessage(panel) {
  return materialPanelReferenceCapMessage(panel);
}

function _ffeReferenceAddDisabled(panel) {
  return materialPanelReferenceAddDisabled(panel);
}

function _ffeMaterialOrderedTiles(panel) {
  return materialPanelOrderedTiles(panel);
}

function _ffeImageWithFallbackHtml(url, opts) {
  return renderMaterialImageWithFallbackHtml(url, Object.assign({ actionAttr: 'data-ffe-action' }, opts || {}));
}

// 共用：从素材展示区批量下载当前选中的素材图。
// 命名规则：镜头X + 图片类型名称 + x（场景图/角色图/道具图，按 role 单独计数）。
// 由镜头页面板和首帧编辑弹窗共用——两处入口的 action 名都是 'download-all-material'。
function _materialRoleZhLabel(role) {
  if (role === 'scene') return '场景图';
  if (role === 'char') return '角色图';
  return '道具图';
}

function _guessMaterialImageExt(url) {
  var m = String(url || '').toLowerCase().match(/\.(jpe?g|png|webp|gif)(?:\?|#|$)/);
  if (!m) return null;
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}

async function _downloadOneMaterialAsBlob(url, filename) {
  var resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var blob = await resp.blob();
  var objectUrl = URL.createObjectURL(blob);
  try {
    var a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 给浏览器时间消费 blob URL 后再回收，避免下载尚未触发就被吊销
    setTimeout(function () { try { URL.revokeObjectURL(objectUrl); } catch (_) {} }, 5000);
  }
}

async function _downloadAllPanelMaterials(panel, groupIdx) {
  var tiles = materialPanelOrderedTiles(panel || {});
  if (!tiles.length) {
    showToast('当前素材区没有可下载的图片', 'warn');
    return;
  }
  var groupNo = Number(groupIdx);
  if (!Number.isFinite(groupNo) || groupNo < 0) groupNo = 0;
  groupNo = groupNo + 1;
  showToast('正在准备下载 ' + tiles.length + ' 张素材图', 'info');
  var seqByRole = { scene: 0, char: 0, prop: 0 };
  var ok = 0;
  var fail = 0;
  for (var i = 0; i < tiles.length; i++) {
    var tile = tiles[i] || {};
    var role = tile.role || 'prop';
    seqByRole[role] = (seqByRole[role] || 0) + 1;
    var typeName = _materialRoleZhLabel(role);
    var url = tile.url || tile.thumbUrl || '';
    if (!url) { fail++; continue; }
    var ext = _guessMaterialImageExt(url) || 'png';
    var filename = '镜头' + groupNo + typeName + seqByRole[role] + '.' + ext;
    try {
      await _downloadOneMaterialAsBlob(url, filename);
      ok++;
    } catch (e) {
      console.warn('[downloadAllPanelMaterials] failed:', filename, e);
      fail++;
    }
    // 间隔 200ms，规避部分浏览器对短时间多文件下载的阻断
    await new Promise(function (r) { setTimeout(r, 200); });
  }
  if (fail === 0) showToast('已下载 ' + ok + ' 张素材图', 'success');
  else if (ok === 0) showToast('素材图下载失败', 'error');
  else showToast('已下载 ' + ok + ' 张，' + fail + ' 张失败', 'warn');
}

function _ffeMaterialPanelHtml(payload) {
  var panel = _ffeMaterialPanelData(payload);
  return renderMaterialImagePanelHtml({
    panel: panel,
    scope: 'editor',
    groupIdx: _firstFrameEditor.groupIdx,
    rolePickerOpen: _firstFrameEditor.referenceRolePickerOpen,
    actionAttr: 'data-ffe-action',
  });
}

function _ffeActualImageInput(payload) {
  var plan = payload && payload.plan || {};
  var summary = plan.planSummary || (payload && payload.planSummary) || {};
  return payload && payload.currentFrame && payload.currentFrame.planSummary
    ? payload.currentFrame.planSummary.actualImageInput
    : summary.actualImageInput;
}

function _ffeIsImageStale(payload) {
  var actualImageInput = _ffeActualImageInput(payload);
  if (!actualImageInput || !actualImageInput.draftFingerprint) return false;
  var savedFingerprint = _firstFrameEditor.savedDraftFingerprint || (payload && payload.savedDraftFingerprint) || '';
  var formDirty = _ffeDraftJson(payload && payload.draft) !== (_firstFrameEditor.originalDraftJson || '{}');
  if (!formDirty && (!savedFingerprint || actualImageInput.draftFingerprint === savedFingerprint)) return false;
  return true;
}

function _ffeStaleDismissKey(payload) {
  var actualImageInput = _ffeActualImageInput(payload);
  return String((actualImageInput && actualImageInput.draftFingerprint) || '') + '|' +
    String(_firstFrameEditor.savedDraftFingerprint || (payload && payload.savedDraftFingerprint) || '');
}

function _ffeAlertItemHtml(item) {
  // item: { key, severity, message, dismissable }
  var sev = item.severity || 'info';
  return '<div class="ffe-image-alert ffe-image-alert--' + escapeHtml(sev) + '" data-alert-key="' + escapeHtml(item.key || '') + '">' +
    '<span class="ffe-image-alert-text">' + escapeHtml(item.message) + '</span>' +
    (item.dismissable !== false
      ? '<button type="button" class="ffe-image-alert-dismiss" data-ffe-action="dismiss-image-alert" data-alert-key="' + escapeHtml(item.key || '') + '" title="关闭"><span class="material-symbols-outlined">close</span></button>'
      : '') +
  '</div>';
}

function _ffeImageAlertHtml(payload) {
  var dismissed = _firstFrameEditor.dismissedAlerts || {};
  var items = [];

  // legacy (severity: error) — 结构性能力限制，可关闭
  if (payload && payload.legacyUnsupported && !dismissed['legacy']) {
    items.push({
      key: 'legacy',
      severity: 'error',
      message: '旧版手稿首帧没有结构化生成计划，请先重新生成彩色首帧。',
    });
  }

  // generateBlock (severity: error)
  var gb = _firstFrameEditor.generateBlock;
  if (gb && gb.message && !dismissed['generateBlock']) {
    items.push({
      key: 'generateBlock',
      severity: 'error',
      message: gb.message,
    });
  }

  // notices (severity: info)
  var notices = Array.isArray(payload && payload.notices) ? payload.notices : [];
  notices.forEach(function (notice, idx) {
    var code = (notice && (notice.code || notice.id)) || ('notice-' + idx);
    var dismissKey = 'notice:' + code;
    if (dismissed[dismissKey]) return;
    var text = notice && (notice.message || notice.code) || '';
    if (!text) return;
    items.push({
      key: dismissKey,
      severity: 'info',
      message: text,
    });
  });

  // stale (severity: warn)
  // 生成进行中时不显示"提示词/素材已改变，请重新生成"——此刻正在重新生成，再催一遍自相矛盾。
  if (_ffeIsImageStale(payload) && !_firstFrameEditor.generating) {
    var staleKey = 'stale:' + _ffeStaleDismissKey(payload);
    if (!dismissed[staleKey]) {
      items.push({
        key: staleKey,
        severity: 'warn',
        message: '提示词/素材已改变，请重新生成图片',
      });
    }
  }

  if (!items.length) return '';
  return '<div class="ffe-image-alert-stack">' + items.map(_ffeAlertItemHtml).join('') + '</div>';
}

function _ffeGenerationContextHtml(payload) {
  return '<div class="ffe-context-stack ffe-context-layout">' +
    '<div class="ffe-context-top">' + _ffeMaterialPanelHtml(payload) + '</div>' +
    _ffePanelHtml('提示词展示区域', '画面提示词', _ffePromptHtml(payload), 'ffe-prompt-panel', _ffeFieldMetaHtml('content', payload)) +
  '</div>';
}

function _ffeNegativePromptPanelHtml(payload) {
  return _ffePanelHtml('负向提示词展示区域', '负向约束', _ffeNegativePromptHtml(payload), 'ffe-negative-panel', _ffeFieldMetaHtml('negativePromptOverride', payload));
}

function _ffeHistoryHtml(payload) {
  var current = payload && payload.currentFrame && payload.currentFrame.url ? [{
    url: payload.currentFrame.url,
    at: '当前',
    source: payload.currentFrame.mode || 'current',
    current: true
  }] : [];
  var history = Array.isArray(payload && payload.imageHistory) ? payload.imageHistory : [];
  var items = current.concat(history);
  if (!items.length) return '<div class="ffe-history-empty">暂无历史图片</div>';
  return items.map(function (item, idx) {
    var url = item && item.url || '';
    var title = item.current ? '当前首帧' : (item.title || item.name || item.source || ('历史图片 ' + idx));
    var planForRatio = payload && payload.plan || {};
    var summaryForRatio = planForRatio.planSummary || (payload && payload.planSummary) || {};
    var ratio = item.aspectRatio || item.ratio || planForRatio.aspectRatio || summaryForRatio.aspectRatio || '';
    var meta = [_ffeFormatDateTime(item.at), ratio || item.mode || item.source || ''].filter(Boolean);
    return '<article class="ffe-history-item ' + (item.current ? 'is-current' : '') + '" data-history-idx="' + idx + '">' +
      (url ? '<button type="button" class="ffe-history-thumb" data-ffe-action="view-history" data-url="' + escapeHtml(url) + '">' + _ffeImageWithFallbackHtml(url, { variant: 'thumb', alt: title }) + '</button>' : '<div class="ffe-history-thumb-empty">无图</div>') +
      '<div class="ffe-history-meta">' +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<span>' + escapeHtml(meta.join(' · ')) + '</span>' +
        (item.source && !item.current ? '<em>' + escapeHtml(item.source) + '</em>' : '') +
      '</div>' +
      '<div class="ffe-history-actions">' +
        (url ? '<button type="button" data-ffe-action="view-history" data-url="' + escapeHtml(url) + '">查看</button>' : '') +
        (!item.current && url ? '<button type="button" data-ffe-action="set-current-history" data-url="' + escapeHtml(url) + '">替换</button>' : '') +
      '</div>' +
    '</article>';
  }).join('');
}

function _ffeSourceHash(payload) {
  return String((payload && payload.sourceHash) || '').trim() || 'no-source';
}

function _ffeChatStorageKey(payload, gIdx) {
  if (!project || !project.id || gIdx == null || !payload) return '';
  return ['origin:first-frame-edit-chat', project.id, gIdx, _ffeSourceHash(payload)].join(':');
}

function _ffeNormalizeChatForStorage(chat) {
  return (Array.isArray(chat) ? chat : []).filter(function (item) {
    return item && !item.pending && (item.role === 'user' || item.role === 'assistant') && String(item.content || '').trim();
  }).slice(-30).map(function (item) {
    var hasSavedApplyState = !!item.afterSavedDraftFingerprint;
    return {
      role: item.role,
      content: String(item.content || '').slice(0, 1600),
      patch: item.patch || null,
      warnings: Array.isArray(item.warnings) ? item.warnings : [],
      intentSummary: item.intentSummary || '',
      diffOpen: !!item.diffOpen,
      applied: hasSavedApplyState && !!item.applied,
      undoable: hasSavedApplyState && !!item.undoable,
      invalid: !!item.invalid,
      beforeSavedDraft: hasSavedApplyState ? (item.beforeSavedDraft || {}) : null,
      beforeSavedDraftFingerprint: hasSavedApplyState ? String(item.beforeSavedDraftFingerprint || '') : '',
      afterSavedDraftFingerprint: hasSavedApplyState ? String(item.afterSavedDraftFingerprint || '') : '',
      afterSourceHash: hasSavedApplyState ? String(item.afterSourceHash || '') : '',
    };
  });
}

function _ffeLoadChat(payload, gIdx) {
  var key = _ffeChatStorageKey(payload, gIdx);
  if (!key) return [];
  try {
    var parsed = JSON.parse(sessionStorage.getItem(key) || '[]');
    return _ffeNormalizeChatForStorage(parsed);
  } catch (_) {
    return [];
  }
}

function _ffeSaveChat() {
  var key = _ffeChatStorageKey(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
  if (!key) return;
  try {
    var chat = _ffeNormalizeChatForStorage(_firstFrameEditor.chat);
    if (chat.length) sessionStorage.setItem(key, JSON.stringify(chat));
    else sessionStorage.removeItem(key);
  } catch (_) {}
}

function _ffeSetChat(chat) {
  _firstFrameEditor.chat = Array.isArray(chat) ? chat.slice(-30) : [];
  _ffeSaveChat();
}

function _ffeAppendChat(msg) {
  _ffeSetChat((_firstFrameEditor.chat || []).concat([msg]));
}

function _ffeReplacePendingAssistant(msg) {
  var chat = (_firstFrameEditor.chat || []).slice();
  for (var i = chat.length - 1; i >= 0; i--) {
    if (chat[i] && chat[i].pending) {
      chat[i] = msg;
      _ffeSetChat(chat);
      return;
    }
  }
  _ffeAppendChat(msg);
}

function _ffeConversationHistoryForApi() {
  return (_firstFrameEditor.chat || []).filter(function (item) {
    return item && !item.pending && (item.role === 'user' || item.role === 'assistant') && String(item.content || '').trim();
  }).map(function (item) {
    return { role: item.role, content: String(item.content || '').slice(0, 1200) };
  }).slice(-20);
}

function _ffeValuePreview(value) {
  if (value == null) return '未设置';
  if (Array.isArray(value)) return value.length ? value.map(function (item) {
    return typeof item === 'string' ? item : JSON.stringify(item);
  }).join('\n') : '空列表';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function _ffeDiffHtml(patch, open) {
  var fields = patch && Array.isArray(patch.changedFields) ? patch.changedFields : [];
  if (!open) return '';
  if (!fields.length) return '<div class="ffe-chat-diff is-empty">没有字段变化</div>';
  return '<div class="ffe-chat-diff">' + fields.map(function (field) {
    var fieldName = typeof field === 'string' ? field : (field.field || 'field');
    var oldValue = typeof field === 'string'
      ? (patch.beforeDraft && patch.beforeDraft[fieldName])
      : field.oldValue;
    var newValue = typeof field === 'string'
      ? (patch.nextDraft && patch.nextDraft[fieldName])
      : field.newValue;
    return '<div class="ffe-chat-diff-row">' +
      '<strong>' + escapeHtml(fieldName) + '</strong>' +
      '<div><span>原值</span><pre>' + escapeHtml(_ffeValuePreview(oldValue)) + '</pre></div>' +
      '<div><span>新值</span><pre>' + escapeHtml(_ffeValuePreview(newValue)) + '</pre></div>' +
    '</div>';
  }).join('') + '</div>';
}

function _ffeWarningsHtml(warnings) {
  warnings = Array.isArray(warnings) ? warnings : [];
  if (!warnings.length) return '';
  return '<div class="ffe-chat-warnings">' + warnings.map(function (warning) {
    return '<div class="ffe-chat-warning is-' + escapeHtml(warning.severity || 'warn') + '">' +
      escapeHtml(warning.message || warning.code || 'AI 已自动调整部分草稿内容') +
    '</div>';
  }).join('') + '</div>';
}

function _ffeChatHtml() {
  var chat = Array.isArray(_firstFrameEditor.chat) ? _firstFrameEditor.chat : [];
  if (!chat.length) {
    return '<div class="ffe-chat-empty">' +
      '<span class="material-symbols-outlined">auto_awesome</span>' +
      '<strong>描述你想调整的画面</strong>' +
      '<span>可以让 AI 帮你改写 prompt、参考图或负向约束。</span>' +
    '</div>';
  }
  return '<div class="ffe-chat-list">' + chat.map(function (msg, idx) {
    var isAssistant = msg.role === 'assistant';
    var diffOpen = !!msg.diffOpen;
    var changedFields = msg.patch && Array.isArray(msg.patch.changedFields) ? msg.patch.changedFields : [];
    var hasPatchChanges = changedFields.length > 0 && msg.patch && msg.patch.nextDraft;
    var isDirty = _firstFrameEditor.open && _ffeDraftDirty();
    var isInvalid = !!msg.invalid;
    var isApplying = !!msg.applying;
    var isUndoing = !!msg.undoing;
    var canUndo = _ffeCanUndoSavedPatch(msg);
    var staleUndo = msg.undoable && !canUndo && !isDirty;
    var applyLabel = isApplying ? '正在应用...' : (isUndoing ? '正在撤销...' : (msg.undoable ? (canUndo ? '撤销此次应用' : '已有后续更新') : (msg.applied ? '已应用并保存' : (isInvalid ? '建议已失效' : '应用并保存'))));
    var applyDisabled = isApplying || isUndoing || isInvalid || isDirty || staleUndo || (msg.applied && !msg.undoable);
    return '<article class="ffe-chat-msg ' + (isAssistant ? 'is-assistant' : 'is-user') + '">' +
      '<div class="ffe-chat-avatar"><span class="material-symbols-outlined">' + (isAssistant ? 'auto_awesome' : 'person') + '</span></div>' +
      '<div class="ffe-chat-content">' +
        '<div class="ffe-chat-bubble">' + escapeHtml(msg.content || '') + (msg.pending ? '<em>处理中…</em>' : '') + '</div>' +
        (isAssistant ? _ffeWarningsHtml(msg.warnings) : '') +
        (isAssistant && msg.patch ? '<div class="ffe-chat-actions">' +
          '<button type="button" data-ffe-action="toggle-ai-diff" data-chat-idx="' + idx + '">' + (diffOpen ? '收起 diff' : '查看 diff') + '</button>' +
          (hasPatchChanges
            ? '<button type="button" data-ffe-action="' + (msg.undoable ? 'undo-ai-draft' : 'apply-ai-draft') + '" data-chat-idx="' + idx + '"' + (applyDisabled ? ' disabled' : '') + (isDirty ? ' title="当前有未保存的手动编辑，请先保存或放弃后再应用"' : (staleUndo ? ' title="已有后续更新，无法回滚此建议"' : '')) + '>' + applyLabel + '</button>'
            : '<button type="button" disabled>无可应用修改</button>') +
        '</div>' : '') +
        (isAssistant ? _ffeDiffHtml(msg.patch, diffOpen) : '') +
      '</div>' +
    '</article>';
  }).join('') + '</div>';
}

function _ffeRewriteChatSectionHtml(chatDisabled) {
  if (!FIRST_FRAME_REWRITE_CHAT_ENABLED) return '';
  var sendIcon = _firstFrameEditor.rewriting ? 'hourglass_top' : 'arrow_upward';
  var hasChatMessages = Array.isArray(_firstFrameEditor.chat) && _firstFrameEditor.chat.length > 0;
  return _ffePanelHtml('对话区', 'CONVERSATION', _ffeChatHtml(), 'ffe-chat-panel' + (hasChatMessages ? ' has-messages' : '')) +
    '<section class="ffe-chat-input">' +
      '<textarea rows="1" data-ffe-field="chatInput" placeholder="告诉 AI 你想怎么调整这张首帧…"' + (chatDisabled ? ' disabled' : '') + '></textarea>' +
      '<button type="button" class="ffe-send-btn" data-ffe-action="send-ai-message" title="发送"' + (chatDisabled ? ' disabled' : '') + '><span class="material-symbols-outlined">' + sendIcon + '</span></button>' +
    '</section>';
}

function _ffeReferenceMaterialPickerHtml(payload) {
  var picker = _ffeReferenceMaterialPickerState();
  if (!picker.open) return '';
  return renderMaterialPickerHtml({
    panel: _ffeMaterialPanelData(payload) || {},
    picker: picker,
    scope: 'editor',
    groupIdx: _firstFrameEditor.groupIdx,
    actionAttr: 'data-ffe-action',
  });
}

function _ffeModalHtml(payload, gIdx) {
  payload = payload || {};
  var plan = payload.plan || {};
  var currentUrl = payload.currentFrame && payload.currentFrame.url || '';
  var legacy = payload.legacyUnsupported;
  var summary = plan.planSummary || payload.planSummary || {};
  var historyCount = (payload.currentFrame && payload.currentFrame.url ? 1 : 0) + (Array.isArray(payload.imageHistory) ? payload.imageHistory.length : 0);
  var chatDisabled = _firstFrameEditor.saving || _firstFrameEditor.generating || _firstFrameEditor.rewriting;
  var generatingPreview = !!_firstFrameEditor.generating;
  var generatingText = _firstFrameEditor.generatingText || '生成首帧中…';

  return '<div class="ffe-modal" role="dialog" aria-modal="true" aria-label="首帧编辑控制台">' +
    '<button type="button" class="ffe-close" data-ffe-action="close" title="关闭"><span class="material-symbols-outlined">close</span></button>' +
    '<div class="ffe-shell">' +
      '<aside class="ffe-column ffe-context-column">' +
        _ffeGenerationContextHtml(payload) +
      '</aside>' +
      '<main class="ffe-center">' +
        _ffePanelHtml('图片展示区域', _ffeImagePreviewEyebrow(payload),
          '<div class="ffe-preview-slot">' +
            '<div class="ffe-preview-stage' + (generatingPreview ? ' is-generating' : '') + '">' +
              (currentUrl
                ? _ffeImageWithFallbackHtml(currentUrl, { variant: 'preview', alt: '当前首帧', dataAction: 'view-current', dataUrl: currentUrl })
                : '<div class="ffe-image-empty"><span class="material-symbols-outlined">image</span><strong>暂无当前首帧</strong><span>可以先查看系统生成计划</span></div>') +
              (generatingPreview
                ? '<div class="ffe-image-generating" role="status" aria-live="polite">' +
                    '<div class="ffe-image-generating-card">' +
                      '<div class="ffe-image-generating-spinner"></div>' +
                      '<span data-ffe-generating-text>' + escapeHtml(generatingText) + '</span>' +
                    '</div>' +
                  '</div>'
                : '') +
            '</div>' +
          '</div>' +
          _ffeImageAlertHtml(payload) +
          '<div class="ffe-image-actions">' +
            '<button type="button" class="ffe-action-secondary" data-ffe-action="download-current" data-url="' + escapeHtml(currentUrl) + '"' + (currentUrl && !generatingPreview ? '' : ' disabled') + '><span class="material-symbols-outlined">download</span><span>下载图片</span></button>' +
            '<span class="ffe-draft-actions">' +
              '<button type="button" class="ffe-action-ghost" data-ffe-action="restore-initial"' + (payload.draft ? '' : ' disabled') + '><span class="material-symbols-outlined">settings_backup_restore</span><span>恢复初始</span></button>' +
              '<button type="button" class="ffe-action-secondary" data-ffe-action="generate-draft" disabled><span class="material-symbols-outlined">refresh</span><span>重新生成</span></button>' +
            '</span>' +
          '</div>', 'ffe-image-panel') +
        _ffeNegativePromptPanelHtml(payload) +
        _ffeRewriteChatSectionHtml(chatDisabled) +
      '</main>' +
      '<aside class="ffe-right">' +
        '<div class="ffe-history-head"><div><h3>历史图片 list</h3><span>HISTORY</span></div></div>' +
        '<div class="ffe-history-list">' + _ffeHistoryHtml(payload) + '</div>' +
        '<div class="ffe-history-footer"><button type="button" disabled>已显示 ' + historyCount + ' 张</button></div>' +
      '</aside>' +
    '</div>' +
    _ffeReferenceMaterialPickerHtml(payload) +
  '</div>';
}

function _ensureFirstFrameEditorRoot() {
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'firstFrameEditorRoot';
    document.body.appendChild(root);
  }
  return root;
}

function _setFirstFrameEditorLock(locked) {
  if (locked) {
    _firstFrameEditorScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add('first-frame-editor-lock');
    document.body.classList.add('first-frame-editor-lock');
    document.body.style.setProperty('--ffe-lock-scroll-y', '-' + _firstFrameEditorScrollY + 'px');
    return;
  }
  document.body.classList.remove('first-frame-editor-lock');
  document.documentElement.classList.remove('first-frame-editor-lock');
  document.body.style.removeProperty('--ffe-lock-scroll-y');
  if (_firstFrameEditorScrollY) window.scrollTo(0, _firstFrameEditorScrollY);
  _firstFrameEditorScrollY = 0;
}

// 必须与服务端 lib/first-frame-edit-draft.ts 的 cleanText 完全一致：
// 先把"任意空白 + 换行"折叠为单个 \n，再 trim，最后按上限截断。
// 任何一步与服务端偏离，都会让 _ffeHasAutoSaveChanges 判定永远为 true，
// 在关闭弹窗时把 _ffeFlushAutoSave 卡到 flush_guard_exceeded。
function _ffeCleanDraftText(value, limit) {
  var text = String(value == null ? '' : value).replace(/\s+\n/g, '\n').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function _ffeDraftForCompare(draft) {
  draft = draft || {};
  var out = {};
  var prompt = _ffeCleanDraftText(_ffePromptContentFromDraft(draft), FFE_PROMPT_OVERRIDE_MAX_CHARS);
  if (prompt) out.content = prompt;
  var negative = _ffeCleanDraftText(draft.negativePromptOverride, FFE_NEGATIVE_PROMPT_MAX_CHARS);
  if (negative) out.negativePromptOverride = negative;
  var excluded = draft.referenceOverrides && Array.isArray(draft.referenceOverrides.excluded)
    ? draft.referenceOverrides.excluded.map(function (item) {
      var next = {};
      if (item.role) next.role = String(item.role).trim();
      if (item.assetId) next.assetId = String(item.assetId).trim();
      if (item.assetName) next.assetName = String(item.assetName).trim();
      if (Number.isFinite(Number(item.slot))) next.slot = Math.floor(Number(item.slot));
      if (Number.isFinite(Number(item.imageNo))) next.imageNo = Math.floor(Number(item.imageNo));
      return next;
    }).filter(function (item) {
      return item.role || item.assetId || item.assetName || item.slot || item.imageNo;
    })
    : [];
  var added = draft.referenceOverrides && Array.isArray(draft.referenceOverrides.added)
    ? draft.referenceOverrides.added.map(function (item) {
      return {
        role: String(item.role || '').trim(),
        assetId: String(item.assetId || '').trim()
      };
    }).filter(function (item) {
      return item.role && item.assetId;
    })
    : [];
  var seenExcluded = {};
  excluded = excluded.filter(function (item) {
    var key = [item.role || '', item.assetId || '', item.assetName || '', item.slot || '', item.imageNo || ''].join('|').toLowerCase();
    if (seenExcluded[key]) return false;
    seenExcluded[key] = true;
    return true;
  }).sort(function (a, b) {
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
  var seenAdded = {};
  added = added.filter(function (item) {
    var key = (item.role + ':' + item.assetId).toLowerCase();
    if (seenAdded[key]) return false;
    seenAdded[key] = true;
    return true;
  }).sort(function (a, b) {
    return (a.role + ':' + a.assetId).localeCompare(b.role + ':' + b.assetId);
  });
  if (excluded.length || added.length) out.referenceOverrides = {
    ...(excluded.length ? { excluded: excluded } : {}),
    ...(added.length ? { added: added } : {})
  };
  if (draft.firstFrameReferenceSelection && draft.firstFrameReferenceSelection.mode === 'manual') {
    var selection = draft.firstFrameReferenceSelection;
    out.firstFrameReferenceSelection = {
      mode: 'manual',
      includeIds: Array.isArray(selection.includeIds) ? selection.includeIds.map(String).filter(Boolean) : [],
      ...(Array.isArray(selection.excludeIds) && selection.excludeIds.length ? { excludeIds: selection.excludeIds.map(String).filter(Boolean) } : {}),
      ...(Array.isArray(selection.order) && selection.order.length ? { order: selection.order.map(String).filter(Boolean) } : {})
    };
  }
  if (Array.isArray(draft.firstFrameReferenceAttachments) && draft.firstFrameReferenceAttachments.length) {
    out.firstFrameReferenceAttachments = draft.firstFrameReferenceAttachments.map(function (item) {
      return {
        id: String(item.id || ''),
        imageId: String(item.imageId || ''),
        role: String(item.role || ''),
        name: String(item.name || ''),
        url: String(item.url || ''),
        thumbUrl: String(item.thumbUrl || item.url || '')
      };
    }).filter(function (item) { return item.id && item.imageId && item.role && item.url; });
  }
  return out;
}

function _ffeDraftJson(draft) {
  try { return JSON.stringify(_ffeDraftForCompare(draft)); } catch (_) { return '{}'; }
}

function _ffeCloneDraft(draft) {
  try { return JSON.parse(JSON.stringify(draft || {})); } catch (_) { return {}; }
}

function _ffeMarkDraftFieldTouched(field) {
  if (field !== 'content' && field !== 'negativePromptOverride') return;
  var auto = _ffeAutoSaveState();
  if (!auto.touched) auto.touched = {};
  auto.touched[field] = true;
}

function _ffeCurrentSourceHash() {
  return String(_firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash || '');
}

function _ffeCanUndoSavedPatch(msg) {
  if (!msg || !msg.undoable || !msg.beforeSavedDraft || !msg.afterSavedDraftFingerprint) return false;
  if (_ffeDraftDirty()) return false;
  return String(_firstFrameEditor.savedDraftFingerprint || '') === String(msg.afterSavedDraftFingerprint || '')
    && _ffeCurrentSourceHash() === String(msg.afterSourceHash || '');
}

function _ffeResetSavedBaseline(payload) {
  _ffeCancelAutoSaveTimers();
  var savedJson = _ffeDraftJson(payload && payload.draft);
  _firstFrameEditor.originalDraftJson = savedJson;
  _firstFrameEditor.baselineDraftJson = savedJson;
  _firstFrameEditor.savedDraftFingerprint = String(payload && payload.savedDraftFingerprint || '');
  _firstFrameEditor.baselineFingerprint = String(payload && payload.baselineFingerprint || payload && payload.savedDraftFingerprint || '');
  var auto = _ffeAutoSaveState();
  auto.lastSavedDraftJson = savedJson;
  auto.pendingDraftJson = savedJson;
  auto.expectedFingerprint = _firstFrameEditor.savedDraftFingerprint;
  auto.dirtyAt = null;
  auto.errorMessage = "";
  auto.conflict = false;
  auto.touched.content = false;
  auto.touched.negativePromptOverride = false;
  auto.fieldSaving.content = false;
  auto.fieldSaving.negativePromptOverride = false;
  auto.fieldStatus.content = _ffeSavedFieldStatus('content', payload && payload.draft);
  auto.fieldStatus.negativePromptOverride = _ffeSavedFieldStatus('negativePromptOverride', payload && payload.draft);
}

function _ffeCollectDraft() {
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return {};
  var promptEl = root.querySelector('[data-ffe-field="content"]');
  var negativeEl = root.querySelector('[data-ffe-field="negativePromptOverride"]');
  var payloadDraft = _firstFrameEditor.payload && _firstFrameEditor.payload.draft || {};
  var draft = {};
  var prompt = promptEl ? String(promptEl.value || '').trim() : '';
  var existingDraft = _firstFrameEditor.payload && _firstFrameEditor.payload.draft || {};
  var negative = negativeEl ? String(negativeEl.value || '').trim() : '';
  var auto = _ffeAutoSaveState();
  if (prompt && (_ffePromptContentFromDraft(existingDraft) || (auto.touched && auto.touched.content))) draft.content = prompt;
  if (negative) draft.negativePromptOverride = negative;
  if (payloadDraft.firstFrameReferenceSelection) draft.firstFrameReferenceSelection = payloadDraft.firstFrameReferenceSelection;
  if (Array.isArray(payloadDraft.firstFrameReferenceAttachments) && payloadDraft.firstFrameReferenceAttachments.length) {
    draft.firstFrameReferenceAttachments = payloadDraft.firstFrameReferenceAttachments.slice();
  }
  if (!draft.firstFrameReferenceSelection && payloadDraft.referenceOverrides) draft.referenceOverrides = payloadDraft.referenceOverrides;
  return draft;
}

function _ffeDisableActions(root, actions, disabled) {
  actions.forEach(function (name) {
    Array.prototype.slice.call(root.querySelectorAll('[data-ffe-action="' + name + '"]')).forEach(function (el) {
      var computedDisabled = el.getAttribute('data-disabled-computed') === 'true';
      el.disabled = !!disabled || computedDisabled;
      if (computedDisabled) el.setAttribute('aria-disabled', 'true');
      else if (!disabled && el.getAttribute('aria-disabled') === 'true') el.setAttribute('aria-disabled', 'false');
    });
  });
}

function _ffeUpdateDirtyState() {
  if (!_firstFrameEditor.open) return;
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return;
  // 任何会引起 dirty 状态变化的路径（input/change/IME 结束、恢复初始、AI 应用、保存响应等）
  // 都会走到这里，顺带刷新两个 textarea 的字数计数，保证显示永远跟 DOM 实际内容一致。
  _ffeSetFieldCounter('content');
  _ffeSetFieldCounter('negativePromptOverride');
  var dirty = _ffeDraftJson(_ffeCollectDraft()) !== (_firstFrameEditor.originalDraftJson || '{}');
  var saving = !!_firstFrameEditor.saving;
  var generating = !!_firstFrameEditor.generating;
  var restoring = !!_firstFrameEditor.restoring;
  var rewriting = !!_firstFrameEditor.rewriting;
  var genBtn = root.querySelector('[data-ffe-action="generate-draft"]');
  var hasSavedDraft = (_firstFrameEditor.originalDraftJson || '{}') !== '{}';
  if (genBtn) genBtn.disabled = generating || restoring || rewriting;
  Array.prototype.slice.call(root.querySelectorAll('textarea, input, select')).forEach(function (el) {
    var field = el.dataset && el.dataset.ffeField || '';
    var isAutoSavedText = field === 'content' || field === 'negativePromptOverride';
    el.disabled = isAutoSavedText ? (generating || restoring || rewriting) : (generating || saving || restoring || rewriting);
  });
  _ffeDisableActions(root, ['restore-initial'], generating || restoring || rewriting || (!dirty && !hasSavedDraft));
  _ffeDisableActions(root, ['send-ai-message', 'toggle-reference-role-picker', 'choose-reference-upload-role', 'select-reference-material', 'upload-reference-material', 'confirm-reference-material', 'remove-reference-tile', 'apply-ai-draft', 'undo-ai-draft', 'set-current-history'], generating || saving || restoring || rewriting);
  if (dirty) {
    _ffeDisableActions(root, ['apply-ai-draft', 'undo-ai-draft'], true);
  }
  var chatInput = root.querySelector('[data-ffe-field="chatInput"]');
  var sendBtn = root.querySelector('[data-ffe-action="send-ai-message"]');
  if (sendBtn) sendBtn.disabled = generating || saving || restoring || rewriting || !String(chatInput && chatInput.value || '').trim();
}

function _ffeSetFieldErrors(errors) {
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return;
  Array.prototype.slice.call(root.querySelectorAll('.ffe-field-error')).forEach(function (el) { el.remove(); });
  (errors || []).forEach(function (err) {
    var field = err.field || '';
    var target = field === 'referenceOverrides' || field === 'firstFrameReferenceSelection'
      ? root.querySelector('.ffe-material-panel')
      : root.querySelector('[data-ffe-field="' + field + '"]');
    if (!target) return;
    var msg = document.createElement('div');
    msg.className = 'ffe-field-error';
    msg.textContent = err.message || '校验失败';
    if (target.parentElement) target.parentElement.appendChild(msg);
  });
}

function _ffeSetFieldWarnings(warnings) {
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return;
  Array.prototype.slice.call(root.querySelectorAll('.ffe-field-warning')).forEach(function (el) { el.remove(); });
  (warnings || []).forEach(function (warning) {
    var field = warning && warning.field || '';
    if (!field) return;
    var target = field === 'referenceOverrides' || field === 'firstFrameReferenceSelection'
      ? root.querySelector('.ffe-material-panel')
      : root.querySelector('[data-ffe-field="' + field + '"]');
    if (!target) return;
    var msg = document.createElement('div');
    msg.className = 'ffe-field-warning';
    msg.textContent = warning.message || 'AI 已自动调整该字段。';
    if (target.parentElement) target.parentElement.appendChild(msg);
  });
}

function _ffeCancelAutoSaveTimers() {
  var auto = _ffeAutoSaveState();
  if (auto.debounceTimer) {
    clearTimeout(auto.debounceTimer);
    auto.debounceTimer = null;
  }
  if (auto.maxWaitTimer) {
    clearTimeout(auto.maxWaitTimer);
    auto.maxWaitTimer = null;
  }
  if (auto.savingVisibleTimer) {
    clearTimeout(auto.savingVisibleTimer);
    auto.savingVisibleTimer = null;
  }
}

function _ffeParseDraftJson(json) {
  try { return JSON.parse(json || '{}') || {}; } catch (_) { return {}; }
}

function _ffeDraftTextFieldValue(draft, field) {
  return typeof (draft && draft[field]) === 'string' ? String(draft[field]).trim() : '';
}

function _ffeChangedTextFields(nextDraft, prevDraft) {
  return ['content', 'negativePromptOverride'].filter(function (field) {
    return _ffeDraftTextFieldValue(nextDraft, field) !== _ffeDraftTextFieldValue(prevDraft, field);
  });
}

function _ffeRefreshPendingDraftJson() {
  var auto = _ffeAutoSaveState();
  var draft = _ffeCollectDraft();
  var json = _ffeDraftJson(draft);
  auto.pendingDraftJson = json;
  return { draft: draft, json: json };
}

function _ffeHasAutoSaveChanges() {
  var auto = _ffeAutoSaveState();
  return !!auto.forceSaveOnce || auto.pendingDraftJson !== auto.lastSavedDraftJson;
}

function _ffeSetSavingVisibleForFields(fields) {
  fields = Array.isArray(fields) ? fields : [];
  var auto = _ffeAutoSaveState();
  auto.fieldSaving.content = fields.indexOf('content') >= 0;
  auto.fieldSaving.negativePromptOverride = fields.indexOf('negativePromptOverride') >= 0;
  fields.forEach(function (field) { _ffeSetFieldStatus(field, 'saving'); });
}

function _ffeMarkSaveError(fields, message, conflict) {
  var auto = _ffeAutoSaveState();
  auto.errorMessage = message || '保存失败';
  auto.conflict = !!conflict;
  (fields && fields.length ? fields : ['content', 'negativePromptOverride']).forEach(function (field) {
    _ffeSetFieldStatus(field, 'error');
  });
}

function _ffePayloadHasNotice(payload, code) {
  return (Array.isArray(payload && payload.notices) ? payload.notices : []).some(function (notice) {
    return notice && notice.code === code;
  });
}

function _ffeApplyPlanAutoSaveFlags(payload) {
  var auto = _ffeAutoSaveState();
  auto.staleWasShown = !!(payload && payload.draftStale);
  auto.staleNoticeShown = false;
  auto.forceSaveOnce = _ffePayloadHasNotice(payload, 'legacy_style_rules_merged');
}

function _ffeMaybeStartForcedLegacySave() {
  if (_ffeAutoSaveState().forceSaveOnce) {
    _ffeScheduleAutoSave({ source: 'autosave-legacy', immediate: true });
  }
}

function _ffeApplyDraftSaveResponse(resp, options) {
  options = options || {};
  resp = resp || {};
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[_firstFrameEditor.groupIdx]) project.storyboards[_firstFrameEditor.groupIdx] = {};
  project.storyboards[_firstFrameEditor.groupIdx].firstFrameEditDraft = resp.draft || null;
  if (resp.firstFrameBasePrompt) project.storyboards[_firstFrameEditor.groupIdx].firstFrameBasePrompt = resp.firstFrameBasePrompt;
  if (resp.firstFrameBackup) project.storyboards[_firstFrameEditor.groupIdx].firstFrameBackup = resp.firstFrameBackup;
  if (_firstFrameEditor.payload) {
    _firstFrameEditor.payload.draft = resp.draft || null;
    if (resp.sourceHash) _firstFrameEditor.payload.sourceHash = resp.sourceHash;
    if (resp.savedDraftFingerprint) _firstFrameEditor.payload.savedDraftFingerprint = resp.savedDraftFingerprint;
    if (resp.baselineFingerprint) _firstFrameEditor.payload.baselineFingerprint = resp.baselineFingerprint;
    if (resp.firstFrameBasePrompt) _firstFrameEditor.payload.firstFrameBasePrompt = resp.firstFrameBasePrompt;
    if (resp.firstFrameBackup) _firstFrameEditor.payload.firstFrameBackup = resp.firstFrameBackup;
    if (resp.firstFrameMaterialPanel) _ffeApplyMaterialPanel(resp.firstFrameMaterialPanel);
  }
  var savedJson = _ffeDraftJson(resp.draft);
  _firstFrameEditor.originalDraftJson = savedJson;
  _firstFrameEditor.baselineDraftJson = savedJson;
  _firstFrameEditor.savedDraftFingerprint = String(resp.savedDraftFingerprint || '');
  _firstFrameEditor.baselineFingerprint = String(resp.baselineFingerprint || resp.savedDraftFingerprint || '');
  var auto = _ffeAutoSaveState();
  auto.lastSavedDraftJson = savedJson;
  auto.pendingDraftJson = savedJson;
  auto.expectedFingerprint = _firstFrameEditor.savedDraftFingerprint;
  auto.dirtyAt = null;
  auto.errorMessage = "";
  auto.conflict = false;
  auto.forceSaveOnce = false;
  auto.fieldSaving.content = false;
  auto.fieldSaving.negativePromptOverride = false;
  _ffeResetFieldStatusesFromDraft(resp.draft, options.restored === true);
  _sbApplyFirstFrameCardPromptDraftResponse(_firstFrameEditor.groupIdx, resp, { preserveTextarea: true });
  if (auto.staleWasShown && !auto.staleNoticeShown && options.source && String(options.source).indexOf('autosave') === 0) {
    auto.staleNoticeShown = true;
    showToast('已按当前镜头/资产/风格上下文保存', 'success');
  }
}

async function _ffeRetryAutoSaveWithConflictPrompt() {
  var result = await _ffeFlushAutoSave({ source: 'autosave-retry' });
  if (result && result.ok) return true;
  if (result && result.code === 'saved_draft_changed') {
    var overwrite = window.confirm('草稿在另一处被修改，是否用本窗口的版本覆盖？');
    if (!overwrite) {
      var refresh = window.confirm('是否刷新到最新草稿？刷新会放弃本窗口未保存修改。');
      if (refresh) await _refreshFirstFrameEditor();
      return false;
    }
    var forced = await _ffeRunOneSaveCycle({ source: 'autosave-force', force: true, forceSave: true, noRetry: true });
    return !!(forced && forced.ok);
  }
  return false;
}

async function _ffePostDraftSnapshot(draft, options) {
  options = options || {};
  var auto = _ffeAutoSaveState();
  return await apiPost('/api/frames/edit-draft', {
    projectId: project.id,
    groupIdx: _firstFrameEditor.groupIdx,
    draft: draft || {},
    expectedSavedDraftFingerprint: auto.expectedFingerprint || _firstFrameEditor.savedDraftFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.savedDraftFingerprint) || '',
    force: options.force === true,
  }, 'PUT');
}

async function _ffeRunOneSaveCycle(options) {
  options = options || {};
  var auto = _ffeAutoSaveState();
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id) return { ok: false, code: 'not_open' };
  if (_firstFrameEditor.generating || _firstFrameEditor.rewriting) return { ok: false, code: 'blocked' };
  if (auto.inFlightPromise) return await auto.inFlightPromise;
  _ffeCancelAutoSaveTimers();
  var explicitDraft = Object.prototype.hasOwnProperty.call(options, 'draftOverride') ? (options.draftOverride || {}) : null;
  var snapshot = explicitDraft ? { draft: explicitDraft, json: _ffeDraftJson(explicitDraft) } : _ffeRefreshPendingDraftJson();
  if (!options.forceSave && !auto.forceSaveOnce && snapshot.json === auto.lastSavedDraftJson) {
    return { ok: true, skipped: true, resp: null };
  }
  var changedFields = _ffeChangedTextFields(snapshot.draft, _ffeParseDraftJson(auto.lastSavedDraftJson));
  if (auto.forceSaveOnce && !changedFields.length) changedFields = ['content'];
  var promise = (async function () {
    var visibleTimer = null;
    var attempts = options.noRetry ? 1 : 2;
    _firstFrameEditor.saving = true;
    _ffeUpdateDirtyState();
    visibleTimer = setTimeout(function () {
      auto.savingVisibleTimer = null;
      _ffeSetSavingVisibleForFields(changedFields);
    }, FFE_AUTOSAVE_SAVING_VISIBLE_MS);
    auto.savingVisibleTimer = visibleTimer;
    for (var attempt = 0; attempt < attempts; attempt += 1) {
      try {
        var resp = await _ffePostDraftSnapshot(snapshot.draft, options);
        if (visibleTimer) {
          clearTimeout(visibleTimer);
          visibleTimer = null;
          auto.savingVisibleTimer = null;
        }
        _ffeApplyDraftSaveResponse(resp, { source: options.source || 'autosave' });
        if (options.showSuccess) showToast('首帧草稿已保存', 'success');
        return { ok: true, resp: resp };
      } catch (e) {
        var payload = e && e.payload || {};
        if (payload.code === 'saved_draft_changed') {
          if (visibleTimer) {
            clearTimeout(visibleTimer);
            visibleTimer = null;
            auto.savingVisibleTimer = null;
          }
          _ffeMarkSaveError(changedFields, payload.error || '草稿在另一处被修改', true);
          showToast('草稿在另一处被修改，请重试或刷新后继续。', 'warn');
          return { ok: false, code: 'saved_draft_changed', payload: payload };
        }
        if (payload.code === 'validation_failed' && Array.isArray(payload.errors)) {
          if (visibleTimer) {
            clearTimeout(visibleTimer);
            visibleTimer = null;
            auto.savingVisibleTimer = null;
          }
          _ffeSetFieldErrors(payload.errors);
          _ffeMarkSaveError(changedFields, '草稿校验失败', false);
          showToast('草稿校验失败，请检查标红字段', 'warn');
          return { ok: false, code: 'validation_failed', payload: payload };
        }
        if (attempt + 1 >= attempts) {
          if (visibleTimer) {
            clearTimeout(visibleTimer);
            visibleTimer = null;
            auto.savingVisibleTimer = null;
          }
          _ffeMarkSaveError(changedFields, '保存失败', false);
          showToast('自动保存失败: ' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
          return { ok: false, code: payload.code || 'save_failed', payload: payload };
        }
      }
    }
    return { ok: false, code: 'save_failed' };
  })();
  auto.inFlightPromise = promise;
  try {
    return await promise;
  } finally {
    _firstFrameEditor.saving = false;
    auto.inFlightPromise = null;
    _ffeUpdateDirtyState();
  }
}

function _ffeScheduleAutoSave(options) {
  options = options || {};
  var auto = _ffeAutoSaveState();
  if (!_firstFrameEditor.open || _firstFrameEditor.generating || _firstFrameEditor.rewriting) return;
  if (auto.composing) return;
  _ffeRefreshPendingDraftJson();
  if (!_ffeHasAutoSaveChanges()) {
    auto.dirtyAt = null;
    return;
  }
  if (!auto.dirtyAt) auto.dirtyAt = Date.now();
  if (auto.debounceTimer) clearTimeout(auto.debounceTimer);
  if (auto.maxWaitTimer) clearTimeout(auto.maxWaitTimer);
  auto.debounceTimer = null;
  auto.maxWaitTimer = null;
  var run = function () {
    _ffeRunOneSaveCycle({ source: options.source || 'autosave' }).then(function (res) {
      _ffeRefreshPendingDraftJson();
      if (res && res.ok && _ffeHasAutoSaveChanges() && !_ffeAutoSaveState().composing) {
        _ffeScheduleAutoSave({ source: 'autosave-followup' });
      }
    });
  };
  if (options.immediate) {
    run();
    return;
  }
  auto.debounceTimer = setTimeout(run, FFE_AUTOSAVE_DEBOUNCE_MS);
  var waitMs = Math.max(0, auto.dirtyAt + FFE_AUTOSAVE_MAX_WAIT_MS - Date.now());
  auto.maxWaitTimer = setTimeout(run, waitMs);
}

async function _ffeFlushAutoSave(options) {
  options = options || {};
  var auto = _ffeAutoSaveState();
  if (auto.currentFlushPromise) return await auto.currentFlushPromise;
  auto.currentFlushPromise = (async function () {
    var guard = 0;
    while (guard < 8) {
      guard += 1;
      _ffeRefreshPendingDraftJson();
      if (!_ffeHasAutoSaveChanges()) return { ok: true };
      var result = await _ffeRunOneSaveCycle({ source: options.source || 'autosave-flush', forceSave: true, noRetry: options.noRetry === true });
      if (!result || !result.ok) return result || { ok: false, code: 'save_failed' };
    }
    return { ok: false, code: 'flush_guard_exceeded' };
  })();
  try {
    return await auto.currentFlushPromise;
  } finally {
    auto.currentFlushPromise = null;
  }
}

function _ffeFlushAutoSaveOnPageHide() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id) return;
  var pending = _ffeRefreshPendingDraftJson();
  if (!_ffeHasAutoSaveChanges()) return;
  var body = JSON.stringify({
    projectId: project.id,
    groupIdx: _firstFrameEditor.groupIdx,
    draft: pending.draft || {},
    expectedSavedDraftFingerprint: _firstFrameEditor.savedDraftFingerprint || _ffeAutoSaveState().expectedFingerprint || '',
    force: true,
  });
  try {
    fetch('/api/frames/edit-draft', {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: body,
      keepalive: true,
    }).catch(function () {});
  } catch (_) {}
}

function _ffeBeforeUnloadHasUnsavedChanges() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null) return false;
  _ffeRefreshPendingDraftJson();
  return _ffeHasAutoSaveChanges();
}

function _ffeFlushFailureMessage(result) {
  var code = result && result.code || '';
  if (code === 'saved_draft_changed') return '草稿在另一处被修改，请重试保存或刷新后继续。';
  if (code === 'validation_failed') return '草稿校验失败，请检查提示词或参考图设置。';
  if (code === 'flush_guard_exceeded') return '自动保存未完成，请稍后重试。';
  if (code === 'blocked') return '当前正在生成或改写，暂时不能重新生成。';
  return '自动保存失败，未开始重新生成。';
}

async function _refreshFirstFrameEditor() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id) return;
  var gIdx = _firstFrameEditor.groupIdx;
  var previousChatKey = _ffeChatStorageKey(_firstFrameEditor.payload, gIdx);
  var payload = await apiGet('/api/frames/plan?projectId=' + encodeURIComponent(project.id) + '&groupIdx=' + encodeURIComponent(gIdx) + '&frameType=first_frame');
  var nextChatKey = _ffeChatStorageKey(payload, gIdx);
  if (previousChatKey && nextChatKey && previousChatKey !== nextChatKey) {
    _firstFrameEditor.chat = _ffeLoadChat(payload, gIdx);
  }
  _firstFrameEditor.payload = payload;
  _ffeResetSavedBaseline(payload);
  _ffeApplyPlanAutoSaveFlags(payload);
  _renderFirstFrameEditor(payload, gIdx, false);
  _ffeMaybeStartForcedLegacySave();
}

async function _generateFirstFrameFromEditor() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null) return;
  var gIdx = _firstFrameEditor.groupIdx;
  _ffeClearGenerateBlock();
  var flushed = await _ffeFlushAutoSave({ source: 'autosave-generate' });
  if (!flushed || !flushed.ok) {
    _ffeSetGenerateBlock(_ffeFlushFailureMessage(flushed), {
      code: flushed && flushed.code === 'flush_guard_exceeded' ? 'flush_overflow' : 'autosave_failed',
      reason: flushed && flushed.code || ''
    });
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
    return;
  }
  var preflightOk = await _ffeEnsureFirstFramePreflightAllowed(gIdx);
  if (!preflightOk) return;

  _firstFrameEditor.generating = true;
  _ffeSetGeneratingPreviewText('生成首帧中…');
  _ffeUpdateDirtyState();
  _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
  var shouldRefreshAfterGenerate = false;
  try {
    await generateStoryboardSheet(gIdx, {
      applyEditDraft: true,
      skipPreflight: true,
      onLoadingText: _ffeSetGeneratingPreviewText,
      onStartError: function (err) {
        var payload = err && err.payload || {};
        _ffeSetGenerateBlock('重新生成失败：' + _diagnoseApiError(((err && err.message) || err).toString()), {
          code: 'batch_failed',
          reason: payload.code || ''
        });
        _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
        renderImageGrid();
        return true;
      }
    });
    if (!_firstFrameEditor.generateBlock) {
      shouldRefreshAfterGenerate = true;
    }
  } finally {
    _firstFrameEditor.generating = false;
    _ffeClearGeneratingPreviewText();
    _ffeUpdateDirtyState();
  }
  if (shouldRefreshAfterGenerate) {
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
    await _refreshFirstFrameEditor();
  } else if (_firstFrameEditor.open && _firstFrameEditor.generateBlock) {
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
  }
}

async function _ffeApplyRestoreInitialResponse(resp) {
  resp = resp || {};
  if (project.storyboards && project.storyboards[_firstFrameEditor.groupIdx]) {
    delete project.storyboards[_firstFrameEditor.groupIdx].firstFrameEditDraft;
    if (resp.firstFrameBasePrompt) project.storyboards[_firstFrameEditor.groupIdx].firstFrameBasePrompt = resp.firstFrameBasePrompt;
    if (resp.firstFrameBackup) project.storyboards[_firstFrameEditor.groupIdx].firstFrameBackup = resp.firstFrameBackup;
  }
  if (_firstFrameEditor.payload) {
    _firstFrameEditor.payload.draft = null;
    if (resp.sourceHash) _firstFrameEditor.payload.sourceHash = resp.sourceHash;
    if (resp.savedDraftFingerprint) _firstFrameEditor.payload.savedDraftFingerprint = resp.savedDraftFingerprint;
    if (resp.baselineFingerprint) _firstFrameEditor.payload.baselineFingerprint = resp.baselineFingerprint;
    if (resp.firstFrameBasePrompt) _firstFrameEditor.payload.firstFrameBasePrompt = resp.firstFrameBasePrompt;
    if (resp.firstFrameBackup) _firstFrameEditor.payload.firstFrameBackup = resp.firstFrameBackup;
  }
  showToast('已恢复初始首帧计划', 'success');
  await _refreshFirstFrameEditor();
  _ffeResetFieldStatusesFromDraft(null, true);
}

async function _restoreFirstFrameInitial() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id) return;
  if (_firstFrameEditor.generating || _firstFrameEditor.restoring) return;
  var ok = window.confirm('将恢复为系统初始首帧计划，当前提示词、负向词和参考图草稿都会清空。是否继续？');
  if (!ok) return;
  _ffeCancelAutoSaveTimers();
  var auto = _ffeAutoSaveState();
  if (auto.inFlightPromise) {
    var inflight = await auto.inFlightPromise;
    if (!inflight || !inflight.ok) return;
  }
  _firstFrameEditor.restoring = true;
  _ffeUpdateDirtyState();
  try {
    var resp = await apiPost('/api/frames/edit-draft', {
      projectId: project.id,
      groupIdx: _firstFrameEditor.groupIdx,
      expectedSavedDraftFingerprint: auto.expectedFingerprint || _firstFrameEditor.savedDraftFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.savedDraftFingerprint) || '',
    }, 'DELETE');
    await _ffeApplyRestoreInitialResponse(resp);
  } catch (e) {
    var payload = e && e.payload || {};
    if (payload.code === 'saved_draft_changed') {
      var overwrite = window.confirm('草稿在另一处被修改，是否继续恢复初始并覆盖远端草稿？');
      if (overwrite) {
        try {
          var forcedResp = await apiPost('/api/frames/edit-draft', {
            projectId: project.id,
            groupIdx: _firstFrameEditor.groupIdx,
            expectedSavedDraftFingerprint: auto.expectedFingerprint || _firstFrameEditor.savedDraftFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.savedDraftFingerprint) || '',
            force: true,
          }, 'DELETE');
          await _ffeApplyRestoreInitialResponse(forcedResp);
        } catch (forceErr) {
          showToast('恢复初始失败: ' + _diagnoseApiError(((forceErr && forceErr.message) || forceErr).toString()), 'error');
        }
      } else {
        var refresh = window.confirm('是否刷新到最新草稿？刷新会放弃本窗口未保存修改。');
        if (refresh) await _refreshFirstFrameEditor();
        else showToast('已保留当前本地编辑。', 'warn');
      }
      return;
    }
    showToast('恢复初始失败: ' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
  } finally {
    _firstFrameEditor.restoring = false;
    _ffeUpdateDirtyState();
  }
}

function _ffeReferenceMutationBase() {
  return _materialReferenceMutationBase({
    source: 'editor',
    groupIdx: _firstFrameEditor.groupIdx,
    panel: _ffeMaterialPanelData(_firstFrameEditor.payload) || {},
    sourceHash: _firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash || '',
  });
}

function _materialReferenceMutationBase(options) {
  options = options || {};
  var panel = options.panel || {};
  return {
    source: options.source || 'shot',
    projectId: options.projectId || (project && project.id) || '',
    groupIdx: options.groupIdx,
    baseSourceHash: panel.sourceHash || options.sourceHash || '',
    baseSelectionVersion: panel.selectionVersion || options.selectionVersion || '',
  };
}

function _ffeDraftDirty() {
  return _ffeDraftJson(_ffeCollectDraft()) !== (_firstFrameEditor.originalDraftJson || '{}');
}

async function _ffeSaveBeforeReferenceMutation() {
  var flushed = await _ffeFlushAutoSave({ source: 'autosave-reference' });
  return !!(flushed && flushed.ok);
}

function _ffeReferenceMutationError(e) {
  var payload = e && e.payload || {};
  if (payload.code === 'reference_source_changed') return '参考素材已变更，请刷新后继续。';
  if (payload.code === 'reference_selection_changed') return '参考素材状态已更新，请确认后重试。';
  if (payload.code === 'reference_selection_unavailable') return '部分参考图已不可用，请刷新后重试。';
  if (payload.code === 'reference_cap_reached') return payload.error || '参考图已达上限，请先移除一张后再添加。';
  return _diagnoseApiError(((e && e.message) || e).toString());
}

function _ffeApplyMaterialPanel(panel) {
  if (!_firstFrameEditor.payload || !panel) return;
  if (_firstFrameEditor.groupIdx != null) {
    setMaterialPanel(_firstFrameEditor.groupIdx, panel, {
      sourceHash: panel.sourceHash || (_firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash) || '',
      selectionVersion: panel.selectionVersion || '',
    });
  }
  _firstFrameEditor.payload.firstFrameMaterialPanel = panel;
  if (_firstFrameEditor.payload.plan) _firstFrameEditor.payload.plan.firstFrameMaterialPanel = panel;
}

function _applyMaterialMutationPanel(groupIdx, panel, sourceHash) {
  if (!panel || groupIdx == null) return;
  setMaterialPanel(groupIdx, panel, {
    sourceHash: panel.sourceHash || sourceHash || '',
    selectionVersion: panel.selectionVersion || '',
  });
  if (_firstFrameEditor.open && Number(_firstFrameEditor.groupIdx) === Number(groupIdx)) {
    _ffeApplyMaterialPanel(panel);
  }
  _rerenderMaterialPanelSlot(groupIdx);
  _renderShotMaterialPickerOverlay();
}

async function _persistMaterialReferenceSelection(options) {
  options = options || {};
  var base = _materialReferenceMutationBase(options);
  if (!base.projectId || base.groupIdx == null) return { ok: false };
  var isEditor = base.source === 'editor';
  if (isEditor) {
    if (!_firstFrameEditor.open) return { ok: false };
    if (!await _ffeSaveBeforeReferenceMutation()) return { ok: false };
    _firstFrameEditor.saving = true;
    _ffeUpdateDirtyState();
  }
  try {
    var resp = await apiPost('/api/frames/reference-selection', {
      projectId: base.projectId,
      groupIdx: base.groupIdx,
      includeIds: options.includeIds || [],
      baseSourceHash: base.baseSourceHash,
      baseSelectionVersion: base.baseSelectionVersion,
    }, 'PUT');
    if (isEditor) _ffeApplyDraftSaveResponse(resp, { source: 'reference' });
    else _sbApplyFirstFrameCardPromptDraftResponse(base.groupIdx, resp, { preserveTextarea: true });
    if (resp.firstFrameMaterialPanel) _applyMaterialMutationPanel(base.groupIdx, resp.firstFrameMaterialPanel, resp.sourceHash);
    if (isEditor) await _refreshFirstFrameEditor();
    return { ok: true, resp: resp };
  } catch (e) {
    var payload = e && e.payload || {};
    if (payload.firstFrameMaterialPanel) _applyMaterialMutationPanel(base.groupIdx, payload.firstFrameMaterialPanel, payload.sourceHash || base.baseSourceHash);
    if (isEditor && (payload.code === 'reference_source_changed' || payload.code === 'reference_selection_changed' || payload.code === 'reference_selection_unavailable')) {
      await _refreshFirstFrameEditor();
    }
    showToast(_ffeReferenceMutationError(e), 'warn');
    return { ok: false, error: e };
  } finally {
    if (isEditor) {
      _firstFrameEditor.saving = false;
      _ffeUpdateDirtyState();
    }
  }
}

async function _ffePersistReferenceSelection(includeIds) {
  var result = await _persistMaterialReferenceSelection({
    source: 'editor',
    groupIdx: _firstFrameEditor.groupIdx,
    panel: _ffeMaterialPanelData(_firstFrameEditor.payload) || {},
    sourceHash: _firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash || '',
    includeIds: includeIds || [],
  });
  return !!(result && result.ok);
}

function _ffeOpenReferenceMaterialPicker(role) {
  var panel = _ffeMaterialPanelData(_firstFrameEditor.payload) || {};
  if (_ffeReferenceAddDisabled(panel)) {
    showToast(_ffeReferenceCapMessage(panel), 'warn');
    return;
  }
  var picker = _ffeReferenceMaterialPickerState();
  picker.open = true;
  picker.role = role || 'scene';
  picker.selectedId = "";
  picker.uploading = false;
  picker.error = "";
  _firstFrameEditor.referenceRolePickerOpen = false;
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
}

function _ffeCloseReferenceMaterialPicker() {
  var picker = _ffeReferenceMaterialPickerState();
  picker.open = false;
  picker.role = null;
  picker.selectedId = "";
  picker.uploading = false;
  picker.error = "";
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
}

function _ffeSelectReferenceMaterial(tileId) {
  var picker = _ffeReferenceMaterialPickerState();
  if (!picker.open || !tileId) return;
  var panel = _ffeMaterialPanelData(_firstFrameEditor.payload) || {};
  var selectedSet = _ffeSelectedTileIdSet(panel);
  if (selectedSet[tileId]) return;
  if (Number(panel.remaining || 0) <= 0 && picker.selectedId !== tileId) {
    picker.error = _ffeReferenceCapMessage(panel) || '参考图已达上限，请先移除一张后再添加。';
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    return;
  }
  picker.selectedId = tileId;
  picker.error = "";
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
}

async function _uploadMaterialReferenceFile(options) {
  options = options || {};
  var base = _materialReferenceMutationBase(options);
  if (!base.projectId || base.groupIdx == null || !options.file) {
    throw new Error('缺少上传参考素材所需参数');
  }
  var form = new FormData();
  form.append('file', options.file);
  form.append('projectId', String(base.projectId || ''));
  form.append('groupIdx', String(base.groupIdx));
  form.append('role', options.role || 'scene');
  form.append('baseSourceHash', base.baseSourceHash || '');
  form.append('baseSelectionVersion', base.baseSelectionVersion || '');
  var resp = await fetch('/api/frames/reference-material-upload', {
    method: 'POST',
    headers: _ffeAuthHeadersForUpload(),
    body: form,
  });
  var data = await resp.json().catch(function () { return {}; });
  if (!resp.ok || data.error) {
    if (data.firstFrameMaterialPanel) _applyMaterialMutationPanel(base.groupIdx, data.firstFrameMaterialPanel, data.sourceHash || base.baseSourceHash);
    var err = new Error(data.error || '上传参考素材失败');
    err.payload = data;
    throw err;
  }
  if (data.firstFrameMaterialPanel) _applyMaterialMutationPanel(base.groupIdx, data.firstFrameMaterialPanel, data.sourceHash || base.baseSourceHash);
  return data;
}

async function _ffeUploadReferenceMaterialFile(role, file) {
  return _uploadMaterialReferenceFile({
    source: 'editor',
    groupIdx: _firstFrameEditor.groupIdx,
    panel: _ffeMaterialPanelData(_firstFrameEditor.payload) || {},
    sourceHash: _firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash || '',
    role: role,
    file: file,
  });
}

function _ffePickAndUploadReferenceMaterial() {
  var picker = _ffeReferenceMaterialPickerState();
  if (!picker.open || !picker.role || picker.uploading) return;
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = false;
  input.style.display = 'none';
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) {
      try { input.remove(); } catch (_) {}
      return;
    }
    picker.uploading = true;
    picker.error = "";
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    _ffeUploadReferenceMaterialFile(picker.role, file).then(function (data) {
      if (data.firstFrameMaterialPanel) _ffeApplyMaterialPanel(data.firstFrameMaterialPanel);
      picker.uploading = false;
      picker.selectedId = data.material && data.material.id || "";
      picker.error = "";
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    }).catch(function (e) {
      var payload = e && e.payload || {};
      if (payload.firstFrameMaterialPanel) _ffeApplyMaterialPanel(payload.firstFrameMaterialPanel);
      picker.uploading = false;
      picker.error = _ffeReferenceMutationError(e);
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    }).finally(function () {
      try { input.remove(); } catch (_) {}
    });
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(function () { try { input.remove(); } catch (_) {} }, 10000);
}

async function _ffeConfirmReferenceMaterial() {
  var picker = _ffeReferenceMaterialPickerState();
  if (!picker.open) return;
  var panel = _ffeMaterialPanelData(_firstFrameEditor.payload) || {};
  var selectedSet = _ffeSelectedTileIdSet(panel);
  var selectedTile = _ffeCandidateTilesForRole(panel, picker.role).find(function (tile) { return tile && tile.id === picker.selectedId; }) || null;
  if (!picker.selectedId || !selectedTile || selectedSet[picker.selectedId]) {
    picker.open = false;
    picker.role = null;
    picker.selectedId = "";
    picker.error = "";
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    return;
  }
  if (Number(panel.remaining || 0) <= 0) {
    picker.error = _ffeReferenceCapMessage(panel) || '参考图已达上限，请先移除一张后再添加。';
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    return;
  }
  var includeIds = _ffePanelTileIds(panel).concat([picker.selectedId]).filter(function (id, idx, list) {
    return id && list.indexOf(id) === idx;
  });
  var ok = await _ffePersistReferenceSelection(includeIds);
  if (ok) {
    picker.open = false;
    picker.role = null;
    picker.selectedId = "";
    picker.error = "";
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
    showToast('参考素材已添加', 'success');
  } else {
    picker.error = '添加失败，请刷新后重试。';
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
  }
}

async function _ffeRemoveReferenceTile(tileId) {
  var panel = _ffeMaterialPanelData(_firstFrameEditor.payload);
  var ids = _ffePanelTileIds(panel).filter(function (id) { return id !== tileId; });
  var ok = await _ffePersistReferenceSelection(ids);
  if (ok) showToast('已从本次首帧参考中移除', 'success');
}

function _materialPanelActionContext(btn) {
  var holder = btn && btn.closest && btn.closest('[data-group-idx]');
  var groupRaw = btn && btn.dataset && btn.dataset.groupIdx || holder && holder.dataset && holder.dataset.groupIdx;
  var groupIdx = Number(groupRaw);
  if (!Number.isFinite(groupIdx)) groupIdx = -1;
  var scope = btn && btn.dataset && btn.dataset.materialScope || holder && holder.dataset && holder.dataset.materialScope || 'shot';
  return {
    scope: scope,
    groupIdx: groupIdx,
  };
}

function _rerenderShotInteractionTargets(prevGroupIdx, nextGroupIdx) {
  var hasPrev = prevGroupIdx != null && Number(prevGroupIdx) >= 0;
  var hasNext = nextGroupIdx != null && Number(nextGroupIdx) >= 0;
  if (hasPrev) _rerenderMaterialPanelSlot(Number(prevGroupIdx));
  if (hasNext && (!hasPrev || Number(nextGroupIdx) !== Number(prevGroupIdx))) {
    _rerenderMaterialPanelSlot(Number(nextGroupIdx));
  }
}

function _setShotMaterialRolePicker(groupIdx, open) {
  var prev = materialPanelState.activeRolePicker;
  var prevGroup = prev && prev.surface === 'shot' ? prev.groupIdx : null;
  setMaterialPanelActiveRolePicker(open ? { surface: 'shot', groupIdx: groupIdx } : null);
  _rerenderShotInteractionTargets(prevGroup, groupIdx);
}

function _setShotMaterialPicker(nextPicker, fallbackGroupIdx) {
  var prev = materialPanelState.activePicker;
  var prevGroup = prev && prev.surface === 'shot' ? prev.groupIdx : null;
  setMaterialPanelActivePicker(nextPicker);
  _rerenderShotInteractionTargets(prevGroup, nextPicker && nextPicker.groupIdx != null ? nextPicker.groupIdx : fallbackGroupIdx);
  _renderShotMaterialPickerOverlay();
}

function _activeShotMaterialPicker(groupIdx) {
  var picker = materialPanelState.activePicker;
  if (picker && picker.surface === 'shot' && Number(picker.groupIdx) === Number(groupIdx)) {
    return Object.assign({ open: true }, picker);
  }
  return null;
}

function _maybeRefreshShotMaterialPanelAfterInteraction(groupIdx) {
  if (!project || !project.id || !materialPanelNeedsPostInteractionRefresh(groupIdx)) return;
  fetchMaterialPanels(project.id, { groupIdx: groupIdx }).then(_refreshMaterialPanelSlots).catch(function (err) {
    console.warn('[MaterialPanel] post-interaction refresh failed:', (err && err.message) || err);
  });
}

function _openShotReferenceMaterialPicker(groupIdx, role) {
  var panel = getMaterialPanel(groupIdx) || {};
  if (_ffeReferenceAddDisabled(panel)) {
    showToast(_ffeReferenceCapMessage(panel), 'warn');
    return;
  }
  setMaterialPanelActiveRolePicker(null);
  _setShotMaterialPicker({
    surface: 'shot',
    groupIdx: groupIdx,
    open: true,
    role: role || 'scene',
    selectedId: '',
    uploading: false,
    error: '',
  }, groupIdx);
}

function _closeShotReferenceMaterialPicker(groupIdx) {
  _setShotMaterialPicker(null, groupIdx);
  _maybeRefreshShotMaterialPanelAfterInteraction(groupIdx);
}

function _selectShotReferenceMaterial(groupIdx, tileId) {
  var picker = _activeShotMaterialPicker(groupIdx);
  if (!picker || !tileId) return;
  var panel = getMaterialPanel(groupIdx) || {};
  var selectedSet = _ffeSelectedTileIdSet(panel);
  if (selectedSet[tileId]) return;
  if (Number(panel.remaining || 0) <= 0 && picker.selectedId !== tileId) {
    picker.error = _ffeReferenceCapMessage(panel) || '参考图已达上限，请先移除一张后再添加。';
    _setShotMaterialPicker(picker, groupIdx);
    return;
  }
  picker.selectedId = tileId;
  picker.error = '';
  _setShotMaterialPicker(picker, groupIdx);
}

async function _confirmShotReferenceMaterial(groupIdx) {
  var picker = _activeShotMaterialPicker(groupIdx);
  if (!picker) return;
  var panel = getMaterialPanel(groupIdx) || {};
  var selectedSet = _ffeSelectedTileIdSet(panel);
  var selectedTile = _ffeCandidateTilesForRole(panel, picker.role).find(function (tile) {
    return tile && tile.id === picker.selectedId;
  }) || null;
  if (!picker.selectedId || !selectedTile || selectedSet[picker.selectedId]) {
    _closeShotReferenceMaterialPicker(groupIdx);
    return;
  }
  if (Number(panel.remaining || 0) <= 0) {
    picker.error = _ffeReferenceCapMessage(panel) || '参考图已达上限，请先移除一张后再添加。';
    _setShotMaterialPicker(picker, groupIdx);
    return;
  }
  var includeIds = _ffePanelTileIds(panel).concat([picker.selectedId]).filter(function (id, idx, list) {
    return id && list.indexOf(id) === idx;
  });
  var result = await _persistMaterialReferenceSelection({
    source: 'shot',
    groupIdx: groupIdx,
    panel: panel,
    includeIds: includeIds,
  });
  if (result && result.ok) {
    _closeShotReferenceMaterialPicker(groupIdx);
    showToast('参考素材已添加', 'success');
  } else {
    picker.error = '添加失败，请刷新后重试。';
    _setShotMaterialPicker(picker, groupIdx);
  }
}

async function _removeShotReferenceTile(groupIdx, tileId) {
  var panel = getMaterialPanel(groupIdx) || {};
  var ids = _ffePanelTileIds(panel).filter(function (id) { return id !== tileId; });
  var result = await _persistMaterialReferenceSelection({
    source: 'shot',
    groupIdx: groupIdx,
    panel: panel,
    includeIds: ids,
  });
  if (result && result.ok) {
    _rerenderMaterialPanelSlot(groupIdx);
    showToast('已从本次首帧参考中移除', 'success');
  }
}

function _pickAndUploadShotReferenceMaterial(groupIdx) {
  var picker = _activeShotMaterialPicker(groupIdx);
  if (!picker || !picker.role || picker.uploading) return;
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = false;
  input.style.display = 'none';
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) {
      try { input.remove(); } catch (_) {}
      return;
    }
    picker.uploading = true;
    picker.error = '';
    setMaterialPanelUploading('shot', groupIdx, true);
    _setShotMaterialPicker(picker, groupIdx);
    _uploadMaterialReferenceFile({
      source: 'shot',
      groupIdx: groupIdx,
      panel: getMaterialPanel(groupIdx) || {},
      role: picker.role,
      file: file,
    }).then(function (data) {
      var nextPicker = _activeShotMaterialPicker(groupIdx) || picker;
      nextPicker.uploading = false;
      nextPicker.selectedId = data.material && data.material.id || '';
      nextPicker.error = '';
      setMaterialPanelUploading('shot', groupIdx, false);
      _setShotMaterialPicker(nextPicker, groupIdx);
      _maybeRefreshShotMaterialPanelAfterInteraction(groupIdx);
    }).catch(function (e) {
      var nextPicker = _activeShotMaterialPicker(groupIdx) || picker;
      nextPicker.uploading = false;
      nextPicker.error = _ffeReferenceMutationError(e);
      setMaterialPanelUploading('shot', groupIdx, false);
      _setShotMaterialPicker(nextPicker, groupIdx);
    }).finally(function () {
      try { input.remove(); } catch (_) {}
    });
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(function () { try { input.remove(); } catch (_) {} }, 10000);
}

async function _handleMaterialPanelAction(ev) {
  if (!project) return;
  if (ev.target && ev.target.classList && ev.target.classList.contains('ffe-material-picker-backdrop') && ev.target.dataset && ev.target.dataset.materialScope === 'shot') {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    _closeShotReferenceMaterialPicker(Number(ev.target.dataset.groupIdx));
    return;
  }
  var btn = ev.target && ev.target.closest && ev.target.closest('[data-material-action]');
  if (!btn) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  var action = btn.dataset.materialAction || '';
  var ctx = _materialPanelActionContext(btn);
  if (ctx.scope !== 'shot' || ctx.groupIdx < 0) return;
  var groupIdx = ctx.groupIdx;

  if (action === 'download-all-material') {
    await _downloadAllPanelMaterials(getMaterialPanel(groupIdx), groupIdx);
    return;
  }
  if (action === 'view-ref') {
    var viewUrl = btn.dataset.url || '';
    if (viewUrl) _openLightbox(viewUrl);
    return;
  }
  if (action === 'toggle-reference-role-picker') {
    var panel = getMaterialPanel(groupIdx) || {};
    if (_ffeReferenceAddDisabled(panel)) {
      showToast(_ffeReferenceCapMessage(panel), 'warn');
      return;
    }
    _setShotMaterialRolePicker(groupIdx, !_isShotMaterialRolePickerOpen(groupIdx));
    return;
  }
  if (action === 'choose-reference-upload-role') {
    _openShotReferenceMaterialPicker(groupIdx, btn.dataset.role || 'scene');
    return;
  }
  if (action === 'close-reference-material-picker') {
    _closeShotReferenceMaterialPicker(groupIdx);
    return;
  }
  if (action === 'select-reference-material') {
    if (btn.closest('.is-image-missing') || btn.closest('[data-image-missing="true"]') || btn.querySelector('.is-image-missing, [data-image-missing="true"]')) {
      showToast('图片暂不可用，不能作为参考图', 'warn');
      return;
    }
    _selectShotReferenceMaterial(groupIdx, btn.dataset.tileId || '');
    return;
  }
  if (action === 'upload-reference-material') {
    _pickAndUploadShotReferenceMaterial(groupIdx);
    return;
  }
  if (action === 'confirm-reference-material') {
    await _confirmShotReferenceMaterial(groupIdx);
    return;
  }
  if (action === 'remove-reference-tile') {
    var tileId = btn.dataset.tileId || '';
    if (tileId) await _removeShotReferenceTile(groupIdx, tileId);
  }
}

function _ffeAuthHeadersForUpload() {
  var authToken = '';
  try { authToken = localStorage.getItem('sw_auth_token') || ''; } catch (_) {}
  return authToken ? { 'Authorization': 'Bearer ' + authToken } : {};
}

async function _setCurrentFromEditorHistory(url) {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id || !url) return;
  if (_firstFrameEditor.generating || _firstFrameEditor.saving) return;
  try {
    await apiPost('/api/frames/set-current-from-history', {
      projectId: project.id,
      groupIdx: _firstFrameEditor.groupIdx,
      historyUrl: url,
    });
    await _reloadProjectFromServerForStoryboard(project.id);
    renderImageGrid();
    await _refreshFirstFrameEditor();
    showToast('已恢复历史首帧', 'success');
  } catch (e) {
    showToast('恢复历史首帧失败: ' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
  }
}

function _markAiSuggestionInvalid(chatIdx) {
  var msg = Number.isFinite(Number(chatIdx)) && _firstFrameEditor.chat ? _firstFrameEditor.chat[Number(chatIdx)] : null;
  if (!msg) return;
  msg.invalid = true;
  msg.applying = false;
  msg.undoable = false;
  _ffeSaveChat();
}

async function _applyDraftToEditor(nextDraft, chatIdx) {
  if (!_firstFrameEditor.payload) return false;
  if (_ffeDraftDirty()) {
    var flushed = await _ffeFlushAutoSave({ source: 'autosave-ai-apply' });
    if (!flushed || !flushed.ok) {
      showToast('当前手动编辑尚未保存，暂时无法应用 AI 建议。', 'warn');
      _ffeUpdateDirtyState();
      return false;
    }
  }
  var msg = Number.isFinite(Number(chatIdx)) && _firstFrameEditor.chat ? _firstFrameEditor.chat[Number(chatIdx)] : null;
  if (!msg || !nextDraft) return false;
  var beforeSavedDraft = _ffeCloneDraft(_firstFrameEditor.payload && _firstFrameEditor.payload.draft || {});
  var beforeSavedDraftFingerprint = _firstFrameEditor.savedDraftFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.savedDraftFingerprint) || '';
  msg.applying = true;
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
  var saveResult = await _ffeRunOneSaveCycle({
    draftOverride: nextDraft || {},
    forceSave: true,
    noRetry: true,
    source: 'ai-apply',
  });
  msg.applying = false;
  if (!saveResult || !saveResult.ok) {
    if (saveResult && saveResult.code === 'saved_draft_changed') {
      _markAiSuggestionInvalid(chatIdx);
      showToast('草稿已在其他位置更新，AI 建议已失效，请重新发送指令。', 'warn');
    } else if (saveResult && saveResult.code === 'validation_failed') {
      showToast('AI 建议没有通过草稿校验，请重新调整指令。', 'warn');
    } else {
      showToast('应用失败，草稿未保存，请重试。', 'error');
    }
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
    return false;
  }
  if (Array.isArray(_firstFrameEditor.chat)) {
    _firstFrameEditor.chat.forEach(function (item) {
      if (!item) return;
      item.undoable = false;
    });
    msg.applied = true;
    msg.undoable = true;
    msg.invalid = false;
    msg.beforeSavedDraft = beforeSavedDraft;
    msg.beforeSavedDraftFingerprint = beforeSavedDraftFingerprint;
    msg.afterSavedDraftFingerprint = saveResult.resp && saveResult.resp.savedDraftFingerprint || _firstFrameEditor.savedDraftFingerprint || '';
    msg.afterSourceHash = _ffeCurrentSourceHash();
    _ffeSaveChat();
  }
  showToast('已应用并保存', 'success');
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
  return true;
}

async function _undoAppliedDraftFromEditor(chatIdx) {
  if (!_firstFrameEditor.payload) return false;
  if (_ffeDraftDirty()) {
    var flushed = await _ffeFlushAutoSave({ source: 'autosave-ai-undo' });
    if (!flushed || !flushed.ok) {
      showToast('当前手动编辑尚未保存，暂时无法撤销 AI 建议。', 'warn');
      _ffeUpdateDirtyState();
      return false;
    }
  }
  var msg = Number.isFinite(Number(chatIdx)) && _firstFrameEditor.chat ? _firstFrameEditor.chat[Number(chatIdx)] : null;
  if (!msg || !_ffeCanUndoSavedPatch(msg)) {
    if (msg) {
      msg.undoable = false;
      _ffeSaveChat();
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
    }
    showToast('已有后续更新，无法回滚此建议。', 'warn');
    return false;
  }
  msg.undoing = true;
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
  var saveResult = await _ffeRunOneSaveCycle({
    draftOverride: msg.beforeSavedDraft || {},
    forceSave: true,
    noRetry: true,
    source: 'ai-undo',
  });
  msg.undoing = false;
  if (!saveResult || !saveResult.ok) {
    if (saveResult && saveResult.code === 'saved_draft_changed') {
      msg.undoable = false;
      _ffeSaveChat();
      showToast('已有后续更新，无法回滚此建议。', 'warn');
    } else {
      showToast('撤销失败，当前草稿未改变。', 'error');
    }
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
    return false;
  }
  msg.applied = false;
  msg.undoable = false;
  _ffeSaveChat();
  showToast('已恢复到应用前草稿', 'success');
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx, false);
  return true;
}

async function _sendFirstFrameRewriteMessage() {
  if (!_firstFrameEditor.open || _firstFrameEditor.groupIdx == null || !project || !project.id) return;
  if (_firstFrameEditor.generating || _firstFrameEditor.restoring || _firstFrameEditor.rewriting) return;
  var root = document.getElementById('firstFrameEditorRoot');
  var input = root && root.querySelector('[data-ffe-field="chatInput"]');
  var message = input ? String(input.value || '').trim() : '';
  if (!message) return;
  var dirty = _ffeDraftJson(_ffeCollectDraft()) !== (_firstFrameEditor.originalDraftJson || '{}');
  if (dirty || _firstFrameEditor.saving) {
    var saved = await _ffeFlushAutoSave({ source: 'autosave-chat' });
    if (!saved || !saved.ok) {
      var retryInput = document.getElementById('firstFrameEditorRoot') && document.getElementById('firstFrameEditorRoot').querySelector('[data-ffe-field="chatInput"]');
      if (retryInput) retryInput.value = message;
      _ffeUpdateDirtyState();
      return;
    }
    root = document.getElementById('firstFrameEditorRoot');
    input = root && root.querySelector('[data-ffe-field="chatInput"]');
  }
  var history = _ffeConversationHistoryForApi();
  var baselineDraft = _firstFrameEditor.payload && _firstFrameEditor.payload.draft || {};
  var beforeDraft = JSON.parse(_ffeDraftJson(baselineDraft));
  var didAutoSaveBeforeRewrite = dirty;
  _ffeAppendChat({ role: 'user', content: message });
  _ffeAppendChat({ role: 'assistant', content: '正在理解你的指令并生成草稿修改建议。', pending: true });
  if (input) input.value = '';
  _firstFrameEditor.rewriting = true;
  _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
  try {
    var resp = await apiPost('/api/frames/rewrite-draft', {
      projectId: project.id,
      groupIdx: _firstFrameEditor.groupIdx,
      conversationHistory: history,
      userMessage: message,
      sourceHash: _firstFrameEditor.payload && _firstFrameEditor.payload.sourceHash || '',
      baselineDraft: baselineDraft,
      baselineFingerprint: _firstFrameEditor.baselineFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.baselineFingerprint) || '',
      expectedSavedDraftFingerprint: _firstFrameEditor.savedDraftFingerprint || (_firstFrameEditor.payload && _firstFrameEditor.payload.savedDraftFingerprint) || '',
    });
    if (resp.sourceHash && _firstFrameEditor.payload) {
      _firstFrameEditor.payload.sourceHash = resp.sourceHash;
    }
    if (resp.savedDraftFingerprint) {
      _firstFrameEditor.savedDraftFingerprint = resp.savedDraftFingerprint;
      if (_firstFrameEditor.payload) _firstFrameEditor.payload.savedDraftFingerprint = resp.savedDraftFingerprint;
    }
    var responsePatch = resp.patch || null;
    if (responsePatch) responsePatch.beforeDraft = beforeDraft;
    var responseWarnings = Array.isArray(resp.warnings) ? resp.warnings : [];
    var responseChangedFields = responsePatch && Array.isArray(responsePatch.changedFields) ? responsePatch.changedFields : [];
    var forbiddenOnly = !responseChangedFields.length && responseWarnings.some(function (item) {
      return item && (item.code === 'forbidden_field_ignored' || item.code === 'style_rules_ignored');
    });
    _ffeReplacePendingAssistant({
      role: 'assistant',
      content: responseChangedFields.length
        ? '已生成修改建议，确认后会应用并保存到当前首帧草稿。'
        : (forbiddenOnly
          ? '这类生成参数不能通过首帧对话修改。我可以帮你调整提示词、负向词或参考图选择。'
          : '这条指令没有产生可应用的草稿修改。'),
      patch: responsePatch,
      warnings: responseWarnings,
      intentSummary: resp.intentSummary || '',
      baselineFingerprint: resp.baselineFingerprint || '',
    });
    _firstFrameEditor.rewriting = false;
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    _ffeSetFieldWarnings(resp.warnings || []);
  } catch (e) {
    var failedInput = document.getElementById('firstFrameEditorRoot') && document.getElementById('firstFrameEditorRoot').querySelector('[data-ffe-field="chatInput"]');
    if (failedInput) failedInput.value = message;
    var errorPayload = e && e.payload || {};
    if (errorPayload.code === 'validation_failed' && Array.isArray(errorPayload.errors)) {
      showToast('AI 改写结果校验失败，请检查标红字段', 'warn');
    } else if (errorPayload.code === 'first_frame_rewrite_interval_limited' || errorPayload.code === 'first_frame_rewrite_daily_limited' || errorPayload.code === 'rewrite_rate_limited') {
      showToast(didAutoSaveBeforeRewrite ? '草稿已保存，但 AI 请求被限流，请稍后重试。' : (errorPayload.error || '发送太频繁，请稍后再试'), 'warn');
    } else if (errorPayload.code === 'saved_draft_changed' || errorPayload.code === 'source_changed' || errorPayload.code === 'baseline_fingerprint_mismatch') {
      showToast(errorPayload.error || '首帧草稿状态已变化，请刷新后重试。', 'warn');
    } else {
      showToast('AI 改写失败: ' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
    }
    _ffeReplacePendingAssistant({
      role: 'assistant',
      content: errorPayload.code === 'validation_failed'
        ? '改写结果没有通过草稿校验，请按标红字段调整后再试。'
        : (errorPayload.error || errorPayload.detail || '改写失败，请稍后重试。'),
    });
    _firstFrameEditor.rewriting = false;
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    var restoredInput = document.getElementById('firstFrameEditorRoot') && document.getElementById('firstFrameEditorRoot').querySelector('[data-ffe-field="chatInput"]');
    if (restoredInput) restoredInput.value = message;
    if (errorPayload.code === 'validation_failed' && Array.isArray(errorPayload.errors)) {
      _ffeSetFieldErrors(errorPayload.errors);
    }
  } finally {
    _ffeUpdateDirtyState();
  }
}

async function _closeFirstFrameEditor(options) {
  options = options || {};
  if (_firstFrameEditor.open && !_firstFrameEditor.generating && options.forceDiscard !== true) {
    _ffeRefreshPendingDraftJson();
    if (_ffeHasAutoSaveChanges() || _firstFrameEditor.saving) {
      var saved = await _ffeFlushAutoSave({ source: 'autosave-close' });
      if (!saved || !saved.ok) {
        var retry = window.confirm('保存失败。点击“确定”重试保存，点击“取消”选择是否放弃未保存内容并关闭。');
        if (retry) {
          saved = await _ffeFlushAutoSave({ source: 'autosave-close-retry', noRetry: true });
          if (!saved || !saved.ok) return;
        } else {
          var discard = window.confirm('您还有未保存的修改，关闭后将丢失。确认关闭？');
          if (!discard) return;
        }
      }
    }
  }
  _ffeCancelAutoSaveTimers();
  _firstFrameEditor = _ffeInitialEditorState();
  var root = document.getElementById('firstFrameEditorRoot');
  if (root) root.innerHTML = '';
  _setFirstFrameEditorLock(false);
}

function _renderFirstFrameEditor(payload, gIdx, preserveLocalDraft) {
  var root = _ensureFirstFrameEditorRoot();
  if (preserveLocalDraft !== false && _firstFrameEditor.open && payload && root.querySelector('.ffe-modal')) {
    var localDraft = _ffeCollectDraft();
    payload.draft = _ffeDraftJson(localDraft) === '{}' ? null : localDraft;
    if (_firstFrameEditor.payload) _firstFrameEditor.payload.draft = payload.draft;
  }
  root.innerHTML = _ffeModalHtml(payload, gIdx);
  _setFirstFrameEditorLock(true);
  _ffeUpdateDirtyState();
  hydrateProtectedImageElements(root);
}

async function _openFirstFrameEditor(gIdx) {
  if (!project || !project.id) return;
  _firstFrameEditor = _ffeInitialEditorState({ open: true, groupIdx: gIdx, loading: true, originalDraftJson: "{}", baselineDraftJson: "{}" });
  var root = _ensureFirstFrameEditorRoot();
  root.innerHTML = '<div class="ffe-modal"><button type="button" class="ffe-close" data-ffe-action="close"><span class="material-symbols-outlined">close</span></button><div class="ffe-shell ffe-shell-loading"><div class="ffe-loading">正在读取首帧生成计划…</div></div></div>';
  _setFirstFrameEditorLock(true);
  try {
    var payload = await apiGet('/api/frames/plan?projectId=' + encodeURIComponent(project.id) + '&groupIdx=' + encodeURIComponent(gIdx) + '&frameType=first_frame');
    _firstFrameEditor = _ffeInitialEditorState({ open: true, groupIdx: gIdx, loading: false, payload: payload, chat: _ffeLoadChat(payload, gIdx) });
    _ffeResetSavedBaseline(payload);
    _ffeApplyPlanAutoSaveFlags(payload);
    _renderFirstFrameEditor(payload, gIdx, false);
    _ffeMaybeStartForcedLegacySave();
  } catch (e) {
    _closeFirstFrameEditor();
    showToast('打开首帧编辑失败: ' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
  }
}

function _handleFirstFrameEditorClick(ev) {
  var btn = ev.target && ev.target.closest ? ev.target.closest('[data-ffe-action]') : null;
  if (!btn) {
    if (_firstFrameEditor.referenceMaterialPicker && _firstFrameEditor.referenceMaterialPicker.open && ev.target && ev.target.classList && ev.target.classList.contains('ffe-material-picker-backdrop')) {
      _ffeCloseReferenceMaterialPicker();
      return;
    }
    if (_firstFrameEditor.referenceRolePickerOpen && !(ev.target && ev.target.closest && ev.target.closest('.ffe-material-add-wrap'))) {
      _firstFrameEditor.referenceRolePickerOpen = false;
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    }
    return;
  }
  var action = btn.dataset.ffeAction || '';
  if ((_firstFrameEditor.generating || _firstFrameEditor.restoring || _firstFrameEditor.rewriting) && [
    'restore-initial',
    'send-ai-message',
    'apply-ai-draft',
    'undo-ai-draft',
    'set-current-history',
    'toggle-reference-role-picker',
    'choose-reference-upload-role',
    'select-reference-material',
    'upload-reference-material',
    'confirm-reference-material',
    'remove-reference-tile',
  ].includes(action)) {
    return;
  }
  if (action === 'close') {
    _closeFirstFrameEditor();
    return;
  }
  if (action === 'dismiss-image-alert') {
    var alertKey = btn.dataset.alertKey || '';
    if (!alertKey) return;
    if (!_firstFrameEditor.dismissedAlerts) _firstFrameEditor.dismissedAlerts = {};
    _firstFrameEditor.dismissedAlerts[alertKey] = true;
    if (alertKey === 'generateBlock') _ffeClearGenerateBlock();
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    return;
  }
  if (action === 'retry-autosave') {
    _ffeRetryAutoSaveWithConflictPrompt();
    return;
  }
  if (action === 'restore-initial') {
    _restoreFirstFrameInitial();
    return;
  }
  if (action === 'generate-draft') {
    _generateFirstFrameFromEditor();
    return;
  }
  if (action === 'download-current') {
    var downloadUrl = btn.dataset.url || (_firstFrameEditor.payload && _firstFrameEditor.payload.currentFrame && _firstFrameEditor.payload.currentFrame.url) || '';
    if (!downloadUrl) return;
    var a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'first_frame_' + (Number(_firstFrameEditor.groupIdx || 0) + 1) + '.png';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (action === 'download-all-material') {
    _downloadAllPanelMaterials(
      _ffeMaterialPanelData(_firstFrameEditor.payload),
      _firstFrameEditor.groupIdx
    );
    return;
  }
  if (action === 'send-ai-message') {
    _sendFirstFrameRewriteMessage();
    return;
  }
  if (action === 'apply-ai-draft') {
    var chatIdx = parseInt(btn.dataset.chatIdx, 10);
    var msg = !isNaN(chatIdx) && _firstFrameEditor.chat ? _firstFrameEditor.chat[chatIdx] : null;
    if (msg && msg.patch && msg.patch.nextDraft) {
      _applyDraftToEditor(msg.patch.nextDraft, chatIdx);
    }
    return;
  }
  if (action === 'undo-ai-draft') {
    var undoIdx = parseInt(btn.dataset.chatIdx, 10);
    _undoAppliedDraftFromEditor(undoIdx);
    return;
  }
  if (action === 'toggle-ai-diff') {
    var diffIdx = parseInt(btn.dataset.chatIdx, 10);
    var diffMsg = !isNaN(diffIdx) && _firstFrameEditor.chat ? _firstFrameEditor.chat[diffIdx] : null;
    if (diffMsg) {
      diffMsg.diffOpen = !diffMsg.diffOpen;
      _ffeSaveChat();
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    }
    return;
  }
  if (action === 'toggle-reference-role-picker') {
    var panel = _ffeMaterialPanelData(_firstFrameEditor.payload) || {};
    if (_ffeReferenceAddDisabled(panel)) {
      showToast(_ffeReferenceCapMessage(panel), 'warn');
      return;
    }
    _firstFrameEditor.referenceRolePickerOpen = !_firstFrameEditor.referenceRolePickerOpen;
    _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
    return;
  }
  if (action === 'choose-reference-upload-role') {
    var selectedRole = btn.dataset.role || 'scene';
    _ffeOpenReferenceMaterialPicker(selectedRole);
    return;
  }
  if (action === 'close-reference-material-picker') {
    _ffeCloseReferenceMaterialPicker();
    return;
  }
  if (action === 'select-reference-material') {
    if (btn.closest('.is-image-missing') || btn.closest('[data-image-missing="true"]') || btn.querySelector('.is-image-missing, [data-image-missing="true"]')) {
      showToast('图片暂不可用，不能作为参考图', 'warn');
      return;
    }
    _ffeSelectReferenceMaterial(btn.dataset.tileId || '');
    return;
  }
  if (action === 'upload-reference-material') {
    _ffePickAndUploadReferenceMaterial();
    return;
  }
  if (action === 'confirm-reference-material') {
    _ffeConfirmReferenceMaterial();
    return;
  }
  if (action === 'remove-reference-tile') {
    var tileId = btn.dataset.tileId || '';
    if (tileId) _ffeRemoveReferenceTile(tileId);
    return;
  }
  if (action === 'view-current' || action === 'view-history' || action === 'view-ref') {
    var url = btn.dataset.url || (btn.tagName === 'IMG' ? btn.getAttribute('src') : '');
    if (url) _openLightbox(url);
  }
  if (action === 'set-current-history') {
    var historyUrl = btn.dataset.url || '';
    if (historyUrl) _setCurrentFromEditorHistory(historyUrl);
    return;
  }
}

document.addEventListener('click', _handleMaterialPanelAction);
document.addEventListener('click', _handleFirstFrameEditorClick);
document.addEventListener('focusin', function (ev) {
  var target = ev.target;
  if (target && target.matches && target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var gIdx = parseInt(target.dataset.gidx, 10);
    if (!isNaN(gIdx)) _sbHydrateFirstFramePromptEditor(gIdx, target);
    return;
  }
  if (target && target.matches && target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    var tailGIdx = parseInt(target.dataset.gidx, 10);
    if (!isNaN(tailGIdx)) _sbHydrateTailFramePromptEditor(tailGIdx, target);
  }
});
document.addEventListener('input', function (ev) {
  var target = ev.target;
  if (target && target.matches && target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var gIdx = parseInt(target.dataset.gidx, 10);
    if (isNaN(gIdx)) return;
    _sbSyncFramePromptSafetyHighlight(target);
    _sbRefreshFirstFrameCardPendingDraft(gIdx);
    _sbScheduleFirstFrameCardPromptSave(gIdx, { source: 'card-autosave-input' });
    return;
  }
  if (target && target.matches && target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    if (target.readOnly) return;
    var tailGIdx = parseInt(target.dataset.gidx, 10);
    if (isNaN(tailGIdx)) return;
    _sbSyncFramePromptSafetyHighlight(target);
    _sbRefreshTailFrameCardPendingDraft(tailGIdx);
    _sbScheduleTailFrameCardPromptSave(tailGIdx, { source: 'tail-card-autosave-input' });
  }
});
document.addEventListener('change', function (ev) {
  var target = ev.target;
  if (target && target.matches && target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var gIdx = parseInt(target.dataset.gidx, 10);
    if (!isNaN(gIdx)) _sbScheduleFirstFrameCardPromptSave(gIdx, { source: 'card-autosave-change', immediate: true });
    return;
  }
  if (target && target.matches && target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    if (target.readOnly) return;
    var tailGIdx = parseInt(target.dataset.gidx, 10);
    if (!isNaN(tailGIdx)) _sbScheduleTailFrameCardPromptSave(tailGIdx, { source: 'tail-card-autosave-change', immediate: true });
  }
});
document.addEventListener('input', function (ev) {
  if (ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot')) {
    var field = ev.target.dataset && ev.target.dataset.ffeField || '';
    _ffeMarkDraftFieldTouched(field);
    if (field === 'content' || field === 'negativePromptOverride') {
      _ffeScheduleAutoSave({ source: 'autosave-input' });
    }
    _ffeUpdateDirtyState();
  }
});
document.addEventListener('change', function (ev) {
  if (ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot')) {
    var field = ev.target.dataset && ev.target.dataset.ffeField || '';
    _ffeMarkDraftFieldTouched(field);
    if (field === 'content' || field === 'negativePromptOverride') {
      _ffeScheduleAutoSave({ source: 'autosave-change' });
    }
    _ffeUpdateDirtyState();
  }
});
document.addEventListener('compositionstart', function (ev) {
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var cardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(cardGIdx)) {
      var cardAuto = _sbFirstFrameCardPromptState(cardGIdx);
      cardAuto.composing = true;
      cardAuto.dirtyAt = null;
      _sbClearFirstFrameCardPromptTimers(cardGIdx);
    }
    return;
  }
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    if (ev.target.readOnly) return;
    var tailCardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(tailCardGIdx)) {
      var tailCardAuto = _sbTailFrameCardPromptState(tailCardGIdx);
      tailCardAuto.composing = true;
      tailCardAuto.dirtyAt = null;
      _sbClearTailFrameCardPromptTimers(tailCardGIdx);
    }
    return;
  }
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'content' && field !== 'negativePromptOverride') return;
  var auto = _ffeAutoSaveState();
  auto.composing = true;
  auto.dirtyAt = null;
  _ffeCancelAutoSaveTimers();
});
document.addEventListener('compositionend', function (ev) {
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var cardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(cardGIdx)) {
      var cardAuto = _sbFirstFrameCardPromptState(cardGIdx);
      cardAuto.composing = false;
      cardAuto.dirtyAt = null;
      _sbSyncFramePromptSafetyHighlight(ev.target);
      _sbScheduleFirstFrameCardPromptSave(cardGIdx, { source: 'card-autosave-compositionend' });
    }
    return;
  }
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    if (ev.target.readOnly) return;
    var tailCardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(tailCardGIdx)) {
      var tailCardAuto = _sbTailFrameCardPromptState(tailCardGIdx);
      tailCardAuto.composing = false;
      tailCardAuto.dirtyAt = null;
      _sbSyncFramePromptSafetyHighlight(ev.target);
      _sbScheduleTailFrameCardPromptSave(tailCardGIdx, { source: 'tail-card-autosave-compositionend' });
    }
    return;
  }
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'content' && field !== 'negativePromptOverride') return;
  var auto = _ffeAutoSaveState();
  auto.composing = false;
  auto.dirtyAt = null;
  _ffeMarkDraftFieldTouched(field);
  _ffeScheduleAutoSave({ source: 'autosave-compositionend' });
  _ffeUpdateDirtyState();
});
document.addEventListener('blur', function (ev) {
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-first-prompt-field="content"]')) {
    var cardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(cardGIdx) && !_sbFirstFrameCardPromptState(cardGIdx).composing) {
      _sbScheduleFirstFrameCardPromptSave(cardGIdx, { source: 'card-autosave-blur', immediate: true });
    }
    return;
  }
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-tail-prompt-field="content"]')) {
    if (ev.target.readOnly) return;
    var tailCardGIdx = parseInt(ev.target.dataset.gidx, 10);
    if (!isNaN(tailCardGIdx) && !_sbTailFrameCardPromptState(tailCardGIdx).composing) {
      _sbScheduleTailFrameCardPromptSave(tailCardGIdx, { source: 'tail-card-autosave-blur', immediate: true });
    }
    return;
  }
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'content' && field !== 'negativePromptOverride') return;
  if (_ffeAutoSaveState().composing) return;
  _ffeScheduleAutoSave({ source: 'autosave-blur', immediate: true });
}, true);
document.addEventListener('scroll', function (ev) {
  if (ev.target && ev.target.matches && ev.target.matches('textarea[data-sb-first-prompt-field="content"], textarea[data-sb-tail-prompt-field="content"]')) {
    _sbSyncFramePromptSafetyHighlight(ev.target);
  }
}, true);
window.addEventListener('pagehide', function () {
  _ffeFlushAutoSaveOnPageHide();
  _sbFlushFirstFrameCardPromptsOnPageHide();
  _sbFlushTailFrameCardPromptsOnPageHide();
});
window.addEventListener('beforeunload', function (ev) {
  if (!_ffeBeforeUnloadHasUnsavedChanges() && !_sbAnyFirstFrameCardPromptUnsaved() && !_sbAnyTailFrameCardPromptUnsaved()) return;
  ev.preventDefault();
  ev.returnValue = '';
});
function _ffeCanScrollEditorText(target) {
  return !!(target && target.closest && target.closest('.ffe-chat-panel .ffe-panel-body, .ffe-material-picker-body, .ffe-ref-picker-menu, [data-ffe-field="content"], [data-ffe-field="negativePromptOverride"], [data-ffe-field="chatInput"]'));
}
document.addEventListener('wheel', function (ev) {
  if (_firstFrameEditor.open && ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot') && !_ffeCanScrollEditorText(ev.target)) ev.preventDefault();
}, { passive: false, capture: true });
document.addEventListener('touchmove', function (ev) {
  if (_firstFrameEditor.open && ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot') && !_ffeCanScrollEditorText(ev.target)) ev.preventDefault();
}, { passive: false, capture: true });
document.addEventListener('keydown', function (ev) {
  if (_firstFrameEditor.open && ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot [data-ffe-field="chatInput"]')) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      _sendFirstFrameRewriteMessage();
      return;
    }
  }
  if (ev.key === 'Escape') {
    if (_firstFrameEditor.referenceMaterialPicker && _firstFrameEditor.referenceMaterialPicker.open) {
      ev.preventDefault();
      _ffeCloseReferenceMaterialPicker();
      return;
    }
    if (_firstFrameEditor.referenceRolePickerOpen) {
      ev.preventDefault();
      _firstFrameEditor.referenceRolePickerOpen = false;
      _renderFirstFrameEditor(_firstFrameEditor.payload, _firstFrameEditor.groupIdx);
      return;
    }
    var lightbox = document.getElementById('assetLightbox');
    if (lightbox) {
      ev.preventDefault();
      lightbox.remove();
      return;
    }
    if (_firstFrameEditor.open) _closeFirstFrameEditor();
  }
});

/* ================================================================
   Storyboard groups
   ================================================================ */
export function getStoryboardGroups() {
  if (!project || !project.shots) return [];
  var shots = project.shots;
  var sbs = Array.isArray(project.storyboards) ? project.storyboards : [];
  // 合并模式：服务端已按"段"建好 storyboards（某段 shotIndices 含多个镜头）时，按段分组；
  // 否则（1:1 / flag OFF）回落原先的一镜一组，行为完全不变。
  var hasMerged = sbs.length && sbs.some(function (sb) {
    return sb && Array.isArray(sb.shotIndices) && sb.shotIndices.length > 1;
  });
  if (hasMerged) {
    return sbs.map(function (sb, g) {
      var idxs = (Array.isArray(sb.shotIndices) && sb.shotIndices.length ? sb.shotIndices : [g])
        .filter(function (i) { return Number.isInteger(i) && i >= 0 && i < shots.length; });
      var groupShots = idxs.map(function (i) { return shots[i]; });
      return {
        groupIdx: g,
        shotIndices: idxs,
        shots: groupShots,
        emotion: (groupShots[0] && groupShots[0].emotion) || 'general',
      };
    });
  }
  return project.shots.map(function (shot, idx) {
    return {
      groupIdx: idx,
      shotIndices: [idx],
      shots: [shot],
      emotion: shot.emotion || 'general',
    };
  });
}

function _getShotGroupIndices() {
  var map = {};
  if (!project || !project.shots) return map;
  var groups = getStoryboardGroups();
  groups.forEach(function (g) {
    g.shotIndices.forEach(function (si) { map[si] = g.groupIdx; });
  });
  return map;
}

function _firstFramePreflightTargets(groups) {
  return (groups || []).map(function (g, idx) {
    return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [] };
  });
}

function _firstFramePreflightKey(groups) {
  if (!project || !project.id || !project.shots || !project.shots.length) return "";
  var staleFlags = project._staleFlags && typeof project._staleFlags === "object"
    ? Object.keys(project._staleFlags).filter(function (key) { return !!project._staleFlags[key]; }).sort()
    : [];
  // 注：此前 key 里包含 project.updatedAt——任何 saveProject 都会让 updatedAt 变，
  // 进而让 preflight 缓存失效、被迫重跑。但 preflight 的判定逻辑只依赖下面
  // shotPlan* 字段、staleFlags 以及 targets，updatedAt 没有语义贡献。
  // 这里移除 updatedAt，使保存项目不再无意义地让缓存失效。
  return JSON.stringify({
    projectId: project.id,
    shotPlanStatus: project.shotPlanStatus || "",
    shotPlanSourceHash: project.shotPlanSourceHash || "",
    shotPlanGeneratedAt: project.shotPlanGeneratedAt || "",
    shotPlanStaleAt: project.shotPlanStaleAt || "",
    shotPlanFailedAt: project.shotPlanFailedAt || "",
    staleFlags: staleFlags,
    targets: _firstFramePreflightTargets(groups).map(function (t) { return t.shotIndices; }),
  });
}

function _firstFramePreflightMessage(payload, fallback) {
  var blocked = payload && payload.preflight && Array.isArray(payload.preflight.blocked)
    ? payload.preflight.blocked
    : [];
  var first = blocked[0] || null;
  var blocker = first && Array.isArray(first.blockers) ? first.blockers[0] : null;
  return (blocker && blocker.message) || (first && first.reason) || fallback || "镜头计划暂不可用于首帧生成。";
}

function _resetFirstFramePreflightState(key, status, message) {
  _firstFramePreflightState = {
    key: key || "",
    status: status || "idle",
    payload: null,
    message: message || "",
    promise: null,
  };
}

function _requestFirstFramePreflight(groups, key, force) {
  if (!project || !project.id || !key) return;
  if (!force && _firstFramePreflightState.key === key && _firstFramePreflightState.promise) {
    return _firstFramePreflightState.promise;
  }
  var targets = _firstFramePreflightTargets(groups);
  var promise = apiPost("/api/batch/preflight", {
    batchType: "storyboard_images",
    projectId: project.id,
    targets: targets,
  }).then(function (payload) {
    if (_firstFramePreflightState.key !== key) return;
    _firstFramePreflightState = {
      key: key,
      status: payload && payload.allowed ? "allowed" : "blocked",
      payload: payload || null,
      message: payload && payload.allowed ? "" : _firstFramePreflightMessage(payload),
      promise: null,
    };
    var nextGroups = getStoryboardGroups();
    _updateImagesActionButton(nextGroups);
    _syncFirstFramePrimaryButtons(nextGroups);
    return _firstFramePreflightState;
  }).catch(function (e) {
    if (_firstFramePreflightState.key !== key) return;
    console.warn("[FirstFramePreflight] check failed:", e);
    _firstFramePreflightState = {
      key: key,
      status: "error",
      payload: null,
      message: "镜头计划检查失败，请稍后重试。",
      promise: null,
    };
    var nextGroups = getStoryboardGroups();
    _updateImagesActionButton(nextGroups);
    _syncFirstFramePrimaryButtons(nextGroups);
    return _firstFramePreflightState;
  });
  _firstFramePreflightState.promise = promise;
  return promise;
}

function _getFirstFramePreflightState(groups) {
  if (!project || !project.shots || !project.shots.length) {
    _resetFirstFramePreflightState("", "blocked", "请先生成镜头计划。");
    return _firstFramePreflightState;
  }
  var key = _firstFramePreflightKey(groups);
  if (!key) {
    _resetFirstFramePreflightState("", "blocked", "请先生成镜头计划。");
    return _firstFramePreflightState;
  }
  if (_firstFramePreflightState.key !== key) {
    _firstFramePreflightState = {
      key: key,
      status: "checking",
      payload: null,
      message: "正在检查镜头计划…",
      promise: null,
    };
    _requestFirstFramePreflight(groups, key);
  }
  return _firstFramePreflightState;
}

async function _ensureFirstFramePreflightAllowed(groups, hint) {
  groups = groups || getStoryboardGroups();
  if (!project || !project.shots || !project.shots.length) {
    showToast("请先生成镜头计划", "warn");
    return false;
  }
  var key = _firstFramePreflightKey(groups);
  if (!key) {
    showToast("请先生成镜头计划", "warn");
    return false;
  }
  if (_firstFramePreflightState.key === key && _firstFramePreflightState.status === "allowed") {
    return true;
  }
  if (hint) hint.textContent = "正在检查镜头计划…";
  if (_firstFramePreflightState.key !== key || !_firstFramePreflightState.promise) {
    _firstFramePreflightState = {
      key: key,
      status: "checking",
      payload: null,
      message: "正在检查镜头计划…",
      promise: null,
    };
    _requestFirstFramePreflight(groups, key);
  }
  await _firstFramePreflightState.promise;
  var state = _firstFramePreflightState.key === key
    ? _firstFramePreflightState
    : _getFirstFramePreflightState(groups);
  if (state.status !== "allowed") {
    var message = state.message || "镜头计划暂不可用于首帧生成。";
    if (hint) hint.textContent = message;
    showToast(message, "warn");
    _updateImagesActionButton(groups);
    return false;
  }
  if (hint && !_imagesGenerating) hint.textContent = FIRST_FRAME_DEFAULT_HINT;
  return true;
}

async function _fetchSingleFirstFramePreflightPayload(gIdx, group) {
  if (!project || !project.id || !group) {
    return { allowed: false, preflight: { blocked: [{ blockers: [{ message: "请先生成镜头计划" }] }] } };
  }
  return await apiPost("/api/batch/preflight", {
    batchType: "storyboard_images",
    projectId: project.id,
    targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
  });
}

async function _ensureSingleFirstFramePreflightAllowed(gIdx, group) {
  try {
    var payload = await _fetchSingleFirstFramePreflightPayload(gIdx, group);
    if (payload && payload.allowed) return true;
    showToast(_firstFramePreflightMessage(payload), "warn");
    return false;
  } catch (e) {
    console.warn("[FirstFramePreflight] single check failed:", e);
    showToast("镜头计划检查失败，请稍后重试。", "warn");
    return false;
  }
}

async function _ffeEnsureFirstFramePreflightAllowed(gIdx) {
  var group = (project && project.storyboards && project.storyboards[gIdx]) || {};
  try {
    var payload = await _fetchSingleFirstFramePreflightPayload(gIdx, group);
    if (payload && payload.allowed) {
      _ffeClearGenerateBlock();
      return true;
    }
    var blocked = payload && payload.preflight && Array.isArray(payload.preflight.blocked)
      ? payload.preflight.blocked
      : [];
    var first = blocked[0] || {};
    _ffeSetGenerateBlock(_firstFramePreflightMessage(payload), {
      code: 'preflight_blocked',
      reason: first.reason || ''
    });
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
    return false;
  } catch (e) {
    console.warn("[FirstFramePreflight] editor check failed:", e);
    _ffeSetGenerateBlock("镜头计划检查失败，请稍后重试。", { code: 'preflight_blocked', reason: 'request_failed' });
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
    return false;
  }
}

function _isFirstFramePreflightAllowedNow(groups) {
  return _getFirstFramePreflightState(groups).status === "allowed";
}

function _firstFramePreflightTitleNow(groups) {
  var preflight = _getFirstFramePreflightState(groups);
  return preflight.status === "allowed" ? "" : (preflight.message || "正在检查镜头计划…");
}

function _firstFramePrimaryButtonState(gIdx, sb, groups, preflight) {
  groups = groups || getStoryboardGroups();
  preflight = preflight || _getFirstFramePreflightState(groups);
  var materialBlockMessage = _materialLimitBlockMessage(groups, [gIdx]);
  var preflightAllowed = preflight && preflight.status === "allowed";
  var hasImg = !!_firstFrameImageUrl(sb);
  var disabled = !!materialBlockMessage || !preflightAllowed;
  return {
    action: disabled ? "" : "regen-sb",
    disabled: disabled,
    icon: "auto_awesome",
    text: hasImg ? "重新生成" : "生成首帧",
    title: materialBlockMessage || (preflightAllowed ? "" : ((preflight && preflight.message) || "正在检查镜头计划…")),
  };
}

function _syncFirstFramePrimaryButtons(groups) {
  if (!project || typeof document === "undefined") return;
  groups = groups || getStoryboardGroups();
  var expectedKey = _firstFramePreflightKey(groups);
  var preflight = _firstFramePreflightState.key === expectedKey
    ? _firstFramePreflightState
    : _getFirstFramePreflightState(groups);
  groups.forEach(function (_group, gIdx) {
    var buttons = document.querySelectorAll('.sb-sheet[data-group-idx="' + gIdx + '"] .sb-frame-panel[data-frame="first"] [data-frame-primary="first"]');
    if (!buttons.length) return;
    var sb = (project.storyboards && project.storyboards[gIdx]) || {};
    var state = _firstFramePrimaryButtonState(gIdx, sb, groups, preflight);
    buttons.forEach(function (btn) {
      btn.disabled = !!state.disabled;
      btn.dataset.gidx = String(gIdx);
      if (state.action) btn.dataset.action = state.action;
      else btn.removeAttribute("data-action");
      if (state.title) btn.setAttribute("title", state.title);
      else btn.removeAttribute("title");
      var iconEl = btn.querySelector(".material-symbols-outlined");
      if (iconEl) iconEl.textContent = state.icon;
      var labelEl = btn.querySelector("span:not(.material-symbols-outlined)");
      if (labelEl) labelEl.textContent = state.text;
    });
  });
}

/* ================================================================
   Images page
   ================================================================ */
export function refreshImagesPage() {
  _syncRefs();
  var needShots = $("imagesNeedShots");
  var ready = $("imagesReady");
  var actionBar = $("imagesActionBar");
  if (!project || !project.shots || !project.shots.length) {
    if (needShots) needShots.hidden = false;
    if (ready) ready.hidden = true;
    if (actionBar) actionBar.hidden = true;
    var ig = $("imageGrid"); if (ig) ig.innerHTML = "";
    return;
  }
  _setTopFirstFrameActionLocked(false);
  if (needShots) needShots.hidden = true;
  if (ready) ready.hidden = false;
  renderImageGrid();
  checkImagesConfirm();
}

/* ── Step A: AI prompt generation ── */
// Legacy prompt-preview hooks stay as compatibility no-ops when the merged shot page
// does not mount #promptPreviewList; visible feedback now lives on storyboard cards.

export function renderPromptPreviewList() {
  _syncRefs();
  var list = $("promptPreviewList");
  if (!list || !project || !project.shots) return;
  list.innerHTML = "";
  project.shots.forEach(function (shot, idx) {
    var card = document.createElement("div");
    card.className = "prompt-preview-card" + (shot.imagePromptGenerated ? " is-done" : "");
    card.dataset.shotIdx = idx;
    // 此前 stale 状态显示 "⚠ 需更新"（红色警告字 .stale-warn）；用户反馈装饰性"需更新"提示
    // 一概去掉，stale 状态由"生成全部关键帧"按钮文案集中体现。stale 时仍归为"已生成"。
    var statusHtml = '';
    if (shot.imagePromptGenerated) statusHtml = '<span class="prompt-preview-status ok">&#10003; 已生成</span>';
    else statusHtml = '<span class="prompt-preview-status wait">待生成</span>';

    card.innerHTML =
      '<div class="prompt-preview-head">' +
        '<div class="prompt-preview-num">' + (idx + 1) + '</div>' +
        '<span class="prompt-preview-scene">镜头 ' + (idx + 1) + ' · ' + escapeHtml(shot.shotType || "") + '</span>' +
        statusHtml +
      '</div>' +
      '<div class="prompt-preview-desc">' + escapeHtml((shot.visual || "").slice(0, 80) || "无描述") + '</div>' +
      '<div class="prompt-preview-prompt">' + (shot.imagePrompt ? '画面指令已准备' : '') + '</div>' +
      '<div class="prompt-preview-actions">' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="regen-convert">重新生成</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="edit-convert">手动编辑</button>' +
      '</div>';
    list.appendChild(card);
  });
}

export function updatePromptCard(idx, status, promptText, errMsg) {
  var list = $("promptPreviewList");
  if (!list) return;
  var card = list.querySelector('[data-shot-idx="' + idx + '"]');
  if (!card) return;
  var statusEl = card.querySelector(".prompt-preview-status");
  var promptEl = card.querySelector(".prompt-preview-prompt");

  if (status === "loading") {
    card.classList.remove("is-done", "is-err");
    if (statusEl) { statusEl.className = "prompt-preview-status wait"; statusEl.innerHTML = "生成中…"; }
    if (promptEl) promptEl.textContent = "";
  } else if (status === "done") {
    card.classList.add("is-done");
    card.classList.remove("is-err");
    if (statusEl) { statusEl.className = "prompt-preview-status ok"; statusEl.innerHTML = "&#10003; 已生成"; }
    if (promptEl) promptEl.textContent = promptText ? "画面指令已准备" : "";
  } else if (status === "error") {
    card.classList.add("is-err");
    card.classList.remove("is-done");
    if (statusEl) { statusEl.className = "prompt-preview-status err"; statusEl.textContent = "失败"; }
    if (promptEl) promptEl.textContent = errMsg || "生成失败";
  }
}

export function checkConvertConfirm() {
  var area = $("convertConfirmArea");
  if (!area || !project || !project.shots) return;
  var allDone = project.shots.length > 0 && project.shots.every(function (s) { return s.imagePromptGenerated && s.imagePrompt; });
  area.hidden = !allDone;
}

export async function convertSinglePrompt(idx) {
  if (!project) return;
  var shot = project.shots[idx];
  if (!shot) return;
  var originId = project.id;
  updatePromptCard(idx, "loading");

  var assetRefs = [];
  try {
    var refResp = await apiPost('/api/assets/match-references', {
      project: { assets: project.assets },
      shot: shot,
    });
    assetRefs = refResp.refs || [];
  } catch (e) {
    console.warn('[ImagePrompt] match-references failed, continuing without refs:', e);
  }
  var imageUrls = [];
  assetRefs.forEach(function (r) {
    var imgUrl = r.pencilUrl || r.url;
    if (imgUrl) imageUrls.push(imgUrl);
  });

  try {
    var _sbDiagBox = (window.__qdIsAdmin === true)
      ? ($("sbDiagnostic_" + idx) || $("sbDiagnostic"))
      : null;
    if (_sbDiagBox) _sbDiagBox.hidden = false;
    var _sbDiagCaptor = _sbDiagBox ? attachDiagnostic(_sbDiagBox) : null;
    var resp = await apiPostStream("/api/storyboard/convert-prompt", {
      shot: shot,
      styleBible: project.styleBible,
      assets: project.assets,
      assetRefs: assetRefs,
      idx: idx,
      imageUrls: imageUrls,
      creatorProfile: formatCreatorProfileForApi(),
    }, function () {}, _sbDiagCaptor ? _sbDiagCaptor.onEvent : null);

    var cleaned = (resp.imagePrompt || "").trim().replace(/^["']|["']$/g, "");
    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (proj.shots && proj.shots[idx]) {
        proj.shots[idx].imagePrompt = cleaned;
        proj.shots[idx].imagePromptGenerated = true;
        if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + idx];
      }
    });
    if (isCurrent) updatePromptCard(idx, "done", cleaned);
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 100);
    updatePromptCard(idx, "error", null, errMsg);
    throw e;
  }
}

/* ================================================================
   批量转换 prompt — Phase 3-B-1 pilot
   主路径：POST /api/batch/start + SSE subscribeBatch
   Fallback：/api/batch/start 4xx（executor 没注册等）时走老循环
   ================================================================ */
export async function convertAllPrompts() {
  if (!project || !project.shots) return;
  if (_promptsConverting) { showToast("正在生成中，请稍候", "warn"); return; }
  _promptsConverting = true;
  var btn = $("btnConvertAll");
  var hint = $("convertHint");
  if (btn) btn.disabled = true;

  var originId = project.id;
  var targetIdxs = project.shots.map(function (_, i) { return i; })
    .filter(function (i) { return !project.shots[i].imagePromptGenerated || !project.shots[i].imagePrompt; });
  if (!targetIdxs.length) targetIdxs = project.shots.map(function (_, i) { return i; });
  var total = targetIdxs.length;

  targetIdxs.forEach(function (i) { updatePromptCard(i, "loading"); });
  if (hint) hint.textContent = "启动中… 0/" + total;

  // targetSeq -> shotIdx：task_failed 的 extra 里没 shotIdx 时用它反查
  var seqToShotIdx = {};
  targetIdxs.forEach(function (shotIdx, seq) { seqToShotIdx[seq] = shotIdx; });

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_prompts',
      projectId: originId,
      targets: targetIdxs.map(function (i) { return { idx: i }; }),
      options: { creatorProfile: formatCreatorProfileForApi() },
    });
  } catch (e) {
    _promptsConverting = false;
    if (btn) btn.disabled = false;
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (hint) hint.textContent = "批量启动失败：" + errMsg;
    showToast("批量启动失败：" + _diagnoseApiError(errMsg), "error");
    targetIdxs.forEach(function (i) { updatePromptCard(i, "error", null, errMsg); });
    return;
  }

  var doneCount = 0;
  var failCount = 0;

  function finish() {
    if (!_promptsConverting) return;  // 去重
    _promptsConverting = false;
    if (btn) btn.disabled = false;
    var done = project.shots.filter(function (s) { return s.imagePromptGenerated; }).length;
    if (hint) hint.textContent = done + "/" + project.shots.length + " 条已生成";
    checkConvertConfirm();
  }

  subscribeBatch(startResp.batchId, {
    onSnapshot: function (snap) {
      // 刷新页面 / 晚订阅时，这是第一帧：用累计数把进度条先对齐一下
      if (hint && snap && typeof snap.total === 'number') {
        hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + snap.total;
      }
    },
    onTaskCompleted: function (data) {
      doneCount++;
      var extra = data.extra || {};
      var patch = data.patch || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : seqToShotIdx[data.targetSeq];
      if (typeof shotIdx !== 'number') return;
      var cleaned = extra.imagePrompt || patch.value || "";
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (proj.shots && proj.shots[shotIdx]) {
          proj.shots[shotIdx].imagePrompt = cleaned;
          proj.shots[shotIdx].imagePromptGenerated = true;
          if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + shotIdx];
        }
      }, data && data.serverVersion);
      if (isCurrent) updatePromptCard(shotIdx, "done", cleaned);
      if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + total;
    },
    onTaskFailed: function (data) {
      failCount++;
      var extra = data.extra || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : seqToShotIdx[data.targetSeq];
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 100);
      if (typeof shotIdx === 'number') updatePromptCard(shotIdx, "error", null, errMsg);
      if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + total;
    },
    onBatchCompleted: function () {
      if (failCount > 0) showToast(failCount + " 条生成失败", "warn");
      finish();
    },
    onClose: function () {
      // SSE 断开（非正常结束）：保底把按钮还回来，用户可重试
      finish();
    },
  });
}

/**
 * 老的前端循环路径，只在 /api/batch/start 4xx 时兜底。
 * 等后端 executor 稳定后删（Phase 3-B-2 收尾）。
 */
export function confirmPrompts() {
  if (!project || !project.shots) return;
  var missing = project.shots.filter(function (s) { return !s.imagePromptGenerated || !s.imagePrompt; });
  if (missing.length) { showToast("还有 " + missing.length + " 条画面指令未准备好", "warn"); return; }
  var stepGenerate = $("imgStepGenerate");
  if (stepGenerate) stepGenerate.hidden = false;
  var stepConvert = $("imgStepConvert");
  if (stepConvert) {
    var area = stepConvert.querySelector(".action-area");
    if (area) area.hidden = true;
  }
  renderImageGrid();
}

function _sbPromptShort(text, maxLen) {
  var t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  maxLen = maxLen || 120;
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

function _shotStoryboardSlotEmptyHtml(text) {
  return '<div class="shot-storyboard-slot-empty">' +
    '<span class="material-symbols-outlined">image</span>' +
    '<p>' + escapeHtml(text || '等待分镜数据') + '</p>' +
  '</div>';
}

function _shotStoryboardSlotFallbackHtml(shotIdx) {
  if (!project || !Array.isArray(project.storyboards) || !project.storyboards.length) {
    return _shotStoryboardSlotEmptyHtml('等待镜头计划确认');
  }
  var info = _segmentInfoForShot(project, shotIdx);
  if (info && info.isSegmentFirst) {
    return _shotStoryboardSlotEmptyHtml('片段 ' + info.groupNo + ' 首帧将在这里管理');
  }
  return _shotStoryboardSlotEmptyHtml(
    '并入片段 ' + info.groupNo + '，首帧在镜头 ' + String(info.anchorShotNo).padStart(2, '0') + ' 管理，无需单独出图'
  );
}

function _storyboardGroupShotRangeText(group) {
  var idxs = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  if (!idxs.length) return '';
  var first = Number(idxs[0]);
  var last = Number(idxs[idxs.length - 1]);
  if (!Number.isInteger(first)) return '';
  if (!Number.isInteger(last) || last === first) return String(first + 1).padStart(2, '0');
  return String(first + 1).padStart(2, '0') + '-' + String(last + 1).padStart(2, '0');
}

function _groupAnchorShotIdx(group, fallbackIdx) {
  var idxs = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  for (var i = 0; i < idxs.length; i++) {
    var idx = Number(idxs[i]);
    if (Number.isInteger(idx) && idx >= 0) return idx;
  }
  return fallbackIdx;
}

function _storyboardCardHtml(gIdx, group, sb, opts) {
  opts = opts || {};
  var idxs = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  var shots = Array.isArray(group && group.shots) ? group.shots : [];
  var firstIdx = Number.isInteger(Number(idxs[0])) ? Number(idxs[0]) : gIdx;
  var lastIdx = Number.isInteger(Number(idxs[idxs.length - 1])) ? Number(idxs[idxs.length - 1]) : firstIdx;
  var shotLabel = 'SHOT ' + String(firstIdx + 1).padStart(2, '0');
  if (idxs.length > 1) shotLabel += '-' + String(lastIdx + 1).padStart(2, '0');
  shotLabel += ' · ' + ((shots[0] && shots[0].shotType) || 'Shot');
  var shotRangeText = idxs.length ? String(firstIdx + 1) : String(gIdx + 1);
  if (idxs.length > 1) shotRangeText += '-' + String(lastIdx + 1);
  return '<div class="shots-storyboard-card-inner">' +
    '<div class="sb-sheet-loading absolute inset-0 flex items-center justify-center bg-white z-30 rounded-[2rem]" hidden>' +
      '<div class="text-center">' +
        '<div class="inline-block w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin mb-3"></div>' +
        '<span class="block text-xs font-bold text-on-surface-variant">生成中…</span>' +
      '</div>' +
    '</div>' +
    '<div class="sb-sheet-error absolute inset-0 flex flex-col items-center justify-center bg-white z-30 rounded-[2rem] p-8 text-center" hidden>' +
      '<span class="material-symbols-outlined text-5xl text-error mb-3">error_outline</span>' +
      '<span class="text-sm font-bold text-error mb-2">首帧图生成失败</span>' +
      '<span class="sb-error-msg text-xs text-on-surface-variant/80 max-w-md leading-relaxed"></span>' +
      '<span class="text-[10px] text-on-surface-variant/40 mt-4">点击下方「重新生成」可再次尝试</span>' +
    '</div>' +
    '<div class="shots-storyboard-card-head">' +
      '<div class="min-w-0">' +
        '<div class="flex items-center gap-3 flex-wrap">' +
          '<h3>分镜板 ' + (gIdx + 1) + '</h3>' +
          '<span class="shot-segment-tag" title="归属镜头编号">归属镜头' + escapeHtml(shotRangeText) + '</span>' +
        '</div>' +
        '<p>' + escapeHtml(shotLabel) + ' · ' + shots.length + ' 个镜头</p>' +
      '</div>' +
      '<div class="shots-storyboard-card-actions">' +
        (opts.mergedChild ? '' : _historyBtnHtml(sb, "sb")) +
      '</div>' +
    '</div>' +
    '<div class="shots-storyboard-card-body">' +
      '<div class="sb-frame-stack">' +
        _storyboardFramePanelHtml('first', sb, gIdx, group, {
          mergedChild: opts.mergedChild === true,
          readOnlyActions: opts.mergedChild === true,
        }) +
        _storyboardFramePanelHtml('tail', sb, gIdx, group, {
          mergedChild: opts.mergedChild === true,
          readOnlyActions: opts.mergedChild === true,
        }) +
      '</div>' +
    '</div>' +
  '</div>';
}

function _setTopFirstFrameActionLocked(locked) {
  var actionBar = $("imagesActionBar");
  var btn = $("btnGenAllImages");
  if (actionBar) actionBar.hidden = false;
  if (!btn) return;
  btn.innerHTML = '<span class="shots-step-number">II</span><span>生成全部关键帧</span>';
  btn.disabled = !!locked;
  btn.dataset.actionState = locked ? 'locked' : '';
  btn.title = locked ? '镜头计划可用后可生成全部关键帧' : '';
}

function _storyboardIndexRailHasFailure(sb) {
  sb = sb || {};
  if (_isFirstFrameFailed(sb)) return true;
  return _tailFrameUiState(sb).status === 'failed';
}

function _setStoryboardIndexRailActive(shotIdx) {
  var rail = $("sbIndexRail");
  if (!rail) return;
  shotIdx = Number(shotIdx);
  if (!Number.isFinite(shotIdx)) return;
  _sbIndexRailActiveShotIdx = shotIdx;
  rail.querySelectorAll(".sb-index-rail-btn").forEach(function (btn) {
    btn.classList.toggle("is-active", Number(btn.dataset.shotIdx) === shotIdx);
  });
}

function _setStoryboardIndexRailFailureForGroup(gIdx, failed) {
  var rail = $("sbIndexRail");
  if (!rail) return;
  rail.querySelectorAll('.sb-index-rail-btn[data-gidx="' + String(gIdx) + '"]').forEach(function (btn) {
    btn.classList.toggle("is-failed", !!failed);
  });
}

function _positionStoryboardIndexRail() {
  var rail = $("sbIndexRail");
  if (!rail || rail.hidden) return;
  var firstButton = rail.querySelector(".sb-index-rail-btn");
  var firstCard = document.querySelector('.shot-workbench-card[data-shot-idx="0"]') || document.querySelector(".shot-workbench-card");
  var sidebar = $("sidebar");
  if (firstButton && firstCard && sidebar) {
    var sidebarRight = sidebar.getBoundingClientRect().right;
    var cardLeft = firstCard.getBoundingClientRect().left;
    var btnWidth = firstButton.getBoundingClientRect().width || 17;
    var gapLeft = Math.min(sidebarRight, cardLeft);
    var gapRight = Math.max(sidebarRight, cardLeft);
    var centeredLeft = gapLeft + ((gapRight - gapLeft) - btnWidth) / 2;
    rail.style.left = Math.round(Math.max(0, centeredLeft)) + "px";
  }
  var taskShortcut = $("navTaskListWrap") || $("navTaskListShortcut");
  if (taskShortcut) {
    rail.style.top = Math.round(taskShortcut.getBoundingClientRect().top) + "px";
  }
}

function _storyboardIndexRailAnchorY() {
  var rail = $("sbIndexRail");
  if (!rail || rail.hidden) return 112;
  var firstButton = rail.querySelector(".sb-index-rail-btn");
  if (firstButton) return firstButton.getBoundingClientRect().top;
  return rail.getBoundingClientRect().top || 112;
}

function _shotCardsForIndexRail() {
  var root = $("shotListWrap");
  return root ? Array.prototype.slice.call(root.querySelectorAll(".shot-workbench-card[data-shot-idx]")) : [];
}

function _currentShotIdxForIndexRailViewport() {
  var cards = _shotCardsForIndexRail().filter(function (card) {
    var idx = Number(card.dataset.shotIdx);
    return Number.isFinite(idx);
  });
  if (!cards.length) return null;
  var anchorY = _storyboardIndexRailAnchorY();
  var testY = anchorY + SB_INDEX_RAIL_ANCHOR_EPSILON;
  var previousIdx = null;
  for (var i = 0; i < cards.length; i++) {
    var rect = cards[i].getBoundingClientRect();
    var shotIdx = Number(cards[i].dataset.shotIdx);
    if (rect.top <= testY && rect.bottom > testY) return shotIdx;
    if (rect.top <= testY) previousIdx = shotIdx;
  }
  if (previousIdx !== null) return previousIdx;
  return Number(cards[0].dataset.shotIdx);
}

function _syncStoryboardIndexRailFromViewport() {
  var rail = $("sbIndexRail");
  if (!rail || rail.hidden) return;
  if (_sbIndexRailProgrammaticScrolling) return;
  if (!rail.querySelector(".sb-index-rail-btn")) return;
  if (!_shotCardsForIndexRail().length) return;
  var shotIdx = _currentShotIdxForIndexRailViewport();
  if (shotIdx === null) return;
  _setStoryboardIndexRailActive(shotIdx);
}

function _scheduleStoryboardIndexRailViewportSync(opts) {
  opts = opts || {};
  var reposition = !!opts.reposition;
  if (_sbIndexRailSyncRaf) return;
  _sbIndexRailSyncRaf = requestAnimationFrame(function () {
    _sbIndexRailSyncRaf = 0;
    if (reposition) _positionStoryboardIndexRail();
    _syncStoryboardIndexRailFromViewport();
  });
}

function _bindStoryboardIndexRailViewportSync() {
  if (!_sbIndexRailViewportSyncBound) {
    _sbIndexRailViewportSyncBound = true;
    window.addEventListener("scroll", function () {
      _scheduleStoryboardIndexRailViewportSync();
    }, { passive: true });
    window.addEventListener("resize", function () {
      _scheduleStoryboardIndexRailViewportSync({ reposition: true });
    });
  }
  if (_sbIndexRailResizeObserver && _sbIndexRailResizeObserver.disconnect) {
    _sbIndexRailResizeObserver.disconnect();
    _sbIndexRailResizeObserver = null;
  }
  var root = $("shotListWrap");
  if (root && typeof ResizeObserver !== "undefined") {
    _sbIndexRailResizeObserver = new ResizeObserver(function () {
      _scheduleStoryboardIndexRailViewportSync();
    });
    _sbIndexRailResizeObserver.observe(root);
  }
}

function _waitForIndexRailScrollSettle(targetScrollY, shotIdx) {
  var lastY = window.scrollY || window.pageYOffset || 0;
  var stableFrames = 0;
  function tick() {
    var currentY = window.scrollY || window.pageYOffset || 0;
    var nearTarget = Math.abs(currentY - targetScrollY) < 2;
    var stable = Math.abs(currentY - lastY) < 0.5;
    stableFrames = (nearTarget || stable) ? stableFrames + 1 : 0;
    lastY = currentY;
    if (stableFrames >= 2) {
      _sbIndexRailProgrammaticScrolling = false;
      _sbIndexRailScrollSettleTimer = null;
      _setStoryboardIndexRailActive(shotIdx);
      _scheduleStoryboardIndexRailViewportSync();
      return;
    }
    _sbIndexRailScrollSettleTimer = setTimeout(tick, 80);
  }
  _sbIndexRailScrollSettleTimer = setTimeout(tick, 80);
}

function _scrollToShotCardFromRail(shotIdx) {
  var selector = '.shot-workbench-card[data-shot-idx="' + String(shotIdx) + '"]';
  var root = $("shotListWrap");
  var card = root && root.querySelector(selector);
  if (!card) card = document.querySelector(selector);
  if (!card) return;
  if (_sbIndexRailScrollSettleTimer) {
    clearTimeout(_sbIndexRailScrollSettleTimer);
    _sbIndexRailScrollSettleTimer = null;
  }
  _sbIndexRailProgrammaticScrolling = true;
  _setStoryboardIndexRailActive(shotIdx);
  var targetTop = _storyboardIndexRailAnchorY();
  var cardTop = card.getBoundingClientRect().top;
  var nextScrollY = window.scrollY + cardTop - targetTop;
  try {
    window.scrollTo({ top: Math.max(0, nextScrollY), behavior: "smooth" });
  } catch (_e) {
    window.scrollTo(0, Math.max(0, nextScrollY));
  }
  _waitForIndexRailScrollSettle(Math.max(0, nextScrollY), shotIdx);
}

function _renderStoryboardIndexRail(groups, isShotLayout) {
  var rail = $("sbIndexRail");
  if (!rail) return;
  var shots = project && Array.isArray(project.shots) ? project.shots : [];
  if (!isShotLayout || !shots.length || shots.length < 2) {
    rail.hidden = true;
    rail.innerHTML = "";
    _sbIndexRailActiveShotIdx = null;
    return;
  }
  var html = '<div class="sb-index-rail-inner">';
  for (var i = 0; i < shots.length; i++) {
    var info = _segmentInfoForShot(project, i) || {};
    var gIdx = Number.isInteger(Number(info.groupIdx)) ? Number(info.groupIdx) : i;
    var sb = project && project.storyboards && project.storyboards[gIdx] || {};
    var failed = _storyboardIndexRailHasFailure(sb);
    html += '<button type="button" class="sb-index-rail-btn' +
      (failed ? ' is-failed' : '') +
      '" data-shot-idx="' + i + '" data-gidx="' + gIdx + '" title="跳到镜头 ' + (i + 1) + '">' + (i + 1) + '</button>';
  }
  html += '</div>';
  rail.hidden = false;
  rail.innerHTML = html;
  _positionStoryboardIndexRail();
  rail.querySelectorAll(".sb-index-rail-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var shotIdx = parseInt(btn.dataset.shotIdx, 10);
      if (isNaN(shotIdx)) return;
      _scrollToShotCardFromRail(shotIdx);
    });
  });
  _bindStoryboardIndexRailViewportSync();
  _scheduleStoryboardIndexRailViewportSync();
}

export function renderImageGrid() {
  _syncRefs();
  var grid = $("imageGrid");
  if (!grid || !project || !project.shots) return;
  var isShotLayout = grid.dataset.layout === "shots";
  var shotListWrap = $("shotListWrap");
  var prevScrollLeft = grid.scrollLeft || 0;
  var prevIdx = _sbCurrentIdx || 0;
  grid.innerHTML = "";
  if (!project.storyboards) project.storyboards = [];
  var groups = getStoryboardGroups();
  _pruneFrameCardCollapsed(groups);
  if (isShotLayout && shotListWrap) {
    shotListWrap.querySelectorAll(".shot-storyboard-slot").forEach(function (slot) {
      var shotIdx = parseInt(slot.dataset.shotIdx, 10);
      slot.innerHTML = _shotStoryboardSlotFallbackHtml(isNaN(shotIdx) ? 0 : shotIdx);
    });
    shotListWrap.querySelectorAll(".shot-material-slot").forEach(function (slot) {
      slot.innerHTML = '<div class="shot-material-slot-empty">等待素材匹配</div>';
    });
  }

  var actionBar = $("imagesActionBar");
  if (actionBar) actionBar.hidden = false;

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var card = document.createElement("div");
    card.className = "sb-sheet shots-storyboard-card";
    card.dataset.groupIdx = gIdx;
    card.innerHTML = _storyboardCardHtml(gIdx, group, sb);
    if (isShotLayout && shotListWrap) {
      var anchorShotIdx = _groupAnchorShotIdx(group, gIdx);
      var materialSlot = $("shotMaterialSlot_" + anchorShotIdx);
      var assetPanel = card.querySelector(".shot-material-panel-slot");
      if (materialSlot && assetPanel) {
        materialSlot.innerHTML = "";
        materialSlot.appendChild(assetPanel);
      }
      var slot = $("shotStoryboardSlot_" + anchorShotIdx) || shotListWrap.querySelector('.shot-storyboard-slot[data-shot-idx="' + anchorShotIdx + '"]');
      if (slot) {
        slot.innerHTML = "";
        slot.appendChild(card);
      } else {
        grid.appendChild(card);
      }
      (group.shotIndices || []).forEach(function (shotIdx) {
        if (Number(shotIdx) === Number(anchorShotIdx)) return;
        var mirrorSlot = $("shotStoryboardSlot_" + shotIdx);
        if (!mirrorSlot) return;
        var mirrorCard = document.createElement("div");
        mirrorCard.className = "sb-sheet shots-storyboard-card shots-storyboard-card-merged-child";
        mirrorCard.dataset.groupIdx = gIdx;
        mirrorCard.dataset.mergedShotIdx = shotIdx;
        mirrorCard.innerHTML = _storyboardCardHtml(gIdx, group, sb, { mergedChild: true });
        var mirrorMaterialSlot = $("shotMaterialSlot_" + shotIdx);
        var mirrorAssetPanel = mirrorCard.querySelector(".shot-material-panel-slot");
        if (mirrorMaterialSlot && mirrorAssetPanel) {
          mirrorMaterialSlot.innerHTML = "";
          mirrorMaterialSlot.appendChild(mirrorAssetPanel);
        }
        mirrorSlot.innerHTML = "";
        mirrorSlot.appendChild(mirrorCard);
      });
    } else {
      grid.appendChild(card);
    }
  });

  var bindRoot = (isShotLayout && shotListWrap) ? shotListWrap : grid;

  bindRoot.querySelectorAll(".sb-prompt-edit").forEach(function (ta) {
    ta.addEventListener("blur", function () {
      var gIdx = parseInt(ta.dataset.gidx, 10);
      if (isNaN(gIdx)) return;
      var grps = getStoryboardGroups();
      var grp = grps[gIdx];
      if (!grp) return;
      var parts = ta.value.split(/\n---\n/);
      var _changed = false;
      grp.shots.forEach(function (shot, i) {
        if (parts[i] !== undefined) {
          var _newP = parts[i].trim();
          if (project.shots[grp.shotIndices[i]].imagePrompt !== _newP) _changed = true;
          project.shots[grp.shotIndices[i]].imagePrompt = _newP;
          project.shots[grp.shotIndices[i]].imagePromptGenerated = true;
        }
      });
      if (_changed && project.storyboards && project.storyboards[gIdx] && project.storyboards[gIdx].imageUrl) {
        if (!project._staleFlags) project._staleFlags = {};
        project._staleFlags["storyboard_" + gIdx] = true;
      }
      saveProject();
    });
  });

  bindRoot.querySelectorAll(".sb-toggle-prompt").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var card = btn.closest(".sb-sheet");
      if (!card) return;
      var area = card.querySelector(".sb-prompt-area");
      if (area) {
        area.hidden = !area.hidden;
        if (!area.hidden) {
          var ta = area.querySelector("textarea");
          if (ta) ta.focus();
        }
      }
    });
  });

  _initGalleryDrag(grid);
  hydrateProtectedImageElements(bindRoot);
  _sbSyncFramePromptSafetyHighlights(bindRoot);
  requestAnimationFrame(function () {
    _sbHydrateFirstFramePromptEditors(bindRoot);
    _sbHydrateTailFramePromptEditors(bindRoot);
    _sbSyncFramePromptSafetyHighlights(bindRoot);
  });
  _ensureShotMaterialPanels(groups);
  _sbCurrentIdx = groups.length ? Math.min(prevIdx, groups.length - 1) : 0;
  _renderStoryboardIndexRail(groups, isShotLayout);
  if (!isShotLayout) _updateNavDots(groups.length);
  if (!isShotLayout && prevScrollLeft > 0) {
    requestAnimationFrame(function () {
      var maxScrollLeft = Math.max(0, grid.scrollWidth - grid.clientWidth);
      grid.scrollLeft = Math.min(prevScrollLeft, maxScrollLeft);
      _syncNavFromScroll(grid);
    });
  }
}

function _initGalleryDrag(container) {
  if (!container || container.dataset.dragInited === "1") return;
  if (container.dataset.layout === "shots") return;
  container.dataset.dragInited = "1";
  var pointerState = null;
  var suppressClick = false;
  var wheelLocked = false;
  var wheelUnlockTimer = null;

  container.style.touchAction = "pan-y";
  container.style.overscrollBehaviorX = "contain";
  container.style.scrollSnapType = "none";

  function _gestureThreshold() {
    return Math.max(48, Math.min(120, container.clientWidth * 0.12));
  }

  function _pageByDelta(delta) {
    if (!delta) return;
    var cards = container.querySelectorAll(".sb-sheet");
    if (!cards.length) return;
    var nextIdx = _sbCurrentIdx + (delta > 0 ? 1 : -1);
    nextIdx = Math.max(0, Math.min(cards.length - 1, nextIdx));
    scrollToCard(nextIdx);
  }

  container.addEventListener("wheel", function (e) {
    var delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 24) return;
    e.preventDefault();
    if (!wheelLocked) {
      wheelLocked = true;
      _pageByDelta(delta);
    }
    if (wheelUnlockTimer) clearTimeout(wheelUnlockTimer);
    wheelUnlockTimer = setTimeout(function () {
      wheelLocked = false;
      wheelUnlockTimer = null;
    }, 720);
  }, { passive: false });

  container.addEventListener("click", function (e) {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }, true);

  container.addEventListener("pointerdown", function (e) {
    if (e.target.closest("button, textarea, select, a, details, summary, input")) return;
    pointerState = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    container.classList.add("active");
    try { container.setPointerCapture(e.pointerId); } catch (_e) {}
  });

  container.addEventListener("pointermove", function (e) {
    if (!pointerState || e.pointerId !== pointerState.id) return;
    pointerState.lastX = e.clientX;
    pointerState.lastY = e.clientY;
    var dx = pointerState.lastX - pointerState.startX;
    var dy = pointerState.lastY - pointerState.startY;
    if (!pointerState.moved && Math.hypot(dx, dy) < 6) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      pointerState.moved = true;
      e.preventDefault();
    }
  }, { passive: false });

  function _endPointer(e) {
    if (!pointerState || (e && e.pointerId !== pointerState.id)) return;
    var state = pointerState;
    pointerState = null;
    container.classList.remove("active");
    try { container.releasePointerCapture(state.id); } catch (_e) {}

    var dx = state.lastX - state.startX;
    var dy = state.lastY - state.startY;
    if (state.moved) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 180);
      if (Math.abs(dx) >= _gestureThreshold() && Math.abs(dx) > Math.abs(dy)) {
        _pageByDelta(dx < 0 ? 1 : -1);
      } else {
        scrollToCard(_sbCurrentIdx);
      }
    }
  }

  container.addEventListener("pointerup", _endPointer);
  container.addEventListener("pointercancel", _endPointer);
  container.addEventListener("scroll", _debounce(function () {
    _syncNavFromScroll(container);
  }, 120));
}

function _debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function _updateNavDots(count) {
  var dotsWrap = $("sbNavDots");
  if (!dotsWrap) return;
  dotsWrap.innerHTML = "";
  for (var i = 0; i < count; i++) {
    var dot = document.createElement("div");
    dot.className = i === _sbCurrentIdx
      ? "w-10 h-1 bg-primary rounded-full transition-all"
      : "w-4 h-1 bg-primary/20 rounded-full transition-all";
    dot.dataset.dotIdx = i;
    dotsWrap.appendChild(dot);
  }
}

function _syncNavFromScroll(container) {
  if (_sbProgrammaticScrolling) return;
  var cards = container.querySelectorAll(".sb-sheet");
  if (!cards.length) return;
  var containerRect = container.getBoundingClientRect();
  var center = containerRect.left + containerRect.width / 2;
  var closest = 0, minDist = Infinity;
  cards.forEach(function (c, i) {
    var r = c.getBoundingClientRect();
    var d = Math.abs(r.left + r.width / 2 - center);
    if (d < minDist) { minDist = d; closest = i; }
  });
  if (closest !== _sbCurrentIdx) {
    _sbCurrentIdx = closest;
    _updateNavDots(cards.length);
  }
}

export function getSbCurrentIdx() { return _sbCurrentIdx; }

export function scrollToCard(idx) {
  var grid = $("imageGrid");
  if (!grid) return;
  var cards = grid.querySelectorAll(".sb-sheet");
  if (idx < 0 || idx >= cards.length) return;

  var card = cards[idx];
  var gridRect = grid.getBoundingClientRect();
  var cardRect = card.getBoundingClientRect();
  var targetLeft = grid.scrollLeft + (cardRect.left - gridRect.left) - (grid.clientWidth - cardRect.width) / 2;
  var maxLeft = Math.max(0, grid.scrollWidth - grid.clientWidth);
  targetLeft = Math.max(0, Math.min(maxLeft, targetLeft));

  if (_sbScrollSettleTimer) {
    clearTimeout(_sbScrollSettleTimer);
    _sbScrollSettleTimer = null;
  }
  _sbProgrammaticScrolling = true;
  grid.style.scrollSnapType = "none";
  try {
    grid.scrollTo({ left: targetLeft, behavior: "smooth" });
  } catch (_e) {
    grid.scrollLeft = targetLeft;
  }
  _sbCurrentIdx = idx;
  _updateNavDots(cards.length);
  _waitForScrollSettle(grid, targetLeft);
}

function _waitForScrollSettle(grid, targetLeft) {
  var lastLeft = grid.scrollLeft;
  var stableFrames = 0;
  function tick() {
    var currentLeft = grid.scrollLeft;
    var nearTarget = Math.abs(currentLeft - targetLeft) < 1;
    var stable = Math.abs(currentLeft - lastLeft) < 0.5;
    stableFrames = (nearTarget || stable) ? stableFrames + 1 : 0;
    lastLeft = currentLeft;
    if (stableFrames >= 2) {
      _sbProgrammaticScrolling = false;
      _sbScrollSettleTimer = null;
      _syncNavFromScroll(grid);
      return;
    }
    _sbScrollSettleTimer = setTimeout(tick, 80);
  }
  _sbScrollSettleTimer = setTimeout(tick, 80);
}

export function updateStoryboardCard(gIdx, status, imgUrl, errMsg) {
  // Phase 3-A：DOM 级渲染委托给 render_hooks.renderStoryboardCard。
  // 顺手修 audit P0-4：done 时实际更新 <img src>，原来只关 overlay 不换图
  // 导致生成成功后卡片还显示旧图 / 占位符，需要用户手动刷新才能看到新图。
  // done + 无 <img>（之前只是占位符）时，由 needFullRerender 触发整体重渲。
  var result = renderStoryboardCard(gIdx, status, {
    imgUrl: imgUrl,
    loadingText: (status === "loading") ? errMsg : undefined,
    errMsg: (status === "error") ? errMsg : undefined,
  });
  if (!result.ok) return;
  if (status === "error") _setStoryboardIndexRailFailureForGroup(gIdx, true);
  else if (status === "done" || status === "ready" || status === "success") _setStoryboardIndexRailFailureForGroup(gIdx, false);
  if (result.needFullRerender) renderImageGrid();
}

function _firstFrameUrl(sb) {
  return _firstFrameImageUrl(sb);
}

function _isFirstFrameFailed(sb) {
  sb = sb || {};
  var st = String((sb.frames && sb.frames.first && sb.frames.first.status) || sb.firstFrameStatus || '').toLowerCase();
  return st === 'failed' || st === 'error' || !!sb.firstFrameLastError;
}

// 用户原则: 尾帧不再被系统自动判定"需更新"。这里只在尾帧真的处于不可用状态
// (失败 / 缺图 / 文件丢失) 时才回 true, 用于批量"重试失败"的兜底; 没有 hash 不一致
// 或 sourceHash 缺失之类的隐性 stale。
function _tailNeedsUpdate(sb /*, gIdx */) {
  if (!_isTailRequested(sb)) return false;
  var tail = (sb.frames && sb.frames.tail) || null;
  var status = String((tail && tail.status) || '').toLowerCase();
  var refStatus = String(sb.tailFrameReferenceStatus || (tail && tail.referenceStatus) || '').toLowerCase();
  if (!_tailFrameImageUrl(sb)) return true;
  if (status === 'failed') return true;
  if (refStatus === 'missing' || refStatus === 'file_missing' || refStatus === 'unresolvable') return true;
  return false;
}

function _tailFrameStatusForBatch(sb) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  var tailUrl = _tailFrameImageUrl(sb);
  return String((tail && tail.status) || (sb.tailFrameLastError ? 'failed' : (tailUrl ? 'ready' : 'missing'))).toLowerCase();
}

function _isTailKeyframeWanted(group, sb) {
  var idxs = (group && Array.isArray(group.shotIndices)) ? group.shotIndices : [];
  if (idxs.length > 1) return false;
  var intent = _tailFrameGenerationIntentForGroup(group, sb);
  return !!(intent && intent.wanted);
}

function _tailKeyframeNeedsGeneration(sb, opts) {
  opts = opts || {};
  if (opts.includeReady) return true;
  var tailStatus = _tailFrameStatusForBatch(sb);
  return !_tailFrameImageUrl(sb) || tailStatus === 'failed';
}

function _tailKeyframeCanBeGeneratedNow(group, sb) {
  return !!_tailFrameGenerationIntentForGroup(group || {}, sb).canGenerate;
}

function _tailKeyframeCanBePlannedAfterFirst(group, sb) {
  var intent = _tailFrameGenerationIntentForGroup(group || {}, sb);
  return !!intent.requiresFirstFrame && (!_firstFrameUrl(sb) || _isFirstFrameFailed(sb));
}

function _tailKeyframeTargets(groups, opts) {
  opts = opts || {};
  groups = groups || getStoryboardGroups();
  var targets = [];
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i];
    var sb = (project.storyboards && project.storyboards[i]) || {};
    if (!_isTailKeyframeWanted(group, sb)) continue;
    var tailStatus = _tailFrameStatusForBatch(sb);
    if (opts.failedOnly && tailStatus !== 'failed') continue;
    if (!opts.failedOnly && !_tailKeyframeNeedsGeneration(sb, opts)) continue;
    if (!_tailKeyframeCanBeGeneratedNow(group, sb)) continue;
    targets.push({ groupIdx: i, idx: i, shotIndices: (group && group.shotIndices) || [] });
  }
  return targets;
}

function _plannedTailKeyframeCountForProgress(groups, buttonState, tailKeyframeMode) {
  groups = groups || getStoryboardGroups();
  buttonState = buttonState || {};
  if (tailKeyframeMode === 'all') {
    var allCount = 0;
    for (var i = 0; i < groups.length; i++) {
      var sb = (project.storyboards && project.storyboards[i]) || {};
      if (_isTailKeyframeWanted(groups[i], sb)) allCount++;
    }
    return allCount;
  }
  if (tailKeyframeMode === 'failed') return (buttonState.failedTail || []).length;
  return (buttonState.pendingTailKeyframes || []).length;
}

function _isFirstFrameStale(gIdx) {
  return !!(project && project._staleFlags && project._staleFlags["storyboard_" + gIdx]);
}

function _computeImagesBatchState(groups, opts) {
  opts = opts || {};
  groups = groups || getStoryboardGroups();
  var missingFirst = [];
  var failedFirst = [];
  var failedTail = [];
  var staleFirst = [];
  var staleTail = [];
  var pendingTailKeyframes = [];
  var readyFirstCount = 0;
  for (var i = 0; i < groups.length; i++) {
    var sb = (project.storyboards && project.storyboards[i]) || {};
    var hasFirst = !!_firstFrameUrl(sb);
    if (hasFirst) readyFirstCount++;
    if (!hasFirst) missingFirst.push(i);
    if (_isFirstFrameFailed(sb)) failedFirst.push(i);
    if (hasFirst && _isFirstFrameStale(i)) staleFirst.push(i);
    if (_tailNeedsUpdate(sb, i)) staleTail.push(i);
    if (_isTailKeyframeWanted(groups[i], sb) && _tailKeyframeNeedsGeneration(sb)) {
      var tailStatusForBatch = _tailFrameStatusForBatch(sb);
      if (tailStatusForBatch === 'failed') failedTail.push(i);
      if (tailStatusForBatch !== 'failed' && (_tailKeyframeCanBeGeneratedNow(groups[i], sb) || _tailKeyframeCanBePlannedAfterFirst(groups[i], sb))) {
        pendingTailKeyframes.push(i);
      }
    }
  }
  var staleCount = staleFirst.length + staleTail.length;
  var failedKeyframeCount = failedFirst.length + failedTail.length;
  var missingKeyframeCount = missingFirst.length + pendingTailKeyframes.length;
  var action = 'generate_all';
  var label = '生成全部关键帧';
  // 状态机：
  //   - generating: 启动中… / 生成中…
  //   - generate_all: 全部缺首帧 → 生成全部关键帧
  //   - retry_failed: 有失败首帧/建议尾帧 → 重试失败项·N个
  //   - fill_missing: 部分缺首帧/建议尾帧 → 补全 N 个关键帧
  //   - regenerate_all: 全部就绪（含 stale-only 场景）→ 重新生成全部关键帧
  // 注：以前有独立的 update_stale 分支，文案"更新 N 项需更新"且只重生 stale 那几张。
  // 用户决策：stale-only 场景统一显示"重新生成全部关键帧"，点击即全量重生（与 regenerate_all 行为一致），
  // 避免按钮文案与"装饰性需更新"挂钩。
  if ((_imagesGenerating || _imagesStarting || _tailFramesGenerating) && !opts.ignoreGenerating) {
    action = 'generating';
    label = _imagesStarting ? '启动中…' : '生成中…';
  } else if (groups.length > 0 && missingFirst.length === groups.length) {
    action = 'generate_all';
    label = '生成全部关键帧';
  } else if (failedKeyframeCount > 0) {
    action = 'retry_failed';
    label = '重试失败项·' + failedKeyframeCount + '个';
  } else if (missingKeyframeCount > 0) {
    action = 'fill_missing';
    label = '补全 ' + missingKeyframeCount + ' 个关键帧';
  } else if (readyFirstCount > 0) {
    // stale-only 也走这里——staleCount 不再单独分支处理。
    action = 'regenerate_all';
    label = '重新生成全部关键帧';
  }
  // staleCount 仍计算保留供 dispatch 决定要不要顺带刷尾帧关键帧。
  void staleCount;
  return {
    action: action,
    label: label,
    missingFirst: missingFirst,
    failedFirst: failedFirst,
    failedTail: failedTail,
    staleFirst: staleFirst,
    staleTail: staleTail,
    pendingTailKeyframes: pendingTailKeyframes,
  };
}

function _allFirstFramesReady(groups) {
  groups = groups || getStoryboardGroups();
  if (!project || !groups.length) return false;
  if (!project.storyboards) project.storyboards = [];
  return groups.every(function (_, i) {
    return !!(project.storyboards[i] && _firstFrameUrl(project.storyboards[i]));
  });
}

function _syncMergedStoryboardConfirmState(groups) {
  var topArea = $("shotsConfirmArea");
  var topBtn = $("btnConfirmShots");
  if (!topArea || !topBtn || !project || !project.shots || !project.shots.length) return;

  groups = groups || getStoryboardGroups();
  // 确认链在飞期间（SSE/对账触发的重渲染会走到这里）保持忙态，
  // 防止把按钮冲回可点状态造成二次入口。
  if (_confirmImagesInFlight) {
    topArea.hidden = false;
    topBtn.disabled = true;
    topBtn.innerHTML =
      '<span class="shots-step-number">III</span>' +
      '<span>确认中…</span>';
    topBtn.title = "正在确认分镜图，请稍候";
    return;
  }
  var allFirstFramesReady = _allFirstFramesReady(groups);
  topArea.hidden = false;
  delete topBtn.dataset.confirmMode;
  topBtn.disabled = !allFirstFramesReady;
  topBtn.classList.toggle("opacity-50", !allFirstFramesReady);
  topBtn.classList.toggle("cursor-not-allowed", !allFirstFramesReady);
  topBtn.classList.toggle("shadow-none", !allFirstFramesReady);
  topBtn.classList.toggle("hover:opacity-90", allFirstFramesReady);
  topBtn.classList.toggle("hover:opacity-50", !allFirstFramesReady);
  // 统一文案：不论 allFirstFramesReady / imagesApproved 状态，都展示"确认分镜图，进入下一步"，
  // 禁用态由 disabled + opacity 区分；编号/箭头结构与 workspace.html 保持一致，
  // 避免每次刷新时把按钮子节点冲回旧结构。
  var SHOTS_CONFIRM_HTML =
    '<span class="shots-step-number">III</span>' +
    '<span>确认分镜图，进入下一步</span>' +
    '<span class="material-symbols-outlined text-base">arrow_forward</span>';
  if (!allFirstFramesReady) {
    topBtn.innerHTML = SHOTS_CONFIRM_HTML;
    topBtn.title = "请先生成全部关键帧";
    return;
  }
  topBtn.innerHTML = SHOTS_CONFIRM_HTML;
  topBtn.title = project.imagesApproved
    ? "分镜图已确认，可继续查看视频提示词"
    : "确认所有首帧分镜图并进入视频提示词";
}

function _updateImagesActionButton(groups) {
  var btn = $("btnGenAllImages");
  if (!btn || !project) return;
  groups = groups || getStoryboardGroups();
  var materialBlockMessage = _materialLimitBlockMessage(groups);
  var preflight = _getFirstFramePreflightState(groups);
  var state = _computeImagesBatchState(groups);
  // 直接使用 _computeImagesBatchState 计算出的精细 label，让按钮文案与真实状态一致：
  //   - generate_all → 生成全部关键帧
  //   - fill_missing → 补全 N 个关键帧
  //   - retry_failed → 重试失败项·N个
  //   - regenerate_all → 重新生成全部关键帧（含 stale-only 场景，全量重生）
  //   - generating → 启动中… / 生成中…
  var label = state.label;
  var preflightBlocked = preflight.status !== "allowed";
  var preflightMessage = preflight.message || "";
  var hint = $("imagesHint");
  btn.innerHTML = '<span class="shots-step-number">II</span><span>' + escapeHtml(label) + '</span>';
  btn.disabled = state.action === 'generating' || !!materialBlockMessage || preflightBlocked;
  btn.dataset.actionState = materialBlockMessage ? 'material_limit' : (preflightBlocked ? preflight.status : state.action);
  btn.title = materialBlockMessage || preflightMessage || '';
  if (hint && !_imagesGenerating && !_imagesStarting && !_tailFramesGenerating) {
    hint.textContent = materialBlockMessage || preflightMessage || FIRST_FRAME_DEFAULT_HINT;
  }
}

export function checkImagesConfirm() {
  if (!project || !project.shots) return;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  _syncMergedStoryboardConfirmState(groups);
  _updateImagesActionButton(groups);
  _syncFirstFramePrimaryButtons(groups);
  _syncShotsKeyframeHeaderHint();
}

/**
 * Phase 3-B-8：单张分镜图重生成 = 单元素 `storyboard_images` batch。
 *
 * 和"一键生成全部分镜图"完全共用 `storyboard_image_executor`：prompt 组装
 * 走后端同一条路径（`_build_storyboard_prompt`），成功后 `apply_patch_and_save`
 * 权威落盘；前端只挂 SSE 看进度 + 乐观刷卡片。不再用 `apiImageGenerate`
 * / `_pendingImageTasks` 这些前端自管套件。
 */
export async function generateStoryboardSheet(gIdx, opts) {
  opts = opts || {};
  if (!project) return;
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  var originId = project.id;
  await _ensureMaterialPanelsForChecks(groups, [gIdx]);
  var materialBlockMessage = _materialLimitBlockMessage(groups, [gIdx]);
  if (materialBlockMessage) {
    showToast(materialBlockMessage, 'warn');
    renderImageGrid();
    return;
  }

  var hasSomePrompt = group.shots.some(function (s) { return s.imagePrompt || s.visual; });
  if (!hasSomePrompt) {
    updateStoryboardCard(gIdx, "error", null, "该组镜头无描述，请先完成 AI 生成或镜头设计");
    return;
  }
  if (!opts.skipPreflight) {
    var preflightOk = await _ensureSingleFirstFramePreflightAllowed(gIdx, group);
    if (!preflightOk) {
      renderImageGrid();
      checkImagesConfirm();
      return;
    }
  }

  var initialLoadingText = "生成视频首帧…";
  updateStoryboardCard(gIdx, "loading", null, initialLoadingText);
  if (typeof opts.onLoadingText === 'function') {
    try { opts.onLoadingText(initialLoadingText); } catch (_loadingTextErr) {}
  }

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
      applyEditDraft: opts.applyEditDraft === true,
    });
  } catch (e) {
    if (opts.onStartError && opts.onStartError(e) === true) return;
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, '积分不足');
      showBillingPaywall(e.billing || null);
      return;
    }
    if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsg);
    showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsg), "error");
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || "未能创建批量任务";
    updateStoryboardCard(gIdx, "error", null, fErr);
    showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(fErr), "error");
    return;
  }
  _markStoryboardBatchLocallyAttached(originId, startResp.batchId);
  if (opts.applyEditDraft === true) _sbMarkFirstFrameCardPromptDraftCommitPending(gIdx);

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var _gotResult = false;
    // —— 单张分镜倒计时 ——
    // 抽到 _startSingleFrameEta helper (P2.5b.T3)。initial=70s 是 medium 画质 + 中转
    // 排队实测典型值, 多余时间显示 "约剩 5 秒" 兜底。
    var eta = _startSingleFrameEta({
      initialSec: 70,
      onTick: function (remain) {
        var loadingText = "生成首帧中…约剩 " + _fmtMinSec(remain);
        try { updateStoryboardCard(gIdx, "loading", null, loadingText); } catch (_e) {}
        if (typeof opts.onLoadingText === 'function') {
          try { opts.onLoadingText(loadingText); } catch (_loadingTextErr) {}
        }
      },
    });
    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() { if (!settled) { settled = true; _stopPoll(); eta.stop(); resolve(); } }
    var finishingFromServer = null;

	    function _finishAfterServerSync() {
	      if (finishingFromServer) return finishingFromServer;
	      finishingFromServer = (async function () {
	        await _reloadProjectFromServerForStoryboard(originId);
	        await _sbRefreshFirstFrameCardPromptBaselinesFromServer([{ groupIdx: gIdx }], {
	          preserveTextarea: true,
	          clearDraftCommitRefreshPending: true,
	        });
	        var latest = project && project.storyboards && project.storyboards[gIdx];
        var latestUrl = _firstFrameImageUrl(latest);
        if (latestUrl) {
          _gotResult = true;
          updateStoryboardCard(gIdx, "done", latestUrl);
        } else if (!_gotResult) {
          updateStoryboardCard(gIdx, "error", null, "生成完成但未拿到图片，请重试");
        }
        finish();
      })();
      return finishingFromServer;
    }

    function _applyResult(rawUrl, extra, serverVersion) {
      if (!rawUrl || _gotResult) return;
      _gotResult = true;
      var isTail = _isTailPatchExtra(extra);
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _archiveOldImage(existing, "storyboard");
        _applyFrameImagePatch(existing, rawUrl, extra, group.shotIndices);
        proj.storyboards[gIdx] = existing;
        if (proj._staleFlags) delete proj._staleFlags["storyboard_" + gIdx];
      }, serverVersion);
      if (isCurrent) {
        if (isTail) {
          renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: rawUrl });
        } else {
          updateStoryboardCard(gIdx, "done", rawUrl);
        }
      }
    }

    // 5 秒兜底轮询：SSE 偶尔丢事件，靠它从 /api/batch/<id> 拿权威结果
    async function _pollOnce() {
      if (settled) return;
      try {
        var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
        if (!snap || settled) return;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti];
          if (t.status === 'completed' && !_gotResult) {
            var result = t.result || {};
            var extra = result.extra || {};
            var patch = result.patch || {};
            var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
            _applyResult(url, extra, result.serverVersion);
          } else if (t.status === 'failed' && !_gotResult) {
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            var extraPoll = (t.result && t.result.extra) || t.extra || {};
            var displayMsgPoll = _firstFrameFailureDisplay(errMsgPoll, extraPoll);
            if (project && project.id === originId) {
              _clearFailedStoryboardLocally(gIdx, displayMsgPoll, extraPoll, originId);
              if (_isImageSafetyBlocked(_imageSafetyAuditFromExtra(extraPoll), displayMsgPoll)) renderImageGrid();
              else updateStoryboardCard(gIdx, "error", null, displayMsgPoll.slice(0, 120));
            }
            showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(displayMsgPoll), "error");
            _gotResult = true;
          }
        }
        if (snap.status === 'completed' || snap.status === 'failed' ||
            snap.status === 'cancelled' || snap.status === 'partial') {
          await _finishAfterServerSync();
        }
      } catch (e) {
        console.warn('[StoryboardImg-single] poll failed:', (e && e.message) || e);
      }
    }
    pollTimer = setInterval(_pollOnce, 5000);

    subscribeBatch(startResp.batchId, {
      onTaskCompleted: function (data) {
        var extra = (data && data.extra) || {};
        var patch = (data && data.patch) || {};
        var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || (data && data.resultUrl) || "";
        _applyResult(rawUrl, extra, data && data.serverVersion);
      },
      onTaskFailed: function (data) {
        var errMsgInner = ((data && data.errorMsg) || "生成失败").toString().slice(0, 120);
        var extraInner = (data && data.extra) || {};
        var displayMsgInner = _firstFrameFailureDisplay(errMsgInner, extraInner);
        if (project && project.id === originId) {
          _clearFailedStoryboardLocally(gIdx, displayMsgInner, extraInner, originId);
          if (_isImageSafetyBlocked(_imageSafetyAuditFromExtra(extraInner), displayMsgInner)) renderImageGrid();
          else updateStoryboardCard(gIdx, "error", null, displayMsgInner.slice(0, 120));
        }
        showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(displayMsgInner), "error");
        _gotResult = true;
      },
      onBatchCompleted: function () {
        _finishAfterServerSync();
      },
      onClose: function () {
        // SSE 断了不立即 finish，让 polling 跑到 batch 真完成
      },
    });
  });
}

async function _autoConvertGroupPrompts(group) {
  if (!project) return;
  var needConvert = group.shots.filter(function (s) {
    return !s.imagePromptGenerated || !s.imagePrompt;
  });
  if (!needConvert.length) return;

  for (var i = 0; i < group.shotIndices.length; i++) {
    var sIdx = group.shotIndices[i];
    var shot = project.shots[sIdx];
    if (shot && (!shot.imagePromptGenerated || !shot.imagePrompt)) {
      await convertSinglePrompt(sIdx);
    }
  }
}

/**
 * 单帧生成 ETA 倒计时 helper (P2.5b.T3)。
 * opts.initialSec=70 (默认), minSec=5 (显示下限, 避免显示 0/负数),
 * intervalMs=1000, onTick(remainSec) 每秒回调。
 * 返回 { stop } 用于在 finish/error 时停止。
 */
function _startSingleFrameEta(opts) {
  opts = opts || {};
  var initialSec = Math.max(5, opts.initialSec || 70);
  var minSec = Math.max(1, opts.minSec || 5);
  var intervalMs = opts.intervalMs || 1000;
  var onTick = opts.onTick || function () {};
  var start = Date.now();
  var timer = null;
  function tick() {
    var elapsed = Math.floor((Date.now() - start) / 1000);
    var remain = Math.max(minSec, initialSec - elapsed);
    try { onTick(remain); } catch (_) {}
  }
  tick();
  timer = setInterval(tick, intervalMs);
  return {
    stop: function () { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/**
 * 弹出 file picker 上传首帧/尾帧图。不走 upload-char-image, 避免 mutate
 * character lock; 调 /api/frames/upload 独立接口, 成功后用返回的 url 更新 storyboard
 * state, 并调 renderStoryboardFrameCard 只刷新对应 frame 位。
 */
function _pickAndUploadFrame(gIdx, kind) {
  if (!project) return;
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) return;
    _uploadFrameImage(gIdx, file, kind);
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(function () { try { input.remove(); } catch (_) {} }, 5000);
}

function _pickAndUploadFirstFrame(gIdx) { _pickAndUploadFrame(gIdx, 'first'); }
function _pickAndUploadTailFrame(gIdx) { _pickAndUploadFrame(gIdx, 'tail'); }

async function _uploadFrameImage(gIdx, file, kind) {
  if (!project) return;
  var isTail = kind === 'tail';
  var frameType = isTail ? 'tail_frame' : 'first_frame';
  var frameLabel = isTail ? '尾帧' : '首帧';
  var originId = project.id;
  renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'loading', { loadingText: '上传中…' });

  var formData = new FormData();
  formData.append('file', file);
  formData.append('projectId', String(originId || ''));
  formData.append('groupIdx', String(gIdx));
  formData.append('frameType', frameType);

  try {
    var authToken = '';
    try { authToken = localStorage.getItem('sw_auth_token') || ''; } catch (_) {}
    var resp = await fetch('/api/frames/upload', {
      method: 'POST',
      headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {},
      body: formData,
    });
    var data = await resp.json();
    if (!resp.ok || data.error) {
      var errMsg = (data && data.error) || '上传失败';
      renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'error', { errMsg: errMsg });
      if (isTail) _clearFailedTailFrameLocally(gIdx, errMsg, null, originId);
      showToast(frameLabel + ' #' + (gIdx + 1) + ' 上传失败: ' + errMsg, 'error');
      return;
    }
    var url = data.url || '';
    var displayUrl = data.signedUrl || url;
    if (!url) {
      renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'error', { errMsg: '服务器未返回图片 URL' });
      return;
    }
    var extra = isTail
      ? {
        groupIdx: gIdx,
        tailFrameUrl: url,
        tailFrameMode: 'uploaded',
        tailFrameIntent: data.tailFrameIntent || 'requested',
        tailFrameIntentUpdatedAt: data.tailFrameIntentUpdatedAt || new Date().toISOString(),
        tailFrameSourceHash: Object.prototype.hasOwnProperty.call(data, 'tailFrameSourceHash')
          ? data.tailFrameSourceHash
          : null,
        tailFrameReferenceStatus: data.tailFrameReferenceStatus || 'ready',
        frames: {
          tail: {
            url: url,
            status: 'ready',
            source: 'uploaded',
            mode: 'uploaded',
            generatedAt: new Date().toISOString(),
            sourceHash: Object.prototype.hasOwnProperty.call(data, 'tailFrameSourceHash')
              ? data.tailFrameSourceHash
              : null,
            referenceStatus: data.tailFrameReferenceStatus || 'ready',
          },
        },
      }
      : {
        groupIdx: gIdx,
        firstFrameUrl: url,
        firstFrameMode: 'uploaded',
        firstFrameSource: 'uploaded',
        firstFrameSourceHash: Object.prototype.hasOwnProperty.call(data, 'firstFrameSourceHash')
          ? data.firstFrameSourceHash
          : null,
        frames: {
          first: {
          url: url,
          status: 'ready',
          source: 'uploaded',
          mode: 'uploaded',
          generatedAt: new Date().toISOString(),
          sourceHash: Object.prototype.hasOwnProperty.call(data, 'firstFrameSourceHash')
            ? data.firstFrameSourceHash
            : null,
          },
        },
      };
    _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      var existing = proj.storyboards[gIdx] || {};
      _applyFrameImagePatch(existing, url, extra, null);
      proj.storyboards[gIdx] = existing;
    }, data && data.serverVersion);
    renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'done', { imgUrl: displayUrl });
    saveProject();
    showToast(frameLabel + ' #' + (gIdx + 1) + ' 上传成功', 'success');
  } catch (e) {
    var msg = ((e && e.message) || e).toString().slice(0, 200);
    renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'error', { errMsg: msg });
    if (isTail) _clearFailedTailFrameLocally(gIdx, msg, null, originId);
    showToast(frameLabel + ' #' + (gIdx + 1) + ' 上传失败: ' + msg, 'error');
  }
}

/**
 * 启动尾帧生成 (P2.5a.T4)。和 generateStoryboardSheet 结构对称, 但:
 *   - batchType='tail_frame_images'
 *   - UI 只更新尾帧格 (renderStoryboardFrameCard), 不触碰主分镜/首帧 img
 *   - 失败走 _clearFailedTailFrameLocally 和 tail 的 error 渲染
 *   - 不做 ETA 动画 (尾帧 UX 简化)
 * 后端 executor 已在 P2/P2.5a.T0 做 preflight, 这里前端再挡一次。
 */
export async function generateStoryboardTailFrame(gIdx) {
  if (!project) return;
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  var sb = project.storyboards[gIdx] || {};
  await _ensureMaterialPanelsForChecks(groups, [gIdx]);
  var materialBlockMessage = _materialLimitBlockMessage(groups, [gIdx]);
  if (materialBlockMessage) {
    showToast(materialBlockMessage, 'warn');
    renderImageGrid();
    return;
  }

  var tailIntent = _tailFrameGenerationIntentForGroup(group, sb);
  if (!tailIntent.canGenerate) {
    sb.tailFrameIntent = "requested";
    sb.tailFrameIntentUpdatedAt = new Date().toISOString();
    sb.tailFrameReferenceStatus = _tailFrameImageUrl(sb) ? "ready" : "missing";
    project.storyboards[gIdx] = sb;
    saveProject();
    renderImageGrid();
    checkImagesConfirm();
    showToast(tailIntent.requiresFirstFrame ? "已标记这段需要尾帧，请先生成彩色首帧" : "已标记这段需要尾帧", "info");
    return;
  }
  var tailFlushResult = await _sbRunTailFrameCardPromptSave(gIdx, { source: 'regen-tail-flush' });
  if (tailFlushResult && tailFlushResult.ok === false) {
    if (tailFlushResult.readOnly) {
      var tailState = _sbTailFrameCardPromptState(gIdx);
      showToast((tailState.preflight && tailState.preflight.message) || '尾帧提示词未就绪，请稍后重试。', 'warn');
    }
    renderImageGrid();
    checkImagesConfirm();
    return;
  }
  sb = project.storyboards[gIdx] || sb;
  sb.tailFrameIntent = "requested";
  sb.tailFrameIntentUpdatedAt = sb.tailFrameIntentUpdatedAt || new Date().toISOString();
  project.storyboards[gIdx] = sb;
  saveProject();
  var originId = project.id;
  renderStoryboardFrameCard(gIdx, 'tail', 'loading', { loadingText: "生成尾帧中…" });

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'tail_frame_images',
      projectId: originId,
      targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
      applyEditDraft: true,
    });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (project && project.id === originId) {
        renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: '积分不足' });
        _clearFailedTailFrameLocally(gIdx, '积分不足', null, originId);
      }
      showBillingPaywall(e.billing || null);
      return;
    }
    if (project && project.id === originId) {
      renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errMsg });
      _clearFailedTailFrameLocally(gIdx, errMsg, null, originId);
    }
    showToast("尾帧 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsg), "error");
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || "未能创建批量任务";
    renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: fErr });
    _clearFailedTailFrameLocally(gIdx, fErr, null, originId);
    return;
  }
  _markStoryboardBatchLocallyAttached(originId, startResp.batchId);

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var _gotResult = false;
    // 尾帧 ETA: initial=60s (尾帧不做多 ref 预处理, 通常比首帧快一点)
    var eta = _startSingleFrameEta({
      initialSec: 60,
      onTick: function (remain) {
        try {
          renderStoryboardFrameCard(gIdx, 'tail', 'loading', { loadingText: '生成尾帧中…约剩 ' + _fmtMinSec(remain) });
        } catch (_e) {}
      },
    });
    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() { if (!settled) { settled = true; _stopPoll(); eta.stop(); resolve(); } }
    var finishingFromServer = null;
    function _finishAfterServerSync() {
      if (finishingFromServer) return finishingFromServer;
      finishingFromServer = (async function () {
        try {
          await _reloadProjectFromServerForStoryboard(originId);
          if (project && project.id === originId) renderImageGrid();
        } catch (e) {
          console.warn('[TailFrame] reload after single completion failed:', (e && e.message) || e);
        } finally {
          finish();
        }
      })();
      return finishingFromServer;
    }

    function _applyResult(rawUrl, extra, serverVersion) {
      if (!rawUrl || _gotResult) return;
      _gotResult = true;
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _applyFrameImagePatch(existing, rawUrl, extra, group.shotIndices);
        proj.storyboards[gIdx] = existing;
      }, serverVersion);
      if (isCurrent) {
        renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: rawUrl });
      }
    }

    async function _pollOnce() {
      if (settled) return;
      try {
        var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
        if (!snap || settled) return;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        for (var ti = 0; ti < tasks.length; ti++) {
          var t = tasks[ti];
          if (t.status === 'completed' && !_gotResult) {
            var result = t.result || {};
            var extra = result.extra || {};
            var patch = result.patch || {};
            var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
            _applyResult(url, extra, result.serverVersion);
          } else if (t.status === 'failed' && !_gotResult) {
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            var extraPoll = _snapshotTaskExtra(t);
            if (project && project.id === originId) {
              var synced = await _reloadProjectFromServerForStoryboard(originId);
              var extraRecordPoll = _tailFrameErrorRecordFromExtra(extraPoll, errMsgPoll);
              if (!synced || extraRecordPoll.imageSafetyAudit) _clearFailedTailFrameLocally(gIdx, errMsgPoll, extraPoll, originId);
              var latestSb = project && project.storyboards && project.storyboards[gIdx];
              var errRecordPoll = _tailFrameErrorRecordFromStoryboard(latestSb, errMsgPoll);
              var errDisplayPoll = _tailFrameErrorDisplay(errRecordPoll, errMsgPoll);
              if (_tailFrameSafetyInfo(latestSb) || _isImageSafetyBlocked(extraRecordPoll.imageSafetyAudit || errRecordPoll.imageSafetyAudit, errMsgPoll)) {
                renderImageGrid();
              } else {
                renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplayPoll });
              }
            }
            showToast("尾帧 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsgPoll), "error");
            _gotResult = true;
          }
        }
        if (snap.status === 'completed' || snap.status === 'failed' ||
            snap.status === 'cancelled' || snap.status === 'partial') {
          await _finishAfterServerSync();
        }
      } catch (e) {
        console.warn('[TailFrame-single] poll failed:', (e && e.message) || e);
      }
    }
    pollTimer = setInterval(_pollOnce, 5000);

    subscribeBatch(startResp.batchId, {
      onTaskCompleted: function (data) {
        var extra = (data && data.extra) || {};
        var patch = (data && data.patch) || {};
        var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || (data && data.resultUrl) || "";
        _applyResult(rawUrl, extra, data && data.serverVersion);
      },
      onTaskFailed: function (data) {
        var extra = (data && data.extra) || {};
        var errMsgInner = ((data && data.errorMsg) || "生成失败").toString().slice(0, 120);
        var errRecordInner = _tailFrameErrorRecordFromExtra(extra, errMsgInner);
        var errDisplayInner = _tailFrameErrorDisplay(errRecordInner, errMsgInner);
        if (project && project.id === originId) {
          _clearFailedTailFrameLocally(gIdx, errMsgInner, extra, originId);
          if (_isImageSafetyBlocked(errRecordInner.imageSafetyAudit, errRecordInner.message || errDisplayInner)) renderImageGrid();
          else renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplayInner });
        }
        showToast("尾帧 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errDisplayInner), "error");
        _gotResult = true;
      },
      onBatchCompleted: function () {
        _finishAfterServerSync();
      },
      onClose: function () { /* 等 polling 兜底 */ },
    });
  });
}

/**
 * 批量生成所有可生成的尾帧 (P2.5b.T2)。
 * 筛选: 最终推荐/用户请求 且 当前依赖条件可生成 且 (无尾帧 or 尾帧 failed) 的组。
 * 不做脏数据清理, 不动主分镜/首帧; 用一个 batchType='tail_frame_images' 批提交全部,
 * 复用尾帧单生成的 SSE/polling pattern。
 */
export async function generateAllTailFrames(opts) {
  opts = opts || {};
  if (!project) return;
  if (!project.storyboards) project.storyboards = [];
  var originId = project.id;
  var groups = getStoryboardGroups();

  var targets = Array.isArray(opts.targets) ? opts.targets.slice() : [];
  var skipNoFirst = 0;
  var skipMerged = 0;
  var skipLowScore = 0;
  if (!targets.length) {
    for (var i = 0; i < groups.length; i++) {
      var sb = project.storyboards[i] || {};
      // P3：一键(自动)只跟随"solo 且分值达标"。合并段恒无尾锚点 → 跳过;
      // 低分 solo 不自动跟随(用户仍可在尾帧卡手动生成,手动不拦)。
      var _idxs = (groups[i] && groups[i].shotIndices) || [];
      if (_idxs.length > 1) { skipMerged++; continue; }
      var tailIntent = _tailFrameGenerationIntentForGroup(groups[i], sb);
      if (!tailIntent.wanted) { skipLowScore++; continue; }
      if (!tailIntent.canGenerate) { skipNoFirst++; continue; }
      var tailUrl = (sb.frames && sb.frames.tail && sb.frames.tail.url) || sb.tailFrameUrl;
      var tailStatus = (sb.frames && sb.frames.tail && sb.frames.tail.status) || '';
      var shouldGen = !tailUrl || tailStatus === 'failed';
      if (shouldGen) {
        targets.push({ groupIdx: i, idx: i, shotIndices: groups[i].shotIndices || [] });
      }
    }
  }
  if (!targets.length) {
    var _skipParts = [];
    if (skipNoFirst > 0) _skipParts.push(skipNoFirst + ' 个缺彩色片段首帧');
    if (skipMerged > 0) _skipParts.push(skipMerged + ' 个合并片段(不建议尾帧)');
    if (skipLowScore > 0) _skipParts.push(skipLowScore + ' 个低分 solo 片段(可在尾帧卡手动生成)');
    var hintMsg = _skipParts.length
      ? '没有需要自动生成尾帧的片段:' + _skipParts.join('、')
      : '全部片段已有尾帧, 无需重新生成';
    showToast(hintMsg, 'info');
    return;
  }
  _setTailFramesGenerating(true);
  try {
    await _ensureMaterialPanelsForChecks(groups, targets.map(function (t) { return t.groupIdx; }));
    var materialBlockMessage = _materialLimitBlockMessage(groups, targets.map(function (t) { return t.groupIdx; }));
    if (materialBlockMessage) {
      showToast(materialBlockMessage, 'warn');
      renderImageGrid();
      _setTailFramesGenerating(false);
      return;
    }
    var tailFlushResult = await _sbFlushTailFrameCardPromptsForTargets(targets, 'tail-frame-batch-flush');
    if (tailFlushResult && tailFlushResult.ok === false) {
      if (tailFlushResult.readOnly) {
        showToast('部分尾帧暂不可编辑或生成，请先完成对应彩色视频首帧。', 'warn');
      }
      renderImageGrid();
      checkImagesConfirm();
      _setTailFramesGenerating(false);
      return;
    }
  } catch (e) {
    _setTailFramesGenerating(false);
    throw e;
  }

  var btn = opts.buttonId ? $(opts.buttonId) : null;
  if (btn) btn.disabled = true;
  targets.forEach(function (t) {
    renderStoryboardFrameCard(t.groupIdx, 'tail', 'loading', { loadingText: '生成尾帧中…' });
  });

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'tail_frame_images',
      projectId: originId,
      targets: targets,
      applyEditDraft: true,
    });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      showBillingPaywall(e.billing || null);
    } else {
      showToast('批量尾帧启动失败: ' + _diagnoseApiError(errMsg), 'error');
    }
    targets.forEach(function (t) {
      renderStoryboardFrameCard(t.groupIdx, 'tail', 'error', { errMsg: errMsg });
      _clearFailedTailFrameLocally(t.groupIdx, errMsg, null, originId);
    });
    if (btn) btn.disabled = false;
    _setTailFramesGenerating(false);
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || '未能创建批量任务';
    showToast(fErr, 'error');
    targets.forEach(function (t) {
      renderStoryboardFrameCard(t.groupIdx, 'tail', 'error', { errMsg: fErr });
      _clearFailedTailFrameLocally(t.groupIdx, fErr, null, originId);
    });
    if (btn) btn.disabled = false;
    _setTailFramesGenerating(false);
    return;
  }
  _markStoryboardBatchLocallyAttached(originId, startResp.batchId);
  var externalProgressState = opts.progressState && typeof opts.progressState === 'object'
    ? opts.progressState
    : null;
  if (externalProgressState) {
    var minimumTotal = Number(externalProgressState.done || 0) +
      Number(externalProgressState.fail || 0) +
      targets.length;
    externalProgressState.total = Math.max(Number(externalProgressState.total || 0), minimumTotal);
    if (!externalProgressState.startTs) externalProgressState.startTs = Date.now();
  }

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var completedIdx = Object.create(null);
    var totalCount = targets.length;
    var doneCount = 0;
    var failCount = 0;
    var finishingFromServer = null;
    var tailProgress = externalProgressState || {
      done: 0,
      fail: 0,
      total: totalCount,
      startTs: Date.now(),
    };
    var tailEtaTick = setInterval(_renderTailEta, 1000);

    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function _stopTailEta() { if (tailEtaTick) { clearInterval(tailEtaTick); tailEtaTick = null; } }
    function _renderTailEta() {
      _showKeyframeHeaderProgress(tailProgress.done, tailProgress.total, tailProgress.fail, tailProgress.startTs);
    }
    _renderTailEta();

    function finish() {
      if (settled) return;
      settled = true;
      _stopPoll();
      _stopTailEta();
      _hideKeyframeHeaderProgress();
      if (btn) btn.disabled = false;
      _setTailFramesGenerating(false);
      if (failCount === 0) {
        showToast('批量尾帧生成完成 (' + doneCount + ' 张)', 'success');
      } else if (failCount === totalCount) {
        showToast('批量尾帧全部失败', 'error');
      } else {
        showToast('批量尾帧: 成功 ' + doneCount + ', 失败 ' + failCount, 'warn');
      }
      checkImagesConfirm();
      resolve();
    }
    function _finishAfterServerSync() {
      if (finishingFromServer) return finishingFromServer;
      finishingFromServer = (async function () {
        try {
          await _reloadProjectFromServerForStoryboard(originId);
          if (project && project.id === originId) renderImageGrid();
        } catch (e) {
          console.warn('[TailFrame] reload after batch completion failed:', (e && e.message) || e);
        } finally {
          finish();
        }
      })();
      return finishingFromServer;
    }

    function _applyOne(extra, rawUrl) {
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      if (typeof gIdx !== 'number' || completedIdx[gIdx]) return;
      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _applyFrameImagePatch(existing, rawUrl, extra, null);
        proj.storyboards[gIdx] = existing;
        if (proj._staleFlags) delete proj._staleFlags["tail_frame_" + gIdx];
      });
      renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: rawUrl });
      completedIdx[gIdx] = 'done';
      doneCount++;
      tailProgress.done = Number(tailProgress.done || 0) + 1;
      _renderTailEta();
    }
    function _failOne(extra, errMsg) {
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      if (typeof gIdx !== 'number' || completedIdx[gIdx]) return;
      var errRecord = _tailFrameErrorRecordFromExtra(extra, errMsg);
      var errDisplay = _tailFrameErrorDisplay(errRecord, errMsg);
      _clearFailedTailFrameLocally(gIdx, errMsg, extra, originId);
      if (_isImageSafetyBlocked(errRecord.imageSafetyAudit, errRecord.message || errDisplay)) renderImageGrid();
      else renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplay });
      completedIdx[gIdx] = 'failed';
      failCount++;
      tailProgress.fail = Number(tailProgress.fail || 0) + 1;
      _renderTailEta();
    }
    function _applyTailBatchSnapshotTask(t) {
      var status = String((t && t.status) || '').toLowerCase();
      if (status === 'completed' || status === 'succeeded' || status === 'done') {
        var result = t.result || {};
        var extra = result.extra || {};
        var patch = result.patch || {};
        var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
        if (url) _applyOne(extra, url);
      } else if (status === 'failed' || status === 'timeout') {
        var target = t.target || {};
        var extraF = _snapshotTaskExtra(t);
        if (typeof extraF.groupIdx !== 'number') extraF.groupIdx = target.groupIdx;
        var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
        _failOne(extraF, errMsgPoll);
      }
    }

    async function _pollOnce() {
      if (settled) return;
      try {
        var snap = await apiGet('/api/batch/' + encodeURIComponent(startResp.batchId));
        if (!snap || settled) return;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        tasks.forEach(_applyTailBatchSnapshotTask);
        if (snap.status === 'completed' || snap.status === 'failed' ||
            snap.status === 'cancelled' || snap.status === 'partial') {
          await _finishAfterServerSync();
        }
      } catch (e) {
        console.warn('[TailFrame-all] poll failed:', (e && e.message) || e);
      }
    }
    pollTimer = setInterval(_pollOnce, 5000);

    subscribeBatch(startResp.batchId, {
      onSnapshot: function (snap) {
        if (!snap || typeof snap.total !== 'number') return;
        totalCount = snap.total;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        tasks.forEach(_applyTailBatchSnapshotTask);
        _renderTailEta();
      },
      onTaskCompleted: function (data) {
        var extra = (data && data.extra) || {};
        var patch = (data && data.patch) || {};
        var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || (data && data.resultUrl) || '';
        if (rawUrl) _applyOne(extra, rawUrl);
      },
      onTaskFailed: function (data) {
        var extra = (data && data.extra) || {};
        var target = (data && data.target) || {};
        if (typeof extra.groupIdx !== 'number' && typeof target.groupIdx === 'number') {
          extra.groupIdx = target.groupIdx;
        }
        var errMsgInner = ((data && data.errorMsg) || '生成失败').toString().slice(0, 120);
        _failOne(extra, errMsgInner);
      },
      onBatchCompleted: function () {
        _finishAfterServerSync();
      },
      onClose: function () { /* polling 兜底 */ },
    });
  });
}

export async function generateAllImages() {
  if (_imagesGenerating || _imagesStarting || _tailFramesGenerating) return;
  if (!project || !project.shots || !project.shots.length) return;
  var groups = getStoryboardGroups();
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  await _ensureMaterialPanelsForChecks(groups);
  var materialBlockMessage = _materialLimitBlockMessage(groups);
  if (materialBlockMessage) {
    showToast(materialBlockMessage, 'warn');
    _updateImagesActionButton(groups);
    return;
  }
  _imagesStarting = true;
  if (hint) hint.textContent = "正在准备关键帧生成…";
  _updateImagesActionButton(groups);
  var accepted = await _acceptShotPlanForStoryboard();
  if (!accepted) {
    _imagesStarting = false;
    _updateImagesActionButton(groups);
    return;
  }

  // 保存镜头编辑后重新取最新 project，避免进入批处理前拿到旧分组状态。
  _syncRefs();
  groups = getStoryboardGroups();
  await _ensureMaterialPanelsForChecks(groups);
  materialBlockMessage = _materialLimitBlockMessage(groups);
  if (materialBlockMessage) {
    showToast(materialBlockMessage, 'warn');
    if (hint) hint.textContent = materialBlockMessage;
    _imagesStarting = false;
    _updateImagesActionButton(groups);
    renderImageGrid();
    return;
  }
  // 此前这里 await _ensureFirstFramePreflightAllowed 做了一次专门的 preflight 请求；
  // 它与下面 /api/batch/start 后端做的 sentinelPreflightForBatch 检查完全重复，
  // 且因为 preflight key 含 updatedAt（已在 Step 3B 修掉），saveProject 后必然
  // 缓存失效导致再多一次往返。这里移除前置 await，让 batch/start 直接执行；
  // 若服务器侧检查未通过会返回 409 + code: 'artifact_usage_blocked'，下面的 catch
  // 分支会以原 message 弹 toast 并回滚按钮状态。
  // 注：_ensureFirstFramePreflightAllowed 函数本身保留，单图重生成路径仍在使用；
  // _updateImagesActionButton 内的后台 preflight 也保留，用于按钮的常态显隐。
  _imagesGenerating = true;
  _imagesStarting = false;
  if (btn) btn.disabled = true;
  if (!project.storyboards) project.storyboards = [];

  var originId = project.id;

  // Step 1：多参首帧模式直接由后端基于 visual + 资产上下文组装首帧 prompt。
  // 这里不再预生成旧的黑白铅笔 storyboard prompt，避免浪费 token，也避免
  // 后续视频兜底时被黑白/手绘语义污染。
  // 注: 不再 blanket 给所有 group 打 "准备首帧…" loading 浮窗——那会让"补全 1 张" /
  // "重试失败" 这类只重生一部分的场景, 所有 card 都莫名挂上 loading。
  // 真正会重生的 group 在下面 targets 算出来后再打 loading 状态。
  if (hint) hint.textContent = "准备生成视频关键帧…";

  // Step 2：过滤仍缺图的组
  // 同时**裁剪 storyboards 数组**到当前分组数：之前用旧分组算法生成的
  // 多余 panel（比如旧算法 cap=3 出 7 组，新算法 cap=4 只出 5 组）会残留
  // 在尾部，并且前几个 slot 里的 shotIndices 和当前分组对不上时，UI 取
  // storyboards[i] 拿到的就是错位的旧图——表现为"前 N 张图布局对不上"。
  // 这里在开新 batch 前先做一次清理：
  //   1. 截短到当前分组数
  //   2. 任何 slot 里 shotIndices 和当前分组的 shotIndices 不一致 → 视为脏图丢掉
  if (!Array.isArray(project.storyboards)) project.storyboards = [];
  if (project.storyboards.length > groups.length) {
    project.storyboards.length = groups.length;
  }
  var dirtyCleared = 0;
  for (var ck = 0; ck < groups.length; ck++) {
    var existing = project.storyboards[ck];
    if (!existing) continue;
    var savedSi = Array.isArray(existing.shotIndices) ? existing.shotIndices : null;
    var newSi = groups[ck].shotIndices || [];
    var match = savedSi && savedSi.length === newSi.length
      && savedSi.every(function (v, j) { return v === newSi[j]; });
    if (!match) {
      // 旧图配的 shotIndices 和新分组对不上 → 视为脏数据，清掉留待重生成
      project.storyboards[ck] = {};
      dirtyCleared++;
    }
  }
  if (dirtyCleared > 0) {
    console.log('[generateAllImages] cleared ' + dirtyCleared + ' stale storyboard slot(s) due to grouping change');
    saveProject();
    // 重渲一次让脏 slot 立即变回"待生成"占位
    try { renderImageGrid(); } catch (_) {}
  }

  var buttonState = _computeImagesBatchState(groups, { ignoreGenerating: true });
  var targets = [];
  var tailKeyframeMode = 'pending';
  if (buttonState.action === 'retry_failed') {
    targets = buttonState.failedFirst.map(function (gIdx) {
      return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
    });
    tailKeyframeMode = 'failed';
  } else if (buttonState.action === 'fill_missing') {
    targets = buttonState.missingFirst.map(function (gIdx) {
      return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
    });
  } else {
    // regenerate_all（含此前独立的 stale-only 场景）：全量重生所有 group 首帧，
    // 随后同步重生已请求/已生成/被建议的尾帧关键帧。
    targets = groups.map(function (g, idx) {
      return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [] };
    });
    tailKeyframeMode = buttonState.action === 'regenerate_all' ? 'all' : 'pending';
  }
  var runTailKeyframesAfterFirst = buttonState.pendingTailKeyframes.length > 0 ||
    buttonState.failedTail.length > 0 ||
    buttonState.action === 'regenerate_all';
  var plannedTailKeyframeCount = runTailKeyframesAfterFirst
    ? _plannedTailKeyframeCountForProgress(groups, buttonState, tailKeyframeMode)
    : 0;
  if (!targets.length) {
    var tailOnlyTargets = _tailKeyframeTargets(groups, {
      failedOnly: tailKeyframeMode === 'failed',
      includeReady: tailKeyframeMode === 'all',
    });
    _imagesGenerating = false;
    _imagesStarting = false;
    if (btn) btn.disabled = false;
    if (tailOnlyTargets.length) {
      if (hint) hint.textContent = "正在生成 " + tailOnlyTargets.length + " 张尾帧关键帧…";
      await generateAllTailFrames({ targets: tailOnlyTargets, buttonId: 'btnGenAllImages' });
    } else {
      _updateImagesActionButton(groups);
    }
    checkImagesConfirm();
    return;
  }
  var totalCount = targets.length;
  if (hint) hint.textContent = "正在生成 " + totalCount + " 张关键帧…";
  targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "loading", null, "生成关键帧中…"); });

  var doneCount = 0;
  var failCount = 0;
  var finished = false;
  var keyframeProgressState = {
    done: 0,
    fail: 0,
    total: totalCount + plannedTailKeyframeCount,
    startTs: Date.now(),
  };
  // 标题下方进度行：等真实跑完 1 张以后用实测速度，否则用保守初始猜测；
  // 并发估算来自当前前端图片并发常量，避免标题 ETA 和调度上限明显偏离。
  var diagBox = $("sbDiagnostic");
  function _renderEta() {
    _showKeyframeHeaderProgress(
      keyframeProgressState.done,
      keyframeProgressState.total,
      keyframeProgressState.fail,
      keyframeProgressState.startTs,
    );
  }
  function _clearEta() {
    _hideKeyframeHeaderProgress();
    if (diagBox) diagBox.innerHTML = '';
  }
  _renderEta();
  // 兜底：定期 tick 让"约剩 N 秒"自然减少（即便 SSE / poll 没新事件）
  var etaTick = setInterval(_renderEta, 1000);
  function _stopEtaTick() { if (etaTick) { clearInterval(etaTick); etaTick = null; } }

  // seq -> groupIdx 反查，task_failed 缺 extra 时用
  var seqToGroupIdx = {};
  targets.forEach(function (t, seq) { seqToGroupIdx[seq] = t.groupIdx; });

  // Step 3：走后端 batch，无 fallback。/api/batch/start 失败直接报错，
  // 用户可重试或点单张重新生成；硬回滚靠 git revert。
  var startResp;
  try {
    // 批量入口 ("重新生成全部关键帧" / "补全 N 张") 也带 applyEditDraft: true,
    // 让用户在画面描述里的草稿在批量重生时被采用, 而不仅仅是首帧编辑器弹窗。
    // 后端有 `&& draft` 守卫, 没编辑过的 group 不受影响。
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: targets,
      applyEditDraft: true,
    });
    if (startResp && startResp.batchId) _markStoryboardBatchLocallyAttached(originId, startResp.batchId);
    _sbMarkFirstFrameCardPromptDraftCommitPendingForTargets(targets);
  } catch (e) {
    console.error('[generateAllImages] /api/batch/start failed:', e);
    _stopEtaTick();
    _clearEta();
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (hint) hint.textContent = '积分不足';
      showBillingPaywall(e.billing || null);
    } else if (e instanceof ApiError && e.status === 409 && e.payload && e.payload.code === 'artifact_usage_blocked') {
      // 服务端 sentinel preflight 拒绝（取代了前端原本的 _ensureFirstFramePreflightAllowed）。
      // e.message 已经是 sentinelMessage 返回的人类可读说明。
      var blockedMsg = (e.message || '').toString() || '镜头计划暂不可用于首帧生成';
      if (hint) hint.textContent = blockedMsg;
      showToast(blockedMsg, 'warn');
    } else {
      if (hint) hint.textContent = "启动失败：" + ((e && e.message) || e);
      showToast("批量生成启动失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "error", null, "启动失败"); });
    _imagesGenerating = false;
    _imagesStarting = false;
    if (btn) btn.disabled = false;
    _updateImagesActionButton(groups);
    return;
  }

  function finish() {
    if (finished) return;
    finished = true;
    _stopEtaTick();
    if (!runTailKeyframesAfterFirst) {
      _clearEta();
    } else if (diagBox) {
      diagBox.innerHTML = '';
    }
    var done = project.storyboards.filter(function (s) { return s && s.imageUrl; }).length;
    if (hint) hint.textContent = done + "/" + groups.length + " 张关键帧已生成";
    var allSbDone = groups.every(function (_, i) { return project.storyboards[i] && project.storyboards[i].imageUrl; });
    if (failCount > 0) showToast(failCount + " 张关键帧生成失败，请手动重试", "warn");
    if (runTailKeyframesAfterFirst) {
      _maybeAutoStartTailFramesFromCurrentProject(originId, startResp.batchId, {
        failedOnly: tailKeyframeMode === 'failed',
        includeReady: tailKeyframeMode === 'all',
        buttonId: 'btnGenAllImages',
        hintId: 'imagesHint',
        progressState: keyframeProgressState,
      })
        .finally(function () {
          _hideKeyframeHeaderProgress();
          _imagesGenerating = false;
          if (btn) btn.disabled = false;
          var finalGroups = getStoryboardGroups();
          var finalAllFirstDone = finalGroups.every(function (_, i) {
            return project.storyboards[i] && project.storyboards[i].imageUrl;
          });
          var remainingTailTargets = _tailKeyframeTargets(finalGroups);
          if (finalAllFirstDone && finalGroups.length > 0 && !remainingTailTargets.length) {
            showToast("全部关键帧已生成", "success");
          }
          checkImagesConfirm();
          setTimeout(function () { _checkAndSuggest("images"); }, 1000);
        });
      return;
    }
    if (allSbDone && groups.length > 0) showToast("全部关键帧已生成", "success");
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    checkImagesConfirm();
    setTimeout(function () { _checkAndSuggest("images"); }, 1000);
  }

  // 已经在本地标记完成的 groupIdx —— polling/SSE 收到重复事件时去重
  var _seenDone = Object.create(null);
  var _seenFailed = Object.create(null);

  function _applyTaskCompleted(groupIdx, rawUrl, extra, serverVersion) {
    if (typeof groupIdx !== 'number' || !rawUrl) return;
    if (_seenDone[groupIdx]) return;  // 已处理过
    _seenDone[groupIdx] = true;
    doneCount++;
    keyframeProgressState.done++;

    var imageAssetId = (extra && extra.assetId) || '';
    var shotIndices = (extra && Array.isArray(extra.shotIndices)) ? extra.shotIndices : null;
    var isTail = _isTailPatchExtra(extra);

      var isCurrent = _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      var existing = proj.storyboards[groupIdx] || {};
      if (!isTail) _archiveOldImage(existing, "storyboard");
      _applyFrameImagePatch(existing, rawUrl, extra, shotIndices);
      if (imageAssetId && !existing.fetchStatus) existing.fetchStatus = 'done';
      proj.storyboards[groupIdx] = existing;
      if (proj._staleFlags) delete proj._staleFlags["storyboard_" + groupIdx];
      if (isTail && proj._staleFlags) delete proj._staleFlags["tail_frame_" + groupIdx];
    }, serverVersion);
    if (isCurrent) {
      if (isTail) {
        renderStoryboardFrameCard(groupIdx, 'tail', 'done', { imgUrl: rawUrl });
      } else {
        updateStoryboardCard(groupIdx, "done", rawUrl);
      }
    }
    // 尾帧: UI 通过 renderStoryboardFrameCard 单独更新尾帧位, 不触碰首帧/主图 img
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
    _renderEta();
  }

  function _applyTaskFailed(groupIdx, errMsg, extra) {
    if (typeof groupIdx !== 'number') return;
    if (_seenFailed[groupIdx] || _seenDone[groupIdx]) return;
    _seenFailed[groupIdx] = true;
    failCount++;
    keyframeProgressState.fail++;
    var displayMsg = _firstFrameFailureDisplay(errMsg || '生成失败', extra);
    _clearFailedStoryboardLocally(groupIdx, displayMsg, extra, originId);
    var audit = _imageSafetyAuditFromExtra(extra);
    if (_isImageSafetyBlocked(audit, displayMsg)) renderImageGrid();
    else updateStoryboardCard(groupIdx, "error", null, displayMsg.slice(0, 120));
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
    _renderEta();
  }
  function _applyStoryboardBatchSnapshotTask(t) {
    var status = String((t && t.status) || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'done') {
      var result = t.result || {};
      var extra = result.extra || {};
      var patch = result.patch || {};
      var gIdx = (typeof extra.groupIdx === 'number')
        ? extra.groupIdx
        : ((t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq]);
      var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
      _applyTaskCompleted(gIdx, url, extra, result.serverVersion);
    } else if (status === 'failed' || status === 'timeout') {
      var gIdx2 = (t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq];
      _applyTaskFailed(gIdx2, t.errorMsg, _snapshotTaskExtra(t));
    }
  }

  // ============================================================
  // 兜底轮询：每 5 秒主动 GET /api/batch/<id>，拿后端权威 snapshot。
  // SSE 在中转站 / 浏览器后台 / 反向代理下偶尔会丢事件，轮询保证 UI 最终
  // 能追上后端真实状态——哪怕 task_completed 一条都没收到，5 秒内也能恢复。
  // ============================================================
  var pollTimer = null;
  var pollSettled = false;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  var finishingFromServer = null;

	  function _finishAfterServerSync() {
	    if (finished) return Promise.resolve();
	    if (finishingFromServer) return finishingFromServer;
	    finishingFromServer = (async function () {
	      pollSettled = true;
	      _stopPoll();
	      await _reloadProjectFromServerForStoryboard(originId);
	      await _sbRefreshFirstFrameCardPromptBaselinesFromServer(targets, {
	        preserveTextarea: true,
	        clearDraftCommitRefreshPending: true,
	      });
	      renderImageGrid();
	      finish();
	    })();
    return finishingFromServer;
  }

  async function _pollOnce() {
    if (pollSettled) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
      if (!snap || pollSettled) return;
      var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
      tasks.forEach(_applyStoryboardBatchSnapshotTask);
      if (snap.status === 'completed' || snap.status === 'failed' ||
          snap.status === 'cancelled' || snap.status === 'partial') {
        console.log('[StoryboardImg] poll detected batch finished status=' + snap.status);
        await _finishAfterServerSync();
      }
    } catch (e) {
      console.warn('[StoryboardImg] poll failed:', (e && e.message) || e);
    }
  }
  pollTimer = setInterval(_pollOnce, 5000);

  subscribeBatch(startResp.batchId, {
    onSnapshot: function (snap) {
      if (hint && snap && typeof snap.total === 'number') {
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        tasks.forEach(_applyStoryboardBatchSnapshotTask);
        hint.textContent = "生成中… " + Math.min(snap.total, doneCount + failCount) + "/" + snap.total;
        _renderEta();
      }
    },
    onTaskStarted: function (data) {
      var extra = data.target || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      if (typeof groupIdx === 'number' && !_seenDone[groupIdx]) {
        updateStoryboardCard(groupIdx, "loading", null, "生成中…");
      }
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || data.resultUrl || '';
      _applyTaskCompleted(groupIdx, rawUrl, extra, data && data.serverVersion);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      _applyTaskFailed(groupIdx, data.errorMsg, extra);
    },
    onBatchCompleted: function () {
      _finishAfterServerSync();
    },
    onClose: function () {
      // SSE 断开（非正常结束）：保留 polling，让它跑完所有 task
      // polling 自己会在 batch 真完成时调 finish
    },
  });
}

// "确认分镜图"在飞标记：整条确认链是 2~4 个串行网络往返（保存镜头表 flush /
// compute-stale 复核 / preflight / 整包 PUT），期间按钮若不锁、无忙态，用户会
// 以为没点上而连点 → 并发跑出 N 条确认链：PUT 互相 409、toast 连环弹、最后
// 突然跳页。守卫 + 忙态从根上掐掉并发入口。
var _confirmImagesInFlight = false;

function _setConfirmShotsBusy(busy) {
  if (busy) {
    var btn = $("btnConfirmShots");
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML =
      '<span class="shots-step-number">III</span>' +
      '<span>确认中…</span>';
    btn.title = "正在确认分镜图，请稍候";
    return;
  }
  // 恢复走权威渲染，保证 disabled/文案与真实项目状态一致。
  checkImagesConfirm();
}

export async function confirmImages() {
  if (_confirmImagesInFlight) return;
  if (!project || !project.shots) { showToast("请先生成首帧图", "warn"); return; }
  _confirmImagesInFlight = true;
  _setConfirmShotsBusy(true);
  try {
    await _confirmImagesInner();
  } finally {
    _confirmImagesInFlight = false;
    _setConfirmShotsBusy(false);
  }
}

async function _confirmImagesInner() {
  var accepted = await _acceptShotPlanForStoryboard();
  if (!accepted) return;

  _syncRefs();
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var missing = groups.filter(function (_, i) { return !project.storyboards[i] || !_firstFrameUrl(project.storyboards[i]); });
  if (missing.length) {
    showToast("还有 " + missing.length + " 张分镜板未生成", "warn");
    checkImagesConfirm();
    return;
  }
  var staleIdx = [];
  groups.forEach(function (_, i) { if (_isStale("storyboard_" + i)) staleIdx.push(i); });
  if (staleIdx.length) {
    // 本地 stale 标记可能是孤儿残留：历史上标记清除只发生在前端"亲历 task_completed"
    // 的回调里，页面刷新/重连窗口内完成的重生成清不到标记（图和 sourceHash 其实已是新的）。
    // 拦截前先调服务端权威重算，按 mirror 语义对齐 storyboard_* 前缀：
    // 权威认定不 stale 的残留标记被删除并放行；权威仍认定 stale 才拦截。
    try {
      var staleResp = await apiPost("/api/orchestration/compute-stale", { projectId: project.id });
      if (staleResp && staleResp.staleFlags && typeof staleResp.staleFlags === "object") {
        var flagsChanged = _applyServerStaleFlags(["storyboard_"], staleResp.staleFlags);
        if (flagsChanged) saveProject();
        staleIdx = [];
        groups.forEach(function (_, i) { if (_isStale("storyboard_" + i)) staleIdx.push(i); });
      }
    } catch (e) {
      // 权威重算失败时保守处理：维持原有"按本地标记拦截"的行为。
      console.warn("[ImagesConfirm] compute-stale 复核失败，按本地标记拦截:", (e && e.message) || e);
    }
  }
  if (staleIdx.length) {
    var staleLabels = staleIdx.map(function (i) {
      var g = groups[i] || {};
      var sis = (Array.isArray(g.shotIndices) && g.shotIndices.length) ? g.shotIndices : [i];
      return "镜头" + sis.map(function (s) { return s + 1; }).join("-");
    });
    var staleLabelText = staleLabels.slice(0, 3).join("、") + (staleLabels.length > 3 ? " 等" : "");
    showToast("还有 " + staleIdx.length + " 张分镜图已过期（" + staleLabelText + "），请重新生成后再确认", "warn");
    checkImagesConfirm();
    return;
  }
  var preflightPayload;
  try {
    preflightPayload = await apiPost("/api/batch/preflight", {
      batchType: "video_prompts",
      projectId: project.id,
      targets: _firstFramePreflightTargets(groups),
    });
  } catch (e) {
    console.warn("[VideoPromptPreflight] confirm check failed:", e);
    showToast("确认前检查失败，请稍后重试", "warn");
    checkImagesConfirm();
    return;
  }
  if (!preflightPayload || !preflightPayload.allowed) {
    var message = _firstFramePreflightMessage(preflightPayload, "分镜图暂不可进入提示词。");
    var hint = $("imagesHint");
    if (hint) hint.textContent = message;
    showToast(message, "warn");
    checkImagesConfirm();
    return;
  }

  var prevShotsApproved = project.shotsApproved;
  var prevImagesApproved = project.imagesApproved;
  var prevCurrentStep = project.currentStep;
  project.shotsApproved = true;
  project.imagesApproved = true;
  project.currentStep = Math.max(project.currentStep, 5);
  function _rollbackConfirmState() {
    project.shotsApproved = prevShotsApproved;
    project.imagesApproved = prevImagesApproved;
    project.currentStep = prevCurrentStep;
  }
  if (_ctx.flushServerSave) {
    var saved;
    try {
      saved = await _ctx.flushServerSave();
    } catch (e) {
      _rollbackConfirmState();
      showToast("确认失败：项目保存失败，请稍后重试", "error");
      return;
    }
    if (saved && saved.ok === false && saved.stale === true) {
      // 409 stale：flushServerSave 已用服务器最新整包替换内存（批量刚完成时
      // 后端 apply_patch_and_save 抢先 bump version 是常态，不是真冲突）。
      // 本次 PUT 被丢弃 = 确认标记没落盘。在重载后的新副本上重打标记，
      // 用对齐后的 version 再 flush 一次；二连败才按真失败回滚。
      _syncRefs();
      if (!project || !project.shots) {
        showToast("确认失败：项目状态已变化，请重试", "error");
        return;
      }
      prevShotsApproved = project.shotsApproved;
      prevImagesApproved = project.imagesApproved;
      prevCurrentStep = project.currentStep;
      project.shotsApproved = true;
      project.imagesApproved = true;
      project.currentStep = Math.max(project.currentStep || 0, 5);
      try {
        saved = await _ctx.flushServerSave();
      } catch (e2) {
        saved = { ok: false };
      }
    }
    if (saved && saved.ok === false) {
      _rollbackConfirmState();
      showToast("确认失败：项目保存失败，请稍后重试", "error");
      return;
    }
  } else {
    saveProject();
  }
  switchPage("prompts");
  showToast("分镜图已确认，已进入视频提示词", "success");
}

export async function handleImageAction(e) {
  if (!project) return;
  var target = e.target;
  var btn = target && target.closest ? target.closest("[data-action]") : null;
  if (!btn) {
    var frameHead = target && target.closest ? target.closest(".sb-frame-panel-head") : null;
    if (frameHead) {
      var headPanel = frameHead.closest(".sb-frame-panel");
      var headToggle = headPanel && headPanel.querySelector('.sb-frame-toggle[data-action="toggle-frame-card"]');
      if (_setFramePanelCollapsedFromToggle(headToggle)) return;
    }
    var collapsedPanel = target && target.closest ? target.closest(".sb-frame-panel.is-collapsed") : null;
    if (collapsedPanel) {
      var collapsedToggle = collapsedPanel.querySelector('.sb-frame-toggle[data-action="toggle-frame-card"]');
      if (_setFramePanelCollapsedFromToggle(collapsedToggle, false)) return;
    }
    return;
  }
  var action = btn.dataset.action;

  if (action === "edit-first-frame") {
    var editGIdx = parseInt(btn.dataset.gidx, 10);
    if (!isNaN(editGIdx)) _openFirstFrameEditor(editGIdx);
    return;
  }

  if (action === "retry-first-frame-prompt-save") {
    var retryGIdx = parseInt(btn.dataset.gidx, 10);
    if (isNaN(retryGIdx)) {
      var retryCard = btn.closest(".sb-sheet");
      retryGIdx = parseInt(retryCard && retryCard.dataset.groupIdx, 10);
    }
    if (!isNaN(retryGIdx)) _sbRetryFirstFrameCardPromptSave(retryGIdx);
    return;
  }

  if (action === "retry-tail-frame-prompt-save") {
    var retryTailGIdx = parseInt(btn.dataset.gidx, 10);
    if (isNaN(retryTailGIdx)) {
      var retryTailCard = btn.closest(".sb-sheet");
      retryTailGIdx = parseInt(retryTailCard && retryTailCard.dataset.groupIdx, 10);
    }
    if (!isNaN(retryTailGIdx)) _sbRetryTailFrameCardPromptSave(retryTailGIdx);
    return;
  }

  if (action === "restore-tail-frame-prompt") {
    var restoreTailGIdx = parseInt(btn.dataset.gidx, 10);
    if (isNaN(restoreTailGIdx)) {
      var restoreTailCard = btn.closest(".sb-sheet");
      restoreTailGIdx = parseInt(restoreTailCard && restoreTailCard.dataset.groupIdx, 10);
    }
    if (!isNaN(restoreTailGIdx)) _sbRestoreTailFrameCardPrompt(restoreTailGIdx);
    return;
  }

  if (action === "toggle-frame-card") {
    // 折叠/展开首帧 / 尾帧 card。仅切 CSS class + 改按钮文案/图标, 不走完整 re-render,
    // 避免破坏画面描述 textarea 的焦点/输入态。折叠状态会持久化到 localStorage。
    _setFramePanelCollapsedFromToggle(btn);
    return;
  }

  if (action === "lightbox") {
    var imgSrc = btn.tagName === "IMG" ? btn.src : (btn.dataset.img || "");
    if (imgSrc) _openLightbox(imgSrc);
    return;
  }

  var card = btn.closest(".sb-sheet");
  if (!card) return;
  var gIdx = parseInt(card.dataset.groupIdx, 10);

  if (action === "ref-agent-sb") {
    agentInsertRef("分镜板", String(gIdx + 1), { groupIdx: gIdx });
    return;
  }

  if (action === "show-history") {
    var sbItem = project.storyboards && project.storyboards[gIdx];
    if (!sbItem) { showToast("暂无历史版本", "warn"); return; }
    _openHistoryPopover(btn, sbItem, async function (hi) {
      var snap = sbItem.imageHistory && sbItem.imageHistory[hi];
      var historyUrl = snap && (snap.url || snap.rawUrl || snap.realPhotoUrl || snap.pencilUrl) || "";
      if (!historyUrl || !project || !project.id) return;
      try {
        await apiPost('/api/frames/set-current-from-history', {
          projectId: project.id,
          groupIdx: gIdx,
          historyUrl: historyUrl,
        });
        await _reloadProjectFromServerForStoryboard(project.id);
        renderImageGrid();
        showToast("已恢复到历史版本", "ok");
      } catch (err) {
        showToast("恢复历史版本失败: " + _diagnoseApiError(((err && err.message) || err).toString()), "error");
      }
    });
    return;
  }

  if (action === "show-tail-history") {
    var tailSbItem = project.storyboards && project.storyboards[gIdx];
    if (!tailSbItem || !Array.isArray(tailSbItem.tailFrameHistory) || !tailSbItem.tailFrameHistory.length) {
      showToast("暂无尾帧历史版本", "warn");
      return;
    }
    _openHistoryPopover(btn, { imageHistory: tailSbItem.tailFrameHistory }, async function (hi) {
      var snap = tailSbItem.tailFrameHistory && tailSbItem.tailFrameHistory[hi];
      var historyUrl = snap && (snap.url || snap.rawUrl) || "";
      if (!historyUrl || !project || !project.id) return;
      try {
        await apiPost('/api/frames/set-current-from-history', {
          projectId: project.id,
          groupIdx: gIdx,
          frameType: 'tail_frame',
          historyUrl: historyUrl,
        });
        await _reloadProjectFromServerForStoryboard(project.id);
        renderImageGrid();
        showToast("已恢复尾帧历史版本", "ok");
      } catch (err) {
        showToast("恢复尾帧历史版本失败: " + _diagnoseApiError(((err && err.message) || err).toString()), "error");
      }
    });
    return;
  }

  if (action === "regen-sb") {
    if (_imagesGenerating) { showToast("正在生成中，请稍候", "warn"); return; }
    var regenGroups = getStoryboardGroups();
    var regenGroup = regenGroups[gIdx];
    if (!await _ensureSingleFirstFramePreflightAllowed(gIdx, regenGroup)) {
      renderImageGrid();
      checkImagesConfirm();
      return;
    }
    // P1 修复: 在发 /api/batch/start 之前, 先把卡片内联"画面描述"textarea 里还没
    //  防抖落地的输入 flush 到 /api/frames/edit-draft。FFE 模态那条
    //  (_generateFirstFrameFromEditor, line 3105) 一直有 _ffeFlushAutoSave 兜底,
    //  这里补上对应的卡片版, 避免用户改了字立刻点重生时, 后端读到上一拍的旧 draft。
    //  state.composing / hydrating 都由 _sbRunFirstFrameCardPromptSave 内部处理,
    //  没改动直接 skipped, 不会重复发 PUT。
    var cardFlushResult = await _sbRunFirstFrameCardPromptSave(gIdx, { source: 'regen-sb-flush' });
    if (cardFlushResult && cardFlushResult.ok === false) {
      // toast 已经在 _sbRunFirstFrameCardPromptSave 内部弹过, 这里直接不启动 batch,
      // 让用户处理保存错误后再点。
      renderImageGrid();
      checkImagesConfirm();
      return;
    }
    if (!project.storyboards) project.storyboards = [];
    var oldSb = project.storyboards[gIdx];
    if (oldSb) _archiveOldImage(oldSb, "storyboard");
    // P2 修复: 原来这里把整槽换成 { imageHistory: [...] } / null 再 saveProject(),
    //  会把"没有 draft / 没有 firstFrameBasePrompt / 没有 frames.tail"的本地状态
    //  通过 debounced PUT /api/projects/<id> 推到服务器。当前依赖 batch executor
    //  比 1.5s saveProject debounce 更快落地 + If-Match 409 自动 reload 救场,
    //  但这不是契约: 慢一拍 draft 就被 PUT 覆盖丢了, 中间也会有 60-90s UI 抖动。
    //  改成只删生成结果相关字段, 保留 firstFrameEditDraft / firstFrameBasePrompt /
    //  firstFrameBackup / 尾帧 / shotIndices 等所有用户态。
    if (oldSb) {
      delete oldSb.url;
      delete oldSb.imageUrl;
      delete oldSb.rawUrl;
      delete oldSb.firstFrameUrl;
      delete oldSb.firstFrame;
      delete oldSb.firstFramePrompt;
      delete oldSb.firstFrameMode;
      delete oldSb.firstFrameSourceHash;
      delete oldSb.firstFrameLastError;
      delete oldSb.firstFrameFailedAt;
      delete oldSb.firstFrameSafetyAudit;
      delete oldSb.firstFramePlanSummary;
      delete oldSb.effectiveVisualDescription;
      delete oldSb.imagePrompt;
      delete oldSb.originalFirstFramePrompt;
      delete oldSb.debugSketchUrl;
      if (oldSb.frames && typeof oldSb.frames === 'object') {
        var nextFrames = Object.assign({}, oldSb.frames);
        delete nextFrames.first;
        oldSb.frames = nextFrames;
      }
    } else {
      project.storyboards[gIdx] = {};
    }
    saveProject();
    // 卡片上的"重新生成"按钮: 沿用画面描述上的已保存草稿 (firstFrameEditDraft),
    // 不再静默吞掉用户编辑。后端 (lib/batch-executors.ts:1234) 有 `&& draft` 守卫,
    // 没编辑过的 group 这个 true 是空操作。
    generateStoryboardSheet(gIdx, { skipPreflight: true, applyEditDraft: true }).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    });
  } else if (action === "accept-tail-suggestion") {
    _acceptTailFrameSuggestion(gIdx);
  } else if (action === "regen-tail") {
    // 尾帧独立生成: 不清首帧, 不 archive 主图, 生成完只刷新尾帧格 (renderStoryboardFrameCard
    // 内部处理)。前端和后端都有 preflight 挡 legacy_pencil / 缺首帧的 case。
    generateStoryboardTailFrame(gIdx).then(function () {
      saveProject();
    }).catch(function (err) {
      console.warn('[TailFrame] regen-tail failed:', (err && err.message) || err);
    });
  } else if (action === "delete-tail") {
    // 删除尾帧的语义 = 清图 + 清用户意图。
    // 删后顶部 "重新生成全部" / 批量重试等都不会再带上此组的尾帧。
    // 如果用户只是想"重做一张"，应该使用 regen-tail；delete-tail 表达的是
    // "这一段不再需要尾帧"。
    if (!project.storyboards) project.storyboards = [];
    var delSb = project.storyboards[gIdx] || {};
    if (delSb.frames && typeof delSb.frames === 'object') {
      var nextFrames = Object.assign({}, delSb.frames);
      delete nextFrames.tail;
      delSb.frames = nextFrames;
    }
    delSb.tailFrameUrl = '';
    delSb.tailFramePrompt = '';
    delSb.tailFrameIntent = 'none';
    delSb.tailFrameIntentUpdatedAt = new Date().toISOString();
    delSb.tailFrameSourceHash = null;
    delSb.tailFrameReferenceStatus = 'missing';
    delSb.tailFrameLastError = '';
    project.storyboards[gIdx] = delSb;
    saveProject();
    renderImageGrid();
    checkImagesConfirm();
    showToast('已删除尾帧并清除意图', 'info');
  } else if (action === "upload-tail") {
    _pickAndUploadTailFrame(gIdx);
  } else if (action === "upload-first") {
    _pickAndUploadFirstFrame(gIdx);
  } else if (action === "regen-sb-prompt") {
    if (_imagesGenerating || _promptsConverting) { showToast("正在生成中，请稍候", "warn"); return; }
    var groups = getStoryboardGroups();
    var group = groups[gIdx];
    if (!group) return;
    group.shotIndices.forEach(function (sIdx) {
      project.shots[sIdx].imagePrompt = "";
      project.shots[sIdx].imagePromptGenerated = false;
    });
    saveProject();
    updateStoryboardCard(gIdx, "loading", null, "重写画面指令…");
    _autoConvertGroupPrompts(group).then(function () {
      updateStoryboardCard(gIdx, "loading", null, "重新生成首帧图…");
      return generateStoryboardSheet(gIdx);
    }).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    }).catch(function (err) {
      showToast("重新生成失败: " + _diagnoseApiError(((err && err.message) || err).toString()), "error");
    });
  } else if (action === "download-sb") {
    // 走 fetch→blob→<a> 的下载链路, 复用 _downloadOneMaterialAsBlob。
    // 原本直接 <a href=/api/images/file/xxx> 会被浏览器当成"未认证下载"挡掉
    // (受 JWT 保护的图片端点, <a download> 不会带认证 cookie/header),
    // 出现 Chrome "无法从网站上提取文件" 提示。
    (function () {
      var sb = project.storyboards && project.storyboards[gIdx];
      var firstUrl = _firstFrameImageUrl(sb);
      if (!firstUrl) return;
      var ext = _guessMaterialImageExt(firstUrl) || 'png';
      // 命名: 镜头X首帧图X  (跟批量下载素材图的 "镜头X场景图Y" 命名风格保持一致)
      var groupNo = gIdx + 1;
      _downloadOneMaterialAsBlob(firstUrl, "镜头" + groupNo + "首帧图" + groupNo + "." + ext)
        .catch(function (e) { showToast('下载首帧失败：' + ((e && e.message) || e), 'error'); });
    })();
  } else if (action === "download-tail") {
    (function () {
      var sbTail = project.storyboards && project.storyboards[gIdx];
      var tailUrl = _tailFrameImageUrl(sbTail);
      if (!tailUrl) return;
      var ext = _guessMaterialImageExt(tailUrl) || 'png';
      var groupNo = gIdx + 1;
      _downloadOneMaterialAsBlob(tailUrl, "镜头" + groupNo + "尾帧图" + groupNo + "." + ext)
        .catch(function (e) { showToast('下载尾帧失败：' + ((e && e.message) || e), 'error'); });
    })();
  }
}

export function handleConvertAction(e) {
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var card = btn.closest(".prompt-preview-card");
  if (!card) return;
  var idx = parseInt(card.dataset.shotIdx, 10);
  var action = btn.dataset.action;

  if (action === "regen-convert") {
    if (_promptsConverting) { showToast("正在批量生成中，请稍候", "warn"); return; }
    if (!project || !project.shots[idx]) return;
    project.shots[idx].imagePrompt = "";
    project.shots[idx].imagePromptGenerated = false;
    saveProject();
    convertSinglePrompt(idx).then(function () { checkConvertConfirm(); });
  } else if (action === "edit-convert") {
    if (!project || !project.shots[idx]) return;
    var current = project.shots[idx].imagePrompt || "";
    var newPrompt = prompt("手动编辑中文画面提示词:", current);
    if (newPrompt !== null && newPrompt.trim()) {
      project.shots[idx].imagePrompt = newPrompt.trim();
      project.shots[idx].imagePromptGenerated = true;
      var _editGIdxMap = _getShotGroupIndices();
      var _editGIdx = _editGIdxMap[idx] !== undefined ? _editGIdxMap[idx] : Math.floor(idx / 3);
      if (project.storyboards && project.storyboards[_editGIdx] && project.storyboards[_editGIdx].imageUrl) {
        if (!project._staleFlags) project._staleFlags = {};
        project._staleFlags["storyboard_" + _editGIdx] = true;
      }
      saveProject();
      renderPromptPreviewList();
      checkConvertConfirm();
    }
  }
}
