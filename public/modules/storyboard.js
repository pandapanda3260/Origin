import { $, escapeHtml, showToast, apiPost, apiPostStream, apiGet,
  consumeStreamStepTags, ApiError, hydrateProtectedImageElements } from './utils.js';
import { attachDiagnostic } from './diagnostic.js';
import { renderStoryboardCard, renderStoryboardFrameCard } from './render_hooks.js';
import { subscribeBatch } from './backend_stream.js';
import { showBillingPaywall } from './billing.js';

let _ctx = {};
let project = null;

var _imagesGenerating = false;
var _promptsConverting = false;
var IMG_PARALLEL = 3;
var MAX_SHOTS_PER_GROUP = 5;
var _sbCurrentIdx = 0;
var _sbProgrammaticScrolling = false;
var _sbScrollSettleTimer = null;

export function initStoryboard(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncStoryboardProject(p) {
  project = p || null;
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
function _checkAndSuggest(stage) { if (_ctx.checkAndSuggest) _ctx.checkAndSuggest(stage); }
function _archiveOldImage(item, source) { if (_ctx.archiveOldImage) _ctx.archiveOldImage(item, source); }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function _openLightbox(url) { if (_ctx.openLightbox) _ctx.openLightbox(url); }
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

function _storyboardFramePanelHtml(kind, sb, gIdx) {
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
    buttons += _frameButtonHtml('upgrade-first-frame', gIdx, 'upgrade', '先升级首帧', '重新生成彩色首帧, 升级后可生成尾帧', 'primary', false);
  } else {
    buttons += _frameButtonHtml(isTail ? 'upload-tail' : 'upload-first', gIdx, 'upload', '上传', isTail ? '手动上传一张已有尾帧图' : '手动上传一张已有首帧图', 'secondary', false);
    if (hasImg) buttons += _frameButtonHtml(isTail ? 'download-tail' : 'download-sb', gIdx, 'download', '下载', isTail ? '下载尾帧' : '下载首帧', 'secondary', false);
    buttons += _frameButtonHtml(canPrimary ? primaryAction : '', gIdx, primaryIcon, primaryText, primaryTitle, 'primary', !canPrimary);
    // Tail-only: 删除按钮 = 清图 + 清意图。只有"已生成尾帧"或"已请求但尚未生成"才暴露该按钮。
    if (isTail && (hasImg || sb.tailFrameIntent === 'requested')) {
      buttons += _frameButtonHtml('delete-tail', gIdx, 'delete', '删除', '删除该尾帧并清除"需要尾帧"的意图（下次批量重做不会再生成）', 'secondary', false);
    }
  }

  // Tail-only: 过期 / 不可解析 徽章。用独立小 badge 贴在 header statusText 旁边，
  // 方便用户一眼看到"视频生成前必须处理此项"。
  var tailBadgesHtml = '';
  if (isTail) {
    var tailRefStatus = String(sb.tailFrameReferenceStatus || '').toLowerCase();
    var tailNeedsUpdate = _tailNeedsUpdate(sb, gIdx);
    if (tailRefStatus === 'unresolvable') {
      tailBadgesHtml += '<span class="shrink-0 ml-1 px-2 py-0.5 rounded-full text-[9px] font-black tracking-widest uppercase bg-error/10 text-error border border-error/20" title="尾帧文件在服务器上已不可解析，视频生成会降级到首帧+多图通道">文件不可解析</span>';
    }
    if (tailNeedsUpdate && hasImg && tailRefStatus !== 'unresolvable') {
      tailBadgesHtml += '<span class="shrink-0 ml-1 px-2 py-0.5 rounded-full text-[9px] font-black tracking-widest uppercase bg-amber-100 text-amber-700 border border-amber-200" title="镜头或首帧已变更，当前尾帧可能过期，建议重新生成">需更新</span>';
    }
  }

  return '<div data-frame="' + kind + '" class="sb-frame-panel min-h-0 flex flex-col rounded-3xl overflow-hidden border border-outline-variant/10 bg-white/55 shadow-inner">' +
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
           '<div class="relative flex-1 min-h-[180px] bg-surface-container overflow-hidden">' +
             imgHtml +
             '<div class="sb-frame-loading absolute inset-0 flex items-center justify-center bg-white/95 backdrop-blur-sm" hidden>' +
               '<div class="inline-block w-5 h-5 border-2 border-primary/20 border-t-primary rounded-full animate-spin"></div>' +
               '<span class="text-[10px] ml-2 text-on-surface-variant">生成中…</span>' +
             '</div>' +
             errorHtml +
             '<div class="absolute right-3 bottom-3 flex items-center justify-end gap-2 flex-wrap max-w-[calc(100%-1.5rem)]">' + buttons + '</div>' +
           '</div>' +
         '</div>';
}

/* ================================================================
   Storyboard groups
   ================================================================ */
export function getStoryboardGroups() {
  if (!project || !project.shots) return [];
  var shots = project.shots;
  var hasGroupBoundary = shots.some(function (s) { return s.groupBoundary; });
  var rawGroups = [];

  if (!hasGroupBoundary) {
    // 按情绪段切组：同 emotion 连续的镜头放一组，emotion 变化就切；
    // 单组上限放到 4——分镜稿一张图最多画 2x2 四格，超过 4 个镜头时另起一组。
    // 之前 cap=3 会导致出现 3 格不规则布局，原网站只用 1×2 或 2×2 两种。
    var bucket = [];
    var bucketIndices = [];
    var bucketEmotion = null;
    var flush = function () {
      if (!bucket.length) return;
      rawGroups.push({
        shotIndices: bucketIndices.slice(),
        shots: bucket.slice(),
        emotion: bucketEmotion || 'general',
      });
      bucket = [];
      bucketIndices = [];
    };
    shots.forEach(function (shot, idx) {
      var em = shot.emotion || 'general';
      if (bucketEmotion === null) bucketEmotion = em;
      var emotionChanged = (em !== bucketEmotion);
      var bucketFull = (bucket.length >= 4);
      if (emotionChanged || bucketFull) {
        flush();
        bucketEmotion = em;
      }
      bucket.push(shot);
      bucketIndices.push(idx);
    });
    flush();
  } else {
    var curShots = [];
    var curIndices = [];
    shots.forEach(function (shot, idx) {
      curShots.push(shot);
      curIndices.push(idx);
      if (shot.groupBoundary || idx === shots.length - 1) {
        rawGroups.push({
          shotIndices: curIndices.slice(),
          shots: curShots.slice(),
          emotion: shot.emotion || "general"
        });
        curShots = [];
        curIndices = [];
      }
    });
  }

  // —— Normalize 阶段 ——
  // 用户要求："分镜图的排布要么 2 张要么 4 张 不要 3 张的"。这里把所有
  // 大小为 1 / 3 / >4 的分组拆并合并成清一色的 4 / 2（必要时单尾允许 1）。
  // 算法：把所有 raw groups 拍平成镜头序列（保留情绪标记），然后贪心切片：
  //   - 剩余 ≥ 4 → 切 4
  //   - 剩余 == 3 → 切 2 + 留 1（让下一轮处理；最终单尾才允许 1 格）
  //   - 剩余 == 2 → 切 2
  //   - 剩余 == 1 → 单格（仅在最后一格，无法和前一组并入时出现）
  // 同时尽量按情绪边界对齐：贪心时如果第 4 张和第 1 张情绪相差太远，优先
  // 切 2 而不是切 4——避免一张分镜稿里前后情绪拧得太别扭。
  var flat = [];
  rawGroups.forEach(function (g) {
    g.shotIndices.forEach(function (si, i) {
      flat.push({ idx: si, shot: g.shots[i], emotion: g.emotion });
    });
  });

  // 视频片段分组只看导演计划：同一情绪段内尽量合并，但保持片段可控。
  // 片段计划时长 = 组内 shot.duration 之和；台词字数只在视频生成前做质量提醒，
  // 不再反向决定 5s/10s 档位，也不在这里触发隐藏拆分。
  var MAX_SHOTS_PER_GROUP = 4;
  var MAX_GROUP_DURATION_SEC = 10;

  // 第一步：按情绪段切成 emotion buckets
  var emoBuckets = [];
  var curBucket = [];
  var curEm = null;
  flat.forEach(function (item) {
    if (curEm === null) curEm = item.emotion;
    if (item.emotion !== curEm) {
      if (curBucket.length) emoBuckets.push({ items: curBucket, emotion: curEm });
      curBucket = [item];
      curEm = item.emotion;
    } else {
      curBucket.push(item);
    }
  });
  if (curBucket.length) emoBuckets.push({ items: curBucket, emotion: curEm });

  // 第二步：每个情绪 bucket 内部贪心打包，受计划时长和分镜格数约束
  var groups = [];
  emoBuckets.forEach(function (eb) {
    var items = eb.items;
    if (!items.length) return;

    var curItems = [];
    var curDur = 0;
    var flush = function () {
      if (!curItems.length) return;
      groups.push({
        groupIdx: groups.length,
        shotIndices: curItems.map(function (x) { return x.idx; }),
        shots: curItems.map(function (x) { return x.shot; }),
        emotion: eb.emotion,
      });
      curItems = [];
      curDur = 0;
    };

    items.forEach(function (item) {
      var shot = item.shot;
      var dur = Number(shot.duration || shot.durationSec || 4) || 4;

      // 单个镜头自己就超出建议片段时长：独占一组，尊重镜头表计划。
      if (dur > MAX_GROUP_DURATION_SEC) {
        flush();
        curItems = [item];
        curDur = dur;
        flush();
        return;
      }

      var wouldExceed =
        curDur + dur > MAX_GROUP_DURATION_SEC ||
        curItems.length >= MAX_SHOTS_PER_GROUP;

      if (wouldExceed) flush();
      curItems.push(item);
      curDur += dur;
    });

    flush();
  });

  return groups;
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

/* ================================================================
   Images page
   ================================================================ */
export function refreshImagesPage() {
  _syncRefs();
  var needShots = $("imagesNeedShots");
  var ready = $("imagesReady");
  var actionBar = $("imagesActionBar");
  if (!project || !project.shotsApproved || !project.shots || !project.shots.length) {
    if (needShots) needShots.hidden = false;
    if (ready) ready.hidden = true;
    if (actionBar) actionBar.hidden = true;
    var ig = $("imageGrid"); if (ig) ig.innerHTML = "";
    return;
  }
  needShots.hidden = true;
  ready.hidden = false;
  renderImageGrid();
  checkImagesConfirm();
}

/* ── Step A: AI prompt generation ── */

export function renderPromptPreviewList() {
  _syncRefs();
  var list = $("promptPreviewList");
  if (!list || !project || !project.shots) return;
  list.innerHTML = "";
  project.shots.forEach(function (shot, idx) {
    var card = document.createElement("div");
    card.className = "prompt-preview-card" + (shot.imagePromptGenerated ? " is-done" : "");
    card.dataset.shotIdx = idx;
    var isPromptStale = _isStale("shot_prompt_" + idx);
    var statusHtml = '';
    if (shot.imagePromptGenerated && isPromptStale) statusHtml = '<span class="prompt-preview-status stale-warn">&#9888; 需更新</span>';
    else if (shot.imagePromptGenerated) statusHtml = '<span class="prompt-preview-status ok">&#10003; 已生成</span>';
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

export function renderImageGrid() {
  _syncRefs();
  var grid = $("imageGrid");
  if (!grid || !project || !project.shots) return;
  var prevScrollLeft = grid.scrollLeft || 0;
  var prevIdx = _sbCurrentIdx || 0;
  grid.innerHTML = "";
  if (!project.storyboards) project.storyboards = [];
  var groups = getStoryboardGroups();

  var actionBar = $("imagesActionBar");
  if (actionBar) actionBar.hidden = false;

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var shotLabel = 'SHOT ' + String(group.shotIndices[0]+1).padStart(2,'0');
    if (group.shotIndices.length > 1) shotLabel += '-' + String(group.shotIndices[group.shotIndices.length-1]+1).padStart(2,'0');
    shotLabel += ' · ' + (group.shots[0].shotType || 'Shot');
    var groupEmotion = group.emotion || (group.shots[0] && group.shots[0].emotion) || "";
    var groupIntensity = 3;
    if (group.shots.length) {
      var total = 0;
      group.shots.forEach(function (s) { total += (s.intensity || 3); });
      groupIntensity = Math.round(total / group.shots.length);
    }
    var emotionTag = groupEmotion ? emotionBadgeHtml(groupEmotion, groupIntensity) : "";

    // 英文 prompt（仅给图像模型用，调试时折叠展示）
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

    var card = document.createElement("div");
    card.className = "sb-sheet flex-none w-[75vw] md:w-[65vw] lg:w-[60vw] h-full snap-center-custom flex flex-col";
    card.dataset.groupIdx = gIdx;

    card.innerHTML =
      '<div class="flex-1 bg-surface-container-lowest/40 backdrop-blur-xl rounded-[2.5rem] border border-white/30 overflow-hidden shadow-2xl transition-transform duration-500 hover:scale-[1.005] group relative">' +
        // 用户反馈："生成分镜图的时候 前面图还在 然后生成失败"——之前 loading
        // 用 bg-white/60 半透明，老图透出来；现在改成完全不透明，再生成时
        // 用户看到的就是干净的 loading 状态而不是"老图 + 一层蒙版"。
        '<div class="sb-sheet-loading absolute inset-0 flex items-center justify-center bg-white z-30 rounded-[2.5rem]" hidden>' +
          '<div class="text-center">' +
            '<div class="inline-block w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin mb-3"></div>' +
            '<span class="block text-xs font-bold text-on-surface-variant">生成中…</span>' +
          '</div>' +
        '</div>' +
        // 错误态也改成全屏不透明卡片，覆盖老图。失败时用户能立刻看到红色提示
        // 而不是"老图依旧 + 底部一行小字"。
        '<div class="sb-sheet-error absolute inset-0 flex flex-col items-center justify-center bg-white z-30 rounded-[2.5rem] p-8 text-center" hidden>' +
          '<span class="material-symbols-outlined text-5xl text-error mb-3">error_outline</span>' +
          '<span class="text-sm font-bold text-error mb-2">首帧图生成失败</span>' +
          '<span class="sb-error-msg text-xs text-on-surface-variant/80 max-w-md leading-relaxed"></span>' +
          '<span class="text-[10px] text-on-surface-variant/40 mt-4">点击下方「重新生成」可再次尝试</span>' +
        '</div>' +
        '<div class="absolute inset-0 p-8 flex flex-col">' +
          '<div class="flex items-center justify-between mb-5">' +
            '<div class="flex items-center gap-4">' +
              '<span class="px-3 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase tracking-[0.2em] rounded-full border border-primary/20">' +
                'Scene ' + String(gIdx+1).padStart(2,'00') +
              '</span>' +
              '<span class="text-lg font-bold tracking-tight text-on-background">分镜板 ' + (gIdx+1) + '</span>' +
              (_isStale("storyboard_" + gIdx) ? '<span class="stale-badge" title="前序内容已修改，建议重新生成">需更新</span>' : '') +
              '<span class="text-xs text-on-surface-variant/50 font-medium">' + group.shots.length + ' Shots</span>' +
              emotionTag +
              _tailFrameSuggestionBadgeHtml(group, sb, gIdx) +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              '<span class="text-[10px] text-on-surface-variant/30 font-bold tracking-widest uppercase">' + group.shots.length + ' shots</span>' +
            '</div>' +
          '</div>' +
          '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0">' +
            _storyboardFramePanelHtml('first', sb, gIdx) +
            _storyboardFramePanelHtml('tail', sb, gIdx) +
          '</div>' +
          '<div class="mt-5 min-h-0 shrink-0">' +
            '<div class="flex items-center gap-3 mb-2">' +
              '<span class="text-[12px] font-black uppercase tracking-widest text-primary">' + escapeHtml(shotLabel) + '</span>' +
              '<div class="h-px flex-1 bg-outline-variant/20"></div>' +
            '</div>' +
            (hasShotBrief
              ? '<div class="mb-4 max-w-full rounded-2xl bg-white/35 border border-outline-variant/10 px-3 py-2">' +
                  '<div class="flex items-start gap-2 text-[11px] leading-relaxed text-on-surface-variant/70 font-medium">' +
                    '<span class="text-[10px] font-black tracking-widest uppercase text-primary/55 shrink-0 leading-relaxed">画面描述</span>' +
                    '<span class="line-clamp-2">' + escapeHtml(shotBriefSummary) + '</span>' +
                  '</div>' +
                '</div>'
              : '<p class="text-[11px] leading-relaxed text-on-surface-variant/60 font-medium mb-4">待生成画面描述</p>') +
            '<div class="flex items-center gap-2 flex-wrap">' +
              '<button type="button" class="w-9 h-9 rounded-full bg-surface-container-lowest/70 flex items-center justify-center hover:bg-white transition-colors" data-action="ref-agent-sb" title="引用到 AI 助手"><span class="material-symbols-outlined text-sm text-on-surface-variant">alternate_email</span></button>' +
              _historyBtnHtml(sb, "sb") +
              '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-white/60 hover:bg-white/90 text-on-surface-variant rounded-full text-[10px] font-bold tracking-widest uppercase transition-all active:scale-95 border border-outline-variant/20" data-action="regen-sb-prompt">' +
                '<span class="material-symbols-outlined text-sm">auto_fix_high</span>重写画面指令' +
              '</button>' +
              (promptText
                ? '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-white/60 hover:bg-white/90 text-on-surface-variant rounded-full text-[10px] font-bold tracking-widest uppercase transition-all active:scale-95 border border-outline-variant/20 sb-toggle-prompt">' +
                    '<span class="material-symbols-outlined text-sm">edit_note</span>编辑画面指令' +
                  '</button>'
                : '') +
            '</div>' +
            '<div class="sb-prompt-area mt-3" hidden>' +
              '<textarea class="sb-prompt-edit w-full bg-surface-container-lowest text-[11px] text-on-surface-variant rounded-2xl p-3 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none leading-relaxed" rows="3" data-gidx="' + gIdx + '">' + escapeHtml(promptText) + '</textarea>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    grid.appendChild(card);
  });

  grid.querySelectorAll(".sb-prompt-edit").forEach(function (ta) {
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

  grid.querySelectorAll(".sb-toggle-prompt").forEach(function (btn) {
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
  hydrateProtectedImageElements(grid);
  _sbCurrentIdx = groups.length ? Math.min(prevIdx, groups.length - 1) : 0;
  _updateNavDots(groups.length);
  if (prevScrollLeft > 0) {
    requestAnimationFrame(function () {
      var maxScrollLeft = Math.max(0, grid.scrollWidth - grid.clientWidth);
      grid.scrollLeft = Math.min(prevScrollLeft, maxScrollLeft);
      _syncNavFromScroll(grid);
    });
  }
}

function _initGalleryDrag(container) {
  if (!container || container.dataset.dragInited === "1") return;
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

function _tailNeedsUpdate(sb, gIdx) {
  if (!_isTailRequested(sb)) return false;
  if (project && project._staleFlags && project._staleFlags["tail_frame_" + gIdx]) return true;
  var tail = (sb.frames && sb.frames.tail) || null;
  var status = String((tail && tail.status) || '').toLowerCase();
  var refStatus = String(sb.tailFrameReferenceStatus || (tail && tail.referenceStatus) || '').toLowerCase();
  if (!_tailFrameImageUrl(sb)) return true;
  if (status === 'failed') return true;
  if (refStatus === 'missing' || refStatus === 'unresolvable') return true;
  return !(sb.tailFrameSourceHash || (tail && tail.sourceHash));
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
  var label = '一键生成全部';
  if (_imagesGenerating && !opts.ignoreGenerating) {
    action = 'generating';
    label = '生成中…';
  } else if (groups.length > 0 && missingFirst.length === groups.length) {
    action = 'generate_all';
    label = '一键生成全部';
  } else if (failedFirst.length > 0) {
    action = 'retry_failed';
    label = '重试失败项 (' + failedFirst.length + ')' + (staleCount ? ' · 另有 ' + staleCount + ' 项需更新' : '');
  } else if (missingFirst.length > 0) {
    action = 'fill_missing';
    label = '补全 ' + missingFirst.length + ' 个首帧';
  } else if (staleCount > 0) {
    action = 'update_stale';
    label = '更新 ' + staleCount + ' 项需更新';
  } else if (readyFirstCount > 0) {
    action = 'regenerate_all';
    label = '重新生成全部';
  }
  return {
    action: action,
    label: label,
    missingFirst: missingFirst,
    failedFirst: failedFirst,
    staleFirst: staleFirst,
    staleTail: staleTail,
  };
}

function _updateImagesActionButton(groups) {
  var btn = $("btnGenAllImages");
  if (!btn || !project) return;
  var state = _computeImagesBatchState(groups);
  var iconName = state.action === 'retry_failed' ? 'refresh' : 'auto_fix_high';
  btn.innerHTML = '<span class="material-symbols-outlined text-sm">' + iconName + '</span>' + escapeHtml(state.label);
  btn.disabled = state.action === 'generating';
  btn.dataset.actionState = state.action;
}

export function checkImagesConfirm() {
  var area = $("imagesConfirmArea");
  if (!area || !project || !project.shots) return;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var allDone = groups.length > 0 && groups.every(function (_, i) {
    return project.storyboards[i] && project.storyboards[i].imageUrl;
  });
  area.hidden = !allDone;
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
export async function generateStoryboardSheet(gIdx) {
  if (!project) return;
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  var originId = project.id;

  var hasSomePrompt = group.shots.some(function (s) { return s.imagePrompt || s.visual; });
  if (!hasSomePrompt) {
    updateStoryboardCard(gIdx, "error", null, "该组镜头无描述，请先完成 AI 生成或镜头设计");
    return;
  }

  updateStoryboardCard(gIdx, "loading", null, "生成视频首帧…");

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
    });
  } catch (e) {
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
    renderStoryboardFrameCard(gIdx, isTail ? 'tail' : 'first', 'done', { imgUrl: url });
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

  var btn = opts.buttonId ? $(opts.buttonId) : $("btnGenAllTailFrames");
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

/**
 * 批量升级 legacy_pencil 首帧为彩色 structured_v1 (P2.5b 遗留)。
 * 筛选条件:
 *   - firstFrameMode === 'legacy_pencil'
 *   - shotIndices 与当前分组匹配 (分组已变的 legacy 片段不在此处升级, 避免
 *     写错位; 用户需要走"一键生成全部分镜图")
 * 提交 batchType:'storyboard_images', 后端自然产出 structured_v1; 升级后尾帧
 * 按钮自然 enable。复用 _imagesGenerating 全局锁, 和 generateAllImages 互斥。
 */
export async function upgradeLegacyFirstFrames() {
  if (_imagesGenerating) { showToast('正在生成中，请稍候', 'warn'); return; }
  if (!project) return;
  if (!project.storyboards) project.storyboards = [];
  var originId = project.id;
  var groups = getStoryboardGroups();

  var targets = [];
  var mismatched = 0;
  for (var i = 0; i < groups.length; i++) {
    var sb = project.storyboards[i] || {};
    if (String(sb.firstFrameMode || '') !== 'legacy_pencil') continue;
    var savedSi = Array.isArray(sb.shotIndices) ? sb.shotIndices : null;
    var newSi = groups[i].shotIndices || [];
    var match = savedSi && savedSi.length === newSi.length
      && savedSi.every(function (v, j) { return v === newSi[j]; });
    if (!match) { mismatched++; continue; }
    targets.push({ groupIdx: i, idx: i, shotIndices: newSi });
  }

  if (!targets.length) {
    var emptyMsg = mismatched > 0
      ? '有 ' + mismatched + ' 个 legacy 片段因分组已变, 请用"一键生成全部分镜图"重跑'
      : '没有找到 legacy_pencil 首帧, 无需升级';
    showToast(emptyMsg, 'info');
    return;
  }

  _imagesGenerating = true;
  var btn = $('btnUpgradeLegacyFirstFrames');
  var btnAll = $('btnGenAllImages');
  if (btn) btn.disabled = true;
  if (btnAll) btnAll.disabled = true;

  // 清掉每个 legacy slot (保留 history 用于 show-history), 防止旧手稿图影响新首帧的 diff
  targets.forEach(function (t) {
    var oldSb = project.storyboards[t.groupIdx];
    if (oldSb) _archiveOldImage(oldSb, 'storyboard');
    project.storyboards[t.groupIdx] = oldSb && Array.isArray(oldSb.imageHistory) && oldSb.imageHistory.length
      ? { imageHistory: oldSb.imageHistory }
      : null;
    updateStoryboardCard(t.groupIdx, 'loading', null, '升级首帧中…');
  });
  saveProject();

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: targets,
    });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      showBillingPaywall(e.billing || null);
    } else {
      showToast('升级启动失败: ' + _diagnoseApiError(errMsg), 'error');
    }
    targets.forEach(function (t) {
      updateStoryboardCard(t.groupIdx, 'error', null, errMsg);
    });
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    if (btnAll) btnAll.disabled = false;
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || '未能创建批量任务';
    showToast(fErr, 'error');
    targets.forEach(function (t) {
      updateStoryboardCard(t.groupIdx, 'error', null, fErr);
    });
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    if (btnAll) btnAll.disabled = false;
    return;
  }

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var completedIdx = Object.create(null);
    var totalCount = targets.length;
    var doneCount = 0;
    var failCount = 0;

    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() {
      if (settled) return;
      settled = true;
      _stopPoll();
      _imagesGenerating = false;
      if (btn) btn.disabled = false;
      if (btnAll) btnAll.disabled = false;
      if (failCount === 0) {
        showToast('升级完成: ' + doneCount + ' 个首帧已转为 structured_v1, 可生成尾帧', 'success');
      } else if (failCount === totalCount) {
        showToast('升级全部失败', 'error');
      } else {
        showToast('升级: 成功 ' + doneCount + ', 失败 ' + failCount, 'warn');
      }
      try { renderImageGrid(); } catch (_) {}
      resolve();
    }

    function _applyOne(extra, rawUrl) {
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      if (typeof gIdx !== 'number' || completedIdx[gIdx]) return;
      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _archiveOldImage(existing, 'storyboard');
        _applyFrameImagePatch(existing, rawUrl, extra, null);
        proj.storyboards[gIdx] = existing;
      });
      updateStoryboardCard(gIdx, 'done', rawUrl);
      completedIdx[gIdx] = 'done';
      doneCount++;
    }
    function _failOne(extra, errMsg) {
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      if (typeof gIdx !== 'number' || completedIdx[gIdx]) return;
      updateStoryboardCard(gIdx, 'error', null, errMsg);
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
            var errMsgPoll = (t.errorMsg || '升级失败').toString().slice(0, 120);
            _failOne(extraF, errMsgPoll);
          }
        });
        if (snap.status === 'completed' || snap.status === 'failed' ||
            snap.status === 'cancelled' || snap.status === 'partial') {
          finish();
        }
      } catch (e) {
        console.warn('[LegacyUpgrade-all] poll failed:', (e && e.message) || e);
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
        var errMsgInner = ((data && data.errorMsg) || '升级失败').toString().slice(0, 120);
        _failOne(extra, errMsgInner);
      },
      onBatchCompleted: function () { finish(); },
      onClose: function () { /* polling 兜底 */ },
    });
  });
}

export async function generateAllImages() {
  if (_imagesGenerating) return;
  if (!project || !project.shots || !project.shots.length) return;
  _imagesGenerating = true;
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  if (btn) btn.disabled = true;
  if (!project.storyboards) project.storyboards = [];

  var originId = project.id;
  var groups = getStoryboardGroups();

  // Step 1：多参首帧模式直接由后端基于 visual + 资产上下文组装首帧 prompt。
  // 这里不再预生成旧的黑白铅笔 storyboard prompt，避免浪费 token，也避免
  // 后续视频兜底时被黑白/手绘语义污染。
  if (hint) hint.textContent = "准备生成视频首帧…";
  for (var gi = 0; gi < groups.length; gi++) {
    updateStoryboardCard(gi, "loading", null, "准备首帧…");
  }

  // 重新取最新 project，避免进入批处理前拿到旧分组状态。
  _syncRefs();
  groups = getStoryboardGroups();

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
  } else if (buttonState.action === 'update_stale') {
    targets = buttonState.staleFirst.map(function (gIdx) {
      return { groupIdx: gIdx, idx: gIdx, shotIndices: groups[gIdx].shotIndices || [] };
    });
    requestedTailIdxMap = Object.create(null);
    buttonState.staleTail.forEach(function (gIdx) { requestedTailIdxMap[gIdx] = true; });
    buttonState.staleFirst.forEach(function (gIdx) {
      var sb = (project.storyboards && project.storyboards[gIdx]) || {};
      if (_isTailRequested(sb)) requestedTailIdxMap[gIdx] = true;
    });
    runRequestedTailsAfterFirst = Object.keys(requestedTailIdxMap).length > 0;
  } else {
    targets = groups.map(function (g, idx) {
      return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [] };
    });
    runRequestedTailsAfterFirst = buttonState.action === 'regenerate_all';
  }
  if (!targets.length && runRequestedTailsAfterFirst) {
    _imagesGenerating = false;
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
    } else {
      if (hint) hint.textContent = "启动失败：" + ((e && e.message) || e);
      showToast("批量生成启动失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "error", null, "启动失败"); });
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
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

export function confirmImages() {
  if (!project || !project.shots) { showToast("请先生成首帧图", "warn"); return; }
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var missing = groups.filter(function (_, i) { return !project.storyboards[i] || !project.storyboards[i].imageUrl; });
  if (missing.length) { showToast("还有 " + missing.length + " 张分镜板未生成", "warn"); return; }
  project.imagesApproved = true;
  project.currentStep = Math.max(project.currentStep, 5);
  saveProject();
  switchPage("prompts");
}

export function handleImageAction(e) {
  if (!project) return;
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;

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
    if (!project.storyboards) project.storyboards = [];
    var oldSb = project.storyboards[gIdx];
    if (oldSb) _archiveOldImage(oldSb, "storyboard");
    project.storyboards[gIdx] = oldSb && Array.isArray(oldSb.imageHistory) && oldSb.imageHistory.length
      ? { imageHistory: oldSb.imageHistory }
      : null;
    saveProject();
    generateStoryboardSheet(gIdx).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    });
  } else if (action === "accept-tail-suggestion") {
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
  } else if (action === "upgrade-first-frame") {
    // legacy_pencil 首帧升级: 重跑 storyboard_images batch, 后端会写 structured_v1,
    // 升级成功后尾帧按钮自然 enable。复用 generateStoryboardSheet 的单片段路径。
    if (_imagesGenerating) { showToast("正在生成中，请稍候", "warn"); return; }
    if (!project.storyboards) project.storyboards = [];
    var oldSbUpg = project.storyboards[gIdx];
    if (oldSbUpg) _archiveOldImage(oldSbUpg, "storyboard");
    project.storyboards[gIdx] = oldSbUpg && Array.isArray(oldSbUpg.imageHistory) && oldSbUpg.imageHistory.length
      ? { imageHistory: oldSbUpg.imageHistory }
      : null;
    saveProject();
    generateStoryboardSheet(gIdx).then(function () {
      renderImageGrid();
      checkImagesConfirm();
      showToast("首帧已升级为彩色版, 现在可以生成尾帧", "success");
    }).catch(function (err) {
      console.warn('[LegacyUpgrade] failed:', (err && err.message) || err);
    });
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
    var newPrompt = prompt("手动编辑画面生成指令 (English):", current);
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
