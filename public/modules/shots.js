import { $, escapeHtml, showToast, apiPost, apiGet, getAuthHeaders, stripStepTags } from './utils.js?v=300';
import { subscribeBatch } from './backend_stream.js?v=300';
import { segmentInfoForShot } from './frameRecommendations.js?v=1';
import {
  ANGLES,
  CAMERA_MOVES,
  COMPOSITION_PRESETS,
  FOCUS_OPTIONS,
  LENSES,
  LIGHT_PRESETS,
  SHOT_TYPES,
  deriveFocus,
  legacyShotTypeToAngle,
  normalizeAngle,
  normalizeCamera,
  normalizeComposition,
  normalizeFocus,
  normalizeLens,
  normalizeLight,
  normalizeShotType,
} from './shotSchema.js?v=300';

let _ctx = {};
let project = null;

export { ANGLES, CAMERA_MOVES, COMPOSITION_PRESETS, FOCUS_OPTIONS, LENSES, LIGHT_PRESETS, SHOT_TYPES };
// 时长下拉选项: 产品收敛到 1-7 秒。短镜头允许存在, 视频生成阶段会通过片段合并
// 保证模型下限; 这是镜头页和提示词页共用的单一数据源 (_buildDurationOptions
// export 出去给 videoPrompts.js 使用), 改这一处两个页面同步生效。
const SHOT_DURATION_OPTIONS = [1,2,3,4,5,6,7];
const SHOT_PACE_OPTIONS = [
  { value: "slow", label: "慢" },
  { value: "normal", label: "正常" },
  { value: "fast", label: "快" },
  { value: "fast_forward", label: "快进" },
];

var _shotParaMap = {};
var _scriptParas = [];
var _shotHoverBound = false;
// 镜头参数 chip 折叠态: key = shotIdx, true = 展开全部(否则只显示前四)。按 shotIdx 记忆,
// 局部 toggle 不走整卡 re-render, 改 dropdown 等 re-render 后也能保持展开/收起状态。
var _shotSpecsExpanded = {};

export function initShots(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncShotsProject(p) {
  project = p || null;
  _shotHoverBound = false;
  _syncShotsProgressBanner();
}

function _syncRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function flushServerSave() { if (_ctx.flushServerSave) return _ctx.flushServerSave(); return saveProject(); }
function _safeWriteBack(id, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(id, fn, serverVersion) : false; }
function switchPage(p) { if (_ctx.switchPage) _ctx.switchPage(p); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function _markDownstreamStale(scope, detail) { if (_ctx.markDownstreamStale) _ctx.markDownstreamStale(scope, detail); }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function emotionBadgeHtml(emotion, intensity) { return _ctx.emotionBadgeHtml ? _ctx.emotionBadgeHtml(emotion, intensity) : ''; }

// 反查某镜头所属"片段(段)"序号：在 project.storyboards[g].shotIndices 里找含 shotIdx 的段。
// 合并模式下多个镜头同属一段；1:1 / flag OFF 时片段号即镜头号。
function _segmentNoForShot(shotIdx) {
  return segmentInfoForShot(project, shotIdx).groupNo;
}

function _shotStoryboardInitialSlotHtml(shotIdx) {
  var hasStoryboardPlan = !!(project && Array.isArray(project.storyboards) && project.storyboards.length);
  var info = segmentInfoForShot(project, shotIdx);
  var text;
  if (!hasStoryboardPlan) {
    text = '等待镜头计划确认';
  } else if (info.isSegmentFirst) {
    text = '片段 ' + info.groupNo + ' 首帧将在这里管理';
  } else {
    text = '并入片段 ' + info.groupNo + '，首帧在镜头 ' + String(info.anchorShotNo).padStart(2, '0') + ' 管理，无需单独出图';
  }
  return '<div class="shot-storyboard-slot-empty">' +
    '<span class="material-symbols-outlined">image</span>' +
    '<p>' + escapeHtml(text) + '</p>' +
  '</div>';
}

function _applyShotPlanServerProjectSnapshot(proj, snap) {
  if (!proj || !snap) return;
  [
	    "shots",
	    "planMeta",
	    "shotsApproved",
    "storyboards",
    "videoTasks",
    "currentStep",
    "frameWorkflowSchemaVersion",
    "_staleFlags",
    "shotPlanStatus",
    "shotPlanSourceHash",
    "shotPlanSourceSnapshot",
    "shotPlanStaleReasons",
    "shotPlanStaleAt",
    "shotPlanGeneratedAt",
    "shotPlanLastBatchId",
    "shotPlanBatchId",
    "shotPlanLastError",
    "shotPlanFailedAt",
    "shotPlanLastConfirmedAt",
    "shotPlanLastConfirmedHash",
    "shotsManuallyEditedAt",
    "legacyShotPlanArchive",
  ].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(snap, key)) proj[key] = snap[key];
  });
}

function _shotPlanStatusLabel(status) {
  if (status === "generating") return "生成中";
  if (status === "failed") return "生成失败";
  if (status === "stale") return "上游已变化";
  if (status === "legacy_unknown") return "旧版镜头计划";
  if (status === "ready") return "已就绪";
  return "";
}

function _shotPlanReasonLabel(reason) {
  var map = {
    script_changed: "剧本",
    style_bible_changed: "风格圣经",
    assets_changed: "资产库",
    duration_changed: "时长",
    emotion_changed: "情绪节奏",
    world_changed: "世界观",
    upstream_changed_during_generation: "生成中上游变化",
    manual_shot_edit: "手动编辑",
    legacy_unknown: "旧版镜头计划",
    unknown: "未知变化",
  };
  return map[reason] || reason || "上游变化";
}

export function _shotPlanChangeSubject(reasons) {
  reasons = Array.isArray(reasons) ? reasons : [];
  var labels = [];
  reasons.forEach(function (reason) {
    if (reason === "upstream_changed_during_generation") return;
    var label = _shotPlanReasonLabel(reason);
    if (label && labels.indexOf(label) < 0) labels.push(label);
  });
  if (labels.length) return labels.join("、");
  if (reasons.indexOf("upstream_changed_during_generation") >= 0) return "生成期间的上游内容";
  return "";
}

function _hasAnyAssetData() {
  if (!project || !project.assets) return false;
  var assets = project.assets;
  return !!(
    (Array.isArray(assets.characters) && assets.characters.length) ||
    (Array.isArray(assets.scenes) && assets.scenes.length) ||
    (Array.isArray(assets.props) && assets.props.length)
  );
}

function _hasAnyShots() {
  return !!(project && Array.isArray(project.shots) && project.shots.length);
}

function _getShotPlanActionState() {
  var hasShots = _hasAnyShots();
  var status = (project && project.shotPlanStatus) || "";
  var hasShotPlanFlag = !!(project && project._staleFlags && project._staleFlags.shotPlan);
  var reasons = project && Array.isArray(project.shotPlanStaleReasons) ? project.shotPlanStaleReasons : [];
  var reasonText = reasons.length ? "上游变化：" + reasons.map(_shotPlanReasonLabel).join("、") : "";

  if (!project || !_hasAnyAssetData()) {
    return {
      label: "生成镜头计划",
      disabled: true,
      hint: "请先完成资产分析",
    };
  }
  if (status === "generating") {
    return {
      label: "镜头计划生成中…",
      disabled: true,
      hint: "后台正在生成镜头计划，请稍候。",
    };
  }
  if (status === "failed") {
    return {
      label: "重新生成镜头计划",
      disabled: false,
      hint: project.shotPlanLastError ? ("上次生成失败：" + String(project.shotPlanLastError).slice(0, 60)) : "上次生成失败，请重新生成。",
    };
  }
  if (status === "stale" || (hasShots && hasShotPlanFlag)) {
    var subject = _shotPlanChangeSubject(reasons);
    return {
      label: "重新生成镜头计划",
      disabled: false,
      hint: subject ? (subject + "已变化，建议重新生成镜头计划。") : (reasonText || "镜头计划依赖已变化，建议重新生成镜头计划。"),
    };
  }
  if (status === "legacy_unknown") {
    return {
      label: "重新生成镜头计划",
      disabled: false,
      hint: "旧版镜头计划，建议确认仍可用或重新生成。",
    };
  }
  if (hasShots) {
    return {
      label: "重新生成镜头计划",
      disabled: false,
      hint: "",
    };
  }
  return {
    label: "生成镜头计划",
    disabled: false,
    hint: "根据剧本、风格和资产生成镜头计划。",
  };
}

function _refreshShotPlanActionState(override) {
  var btn = $("btnGenShots");
  var emptyBtn = $("btnGenShotsEmpty");
  var hint = $("shotsHint");
  var state = override || _getShotPlanActionState();
  if (btn) {
    btn.innerHTML =
      '<span class="shots-step-number">I</span>' +
      '<span>' + escapeHtml(state.label || "") + '</span>';
    btn.disabled = !!state.disabled;
  }
  if (emptyBtn) {
    emptyBtn.textContent = state.label || "生成镜头计划";
    emptyBtn.disabled = !!state.disabled;
  }
  if (hint) hint.textContent = state.hint || "";
}

async function confirmShotPlanStillValid() {
  _syncRefs();
  if (!project || !project.id) return;
  try {
    var p = await apiPost("/api/projects/" + encodeURIComponent(project.id) + "/shot-plan/confirm", {});
    _safeWriteBack(project.id, function (proj) {
      _applyShotPlanServerProjectSnapshot(proj, p);
    });
    showToast("已确认当前镜头计划仍可用", "success");
    _refreshShotPlanActionState();
    renderShotList();
  } catch (e) {
    var msg = ((e && e.message) || e || "确认失败").toString();
    showToast("确认镜头计划失败：" + _diagnoseApiError(msg), "error");
  }
}

function _scrollToStoryboardWorkbench() {
  window.setTimeout(function () {
    var target = document.querySelector(".shots-storyboard-shell") || $("imagesReady");
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 80);
}

function _hasMeaningfulValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(_hasMeaningfulValue);
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function _singleShotSlot(idx, src) {
  var slot = Object.assign({}, src || {});
  slot.idx = idx;
  slot.shotIdx = idx + 1;
  slot.shotIndices = [idx];
  if (slot.frames && typeof slot.frames === "object") {
    slot.frames = Object.assign({}, slot.frames);
    if (slot.frames.first && typeof slot.frames.first === "object") {
      slot.frames.first = Object.assign({}, slot.frames.first, { shotIndices: [idx] });
    }
    if (slot.frames.tail && typeof slot.frames.tail === "object") {
      slot.frames.tail = Object.assign({}, slot.frames.tail, { shotIndices: [idx] });
    }
  }
  return slot;
}

function _makeSingleShotStoryboards(shots) {
  return (Array.isArray(shots) ? shots : []).map(function (_, idx) { return _singleShotSlot(idx, null); });
}

function _archiveStoryboardSlot(oldGroupIdx, sb, vt, reason) {
  if (!_hasMeaningfulValue(sb) && !_hasMeaningfulValue(vt)) return;
  if (!Array.isArray(project.legacyStoryboardArchive)) project.legacyStoryboardArchive = [];
  project.legacyStoryboardArchive.push({
    oldGroupIdx: oldGroupIdx,
    oldShotIndices: Array.isArray(sb && sb.shotIndices) ? sb.shotIndices.slice() : [],
    storyboard: _hasMeaningfulValue(sb) ? sb : undefined,
    videoTask: _hasMeaningfulValue(vt) ? vt : undefined,
    archivedAt: new Date().toISOString(),
    archiveReason: reason || "shot_structure_change",
  });
  project.legacyStoryboardArchiveLastMigratedAt = new Date().toISOString();
  project.legacyStoryboardArchiveLastCount = 1;
}

function _remapEditDataAfterShotDelete(deletedIdx) {
  if (!project || !project.editData || typeof project.editData !== "object") return;
  var touched = false;
  var timelineArchive = null;
  var edl = project.editData.edl;
  if (edl && Array.isArray(edl.timeline)) {
    var oldTimeline = edl.timeline;
    var nextTimeline = [];
    var dropped = 0;
    oldTimeline.forEach(function (entry) {
      var oldGroupIdx = Number(entry && entry.groupIdx);
      if (!Number.isInteger(oldGroupIdx)) {
        nextTimeline.push(entry);
      } else if (oldGroupIdx === deletedIdx) {
        dropped++;
      } else {
        var nextGroupIdx = oldGroupIdx > deletedIdx ? oldGroupIdx - 1 : oldGroupIdx;
        nextTimeline.push(Object.assign({}, entry, { groupIdx: nextGroupIdx }));
        if (nextGroupIdx !== oldGroupIdx) touched = true;
      }
    });
    if (dropped || nextTimeline.length !== oldTimeline.length) {
      touched = true;
      timelineArchive = timelineArchive || {};
      timelineArchive.edl = edl;
      timelineArchive.droppedTimelineCount = dropped;
      project.editData.edl = Object.assign({}, edl, {
        timeline: nextTimeline,
        version: (Number(edl.version) || 0) + 1,
      });
    }
  }
  var tags = project.editData.segmentTags;
  if (tags && Array.isArray(tags.segments)) {
    var oldSegments = tags.segments;
    var nextSegments = [];
    var droppedTags = 0;
    oldSegments.forEach(function (seg) {
      var oldGroupIdx = Number(seg && seg.groupIdx);
      if (!Number.isInteger(oldGroupIdx)) {
        nextSegments.push(seg);
      } else if (oldGroupIdx === deletedIdx) {
        droppedTags++;
      } else {
        var nextGroupIdx = oldGroupIdx > deletedIdx ? oldGroupIdx - 1 : oldGroupIdx;
        nextSegments.push(Object.assign({}, seg, { groupIdx: nextGroupIdx }));
        if (nextGroupIdx !== oldGroupIdx) touched = true;
      }
    });
    if (droppedTags || nextSegments.length !== oldSegments.length) {
      touched = true;
      timelineArchive = timelineArchive || {};
      timelineArchive.segmentTags = tags;
      timelineArchive.droppedSegmentTagCount = droppedTags;
      project.editData.segmentTags = Object.assign({}, tags, { segments: nextSegments });
    }
  }
  if (touched) {
    project.editData.version = (Number(project.editData.version) || 0) + 1;
    if (timelineArchive) {
      if (!Array.isArray(project.legacyTimelineArchive)) project.legacyTimelineArchive = [];
      project.legacyTimelineArchive.push(Object.assign({}, timelineArchive, {
        archivedAt: new Date().toISOString(),
        archiveReason: "shot_deleted",
      }));
    }
  }
}

function _remapEditDataAfterShotInsert(insertIdx) {
  if (!project || !project.editData || typeof project.editData !== "object") return;
  var touched = false;
  var edl = project.editData.edl;
  if (edl && Array.isArray(edl.timeline)) {
    var nextTimeline = edl.timeline.map(function (entry) {
      var oldGroupIdx = Number(entry && entry.groupIdx);
      if (!Number.isInteger(oldGroupIdx) || oldGroupIdx < insertIdx) return entry;
      touched = true;
      return Object.assign({}, entry, { groupIdx: oldGroupIdx + 1 });
    });
    if (touched) {
      project.editData.edl = Object.assign({}, edl, {
        timeline: nextTimeline,
        version: (Number(edl.version) || 0) + 1,
      });
    }
  }
  var tags = project.editData.segmentTags;
  if (tags && Array.isArray(tags.segments)) {
    var tagTouched = false;
    var nextSegments = tags.segments.map(function (seg) {
      var oldGroupIdx = Number(seg && seg.groupIdx);
      if (!Number.isInteger(oldGroupIdx) || oldGroupIdx < insertIdx) return seg;
      tagTouched = true;
      return Object.assign({}, seg, { groupIdx: oldGroupIdx + 1 });
    });
    if (tagTouched) {
      touched = true;
      project.editData.segmentTags = Object.assign({}, tags, { segments: nextSegments });
    }
  }
  if (touched) project.editData.version = (Number(project.editData.version) || 0) + 1;
}

export function _syncSingleShotSlotsAfterDelete(deletedIdx) {
  _syncRefs();
  if (!project) return;
  var oldStoryboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  var oldVideoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  _archiveStoryboardSlot(deletedIdx, oldStoryboards[deletedIdx], oldVideoTasks[deletedIdx], "shot_deleted");

  var nextStoryboards = [];
  var nextVideoTasks = [];
  var shotCount = Array.isArray(project.shots) ? project.shots.length : 0;
  for (var idx = 0; idx < shotCount; idx++) {
    var oldIdx = idx < deletedIdx ? idx : idx + 1;
    nextStoryboards[idx] = _singleShotSlot(idx, oldStoryboards[oldIdx]);
    if (_hasMeaningfulValue(oldVideoTasks[oldIdx])) {
      nextVideoTasks[idx] = Object.assign({}, oldVideoTasks[oldIdx], { groupIdx: idx });
    }
  }
  for (var extraIdx = shotCount + 1; extraIdx < Math.max(oldStoryboards.length, oldVideoTasks.length); extraIdx++) {
    _archiveStoryboardSlot(extraIdx, oldStoryboards[extraIdx], oldVideoTasks[extraIdx], "shot_deleted:orphan_after_shift");
  }
  project.storyboards = nextStoryboards;
  project.videoTasks = nextVideoTasks;
  project.frameWorkflowSchemaVersion = 3;
  _remapEditDataAfterShotDelete(deletedIdx);
}

export function _syncSingleShotSlotsAfterInsert(insertIdx) {
  _syncRefs();
  if (!project) return;
  var oldStoryboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  var oldVideoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  var shotCount = Array.isArray(project.shots) ? project.shots.length : 0;
  var nextStoryboards = [];
  var nextVideoTasks = [];
  for (var idx = 0; idx < shotCount; idx++) {
    if (idx === insertIdx) {
      nextStoryboards[idx] = _singleShotSlot(idx, null);
      continue;
    }
    var oldIdx = idx < insertIdx ? idx : idx - 1;
    nextStoryboards[idx] = _singleShotSlot(idx, oldStoryboards[oldIdx]);
    if (_hasMeaningfulValue(oldVideoTasks[oldIdx])) {
      nextVideoTasks[idx] = Object.assign({}, oldVideoTasks[oldIdx], { groupIdx: idx });
    }
  }
  project.storyboards = nextStoryboards;
  project.videoTasks = nextVideoTasks;
  project.frameWorkflowSchemaVersion = 3;
  _remapEditDataAfterShotInsert(insertIdx);
}

/* ================================================================
   Shots page
   ================================================================ */
export function refreshShotsPage() {
  _syncRefs();
  _syncShotsProgressBanner();
  var needScript = $("shotsNeedScript");
  var needPlan = $("shotsNeedPlan");
  var ready = $("shotsReady");
  var topActions = $("shotsTopActions");
  var hasAssets = !!(project && _hasAnyAssetData());
  var hasShots = _hasAnyShots();
  var isGenerating = !!(project && project.shotPlanStatus === "generating");
  if (!hasAssets) {
    if (needScript) needScript.hidden = false;
    if (needPlan) needPlan.hidden = true;
    if (ready) ready.hidden = true;
    if (topActions) topActions.hidden = true;
    var actionBar = $("imagesActionBar");
    if (actionBar) actionBar.hidden = true;
    var wrap = $("shotListWrap");
    if (wrap) wrap.innerHTML = "";
    _hideScriptRefPanel();
    var ca = $("shotsConfirmArea");
    if (ca) ca.hidden = true;
    _refreshShotPlanActionState();
    return;
  }
  if (needScript) needScript.hidden = true;
  if (hasAssets && !hasShots && !isGenerating) {
    if (needPlan) needPlan.hidden = false;
    if (ready) ready.hidden = true;
    if (topActions) topActions.hidden = true;
    var emptyActionBar = $("imagesActionBar");
    if (emptyActionBar) emptyActionBar.hidden = true;
    var emptyWrap = $("shotListWrap");
    if (emptyWrap) emptyWrap.innerHTML = "";
    _hideScriptRefPanel();
    var emptyConfirm = $("shotsConfirmArea");
    if (emptyConfirm) emptyConfirm.hidden = true;
    _refreshShotPlanActionState();
    return;
  }
  if (needPlan) needPlan.hidden = true;
  if (ready) ready.hidden = false;
  if (topActions) topActions.hidden = !hasShots;
  _refreshShotPlanActionState();
  renderShotList();
}

export function _buildSelectOptions(options, current) {
  var html = '<option value="">—</option>';
  var matched = false;
  options.forEach(function (opt) {
    var sel = (current === opt) ? ' selected' : '';
    if (current === opt) matched = true;
    html += '<option value="' + escapeHtml(opt) + '"' + sel + '>' + escapeHtml(opt) + '</option>';
  });
  if (current && !matched) {
    html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
  }
  return html;
}

function _normalizeShotDuration(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) n = 4;
  // clamp 跟 SHOT_DURATION_OPTIONS 同步: 1-7 秒。旧项目里 < 1 / > 7 的镜头打开时会被
  // normalize 到边界, 写回时也按新范围保存, 等同于一次平滑迁移。
  return Math.max(1, Math.min(7, Math.round(n)));
}

function _normalizeShotPace(value) {
  var raw = String(value || "").trim();
  var map = {
    "慢": "slow",
    "慢节奏": "slow",
    "舒缓": "slow",
    "正常": "normal",
    "平稳": "normal",
    "标准": "normal",
    "快": "fast",
    "快节奏": "fast",
    "紧凑": "fast",
    "快进": "fast_forward",
    "快速推进": "fast_forward",
    "fast-forward": "fast_forward",
  };
  raw = map[raw] || raw;
  return SHOT_PACE_OPTIONS.some(function (item) { return item.value === raw; }) ? raw : "normal";
}

export function _buildDurationOptions(current) {
  var cur = _normalizeShotDuration(current);
  return SHOT_DURATION_OPTIONS.map(function (sec) {
    return '<option value="' + sec + '"' + (sec === cur ? ' selected' : '') + '>' + sec + '秒</option>';
  }).join('');
}

export function _buildPaceOptions(current) {
  var cur = _normalizeShotPace(current);
  return SHOT_PACE_OPTIONS.map(function (item) {
    return '<option value="' + escapeHtml(item.value) + '"' + (item.value === cur ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
  }).join('');
}

export function _shotFieldValue(field, value) {
  if (field === "duration") return _normalizeShotDuration(value);
  if (field === "pace") return _normalizeShotPace(value);
  if (field === "shotType") return normalizeShotType(value);
  if (field === "angle") return normalizeAngle(value);
  if (field === "lens") return normalizeLens(value);
  if (field === "focus") return normalizeFocus(value);
  if (field === "light") return normalizeLight(value);
  if (field === "composition") return normalizeComposition(value);
  if (field === "camera") return normalizeCamera(value);
  return String(value == null ? "" : value).trim();
}

export function _shotFieldCurrent(shot, field) {
  if (field === "duration") return _normalizeShotDuration(shot.duration ?? shot.durationSec);
  if (field === "pace") return _normalizeShotPace(shot.pace || shot.narrativePace);
  if (field === "shotType") {
    var migratedAngle = legacyShotTypeToAngle(shot.shotType);
    return normalizeShotType(migratedAngle ? shot.framing : (shot.shotType || shot.framing));
  }
  if (field === "angle") return normalizeAngle(shot.angle || shot.viewpoint || legacyShotTypeToAngle(shot.shotType));
  if (field === "lens") return normalizeLens(shot.lens || shot.focalLength || shot.focal);
  if (field === "focus") {
    return normalizeFocus(
      shot.focus || shot.depthOfField || shot.dof,
      deriveFocus(_shotFieldCurrent(shot, "lens"), _shotFieldCurrent(shot, "shotType")),
    );
  }
  if (field === "light") return normalizeLight(shot.light || shot.lighting);
  if (field === "composition") return normalizeComposition(shot.composition || shot.compositionalRule);
  if (field === "camera") return normalizeCamera(shot.camera || shot.movement);
  return String(shot[field] == null ? "" : shot[field]).trim();
}

export function _applyShotFieldValue(shot, field, value) {
  if (field === "duration") {
    shot.duration = value;
    shot.durationSec = value;
    return;
  }
  if (field === "pace") {
    shot.pace = value;
    return;
  }
  if (field === "shotType") {
    shot.shotType = value;
    shot.framing = value;
    return;
  }
  if (field === "camera") {
    shot.camera = value;
    shot.movement = value;
    return;
  }
  if (field === "lens") {
    shot.lens = value;
    if (!shot.focus) shot.focus = deriveFocus(value, _shotFieldCurrent(shot, "shotType"));
    return;
  }
  if (field === "angle" || field === "focus" || field === "light" || field === "composition") {
    shot[field] = value;
    return;
  }
  shot[field] = value;
}

function _updateShotSummaryMeta() {
  var summaryMeta = $("shotSummaryMeta");
  if (!summaryMeta) return;
  if (!project || !Array.isArray(project.shots) || !project.shots.length) {
    summaryMeta.textContent = "";
    return;
  }
  var totalSec = 0;
  project.shots.forEach(function (s) { totalSec += _normalizeShotDuration(s.duration ?? s.durationSec); });
  summaryMeta.textContent = "共 " + project.shots.length + " 个镜头 · " + totalSec + " 秒";
}

function _hideScriptRefPanel() {
  var colWrap = $("scriptRefColWrap");
  var panel = $("scriptRefPanel");
  if (panel) {
    panel.innerHTML = "";
    panel.textContent = "";
  }
  if (colWrap) colWrap.hidden = true;
  _scriptParas = [];
  _shotParaMap = {};
}

/* 注：重渲染滚动跳变（整重建 → 高度塌缩 → scrollY 被钳 → "跳回镜头 2"）
 * 的防护已收口到全局守卫 modules/scroll_anchor_guard.js（main.js 初始化），
 * 覆盖 renderShotList / renderImageGrid / SSE 回调等所有重建路径，
 * 本模块不再做局部锚定。 */

export function renderShotList() {
  _syncRefs();
  _syncShotsProgressBanner();
  var wrap = $("shotListWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!project || !project.shots || !project.shots.length) {
    var emptySummaryMeta = $("shotSummaryMeta");
    if (emptySummaryMeta) emptySummaryMeta.textContent = "";
    _hideScriptRefPanel();
    var ca = $("shotsConfirmArea"); if (ca) ca.hidden = true;
    var emptyActionBar = $("imagesActionBar"); if (emptyActionBar) emptyActionBar.hidden = true;
    var emptyTopActions = $("shotsTopActions"); if (emptyTopActions && !(project && project.shotPlanStatus === "generating")) emptyTopActions.hidden = true;
    var emptyNeedPlan = $("shotsNeedPlan");
    var emptyReady = $("shotsReady");
    if (project && _hasAnyAssetData()) {
      if (project.shotPlanStatus === "generating") {
        if (emptyNeedPlan) emptyNeedPlan.hidden = true;
        if (emptyReady) emptyReady.hidden = false;
      } else {
        if (emptyNeedPlan) emptyNeedPlan.hidden = false;
        if (emptyReady) emptyReady.hidden = true;
      }
    }
    _refreshShotPlanActionState();
    return;
  }
  var needPlan = $("shotsNeedPlan"); if (needPlan) needPlan.hidden = true;
  var ready = $("shotsReady"); if (ready) ready.hidden = false;
  var topActions = $("shotsTopActions"); if (topActions) topActions.hidden = false;
  _refreshShotPlanActionState();
  var actionBar = $("imagesActionBar"); if (actionBar) actionBar.hidden = false;

  var shotPlanStatus = project.shotPlanStatus || "";
  var shotPlanNeedsAttention = shotPlanStatus !== "generating" && (
    shotPlanStatus === "stale" || shotPlanStatus === "legacy_unknown" || shotPlanStatus === "failed" || (project._staleFlags && project._staleFlags.shotPlan)
  );
  if (shotPlanNeedsAttention) {
    var spb = document.createElement("div");
    // 注：此前用 mx-8 给 banner 左右各留 32px 边距，导致 banner 比下方 shot card 卡片窄。
    // 用户反馈：banner 左右边界应与镜头卡片对齐，去掉 mx-8 让 banner 撑满 wrap 容器宽度。
    spb.className = "upstream-stale-banner";
    var reasons = Array.isArray(project.shotPlanStaleReasons) ? project.shotPlanStaleReasons : [];
    var subject = _shotPlanChangeSubject(reasons);
    var reasonText = reasons.length ? "变化来源：" + reasons.map(_shotPlanReasonLabel).join("、") : "";
    var message = "";
    if (shotPlanStatus === "failed") {
      message = "镜头计划生成失败，请重新生成。";
    } else if (shotPlanStatus === "legacy_unknown") {
      message = "当前镜头计划来自旧版本，建议校验后继续或重新生成。";
    } else {
      message = subject
        ? subject + "已变化，当前镜头计划可能不是最新版本。"
        : "镜头计划依赖已变化，当前镜头计划可能不是最新版本。";
    }
    // 注：此前在 banner 右侧渲染 "确认仍可用" 和 "重新生成镜头计划" 两个 pill 按钮。
    // 用户反馈：banner 仅作提示用，相应的操作通过顶部"重新生成镜头计划"主按钮触发，
    // banner 内不再放重复按钮。confirm-shot-plan-valid / regen-shot-plan 两个 action
    // 仍由 handleShotAction 路由器保留（_getShotPlanActionState 与其他入口可能仍调用）。
    spb.innerHTML =
      '<span class="material-symbols-outlined">warning</span>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="font-semibold">' + escapeHtml(_shotPlanStatusLabel(shotPlanStatus) || "镜头计划需校验") + '</div>' +
        '<div class="text-xs opacity-75">' + escapeHtml(message + (reasonText ? " " + reasonText : "")) + '</div>' +
      '</div>';
    wrap.appendChild(spb);
  }


  _updateShotSummaryMeta();

  project.shots.forEach(function (shot, idx) {
    var segmentInfo = segmentInfoForShot(project, idx);
    var card = document.createElement("div");
    card.className = "sc-card shot-workbench-card group";
    card.dataset.shotIdx = idx;

    card.innerHTML =
      '<header class="shot-card-head">' +
        // 第一行: 镜头 NN / SHOT NN + 情绪 badge (左对齐) + @ / 删除 (右对齐)。
        '<div class="shot-card-head-top">' +
          '<div class="shot-card-title">' +
            '<strong>镜头 ' + String(idx+1).padStart(2,'0') + '</strong>' +
            '<span class="shot-card-en-label">/ SHOT ' + String(idx+1).padStart(2,'0') + '</span>' +
            (shot.emotion ? '<span class="shot-emotion-tag">' + emotionBadgeHtml(shot.emotion, shot.intensity) + '</span>' : '') +
            '<span class="shot-segment-tag" title="本镜头所属片段">片段 ' + _segmentNoForShot(idx) + '</span>' +
          '</div>' +
          // @ / 删除 按钮与标题同一行, 右对齐 + 常亮 (CSS opacity:1)。
          '<div class="shot-card-actions">' +
            '<button type="button" class="shot-icon-btn" data-action="ref-agent" title="引用到 AI 助手">' +
              '<span class="material-symbols-outlined">alternate_email</span>' +
            '</button>' +
            '<button type="button" class="shot-icon-btn is-danger" data-action="delete-shot" title="删除镜头">' +
              '<span class="material-symbols-outlined">delete_outline</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        // 第二行: 镜头参数 chip 单独占一整行, 放在标题下方。
        '<div class="shot-card-specs' + (_shotSpecsExpanded[idx] ? ' is-expanded' : '') + '">' +
          '<label class="shot-pill-select-wrap">' +
            '<span>时长</span>' +
            '<select class="shot-field shot-select shot-pill-select" data-field="duration">' +
              _buildDurationOptions(shot.duration ?? shot.durationSec) +
            '</select>' +
          '</label>' +
          '<label class="shot-pill-select-wrap">' +
            '<span>节奏</span>' +
            '<select class="shot-field shot-select shot-pill-select" data-field="pace">' +
              _buildPaceOptions(shot.pace || shot.narrativePace) +
            '</select>' +
          '</label>' +
          '<label class="shot-pill-select-wrap">' +
            '<span>景别</span>' +
            '<select class="shot-field shot-select shot-pill-select" data-field="shotType">' +
              _buildSelectOptions(SHOT_TYPES, _shotFieldCurrent(shot, "shotType")) +
            '</select>' +
          '</label>' +
          '<label class="shot-pill-select-wrap">' +
            '<span>运镜</span>' +
            '<select class="shot-field shot-select shot-pill-select" data-field="camera">' +
              _buildSelectOptions(CAMERA_MOVES, _shotFieldCurrent(shot, "camera")) +
            '</select>' +
          '</label>' +
          '<span class="shot-specs-extra">' +
            '<label class="shot-pill-select-wrap">' +
              '<span>角度</span>' +
              '<select class="shot-field shot-select shot-pill-select" data-field="angle">' +
                _buildSelectOptions(ANGLES, _shotFieldCurrent(shot, "angle")) +
              '</select>' +
            '</label>' +
            '<label class="shot-pill-select-wrap">' +
              '<span>焦距</span>' +
              '<select class="shot-field shot-select shot-pill-select" data-field="lens">' +
                _buildSelectOptions(LENSES, _shotFieldCurrent(shot, "lens")) +
              '</select>' +
            '</label>' +
            '<label class="shot-pill-select-wrap">' +
              '<span>景深</span>' +
              '<select class="shot-field shot-select shot-pill-select" data-field="focus">' +
                _buildSelectOptions(FOCUS_OPTIONS, _shotFieldCurrent(shot, "focus")) +
              '</select>' +
            '</label>' +
            '<label class="shot-pill-select-wrap">' +
              '<span>光线</span>' +
              '<select class="shot-field shot-select shot-pill-select" data-field="light">' +
                _buildSelectOptions(LIGHT_PRESETS, _shotFieldCurrent(shot, "light")) +
              '</select>' +
            '</label>' +
            '<label class="shot-pill-select-wrap">' +
              '<span>构图</span>' +
              '<select class="shot-field shot-select shot-pill-select" data-field="composition">' +
                _buildSelectOptions(COMPOSITION_PRESETS, _shotFieldCurrent(shot, "composition")) +
              '</select>' +
            '</label>' +
          '</span>' +
          '<button type="button" class="shot-specs-toggle" data-action="toggle-shot-specs" data-shot-idx="' + idx + '">' +
            (_shotSpecsExpanded[idx] ? '◁◁◁ 收起' : '▷▷▷ 更多') +
          '</button>' +
        '</div>' +
        '</header>' +
      '<aside class="shot-storyboard-slot" id="shotStoryboardSlot_' + idx + '" data-shot-idx="' + idx + '" data-group-idx="' + segmentInfo.groupIdx + '">' +
        _shotStoryboardInitialSlotHtml(idx) +
      '</aside>' +
      '<input type="hidden" data-field="audio" value="' + escapeHtml(shot.audio||"") + '" />';
    wrap.appendChild(card);
  });

  wrap.querySelectorAll(".shot-specs-toggle").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var idx = parseInt(btn.dataset.shotIdx, 10);
      if (isNaN(idx)) return;
      var specs = btn.closest(".shot-card-specs");
      if (!specs) return;
      var nowExpanded = !specs.classList.contains("is-expanded");
      _shotSpecsExpanded[idx] = nowExpanded;
      specs.classList.toggle("is-expanded", nowExpanded);
      btn.textContent = nowExpanded ? "◁◁◁ 收起" : "▷▷▷ 更多";
    });
  });

  wrap.querySelectorAll(".shot-field").forEach(function (el) {
    var evt = (el.tagName === "SELECT") ? "change" : "blur";
    el.addEventListener(evt, function () {
      var card = el.closest(".sc-card[data-shot-idx]");
      if (!card) return;
      var idx = parseInt(card.dataset.shotIdx, 10);
      if (isNaN(idx) || !project || !project.shots[idx]) return;
      var field = el.dataset.field;
      var val = _shotFieldValue(field, el.value);
      if (_shotFieldCurrent(project.shots[idx], field) !== val) {
        _applyShotFieldValue(project.shots[idx], field, val);
        _markDownstreamStale("shot", { idx: idx });
        if (field === "duration") _updateShotSummaryMeta();
        saveProject();
      }
    });
  });

  // 注：此前这里有 `shotsConfirmArea.hidden = true` 的越权 hide，会在镜头计划
  // 生成完成后把"分镜图已确认"按钮藏掉。该容器的显隐由 storyboard.js
  // 的 _syncMergedStoryboardConfirmState 独立管理（通过 checkImagesConfirm 触发），
  // 这里不再越权操作。renderShotList 内当 shots 为空时仍会在 line 462 隐藏（合理）。
  _renderScriptRefPanel();
  _shotParaMap = _buildShotScriptMapping();
  _bindShotHoverHighlight();
}

function _renderScriptRefPanel() {
  var colWrap = $("scriptRefColWrap");
  var panel = $("scriptRefPanel");
  if (!colWrap || !panel) return;
  if (!project || !project.script || !project.shots || !project.shots.length) {
    _hideScriptRefPanel();
    return;
  }
  var raw = stripStepTags(project.script).replace(/\r\n/g, "\n");
  _scriptParas = raw.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (!_scriptParas.length) {
    _scriptParas = raw.split(/\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  }
  var html = "";
  _scriptParas.forEach(function (text, i) {
    html += '<div class="sr-para" data-para-idx="' + i + '">' + escapeHtml(text) + '</div>';
  });
  panel.innerHTML = html;
  colWrap.hidden = false;
}

function _buildShotScriptMapping() {
  var map = {};
  if (!project || !project.shots || !_scriptParas.length) return map;
  var fullScript = project.script || "";
  project.shots.forEach(function (shot, si) {
    map[si] = [];
    if (shot.scriptRef && shot.scriptRef.trim()) {
      var ref = shot.scriptRef.trim();
      var charStart = fullScript.indexOf(ref);
      if (charStart >= 0) {
        var runLen = 0;
        for (var pi = 0; pi < _scriptParas.length; pi++) {
          var pStart = fullScript.indexOf(_scriptParas[pi], runLen);
          if (pStart < 0) continue;
          var pEnd = pStart + _scriptParas[pi].length;
          var refEnd = charStart + ref.length;
          if (charStart < pEnd && refEnd > pStart) map[si].push(pi);
          runLen = pStart + 1;
        }
      }
      if (map[si].length) return;
    }
    var keywords = [];
    if (shot.dialogue) {
      var raw = shot.dialogue.replace(/^[^：:]+[：:]\s*/, "").trim();
      if (raw.length >= 4) keywords.push(raw);
    }
    if (shot.visual) {
      (shot.characters || []).forEach(function (c) { if (c) keywords.push(c); });
    }
    if (keywords.length) {
      _scriptParas.forEach(function (pText, pi) {
        for (var k = 0; k < keywords.length; k++) {
          if (pText.indexOf(keywords[k]) >= 0) {
            if (map[si].indexOf(pi) < 0) map[si].push(pi);
            break;
          }
        }
      });
    }
  });
  return map;
}

function _bindShotHoverHighlight() {
  if (_shotHoverBound) return;
  var wrap = $("shotListWrap");
  var panelBody = $("scriptRefPanel");
  if (!wrap || !panelBody) return;
  _shotHoverBound = true;
  var _lastHighlightIdx = -1;

  wrap.addEventListener("mouseover", function (e) {
    var card = e.target.closest(".sc-card[data-shot-idx]");
    if (!card) return;
    var idx = parseInt(card.dataset.shotIdx, 10);
    if (isNaN(idx) || idx === _lastHighlightIdx) return;
    _lastHighlightIdx = idx;
    var allParas = panelBody.querySelectorAll(".sr-para");
    if (!allParas.length) return;
    var matched = _shotParaMap[idx] || [];
    var hasDim = matched.length > 0;
    allParas.forEach(function (p) {
      p.classList.remove("script-ref-active", "script-ref-dim");
      if (hasDim) p.classList.add("script-ref-dim");
    });
    matched.forEach(function (pi) {
      if (allParas[pi]) {
        allParas[pi].classList.remove("script-ref-dim");
        allParas[pi].classList.add("script-ref-active");
      }
    });
    if (matched.length && allParas[matched[0]]) {
      // 滚动容器就是 .script-ref-body 自己 (滚动已从 .shots-right-col 移入面板内,
      // 修复滚动中 backdrop-filter 面板背景层不随滚的渲染伪影, 见 styles.css)。
      var scrollWrap = panelBody;
      var paraEl = allParas[matched[0]];
      var wrapRect = scrollWrap.getBoundingClientRect();
      var paraRect = paraEl.getBoundingClientRect();
      var target = scrollWrap.scrollTop + (paraRect.top - wrapRect.top) - (wrapRect.height - paraRect.height) / 2;
      scrollWrap.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  });

  wrap.addEventListener("mouseleave", function () {
    _lastHighlightIdx = -1;
    panelBody.querySelectorAll(".sr-para").forEach(function (p) {
      p.classList.remove("script-ref-active", "script-ref-dim");
    });
  });
}

/* ----------------------------------------------------------------
   镜头表生成倒计时（"，剩x分x秒"）
   ----------------------------------------------------------------
   - 总时长估算：取最近 5 次成功生成的真实耗时中位数（localStorage），
     没有历史就用 240s 兜底（推理类模型 3~5 分钟常态，取偏中值）。
   - 锚点：本地点击时刻起算；snapshot/轮询带回 batch.createdAt 后矫正，
     这样刷新 / reattach 续接进度时倒计时不会从头再走。
   - 超出预估后不再装"剩 0 秒"，改显示"已用x分x秒（超出预估）"。
   - 只在成功完成时把真实耗时写回历史，失败/取消不污染估算。
   ---------------------------------------------------------------- */
var SHOTPLAN_DUR_KEY = "origin_shotplan_durations_v1";
var SHOTPLAN_DEFAULT_ESTIMATE_SEC = 240;

function _fmtMinSec(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return m > 0 ? m + "分" + (s < 10 ? "0" + s : s) + "秒" : s + "秒";
}

function _shotPlanEstimateSec() {
  try {
    var arr = JSON.parse(localStorage.getItem(SHOTPLAN_DUR_KEY) || "[]");
    var ds = (Array.isArray(arr) ? arr : []).filter(function (n) {
      return Number.isFinite(n) && n >= 10 && n <= 1800;
    });
    if (!ds.length) return SHOTPLAN_DEFAULT_ESTIMATE_SEC;
    ds.sort(function (a, b) { return a - b; });
    return Math.round(ds[Math.floor(ds.length / 2)]); // 中位数抗离群
  } catch (_e) {
    return SHOTPLAN_DEFAULT_ESTIMATE_SEC;
  }
}

function _recordShotPlanDuration(sec) {
  if (!(sec >= 10 && sec <= 1800)) return; // 秒级完成多半是缓存/复用，不计入
  try {
    var arr = JSON.parse(localStorage.getItem(SHOTPLAN_DUR_KEY) || "[]");
    if (!Array.isArray(arr)) arr = [];
    arr.push(Math.round(sec));
    while (arr.length > 5) arr.shift();
    localStorage.setItem(SHOTPLAN_DUR_KEY, JSON.stringify(arr));
  } catch (_e) {}
}

var _shotsEta = null; // { anchorMs, totalSec, timer }
var _shotsHintBase = "";

function _shotsEtaSuffix() {
  if (!_shotsEta) return "";
  var elapsed = (Date.now() - _shotsEta.anchorMs) / 1000;
  var remain = Math.ceil(_shotsEta.totalSec - elapsed);
  if (remain > 0) return "，剩" + _fmtMinSec(remain);
  return "，已用" + _fmtMinSec(elapsed) + "（超出预估）";
}

function _shotsEtaStart() {
  _shotsEtaStop(false);
  _shotsEta = { anchorMs: Date.now(), totalSec: _shotPlanEstimateSec(), timer: null };
  _shotsEta.timer = setInterval(function () {
    if (!_shotsEta) return;
    var hintEl = $("shotsGenHint");
    if (hintEl && _shotsHintBase) hintEl.textContent = _shotsHintBase + _shotsEtaSuffix();
  }, 1000);
}

/* snapshot / 轮询帧带 createdAt（服务端 getBatchSnapshot 附带）时矫正锚点 */
function _shotsEtaSyncAnchor(snap) {
  if (!_shotsEta || !snap || !snap.createdAt) return;
  var t = Date.parse(snap.createdAt);
  if (Number.isFinite(t) && t > 0 && t <= Date.now() && Math.abs(t - _shotsEta.anchorMs) > 3000) {
    _shotsEta.anchorMs = t;
  }
}

function _shotsEtaStop(recordSuccess) {
  if (!_shotsEta) return;
  if (recordSuccess) _recordShotPlanDuration((Date.now() - _shotsEta.anchorMs) / 1000);
  if (_shotsEta.timer) clearInterval(_shotsEta.timer);
  _shotsEta = null;
}

function _setShotsProgress(pct, title, hint) {
  var bar = $("shotsGenProgress");
  var banner = $("shotsGenBanner");
  var titleEl = $("shotsGenTitle");
  var hintEl = $("shotsGenHint");
  if (bar) bar.style.width = pct + "%";
  if (banner) banner.hidden = false;
  if (titleEl && title) titleEl.textContent = title;
  if (hintEl && hint) {
    _shotsHintBase = hint;
    hintEl.textContent = hint + _shotsEtaSuffix();
  }
}

/* 失败终态展示：停 ETA 倒计时、停转圈、换 error 图标、亮出"重新生成"按钮。
   背景(2026-06-10 Vasily)：失败后 needPlan 入口是隐藏的、镜头列表又是空的，
   页面上没有任何重试入口，只能切页/刷新绕回去。 */
function _setShotsGenBannerFailed(hint) {
  _shotsEtaStop(false);
  _setShotsProgress(0, "镜头设计失败", hint);
  var banner = $("shotsGenBanner");
  if (banner) {
    var icon = banner.querySelector(".material-symbols-outlined");
    if (icon) {
      icon.classList.remove("animate-spin");
      icon.textContent = "error";
    }
  }
  var retry = $("btnShotsGenRetry");
  if (retry) {
    retry.hidden = false;
    retry.disabled = false;
    // onclick 赋值幂等，重复进失败态不会叠监听
    retry.onclick = _retryGenerateShotsFromBanner;
  }
}

/* 回到"生成中"视觉：转圈图标 + 藏重试按钮（开始/重连/成功收尾时调） */
function _resetShotsGenBannerVisuals() {
  var banner = $("shotsGenBanner");
  if (banner) {
    var icon = banner.querySelector(".material-symbols-outlined");
    if (icon) {
      icon.classList.add("animate-spin");
      icon.textContent = "progress_activity";
    }
  }
  var retry = $("btnShotsGenRetry");
  if (retry) retry.hidden = true;
}

function _retryGenerateShotsFromBanner() {
  _syncRefs();
  // 失败终态各路径都会 finish() 清挂账；这里兜底再清一次，防住
  // "失败已展示但 finish 还没跑到"的窗口期点击被 generateShots 早退吞掉。
  if (project && project.id) {
    _trackingShotsBatchByProject.delete(String(project.id));
  }
  generateShots();
}

function _hideShotsProgressBanner() {
  _shotsEtaStop(false);
  _shotsHintBase = "";
  var bar = $("shotsGenProgress");
  var banner = $("shotsGenBanner");
  var titleEl = $("shotsGenTitle");
  var hintEl = $("shotsGenHint");
  if (banner) banner.hidden = true;
  _resetShotsGenBannerVisuals();
  if (bar) {
    bar.style.width = "0%";
    bar.classList.remove("extract-bar-pulse");
  }
  if (titleEl) titleEl.textContent = "AI 正在设计镜头…";
  if (hintEl) hintEl.textContent = "分析剧本、资产、情绪曲线，生成完整镜头表";
}

function _syncShotsProgressBanner() {
  if (!project || project.shotPlanStatus !== "generating") {
    _hideShotsProgressBanner();
  }
}

/* ----------------------------------------------------------------
   generateShots — Phase 5.13 (batch_runner 后端化)
   ================================================================
   从 apiPostStream("/api/shots/generate") 换成 POST /api/batch/start
   {batchType:"shots"} + subscribeBatch。后端 shots_executor 负责真正的
   LLM 调用，前端只看阶段性进度 + 最终 patch。

   好处：
   - 刷新 / 切 tab / 关 tab 重开都不丢状态（main.js 的 reattachActiveBatches
     识别 shots 就能重新挂 SSE）
   - reasoning 阶段通过后端 REASONING_BEAT 心跳保持连接活跃，不再 90 秒
     掐线
   - 成功后 `services.project_patch` 直接权威落盘 `project.shots`，前端
     `_safeWriteBack` 只是 UI 乐观更新
   ---------------------------------------------------------------- */
// 本会话正在跟踪的 shots 批次（projectKey → batchId）。
// 防止重复调用 generateShots 造成同一批次双订阅（双倍回调/弹双 toast），
// 以及"确认资产自动触发 + 手点生成"这类同会话重入。
// 服务端 /api/batch/start 对 shots 还有同项目复用兜底（跨刷新/跨标签页场景）。
var _trackingShotsBatchByProject = new Map();

export async function generateShots(opts) {
  _syncRefs();
  var existingBatchId = (opts && opts.resumeBatchId) || null;

  if (!existingBatchId) {
    if (!project || !_hasAnyAssetData()) {
      showToast("请先完成资产分析", "warn");
      return;
    }
  }

  var originId = project.id;
  var _trackKey = String(originId);
  var _tracked = _trackingShotsBatchByProject.get(_trackKey);
  if (existingBatchId) {
    if (_tracked === existingBatchId) {
      // 这路批次已在跟踪，避免双订阅。但"切走项目又切回"会经 _hideShotsProgressBanner
      // 停掉倒计时——这里只复活 ticker（锚点由下一帧 snapshot.createdAt 矫正）。
      if (!_shotsEta && project && project.shotPlanStatus === "generating") _shotsEtaStart();
      return;
    }
  } else if (_tracked) {
    return; // 本会话已有一路镜头计划在跟踪（自动触发/重复点击直接忽略）
  }
  var btn = $("btnGenShots");
  var needPlan = $("shotsNeedPlan");
  var ready = $("shotsReady");
  var topActions = $("shotsTopActions");
  if (needPlan) needPlan.hidden = true;
  if (ready) ready.hidden = false;
  if (topActions) topActions.hidden = !_hasAnyShots();
  _refreshShotPlanActionState({
    label: "镜头计划生成中…",
    disabled: true,
    hint: existingBatchId ? "正在重新连接镜头计划生成任务。" : "后台正在生成镜头计划，请稍候。",
  });
  _resetShotsGenBannerVisuals(); // 从失败态重试/重连时复原转圈+收起重试按钮
  _shotsEtaStart();
  _setShotsProgress(5, "AI 正在分析剧本与资产…", "准备生成完整镜头表，请稍候");
  var _progressBar = $("shotsGenProgress");
  if (_progressBar) _progressBar.classList.add("extract-bar-pulse");

  var batchId = existingBatchId;
  if (!batchId) {
    try {
      var startResp = await apiPost("/api/batch/start", {
        batchType: "shots",
        projectId: originId,
        targets: [{ type: "shots" }],
        options: {
          script: project.script,
          styleBible: project.styleBible,
          assets: project.assets,
          idea: project.idea || "",
          durationSec: project.scriptTargetDurationSec || null,
          emotionSegments: project.emotionSegments || [],
          creatorProfile: formatCreatorProfileForApi(),
        },
      });
      batchId = startResp && startResp.batchId;
      if (!batchId) throw new Error("启动失败：未返回 batchId");
      if (startResp && startResp.reused) {
        // 服务端防重命中：同项目已有镜头计划批次在跑，复用并续显进度
        _setShotsProgress(15, "重新连接生成任务…", "检测到后台已在生成镜头计划，继续跟踪进度");
      }
    } catch (e) {
      if (_progressBar) _progressBar.classList.remove("extract-bar-pulse");
      var errTextStart = ((e && e.message) || e).toString().slice(0, 150);
      _setShotsGenBannerFailed(errTextStart);
      showToast("镜头设计启动失败：" + _diagnoseApiError(errTextStart), "error");
      _refreshShotPlanActionState();
      return;
    }
  } else {
    _setShotsProgress(15, "重新连接生成任务…", "已检测到后台正在生成，继续跟踪进度");
  }
  _trackingShotsBatchByProject.set(_trackKey, batchId);

  var finished = false;
  var finishingFromServer = null;
  var pollTimer = null;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function finish() {
    if (finished) return;
    finished = true;
    _stopPoll();
    _shotsEtaStop(false);
    if (_trackingShotsBatchByProject.get(_trackKey) === batchId) {
      _trackingShotsBatchByProject.delete(_trackKey);
    }
    if (_progressBar) _progressBar.classList.remove("extract-bar-pulse");
    _refreshShotPlanActionState();
  }

  function _completedShotsFromSnapshot(snap) {
    var tasks = snap && Array.isArray(snap.tasks) ? snap.tasks : [];
    for (var i = 0; i < tasks.length; i++) {
      var result = tasks[i] && tasks[i].result;
      var patch = result && result.patch;
      if (patch && patch.type === "shots" && Array.isArray(patch.value) && patch.value.length) {
        return patch.value;
      }
    }
    return null;
  }

  async function _finishAfterServerSync(snap) {
    if (finished) return;
    if (finishingFromServer) return finishingFromServer;
    finishingFromServer = (async function () {
      var serverShots = null;
      try {
        var resp = await fetch("/api/projects/" + encodeURIComponent(originId), { headers: getAuthHeaders() });
        if (resp.ok) {
          var p = await resp.json();
          if (p && p.id === originId && Array.isArray(p.shots)) {
            serverShots = p.shots;
            _safeWriteBack(originId, function (proj) { _applyShotPlanServerProjectSnapshot(proj, p); });
          }
        }
      } catch (e) {
        console.warn("[Shots] reload after completion failed:", e);
      }

      if (!serverShots || !serverShots.length) {
        serverShots = _completedShotsFromSnapshot(snap);
        if (serverShots && serverShots.length) {
          _safeWriteBack(originId, function (proj) {
            proj.shots = serverShots;
            proj.shotsApproved = false;
            proj.imagesApproved = false;
            proj.videoPromptsApproved = false;
            proj.storyboards = _makeSingleShotStoryboards(serverShots);
            proj.videoTasks = [];
            proj.currentStep = Math.max(proj.currentStep || 0, 3);
            proj.frameWorkflowSchemaVersion = 3;
          });
        }
      }

      if (serverShots && serverShots.length) {
        _shotsEtaStop(true);
        _resetShotsGenBannerVisuals(); // 可能从失败展示翻转回成功（如空patch但服务端已落盘）
        _setShotsProgress(100, "镜头设计完成", "共生成 " + serverShots.length + " 个镜头");
        setTimeout(function () { var b = $("shotsGenBanner"); if (b) b.hidden = true; }, 1200);
        refreshShotsPage();
        showToast("镜头设计完成：共 " + serverShots.length + " 个镜头", "success");
      }
      finish();
    })();
    return finishingFromServer;
  }

  // 兜底轮询：每 5 秒主动 GET /api/batch/<id> 拿权威状态。
  // SSE 在某些环境下不稳定（开发热重载、浏览器节流、反代 buffer 等），
  // 轮询保证不管 SSE 通不通，UI 最终一定追得上。
  // 检测到 status=completed → 从服务端整包重拉项目（shots 已经被
  // executor 落盘）+ 触发渲染；status=failed → 显示错误提示。
  async function _pollOnce() {
    if (finished) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
      if (!snap || finished) return;
      _shotsEtaSyncAnchor(snap);
      if (snap.status === "completed") {
        console.log("[Shots] poll detected batch completed → reload project");
        await _finishAfterServerSync(snap);
      } else if (snap.status === "failed" || snap.status === "cancelled" || snap.status === "partial") {
        var taskErr = "";
        if (Array.isArray(snap.tasks)) {
          var f = snap.tasks.find(function (t) { return t.status === "failed"; });
          if (f && f.errorMsg) taskErr = f.errorMsg;
        }
        var failMsg = taskErr || "请稍后重试";
        console.warn("[Shots] poll detected batch failed: " + failMsg);
        _setShotsGenBannerFailed(failMsg.slice(0, 120));
        showToast("镜头设计失败：" + _diagnoseApiError(failMsg), "error");
        finish();
      }
    } catch (e) {
      console.warn("[Shots] poll failed:", (e && e.message) || e);
    }
  }
  pollTimer = setInterval(_pollOnce, 5000);

  subscribeBatch(batchId, {
    onSnapshot: function (snap) {
      if (finished) return; // 终态后迟到的 snapshot 不再覆盖失败/完成展示
      _shotsEtaSyncAnchor(snap);
      if (snap && snap.succeeded >= 1) {
        _setShotsProgress(95, "生成完成，正在落盘…", "");
      } else if (snap && snap.failed >= 1) {
        // 单任务批次，任务失败即终态。优先取 snapshot 里的真实 errorMsg，
        // 别再只给"请稍后重试"（实际错误如"LLM background submit 超时"应直给）。
        var snapErr = "";
        if (Array.isArray(snap.tasks)) {
          var ft = snap.tasks.find(function (t) { return t.status === "failed"; });
          if (ft && ft.errorMsg) snapErr = String(ft.errorMsg);
        }
        _setShotsGenBannerFailed((snapErr || "请稍后重试").slice(0, 120));
        showToast("镜头设计失败：" + _diagnoseApiError(snapErr || "请稍后重试"), "error");
        finish(); // 立即收尾：清挂账让"重新生成"点击即生效，也避免兜底轮询再弹一次 toast
      } else {
        _setShotsProgress(20, "AI 正在生成镜头表", "已连接后台任务");
      }
    },
    onTaskStarted: function () {
      _setShotsProgress(20, "AI 正在生成镜头表", "模型已开始生成，请耐心等待");
    },
    onTaskProgress: function (data) {
      if (!data || !data.stage) return;
      var stage = data.stage;

      if (stage === "prepare") {
        _setShotsProgress(Math.max(10, data.percent || 10), "正在准备素材", data.hint || "");
      } else if (stage === "planning") {
        _setShotsProgress(Math.max(10, data.percent || 10), "AI 正在分析剧本结构", data.hint || "规划场次与分组…");
      } else if (stage === "dispatching") {
        _setShotsProgress(Math.max(20, data.percent || 20), "正在分配镜头任务", data.hint || "");
      } else if (stage.indexOf("scene_") === 0) {
        _setShotsProgress(Math.max(25, data.percent || 25), "正在生成镜头", data.hint || "");
      } else if (stage.indexOf("flushed_") === 0) {
        _setShotsProgress(Math.max(30, data.percent || 30), "镜头生成中", data.hint || "");
        var partial = data.partialShots;
        if (Array.isArray(partial) && partial.length) {
          _safeWriteBack(originId, function (proj) {
            proj.shots = partial;
          });
          renderShotList();
        }
      } else if (stage === "assembling") {
        _setShotsProgress(Math.max(88, data.percent || 88), "正在组装最终镜头表", data.hint || "");
      } else if (stage === "reasoning") {
        var base = 25;
        var step = Math.min(35, (data.beatCount || 1) * 2);
        _setShotsProgress(base + step, "AI 正在深度推理", data.hint || "AI 正在深度推理…");
      } else if (stage === "writing") {
        _setShotsProgress(Math.max(70, data.percent || 70), "AI 正在输出镜头表", data.hint || "");
      } else if (stage === "parsing") {
        _setShotsProgress(Math.max(90, data.percent || 90), "整理中", data.hint || "正在整理镜头表");
      }
    },
    onTaskCompleted: async function (data) {
      var patch = (data && data.patch) || {};
      var arr = Array.isArray(patch.value) ? patch.value : null;
      if (!arr || !arr.length) {
        // 注意：这里故意不 finish() —— onBatchCompleted 的 _finishAfterServerSync
        // 还有机会从服务端整包恢复；恢复成功路径会复原横幅视觉。
        _setShotsGenBannerFailed("AI 未返回有效镜头表");
        showToast("镜头设计失败：未能解析出分镜列表", "error");
        return;
      }
      _shotsEtaStop(true);

      var isCurrent = false;
      try {
        var resp = await fetch("/api/projects/" + encodeURIComponent(originId), { headers: getAuthHeaders() });
        if (resp.ok) {
          var serverProject = await resp.json();
          isCurrent = _safeWriteBack(originId, function (proj) {
            _applyShotPlanServerProjectSnapshot(proj, serverProject);
          }, data && data.serverVersion);
        }
      } catch (e) {
        console.warn("[Shots] reload after completion failed:", e);
      }
      if (!isCurrent) {
        isCurrent = _safeWriteBack(originId, function (proj) {
          proj.shots = arr;
          proj.shotsApproved = false;
          proj.imagesApproved = false;
          proj.videoPromptsApproved = false;
          proj.storyboards = _makeSingleShotStoryboards(arr);
          proj.videoTasks = [];
          proj.frameWorkflowSchemaVersion = 3;
        }, data && data.serverVersion);
      }

      _resetShotsGenBannerVisuals();
      _setShotsProgress(100, "镜头设计完成", "共生成 " + arr.length + " 个镜头");
      if (isCurrent) {
        var _types = {};
        arr.forEach(function (sh) {
          var t = sh.shotType || "其他";
          _types[t] = (_types[t] || 0) + 1;
        });
        showToast(
          "镜头设计完成：共 " + arr.length + " 个镜头，涵盖 " +
          Object.keys(_types).length + " 种景别/类型",
          "success",
        );
        setTimeout(function () { var b = $("shotsGenBanner"); if (b) b.hidden = true; }, 2000);
        refreshShotsPage();
        finish();
      }
    },
    onTaskFailed: function (data) {
      if (finished) return; // snapshot/轮询已先判终态时不再重复弹 toast
      var errText = ((data && data.errorMsg) || "生成失败").toString().slice(0, 150);
      _setShotsGenBannerFailed(errText);
      showToast("镜头设计失败: " + _diagnoseApiError(errText), "error");
      // 单任务批次，任务失败即批次终态：立即收尾（清挂账+停轮询），
      // "重新生成"点下去不会被旧挂账早退，兜底轮询也不会 5 秒后再弹一次错误。
      finish();
    },
    onBatchCompleted: async function (data) {
      var snap = null;
      try {
        snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
      } catch (e) {
        console.warn("[Shots] completion snapshot reload failed:", e);
      }
      await _finishAfterServerSync(snap || data);
    },
    onClose: function () {
      if (pollTimer) console.warn("[Shots] SSE closed; polling fallback remains active");
    },
  });
}

/* 供 main.js reattachActiveBatches 调：刷新 / 关 tab 回来后，发现后台还有
   shots 任务在跑，就用这个函数重挂 SSE，不再发新的 /api/batch/start。 */
export function attachShotsBatch(batchId) {
  if (!batchId) return;
  return generateShots({ resumeBatchId: batchId });
}

export function saveShotEdits() {
  _syncRefs();
  if (!project || !project.shots) return false;
  var wrap = $("shotListWrap");
  if (!wrap) return false;
  var changed = [];
  wrap.querySelectorAll(".sc-card[data-shot-idx]").forEach(function (card) {
    var idx = parseInt(card.dataset.shotIdx, 10);
    if (isNaN(idx) || !project.shots[idx]) return;
    var shotChanged = false;
    card.querySelectorAll("[data-field]").forEach(function (el) {
      var field = el.dataset.field;
      var val = _shotFieldValue(field, el.value);
      if (_shotFieldCurrent(project.shots[idx], field) !== val) shotChanged = true;
      _applyShotFieldValue(project.shots[idx], field, val);
    });
    if (shotChanged) changed.push(idx);
  });
  if (changed.length) changed.forEach(function (idx) { _markDownstreamStale("shot", { idx: idx }); });
  if (changed.length) saveProject();
  return changed.length > 0;
}

export async function acceptShotPlanForStoryboard() {
  _syncRefs();
  if (!project || !project.shots || !project.shots.length) {
    showToast("请先生成镜头计划", "warn");
    return false;
  }
  var changed = saveShotEdits();

  if (!changed && project.shotsApproved === true && Number(project.currentStep || 0) >= 4) {
    return true;
  }

  var prevShotsApproved = project.shotsApproved;
  var prevCurrentStep = project.currentStep;
  project.shotsApproved = true;
  project.currentStep = Math.max(project.currentStep || 0, 4);

  try {
    var saved = await flushServerSave();
    if (saved && saved.ok === false) {
      // A first-frame draft autosave can legitimately advance the server version
      // right before this flush. If no shot fields changed, the 409-sync result
      // is not a failed shot-table save; continue from the freshly loaded project.
      if (saved.stale === true && !changed) {
        _syncRefs();
        return true;
      }
      throw new Error("project save rejected");
    }
    return true;
  } catch (e) {
    project.shotsApproved = prevShotsApproved;
    project.currentStep = prevCurrentStep;
    showToast("保存镜头表失败，请稍后重试", "error");
    return false;
  }
}

export function handleShotAction(e) {
  _syncRefs();
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;
  if (action === "regen-shot-plan") {
    generateShots();
    return;
  }
  if (action === "confirm-shot-plan-valid") {
    confirmShotPlanStillValid();
    return;
  }
  var card = btn.closest(".sc-card[data-shot-idx]");
  if (!card) return;
  var idx = parseInt(card.dataset.shotIdx, 10);

  if (action === "ref-agent") {
    var shot = project && project.shots && project.shots[idx];
    agentInsertRef("分镜", String(idx + 1), { shotIdx: idx, visual: (shot && shot.visual) || "" });
    return;
  }
	  if (action === "delete-shot") {
	    if (!project || !project.shots) return;
	    project.shots.splice(idx, 1);
	    project.shots.forEach(function (s, i) { s.order = i + 1; s.id = "shot_" + (i + 1); });
	    _syncSingleShotSlotsAfterDelete(idx);
	    showToast("已删除镜头，后续分镜板已按镜头顺序对齐", "warn");
	    if (project._staleFlags) {
	      Object.keys(project._staleFlags).forEach(function (k) {
	        if (k.indexOf("shot_") === 0 || k.indexOf("shot_prompt_") === 0 ||
            k.indexOf("storyboard_") === 0 || k.indexOf("video_prompt_") === 0) {
          delete project._staleFlags[k];
        }
      });
    }
    saveProject();
    renderShotList();
  }
}
