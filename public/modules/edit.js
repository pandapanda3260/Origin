/**
 * Edit workbench module — extracted from main.js (stage 2 refactor).
 * Call initEdit(ctx) once at startup, then syncEditProject(p) whenever project changes.
 */
import { $, escapeHtml, showToast, showConfirm, apiGet, apiPost, apiPostStream, formatTime, ApiError, getAuthHeaders, fetchVideoSignedUrl, fetchUploadSignedUrl, hydrateProtectedImageElements } from './utils.js';
import { subscribeTask, subscribeBatch } from './backend_stream.js';
import { showBillingPaywall } from './billing.js';
import { extractSubtitleLinesFromPrompt, resolveSubtitleLayoutSpec, splitSubtitleDialogueLines, subtitleVisibleCharCount } from '/modules/subtitle_format.js';

// 版本探针：让用户在 console 看到 "EDIT_JS_VERSION 117" 才能确认新代码加载到。
console.log('%c[EDIT_JS_VERSION] 117 —— 下载按钮状态按导出完成态收口', 'background:#0e7c4a;color:#fff;padding:2px 6px;border-radius:3px;');

let _ctx = {};
let project = null;

// E-6：BGM 曲库缓存从 window._bgmCatalogCache 搬到 module scope。
// 全局挂 window 的唯一历史理由是方便 devtools 调试，但实质上违反了"模块内态
// 不应该泄到全局"原则，也让架构守门脚本没法扫出"前端私藏剪辑数据"。
let _bgmCatalogCache = null;

// E-1.1：edit.js 以前裸引用 sleep / _getAuthToken / _diagnoseApiError，
// 但既没 import 也没在 ctx 里拿 → ES module strict mode 下任何触发它们的按钮都会
  // ReferenceError 崩（下载导出 / 内部分析 / 内部剪辑 / 素材上传 / 删除素材 5 个）。
// 照 storyboard.js / videoTasks.js 的模式从 ctx 里读，带本地 fallback 兜底。
  function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }
function _getAuthToken() { return _ctx.getAuthToken ? _ctx.getAuthToken() : ""; }
let _onlineEditorConfigRequested = false;
let _onlineEditorConfigRetryAt = 0;
const ONLINE_EDITOR_CONFIG_RETRY_DELAY_MS = 30000;

function _forEachOnlineEditorEntry(fn) {
  ["editCardRefine", "editGuardOnlineEditorEntry"].forEach(function (id) {
    var el = $(id);
    if (el) fn(el);
  });
}

function _removeOnlineEditorEntries() {
  _forEachOnlineEditorEntry(function (el) {
    try { el.remove(); } catch (_) { el.hidden = true; }
  });
}

function _setOnlineEditorEntriesHidden(hidden) {
  _forEachOnlineEditorEntry(function (el) { el.hidden = !!hidden; });
}

function _syncOnlineEditorEntries() {
  var cfg = _ctx.getOnlineEditorConfig ? _ctx.getOnlineEditorConfig() : null;
  if (!cfg) {
    _setOnlineEditorEntriesHidden(true);
    var now = Date.now();
    if (!_onlineEditorConfigRequested && _ctx.loadOnlineEditorConfig && now >= _onlineEditorConfigRetryAt) {
      _onlineEditorConfigRequested = true;
      Promise.resolve(_ctx.loadOnlineEditorConfig())
        .then(function () { _syncOnlineEditorEntries(); })
        .catch(function (err) {
          console.warn("[Edit] 在线精修配置读取失败:", err);
          _onlineEditorConfigRequested = false;
          _onlineEditorConfigRetryAt = Date.now() + ONLINE_EDITOR_CONFIG_RETRY_DELAY_MS;
          _setOnlineEditorEntriesHidden(true);
        });
    }
    return;
  }
  if (cfg.reason === "disabled") {
    _removeOnlineEditorEntries();
    return;
  }
  _setOnlineEditorEntriesHidden(false);
}

function _getEditData() {
  return (project && project.editData) ? project.editData : {};
}

function _currentEditEdl() {
  var editData = _getEditData();
  return editData.edl || (_editState && _editState.edl) || null;
}

function _hasUsableEdl() {
  var edl = _currentEditEdl();
  return !!(edl && Array.isArray(edl.timeline) && edl.timeline.length > 0);
}

function _currentEditEdlVersion() {
  var edl = _currentEditEdl();
  var v = Number(edl && edl.version);
  return Number.isFinite(v) ? v : 0;
}

function _stableExportStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(_stableExportStringify).join(",") + "]";
  var keys = Object.keys(value).sort();
  return "{" + keys.map(function (key) {
    return JSON.stringify(key) + ":" + _stableExportStringify(value[key]);
  }).join(",") + "}";
}

function _sha256Hex(text) {
  var bytes = new TextEncoder().encode(String(text || ""));
  var h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  var k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  var bitLen = bytes.length * 8;
  var dataLen = (((bytes.length + 9 + 63) >> 6) << 6);
  var data = new Uint8Array(dataLen);
  data.set(bytes);
  data[bytes.length] = 0x80;
  var hi = Math.floor(bitLen / 0x100000000);
  var lo = bitLen >>> 0;
  data[dataLen - 8] = (hi >>> 24) & 255;
  data[dataLen - 7] = (hi >>> 16) & 255;
  data[dataLen - 6] = (hi >>> 8) & 255;
  data[dataLen - 5] = hi & 255;
  data[dataLen - 4] = (lo >>> 24) & 255;
  data[dataLen - 3] = (lo >>> 16) & 255;
  data[dataLen - 2] = (lo >>> 8) & 255;
  data[dataLen - 1] = lo & 255;
  var w = new Uint32Array(64);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  for (var offset = 0; offset < data.length; offset += 64) {
    for (var i = 0; i < 16; i++) {
      var j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ ((~e) & g)) >>> 0;
      var temp1 = (hh + S1 + ch + k[i] + w[i]) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(function (x) { return (x >>> 0).toString(16).padStart(8, "0"); }).join("");
}

function _roundExportSec(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  var rounded = Math.round(Math.max(0, n) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function _extractExportClipIdFromUrl(value) {
  if (typeof value !== "string") return "";
  var m = /\/api\/videos\/file\/([a-zA-Z0-9-]+)/.exec(value);
  return m ? m[1] : "";
}

function _cleanExportGroupIdx(value) {
  if (value == null || value === "") return null;
  var n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function _currentClipIdForGroup(groupIdx) {
  if (!project || !Number.isInteger(Number(groupIdx))) return "";
  var gi = Number(groupIdx);
  var sb = Array.isArray(project.storyboards) ? project.storyboards[gi] : null;
  var vt = Array.isArray(project.videoTasks) ? project.videoTasks[gi] : null;
  return String(
    (sb && sb.videoTaskId) ||
    (vt && (vt.taskId || vt.serverTaskId || vt.id)) ||
    _extractExportClipIdFromUrl(sb && (sb.videoUrl || sb._originVideoUrl)) ||
    _extractExportClipIdFromUrl(vt && (vt.url || vt.videoUrl || vt.protectedUrl)) ||
    ""
  ).trim();
}

function _resolveCurrentExportFormat() {
  var candidates = [
    project && project.styleOptions && project.styleOptions.aspectRatio,
    project && project.styleBible && project.styleBible.aspectRatio,
    project && project.videoAspectRatio,
    "9:16"
  ];
  var ratio = "9:16";
  for (var i = 0; i < candidates.length; i++) {
    var r = String(candidates[i] || "").trim();
    if (/^(16:9|9:16|1:1|21:9|4:3|3:4)$/.test(r)) { ratio = r; break; }
  }
  if (ratio === "16:9" || ratio === "4:3" || ratio === "21:9") {
    return { ratio: "16:9", size: "1920x1080", width: 1920, height: 1080 };
  }
  if (ratio === "1:1") return { ratio: "1:1", size: "1024x1024", width: 1024, height: 1024 };
  return { ratio: "9:16", size: "1080x1920", width: 1080, height: 1920 };
}

function _currentEditExportSignature(options) {
  options = options || {};
  var edl = _currentEditEdl();
  var timeline = Array.isArray(edl) ? edl : (edl && Array.isArray(edl.timeline) ? edl.timeline : []);
  if (!timeline.length) return "";
  var items = [];
  timeline.forEach(function (entry) {
    if (!entry) return;
    var clipId = String(entry.clipId || "").trim();
    if (!clipId && typeof entry.videoUrl === "string") clipId = _extractExportClipIdFromUrl(entry.videoUrl);
    if (!clipId && typeof entry.protectedUrl === "string") clipId = _extractExportClipIdFromUrl(entry.protectedUrl);
    if (!clipId && typeof entry._originVideoUrl === "string") clipId = _extractExportClipIdFromUrl(entry._originVideoUrl);
    if (!clipId && Number.isInteger(Number(entry.groupIdx))) clipId = _currentClipIdForGroup(Number(entry.groupIdx));
    if (!clipId) return;
    var inSec = Math.max(0, Number(entry.inPoint != null ? entry.inPoint : (entry.in != null ? entry.in : 0)) || 0);
    var outSec = Number(entry.outPoint != null ? entry.outPoint : entry.out);
    if (!Number.isFinite(outSec) || outSec <= inSec) {
      outSec = Number(entry.duration) > 0 ? inSec + Number(entry.duration) : 0;
    }
    items.push({
      clipId: clipId,
      groupIdx: _cleanExportGroupIdx(entry.groupIdx),
      inSec: _roundExportSec(inSec),
      outSec: _roundExportSec(outSec),
      transitionInType: String((entry.transitionIn && entry.transitionIn.type) || entry.transitionIn || "cut").trim().toLowerCase() || "cut"
    });
  });
  if (!items.length) return "";
  var bgm = edl && edl.bgm && typeof edl.bgm === "object" ? edl.bgm : null;
  var bgmEnabled = !!(bgm && bgm.enabled === true);
  var bgmId = bgmEnabled && bgm && bgm.trackId ? String(bgm.trackId).trim() : "";
  var bgmOffsetTime = bgmId ? _roundExportSec(bgm && bgm.offsetTime) : 0;
  var resolvedBgm = options.resolvedBgm && typeof options.resolvedBgm === "object" ? options.resolvedBgm : null;
  if (resolvedBgm && resolvedBgm.trackId) {
    bgmEnabled = true;
    bgmId = String(resolvedBgm.trackId).trim();
    bgmOffsetTime = bgmId ? _roundExportSec(resolvedBgm.offsetTime) : 0;
  }
  var payload = {
    version: 1,
    exportFormat: _resolveCurrentExportFormat(),
    items: items,
    bgm: {
      enabled: bgmEnabled && !!bgmId,
      trackId: bgmId,
      offsetTime: bgmOffsetTime
    }
  };
  return "edit-export-v1:" + _sha256Hex(_stableExportStringify(payload));
}

function _exportMatchesAutoBgmSignature(exportedSignature) {
  var editData = _getEditData();
  var meta = editData.exportedEdlSignatureMeta && typeof editData.exportedEdlSignatureMeta === "object"
    ? editData.exportedEdlSignatureMeta
    : null;
  var bgmMeta = meta && meta.bgm && typeof meta.bgm === "object" ? meta.bgm : null;
  if (!bgmMeta || bgmMeta.source !== "auto" || !bgmMeta.trackId) return false;

  var edl = _currentEditEdl();
  var bgm = edl && edl.bgm && typeof edl.bgm === "object" ? edl.bgm : null;
  if (!bgm || bgm.enabled !== true || bgm.trackId) return false;

  var segmentTags = editData.segmentTags && typeof editData.segmentTags === "object" ? editData.segmentTags : {};
  if (String(segmentTags.suggestedBGMCategory || "") !== String(bgmMeta.suggestedBGMCategory || "")) return false;
  if (String(segmentTags.sourceFingerprint || "") !== String(bgmMeta.segmentFingerprint || "")) return false;

  return exportedSignature === _currentEditExportSignature({
    resolvedBgm: {
      trackId: bgmMeta.trackId,
      offsetTime: bgmMeta.offsetTime,
    },
  });
}

var AUTO_COMPOSE_RUNNING_STALE_MS = 10 * 60 * 1000;

function _isFreshAutoComposeRun(run) {
  var raw = String((run && (run.heartbeatAt || run.updatedAt || run.createdAt)) || "");
  var ts = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= AUTO_COMPOSE_RUNNING_STALE_MS;
}

function _isComposeRunCoveredByExport(run, editData) {
  if (!run || !editData || !editData.exportUrl) return false;
  if (run.exportUrl) return true;
  var runTaskId = String(run.exportTaskId || "").trim();
  var currentTaskId = String(editData.exportTaskId || "").trim();
  return !!(runTaskId && currentTaskId && runTaskId === currentTaskId);
}

function _isAutoComposeRunning() {
  if (_editActionBusy && _editActionBusy.btnEditAutoCompose) return true;
  var editData = _getEditData();
  var runs = editData.composeRuns;
  return Array.isArray(runs) && runs.some(function (run) {
    return run
      && run.status === "running"
      && _isFreshAutoComposeRun(run)
      && !_isComposeRunCoveredByExport(run, editData);
  });
}

function _exportMatchesCurrentEdl() {
  var editData = _getEditData();
  if (!editData.exportUrl) return false;
  var exportedSignature = String(editData.exportedEdlSignature || "").trim();
  if (exportedSignature) {
    var currentSignature = _currentEditExportSignature();
    return exportedSignature === currentSignature || _exportMatchesAutoBgmSignature(exportedSignature);
  }
  var exportedVersion = Number(editData.exportedEdlVersion);
  if (!Number.isFinite(exportedVersion)) return false;
  if (exportedVersion !== _currentEditEdlVersion()) return false;
  var currentSignature = _currentEditExportSignature();
  if (currentSignature) editData.exportedEdlSignature = currentSignature;
  return true;
}

function _getEditExportState() {
  var editData = _getEditData();
  if (_isAutoComposeRunning()) {
    return { state: "composing", label: "成片中", sub: "Composing", disabled: true, hint: "" };
  }
  if (!_hasUsableEdl()) {
    return { state: "no-edl", label: "下载导出", sub: "Export", disabled: true, hint: "" };
  }
  if (editData.exportTaskId && !editData.exportUrl) {
    return { state: "exporting", label: "导出中", sub: "Exporting", disabled: true, hint: "" };
  }
  if (editData.exportUrl) {
    if (_exportMatchesCurrentEdl()) {
      return { state: "download", label: "下载成片", sub: "Download", disabled: false, hint: "" };
    }
    return {
      state: "stale",
      label: "需重新成片",
      sub: "Outdated",
      disabled: true,
      hint: "",
    };
  }
  return { state: "export", label: "下载导出", sub: "Export", disabled: false, hint: "" };
}

function _syncEditExportButtonState() {
  var btn = $("btnEditExport");
  if (!btn) return;
  if (_editActionBusy && _editActionBusy.btnEditExport) return;
  var state = _getEditExportState();
  btn.disabled = !!state.disabled;
  btn.dataset.exportState = state.state;
  var labelEl = btn.querySelector(".edit-action-label-cn");
  if (labelEl) labelEl.textContent = state.label;
  var subEl = labelEl && labelEl.nextElementSibling;
  if (subEl) subEl.textContent = state.sub;
  btn.title = state.hint || "";
  var hintEl = $("editExportHint");
  if (hintEl) {
    hintEl.textContent = state.hint || "";
    hintEl.hidden = !state.hint;
  }
}

function _pulseAutoComposeButton() {
  var card = $("editCardAutoCompose");
  if (!card) return;
  card.animate([
    { transform: "scale(1)", filter: "brightness(1)" },
    { transform: "scale(1.03)", filter: "brightness(1.25)" },
    { transform: "scale(1)", filter: "brightness(1)" },
  ], { duration: 520, easing: "ease-out" });
}

// PATCH /api/edit/timeline 撞车兜底：只把剪辑相关字段从后端权威拉回内存，
// 不整包 reload 项目（避免跳页）。_sendTimelineOp / 媒体删除失败时调用。
async function _resyncEditDataFromServer() {
  if (!project || !project.id) return;
  try {
    var latest = await apiGet("/api/projects/" + encodeURIComponent(project.id));
    if (!latest || !latest.id) return;
    if (typeof latest.version === "number" && _ctx.bumpProjectVersion) {
      _ctx.bumpProjectVersion(latest.version);
    }
    // storyboards[i].importedToEdit 以后端为准
    if (Array.isArray(latest.storyboards) && Array.isArray(project.storyboards)) {
      for (var i = 0; i < latest.storyboards.length; i++) {
        var src = latest.storyboards[i];
        var dst = project.storyboards[i];
        if (src && dst && typeof src.importedToEdit !== "undefined") {
          dst.importedToEdit = src.importedToEdit; // arch-guard:allow-imported-to-edit 强同步回灌
        }
      }
    }
    // editData 子树以后端为准
    var ed = latest.editData || {};
    if (!project.editData) project.editData = {};
    if (ed.edl) {
      await _hydrateEdlVideoUrls(ed.edl);
      project.editData.edl = ed.edl; // arch-guard:allow-editdata 强同步回灌
      _editState.edl = ed.edl;
    }
    if (ed.segmentTags) {
      project.editData.segmentTags = ed.segmentTags; // arch-guard:allow-editdata 强同步回灌
      _editState.segmentTags = ed.segmentTags;
    }
    if (Object.prototype.hasOwnProperty.call(ed, "exportTaskId")) {
      project.editData.exportTaskId = ed.exportTaskId; // arch-guard:allow-editdata 强同步回灌
    }
    if (Object.prototype.hasOwnProperty.call(ed, "exportUrl")) {
      project.editData.exportUrl = ed.exportUrl; // arch-guard:allow-editdata 强同步回灌
    }
    if (Object.prototype.hasOwnProperty.call(ed, "exportedEdlVersion")) {
      project.editData.exportedEdlVersion = ed.exportedEdlVersion; // arch-guard:allow-editdata 强同步回灌
    }
    if (Object.prototype.hasOwnProperty.call(ed, "exportedEdlSignature")) {
      project.editData.exportedEdlSignature = ed.exportedEdlSignature; // arch-guard:allow-editdata 强同步回灌
    }
    if (Object.prototype.hasOwnProperty.call(ed, "exportedEdlSignatureMeta")) {
      project.editData.exportedEdlSignatureMeta = ed.exportedEdlSignatureMeta; // arch-guard:allow-editdata 强同步回灌
    }
    if (Array.isArray(ed.composeRuns)) project.editData.composeRuns = ed.composeRuns; // arch-guard:allow-editdata 强同步回灌
    if (typeof ed.lastAutoComposeEdlVersion !== "undefined") {
      project.editData.lastAutoComposeEdlVersion = ed.lastAutoComposeEdlVersion; // arch-guard:allow-editdata 强同步回灌
    }
    if (_ctx.getActivePage && _ctx.getActivePage() === "edit") {
      try { refreshEditPage(); } catch (_e) {}
    }
  } catch (_e) {
    // 强同步失败不再 toast 扰用户，上一条"保存失败"已经提示过一次。
  }
}

export function initEdit(ctx) {
  _ctx = ctx;
}

export function syncEditProject(p) {
  project = p;
}

  /* ================================================================
     自动剪辑工作台
     ================================================================ */
  var _editState = {
    segments: [],
    segmentTags: null,
    edl: null,
    zoom: 1,
    pixelsPerSecond: 30,
    /* playback engine — double buffer */
    isPlaying: false,
    currentSegIdx: 0,
    globalTime: 0,
    totalDuration: 0,
    segStartTimes: [],
    _rafId: null,
    _vidA: null,
    _vidB: null,
    _activeVid: "A",
    _preloaded: false,
    /* filmstrip thumbnail cache: { [groupIdx]: [dataUrl, ...] } */
    _thumbCache: {},
    /* waveform peak cache: { [groupIdx]: Float32Array } */
    _waveformCache: {},
    _bgmStatusRafId: null,
    /* undo/redo */
    _undoStack: [],
    _undoPtr: -1,
  };

  var _videoUrlHydrationRunId = 0;
  var _videoUrlHydrationPromise = null;

  var _PROTECTED_VIDEO_RE = /\/api\/videos\/file\/([0-9a-fA-F-]{36})/;
  var _PROTECTED_UPLOAD_RE = /\/api\/edit\/media\/([0-9a-fA-F-]{36})/;

  function _protectedVideoUrlFrom(url) {
    url = String(url || '').trim();
    if (!url) return '';
    var m = _PROTECTED_VIDEO_RE.exec(url);
    return m ? '/api/videos/file/' + m[1] : '';
  }

  // 上传素材的"裸"受保护形式（去掉 exp/sig），用于持久化与按需重签。
  function _protectedUploadUrlFrom(url) {
    url = String(url || '').trim();
    if (!url) return '';
    var m = _PROTECTED_UPLOAD_RE.exec(url);
    return m ? '/api/edit/media/' + m[1] : '';
  }

  // 生成片段优先匹配（行为与改前完全一致），否则尝试上传素材。
  function _protectedMediaUrlFrom(url) {
    return _protectedVideoUrlFrom(url) || _protectedUploadUrlFrom(url);
  }

  function _segPersistedVideoUrl(seg) {
    if (!seg) return '';
    return seg._originVideoUrl || seg.protectedUrl || _protectedMediaUrlFrom(seg.videoUrl) || seg.videoUrl || '';
  }

  async function _hydrateVideoEntryUrl(entry) {
    if (!entry) return;
    var origin = _segPersistedVideoUrl(entry);
    var isUpload = !_protectedVideoUrlFrom(origin) && !!_protectedUploadUrlFrom(origin);
    if (!_protectedMediaUrlFrom(origin)) return;
    try {
      var runtimeUrl = isUpload
        ? await fetchUploadSignedUrl(origin)
        : await fetchVideoSignedUrl(origin);
      if (runtimeUrl && runtimeUrl !== origin) {
        if (typeof entry._originVideoUrl === 'undefined') entry._originVideoUrl = origin;
        entry.protectedUrl = origin;
        entry.videoUrl = runtimeUrl;
      }
    } catch (_e) {}
  }

  async function _hydrateEdlVideoUrls(edl) {
    if (!edl || !Array.isArray(edl.timeline)) return edl;
    await Promise.all(edl.timeline.map(function (entry) {
      return _hydrateVideoEntryUrl(entry);
    }));
    return edl;
  }

  function _runtimeVideoUrlNeedsRefresh(url) {
    url = String(url || '').trim();
    var protectedUrl = _protectedMediaUrlFrom(url);
    if (!protectedUrl) return false;
    if (url === protectedUrl) return true;
    try {
      var u = new URL(url, window.location.origin);
      var exp = Number(u.searchParams.get('exp') || 0);
      return !Number.isFinite(exp) || exp * 1000 <= Date.now() + 5000;
    } catch (_e) {
      return false;
    }
  }

  function _collectTimelineVideoEntries() {
    var entries = [];
    if (_editState && _editState.edl && Array.isArray(_editState.edl.timeline)) {
      entries = entries.concat(_editState.edl.timeline);
    }
    if (_editState && Array.isArray(_editState.segments)) {
      entries = entries.concat(_editState.segments);
    }
    return entries.filter(Boolean);
  }

  function _timelineVideoUrlsNeedRefresh() {
    return _collectTimelineVideoEntries().some(function (entry) {
      return _runtimeVideoUrlNeedsRefresh(entry && entry.videoUrl);
    });
  }

  async function _hydrateTimelineVideoUrls() {
    var entries = _collectTimelineVideoEntries();
    var before = entries.map(function (entry) {
      return [entry.videoUrl || '', entry.protectedUrl || '', entry._originVideoUrl || ''].join('|');
    }).join('\n');
    await Promise.all(entries.map(function (entry) {
      return _hydrateVideoEntryUrl(entry);
    }));
    var after = entries.map(function (entry) {
      return [entry.videoUrl || '', entry.protectedUrl || '', entry._originVideoUrl || ''].join('|');
    }).join('\n');
    return before !== after;
  }

  function _scheduleTimelineVideoUrlHydration() {
    if (!_timelineVideoUrlsNeedRefresh()) return;
    var runId = ++_videoUrlHydrationRunId;
    var promise = _hydrateTimelineVideoUrls();
    _videoUrlHydrationPromise = promise;
    promise.then(function (changed) {
      if (runId !== _videoUrlHydrationRunId) return;
      _videoUrlHydrationPromise = null;
      if (changed && (!_ctx.getActivePage || _ctx.getActivePage() === "edit")) {
        _initDoubleBuffer();
      }
    }).catch(function (err) {
      if (runId !== _videoUrlHydrationRunId) return;
      _videoUrlHydrationPromise = null;
      console.warn("[Edit] video URL hydrate failed:", err);
    });
  }

  function _entryForPersistence(entry) {
    var out = Object.assign({}, entry || {});
    out.videoUrl = _segPersistedVideoUrl(entry);
    delete out._originVideoUrl;
    delete out.protectedUrl;
    return out;
  }

  function _edlForPersistence(edl) {
    if (!edl || typeof edl !== 'object') return edl;
    var out = Object.assign({}, edl);
    out.timeline = Array.isArray(edl.timeline) ? edl.timeline.map(_entryForPersistence) : [];
    return out;
  }

  function _getEditSegments() {
    if (!project || !project.storyboards) return [];
    var groups = _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : [];
    var segs = [];
    for (var gi = 0; gi < groups.length; gi++) {
	      var g = groups[gi];
	      var sb = (project.storyboards && project.storyboards[gi]) || {};
	      if (!sb.videoUrl) continue;
	      var vt = Array.isArray(project.videoTasks) ? project.videoTasks[gi] : null;
	      if (sb.videoIsCurrent === false || (vt && vt.isCurrent === false)) continue;
	      if (sb.importedToEdit !== true) continue;
      var shots = g.shots || [];
      var dur = _resolveGroupImportDuration(gi);
      segs.push({
        groupIdx: g.groupIdx != null ? g.groupIdx : gi,
        videoUrl: sb.videoUrl,
        protectedUrl: _segPersistedVideoUrl(sb),
        _originVideoUrl: _segPersistedVideoUrl(sb),
        thumbnailUrl: sb.imageUrl || sb.rawUrl || "",
        shotIndices: g.shotIndices || [],
        duration: dur || 5,
        shots: shots,
      });
    }
    segs.sort(function (a, b) { return (a.groupIdx || 0) - (b.groupIdx || 0); });
    return segs;
  }

  // E-5：`_migrateImportedToEditFlag` 迁移到后端。
  // 旧实现在前端把 "有 videoUrl 却没 importedToEdit" 的老数据补成 True，并触发
  // saveProject() 整包 PUT 写盘——这既踩坑"前端写 storyboard 权威字段"（Phase
  // 5.13 已经把这些字段划到后端权威），又让首次打开剪辑页就白白发一次 PUT。
  // 现在由后端 `_hydrate_imported_to_edit_defaults` 在 GET /api/projects/{id}
  // 返回前纯 hydrate 补齐（不写盘），磁盘旧数据下次被 `apply_edit_patch_and_save`
  // 写盘时自然补齐。前端完全不用管。

  // E-4.2：剪辑时间线细粒度 PATCH 的前端入口。每次 mutation 走同一条路径，
  // 失败时走 onError 回滚 + 强同步。成功时推进 project.version，避免 PUT 409。
  function _sendTimelineOp(body, onError) {
    if (!project || !project.id) return Promise.resolve(null);
    var payload = Object.assign({ projectId: project.id }, body || {});
    return apiPost("/api/edit/timeline", payload).then(async function (resp) {
      if (!resp || !resp.ok) {
        var msg = (resp && resp.error) || "保存失败";
        if (onError) try { onError(msg); } catch (_e) {}
        showToast("保存失败: " + _diagnoseApiError(msg), "error");
        // 强同步：mutation 撞车 / 越界 / 非法时，后端权威态和内存乐观更新已经
        // 分叉——拉一次 GET /api/projects/{id}，把 editData 回灌内存，盖掉本地
        // edl / importedToEdit 的脏态。这里刻意不整包 reload 项目（那样会跳页），
        // 只同步剪辑相关字段。
        _resyncEditDataFromServer();
        return null;
      }
      // 成功：推进版本，更新内存 edl 以后端返回为准（覆盖本地乐观更新里的细节，保持一致）。
      if (resp.serverVersion != null && _ctx.bumpProjectVersion) {
        _ctx.bumpProjectVersion(resp.serverVersion);
      }
      if (resp.edl && project) {
        await _hydrateEdlVideoUrls(resp.edl);
        _editState.edl = resp.edl;
        if (!project.editData) project.editData = {};
        project.editData.edl = resp.edl; // arch-guard:allow-editdata 内存镜像（后端已权威落盘）
      }
      // 剪辑 gate 全景镜像：每次 mutation 后端都回 `readiness`，前端只抄写。
      // 这保证 guard 显示 / 导出按钮亮灭 / 素材库状态条的判定和后端规则
      // （services/edit_timeline_gate.project_edit_readiness）100% 同步。
      if (resp.readiness && project) {
        if (!project.editData) project.editData = {};
        project.editData.readiness = resp.readiness; // arch-guard:allow-editdata gate 全景镜像（只读）
      }
      _syncEditExportButtonState();
      return resp;
    }).catch(function (err) {
      var m = (err && err.message) || "网络错误";
      if (onError) try { onError(m); } catch (_e) {}
      showToast("保存失败: " + _diagnoseApiError(m), "error");
      return null;
    });
  }

  function isGroupImported(groupIdx) {
    if (!project || !Array.isArray(project.storyboards)) return false;
    if (groupIdx == null) return false;
    var sb = project.storyboards[groupIdx];
    return !!(sb && sb.importedToEdit === true);
  }

  function _positiveDurationSec(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
  }

  function _completedVideoStatus(value) {
    var status = String(value || "").toLowerCase();
    return status === "completed" || status === "done";
  }

  function _currentMatchedVideoTask(groupIdx) {
    var sb = (project && Array.isArray(project.storyboards)) ? project.storyboards[groupIdx] : null;
    var vt = (project && Array.isArray(project.videoTasks)) ? project.videoTasks[groupIdx] : null;
    if (!sb || !vt) return null;
    var sbTaskId = String(sb.videoTaskId || "");
    var vtTaskId = String(vt.taskId || "");
    if (!sbTaskId || !vtTaskId || sbTaskId !== vtTaskId) return null;
    if (sb.videoIsCurrent === false || vt.isCurrent === false) return null;
    if (!_completedVideoStatus(vt.status)) return null;
    return vt;
  }

  function _shotDurationForEdit(shot) {
    var n = Number(shot && (shot.duration != null ? shot.duration : shot.durationSec));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 4;
  }

  function _sumProjectShotDurationsForGroup(sb) {
    if (!project || !Array.isArray(project.shots) || !Array.isArray(sb && sb.shotIndices) || !sb.shotIndices.length) return 0;
    var total = 0;
    sb.shotIndices.forEach(function (value) {
      var idx = Number(value);
      if (!Number.isInteger(idx) || idx < 0 || !project.shots[idx]) return;
      total += _shotDurationForEdit(project.shots[idx]);
    });
    return _positiveDurationSec(total);
  }

  function _sumGroupShotDurations(groupIdx) {
    var groups = _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : [];
    var g = groups[groupIdx];
    if (!g || !Array.isArray(g.shots) || !g.shots.length) return 0;
    var dur = 0;
    g.shots.forEach(function (s) { dur += _shotDurationForEdit(s); });
    return _positiveDurationSec(dur);
  }

  function _resolveTrustedActualDuration(groupIdx) {
    var sb = (project && Array.isArray(project.storyboards)) ? project.storyboards[groupIdx] : null;
    if (!sb) return 0;
    var storyboardDuration = _positiveDurationSec(sb.videoDurationSec);
    if (storyboardDuration > 0) return storyboardDuration;
    var vt = _currentMatchedVideoTask(groupIdx);
    return vt ? _positiveDurationSec(vt.durationSec != null ? vt.durationSec : vt.duration_sec) : 0;
  }

  function _resolveGroupImportDuration(groupIdx) {
    var sb = (project && Array.isArray(project.storyboards)) ? project.storyboards[groupIdx] : null;
    if (!sb) return 5;
    var trustedActual = _resolveTrustedActualDuration(groupIdx);
    if (trustedActual > 0) return trustedActual;
    var plannedDuration = _positiveDurationSec(sb.plannedDurationSec);
    if (plannedDuration > 0) return plannedDuration;
    var storyboardDuration = _positiveDurationSec(sb.durationSec != null ? sb.durationSec : sb.duration);
    if (storyboardDuration > 0) return storyboardDuration;
    var projectShotDuration = _sumProjectShotDurationsForGroup(sb);
    if (projectShotDuration > 0) return projectShotDuration;
    var groupShotDuration = _sumGroupShotDurations(groupIdx);
    if (groupShotDuration > 0) return groupShotDuration;
    return 5;
  }

  function _sumGroupDuration(groupIdx) {
    return _resolveGroupImportDuration(groupIdx);
  }

  /** 把 _editState.edl.timeline 里"陈旧的 duration / outPoint"修正到当前
   * sb.videoDurationSec —— 解决"老 timeline 写了 5s 段长但实际视频是 10s"的错位。
   * 只动 inPoint=0 的段（用户手剪过的不动）。 */
  function _repairTimelineDurations() {
    if (!_editState.edl || !Array.isArray(_editState.edl.timeline)) return false;
    if (!project || !Array.isArray(project.storyboards)) return false;
    var changed = false;
    _editState.edl.timeline.forEach(function (item) {
      if (!item || item.groupIdx == null) return;
      var realDur = _resolveTrustedActualDuration(item.groupIdx);
      if (!realDur) return;
      var curDur = Number(item.duration) || 0;
      if (Math.abs(curDur - realDur) < 0.05) return;
      if (!item.inPoint || Number(item.inPoint) === 0) {
        item.duration = realDur;
        item.outPoint = realDur;
        changed = true;
      }
    });
    return changed;
  }

  function importGroupToTimeline(groupIdx) {
    if (!project || !Array.isArray(project.storyboards)) return false;
    if (groupIdx == null || groupIdx < 0) return false;
    if (!project.storyboards[groupIdx]) project.storyboards[groupIdx] = {};
    var sb = project.storyboards[groupIdx];
    if (!sb.videoUrl) return false;

    // E-4.3：import-group 现在由后端原子执行：同时翻 storyboards[idx].importedToEdit=true
    // 和把片段追加进 editData.edl.timeline。前端做内存乐观更新保证即时 UI 反馈，
    // 网络失败时 _sendTimelineOp 会 toast 并由 refreshEditPage 拉回权威态。
    sb.importedToEdit = true; // arch-guard:allow-imported-to-edit 乐观更新（后端 /api/edit/timeline import-group 权威翻转）
    if (_editState.edl && Array.isArray(_editState.edl.timeline)) {
      var exists = _editState.edl.timeline.some(function (e) {
        return e && e.groupIdx === groupIdx;
      });
      if (!exists) {
        var dur = _sumGroupDuration(groupIdx);
        _editState.edl.timeline.push({
          groupIdx: groupIdx,
          videoUrl: sb.videoUrl,
          protectedUrl: _segPersistedVideoUrl(sb),
          _originVideoUrl: _segPersistedVideoUrl(sb),
          inPoint: 0,
          outPoint: dur,
          duration: dur,
          transitionIn: { type: "cut", duration: 0 },
        });
        _editState.edl.timeline.sort(function (a, b) {
          return (a.groupIdx || 0) - (b.groupIdx || 0);
        });
        if (!project.editData) project.editData = {};
        project.editData.edl = _editState.edl; // arch-guard:allow-editdata 乐观更新（后端权威落盘）
      }
    }

    if (_editState.edl && Array.isArray(_editState.edl.timeline)) {
      var trustedDur = _resolveTrustedActualDuration(groupIdx);
      _editState.edl.timeline.forEach(function (entry) {
        if (!entry || entry.groupIdx !== groupIdx) return;
        entry.videoUrl = sb.videoUrl;
        entry.protectedUrl = _segPersistedVideoUrl(sb);
        entry._originVideoUrl = _segPersistedVideoUrl(sb);
        if (trustedDur > 0 && (!entry.inPoint || Number(entry.inPoint) === 0)) {
          entry.duration = trustedDur;
          entry.outPoint = trustedDur;
        }
      });
      if (!project.editData) project.editData = {};
      project.editData.edl = _editState.edl; // arch-guard:allow-editdata 乐观更新（后端权威落盘）
    }

    _sendTimelineOp({ op: "import-group", groupIdx: groupIdx }).then(function (resp) {
      if (resp && _ctx.getActivePage && _ctx.getActivePage() === "edit") {
        try { refreshEditPage(); } catch (_e) {}
      }
    });

    if (_ctx.getActivePage && _ctx.getActivePage() === "edit") {
      try { refreshEditPage(); } catch (_e) {}
    }
    return true;
  }

  function removeGroupFromTimeline(groupIdx) {
    if (!project || !Array.isArray(project.storyboards)) return false;
    if (groupIdx == null || groupIdx < 0) return false;
    var sb = project.storyboards[groupIdx];
    if (sb) sb.importedToEdit = false; // arch-guard:allow-imported-to-edit 乐观更新（后端 remove-group 权威翻转）

    if (_editState.edl && Array.isArray(_editState.edl.timeline)) {
      _editState.edl.timeline = _editState.edl.timeline.filter(function (e) {
        return !(e && e.groupIdx === groupIdx);
      });
      if (!project.editData) project.editData = {};
      project.editData.edl = _editState.edl; // arch-guard:allow-editdata 乐观更新（后端权威落盘）
    }

    _sendTimelineOp({ op: "remove-group", groupIdx: groupIdx });

    if (_ctx.getActivePage && _ctx.getActivePage() === "edit") {
      try { refreshEditPage(); } catch (_e) {}
    }
    return true;
  }

  function _renderEditGuardHint(readiness) {
    // 动态引导文案，根据后端 readiness 下发的 readyCount / totalCount 区分场景：
    //   - readyCount=0, totalCount=0  新项目，还没生成过视频
    //   - readyCount=0, totalCount>0  所有视频都还没做好
    //   - readyCount>=1               有视频已就绪，等用户去点「导入剪辑工作台」
    // 规则判定一律由后端算，前端只选文案；不存在"前端自己推断还差几条"。
    var el = $("editGuardHint");
    if (!el) return;
    if (!readiness) {
      el.innerHTML =
        '在「片段生成」页任意一条生成成功的视频卡片上，点「导入剪辑工作台」即可。';
      return;
    }
    var ready = readiness.readyCount | 0;
    var total = readiness.totalCount | 0;
    if (ready >= 1) {
      el.innerHTML =
        '你已经有 <span class="text-on-background font-semibold">' + ready + '</span> 条视频就绪。' +
        '<br/>回「片段生成」页，在想用的视频卡片上点「导入剪辑工作台」即可开剪。';
    } else if (total >= 1) {
      el.innerHTML =
        '所有视频还在生成中。<br/>' +
        '任意一条视频生成成功后，就可以在卡片上点「导入剪辑工作台」开始剪辑，<br/>' +
        '不必等全部生成完。';
    } else {
      el.innerHTML =
        '还没有可用的视频片段。<br/>' +
        '先去「片段生成」页生成至少一条视频，之后在卡片上点「导入剪辑工作台」。';
    }
  }

  function refreshEditPage() {
    // E-5：importedToEdit 默认值由后端 hydrate（GET /api/projects/{id} 在返回前
    // 给 videoUrl 已存在但缺字段的 storyboard 补 True），前端无须再跑迁移。
    //
    // 剪辑 gate：是否解锁工作台 / guard 文案如何引导，全部由后端
    // services/edit_timeline_gate.project_edit_readiness 算出的
    // `project.editData.readiness` 字段决定。前端这里只负责把字段翻译成 UI 态，
    // 不自己算"什么时候能进剪辑"。_getEditSegments() 仍保留作为"时间线上真实
    // 可用的片段"—— 它读的 `importedToEdit === true` 本身也是后端权威字段。
    var guard = $("editGuard");
    var workspace = $("editWorkspace");
    _syncOnlineEditorEntries();
    var readiness = (project && project.editData && project.editData.readiness) || null;
    var canEnter = readiness ? readiness.canEnterEdit === true : false;
    var segments = _getEditSegments();
    _editState.segments = segments;

    // canEnter 为权威源，但做一层兜底：readiness 字段还没下发时（新项目 / 旧
    // 磁盘数据 + 未触发 GET），用本地 segments 判定避免死锁。
    var hasImported = canEnter || segments.length > 0;

    if (!hasImported) {
      if (guard) guard.hidden = false;
      if (workspace) workspace.hidden = true;
      _renderEditGuardHint(readiness);
      _syncUndoRedoButtons();
      return;
    }
    if (guard) guard.hidden = true;
    if (workspace) workspace.hidden = false;

    if (project && project.editData && project.editData.segmentTags) {
      _editState.segmentTags = project.editData.segmentTags;
      _renderEditTags();
      var btnEdl = $("btnEditGenEdl");
      if (btnEdl) btnEdl.disabled = false;
    }
    if (project && project.editData && project.editData.edl) {
      _editState.edl = project.editData.edl;
      // 老 timeline 数据可能用错误的 _sumGroupDuration（按 shots 累加 = 5）写入了
      // duration / outPoint，但实际视频是 10s。这里用 sb.videoDurationSec 一次性纠正，
      // 让段长立即变成真实视频时长。
      _repairTimelineDurations();
      var btnEdl2 = $("btnEditGenEdl");
      if (btnEdl2) btnEdl2.disabled = false;
    }
    _syncEditExportButtonState();
    var btnAutoCompose = $("btnEditAutoCompose");
    if (btnAutoCompose) {
      btnAutoCompose.disabled = !(segments.length > 0) || !!_editActionBusy.btnEditAutoCompose;
    }

    if (_editState.edl && _editState._undoStack.length === 0) {
      _editSaveUndo();
    } else {
      _syncUndoRedoButtons();
    }

    _buildSegStartTimes();
    _renderEditTimeline();
    _updateEditTimeDisplay();

    _initDoubleBuffer();
    _scheduleTimelineVideoUrlHydration();

    _loadUploadedMedia().then(function () { _renderMediaLibrary(); });
    _renderMediaLibrary();

    // 刷新时也要把 BGM 选择器渲出来——之前只在 _analyzeEditSegments / _generateEditEdl
    // 之后才 render，导致用户刷新页面就完全看不到 BGM 区域，反馈"刷新后没看到 bgm"。
    _renderBgmSelector();
    _renderBgmStatus();
    _renderTransitionPanel();
    _wireTransitionControls();

    // 刷新进来如果 EDL 已明确打开 BGM，把 audio 元素 src 同步上，但不 autoplay
    // （等用户按播放才起播）。这样用户一进剪辑页就有正确的 BGM 状态。
    if (_editState.edl && _editState.edl.bgm && _editState.edl.bgm.enabled === true && _editState.edl.bgm.trackId) {
      setTimeout(_syncBgmPlayback, 0);
    }

    // E-2.2：若上一次导出任务尚未完成（editData.exportTaskId 有值且无 exportUrl），
    // 刷新回来时自动重订 SSE，保证"刷新不丢状态"宪法。
    _tryResumeExportStream();
  }

  function _timelineTransitionGapPx() {
    var el = $("editTimelineArea") || document.documentElement;
    if (!el || typeof getComputedStyle !== "function") return 36;
    var raw = getComputedStyle(el).getPropertyValue("--edit-transition-gap");
    var px = parseFloat(raw || "36");
    return Number.isFinite(px) ? px : 36;
  }

  function _timelineContentWidth(totalDur, pps, segCount) {
    var gaps = Math.max(0, (segCount || 0) - 1) * _timelineTransitionGapPx();
    return Math.max((totalDur || 0) * pps + gaps + 100, 600);
  }

  function _timelineDurationWidth(duration, pps) {
    return Math.max((duration || 0) * pps, 2);
  }

  function _timelineStarts(segs) {
    var starts = [];
    var t = 0;
    (segs || []).forEach(function (seg) {
      starts.push(t);
      t += _segDuration(seg);
    });
    return { starts: starts, totalDur: t };
  }

  function _timelineBoundaryCountForTime(time, starts) {
    var count = 0;
    var t = Math.max(0, Number(time) || 0);
    (starts || []).forEach(function (start, i) {
      if (i > 0 && t >= start - 0.001) count = i;
    });
    return count;
  }

  function _timelineSegmentLeft(start, index, pps) {
    return (Number(start) || 0) * pps + Math.max(0, Number(index) || 0) * _timelineTransitionGapPx();
  }

  function _timelineTransitionCenter(start, index, pps) {
    return (Number(start) || 0) * pps + (Math.max(1, Number(index) || 1) - 0.5) * _timelineTransitionGapPx();
  }

  function _timelineTimeToX(time, pps, starts) {
    return Math.max(0, Number(time) || 0) * pps + _timelineBoundaryCountForTime(time, starts) * _timelineTransitionGapPx();
  }

  function _timelineXToTime(x, pps, segs, starts) {
    var px = Math.max(0, Number(x) || 0);
    var list = segs || [];
    var st = starts || _timelineStarts(list).starts;
    if (!list.length || !(pps > 0)) return 0;

    for (var i = 0; i < list.length; i++) {
      var left = _timelineSegmentLeft(st[i] || 0, i, pps);
      var right = left + _timelineDurationWidth(_segDuration(list[i]), pps);
      if (px < left) return st[i] || 0;
      if (px <= right) return (st[i] || 0) + (px - left) / pps;
    }
    var lastIdx = list.length - 1;
    return (st[lastIdx] || 0) + _segDuration(list[lastIdx]);
  }

  function _timelineInsertIndexFromClientX(clientX, trackEl) {
    var list = _getTimelineSegs();
    if (!list || !list.length) return 0;
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var starts = (_editState.segStartTimes && _editState.segStartTimes.length === list.length)
      ? _editState.segStartTimes
      : _timelineStarts(list).starts;
    var track = trackEl || $("editVideoTrack");
    if (!track || !track.getBoundingClientRect) return list.length;
    var x = clientX - track.getBoundingClientRect().left;
    for (var i = 0; i < list.length; i++) {
      var left = _timelineSegmentLeft(starts[i] || 0, i, pps);
      var right = left + _timelineDurationWidth(_segDuration(list[i]), pps);
      if (x <= (left + right) / 2) return i;
    }
    return list.length;
  }

  function _timelineInsertSlotX(insertIndex, list, starts, pps) {
    var segs = list || _getTimelineSegs();
    if (!segs || !segs.length) return 0;
    var idx = Math.max(0, Math.min(Number(insertIndex) || 0, segs.length));
    var st = (starts && starts.length === segs.length) ? starts : _timelineStarts(segs).starts;
    var gap = _timelineTransitionGapPx();
    if (idx <= 0) return _timelineSegmentLeft(st[0] || 0, 0, pps);
    if (idx >= segs.length) {
      var lastIdx = segs.length - 1;
      var lastLeft = _timelineSegmentLeft(st[lastIdx] || 0, lastIdx, pps);
      return lastLeft + _timelineDurationWidth(_segDuration(segs[lastIdx]), pps) + gap / 2;
    }
    return _timelineTransitionCenter(st[idx] || 0, idx, pps);
  }

  function _timelineEntryDisplayNo(entry, fallbackIndex) {
    var raw = entry && entry.groupIdx != null ? Number(entry.groupIdx) : Number(fallbackIndex);
    if (!Number.isInteger(raw)) raw = Number(fallbackIndex) || 0;
    return String(raw + 1);
  }

  function _timelineInsertSlotLabel(insertIndex, list) {
    var segs = list || _getTimelineSegs();
    var len = segs ? segs.length : 0;
    if (!len) return "插入到 V1";
    var idx = Math.max(0, Math.min(Number(insertIndex) || 0, len));
    if (idx <= 0) return "插入到 " + _timelineEntryDisplayNo(segs[0], 0) + " 前";
    if (idx >= len) return "插入到 " + _timelineEntryDisplayNo(segs[len - 1], len - 1) + " 后";
    return "插入到 " + _timelineEntryDisplayNo(segs[idx - 1], idx - 1) +
      " 与 " + _timelineEntryDisplayNo(segs[idx], idx) + " 之间";
  }

  function _clearTimelineInsertAdjacency(track) {
    var root = track || $("editVideoTrack");
    if (!root) return;
    root.querySelectorAll(".edit-segment-block").forEach(function (block) {
      block.classList.remove("edit-seg-insert-before", "edit-seg-insert-after");
    });
  }

  function _ensureTimelineInsertCue(track) {
    var root = track || $("editVideoTrack");
    if (!root) return null;
    var cue = root.querySelector(".edit-timeline-insert-cue");
    if (!cue) {
      cue = document.createElement("div");
      cue.className = "edit-timeline-insert-cue";
      cue.hidden = true;
      cue.innerHTML =
        '<span class="edit-timeline-insert-cue__label"></span>' +
        '<span class="edit-timeline-insert-cue__line" aria-hidden="true"></span>';
      root.appendChild(cue);
    }
    return cue;
  }

  function _showTimelineInsertCue(insertIndex, track) {
    var root = track || $("editVideoTrack");
    if (!root) return;
    var segs = _getTimelineSegs();
    var len = segs ? segs.length : 0;
    var idx = Math.max(0, Math.min(Number(insertIndex) || 0, len));
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var starts = (_editState.segStartTimes && _editState.segStartTimes.length === len)
      ? _editState.segStartTimes
      : _timelineStarts(segs || []).starts;
    var cue = _ensureTimelineInsertCue(root);
    if (!cue) return;
    var x = _timelineInsertSlotX(idx, segs || [], starts, pps);
    cue.style.left = x + "px";
    cue.dataset.insertIndex = String(idx);
    cue.dataset.edge = idx <= 0 ? "start" : (idx >= len ? "end" : "middle");
    var label = cue.querySelector(".edit-timeline-insert-cue__label");
    if (label) label.textContent = _timelineInsertSlotLabel(idx, segs || []);
    cue.hidden = false;
    root.classList.add("edit-video-track--drop-active");
    _clearTimelineInsertAdjacency(root);
    var blocks = root.querySelectorAll(".edit-segment-block");
    if (idx > 0 && blocks[idx - 1]) blocks[idx - 1].classList.add("edit-seg-insert-after");
    if (idx < blocks.length && blocks[idx]) blocks[idx].classList.add("edit-seg-insert-before");
  }

  function _hideTimelineInsertCue(track) {
    var root = track || $("editVideoTrack");
    if (!root) return;
    root.classList.remove("edit-video-track--drop-active");
    _clearTimelineInsertAdjacency(root);
    var cue = root.querySelector(".edit-timeline-insert-cue");
    if (cue) cue.hidden = true;
  }

  function _normalizeTimelineInsertIndex(insertIndex) {
    var len = (_editState.edl && Array.isArray(_editState.edl.timeline)) ? _editState.edl.timeline.length : 0;
    var n = Number(insertIndex);
    if (!Number.isInteger(n)) return len;
    return Math.max(0, Math.min(n, len));
  }

  function _nextExternalMediaGroupIdx() {
    var tl = (_editState.edl && Array.isArray(_editState.edl.timeline)) ? _editState.edl.timeline : [];
    var max = 899;
    tl.forEach(function (entry) {
      var g = Number(entry && entry.groupIdx);
      if (Number.isInteger(g) && g >= 900 && g > max) max = g;
    });
    return max + 1;
  }

  function _setTimelineContentWidth(width) {
    _setTimelineTrackWidth($("editTimelineContent"), width);
  }

  function _setTimelineTrackWidth(el, width) {
    if (!el) return;
    el.style.width = width + "px";
    el.style.minWidth = width + "px";
  }

  function _timelineOriginX(scrollEl) {
    var el = scrollEl || $("editTimelineScroll");
    if (!el || typeof getComputedStyle !== "function") return 0;
    var style = getComputedStyle(el);
    var px = parseFloat(style.paddingLeft || "0");
    return Number.isFinite(px) ? px : 0;
  }

  function _syncTimelineScrollLayers(scrollEl) {
    var scroll = scrollEl || $("editTimelineScroll");
    var x = scroll ? scroll.scrollLeft || 0 : 0;
    var tx = "translateX(" + (-x) + "px)";
    var rulerCanvas = $("editRuler");
    if (rulerCanvas) rulerCanvas.style.transform = tx;
  }

  function _renderEditTimeline() {
    var track = $("editVideoTrack");
    if (!track) return;
    track.innerHTML = "";

    var segs = _editState.edl ? _editState.edl.timeline : _editState.segments;
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var timing = _timelineStarts(segs);
    var starts = timing.starts;
    var totalDur = timing.totalDur;
    var contentW = _timelineContentWidth(totalDur, pps, segs.length);

    // 任意时间线变化都顺手刷新右侧"转场控制"面板的统计 + 按钮可用态
    if (typeof _renderTransitionPanel === "function") _renderTransitionPanel();

    var PLOT_COLORS = {
      setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE",
      resolution: "#2C3E50", climax: "#0B1320",
    };

    _setTimelineContentWidth(contentW);
    _setTimelineTrackWidth(track, contentW);
    _syncTimelineScrollLayers();

    segs.forEach(function (seg, i) {
      var dur = _segDuration(seg);
      var w = _timelineDurationWidth(dur, pps);
      var left = _timelineSegmentLeft(starts[i], i, pps);
      var gIdx = seg.groupIdx != null ? seg.groupIdx : i;

      var tag = null;
      if (_editState.segmentTags && _editState.segmentTags.segments) {
        tag = _editState.segmentTags.segments.find(function (t) { return t.groupIdx === gIdx; });
      }
      var color = "#526168";
      if (tag && tag.plotRole && PLOT_COLORS[tag.plotRole]) color = PLOT_COLORS[tag.plotRole];

      /* transition marker */
      if (i > 0) {
        var trans = (seg.transitionIn && seg.transitionIn.type) || "cut";
        var transLabel = trans === "crossfade" ? "叠化" : trans === "fade_from_black" ? "淡入" : trans === "fade_to_black" ? "淡黑" : "硬切";
        var transEl = document.createElement("div");
        transEl.className = "edit-transition-marker" + (trans !== "cut" ? " edit-transition-marker--active" : "");
        transEl.title = "转场：" + transLabel + " · 点击切换";
        transEl.textContent = transLabel;
        transEl.style.left = _timelineTransitionCenter(starts[i], i, pps) + "px";
        (function (idx) {
          transEl.addEventListener("click", function (ev) { ev.stopPropagation(); _cycleTransition(idx); });
        })(i);
        track.appendChild(transEl);
      }

      /* segment block */
      var block = document.createElement("div");
      block.className = "edit-segment-block";
      block.style.width = w + "px";
      block.style.left = left + "px";
      block.style.top = "0";
      block.style.bottom = "0";
      block.style.borderColor = color;
      block.dataset.segIdx = i;
      block.title = "片段 " + (gIdx + 1) + " · " + dur.toFixed(1) + "s";

      /* filmstrip background */
      var filmstripHtml = '<div class="edit-seg-filmstrip" data-gidx="' + gIdx + '"></div>';

      /* waveform canvas */
      var waveformHtml = '<canvas class="edit-seg-waveform" data-gidx="' + gIdx + '" height="20"></canvas>';

      /* info overlay */
      var emotionHtml = "";
      if (tag) emotionHtml = '<span class="edit-seg-emotion">' + escapeHtml(tag.emotion || "") + '</span>';

      block.innerHTML =
        '<div class="edit-seg-color-bar" style="background:' + color + '"></div>' +
        filmstripHtml +
        '<div class="edit-seg-overlay">' +
          '<span class="edit-seg-label">' + (gIdx + 1) + '</span>' +
          emotionHtml +
          '<span class="edit-seg-dur">' + dur.toFixed(1) + 's</span>' +
        '</div>' +
        waveformHtml +
        '<div class="edit-trim-handle edit-trim-left" data-side="left"></div>' +
        '<div class="edit-trim-handle edit-trim-right" data-side="right"></div>' +
        '<button class="edit-seg-regen-btn" title="重新生成此片段" data-gidx="' + gIdx + '">&#x21bb;</button>' +
        '<button class="edit-seg-remove-btn" title="从剪辑工作台移除此片段" data-gidx="' + gIdx + '">&#x2715;</button>';

      /* drag reorder */
      block.setAttribute("draggable", "true");
      block.addEventListener("dragstart", function (ev) {
        if (ev.target.classList.contains("edit-trim-handle")) { ev.preventDefault(); return; }
        ev.dataTransfer.setData("text/plain", String(i));
        block.classList.add("opacity-50");
      });
      block.addEventListener("dragend", function () { block.classList.remove("opacity-50"); });
      block.addEventListener("dragover", function (ev) { ev.preventDefault(); block.style.outline = "2px solid #60a5fa"; });
      block.addEventListener("dragleave", function () { block.style.outline = ""; });
      block.addEventListener("drop", function (ev) {
        ev.preventDefault(); block.style.outline = "";
        var fromIdx = parseInt(ev.dataTransfer.getData("text/plain"), 10);
        if (fromIdx === i || isNaN(fromIdx)) return;
        _reorderEditSegment(fromIdx, i);
      });

      block.addEventListener("click", function (ev) {
        if (ev.target.classList.contains("edit-trim-handle")) return;
        _previewEditSegment(gIdx);
      });

      /* trim handles */
      _bindTrimHandle(block, seg, i, pps);

      /* regen button */
      var regenBtn = block.querySelector(".edit-seg-regen-btn");
      if (regenBtn) {
        (function (idx) {
          regenBtn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            _regenSegment(idx);
          });
        })(gIdx);
      }

      /* remove button —— 把此片段从剪辑工作台移除（不删原视频文件） */
      var removeBtn = block.querySelector(".edit-seg-remove-btn");
      if (removeBtn) {
        (function (idx) {
          removeBtn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            showConfirm(
              "移除片段 " + (idx + 1),
              "确定从剪辑工作台移除这个片段？\n（不会删除已生成的视频文件，可在片段页重新导入）",
              function () {
                removeGroupFromTimeline(idx);
                showToast("已移除片段 " + (idx + 1), "ok");
              }
            );
          });
        })(gIdx);
      }

      track.appendChild(block);
    });

    /* render tag track above video track */
    _renderTagTrack(segs, pps, starts, contentW);

    /* render time ruler */
    _renderTimeRuler(totalDur, pps, starts, segs);

    /* render filmstrips (async) */
    _renderAllFilmstrips(segs, pps);

    /* render waveforms (async) */
    _renderAllWaveforms(segs, pps);

    /* render BGM track */
    _renderBgmTrack(totalDur, pps, contentW, starts, segs);
  }

  /* ── Tag track (AI segment labels above video track) ── */

  var _TAG_PLOT_LABELS = { setup: "铺垫", rising: "递进", climax: "高潮", falling: "回落", resolution: "收尾" };
  var _TAG_PLOT_COLORS = { setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE", resolution: "#2C3E50", climax: "#0B1320" };

  function _renderTagTrack(segs, pps, starts, contentW) {
    var container = $("editTagTrack");
    if (!container) return;
    container.innerHTML = "";

    if (!_editState.segmentTags || !_editState.segmentTags.segments || !segs.length) {
      container.style.display = "none";
      return;
    }

    container.style.display = "block";
    var fallbackTiming = contentW ? null : _timelineStarts(segs);
    _setTimelineTrackWidth(container, contentW || _timelineContentWidth(fallbackTiming.totalDur, pps, segs.length));

    segs.forEach(function (seg, i) {
      var dur = _segDuration(seg);
      var w = _timelineDurationWidth(dur, pps);
      var left = _timelineSegmentLeft((starts && starts[i] != null) ? starts[i] : _timelineStarts(segs).starts[i], i, pps);
      var gIdx = seg.groupIdx != null ? seg.groupIdx : i;

      var tag = _editState.segmentTags.segments.find(function (t) { return t.groupIdx === gIdx; });
      var block = document.createElement("div");
      block.className = "edit-tag-block";
      block.style.width = w + "px";
      block.style.left = left + "px";

      if (tag) {
        var color = _TAG_PLOT_COLORS[tag.plotRole] || "#526168";
        var plotLabel = _TAG_PLOT_LABELS[tag.plotRole] || "";
        var isDark = tag.plotRole === "climax" || tag.plotRole === "resolution" || tag.plotRole === "falling";
        var badgeBg = isDark ? color : color + "40";
        var badgeText = isDark ? "#CFD8DC" : "#2C3E50";

        block.style.borderBottomColor = color;
        block.innerHTML =
          '<span class="edit-tag-badge" style="background:' + badgeBg + ';color:' + badgeText + '">' + escapeHtml(plotLabel) + '</span>' +
          '<span class="edit-tag-emotion">' + escapeHtml(tag.emotion || "") + '</span>';
      } else {
        block.innerHTML = '<span class="edit-tag-emotion" style="opacity:0.3">片段 ' + (gIdx + 1) + '</span>';
      }

      container.appendChild(block);
    });
  }

  /* ── Trim handle interaction ── */

  function _bindTrimHandle(block, seg, segIdx, pps) {
    var handles = block.querySelectorAll(".edit-trim-handle");
    handles.forEach(function (handle) {
      var side = handle.dataset.side;
      handle.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        block.setAttribute("draggable", "false");

        if (!_editState.edl || !_editState.edl.timeline) return;
        _editSaveUndo();
        var item = _editState.edl.timeline[segIdx];
        if (!item) return;

        var origSeg = _editState.segments.find(function (s) { return s.groupIdx === (item.groupIdx != null ? item.groupIdx : segIdx); });
        var maxDur = (origSeg && origSeg.duration) || item.duration || 10;
        var startX = ev.clientX;
        var startIn = item.inPoint || 0;
        var startOut = item.outPoint != null ? item.outPoint : maxDur;

        function onMove(me) {
          var dx = me.clientX - startX;
          var dt = dx / pps;

          if (side === "left") {
            var newIn = Math.max(0, Math.min(startIn + dt, startOut - 0.5));
            item.inPoint = Math.round(newIn * 10) / 10;
          } else {
            var newOut = Math.max((item.inPoint || 0) + 0.5, Math.min(startOut + dt, maxDur));
            item.outPoint = Math.round(newOut * 10) / 10;
          }
          item.duration = (item.outPoint || maxDur) - (item.inPoint || 0);

          var newW = _timelineDurationWidth(item.duration, pps);
          block.style.width = newW + "px";
          var durEl = block.querySelector(".edit-seg-dur");
          if (durEl) durEl.textContent = item.duration.toFixed(1) + "s";

          var vid = _getActiveVid();
          if (vid) vid.currentTime = side === "left" ? (item.inPoint || 0) : (item.outPoint || maxDur);
        }

        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          block.setAttribute("draggable", "true");
          // E-4.2：trim 收尾走 PATCH /api/edit/timeline，内存乐观更新已完成，
          // 这里只把最终 inPoint/outPoint 推给后端。失败时 _sendTimelineOp 内
          // 会 toast + 后续 refresh 拉回权威态。
          _sendTimelineOp({
            op: "trim",
            segIdx: segIdx,
            inPoint: item.inPoint,
            outPoint: item.outPoint,
          });
          _buildSegStartTimes();
          _updateEditTimeDisplay();
        }

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  /* ── Filmstrip thumbnails (uses independent temp videos, never touches the play pool) ── */

  var _filmstripQueue = [];
  var _filmstripBusy = false;

  function _renderAllFilmstrips(segs, pps) {
    _filmstripQueue = [];
    segs.forEach(function (seg, i) {
      var gIdx = seg.groupIdx != null ? seg.groupIdx : i;
      var dur = _segDuration(seg);
      var w = _timelineDurationWidth(dur, pps);
      var thumbCount = Math.max(1, Math.floor(w / 50));

      var container = document.querySelector('.edit-seg-filmstrip[data-gidx="' + gIdx + '"]');
      if (!container) return;
      container.style.width = w + "px";

      if (_editState._thumbCache[gIdx] && _editState._thumbCache[gIdx].length >= thumbCount) {
        _fillFilmstrip(container, _editState._thumbCache[gIdx], thumbCount);
        return;
      }

      var url = _segVideoUrl(seg, i);
      if (!url) return;
      _filmstripQueue.push({ gIdx: gIdx, url: url, seg: seg, dur: dur, thumbCount: thumbCount, container: container });
    });
    _processFilmstripQueue();
  }

  function _processFilmstripQueue() {
    if (_filmstripBusy || !_filmstripQueue.length) return;
    _filmstripBusy = true;
    var job = _filmstripQueue.shift();

    var tmpVid = document.createElement("video");
    tmpVid.preload = "auto";
    tmpVid.muted = true;
    tmpVid.crossOrigin = "anonymous";
    tmpVid.src = job.url;

    var inPt = job.seg.inPoint || 0;
    var outPt = job.seg.outPoint != null ? job.seg.outPoint : job.dur;
    var step = (outPt - inPt) / job.thumbCount;
    var thumbs = [];
    var canvas = document.createElement("canvas");
    canvas.width = 80; canvas.height = 60;
    var ctx = canvas.getContext("2d");
    var idx = 0;

    function captureNext() {
      if (idx >= job.thumbCount) {
        _editState._thumbCache[job.gIdx] = thumbs;
        _fillFilmstrip(job.container, thumbs, job.thumbCount);
        tmpVid.src = "";
        tmpVid = null;
        _filmstripBusy = false;
        _processFilmstripQueue();
        return;
      }
      var t = inPt + idx * step + step * 0.5;
      tmpVid.currentTime = t;
    }

    tmpVid.onseeked = function () {
      try {
        ctx.drawImage(tmpVid, 0, 0, 80, 60);
        thumbs.push(canvas.toDataURL("image/jpeg", 0.5));
      } catch (e) { thumbs.push(""); }
      idx++;
      captureNext();
    };

    tmpVid.onloadeddata = function () { captureNext(); };
    tmpVid.onerror = function () {
      _filmstripBusy = false;
      _processFilmstripQueue();
    };
    tmpVid.load();
  }

  function _fillFilmstrip(container, thumbs, count) {
    container.innerHTML = "";
    for (var j = 0; j < count && j < thumbs.length; j++) {
      if (!thumbs[j]) continue;
      var img = document.createElement("img");
      img.src = thumbs[j];
      img.className = "edit-filmstrip-frame";
      container.appendChild(img);
    }
  }

  /* ── Audio waveform (lazy, sequential, non-blocking) ── */

  var _waveformQueue = [];
  var _waveformBusy = false;

  function _renderAllWaveforms(segs, pps) {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    _waveformQueue = [];

    segs.forEach(function (seg, i) {
      var gIdx = seg.groupIdx != null ? seg.groupIdx : i;
      var dur = _segDuration(seg);
      var w = _timelineDurationWidth(dur, pps);

      var canvas = document.querySelector('.edit-seg-waveform[data-gidx="' + gIdx + '"]');
      if (!canvas) return;
      canvas.width = Math.round(w);
      canvas.style.width = w + "px";

      if (_editState._waveformCache[gIdx]) {
        _drawWaveform(canvas, _editState._waveformCache[gIdx]);
        return;
      }

      var url = _segVideoUrl(seg, i);
      if (!url) return;
      _waveformQueue.push({ gIdx: gIdx, url: url, canvas: canvas });
    });

    _processWaveformQueue();
  }

  function _processWaveformQueue() {
    if (_waveformBusy || !_waveformQueue.length) return;

    var schedule = window.requestIdleCallback || function (cb) { setTimeout(cb, 100); };
    schedule(function () {
      if (_waveformBusy || !_waveformQueue.length) return;
      _waveformBusy = true;
      var job = _waveformQueue.shift();

      fetch(job.url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        var ac = new (window.AudioContext || window.webkitAudioContext)();
        return ac.decodeAudioData(buf).then(function (audio) {
          var raw = audio.getChannelData(0);
          var blockSize = Math.floor(audio.sampleRate / 200);
          var peaks = new Float32Array(Math.ceil(raw.length / blockSize));
          for (var b = 0; b < peaks.length; b++) {
            var start = b * blockSize;
            var end = Math.min(start + blockSize, raw.length);
            var max = 0;
            for (var s = start; s < end; s++) {
              var abs = raw[s] < 0 ? -raw[s] : raw[s];
              if (abs > max) max = abs;
            }
            peaks[b] = max;
          }
          _editState._waveformCache[job.gIdx] = peaks;
          _drawWaveform(job.canvas, peaks);
          ac.close();
        });
      }).catch(function () {}).then(function () {
        _waveformBusy = false;
        _processWaveformQueue();
      });
    });
  }

  function _drawWaveform(canvas, peaks) {
    var ctx = canvas.getContext("2d");
    if (!ctx || !peaks.length) return;
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(96,165,250,0.35)";

    var step = peaks.length / w;
    for (var x = 0; x < w; x++) {
      var pi = Math.floor(x * step);
      var val = peaks[pi] || 0;
      var barH = val * h * 0.9;
      ctx.fillRect(x, h - barH, 1, barH);
    }
  }

  /* ── Time ruler ── */

  function _renderTimeRuler(totalDur, pps, starts, segs) {
    var rulerCanvas = $("editRuler");
    if (!rulerCanvas) return;
    var totalW = _timelineContentWidth(totalDur, pps, segs && segs.length);
    rulerCanvas.width = totalW;
    rulerCanvas.style.width = totalW + "px";

    var ctx = rulerCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, totalW, 24);

    var interval = 10;
    if (pps >= 60) interval = 5;
    if (pps >= 120) interval = 2;
    if (pps >= 200) interval = 1;
    if (pps < 15) interval = 30;

    ctx.fillStyle = "rgba(207,216,220,0.3)";
    ctx.font = "9px monospace";
    ctx.textBaseline = "top";

    for (var t = 0; t <= totalDur + interval; t += interval) {
      var x = _timelineTimeToX(t, pps, starts);
      ctx.fillRect(x, 14, 1, 10);
      ctx.fillText(_formatTime(t), x + 3, 2);
    }

    var subInterval = interval / 5;
    if (subInterval >= 0.2) {
      ctx.fillStyle = "rgba(207,216,220,0.1)";
      for (var st = 0; st <= totalDur + subInterval; st += subInterval) {
        var sx = _timelineTimeToX(st, pps, starts);
        ctx.fillRect(sx, 18, 1, 6);
      }
    }
  }

  /* ── BGM track visualization ── */

  function _renderBgmTrack(totalDur, pps, contentW, starts, segs) {
    var aTrack = $("editAudioTrack");
    if (!aTrack) return;
    aTrack.innerHTML = "";
    _setTimelineTrackWidth(aTrack, contentW || _timelineContentWidth(totalDur, pps, segs && segs.length));

    var bgm = _editState.edl && _editState.edl.bgm;
    if (!bgm || bgm.enabled !== true || !bgm.trackId) {
      aTrack.innerHTML = '<p class="text-[11px] text-white/10 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">BGM 轨道</p>';
      return;
    }

    var catalog = _bgmCatalogCache || [];
    var trackIdText = String(bgm.trackId || "").toLowerCase();
    var seedTrackFallbacks = {
      "hopeful_seed.mp3": { category: "hopeful", name: "希望 · 晨光" },
      "calm_seed.mp3": { category: "calm", name: "平静 · 海面" },
      "romantic_seed.mp3": { category: "romantic", name: "浪漫 · 旧木屋" },
      "tense_seed.mp3": { category: "tense", name: "紧张 · 追逐" },
      "action_seed.mp3": { category: "action", name: "动作 · 高速" },
      "sad_seed.mp3": { category: "sad", name: "悲伤 · 雨夜" },
      "epic_seed.mp3": { category: "epic", name: "史诗 · 旷野" },
      "mysterious_seed.mp3": { category: "mysterious", name: "神秘 · 雾林" }
    };
    var entry = catalog.find(function (t) { return t.id === bgm.trackId; }) || seedTrackFallbacks[trackIdText] || null;
    var name = entry ? entry.name : bgm.trackId;
    var categoryMatch = trackIdText.match(/^(hopeful|calm|romantic|mysterious|tense|action|epic|sad)(?:[_\-.]|$)/);
    var category = entry && entry.category ? String(entry.category).toLowerCase() : (categoryMatch ? categoryMatch[1] : "");
    var categoryClass = /^(hopeful|calm|romantic|mysterious|tense|action|epic|sad)$/.test(category)
      ? " edit-bgm-block--" + category
      : "";
    var bgmDur = (entry && entry.duration > 0) ? entry.duration : totalDur;
    if (!(bgmDur > 0)) bgmDur = totalDur || 1; // 防御：时长缺失/为 0 时退化成单段

    // BGM 循环铺到视频结尾、超出截断——与导出(-stream_loop -1 + -shortest)和
    // 预览(_bgmAudio.loop=true)的实际行为一致。首段带曲名+拖拽手柄；其后为循环
    // 重复段（弱化 + 接缝竖线），末段按视频结尾截断。视频短于一遍 BGM 时只画截断的首段。
    var offset = bgm.offsetTime || 0;
    var fillEnd = totalDur || 0;
    var tileCount = Math.min(500, Math.max(1, Math.ceil((fillEnd - offset) / bgmDur)));

    var fillW = Math.max(0, _timelineTimeToX(fillEnd, pps, starts) - _timelineTimeToX(offset, pps, starts));
    var strip = document.createElement("div");
    strip.style.display = "flex";
    strip.style.alignItems = "stretch";
    strip.style.height = "100%";
    strip.style.position = "absolute";
    strip.style.top = "0";
    strip.style.bottom = "0";
    strip.style.left = _timelineTimeToX(offset, pps, starts) + "px";
    strip.style.width = fillW + "px";

    for (var i = 0; i < tileCount; i++) {
      var tileStart = offset + i * bgmDur;
      if (tileStart >= fillEnd) break;
      var tileEnd = Math.min(tileStart + bgmDur, fillEnd); // 末段截断到视频结尾
      var tileW = Math.max(_timelineTimeToX(tileEnd, pps, starts) - _timelineTimeToX(tileStart, pps, starts), 2);

      var block = document.createElement("div");
      block.className = "edit-bgm-block" + categoryClass;
      if (category) block.dataset.bgmCategory = category;
      block.style.flex = "0 0 auto";
      block.style.width = tileW + "px";
      if (i > 0) {
        // 循环重复段：弱化 + 接缝竖线 + 循环图标
        block.style.opacity = "0.5";
        block.style.borderLeft = "1px dashed rgba(255,255,255,0.25)";
        block.style.justifyContent = "center";
        block.title = name + "（循环）";
        block.innerHTML = '<span class="material-symbols-outlined text-[11px] opacity-70">repeat</span>';
      } else {
        block.innerHTML = '<span class="material-symbols-outlined text-xs" style="font-variation-settings:\'FILL\' 1">music_note</span>' +
          '<span class="text-[10px] font-bold truncate">' + escapeHtml(name) + '</span>' +
          '<span class="text-[9px] opacity-50">' + _formatTime(bgmDur) + '</span>';
      }
      strip.appendChild(block);
    }

    // 拖拽整条 BGM 调 offset（保留原交互）：拖动改 offsetTime，松手 PATCH bgm-offset 并重铺。
    var dragStartX = 0;
    var dragStartOffset = 0;
    strip.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      dragStartX = ev.clientX;
      dragStartOffset = bgm.offsetTime || 0;

      function onMove(me) {
        var dx = me.clientX - dragStartX;
        var newOffset = Math.max(0, _timelineXToTime(_timelineTimeToX(dragStartOffset, pps, starts) + dx, pps, segs, starts));
        bgm.offsetTime = Math.round(newOffset * 10) / 10;
        strip.style.left = _timelineTimeToX(bgm.offsetTime, pps, starts) + "px";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // E-4.2：BGM 偏移拖动收尾 → PATCH bgm-offset；内存 bgm.offsetTime 已同步更新。
        _sendTimelineOp({ op: "bgm-offset", offsetTime: bgm.offsetTime || 0 });
        _renderBgmTrack(totalDur, pps, contentW, starts, segs); // 重铺，循环段跟随新 offset、末段重新截断
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    aTrack.appendChild(strip);
  }

  /* ── Undo / Redo ── */

  function _syncUndoRedoButtons() {
    var undoBtn = $("editUndoBtn");
    var redoBtn = $("editRedoBtn");
    var canUndo = _editState._undoPtr > 0;
    var canRedo = _editState._undoPtr >= 0 && _editState._undoPtr < _editState._undoStack.length - 1;
    if (undoBtn) {
      undoBtn.disabled = !canUndo;
      undoBtn.title = canUndo ? "撤销 (Ctrl+Z)" : "暂无可撤销操作";
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
      redoBtn.title = canRedo ? "恢复 (Ctrl+Shift+Z)" : "暂无可恢复操作";
    }
  }

  function _editSaveUndo() {
    if (!_editState.edl) {
      _syncUndoRedoButtons();
      return;
    }
    var snapshot = JSON.parse(JSON.stringify(_editState.edl));
    if (_editState._undoPtr < _editState._undoStack.length - 1) {
      _editState._undoStack.splice(_editState._undoPtr + 1);
    }
    _editState._undoStack.push(snapshot);
    if (_editState._undoStack.length > 50) _editState._undoStack.shift();
    _editState._undoPtr = _editState._undoStack.length - 1;
    _syncUndoRedoButtons();
  }

  function _editUndo() {
    if (_editState._undoPtr <= 0) { showToast("无法继续撤销", "warn"); return; }
    _editState._undoPtr--;
    var snap = JSON.parse(JSON.stringify(_editState._undoStack[_editState._undoPtr]));
    _editState.edl = snap;
    if (project) {
      if (!project.editData) project.editData = {};
      project.editData.edl = snap; // arch-guard:allow-editdata undo 内存镜像
    }
    // E-4.2：undo 用"整包 set-edl"op 推到后端——实现简单、后端无需理解具体差异，
    // 也避免了只改单字段时后端校验失败导致栈错位。
    _sendTimelineOp({ op: "set-edl", edl: _edlForPersistence(snap) });
    _buildSegStartTimes();
    _renderEditTimeline();
    _renderBgmStatus();
    _updatePlayhead();
    _syncUndoRedoButtons();
    showToast("已撤销", "ok");
  }

  function _editRedo() {
    if (_editState._undoPtr >= _editState._undoStack.length - 1) { showToast("无法继续重做", "warn"); return; }
    _editState._undoPtr++;
    var snap = JSON.parse(JSON.stringify(_editState._undoStack[_editState._undoPtr]));
    _editState.edl = snap;
    if (project) {
      if (!project.editData) project.editData = {};
      project.editData.edl = snap; // arch-guard:allow-editdata redo 内存镜像
    }
    _sendTimelineOp({ op: "set-edl", edl: _edlForPersistence(snap) });
    _buildSegStartTimes();
    _renderEditTimeline();
    _renderBgmStatus();
    _updatePlayhead();
    _syncUndoRedoButtons();
    showToast("已重做", "ok");
  }

  function _reorderEditSegment(fromIdx, toIdx) {
    _editSaveUndo();
    if (_editState.edl && _editState.edl.timeline) {
      var arr = _editState.edl.timeline;
      var item = arr.splice(fromIdx, 1)[0];
      arr.splice(toIdx, 0, item);
      // E-4.2：reorder PATCH /api/edit/timeline。前端乐观更新即时重渲染，
      // 后端权威排序以后端返回 edl 为准（_sendTimelineOp 成功回调里已回写）。
      _sendTimelineOp({ op: "reorder", fromIdx: fromIdx, toIdx: toIdx });
    } else {
      var arr2 = _editState.segments;
      var item2 = arr2.splice(fromIdx, 1)[0];
      arr2.splice(toIdx, 0, item2);
    }
    _renderEditTimeline();
    showToast("片段已重排", "ok");
  }

  var _regenStreams = {};

  function _regenSegment(groupIdx) {
    if (_regenStreams[groupIdx]) {
      showToast("片段 " + (groupIdx + 1) + " 正在生成中，请稍候", "warn");
      return;
    }
    showConfirm("重新生成片段 " + (groupIdx + 1), "确定重新生成这个片段的视频？", function () {
      showToast("正在重新生成片段 " + (groupIdx + 1) + "…", "ok");
      var btn = document.querySelector('.edit-seg-regen-btn[data-gidx="' + groupIdx + '"]');
      if (btn) { btn.disabled = true; btn.classList.add("animate-spin"); }

      apiPost("/api/edit/timeline", {
        projectId: project.id,
        op: "regen-group",
        groupIdx: groupIdx,
      }).then(function (resp) {
        if (!resp || !resp.ok) {
          showToast("重新生成失败: " + ((resp && resp.error) || "未知错误"), "error");
          if (btn) { btn.disabled = false; btn.classList.remove("animate-spin"); }
          return;
        }
        var batchId = resp.batchId;
        _regenStreams[groupIdx] = subscribeBatch(batchId, {
          onTaskCompleted: function (data) {
            var newUrl = data && data.resultUrl;
            if (newUrl && project) {
              var sbs = project.storyboards || [];
              if (sbs[groupIdx]) {
                sbs[groupIdx].videoUrl = newUrl;
                sbs[groupIdx]._originVideoUrl = newUrl;
              }
              var segs = _editState.edl ? _editState.edl.timeline : _editState.segments;
              fetchVideoSignedUrl(newUrl).then(function (runtimeUrl) {
                segs.forEach(function (s) {
                  if (s.groupIdx === groupIdx) {
                    s.videoUrl = runtimeUrl || newUrl;
                    s.protectedUrl = newUrl;
                    s._originVideoUrl = newUrl;
                  }
                });
                _renderEditTimeline();
                _previewEditSegment(groupIdx);
              }).catch(function () {
                segs.forEach(function (s) {
                  if (s.groupIdx === groupIdx) s.videoUrl = newUrl;
                });
                _renderEditTimeline();
                _previewEditSegment(groupIdx);
              });
            }
            showToast("片段 " + (groupIdx + 1) + " 重新生成完成！", "ok");
          },
          onTaskFailed: function (data) {
            showToast("片段 " + (groupIdx + 1) + " 重新生成失败: " + ((data && data.errorMsg) || ""), "error");
          },
          onBatchCompleted: function () {
            delete _regenStreams[groupIdx];
            if (btn) { btn.disabled = false; btn.classList.remove("animate-spin"); }
          },
          onClose: function () {
            delete _regenStreams[groupIdx];
            if (btn) { btn.disabled = false; btn.classList.remove("animate-spin"); }
          },
        });
      }).catch(function (err) {
        showToast("重新生成失败: " + ((err && err.message) || "网络错误"), "error");
        if (btn) { btn.disabled = false; btn.classList.remove("animate-spin"); }
      });
    });
  }

  var _TRANSITION_CYCLE = ["cut", "crossfade", "fade_to_black", "fade_from_black"];
  var _TRANSITION_LABELS = { cut: "硬切", crossfade: "叠化", fade_to_black: "淡黑", fade_from_black: "淡入" };

  function _cycleTransition(segIdx) {
    if (!_editState.edl || !_editState.edl.timeline || !_editState.edl.timeline[segIdx]) return;
    _editSaveUndo();
    var item = _editState.edl.timeline[segIdx];
    if (!item.transitionIn) item.transitionIn = { type: "cut", duration: 0 };
    var cur = item.transitionIn.type || "cut";
    var idx = _TRANSITION_CYCLE.indexOf(cur);
    var next = _TRANSITION_CYCLE[(idx + 1) % _TRANSITION_CYCLE.length];
    item.transitionIn.type = next;
    item.transitionIn.duration = next === "cut" ? 0 : 0.5;
    // E-4.2：transition 切换 PATCH /api/edit/timeline。
    _sendTimelineOp({
      op: "transition",
      segIdx: segIdx,
      type: next,
      duration: item.transitionIn.duration,
    });
    _renderEditTimeline();
  }

  /* ── Timeline data helpers ── */

  function _getTimelineSegs() {
    if (_editState.edl && _editState.edl.timeline && _editState.edl.timeline.length) {
      return _editState.edl.timeline;
    }
    return _editState.segments;
  }

  function _buildSegStartTimes() {
    var segs = _getTimelineSegs();
    var starts = [];
    var t = 0;
    for (var i = 0; i < segs.length; i++) {
      var dur = _segDuration(segs[i]);
      starts.push(t);
      t += dur;
    }
    _editState.segStartTimes = starts;
    _editState.totalDuration = t;
  }

  function _segDuration(seg) {
    if (seg.outPoint != null && seg.inPoint != null) return seg.outPoint - seg.inPoint;
    if (seg.duration) return seg.duration;
    return 5;
  }

  function _segVideoUrl(seg, segIdx) {
    var gIdx = seg.groupIdx != null ? seg.groupIdx : segIdx;
    var orig = _editState.segments.find(function (s) { return s.groupIdx === gIdx; });
    return seg.videoUrl || (orig && orig.videoUrl) || "";
  }

  /* ── Double-buffer playback engine ── */

  var _VID_STYLE = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;border-radius:8px;background:#000;";

  function _createVidElement() {
    var v = document.createElement("video");
    v.preload = "auto";
    v.playsInline = true;
    v.muted = false;
    v.style.cssText = _VID_STYLE + "display:none;";
    return v;
  }

  function _editPreviewCanvasRect(area) {
    if (!area) return null;
    var boxW = area.clientWidth || 0;
    var boxH = area.clientHeight || 0;
    if (!boxW || !boxH) return null;
    var fmt = _resolveCurrentExportFormat();
    var mediaRatio = Math.max(0.01, (fmt.width || 1080) / (fmt.height || 1920));
    var boxRatio = boxW / boxH;
    var w;
    var h;
    var x;
    var y;
    if (boxRatio > mediaRatio) {
      h = boxH;
      w = h * mediaRatio;
      x = (boxW - w) / 2;
      y = 0;
    } else {
      w = boxW;
      h = w / mediaRatio;
      x = 0;
      y = (boxH - h) / 2;
    }
    return { x: x, y: y, width: w, height: h, format: fmt };
  }

  function _syncSubtitleOverlayLayout() {
    var area = $("editPreviewArea");
    var sub = _editState && _editState._subtitleEl;
    if (!area || !sub) return;
    var canvasRect = _editPreviewCanvasRect(area);
    if (!canvasRect) return;
    var spec = resolveSubtitleLayoutSpec({
      width: canvasRect.format.width,
      height: canvasRect.format.height,
    });
    var scale = canvasRect.height / spec.height;
    var fontPx = Math.max(8, Math.round(spec.fontSize * scale));
    var lineHeightPx = Math.max(fontPx + 2, Math.round(fontPx * 1.25));
    var top = canvasRect.y + canvasRect.height * spec.topRatio;
    var maxTop = canvasRect.y + Math.max(0, canvasRect.height - lineHeightPx * 2 - canvasRect.height * 0.02);
    top = Math.max(canvasRect.y, Math.min(top, maxTop));

    sub.style.left = Math.round(canvasRect.x) + "px";
    sub.style.right = "auto";
    sub.style.top = Math.round(top) + "px";
    sub.style.bottom = "auto";
    sub.style.width = Math.round(canvasRect.width) + "px";
    sub.style.padding = "0";

    var span = sub.firstElementChild;
    if (span) {
      var shadowOffset = Math.max(1, Math.round(fontPx / 12));
      var shadowBlur = Math.max(2, Math.round(fontPx / 3));
      span.style.maxWidth = Math.max(24, Math.round(canvasRect.width * spec.maxWidthRatio)) + "px";
      span.style.font = "700 " + fontPx + "px/" + lineHeightPx + "px 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
      span.style.textShadow =
        "-" + shadowOffset + "px -" + shadowOffset + "px 0 #000," +
        shadowOffset + "px -" + shadowOffset + "px 0 #000," +
        "-" + shadowOffset + "px " + shadowOffset + "px 0 #000," +
        shadowOffset + "px " + shadowOffset + "px 0 #000," +
        "0 0 " + shadowBlur + "px rgba(0,0,0,.7)";
    }
  }

  function _initDoubleBuffer() {
    var area = $("editPreviewArea");
    if (!area) return;

    if (_editState._vidA && _editState._vidA.parentNode) _editState._vidA.parentNode.removeChild(_editState._vidA);
    if (_editState._vidB && _editState._vidB.parentNode) _editState._vidB.parentNode.removeChild(_editState._vidB);

    _editState._vidA = _createVidElement();
    _editState._vidB = _createVidElement();
    _editState._activeVid = "A";
    area.appendChild(_editState._vidA);
    area.appendChild(_editState._vidB);
    // 两个 vid 都常驻 display:block + position:absolute 叠在一起，用 z-index 切换
    // 哪个在上面。这样段间 cut 不会触发 display:none → block 的重新 paint 静帧。
    _editState._vidA.style.display = "block";
    _editState._vidA.style.zIndex = "2";
    _editState._vidB.style.display = "block";
    _editState._vidB.style.zIndex = "1";

    // 字幕浮层：底部居中、白字黑边、跟着 globalTime 切换内容
    if (!_editState._subtitleEl) {
      var sub = document.createElement('div');
      sub.id = 'editSubtitleOverlay';
      sub.style.cssText =
        'position:absolute;left:0;top:0;width:0;text-align:center;' +
        'pointer-events:none;z-index:20;padding:0;';
      sub.innerHTML = '<span style="display:inline-block;max-width:90%;font:700 8px/10px \'PingFang SC\',\'Noto Sans CJK SC\',sans-serif;' +
        'white-space:pre-line;overflow-wrap:anywhere;word-break:break-word;color:#fff;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 3px rgba(0,0,0,.7);"></span>';
      area.appendChild(sub);
      _editState._subtitleEl = sub;
    }
    _syncSubtitleOverlayLayout();

    // BGM 播放器：单例 audio，selected 时 src 跟着变；播放/暂停/seek 跟随 globalTime
    if (!_editState._bgmAudio) {
      var bgm = document.createElement('audio');
      bgm.id = 'editBgmPlayer';
      bgm.preload = 'auto';
      bgm.loop = true;
      bgm.volume = 0.32;
      document.body.appendChild(bgm);
      _editState._bgmAudio = bgm;
    }
    // SFX whoosh 池：用 Web Audio + buffer 一次合成 4 段不同长度的 whoosh，转场时按需 play()
    if (!_editState._sfxAudio) {
      var sfx = document.createElement('audio');
      sfx.id = 'editSfxPlayer';
      sfx.preload = 'auto';
      sfx.volume = 0.6;
      // data URL: 一段 0.4s 的褐噪声 whoosh —— 浏览器没有 Brown noise gen 的快捷方式，
      // 这里用一段静态 .wav header + 程序合成的样本就好。先留空，第一次切转场时合成。
      document.body.appendChild(sfx);
      _editState._sfxAudio = sfx;
    }

    var segs = _getTimelineSegs();
    if (segs.length > 0) {
      var url = _segVideoUrl(segs[0], 0);
      if (url) {
        _editState._vidA.src = url;
        try { _editState._vidA.dataset.segIdx = "0"; } catch (_) {}
        var seg0In = segs[0].inPoint || 0;
        var seg0Start = seg0In === 0 ? SEEDANCE_INTRO_TRIM_SEC : seg0In;
        var initSeek = function () { try { _editState._vidA.currentTime = seg0Start; } catch (_e) {} };
        if (_editState._vidA.readyState >= 1) initSeek();
        else _editState._vidA.addEventListener('loadedmetadata', function _h() {
          _editState._vidA.removeEventListener('loadedmetadata', _h); initSeek();
        });
        _editState._vidA.style.display = "block";
        _editState._vidA.load();
        var placeholder = $("editPreviewPlaceholder");
        if (placeholder) placeholder.hidden = true;
      }
    }

    _editState._preloaded = true;
    console.log("[Edit] Double-buffer initialized");
  }

  /** 播放一次转场 whoosh（用 Web Audio API 现合成褐噪声 + bandpass + 包络） */
  function _playTransitionSfx(transType) {
    try {
      var t = String(transType || '').toLowerCase();
      if (t === 'cut' || !t) return;
      // 单例 AudioContext —— iOS Safari 要求用户交互后才能 resume；播放按钮已经触发过了
      if (!_editState._audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _editState._audioCtx = new Ctx();
      }
      var ctx = _editState._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      // SFX 时长比转场略长一点点，让 whoosh 尾音盖过整段过渡（dissolve 1s → sfx 0.8s）
      var dur = (t === 'dissolve') ? 0.85
              : (t === 'wipe' || t === 'wipeleft' || t === 'wiperight') ? 0.65
              : 0.7; // fade
      var rate = ctx.sampleRate;
      var buf = ctx.createBuffer(2, Math.floor(rate * dur), rate);
      // brown noise 通过累加白噪声生成
      for (var ch = 0; ch < 2; ch++) {
        var data = buf.getChannelData(ch);
        var last = 0;
        for (var i = 0; i < data.length; i++) {
          var white = Math.random() * 2 - 1;
          last = (last + 0.02 * white) / 1.02;
          // 包络：短促 attack + 指数 decay；衰减系数随时长缩放保持音色不变
          var env = Math.exp(-3 * (i / data.length));
          data[i] = last * env * 4;
        }
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      // 带通：fade/dissolve 用 1.8kHz 低频，wipe 用 4kHz 高频
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = (t === 'wipe' || t === 'wipeleft' || t === 'wiperight') ? 4000 : 1800;
      bp.Q.value = 1.2;
      var gain = ctx.createGain();
      gain.gain.value = 0.45;
      src.connect(bp).connect(gain).connect(ctx.destination);
      src.start();
    } catch (e) { console.warn('[Edit] sfx play failed:', e); }
  }

  function _getActiveVid() {
    return _editState._activeVid === "A" ? _editState._vidA : _editState._vidB;
  }

  function _getStandbyVid() {
    return _editState._activeVid === "A" ? _editState._vidB : _editState._vidA;
  }

  function _swapBuffers() {
    _editState._activeVid = _editState._activeVid === "A" ? "B" : "A";
  }

  // Seedance i2v 视频的前 ~500 ms 几乎是参考图静帧（模型从图片"启动"到真正运动
  // 需要时间，用户反馈 0.25s 还能看到一点封面；这里加大到 0.5s）。
  // 5s 视频跳过 0.5s → 实际播 4.5s；10s 视频跳过 0.5s → 实际播 9.5s。
  // 用户已全局关字幕，所以这 0.5s 损失不会"漏台词"。
  var SEEDANCE_INTRO_TRIM_SEC = 0.5;
  function _loadSegToVid(vid, segIdx) {
    var segs = _getTimelineSegs();
    var seg = segs[segIdx];
    if (!seg || !vid) return;
    var url = _segVideoUrl(seg, segIdx);
    if (!url) return;
    if (vid.getAttribute("src") !== url) {
      vid.src = url;
    }
    try { vid.dataset.segIdx = String(segIdx); } catch (_) {}
    var baseIn = seg.inPoint || 0;
    // 只对"自然 inPoint=0"的片段做 intro 跳过；用户手动剪过的就尊重它。
    var startAt = baseIn === 0 ? SEEDANCE_INTRO_TRIM_SEC : baseIn;
    // 如果 metadata 还没就绪，挂一次 loadedmetadata 再 seek，避免在 readyState=0 时
    // 设置 currentTime 被浏览器忽略（结果还是从 0 帧开始，封面感原样）。
    var trySeek = function () {
      try { vid.currentTime = startAt; } catch (_e) {}
    };
    if (vid.readyState >= 1 /* HAVE_METADATA */) {
      trySeek();
    } else {
      var once = function () { vid.removeEventListener('loadedmetadata', once); trySeek(); };
      vid.addEventListener('loadedmetadata', once);
    }
  }

  function _showVid(vid, transType) {
    var placeholder = $("editPreviewPlaceholder");
    if (placeholder) placeholder.hidden = true;

    // 把 EDL 里的 transition 类型归一到这里能识别的几类。
    // 关键 BUG：之前 fade/dissolve/wipe 走到下面 if-else 全 miss，结果新 vid 永远不
    // display:block —— 用户看到的就是"画面卡死在前一段最后一帧"（收尾段尤其明显，
    // 因为它本身就是 fade 进场）。这里把所有非 cut 的转场都映射成 crossfade，
    // 预览有个柔和过渡，导出还是按 EDL 真实类型走 ffmpeg xfade。
    var t = String(transType || 'cut').toLowerCase();
    if (t === 'fade' || t === 'dissolve' || t === 'wipe' ||
        t === 'wipeleft' || t === 'wiperight' || t === 'slideleft' || t === 'slideright') {
      t = 'crossfade';
    }

    if (!t || t === "cut") {
      // 关键：cut 切换时**不要**用 display:none/block —— 浏览器在 display 切换瞬间
      // 会有一个短暂的 paint，把刚 display:block 的 vid 显示成第 0 帧（即使 currentTime
      // 已经 seek 到 0.5s），用户感知就是"段间夹了一张封面图"。
      // 改用 z-index + opacity 切换：两个 vid 都常驻 display:block，仅靠 z-index 决定
      // 哪个在上面，避免重新 layout / paint 静帧。
      if (_editState._vidA) {
        _editState._vidA.style.display = "block";
        _editState._vidA.style.opacity = "1";
        _editState._vidA.style.zIndex = (vid === _editState._vidA) ? "2" : "1";
      }
      if (_editState._vidB) {
        _editState._vidB.style.display = "block";
        _editState._vidB.style.opacity = "1";
        _editState._vidB.style.zIndex = (vid === _editState._vidB) ? "2" : "1";
      }
      _clearTransOverlay();
      return;
    }

    // 预览转场时长（毫秒）；与 lib/ffmpeg.ts defaultTransDuration 对齐让用户预览到啥导出就是啥
    var dur = (transType === 'dissolve') ? 1000
            : (transType === 'wipe' || transType === 'wipeleft' || transType === 'wiperight') ? 700
            : 800; // fade & 默认
    var area = $("editPreviewArea");

    if (t === "crossfade") {
      var outgoing = _getActiveVid();
      if (vid) { vid.style.display = "block"; vid.style.opacity = "0"; vid.style.zIndex = "2"; }
      if (outgoing && outgoing !== vid) { outgoing.style.display = "block"; outgoing.style.zIndex = "3"; }
      var start = performance.now();
      function crossfadeTick(now) {
        var p = Math.min((now - start) / dur, 1);
        if (vid) vid.style.opacity = p;
        if (outgoing && outgoing !== vid) outgoing.style.opacity = (1 - p);
        if (p < 1) requestAnimationFrame(crossfadeTick);
        else {
          // crossfade 完成后保持 outgoing display:block + 退到 z-index 1，避免下次
          // cut 切换时再次触发 display:none → block 的重 paint 闪封面。
          if (outgoing && outgoing !== vid) {
            outgoing.style.opacity = "1";
            outgoing.style.zIndex = "1";
          }
        }
      }
      requestAnimationFrame(crossfadeTick);

    } else if (t === "fade_to_black" || t === "fade_from_black") {
      var overlay = _getTransOverlay(area);
      var outVid = (transType === "fade_to_black") ? _getActiveVid() : null;
      overlay.style.opacity = transType === "fade_to_black" ? "0" : "1";
      overlay.style.display = "block";
      var s2 = performance.now();
      function fadeTick(now) {
        var p = Math.min((now - s2) / dur, 1);
        if (t === "fade_to_black") {
          overlay.style.opacity = p;
          if (p >= 1) {
            if (outVid) { outVid.style.display = "none"; }
            if (vid) { vid.style.display = "block"; }
            var s3 = performance.now();
            function fadeIn(now2) {
              var p2 = Math.min((now2 - s3) / dur, 1);
              overlay.style.opacity = (1 - p2);
              if (p2 < 1) requestAnimationFrame(fadeIn);
              else overlay.style.display = "none";
            }
            requestAnimationFrame(fadeIn);
          } else { requestAnimationFrame(fadeTick); }
        } else {
          overlay.style.opacity = (1 - p);
          if (vid) vid.style.display = "block";
          if (p >= 1) overlay.style.display = "none";
          else requestAnimationFrame(fadeTick);
        }
      }
      requestAnimationFrame(fadeTick);
    }
  }

  function _getTransOverlay(area) {
    var ov = area && area.querySelector(".edit-trans-overlay");
    if (!ov && area) {
      ov = document.createElement("div");
      ov.className = "edit-trans-overlay";
      ov.style.cssText = "position:absolute;inset:0;background:#000;z-index:15;pointer-events:none;display:none;opacity:0";
      area.appendChild(ov);
    }
    return ov;
  }

  function _clearTransOverlay() {
    var area = $("editPreviewArea");
    var ov = area && area.querySelector(".edit-trans-overlay");
    if (ov) { ov.style.display = "none"; ov.style.opacity = "0"; }
  }

  /* ── Seek / navigate ── */

  function _previewEditSegment(gIdx) {
    var segs = _getTimelineSegs();
    var idx = -1;
    for (var i = 0; i < segs.length; i++) {
      if ((segs[i].groupIdx != null ? segs[i].groupIdx : i) === gIdx) { idx = i; break; }
    }
    if (idx < 0) idx = 0;
    _editSeekToSeg(idx);
  }

  function _editSeekToSeg(segIdx) {
    _buildSegStartTimes();
    var segs = _getTimelineSegs();
    if (segIdx < 0 || segIdx >= segs.length) return;

    var wasPlaying = _editState.isPlaying;
    if (wasPlaying) _editPause();

    _editState.currentSegIdx = segIdx;
    _editState.globalTime = _editState.segStartTimes[segIdx] || 0;

    var vid = _getActiveVid();
    _loadSegToVid(vid, segIdx);
    _showVid(vid);

    _updatePlayhead();
    _updateEditTimeDisplay();
    _highlightActiveSeg(segIdx);

    if (wasPlaying) _editPlay();
  }

  function _editSeekToTime(timelineX) {
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var segs = _getTimelineSegs();
    var starts = _editState.segStartTimes;
    var t = Math.max(0, Math.min(_timelineXToTime(timelineX, pps, segs, starts), _editState.totalDuration));
    var segIdx = 0;
    for (var i = 0; i < starts.length; i++) {
      var dur = _segDuration(segs[i]);
      if (t >= starts[i] && t < starts[i] + dur) { segIdx = i; break; }
      if (i === starts.length - 1) segIdx = i;
    }

    var wasPlaying = _editState.isPlaying;
    if (wasPlaying) _editPause();

    _editState.currentSegIdx = segIdx;
    _editState.globalTime = t;

    var seg = segs[segIdx];
    var localTime = (seg.inPoint || 0) + (t - (starts[segIdx] || 0));

    var vid = _getActiveVid();
    var url = _segVideoUrl(seg, segIdx);
    if (vid) {
      var srcChanged = vid.getAttribute("src") !== url;
      if (srcChanged) vid.src = url;
      try { vid.dataset.segIdx = String(segIdx); } catch (_) {}
      if (srcChanged && vid.readyState < 2) {
        vid.addEventListener("loadedmetadata", function onMeta() {
          vid.removeEventListener("loadedmetadata", onMeta);
          vid.currentTime = localTime;
        });
      } else {
        vid.currentTime = localTime;
      }
    }
    _showVid(vid);

    _updatePlayhead(true);
    _updateEditTimeDisplay();
    _highlightActiveSeg(segIdx);

    if (wasPlaying) _editPlay();
  }

  /* ── Play / Pause / Tick (double-buffer, cached DOM) ── */

  var _tickCache = {
    segs: null, starts: null, playheadEl: null,
    scrollEl: null, timeEl: null, playBtnSpan: null,
  };

  function _refreshTickCache() {
    _tickCache.segs = _getTimelineSegs();
    _tickCache.starts = _editState.segStartTimes;
    _tickCache.playheadEl = $("editPlayhead");
    _tickCache.scrollEl = $("editTimelineScroll");
    _tickCache.timeEl = $("editTimeDisplay");
    var btn = $("editPlayBtn");
    _tickCache.playBtnSpan = btn ? btn.querySelector("span") : null;
    var previewBtn = $("editPreviewPlayBtn");
    _tickCache.previewPlayBtnSpan = previewBtn ? previewBtn.querySelector("span") : null;
  }

  function _syncEditPlayButtons(isPlaying) {
    var icon = isPlaying ? "pause" : "play_arrow";
    var mainSpan = _tickCache.playBtnSpan || ($("editPlayBtn") && $("editPlayBtn").querySelector("span"));
    var previewSpan = _tickCache.previewPlayBtnSpan || ($("editPreviewPlayBtn") && $("editPreviewPlayBtn").querySelector("span"));
    if (mainSpan) mainSpan.textContent = icon;
    if (previewSpan) previewSpan.textContent = icon;
  }

  function _editTogglePlay() {
    if (_editState.isPlaying) _editPause();
    else _editPlay();
  }

  function _editPlay() {
    _buildSegStartTimes();
    _refreshTickCache();
    var segs = _tickCache.segs;
    if (!segs.length) return;

    if (_timelineVideoUrlsNeedRefresh()) {
      showToast("正在刷新视频播放地址…", "warn");
      var hydration = _videoUrlHydrationPromise || _hydrateTimelineVideoUrls();
      _videoUrlHydrationPromise = hydration;
      hydration.then(function (changed) {
        if (_videoUrlHydrationPromise === hydration) _videoUrlHydrationPromise = null;
        if (_timelineVideoUrlsNeedRefresh()) {
          showToast("视频播放地址刷新失败，请重新登录后再试", "error");
          return;
        }
        if (changed) _initDoubleBuffer();
        _editPlay();
      }).catch(function (err) {
        if (_videoUrlHydrationPromise === hydration) _videoUrlHydrationPromise = null;
        console.warn("[EditPlay] video URL hydrate failed:", err);
        showToast("视频播放地址刷新失败，请重新登录后再试", "error");
      });
      return;
    }

    if (_editState.currentSegIdx >= segs.length) {
      _editState.currentSegIdx = 0;
      _editState.globalTime = 0;
    }
    if (_editState.globalTime >= _editState.totalDuration) {
      _editState.currentSegIdx = 0;
      _editState.globalTime = 0;
    }

    var segIdx = _editState.currentSegIdx;
    var seg = segs[segIdx];
    var vid = _getActiveVid();

    var url = _segVideoUrl(seg, segIdx);
    if (vid) {
      if (vid.getAttribute("src") !== url) vid.src = url;
      try { vid.dataset.segIdx = String(segIdx); } catch (_) {}
      var localOffset = _editState.globalTime - (_editState.segStartTimes[segIdx] || 0);
      var rawIn = seg.inPoint || 0;
      // 关键修复（第一段开头封面）：当处于段开头 + inPoint=0 时，需要应用
      // SEEDANCE_INTRO_TRIM_SEC 偏移跳过 i2v 启动静帧。否则用户每次"暂停后再点
      // 播放"或第一次开播，都会看到第 0 帧封面图。
      var targetTime = rawIn + localOffset;
      if (rawIn === 0 && localOffset < 0.05) {
        targetTime = SEEDANCE_INTRO_TRIM_SEC;
      }
      // 如果 vid metadata 还没加载好，同步 set currentTime 会被忽略，
      // 必须等 loadedmetadata 再 seek，否则播放从第 0 帧开始 → 封面感。
      var doVidSeek = function () { try { vid.currentTime = targetTime; } catch (_e) {} };
      if (vid.readyState >= 1) doVidSeek();
      else vid.addEventListener('loadedmetadata', function _h() {
        vid.removeEventListener('loadedmetadata', _h); doVidSeek();
      });
      _showVid(vid);
    }

    _prebufferNext(segIdx);

    _editState.isPlaying = true;
    _syncEditPlayButtons(true);
    _highlightActiveSeg(segIdx);

    if (vid) {
      _seekThenPlay(vid, targetTime);
    }

    // BGM 跟着 globalTime 起播：如果选了 BGM 就 sync 播放，让用户在剪辑工作台
    // 听到的就是导出后的 BGM；没选就静音。
    _syncBgmPlayback();

    if (_editState._rafId) cancelAnimationFrame(_editState._rafId);
    _editState._rafId = requestAnimationFrame(_editTickLoop);
  }

  function _editPause() {
    _editState.isPlaying = false;
    if (_editState._rafId) {
      cancelAnimationFrame(_editState._rafId);
      _editState._rafId = null;
    }

    var vid = _getActiveVid();
    if (vid) vid.pause();

    // 暂停 BGM
    if (_editState._bgmAudio) { try { _editState._bgmAudio.pause(); } catch (_) {} }
    _updateBgmStatusFromTimeline();

    _syncEditPlayButtons(false);
  }

  /** 把 BGM audio 同步到当前播放状态：明确打开 BGM 才 play 并按 globalTime 起跳 */
  function _syncBgmPlayback() {
    var bgm = _editState._bgmAudio;
    if (!bgm) return;
    var _b = _editState.edl && _editState.edl.bgm;
    var trackId = (_b && _b.enabled === true) ? _b.trackId : null;
    if (!trackId) {
      try { bgm.pause(); } catch (_) {}
      bgm.removeAttribute('src');
      return;
    }
    // 用带 token 的 fetch 取流转 blob objectURL，再喂给 audio（媒体请求带不了 Bearer header）。
    _ensureBgmObjectUrl(trackId, function (objUrl) {
      if (bgm.getAttribute('src') !== objUrl) {
        bgm.src = objUrl;
        bgm.load();
      }
      var setStart = function () {
        // BGM 循环播放：currentTime = globalTime mod bgmDuration
        var bgmDur = isFinite(bgm.duration) && bgm.duration > 0 ? bgm.duration : 28;
        var startAt = ((_editState.globalTime || 0) % bgmDur);
        try { bgm.currentTime = startAt; } catch (_) {}
        _updateBgmStatusFromAudio(bgm, trackId);
        if (_editState.isPlaying) {
          bgm.play().catch(function () { /* autoplay blocked，无视即可 */ });
        }
      };
      if (bgm.readyState >= 1) setStart();
      else bgm.addEventListener('loadedmetadata', setStart, { once: true });
    });
  }

  function _seekThenPlay(vid, seekTime) {
    if (!vid) return;
    var hasSeek = typeof seekTime === "number" && isFinite(seekTime);
    var settled = false;
    var onVideoError = null;

    var cleanup = function () {
      if (onVideoError) {
        vid.removeEventListener("error", onVideoError);
        onVideoError = null;
      }
    };

    var failPlayback = function (err) {
      if (settled) return;
      settled = true;
      cleanup();
      console.warn("[EditPlay] video failed:", err);
      if (_editState.isPlaying) _editPause();
      showToast("视频播放失败: " + ((err && err.message) || "视频加载失败"), "warn");
    };

    onVideoError = function () {
      var mediaErr = vid.error;
      var msg = mediaErr && mediaErr.message ? mediaErr.message : "视频加载失败";
      failPlayback(new Error(msg));
    };
    vid.addEventListener("error", onVideoError, { once: true });

    var _doPlay = function () {
      vid.play().catch(function (err) {
        if (err && err.name === "NotAllowedError" && !vid.muted) {
          vid.muted = true;
          vid.play().then(function () { settled = true; cleanup(); vid.muted = false; }).catch(failPlayback);
          return;
        }
        failPlayback(err);
      }).then(function () {
        settled = true;
        cleanup();
      });
    };

    var _seekAndPlay = function () {
      if (hasSeek) {
        vid.currentTime = seekTime;
        if (Math.abs(vid.currentTime - seekTime) > 0.05) {
          vid.addEventListener("seeked", function onSeeked() {
            vid.removeEventListener("seeked", onSeeked);
            if (_editState.isPlaying) _doPlay();
          });
          return;
        }
      }
      _doPlay();
    };

    if (vid.readyState >= 3) {
      _seekAndPlay();
    } else {
      var handler = function () {
        vid.removeEventListener("canplay", handler);
        if (_editState.isPlaying) _seekAndPlay();
      };
      vid.addEventListener("canplay", handler);
      vid.load();
    }
  }

  function _prebufferNext(curIdx) {
    var segs = _tickCache.segs || _getTimelineSegs();
    var nextIdx = curIdx + 1;
    if (nextIdx >= segs.length) return;

    var standby = _getStandbyVid();
    if (!standby) return;
    var nextSeg = segs[nextIdx];
    var url = _segVideoUrl(nextSeg, nextIdx);
    if (!url) return;

    if (standby.getAttribute("src") !== url) {
      standby.src = url;
    }
    try { standby.dataset.segIdx = String(nextIdx); } catch (_) {}
    // standby 必须 seek 到跳过 Seedance i2v 启动静帧的位置 —— 否则切到 standby
    // 那一瞬间会闪一下 frame=0 的封面图（i2v 模型从图片"启动"到运动需要 ~0.5s）。
    var rawIn = nextSeg.inPoint || 0;
    var nextStart = rawIn === 0 ? SEEDANCE_INTRO_TRIM_SEC : rawIn;
    var doSeek = function () {
      try { standby.currentTime = nextStart; } catch (_e) {}
      // 关键修复（封面闪一下）：很多浏览器在长时间静止 + display 切换的 vid 上
      // 会先 paint 一帧旧的 frame buffer 才更新到当前 currentTime 的帧。这里做
      // 一次"warm-up"——seek 完后短暂 muted-play 再 pause，强制浏览器把当前
      // 帧 decode + paint 到 vid surface，下次切换显示就不会闪历史 frame。
      var warmup = function () {
        var prevMuted = standby.muted;
        standby.muted = true;
        var p = standby.play();
        var stopWarm = function () {
          try { standby.pause(); } catch (_) {}
          standby.muted = prevMuted;
          // pause 后再确保 currentTime 还在 trim 后位置（play 推进了一点点）
          try { standby.currentTime = nextStart; } catch (_) {}
        };
        if (p && typeof p.then === 'function') {
          p.then(function () { setTimeout(stopWarm, 60); }).catch(function () { stopWarm(); });
        } else {
          setTimeout(stopWarm, 60);
        }
      };
      if (standby.readyState >= 2 /* HAVE_CURRENT_DATA */) warmup();
      else {
        var w2 = function () { standby.removeEventListener('canplay', w2); warmup(); };
        standby.addEventListener('canplay', w2);
      }
    };
    if (standby.readyState >= 1) doSeek();
    else {
      var once = function () { standby.removeEventListener('loadedmetadata', once); doSeek(); };
      standby.addEventListener('loadedmetadata', once);
    }
    standby.load();
  }

  function _editTickLoop() {
    if (!_editState.isPlaying) return;

    // 切换中：standby 还没就绪，不要推进时间也不要再次触发下一次切换，
    // 否则 globalTime 会读到旧 vid 的越界 currentTime → playhead 抽搐
    // 或者还没切到 nextIdx 就又触发一次切到 nextIdx+1 的连锁错位。
    if (_editState._swapping) {
      _updatePlayheadFast(true);
      _updateTimeDisplayFast();
      _editState._rafId = requestAnimationFrame(_editTickLoop);
      return;
    }

    var segs = _tickCache.segs;
    var starts = _tickCache.starts;
    var curIdx = _editState.currentSegIdx;
    var seg = segs[curIdx];
    var vid = _getActiveVid();

    if (vid && seg) {
      var inPt = seg.inPoint || 0;
      var localTime = Math.max(0, vid.currentTime - inPt);
      // 防越界：vid 偶发 stall 时 currentTime 可能超过 outPoint，把它截到段长内
      var segDur = _segDuration(seg);
      if (localTime > segDur) localTime = segDur;
      _editState.globalTime = (starts[curIdx] || 0) + localTime;
      // 主循环每帧把 active vid 的 dataset.segIdx 同步到 currentSegIdx，确保字幕
      // 反查不会因为某次 swap 漏写 dataset 导致一直读到上一段索引。
      try { vid.dataset.segIdx = String(curIdx); } catch (_) {}
    }

    var segEnd = (starts[curIdx] || 0) + _segDuration(seg);

    if (_editState.globalTime >= segEnd - 0.08) {
      var nextIdx = curIdx + 1;
      if (nextIdx >= segs.length) {
        _editState.globalTime = _editState.totalDuration;
        _editPause();
        _updatePlayheadFast(true);
        _updateTimeDisplayFast();
        return;
      }

      var standby = _getStandbyVid();
      var nextSeg = segs[nextIdx];
      var nextUrl = _segVideoUrl(nextSeg, nextIdx);
      var transType = (nextSeg.transitionIn && nextSeg.transitionIn.type) || "cut";

      if (standby) {
        // 切到下一段时跳过 Seedance i2v 启动静帧 —— 这是"段落之间像夹了张封面图"
        // 的最后一道防线（_loadSegToVid / _prebufferNext / _initDoubleBuffer
        // 都已加上同样的偏移）。
        var rawIn = nextSeg.inPoint || 0;
        var nextInPt = rawIn === 0 ? SEEDANCE_INTRO_TRIM_SEC : rawIn;
        var srcChanged = standby.getAttribute("src") !== nextUrl;
        if (srcChanged) {
          standby.src = nextUrl;
          standby.load();
          // 关键：src 刚变 + readyState=0，下面同步 set currentTime 会被
          // 忽略；先等 loadedmetadata 再 seek，否则 doSwap 时 standby 还在
          // 第 0 帧 → 段间闪一张静帧封面。
          var _earlySeek = function () {
            standby.removeEventListener('loadedmetadata', _earlySeek);
            try { standby.currentTime = nextInPt; } catch (_e) {}
          };
          standby.addEventListener('loadedmetadata', _earlySeek);
        }

        // 切换流程修正（v3）：
        //   v1 立刻 _showVid → 黑屏 + 音频先到
        //   v2 等 readyState≥2 → play() 立刻 stall
        //   v3 等 seeked + readyState≥3 → 上一版有 BUG：1.5s 兜底定时器无脑把
        //       currentTime 跳回 inPoint，已经播了 1.5s 又被拉回起点，所以"第一秒重播"
        //
        //   现在的 v3 修正版：
        //     - 兜底定时器只在 swapped=false 时执行（已经成功切换的不再骚扰）
        //     - 不再在切换流程里二次 setCurrentTime（standby 已经在 inPoint 了）
        //     - _seekThenPlay 已经会处理 seek，不需要重复
        _editState._swapping = true;

        var swapped = false;
        var doSwap = function () {
          if (swapped) return;
          swapped = true;
          // 移除所有事件监听，避免 swapped 之后还有事件触发 doSwap 或 seek
          try { standby.removeEventListener("seeked", onSeeked); } catch (_) {}
          try { standby.removeEventListener("canplay", onCanplay); } catch (_) {}
          try { standby.removeEventListener("canplaythrough", onCanplay); } catch (_) {}
          if (vid) { try { vid.pause(); } catch (_) {} }
          _editState.currentSegIdx = nextIdx;
          _editState.globalTime = _editState.segStartTimes[nextIdx] || 0;
          // 给 standby vid 打段索引标签，字幕反查时可以严格定位到对应段，
          // 不会再因为 _editState.currentSegIdx 异步切换中途看到错段。
          try { standby.dataset.segIdx = String(nextIdx); } catch (_) {}
          _showVid(standby, transType);
          _swapBuffers();
          _seekThenPlay(standby, nextInPt);
          _highlightActiveSeg(nextIdx);

          // 关键修复：非 cut 转场时，绝对不能立即 _prebufferNext，否则会把
          // N+2 段的 src 灌进还在 crossfade 淡出中的"上一段"video 元素，
          // 用户就会看到淡出层突然闪出毫不相干的下下段画面。
          // 等 crossfade 完全结束、outgoing 元素 display:none 之后再换 src 就安全了。
          var t = String(transType || 'cut').toLowerCase();
          var isCut = (!t || t === 'cut');
          if (isCut) {
            _prebufferNext(nextIdx);
          } else {
            var prebufDelay = (t === 'dissolve') ? 1100
                            : (t === 'wipe' || t === 'wipeleft' || t === 'wiperight') ? 800
                            : 900; // fade & 其它（与 _showVid 的 dur 同步 + 100ms 缓冲）
            setTimeout(function () {
              // 防御：如果用户已经 seek 到别的段，prebuffer 由 _editSeekToSeg 的下次 play
              // 自然接管即可，这里不再强行改 standby 的 src
              if (_editState.currentSegIdx === nextIdx) _prebufferNext(nextIdx);
            }, prebufDelay);
          }
          _editState._swapping = false;
          // 转场 SFX：非 cut 转场就同步播一个 whoosh，让用户在工作台预览就能听到
          if (transType && transType !== 'cut') _playTransitionSfx(transType);
        };

        var seekedOk = false;
        var canplayOk = false;
        var maybeSwap = function () {
          if (seekedOk && canplayOk && standby.readyState >= 3) doSwap();
        };
        var onSeeked = function () {
          if (swapped) return;
          standby.removeEventListener("seeked", onSeeked);
          seekedOk = true;
          maybeSwap();
        };
        var onCanplay = function () {
          if (swapped) return;
          if (standby.readyState >= 3) {
            standby.removeEventListener("canplay", onCanplay);
            standby.removeEventListener("canplaythrough", onCanplay);
            canplayOk = true;
            maybeSwap();
          }
        };
        standby.addEventListener("seeked", onSeeked);
        standby.addEventListener("canplay", onCanplay);
        standby.addEventListener("canplaythrough", onCanplay);

        // 触发 seek（如果 src 没变，currentTime= 立刻触发 seeked）
        try { standby.currentTime = nextInPt; } catch (_) {}
        // readyState >= 3 = HAVE_FUTURE_DATA，可以直接 play 不会立刻 stall
        if (standby.readyState >= 3) { canplayOk = true; }
        // 如果 currentTime 已经吻合（inPoint=0 + 刚 load 完时常见），不会再触发 seeked 事件，
        // 这里同步标记一下，否则 swap 会永远卡在等 seeked，最后只能靠 1.5s 兜底超时切。
        if (Math.abs(standby.currentTime - nextInPt) < 0.05) { seekedOk = true; }
        maybeSwap();

        // 兜底：1.5s 后强切——但如果已经 swapped，绝对不再动 currentTime！
        // 否则就是把已经播了 1.5s 的视频 seek 回起点，制造"第一秒重播"。
        // 关键：如果此时 standby 还没 ready（readyState<1）或者还没 seek 到 intro
        // trim，强切会让用户看到一帧封面静帧。所以兜底里也分两段——先等 metadata
        // 再 seek 再 doSwap，保证显示出来已经是 0.5s 之后的运动帧。
        setTimeout(function () {
          if (swapped) return;
          var hardSwap = function () {
            if (swapped) return;
            // 等 currentTime 真正落到 nextInPt 才执行 doSwap，避免封面闪一下
            var atTarget = Math.abs(standby.currentTime - nextInPt) < 0.05;
            if (atTarget || standby.readyState < 1) { doSwap(); return; }
            var onSk = function () { standby.removeEventListener('seeked', onSk); doSwap(); };
            standby.addEventListener('seeked', onSk);
            try { standby.currentTime = nextInPt; } catch (_) {}
            // 极端兜底：再过 400ms 还没 seeked 也强切，不能无限拖
            setTimeout(function () {
              try { standby.removeEventListener('seeked', onSk); } catch (_) {}
              doSwap();
            }, 400);
          };
          if (standby.readyState >= 1) {
            try { standby.currentTime = nextInPt; } catch (_) {}
            hardSwap();
          } else {
            var _wm = function () { standby.removeEventListener('loadedmetadata', _wm); hardSwap(); };
            standby.addEventListener('loadedmetadata', _wm);
            // metadata 仍然不来的极端兜底（200ms），按硬切走
            setTimeout(function () {
              try { standby.removeEventListener('loadedmetadata', _wm); } catch (_) {}
              hardSwap();
            }, 200);
          }
        }, 1500);
      } else if (vid) {
        try { vid.pause(); } catch (_) {}
        _editState.currentSegIdx = nextIdx;
        _highlightActiveSeg(nextIdx);
      }
    }

    _updatePlayheadFast(true);
    _updateTimeDisplayFast();
    _updateSubtitleFast();
    _updateBgmStatusFromTimeline();

    _editState._rafId = requestAnimationFrame(_editTickLoop);
  }

  /** 当前 globalTime 应该展示的字幕文本。清洗、speaker 剥离、"——" 跳过、
   * 短视频标点和两行分行都由 subtitle_format.js 统一处理。 */
  function _currentSubtitleText() {
    var segs = _tickCache.segs || [];
    var starts = _tickCache.starts || [];
    // 段索引完全按 globalTime 在时间轴上的位置二分确定，跟 vid / currentSegIdx /
    // dataset 都解耦。time line 上看到的 playhead 在哪段，字幕就显示哪段——
    // 这是用户视觉上最一致的行为。
    var gt = _editState.globalTime || 0;
    var idx = segs.length - 1;
    for (var ii = 0; ii < segs.length; ii++) {
      var dStart = starts[ii] || 0;
      var dEnd = dStart + _segDuration(segs[ii]);
      if (gt < dEnd - 0.02) { idx = ii; break; }
    }
    if (idx < 0) idx = 0;
    var seg = segs && segs[idx];
    if (!seg || !project) return '';
    var gIdx = seg.groupIdx != null ? seg.groupIdx : idx;
    var sbs = Array.isArray(project.storyboards) ? project.storyboards : [];
    var shots = Array.isArray(project.shots) ? project.shots : [];
    var sb = sbs[gIdx];
    var lines = [];

    // 字幕台词权威来源切换（关键修复）：
    // 之前依赖 sb.shotIndices 推导段内 shot，但后端实际生成 videoPrompt 时
    // 经常一段视频合并了 2-3 个 shot 的台词（shot[1].dialogue + shot[2].dialogue
    // 一起塞进 sb[1] 的 prompt），用户能在视频里听到全部 5 句台词，但前端只读
    // shot[gIdx].dialogue 的 2 句字幕，"还是靠限时排队" 等就永远不出现。
    //
    // 改成：优先从 sb.videoPrompt 文本里 regex 抓所有 `角色：「台词」` /
    // `角色："台词"` 形式的引号字符串作为字幕——这是 AI 真正"说了什么"的来源。
    // 仅当 prompt 抓不到任何台词时才退回 shots[].dialogue。
    var prompt = (sb && sb.videoPrompt) || '';
    if (prompt) {
      lines = extractSubtitleLinesFromPrompt(prompt);
    }
    if (!lines.length) {
      // fallback：老路径，从 shots[].dialogue 取
      var shotIdxs = (sb && Array.isArray(sb.shotIndices) && sb.shotIndices.length) ? sb.shotIndices : [gIdx];
      for (var i = 0; i < shotIdxs.length; i++) {
        var sh = shots[shotIdxs[i]];
        if (!sh) continue;
        var raw = String(sh.dialogue || '').trim();
        var pieces = splitSubtitleDialogueLines(raw);
        for (var j = 0; j < pieces.length; j++) {
          if (pieces[j]) lines.push(pieces[j]);
        }
      }
    }
    if (!lines.length) return '';
    // 段内进度严格用 globalTime - segStart，跟段索引判定保持同一时间基准
    var segDur = _segDuration(seg);
    var segStart2 = starts[idx] || 0;
    var localT = Math.max(0, gt - segStart2);
    if (localT > segDur) localT = segDur;

    // 字幕节奏 v4 —— 双策略：
    //
    // (a) 台词总长 <= 段长：按字符比例分配，留一点尾巴让最后一句保持到段尾。
    //     minPerLine 保证短句不会一闪而过（段 4-5 这种 2 句词的段也能看清）。
    //
    // (b) 台词总长 > 段长（典型如段 3：7 句 ~14s 要塞进 10s）：
    //     不能再用 minPerLine 兜底——4 字句和 9 字句被一起压缩成同等时长，
    //     就会出现"短句字幕还在显示，AI 已经说到长句一半"的口型错位。
    //     此时直接按字符比例分配可用时间（短句快过、长句慢过），
    //     更贴近 AI 演员"字多说久"的真实节奏。
    var perChar = 1 / 3.0;       // 0.33s / 字
    var minPerLine = 1.9;        // 段时间充足时最短 1.9s
    var TAIL_PAD = 0.2;          // 段尾留 0.2s 收尾
    var avail = Math.max(0.5, segDur - TAIL_PAD);

    var rawSum = 0;
    for (var li0 = 0; li0 < lines.length; li0++) {
      rawSum += Math.max(0.6, subtitleVisibleCharCount(lines[li0])) * perChar;
    }

    var ends = [];
    var t = 0;
    if (rawSum <= avail) {
      // 策略 (a)：宽裕——用 minPerLine 撑短句，再按比例填到段尾
      for (var li = 0; li < lines.length; li++) {
        var d = Math.max(minPerLine, subtitleVisibleCharCount(lines[li]) * perChar);
        t += d;
        ends.push(t);
      }
      if (t > 0 && t < avail) {
        var pad = avail / t;
        for (var pi = 0; pi < ends.length; pi++) ends[pi] *= pad;
      }
    } else {
      // 策略 (b)：紧——纯按字符比例分配 avail，不再 minPerLine 兜底
      var totalChar = 0;
      for (var ci = 0; ci < lines.length; ci++) {
        totalChar += Math.max(2, subtitleVisibleCharCount(lines[ci])); // 极短句保底 2 字权重
      }
      var t2 = 0;
      for (var li2 = 0; li2 < lines.length; li2++) {
        var w = Math.max(2, subtitleVisibleCharCount(lines[li2]));
        t2 += avail * w / totalChar;
        ends.push(t2);
      }
    }
    // 字幕"延后量" SUB_LAG：每句字幕比算出来的"段内字符比例"边界**延后** 0.3s
    // 切换。AI 视频演员普遍比"字数 × perChar"估算的纯字数节奏略慢——开场
    // 还有动作 cue（账单啪一声、机位移动），演员真正开口比 0s 晚一拍；
    // 句间也有反应停顿。延后切换 = 每句 hold 多 0.3s 等演员，前几句"字幕
    // 跑在演员前面"的串台词感会消失。最后一句默认保留到段尾，不受影响。
    var SUB_LAG = 0.3;
    var pickedK = lines.length - 1;
    for (var ki = 0; ki < lines.length - 1; ki++) {
      if (localT < ends[ki] + SUB_LAG) { pickedK = ki; break; }
    }
    return lines[pickedK];
  }

  function _updateSubtitleFast() {
    var sub = _editState._subtitleEl;
    if (!sub) return;
    _syncSubtitleOverlayLayout();
    // 切换中：currentSegIdx 已经指向下一段，但 standby 视频还没真正切到画面前置；
    // 这时如果照常更新字幕，用户会看到"画面是上一段、字幕是下一段"的串台词。
    // 切换期间冻结字幕，等画面 swap 完成后下一帧再刷新。
    if (_editState._swapping) return;
    var text = _currentSubtitleText();
    var span = sub.firstElementChild;
    if (span && span.textContent !== text) span.textContent = text;
  }

  /* ── UI update helpers (fast path uses cached DOM refs) ── */

  function _updatePlayheadFast(allowAutoScroll) {
    var el = _tickCache.playheadEl;
    if (!el) return;
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var segs = _tickCache.segs || _getTimelineSegs();
    var starts = _tickCache.starts || _editState.segStartTimes || _timelineStarts(segs).starts;
    var x = _timelineTimeToX(_editState.globalTime, pps, starts);

    var scroll = _tickCache.scrollEl;
    if (scroll) {
      var visible = scroll.clientWidth;
      if (allowAutoScroll && x > scroll.scrollLeft + visible - 60) {
        scroll.scrollLeft = x - visible / 2;
        _syncTimelineScrollLayers(scroll);
      } else if (allowAutoScroll && x < scroll.scrollLeft + 30) {
        scroll.scrollLeft = Math.max(0, x - 30);
        _syncTimelineScrollLayers(scroll);
      }
      // playhead lives outside the scroller, so align it to the scroller's real content origin.
      el.style.left = (x - scroll.scrollLeft + _timelineOriginX(scroll)) + "px";
    } else {
      el.style.left = (x + _timelineOriginX()) + "px";
    }
  }

  function _updateTimeDisplayFast() {
    var el = _tickCache.timeEl;
    if (!el) return;
    el.textContent = _formatTime(_editState.globalTime) + " / " + _formatTime(_editState.totalDuration);
  }

  function _updatePlayhead(allowAutoScroll) {
    _tickCache.playheadEl = _tickCache.playheadEl || $("editPlayhead");
    _tickCache.scrollEl = _tickCache.scrollEl || $("editTimelineScroll");
    _updatePlayheadFast(!!allowAutoScroll);
  }

  function _updateEditTimeDisplay() {
    _tickCache.timeEl = _tickCache.timeEl || $("editTimeDisplay");
    _updateTimeDisplayFast();
  }

  function _currentBgmTrackId() {
    var bgm = _editState.edl && _editState.edl.bgm;
    if (!bgm || bgm.enabled !== true || !bgm.trackId) return "";
    return bgm.trackId;
  }

  function _findBgmEntry(trackId) {
    if (!trackId) return null;
    return (_bgmCatalogCache || []).find(function (t) { return t.id === trackId; }) || null;
  }

  function _resolveBgmDuration(trackId, audio) {
    var audioDur = audio && isFinite(audio.duration) && audio.duration > 0 ? Number(audio.duration) : 0;
    if (audioDur > 0) return audioDur;
    var entry = _findBgmEntry(trackId);
    var entryDur = Number(entry && entry.duration);
    return Number.isFinite(entryDur) && entryDur > 0 ? entryDur : 0;
  }

  function _setBgmStatusProgress(current, duration) {
    var statusEl = $("editBgmStatus");
    if (!statusEl) return;
    var progressEl = statusEl.querySelector("[data-bgm-progress]");
    var timeEl = statusEl.querySelector("[data-bgm-time]");
    var dur = Number(duration) || 0;
    var cur = Number(current) || 0;
    if (dur > 0) cur = ((cur % dur) + dur) % dur;
    else cur = 0;
    var pct = dur > 0 ? Math.max(0, Math.min(100, cur / dur * 100)) : 0;
    if (progressEl) progressEl.style.width = pct.toFixed(2) + "%";
    if (timeEl) timeEl.textContent = _formatTime(cur) + " / " + (dur > 0 ? _formatTime(dur) : "00:00");
  }

  function _updateBgmStatusFromAudio(audio, trackId) {
    var currentTrackId = _currentBgmTrackId();
    if (!currentTrackId || (trackId && trackId !== currentTrackId)) return;
    _setBgmStatusProgress(audio ? audio.currentTime : 0, _resolveBgmDuration(currentTrackId, audio));
  }

  function _updateBgmStatusFromTimeline() {
    var trackId = _currentBgmTrackId();
    if (!trackId) {
      _setBgmStatusProgress(0, 0);
      return;
    }
    var audio = _editState._bgmAudio;
    var dur = _resolveBgmDuration(trackId, audio);
    var cur = dur > 0 ? ((_editState.globalTime || 0) % dur) : 0;
    _setBgmStatusProgress(cur, dur);
  }

  function _bindBgmPreviewProgress(audio, trackId) {
    if (!audio) return;
    audio.dataset.statusTrackId = trackId || "";
    var update = function () {
      _updateBgmStatusFromAudio(audio, trackId);
    };
    audio.ontimeupdate = update;
    audio.onloadedmetadata = update;
    audio.onpause = update;
  }

  function _formatTime(sec) {
    if (!sec || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function _highlightActiveSeg(idx) {
    var track = $("editVideoTrack");
    if (!track) return;
    var blocks = track.querySelectorAll(".edit-segment-block");
    blocks.forEach(function (b, i) {
      b.classList.toggle("edit-seg-active", i === idx);
    });
  }

  function _renderEditTags() {
    var container = $("editTagsList");
    if (!container || !_editState.segmentTags) return;
    var tags = _editState.segmentTags;
    container.innerHTML = "";

    if (tags.segments && tags.segments.length) {
      tags.segments.forEach(function (seg) {
        var PLOT_LABELS = { setup: "铺垫", rising: "递进", climax: "高潮", falling: "回落", resolution: "收尾" };
        var plotLabel = PLOT_LABELS[seg.plotRole] || seg.plotRole || "";
        var PLOT_COLORS = { setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE", resolution: "#2C3E50", climax: "#0B1320" };
        var color = PLOT_COLORS[seg.plotRole] || "#526168";
        var isDark = seg.plotRole === "climax" || seg.plotRole === "resolution";
        var textColor = isDark ? color : "#526168";
        var badgeBg = isDark ? color + "20" : color;
        var badgeText = isDark ? color : "#2C3E50";

        var html =
          '<div class="edit-tag-card" style="border-left: 3px solid ' + color + '">' +
            '<div class="flex items-center gap-2 mb-1">' +
              '<span class="text-[11px] font-bold" style="color:' + textColor + '">片段 ' + (seg.groupIdx + 1) + '</span>' +
              '<span class="text-[9px] px-1.5 py-0.5 rounded-full font-bold" style="background:' + badgeBg + ';color:' + badgeText + '">' + plotLabel + '</span>' +
              '<span class="text-[9px] text-on-surface-variant/40">' + (seg.pace || "") + '</span>' +
            '</div>' +
            '<p class="text-[10px] text-on-surface-variant/70 leading-relaxed">' + escapeHtml(seg.keyAction || "") + '</p>' +
            '<div class="flex items-center gap-1.5 mt-1 flex-wrap">' +
              '<span class="text-[9px] text-on-surface-variant/50">' + escapeHtml(seg.emotion || "") + '</span>' +
              (seg.keyCharacters ? seg.keyCharacters.map(function (c) { return '<span class="text-[8px] px-1 py-0.5 bg-surface-container rounded text-on-surface-variant/50">' + escapeHtml(c) + '</span>'; }).join("") : "") +
            '</div>' +
          '</div>';
        container.insertAdjacentHTML("beforeend", html);
      });
    }

    var arcEl = $("editNarrativeArc");
    if (arcEl && tags.segments && tags.segments.length) {
      var ARC_COLORS = { setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE", resolution: "#2C3E50", climax: "#0B1320" };
      var ARC_LABELS = { setup: "铺垫", rising: "递进", climax: "高潮", falling: "回落", resolution: "收尾" };

      var arcEl_ = $("editNarrativeArc");
      var svgW = arcEl_ ? arcEl_.clientWidth || 180 : 180;
      var svgH = 44;
      var padX = 10;
      var padY = 6;
      var n = tags.segments.length;
      var stepX = n > 1 ? (svgW - padX * 2) / (n - 1) : 0;

      var points = tags.segments.map(function (seg, idx) {
        var x = padX + idx * stepX;
        var intensity = Math.min(Math.max(seg.emotionIntensity || 3, 1), 10);
        var y = svgH - padY - ((intensity / 10) * (svgH - padY * 2));
        return { x: x, y: y, seg: seg };
      });

      var pathD = points.map(function (p, idx) { return (idx === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
      var fillD = pathD + " L" + points[points.length - 1].x.toFixed(1) + "," + (svgH - padY) + " L" + points[0].x.toFixed(1) + "," + (svgH - padY) + " Z";

      var svg = '<svg width="' + svgW + '" height="' + svgH + '" viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%">';
      svg += '<path d="' + fillD + '" fill="url(#emotionGrad)" opacity="0.25"/>';
      svg += '<path d="' + pathD + '" fill="none" stroke="#2C3E50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

      points.forEach(function (p) {
        var c = ARC_COLORS[p.seg.plotRole] || "#526168";
        var strokeC = (p.seg.plotRole === "setup" || p.seg.plotRole === "rising") ? "#90A4AE" : "white";
        svg += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="4" fill="' + c + '" stroke="' + strokeC + '" stroke-width="1.5"/>';
      });

      svg += '<defs><linearGradient id="emotionGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2C3E50"/><stop offset="100%" stop-color="#2C3E50" stop-opacity="0"/></linearGradient></defs>';
      svg += '</svg>';

      var legend = '<div class="flex flex-wrap gap-1 mt-1">';
      var seenRoles = {};
      var ARC_DARK = { climax: true, resolution: true, falling: true };
      points.forEach(function (p) {
        var role = p.seg.plotRole;
        if (role && !seenRoles[role]) {
          seenRoles[role] = true;
          var bg = ARC_COLORS[role] || "#526168";
          var txt = ARC_DARK[role] ? "#CFD8DC" : "#2C3E50";
          legend += '<span class="text-[8px] px-1.5 py-0.5 rounded-full font-bold" style="background:' + bg + ';color:' + txt + '">' + (ARC_LABELS[role] || role) + '</span>';
        }
      });
      legend += '</div>';

      arcEl.innerHTML = svg + legend;
    }
  }

  async function _loadBgmLibrary() {
    try {
      var resp = await apiGet("/api/edit/bgm-library");
      var tracks = resp.tracks || [];
      _bgmCatalogCache = tracks;
      return tracks;
    } catch (e) {
      console.warn("[Edit] BGM library load failed:", e);
      return [];
    }
  }

  function _pickAutoBgmTrack(tracks) {
    tracks = Array.isArray(tracks) ? tracks : [];
    if (!tracks.length) return null;
    var suggestedCat = "";
    if (_editState.segmentTags && _editState.segmentTags.suggestedBGMCategory) {
      suggestedCat = String(_editState.segmentTags.suggestedBGMCategory || "").toLowerCase();
    }
    var picked = suggestedCat && tracks.find(function (t) {
      return String(t && t.category || "").toLowerCase() === suggestedCat;
    });
    return picked || tracks[0] || null;
  }

  async function _renderBgmSelector() {
    var container = $("editBgmSelector");
    if (!container) return;
    var tracks = await _loadBgmLibrary();
    if (!tracks.length) {
      container.innerHTML = '<p class="edit-bgm-selector-empty">暂无背景音乐，请联系管理员添加</p>';
      return;
    }

    var CAT_LABELS = { calm: "平静", tense: "紧张", action: "动作", romantic: "浪漫", sad: "悲伤", epic: "史诗", mysterious: "神秘", hopeful: "希望" };
    var suggestedCat = "";
    if (_editState.segmentTags && _editState.segmentTags.suggestedBGMCategory) {
      suggestedCat = _editState.segmentTags.suggestedBGMCategory;
    }

    var html = '<div class="edit-bgm-option-list">';
    tracks.forEach(function (t) {
      var catLabel = CAT_LABELS[t.category] || t.category;
      var isRecommended = suggestedCat && t.category === suggestedCat;
      var isSelected = _editState.edl && _editState.edl.bgm && _editState.edl.bgm.trackId === t.id;
      var hasFile = !!t.file;

      html += '<div class="edit-bgm-option' + (isSelected ? ' is-selected' : '') + '" data-bgm-id="' + t.id + '">' +
        '<div class="edit-bgm-option-main">' +
          '<div class="edit-bgm-option-title-row">' +
            '<span class="edit-bgm-option-name">' + escapeHtml(t.name) + '</span>' +
            '<div class="edit-bgm-option-title-meta">' +
              (isRecommended ? '<span class="edit-bgm-recommend-badge">推荐</span>' : '') +
              '<span class="edit-bgm-chip">' + catLabel + '</span>' +
              '<span class="edit-bgm-option-duration">' + t.duration + 's</span>' +
            '</div>' +
          '</div>' +
          '<div class="edit-bgm-option-bottom-row">' +
            '<div class="edit-bgm-option-actions">' +
              (hasFile ? '<button type="button" class="edit-bgm-option-btn edit-bgm-option-btn--preview" data-bgm-preview="' + t.id + '" title="试听">' +
                '<span class="material-symbols-outlined">play_arrow</span>' +
                '<span data-bgm-preview-label data-bgm-idle-label="试听">试听</span>' +
              '</button>' : '') +
              '<button type="button" class="edit-bgm-option-btn edit-bgm-option-btn--select" data-bgm-select="' + t.id + '" title="选择">' +
                '<span class="material-symbols-outlined">check</span>' +
                '<span>选择</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';

    container.innerHTML = html;

    container.querySelectorAll("[data-bgm-select]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var bgmId = btn.dataset.bgmSelect;
        if (_editState.edl) {
          if (!_editState.edl.bgm || typeof _editState.edl.bgm !== "object") _editState.edl.bgm = {};
          _editState.edl.bgm.trackId = bgmId;
          _editState.edl.bgm.enabled = true; // 选曲即视为打开
          // E-4.2：BGM 选择 PATCH bgm-select（后端会把 enabled 置 true）。
          _sendTimelineOp({ op: "bgm-select", trackId: bgmId });
          var sel = $("editBgmSelector");
          if (sel) sel.hidden = true; // 选完收起列表
          _renderBgmStatus();
          _renderBgmSelector();
          // 立即同步预览 BGM player —— 用户点完应当立刻能在工作台听到效果（过程不弹提示，少打扰）
          _syncBgmPlayback();
        } else {
          showToast("请先生成剪辑方案", "warn");
        }
      });
    });

    container.querySelectorAll("[data-bgm-preview]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        _previewBgm(btn.dataset.bgmPreview, btn);
      });
    });
    // 库加载完后刷新状态头部（首次让 trackId 命中曲名/风格）
    _renderBgmStatus();
    if (_editState.edl && _editState.edl.bgm && _editState.edl.bgm.trackId) {
      _renderEditTimeline();
    }
  }

  /* ── 转场控制面板（BGM 下方） ── */

  /** 渲染转场分布摘要 + 启用/禁用"去除全部转场"按钮 */
  function _renderTransitionPanel() {
    var summary = $("editTransitionSummary");
    var btn = $("btnEditClearTransitions");
    if (!btn) return; // summary 已移到标题区，可能不存在，仅作可选展示

    var timeline = (_editState.edl && _editState.edl.timeline) || [];
    if (!timeline.length) {
      if (summary) {
        summary.textContent = "成片后显示当前转场分布";
        summary.className = "text-[10px] text-white/40 mb-2";
      }
      btn.disabled = true;
      return;
    }

    var counts = { cut: 0, fade: 0, dissolve: 0, wipe: 0, other: 0 };
    timeline.forEach(function (seg, i) {
      if (i === 0) return; // 首段无入转场
      var t = String((seg.transitionIn && seg.transitionIn.type) || "cut").toLowerCase();
      if (counts[t] != null) counts[t]++;
      else counts.other++;
    });
    var nonCut = counts.fade + counts.dissolve + counts.wipe + counts.other;

    if (nonCut === 0) {
      if (summary) {
        summary.textContent = "全部硬切（" + (timeline.length - 1) + " 处衔接）";
        summary.className = "text-[10px] text-white/40 mb-2";
      }
      btn.disabled = true;
    } else {
      var parts = [];
      if (counts.fade) parts.push(counts.fade + " fade");
      if (counts.dissolve) parts.push(counts.dissolve + " dissolve");
      if (counts.wipe) parts.push(counts.wipe + " wipe");
      if (counts.other) parts.push(counts.other + " 其它");
      if (summary) {
        summary.textContent = "当前 " + nonCut + " 处转场（" + parts.join(" · ") + "）";
        summary.className = "text-[10px] text-white/55 mb-2";
      }
      btn.disabled = false;
    }
  }

  /** 绑定"去除全部转场"按钮（只绑一次）。BGM 开关在 _renderBgmStatus 里绑定。 */
  function _wireTransitionControls() {
    var btn = $("btnEditClearTransitions");
    if (btn && btn.dataset.wired !== "1") {
      btn.dataset.wired = "1";
      btn.addEventListener("click", _clearAllTransitions);
    }
  }

  /** 切换 BGM 总开关（开/关）。打开时若尚未选曲，自动按视频分析标签匹配一首。 */
  async function _setBgmEnabled(enabled) {
    if (!_editState.edl) {
      var tg = $("editBgmToggle");
      if (tg) tg.checked = false;
      showToast("请先生成剪辑方案", "warn");
      return;
    }
    _editSaveUndo();
    if (!_editState.edl.bgm || typeof _editState.edl.bgm !== "object") _editState.edl.bgm = {};
    var prevBgm = _editState.edl.bgm;
    var trackId = prevBgm.trackId || "";
    if (enabled && !trackId) {
      var tracks = _bgmCatalogCache && _bgmCatalogCache.length ? _bgmCatalogCache : await _loadBgmLibrary();
      var picked = _pickAutoBgmTrack(tracks);
      if (!picked) {
        prevBgm.enabled = false;
        var toggle = $("editBgmToggle");
        if (toggle) toggle.checked = false;
        showToast("BGM 曲库为空，无法自动匹配", "warn");
        _renderBgmStatus();
        return;
      }
      trackId = picked.id;
      prevBgm.trackId = trackId;
      prevBgm.offsetTime = Number(prevBgm.offsetTime) > 0 ? Number(prevBgm.offsetTime) : 0;
    }
    prevBgm.enabled = !!enabled;
    if (project) {
      if (!project.editData) project.editData = {};
      project.editData.edl = _editState.edl; // arch-guard:allow-editdata
    }
    if (enabled && trackId) {
      _sendTimelineOp({ op: "bgm-select", trackId: trackId });
    } else {
      _sendTimelineOp({ op: "bgm-toggle", enabled: false });
    }
    _renderBgmStatus();
    _renderEditTimeline();   // A1 轨道即时反映开/关
    _syncBgmPlayback();      // 关→停播，开→续播
  }

  // BGM 流用带 token 的 fetch 取回转成 blob objectURL，再喂给 <audio>。
  // 原因：鉴权走 Authorization: Bearer，而 <audio src> 这类媒体请求带不了自定义 header，
  // 直接用 /api/edit/bgm/<id> 会被 getCurrentUser 判 401、静默没声音。按 id 缓存避免重复拉取。
  var _bgmBlobUrlCache = {};
  function _ensureBgmObjectUrl(id, cb) {
    if (!id) return;
    if (_bgmBlobUrlCache[id]) { cb(_bgmBlobUrlCache[id]); return; }
    var token = "";
    try { token = localStorage.getItem("sw_auth_token") || ""; } catch (_e) {}
    fetch("/api/edit/bgm/" + encodeURIComponent(id), {
      headers: token ? { Authorization: "Bearer " + token } : {}
    })
      .then(function (r) { if (!r.ok) throw new Error("bgm " + r.status); return r.blob(); })
      .then(function (blob) { var u = URL.createObjectURL(blob); _bgmBlobUrlCache[id] = u; cb(u); })
      .catch(function (e) { console.warn("[bgm] 取流失败:", id, (e && e.message) || e); });
  }

  /** 试听某首 BGM：再点一次停。单例预览 audio，与列表共用。 */
  function _previewBgm(id, btn) {
    var audio = document.getElementById("_bgmPreviewAudio");
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = "_bgmPreviewAudio";
      document.body.appendChild(audio);
    }
    var labelSpan = btn && btn.querySelector("[data-bgm-preview-label]");
    var iconSpan = btn && btn.querySelector(".material-symbols-outlined");
    var idleLabel = (labelSpan && labelSpan.dataset && labelSpan.dataset.bgmIdleLabel) || (labelSpan && labelSpan.textContent && labelSpan.textContent.trim()) || "播放";
    function setBtnState(iconValue, labelValue) {
      if (iconSpan) iconSpan.textContent = iconValue;
      if (labelSpan) labelSpan.textContent = labelValue;
    }
    if (audio.dataset.playing === id || audio.dataset.pending === id) {
      try { audio.pause(); } catch (_e) {}
      audio.dataset.playing = "";
      audio.dataset.pending = "";
      setBtnState("play_arrow", idleLabel);
      _updateBgmStatusFromAudio(audio, id);
    } else {
      audio.dataset.pending = id;
      audio.dataset.playing = "";
      setBtnState("progress_activity", "加载");
      _bindBgmPreviewProgress(audio, id);
      _ensureBgmObjectUrl(id, function (objUrl) {
        if (audio.dataset.pending !== id) return;
        audio.src = objUrl;
        audio.play().then(function () {
          audio.dataset.pending = "";
          audio.dataset.playing = id;
          setBtnState("pause", "暂停");
          _updateBgmStatusFromAudio(audio, id);
        }).catch(function (err) {
          audio.dataset.pending = "";
          audio.dataset.playing = "";
          setBtnState("play_arrow", idleLabel);
          _updateBgmStatusFromAudio(audio, id);
          console.warn("[bgm] preview play failed:", err);
        });
        audio.onended = function () {
          setBtnState("play_arrow", idleLabel);
          audio.dataset.playing = "";
          audio.dataset.pending = "";
          try { audio.currentTime = 0; } catch (_e) {}
          _updateBgmStatusFromAudio(audio, id);
        };
      });
    }
  }

  /** 渲染右侧"背景音乐"状态头部：默认关闭；用户打开后自动匹配一首，之后可换曲。 */
  function _renderBgmStatus() {
    var statusEl = $("editBgmStatus");
    var toggle = $("editBgmToggle");
    if (!statusEl) return;

    var bgm = (_editState.edl && _editState.edl.bgm) || null;
    var enabled = !!(bgm && bgm.enabled === true);
    var panel = statusEl.closest ? statusEl.closest(".edit-bgm-panel") : null;
    if (panel) {
      panel.classList.toggle("is-bgm-on", enabled);
      panel.classList.toggle("is-bgm-off", !enabled);
    }

    if (toggle) {
      toggle.checked = enabled;
      if (toggle.dataset.wired !== "1") {
        toggle.dataset.wired = "1";
        toggle.addEventListener("change", function () { _setBgmEnabled(toggle.checked); });
      }
    }

    if (!_editState.edl) {
      statusEl.innerHTML = '<div class="edit-bgm-current edit-bgm-current--empty">' +
        '<div class="edit-bgm-track-card">' +
          '<div class="edit-bgm-art edit-bgm-art--dim"><span class="material-symbols-outlined">music_note</span></div>' +
          '<div class="edit-bgm-track-main">' +
            '<div class="edit-bgm-track-title-row"><span class="edit-bgm-track-name">背景音乐默认关闭</span></div>' +
            '<div class="edit-bgm-meta-row"><span class="edit-bgm-meta-pill">OFF</span></div>' +
          '</div>' +
          '<div class="edit-bgm-waveform-row"><span class="edit-bgm-waveform edit-bgm-waveform--dim"><span class="edit-bgm-waveform-active" data-bgm-progress></span></span></div>' +
          '<div class="edit-bgm-time-row"><span data-bgm-time>00:00 / 00:00</span></div>' +
        '</div>' +
      '</div>';
      return;
    }
    if (!enabled) {
      statusEl.innerHTML = '<div class="edit-bgm-current edit-bgm-current--off">' +
        '<div class="edit-bgm-track-card">' +
          '<div class="edit-bgm-art edit-bgm-art--off"><span class="material-symbols-outlined">music_off</span></div>' +
          '<div class="edit-bgm-track-main">' +
            '<div class="edit-bgm-track-title-row"><span class="edit-bgm-track-name">背景音乐已关闭</span></div>' +
            '<div class="edit-bgm-meta-row"><span class="edit-bgm-meta-pill">OFF</span></div>' +
          '</div>' +
          '<div class="edit-bgm-waveform-row"><span class="edit-bgm-waveform edit-bgm-waveform--dim"><span class="edit-bgm-waveform-active" data-bgm-progress></span></span></div>' +
          '<div class="edit-bgm-time-row"><span data-bgm-time>00:00 / 00:00</span></div>' +
        '</div>' +
      '</div>';
      return;
    }

    var CAT_LABELS = { calm: "平静", tense: "紧张", action: "动作", romantic: "浪漫", sad: "悲伤", epic: "史诗", mysterious: "神秘", hopeful: "希望" };
    var trackId = bgm && bgm.trackId;
    var entry = trackId ? (_bgmCatalogCache || []).find(function (t) { return t.id === trackId; }) : null;

    if (!entry) {
      statusEl.innerHTML = '<div class="edit-bgm-current edit-bgm-current--auto">' +
        '<div class="edit-bgm-track-card">' +
          '<div class="edit-bgm-art"><span class="material-symbols-outlined">music_note</span></div>' +
          '<div class="edit-bgm-track-main">' +
            '<div class="edit-bgm-track-title-row"><span class="edit-bgm-track-name">正在匹配配乐</span></div>' +
            '<div class="edit-bgm-meta-row"><span class="edit-bgm-meta-pill">AUTO</span></div>' +
          '</div>' +
          '<div class="edit-bgm-waveform-row"><span class="edit-bgm-waveform"><span class="edit-bgm-waveform-active" data-bgm-progress></span></span></div>' +
          '<div class="edit-bgm-time-row"><span data-bgm-time>00:00 / 00:00</span></div>' +
        '</div>' +
        '<div class="edit-bgm-actions-row">' +
          '<button type="button" data-bgm-expand class="edit-bgm-change-btn">换曲</button>' +
        '</div>' +
      '</div>';
    } else {
      var catLabel = CAT_LABELS[entry.category] || entry.category;
      var sugCat = _editState.segmentTags && _editState.segmentTags.suggestedBGMCategory;
      var isRec = sugCat && entry.category === sugCat;
      var dur = Number(entry.duration) || 0;
      var durText = dur > 0 ? _formatTime(dur) : "--:--";
      statusEl.innerHTML =
        '<div class="edit-bgm-current">' +
          '<div class="edit-bgm-track-card">' +
            '<div class="edit-bgm-art"><span class="material-symbols-outlined" style="font-variation-settings:\'FILL\' 1">music_note</span></div>' +
            '<div class="edit-bgm-track-main">' +
              '<div class="edit-bgm-track-title-row">' +
                '<span class="edit-bgm-track-name">' + escapeHtml(entry.name) + '</span>' +
                (isRec ? '<span class="edit-bgm-recommend-badge">推荐</span>' : '') +
              '</div>' +
              '<div class="edit-bgm-meta-row">' +
                '<span class="edit-bgm-chip">' + escapeHtml(catLabel) + '</span>' +
                '<span class="edit-bgm-meta-pill">' + durText + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="edit-bgm-waveform-row"><span class="edit-bgm-waveform"><span class="edit-bgm-waveform-active" data-bgm-progress></span></span></div>' +
            '<div class="edit-bgm-time-row"><span data-bgm-time>00:00 / ' + durText + '</span></div>' +
          '</div>' +
          '<div class="edit-bgm-actions-row">' +
            '<button type="button" data-bgm-preview-cur="' + escapeHtml(entry.id) + '" class="edit-bgm-play-btn" title="试听">' +
              '<span class="material-symbols-outlined" data-bgm-preview-icon>play_arrow</span>' +
              '<span data-bgm-preview-label data-bgm-idle-label="播放">播放</span>' +
            '</button>' +
            '<button type="button" data-bgm-expand class="edit-bgm-change-btn">' +
              '<span class="material-symbols-outlined">sync</span>' +
              '<span>换曲</span>' +
            '</button>' +
          '</div>' +
        '</div>';
    }

    var expandBtn = statusEl.querySelector("[data-bgm-expand]");
    if (expandBtn) expandBtn.addEventListener("click", function () {
      var sel = $("editBgmSelector");
      if (!sel) return;
      sel.hidden = !sel.hidden;
      if (!sel.hidden) _renderBgmSelector();
    });
    var curPrev = statusEl.querySelector("[data-bgm-preview-cur]");
    if (curPrev) curPrev.addEventListener("click", function () { _previewBgm(curPrev.dataset.bgmPreviewCur, curPrev); });
    var previewAudio = document.getElementById("_bgmPreviewAudio");
    if (previewAudio && previewAudio.dataset.playing === trackId) {
      _updateBgmStatusFromAudio(previewAudio, trackId);
    } else {
      _updateBgmStatusFromTimeline();
    }
  }

  /** 把 timeline 里所有 transitionIn 改成 cut，写盘 + 重渲染。可用 Undo 恢复。 */
  function _clearAllTransitions() {
    if (!_editState.edl || !Array.isArray(_editState.edl.timeline)) {
      showToast("还没有剪辑方案", "warn");
      return;
    }
    var timeline = _editState.edl.timeline;
    var hasAny = timeline.some(function (s, i) {
      if (i === 0) return false;
      var t = (s.transitionIn && s.transitionIn.type) || "cut";
      return t !== "cut";
    });
    if (!hasAny) { showToast("已经全是硬切了", "ok"); return; }

    _editSaveUndo();
    timeline.forEach(function (s, i) {
      if (i === 0) return;
      s.transitionIn = { type: "cut", duration: 0 };
      // transitionOut 影响下一段的入转场预览，保持对齐
      if (i < timeline.length - 1) s.transitionOut = { type: "cut", duration: 0 };
    });

    // 同步内存镜像 + 持久化
    if (project) {
      if (!project.editData) project.editData = {};
      project.editData.edl = _editState.edl; // arch-guard:allow-editdata
    }
    _sendTimelineOp({ op: "set-edl", edl: _edlForPersistence(_editState.edl) });

    _buildSegStartTimes();
    _renderEditTimeline();
    _renderTransitionPanel();
    _updatePlayhead();
    showToast("已去除全部转场，可用「撤销」恢复", "ok");
  }

  var _editActionBusy = {};
  function _editActionStart(btnId, wrapId, spinnerColor, loadText, loadSub) {
    if (_editActionBusy[btnId]) return false;
    _editActionBusy[btnId] = true;
    var btn = $(btnId);
    var wrap = $(wrapId);
    if (btn) btn.disabled = true;
    if (wrap) {
      wrap.style.position = "relative";
      var overlay = document.createElement("div");
      overlay.className = "edit-action-loading";
      overlay.id = wrapId + "_loading";
      overlay.innerHTML =
        '<div class="edit-action-spinner" style="--spinner-color:' + (spinnerColor || '#67e8f9') + '"></div>' +
        '<span class="edit-load-text">' + (loadText || '处理中…') + '</span>' +
        '<span class="edit-load-sub">' + (loadSub || 'Processing') + '</span>';
      wrap.appendChild(overlay);
    }
    return true;
  }
  function _editActionEnd(btnId, wrapId, originalLabel) {
    _editActionBusy[btnId] = false;
    var btn = $(btnId);
    if (btn) {
      btn.disabled = false;
      var labelEl = btn.querySelector(".edit-action-label-cn");
      if (labelEl) labelEl.textContent = originalLabel || "";
    }
    var overlay = $(wrapId + "_loading");
    if (overlay) {
      overlay.style.animation = "editLoadFadeIn 0.2s ease-in reverse forwards";
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
    }
  }
  function _editActionProgress(wrapId, text) {
    var overlay = $(wrapId + "_loading");
    if (!overlay) return;
    var el = overlay.querySelector(".edit-load-text");
    if (el) el.textContent = text;
  }

  async function _analyzeEditSegments() {
    if (!project || !project.script) {
      showToast("请先生成剧本", "error");
      return;
    }
    if (!_editActionStart("btnEditAnalyze", "editCardAnalyze", "#67e8f9", "正在分析叙事结构…", "Analyzing")) return;

    try {
      var shotsData = (project.shots || []).map(function (s) {
        return { visual: s.visual, camera: s.camera, shotType: s.shotType, duration: s.duration, dialogue: s.dialogue, audio: s.audio, keyInfo: s.keyInfo, characters: s.characters, scenes: s.scenes };
      });
      var _analyzeChars = 0;
      var resp = await apiPostStream("/api/edit/analyze", {
        // E-3.2/3.3：projectId 交给后端，让 /analyze SSE done 前做 apply_edit_patch_and_save。
        projectId: (project && project.id) || "",
        script: project.script,
        styleBible: project.styleBible || {},
        shots: shotsData,
        segments: _editState.segments.map(function (s) {
          return { groupIdx: s.groupIdx, duration: s.duration, shotIndices: s.shotIndices };
        }),
      }, function (chunk) {
        _analyzeChars += chunk.length;
        var pct = Math.min(90, 10 + Math.floor(_analyzeChars / 50));
        _editActionProgress("editCardAnalyze", "分析中");
      });

      _editState.segmentTags = resp.result;
      // E-3.3：不再前端 saveProject() 写盘——后端已在 SSE done 前落盘，
      // 这里只把内存里的展示态对齐 + 推进 version。刷新后 GET 会拿到权威 editData。
      if (project && resp && resp.serverVersion != null && _ctx.bumpProjectVersion) {
        _ctx.bumpProjectVersion(resp.serverVersion);
      }
      if (project) {
        if (!project.editData) project.editData = {};
        project.editData.segmentTags = resp.result; // arch-guard:allow-editdata 内存镜像（后端 SSE 已落盘）
      }

      _renderEditTags();
      _renderEditTimeline();
      _renderBgmSelector();
      var genBtn = $("btnEditGenEdl");
      if (genBtn) genBtn.disabled = false;
      showToast("片段分析完成", "ok");
    } catch (e) {
      showToast("片段分析失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    _editActionEnd("btnEditAnalyze", "editCardAnalyze", "片段分析");
  }

  async function _applyGeneratedEdlResponse(resp) {
    if (!resp || !resp.result) return false;
      await _hydrateEdlVideoUrls(resp.result);
      _editState.edl = resp.result;
      // E-3.3：同 _analyzeEditSegments，EDL 已由 /generate-edl SSE done 前落盘，
      // 前端只推 version + 更新展示态，不再 saveProject。
      if (project && resp && resp.serverVersion != null && _ctx.bumpProjectVersion) {
        _ctx.bumpProjectVersion(resp.serverVersion);
      }
      if (project) {
        if (!project.editData) project.editData = {};
        project.editData.edl = resp.result; // arch-guard:allow-editdata 内存镜像（后端 SSE 已落盘）
      }

      _renderEditTimeline();
      _renderBgmSelector();
      _renderBgmStatus();
      _syncBgmPlayback();
      _syncEditExportButtonState();
      // 把 LLM 给的剪辑思路一起 toast 出来，方便用户理解成片结构。
      var narr = (resp.result && resp.result.narrative) || (resp && resp.narrative) || "";
      var dur = (resp.result && resp.result.duration) || 0;
      var msg = "剪辑方案已生成";
      if (dur > 0) msg += "（共 " + dur.toFixed(1) + "s）";
      if (narr) msg += "：" + narr;
      showToast(msg, "ok");
      return true;
  }

  function _currentEditSegmentsForEdl() {
    return _editState.segments.map(function (s) {
      return { groupIdx: s.groupIdx, videoUrl: _segPersistedVideoUrl(s), duration: s.duration };
    });
  }

  async function _generateEditEdlLegacy() {
    var _edlChars = 0;
    return apiPostStream("/api/edit/generate-edl", {
      projectId: (project && project.id) || "",
      segmentTags: _editState.segmentTags,
      segments: _currentEditSegmentsForEdl(),
    }, function (chunk) {
      _edlChars += chunk.length;
      var pct = Math.min(90, 10 + Math.floor(_edlChars / 40));
      _editActionProgress("editCardGenEdl", "生成进度 " + pct + "%");
    });
  }

  function _edlDraftConfirmMessage(resp) {
    var draft = (resp && (resp.draftResult || resp.result)) || {};
    var dur = Number(draft.duration) || 0;
    var narr = String(draft.narrative || "").trim();
    var warnings = Array.isArray(resp && resp.qcWarnings) ? resp.qcWarnings : [];
    var msg = "已生成剪辑草稿，确认后才会写入当前时间线。";
    if (dur > 0) msg += "\n预计时长：" + dur.toFixed(1) + "s";
    if (warnings.length) msg += "\n质检提醒：" + warnings.length + " 条";
    if (narr) msg += "\n剪辑思路：" + narr;
    return msg;
  }

  async function _resumeEditEdlGraph(threadId, action) {
    return apiPostStream("/api/edit/generate-edl-graph", {
      threadId: threadId,
      action: action,
    }, null, function (evt) {
      if (evt && evt.type === "phase" && evt.name === "commit_edl") {
        _editActionProgress("editCardGenEdl", "正在应用剪辑草稿…");
      }
    });
  }

  async function _generateEditEdlGraph() {
    var _edlChars = 0;
    var approvalEvent = null;
    var resp = await apiPostStream("/api/edit/generate-edl-graph", {
      projectId: (project && project.id) || "",
      segmentTags: _editState.segmentTags,
      segments: _currentEditSegmentsForEdl(),
    }, function (chunk) {
      _edlChars += chunk.length;
      var pct = Math.min(90, 10 + Math.floor(_edlChars / 40));
      _editActionProgress("editCardGenEdl", "生成进度 " + pct + "%");
    }, function (evt) {
      if (evt && evt.type === "needs_approval") approvalEvent = evt;
    });

    if (!resp.needsApproval && resp.result && resp.serverVersion != null) return resp;

    var pending = approvalEvent || resp;
    var threadId = pending && pending.threadId;
    if (!threadId) throw new Error("EDL 草稿缺少 threadId，无法确认");

    var ok = await showConfirm(
      "确认剪辑草稿",
      _edlDraftConfirmMessage(pending),
      "应用到时间线",
      "放弃草稿"
    );
    if (!ok) {
      await _resumeEditEdlGraph(threadId, "reject").catch(function () {});
      showToast("已放弃剪辑草稿", "ok");
      return null;
    }

    var conflictEvent = null;
    var finalResp = await apiPostStream("/api/edit/generate-edl-graph", {
      threadId: threadId,
      action: "approve",
    }, null, function (evt) {
      if (evt && evt.type === "phase" && evt.name === "commit_edl") {
        _editActionProgress("editCardGenEdl", "正在应用剪辑草稿…");
      }
      if (evt && evt.type === "needs_approval") conflictEvent = evt;
    });

    if (finalResp.needsApproval || (conflictEvent && conflictEvent.approvalType === "edl_version_conflict")) {
      var rerun = await showConfirm(
        "时间线已变化",
        "你确认草稿前，剪辑时间线已经被修改。为避免覆盖手工编辑，当前草稿不会写入。\n是否基于当前时间线重新生成？",
        "重新生成",
        "放弃草稿"
      );
      await _resumeEditEdlGraph(threadId, rerun ? "rerun" : "discard").catch(function () {});
      if (rerun) {
        showToast("请重新生成当前时间线的剪辑草稿", "error");
      } else {
        showToast("已放弃冲突的剪辑草稿", "ok");
      }
      return null;
    }

    return finalResp;
  }

  async function _generateEditEdl() {
    if (!_editState.segmentTags) {
      showToast("请先运行一键成片生成片段分析", "error");
      return;
    }
    if (!_editActionStart("btnEditGenEdl", "editCardGenEdl", "#c084fc", "正在生成剪辑方案…", "Generating")) return;

    try {
      var useLegacy = false;
      try { useLegacy = localStorage.getItem("origin_legacy_edl") === "1"; } catch (_e) {}
      var resp = useLegacy ? await _generateEditEdlLegacy() : await _generateEditEdlGraph();
      if (resp) await _applyGeneratedEdlResponse(resp);
    } catch (e) {
      showToast("剪辑方案生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    _editActionEnd("btnEditGenEdl", "editCardGenEdl", "剪辑方案");
  }

  // E-2.2：正在订阅中的导出 SSE 句柄。刷新 / 重入时幂等重订。
  var _exportStreamHandle = null;

  var _exportDownloaded = false;

  function _exportFilenameFromContentDisposition(header) {
    header = String(header || "");
    if (!header) return "";
    var starMatch = header.match(/filename\*\s*=\s*([^;]+)/i);
    if (starMatch && starMatch[1]) {
      var encoded = starMatch[1].trim().replace(/^['"]|['"]$/g, "");
      var utf8Prefix = encoded.match(/^utf-8''(.+)$/i);
      try {
        return decodeURIComponent(utf8Prefix ? utf8Prefix[1] : encoded);
      } catch (_) {}
    }
    var quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
    if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();
    var plainMatch = header.match(/filename\s*=\s*([^;]+)/i);
    return plainMatch && plainMatch[1] ? plainMatch[1].trim() : "";
  }

  function _downloadExportFile(url, opts) {
    var force = !!(opts && opts.force);
    if (_exportDownloaded && !force) return;
    _exportDownloaded = true;
    var fname = "export_" + (project && project.id ? project.id : "video") + ".mp4";
    fetch(url, { headers: getAuthHeaders() })
      .then(function (resp) {
        if (!resp.ok) throw new Error("下载失败: " + resp.status);
        fname = _exportFilenameFromContentDisposition(resp.headers.get("Content-Disposition")) || fname;
        return resp.blob();
      })
      .then(function (blob) {
        var blobUrl = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = blobUrl;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 5000);
      })
      .catch(function (err) {
        console.error("[Export] download error:", err);
        showToast("下载失败: " + (err.message || "未知错误"), "error");
        _exportDownloaded = false;
      });
  }

  function _handleEditExportClick(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var state = _getEditExportState();
    var editData = _getEditData();
    if (state.state === "composing") {
      showToast("一键成片正在运行，完成后即可下载", "warn");
      return;
    }
    if (state.state === "download" && editData.exportUrl) {
      _downloadExportFile(editData.exportUrl, { force: true });
      return;
    }
    if (state.state === "stale") {
      _pulseAutoComposeButton();
      return;
    }
    if (state.state === "export") {
      _exportEditVideo();
      return;
    }
    if (state.state === "exporting") {
      showToast("导出正在进行中，请稍候", "warn");
      return;
    }
    showToast("请先一键成片，再下载成片", "warn");
  }

  function _attachExportStream(taskId) {
    _exportDownloaded = false;
    if (!taskId) return;
    if (_exportStreamHandle) {
      try { _exportStreamHandle.close(); } catch (_e) {}
      _exportStreamHandle = null;
    }
    var handle = subscribeTask(taskId, {
      onProgress: function (data) {
        var pct = (data && data.progress != null) ? data.progress : 0;
        _editActionProgress("editCardExport", "导出中 " + pct + "%");
      },
      onCompleted: function (data) {
        var url = (data && (data.downloadUrl || data.resultUrl)) || "";
        var edlVersion = data && data.edlVersion;
        var edlSignature = data && (data.edlSignature || data.exportedEdlSignature);
        var edlSignatureMeta = data && data.exportedEdlSignatureMeta;
        if (project && url) {
          if (!project.editData) project.editData = {};
          // E-3.3 前置：exportUrl/exportTaskId 的权威落盘将由后端 _run_export → task_store
          // 承担（这里不再 saveProject 写盘），只把内存里的展示字段更新，让 UI 立刻显示下载按钮。
          project.editData.exportUrl = url; // arch-guard:allow-editdata 内存镜像（后端 task_store 是权威源）
          project.editData.exportTaskId = taskId;
          if (typeof edlVersion !== "undefined") project.editData.exportedEdlVersion = edlVersion; // arch-guard:allow-editdata
          if (edlSignature) project.editData.exportedEdlSignature = edlSignature; // arch-guard:allow-editdata
          if (edlSignatureMeta) project.editData.exportedEdlSignatureMeta = edlSignatureMeta; // arch-guard:allow-editdata
        }
        if (url) {
          showToast("成片导出完成，点击「下载成片」保存文件", "ok");
        }
        _editActionEnd("btnEditExport", "editCardExport", "下载导出");
        _exportStreamHandle = null;
        _syncEditExportButtonState();
      },
      onFailed: function (data) {
        var msg = (data && (data.reason || data.errorMsg)) || "导出失败";
        if (project && project.editData && project.editData.exportTaskId === taskId && !project.editData.exportUrl) {
          project.editData.exportTaskId = "";
        }
        showToast("导出失败: " + _diagnoseApiError(msg), "error");
        _editActionEnd("btnEditExport", "editCardExport", "下载导出");
        _exportStreamHandle = null;
        _syncEditExportButtonState();
      },
      onClose: function () {
        // SSE 异常断开：兜底拉一次 HTTP 状态确认结果，避免按钮卡死。
        apiGet("/api/edit/export-status/" + taskId).then(function (status) {
          if (!status) return;
          var isCompleted = status.done || status.status === "completed";
          var isFailed = status.status === "failed" || status.status === "cancelled" || status.status === "timeout";
          var downloadUrl = status.downloadUrl || status.url || "";
          var edlVersion = status.edlVersion;
          var edlSignature = status.edlSignature || status.exportedEdlSignature;
          var edlSignatureMeta = status.exportedEdlSignatureMeta;
          var errorMsg = status.error || status.errorMsg || "";
          var restarted = status.restarted || errorMsg === "orphaned by server restart";
          if (isCompleted || isFailed) {
            if (isCompleted && downloadUrl) {
              if (project) {
                if (!project.editData) project.editData = {};
                project.editData.exportUrl = downloadUrl; // arch-guard:allow-editdata HTTP 兜底内存镜像
                project.editData.exportTaskId = taskId;
                if (typeof edlVersion !== "undefined") project.editData.exportedEdlVersion = edlVersion; // arch-guard:allow-editdata
                if (edlSignature) project.editData.exportedEdlSignature = edlSignature; // arch-guard:allow-editdata
                if (edlSignatureMeta) project.editData.exportedEdlSignatureMeta = edlSignatureMeta; // arch-guard:allow-editdata
              }
              showToast("成片导出完成，点击「下载成片」保存文件", "ok");
            } else if (restarted) {
              showToast("服务刚刚重启了，这次导出中断了，点「下载导出」重试一次就好", "warn");
            } else if (isFailed || errorMsg) {
              showToast("导出失败: " + _diagnoseApiError(errorMsg || "导出失败"), "error");
            }
            if (isFailed && project && project.editData && project.editData.exportTaskId === taskId && !project.editData.exportUrl) {
              project.editData.exportTaskId = "";
            }
            _editActionEnd("btnEditExport", "editCardExport", "下载导出");
            _syncEditExportButtonState();
          }
        }).catch(function () {});
        _exportStreamHandle = null;
        _syncEditExportButtonState();
      },
    });
    _exportStreamHandle = handle;
  }

  async function _exportEditVideo() {
    var segs = _getTimelineSegs();
    if (!segs || segs.length === 0) {
      showToast("时间线上没有素材", "error");
      return;
    }
    if (!_editActionStart("btnEditExport", "editCardExport", "#34d399", "正在下载导出…", "Exporting")) return;

    var exportEdl = _editState.edl ? _edlForPersistence(_editState.edl) : {
      timeline: segs.map(function (s) {
        return {
          groupIdx: s.groupIdx,
          videoUrl: _segPersistedVideoUrl(s),
          inPoint: s.inPoint || 0,
          outPoint: s.outPoint || s.duration || 0,
          duration: s.duration || 0,
        };
      }),
    };

    try {
      var resp = await apiPost("/api/edit/export", {
        projectId: (project && project.id) || "",
        edl: exportEdl,
        edlVersion: _currentEditEdlVersion(),
        segments: segs.map(function (s) {
          return { groupIdx: s.groupIdx, videoUrl: _segPersistedVideoUrl(s), duration: s.duration };
        }),
      });

      var taskId = resp.taskId;
      if (!taskId) {
        throw new Error(resp && resp.error ? resp.error : "任务创建失败");
      }
      // E-2.2：taskId 通过 task_store 持久化（register 已在后端做过），前端只需要
      // 在内存里缓存就够——不再 saveProject 写盘（Bug F 同款）。刷新后由
      // _tryResumeExportStream() 从 editData 里读回重订。
      if (project) {
        if (!project.editData) project.editData = {};
        project.editData.exportTaskId = taskId;
        project.editData.exportUrl = "";
      }
      _syncEditExportButtonState();
      showToast("导出任务已提交，正在处理…", "ok");
      _attachExportStream(taskId);
    } catch (e) {
      if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
        showBillingPaywall(e.billing || null);
      } else {
        showToast("导出失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      }
      _editActionEnd("btnEditExport", "editCardExport", "下载导出");
      _syncEditExportButtonState();
    }
  }

  // 时间线被手工改过后的轻确认弹窗：只有「确定」会动作（设为新基线并继续成片），
  // 取消 / 右上角 ✕ / 点弹窗外区域 一律不做事。视觉按剪辑页确认弹窗设计稿收敛。
  function _confirmOverwriteTimeline() {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "qd-ow-overlay";
      overlay.innerHTML =
        '<div class="qd-ow-card" role="dialog" aria-modal="true" aria-labelledby="qdOverwriteTitle">' +
          '<button type="button" class="qd-ow-x" aria-label="关闭">' +
            '<span class="material-symbols-outlined">close</span>' +
          '</button>' +
          '<div class="qd-ow-body">' +
            '<div class="qd-ow-title-row">' +
              '<span class="material-symbols-outlined qd-ow-warning" aria-hidden="true">warning</span>' +
              '<h2 id="qdOverwriteTitle">提示：修改前的内容将会被覆盖</h2>' +
            '</div>' +
            '<div class="qd-ow-actions">' +
              '<button type="button" class="qd-ow-cancel">取消</button>' +
              '<button type="button" class="qd-ow-ok">确定</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      var settled = false;
      function onKey(e) { if (e.key === "Escape") done(false); }
      function done(val) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(val);
      }
      overlay.querySelector(".qd-ow-ok").onclick = function () { done(true); };
      overlay.querySelector(".qd-ow-cancel").onclick = function () { done(false); };
      overlay.querySelector(".qd-ow-x").onclick = function () { done(false); };
      overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
    });
  }

  // 「确定」分支：把当前（手工改过的）时间线设为新基线，再自动接着成片，
  // 用户不必再手动点一次「一键成片」。失败则提示并停下。
  async function _acceptTimelineAndCompose() {
    if (!project || !project.id) return;
    try {
      await apiPost("/api/edit/auto-compose/recovery", {
        projectId: project.id,
        action: "accept-current",
      });
      await _resyncEditDataFromServer();
    } catch (e) {
      showToast("处理失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      return;
    }
    await _autoComposeEditVideo();
  }

  // 一键成片进度：按阶段统一显示一句短文案，避免后端下发的长 step 标签把按钮撑爆。
  function _composePhaseLabel(phase) {
    switch (phase) {
      case "preflight": return "检查片段中…";
      case "analyze": return "分析结构中…";
      case "edl": return "方案生成中…";
      case "export": return "导出中…";
      default: return "处理中…";
    }
  }

  async function _autoComposeEditVideo() {
    if (!project || !project.id) {
      showToast("请先打开项目", "error");
      return;
    }
    if (!_editState.segments || !_editState.segments.length) {
      showToast("当前没有可用片段", "error");
      return;
    }
    if (!_editActionStart("btnEditAutoCompose", "editCardAutoCompose", "#fbbf24", "检查片段中…", "Composing")) return;

    var capturedError = null;
    var partialHintShown = false;
    var needOverwriteConfirm = false;
    var observedExportTaskId = "";
    var shouldResumeExportStream = false;
    try {
      var resp = await apiPostStream("/api/edit/auto-compose", {
        projectId: project.id,
        mode: "start",
      }, null, function (evt) {
        if (!evt) return;
        if (evt.type === "phase") {
          _editActionProgress("editCardAutoCompose", _composePhaseLabel(evt.phase));
        } else if (evt.type === "preflight_result") {
          if (evt.partial && !partialHintShown) {
            partialHintShown = true;
            var skipped = Number(evt.skipped || 0) + Number(evt.stale || 0);
            if (skipped > 0) showToast("将跳过 " + skipped + " 个不可用片段继续成片", "warn");
          }
        } else if (evt.type === "export_started") {
          observedExportTaskId = String(evt.taskId || "");
          if (project) {
            if (!project.editData) project.editData = {};
            project.editData.exportTaskId = evt.taskId;
            project.editData.exportUrl = "";
          }
          _syncEditExportButtonState();
        } else if (evt.type === "export_progress") {
          _editActionProgress("editCardAutoCompose", "导出中 " + (evt.progress || 0) + "%");
        } else if (evt.type === "step") {
          _editActionProgress("editCardAutoCompose", _composePhaseLabel(evt.phase));
        } else if (evt.type === "warning") {
          var warnings = Array.isArray(evt.warnings) ? evt.warnings : [];
          if (warnings.length) showToast("剪辑质检提醒 " + warnings.length + " 条，已记录到成片记录", "warn");
        } else if (evt.type === "error") {
          capturedError = evt;
        }
      });

      await _resyncEditDataFromServer();
      if (resp && resp.exportTaskId && project) {
        if (!project.editData) project.editData = {};
        project.editData.exportTaskId = resp.exportTaskId;
      }
      if (resp && resp.exportUrl && project) {
        if (!project.editData) project.editData = {};
        project.editData.exportUrl = resp.exportUrl;
        if (typeof resp.exportedEdlVersion !== "undefined") {
          project.editData.exportedEdlVersion = resp.exportedEdlVersion;
        }
        if (resp.exportedEdlSignature) {
          project.editData.exportedEdlSignature = resp.exportedEdlSignature;
        }
        if (resp.exportedEdlSignatureMeta) {
          project.editData.exportedEdlSignatureMeta = resp.exportedEdlSignatureMeta;
        }
      }
      if (resp && resp.partial) {
        showToast("一键成片完成（已跳过部分不可用片段）", "ok");
      } else {
        showToast("一键成片完成", "ok");
      }
    } catch (e) {
      if (capturedError && capturedError.code === "MANUAL_TIMELINE_EDIT_DETECTED") {
        // 推迟到本次成片动作完全结束（_editActionEnd 之后）再弹确认，
        // 否则在 busy 态里递归触发 _autoComposeEditVideo 会被忙碌守卫挡掉。
        needOverwriteConfirm = true;
      } else if (capturedError && capturedError.code === "ALREADY_RUNNING") {
        showToast("已有一键成片任务正在运行", "warn");
      } else if (capturedError && capturedError.code) {
        showToast("一键成片失败: " + _diagnoseApiError(capturedError.message || capturedError.error || capturedError.code), "error");
      } else {
        var activeExportTaskId = observedExportTaskId || (project && project.editData && project.editData.exportTaskId) || "";
        if (activeExportTaskId && !(project && project.editData && project.editData.exportUrl)) {
          shouldResumeExportStream = true;
          showToast("成片导出仍在后台进行，完成后可下载", "warn");
        } else {
          showToast("一键成片失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
        }
      }
      await _resyncEditDataFromServer();
      if (observedExportTaskId || (project && project.editData && project.editData.exportTaskId && !project.editData.exportUrl)) {
        shouldResumeExportStream = true;
      }
    }
    _editActionEnd("btnEditAutoCompose", "editCardAutoCompose", "一键成片");
    _syncEditExportButtonState();
    if (shouldResumeExportStream) setTimeout(_tryResumeExportStream, 0);

    // 时间线被手工改过：本次成片已停在 preflight。等动作态清干净后再弹确认，
    // 点「确定」= 设为新基线并自动续跑成片；取消 / ✕ / 点弹窗外 都不做事。
    if (needOverwriteConfirm) {
      var ok = await _confirmOverwriteTimeline();
      if (ok) await _acceptTimelineAndCompose();
    }
  }

  // E-2.2：刷新/切页回来时如果 editData.exportTaskId 还在 running，主动重订 SSE。
  function _tryResumeExportStream() {
    if (!project || !project.editData) return;
    var tid = project.editData.exportTaskId;
    if (!tid) return;
    // 如果 exportUrl 已经落盘，说明这次导出早就完了，不再续订。
    if (project.editData.exportUrl) return;
    if (_exportStreamHandle) return;
    try {
      _editActionStart("btnEditExport", "editCardExport", "#34d399", "正在下载导出…", "Exporting");
    } catch (_e) {}
    _attachExportStream(tid);
  }

  /* ── Media library panel ── */

  var _mediaActiveTab = "clips";
  var _uploadedMedia = [];
  var _mediaPreviewBlobCache = {};
  var _mediaPreviewBlobPending = {};

  function _isProtectedEditMediaUrl(url) {
    url = String(url || "").trim();
    if (!url) return false;
    try {
      var u = new URL(url, window.location.origin);
      return u.origin === window.location.origin && u.pathname.indexOf("/api/edit/media/") === 0;
    } catch (_e) {
      return url.indexOf("/api/edit/media/") === 0;
    }
  }

  function _looksLikeImageUrl(url) {
    return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|svg|tiff?)(\?|#|$)/i.test(String(url || ""));
  }

  function _resolveMediaPreviewUrl(url) {
    url = String(url || "").trim();
    if (!url || !_isProtectedEditMediaUrl(url)) return Promise.resolve(url);
    if (_mediaPreviewBlobCache[url]) return Promise.resolve(_mediaPreviewBlobCache[url]);
    if (_mediaPreviewBlobPending[url]) return _mediaPreviewBlobPending[url];

    _mediaPreviewBlobPending[url] = fetch(url, {
      headers: getAuthHeaders(),
      cache: "force-cache",
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("素材预览加载失败 (" + resp.status + ")");
        return resp.blob();
      })
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);
        _mediaPreviewBlobCache[url] = objectUrl;
        return objectUrl;
      })
      .finally(function () {
        delete _mediaPreviewBlobPending[url];
      });
    return _mediaPreviewBlobPending[url];
  }

  function _hydrateMediaPreviewElements(root) {
    if (!root) return;
    var nodes = [];
    if (root.matches && root.matches("[data-media-preview-src]")) nodes.push(root);
    if (root.querySelectorAll) {
      root.querySelectorAll("[data-media-preview-src]").forEach(function (node) { nodes.push(node); });
    }
    nodes.forEach(function (node) {
      var sourceUrl = node.getAttribute("data-media-preview-src") || "";
      if (!sourceUrl) return;
      node.setAttribute("data-media-preview-loading", "true");
      _resolveMediaPreviewUrl(sourceUrl)
        .then(function (displayUrl) {
          if (!displayUrl) return;
          node.setAttribute("src", displayUrl);
          node.removeAttribute("data-media-preview-src");
          node.removeAttribute("data-media-preview-loading");
          if (node.tagName === "VIDEO") {
            try { node.load(); } catch (_e) {}
          }
        })
        .catch(function (e) {
          node.removeAttribute("data-media-preview-loading");
          node.setAttribute("data-media-preview-error", "true");
          console.warn("[Edit] 素材卡片预览加载失败:", sourceUrl, (e && e.message) || e);
        });
    });
  }

  function _renderMediaLibrary() {
    var list = $("editMediaList");
    if (!list) return;
    list.innerHTML = "";

    if (_mediaActiveTab === "clips") {
      var segs = _editState.segments;
      if (!segs.length) {
        list.innerHTML = '<p class="text-[10px] text-on-surface-variant/30 text-center mt-8">暂无视频片段</p>';
        return;
      }
      segs.forEach(function (seg, i) {
        var card = _buildMediaCard({
          type: "clip",
          idx: seg.groupIdx != null ? seg.groupIdx : i,
          name: "片段 " + ((seg.groupIdx != null ? seg.groupIdx : i) + 1),
          thumbUrl: seg.thumbnailUrl || "",
          videoUrl: seg.videoUrl || "",
          protectedUrl: _segPersistedVideoUrl(seg),
          duration: seg.duration || 5,
        });
        list.appendChild(card);
      });
    } else {
      if (!_uploadedMedia.length) {
        list.innerHTML = '<p class="text-[10px] text-on-surface-variant/30 text-center mt-8">点击右上角上传素材</p>';
        return;
      }
      _uploadedMedia.forEach(function (m, i) {
        var uploadKind = m.kind || "";
        var uploadIsImage = uploadKind === "image";
        var uploadPreviewUrl = m.localPreviewUrl || m.previewUrl || m.url || "";
        var card = _buildMediaCard({
          type: "upload",
          idx: i,
          name: m.name || "素材 " + (i + 1),
          thumbUrl: uploadIsImage ? (m.thumbnailUrl || uploadPreviewUrl) : (m.thumbnailUrl || ""),
          previewUrl: uploadPreviewUrl,
          videoUrl: uploadIsImage ? "" : (m.url || ""),
          protectedUrl: m.protectedUrl || m.url || "",
          duration: m.duration || 0,
          mediaId: m.id,
          kind: uploadKind,
        });
        list.appendChild(card);
      });
    }
  }

  function _buildMediaCard(info) {
    var card = document.createElement("div");
    card.className = "edit-media-card mb-2";
    card.setAttribute("draggable", "true");

    var previewUrl = info.thumbUrl || info.previewUrl || info.videoUrl || "";
    var previewIsImage = info.kind === "image" || !!info.thumbUrl || _looksLikeImageUrl(previewUrl);
    var thumbHtml;
    if (previewUrl && previewIsImage) {
      thumbHtml = '<img src="' + escapeHtml(previewUrl) + '" loading="lazy" />';
    } else if (previewUrl) {
      thumbHtml = '<video data-media-preview-src="' + escapeHtml(previewUrl) + '" muted playsinline preload="metadata"></video>';
    } else {
      thumbHtml = '<div style="aspect-ratio:16/9;background:rgba(0,0,0,0.05);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-on-surface-variant/20">movie</span></div>';
    }

    var durText = info.duration ? _formatTime(info.duration) : "";
    // type='clip' 的删除按钮 = 把片段从剪辑工作台移除（不删原视频）
    // type='upload' 的删除按钮 = 删掉用户上传的素材文件
    var deleteIconHtml = '';
    if (info.type === "upload") {
      deleteIconHtml = '<span class="edit-media-card-delete material-symbols-outlined" data-media-id="' + (info.mediaId || "") + '">close</span>';
    } else if (info.type === "clip") {
      deleteIconHtml = '<span class="edit-media-card-delete material-symbols-outlined" data-clip-gidx="' + info.idx + '" title="从剪辑工作台移除">close</span>';
    }
    card.innerHTML = thumbHtml +
      '<div class="edit-media-card-info">' +
        '<span class="edit-media-card-name">' + escapeHtml(info.name) + '</span>' +
        (durText ? '<span class="edit-media-card-dur">' + durText + '</span>' : '') +
      '</div>' +
      deleteIconHtml;

    hydrateProtectedImageElements(card);
    _hydrateMediaPreviewElements(card);

    card.addEventListener("dragstart", function (ev) {
      ev.dataTransfer.setData("application/x-edit-media", JSON.stringify({
        type: info.type,
        idx: info.idx,
        videoUrl: info.videoUrl,
        protectedUrl: info.protectedUrl || info.videoUrl,
        duration: info.duration,
        mediaId: info.mediaId,
        name: info.name,
        kind: info.kind,
      }));
      ev.dataTransfer.effectAllowed = "copy";
    });

    if (info.type === "clip") {
      card.addEventListener("dblclick", function () {
        _previewEditSegment(info.idx);
      });
    }

    var delBtn = card.querySelector(".edit-media-card-delete");
    if (delBtn) {
      delBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (info.type === "clip") {
          showConfirm(
            "移除片段 " + (info.idx + 1),
            "确定从剪辑工作台移除这个片段？\n（不会删除已生成的视频文件，可在片段页重新导入）",
            function () {
              removeGroupFromTimeline(info.idx);
              showToast("已移除片段 " + (info.idx + 1), "ok");
            }
          );
        } else {
          _deleteUploadedMedia(info.mediaId, info.idx);
        }
      });
    }

    return card;
  }

  function _initMediaTabEvents() {
    var tabs = document.querySelectorAll(".edit-media-tab");
    function syncMediaTabs(activeTab) {
      tabs.forEach(function (t) {
        var selected = t.dataset.tab === activeTab;
        t.classList.toggle("edit-media-tab--active", selected);
        t.setAttribute("aria-selected", selected ? "true" : "false");
      });
    }
    function activateMediaTab(activeTab) {
      if (!activeTab) return;
      var changed = _mediaActiveTab !== activeTab;
      _mediaActiveTab = activeTab;
      syncMediaTabs(_mediaActiveTab);
      if (changed) _renderMediaLibrary();
    }
    tabs.forEach(function (tab) {
      tab.addEventListener("pointerdown", function () {
        activateMediaTab(tab.dataset.tab);
      });
      tab.addEventListener("click", function () {
        activateMediaTab(tab.dataset.tab);
      });
    });
    syncMediaTabs(_mediaActiveTab);
  }

  function _initMediaUpload() {
    var input = $("editMediaUploadInput");
    if (!input) return;
    input.addEventListener("change", async function () {
      var files = Array.from(input.files || []);
      if (!files.length) return;
      input.value = "";

      var uploadedAny = false;
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!_isTimelineUploadVideo(file)) {
          showToast("剪辑页目前仅支持上传视频素材", "warn");
          continue;
        }
        try {
          var fd = new FormData();
          fd.append("file", file);
          fd.append("projectId", project ? project.id : "default");
          fd.append("purpose", "edit_timeline");

          var resp = await fetch("/api/edit/upload-media", {
            method: "POST",
            headers: { Authorization: "Bearer " + (_getAuthToken() || "") },
            body: fd,
          });
          if (!resp.ok) throw new Error(await _readUploadError(resp));
          var data = await resp.json();
          var uploadedItem = _normalizeMediaLibraryItem(data);
          uploadedItem.name = uploadedItem.name || file.name;
          uploadedItem.mime = uploadedItem.mime || file.type || "";
          uploadedItem.kind = uploadedItem.kind || _kindFromMime(uploadedItem.mime);
          uploadedItem.localPreviewUrl = URL.createObjectURL(file);
          _uploadedMedia.push(uploadedItem);
          uploadedAny = true;
          showToast("素材已上传: " + (data.name || file.name), "ok");
        } catch (e) {
          showToast("上传失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
        }
      }
      if (!uploadedAny) return;
      _mediaActiveTab = "uploads";
      document.querySelectorAll(".edit-media-tab").forEach(function (t) {
        var selected = t.dataset.tab === "uploads";
        t.classList.toggle("edit-media-tab--active", selected);
        t.setAttribute("aria-selected", selected ? "true" : "false");
      });
      _renderMediaLibrary();
    });
  }

  function _isTimelineUploadVideo(file) {
    if (!file) return false;
    var mime = String(file.type || "").toLowerCase();
    if (mime) return mime.indexOf("video/") === 0;
    return /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i.test(String(file.name || ""));
  }

  async function _readUploadError(resp) {
    try {
      var data = await resp.clone().json();
      return data.error || data.detail || data.message || "上传失败";
    } catch (_e) {
      try {
        var text = await resp.text();
        return text || "上传失败";
      } catch (_e2) {
        return "上传失败";
      }
    }
  }

  async function _loadUploadedMedia() {
    if (!project) return;
    try {
      var resp = await apiGet("/api/edit/media-library/project?projectId=" + encodeURIComponent(project.id));
      _uploadedMedia = (resp.items || resp.media || [])
        .filter(function (item) { return !item.source || item.source === "uploaded"; })
        .filter(function (item) { return (item.kind || _kindFromMime(item.mime || "")) === "video"; })
        .map(_normalizeMediaLibraryItem);
    } catch (e) {
      _uploadedMedia = [];
    }
  }

  function _normalizeMediaLibraryItem(item) {
    item = item || {};
    var mime = item.mime || "";
    var kind = item.kind || _kindFromMime(mime);
    return {
      id: item.mediaId || item.id || "",
      name: item.title || item.name || item.filename || "",
      url: item.url || "",
      protectedUrl: item.protectedUrl || item.url || "",
      thumbnailUrl: item.thumbnailUrl || item.coverUrl || "",
      duration: Number(item.durationSec || item.duration || 0) || 0,
      kind: kind,
      mime: mime,
      localPreviewUrl: item.localPreviewUrl || "",
      previewUrl: item.previewUrl || "",
      source: item.source || "uploaded",
    };
  }

  function _kindFromMime(mime) {
    mime = String(mime || "").toLowerCase();
    if (mime.indexOf("image/") === 0) return "image";
    if (mime.indexOf("video/") === 0) return "video";
    if (mime.indexOf("audio/") === 0) return "audio";
    return "";
  }

  async function _deleteUploadedMedia(mediaId, idx) {
    if (!mediaId) return;
    try {
      var resp = await fetch("/api/edit/media/" + mediaId, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + (_getAuthToken() || "") },
      });
      // fetch 不会对 4xx/5xx 抛错——必须手动判 resp.ok，否则后端返回 500
      // 前端也会误认为删成功、把本地 list splice 掉，下次刷新素材又"复活"。
      if (!resp || !resp.ok) {
        var txt = "";
        try { txt = await resp.text(); } catch (_e) {}
        throw new Error(txt || ("HTTP " + (resp && resp.status)));
      }
      _uploadedMedia.splice(idx, 1);
      showToast("素材已删除", "ok");
    } catch (e) {
      showToast("删除失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      // 后端到底删没删成不清楚，拉一次权威列表回灌——比信任本地 splice 安全。
      await _loadUploadedMedia();
    }
    _renderMediaLibrary();
  }

  function _initMediaDropOnTimeline() {
    var track = $("editVideoTrack");
    if (!track) return;
    var acceptsMediaDrag = function (ev) {
      var types = ev && ev.dataTransfer && ev.dataTransfer.types;
      if (!types) return false;
      if (typeof types.indexOf === "function") return types.indexOf("application/x-edit-media") >= 0;
      if (typeof types.contains === "function") return types.contains("application/x-edit-media");
      return Array.prototype.indexOf.call(types, "application/x-edit-media") >= 0;
    };
    track.addEventListener("dragover", function (ev) {
      if (acceptsMediaDrag(ev)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        _showTimelineInsertCue(_timelineInsertIndexFromClientX(ev.clientX, track), track);
      }
    });
    track.addEventListener("dragleave", function (ev) {
      if (!ev.relatedTarget || !track.contains(ev.relatedTarget)) _hideTimelineInsertCue(track);
    });
    track.addEventListener("drop", function (ev) {
      var insertIndex = _timelineInsertIndexFromClientX(ev.clientX, track);
      _hideTimelineInsertCue(track);
      var raw = ev.dataTransfer.getData("application/x-edit-media");
      if (!raw) return;
      ev.preventDefault();
      try {
        var info = JSON.parse(raw);
        _addMediaToTimeline(info, insertIndex);
      } catch (e) {}
    });
    document.addEventListener("dragend", function () { _hideTimelineInsertCue(track); });
  }

  function _addMediaToTimeline(info, insertIndex) {
    // C：图片素材暂不支持加入时间线——明确拦截，避免“假装加成功”
    if (_mediaIsImage(info)) {
      showToast("暂不支持图片素材，请拖入视频片段", "warn");
      return;
    }
    // A2：上传视频后端未落时长，拖入前先探测真实 metadata，探测不到再兜底 5s
    if (info.type === "upload" && !(Number(info.duration) > 0) && info.videoUrl) {
      _probeVideoDuration(info.videoUrl, function (dur) {
        _commitMediaToTimeline(Object.assign({}, info, { duration: dur > 0 ? dur : 5 }), insertIndex);
      });
      return;
    }
    _commitMediaToTimeline(info, insertIndex);
  }

  /** 判断拖入素材是否为图片（优先 kind，其次按扩展名兜底） */
  function _mediaIsImage(info) {
    if (!info) return false;
    if (info.kind === "image") return true;
    if (info.kind === "video" || info.kind === "audio") return false;
    var s = String(info.videoUrl || "") + " " + String(info.name || "");
    return /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|svg|tiff?)(\?|#|$)/i.test(s);
  }

  /** 探测视频真实时长（拿不到/超时回调 0），用隐藏 video 读 metadata */
  function _probeVideoDuration(url, cb) {
    var done = false;
    var finish = function (d) { if (done) return; done = true; cb(d); };
    try {
      var v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.addEventListener("loadedmetadata", function () {
        var d = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        try { v.removeAttribute("src"); v.load(); } catch (_e) {}
        finish(d);
      });
      v.addEventListener("error", function () { finish(0); });
      setTimeout(function () { finish(0); }, 4000);
      v.src = url;
    } catch (e) { finish(0); }
  }

  function _commitMediaToTimeline(info, insertIndex) {
    if (!_editState.edl) {
      _editState.edl = { timeline: [], bgm: null, totalDuration: 0 };
    }
    _editSaveUndo();
    var targetIndex = _normalizeTimelineInsertIndex(insertIndex);
    var newEntry = {
      groupIdx: info.type === "clip" ? info.idx : _nextExternalMediaGroupIdx(),
      videoUrl: info.videoUrl,
      protectedUrl: info.protectedUrl || _protectedVideoUrlFrom(info.videoUrl) || info.videoUrl,
      _originVideoUrl: info.protectedUrl || _protectedVideoUrlFrom(info.videoUrl) || info.videoUrl,
      inPoint: 0,
      outPoint: info.duration || 5,
      duration: info.duration || 5,
      transitionIn: { type: "cut", duration: 0 },
      _isExternalMedia: info.type === "upload",
      _mediaName: info.name,
      mediaId: info.mediaId || "",
    };
    _editState.edl.timeline.splice(targetIndex, 0, newEntry);

    // E-4.2：add-media PATCH /api/edit/timeline。后端按 insertIndex 写入权威 timeline，
    // 前端先做同位置乐观插入，避免拖到中间却短暂出现在末尾。
    _sendTimelineOp({ op: "add-media", entry: _entryForPersistence(newEntry), insertIndex: targetIndex });

    _buildSegStartTimes();
    _renderEditTimeline();
    _updateEditTimeDisplay();
    _revealTimelineSeg(targetIndex);
    showToast("已添加到时间线: " + (info.name || ""), "ok");
  }

  function _revealTimelineSeg(segIdx) {
    var tl = _editState.edl && _editState.edl.timeline;
    if (!tl || !tl.length) return;
    var idx = Math.max(0, Math.min(Number(segIdx) || 0, tl.length - 1));
    _highlightActiveSeg(idx);
    var scrollEl = $("editTimelineScroll");
    if (!scrollEl) return;
    try {
      var pps = _editState.pixelsPerSecond * _editState.zoom;
      var starts = (_editState.segStartTimes && _editState.segStartTimes.length === tl.length)
        ? _editState.segStartTimes
        : _timelineStarts(tl).starts;
      var left = _timelineSegmentLeft(starts[idx] || 0, idx, pps);
      var right = left + _timelineDurationWidth(_segDuration(tl[idx]), pps);
      var viewport = Math.max(0, scrollEl.clientWidth - _timelineOriginX(scrollEl) * 2);
      if (left < scrollEl.scrollLeft) {
        scrollEl.scrollLeft = Math.max(0, left - 24);
      } else if (right > scrollEl.scrollLeft + viewport) {
        scrollEl.scrollLeft = Math.max(0, right - viewport + 24);
      }
      _syncTimelineScrollLayers(scrollEl);
    } catch (_e) {}
  }

  /** 滚动时间线到末尾并高亮最新加入的片段 */
  function _revealLastTimelineSeg() {
    var tl = _editState.edl && _editState.edl.timeline;
    if (!tl || !tl.length) return;
    _revealTimelineSeg(tl.length - 1);
  }

  function _initEditEvents() {
    var btnAutoCompose = $("btnEditAutoCompose");
    if (btnAutoCompose) btnAutoCompose.addEventListener("click", _autoComposeEditVideo);

    var btnAnalyze = $("btnEditAnalyze");
    if (btnAnalyze) btnAnalyze.addEventListener("click", _analyzeEditSegments);

    var btnEdl = $("btnEditGenEdl");
    if (btnEdl) btnEdl.addEventListener("click", _generateEditEdl);

    var btnExport = $("btnEditExport");
    if (btnExport) btnExport.addEventListener("click", _handleEditExportClick);

    /* Play / Pause */
    var playBtn = $("editPlayBtn");
    if (playBtn) playBtn.addEventListener("click", _editTogglePlay);
    var previewPlayBtn = $("editPreviewPlayBtn");
    if (previewPlayBtn) previewPlayBtn.addEventListener("click", _editTogglePlay);

    /* Click + drag timeline / ruler / playhead to scrub (PR-style) */
    var timelineScroll = $("editTimelineScroll");
    var rulerWrap = $("editRulerWrap");
    var playheadEl = $("editPlayhead");

    if (timelineScroll) {
      var _scrubState = { active: false, wasPaused: false };

      var _xToTimelinePixels = function (clientX) {
        var rect = timelineScroll.getBoundingClientRect();
        return clientX - rect.left + timelineScroll.scrollLeft - _timelineOriginX(timelineScroll);
      };

      var _scrubTo = function (clientX) {
        var x = _xToTimelinePixels(clientX);
        var pps = _editState.pixelsPerSecond * _editState.zoom;

        var segs = _getTimelineSegs();
        var starts = _editState.segStartTimes;
        var t = Math.max(0, Math.min(_timelineXToTime(x, pps, segs, starts), _editState.totalDuration));
        var segIdx = 0;
        for (var i = 0; i < starts.length; i++) {
          var dur = _segDuration(segs[i]);
          if (t >= starts[i] && t < starts[i] + dur) { segIdx = i; break; }
          if (i === starts.length - 1) segIdx = i;
        }

        _editState.currentSegIdx = segIdx;
        _editState.globalTime = t;

        var seg = segs[segIdx];
        var localTime = (seg.inPoint || 0) + (t - (starts[segIdx] || 0));
        var vid = _getActiveVid();
        var url = _segVideoUrl(seg, segIdx);
        if (vid) {
          if (vid.getAttribute("src") !== url) vid.src = url;
          vid.currentTime = localTime;
        }
        _showVid(vid);
        _updatePlayheadFast();
        _updateTimeDisplayFast();
        _highlightActiveSeg(segIdx);
      };

      var _scrubStart = function (ev) {
        _buildSegStartTimes();
        _scrubState.wasPaused = !_editState.isPlaying;
        if (_editState.isPlaying) _editPause();
        _scrubState.active = true;
        _scrubTo(ev.clientX);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      };

      var _scrubMove = function (ev) {
        if (!_scrubState.active) return;
        ev.preventDefault();
        _scrubTo(ev.clientX);
      };

      var _scrubEnd = function () {
        if (!_scrubState.active) return;
        _scrubState.active = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (!_scrubState.wasPaused) _editPlay();
      };

      document.addEventListener("mousemove", _scrubMove);
      document.addEventListener("mouseup", _scrubEnd);

      /* Timeline track area: click or drag to scrub */
      timelineScroll.addEventListener("mousedown", function (ev) {
        if (ev.button !== 0) return;
        if (ev.target.closest(".edit-segment-block") || ev.target.closest(".edit-transition-marker")) return;
        _scrubStart(ev);
      });

      /* Ruler area: click or drag to scrub */
      if (rulerWrap) {
        rulerWrap.style.cursor = "col-resize";
        rulerWrap.addEventListener("mousedown", function (ev) {
          if (ev.button !== 0) return;
          _scrubStart(ev);
        });
      }

      /* Playhead handle: drag to scrub */
      if (playheadEl) {
        var handle = playheadEl.querySelector(".edit-playhead-glow");
        if (handle) {
          handle.style.pointerEvents = "auto";
          handle.style.cursor = "col-resize";
          handle.style.width = "14px";
          handle.style.height = "14px";
          handle.addEventListener("mousedown", function (ev) {
            ev.stopPropagation();
            if (ev.button !== 0) return;
            _scrubStart(ev);
          });
        }
      }

      timelineScroll.addEventListener("wheel", function (ev) {
        var dx = ev.deltaX || 0;
        var dy = ev.deltaY || 0;
        var shouldPanHorizontally = ev.shiftKey || Math.abs(dx) > Math.abs(dy);
        if (!shouldPanHorizontally) return;
        ev.preventDefault();
        timelineScroll.scrollLeft += ev.shiftKey ? (dy || dx) : dx;
      }, { passive: false });

      timelineScroll.addEventListener("scroll", function () {
        _syncTimelineScrollLayers(timelineScroll);
        _updatePlayhead();
      });
    }

    /* Undo / Redo buttons */
    var undoBtn = $("editUndoBtn");
    if (undoBtn) undoBtn.addEventListener("click", _editUndo);
    var redoBtn = $("editRedoBtn");
    if (redoBtn) redoBtn.addEventListener("click", _editRedo);

    /* Keyboard shortcuts */
    document.addEventListener("keydown", function (ev) {
      if ((_ctx.getActivePage ? _ctx.getActivePage() : "") !== "edit") return;
      if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" || ev.target.isContentEditable) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        _editTogglePlay();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.code === "KeyZ") {
        ev.preventDefault();
        if (ev.shiftKey) _editRedo();
        else _editUndo();
      }
    });

    /* Zoom */
    var zoomSlider = $("editZoomSlider");
    if (zoomSlider) zoomSlider.addEventListener("input", function () {
      _editState.zoom = parseFloat(this.value);
      _renderEditTimeline();
      _updatePlayhead();
    });
    var zoomIn = $("editZoomIn");
    if (zoomIn) zoomIn.addEventListener("click", function () {
      _editState.zoom = Math.min(_editState.zoom + 0.3, 4);
      if (zoomSlider) zoomSlider.value = _editState.zoom;
      _renderEditTimeline();
      _updatePlayhead();
    });
    var zoomOut = $("editZoomOut");
    if (zoomOut) zoomOut.addEventListener("click", function () {
      _editState.zoom = Math.max(_editState.zoom - 0.3, 0.5);
      if (zoomSlider) zoomSlider.value = _editState.zoom;
      _renderEditTimeline();
      _updatePlayhead();
    });

    /* Media library */
    _initMediaTabEvents();
    _initMediaUpload();
    _initMediaDropOnTimeline();
  }

  // E-1.2：旧素材库 fallback（_DEAD_BLOCK_START / _renderLibraryTemplates /
  // _initLibraryEvents / _openVideoLightbox）已于 Phase 5 重构从 assets.js 统一接管，
  // 此文件里的副本从未被调用且引用了 assets.js 才有的内部变量，已整段清理。


export { refreshEditPage, _initEditEvents, importGroupToTimeline, removeGroupFromTimeline, isGroupImported };
