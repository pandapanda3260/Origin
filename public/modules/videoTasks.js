/**
 * Video task lifecycle and segment generation page.
 *
 * Extracted from main.js as one complete runtime module. main.js remains the
 * composition root and injects project/settings/videoState plus cross-domain
 * callbacks through initVideoTasks(ctx).
 */
import { $, escapeHtml, showToast, showConfirm, apiPost, apiGet, formatTime, ApiError, getAuthHeaders, hydrateProtectedImageElements, showConsistencyAggregateWarning, getActiveBatchesShared } from '/modules/utils.js';
import { subscribeTask, subscribeBatch } from '/modules/backend_stream.js';
import { showBillingPaywall } from '/modules/billing.js';
import { describeVideoModelStatusFailure } from '/modules/video_model_status.js';
import { firstFrameImageUrl } from '/modules/frameRecommendations.js';
import { assertModuleSingleton } from '/modules/module_singleton_guard.js';

assertModuleSingleton("videoTasks", import.meta.url);

let _ctx = {};

// 与 storyboard.js / videoPrompts.js / shots.js 一致的本地桥接：
// _ctx.safeWriteBack 由 main.js 在 init 时注入；模块内统一通过这个 _safeWriteBack
// 调用，避免散落的 `_ctx.safeWriteBack &&` 判空逻辑。
function _safeWriteBack(id, fn, serverVersion) {
  return _ctx.safeWriteBack ? _ctx.safeWriteBack(id, fn, serverVersion) : false;
}
function importGroupToTimeline(groupIdx) {
  return _ctx.importGroupToTimeline ? _ctx.importGroupToTimeline(groupIdx) : false;
}
function removeGroupFromTimeline(groupIdx) {
  return _ctx.removeGroupFromTimeline ? _ctx.removeGroupFromTimeline(groupIdx) : false;
}
function isGroupImported(groupIdx) {
  return _ctx.isGroupImported ? _ctx.isGroupImported(groupIdx) : false;
}
let project = null;
let settings = null;
let videoState = null;

let MAX_CONCURRENT = 10;
let MAX_TASKS_TOTAL = 20;
let STATUS_COPY = {};
let VIDEO_ADAPTERS = {};
let _projectEpoch = 0;
var _videoInFlightGroups = new Set();
var _batchRenderSeq = 0;
var _videoGenerationEstimate = {
  averageSec: null,
  sampleSize: 0,
  fetchedAt: 0,
  loading: false,
};

function isVideoSegmentBatchType(batchType) {
  return batchType === "video_segments" || batchType === "videos";
}

export function initVideoTasks(ctx) {
  _ctx = ctx || {};
  MAX_CONCURRENT = _ctx.MAX_CONCURRENT || MAX_CONCURRENT;
  MAX_TASKS_TOTAL = _ctx.MAX_TASKS_TOTAL || MAX_TASKS_TOTAL;
  STATUS_COPY = _ctx.STATUS_COPY || STATUS_COPY;
  VIDEO_ADAPTERS = _ctx.VIDEO_ADAPTERS || VIDEO_ADAPTERS;
  _syncVideoRefs();
  _ensureBatchTipBound();
}

// 给 [data-tip] 元素绑定一个轻量浮窗（替代原生 title，鼠标移上去即时显示）。
function _ensureBatchTipBound() {
  if (typeof document === "undefined" || document._batchTipBound) return;
  document._batchTipBound = true;
  var tipEl = null;
  function ensureTipEl() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement("div");
    tipEl.className = "app-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function positionTip(target) {
    if (!tipEl) return;
    var rect = target.getBoundingClientRect();
    tipEl.style.visibility = "hidden";
    tipEl.style.display = "block";
    var tipRect = tipEl.getBoundingClientRect();
    var margin = 8;
    var top = rect.top - tipRect.height - margin;
    var placement = "top";
    if (top < margin) {
      top = rect.bottom + margin;
      placement = "bottom";
    }
    var left = rect.left + rect.width / 2 - tipRect.width / 2;
    var vw = window.innerWidth;
    if (left < margin) left = margin;
    if (left + tipRect.width > vw - margin) left = vw - margin - tipRect.width;
    tipEl.style.top = Math.round(top) + "px";
    tipEl.style.left = Math.round(left) + "px";
    tipEl.dataset.placement = placement;
    tipEl.style.visibility = "";
  }
  function showFor(target) {
    var text = target.getAttribute("data-tip");
    if (!text) return;
    ensureTipEl();
    tipEl.textContent = text;
    tipEl.classList.add("is-visible");
    positionTip(target);
  }
  function hide() {
    if (!tipEl) return;
    tipEl.classList.remove("is-visible");
  }
  document.addEventListener("mouseover", function (e) {
    var target = e.target.closest && e.target.closest("[data-tip]");
    if (!target) return;
    showFor(target);
  });
  document.addEventListener("mouseout", function (e) {
    var target = e.target.closest && e.target.closest("[data-tip]");
    if (!target) return;
    var related = e.relatedTarget;
    if (related && target.contains(related)) return;
    hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
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
function _flushServerSave() { return _ctx.flushServerSave ? _ctx.flushServerSave() : saveProject(); }
function _registerServerTask() { if (_ctx.registerServerTask) return _ctx.registerServerTask.apply(null, arguments); }
function _notifyServerTaskDone() { if (_ctx.notifyServerTaskDone) return _ctx.notifyServerTaskDone.apply(null, arguments); }
function _archiveOldImage() { if (_ctx.archiveOldImage) return _ctx.archiveOldImage.apply(null, arguments); }
function updateAssetCardImage() { if (_ctx.updateAssetCardImage) return _ctx.updateAssetCardImage.apply(null, arguments); }
function updateStoryboardCard() { if (_ctx.updateStoryboardCard) return _ctx.updateStoryboardCard.apply(null, arguments); }
function getStoryboardGroups() { return _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : []; }
function _vpFetchAndCache(sb) { return _ctx.vpFetchAndCache ? _ctx.vpFetchAndCache(sb) : Promise.resolve(null); }
function _vpGetCache(sb) { return _ctx.vpGetCache ? _ctx.vpGetCache(sb) : { sensitiveHits: [] }; }
function switchPage(page) { if (_ctx.switchPage) return _ctx.switchPage(page); }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }
function refreshOverview() { if (_ctx.refreshOverview) return _ctx.refreshOverview(); }
function _normalizeBatchStatus(status) {
  return String(status || "").trim().toLowerCase();
}
function isTerminalBatchStatus(status) {
  var normalized = _normalizeBatchStatus(status);
  return normalized === "completed" ||
    normalized === "succeeded" ||
    normalized === "failed" ||
    normalized === "cancelled" ||
    normalized === "partial";
}
function isRunningBatchStatus(status) {
  var normalized = _normalizeBatchStatus(status);
  return normalized === "queued" || normalized === "running";
}
function _setBatchStartDisabled(disabled) {
  ["btnStartBatch", "btnGenerateAllSegments"].forEach(function (id) {
    var btn = $(id);
    if (btn) btn.disabled = !!disabled;
  });
  // 任何把按钮恢复可点的路径，都顺手清掉准备阶段提示，避免文案残留
  if (!disabled) _setBatchGenerateHint("");
}
// 「生成全部片段」点击后到首个可见变化之间有多个串行网络请求（reload/保存/连续性AI检查），
// 这里给英雄区一行阶段提示，让用户知道在等什么。文案为空时隐藏。
function _setBatchGenerateHint(text) {
  var el = $("batchGenerateHint");
  if (!el) return;
  var msg = (text == null ? "" : String(text)).trim();
  el.textContent = msg;
  el.hidden = !msg;
}
async function _reloadProjectFromServerForVideoBatch(hintEl) {
  if (!_ctx.reloadProjectFromServer) return false;
  try {
    if (hintEl) hintEl.textContent = "正在同步最新提示词状态…";
    var ok = await _ctx.reloadProjectFromServer();
    _syncVideoRefs();
    return !!ok;
  } catch (e) {
    console.warn("[VideoBatch] reloadProjectFromServer failed:", e);
    _syncVideoRefs();
    return false;
  } finally {
    if (hintEl) hintEl.textContent = "";
  }
}

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
	      filename: "", displayName: "", downloadFilename: "",
	      autoImport: !!autoImport, createdAt: Date.now(),
      warnings: [],
      cardEl: null, videoEl: null,
      _badge: null, _busyWrap: null, _busyText: null, _videoWrap: null,
      _playOverlay: null, _videoLoading: null, _failedWrap: null, _failedText: null, _warningText: null, _actions: null,
    };
  }

	  function isTerminal(t) { return t.status === "done" || t.status === "failed" || t.status === "timeout"; }
	  function _nameMetaFrom(value) {
	    value = value || {};
	    return {
	      filename: value.filename || value.fileName || value.videoFilename || "",
	      displayName: value.displayName || value.display_name || value.title || value.name || value.videoDisplayName || "",
	      downloadFilename: value.downloadFilename || value.download_filename || value.videoDownloadFilename || "",
	    };
	  }
	  function _applyVideoNameMeta(target, value) {
	    if (!target || !value) return target;
	    var meta = _nameMetaFrom(value);
	    if (meta.filename) target.filename = meta.filename;
	    if (meta.displayName) target.displayName = meta.displayName;
	    if (meta.downloadFilename) target.downloadFilename = meta.downloadFilename;
	    return target;
	  }
	  function _taskDisplayName(task) {
	    var metaName = task && (task.displayName || task.title || task.name);
	    if (metaName) return String(metaName);
	    if (task && task._groupIdx != null && Number.isFinite(Number(task._groupIdx))) {
	      return "片段 " + (Number(task._groupIdx) + 1);
    }
    var raw = (task && task.prompt || "").trim();
    var m = raw.match(/^片段\s*(\d+)/);
    if (m) return "片段 " + m[1];
    return "视频任务";
  }
  function _taskDisplayMeta(task) {
    return (task && task._groupIdx != null) ? "基于片段设置生成" : "自定义视频生成任务";
  }
	  function activeTaskCount() {
	    _syncVideoRefs();
	    if (!videoState || !Array.isArray(videoState.tasks)) return 0;
	    var n = 0;
	    for (var i = 0; i < videoState.tasks.length; i++) { if (!isTerminal(videoState.tasks[i])) n++; }
	    return n;
	  }

	  function _videoPromptReadinessForGroup(gIdx) {
	    var sb = project && project.storyboards && project.storyboards[gIdx];
	    if (!sb || !sb.videoPrompt) return { canStart: false, reason: "missing_video_prompt", status: "missing" };
	    if (!sb.videoPromptStatus) return { canStart: true, reason: "legacy_ready", status: "ready" };
	    if (sb.videoPromptStatus !== "ready") {
	      return {
	        canStart: false,
	        reason: sb.videoPromptStatus === "generating" ? "video_prompt_generating" : "video_prompt_failed",
	        status: sb.videoPromptStatus,
	        lastError: sb.videoPromptLastError || "",
	      };
	    }
	    return { canStart: true, reason: "ready", status: "ready" };
	  }

	  function _videoPromptNotReadyMessage(gIdx, readiness) {
	    var reason = readiness && readiness.reason;
	    var label = "片段 " + (gIdx + 1);
	    if (reason === "video_prompt_generating") {
	      return label + " 的视频提示词还未就绪（状态：生成中）。请等待完成；如果长时间没有变化，请回到「视频提示词」页处理。";
	    }
	    if (reason === "video_prompt_failed") {
	      var err = String((readiness && readiness.lastError) || "").trim();
	      if (/角色一致性|needs_review|species|locked|非人角色/.test(err)) {
	        return label + " 的视频提示词未就绪：角色一致性未通过。请回到「视频提示词」页确认角色后继续生成。";
	      }
	      if (err) return label + " 的视频提示词上轮生成失败：" + err.slice(0, 80) + "。请回到「视频提示词」页重新生成。";
	      return label + " 的视频提示词上轮生成失败，请回到「视频提示词」页重新生成。";
	    }
	    return "片段 " + (gIdx + 1) + " 缺少可用视频提示词，请先去「视频提示词」页生成";
	  }

	  function _getVideoSegmentPreflightPayload(source) {
	    var payload = source && source.payload ? source.payload : source;
	    if (!payload || !payload.preflight) return null;
	    if (payload.code === "video_segment_preflight_failed") return payload;
	    return null;
	  }

	  function _formatVideoSegmentPreflightMessage(payload) {
	    var preflight = (payload && payload.preflight) || {};
	    var blocked = Array.isArray(preflight.blocked) ? preflight.blocked : [];
	    var lines = [];
	    if (blocked.length) {
	      lines.push("以下片段暂不能开始视频生成：");
	      blocked.slice(0, 8).forEach(function (item) {
	        var seg = "片段 " + (Number(item.groupIdx) + 1);
	        var reasons = [];
	        (item.blockers || []).forEach(function (b) {
	          if (b && b.message) reasons.push(b.message);
	          else if (b && b.code) reasons.push(b.code);
	        });
	        if (!reasons.length && item.reason) reasons.push(item.reason);
	        lines.push(seg + "：" + (reasons.join("；") || "生成前检查未通过"));
	      });
	      if (blocked.length > 8) lines.push("还有 " + (blocked.length - 8) + " 个片段需要处理。");
	    }
	    return lines.join("\n") || (payload && (payload.detail || payload.error)) || "视频生成前检查未通过";
	  }

	  function _videoSegmentPreflightActions(payload) {
	    var preflight = (payload && payload.preflight) || {};
	    var actions = [];
	    function add(list) {
	      (list || []).forEach(function (item) {
	        (item.nextActions || []).forEach(function (action) {
	          if (actions.indexOf(action) < 0) actions.push(action);
	        });
	      });
	    }
	    add(preflight.blocked);
	    add(preflight.warnings);
	    return actions;
	  }

	  function _targetPageForVideoSegmentPreflight(payload) {
	    var actions = _videoSegmentPreflightActions(payload);
	    if (actions.indexOf("regenerate_video_prompt") >= 0 || actions.indexOf("wait_video_prompt") >= 0) return "prompts";
	    if (
	      actions.indexOf("confirm_character_lock") >= 0 ||
	      actions.indexOf("fill_species") >= 0 ||
	      actions.indexOf("regenerate_prop_reference") >= 0 ||
	      actions.indexOf("regenerate_character_reference") >= 0 ||
	      actions.indexOf("regenerate_scene_reference") >= 0
	    ) return "assets";
	    if (
	      actions.indexOf("regenerate_first_frame") >= 0 ||
	      actions.indexOf("regenerate_tail_frame") >= 0 ||
	      actions.indexOf("wait_tail_frame") >= 0 ||
	      actions.indexOf("switch_to_strict_first_frame") >= 0
	    ) return "images";
	    if (actions.indexOf("switch_video_model") >= 0) return "settings";
	    return "batch";
	  }

	  async function _postVideoBatchStartWithPreflightHandling(requestBody) {
	    var body = JSON.parse(JSON.stringify(requestBody || {}));
	    try {
	      return { resp: await apiPost("/api/batch/start", body) };
	    } catch (e) {
	      var payload = _getVideoSegmentPreflightPayload(e);
	      if (!payload) throw e;
	      var msg = _formatVideoSegmentPreflightMessage(payload);
	      var go = await showConfirm(
	        "视频生成前检查未通过",
	        msg,
	        "去处理",
	        "稍后处理",
	      );
	      if (go) switchPage(_targetPageForVideoSegmentPreflight(payload));
	      return { aborted: true, payload: payload };
	    }
	  }

	  function _hasCurrentVideoForGroup(gIdx) {
	    var sb = project && project.storyboards && project.storyboards[gIdx];
	    if (!sb || !sb.videoUrl) return false;
	    var vt = Array.isArray(project.videoTasks) ? project.videoTasks[gIdx] : null;
	    if (sb.videoIsCurrent === false) return false;
	    if (vt && vt.isCurrent === false) return false;
	    return true;
	  }

  function _markGroupVideoCurrent(gIdx, url, opts) {
    opts = opts || {};
    if (!project || gIdx == null || !Array.isArray(project.storyboards)) return;
    if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
    var sb = project.storyboards[gIdx];
    var protectedUrl = opts.protectedUrl || _protectedVideoUrlFrom(url);
    var taskId = opts.taskId || opts.serverTaskId || "";
    var durationSec = Number(opts.durationSec || 0);
	    var plannedDurationSec = Number(opts.plannedDurationSec || 0);
	    var nameMeta = _nameMetaFrom(opts);

	    if (url) sb.videoUrl = url;
	    if (protectedUrl) sb._originVideoUrl = protectedUrl;
	    if (taskId) sb.videoTaskId = taskId;
	    if (nameMeta.filename) sb.videoFilename = nameMeta.filename;
	    if (nameMeta.displayName) sb.videoDisplayName = nameMeta.displayName;
	    if (nameMeta.downloadFilename) sb.videoDownloadFilename = nameMeta.downloadFilename;
    if (durationSec > 0) sb.videoDurationSec = durationSec;
    if (plannedDurationSec > 0) sb.plannedDurationSec = plannedDurationSec;
    if (Array.isArray(opts.videoWarnings)) sb.videoWarnings = opts.videoWarnings;
    if (typeof opts.readyForEdit === "boolean") sb.readyForEdit = opts.readyForEdit;
    else delete sb.readyForEdit;
    sb.videoIsCurrent = true;
    delete sb.videoInvalidatedAt;
    delete sb.videoInvalidatedReason;

    if (!Array.isArray(project.videoTasks)) project.videoTasks = [];
    var vt = project.videoTasks[gIdx];
    if (!vt || typeof vt !== "object") vt = {};
    vt.groupIdx = gIdx;
    if (taskId) vt.taskId = taskId;
	    if (url) vt.url = protectedUrl || url;
	    if (protectedUrl) vt.protectedUrl = protectedUrl;
	    if (nameMeta.filename) vt.filename = nameMeta.filename;
	    if (nameMeta.displayName) vt.displayName = nameMeta.displayName;
	    if (nameMeta.downloadFilename) vt.downloadFilename = nameMeta.downloadFilename;
    if (durationSec > 0) vt.durationSec = durationSec;
    if (plannedDurationSec > 0) vt.plannedDurationSec = plannedDurationSec;
    if (Array.isArray(opts.videoWarnings)) vt.warnings = opts.videoWarnings;
    vt.status = "completed";
    vt.isCurrent = true;
    delete vt.outdated;
    delete vt.invalidatedAt;
    delete vt.invalidatedReason;
    project.videoTasks[gIdx] = vt;
  }

  function _canBulkImportGroup(gIdx) {
    if (!_hasCurrentVideoForGroup(gIdx)) return false;
    var sb = project && project.storyboards && project.storyboards[gIdx];
    if (sb && typeof sb.readyForEdit === "boolean") return sb.readyForEdit === true;
    return true;
  }

  async function importAllGeneratedSegments(options) {
    options = options || {};
    _syncVideoRefs();
    if (!project || !Array.isArray(project.storyboards)) {
      if (!options.silent) showToast("请先打开项目", "warn");
      return { imported: 0, already: 0, skipped: 0, failed: 0, total: 0 };
    }
    if (_ctx.reloadProjectFromServer) {
      try {
        await _ctx.reloadProjectFromServer();
        _syncVideoRefs();
      } catch (e) {
        console.warn("[BatchImport] reload project before import failed:", e);
        _syncVideoRefs();
      }
    }
    var groups = getStoryboardGroups();
    var imported = 0;
    var already = 0;
    var skipped = 0;
    var failed = 0;
    for (var i = 0; i < groups.length; i++) {
      if (!project.storyboards[i] || !project.storyboards[i].videoPrompt) continue;
      if (!_canBulkImportGroup(i)) { skipped++; continue; }
      var isImported = false;
      try { isImported = isGroupImported(i); } catch (_e) { isImported = false; }
      if (isImported) { already++; continue; }
      try {
        if (importGroupToTimeline(i)) imported++;
        else failed++;
      } catch (_err) {
        failed++;
      }
    }
    renderBatchClipList();
    updateBadge();
    var summary = { imported: imported, already: already, skipped: skipped, failed: failed, total: imported + already + skipped + failed };
    if (options.silent) return summary;
    if (imported > 0) {
      showToast("已导入 " + imported + " 个片段" + (already ? "，跳过已导入 " + already + " 个" : ""), "ok");
    } else if (already > 0 && skipped === 0 && failed === 0) {
      showToast("所有已生成片段都已导入剪辑工作台", "info");
    } else if (failed > 0) {
      showToast("导入失败，请重试或刷新", "warn");
    } else if (skipped > 0) {
      showToast("暂无新的可导入片段，未生成或未就绪的片段已跳过", "warn");
    } else {
      showToast("暂无可导入片段，请先生成片段视频", "warn");
    }
    return summary;
  }

  async function confirmSegmentsAndEnterEdit() {
    var result = await importAllGeneratedSegments({ silent: true });
    _syncVideoRefs();
    var importedCount = 0;
    if (project && Array.isArray(project.storyboards)) {
      importedCount = project.storyboards.filter(function (sb) { return sb && sb.importedToEdit === true; }).length;
    }
    var timeline = project && project.editData && project.editData.edl && Array.isArray(project.editData.edl.timeline)
      ? project.editData.edl.timeline
      : [];
    if (timeline.length > 0 || importedCount > 0 || (result && (result.imported > 0 || result.already > 0))) {
      showToast(result && result.imported > 0 ? ("已补导入 " + result.imported + " 个片段，进入剪辑") : "片段视频已确认，进入剪辑", "ok");
      switchPage("edit");
      return result;
    }
    if (result && result.failed > 0) {
      showToast("片段导入失败，请刷新后重试", "warn");
    } else if (result && result.skipped > 0) {
      showToast("还有片段未生成或未就绪，暂不能进入剪辑", "warn");
    } else {
      showToast("暂无可进入剪辑的片段，请先生成片段视频", "warn");
    }
    return result;
  }

	  function _videoWarningKey(w) {
	    return (w && (w.key || w.message)) ? String(w.key || w.message) : '';
	  }
	  function _isObsoleteVideoWarning(w) {
	    var key = _videoWarningKey(w);
	    var msg = String((w && w.message) || w || '');
	    return key === 'duration_over_budget' || /视频档位|压缩动作\/台词/.test(msg);
	  }
	  function _normalizeVideoWarnings(data) {
	    if (!data) return [];
	    if (Array.isArray(data.videoWarnings)) return data.videoWarnings.filter(function (w) { return w && !_isObsoleteVideoWarning(w); });
	    if (Array.isArray(data.warnings)) return data.warnings.filter(function (w) { return w && !_isObsoleteVideoWarning(w); });
	    if (data.warning) return _isObsoleteVideoWarning(data.warning) ? [] : [data.warning];
	    if (data.stage === 'duration_warning' && (data.hint || data.message)) {
	      return [];
	    }
    return [];
  }
  function _mergeVideoWarnings(task, data, notify) {
    if (!task) return;
    var warnings = Array.isArray(data) ? data : _normalizeVideoWarnings(data);
    if (!warnings.length) return;
    task.warnings = Array.isArray(task.warnings) ? task.warnings : [];
    task._shownWarnings = task._shownWarnings || Object.create(null);
	    warnings.forEach(function (w) {
	      if (!w) return;
	      var normalized = (typeof w === 'string') ? { key: w, level: 'warn', message: w } : w;
	      if (_isObsoleteVideoWarning(normalized)) return;
	      var key = _videoWarningKey(normalized);
	      if (!key) return;
      var exists = task.warnings.some(function (old) { return _videoWarningKey(old) === key; });
      if (!exists) task.warnings.push(normalized);
      if (notify && !task._shownWarnings[key]) {
        task._shownWarnings[key] = true;
        showToast(normalized.message || key, 'warn');
      }
    });
  }
  function _projectVideoWarnings(gIdx) {
	    if (!project || gIdx == null) return [];
	    var vt = Array.isArray(project.videoTasks) ? project.videoTasks[gIdx] : null;
	    if (vt && Array.isArray(vt.warnings)) return vt.warnings.filter(function (w) { return !_isObsoleteVideoWarning(w); });
	    var sb = Array.isArray(project.storyboards) ? project.storyboards[gIdx] : null;
	    if (sb && Array.isArray(sb.videoWarnings)) return sb.videoWarnings.filter(function (w) { return !_isObsoleteVideoWarning(w); });
	    return [];
	  }
  function _applyVideoTaskProgress(task, data) {
    if (!task) return;
    if (task.status !== "polling") {
      task.status = "polling";
      task.statusCn = "生成中";
    }
    _mergeVideoWarnings(task, data, true);
    updateTaskCard(task);
  }

	  function _normalizeGroupIdx(gIdx) {
	    var n = Number(gIdx);
	    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
	  }
	  function _tailRushedMessageFrom(data) {
	    var extra = data && data.extra ? data.extra : data;
	    if (extra && extra.errorCode === "video_duration_budget_blocked") {
	      return "片段结尾仓促，请在镜头页增加对应片段的视频时长";
	    }
	    var warnings = _normalizeVideoWarnings(extra);
	    for (var i = 0; i < warnings.length; i++) {
	      var w = warnings[i] || {};
	      if (String(w.key || "") === "tail_rushed") {
	        return w.message || "片段结尾仓促，请在镜头页增加对应片段的视频时长";
	      }
	    }
	    var raw = String((data && (data.reason || data.errorMsg || data.detail)) || data || "");
	    if (raw.indexOf("片段结尾仓促") >= 0) {
	      return "片段结尾仓促，请在镜头页增加对应片段的视频时长";
	    }
	    return "";
	  }
	  function _videoFailureStatusText(data, fallback) {
	    return _tailRushedMessageFrom(data) || _friendlyVideoError(fallback || (data && (data.reason || data.errorMsg)) || "failed");
	  }

  function _isVideoGroupInFlight(gIdx) {
    var n = _normalizeGroupIdx(gIdx);
    return n != null && _videoInFlightGroups.has(n);
  }

  function _lockVideoGroup(gIdx) {
    var n = _normalizeGroupIdx(gIdx);
    if (n == null) return false;
    if (_videoInFlightGroups.has(n)) return false;
    _videoInFlightGroups.add(n);
    return true;
  }

  function _unlockVideoGroup(gIdx) {
    var n = _normalizeGroupIdx(gIdx);
    if (n != null) _videoInFlightGroups.delete(n);
  }

  function _lockVideoGroups(indices) {
    var locked = [];
    var skipped = [];
    var seen = Object.create(null);
    (indices || []).forEach(function (gIdx) {
      var n = _normalizeGroupIdx(gIdx);
      if (n == null || seen[n]) return;
      seen[n] = true;
      if (_videoInFlightGroups.has(n)) skipped.push(n);
      else { _videoInFlightGroups.add(n); locked.push(n); }
    });
    return { locked: locked, skipped: skipped };
  }

  function _unlockVideoGroups(indices) {
    (indices || []).forEach(function (gIdx) { _unlockVideoGroup(gIdx); });
  }

  function _inFlightMessage(indices) {
    var arr = (indices || []).map(function (n) { return Number(n) + 1; }).filter(function (n) { return Number.isFinite(n); });
    if (!arr.length) return "已有视频任务正在生成";
    return arr.length === 1
      ? "片段 " + arr[0] + " 正在生成中，请等待完成"
      : "片段 " + arr.join("、") + " 正在生成中，已跳过重复提交";
  }


  /* ---- 视频任务恢复（单一路径，后端权威） ----
   * Phase 4 重构：合并原 _recoverAllVideoTasks + _reattachVideoBatches 为
   * 单一恢复函数，消除双路径叠加导致的重复卡片。
   *
   * 恢复策略：
   *   1. /api/batch/active → 活跃批次（进行中），按 target_idx 去重建卡 + 挂 SSE
   *   2. /api/tasks/video-by-project → 已完成历史（去重），补充 batch 没覆盖的分镜
   *   两步之间按 groupIdx 互斥：步骤 1 已有的分镜，步骤 2 不再建卡 */
  function _videoRestoreGuard(options) {
    options = options || {};
    var expectedProjectId = options.projectId || (project && project.id) || "";
    var isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : null;
    return function () {
      _syncVideoRefs();
      if (isCurrent && !isCurrent()) return false;
      if (expectedProjectId && (!project || project.id !== expectedProjectId)) return false;
      return true;
    };
  }

  function _restoreVideoTasks(options) {
    var guard = _videoRestoreGuard(options);
    _syncVideoRefs();
    if (!guard()) return Promise.resolve(false);
    if (!videoState || !Array.isArray(videoState.tasks)) return Promise.resolve(false);
    if (_batchHandle) { try { _batchHandle.close(); } catch (_e) {} _batchHandle = null; }
    videoState.tasks.forEach(function (t) {
      if (t && t._sseHandle) { try { t._sseHandle.close(); } catch (_e) {} t._sseHandle = null; }
    });
    videoState.tasks = [];
    var tw = $("taskListWrap"); if (tw) tw.innerHTML = "";
    var bw = $("batchTaskListWrap"); if (bw) bw.innerHTML = "";
    syncTaskListVisibility(); updateBadge();
    return _reattachVideoTasks(options);
  }

  function _dropSupersededGroupTasks(gIdx) {
    if (!videoState || !Array.isArray(videoState.tasks)) return;
    var n = Number(gIdx);
    if (!Number.isFinite(n)) return;
    var bWrap = $("batchTaskListWrap");
    for (var i = videoState.tasks.length - 1; i >= 0; i--) {
      var t = videoState.tasks[i];
      if (!t || Number(t._groupIdx) !== n) continue;
      t._killed = true;
      cleanupTask(t);
      videoState.tasks.splice(i, 1);
    }
    // Mirror rows are keyed by localId, but stale duplicates from older renders may
    // only have the group key. Clear that too before rebuilding from server history.
    try {
      var mirror = bWrap && bWrap.querySelector('[data-group-idx="' + n + '"]');
      if (mirror && mirror.parentNode) mirror.parentNode.removeChild(mirror);
    } catch (_e) {}
  }

  /* 2026-06 · 全局唤醒对账（main.js focus/visibilitychange/online 分发）。
   * 只在"本地没有任何闭包在跟踪任务"时才考虑重建：activeTaskCount()>0 说明
   * 进行中的任务有自己的 SSE+降级轮询（backend_stream.js）盯着，不打断；
   * =0 时先查 /api/batch/active（共享缓存），有视频批次（活跃或 30 分钟内
   * 终态）才走 _restoreVideoTasks 全量重建——把切走期间完成的片段补进 UI。
   * 完全没相关批次时零 DOM 操作，避免每次 focus 都闪列表。 */
  var _videoWakeReconcileInFlight = false;
  function reconcileVideoTasksOnWake(reason) {
    _syncVideoRefs();
    if (!project || !project.id) return;
    if (activeTaskCount() > 0) return;
    if (_videoWakeReconcileInFlight) return;
    _videoWakeReconcileInFlight = true;
    var pid = project.id;
    getActiveBatchesShared(pid).then(function (resp) {
      if (!project || project.id !== pid) return false;
      var batches = (resp && resp.batches) || [];
      var hasVideo = batches.some(function (b) { return b && isVideoSegmentBatchType(b.batchType || ""); });
      if (!hasVideo) return false;
      return _restoreVideoTasks({ projectId: pid });
    }).catch(function (e) {
      console.warn("[VideoWakeReconcile] failed:", (e && e.message) || e, reason || "");
    }).finally(function () {
      _videoWakeReconcileInFlight = false;
    });
  }

  async function _reattachVideoTasks(options) {
    var guard = _videoRestoreGuard(options);
    _syncVideoRefs();
    if (!guard() || !project || !project.id) return false;
    var restoreProjectId = project.id;

    var coveredGroups = {};

    // Step 1: active batches — 进行中的批次优先
    try {
      var batchResp = await getActiveBatchesShared(restoreProjectId);
      if (!guard()) return false;
      var batches = (batchResp && batchResp.batches) || [];
      batches.forEach(function (b) {
        if (!guard()) return;
        if (!isVideoSegmentBatchType(b.batchType || "")) return;
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

          var task = createVideoTaskObj("片段 " + (gIdx + 1), false);
          task._groupIdx = gIdx;
          task._projectId = restoreProjectId;
          task.serverTaskId = st.taskId || st.task_id || "";

	          var result = st.result || {};
	          var resultNameMeta = Object.assign({}, result.patch || {}, result.extra || {}, result);
	          _applyVideoNameMeta(task, resultNameMeta);
	          _mergeVideoWarnings(task, (result.extra && result.extra.videoWarnings) || _projectVideoWarnings(gIdx), false);
          var resultUrl = result.resultUrl || result.url || (result.patch && result.patch.url) || "";
          var protectedUrl = result.protectedUrl || result.protected_url || (result.extra && result.extra.protectedUrl) || _protectedVideoUrlFrom(resultUrl);

          if (st.status === "done" || st.status === "completed" || st.status === "succeeded") {
            task.status = "done"; task.statusCn = "完成";
            task.videoUrl = resultUrl;
            task.protectedUrl = protectedUrl;
            if (task.videoUrl && project && Array.isArray(project.storyboards)) {
              var dSec = (result.patch && result.patch.durationSec) || (result.extra && result.extra.durationSec);
	              _markGroupVideoCurrent(gIdx, task.videoUrl, {
	                protectedUrl: protectedUrl,
	                taskId: task.serverTaskId,
	                filename: resultNameMeta.filename,
	                displayName: resultNameMeta.displayName,
	                downloadFilename: resultNameMeta.downloadFilename,
	                durationSec: dSec,
                plannedDurationSec: result.patch && result.patch.plannedDurationSec,
                readyForEdit: result.extra && result.extra.readyForEdit,
                videoWarnings: result.extra && result.extra.videoWarnings,
              });
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

        var batchStatus = b.status || snap.status || "";
        if (isTerminalBatchStatus(batchStatus)) return;
        if (!isRunningBatchStatus(batchStatus)) return;

        _setBatchStartDisabled(true);

        if (_batchHandle) { try { _batchHandle.close(); } catch (_e) {} _batchHandle = null; }

        function findTaskByServerId(taskId) {
          if (!guard()) return null;
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
          if (!guard()) return null;
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
          if (!guard()) return;
          if (_seenDone[taskId] || _seenFailed[taskId]) return;
          _seenDone[taskId] = true;
          totalDone++;
	          var gi = (extra && typeof extra.groupIdx === "number") ? extra.groupIdx : null;
	          var t = ensureTaskBound(taskId, gi);
	          if (!t) return;
	          _applyVideoNameMeta(t, extra);
          var eIdx = gi != null ? gi : t._groupIdx;
          if (project && eIdx != null && Array.isArray(project.storyboards)) {
            if (!project.storyboards[eIdx]) project.storyboards[eIdx] = {};
            if (extra && typeof extra.readyForEdit === "boolean") {
              project.storyboards[eIdx].readyForEdit = extra.readyForEdit;
            }
            if (extra && Array.isArray(extra.videoWarnings)) {
              project.storyboards[eIdx].videoWarnings = extra.videoWarnings;
            }
          }
          if (project && extra && extra.editReadiness && typeof extra.editReadiness === "object") {
            if (!project.editData) project.editData = {};
            project.editData.readiness = extra.editReadiness;
          }
          if (url) {
            _mergeVideoWarnings(t, extra, false);
            var protectedUrl = (extra && extra.protectedUrl) || _protectedVideoUrlFrom(url);
            t.videoUrl = url;
            t.protectedUrl = protectedUrl;
            if (project && t._groupIdx != null && Array.isArray(project.storyboards)) {
              // 把后端真实生成文件时长写到 storyboard，剪辑工作台 timeline
              // 段长就能用真实视频长度，避免计划时长和文件时长错位。
              var realDur = (extra && extra.durationSec) || 0;
              if (!realDur && extra && extra.patch && extra.patch.durationSec) realDur = extra.patch.durationSec;
	              _markGroupVideoCurrent(t._groupIdx, url, {
	                protectedUrl: protectedUrl,
	                taskId: taskId || t.serverTaskId,
	                filename: extra && extra.filename,
	                displayName: extra && extra.displayName,
	                downloadFilename: extra && extra.downloadFilename,
	                durationSec: realDur,
                plannedDurationSec: (extra && extra.plannedDurationSec) || (extra && extra.patch && extra.patch.plannedDurationSec),
                readyForEdit: extra && extra.readyForEdit,
                videoWarnings: extra && extra.videoWarnings,
              });
            }
            videoPipeline(t).then(function () { updateBadge(); renderBatchClipList(); });
          } else {
            t.status = "failed"; t.statusCn = "生成完成但无视频地址";
            updateTaskCard(t); updateBadge();
          }
        }

	        function applyFailed(taskId, reason, payload) {
	          if (!guard()) return;
	          if (_seenFailed[taskId] || _seenDone[taskId]) return;
	          _seenFailed[taskId] = true;
          totalFail++;
	          var t = findTaskByServerId(taskId);
	          if (!t) return;
	          var failPayload = payload || { reason: reason };
	          _mergeVideoWarnings(t, (failPayload && failPayload.extra) || failPayload, false);
	          t.status = "failed";
	          t.statusCn = _videoFailureStatusText(failPayload, reason || "failed");
	          updateTaskCard(t); updateBadge();
	          renderBatchClipList();
	        }

        // ===== Polling fallback：5 秒兜底拉 batch snapshot =====
        var _reatPoll = null;
        function _stopReatPoll() { if (_reatPoll) { clearInterval(_reatPoll); _reatPoll = null; } }
        async function _reatPollOnce() {
          try {
            var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
            if (!guard()) { _stopReatPoll(); return; }
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
	                  applyFailed(tid, st2.errorMsg || st2.error_msg, {
	                    reason: st2.errorMsg || st2.error_msg,
	                    extra: st2.result && st2.result.extra,
	                  });
                }
              });
            }
            if (isTerminalBatchStatus(snap.status)) {
              _stopReatPoll();
              _setBatchStartDisabled(false);
            }
          } catch (e) {
            console.warn("[VideoReattach] poll failed:", e && e.message);
          }
        }
        _reatPoll = setInterval(_reatPollOnce, 5000);
        setTimeout(_reatPollOnce, 1500);

        var batchHandle = subscribeBatch(batchId, {
          onSnapshot: function (data) {
            if (!guard()) return;
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
	                  applyFailed(tid, st2.errorMsg || st2.error_msg, {
	                    reason: st2.errorMsg || st2.error_msg,
	                    extra: st2.result && st2.result.extra,
	                  });
                }
              });
              _updateBatchTotalProgress();
            }
          },
          onTaskStarted: function (data) {
            if (!guard()) return;
            var taskId = data.taskId; if (!taskId) return;
            var tgt = data.target || {};
            var gi = tgt.storyboardIdx != null ? tgt.storyboardIdx
                   : tgt.groupIdx != null ? tgt.groupIdx
                   : tgt.idx != null ? tgt.idx
                   : data.targetIdx;
            ensureTaskBound(taskId, gi);
          },
          onTaskProgress: function (data) {
            if (!guard()) return;
            var t = findTaskByServerId(data.taskId);
            if (!t) return;
            _applyVideoTaskProgress(t, data);
          },
	          onTaskCompleted: function (data) {
	            if (!guard()) return;
	            applyCompleted(data.taskId, data.resultUrl || data.videoUrl || "", Object.assign({}, data, data.extra || {}));
	          },
          onTaskFailed: function (data) {
            if (!guard()) return;
	            applyFailed(data.taskId, data.reason || data.errorMsg, data);
          },
          onBatchCompleted: function () {
            if (!guard()) return;
            _stopReatPoll();
            _setBatchStartDisabled(false);
          },
          onClose: function () {
            if (!guard()) return;
            if (_batchHandle === batchHandle) _batchHandle = null;
          },
        });
        _batchHandle = batchHandle;
      });
    } catch (e) {
      console.warn("[VideoReattach] batch/active failed:", e);
    }

    // Step 2: completed history — 补充已完成但不在活跃 batch 中的历史任务
    try {
      var histResp = await apiGet("/api/tasks/video-by-project?projectId=" + encodeURIComponent(restoreProjectId));
      if (!guard()) return false;
      var histTasks = (histResp && histResp.tasks) || [];
      if (histTasks.length) {
        console.log("[VideoReattach] Found " + histTasks.length + " history tasks");
        histTasks.forEach(function (t) {
          if (!guard()) return;
          var gIdx = t.target_idx != null ? t.target_idx : 0;
          if (coveredGroups[gIdx]) return;
          coveredGroups[gIdx] = true;

          var isSucceeded = t.status === "succeeded" || t.status === "done" || t.status === "completed";
          var isFailed = t.status === "failed" || t.status === "timeout";
          var url = t.result_url || "";
          var protectedUrl = t.protected_url || _protectedVideoUrlFrom(url);

	          if (isSucceeded && url && project && Array.isArray(project.storyboards)) {
	            _markGroupVideoCurrent(gIdx, url, {
	              protectedUrl: protectedUrl,
	              taskId: t.task_id,
	              filename: t.filename,
	              displayName: t.displayName || t.display_name || t.title || t.name,
	              downloadFilename: t.downloadFilename || t.download_filename,
	              durationSec: t.duration_sec,
	            });
	          }

          if (isSucceeded || isFailed) {
            _dropSupersededGroupTasks(gIdx);
          }

	          var task = createVideoTaskObj("片段 " + (gIdx + 1), false);
	          _applyVideoNameMeta(task, t);
	          task.serverTaskId = t.task_id || "";
          task._groupIdx = gIdx;
          task._projectId = restoreProjectId;
          _mergeVideoWarnings(task, _projectVideoWarnings(gIdx), false);

          if (isSucceeded) {
            task.status = "done"; task.statusCn = "已完成";
            task.videoUrl = url;
            task.protectedUrl = protectedUrl;
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
          // —— silent:true：用户感知里 task 始终保持「已完成」，不会被切到
          // 「下载中」再切回来；预热完全在后台做。
          if (isSucceeded && task.videoUrl) {
            try { videoPipeline(task, { silent: true }).then(function () { updateBadge(); renderBatchClipList(); }); }
            catch (_pe) {}
          }

          // 关键修复：对仍在 running 的视频任务挂 SSE 流，否则刷新后卡片
          // 永远卡在"生成中"——后端继续跑、最终也写完 video_tasks，但前端不知道，
          // 用户感觉"刷新后正在生成的视频丢了"。
          if (!isSucceeded && !isFailed && task.serverTaskId) {
            try { _attachTaskStream(task, task.serverTaskId); }
            catch (_se) { console.warn('[VideoReattach] attach stream failed:', _se); }
          }
        });
      }
    } catch (e) {
      console.warn("[VideoReattach] video-by-project failed:", e);
    }

    syncTaskListVisibility(); updateBadge(); _updateBatchTotalProgress();
    renderBatchClipList();
    return true;
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
    var protectedUrl = t.protected_url || _protectedVideoUrlFrom(url);
    if (t.task_type === "video") {
      if (!project.storyboards) project.storyboards = [];
      if (!project.storyboards[tIdx]) project.storyboards[tIdx] = {};
	      _markGroupVideoCurrent(tIdx, url, {
	        protectedUrl: protectedUrl,
	        taskId: t.task_id,
	        filename: t.filename,
	        displayName: t.displayName || t.display_name || t.title || t.name,
	        downloadFilename: t.downloadFilename || t.download_filename,
	        durationSec: t.duration_sec,
	      });
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
      if (url) showToast("首帧图 #" + (tIdx + 1) + " 已在后台生成完成", "ok");
    } else if (tType === "char") {
      var charItem = project.assets && project.assets.characters && project.assets.characters[tIdx];
      if (charItem) {
        if (url && !charItem.realPhotoUrl) { _archiveOldImage(charItem, "character"); charItem.realPhotoUrl = url; charItem.imageUrl = url; charItem.rawUrl = url; }
        if (t.asset_id) charItem.assetId = t.asset_id;
        if (t.fetch_status) charItem.fetchStatus = t.fetch_status;
        saveProject(); if (url) updateAssetCardImage("char", tIdx, "done", url);
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

	  function _plannedDurForBatchGroup(grp) {
	    var total = 0;
	    ((grp && grp.shots) || []).forEach(function (sh) {
	      total += Number((sh && (sh.duration || sh.durationSec)) || 4) || 4;
	    });
	    return Math.max(1, Math.round(total * 10) / 10);
	  }

	  function _formatBatchDuration(sec) {
	    var n = Number(sec) || 0;
	    if (!n || n < 0) return "--:--";
	    var m = Math.floor(n / 60);
	    var s = Math.round(n % 60);
	    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
	  }

	  // 进度提示统一时间格式："x分x秒"（<60s 只显 "x秒"）。
	  // 注意与 _formatBatchDuration 分工：MM:SS 留给"片段时长"列，剩余时间类提示用本函数。
	  function _fmtMinSec(sec) {
	    sec = Math.max(0, Math.round(Number(sec) || 0));
	    var m = Math.floor(sec / 60);
	    var s = sec % 60;
	    return m > 0 ? m + "分" + (s < 10 ? "0" + s : s) + "秒" : s + "秒";
	  }

  // 预计时长展示在原算法基础上再 /3（用户口径调整：和实际后端调度并发后的体感更贴近）
  var _BATCH_ESTIMATE_DIVISOR = 3;
  var _BATCH_ESTIMATE_MAX_DISPLAY_MIN = 120;

  function _formatBatchEstimateText(minutes) {
    var n = Math.ceil(Number(minutes) || 0);
    if (!n || n < 0) return "—";
    if (n > _BATCH_ESTIMATE_MAX_DISPLAY_MIN) return "~ " + _BATCH_ESTIMATE_MAX_DISPLAY_MIN + "+ 分钟";
    return "~ " + Math.max(1, n) + " 分钟";
  }

  function _fallbackBatchEstimateText(stats) {
    var sec = Number(stats && stats.plannedSec) || 0;
    if (!sec) return "—";
    return _formatBatchEstimateText(sec * 3 / 60 / _BATCH_ESTIMATE_DIVISOR);
  }

  function _batchEstimateText(stats) {
    var total = Number(stats && stats.total) || 0;
    if (!total) return "—";
    var avgSec = Number(_videoGenerationEstimate.averageSec);
    if (Number.isFinite(avgSec) && avgSec > 0) {
      return _formatBatchEstimateText(avgSec * total / 60 / _BATCH_ESTIMATE_DIVISOR);
    }
    return _fallbackBatchEstimateText(stats);
  }

  function _ensureVideoGenerationEstimate() {
    if (_videoGenerationEstimate.loading) return;
    var now = Date.now();
    if (_videoGenerationEstimate.fetchedAt && now - _videoGenerationEstimate.fetchedAt < 5 * 60 * 1000) return;
    _videoGenerationEstimate.loading = true;
    apiGet("/api/video/estimate?limit=10")
      .then(function (res) {
        var avgSec = Number(res && res.averageSec);
        _videoGenerationEstimate.averageSec = Number.isFinite(avgSec) && avgSec > 0 ? avgSec : null;
        _videoGenerationEstimate.sampleSize = Number(res && res.sampleSize) || 0;
        _videoGenerationEstimate.fetchedAt = Date.now();
      })
      .catch(function (e) {
        console.warn("[video estimate] fetch failed:", e);
        _videoGenerationEstimate.averageSec = null;
        _videoGenerationEstimate.sampleSize = 0;
        _videoGenerationEstimate.fetchedAt = Date.now();
      })
      .finally(function () {
        _videoGenerationEstimate.loading = false;
        _renderBatchVisualStats();
      });
  }

	  function _batchTaskProgress(task) {
	    if (!task) return 0;
	    if (task.status === "done") return 100;
	    if (task.status === "failed" || task.status === "timeout") return 0;
	    if (task.status === "fetching") return 95;
	    var elapsedSec = task.createdAt ? (Date.now() - task.createdAt) / 1000 : 0;
	    return elapsedSec > 0 ? Math.min(Math.round(elapsedSec / 90 * 100), 95) : 5;
	  }

	  function _batchRemainingText(task) {
	    if (!task || isTerminal(task)) return "—";
	    var pct = Math.max(1, _batchTaskProgress(task));
	    var elapsedSec = task.createdAt ? Math.max(0, (Date.now() - task.createdAt) / 1000) : 0;
	    if (!elapsedSec || pct <= 1) return "计算中";
	    var estimatedTotal = elapsedSec / (pct / 100);
	    var remaining = Math.max(0, Math.round(estimatedTotal - elapsedSec));
	    return remaining ? "剩余约 " + _fmtMinSec(remaining) : "即将完成";
	  }

	  function _batchThumbHtml(src) {
	    return src
	      ? '<img class="batch-row-thumb-img" loading="lazy" decoding="async" src="' + escapeHtml(src) + '" />'
	      : '<div class="batch-row-thumb-empty"><span class="material-symbols-outlined">movie_filter</span></div>';
	  }

	  function _setText(id, text) {
	    var el = $(id);
	    if (el) el.textContent = text;
	  }

	  function _collectBatchVisualStats(groups) {
	    var sourceGroups = groups || getStoryboardGroups();
	    var stats = { total: 0, done: 0, running: 0, pending: 0, failed: 0, plannedSec: 0 };
	    sourceGroups.forEach(function (group, gIdx) {
	      var sb = project && project.storyboards && project.storyboards[gIdx];
	      if (!sb || !sb.videoPrompt) return;
	      stats.total++;
	      stats.plannedSec += _plannedDurForBatchGroup(group);
	      // 扫描该片段全部任务：重新生成成功后，残留的旧「失败」任务不应再把整组算成异常。
	      // 优先级 running > done(或已有当前视频) > failed > pending。
	      var hasActive = false, hasDone = false, hasFailed = false;
	      var _allTasks = (videoState && Array.isArray(videoState.tasks)) ? videoState.tasks : [];
	      for (var _ti = 0; _ti < _allTasks.length; _ti++) {
	        var _t = _allTasks[_ti];
	        if (!_t || _t._groupIdx !== gIdx) continue;
	        if (!isTerminal(_t)) hasActive = true;
	        else if (_t.status === "done") hasDone = true;
	        else if (_t.status === "failed" || _t.status === "timeout") hasFailed = true;
	      }
	      if (hasActive) stats.running++;
	      else if (hasDone || sb.videoUrl) stats.done++;
	      else if (hasFailed) stats.failed++;
	      else stats.pending++;
	    });
	    return stats;
	  }

	  function _renderBatchVisualStats(stats) {
	    stats = stats || _collectBatchVisualStats();
	    _ensureVideoGenerationEstimate();
	    var estimateText = _batchEstimateText(stats);
	    _setText("batchStatTotal", stats.total + " 个");
	    _setText("batchStatDone", stats.done + " 个");
	    _setText("batchStatRunning", stats.running + " 个");
	    _setText("batchStatPending", stats.pending + " 个");
	    _setText("batchStatEstimate", estimateText);
	    _setText("batchTabAll", stats.total);
	    _setText("batchTabRunning", stats.running);
	    _setText("batchTabDone", stats.done);
	    _setText("batchTabPending", stats.pending);
	    _setText("batchTabFailed", stats.failed);
	    _setText("batchClipCount", stats.total + " 个片段");
	    return stats;
	  }

	  function _updateBatchTotalProgress() {
	    var wrap = $("batchTotalProgressWrap");
	    var bar = $("batchTotalProgressBar");
	    var label = $("batchTotalProgressLabel");
	    var etaEl = $("batchTotalProgressEta");
	    var pctEl = $("batchProgressPercent");
	    if (!wrap || !bar || !label) return;
		    var stats = _renderBatchVisualStats();
		    var taskTotal = videoState && Array.isArray(videoState.tasks) ? videoState.tasks.length : 0;
		    var tot = stats.total || taskTotal;
	    if (tot === 0) {
	      wrap.hidden = true;
	      return;
	    }
	    var done = stats.done || 0, active = stats.running || 0, fail = stats.failed || 0;
	    var i;
	    wrap.hidden = false;
	    var finished = done + fail;
	    var pct = tot ? Math.round(finished / tot * 100) : 0;
	    bar.style.width = pct + "%";
	    if (pctEl) pctEl.textContent = pct + "%";
	    label.textContent = "已完成 " + done + "/" + tot + " · 进行中 " + active + (fail ? " · 失败 " + fail : "");
	    if (etaEl) {
	      var etaText = "";
      if (active > 0 && done >= 1) {
        var sumMs = 0, cnt = 0;
	        for (i = 0; videoState && Array.isArray(videoState.tasks) && i < videoState.tasks.length; i++) {
          var t2 = videoState.tasks[i];
          if (t2.status === "done" && t2.createdAt && t2._doneAt) {
            sumMs += (t2._doneAt - t2.createdAt);
            cnt++;
          }
        }
        if (cnt > 0) {
          var avgSec = sumMs / cnt / 1000;
          var estSec = Math.round(avgSec * active);
          if (estSec > 8) etaText = "预估剩余约 " + _fmtMinSec(estSec) + "（按已完成片段平均耗时）";
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
	    var clipList = $("batchClipList");
	    var hasPlanRows = !!(clipList && clipList.children && clipList.children.length);
	    if (bEmpty) bEmpty.hidden = hasAny || hasPlanRows;
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
    // 优先按 groupIdx 复用 mirror（同一片段重新生成时不应该出现两张卡片）
    // —— 用户反馈"片段 8 出现 2 次 / 名字都一样分不清"。
    // groupIdx 缺失（极少见）才退回 localId。
    var mirror = null;
    if (task._groupIdx != null) {
      mirror = bWrap.querySelector('[data-group-idx="' + task._groupIdx + '"]');
      if (mirror) mirror.dataset.mirrorId = task.localId; // 让后续 localId 查找也能命中
    }
    if (!mirror) mirror = bWrap.querySelector('[data-mirror-id="' + task.localId + '"]');

    var st = task.status, fail = st === "failed" || st === "timeout";
    var done = st === "done", active = !isTerminal(task);
    var fetching = st === "fetching";

	    var progressPct = _batchTaskProgress(task);
	    var statusLabel, statusTone, statusIcon;
	    if (done) {
	      statusLabel = '已完成'; statusTone = 'is-done'; statusIcon = 'check_circle';
	    } else if (fail) {
	      statusLabel = '失败'; statusTone = 'is-failed'; statusIcon = 'error';
	    } else if (fetching) {
	      statusLabel = '下载中'; statusTone = 'is-running'; statusIcon = 'sync';
	    } else if (active) {
	      statusLabel = '进行中'; statusTone = 'is-running'; statusIcon = 'motion_photos_auto';
	    } else if (st === "preparing") {
	      statusLabel = '准备中'; statusTone = 'is-running'; statusIcon = 'pending';
	    } else if (st === "submitting") {
	      statusLabel = '提交中'; statusTone = 'is-running'; statusIcon = 'sync';
	    } else {
	      statusLabel = '未开始'; statusTone = 'is-pending'; statusIcon = 'radio_button_checked';
	    }

			    var taskMeta = escapeHtml(_taskDisplayMeta(task));
			    var timeStr = formatTime(task.createdAt);
			    var firstWarning = Array.isArray(task.warnings) && task.warnings.length ? task.warnings[0] : null;
			    var warningText = firstWarning ? escapeHtml(firstWarning.message || firstWarning.key || String(firstWarning)) : '';
			    var failureText = fail ? _taskFailureDisplayText(task) : '';
			    if (warningText && failureText && warningText === escapeHtml(failureText)) warningText = '';
	    var rowGroupIdx = task._groupIdx != null && Number.isFinite(Number(task._groupIdx)) ? Number(task._groupIdx) : null;
	    var rowGroups = [];
	    try { rowGroups = getStoryboardGroups() || []; } catch (_rowGroupErr) { rowGroups = []; }
	    var rowGroup = rowGroupIdx != null ? rowGroups[rowGroupIdx] : null;
	    var rowSb = rowGroupIdx != null && project && project.storyboards ? (project.storyboards[rowGroupIdx] || {}) : {};
	    var rowThumbSrc = rowSb.firstFrameUrl || rowSb.rawUrl || rowSb.url || rowSb.imageUrl || '';
	    var rowPlannedSec = rowGroup ? _plannedDurForBatchGroup(rowGroup) : 0;
	    var rowDurationText = _formatBatchDuration((rowSb && rowSb.videoDurationSec) || rowPlannedSec);
	    var shotCount = rowGroup && Array.isArray(rowGroup.shots) ? rowGroup.shots.length : 1;
	    var rowShotType = rowGroup && rowGroup.shots && rowGroup.shots[0] && rowGroup.shots[0].shotType ? rowGroup.shots[0].shotType : 'Clip';
	    var rowCharCount = 0, rowSceneCount = 0;
	    ((rowSb && rowSb._matchedRefs) || []).forEach(function (r) {
	      var role = r.role || r.type;
	      if (role === "character") rowCharCount++;
	      else if (role === "scene") rowSceneCount++;
	    });
	    var remainingText = _batchRemainingText(task);

	    var playBtnHtml = '';
	    if (done && (task.videoUrl || task.blobUrl)) {
	      playBtnHtml =
	        '<button type="button" class="batch-row-action batch-row-action-primary batch-play-btn" data-video-url="' + escapeHtml(task.blobUrl || task.videoUrl) + '">' +
	          '<span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 1;">play_arrow</span>播放' +
	        '</button>';
	    }

	    var historyBtnHtml = '';
	    if (done && task._groupIdx != null && (task.videoUrl || task.blobUrl)) {
	      historyBtnHtml =
	        '<button type="button" class="batch-row-icon-action mirror-history-btn" data-action="open-video-history" data-group-idx="' + task._groupIdx + '" title="历史视频" aria-label="历史视频">' +
	          '<span class="material-symbols-outlined">history</span>' +
	        '</button>';
	    }
	    var deleteBtnHtml = '';
	    if (done && task._groupIdx != null && (task.videoUrl || task.blobUrl)) {
	      deleteBtnHtml =
	        '<button type="button" class="batch-row-icon-action mirror-delete-btn" data-action="mirror-delete" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '" title="删除该已生成片段" aria-label="删除该已生成片段">' +
	          '<span class="material-symbols-outlined">delete</span>' +
	        '</button>';
	    }

	    var failBtnsHtml = '';
	    if (fail && (task._retryBody || (task._groupIdx !== undefined && project && project.storyboards && project.storyboards[task._groupIdx]))) {
	      failBtnsHtml =
	        '<button type="button" class="batch-row-action" data-action="retry" data-task-id="' + task.localId + '" title="重新生成">' +
	          '<span class="material-symbols-outlined">refresh</span>重新生成' +
	        '</button>';
	    }

	    var regenBtnHtml = '';
	    var importBtnHtml = '';
	    var downloadBtnHtml = '';
	    if (done && task._groupIdx != null && (task.videoUrl || task.blobUrl)) {
	      regenBtnHtml =
	        '<button type="button" class="batch-row-action mirror-regen-btn" data-action="retry" data-task-id="' + task.localId + '" title="重新生成">' +
	          '<span class="material-symbols-outlined">refresh</span>重新生成' +
	        '</button>';
	      var _imported = false;
	      try { _imported = isGroupImported(task._groupIdx); } catch (_e) {}
	      if (_imported) {
	        importBtnHtml =
	          '<button type="button" class="batch-row-action mirror-import-btn" data-action="mirror-import-edit" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '">' +
	            '<span class="material-symbols-outlined">check_circle</span>已导入' +
	          '</button>';
	      } else {
	        importBtnHtml =
	          '<button type="button" class="batch-row-action batch-row-action-dark mirror-import-btn" data-action="mirror-import-edit" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '">' +
	            '<span class="material-symbols-outlined">movie</span>导入' +
	          '</button>';
	      }
	      downloadBtnHtml =
	        '<button type="button" class="batch-row-action mirror-download-btn" data-action="mirror-download" data-group-idx="' + task._groupIdx + '" data-task-id="' + task.localId + '" title="下载该视频片段">' +
	          '<span class="material-symbols-outlined">download</span>下载' +
	        '</button>';
	    }

	    var moreMenuHtml = '';
	    if (importBtnHtml || downloadBtnHtml) {
	      moreMenuHtml =
	        '<div class="mirror-more-wrap">' +
	          '<button type="button" class="batch-row-icon-action mirror-more-btn" data-action="toggle-mirror-menu" aria-haspopup="true" aria-expanded="false" title="更多操作" aria-label="更多操作">' +
	            '<span class="material-symbols-outlined">more_vert</span>' +
	          '</button>' +
	          '<div class="mirror-more-menu" hidden>' +
	            importBtnHtml +
	            downloadBtnHtml +
	          '</div>' +
	        '</div>';
	    }

    if (!mirror) {
      mirror = document.createElement("div");
      mirror.dataset.mirrorId = task.localId;
      if (task._groupIdx != null) mirror.dataset.groupIdx = String(task._groupIdx);
      // 按 groupIdx 升序插入（片段 1, 2, 3, ...），用户不再被"乱序排列"困扰
      var inserted = false;
      if (task._groupIdx != null) {
        var siblings = bWrap.children;
        for (var si = 0; si < siblings.length; si++) {
          var sib = siblings[si];
          var sibGi = sib.dataset && sib.dataset.groupIdx != null ? Number(sib.dataset.groupIdx) : NaN;
          if (Number.isFinite(sibGi) && sibGi > task._groupIdx) {
            bWrap.insertBefore(mirror, sib);
            inserted = true;
            break;
          }
        }
      }
      if (!inserted) bWrap.appendChild(mirror);
    } else if (task._groupIdx != null && mirror.dataset.groupIdx == null) {
      mirror.dataset.groupIdx = String(task._groupIdx);
    }

    var existingPlayer = mirror.querySelector('.batch-inline-player');
    var playerHtml = existingPlayer ? existingPlayer.outerHTML : '';

    // Tail-frame alignment check drawer: only meaningful when the video was
    // generated via Builder A (payloadMode === 'first_last_frame') and the
    // provider echoed back its own last_frame_url. Lets the user eyeball
    // "did the video actually end on my submitted tail frame?"
    var auditCompareHtml = '';
    if (done && task._groupIdx != null) {
      try {
        var persistedVt = Array.isArray(project && project.videoTasks) ? project.videoTasks[task._groupIdx] : null;
        var audit = persistedVt && persistedVt.videoAudit;
        var persistedSb = project && project.storyboards && project.storyboards[task._groupIdx];
        var submittedTailUrl = persistedSb
          ? ((persistedSb.frames && persistedSb.frames.tail && persistedSb.frames.tail.url) || persistedSb.tailFrameUrl || '')
          : '';
        if (audit && audit.payloadMode === 'first_last_frame' && audit.returnedLastFrameUrl) {
          var submittedHashDisplay = audit.submittedLastFrameContentHash
            ? String(audit.submittedLastFrameContentHash).slice(0, 16) + '…'
            : '(未记录)';
          var returnedHashDisplay = audit.returnedLastFrameContentHash
            ? String(audit.returnedLastFrameContentHash).slice(0, 16) + '…'
            : '(未记录)';
          auditCompareHtml =
            '<details class="tail-align-check border-t border-outline-variant/10">' +
              '<summary class="px-4 py-2 text-[10px] font-bold tracking-widest uppercase cursor-pointer text-on-surface-variant flex items-center gap-1.5 hover:bg-surface-container-low">' +
                '<span class="material-symbols-outlined text-xs">compare_arrows</span>' +
                '尾帧对齐检查 · first_last_frame' +
                (audit.capabilityVerifiedAt ? '<span class="ml-auto text-[9px] font-mono text-on-surface-variant/40">cap ' + escapeHtml(String(audit.capabilityVerifiedAt)) + '</span>' : '') +
              '</summary>' +
              '<div class="px-4 pb-4 grid grid-cols-2 gap-3">' +
                '<div class="flex flex-col gap-1.5">' +
                  (submittedTailUrl
                    ? '<img src="' + escapeHtml(submittedTailUrl) + '" class="w-full rounded-lg border border-outline-variant/20 aspect-video object-cover" alt="submitted tail frame" />'
                    : '<div class="w-full aspect-video rounded-lg border border-outline-variant/20 bg-surface-container flex items-center justify-center text-[10px] text-on-surface-variant/40">提交的尾帧已丢失</div>') +
                  '<p class="text-[10px] font-bold">你提交的尾帧</p>' +
                  '<p class="text-[9px] font-mono text-on-surface-variant/40">sha256 ' + escapeHtml(submittedHashDisplay) + '</p>' +
                '</div>' +
                '<div class="flex flex-col gap-1.5">' +
                  '<img src="' + escapeHtml(audit.returnedLastFrameUrl) + '" class="w-full rounded-lg border border-outline-variant/20 aspect-video object-cover" alt="Seedance returned last frame" />' +
                  '<p class="text-[10px] font-bold">Seedance 视频实际结尾</p>' +
                  '<p class="text-[9px] font-mono text-on-surface-variant/40">sha256 ' + escapeHtml(returnedHashDisplay) + '</p>' +
                '</div>' +
              '</div>' +
              '<p class="px-4 pb-3 text-[10px] text-on-surface-variant/50">如果差异明显，请点上方「重新生成」重跑视频。</p>' +
            '</details>';
        }
      } catch (_auditErr) {
        // audit 渲染出错不应该影响 mirror 主体，悄默失败
        auditCompareHtml = '';
      }
    }

	    mirror.className = "batch-segment-row batch-live-row " + statusTone;
	    mirror.innerHTML =
	      '<div class="batch-row-info">' +
	        '<div class="batch-row-thumb">' + _batchThumbHtml(rowThumbSrc) + '</div>' +
	        '<div class="batch-row-copy">' +
	          '<h4>' + escapeHtml(rowGroupIdx != null ? (String(rowGroupIdx + 1).padStart(2, "0") + '_片段_' + rowShotType) : _taskDisplayName(task)) + '</h4>' +
	          '<p>来源：' + taskMeta + '</p>' +
	          (warningText ? '<p class="batch-row-warning has-tip" data-tip="' + warningText + '">' + warningText + '</p>' : '') +
		          (fail && failureText ? '<p class="batch-row-error has-tip" data-tip="' + escapeHtml(failureText) + '">' + escapeHtml(failureText) + '</p>' : '') +
	        '</div>' +
	      '</div>' +
	      '<div class="batch-row-status">' +
	        '<span class="batch-status-pill ' + statusTone + '"><span class="material-symbols-outlined">' + statusIcon + '</span>' + statusLabel + '</span>' +
	        '<div class="batch-row-progress"><i style="width:' + progressPct + '%"></i></div>' +
	        '<em>' + progressPct + '%</em>' +
	      '</div>' +
	      '<div class="batch-row-actions">' +
	        playBtnHtml +
	        regenBtnHtml +
	        historyBtnHtml +
	        deleteBtnHtml +
	        moreMenuHtml +
	        failBtnsHtml +
	      '</div>' +
	      playerHtml +
	      auditCompareHtml;

	    var bEmpty = $("batchTasksEmpty");
	    if (bEmpty) bEmpty.hidden = videoState.tasks.length > 0;
	    hydrateProtectedImageElements(mirror);

	  }

  function _initBatchPlayerEvents() {
    _syncVideoRefs();
    var bWrap = $("batchTaskListWrap");
    if (!bWrap || bWrap._playerBound) return;
    bWrap._playerBound = true;

    function closeInlinePlayer(player, ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      if (!player) return;
      var v = player.querySelector("video");
      if (v) {
        try { v.pause(); } catch (_) {}
      }
      var blobUrl = player.dataset && player.dataset.blobUrl;
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      }
      player.remove();
    }

    function closeAllMirrorMenus(except) {
      var menus = bWrap.querySelectorAll(".mirror-more-wrap");
      menus.forEach(function (w) {
        if (except && w === except) return;
        var menu = w.querySelector(".mirror-more-menu");
        var btn = w.querySelector(".mirror-more-btn");
        if (menu) menu.hidden = true;
        if (btn) btn.setAttribute("aria-expanded", "false");
        w.classList.remove("is-open");
      });
    }

    if (!document._mirrorMenuOutsideBound) {
      document._mirrorMenuOutsideBound = true;
      document.addEventListener("click", function (e) {
        var hostWrap = $("batchTaskListWrap");
        if (!hostWrap) return;
        if (e.target.closest(".mirror-more-wrap")) return;
        var menus = hostWrap.querySelectorAll(".mirror-more-wrap");
        menus.forEach(function (w) {
          var menu = w.querySelector(".mirror-more-menu");
          var btn = w.querySelector(".mirror-more-btn");
          if (menu) menu.hidden = true;
          if (btn) btn.setAttribute("aria-expanded", "false");
          w.classList.remove("is-open");
        });
      });
    }

    bWrap.addEventListener("click", async function (e) {
      var closeBtn = e.target.closest(".batch-close-player");
      if (closeBtn && bWrap.contains(closeBtn)) {
        closeInlinePlayer(closeBtn.closest(".batch-inline-player"), e);
        return;
      }

      var actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        var act = actionBtn.dataset.action;
        var tid = actionBtn.dataset.taskId;
        if (act === "open-video-history") {
          e.preventDefault();
          var hGIdx = parseInt(actionBtn.dataset.groupIdx, 10);
          if (!isNaN(hGIdx)) _openVideoHistoryModal(hGIdx);
          return;
        }
        if (act === "toggle-mirror-menu") {
          e.preventDefault();
          e.stopPropagation();
          var wrap = actionBtn.closest(".mirror-more-wrap");
          if (!wrap) return;
          var menu = wrap.querySelector(".mirror-more-menu");
          var willOpen = menu && menu.hidden;
          closeAllMirrorMenus(willOpen ? wrap : null);
          if (menu) menu.hidden = !willOpen;
          actionBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
          wrap.classList.toggle("is-open", !!willOpen);
          return;
        }
        if (act === "mirror-delete") {
          var delGIdx = parseInt(actionBtn.dataset.groupIdx, 10);
          if (isNaN(delGIdx)) return;
          if (!window.confirm("确定要删除该已生成的视频片段吗？此操作不可撤销。")) return;
          if (!project || !project.id) {
            showToast("请先打开项目", "warn");
            return;
          }
          actionBtn.disabled = true;
          try {
            var delResp = await apiPost("/api/tasks/video-by-project", {
              projectId: project.id,
              groupIdx: delGIdx,
            }, "DELETE");
            if (delResp && delResp.serverVersion != null) {
              project.version = Number(delResp.serverVersion) || project.version;
            }
            if (delResp && delResp.edl) {
              if (!project.editData) project.editData = {};
              project.editData.edl = delResp.edl;
            }
            if (delResp && delResp.readiness) {
              if (!project.editData) project.editData = {};
              project.editData.readiness = delResp.readiness;
            }
          } catch (delErr) {
            actionBtn.disabled = false;
            showToast("删除失败: " + _diagnoseApiError(((delErr && delErr.message) || delErr).toString()), "error");
            return;
          }
          // 1) 清掉本地 storyboard/videoTasks 镜像；后端已原子落盘。
          try {
            if (project && project.storyboards && project.storyboards[delGIdx]) {
              var sbDel = project.storyboards[delGIdx];
              sbDel.importedToEdit = false;
              delete sbDel.videoUrl;
              delete sbDel._originVideoUrl;
              delete sbDel.videoTaskId;
              delete sbDel.videoCoverUrl;
              delete sbDel.videoStatus;
              delete sbDel.videoMode;
	              delete sbDel.videoTaskFinishedAt;
	              delete sbDel.videoDurationSec;
	              delete sbDel.videoFilename;
	              delete sbDel.videoDisplayName;
	              delete sbDel.videoDownloadFilename;
	              delete sbDel.readyForEdit;
              delete sbDel.videoWarnings;
              delete sbDel.videoIsCurrent;
              // 必须连带清掉 videoAssetId，否则 hydrateProjectAssetUrls 会用
              // 它重签出新的 videoUrl，导致「删除 → 全部生成」立刻显示已完成。
              delete sbDel.videoAssetId;
            }
            if (project && Array.isArray(project.videoTasks) && project.videoTasks[delGIdx]) {
              project.videoTasks[delGIdx] = null;
            }
          } catch (_e) {}
          // 2) 干掉关联任务（清掉镜像卡 + 主任务卡）
          try {
            for (var dk = videoState.tasks.length - 1; dk >= 0; dk--) {
              var dt = videoState.tasks[dk];
              if (dt && Number(dt._groupIdx) === delGIdx) {
                dt._killed = true;
                if (dt._sseHandle) { try { dt._sseHandle.close(); } catch (_e) {} dt._sseHandle = null; }
                if (dt.blobUrl) { try { URL.revokeObjectURL(dt.blobUrl); } catch (_e) {} dt.blobUrl = ""; }
                if (dt.cardEl && dt.cardEl.parentNode) dt.cardEl.parentNode.removeChild(dt.cardEl);
                videoState.tasks.splice(dk, 1);
              }
            }
          } catch (_e) {}
          // 3) 干掉对应的镜像行
          try {
            var oldMirror = bWrap.querySelector('[data-group-idx="' + delGIdx + '"]');
            if (oldMirror && oldMirror.parentNode) oldMirror.parentNode.removeChild(oldMirror);
          } catch (_e) {}
          // 4) 刷新本页镜像；不再走 saveProject，避免旧版本整包 PUT 把删除覆盖回来。
          try { renderBatchClipList(); } catch (_e) {}
          try { syncTaskListVisibility(); } catch (_e) {}
          try { updateBadge(); } catch (_e) {}
          showToast("已删除该视频片段", "ok");
          return;
        }
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
          closeAllMirrorMenus(null);
          return;
        }
        if (act === "mirror-download") {
          var dlTask = null;
          if (tid) {
            for (var di = 0; di < videoState.tasks.length; di++) {
              if (videoState.tasks[di].localId === tid) { dlTask = videoState.tasks[di]; break; }
            }
          }
          if (!dlTask) {
            var dlGIdx = parseInt(actionBtn.dataset.groupIdx, 10);
            if (!isNaN(dlGIdx)) {
              for (var dj = 0; dj < videoState.tasks.length; dj++) {
                if (Number(videoState.tasks[dj]._groupIdx) === dlGIdx) { dlTask = videoState.tasks[dj]; break; }
              }
            }
          }
          downloadVideoTask(dlTask, actionBtn);
          closeAllMirrorMenus(null);
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
      mirror.appendChild(playerDiv);
      var blobUrlToRevoke = "";

      function closePlayer(ev) {
        closeInlinePlayer(playerDiv, ev);
        if (blobUrlToRevoke) {
          try { URL.revokeObjectURL(blobUrlToRevoke); } catch (_) {}
          blobUrlToRevoke = "";
        }
      }

      function renderFallback() {
        playerDiv.innerHTML =
          '<div class="relative p-4 text-center text-xs text-on-surface-variant">' +
            '<button type="button" class="batch-close-player absolute top-2 right-2 w-7 h-7 rounded-full bg-black/10 text-on-surface flex items-center justify-center hover:bg-black/20 transition-colors">' +
              '<span class="material-symbols-outlined text-sm">close</span>' +
            '</button>' +
            '<p>预览加载失败，请关闭后重试。</p>' +
          '</div>';
        var c = playerDiv.querySelector(".batch-close-player");
        if (c) c.addEventListener("click", closePlayer);
      }

      function renderLoading() {
        playerDiv.innerHTML =
          '<div class="relative rounded-lg overflow-hidden bg-black aspect-video flex items-center justify-center text-white/70 text-xs">' +
            '<span>正在准备预览…</span>' +
            '<button type="button" class="batch-close-player absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors z-10">' +
              '<span class="material-symbols-outlined text-sm">close</span>' +
            '</button>' +
          '</div>';
        var c = playerDiv.querySelector(".batch-close-player");
        if (c) c.addEventListener("click", closePlayer);
      }

      function renderVideo(src, allowFetchFallback) {
        playerDiv.innerHTML =
          '<div class="relative rounded-lg overflow-hidden bg-black aspect-video">' +
            '<video src="' + escapeHtml(src) + '" class="w-full h-full" controls autoplay playsinline preload="auto"></video>' +
            '<button type="button" class="batch-close-player absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors z-10">' +
              '<span class="material-symbols-outlined text-sm">close</span>' +
            '</button>' +
          '</div>';
        var c = playerDiv.querySelector(".batch-close-player");
        if (c) c.addEventListener("click", closePlayer);
        var video = playerDiv.querySelector("video");
        if (video && allowFetchFallback) {
          video.addEventListener("error", function () {
            renderLoading();
            fetchVideoBuffer(videoUrl).then(function (buf) {
              if (!playerDiv.isConnected) return;
              if (blobUrlToRevoke) { try { URL.revokeObjectURL(blobUrlToRevoke); } catch (_) {} }
              blobUrlToRevoke = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
              playerDiv.dataset.blobUrl = blobUrlToRevoke;
              renderVideo(blobUrlToRevoke, false);
            }).catch(renderFallback);
          }, { once: true });
        }
      }

      if (_isInternalVideoUrl(videoUrl) && !/[?&]sig=/.test(videoUrl)) {
        renderLoading();
        fetchVideoBuffer(videoUrl).then(function (buf) {
          if (!playerDiv.isConnected) return;
          blobUrlToRevoke = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
          playerDiv.dataset.blobUrl = blobUrlToRevoke;
          renderVideo(blobUrlToRevoke, false);
        }).catch(renderFallback);
      } else {
        renderVideo(videoUrl, true);
      }
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
	      '<p class="tc-prompt">' + escapeHtml(_taskDisplayName(task) + ' · ' + _taskDisplayMeta(task)) + '</p>' +
	      '<p class="tc-warning" style="margin:4px 0 0;color:#a15c00;font-size:11px;line-height:1.35" hidden></p>' +
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
	    task._warningText = card.querySelector(".tc-warning");
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
		    task._badge.textContent = fail ? _taskFailureDisplayText(task) : task.statusCn;
	    task._badge.className = "tc-badge tc-badge--" + st;
	    if (task._warningText) {
	      var firstWarning = Array.isArray(task.warnings) && task.warnings.length ? task.warnings[0] : null;
	      task._warningText.hidden = !firstWarning;
	      task._warningText.textContent = firstWarning ? (firstWarning.message || firstWarning.key || String(firstWarning)) : "";
	    }

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
    // 同时清掉 batch 页的 mirror 行。否则任务因为 MAX_TASKS_TOTAL 容量超限
    // 从 videoState.tasks 里被挤掉之后，孤儿 mirror 还留在 batchTaskListWrap
    // 里，下一次 renderBatchClipList 又给同 groupIdx 渲一个 plan card，于是
    // 出现「同一片段重复显示两行」的鬼影 bug。
    try {
      var bWrap = $("batchTaskListWrap");
      if (bWrap && task.localId) {
        var orphan = bWrap.querySelector('[data-mirror-id="' + task.localId + '"]');
        if (orphan && orphan.parentNode) orphan.parentNode.removeChild(orphan);
      }
    } catch (_e) {}
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
	    var raw = ((errMsg == null) ? "" : String(errMsg));
	    var s = raw.toLowerCase();
		    try { if (s) console.debug('[friendlyVideoError] raw:', raw.slice(0, 200)); } catch (_e) {}
		    if (!s) return "生成失败，请稍后重试";
		    if (raw.indexOf("片段结尾仓促") >= 0 || /video_duration_budget_blocked|tail_rushed/.test(s)) {
		      return "片段结尾仓促，请在镜头页增加对应片段的视频时长";
		    }
		    if (/低质量提交图|jpeg\s*字节\/像素|low_jpeg_bytes_per_pixel/.test(raw)) return "疑似低质量首帧图生成视频";
	    // 积分不足 —— 直接把后端原文（含具体积分数）透出来，不要再被改成"生成失败"
	    if (/积分不足|insufficient.*credit|余额.*不足|credits?.*insufficient/.test(raw)) {
      // 只截前 60 字避免 UI 撑炸
      return raw.length > 60 ? (raw.slice(0, 58) + '…') : raw;
    }
    if (/timeout|timed out|超时|排队过久/.test(s)) return "等待时间过长，请稍后再试";
    if (/network|econnreset|enet|fetch|connection/.test(s)) return "网络波动，请稍后再试";
    if (/content|policy|safety|blocked|敏感|违规/.test(s)) return "素材不符合内容规范，请调整后重试";
    if (/quota|rate.?limit|429/.test(s)) return "通道繁忙，请稍后再试";
	    return "生成失败，请稍后重试";
	  }

	  function _lowQualityFirstFrameWarningText(warnings) {
	    var list = Array.isArray(warnings) ? warnings : [];
	    for (var i = 0; i < list.length; i++) {
	      var w = list[i] || {};
	      var code = String(w.code || w.key || "");
	      var msg = String(w.message || "");
	      var role = String(w.role || "");
	      if ((code.indexOf("low_jpeg_bytes_per_pixel") >= 0 || msg.indexOf("低质量") >= 0) && (!role || role === "first_frame" || msg.indexOf("首帧") >= 0)) {
	        return "疑似低质量首帧图生成视频";
	      }
	    }
	    return "";
	  }

	  function _taskFailureDisplayText(task) {
	    var text = String((task && task.statusCn) || "");
	    var friendly = text ? _friendlyVideoError(text) : "";
	    if (friendly && friendly !== "生成失败，请稍后重试") return friendly;
	    if (!text || text === "生成失败，请稍后重试") {
	      return _lowQualityFirstFrameWarningText(task && task.warnings) || text || "生成失败，请稍后重试";
	    }
	    return text;
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

  var _INTERNAL_VIDEO_RE = /\/api\/videos\/file\/([0-9a-fA-F-]{36})/;

  function _isInternalVideoUrl(url) {
    return _INTERNAL_VIDEO_RE.test(String(url || ""));
  }

  function _protectedVideoUrlFrom(url) {
    var m = _INTERNAL_VIDEO_RE.exec(String(url || ""));
    return m ? "/api/videos/file/" + m[1] : "";
  }

  function _setStoryboardVideoUrl(gIdx, url, protectedUrl) {
    _markGroupVideoCurrent(gIdx, url, { protectedUrl: protectedUrl });
  }

  async function fetchVideoBuffer(url) {
    var opts = _isInternalVideoUrl(url) ? { headers: getAuthHeaders(), cache: "no-store" } : {};
    var res; try { res = await fetch(url, opts); } catch (e) { throw new Error((e && e.message || String(e)) + " — 网络请求失败"); }
    if (!res.ok) throw new Error("下载失败 HTTP " + res.status);
    return await res.arrayBuffer();
  }

  // ───────────────────────── 历史视频弹窗 ─────────────────────────
  function _vhDateParts(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return { short: "", full: String(iso || "") };
    function p(n) { return String(n).padStart(2, "0"); }
    var short = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    var full = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    return { short: short, full: full };
  }

  function _vhSegmentName(gIdx) {
    var name = String(gIdx + 1).padStart(2, "0") + "_片段";
    try {
      var groups = getStoryboardGroups() || [];
      var g = groups[gIdx];
      var st = g && g.shots && g.shots[0] && g.shots[0].shotType ? g.shots[0].shotType : "";
      if (st) name += "_" + st;
    } catch (_e) {}
    return name;
  }

	  function _vhItemName(gIdx, item) {
	    var base = item && (item.displayName || item.display_name || item.title || item.name);
	    if (!base) base = _vhSegmentName(gIdx);
	    return base + " · " + _vhDateParts(item && item.created_at).short;
	  }

  async function _openVideoHistoryModal(gIdx) {
    _syncVideoRefs();
    if (!project || !project.id) { showToast("请先打开项目", "warn"); return; }

    // 同一时刻只保留一个弹窗
    var existed = document.querySelector(".vh-overlay");
    if (existed && existed.parentNode) existed.parentNode.removeChild(existed);

    var overlay = document.createElement("div");
    overlay.className = "vh-overlay";
    overlay.innerHTML =
      '<div class="vh-modal" role="dialog" aria-modal="true" aria-label="历史视频">' +
        '<div class="vh-head">' +
          '<h3 class="vh-title">历史视频 · ' + escapeHtml(_vhSegmentName(gIdx)) + '</h3>' +
          '<button type="button" class="vh-close" data-vh="close" aria-label="关闭"><span class="material-symbols-outlined">close</span></button>' +
        '</div>' +
        '<div class="vh-body">' +
          '<div class="vh-left">' +
            '<div class="vh-player" data-vh="player"></div>' +
            '<p class="vh-player-name" data-vh="player-name"></p>' +
          '</div>' +
          '<div class="vh-right" data-vh="list"><div class="vh-loading">加载中…</div></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var listEl = overlay.querySelector('[data-vh="list"]');
    var playerEl = overlay.querySelector('[data-vh="player"]');
    var playerNameEl = overlay.querySelector('[data-vh="player-name"]');
    var state = { items: [], selected: null };

    function cleanupBlob() {
      if (playerEl && playerEl._vhBlob) { try { URL.revokeObjectURL(playerEl._vhBlob); } catch (_e) {} playerEl._vhBlob = ""; }
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    function close() {
      cleanupBlob();
      document.removeEventListener("keydown", onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    document.addEventListener("keydown", onKey);

    function mountPlayer(item, autoplay) {
      cleanupBlob();
      playerEl.classList.remove("is-loading");
      if (!item) {
        playerEl.innerHTML = '<div class="vh-player-empty"><span class="material-symbols-outlined">movie</span></div>';
        return;
      }
      if (!autoplay) {
        playerEl.innerHTML = '<button type="button" class="vh-play-btn" data-vh="play" aria-label="播放该视频"><span class="material-symbols-outlined">play_arrow</span></button>';
        return;
      }
      playerEl.innerHTML = "";
      var src = item.url || item.protected_url || "";
      var video = document.createElement("video");
      video.className = "vh-video";
      video.controls = true; video.autoplay = true; video.playsInline = true;
      video.setAttribute("playsinline", "");
      playerEl.appendChild(video);
      function fallbackBuffer(u) {
        playerEl.classList.add("is-loading");
        fetchVideoBuffer(u).then(function (buf) {
          if (!playerEl.isConnected) return;
          var b = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
          playerEl._vhBlob = b; video.src = b; playerEl.classList.remove("is-loading");
          video.play().catch(function () {});
        }).catch(function () {
          playerEl.classList.remove("is-loading");
          mountPlayer(item, false);
          showToast("预览加载失败", "warn");
        });
      }
      if (_isInternalVideoUrl(src) && !/[?&]sig=/.test(src)) {
        fallbackBuffer(src);
      } else {
        video.src = src;
        video.addEventListener("error", function () { fallbackBuffer(item.protected_url || src); }, { once: true });
        video.play().catch(function () {});
      }
    }

    function selectItem(item) {
      state.selected = item;
      playerNameEl.textContent = item ? _vhItemName(gIdx, item) : "";
      mountPlayer(item, false);
      renderList();
    }

    function renderList() {
      if (!state.items.length) { listEl.innerHTML = '<div class="vh-empty">空</div>'; return; }
      var html = "";
      state.items.forEach(function (item, i) {
        var parts = _vhDateParts(item.created_at);
        var isSel = state.selected && state.selected.task_id === item.task_id;
        html +=
          '<div class="vh-card' + (isSel ? " is-selected" : "") + (item.is_current ? " is-current" : "") + '" data-vh="card" data-idx="' + i + '">' +
            '<div class="vh-card-main">' +
              '<p class="vh-card-name">' + escapeHtml(_vhItemName(gIdx, item)) +
                (item.is_current ? '<span class="vh-current-tag">当前</span>' : "") + '</p>' +
              '<p class="vh-card-time">生成于 ' + escapeHtml(parts.full) + '</p>' +
            '</div>' +
            (item.is_current
              ? '<button type="button" class="vh-replace is-disabled" disabled>当前使用中</button>'
              : '<button type="button" class="vh-replace" data-vh="replace" data-idx="' + i + '">替换</button>') +
          '</div>';
      });
      listEl.innerHTML = html;
    }

    async function doReplace(item, btnEl) {
      if (!project || !project.id) { showToast("请先打开项目", "warn"); return; }
      if (btnEl) { btnEl.disabled = true; btnEl.textContent = "替换中…"; }
      try {
        var resp = await apiPost("/api/tasks/video-by-project", {
          action: "set-current", projectId: project.id, groupIdx: gIdx, taskId: item.task_id,
        });
        var newUrl = (resp && resp.url) || item.url;
        var newProtected = (resp && resp.protectedUrl) || item.protected_url;
	        _markGroupVideoCurrent(gIdx, newUrl, {
	          protectedUrl: newProtected, taskId: item.task_id,
	          filename: (resp && resp.filename) || item.filename,
	          displayName: (resp && resp.displayName) || item.displayName || item.display_name || item.title || item.name,
	          downloadFilename: (resp && resp.downloadFilename) || item.downloadFilename || item.download_filename,
	          durationSec: (resp && resp.durationSec) || item.duration_sec,
	        });
        if (resp && resp.serverVersion != null) project.version = Number(resp.serverVersion) || project.version;
        if (resp && resp.edl) { if (!project.editData) project.editData = {}; project.editData.edl = resp.edl; }
        if (resp && resp.readiness) { if (!project.editData) project.editData = {}; project.editData.readiness = resp.readiness; }
        // 同步本页 live-row 任务的视频地址（让播放/缩略图指向新视频）
        try {
	          for (var i = 0; i < videoState.tasks.length; i++) {
	            var t = videoState.tasks[i];
	            if (t && Number(t._groupIdx) === gIdx) {
	              t.videoUrl = newUrl; t.protectedUrl = newProtected;
	              _applyVideoNameMeta(t, resp || item);
	              if (t.blobUrl) { try { URL.revokeObjectURL(t.blobUrl); } catch (_e) {} t.blobUrl = ""; }
              t.previewOk = false;
              updateTaskCard(t);
              break;
            }
          }
        } catch (_e) {}
        try { renderBatchClipList(); } catch (_e) {}
        try { updateBadge(); } catch (_e) {}
        // 把「当前」标记移到新视频上
        state.items.forEach(function (it) { it.is_current = (it.task_id === item.task_id); });
        selectItem(item);
        showToast("已替换为该历史视频", "ok");
      } catch (err) {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = "替换"; }
        showToast("替换失败: " + _diagnoseApiError(((err && err.message) || err).toString()), "error");
      }
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var hit = e.target.closest("[data-vh]");
      if (!hit) return;
      var kind = hit.dataset.vh;
      if (kind === "close") { close(); return; }
      if (kind === "play") { if (state.selected) mountPlayer(state.selected, true); return; }
      if (kind === "card") {
        var idx = parseInt(hit.dataset.idx, 10);
        if (!isNaN(idx) && state.items[idx]) selectItem(state.items[idx]);
        return;
      }
      if (kind === "replace") {
        var ridx = parseInt(hit.dataset.idx, 10);
        if (!isNaN(ridx) && state.items[ridx]) doReplace(state.items[ridx], hit);
        return;
      }
    });

    // 拉取该片段历史
    try {
      var resp = await apiGet("/api/tasks/video-by-project?projectId=" + encodeURIComponent(project.id) + "&groupIdx=" + gIdx);
      state.items = (resp && resp.history) || [];
    } catch (e) {
      listEl.innerHTML = '<div class="vh-empty">加载失败</div>';
      mountPlayer(null, false);
      return;
    }
    if (!state.items.length) { mountPlayer(null, false); renderList(); return; }
    var cur = null;
    for (var k = 0; k < state.items.length; k++) { if (state.items[k].is_current) { cur = state.items[k]; break; } }
    selectItem(cur || state.items[0]);
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

	  function _videoTaskDownloadName(task) {
	    if (task && task.downloadFilename) return String(task.downloadFilename);
	    if (task && task.filename) return String(task.filename);
	    if (task && task.displayName) return String(task.displayName).replace(/\.mp4$/i, "") + ".mp4";
	    var gIdx = task && task._groupIdx != null ? Number(task._groupIdx) : NaN;
	    if (Number.isFinite(gIdx)) return "origin_clip_" + String(gIdx + 1).padStart(2, "0") + ".mp4";
    return "origin_clip_" + ((task && task.serverTaskId) || Date.now()) + ".mp4";
  }

  async function downloadVideoTask(task, btn) {
    if (!task || !(task.videoUrl || task.blobUrl)) {
      showToast("视频尚未就绪，无法下载", "warn");
      return;
    }
    var originalHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-outlined">sync</span>下载中';
    }
    try {
      if (task.blobUrl) {
        var a = document.createElement("a");
        a.href = task.blobUrl;
        a.download = _videoTaskDownloadName(task);
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { document.body.removeChild(a); } catch (_) {} }, 1000);
      } else {
        var buf = await fetchVideoBuffer(task.videoUrl);
        _downloadBlob(new Blob([buf], { type: "video/mp4" }), _videoTaskDownloadName(task));
      }
      showToast("视频片段已开始下载", "ok");
    } catch (e) {
      showToast("下载失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
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
  async function videoPipeline(task, opts) {
    // silent=true 用在「刷新后给已经完成的视频做预热」场景：task 本来就是
    // done 状态，预热只是顺手把 <video> src 塞进去让点播放更快。如果再把
    // 卡片切到 fetching → "下载中" 用户会以为视频在重新下载，每次刷新都看到
    // 一闪而过的「下载中」也很怪。silent 模式下我们不动 task.status / 不调
    // updateTaskCard，等到 previewOk 真的拿到再静默写回。
    var silent = !!(opts && opts.silent);
    if (task._killed) { _persistVideoUrlToProject(task); return; }
    if (!silent) {
      task.status = "fetching"; task.statusCn = "正在加载成片"; updateTaskCard(task);
    }
    var vidEl = task.videoEl, ok = false;
    try {
      console.log("[Video] Pipeline start" + (silent ? " (silent)" : "") + ", url:", task.videoUrl ? task.videoUrl.slice(0, 80) : "null");

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
      task.status = "done"; task.statusCn = "已完成";
      // silent 模式下 task.status 始终是 done，updateTaskCard 也要刷一下让
      // previewOk 翻转后老 task-card 的 video 区显示出来（不会再翻回 fetching）。
      updateTaskCard(task);
      console.log("[Video] Pipeline done" + (silent ? " (silent)" : "") + ", previewOk=" + ok);
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
    var protectedUrl = task.protectedUrl || _protectedVideoUrlFrom(task.videoUrl);
    _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      if (!proj.storyboards[gIdx]) proj.storyboards[gIdx] = {};
	      proj.storyboards[gIdx].videoUrl = protectedUrl || task.videoUrl;
	      if (task.videoAssetId) proj.storyboards[gIdx].videoAssetId = task.videoAssetId;
	      if (task.fetchStatus) proj.storyboards[gIdx].fetchStatus = task.fetchStatus;
	      if (task.serverTaskId) proj.storyboards[gIdx].videoTaskId = task.serverTaskId;
	      if (task.filename) proj.storyboards[gIdx].videoFilename = task.filename;
	      if (task.displayName) proj.storyboards[gIdx].videoDisplayName = task.displayName;
	      if (task.downloadFilename) proj.storyboards[gIdx].videoDownloadFilename = task.downloadFilename;
	      proj.storyboards[gIdx].videoStatus = task.status || "done";
      proj.storyboards[gIdx].videoIsCurrent = true;
      delete proj.storyboards[gIdx].videoInvalidatedAt;
      delete proj.storyboards[gIdx].videoInvalidatedReason;
      if (!Array.isArray(proj.videoTasks)) proj.videoTasks = [];
      var vt = proj.videoTasks[gIdx] || {};
      vt.groupIdx = gIdx;
      if (task.serverTaskId) vt.taskId = task.serverTaskId;
	      vt.url = protectedUrl || task.videoUrl;
	      if (protectedUrl) vt.protectedUrl = protectedUrl;
	      if (task.filename) vt.filename = task.filename;
	      if (task.displayName) vt.displayName = task.displayName;
	      if (task.downloadFilename) vt.downloadFilename = task.downloadFilename;
	      vt.status = "completed";
      vt.isCurrent = true;
      delete vt.outdated;
      delete vt.invalidatedAt;
      delete vt.invalidatedReason;
      proj.videoTasks[gIdx] = vt;
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
		    var promptReady = _videoPromptReadinessForGroup(gIdx);
		    if (!promptReady.canStart) throw new Error(_videoPromptNotReadyMessage(gIdx, promptReady));

		    var groupLockHeld = !!opts._videoGroupLockHeld;
	    var groupLockAcquired = false;
	    if (!groupLockHeld) {
	      if (!_lockVideoGroup(gIdx)) {
	        showToast(_inFlightMessage([gIdx]), "warn");
	        return;
	      }
	      groupLockAcquired = true;
	    }
	    function releaseGroupLock() {
	      if (groupLockHeld || groupLockAcquired) {
	        _unlockVideoGroup(gIdx);
	        groupLockHeld = false;
	        groupLockAcquired = false;
	      }
	    }

    var task = createVideoTaskObj("片段 " + (gIdx + 1), false);
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
    var ratio = opts.ratio || _projectPreferredVideoRatio();
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
      var startResult = await _postVideoBatchStartWithPreflightHandling({
        batchType: "video_segments",
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
      if (startResult && startResult.aborted) {
        task.status = "failed"; task.statusCn = "已取消：生成前检查未通过";
        updateTaskCard(task); updateBadge();
        releaseGroupLock();
        return;
      }
      var resp = startResult && startResult.resp;
      showConsistencyAggregateWarning(resp);

	      if (resp && resp.errorCode === "MODEL_UNAVAILABLE") {
	        await _handleModelUnavailable(task, resp, { videoModel: videoModel });
	        releaseGroupLock();
	        return;
	      }
	      if (!resp || resp.error || !resp.batchId) {
	        task.status = "failed"; task.statusCn = _friendlyVideoError((resp && resp.error) || "提交失败");
	        updateTaskCard(task); updateBadge();
	        releaseGroupLock();
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
        onTaskProgress: function (data) {
          _applyVideoTaskProgress(task, data);
        },
	        onTaskCompleted: function (data) {
	          var url = data.resultUrl || data.videoUrl || "";
	          var extra = (data && data.extra) || {};
	          _applyVideoNameMeta(task, extra);
	          _applyVideoNameMeta(task, data);
	          var eIdx = (typeof extra.groupIdx === "number") ? extra.groupIdx : null;
          if (project && eIdx != null && Array.isArray(project.storyboards)) {
            if (!project.storyboards[eIdx]) project.storyboards[eIdx] = {};
            if (typeof extra.readyForEdit === "boolean") {
              project.storyboards[eIdx].readyForEdit = extra.readyForEdit;
            }
            if (Array.isArray(extra.videoWarnings)) {
              project.storyboards[eIdx].videoWarnings = extra.videoWarnings;
            }
          }
          if (url) {
            _mergeVideoWarnings(task, extra, false);
            var protectedUrl = (extra && extra.protectedUrl) || _protectedVideoUrlFrom(url);
            task.videoUrl = url;
            task.protectedUrl = protectedUrl;
            if (project && task._groupIdx != null && Array.isArray(project.storyboards)) {
              _markGroupVideoCurrent(task._groupIdx, url, {
	                protectedUrl: protectedUrl,
	                taskId: task.serverTaskId,
	                filename: extra && extra.filename,
	                displayName: extra && extra.displayName,
	                downloadFilename: extra && extra.downloadFilename,
	                durationSec: extra && extra.durationSec,
                plannedDurationSec: extra && extra.plannedDurationSec,
                readyForEdit: extra && extra.readyForEdit,
                videoWarnings: extra && extra.videoWarnings,
              });
            }
            videoPipeline(task).then(function () { updateBadge(); renderBatchClipList(); }).finally(releaseGroupLock);
          } else {
            task.status = "failed"; task.statusCn = "生成完成但无视频地址";
            updateTaskCard(task); updateBadge();
            releaseGroupLock();
          }
        },
	        onTaskFailed: function (data) {
	          var failExtra = (data && data.extra) || {};
	          _mergeVideoWarnings(task, failExtra, false);
	          task.status = "failed";
	          task.statusCn = _videoFailureStatusText(data, data.reason || data.errorMsg || "failed");
	          updateTaskCard(task); updateBadge();
          renderBatchClipList();
          releaseGroupLock();
        },
	        onBatchCompleted: function () { releaseGroupLock(); },
        onClose: function () {},
      });
    } catch (e) {
      if (_isBillingGateError(e)) {
        task.status = 'failed';
        task.statusCn = _billingGateMessage(e, videoModel) || '积分不足';
        updateTaskCard(task); updateBadge();
        showBillingPaywall(e.billing || null);
        showToast(task.statusCn, 'warn');
        releaseGroupLock();
        return;
      }
      task.status = "failed"; task.statusCn = _friendlyVideoError((e && e.message) || e);
      updateTaskCard(task); updateBadge();
      showToast(task.statusCn, "error");
      releaseGroupLock();
    }
  }

  /* Phase 2 · 2.6.4：把单任务挂到 SSE 流上 */
  function _attachTaskStream(task, taskId) {
    if (task._sseHandle) { try { task._sseHandle.close(); } catch (_e) {} task._sseHandle = null; }
    task._sseHandle = subscribeTask(taskId, {
      onProgress: function (data) {
        _applyVideoTaskProgress(task, data);
      },
	      onCompleted: function (data) {
	        var url = data.resultUrl || data.videoUrl || "";
	        var extra = (data && data.extra) || {};
	        _applyVideoNameMeta(task, extra);
	        _applyVideoNameMeta(task, data);
	        var protectedUrl = extra.protectedUrl || _protectedVideoUrlFrom(url);
        // 簇 11：持久化链路产出的 assetId/fetchStatus 如果后端顺手带过来，
        // 就挂到 task 上，让 videoPipeline 能把"下载中→可播"写进分镜。
        if (data && data.assetId) task.videoAssetId = data.assetId;
        if (data && data.fetchStatus) task.fetchStatus = data.fetchStatus;
        if (url) {
          _mergeVideoWarnings(task, extra, false);
          task.videoUrl = url;
          task.protectedUrl = protectedUrl;
          if (project && task._groupIdx != null && Array.isArray(project.storyboards)) {
            _markGroupVideoCurrent(task._groupIdx, url, {
	              protectedUrl: protectedUrl,
	              taskId: task.serverTaskId,
	              filename: extra && extra.filename,
	              displayName: extra && extra.displayName,
	              downloadFilename: extra && extra.downloadFilename,
	              durationSec: extra && extra.durationSec,
              plannedDurationSec: extra && extra.plannedDurationSec,
              readyForEdit: extra && extra.readyForEdit,
              videoWarnings: extra && extra.videoWarnings,
            });
          }
          videoPipeline(task).then(function () { updateBadge(); });
        } else {
          task.status = "failed"; task.statusCn = "生成完成但无视频地址";
          updateTaskCard(task); updateBadge();
        }
      },
	      onFailed: function (data) {
	        var failExtra = (data && data.extra) || {};
	        _mergeVideoWarnings(task, failExtra, false);
	        task.status = "failed";
	        task.statusCn = _videoFailureStatusText(data, data.reason || "failed");
	        updateTaskCard(task); updateBadge();
      },
      onClose: function () { task._sseHandle = null; },
    });
  }

  var _VIDEO_MODEL_LABEL = { seedance: "Seedance", "seedance-fast": "Seedance Fast", grok: "Grok", kling: "可灵", sora: "Sora" };
  var _videoModelStatusLoading = false;
  var _videoModelStatusLoadedAt = 0;

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

  /* ---- 片段生成页 ---- */

  function refreshBatchPage() {
    _syncVideoRefs();
    var needVP = $("batchNeedPrompts");
    var ready = $("batchReady");
    if (!project || !project.storyboards || !project.storyboards.length) {
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
        var auditBtn = e.target.closest("[data-action='open-prompt-audit']");
        if (auditBtn) {
          e.preventDefault();
          e.stopPropagation();
          var auditIdx = parseInt(auditBtn.dataset.gidx, 10);
          if (!isNaN(auditIdx)) _openVideoPromptAudit(auditIdx, auditBtn.dataset.shotIndices || "");
          return;
        }
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
        _setBatchRatioValue(ratio, true);
      });
    }

    _syncBatchRatioDefault();
    _syncBatchSwitchDefaults();
    _refreshCurrentVideoModelDisplay();

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

    if (list._batchClipScrollHandler) {
      list.removeEventListener("scroll", list._batchClipScrollHandler);
    }
    list._batchClipScrollHandler = updateThumb;
    list.addEventListener("scroll", updateThumb, { passive: true });
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
	    if (!videoState || !Array.isArray(videoState.tasks)) return null;
	    for (var i = 0; i < videoState.tasks.length; i++) {
	      var task = videoState.tasks[i];
	      if (!task || task._killed) continue;
	      if (task._projectId && project && task._projectId !== project.id) continue;
	      if (task._groupIdx === gIdx) return task;
	    }
    return null;
  }

  async function renderBatchClipList() {
    _syncVideoRefs();
    var list = $("batchClipList");
    if (!list || !project || !project.storyboards) return;
    var seq = ++_batchRenderSeq;
    if (_ctx.swRegion) _ctx.swRegion.show();
    try {
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
      var sbRefUrl = firstFrameImageUrl(t.sb);
      var matchKey = [t.gIdx, sbRefUrl, Array.isArray(t.group && t.group.shotIndices) ? t.group.shotIndices.join(",") : ""].join("|");
      if (!t.sb._matchedRefs || t.sb._matchedRefs._forKey !== matchKey) {
        jobs.push((async function () {
          try {
            var resp = await apiPost('/api/assets/match-references', {
              project: { assets: project.assets },
              group: t.group,
              groupIdx: t.gIdx,
              storyboardImageUrl: sbRefUrl || null,
            });
            t.sb._matchedRefs = resp.refs || [];
            t.sb._matchedRefs._forKey = matchKey;
          } catch (e) {
            console.warn('[BatchClip] match-references failed:', e);
            t.sb._matchedRefs = t.sb._matchedRefs || [];
          }
        })());
	      }
	      await Promise.all(jobs);
	    }));

	    if (seq !== _batchRenderSeq) return;
		    list.innerHTML = "";
		    var liveWrap = $("batchTaskListWrap");
		    var stats = _renderBatchVisualStats(_collectBatchVisualStats(groups));

		    groups.forEach(function (group, gIdx) {
		      var sb = project.storyboards[gIdx] || {};
		      if (!sb.videoPrompt) return;
		      var promptReady = _videoPromptReadinessForGroup(gIdx);
		      var totalDur = _plannedDurForBatchGroup(group);

	      var bcThumbSrc = sb.firstFrameUrl || sb.rawUrl || sb.url || sb.imageUrl || '';

      var charCount = 0, sceneCount = 0;
      var assetRefs = sb._matchedRefs || [];
      assetRefs.forEach(function (r) {
        var role = r.role || r.type;
        if (role === "character") charCount++;
        else if (role === "scene") sceneCount++;
      });

      var vpCache = _vpGetCache(sb);
      var batchSenHits = vpCache.sensitiveHits || [];
	      var groupShotIndicesText = Array.isArray(group.shotIndices) ? group.shotIndices.join(",") : "";

	      var clipTask = _findTaskByGroup(gIdx);
	      // 之前条件是 clipTask && liveWrap.querySelector(...)，但 task 可能被
	      // MAX_TASKS_TOTAL 挤掉而 mirror DOM 还在 —— 这种情况下 clipTask=null
	      // 会让 plan card 又渲一遍，造成「同 groupIdx 两行」。改成纯看 DOM。
	      var hasLiveRow = !!(liveWrap && liveWrap.querySelector('[data-group-idx="' + gIdx + '"]'));
	      if (hasLiveRow) return;

	      var statusLabel = '', statusTone = '', progressPct = 0, remainingText = '—';
		      if (!promptReady.canStart) {
		        statusLabel = promptReady.status === 'generating' ? '提示词生成中' : '提示词失效';
		        statusTone = promptReady.status === 'generating' ? 'is-running' : 'is-failed';
		        progressPct = promptReady.status === 'generating' ? 20 : 0;
		      } else if (clipTask && clipTask.status === 'failed') {
		        statusLabel = '失败'; statusTone = 'is-failed'; progressPct = 0;
	      } else if (clipTask && !isTerminal(clipTask)) {
	        statusLabel = '进行中'; statusTone = 'is-running'; progressPct = _batchTaskProgress(clipTask); remainingText = _batchRemainingText(clipTask);
	      } else if (clipTask && clipTask.status === 'done') {
	        statusLabel = '已完成'; statusTone = 'is-done'; progressPct = 100;
		      } else if (!clipTask && sb.videoUrl && !_hasCurrentVideoForGroup(gIdx)) {
		        statusLabel = '旧视频已过期'; statusTone = 'is-pending'; progressPct = 0;
		      } else if (!clipTask && sb.videoUrl) {
		        statusLabel = '已完成'; statusTone = 'is-done'; progressPct = 100;
	      } else {
	        statusLabel = '未开始'; statusTone = 'is-pending'; progressPct = 0;
	      }
	      var rowDurationText = _formatBatchDuration(sb.videoDurationSec || totalDur);
	      var shotCount = Array.isArray(group.shots) ? group.shots.length : 1;
	      var shotType = (group.shots[0] && group.shots[0].shotType) || 'Clip';
	      var sourceText = sb.videoUrl ? '已有视频结果' : '基于片段设置生成';

	      var card = document.createElement("div");
	      card.className = "batch-segment-row batch-plan-row " + statusTone;

	      card.innerHTML =
	        '<div class="batch-row-info">' +
	          '<div class="batch-row-thumb">' + _batchThumbHtml(bcThumbSrc) + '</div>' +
	          '<div class="batch-row-copy">' +
	            '<h4>' + String(gIdx + 1).padStart(2, '0') + '_片段_' + escapeHtml(shotType) + '</h4>' +
	            '<p>来源：' + escapeHtml(sourceText) + '</p>' +
	          '</div>' +
	        '</div>' +
	        '<div class="batch-row-status">' +
	          '<span class="batch-status-pill ' + statusTone + '"><span class="material-symbols-outlined">' + (statusTone === 'is-done' ? 'check_circle' : statusTone === 'is-running' ? 'motion_photos_auto' : statusTone === 'is-failed' ? 'error' : 'radio_button_checked') + '</span>' + statusLabel + '</span>' +
	          '<div class="batch-row-progress"><i style="width:' + progressPct + '%"></i></div>' +
	          '<em>' + progressPct + '%</em>' +
	        '</div>' +
	        '<div class="batch-row-actions">' +
	        (batchSenHits.length
	          ? '<button type="button" class="batch-row-action batch-row-action-danger" data-action="goto-fix-sensitive" data-gidx="' + gIdx + '" title="点击前往提示词页面修改">' +
	              '<span class="material-symbols-outlined">shield</span>' + batchSenHits.length + ' 个敏感词</button>'
	          : '') +
	          '<button type="button" class="batch-row-icon-action" data-action="open-prompt-audit" data-gidx="' + gIdx + '" data-shot-indices="' + escapeHtml(groupShotIndicesText) + '" title="查看生成规则与检查结果" aria-label="查看生成规则与检查结果">' +
	            '<span class="material-symbols-outlined">article</span>' +
	          '</button>' +
		          (clipTask && !isTerminal(clipTask)
		            ? ''
		            : !promptReady.canStart
		              ? '<button type="button" class="batch-row-action is-disabled" disabled title="' + escapeHtml(_videoPromptNotReadyMessage(gIdx, promptReady)) + '">' +
		                  '<span class="material-symbols-outlined">block</span>不可生成</button>'
		            : '<button type="button" class="batch-row-action batch-row-action-dark" data-action="gen-clip" data-gidx="' + gIdx + '">' +
		                '<span class="material-symbols-outlined">play_arrow</span>' +
	                (clipTask && clipTask.status === 'done' ? '重新生成' : '生成') +
	              '</button>') +
	        '</div>';
	      list.appendChild(card);
		    });
		    _renderBatchVisualStats(stats);
		    syncTaskListVisibility();
		    hydrateProtectedImageElements(list);
    } finally {
      if (seq === _batchRenderSeq && _ctx.swRegion) _ctx.swRegion.hide();
    }
	  }

  function _selectBatchVideoModel(alias) {
    var hidden = $("batchVideoModel");
    if (!hidden) return;
    var allowed = ["seedance", "seedance-fast", "grok", "kling", "sora"];
    if (allowed.indexOf(alias) < 0) alias = "grok";
    hidden.value = alias;
    _renderBatchVideoModelDisplay({
      alias: alias,
      label: _VIDEO_MODEL_LABEL[alias] || alias,
      meta: "当前调用模型",
      status: "ready"
    });
  }

  function _inferCurrentVideoModelAlias(model, provider) {
    var text = ((model || "") + " " + (provider || "")).toLowerCase();
    if (text.indexOf("seedance-fast") >= 0 || (text.indexOf("seedance") >= 0 && text.indexOf("fast") >= 0)) return "seedance-fast";
    if (text.indexOf("seedance") >= 0 || text.indexOf("doubao") >= 0 || text.indexOf("volc") >= 0) return "seedance";
    if (text.indexOf("grok") >= 0 || text.indexOf("xai") >= 0) return "grok";
    if (text.indexOf("kling") >= 0) return "kling";
    if (text.indexOf("sora") >= 0) return "sora";
    return "";
  }

  function _formatVideoModelLabel(status) {
    var model = (status && status.model ? String(status.model) : "").trim();
    var provider = (status && status.provider ? String(status.provider) : "").trim();
    var alias = _inferCurrentVideoModelAlias(model, provider);
    if (alias && _VIDEO_MODEL_LABEL[alias]) return _VIDEO_MODEL_LABEL[alias];
    return model || "当前视频模型";
  }

  function _formatVideoModelMeta(status, label) {
    var parts = [];
    var model = (status && status.model ? String(status.model) : "").trim();
    var source = (status && status.source ? String(status.source) : "").trim();
    if (model && model !== label) parts.push(model);
    if (source === "env") parts.push("平台配置");
    else if (source === "user-settings") parts.push("当前账号配置");
    else if (source) parts.push(source);
    return parts.join(" · ") || "由系统统一调度";
  }

  function _renderBatchVideoModelDisplay(info) {
    var display = $("batchVideoModelDisplay");
    var name = $("batchVideoModelName");
    var meta = $("batchVideoModelMeta");
    if (!display || !name || !meta) return;
    display.dataset.videoModelStatus = info.status || "ready";
    name.textContent = info.label || "当前视频模型";
    meta.textContent = info.meta || "由系统统一调度";
  }

  async function _refreshCurrentVideoModelDisplay(force) {
    var display = $("batchVideoModelDisplay");
    if (!display || _videoModelStatusLoading) return;
    var now = Date.now();
    if (!force && _videoModelStatusLoadedAt && now - _videoModelStatusLoadedAt < 30000) return;

    _videoModelStatusLoading = true;
    _renderBatchVideoModelDisplay({
      label: "读取中…",
      meta: "正在读取当前调用模型",
      status: "loading"
    });
    try {
      var status = await apiPost("/api/settings/test", { slot: "video" });
      var ok = !(status && status.ok === false);
      if (!ok) {
        _renderBatchVideoModelDisplay({
          label: "视频模型未配置",
          meta: (status && (status.hint || status.error)) || "当前后端没有可用视频模型",
          status: "missing"
        });
        _videoModelStatusLoadedAt = Date.now();
        return;
      }
      var label = _formatVideoModelLabel(status);
      var alias = _inferCurrentVideoModelAlias(status && status.model, status && status.provider);
      var hidden = $("batchVideoModel");
      if (hidden && alias) hidden.value = alias;
      _renderBatchVideoModelDisplay({
        alias: alias || _currentVideoModelAlias(),
        label: label,
        meta: _formatVideoModelMeta(status, label),
        status: "ready"
      });
      _videoModelStatusLoadedAt = Date.now();
    } catch (e) {
      var failure = describeVideoModelStatusFailure(e);
      console.warn("[BatchClip] load video model status failed:", {
        path: "/api/settings/test",
        status: (e && e.status) || 0,
        name: (e && e.name) || "",
        reason: failure.reason,
        message: (e && e.message) || ""
      });
      _renderBatchVideoModelDisplay({
        label: failure.label || (_VIDEO_MODEL_LABEL[_currentVideoModelAlias()] || "当前视频模型"),
        meta: failure.meta || "读取模型配置失败，请稍后重试",
        status: failure.status || "missing"
      });
      _videoModelStatusLoadedAt = failure.cache === false ? 0 : Date.now();
    } finally {
      _videoModelStatusLoading = false;
    }
  }

  function _openVideoPromptAudit(gIdx, shotIndicesText) {
    if (!project || !project.id) {
      showToast("请先打开项目");
      return;
    }
    var opts = _getDefaultBatchOpts();
    var params = new URLSearchParams();
    params.set("projectId", project.id);
    params.set("groupIdx", String(gIdx));
    params.set("ratio", opts.ratio || _projectPreferredVideoRatio());
    params.set("quality", opts.quality || "1080p");
    params.set("videoModel", opts.videoModel || _currentVideoModelAlias());
    params.set("genAudio", opts.genAudio ? "1" : "0");
    params.set("watermark", opts.watermark ? "1" : "0");

    var indices = String(shotIndicesText || "").trim();
    if (!indices) {
      var groups = getStoryboardGroups();
      var group = groups[gIdx];
      if (group && Array.isArray(group.shotIndices)) indices = group.shotIndices.join(",");
    }
    if (indices) params.set("shotIndices", indices);

    var url = "/video-prompt-audit.html?" + params.toString();
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      console.warn("[BatchClip] open prompt audit failed:", e);
      showToast("浏览器阻止了新窗口，请允许弹窗后重试", "warn");
    }
  }

  function _currentVideoModelAlias() {
    var el = $("batchVideoModel");
    var v = el ? (el.value || "").trim() : "";
    return v || "grok";
  }

  var _BATCH_RATIO_MAP = { "16:9": true, "9:16": true, "1:1": true, "21:9": true, "4:3": true, "3:4": true };

  function _projectPreferredVideoRatio() {
    var opts = (project && project.styleOptions) || {};
    var sb = (project && project.styleBible) || {};
    var value = opts.aspectRatio || sb.aspectRatio || (project && project.videoAspectRatio) || "9:16";
    value = String(value || "9:16");
    return _BATCH_RATIO_MAP[value] ? value : "9:16";
  }

  function _setBatchRatioValue(ratio, markUser) {
    ratio = _BATCH_RATIO_MAP[ratio] ? ratio : _projectPreferredVideoRatio();
    var input = $("batchRatio");
    var ratioGrid = $("batchRatioGrid");
    if (input) input.value = ratio;
    if (videoState && videoState.form) videoState.form.ratio = ratio;
    if (ratioGrid) {
      if (markUser) ratioGrid.dataset.userTouched = "1";
      ratioGrid.querySelectorAll("button").forEach(function (b) {
        var isActive = b.dataset.ratio === ratio;
        b.className = "py-3 rounded-lg text-xs transition-colors " +
          (isActive ? "border-2 border-primary-fixed-dim bg-surface-container-low text-primary font-bold"
                    : "border border-outline-variant/20 hover:border-primary-fixed-dim text-on-surface-variant font-medium");
      });
    }
  }

  function _syncBatchRatioDefault() {
    var ratioGrid = $("batchRatioGrid");
    var projectId = project && project.id ? String(project.id) : "";
    if (ratioGrid && ratioGrid.dataset.projectId !== projectId) {
      ratioGrid.dataset.projectId = projectId;
      delete ratioGrid.dataset.userTouched;
    }
    var input = $("batchRatio");
    var current = input ? String(input.value || "") : "";
    if (!ratioGrid || !ratioGrid.dataset.userTouched || !_BATCH_RATIO_MAP[current]) {
      _setBatchRatioValue(_projectPreferredVideoRatio(), false);
    }
  }

  function _setBatchSwitchStatus(inputId, checked) {
    var statusEl = document.querySelector(".batch-switch-status[data-for='" + inputId + "']");
    if (!statusEl) return;
    if (inputId === "batchAudio") {
      statusEl.textContent = checked ? "有音频" : "无音频";
    } else if (inputId === "batchWatermark") {
      statusEl.textContent = checked ? "有水印" : "无水印";
    }
  }

  function _syncBatchSwitchDefaults() {
    var projectId = project && project.id ? String(project.id) : "";
    var audio = $("batchAudio");
    var watermark = $("batchWatermark");
    if (audio) {
      if (audio.dataset.projectId !== projectId) {
        audio.dataset.projectId = projectId;
        delete audio.dataset.userTouched;
      }
      if (!audio.dataset.userTouched) audio.checked = true;
      _setBatchSwitchStatus("batchAudio", audio.checked);
    }
    if (watermark) {
      if (watermark.dataset.projectId !== projectId) {
        watermark.dataset.projectId = projectId;
        delete watermark.dataset.userTouched;
      }
      if (!watermark.dataset.userTouched) watermark.checked = false;
      _setBatchSwitchStatus("batchWatermark", watermark.checked);
    }
  }

  function _getDefaultBatchOpts() {
    _syncBatchRatioDefault();
    _syncBatchSwitchDefaults();
    return {
      videoModel: _currentVideoModelAlias(),
      ratio: ($("batchRatio") && $("batchRatio").value) || _projectPreferredVideoRatio(),
      quality: ($("batchQuality") && $("batchQuality").value) || "1080p",
      genAudio: $("batchAudio") ? $("batchAudio").checked : true,
      watermark: $("batchWatermark") ? $("batchWatermark").checked : false,
      autoImport: $("batchAutoImport") ? $("batchAutoImport").checked : true
    };
  }

  function _continuityIgnoredStorageKey() {
    var pid = project && project.id ? project.id : "unknown";
    return "qd_continuity_ignored_" + pid;
  }

  function _loadIgnoredContinuityKeys() {
    try {
      var raw = localStorage.getItem(_continuityIgnoredStorageKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(function (x) { return String(x); }).filter(Boolean) : [];
    } catch (_e) {
      return [];
    }
  }

  function _saveIgnoredContinuityKeys(keys) {
    try {
      var uniq = Array.from(new Set((keys || []).map(function (x) { return String(x); }).filter(Boolean)));
      localStorage.setItem(_continuityIgnoredStorageKey(), JSON.stringify(uniq.slice(-500)));
    } catch (_e) {}
  }

  function _rememberContinuityWarnings(warnings) {
    var keys = (warnings || []).map(function (w) { return w && w.key; }).filter(Boolean);
    if (!keys.length) return;
    _saveIgnoredContinuityKeys(_loadIgnoredContinuityKeys().concat(keys));
  }

  var _CONTINUITY_SEVERITY_COPY = { high: "高", medium: "中", low: "低" };
  var _CONTINUITY_CATEGORY_COPY = {
    scene: "场景",
    character: "角色",
    prop: "道具",
    camera: "镜头",
    other: "其他",
  };

  function _continuityWarningLine(w) {
    var sev = _CONTINUITY_SEVERITY_COPY[w.severity] || "提醒";
    var cat = _CONTINUITY_CATEGORY_COPY[w.category] || "连续性";
    return "【" + sev + " · " + cat + "】片段 " + (Number(w.fromGroupIdx) + 1) +
      " → " + (Number(w.toGroupIdx) + 1) + "：" + (w.title || "相邻镜头可能接不上");
  }

  function _showContinuityWarningModal(warnings, meta) {
    return new Promise(function (resolve) {
      var list = Array.isArray(warnings) ? warnings : [];
      var shown = list.slice(0, 8);
      var extra = Math.max(0, list.length - shown.length);
      var overlay = document.createElement("div");
      overlay.className = "fixed inset-0 z-[9999] bg-black/35 flex items-center justify-center px-4";

      var panel = document.createElement("div");
      panel.className = "w-full max-w-2xl rounded-[28px] bg-white shadow-2xl border border-outline-variant/30 p-6 text-on-surface";

      var title = document.createElement("div");
      title.className = "text-lg font-black tracking-wide";
      title.textContent = "生成前发现相邻镜头可能接不上";
      panel.appendChild(title);

      var desc = document.createElement("div");
      desc.className = "mt-2 text-sm text-on-surface-variant leading-relaxed";
      desc.textContent = "这不是报错，只是提前提醒。你可以返回修改，也可以确认这些变化是故意的并继续生成。";
      panel.appendChild(desc);

      var box = document.createElement("div");
      box.className = "mt-4 max-h-[48vh] overflow-auto space-y-3";
      shown.forEach(function (w) {
        var item = document.createElement("div");
        item.className = "rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4";

        var head = document.createElement("div");
        head.className = "text-sm font-black text-on-surface";
        head.textContent = _continuityWarningLine(w);
        item.appendChild(head);

        if (w.reason) {
          var reason = document.createElement("div");
          reason.className = "mt-2 text-xs text-on-surface-variant leading-relaxed";
          reason.textContent = "原因：" + w.reason;
          item.appendChild(reason);
        }
        if (w.suggestion) {
          var suggestion = document.createElement("div");
          suggestion.className = "mt-1 text-xs text-on-surface-variant leading-relaxed";
          suggestion.textContent = "建议：" + w.suggestion;
          item.appendChild(suggestion);
        }
        box.appendChild(item);
      });
      if (extra > 0) {
        var more = document.createElement("div");
        more.className = "text-xs text-on-surface-variant";
        more.textContent = "还有 " + extra + " 条提醒未展开显示。";
        box.appendChild(more);
      }
      panel.appendChild(box);

      var foot = document.createElement("div");
      foot.className = "mt-5 flex flex-wrap items-center justify-end gap-3";

      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "px-5 py-3 rounded-full border border-outline-variant/40 text-sm font-bold hover:bg-surface-container";
      cancel.textContent = "返回修改";

      var ignore = document.createElement("button");
      ignore.type = "button";
      ignore.className = "px-5 py-3 rounded-full border border-primary-fixed-dim text-sm font-bold hover:bg-surface-container";
      ignore.textContent = "这是故意变化，下次不提醒";

      var cont = document.createElement("button");
      cont.type = "button";
      cont.className = "px-6 py-3 rounded-full bg-ink text-white text-sm font-black hover:opacity-90";
      cont.textContent = (meta && meta.count > 1) ? "继续生成全部" : "继续生成";

      foot.appendChild(cancel);
      foot.appendChild(ignore);
      foot.appendChild(cont);
      panel.appendChild(foot);
      overlay.appendChild(panel);

      var done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key === "Escape") close("cancel");
      }
      cancel.addEventListener("click", function () { close("cancel"); });
      cont.addEventListener("click", function () { close("continue"); });
      ignore.addEventListener("click", function () { close("ignore"); });
      overlay.addEventListener("click", function (ev) {
        if (ev.target === overlay) close("cancel");
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
    });
  }

  async function _runContinuityPreflight(indices, meta) {
    _syncVideoRefs();
    if (!project || !project.id) return true;
    var selected = Array.from(new Set((indices || []).map(function (x) { return Number(x); }).filter(Number.isFinite)));
    if (!selected.length) return true;

    if (meta && meta.hintEl) meta.hintEl.textContent = "正在检查相邻镜头连续性…";

    try {
      var saved = await _flushServerSave();
      if (saved && saved.ok === false && !saved.stale) {
        showToast("项目保存失败，已暂停生成，避免用旧数据检查连续性", "error");
        return false;
      }
      if (saved && saved.stale) _syncVideoRefs();
    } catch (e) {
      console.warn("[continuity] flush before check failed:", e);
      showToast("项目保存失败，已暂停生成，避免用旧数据检查连续性", "error");
      return false;
    }

    var resp;
    try {
      resp = await apiPost("/api/continuity/check-adjacent", {
        projectId: project.id,
        indices: selected,
        ignoredKeys: _loadIgnoredContinuityKeys(),
      });
    } catch (e) {
      console.warn("[continuity] preflight request failed:", e);
      showToast("连续性检查暂时失败，本次先继续生成", "warn");
      return true;
    }

    if (resp && resp.checkFailed) {
      console.warn("[continuity] model check failed:", resp.error || resp);
      showToast("连续性检查暂时失败，本次先继续生成", "warn");
      return true;
    }

    var warnings = resp && Array.isArray(resp.warnings) ? resp.warnings : [];
    if (!warnings.length) return true;

    var decision = await _showContinuityWarningModal(warnings, { count: selected.length });
    if (decision === "ignore") {
      _rememberContinuityWarnings(warnings);
      showToast("已记住这些故意变化，继续生成", "ok");
      return true;
    }
    if (decision === "continue") return true;
    return false;
  }

  async function regenSingleClip(gIdx) {
    if (activeTaskCount() >= MAX_CONCURRENT) { showToast("最多同时运行 " + MAX_CONCURRENT + " 个任务", "warn"); return; }
    if (!_lockVideoGroup(gIdx)) { showToast(_inFlightMessage([gIdx]), "warn"); return; }
    var handedOffLock = false;

    try {
      showToast("正在检查相邻镜头衔接，通过后自动开始生成…", "info");
      var ok = await _runContinuityPreflight([gIdx], { count: 1 });
      if (!ok) return;
      await createWorkflowVideoTask(gIdx, Object.assign({}, _getDefaultBatchOpts(), { _videoGroupLockHeld: true }));
      handedOffLock = true;
      renderBatchClipList();
    } catch (e) {
      showToast("片段 " + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    } finally {
      if (!handedOffLock) _unlockVideoGroup(gIdx);
    }
  }

  /* Phase 2 · 2.6.3：片段生成全权由后端 batch_runner 调度。
   * 前端只发一次 POST /api/batch/start，并订阅 /api/batch/<batchId>/stream
   * 来获取每个分镜的生命周期事件。再也不用前端 plan-batch / 轮询。 */
  var _batchHandle = null;

	  async function startBatchGeneration() {
	    _syncVideoRefs();
	    if (!project || !project.storyboards) return;
	    _setBatchStartDisabled(true);
	    _setBatchGenerateHint("正在同步项目最新状态…");
	    await _reloadProjectFromServerForVideoBatch(null);
	    if (!project || !project.storyboards) {
	      _setBatchStartDisabled(false);
	      return;
	    }
	    _setBatchGenerateHint("");

	    var batchOpts = _getDefaultBatchOpts();
	    var groups = getStoryboardGroups();
	    var indices = [];
	    var allHaveVideo = true; // 所有有 videoPrompt 的 sb 是否都已生成过视频
	    var hasAnyPrompt = false;
	    var shouldClearExistingVideos = false;
	    var blockedPrompts = [];
	    for (var i = 0; i < groups.length; i++) {
	      if (!project.storyboards[i] || !project.storyboards[i].videoPrompt) continue;
	      hasAnyPrompt = true;
	      var readiness = _videoPromptReadinessForGroup(i);
	      if (!readiness.canStart) {
	        blockedPrompts.push({ groupIdx: i, readiness: readiness });
	        continue;
	      }
	      if (_hasCurrentVideoForGroup(i)) continue;
	      allHaveVideo = false;
	      indices.push(i);
	    }
	    if (blockedPrompts.length) {
	      showToast(_videoPromptNotReadyMessage(blockedPrompts[0].groupIdx, blockedPrompts[0].readiness), "warn");
	      _setBatchStartDisabled(false);
	      return;
	    }

    if (!indices.length) {
      if (!hasAnyPrompt) {
        showToast("没有视频提示词，请先去『视频提示词』页生成", "warn");
        _setBatchStartDisabled(false);
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
      if (!redoOk) {
        _setBatchStartDisabled(false);
        return;
      }
      // 先只规划要重跑哪些分镜；真正清除旧视频要等连续性预检通过后再做。
      for (var j = 0; j < groups.length; j++) {
	        if (project.storyboards[j] && project.storyboards[j].videoPrompt && _videoPromptReadinessForGroup(j).canStart) {
	          indices.push(j);
	        }
      }
      shouldClearExistingVideos = true;
    }

	    var lockedBatchGroups = [];
    function releaseBatchLocks(groups) {
      var targetGroups = groups || lockedBatchGroups;
      _unlockVideoGroups(targetGroups);
      if (!groups) lockedBatchGroups = [];
    }

    var lockResult = _lockVideoGroups(indices);
    if (lockResult.skipped.length) showToast(_inFlightMessage(lockResult.skipped), "warn");
    indices = lockResult.locked;
    lockedBatchGroups = lockResult.locked.slice();
    if (!indices.length) {
      _setBatchStartDisabled(false);
      return;
    }

    _setBatchGenerateHint("正在保存项目并做相邻镜头衔接检查（AI 检查，可能需要几十秒）…");
    var preflightOk = await _runContinuityPreflight(indices, { count: indices.length, hintEl: null });
    if (!preflightOk) {
      _setBatchStartDisabled(false);
      releaseBatchLocks();
      return;
    }
    if (shouldClearExistingVideos) {
      indices.forEach(function (j) {
        if (!project.storyboards[j]) return;
        delete project.storyboards[j].videoUrl;
        delete project.storyboards[j]._originVideoUrl;
        delete project.storyboards[j].videoTaskId;
        delete project.storyboards[j].videoCoverUrl;
        delete project.storyboards[j].videoStatus;
	        delete project.storyboards[j].videoMode;
	        delete project.storyboards[j].videoTaskFinishedAt;
	        delete project.storyboards[j].videoDurationSec;
	        delete project.storyboards[j].videoFilename;
	        delete project.storyboards[j].videoDisplayName;
	        delete project.storyboards[j].videoDownloadFilename;
	      });
      try { saveProject(); } catch (_e) {}
      renderBatchClipList();
      showToast("将重新生成 " + indices.length + " 个分镜的视频", "ok");
    }
    if (_batchHandle) { try { _batchHandle.close(); } catch (_e) {} _batchHandle = null; }

    // 为每个分镜插入 UI placeholder（serverTaskId 暂空，等 task_started 回填）
    indices.forEach(function (gIdx) {
      var existing = _findTaskByGroup(gIdx);
      if (existing && !isTerminal(existing)) return;
      var task = createVideoTaskObj("片段 " + (gIdx + 1), false);
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
    _setBatchGenerateHint("正在提交生成任务…");
    try {
      var startResult = await _postVideoBatchStartWithPreflightHandling({
        batchType: "video_segments",
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
      if (startResult && startResult.aborted) {
        _setBatchStartDisabled(false);
        indices.forEach(function (gi) {
          var t = _findTaskByGroup(gi);
          if (!t || isTerminal(t)) return;
          t.status = "failed";
          t.statusCn = "已取消：生成前检查未通过";
          updateTaskCard(t);
        });
        updateBadge();
        releaseBatchLocks();
        return;
      }
      resp = startResult && startResult.resp;
      showConsistencyAggregateWarning(resp);
    } catch (e) {
      _setBatchStartDisabled(false);
      showToast("批量提交失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      releaseBatchLocks();
      return;
    }

    if (!resp || resp.error || !resp.batchId) {
      _setBatchStartDisabled(false);
      var errMsg = (resp && resp.error) || "未能创建批量任务";
      showToast(errMsg, "error");
      releaseBatchLocks();
      return;
    }

    var batchId = resp.batchId;
    _setBatchGenerateHint(""); // 任务已创建，进度交给片段卡片展示

    var totalDone = 0, totalFail = 0, total = indices.length;

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
	      var extra = (data && data.extra) || {};
	      var gi = (typeof extra.groupIdx === "number") ? extra.groupIdx : null;
	      var t = findTaskByServerId(data.taskId) || ensureTaskBound(data.taskId, gi);
	      if (!t) return;
	      _applyVideoNameMeta(t, extra);
	      _applyVideoNameMeta(t, data);
	      var url = data.resultUrl || data.videoUrl || "";
      var gIdx = gi != null ? gi : t._groupIdx;
      if (project && gIdx != null && Array.isArray(project.storyboards)) {
        if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
        if (typeof extra.readyForEdit === "boolean") {
          project.storyboards[gIdx].readyForEdit = extra.readyForEdit; // arch-guard:allow-ready-for-edit 后端 gate 镜像
        }
        if (Array.isArray(extra.videoWarnings)) {
          project.storyboards[gIdx].videoWarnings = extra.videoWarnings;
        }
      }
      if (project && extra.editReadiness && typeof extra.editReadiness === "object") {
        if (!project.editData) project.editData = {};
        project.editData.readiness = extra.editReadiness; // arch-guard:allow-editdata gate 全景镜像（只读）
      }
      if (url) {
        _mergeVideoWarnings(t, extra, false);
        var protectedUrl = (extra && extra.protectedUrl) || _protectedVideoUrlFrom(url);
        t.videoUrl = url;
        t.protectedUrl = protectedUrl;
        if (project && t._groupIdx != null && Array.isArray(project.storyboards)) {
          _markGroupVideoCurrent(t._groupIdx, url, {
	            protectedUrl: protectedUrl,
	            taskId: data && data.taskId,
	            filename: extra && extra.filename,
	            displayName: extra && extra.displayName,
	            downloadFilename: extra && extra.downloadFilename,
	            durationSec: extra && extra.durationSec,
            plannedDurationSec: extra && extra.plannedDurationSec,
            readyForEdit: extra && extra.readyForEdit,
            videoWarnings: extra && extra.videoWarnings,
          });
        }
        videoPipeline(t).then(function () { updateBadge(); renderBatchClipList(); }).finally(function () { _unlockVideoGroup(gIdx); });
      } else {
        t.status = "failed"; t.statusCn = "生成完成但无视频地址";
        updateTaskCard(t); updateBadge();
        _unlockVideoGroup(gIdx);
      }
    }

    function handleTaskFailed(data) {
      if (data && data.taskId) {
        if (_seenFailed[data.taskId] || _seenDone[data.taskId]) return;
        _seenFailed[data.taskId] = true;
      }
      totalFail++;
      var t = findTaskByServerId(data.taskId);
      if (!t) return;
      t.status = "failed";
      t.statusCn = _videoFailureStatusText(data, data.reason || data.errorMsg || "failed");
      updateTaskCard(t); updateBadge();
      renderBatchClipList();
      _unlockVideoGroup(t._groupIdx);
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
	        if (isTerminalBatchStatus(snap.status)) {
	          _stopPoll();
	          _setBatchStartDisabled(false);
	          releaseBatchLocks();
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
        _applyVideoTaskProgress(t, data);
      },
      onTaskCompleted: handleTaskCompleted,
      onTaskFailed: handleTaskFailed,
      onBatchCompleted: function () {
        _stopPoll();
        _setBatchStartDisabled(false);
        releaseBatchLocks();
      },
      onClose: function () {
        _batchHandle = null;
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
      downloadVideoTask(task, btn);
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
        if (project.storyboards[oldTask._groupIdx]._originVideoUrl) {
          delete project.storyboards[oldTask._groupIdx]._originVideoUrl;
        }
        if (project.storyboards[oldTask._groupIdx].videoTaskId) {
          delete project.storyboards[oldTask._groupIdx].videoTaskId;
        }
        await createWorkflowVideoTask(oldTask._groupIdx, _getDefaultBatchOpts());
        // 新任务已提交，移除这条旧的失败任务（保留镜像行供新任务复用），
        // 否则残留的失败任务会让「异常/已完成」计数算错。
        try {
          var _oi = videoState.tasks.indexOf(oldTask);
          if (_oi >= 0) {
            oldTask._killed = true;
            if (oldTask._sseHandle) { try { oldTask._sseHandle.close(); } catch (_e) {} oldTask._sseHandle = null; }
            if (oldTask.cardEl && oldTask.cardEl.parentNode) oldTask.cardEl.parentNode.removeChild(oldTask.cardEl);
            videoState.tasks.splice(_oi, 1);
          }
        } catch (_e) {}
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
	      _downloadBlob(blob, _videoTaskDownloadName(task));
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

  // 视频完成后让生成耗时估算重新拉取（侧栏历史视频已下线）。
  function appendOutputHistory(url, taskId) {
    if (!url || url === "#") return;
    _videoGenerationEstimate.fetchedAt = 0;
  }

  /* Close dropdowns on outside click */
  document.addEventListener("click", function () {
    [["panelRatio", "btnRatio"], ["panelDur", "btnDur"]].forEach(function (pair) {
      var p = $(pair[0]), b = $(pair[1]);
      if (p && !p.hidden) { p.hidden = true; if (b) b.classList.remove("is-open"); }
    });
  });


export {
  _restoreVideoTasks,
  reconcileVideoTasksOnWake,
  refreshBatchPage,
  startBatchGeneration,
  importAllGeneratedSegments,
  confirmSegmentsAndEnterEdit,
  _initBatchPlayerEvents,
  handleVideoTaskAction,
  syncTaskListVisibility,
  updateBadge,
  createWorkflowVideoTask,
  activeTaskCount,
};
