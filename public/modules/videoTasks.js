/**
 * Video task lifecycle and batch video page.
 *
 * Extracted from main.js as one complete runtime module. main.js remains the
 * composition root and injects project/settings/videoState plus cross-domain
 * callbacks through initVideoTasks(ctx).
 */
import { $, escapeHtml, showToast, showConfirm, apiPost, apiGet, formatTime, ApiError } from './utils.js';
import { importGroupToTimeline, removeGroupFromTimeline, isGroupImported } from './edit.js';
import { subscribeTask, subscribeBatch } from './backend_stream.js';
import { getBackgroundStylizeCount } from './assets.js';
import { showBillingPaywall } from './billing.js';

let _ctx = {};
let project = null;
let settings = null;
let videoState = null;

let MAX_CONCURRENT = 10;
let MAX_TASKS_TOTAL = 20;
let STATUS_COPY = {};
let VIDEO_ADAPTERS = {};
let _projectEpoch = 0;

export function initVideoTasks(ctx) {
  _ctx = ctx || {};
  MAX_CONCURRENT = _ctx.MAX_CONCURRENT || MAX_CONCURRENT;
  MAX_TASKS_TOTAL = _ctx.MAX_TASKS_TOTAL || MAX_TASKS_TOTAL;
  STATUS_COPY = _ctx.STATUS_COPY || STATUS_COPY;
  VIDEO_ADAPTERS = _ctx.VIDEO_ADAPTERS || VIDEO_ADAPTERS;
  _syncVideoRefs();
}

export function syncVideoTasksProject(p) {
  project = p || null;
  _syncVideoRefs();
}

function _syncVideoRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
  settings = _ctx.getSettings ? _ctx.getSettings() : settings;
  videoState = _ctx.getVideoState ? _ctx.getVideoState() : videoState;
  _projectEpoch = _ctx.getProjectEpoch ? _ctx.getProjectEpoch() : _projectEpoch;
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _registerServerTask() { if (_ctx.registerServerTask) return _ctx.registerServerTask.apply(null, arguments); }
function _notifyServerTaskDone() { if (_ctx.notifyServerTaskDone) return _ctx.notifyServerTaskDone.apply(null, arguments); }
function _archiveOldImage() { if (_ctx.archiveOldImage) return _ctx.archiveOldImage.apply(null, arguments); }
function updateAssetCardImage() { if (_ctx.updateAssetCardImage) return _ctx.updateAssetCardImage.apply(null, arguments); }
function updateStoryboardCard() { if (_ctx.updateStoryboardCard) return _ctx.updateStoryboardCard.apply(null, arguments); }
function _loadGlobalTaskCenter() { if (_ctx.loadGlobalTaskCenter) return _ctx.loadGlobalTaskCenter(); }
function _gtcProgressHtml(status) { return _ctx.gtcProgressHtml ? _ctx.gtcProgressHtml(status) : ''; }
function getStoryboardGroups() { return _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : []; }
function _vpFetchAndCache(sb) { return _ctx.vpFetchAndCache ? _ctx.vpFetchAndCache(sb) : Promise.resolve(null); }
function _vpGetCache(sb) { return _ctx.vpGetCache ? _ctx.vpGetCache(sb) : { sensitiveHits: [] }; }
function switchPage(page) { if (_ctx.switchPage) return _ctx.switchPage(page); }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }
function refreshOverview() { if (_ctx.refreshOverview) return _ctx.refreshOverview(); }

  /* ================================================================
     视频生成（保留 v1.8 全部功能）
     ================================================================ */
  function _isBillingGateError(e) {
    return e instanceof ApiError && [
      'INSUFFICIENT_CREDITS',
    ].indexOf(e.errorCode) >= 0;
  }

  function _billingGateMessage(e, requestedModel) {
    if (!(e instanceof ApiError)) return '';
    if (e.errorCode === 'INSUFFICIENT_CREDITS') {
      return '积分不足';
    }
    return '';
  }

  function createVideoTaskObj(promptText, autoImport) {
    return {
      localId: "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
      serverTaskId: "", prompt: (promptText || "").trim().slice(0, 200) || "(无描述)",
      status: "submit", statusCn: "提交中", statusEn: "提交中",
      videoUrl: "", localPath: "", blobUrl: "", previewOk: false,
      autoImport: !!autoImport, createdAt: Date.now(),
      cardEl: null, videoEl: null,
      _badge: null, _busyWrap: null, _busyText: null, _videoWrap: null,
      _playOverlay: null, _videoLoading: null, _failedWrap: null, _failedText: null, _actions: null,
    };
  }

  function isTerminal(t) { return t.status === "done" || t.status === "failed" || t.status === "timeout"; }
  function activeTaskCount() {
    _syncVideoRefs();
    if (!videoState || !Array.isArray(videoState.tasks)) return 0;
    var n = 0;
    for (var i = 0; i < videoState.tasks.length; i++) { if (!isTerminal(videoState.tasks[i])) n++; }
    return n;
  }


  /* ---- 视频任务恢复（单一路径，后端权威） ----
   * Phase 4 重构：合并原 _recoverAllVideoTasks + _reattachVideoBatches 为
   * 单一恢复函数，消除双路径叠加导致的重复卡片。
   *
   * 恢复策略：
   *   1. /api/batch/active → 活跃批次（进行中），按 target_idx 去重建卡 + 挂 SSE
   *   2. /api/tasks/video-by-project → 已完成历史（去重），补充 batch 没覆盖的分镜
   *   两步之间按 groupIdx 互斥：步骤 1 已有的分镜，步骤 2 不再建卡 */
  function _restoreVideoTasks() {
    _syncVideoRefs();
    if (!videoState || !Array.isArray(videoState.tasks)) return;
    videoState.tasks.forEach(function (t) {
      if (t && t._sseHandle) { try { t._sseHandle.close(); } catch (_e) {} t._sseHandle = null; }
    });
    videoState.tasks = [];
    var tw = $("taskListWrap"); if (tw) tw.innerHTML = "";
    var bw = $("batchTaskListWrap"); if (bw) bw.innerHTML = "";
    syncTaskListVisibility(); updateBadge();
    _reattachVideoTasks();
  }

  async function _reattachVideoTasks() {
    _syncVideoRefs();
    if (!project || !project.id) return;

    var coveredGroups = {};

    // Step 1: active batches — 进行中的批次优先
    try {
      var batchResp = await apiGet("/api/batch/active?projectId=" + encodeURIComponent(project.id));
      var batches = (batchResp && batchResp.batches) || [];
      batches.forEach(function (b) {
        if ((b.batchType || "") !== "videos") return;
        var batchId = b.batchId;
        if (!batchId) return;
        console.log("[VideoReattach] Reattaching batch:", batchId);

        var snap = b.snapshot || {};
        var tasks = b.tasks || [];
        var total = snap.total || tasks.length || 0;
        var totalDone = snap.succeeded || 0;
        var totalFail = snap.failed || 0;

        var batchSeenGroups = {};
        tasks.forEach(function (st) {
          // 后端 getBatchSnapshot 返回字段：
          //   taskId（驼峰）/ target: {groupIdx, idx, storyboardIdx} / result: {resultUrl, url, patch:{url}} / errorMsg
          var tgt = st.target || {};
          var gIdx = tgt.storyboardIdx != null ? tgt.storyboardIdx
                   : tgt.groupIdx != null ? tgt.groupIdx
                   : tgt.idx != null ? tgt.idx
                   : null;
          if (gIdx == null) return;
          if (batchSeenGroups[gIdx]) return;
          batchSeenGroups[gIdx] = true;
          coveredGroups[gIdx] = true;

          var sb = (project.storyboards && project.storyboards[gIdx]) || {};
          var task = createVideoTaskObj("片段" + (gIdx + 1) + ": " + (sb.videoPrompt || "").slice(0, 80), false);
          task._groupIdx = gIdx;
          task._projectId = project.id;
          task.serverTaskId = st.taskId || st.task_id || "";

          var result = st.result || {};
          var resultUrl = result.resultUrl || result.url || (result.patch && result.patch.url) || "";

          if (st.status === "done" || st.status === "completed" || st.status === "succeeded") {
            task.status = "done"; task.statusCn = "完成";
            task.videoUrl = resultUrl;
            if (task.videoUrl && project && Array.isArray(project.storyboards)) {
              if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
              if (!project.storyboards[gIdx].videoUrl) project.storyboards[gIdx].videoUrl = task.videoUrl;
            }
          } else if (st.status === "failed" || st.status === "timeout") {
            task.status = "failed"; task.statusCn = st.errorMsg || st.error_msg || "失败";
          } else {
            task.status = "polling"; task.statusCn = "生成中";
          }
          videoState.tasks.unshift(task);
          insertTaskCardToWraps(createTaskCard(task));
          updateTaskCard(task);
        });

        syncTaskListVisibility(); updateBadge(); _updateBatchTotalProgress();
        renderBatchClipList();

        if (snap.completedAt) return;

        var btn = $("btnStartBatch");
        var hint = $("batchHint");
        if (btn) btn.disabled = true;
        if (hint) hint.textContent = "批量进度 " + (totalDone + totalFail) + "/" + total +
          (totalFail ? "（失败 " + totalFail + "）" : "");

        if (_batchHandle) { try { _batchHandle.close(); } catch (_e) {} _batchHandle = null; }

        function findTaskByServerId(taskId) {
          if (!taskId) return null;
          for (var k = 0; k < videoState.tasks.length; k++) {
            if (videoState.tasks[k].serverTaskId === taskId) return videoState.tasks[k];
          }
          return null;
        }

        // 共享 _seenDone / _seenFailed，给 SSE 和 polling 一起去重
        var _seenDone = Object.create(null);
        var _seenFailed = Object.create(null);

        // 通用：根据 task 状态确保前端卡片已绑 serverTaskId（SSE task_started 可能丢）
        function ensureTaskBound(taskId, gi) {
          var existing = findTaskByServerId(taskId);
          if (existing) return existing;
          if (gi == null) return null;
          var t = _findTaskByGroup(gi);
          if (!t) return null;
          t.serverTaskId = taskId;
          if (!t.status || t.status === "preparing") {
            t.status = "polling"; t.statusCn = "生成中"; updateTaskCard(t);
          }
          return t;
        }

        function applyCompleted(taskId, url, extra) {
          if (_seenDone[taskId] || _seenFailed[taskId]) return;
          _seenDone[taskId] = true;
          totalDone++;
          if (hint) hint.textContent = "批量进度 " + (totalDone + totalFail) + "/" + total +
            (totalFail ? "（失败 " + totalFail + "）" : "");
          var gi = (extra && typeof extra.groupIdx === "number") ? extra.groupIdx : null;
          var t = ensureTaskBound(taskId, gi);
          if (!t) return;
          var eIdx = gi != null ? gi : t._groupIdx;
          if (project && eIdx != null && Array.isArray(project.storyboards)) {
            if (!project.storyboards[eIdx]) project.storyboards[eIdx] = {};
            if (extra && typeof extra.readyForEdit === "boolean") {
              project.storyboards[eIdx].readyForEdit = extra.readyForEdit;
            }
          }
          if (project && extra && extra.editReadiness && typeof extra.editReadiness === "object") {
            if (!project.editData) project.editData = {};
            project.editData.readiness = extra.editReadiness;
          }
          if (url) {
            t.videoUrl = url;
            if (project && t._groupIdx != null && Array.isArray(project.storyboards)) {
              if (!project.storyboards[t._groupIdx]) project.storyboards[t._groupIdx] = {};
              project.storyboards[t._groupIdx].videoUrl = url;
            }
            videoPipeline(t).then(function () { updateBadge(); renderBatchClipList(); });
          } else {
            t.status = "failed"; t.statusCn = "生成完成但无视频地址";
            updateTaskCard(t); updateBadge();
          }
        }

        function applyFailed(taskId, reason) {
          if (_seenFailed[taskId] || _seenDone[taskId]) return;
          _seenFailed[taskId] = true;
          totalFail++;
          if (hint) hint.textContent = "批量进度 " + (totalDone + totalFail) + "/" + total +
            (totalFail ? "（失败 " + totalFail + "）" : "");
          var t = findTaskByServerId(taskId);
          if (!t) return;
          t.status = "failed";
          t.statusCn = _friendlyVideoError(reason || "failed");
          updateTaskCard(t); updateBadge();
          renderBatchClipList();
        }

        // ===== Polling fallback：5 秒兜底拉 batch snapshot =====
        var _reatPoll = null;
        function _stopReatPoll() { if (_reatPoll) { clearInterval(_reatPoll); _reatPoll = null; } }
        async function _reatPollOnce() {
          try {
            var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
            if (!snap) return;
            if (Array.isArray(snap.tasks)) {
              snap.tasks.forEach(function (st2) {
                var tid = st2.taskId || st2.task_id;
                if (!tid) return;
                var tgt = st2.target || {};
                var gi = tgt.storyboardIdx != null ? tgt.storyboardIdx
                       : tgt.groupIdx != null ? tgt.groupIdx
                       : tgt.idx != null ? tgt.idx
                       : null;
                // task 还在跑时也要确保前端卡片已绑 taskId（SSE task_started 可能丢）
                if (st2.status === "running" || st2.status === "queued") {
                  ensureTaskBound(tid, gi);
                  return;
                }
                if (st2.status === "completed" && !_seenDone[tid]) {
                  var r = st2.result || {};
                  var url = r.resultUrl || r.url || (r.patch && r.patch.url) || "";
                  var extra = r.extra || {};
                  if (gi != null && extra.groupIdx == null) extra.groupIdx = gi;
                  applyCompleted(tid, url, extra);
                } else if (st2.status === "failed" && !_seenFailed[tid]) {
                  applyFailed(tid, st2.errorMsg || st2.error_msg);
                }
              });
            }
            if (snap.status === "succeeded" || snap.status === "failed" ||
                snap.status === "completed" || snap.status === "cancelled") {
              _stopReatPoll();
              if (btn) btn.disabled = false;
              if (hint) hint.textContent = "批量完成 " + totalDone + "/" + total +
                (totalFail ? "（失败 " + totalFail + "）" : "");
            }
          } catch (e) {
            console.warn("[VideoReattach] poll failed:", e && e.message);
          }
        }
        _reatPoll = setInterval(_reatPollOnce, 5000);
        setTimeout(_reatPollOnce, 1500);

        _batchHandle = subscribeBatch(batchId, {
          onSnapshot: function (data) {
            if (data && Array.isArray(data.tasks)) {
              data.tasks.forEach(function (st2) {
                var tid = st2.taskId || st2.task_id;
                if (!tid) return;
                var tgt = st2.target || {};
                var gi = tgt.storyboardIdx != null ? tgt.storyboardIdx
                       : tgt.groupIdx != null ? tgt.groupIdx
                       : tgt.idx != null ? tgt.idx
                       : null;
                if (st2.status === "running" || st2.status === "queued") {
                  ensureTaskBound(tid, gi);
                  return;
                }
                if (st2.status === "completed" && !_seenDone[tid]) {
                  var r = st2.result || {};
                  var url = r.resultUrl || r.url || (r.patch && r.patch.url) || "";
                  var extra = r.extra || {};
                  if (gi != null && extra.groupIdx == null) extra.groupIdx = gi;
                  applyCompleted(tid, url, extra);
                } else if (st2.status === "failed" && !_seenFailed[tid]) {
                  applyFailed(tid, st2.errorMsg || st2.error_msg);
                }
              });
              _updateBatchTotalProgress();
            }
          },
          onTaskStarted: function (data) {
            var taskId = data.taskId; if (!taskId) return;
            var tgt = data.target || {};
            var gi = tgt.storyboardIdx != null ? tgt.storyboardIdx
                   : tgt.groupIdx != null ? tgt.groupIdx
                   : tgt.idx != null ? tgt.idx
                   : data.targetIdx;
            ensureTaskBound(taskId, gi);
          },
          onTaskProgress: function (data) {
            var t = findTaskByServerId(data.taskId);
            if (!t) return;
            if (t.status !== "polling") { t.status = "polling"; t.statusCn = "生成中"; updateTaskCard(t); }
          },
          onTaskCompleted: function (data) {
            applyCompleted(data.taskId, data.resultUrl || data.videoUrl || "", data.extra || {});
          },
          onTaskFailed: function (data) {
            applyFailed(data.taskId, data.reason || data.errorMsg);
          },
          onBatchCompleted: function () {
            _stopReatPoll();
            if (btn) btn.disabled = false;
            if (hint) hint.textContent = "批量完成 " + totalDone + "/" + total +
              (totalFail ? "（失败 " + totalFail + "）" : "");
          },
          onClose: function () {
            _stopReatPoll();
            _batchHandle = null;
            if (btn) btn.disabled = false;
          },
        });
      });
    } catch (e) {
      console.warn("[VideoReattach] batch/active failed:", e);
    }

    // Step 2: completed history — 补充已完成但不在活跃 batch 中的历史任务
    try {
      var histResp = await apiGet("/api/tasks/video-by-project?projectId=" + encodeURIComponent(project.id));
      var histTasks = (histResp && histResp.tasks) || [];
      if (histTasks.length) {
        console.log("[VideoReattach] Found " + histTasks.length + " history tasks");
        histTasks.forEach(function (t) {
          var gIdx = t.target_idx != null ? t.target_idx : 0;
          if (coveredGroups[gIdx]) return;
          coveredGroups[gIdx] = true;

          var isSucceeded = t.status === "succeeded" || t.status === "done" || t.status === "completed";
          var isFailed = t.status === "failed" || t.status === "timeout";
          var url = t.result_url || "";

          if (isSucceeded && url && project && Array.isArray(project.storyboards)) {
            if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
            if (!project.storyboards[gIdx].videoUrl) project.storyboards[gIdx].videoUrl = url;
          }

          var sb = (project.storyboards && project.storyboards[gIdx]) || {};
          var task = createVideoTaskObj("片段" + (gIdx + 1) + ": " + (sb.videoPrompt || "").slice(0, 80), false);
          task.serverTaskId = t.task_id || "";
          task._groupIdx = gIdx;
          task._projectId = project.id;

          if (isSucceeded) {
            task.status = "done"; task.statusCn = "已完成";
            task.videoUrl = url;
          } else if (isFailed) {
            task.status = "failed"; task.statusCn = t.error_msg || "生成失败";
          } else {
            task.status = "polling"; task.statusCn = "生成中";
          }

          videoState.tasks.unshift(task);
          insertTaskCardToWraps(createTaskCard(task));
          updateTaskCard(task);

          // 已完成的历史任务：跑一遍 videoPipeline 把视频实际加载到 <video>，
          // 让 previewOk 翻 true，避免刷新后卡片显示"预览不可用（已在浏览器打开）"。
          // 失败也无所谓，pipeline 内部会写降级 UI。
          if (isSucceeded && task.videoUrl) {
            try { videoPipeline(task).then(function () { updateBadge(); renderBatchClipList(); }); }
            catch (_pe) {}
          }
        });
      }
    } catch (e) {
      console.warn("[VideoReattach] video-by-project failed:", e);
    }

    syncTaskListVisibility(); updateBadge(); _updateBatchTotalProgress();
    renderBatchClipList();
  }

  function _recoverSingleServerTask(t) {
    if (!project) return;
    var isDone = t.status === "done" || t.status === "succeeded" || t.status === "completed";
    if (isDone && t.result_url) { _applyCompletedServerTask(t); return; }
    if (t.task_type === "video") { _recoverVideoServerTask(t); return; }
  }

  function _applyCompletedServerTask(t) {
    if (!project) return;
    var tType = t.target_type;
    var tIdx = t.target_idx || 0;
    var url = t.result_url;
    if (t.task_type === "video") {
      if (!project.storyboards) project.storyboards = [];
      if (!project.storyboards[tIdx]) project.storyboards[tIdx] = {};
      if (url && !project.storyboards[tIdx].videoUrl) project.storyboards[tIdx].videoUrl = url;
      if (t.asset_id) project.storyboards[tIdx].videoAssetId = t.asset_id;
      if (t.fetch_status) project.storyboards[tIdx].fetchStatus = t.fetch_status;
      project.storyboards[tIdx].videoTaskId = t.task_id;
      project.storyboards[tIdx].videoStatus = "done";
      saveProject();
      if (url) showToast("视频片段 #" + (tIdx + 1) + " 已在后台生成完成", "ok");
      _notifyServerTaskDone(t.task_id);
      return;
    }
    if (tType === "storyboard") {
      if (!project.storyboards) project.storyboards = [];
      var existing = project.storyboards[tIdx] || {};
      if (url && !existing.imageUrl) {
        _archiveOldImage(existing, "storyboard");
        existing.imageUrl = url; existing.rawUrl = url;
      }
      if (t.asset_id) existing.imageAssetId = t.asset_id;
      if (t.fetch_status) existing.fetchStatus = t.fetch_status;
      project.storyboards[tIdx] = existing;
      saveProject(); if (url) updateStoryboardCard(tIdx, "done", url);
      if (url) showToast("分镜图 #" + (tIdx + 1) + " 已在后台生成完成", "ok");
    } else if (tType === "char") {
      var charItem = project.assets && project.assets.characters && project.assets.characters[tIdx];
      if (charItem) {
        if (t.task_type === "stylize") {
          if (url && !charItem.pencilUrl) { _archiveOldImage(charItem, "stylize"); charItem.pencilUrl = url; delete charItem._pencilFailed; }
          if (t.asset_id) charItem.pencilAssetId = t.asset_id;
          if (t.fetch_status) charItem.fetchStatus = t.fetch_status;
          saveProject(); if (url) showToast("角色「" + (charItem.name || tIdx) + "」风格图已在后台生成", "ok");
        } else {
          if (url && !charItem.realPhotoUrl) { _archiveOldImage(charItem, "character"); charItem.realPhotoUrl = url; charItem.imageUrl = url; charItem.rawUrl = url; }
          if (t.asset_id) charItem.assetId = t.asset_id;
          if (t.fetch_status) charItem.fetchStatus = t.fetch_status;
          saveProject(); if (url) updateAssetCardImage("char", tIdx, "done", url);
        }
      }
    } else if (tType === "scene" || tType === "prop") {
      var list = tType === "scene" ? (project.assets && project.assets.scenes) : (project.assets && project.assets.props);
      var item = list && list[tIdx];
      if (item) {
        if (url && !item.imageUrl) { _archiveOldImage(item, tType === "scene" ? "scene" : "prop"); item.imageUrl = url; item.rawUrl = url; }
        if (t.asset_id) item.assetId = t.asset_id;
        if (t.fetch_status) item.fetchStatus = t.fetch_status;
        saveProject(); if (url) updateAssetCardImage(tType, tIdx, "done", url);
      }
    }
    _notifyServerTaskDone(t.task_id);
  }

  function _recoverVideoServerTask(t) {
    if (!project) return;
    var tid = t.task_id;
    var gIdx = t.target_idx || 0;
    if (videoState.tasks.some(function (vt) { return vt.serverTaskId === tid; })) return;
    var task = createVideoTaskObj("片段 " + (gIdx + 1), false);
    task.serverTaskId = tid; task._groupIdx = gIdx; task._projectId = project.id;
    task.status = "polling"; task.statusCn = "生成中";
    videoState.tasks.push(task);
    var card = createTaskCard(task);
    insertTaskCardToWraps(card); updateTaskCard(task);
    _attachTaskStream(task, tid);
    syncTaskListVisibility(); updateBadge(); _updateBatchTotalProgress();
  }

  function _updateBatchTotalProgress() {
    var wrap = $("batchTotalProgressWrap");
    var bar = $("batchTotalProgressBar");
    var label = $("batchTotalProgressLabel");
    var etaEl = $("batchTotalProgressEta");
    if (!wrap || !bar || !label) return;
    var tot = videoState.tasks.length;
    if (tot === 0) {
      wrap.hidden = true;
      return;
    }
    var done = 0, active = 0, fail = 0;
    var i;
    for (i = 0; i < videoState.tasks.length; i++) {
      var vt = videoState.tasks[i];
      if (vt.status === "done") done++;
      else if (vt.status === "failed" || vt.status === "timeout") fail++;
      else active++;
    }
    wrap.hidden = false;
    var finished = done + fail;
    var pct = tot ? Math.round(finished / tot * 100) : 0;
    bar.style.width = pct + "%";
    label.textContent = "已完成 " + done + "/" + tot + " · 进行中 " + active + (fail ? " · 失败 " + fail : "");
    if (etaEl) {
      var etaText = "";
      if (active > 0 && done >= 1) {
        var sumMs = 0, cnt = 0;
        for (i = 0; i < videoState.tasks.length; i++) {
          var t2 = videoState.tasks[i];
          if (t2.status === "done" && t2.createdAt && t2._doneAt) {
            sumMs += (t2._doneAt - t2.createdAt);
            cnt++;
          }
        }
        if (cnt > 0) {
          var avgSec = sumMs / cnt / 1000;
          var estSec = Math.round(avgSec * active);
          if (estSec > 8) etaText = "预估剩余约 " + estSec + " 秒（按已完成片段平均耗时）";
        }
      }
      etaEl.textContent = etaText;
    }
  }

  function updateBadge() {
    _syncVideoRefs();
    var n = activeTaskCount();
    var badge = $("taskBadge");
    if (badge) {
      if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
      else { badge.hidden = true; }
    }
    try { _updateGlobalTaskBadge(); } catch (e) { /* defined later in source order */ }
    _updateBatchTotalProgress();
  }

  function syncTaskListVisibility() {
    _syncVideoRefs();
    var act = activeTaskCount(), tot = videoState.tasks.length;
    var hasAny = tot > 0;
    var statusText = "";
    if (act > 0) statusText = act + " 个进行中 / 共 " + tot + " 个任务";
    else if (tot > 0) statusText = "共 " + tot + " 个任务（全部完成）";
    else statusText = "暂无任务";

    var empty = $("tasksEmpty"), summary = $("tasksSummary");
    if (empty) empty.hidden = hasAny;
    if (summary) summary.textContent = statusText;

    var bEmpty = $("batchTasksEmpty"), bSummary = $("batchTasksSummary");
    if (bEmpty) bEmpty.hidden = hasAny;
    if (bSummary) bSummary.textContent = statusText;
    _updateBatchTotalProgress();
  }

  function insertTaskCardToWraps(card) {
    var mainWrap = $("taskListWrap");
    if (mainWrap) {
      if (mainWrap.firstChild) mainWrap.insertBefore(card, mainWrap.firstChild); else mainWrap.appendChild(card);
    }
  }

  function syncMirrorCard(task) {
    var bWrap = $("batchTaskListWrap");
    if (!bWrap || !task.cardEl) return;
    if (task._killed || (task._projectId && project && task._projectId !== project.id)) return;
    var mirror = bWrap.querySelector('[data-mirror-id="' + task.localId + '"]');

    var st = task.status, fail = st === "failed" || st === "timeout";
    var done = st === "done", active = !isTerminal(task);
    var fetching = st === "fetching";

    var statusLabel, statusClass, iconHtml;
    if (done) {
      statusLabel = '完成 FINISHED'; statusClass = 'bg-secondary-container text-on-secondary-container';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-secondary-container/20 flex items-center justify-center"><span class="material-symbols-outlined text-primary" style="font-variation-settings: \'FILL\' 1;">check_circle</span></div>';
    } else if (fail) {
      statusLabel = '失败'; statusClass = 'bg-error/10 text-error';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-error/10 flex items-center justify-center"><span class="material-symbols-outlined text-error">error</span></div>';
    } else if (fetching) {
      statusLabel = '下载中 FETCHING'; statusClass = 'bg-primary/10 text-primary';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-primary animate-spin">sync</span></div>';
    } else if (active) {
      var elapsedSec = task.createdAt ? (Date.now() - task.createdAt) / 1000 : 0;
      var pct = elapsedSec > 0 ? Math.min(Math.round(elapsedSec / 90 * 100), 95) : 5;
      var dashOffset = Math.round(125 - (125 * pct / 100));
      statusLabel = '生成中'; statusClass = 'bg-primary/10 text-primary';
      iconHtml =
        '<div class="relative w-12 h-12 flex items-center justify-center">' +
          '<svg class="absolute inset-0 w-full h-full -rotate-90"><circle cx="24" cy="24" fill="none" r="20" stroke="#dfe2f0" stroke-width="4"></circle><circle cx="24" cy="24" fill="none" r="20" stroke="#5a5e6a" stroke-dasharray="125" stroke-dashoffset="' + dashOffset + '" stroke-width="4"></circle></svg>' +
          '<span class="text-[10px] font-bold">' + pct + '%</span>' +
        '</div>';
    } else if (st === "preparing") {
      statusLabel = '准备中 PREPARING'; statusClass = 'bg-[#7c8aff]/10 text-[#5b6abf]';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-[#7c8aff]/10 flex items-center justify-center"><span class="material-symbols-outlined text-[#5b6abf] animate-pulse">pending</span></div>';
    } else if (st === "submitting") {
      statusLabel = '提交中 SUBMITTING'; statusClass = 'bg-primary/10 text-primary';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-primary animate-spin">sync</span></div>';
    } else {
      statusLabel = '排队中 QUEUED'; statusClass = 'bg-surface-variant text-on-surface-variant';
      iconHtml = '<div class="w-10 h-10 rounded-full bg-surface-container-low flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant/40 animate-pulse">hourglass_top</span></div>';
    }

    var promptSnippet = escapeHtml((task.prompt || '').slice(0, 60));
    var timeStr = formatTime(task.createdAt);

    var playBtnHtml = '';
    if (done && (task.videoUrl || task.blobUrl)) {
      playBtnHtml =
        '<button type="button" class="batch-play-btn w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center hover:scale-110 transition-transform active:scale-95" data-video-url="' + escapeHtml(task.blobUrl || task.videoUrl) + '">' +
          '<span class="material-symbols-outlined text-sm" style="font-variation-settings: \'FILL\' 1;">play_arrow</span>' +
        '</button>';
    }

    var failBtnsHtml = '';
    if (fail && (task._retryBody || (task._groupIdx !== undefined && project && project.storyboards && project.storyboards[task._groupIdx]))) {
      failBtnsHtml =
        '<button type="button" class="w-8 h-8 rounded-full bg-surface-container-highest/40 text-on-surface-variant flex items-center justify-center hover:scale-110 transition-transform active:scale-95" data-action="retry" data-task-id="' + task.localId + '" title="重新生成">' +
          '<span class="material-symbols-outlined text-sm">refresh</span>' +
        '</button>';
    }

    var importBtnHtml = '';
    if (done && task._groupIdx != null && (task.videoUrl || task.blobUrl)) {
      var _imported = false;
      try { _imported = isGroupImported(task._groupIdx); } catch (_e) {}
      if (_imported) {
        importBtnHtml =
          '<button type="button" class="mirror-import-btn px-3 py-1.5 rounded-full text-[10px] font-bold bg-surface-container-highest/40 text-on-surface-variant hover:opacity-90 transition-all active:scale-95" style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap" data-action="mirror-import-edit" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '">' +
            '<span class="material-symbols-outlined" style="font-size:13px;line-height:1">check_circle</span>已导入' +
          '</button>';
      } else {
        importBtnHtml =
          '<button type="button" class="mirror-import-btn px-3 py-1.5 rounded-full text-[10px] font-bold bg-primary text-on-primary hover:opacity-90 transition-all active:scale-95" style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap" data-action="mirror-import-edit" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '">' +
            '<span class="material-symbols-outlined" style="font-size:13px;line-height:1">movie</span>导入' +
          '</button>';
      }
    }

    if (!mirror) {
      mirror = document.createElement("div");
      mirror.dataset.mirrorId = task.localId;
      if (bWrap.firstChild) bWrap.insertBefore(mirror, bWrap.firstChild);
      else bWrap.appendChild(mirror);
    }

    var existingPlayer = mirror.querySelector('.batch-inline-player');
    var playerHtml = existingPlayer ? existingPlayer.outerHTML : '';

    mirror.className = "bg-surface-container-lowest rounded-lg border border-outline-variant/5 transition-all overflow-hidden";
    if (fail) mirror.className += " border-error/10";
    mirror.innerHTML =
      '<div class="flex items-center justify-between p-4">' +
        '<div class="flex items-center gap-5">' +
          iconHtml +
          '<div>' +
            '<h5 class="text-sm font-bold">' + (task._groupIdx !== undefined ? '片段 ' + (task._groupIdx + 1) : '视频任务') + '</h5>' +
            '<p class="text-[10px] font-medium text-on-surface-variant/60 max-w-xs truncate">' + promptSnippet + '</p>' +
            (fail && task.statusCn ? '<p class="text-[10px] text-error/70 max-w-xs truncate mt-0.5">' + escapeHtml(task.statusCn) + '</p>' : '') +
          '</div>' +
        '</div>' +
        '<div class="flex items-center gap-3">' +
          playBtnHtml +
          importBtnHtml +
          failBtnsHtml +
          '<span class="px-3 py-1 ' + statusClass + ' text-[10px] font-bold rounded-full" style="white-space:nowrap;display:inline-flex;align-items:center;gap:3px">' + statusLabel + '</span>' +
          '<span class="text-[10px] font-mono text-on-surface-variant/40" style="white-space:nowrap">' + timeStr + '</span>' +
        '</div>' +
      '</div>' +
      playerHtml;

    var bEmpty = $("batchTasksEmpty");
    if (bEmpty) bEmpty.hidden = videoState.tasks.length > 0;

    _syncGlobalTaskCard(task);
  }

  function _syncGlobalTaskCard(task) {
    var gWrap = $("globalTaskListWrap");
    if (!gWrap) return;
    var emptyEl = $("globalTaskEmpty");

    var st = task.status;
    // Map the video-task vocabulary onto the shared status set consumed
    // by _gtcProgressHtml: anything that's not done/failed animates as
    // indeterminate progress.
    var ringStatus = "polling";
    if (st === "done") ringStatus = "done";
    else if (st === "failed" || st === "retry_failed") ringStatus = "failed";
    var label = task._groupIdx !== undefined ? "片段 " + (task._groupIdx + 1) : "视频任务";
    var statusText = task.statusCn || st || "";
    var timeStr = formatTime(task.createdAt);

    var card = gWrap.querySelector('[data-gtp-id="' + task.localId + '"]');
    if (!card) {
      card = document.createElement("div");
      card.dataset.gtpId = task.localId;
      card.className = "gtp-card";
      if (gWrap.firstChild && gWrap.firstChild !== emptyEl) {
        gWrap.insertBefore(card, gWrap.firstChild);
      } else {
        gWrap.appendChild(card);
      }
    }

    card.innerHTML =
      '<div class="shrink-0">' + _gtcProgressHtml(ringStatus) + '</div>' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-xs font-bold truncate">' + escapeHtml(label) + '</p>' +
        '<p class="text-[10px] text-on-surface-variant/60 truncate">' + escapeHtml(statusText) + '</p>' +
      '</div>' +
      '<span class="text-[10px] font-mono text-on-surface-variant/30 shrink-0">' + timeStr + '</span>';

    if (emptyEl) emptyEl.hidden = videoState.tasks.length > 0;
  }

  function toggleGlobalTaskPanel(forceState) {
    _syncVideoRefs();
    var panel = $("globalTaskPanel");
    if (!panel) return;
    var shouldOpen = forceState !== undefined ? forceState : !panel.classList.contains("open");
    panel.classList.toggle("open", shouldOpen);
    if (shouldOpen) _loadGlobalTaskCenter();
  }

  function _initBatchPlayerEvents() {
    _syncVideoRefs();
    var bWrap = $("batchTaskListWrap");
    if (!bWrap || bWrap._playerBound) return;
    bWrap._playerBound = true;
    bWrap.addEventListener("click", function (e) {
      var actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        var act = actionBtn.dataset.action;
        var tid = actionBtn.dataset.taskId;
        if (tid && act === "retry") {
          var task = null;
          for (var i = 0; i < videoState.tasks.length; i++) { if (videoState.tasks[i].localId === tid) { task = videoState.tasks[i]; break; } }
          if (task) retryFailedTask(task);
          return;
        }
        if (act === "mirror-import-edit") {
          var mGIdx = parseInt(actionBtn.dataset.groupIdx, 10);
          if (isNaN(mGIdx)) return;
          var alreadyIn = false;
          try { alreadyIn = isGroupImported(mGIdx); } catch (_e) {}
          if (alreadyIn) {
            try { removeGroupFromTimeline(mGIdx); } catch (_e) {}
            showToast("已从剪辑工作台移出", "info");
          } else {
            var imported = false;
            try { imported = importGroupToTimeline(mGIdx); } catch (_e) {}
            if (imported) {
              showToast("已导入剪辑工作台", "ok");
            } else {
              showToast("导入失败，视频可能还在加载中，请稍后再试", "warn");
            }
          }
          var mTask = null;
          if (tid) { for (var j = 0; j < videoState.tasks.length; j++) { if (videoState.tasks[j].localId === tid) { mTask = videoState.tasks[j]; break; } } }
          if (mTask) updateTaskCard(mTask);
          return;
        }
      }
      var btn = e.target.closest(".batch-play-btn");
      if (!btn) return;
      var mirror = btn.closest("[data-mirror-id]");
      if (!mirror) return;
      var videoUrl = btn.dataset.videoUrl;
      if (!videoUrl) return;

      var existing = mirror.querySelector(".batch-inline-player");
      if (existing) {
        var vid = existing.querySelector("video");
        if (vid && !vid.paused) { vid.pause(); return; }
        if (vid && vid.paused) { vid.play().catch(function () {}); return; }
      }

      var playerDiv = document.createElement("div");
      playerDiv.className = "batch-inline-player p-4 pt-0";
      playerDiv.innerHTML =
        '<div class="relative rounded-lg overflow-hidden bg-black aspect-video">' +
          '<video src="' + escapeHtml(videoUrl) + '" class="w-full h-full" controls autoplay playsinline preload="auto"></video>' +
          '<button type="button" class="batch-close-player absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors z-10">' +
            '<span class="material-symbols-outlined text-sm">close</span>' +
          '</button>' +
        '</div>';
      mirror.appendChild(playerDiv);

      var video = playerDiv.querySelector("video");
      video.addEventListener("error", function () {
        playerDiv.innerHTML =
          '<div class="p-4 text-center text-xs text-on-surface-variant">' +
            '<p>暂时无法在此处播放，' +
            '<a href="' + escapeHtml(videoUrl) + '" target="_blank" class="text-primary underline">点击新窗口播放</a></p>' +
          '</div>';
      });

      var closeBtn = playerDiv.querySelector(".batch-close-player");
      closeBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var v = playerDiv.querySelector("video");
        if (v) v.pause();
        playerDiv.remove();
      });
    });
  }

  function createTaskCard(task) {
    var card = document.createElement("div");
    card.className = "task-card is-active";
    card.dataset.taskId = task.localId;
    card.innerHTML =
      '<div class="tc-head">' +
        '<span class="tc-badge tc-badge--submit">' + escapeHtml(task.statusCn) + '</span>' +
        '<span class="tc-time">' + formatTime(task.createdAt) + '</span>' +
      '</div>' +
      '<p class="tc-prompt">' + escapeHtml(task.prompt) + '</p>' +
      '<div class="tc-preview">' +
        '<div class="tc-busy"><div class="tc-spinner"></div><span class="tc-busy-text">提交中…</span></div>' +
        '<div class="tc-video-wrap" hidden>' +
          '<video playsinline preload="auto" muted></video>' +
          '<div class="tc-play-overlay" hidden><div class="tc-play-btn">&#9654;</div></div>' +
          '<div class="tc-video-loading"><div class="tc-spinner"></div><span class="tc-loading-text">正在下载成片…</span></div>' +
        '</div>' +
        '<div class="tc-failed" hidden><span class="tc-failed-text"></span><div class="tc-failed-actions"><button type="button" class="tc-failed-btn tc-failed-btn--retry" data-action="retry">重新生成</button><button type="button" class="tc-failed-btn" data-action="browser">在浏览器打开</button></div></div>' +
      '</div>' +
      '<div class="tc-actions" hidden>' +
        '<button type="button" class="tc-btn tc-btn--primary" data-action="import-edit" style="display:inline-flex;align-items:center;gap:4px"><span class="material-symbols-outlined" style="font-size:14px;line-height:1">movie</span>导入</button>' +
        '<button type="button" class="tc-btn tc-btn--accent" data-action="download">下载视频</button>' +
        '<button type="button" class="tc-btn" data-action="browser">在线播放</button>' +
        '<button type="button" class="tc-btn" data-action="copy">复制链接</button>' +
      '</div>';

    task.cardEl = card;
    task.videoEl = card.querySelector("video");
    task._badge = card.querySelector(".tc-badge");
    task._busyWrap = card.querySelector(".tc-busy");
    task._busyText = card.querySelector(".tc-busy-text");
    task._videoWrap = card.querySelector(".tc-video-wrap");
    task._playOverlay = card.querySelector(".tc-play-overlay");
    task._videoLoading = card.querySelector(".tc-video-loading");
    task._failedWrap = card.querySelector(".tc-failed");
    task._failedText = card.querySelector(".tc-failed-text");
    task._actions = card.querySelector(".tc-actions");

    var playOv = task._playOverlay, vid = task.videoEl;
    if (playOv && vid) {
      playOv.addEventListener("click", function () { playOv.hidden = true; vid.play().catch(function () {}); });
      vid.addEventListener("play", function () { playOv.hidden = true; });
      vid.addEventListener("pause", function () { if (!vid.ended) playOv.hidden = false; });
      vid.addEventListener("ended", function () { vid.currentTime = 0; playOv.hidden = false; });
    }
    return card;
  }

  function updateTaskCard(task) {
    if (!task.cardEl) return;
    if (task._killed || (task._projectId && project && task._projectId !== project.id)) return;
    var st = task.status, active = !isTerminal(task), done = st === "done";
    var fail = st === "failed" || st === "timeout", fetching = st === "fetching";
    task.cardEl.classList.toggle("is-active", active);
    task._badge.textContent = task.statusCn;
    task._badge.className = "tc-badge tc-badge--" + st;

    if (fetching) {
      task._busyWrap.hidden = true; task._videoWrap.hidden = false;
      if (task._videoLoading) task._videoLoading.hidden = false;
      task._failedWrap.hidden = true; task._actions.hidden = true;
    } else if (active) {
      task._busyWrap.hidden = false; task._busyText.textContent = task.statusCn + "…";
      task._videoWrap.hidden = true; task._failedWrap.hidden = true; task._actions.hidden = true;
    } else if (done && task.previewOk) {
      task._busyWrap.hidden = true; task._videoWrap.hidden = false;
      if (task._videoLoading) task._videoLoading.hidden = true;
      task._failedWrap.hidden = true; task._actions.hidden = false;
    } else if (done && !task.previewOk) {
      task._busyWrap.hidden = true; task._videoWrap.hidden = true;
      if (task._videoLoading) task._videoLoading.hidden = true;
      task._failedWrap.hidden = false; task._failedText.textContent = "预览不可用（已在浏览器打开）";
      task._actions.hidden = false;
    } else if (fail) {
      task._busyWrap.hidden = true; task._videoWrap.hidden = true;
      task._failedWrap.hidden = false; task._failedText.textContent = task.statusCn;
      task._actions.hidden = task.videoUrl ? false : true;
    }
    _refreshImportEditButton(task);
    syncMirrorCard(task);
    syncTaskListVisibility();
    _updateBatchTotalProgress();
  }

  function _refreshImportEditButton(task) {
    if (!task || !task.cardEl) return;
    var btn = task.cardEl.querySelector('[data-action="import-edit"]');
    if (!btn) return;
    // 是否显示这个按钮 = (任务 UI 态是 done && 预览 OK) && (后端判定可入剪)。
    // 前半段是前端自己的"UI 运行态"（这个任务卡片的 spinner 是不是停了），
    // 后半段是"业务资格"—— 业务资格严格只读后端 hydrate 下发的
    // `storyboards[idx].readyForEdit`（规则来源 services/edit_timeline_gate.py，
    // `is_storyboard_ready_for_edit`）。前端不再自己拼 `videoUrl && gIdx != null`
    // 之类的业务判定，避免和后端 /api/edit/timeline import-group 的准入规则撕裂。
    //
    // 兜底：readyForEdit 字段完全缺失（老项目 / 该项目这次会话没触发过 GET）时
    // 视为"后端还没表态"，按钮默认放行——后端 /api/edit/timeline 的
    // assert_can_import_group 仍是最终防线，点下去后端拒绝会 toast。
    var gIdx = task._groupIdx;
    var uiDone = task.status === "done" && (task.previewOk || task.videoUrl) && gIdx != null;
    var backendReady = true;
    if (uiDone && project && Array.isArray(project.storyboards)) {
      var sb = project.storyboards[gIdx] || {};
      if (typeof sb.readyForEdit === "boolean") {
        backendReady = sb.readyForEdit === true;
      }
    }
    var eligible = uiDone && backendReady;
    btn.hidden = !eligible;
    if (!eligible) return;
    var imported = false;
    try { imported = isGroupImported(gIdx); } catch (_e) { imported = false; }
    if (imported) {
      btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;line-height:1">check_circle</span>已导入';
      btn.style.display = 'inline-flex'; btn.style.alignItems = 'center'; btn.style.gap = '4px';
      btn.classList.remove("tc-btn--primary");
      btn.classList.add("tc-btn--muted");
      btn.dataset.imported = "1";
    } else {
      btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;line-height:1">movie</span>导入';
      btn.style.display = 'inline-flex'; btn.style.alignItems = 'center'; btn.style.gap = '4px';
      btn.classList.remove("tc-btn--muted");
      btn.classList.add("tc-btn--primary");
      btn.dataset.imported = "0";
    }
  }

  function cleanupTask(task) {
    if (task._sseHandle) { try { task._sseHandle.close(); } catch (_e) {} task._sseHandle = null; }
    if (task.blobUrl) { try { URL.revokeObjectURL(task.blobUrl); } catch (e) {} task.blobUrl = ""; }
    if (task.cardEl && task.cardEl.parentNode) task.cardEl.parentNode.removeChild(task.cardEl);
    task.cardEl = null; task.videoEl = null;
  }

  /* Video helpers — API calls delegated to backend */
  function _getVideoAdapter() {
    var id = (settings.models.video.adapter) || "openai_compat";
    return VIDEO_ADAPTERS[id] || VIDEO_ADAPTERS.openai_compat;
  }

  /* videoApiFetch, extractTaskId, extractStatus, extractVideoUrlDeep,
     extractTaskFailureReason — all moved to Python backend services/video_client.py */

  function describeStatus(stRaw) {
    var st = (stRaw || "").toLowerCase();
    if (STATUS_COPY[st]) return STATUS_COPY[st];
    return { cn: "生成中", en: "生成中" };
  }

  /* 把底层错误文本分类成用户看得懂的简短提示 */
  function _friendlyVideoError(errMsg) {
    var s = ((errMsg == null) ? "" : String(errMsg)).toLowerCase();
    try { if (s) console.debug('[friendlyVideoError] raw:', s.slice(0, 200)); } catch (_e) {}
    if (!s) return "生成失败，请稍后重试";
    if (/timeout|timed out|超时/.test(s)) return "等待时间过长，请稍后再试";
    if (/network|econnreset|enet|fetch|connection/.test(s)) return "网络波动，请稍后再试";
    if (/content|policy|safety|blocked|敏感|违规/.test(s)) return "素材不符合内容规范，请调整后重试";
    return "生成失败，请稍后重试";
  }

  /* File I/O */
  function abToBase64(buffer) {
    var binary = "", bytes = new Uint8Array(buffer), chunk = 0x8000;
    for (var i = 0; i < bytes.byteLength; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)));
    }
    return btoa(binary);
  }

  function toFileUrlFromNative(p) {
    if (!p) return p; if (/^file:/i.test(p)) return p;
    var s = p.replace(/\\/g, "/"); if (!s.startsWith("/")) s = "/" + s;
    return "file://" + s;
  }

  async function fetchVideoBuffer(url) {
    var res; try { res = await fetch(url); } catch (e) { throw new Error((e && e.message || String(e)) + " — 网络请求失败"); }
    if (!res.ok) throw new Error("下载失败 HTTP " + res.status);
    return await res.arrayBuffer();
  }

  function _downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
  }

  async function saveBufferToDisk(buf) {
    var name = "qd_" + Date.now() + ".mp4";
    var blob = new Blob([buf], { type: "video/mp4" });
    _downloadBlob(blob, name);
    return name;
  }

  async function importVideoIntoPremiere() {
    console.log("[Web] Premiere Pro 导入不可用（Web 版）");
  }

  function tryVideoSrc(vidEl, src, label, timeoutMs) {
    return new Promise(function (resolve) {
      if (!src || !vidEl) { resolve(false); return; }
      vidEl.removeAttribute("src"); try { vidEl.load(); } catch (e) {}
      vidEl.setAttribute("src", src); vidEl.src = src;
      var settled = false;
      function done(ok) { if (settled) return; settled = true; vidEl.onerror = null; resolve(ok); }
      var timer = setTimeout(function () { done(false); }, timeoutMs);
      vidEl.onerror = function () { clearTimeout(timer); done(false); };
      vidEl.addEventListener("loadeddata", function () { clearTimeout(timer); try { vidEl.currentTime = 0.001; } catch (e) {} done(true); }, { once: true });
      try { vidEl.load(); } catch (e) {}
    });
  }

  /* Video task lifecycle — Phase 2：createVideoTask + pollVideoTask 已被 SSE
   * 版的 createWorkflowVideoTask + _attachTaskStream 取代，这里保留注释作为
   * 架构锚点，提示维护者不要再往本文件加客户端轮询代码。 */
  async function videoPipeline(task) {
    if (task._killed) { _persistVideoUrlToProject(task); return; }
    task.status = "fetching"; task.statusCn = "正在加载成片"; updateTaskCard(task);
    var vidEl = task.videoEl, ok = false;
    try {
      console.log("[Video] Pipeline start, url:", task.videoUrl ? task.videoUrl.slice(0, 80) : "null");

      if (!task._killed) {
        ok = await tryVideoSrc(vidEl, task.videoUrl, "directURL", 8000);
        if (ok) console.log("[Video] Direct URL playback OK");
      }

      if (!ok && !task._killed) {
        try {
          var buf = await fetchVideoBuffer(task.videoUrl);
          if (task.blobUrl) { try { URL.revokeObjectURL(task.blobUrl); } catch (e) {} }
          var blob = new Blob([buf], { type: "video/mp4" }); task.blobUrl = URL.createObjectURL(blob);
          ok = await tryVideoSrc(vidEl, task.blobUrl, "blob", 8000);
        } catch (dlErr) {
          console.warn("[Video] Download failed (likely CORS):", dlErr.message);
        }
      }

      if (task._killed) {
        task.status = "done"; task.statusCn = "已完成";
        _persistVideoUrlToProject(task);
        return;
      }

      task.previewOk = ok;
      if (task._videoLoading) task._videoLoading.hidden = true;
      if (ok && task._playOverlay) task._playOverlay.hidden = false;
      if (!ok && task._videoWrap) {
        task._videoWrap.hidden = false;
        task._videoWrap.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:20px;text-align:center">' +
            '<span class="material-symbols-outlined" style="font-size:48px;color:var(--color-primary,#5a5e6a);opacity:0.4">play_circle</span>' +
            '<span style="font-size:12px;color:var(--color-on-surface-variant,#666)">视频已生成，点击下方「在线播放」查看</span>' +
          '</div>';
      }
      task._doneAt = Date.now();
      task.status = "done"; task.statusCn = "已完成"; updateTaskCard(task);
      console.log("[Video] Pipeline done, previewOk=" + ok);
      appendOutputHistory(task.videoUrl, task.serverTaskId);
      _persistVideoUrlToProject(task);
    } catch (e) {
      console.error("[Video] Pipeline error:", e);
      if (task._videoLoading) task._videoLoading.hidden = true;
      task.previewOk = false;
      task._doneAt = Date.now();
      task.status = "done"; task.statusCn = "已完成"; updateTaskCard(task);
      appendOutputHistory(task.videoUrl, task.serverTaskId);
      _persistVideoUrlToProject(task);
    }
    updateBadge();
  }

  function _persistVideoUrlToProject(task) {
    if (!task.videoUrl) return;
    var gIdx = task._groupIdx;
    if (gIdx === undefined || gIdx === null) return;
    var originId = task._projectId || (project && project.id);
    if (!originId) return;
    _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      if (!proj.storyboards[gIdx]) proj.storyboards[gIdx] = {};
      proj.storyboards[gIdx].videoUrl = task.videoUrl;
      if (task.videoAssetId) proj.storyboards[gIdx].videoAssetId = task.videoAssetId;
      if (task.fetchStatus) proj.storyboards[gIdx].fetchStatus = task.fetchStatus;
      if (task.serverTaskId) proj.storyboards[gIdx].videoTaskId = task.serverTaskId;
      proj.storyboards[gIdx].videoStatus = task.status || "done";
    });
    console.log("[Video] Persisted videoUrl to project.storyboards[" + gIdx + "]");
  }

  /* Video form helpers */
  function mimeFromName(n) { n = (n || "").toLowerCase(); if (n.endsWith(".png")) return "image/png"; if (n.endsWith(".webp")) return "image/webp"; if (n.endsWith(".gif")) return "image/gif"; return "image/jpeg"; }

  function pickImageFrame(which) {
    var input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.onchange = function () {
      if (!input.files || !input.files[0]) return;
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result;
        if (which === "start") { videoState.form.startDataUrl = dataUrl; showFramePrev("previewStart", dataUrl, "btnClearStart", "btnPickStart"); }
        else { videoState.form.endDataUrl = dataUrl; showFramePrev("previewEnd", dataUrl, "btnClearEnd", "btnPickEnd"); }
      };
      reader.readAsDataURL(input.files[0]);
    };
    input.click();
  }

  function showFramePrev(pid, url, cid, hid) {
    var p = $(pid), c = $(cid), h = $(hid);
    if (p) { p.hidden = false; p.style.backgroundImage = "url(" + url + ")"; }
    if (c) c.hidden = false; if (h) h.style.display = "none";
  }

  function hideFramePrev(which) {
    if (which === "start") {
      videoState.form.startDataUrl = "";
      var ps = $("previewStart"); if (ps) { ps.hidden = true; ps.style.backgroundImage = ""; }
      var cs = $("btnClearStart"); if (cs) cs.hidden = true; var bs = $("btnPickStart"); if (bs) bs.style.display = "";
    } else {
      videoState.form.endDataUrl = "";
      var pe = $("previewEnd"); if (pe) { pe.hidden = true; pe.style.backgroundImage = ""; }
      var ce = $("btnClearEnd"); if (ce) ce.hidden = true; var be = $("btnPickEnd"); if (be) be.style.display = "";
    }
  }

  function swapFrames() {
    var su = $("startUrl").value; $("startUrl").value = $("endUrl").value; $("endUrl").value = su;
    var t = videoState.form.startDataUrl; videoState.form.startDataUrl = videoState.form.endDataUrl; videoState.form.endDataUrl = t;
    if (videoState.form.startDataUrl) showFramePrev("previewStart", videoState.form.startDataUrl, "btnClearStart", "btnPickStart"); else hideFramePrev("start");
    if (videoState.form.endDataUrl) showFramePrev("previewEnd", videoState.form.endDataUrl, "btnClearEnd", "btnPickEnd"); else hideFramePrev("end");
  }

  function clampDur(d) {
    var n = Number(d);
    if (!Number.isFinite(n)) return 8;
    n = Math.round(n);
    if (n > 15) console.warn("[Duration] " + n + "s exceeds max 15s, clamped");
    return Math.min(15, Math.max(5, n));
  }

  async function createWorkflowVideoTask(gIdx, batchOpts) {
    _syncVideoRefs();
    if (activeTaskCount() >= MAX_CONCURRENT) throw new Error("同时处理数已达上限");

    var opts = batchOpts || {};

    if (!project || !project.storyboards || !project.storyboards[gIdx]) throw new Error("片段 " + (gIdx + 1) + " 无数据");
    var sb = project.storyboards[gIdx];
    var groups = getStoryboardGroups();
    var group = groups[gIdx];
    if (!group) throw new Error("片段 " + (gIdx + 1) + " 分组异常");

    var task = createVideoTaskObj("片段" + (gIdx + 1) + ": " + ((sb.videoPrompt || "").slice(0, 80) || "准备中"), false);
    task.status = "preparing"; task.statusCn = "提交中"; task.statusEn = "提交中";
    task._groupIdx = gIdx;
    task._projectId = project ? project.id : null;
    videoState.tasks.unshift(task);
    while (videoState.tasks.length > MAX_TASKS_TOTAL) {
      var last = videoState.tasks[videoState.tasks.length - 1];
      if (isTerminal(last)) { cleanupTask(last); videoState.tasks.pop(); } else break;
    }
    var card = createTaskCard(task);
    insertTaskCardToWraps(card);
    syncTaskListVisibility(); updateBadge();

    var quality = opts.quality || videoState.form.quality || "1080p";
    var videoModel = opts.videoModel || _currentVideoModelAlias();
    var ratio = opts.ratio || "16:9";
    var genAudio = opts.genAudio !== undefined ? opts.genAudio : true;
    var watermark = opts.watermark !== undefined ? opts.watermark : false;

    task.status = "submitting"; task.statusCn = "提交中"; task.statusEn = "提交中";
    updateTaskCard(task);

    // 单段重生成同样把 shotIndices 顶一份过去，避免后端拿到错误的 shot.dialogue
    var groupsForSingle = getStoryboardGroups();
    var gForSingle = groupsForSingle[gIdx];
    var targetsForSingle = [{
      groupIdx: gIdx,
      idx: gIdx,
      storyboardIdx: gIdx,
      shotIndices: (gForSingle && gForSingle.shotIndices) || [],
    }];

    try {
      var resp = await apiPost("/api/batch/start", {
        batchType: "videos",
        projectId: project.id,
        storyboardIndices: [gIdx],
        targets: targetsForSingle,
        options: {
          quality: quality,
          videoModel: videoModel,
          ratio: ratio,
          genAudio: genAudio,
          watermark: watermark,
        },
      });

      if (resp && resp.errorCode === "MODEL_UNAVAILABLE") {
        await _handleModelUnavailable(task, resp, { videoModel: videoModel });
        return;
      }
      if (!resp || resp.error || !resp.batchId) {
        task.status = "failed"; task.statusCn = _friendlyVideoError((resp && resp.error) || "提交失败");
        updateTaskCard(task); updateBadge();
        return;
      }

      var batchId = resp.batchId;
      task.status = "polling"; task.statusCn = "生成中";
      updateTaskCard(task);

      function findSingleTask(taskId) {
        if (!taskId) return null;
        for (var k = 0; k < videoState.tasks.length; k++) {
          if (videoState.tasks[k].serverTaskId === taskId) return videoState.tasks[k];
        }
        return null;
      }

      subscribeBatch(batchId, {
        onTaskStarted: function (data) {
          var taskId = data.taskId; if (!taskId) return;
          task.serverTaskId = taskId;
          task.status = "polling"; task.statusCn = "生成中";
          updateTaskCard(task);
        },
        onTaskProgress: function () {
          if (task.status !== "polling") { task.status = "polling"; task.statusCn = "生成中"; updateTaskCard(task); }
        },
        onTaskCompleted: function (data) {
          var url = data.resultUrl || data.videoUrl || "";
          var extra = (data && data.extra) || {};
          var eIdx = (typeof extra.groupIdx === "number") ? extra.groupIdx : null;
          if (project && eIdx != null && Array.isArray(project.storyboards)) {
            if (!project.storyboards[eIdx]) project.storyboards[eIdx] = {};
            if (typeof extra.readyForEdit === "boolean") {
              project.storyboards[eIdx].readyForEdit = extra.readyForEdit;
            }
          }
          if (url) {
            task.videoUrl = url;
            if (project && task._groupIdx != null && Array.isArray(project.storyboards)) {
              if (!project.storyboards[task._groupIdx]) project.storyboards[task._groupIdx] = {};
              project.storyboards[task._groupIdx].videoUrl = url;
            }
            videoPipeline(task).then(function () { updateBadge(); renderBatchClipList(); });
          } else {
            task.status = "failed"; task.statusCn = "生成完成但无视频地址";
            updateTaskCard(task); updateBadge();
          }
        },
        onTaskFailed: function (data) {
          task.status = "failed";
          task.statusCn = _friendlyVideoError(data.reason || data.errorMsg || "failed");
          updateTaskCard(task); updateBadge();
          renderBatchClipList();
        },
        onBatchCompleted: function () {},
        onClose: function () {},
      });
    } catch (e) {
      if (_isBillingGateError(e)) {
        task.status = 'failed';
        task.statusCn = _billingGateMessage(e, videoModel) || '积分不足';
        updateTaskCard(task); updateBadge();
        showBillingPaywall(e.billing || null);
        showToast(task.statusCn, 'warn');
        return;
      }
      task.status = "failed"; task.statusCn = _friendlyVideoError((e && e.message) || e);
      updateTaskCard(task); updateBadge();
      showToast(task.statusCn, "error");
    }
  }

  /* Phase 2 · 2.6.4：把单任务挂到 SSE 流上 */
  function _attachTaskStream(task, taskId) {
    if (task._sseHandle) { try { task._sseHandle.close(); } catch (_e) {} task._sseHandle = null; }
    task._sseHandle = subscribeTask(taskId, {
      onProgress: function () {
        if (task.status !== "polling") {
          task.status = "polling"; task.statusCn = "生成中"; updateTaskCard(task);
        }
      },
      onCompleted: function (data) {
        var url = data.resultUrl || data.videoUrl || "";
        // 簇 11：持久化链路产出的 assetId/fetchStatus 如果后端顺手带过来，
        // 就挂到 task 上，让 videoPipeline 能把"下载中→可播"写进分镜。
        if (data && data.assetId) task.videoAssetId = data.assetId;
        if (data && data.fetchStatus) task.fetchStatus = data.fetchStatus;
        if (url) {
          task.videoUrl = url;
          if (project && task._groupIdx != null && Array.isArray(project.storyboards)) {
            if (!project.storyboards[task._groupIdx]) project.storyboards[task._groupIdx] = {};
            project.storyboards[task._groupIdx].videoUrl = url;
          }
          videoPipeline(task).then(function () { updateBadge(); });
        } else {
          task.status = "failed"; task.statusCn = "生成完成但无视频地址";
          updateTaskCard(task); updateBadge();
        }
      },
      onFailed: function (data) {
        task.status = "failed";
        task.statusCn = _friendlyVideoError(data.reason || "failed");
        updateTaskCard(task); updateBadge();
      },
      onClose: function () { task._sseHandle = null; },
    });
  }

  var _VIDEO_MODEL_LABEL = { seedance: "Seedance", "seedance-fast": "Seedance Fast", kling: "可灵" };

  /* MODEL_UNAVAILABLE handler: ask the user whether to retry on a sibling
   * model that still has healthy channels. */
  async function _handleModelUnavailable(task, resp, originalBody) {
    var requested = (resp && resp.requestedModel) || (originalBody && originalBody.videoModel) || "";
    var alts = ((resp && resp.availableModels) || []).filter(function (a) {
      return _VIDEO_MODEL_LABEL[a];
    });
    var reqLabel = _VIDEO_MODEL_LABEL[requested] || requested || "所选模型";

    if (alts.length === 0) {
      task.status = "failed";
      task.statusCn = reqLabel + " 通道繁忙，请稍后重试";
      updateTaskCard(task); updateBadge();
      showToast(task.statusCn, "error");
      return;
    }

    var nextAlias = alts[0];
    var nextLabel = _VIDEO_MODEL_LABEL[nextAlias];
    task.status = "failed";
    task.statusCn = reqLabel + " 通道繁忙";
    updateTaskCard(task); updateBadge();

    showConfirm(
      reqLabel + " 通道繁忙",
      reqLabel + " 当前所有通道都暂时不可用。要改用 " + nextLabel + " 继续生成吗？",
      async function () {
        _selectBatchVideoModel(nextAlias);
        if (task._groupIdx == null || !project) {
          task.statusCn = "无法切换模型重试：缺少分镜索引";
          updateTaskCard(task); updateBadge();
          return;
        }
        try {
          await createWorkflowVideoTask(task._groupIdx, Object.assign({}, _getDefaultBatchOpts(), { videoModel: nextAlias }));
          renderBatchClipList();
        } catch (e) {
          if (_isBillingGateError(e)) {
            task.statusCn = _billingGateMessage(e, nextAlias) || '积分不足';
            updateTaskCard(task); updateBadge();
            showBillingPaywall(e.billing || null);
            showToast(task.statusCn, 'warn');
            return;
          }
          task.statusCn = _friendlyVideoError((e && e.message) || e);
          updateTaskCard(task); updateBadge();
          showToast(task.statusCn, "error");
        }
      }
    );
  }

  /* ---- 批量生成页 ---- */

  function refreshBatchPage() {
    _syncVideoRefs();
    var needVP = $("batchNeedPrompts");
    var ready = $("batchReady");
    if (!project || !project.videoPromptsApproved || !project.storyboards) {
      if (needVP) needVP.hidden = false;
      if (ready) ready.hidden = true;
      var bcl = $("batchClipList"); if (bcl) bcl.innerHTML = "";
      return;
    }
    if (needVP) needVP.hidden = true;
    if (ready) ready.hidden = false;
    renderBatchClipList();

    var clipList = $("batchClipList");
    if (clipList && !clipList._regenBound) {
      clipList._regenBound = true;
      clipList.addEventListener("click", function (e) {
        var senBtn = e.target.closest("[data-action='goto-fix-sensitive']");
        if (senBtn) {
          var gi = parseInt(senBtn.dataset.gidx, 10);
          if (!isNaN(gi)) { _vpSelectedGroup = gi; switchPage("prompts"); }
          return;
        }
        var btn = e.target.closest("[data-action='regen-clip']") || e.target.closest("[data-action='gen-clip']");
        if (!btn) return;
        var gIdx = parseInt(btn.dataset.gidx, 10);
        if (isNaN(gIdx)) return;
        regenSingleClip(gIdx);
      });
    }

    var ratioGrid = $("batchRatioGrid");
    if (ratioGrid && !ratioGrid._bound) {
      ratioGrid._bound = true;
      ratioGrid.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-ratio]");
        if (!btn) return;
        var ratio = btn.dataset.ratio;
        $("batchRatio").value = ratio;
        ratioGrid.querySelectorAll("button").forEach(function (b) {
          var isActive = b.dataset.ratio === ratio;
          b.className = "py-3 rounded-lg text-xs transition-colors " +
            (isActive ? "border-2 border-primary-fixed-dim bg-surface-container-low text-primary font-bold"
                      : "border border-outline-variant/20 hover:border-primary-fixed-dim text-on-surface-variant font-medium");
        });
      });
    }

    var modelGrid = $("batchVideoModelGrid");
    if (modelGrid && !modelGrid._bound) {
      modelGrid._bound = true;
      // Restore last choice across sessions (default kling)
      try {
        var saved = localStorage.getItem("qd_video_model");
        if (saved) _selectBatchVideoModel(saved);
      } catch (_e) {}
      modelGrid.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-video-model]");
        if (!btn) return;
        _selectBatchVideoModel(btn.dataset.videoModel);
      });
    }

    _initBatchClipScroll();
    syncTaskListVisibility();
  }

  function _initBatchClipScroll() {
    var list = $("batchClipList");
    var thumb = $("batchScrollThumb");
    var btnL = $("batchScrollLeft");
    var btnR = $("batchScrollRight");
    if (!list || !thumb) return;

    function updateThumb() {
      var sw = list.scrollWidth, cw = list.clientWidth, sl = list.scrollLeft;
      if (sw <= cw) { thumb.style.width = "100%"; thumb.style.left = "0"; return; }
      var ratio = cw / sw;
      var thumbW = Math.max(ratio * 100, 10);
      var thumbL = (sl / (sw - cw)) * (100 - thumbW);
      thumb.style.width = thumbW + "%";
      thumb.style.left = thumbL + "%";
    }

    list.removeEventListener("scroll", updateThumb);
    list.addEventListener("scroll", updateThumb);
    updateThumb();

    if (btnL && !btnL._bound) {
      btnL._bound = true;
      btnL.addEventListener("click", function () {
        list.scrollBy({ left: -340, behavior: "smooth" });
      });
    }
    if (btnR && !btnR._bound) {
      btnR._bound = true;
      btnR.addEventListener("click", function () {
        list.scrollBy({ left: 340, behavior: "smooth" });
      });
    }

    var trackEl = thumb.parentElement;
    if (trackEl && !trackEl._bound) {
      trackEl._bound = true;
      trackEl.addEventListener("click", function (e) {
        var rect = trackEl.getBoundingClientRect();
        var clickRatio = (e.clientX - rect.left) / rect.width;
        var maxScroll = list.scrollWidth - list.clientWidth;
        list.scrollTo({ left: clickRatio * maxScroll, behavior: "smooth" });
      });
    }
  }

  function _findTaskByGroup(gIdx) {
    for (var i = 0; i < videoState.tasks.length; i++) {
      if (videoState.tasks[i]._groupIdx === gIdx) return videoState.tasks[i];
    }
    return null;
  }

  async function renderBatchClipList() {
    _syncVideoRefs();
    var list = $("batchClipList");
    if (!list || !project || !project.storyboards) return;
    var groups = getStoryboardGroups();

    var prefetchTargets = [];
    groups.forEach(function (group, gIdx) {
      var sb = project.storyboards[gIdx];
      if (!sb || !sb.videoPrompt) return;
      project.storyboards[gIdx] = sb;
      prefetchTargets.push({ gIdx: gIdx, group: group, sb: sb });
    });

    await Promise.all(prefetchTargets.map(async function (t) {
      var jobs = [_vpFetchAndCache(t.sb)];
      if (!t.sb._matchedRefs || t.sb._matchedRefs._forText !== t.sb.videoPrompt) {
        jobs.push((async function () {
          try {
            var resp = await apiPost('/api/assets/match-references', {
              project: { assets: project.assets },
              group: t.group,
              promptText: t.sb.videoPrompt || '',
            });
            t.sb._matchedRefs = resp.refs || [];
            t.sb._matchedRefs._forText = t.sb.videoPrompt;
          } catch (e) {
            console.warn('[BatchClip] match-references failed:', e);
            t.sb._matchedRefs = t.sb._matchedRefs || [];
          }
        })());
      }
      await Promise.all(jobs);
    }));

    list.innerHTML = "";
    var validCount = 0;
    var totalDurAll = 0;

    groups.forEach(function (group, gIdx) {
      var sb = project.storyboards[gIdx] || {};
      if (!sb.videoPrompt) return;
      validCount++;
      var totalDur = 0;
      group.shots.forEach(function (s) { totalDur += (s.duration || 4); });
      totalDurAll += totalDur;

      var bcThumbSrc = sb.rawUrl || sb.imageUrl || '';

      var charCount = 0, sceneCount = 0;
      var assetRefs = sb._matchedRefs || [];
      assetRefs.forEach(function (r) {
        if (r.type === "character") charCount++;
        else sceneCount++;
      });

      var vpCache = _vpGetCache(sb);
      var batchSenHits = vpCache.sensitiveHits || [];

      var clipTask = _findTaskByGroup(gIdx);
      var statusLabel = '', statusClass = '';
      if (clipTask && clipTask.status === 'failed') {
        statusLabel = '失败'; statusClass = 'bg-error/10 text-error';
      } else if (clipTask && !isTerminal(clipTask)) {
        statusLabel = '生成中'; statusClass = 'bg-primary/10 text-primary';
      } else if (clipTask && clipTask.status === 'done') {
        statusLabel = '完成 FINISHED'; statusClass = 'bg-secondary-container text-on-secondary-container';
      } else if (!clipTask && sb.videoUrl) {
        statusLabel = '完成 FINISHED'; statusClass = 'bg-secondary-container text-on-secondary-container';
      } else {
        statusLabel = '就绪 READY'; statusClass = 'bg-primary text-on-primary';
      }

      var card = document.createElement("div");
      card.className = "flex-shrink-0 w-80 bg-surface-container-lowest rounded-xl p-4 shadow-[0px_10px_30px_rgba(0,0,0,0.01)] border border-outline-variant/10 snap-start" +
        ((clipTask && clipTask.status === 'done') || (!clipTask && sb.videoUrl) ? '' : clipTask && !isTerminal(clipTask) ? ' opacity-90' : '');
      card.dataset.groupIdx = gIdx;

      var imgHtml = bcThumbSrc
        ? '<img class="w-full h-full object-cover opacity-60 grayscale" src="' + escapeHtml(bcThumbSrc) + '" />'
        : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-3xl text-on-surface-variant/15">movie_filter</span></div>';

      card.innerHTML =
        '<div class="relative h-44 rounded-lg overflow-hidden mb-4 bg-surface-container-low">' +
          imgHtml +
          '<div class="absolute inset-0 bg-gradient-to-t from-surface-container-lowest/80 to-transparent"></div>' +
          '<div class="absolute bottom-3 left-3 flex items-center gap-2">' +
            '<span class="px-2 py-1 bg-surface-container-lowest/90 backdrop-blur text-[10px] font-black rounded-sm">' + String(totalDur).padStart(2, '0') + ':00s</span>' +
            '<span class="px-2 py-1 ' + statusClass + ' text-[10px] font-black rounded-sm" style="white-space:nowrap">' + statusLabel + '</span>' +
          '</div>' +
        '</div>' +
        '<h4 class="text-sm font-bold mb-3">' + String(gIdx + 1).padStart(2, '0') + '_片段_' + escapeHtml((group.shots[0] && group.shots[0].shotType) || 'Clip') + '</h4>' +
        (batchSenHits.length
          ? '<div class="flex items-center gap-1.5 mb-3 px-2 py-1.5 rounded-lg bg-error/8 cursor-pointer" data-action="goto-fix-sensitive" data-gidx="' + gIdx + '" title="点击前往提示词页面修改">' +
              '<span class="material-symbols-outlined text-error text-xs">shield</span>' +
              '<span class="text-[10px] text-error font-medium">' + batchSenHits.length + ' 个敏感词</span>' +
            '</div>'
          : '') +
        '<div class="flex items-center justify-between py-3 border-t border-outline-variant/5">' +
          '<div class="flex gap-4">' +
            '<div class="flex items-center gap-1 opacity-60">' +
              '<span class="material-symbols-outlined text-[14px]">person</span>' +
              '<span class="text-[10px] font-bold">' + charCount + '</span>' +
            '</div>' +
            '<div class="flex items-center gap-1 opacity-60">' +
              '<span class="material-symbols-outlined text-[14px]">landscape</span>' +
              '<span class="text-[10px] font-bold">' + sceneCount + '</span>' +
            '</div>' +
          '</div>' +
          (clipTask && !isTerminal(clipTask)
            ? ''
            : '<button type="button" class="flex items-center gap-1 px-3 py-1.5 bg-primary text-on-primary rounded-full text-[10px] font-bold tracking-wide hover:opacity-90 transition-all active:scale-95" data-action="gen-clip" data-gidx="' + gIdx + '">' +
                '<span class="material-symbols-outlined text-sm">play_arrow</span>' +
                (clipTask && clipTask.status === 'done' ? '重新生成' : '生成') +
              '</button>') +
        '</div>';
      list.appendChild(card);
    });

    var countEl = $("batchClipCount");
    if (countEl) countEl.textContent = validCount + " 个片段";

    var estEl = $("batchEstTime");
    if (estEl) {
      var estMin = Math.ceil(totalDurAll * 3 / 60);
      estEl.textContent = "~ " + estMin + " 分钟";
    }
  }

  function _selectBatchVideoModel(alias) {
    var grid = $("batchVideoModelGrid");
    var hidden = $("batchVideoModel");
    if (!grid || !hidden) return;
    var allowed = ["seedance", "seedance-fast", "grok"];
    if (allowed.indexOf(alias) < 0) alias = "grok";
    hidden.value = alias;
    try { localStorage.setItem("qd_video_model", alias); } catch (_e) {}
    grid.querySelectorAll("button[data-video-model]").forEach(function (b) {
      var active = b.dataset.videoModel === alias;
      b.className = "py-3 rounded-lg text-xs transition-colors " +
        (active ? "border-2 border-primary-fixed-dim bg-surface-container-low text-primary font-bold"
                : "border border-outline-variant/20 hover:border-primary-fixed-dim text-on-surface-variant font-medium");
    });
  }

  function _currentVideoModelAlias() {
    var el = $("batchVideoModel");
    var v = el ? (el.value || "").trim() : "";
    return v || "grok";
  }

  function _getDefaultBatchOpts() {
    return {
      videoModel: _currentVideoModelAlias(),
      ratio: ($("batchRatio") && $("batchRatio").value) || "16:9",
      quality: ($("batchQuality") && $("batchQuality").value) || "1080p",
      genAudio: $("batchAudio") ? $("batchAudio").checked : true,
      watermark: $("batchWatermark") ? $("batchWatermark").checked : false,
      autoImport: $("batchAutoImport") ? $("batchAutoImport").checked : true
    };
  }

  async function regenSingleClip(gIdx) {
    if (activeTaskCount() >= MAX_CONCURRENT) { showToast("最多同时运行 " + MAX_CONCURRENT + " 个任务", "warn"); return; }

    try {
      await createWorkflowVideoTask(gIdx, _getDefaultBatchOpts());
      renderBatchClipList();
    } catch (e) {
      showToast("片段 " + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
  }

  /* Phase 2 · 2.6.3：批量生成全权由后端 batch_runner 调度。
   * 前端只发一次 POST /api/batch/start，并订阅 /api/batch/<batchId>/stream
   * 来获取每个分镜的生命周期事件。再也不用前端 plan-batch / 轮询。 */
  var _batchHandle = null;

  function _getMissingPencilChars() {
    if (!project || !project.assets || !Array.isArray(project.assets.characters)) return [];
    return project.assets.characters.filter(function (c) {
      var et = (c.entityType || "human").toString().toLowerCase();
      if (et === "non-human") return false;      // 这类不需要转绘
      if (!c.realPhotoUrl) return false;           // 第一步都没完成，跳过不计
      return !c.pencilUrl;
    });
  }

  async function _waitForPencilReady(hintEl) {
    var MAX_WAIT_MS = 15 * 60 * 1000;
    var start = Date.now();
    var initialMissing = _getMissingPencilChars().length;
    if (initialMissing === 0) return { ok: true };
    while (Date.now() - start < MAX_WAIT_MS) {
      var still = _getMissingPencilChars();
      var doneNow = Math.max(0, initialMissing - still.length);
      if (hintEl) hintEl.textContent = "风格图补全中 " + doneNow + "/" + initialMissing + "，视频生成将在就绪后自动开始…";
      if (still.length === 0) return { ok: true };
      // 后台托管为 0 说明之前任务已经失败退出，不会自己恢复
      if (getBackgroundStylizeCount() === 0) return { ok: false, stuck: true };
      await new Promise(function (r) { setTimeout(r, 4000); });
    }
    return { ok: false, timeout: true };
  }

  async function startBatchGeneration() {
    _syncVideoRefs();
    if (!project || !project.storyboards) return;

    var batchOpts = _getDefaultBatchOpts();
    var groups = getStoryboardGroups();
    var indices = [];
    var allHaveVideo = true; // 所有有 videoPrompt 的 sb 是否都已生成过视频
    var hasAnyPrompt = false;
    for (var i = 0; i < groups.length; i++) {
      if (!project.storyboards[i] || !project.storyboards[i].videoPrompt) continue;
      hasAnyPrompt = true;
      if (project.storyboards[i].videoUrl) continue;
      allHaveVideo = false;
      indices.push(i);
    }

    if (!indices.length) {
      if (!hasAnyPrompt) {
        showToast("没有视频提示词，请先去『视频提示词』页生成", "warn");
        return;
      }
      // 所有都已生成 → 弹确认框，问是否全部重新生成
      var redoOk = false;
      try {
        redoOk = await showConfirm(
          "全部分镜已有视频",
          "所有分镜已经生成过视频。\n是否清除现有视频，全部重新生成？\n（旧视频文件保留在历史记录中，不会丢失）",
          "全部重新生成",
          "取消",
        );
      } catch (_e) { redoOk = false; }
      if (!redoOk) return;
      // 清除 sb 上的 videoUrl，重新跑全部
      for (var j = 0; j < groups.length; j++) {
        if (project.storyboards[j] && project.storyboards[j].videoPrompt) {
          delete project.storyboards[j].videoUrl;
          delete project.storyboards[j].videoTaskId;
          delete project.storyboards[j].videoCoverUrl;
          delete project.storyboards[j].videoStatus;
          delete project.storyboards[j].videoMode;
          delete project.storyboards[j].videoTaskFinishedAt;
          delete project.storyboards[j].videoDurationSec;
          indices.push(j);
        }
      }
      // 把变更落到后端
      try { saveProject(); } catch (_e) {}
      renderBatchClipList();
      showToast("将重新生成 " + indices.length + " 个分镜的视频", "ok");
    }

    var btn = $("btnStartBatch");
    var hint = $("batchHint");

    // 前置检查：视频生成硬依赖 pencilUrl（video_content_builder.py 里缺
    // pencilUrl 的角色直接跳过），所以如果资产阶段的后台转绘还没跑完，
    // 我们这里要等一等再提交，避免出来的视频少画角色
    var missing = _getMissingPencilChars();
    if (missing.length > 0) {
      var bgRunning = getBackgroundStylizeCount();
      var confirmMsg;
      var confirmOk;
      var confirmCancel;
      if (bgRunning > 0) {
        confirmMsg = "检测到 " + missing.length + " 个角色的风格图还在后台补全中（" +
          bgRunning + " 个进行中）。视频画面里这些角色依赖风格图才能保持一致。\n\n" +
          "要等风格图全部就绪再开始生成视频吗？";
        confirmOk = "等待就绪再开始";
        confirmCancel = "直接开始（可能缺角色）";
      } else {
        confirmMsg = "检测到 " + missing.length + " 个角色缺少风格图，且后台没有补全任务在跑。\n" +
          "这些角色会被跳过画面。\n\n要先去资产页手动补全，还是直接开始？";
        confirmOk = "直接开始";
        confirmCancel = "返回资产页";
      }
      var waitDecision;
      try {
        waitDecision = await showConfirm("风格图未就绪", confirmMsg, confirmOk, confirmCancel);
      } catch (_e) {
        waitDecision = false;
      }
      if (bgRunning > 0) {
        if (waitDecision) {
          if (btn) btn.disabled = true;
          if (hint) hint.textContent = "等待风格图补全…";
          var waitResult = await _waitForPencilReady(hint);
          if (!waitResult.ok) {
            if (btn) btn.disabled = false;
            if (hint) hint.textContent = "";
            var stillMissing = _getMissingPencilChars().length;
            showToast(
              (waitResult.timeout ? "等待超时，" : "后台补全已停止，") +
              "仍有 " + stillMissing + " 个角色缺风格图。可返回资产页手动重试或直接开始视频。",
              "warn",
            );
            return;
          }
          // 就绪，继续走下面的流程
        } else {
          // 用户选"直接开始（可能缺角色）"——继续流程
        }
      } else {
        if (!waitDecision) {
          // 用户选"返回资产页"
          return;
        }
      }
    }

    if (btn) btn.disabled = true;
    if (hint) hint.textContent = "正在提交批量任务…";

    if (_batchHandle) { try { _batchHandle.close(); } catch (_e) {} _batchHandle = null; }

    // 为每个分镜插入 UI placeholder（serverTaskId 暂空，等 task_started 回填）
    indices.forEach(function (gIdx) {
      var sb = project.storyboards[gIdx] || {};
      var existing = _findTaskByGroup(gIdx);
      if (existing && !isTerminal(existing)) return;
      var task = createVideoTaskObj("片段" + (gIdx + 1) + ": " + (sb.videoPrompt || "").slice(0, 80), false);
      task.status = "preparing"; task.statusCn = "排队中"; task.statusEn = "queued";
      task._groupIdx = gIdx;
      task._projectId = project.id;
      videoState.tasks.unshift(task);
      while (videoState.tasks.length > MAX_TASKS_TOTAL) {
        var last = videoState.tasks[videoState.tasks.length - 1];
        if (isTerminal(last)) { cleanupTask(last); videoState.tasks.pop(); } else break;
      }
      insertTaskCardToWraps(createTaskCard(task));
      updateTaskCard(task);
    });
    syncTaskListVisibility(); updateBadge();
    renderBatchClipList();

    // 用户反馈："片段台词重复 / 跟剧本不对"——根因是后端拿不到本组对应的
    // shot.dialogue（老 storyboards 没存 shotIndices）。前端这里把当前分组
    // 的 shotIndices 一起传过去，video_segments executor 就能精确取本组台词。
    var groupsForBatch = getStoryboardGroups();
    var targetsForBatch = indices.map(function (gi) {
      var g = groupsForBatch[gi];
      return {
        groupIdx: gi,
        idx: gi,
        storyboardIdx: gi,
        shotIndices: (g && g.shotIndices) || [],
      };
    });

    var resp;
    try {
      resp = await apiPost("/api/batch/start", {
        batchType: "videos",
        projectId: project.id,
        storyboardIndices: indices,
        targets: targetsForBatch,
        options: {
          quality: batchOpts.quality,
          videoModel: batchOpts.videoModel,
          ratio: batchOpts.ratio,
          genAudio: batchOpts.genAudio,
          watermark: batchOpts.watermark,
        },
      });
    } catch (e) {
      if (btn) btn.disabled = false;
      if (hint) hint.textContent = "提交失败：" + ((e && e.message) || e);
      showToast("批量提交失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      return;
    }

    if (!resp || resp.error || !resp.batchId) {
      if (btn) btn.disabled = false;
      var errMsg = (resp && resp.error) || "未能创建批量任务";
      if (hint) hint.textContent = errMsg;
      showToast(errMsg, "error");
      return;
    }

    var batchId = resp.batchId;
    if (hint) hint.textContent = "已提交 " + indices.length + " 个分镜，等待后端生成…";

    var totalDone = 0, totalFail = 0, total = indices.length;
    function updateHint() {
      if (!hint) return;
      hint.textContent = "批量进度 " + (totalDone + totalFail) + "/" + total +
        (totalFail ? "（失败 " + totalFail + "）" : "");
    }

    function findTaskByServerId(taskId) {
      if (!taskId) return null;
      for (var k = 0; k < videoState.tasks.length; k++) {
        if (videoState.tasks[k].serverTaskId === taskId) return videoState.tasks[k];
      }
      return null;
    }

    function bindTaskStarted(data) {
      // batch_runner 的 task_started 事件 payload: { taskId, targetSeq, target }
      // 其中 target 是 batch_api 展开的 {idx, storyboardIdx}
      var taskId = data.taskId;
      if (!taskId) return;
      var tgt = data.target || {};
      var gIdx = tgt.storyboardIdx != null ? tgt.storyboardIdx
               : tgt.idx != null ? tgt.idx
               : data.targetIdx;
      if (gIdx == null) return;
      var t = _findTaskByGroup(gIdx);
      if (!t) return;
      t.serverTaskId = taskId;
      t.status = "polling"; t.statusCn = "生成中";
      updateTaskCard(t);
      _registerServerTask(taskId, "video", "video", gIdx);
    }

    // 把 SSE 回调提取为具名函数 → polling 兜底也能直接调用它们
    var _seenDone = Object.create(null);
    var _seenFailed = Object.create(null);

    // 当 SSE task_started 没到时，靠 groupIdx 兜底绑 serverTaskId
    function ensureTaskBound(taskId, gi) {
      if (!taskId) return null;
      var existing = findTaskByServerId(taskId);
      if (existing) return existing;
      if (gi == null) return null;
      var t = _findTaskByGroup(gi);
      if (!t) return null;
      t.serverTaskId = taskId;
      if (!t.status || t.status === "preparing") {
        t.status = "polling"; t.statusCn = "生成中"; updateTaskCard(t);
      }
      return t;
    }

    function handleTaskCompleted(data) {
      if (data && data.taskId) {
        if (_seenDone[data.taskId] || _seenFailed[data.taskId]) return;
        _seenDone[data.taskId] = true;
      }
      totalDone++;
      updateHint();
      var extra = (data && data.extra) || {};
      var gi = (typeof extra.groupIdx === "number") ? extra.groupIdx : null;
      var t = findTaskByServerId(data.taskId) || ensureTaskBound(data.taskId, gi);
      if (!t) return;
      var url = data.resultUrl || data.videoUrl || "";
      var gIdx = gi != null ? gi : t._groupIdx;
      if (project && gIdx != null && Array.isArray(project.storyboards)) {
        if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
        if (typeof extra.readyForEdit === "boolean") {
          project.storyboards[gIdx].readyForEdit = extra.readyForEdit; // arch-guard:allow-ready-for-edit 后端 gate 镜像
        }
      }
      if (project && extra.editReadiness && typeof extra.editReadiness === "object") {
        if (!project.editData) project.editData = {};
        project.editData.readiness = extra.editReadiness; // arch-guard:allow-editdata gate 全景镜像（只读）
      }
      if (url) {
        t.videoUrl = url;
        if (project && t._groupIdx != null && Array.isArray(project.storyboards)) {
          if (!project.storyboards[t._groupIdx]) project.storyboards[t._groupIdx] = {};
          project.storyboards[t._groupIdx].videoUrl = url;
        }
        videoPipeline(t).then(function () { updateBadge(); renderBatchClipList(); });
      } else {
        t.status = "failed"; t.statusCn = "生成完成但无视频地址";
        updateTaskCard(t); updateBadge();
      }
    }

    function handleTaskFailed(data) {
      if (data && data.taskId) {
        if (_seenFailed[data.taskId] || _seenDone[data.taskId]) return;
        _seenFailed[data.taskId] = true;
      }
      totalFail++;
      updateHint();
      var t = findTaskByServerId(data.taskId);
      if (!t) return;
      t.status = "failed";
      t.statusCn = _friendlyVideoError(data.reason || data.errorMsg || "failed");
      updateTaskCard(t); updateBadge();
      renderBatchClipList();
    }

    // ===== Polling fallback =====
    var _pollTimer = null;
    function _stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }
    async function _pollOnce() {
      try {
        var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
        if (!snap) return;
        if (Array.isArray(snap.tasks)) {
          snap.tasks.forEach(function (st) {
            var tid = st.taskId || st.task_id;
            if (!tid) return;
            var tgt = st.target || {};
            var gi = tgt.storyboardIdx != null ? tgt.storyboardIdx
                   : tgt.groupIdx != null ? tgt.groupIdx
                   : tgt.idx != null ? tgt.idx
                   : null;
            // running/queued 阶段也要确保前端卡片绑了 taskId（SSE 可能丢 task_started）
            if (st.status === "running" || st.status === "queued") {
              ensureTaskBound(tid, gi);
              return;
            }
            if (st.status === "completed" && !_seenDone[tid]) {
              var r = st.result || {};
              var url = r.resultUrl || r.url || (r.patch && r.patch.url) || "";
              var extra = r.extra || {};
              if (gi != null && extra.groupIdx == null) extra.groupIdx = gi;
              handleTaskCompleted({ taskId: tid, resultUrl: url, videoUrl: url, extra: extra });
            } else if (st.status === "failed" && !_seenFailed[tid]) {
              handleTaskFailed({ taskId: tid, reason: st.errorMsg || st.error_msg, errorMsg: st.errorMsg || st.error_msg });
            }
          });
        }
        if (snap.status === "succeeded" || snap.status === "failed" ||
            snap.status === "completed" || snap.status === "cancelled") {
          _stopPoll();
          if (btn) btn.disabled = false;
          if (hint) hint.textContent = "批量完成 " + totalDone + "/" + total +
            (totalFail ? "（失败 " + totalFail + "）" : "");
        }
      } catch (e) {
        console.warn("[VideoBatch] poll failed:", e && e.message);
      }
    }
    _pollTimer = setInterval(_pollOnce, 5000);
    setTimeout(_pollOnce, 1500);

    _batchHandle = subscribeBatch(batchId, {
      onTaskStarted: bindTaskStarted,
      onTaskProgress: function (data) {
        var t = findTaskByServerId(data.taskId);
        if (!t) return;
        if (t.status !== "polling") { t.status = "polling"; t.statusCn = "生成中"; updateTaskCard(t); }
      },
      onTaskCompleted: handleTaskCompleted,
      onTaskFailed: handleTaskFailed,
      onBatchCompleted: function () {
        _stopPoll();
        if (btn) btn.disabled = false;
        if (hint) hint.textContent = "批量完成 " + totalDone + "/" + total +
          (totalFail ? "（失败 " + totalFail + "）" : "");
      },
      onClose: function () {
        _stopPoll();
        _batchHandle = null;
        if (btn) btn.disabled = false;
      },
    });
  }

  function buildVideoContent() {
    var promptRaw = $("prompt").value.trim();
    var qmap = { "720p": "标清720p", "1080p": "高清1080p", "4k": "超清4K" };
    var text = "【输出清晰度要求：" + (qmap[videoState.form.quality] || videoState.form.quality) + "】\n\n" + promptRaw;
    var mode = $("modeSelect") ? $("modeSelect").value : "first_last";
    var startRef = ($("startUrl").value.trim() || videoState.form.startDataUrl || "").trim();
    var endRef = ($("endUrl").value.trim() || videoState.form.endDataUrl || "").trim();
    var refVideo = ($("refVideoUrl") && $("refVideoUrl").value.trim()) || "";
    var refAudio = ($("refAudioUrl") && $("refAudioUrl").value.trim()) || "";
    var items = [{ type: "text", text: text }];
    var needImg = mode === "first_last" || mode === "ref_all" || mode === "multi_frame";
    if (needImg) {
      if (startRef) items.push({ type: "image_url", image_url: { url: startRef }, role: "reference_image" });
      if (endRef) items.push({ type: "image_url", image_url: { url: endRef }, role: "reference_image" });
    }
    if (refVideo) items.push({ type: "video_url", video_url: { url: refVideo }, role: "reference_video" });
    if (refAudio) items.push({ type: "audio_url", audio_url: { url: refAudio }, role: "reference_audio" });
    return items;
  }

  function bindQualityChips() {
    var root = $("qualityChips"); if (!root) return;
    root.querySelectorAll(".ds-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        root.querySelectorAll(".ds-chip").forEach(function (b) { b.classList.remove("is-on"); });
        btn.classList.add("is-on"); videoState.form.quality = btn.dataset.quality || "1080p";
      });
    });
  }

  function setupRatioDropdown() {
    var panel = $("panelRatio"), btn = $("btnRatio"), label = $("ratioLabel");
    if (!panel || !btn) return;
    panel.querySelectorAll(".ds-dd-item").forEach(function (item) {
      item.addEventListener("click", function (ev) {
        ev.stopPropagation(); videoState.form.ratio = item.dataset.ratio;
        if (label) label.textContent = item.dataset.ratio;
        panel.querySelectorAll(".ds-dd-item").forEach(function (x) { x.classList.remove("is-on"); });
        item.classList.add("is-on"); panel.hidden = true; btn.classList.remove("is-open");
      });
    });
    btn.addEventListener("click", function (ev) { ev.stopPropagation(); panel.hidden = !panel.hidden; btn.classList.toggle("is-open", !panel.hidden); });
  }

  function setupDurDropdown() {
    var panel = $("panelDur"), btn = $("btnDur"), label = $("durLabel");
    if (!panel || !btn) return;
    for (var s = 5; s <= 15; s++) {
      (function (sec) {
        var b = document.createElement("button"); b.type = "button";
        b.className = "ds-dd-item" + (sec === videoState.form.duration ? " is-on" : "");
        b.textContent = sec + "s";
        b.addEventListener("click", function (ev) {
          ev.stopPropagation(); videoState.form.duration = sec;
          if (label) label.textContent = sec + "s";
          panel.querySelectorAll(".ds-dd-item").forEach(function (x) { x.classList.remove("is-on"); });
          b.classList.add("is-on"); panel.hidden = true; btn.classList.remove("is-open");
        });
        panel.appendChild(b);
      })(s);
    }
    btn.addEventListener("click", function (ev) { ev.stopPropagation(); panel.hidden = !panel.hidden; btn.classList.toggle("is-open", !panel.hidden); });
  }

  /* Task action delegation */
  function handleVideoTaskAction(e) {
    _syncVideoRefs();
    var btn = e.target.closest("[data-action]"); if (!btn) return;
    var cardEl = btn.closest(".task-card"); if (!cardEl) return;
    var taskId = cardEl.dataset.taskId, task = null;
    for (var i = 0; i < videoState.tasks.length; i++) { if (videoState.tasks[i].localId === taskId) { task = videoState.tasks[i]; break; } }
    if (!task) return;
    var action = btn.dataset.action;
    if (action === "retry") retryFailedTask(task);
    else if (action === "download") {
      if (!task.videoUrl) return;
      if (task.blobUrl) {
        var a = document.createElement("a"); a.href = task.blobUrl; a.download = "qd_clip_" + Date.now() + ".mp4"; a.style.display = "none";
        document.body.appendChild(a); a.click(); setTimeout(function () { document.body.removeChild(a); }, 1000);
      } else {
        var origText = btn.textContent; btn.textContent = "下载中…"; btn.disabled = true;
        fetchVideoBuffer(task.videoUrl).then(function (buf) {
          saveBufferToDisk(buf);
          btn.textContent = origText; btn.disabled = false;
        }).catch(function () {
          openInBrowser(task.videoUrl);
          btn.textContent = origText; btn.disabled = false;
        });
      }
    }
    else if (action === "import") { if (task.videoUrl) openInBrowser(task.videoUrl); }
    else if (action === "import-edit") {
      if (task._groupIdx == null) { showToast("当前任务没有关联分镜，无法导入", "warn"); return; }
      if (!task.videoUrl) { showToast("视频尚未就绪", "warn"); return; }
      var alreadyImported = false;
      try { alreadyImported = isGroupImported(task._groupIdx); } catch (_e) {}
      if (alreadyImported) {
        try { removeGroupFromTimeline(task._groupIdx); } catch (_e) {}
        showToast("已从剪辑工作台移出", "info");
      } else {
        var didImport = false;
        try { didImport = importGroupToTimeline(task._groupIdx); } catch (_e) {}
        if (didImport) {
          showToast("已导入剪辑工作台", "ok");
        } else {
          showToast("导入失败，视频可能还在加载中，请稍后再试", "warn");
        }
      }
      updateTaskCard(task);
    }
    else if (action === "browser") { if (task.videoUrl) openInBrowser(task.videoUrl); }
    else if (action === "copy") {
      if (task.videoUrl) copyText(task.videoUrl).then(function () { btn.textContent = "已复制"; setTimeout(function () { btn.textContent = "复制链接"; }, 1500); }, function () { showToast("复制失败", "error"); });
    }
  }

  async function retryFailedTask(oldTask) {
    _syncVideoRefs();
    if (activeTaskCount() >= MAX_CONCURRENT) { showToast("最多同时运行 " + MAX_CONCURRENT + " 个任务", "warn"); return; }

    if (oldTask._groupIdx !== undefined && project && project.storyboards && project.storyboards[oldTask._groupIdx]) {
      try {
        if (project.storyboards[oldTask._groupIdx].videoUrl) {
          delete project.storyboards[oldTask._groupIdx].videoUrl;
        }
        await createWorkflowVideoTask(oldTask._groupIdx, _getDefaultBatchOpts());
        renderBatchClipList();
      } catch (e) {
        showToast("片段 " + (oldTask._groupIdx + 1) + " 重新生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      }
      return;
    }

    showToast("无法重新生成：缺少分镜索引", "warn");
  }

  async function importTaskVideo(task) {
    if (!task.videoUrl) { showToast("无视频链接", "warn"); return; }
    try {
      var buf = await fetchVideoBuffer(task.videoUrl);
      var blob = new Blob([buf], { type: "video/mp4" });
      _downloadBlob(blob, "qd_" + (task.serverTaskId || Date.now()) + ".mp4");
    } catch (e) { showToast("下载失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error"); }
  }

  /* Clipboard / browser */
  function copyText(text) {
    if (!text) return Promise.reject(new Error("empty"));
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return navigator.clipboard.writeText(text).catch(function () { return execCopy(text); });
    return Promise.resolve(execCopy(text));
  }
  function execCopy(text) {
    var el = document.createElement("textarea"); el.value = text; el.setAttribute("readonly", ""); el.style.position = "fixed"; el.style.left = "-32000px";
    document.body.appendChild(el); el.focus(); el.select(); try { document.execCommand("copy"); } catch (e) {} try { document.body.removeChild(el); } catch (e) {}
  }
  function openInBrowser(url) {
    if (!url) return;
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch (e) {}
  }

  /* History — backend authoritative (Phase 2.7) */
  // 历史现在由后端按 user 跨项目聚合：GET /api/video/history?scope=user
  // 完成事件触发刷新，前端只缓存最近一次响应供 UI 展示。
  var _userVideoHistory = [];

  function appendOutputHistory(url, taskId) {
    // 兼容旧调用：完成时只触发后端拉取，不再写 localStorage
    if (!url || url === "#") return;
    refreshUserVideoHistory();
  }

  async function refreshUserVideoHistory() {
    try {
      var res = await apiGet("/api/video/history?scope=user&limit=50");
      _userVideoHistory = Array.isArray(res && res.tasks) ? res.tasks : [];
    } catch (e) {
      console.warn("[history] fetch failed:", e);
      _userVideoHistory = [];
    }
    renderUserVideoHistory();
  }

  function renderUserVideoHistory() {
    var card = $("outputHistoryCard"), sel = $("outputHistorySelect"); if (!sel) return;
    sel.innerHTML = "";
    _userVideoHistory.forEach(function (item, i) {
      var url = item.resultUrl || item.url || "";
      if (!url) return;
      var opt = document.createElement("option"); opt.value = url;
      var ts = item.updatedAt || item.completedAt || item.createdAt || "";
      var t = String(ts).slice(0, 19).replace("T", " ");
      opt.textContent = (i + 1) + ". " + t + " — " + (url.length > 50 ? url.slice(0, 50) + "…" : url);
      sel.appendChild(opt);
    });
    if (card) card.hidden = _userVideoHistory.length === 0;
  }

  function refreshHistoryUI() { renderUserVideoHistory(); }

  /* Close dropdowns on outside click */
  document.addEventListener("click", function () {
    [["panelRatio", "btnRatio"], ["panelDur", "btnDur"]].forEach(function (pair) {
      var p = $(pair[0]), b = $(pair[1]);
      if (p && !p.hidden) { p.hidden = true; if (b) b.classList.remove("is-open"); }
    });
  });


export {
  _restoreVideoTasks,
  refreshBatchPage,
  startBatchGeneration,
  _initBatchPlayerEvents,
  handleVideoTaskAction,
  syncTaskListVisibility,
  updateBadge,
  toggleGlobalTaskPanel,
  createWorkflowVideoTask,
  activeTaskCount,
  refreshHistoryUI,
  refreshUserVideoHistory,
};
