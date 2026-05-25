import { $, escapeHtml, showToast, showConfirm, apiPost, apiPostStream, apiGet, getAuthHeaders,
  consumeStreamStepTags, ApiError, hydrateProtectedImageElements } from './utils.js?v=102';
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
} from './material_image_panel.js?v=103';
import { attachDiagnostic } from './diagnostic.js';
import { renderStoryboardCard, renderStoryboardFrameCard } from './render_hooks.js';
import { subscribeBatch } from './backend_stream.js';
import { showBillingPaywall } from './billing.js';

let _ctx = {};
let project = null;

var _imagesGenerating = false;
var _imagesStarting = false;
var _promptsConverting = false;
var IMG_PARALLEL = 3;
var MAX_SHOTS_PER_GROUP = 5;
var _sbCurrentIdx = 0;
var _sbProgrammaticScrolling = false;
var _sbScrollSettleTimer = null;
var _firstFramePreflightState = { key: "", status: "idle", payload: null, message: "", promise: null };
var FIRST_FRAME_DEFAULT_HINT = "基于镜头与资产生成首帧，并管理可选尾帧";
var FIRST_FRAME_REWRITE_CHAT_ENABLED = false;
var FFE_AUTOSAVE_DEBOUNCE_MS = 800;
var FFE_AUTOSAVE_MAX_WAIT_MS = 4000;
var FFE_AUTOSAVE_SAVING_VISIBLE_MS = 500;
// 必须与服务端 lib/first-frame-edit-draft.ts 中
// MAX_PROMPT_OVERRIDE_CHARS / MAX_NEGATIVE_PROMPT_CHARS 保持一致。
// 用于 textarea maxlength、计数器，以及 _ffeDraftForCompare 保存前比较规范化。
var FFE_PROMPT_OVERRIDE_MAX_CHARS = 5000;
var FFE_NEGATIVE_PROMPT_MAX_CHARS = 500;

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
      promptOverride: false,
      negativePromptOverride: false,
    },
    fieldStatus: {
      promptOverride: "initial",
      negativePromptOverride: "initial",
    },
    fieldSaving: {
      promptOverride: false,
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
    restoring: false,
    rewriting: false,
    generateBlock: null,
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

export function initStoryboard(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncStoryboardProject(p) {
  project = p || null;
  setMaterialPanelProject(project && project.id || '', project && project.updatedAt || '');
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
  var resp;
  try {
    resp = await apiGet("/api/batch/active?projectId=" + encodeURIComponent(project.id));
  } catch (e) {
    console.warn("[StoryboardReattach] /api/batch/active failed:", (e && e.message) || e);
    return;
  }
  var batches = (resp && resp.batches) || [];
  if (!batches.length) return;

  batches.forEach(function (b) {
    var bt = b.batchType || "";
    var batchId = b.batchId;
    if (!batchId) return;

    if (bt === "storyboard_images") {
      _reattachImagesBatch(b);
    } else if (bt === "tail_frame_images") {
      _reattachTailFrameBatch(b);
    } else if (bt === "storyboard_prompts") {
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

  tasks.forEach(function (t) {
    var extra = _snapshotTaskExtra(t);
    var target = _snapshotTaskTarget(t);
    var gIdx = _firstTaskNumber([target.groupIdx, extra.groupIdx, t.target_idx, t.seq]);
    if (gIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";
    var url = _snapshotTaskImageUrl(t);

    if (isDone && url) {
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
      updateStoryboardCard(gIdx, "error", null, _snapshotTaskError(t, 120));
    } else {
      updateStoryboardCard(gIdx, "loading", null, "生成中…");
    }
  });

  var isComplete = snap.status === "completed" || snap.status === "done" || snap.status === "partial";
  if (isComplete) {
    _imagesGenerating = false;
    checkImagesConfirm();
    return;
  }

  _imagesGenerating = true;
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + (snap.total || "?");

  // 刷新后重连场景：把 #sbDiagnostic 改成倒计时（同 generateAllImages 路径）
  var rDiagBox = $("sbDiagnostic");
  var rDoneCount = snap.succeeded || 0;
  var rFailCount = snap.failed || 0;
  var rTotal = snap.total || 0;
  // 刷新后没有"本次生成开始时刻"，从 batch 创建时间近似（不准但够用）
  var rStartTs = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
  function _renderEtaR() {
    if (!rDiagBox || !rTotal) return;
    var pending = Math.max(0, rTotal - rDoneCount - rFailCount);
    var lines = ["生成中… " + rDoneCount + "/" + rTotal];
    if (rFailCount > 0) lines.push(rFailCount + " 张失败");
    if (pending > 0) {
      var avg = (rDoneCount + rFailCount >= 1)
        ? Math.max(8, (Date.now() - rStartTs) / 1000 / (rDoneCount + rFailCount))
        : 70;
      var remain = Math.ceil(pending * avg / 4);
      lines.push("约剩 " + remain + " 秒");
    }
    rDiagBox.innerHTML = '<div class="diag-empty" style="text-align:center;padding:8px 0;font-weight:500;color:#475569;">' +
      escapeHtml(lines.join("，")) +
      '</div>';
  }
  _renderEtaR();
  var rTick = setInterval(_renderEtaR, 1000);
  function _stopTickR() { if (rTick) { clearInterval(rTick); rTick = null; } }
  function _clearEtaR() { if (rDiagBox) rDiagBox.innerHTML = ''; }

  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (s && typeof s.total === 'number') {
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
      rDoneCount++;
      _renderEtaR();
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 120);
      if (typeof groupIdx === 'number') updateStoryboardCard(groupIdx, "error", null, errMsg);
      rFailCount++;
      _renderEtaR();
    },
    onBatchCompleted: function () {
      (async function () {
        _imagesGenerating = false;
        if (btn) btn.disabled = false;
        _stopTickR();
        _clearEtaR();
        await _reloadProjectFromServerForStoryboard(originId);
        renderImageGrid();
        checkImagesConfirm();
      })();
    },
    onClose: function () {
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

  tasks.forEach(function (t) {
    var extra = _snapshotTaskExtra(t);
    var target = _snapshotTaskTarget(t);
    var gIdx = _firstTaskNumber([target.groupIdx, extra.groupIdx, t.target_idx, t.seq]);
    if (gIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";
    var url = _snapshotTaskImageUrl(t);

    if (isDone && url) {
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      _applyTailFrameFields(project.storyboards[gIdx], url, extra, target.shotIndices || null);
      renderStoryboardFrameCard(gIdx, 'tail', 'done', { imgUrl: url });
    } else if (isFailed) {
      var errMsg = _snapshotTaskError(t, 120);
      var displayMsg = _tailFrameErrorDisplay(_tailFrameErrorRecordFromStoryboard(project.storyboards[gIdx], errMsg), errMsg);
      renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: displayMsg });
    } else {
      renderStoryboardFrameCard(gIdx, 'tail', 'loading', { loadingText: "生成尾帧中…" });
    }
  });

  var isComplete = snap.status === "completed" || snap.status === "done" || snap.status === "partial";
  if (isComplete) return;

  // 订阅剩余进度。尾帧批任务通常只有 1 个 target, 不设全局 _imagesGenerating 状态
  // (它是首帧流程的锁, 尾帧不共享)。
  subscribeBatch(batchId, {
    onTaskCompleted: function (data) {
      var extra = (data && data.extra) || {};
      var target = (data && data.target) || {};
      var gIdx2 = _firstTaskNumber([target.groupIdx, extra.groupIdx, data.targetSeq]);
      var patch = (data && data.patch) || {};
      var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || (data && data.resultUrl) || '';
      if (typeof gIdx2 !== 'number' || !rawUrl) return;
      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx2] || {};
        _applyTailFrameFields(existing, rawUrl, extra, target.shotIndices || null);
        proj.storyboards[gIdx2] = existing;
      });
      renderStoryboardFrameCard(gIdx2, 'tail', 'done', { imgUrl: rawUrl });
    },
    onTaskFailed: function (data) {
      var extra = (data && data.extra) || {};
      var target = (data && data.target) || {};
      var gIdx2 = _firstTaskNumber([target.groupIdx, extra.groupIdx, data.targetSeq]);
      var errMsg2 = ((data && data.errorMsg) || '生成失败').toString().slice(0, 120);
      if (typeof gIdx2 !== 'number') return;
      var displayMsg2 = _tailFrameErrorDisplay(_tailFrameErrorRecordFromExtra(extra, errMsg2), errMsg2);
      _clearFailedTailFrameLocally(gIdx2, errMsg2, extra);
      renderStoryboardFrameCard(gIdx2, 'tail', 'error', { errMsg: displayMsg2 });
    },
    onBatchCompleted: function () {
      // 数据已本地 apply, 不强制 reload project; 权威状态会在下次 reload 时到位。
    },
    onClose: function () { /* SSE 断开由 polling 兜底, 或由后端最终 snapshot 修正 */ },
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

  var isComplete = snap.status === "completed" || snap.status === "done" || snap.status === "partial";
  if (isComplete) {
    _promptsConverting = false;
    checkConvertConfirm();
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
      _promptsConverting = false;
      if (btn) btn.disabled = false;
      checkConvertConfirm();
    },
    onClose: function () {
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
  if (extra.tailFrameSafetyAudit) existing.tailFrameSafetyAudit = extra.tailFrameSafetyAudit;
  if (extra.tailFramePlanSummary) existing.tailFramePlanSummary = extra.tailFramePlanSummary;
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

/**
 * 前端 preflight: 尾帧是否可生成。和 lib/visual-reference-state.ts 的
 * checkTailFramePreflight 保持一致 (mode ∈ structured_v1/multi_ref_v1, 或
 * frames.first.status='ready', 且 frames.first.status !== 'failed')。
 * 后端 executor 会再查一次, 前端按钮 disabled 只是 UX 兜底。
 */
function _canGenerateTailFrame(sb) {
  if (!sb) return false;
  var firstUrl =
    sb.firstFrameUrl ||
    (sb.frames && sb.frames.first && sb.frames.first.url) ||
    (sb.firstFrame && sb.firstFrame.currentUrl);
  if (!firstUrl) return false;
  var mode = String(sb.firstFrameMode || '');
  var framesFirstStatus = (sb.frames && sb.frames.first && sb.frames.first.status) || '';
  var firstFrameStatus = (sb.firstFrame && sb.firstFrame.status) || '';
  if (framesFirstStatus === 'failed' || firstFrameStatus === 'failed') return false;
  // 显式拒 legacy_pencil: 即使某些混合数据写了 frames.first.status='ready', 手稿首帧
  // 仍不能做尾帧锚点。必须先升级到彩色首帧。和 lib/visual-reference-state.ts 的
  // checkTailFramePreflight 保持同样的 override 顺序。
  if (mode === 'legacy_pencil') return false;
  if (mode === 'structured_v1' || mode === 'multi_ref_v1') return true;
  if (framesFirstStatus === 'ready') return true;
  return false;
}

function _firstFrameImageUrl(sb) {
  sb = sb || {};
  return (sb.frames && sb.frames.first && sb.frames.first.url) ||
    sb.firstFrameUrl ||
    sb.rawUrl ||
    sb.imageUrl ||
    sb.url ||
    '';
}

function _tailFrameImageUrl(sb) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  return (tail && tail.url) || sb.tailFrameUrl || '';
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
  };
}

function _tailFrameErrorDisplay(record, fallbackMsg) {
  record = record || {};
  return (record.recoveryHint || record.message || fallbackMsg || '生成失败').toString().slice(0, 200);
}

function _tailFrameUiState(sb) {
  sb = sb || {};
  var tail = (sb.frames && sb.frames.tail) || null;
  var tailUrl = _tailFrameImageUrl(sb);
  var tailStatus = (tail && tail.status) || (sb.tailFrameLastError ? 'failed' : (tailUrl ? 'ready' : 'missing'));
  var canGenerate = _canGenerateTailFrame(sb);
  var isLegacyPencil = String(sb.firstFrameMode || '') === 'legacy_pencil';
  var preflightMsg;
  if (isLegacyPencil) preflightMsg = '当前首帧是手稿版 (legacy_pencil), 需先升级为彩色首帧';
  else if (!canGenerate) preflightMsg = '需先生成彩色首帧 (structured_v1)';
  else preflightMsg = '';

  var statusText;
  if (tailStatus === 'ready') statusText = '已生成';
  else if (tailStatus === 'failed') statusText = '生成失败';
  else if (tailStatus === 'degraded') statusText = '已降级 (展示上次成功)';
  else if (tailStatus === 'missing') {
    if (isLegacyPencil) statusText = '需升级首帧';
    else statusText = canGenerate ? '待生成' : '等待首帧';
  } else statusText = tailStatus;

  var btnText;
  if (tailStatus === 'ready' || tailStatus === 'degraded') btnText = '重生成';
  else if (tailStatus === 'failed') btnText = '重试';
  else btnText = '生成尾帧';

  return {
    url: tailUrl,
    status: tailStatus,
    statusText: statusText,
    btnText: btnText,
    canGenerate: canGenerate,
    isLegacyPencil: isLegacyPencil,
    preflightMsg: preflightMsg,
    errorMsg: _tailFrameErrorDisplay(_tailFrameErrorRecordFromStoryboard(sb, '')),
  };
}

function _clipNum(v, min, max, dflt) {
  var n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function _tailFrameSuggestionForGroup(group, sb) {
  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  if (!shots.length) return { level: 'none', score: 0, label: '' };
  if (_isTailRequested(sb)) return { level: 'requested', score: 100, label: '已选择尾帧' };
  var weights = {
    actionLandingNeed: 18,
    visualTransformationNeed: 16,
    revealNeed: 16,
    endingCompositionNeed: 14,
    emotionPeakNeed: 12,
    continuityNeed: 0,
  };
  var weightTotal = 0;
  Object.keys(weights).forEach(function (k) { weightTotal += weights[k]; });
  var weighted = 0;
  var simpleDialogueCount = 0;
  var totalDuration = 0;
  shots.forEach(function (shot) {
    var sig = (shot && shot.tailFrameSignals) || {};
    Object.keys(weights).forEach(function (key) {
      weighted += _clipNum(sig[key], 0, 5, 0) * weights[key];
    });
    if (sig.isSimpleStaticDialogue === true) simpleDialogueCount++;
    totalDuration += _clipNum(shot.duration || shot.durationSec, 0, 120, 4);
  });
  var base = weighted / Math.max(1, shots.length * weightTotal * 5) * 100;
  var durationBonus = _clipNum(totalDuration - 6, 0, 10, 0);
  var simpleDialoguePenalty = simpleDialogueCount === shots.length ? 15 : 0;
  var score = Math.round(_clipNum(base + durationBonus - simpleDialoguePenalty, 0, 100, 0));
  if (score >= 70) return { level: 'strong', score: score, label: '强烈建议尾帧' };
  if (score >= 45) return { level: 'suggest', score: score, label: '建议尾帧' };
  return { level: 'none', score: score, label: '' };
}

// 计算尾帧卡片顶部 advice banner 的展示决策。返回结构:
//   { kind: 'recommend' | 'discourage' | 'hidden',
//     label, reasonShort, reasonLong, score }
// 抑制规则:
//   - shots 为空 / 全无 tailFrameSignals
//   - _isTailRequested(sb) === true (已选择 / 已生成)
//   - tail status === 'ready' | 'degraded' | 'failed' (兜底防御)
//   - firstFrameMode === 'legacy_pencil' (首帧本身不达标, 谈不上要不要尾帧)
// 阈值: score >= 45 -> recommend; < 45 -> discourage
function _tailFrameAdviceForGroup(group, sb) {
  sb = sb || {};
  var hidden = { kind: 'hidden', score: 0 };
  var shots = (group && Array.isArray(group.shots)) ? group.shots : [];
  if (!shots.length) return hidden;
  if (_isTailRequested(sb)) return hidden;
  if (String(sb.firstFrameMode || '') === 'legacy_pencil') return hidden;
  var tailUiStatus = (_tailFrameUiState(sb) || {}).status;
  if (tailUiStatus === 'ready' || tailUiStatus === 'degraded' || tailUiStatus === 'failed') {
    return hidden;
  }
  var hasAnySignals = shots.some(function (shot) {
    return shot && shot.tailFrameSignals && typeof shot.tailFrameSignals === 'object';
  });
  if (!hasAnySignals) return hidden;

  var suggestion = _tailFrameSuggestionForGroup(group, sb);
  // requested level 已被上面的 _isTailRequested 拦掉;
  // 这里只可能是 strong / suggest / none。
  if (suggestion.level === 'requested') return hidden;

  var signalDefs = [
    { key: 'actionLandingNeed', label: '动作落点' },
    { key: 'visualTransformationNeed', label: '视觉转化' },
    { key: 'revealNeed', label: '揭示节点' },
    { key: 'endingCompositionNeed', label: '镜头收束' },
    { key: 'emotionPeakNeed', label: '情绪峰值' },
  ];
  var aggMax = {};
  var simpleDialogueCount = 0;
  var totalDuration = 0;
  shots.forEach(function (shot) {
    var sig = (shot && shot.tailFrameSignals) || {};
    signalDefs.forEach(function (def) {
      var v = _clipNum(sig[def.key], 0, 5, 0);
      if (v > (aggMax[def.key] || 0)) aggMax[def.key] = v;
    });
    if (sig.isSimpleStaticDialogue === true) simpleDialogueCount++;
    totalDuration += _clipNum(shot.duration || shot.durationSec, 0, 120, 4);
  });
  var reasonLongParts = signalDefs.map(function (def) {
    return def.label + ' ' + Math.round((aggMax[def.key] || 0) * 20); // 0-5 → 0-100
  });
  var reasonLong = '评分 ' + suggestion.score + '：' + reasonLongParts.join(' / ');

  if (suggestion.level === 'strong' || suggestion.level === 'suggest') {
    var topSignals = signalDefs
      .map(function (def) { return { label: def.label, value: aggMax[def.key] || 0 }; })
      .filter(function (s) { return s.value >= 4; })
      .sort(function (a, b) { return b.value - a.value; })
      .slice(0, 2)
      .map(function (s) { return s.label; });
    var reasonShortPos = topSignals.length ? topSignals.join(' · ') : '镜头综合评分较高';
    return {
      kind: 'recommend',
      label: '建议生成尾帧',
      reasonShort: reasonShortPos,
      reasonLong: reasonLong,
      score: suggestion.score,
    };
  }

  // suggestion.level === 'none' → discourage
  var negParts = [];
  if (shots.length > 0 && simpleDialogueCount === shots.length) negParts.push('简单对白镜头');
  if (totalDuration < 6) negParts.push('时长较短');
  if (!negParts.length) negParts.push('镜头信号偏弱');
  return {
    kind: 'discourage',
    label: '不建议使用尾帧',
    reasonShort: negParts.join(' · ') + '，首帧主控更稳',
    reasonLong: reasonLong,
    score: suggestion.score,
  };
}

// 渲染尾帧卡片顶部的 advice banner。两种状态:
//   - recommend: 绿色 + 粗体 + lightbulb 图标 + 点击直接走 accept-tail-suggestion
//   - discourage: 琥珀色 + 常规字重 + info 图标 + 点击弹 confirm, 用户确认后再走 accept
//     （此前用红色 bg-red-50/text-red-700，色彩过于警示——这是"不建议但可以做"的
//     提示性语义，不是错误。改用 amber 琥珀色，温和不刺眼，跟绿色保持色相对比。）
// hidden 时返回空串, 调用方不会在 DOM 上落任何节点。
function _tailFrameAdviceBannerHtml(advice, gIdx) {
  if (!advice || advice.kind === 'hidden') return '';
  var isPositive = advice.kind === 'recommend';
  var icon = isPositive ? 'tips_and_updates' : 'info';
  var action = isPositive ? 'accept-tail-suggestion' : 'confirm-tail-advice-override';
  var labelCls = isPositive ? 'font-bold' : 'font-medium';
  var toneCls = isPositive
    ? 'bg-emerald-50 text-emerald-700 border-b border-emerald-100 hover:bg-emerald-100/70 '
    : 'bg-amber-50 text-amber-700 border-b border-amber-100 hover:bg-amber-100/70 ';
  var hintTitle = (isPositive
    ? '点击采纳建议并生成尾帧。'
    : '点击仍然生成尾帧（系统不建议）。') + advice.reasonLong;
  return (
    '<button type="button" ' +
      'class="tail-advice-banner w-full flex items-center gap-1.5 px-4 py-1.5 ' +
        toneCls +
        'transition-colors cursor-pointer text-[11px] leading-tight text-left" ' +
      'data-action="' + action + '" data-gidx="' + gIdx + '" ' +
      'title="' + escapeHtml(hintTitle) + '">' +
      '<span class="material-symbols-outlined text-[14px] shrink-0">' + icon + '</span>' +
      '<span class="' + labelCls + ' shrink-0">' + escapeHtml(advice.label) + '</span>' +
      '<span class="opacity-70 truncate">· ' + escapeHtml(advice.reasonShort) + '</span>' +
    '</button>'
  );
}

// 标记尾帧意图为 requested 并触发后续生成。供:
//   - accept-tail-suggestion (正向 banner 点击)
//   - confirm-tail-advice-override (负向 banner 点击 + 用户在 confirm 弹窗里点了"确定")
// 复用同一套逻辑, 避免行为漂移。
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
  if (_canGenerateTailFrame(suggestSb)) {
    generateStoryboardTailFrame(gIdx).then(function () {
      saveProject();
      checkImagesConfirm();
    }).catch(function (err) {
      console.warn('[TailFrame] accept suggestion failed:', (err && err.message) || err);
    });
  } else {
    showToast("已标记这段需要尾帧，请先生成首帧", "info");
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

function _frameButtonHtml(action, gIdx, icon, text, title, variant, disabled) {
  var cls = variant === 'primary'
    ? 'bg-primary text-on-primary border-primary/20 shadow-sm hover:opacity-90'
    : 'bg-white/80 text-on-surface-variant border-white/60 hover:bg-white';
  return '<button type="button" class="flex items-center gap-1.5 px-3 py-2 rounded-full text-[10px] font-bold tracking-widest uppercase border backdrop-blur-md transition-all active:scale-95 ' + cls + '"' +
    (action ? ' data-action="' + action + '" data-gidx="' + gIdx + '"' : '') +
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

function _storyboardFramePanelHtml(kind, sb, gIdx, group) {
  sb = sb || {};
  var isTail = kind === 'tail';
  var imgUrl = isTail ? _tailFrameImageUrl(sb) : _firstFrameImageUrl(sb);
  var hasImg = !!imgUrl;
  var state = isTail ? _tailFrameUiState(sb) : null;
  var label = isTail ? '尾帧' : '首帧';
  var labelEn = isTail ? 'TAIL FRAME' : 'FIRST FRAME';
  var icon = isTail ? 'skip_next' : 'play_arrow';
  var statusText = isTail
    ? state.statusText
    : (hasImg ? (String(sb.firstFrameMode || '') === 'legacy_pencil' ? '手稿首帧' : '已生成') : '待生成');
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
  var imgHtml = hasImg
    ? '<img data-frame-img class="w-full h-full object-cover cursor-pointer" data-action="lightbox" loading="lazy" decoding="async" src="' + escapeHtml(imgUrl) + '" />'
    : '<div class="sb-frame-placeholder w-full h-full flex flex-col items-center justify-center bg-surface-container text-on-surface-variant/25" data-img-class="w-full h-full object-cover cursor-pointer">' +
        '<span class="material-symbols-outlined text-5xl mb-2">' + placeholderIcon + '</span>' +
        '<span class="text-[10px] font-bold uppercase tracking-[0.28em]">' + escapeHtml(statusText) + '</span>' +
      '</div>';

  var errorMsg = isTail ? state.errorMsg : (sb.firstFrameLastError || '');
  var errorHtml = '<div class="sb-frame-error absolute inset-0 flex items-center justify-center bg-white/95 p-2 text-center"' +
    ((isTail && state.status === 'failed') ? '' : ' hidden') + '>' +
    '<span class="sb-frame-error-msg text-[10px] text-error leading-snug">' + escapeHtml(errorMsg || '生成失败') + '</span>' +
    '</div>';

  var buttons = '';
  if (isTail && state.isLegacyPencil) {
    buttons += _frameButtonHtml('', gIdx, primaryIcon, primaryText, primaryTitle || '当前首帧是旧版手稿图，不能作为尾帧锚点；请重新生成首帧', 'primary', true);
  } else {
    if (!isTail) buttons += _firstFrameEditButtonHtml(gIdx, sb);
    buttons += _frameButtonHtml(isTail ? 'upload-tail' : 'upload-first', gIdx, 'upload', isTail ? '上传尾帧' : '上传首帧', isTail ? '手动上传一张已有尾帧图' : '手动上传一张已有首帧图', 'secondary', false);
    if (hasImg) buttons += _frameButtonHtml(isTail ? 'download-tail' : 'download-sb', gIdx, 'download', '下载', isTail ? '下载尾帧' : '下载首帧', 'secondary', false);
    buttons += _frameButtonHtml((canPrimary && !materialBlocked) ? primaryAction : '', gIdx, primaryIcon, primaryText, primaryTitle, 'primary', !canPrimary || materialBlocked);
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

  // 尾帧专属 advice banner: 复用 _tailFrameAdviceForGroup 决策, hidden 时为空串。
  var adviceBannerHtml = '';
  if (isTail) {
    adviceBannerHtml = _tailFrameAdviceBannerHtml(_tailFrameAdviceForGroup(group, sb), gIdx);
  }

  return '<div data-frame="' + kind + '" class="sb-frame-panel min-h-0 flex flex-col rounded-3xl overflow-hidden border border-outline-variant/10 bg-white/70 shadow-inner">' +
           '<div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-outline-variant/10">' +
             '<div class="min-w-0">' +
               '<div class="flex items-center gap-2">' +
                 '<span class="material-symbols-outlined text-base text-primary/60">' + icon + '</span>' +
                 '<span class="text-[11px] font-black tracking-widest text-on-background">' + label + '</span>' +
                 '<span class="text-[9px] font-black tracking-[0.24em] text-on-surface-variant/45 uppercase">' + labelEn + '</span>' +
               '</div>' +
             '</div>' +
             '<div class="flex items-center gap-1.5 min-w-0 shrink-0">' +
               '<span class="text-[10px] font-bold text-on-surface-variant/60 truncate" title="' + escapeHtml((isTail && state.preflightMsg) || statusText) + '">' + escapeHtml(statusText) + '</span>' +
               tailBadgesHtml +
             '</div>' +
           '</div>' +
           adviceBannerHtml +
           '<div class="relative flex-1 min-h-[220px] bg-surface-container overflow-hidden">' +
             imgHtml +
             '<div class="sb-frame-loading" hidden>' +
               '<div class="sb-frame-loading-card">' +
                 '<div class="sb-frame-loading-spinner"></div>' +
                 '<span class="sb-frame-loading-text">生成中…</span>' +
               '</div>' +
             '</div>' +
             errorHtml +
             '<div class="absolute right-3 bottom-3 flex items-center justify-end gap-2 flex-wrap max-w-[calc(100%-1.5rem)]">' + buttons + '</div>' +
           '</div>' +
         '</div>';
}

function _ffeShort(text, limit) {
  text = String(text || '').trim();
  limit = limit || 180;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function _ffeReferenceLabel(ref) {
  if (!ref) return '参考图';
  var roleMap = { character: '角色', scene: '场景', prop: '道具', self_first_frame: '首帧', prev_tail: '尾帧' };
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

function _ffeDraftHasTextOverride(draft, field) {
  return typeof (draft && draft[field]) === 'string' && String(draft[field]).trim().length > 0;
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
  if (field === 'promptOverride') {
    var plan = (fallbackPayload && fallbackPayload.plan) || {};
    return String(draft.promptOverride || plan.finalPrompt || '').length;
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
  if (field !== 'promptOverride' && field !== 'negativePromptOverride') return;
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
  _ffeSetFieldStatus('promptOverride', restored ? 'restored' : _ffeSavedFieldStatus('promptOverride', draft));
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
  var plan = payload && payload.plan || {};
  var prompt = draft.promptOverride || plan.finalPrompt || '';
  return '<textarea class="ffe-textarea ffe-prompt-textarea" data-ffe-field="promptOverride" maxlength="' + FFE_PROMPT_OVERRIDE_MAX_CHARS + '" placeholder="填写或调整最终首帧 Prompt">' + escapeHtml(prompt) + '</textarea>';
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

function _ffeImageStaleHtml(payload) {
  var actualImageInput = _ffeActualImageInput(payload);
  if (!actualImageInput || !actualImageInput.draftFingerprint) return '';
  var savedFingerprint = _firstFrameEditor.savedDraftFingerprint || (payload && payload.savedDraftFingerprint) || '';
  var formDirty = _ffeDraftJson(payload && payload.draft) !== (_firstFrameEditor.originalDraftJson || '{}');
  if (!formDirty && (!savedFingerprint || actualImageInput.draftFingerprint === savedFingerprint)) return '';
  return '<div class="ffe-image-stale">当前图片基于旧草稿生成，重新生成后才会应用最新修改。</div>';
}

function _ffeGenerationContextHtml(payload) {
  return '<div class="ffe-context-stack ffe-context-layout">' +
    '<div class="ffe-context-top">' + _ffeMaterialPanelHtml(payload) + '</div>' +
    _ffePanelHtml('提示词展示区域', '画面提示词', _ffePromptHtml(payload), 'ffe-prompt-panel', _ffeFieldMetaHtml('promptOverride', payload)) +
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
  var notices = Array.isArray(payload.notices) ? payload.notices : [];
  var generateBlock = _firstFrameEditor.generateBlock;
  var warnHtml = [
    legacy ? '旧版手稿首帧没有结构化生成计划，请先重新生成彩色首帧。' : ''
  ].concat(notices.map(function (notice) {
    return notice && (notice.message || notice.code) || '';
  })).concat(generateBlock && generateBlock.message ? [generateBlock.message] : []).filter(Boolean).map(function (text) {
    return '<div class="ffe-warning">' + escapeHtml(text) + '</div>';
  }).join('');
  var historyCount = (payload.currentFrame && payload.currentFrame.url ? 1 : 0) + (Array.isArray(payload.imageHistory) ? payload.imageHistory.length : 0);
  var chatDisabled = _firstFrameEditor.saving || _firstFrameEditor.generating || _firstFrameEditor.rewriting;

  return '<div class="ffe-modal" role="dialog" aria-modal="true" aria-label="首帧编辑控制台">' +
    '<button type="button" class="ffe-close" data-ffe-action="close" title="关闭"><span class="material-symbols-outlined">close</span></button>' +
    '<div class="ffe-shell">' +
      (warnHtml ? '<div class="ffe-alert-stack">' + warnHtml + '</div>' : '') +
      '<aside class="ffe-column ffe-context-column">' +
        _ffeGenerationContextHtml(payload) +
      '</aside>' +
      '<main class="ffe-center">' +
        _ffePanelHtml('图片展示区域', _ffeImagePreviewEyebrow(payload),
          '<div class="ffe-preview-slot">' +
            '<div class="ffe-preview-stage">' +
              (currentUrl
                ? _ffeImageWithFallbackHtml(currentUrl, { variant: 'preview', alt: '当前首帧', dataAction: 'view-current', dataUrl: currentUrl })
                : '<div class="ffe-image-empty"><span class="material-symbols-outlined">image</span><strong>暂无当前首帧</strong><span>可以先查看系统生成计划</span></div>') +
            '</div>' +
          '</div>' +
          _ffeImageStaleHtml(payload) +
          '<div class="ffe-image-actions">' +
            '<button type="button" class="ffe-action-secondary" data-ffe-action="download-current" data-url="' + escapeHtml(currentUrl) + '"' + (currentUrl ? '' : ' disabled') + '><span class="material-symbols-outlined">download</span><span>下载图片</span></button>' +
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
  var prompt = _ffeCleanDraftText(draft.promptOverride, FFE_PROMPT_OVERRIDE_MAX_CHARS);
  if (prompt) out.promptOverride = prompt;
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
  if (field !== 'promptOverride' && field !== 'negativePromptOverride') return;
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
  auto.touched.promptOverride = false;
  auto.touched.negativePromptOverride = false;
  auto.fieldSaving.promptOverride = false;
  auto.fieldSaving.negativePromptOverride = false;
  auto.fieldStatus.promptOverride = _ffeSavedFieldStatus('promptOverride', payload && payload.draft);
  auto.fieldStatus.negativePromptOverride = _ffeSavedFieldStatus('negativePromptOverride', payload && payload.draft);
}

function _ffeCollectDraft() {
  var root = document.getElementById('firstFrameEditorRoot');
  if (!root) return {};
  var promptEl = root.querySelector('[data-ffe-field="promptOverride"]');
  var negativeEl = root.querySelector('[data-ffe-field="negativePromptOverride"]');
  var payloadDraft = _firstFrameEditor.payload && _firstFrameEditor.payload.draft || {};
  var draft = {};
  var prompt = promptEl ? String(promptEl.value || '').trim() : '';
  var existingDraft = _firstFrameEditor.payload && _firstFrameEditor.payload.draft || {};
  var negative = negativeEl ? String(negativeEl.value || '').trim() : '';
  var auto = _ffeAutoSaveState();
  if (prompt && (existingDraft.promptOverride || (auto.touched && auto.touched.promptOverride))) draft.promptOverride = prompt;
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
  _ffeSetFieldCounter('promptOverride');
  _ffeSetFieldCounter('negativePromptOverride');
  var dirty = _ffeDraftJson(_ffeCollectDraft()) !== (_firstFrameEditor.originalDraftJson || '{}');
  var saving = !!_firstFrameEditor.saving;
  var generating = !!_firstFrameEditor.generating;
  var restoring = !!_firstFrameEditor.restoring;
  var rewriting = !!_firstFrameEditor.rewriting;
  var genBtn = root.querySelector('[data-ffe-action="generate-draft"]');
  var hasSavedDraft = (_firstFrameEditor.originalDraftJson || '{}') !== '{}';
  if (genBtn) genBtn.disabled = generating || restoring || rewriting || (!dirty && !hasSavedDraft);
  Array.prototype.slice.call(root.querySelectorAll('textarea, input, select')).forEach(function (el) {
    var field = el.dataset && el.dataset.ffeField || '';
    var isAutoSavedText = field === 'promptOverride' || field === 'negativePromptOverride';
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
  return ['promptOverride', 'negativePromptOverride'].filter(function (field) {
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
  auto.fieldSaving.promptOverride = fields.indexOf('promptOverride') >= 0;
  auto.fieldSaving.negativePromptOverride = fields.indexOf('negativePromptOverride') >= 0;
  fields.forEach(function (field) { _ffeSetFieldStatus(field, 'saving'); });
}

function _ffeMarkSaveError(fields, message, conflict) {
  var auto = _ffeAutoSaveState();
  auto.errorMessage = message || '保存失败';
  auto.conflict = !!conflict;
  (fields && fields.length ? fields : ['promptOverride', 'negativePromptOverride']).forEach(function (field) {
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
  if (_firstFrameEditor.payload) {
    _firstFrameEditor.payload.draft = resp.draft || null;
    if (resp.sourceHash) _firstFrameEditor.payload.sourceHash = resp.sourceHash;
    if (resp.savedDraftFingerprint) _firstFrameEditor.payload.savedDraftFingerprint = resp.savedDraftFingerprint;
    if (resp.baselineFingerprint) _firstFrameEditor.payload.baselineFingerprint = resp.baselineFingerprint;
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
  auto.fieldSaving.promptOverride = false;
  auto.fieldSaving.negativePromptOverride = false;
  _ffeResetFieldStatusesFromDraft(resp.draft, options.restored === true);
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
  if (auto.forceSaveOnce && !changedFields.length) changedFields = ['promptOverride'];
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

async function _generateFirstFrameFromEditor(allowStale) {
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
  if (!(_firstFrameEditor.payload && _firstFrameEditor.payload.draft)) {
    _ffeSetGenerateBlock('请先编辑提示词或负向词后再重新生成。', { code: 'no_draft' });
    _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
    return;
  }
  var preflightOk = await _ffeEnsureFirstFramePreflightAllowed(gIdx);
  if (!preflightOk) return;

  _firstFrameEditor.generating = true;
  _ffeUpdateDirtyState();
  var retryStale = false;
  try {
    await generateStoryboardSheet(gIdx, {
      applyEditDraft: true,
      allowStaleEditDraft: allowStale === true,
      skipPreflight: true,
      onStartError: function (err) {
        var payload = err && err.payload || {};
        if (payload.code === 'stale_edit_draft' && allowStale !== true) {
          retryStale = true;
          renderImageGrid();
          return true;
        }
        _ffeSetGenerateBlock('重新生成失败：' + _diagnoseApiError(((err && err.message) || err).toString()), {
          code: 'batch_failed',
          reason: payload.code || ''
        });
        _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
        renderImageGrid();
        return true;
      }
    });
    if (retryStale) {
      await generateStoryboardSheet(gIdx, {
        applyEditDraft: true,
        allowStaleEditDraft: true,
        skipPreflight: true,
        onStartError: function (err) {
          var payload = err && err.payload || {};
          _ffeSetGenerateBlock('重新生成失败：' + _diagnoseApiError(((err && err.message) || err).toString()), {
            code: 'retry_failed',
            reason: payload.code || ''
          });
          _renderFirstFrameEditor(_firstFrameEditor.payload, gIdx);
          renderImageGrid();
          return true;
        }
      });
    }
    if (!_firstFrameEditor.generateBlock) {
      await _refreshFirstFrameEditor();
    }
  } finally {
    _firstFrameEditor.generating = false;
    _ffeUpdateDirtyState();
  }
}

async function _ffeApplyRestoreInitialResponse(resp) {
  resp = resp || {};
  if (project.storyboards && project.storyboards[_firstFrameEditor.groupIdx]) {
    delete project.storyboards[_firstFrameEditor.groupIdx].firstFrameEditDraft;
  }
  if (_firstFrameEditor.payload) {
    _firstFrameEditor.payload.draft = null;
    if (resp.sourceHash) _firstFrameEditor.payload.sourceHash = resp.sourceHash;
    if (resp.savedDraftFingerprint) _firstFrameEditor.payload.savedDraftFingerprint = resp.savedDraftFingerprint;
    if (resp.baselineFingerprint) _firstFrameEditor.payload.baselineFingerprint = resp.baselineFingerprint;
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
  if (action === 'retry-autosave') {
    _ffeRetryAutoSaveWithConflictPrompt();
    return;
  }
  if (action === 'restore-initial') {
    _restoreFirstFrameInitial();
    return;
  }
  if (action === 'generate-draft') {
    _generateFirstFrameFromEditor(false);
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
document.addEventListener('input', function (ev) {
  if (ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot')) {
    var field = ev.target.dataset && ev.target.dataset.ffeField || '';
    _ffeMarkDraftFieldTouched(field);
    if (field === 'promptOverride' || field === 'negativePromptOverride') {
      _ffeScheduleAutoSave({ source: 'autosave-input' });
    }
    _ffeUpdateDirtyState();
  }
});
document.addEventListener('change', function (ev) {
  if (ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot')) {
    var field = ev.target.dataset && ev.target.dataset.ffeField || '';
    _ffeMarkDraftFieldTouched(field);
    if (field === 'promptOverride' || field === 'negativePromptOverride') {
      _ffeScheduleAutoSave({ source: 'autosave-change' });
    }
    _ffeUpdateDirtyState();
  }
});
document.addEventListener('compositionstart', function (ev) {
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'promptOverride' && field !== 'negativePromptOverride') return;
  var auto = _ffeAutoSaveState();
  auto.composing = true;
  auto.dirtyAt = null;
  _ffeCancelAutoSaveTimers();
});
document.addEventListener('compositionend', function (ev) {
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'promptOverride' && field !== 'negativePromptOverride') return;
  var auto = _ffeAutoSaveState();
  auto.composing = false;
  auto.dirtyAt = null;
  _ffeMarkDraftFieldTouched(field);
  _ffeScheduleAutoSave({ source: 'autosave-compositionend' });
  _ffeUpdateDirtyState();
});
document.addEventListener('blur', function (ev) {
  if (!(ev.target && ev.target.closest && ev.target.closest('#firstFrameEditorRoot'))) return;
  var field = ev.target.dataset && ev.target.dataset.ffeField || '';
  if (field !== 'promptOverride' && field !== 'negativePromptOverride') return;
  if (_ffeAutoSaveState().composing) return;
  _ffeScheduleAutoSave({ source: 'autosave-blur', immediate: true });
}, true);
window.addEventListener('pagehide', function () {
  _ffeFlushAutoSaveOnPageHide();
});
window.addEventListener('beforeunload', function (ev) {
  if (!_ffeBeforeUnloadHasUnsavedChanges()) return;
  ev.preventDefault();
  ev.returnValue = '';
});
function _ffeCanScrollEditorText(target) {
  return !!(target && target.closest && target.closest('.ffe-chat-panel .ffe-panel-body, .ffe-material-picker-body, .ffe-ref-picker-menu, [data-ffe-field="promptOverride"], [data-ffe-field="negativePromptOverride"], [data-ffe-field="chatInput"]'));
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
    _updateImagesActionButton(getStoryboardGroups());
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
    _updateImagesActionButton(getStoryboardGroups());
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
    // 一概去掉，stale 状态由"生成全部首帧图"按钮文案集中体现。stale 时仍归为"已生成"。
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

function _setTopFirstFrameActionLocked(locked) {
  var actionBar = $("imagesActionBar");
  var btn = $("btnGenAllImages");
  if (actionBar) actionBar.hidden = false;
  if (!btn) return;
  btn.innerHTML = '<span class="material-symbols-outlined text-sm">auto_fix_high</span>生成全部首帧图';
  btn.disabled = !!locked;
  btn.dataset.actionState = locked ? 'locked' : '';
  btn.title = locked ? '镜头计划可用后可生成全部首帧图' : '';
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
  if (isShotLayout && shotListWrap) {
    shotListWrap.querySelectorAll(".shot-storyboard-slot").forEach(function (slot) {
      slot.innerHTML = _shotStoryboardSlotEmptyHtml("等待分镜生成");
    });
    shotListWrap.querySelectorAll(".shot-material-slot").forEach(function (slot) {
      slot.innerHTML = '<div class="shot-material-slot-empty">等待素材匹配</div>';
    });
  }
  if (!project.storyboards) project.storyboards = [];
  var groups = getStoryboardGroups();

  var actionBar = $("imagesActionBar");
  if (actionBar) actionBar.hidden = false;

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var shotLabel = 'SHOT ' + String(group.shotIndices[0]+1).padStart(2,'0');
    if (group.shotIndices.length > 1) shotLabel += '-' + String(group.shotIndices[group.shotIndices.length-1]+1).padStart(2,'0');
    shotLabel += ' · ' + (group.shots[0].shotType || 'Shot');
    // 画面提示词（调试时折叠展示）
    var promptText = group.shots.map(function (s) {
      return s.imagePrompt || '';
    }).filter(function (p) { return p; }).join('\n---\n');

    // 用户主显示：中文画面描述（拼接同组每个镜头的 visual / shotType）
    var visualText = group.shots.map(function (s, _i) {
      var st = s.shotType ? '【' + s.shotType + '】' : '';
      var v = s.visual || s.description || '';
      return (st + v).trim();
    }).filter(function (v) { return v; }).join(' ');

    var shotBriefText = visualText || '';
    var hasShotBrief = !!String(shotBriefText).trim();
    var shotBriefSummary = hasShotBrief ? _sbPromptShort(shotBriefText, 120) : "";
    var firstFrameUrl = _firstFrameImageUrl(sb);

    var card = document.createElement("div");
    card.className = "sb-sheet shots-storyboard-card";
    card.dataset.groupIdx = gIdx;

    card.innerHTML =
      '<div class="shots-storyboard-card-inner">' +
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
	              // 此前这里渲染 stale-badge "需更新" 标签（_isStale("storyboard_" + gIdx) 触发）。
	              // 用户反馈：分镜板顶部"需更新"标签不需要——上游变化提示已经在"生成全部首帧图"
	              // 按钮文案（"更新 N 项需更新"）和顶部 hint 里集中体现，分镜板上的重复标签是冗余。
	              // 老的尾帧建议 badge 已迁移到尾帧卡片顶部 (_tailFrameAdviceBannerHtml),
	              // 这里不再渲染, 避免重复展示。_tailFrameSuggestionBadgeHtml 函数本体
	              // 暂保留, 方便回滚或后续做项目级总览。
	            '</div>' +
            '<p>' + escapeHtml(shotLabel) + ' · ' + group.shots.length + ' 个镜头</p>' +
          '</div>' +
          '<div class="shots-storyboard-card-actions">' +
            _historyBtnHtml(sb, "sb") +
          '</div>' +
        '</div>' +
        '<div class="shots-storyboard-card-body">' +
          '<div class="shots-storyboard-meta">' +
	            (hasShotBrief
	              ? '<div class="shots-brief-box"><span>画面描述</span><p>' + escapeHtml(shotBriefSummary) + '</p></div>'
	              : '<div class="shots-brief-box is-empty"><span>画面描述</span><p>待生成画面描述</p></div>') +
	            _storyboardAssetsHtml(group) +
	            '<div class="sb-prompt-area mt-3" hidden>' +
	              '<textarea class="sb-prompt-edit w-full bg-surface-container-lowest text-[11px] text-on-surface-variant rounded-2xl p-3 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none leading-relaxed" rows="3" data-gidx="' + gIdx + '">' + escapeHtml(promptText) + '</textarea>' +
	            '</div>' +
          '</div>' +
          '<div class="sb-frame-stack">' +
            _storyboardFramePanelHtml('first', sb, gIdx, group) +
            _storyboardFramePanelHtml('tail', sb, gIdx, group) +
          '</div>' +
        '</div>' +
      '</div>';
    if (isShotLayout && shotListWrap) {
      var materialSlot = $("shotMaterialSlot_" + gIdx);
      var assetPanel = card.querySelector(".shot-material-panel-slot");
      if (materialSlot && assetPanel) {
        materialSlot.innerHTML = "";
        materialSlot.appendChild(assetPanel);
      }
      var slot = $("shotStoryboardSlot_" + gIdx) || shotListWrap.querySelector('.shot-storyboard-slot[data-group-idx="' + gIdx + '"]');
      if (slot) {
        slot.innerHTML = "";
        slot.appendChild(card);
      } else {
        grid.appendChild(card);
      }
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
  _ensureShotMaterialPanels(groups);
  _sbCurrentIdx = groups.length ? Math.min(prevIdx, groups.length - 1) : 0;
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
  if (result.needFullRerender) renderImageGrid();
}

function _firstFrameUrl(sb) {
  sb = sb || {};
  return (sb.frames && sb.frames.first && sb.frames.first.url) ||
    sb.firstFrameUrl ||
    sb.imageUrl ||
    sb.url ||
    '';
}

function _isFirstFrameFailed(sb) {
  sb = sb || {};
  var st = String((sb.frames && sb.frames.first && sb.frames.first.status) || sb.firstFrameStatus || '').toLowerCase();
  return st === 'failed' || st === 'error' || !!sb.firstFrameLastError;
}

function _isTailRequested(sb) {
  sb = sb || {};
  return sb.tailFrameIntent === 'requested' || !!_tailFrameImageUrl(sb);
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

function _isFirstFrameStale(gIdx) {
  return !!(project && project._staleFlags && project._staleFlags["storyboard_" + gIdx]);
}

function _computeImagesBatchState(groups, opts) {
  opts = opts || {};
  groups = groups || getStoryboardGroups();
  var missingFirst = [];
  var failedFirst = [];
  var staleFirst = [];
  var staleTail = [];
  var readyFirstCount = 0;
  for (var i = 0; i < groups.length; i++) {
    var sb = (project.storyboards && project.storyboards[i]) || {};
    var hasFirst = !!_firstFrameUrl(sb);
    if (hasFirst) readyFirstCount++;
    if (!hasFirst) missingFirst.push(i);
    if (_isFirstFrameFailed(sb)) failedFirst.push(i);
    if (hasFirst && _isFirstFrameStale(i)) staleFirst.push(i);
    if (_tailNeedsUpdate(sb, i)) staleTail.push(i);
  }
  var staleCount = staleFirst.length + staleTail.length;
  var action = 'generate_all';
  var label = '生成全部首帧图';
  // 状态机：
  //   - generating: 启动中… / 生成中…
  //   - generate_all: 全部缺首帧 → 生成全部首帧图
  //   - retry_failed: 有失败 → 重试失败项·N个
  //   - fill_missing: 部分缺 → 补全 N 个首帧
  //   - regenerate_all: 全部就绪（含 stale-only 场景）→ 重新生成全部首帧图
  // 注：以前有独立的 update_stale 分支，文案"更新 N 项需更新"且只重生 stale 那几张。
  // 用户决策：stale-only 场景统一显示"重新生成全部首帧图"，点击即全量重生（与 regenerate_all 行为一致），
  // 避免按钮文案与"装饰性需更新"挂钩。
  if ((_imagesGenerating || _imagesStarting) && !opts.ignoreGenerating) {
    action = 'generating';
    label = _imagesStarting ? '启动中…' : '生成中…';
  } else if (groups.length > 0 && missingFirst.length === groups.length) {
    action = 'generate_all';
    label = '生成全部首帧图';
  } else if (failedFirst.length > 0) {
    action = 'retry_failed';
    label = '重试失败项·' + failedFirst.length + '个';
  } else if (missingFirst.length > 0) {
    action = 'fill_missing';
    label = '补全 ' + missingFirst.length + ' 个首帧';
  } else if (readyFirstCount > 0) {
    // stale-only 也走这里——staleCount 不再单独分支处理。
    action = 'regenerate_all';
    label = '重新生成全部首帧图';
  }
  // staleCount 仍计算保留供 dispatch 决定要不要顺带刷尾帧（regenerate_all 路径会 null requestedTailIdxMap）
  void staleCount;
  return {
    action: action,
    label: label,
    missingFirst: missingFirst,
    failedFirst: failedFirst,
    staleFirst: staleFirst,
    staleTail: staleTail,
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
  var allFirstFramesReady = _allFirstFramesReady(groups);
  topArea.hidden = false;
  delete topBtn.dataset.confirmMode;
  topBtn.disabled = !allFirstFramesReady;
  topBtn.classList.toggle("opacity-50", !allFirstFramesReady);
  topBtn.classList.toggle("cursor-not-allowed", !allFirstFramesReady);
  topBtn.classList.toggle("shadow-none", !allFirstFramesReady);
  topBtn.classList.toggle("hover:opacity-90", allFirstFramesReady);
  topBtn.classList.toggle("hover:opacity-50", !allFirstFramesReady);
  if (!allFirstFramesReady) {
    topBtn.textContent = "确认分镜图，进入提示词 →";
    topBtn.title = "请先生成全部首帧图";
    return;
  }
  topBtn.textContent = project.imagesApproved
    ? "分镜图已确认，查看视频提示词 →"
    : "确认分镜图，进入提示词 →";
  topBtn.title = "确认所有首帧分镜图并进入视频提示词";
}

function _updateImagesActionButton(groups) {
  var btn = $("btnGenAllImages");
  if (!btn || !project) return;
  groups = groups || getStoryboardGroups();
  var materialBlockMessage = _materialLimitBlockMessage(groups);
  var preflight = _getFirstFramePreflightState(groups);
  var state = _computeImagesBatchState(groups);
  var iconName = state.action === 'retry_failed' ? 'refresh' : 'auto_fix_high';
  // 直接使用 _computeImagesBatchState 计算出的精细 label，让按钮文案与真实状态一致：
  //   - generate_all → 生成全部首帧图
  //   - fill_missing → 补全 N 个首帧
  //   - retry_failed → 重试失败项·N个
  //   - regenerate_all → 重新生成全部首帧图（含 stale-only 场景，全量重生）
  //   - generating → 启动中… / 生成中…
  var label = state.label;
  var preflightBlocked = preflight.status !== "allowed";
  var preflightMessage = preflight.message || "";
  var hint = $("imagesHint");
  btn.innerHTML = '<span class="material-symbols-outlined text-sm">' + iconName + '</span>' + escapeHtml(label);
  btn.disabled = state.action === 'generating' || !!materialBlockMessage || preflightBlocked;
  btn.dataset.actionState = materialBlockMessage ? 'material_limit' : (preflightBlocked ? preflight.status : state.action);
  btn.title = materialBlockMessage || preflightMessage || '';
  if (hint && !_imagesGenerating && !_imagesStarting) {
    hint.textContent = materialBlockMessage || preflightMessage || FIRST_FRAME_DEFAULT_HINT;
  }
}

export function checkImagesConfirm() {
  if (!project || !project.shots) return;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  _syncMergedStoryboardConfirmState(groups);
  _updateImagesActionButton(groups);
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

  updateStoryboardCard(gIdx, "loading", null, "生成视频首帧…");

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
      applyEditDraft: opts.applyEditDraft === true,
      allowStaleEditDraft: opts.allowStaleEditDraft === true,
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
        try { updateStoryboardCard(gIdx, "loading", null, "生成首帧中…约剩 " + remain + " 秒"); } catch (_e) {}
      },
    });
    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() { if (!settled) { settled = true; _stopPoll(); eta.stop(); resolve(); } }
    var finishingFromServer = null;

    function _finishAfterServerSync() {
      if (finishingFromServer) return finishingFromServer;
      finishingFromServer = (async function () {
        await _reloadProjectFromServerForStoryboard(originId);
        var latest = project && project.storyboards && project.storyboards[gIdx];
        var latestUrl = latest && (latest.rawUrl || latest.imageUrl || latest.url);
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

    function _applyResult(rawUrl, extra) {
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
      });
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
            _applyResult(url, extra);
          } else if (t.status === 'failed' && !_gotResult) {
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsgPoll);
            showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsgPoll), "error");
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
        _applyResult(rawUrl, extra);
      },
      onTaskFailed: function (data) {
        var errMsgInner = ((data && data.errorMsg) || "生成失败").toString().slice(0, 120);
        if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsgInner);
        showToast("首帧图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsgInner), "error");
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
      if (isTail) _clearFailedTailFrameLocally(gIdx, errMsg);
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
    });
    renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'done', { imgUrl: displayUrl });
    saveProject();
    showToast(frameLabel + ' #' + (gIdx + 1) + ' 上传成功', 'success');
  } catch (e) {
    var msg = ((e && e.message) || e).toString().slice(0, 200);
    renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'error', { errMsg: msg });
    if (isTail) _clearFailedTailFrameLocally(gIdx, msg);
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

  if (!_canGenerateTailFrame(sb)) {
    sb.tailFrameIntent = "requested";
    sb.tailFrameIntentUpdatedAt = new Date().toISOString();
    sb.tailFrameReferenceStatus = _tailFrameImageUrl(sb) ? "ready" : "missing";
    project.storyboards[gIdx] = sb;
    saveProject();
    renderImageGrid();
    checkImagesConfirm();
    showToast("已标记这段需要尾帧，请先生成彩色首帧", "info");
    return;
  }
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
    });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (project && project.id === originId) {
        renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: '积分不足' });
        _clearFailedTailFrameLocally(gIdx, '积分不足');
      }
      showBillingPaywall(e.billing || null);
      return;
    }
    if (project && project.id === originId) {
      renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errMsg });
      _clearFailedTailFrameLocally(gIdx, errMsg);
    }
    showToast("尾帧 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsg), "error");
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || "未能创建批量任务";
    renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: fErr });
    _clearFailedTailFrameLocally(gIdx, fErr);
    return;
  }

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var _gotResult = false;
    // 尾帧 ETA: initial=60s (尾帧不做多 ref 预处理, 通常比首帧快一点)
    var eta = _startSingleFrameEta({
      initialSec: 60,
      onTick: function (remain) {
        try {
          renderStoryboardFrameCard(gIdx, 'tail', 'loading', { loadingText: '生成尾帧中…约剩 ' + remain + ' 秒' });
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

    function _applyResult(rawUrl, extra) {
      if (!rawUrl || _gotResult) return;
      _gotResult = true;
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _applyFrameImagePatch(existing, rawUrl, extra, group.shotIndices);
        proj.storyboards[gIdx] = existing;
      });
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
            _applyResult(url, extra);
          } else if (t.status === 'failed' && !_gotResult) {
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            if (project && project.id === originId) {
              var synced = await _reloadProjectFromServerForStoryboard(originId);
              if (!synced) _clearFailedTailFrameLocally(gIdx, errMsgPoll);
              var latestSb = project && project.storyboards && project.storyboards[gIdx];
              var errDisplayPoll = _tailFrameErrorDisplay(_tailFrameErrorRecordFromStoryboard(latestSb, errMsgPoll), errMsgPoll);
              renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplayPoll });
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
        _applyResult(rawUrl, extra);
      },
      onTaskFailed: function (data) {
        var extra = (data && data.extra) || {};
        var errMsgInner = ((data && data.errorMsg) || "生成失败").toString().slice(0, 120);
        var errDisplayInner = _tailFrameErrorDisplay(_tailFrameErrorRecordFromExtra(extra, errMsgInner), errMsgInner);
        if (project && project.id === originId) {
          renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplayInner });
          _clearFailedTailFrameLocally(gIdx, errMsgInner, extra);
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
 * 筛选: _canGenerateTailFrame(sb) === true 且 (无尾帧 or 尾帧 failed) 的组。
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
  if (!targets.length) {
    for (var i = 0; i < groups.length; i++) {
      var sb = project.storyboards[i] || {};
      if (!_canGenerateTailFrame(sb)) { skipNoFirst++; continue; }
      var tailUrl = (sb.frames && sb.frames.tail && sb.frames.tail.url) || sb.tailFrameUrl;
      var tailStatus = (sb.frames && sb.frames.tail && sb.frames.tail.status) || '';
      var shouldGen = !tailUrl || tailStatus === 'failed';
      if (shouldGen) {
        targets.push({ groupIdx: i, idx: i, shotIndices: groups[i].shotIndices || [] });
      }
    }
  }
  if (!targets.length) {
    var hintMsg = skipNoFirst > 0
      ? '全部片段已有尾帧, 或缺少彩色首帧 (' + skipNoFirst + ' 个片段跳过)'
      : '全部片段已有尾帧, 无需重新生成';
    showToast(hintMsg, 'info');
    return;
  }
  await _ensureMaterialPanelsForChecks(groups, targets.map(function (t) { return t.groupIdx; }));
  var materialBlockMessage = _materialLimitBlockMessage(groups, targets.map(function (t) { return t.groupIdx; }));
  if (materialBlockMessage) {
    showToast(materialBlockMessage, 'warn');
    renderImageGrid();
    return;
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
      _clearFailedTailFrameLocally(t.groupIdx, errMsg);
    });
    if (btn) btn.disabled = false;
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || '未能创建批量任务';
    showToast(fErr, 'error');
    targets.forEach(function (t) {
      renderStoryboardFrameCard(t.groupIdx, 'tail', 'error', { errMsg: fErr });
      _clearFailedTailFrameLocally(t.groupIdx, fErr);
    });
    if (btn) btn.disabled = false;
    return;
  }

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var completedIdx = Object.create(null);
    var totalCount = targets.length;
    var doneCount = 0;
    var failCount = 0;
    var finishingFromServer = null;

    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() {
      if (settled) return;
      settled = true;
      _stopPoll();
      if (btn) btn.disabled = false;
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
    }
    function _failOne(extra, errMsg) {
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      if (typeof gIdx !== 'number' || completedIdx[gIdx]) return;
      var errDisplay = _tailFrameErrorDisplay(_tailFrameErrorRecordFromExtra(extra, errMsg), errMsg);
      _clearFailedTailFrameLocally(gIdx, errMsg, extra);
      renderStoryboardFrameCard(gIdx, 'tail', 'error', { errMsg: errDisplay });
      completedIdx[gIdx] = 'failed';
      failCount++;
    }

    async function _pollOnce() {
      if (settled) return;
      try {
        var snap = await apiGet('/api/batch/' + encodeURIComponent(startResp.batchId));
        if (!snap || settled) return;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        tasks.forEach(function (t) {
          if (t.status === 'completed') {
            var result = t.result || {};
            var extra = result.extra || {};
            var patch = result.patch || {};
            var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
            if (url) _applyOne(extra, url);
          } else if (t.status === 'failed') {
            var target = t.target || {};
            var extraF = { groupIdx: target.groupIdx };
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            _failOne(extraF, errMsgPoll);
          }
        });
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
  if (_imagesGenerating || _imagesStarting) return;
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
  if (hint) hint.textContent = "正在准备首帧生成…";
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
  if (hint) hint.textContent = "准备生成视频首帧…";
  for (var gi = 0; gi < groups.length; gi++) {
    updateStoryboardCard(gi, "loading", null, "准备首帧…");
  }

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
  var runRequestedTailsAfterFirst = false;
  var requestedTailIdxMap = null; // null = all requested tails (regenerate_all only)
  if (buttonState.action === 'retry_failed') {
    targets = buttonState.failedFirst.map(function (gIdx) {
      return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
    });
  } else if (buttonState.action === 'fill_missing') {
    targets = buttonState.missingFirst.map(function (gIdx) {
      return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
    });
  } else {
    // regenerate_all（含此前独立的 stale-only 场景）：全量重生所有 group 首帧，
    // requestedTailIdxMap=null 让后续 tail 阶段在每个 group 上单独判断 _isTailRequested。
    targets = groups.map(function (g, idx) {
      return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [] };
    });
    runRequestedTailsAfterFirst = buttonState.action === 'regenerate_all';
  }
  if (!targets.length && runRequestedTailsAfterFirst) {
    _imagesGenerating = false;
    _imagesStarting = false;
    if (btn) btn.disabled = false;
    await generateAllTailFrames({
      targets: Object.keys(requestedTailIdxMap || {}).map(function (gIdx) {
        gIdx = Number(gIdx);
        return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
      }),
      buttonId: 'btnGenAllImages',
    });
    checkImagesConfirm();
    return;
  }
  var totalCount = targets.length;
  if (hint) hint.textContent = "正在生成 " + totalCount + " 张首帧图…";
  targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "loading", null, "生成首帧图中…"); });

  // —— 倒计时区域 ——
  // 用户反馈："这个位置改成倒计时吧 还有多久能生成完"。
  // 借用之前给"门控诊断"留的 #sbDiagnostic 容器，生成期间把它改成
  // 动态倒计时（done/total + 估算剩余秒数）；批次结束后清空。
  // 估算逻辑：等真实跑完 1 张以后用实测速度，否则给 70 秒/张的初始猜测
  //（gpt-image medium 实测）；后端并发 4 → 墙钟剩余时间 ≈ pending × avgSec ÷ 4。
  var diagBox = $("sbDiagnostic");
  var etaStartTs = Date.now();
  function _renderEta() {
    if (!diagBox) return;
    var done = doneCount;
    var fail = failCount;
    var pending = Math.max(0, totalCount - done - fail);
    var lines = ["生成中… " + done + "/" + totalCount];
    if (fail > 0) lines.push(fail + " 张失败");
    if (pending > 0) {
      var avg = (done + fail >= 1)
        ? (Date.now() - etaStartTs) / 1000 / (done + fail)
        : 70;
      var remain = Math.ceil(pending * avg / 4);
      lines.push("约剩 " + remain + " 秒");
    }
    diagBox.innerHTML = '<div class="diag-empty" style="text-align:center;padding:8px 0;font-weight:500;color:#475569;">' +
      escapeHtml(lines.join("，")) +
      '</div>';
  }
  function _clearEta() {
    if (!diagBox) return;
    // 批次结束后清空——后续门控诊断面板自己回填（如果有数据的话）
    diagBox.innerHTML = '';
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
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: targets,
    });
  } catch (e) {
    console.error('[generateAllImages] /api/batch/start failed:', e);
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

  var doneCount = 0;
  var failCount = 0;
  var finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    _stopEtaTick();
    _clearEta();
    var done = project.storyboards.filter(function (s) { return s && s.imageUrl; }).length;
    if (hint) hint.textContent = done + "/" + groups.length + " 张首帧图已生成";
    var allSbDone = groups.every(function (_, i) { return project.storyboards[i] && project.storyboards[i].imageUrl; });
    if (allSbDone && groups.length > 0) showToast("全部首帧图已生成", "success");
    if (failCount > 0) showToast(failCount + " 张首帧图生成失败，请手动重试", "warn");
    var requestedTailTargets = [];
    if (runRequestedTailsAfterFirst && failCount === 0) {
      for (var ti = 0; ti < groups.length; ti++) {
        if (requestedTailIdxMap && !requestedTailIdxMap[ti]) continue;
        var tailSb = project.storyboards[ti] || {};
        if (!_isTailRequested(tailSb)) continue;
        if (!_canGenerateTailFrame(tailSb)) continue;
        requestedTailTargets.push({ groupIdx: ti, idx: ti, shotIndices: groups[ti].shotIndices || [] });
      }
    }
    if (requestedTailTargets.length) {
      if (hint) hint.textContent = "正在同步重新生成 " + requestedTailTargets.length + " 张尾帧…";
      generateAllTailFrames({ targets: requestedTailTargets, buttonId: 'btnGenAllImages' })
        .finally(function () {
          _imagesGenerating = false;
          if (btn) btn.disabled = false;
          checkImagesConfirm();
          setTimeout(function () { _checkAndSuggest("images"); }, 1000);
        });
      return;
    }
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    checkImagesConfirm();
    setTimeout(function () { _checkAndSuggest("images"); }, 1000);
  }

  // 已经在本地标记完成的 groupIdx —— polling/SSE 收到重复事件时去重
  var _seenDone = Object.create(null);
  var _seenFailed = Object.create(null);

  function _applyTaskCompleted(groupIdx, rawUrl, extra) {
    if (typeof groupIdx !== 'number' || !rawUrl) return;
    if (_seenDone[groupIdx]) return;  // 已处理过
    _seenDone[groupIdx] = true;
    doneCount++;

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
    });
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

  function _clearFailedStoryboardLocally(groupIdx, errMsg) {
    if (typeof groupIdx !== 'number' || !project) return;
    var msg = (errMsg || '生成失败').toString().slice(0, 500);
    _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      var sb = proj.storyboards[groupIdx] || {};
      // Keep this optimistic client mirror aligned with lib/visual-reference-state.ts markFirstFrameFailed.
      // The next server snapshot remains authoritative; this only prevents the UI from flashing a missing reference.
      var fallbackUrl = (sb.firstFrame && (sb.firstFrame.currentUrl || sb.firstFrame.lastKnownGoodUrl)) || sb.firstFrameUrl || sb.url || sb.imageUrl || sb.rawUrl || "";
      sb.firstFrameLastError = msg;
      sb.firstFrameFailedAt = new Date().toISOString();
      sb.firstFrame = Object.assign({}, sb.firstFrame || {}, {
        currentUrl: fallbackUrl || undefined,
        status: fallbackUrl ? "degraded" : "failed",
        source: fallbackUrl ? "last_known_good" : ((sb.firstFrame && sb.firstFrame.source) || "generated"),
        lastKnownGoodUrl: fallbackUrl || ((sb.firstFrame && sb.firstFrame.lastKnownGoodUrl) || undefined),
        lastError: {
          message: msg,
          failedAt: sb.firstFrameFailedAt
        },
        history: (sb.firstFrame && Array.isArray(sb.firstFrame.history)) ? sb.firstFrame.history : []
      });
      proj.storyboards[groupIdx] = sb;
    });
  }

  /**
   * 本地乐观写 tail 失败态, 对称 _clearFailedStoryboardLocally 但只动 tailFrame* 字段
   * 和 frames.tail, 绝不触碰首帧/主分镜字段。server 端 batches.ts 的 _clearFailedTailFrameImageState
   * 也会写同样一份, 这里只是在 server snapshot 到达前让 UI 立刻切到 failed/degraded 态。
   */
  function _clearFailedTailFrameLocally(groupIdx, errMsg, extra) {
    if (typeof groupIdx !== 'number' || !project) return;
    var errRecord = _tailFrameErrorRecordFromExtra(extra, errMsg);
    var msg = errRecord.message;
    _safeWriteBack(originId, function (proj) {
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
          failedAt: sb.tailFrameFailedAt
        }
      });
      sb.frames = Object.assign({}, sb.frames || {}, { tail: nextTail });
      proj.storyboards[groupIdx] = sb;
    });
  }

  function _applyTaskFailed(groupIdx, errMsg) {
    if (typeof groupIdx !== 'number') return;
    if (_seenFailed[groupIdx] || _seenDone[groupIdx]) return;
    _seenFailed[groupIdx] = true;
    failCount++;
    _clearFailedStoryboardLocally(groupIdx, errMsg);
    updateStoryboardCard(groupIdx, "error", null, (errMsg || '生成失败').toString().slice(0, 120));
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
    _renderEta();
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
      tasks.forEach(function (t) {
        if (t.status === 'completed') {
          var result = t.result || {};
          var extra = result.extra || {};
          var patch = result.patch || {};
          var gIdx = (typeof extra.groupIdx === 'number')
            ? extra.groupIdx
            : ((t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq]);
          var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
          _applyTaskCompleted(gIdx, url, extra);
        } else if (t.status === 'failed') {
          var gIdx2 = (t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq];
          _applyTaskFailed(gIdx2, t.errorMsg);
        }
      });
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
        hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + snap.total;
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
      _applyTaskCompleted(groupIdx, rawUrl, extra);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      _applyTaskFailed(groupIdx, data.errorMsg);
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

export async function confirmImages() {
  if (!project || !project.shots) { showToast("请先生成首帧图", "warn"); return; }

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
  var stale = groups.filter(function (_, i) { return _isStale("storyboard_" + i); });
  if (stale.length) {
    showToast("还有 " + stale.length + " 张分镜图已过期，请先重新生成", "warn");
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
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;

  if (action === "edit-first-frame") {
    var editGIdx = parseInt(btn.dataset.gidx, 10);
    if (!isNaN(editGIdx)) _openFirstFrameEditor(editGIdx);
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
    _openHistoryPopover(btn, sbItem, function (hi) {
      if (_setHistoryAsCurrent(sbItem, hi)) {
        saveProject();
        renderImageGrid();
        showToast("已恢复到历史版本", "ok");
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
    if (!project.storyboards) project.storyboards = [];
    var oldSb = project.storyboards[gIdx];
    if (oldSb) _archiveOldImage(oldSb, "storyboard");
    project.storyboards[gIdx] = oldSb && Array.isArray(oldSb.imageHistory) && oldSb.imageHistory.length
      ? { imageHistory: oldSb.imageHistory }
      : null;
    saveProject();
    generateStoryboardSheet(gIdx, { skipPreflight: true }).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    });
  } else if (action === "accept-tail-suggestion") {
    _acceptTailFrameSuggestion(gIdx);
  } else if (action === "confirm-tail-advice-override") {
    // 负向状态 (不建议使用尾帧) 仍允许用户强制走尾帧, 但要弹一道确认,
    // 避免用户误点 banner。确认后复用 accept-tail-suggestion 的全流程。
    showConfirm(
      '仍要生成尾帧？',
      '系统不建议本段使用尾帧 (镜头偏简单或时长偏短)。若仍坚持生成，可能影响视频画面控制。',
      function () {
        _acceptTailFrameSuggestion(gIdx);
      },
    );
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
    var sb = project.storyboards && project.storyboards[gIdx];
    var firstUrl = _firstFrameImageUrl(sb);
    if (firstUrl) {
      var a = document.createElement("a");
      a.href = firstUrl;
      a.download = "storyboard_" + (gIdx + 1) + ".png";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } else if (action === "download-tail") {
    var sbTail = project.storyboards && project.storyboards[gIdx];
    var tailUrl = _tailFrameImageUrl(sbTail);
    if (tailUrl) {
      var tailA = document.createElement("a");
      tailA.href = tailUrl;
      tailA.download = "storyboard_" + (gIdx + 1) + "_tail.png";
      tailA.target = "_blank";
      document.body.appendChild(tailA);
      tailA.click();
      tailA.remove();
    }
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
