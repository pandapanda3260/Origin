/**
 * Edit workbench module — extracted from main.js (stage 2 refactor).
 * Call initEdit(ctx) once at startup, then syncEditProject(p) whenever project changes.
 */
import { $, escapeHtml, showToast, showConfirm, apiGet, apiPost, apiPostStream, formatTime, ApiError, getAuthHeaders } from './utils.js';
import { subscribeTask, subscribeBatch } from './backend_stream.js';
import { showBillingPaywall } from './billing.js';

let _ctx = {};
let project = null;

// E-6：BGM 曲库缓存从 window._bgmCatalogCache 搬到 module scope。
// 全局挂 window 的唯一历史理由是方便 devtools 调试，但实质上违反了"模块内态
// 不应该泄到全局"原则，也让架构守门脚本没法扫出"前端私藏剪辑数据"。
let _bgmCatalogCache = null;

// E-1.1：edit.js 以前裸引用 sleep / _getAuthToken / _diagnoseApiError，
// 但既没 import 也没在 ctx 里拿 → ES module strict mode 下任何触发它们的按钮都会
// ReferenceError 崩（导出成片 / AI 分析 / AI 剪辑 / 素材上传 / 删除素材 5 个）。
// 照 storyboard.js / videoTasks.js 的模式从 ctx 里读，带本地 fallback 兜底。
  function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }
function _getAuthToken() { return _ctx.getAuthToken ? _ctx.getAuthToken() : ""; }

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
      project.editData.edl = ed.edl; // arch-guard:allow-editdata 强同步回灌
      _editState.edl = ed.edl;
    }
    if (ed.segmentTags) {
      project.editData.segmentTags = ed.segmentTags; // arch-guard:allow-editdata 强同步回灌
      _editState.segmentTags = ed.segmentTags;
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
    /* undo/redo */
    _undoStack: [],
    _undoPtr: -1,
  };

  function _getEditSegments() {
    if (!project || !project.storyboards) return [];
    var groups = _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : [];
    var segs = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var sb = (project.storyboards && project.storyboards[gi]) || {};
      if (!sb.videoUrl) continue;
      if (sb.importedToEdit !== true) continue;
      var dur = 0;
      var shots = g.shots || [];
      shots.forEach(function (shot) { dur += (shot.duration || 4); });
      segs.push({
        groupIdx: g.groupIdx != null ? g.groupIdx : gi,
        videoUrl: sb.videoUrl,
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
    return apiPost("/api/edit/timeline", payload).then(function (resp) {
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

  function _sumGroupDuration(groupIdx) {
    var groups = _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : [];
    var g = groups[groupIdx];
    if (!g || !Array.isArray(g.shots) || !g.shots.length) return 5;
    var dur = 0;
    g.shots.forEach(function (s) { dur += (s.duration || 4); });
    return dur || 5;
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

    _sendTimelineOp({ op: "import-group", groupIdx: groupIdx });

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
        '暂时还没有任何片段在剪辑工作台。<br/>' +
        '在「批量视频生成」页任意一条生成成功的视频卡片上，点「导入剪辑工作台」即可。';
      return;
    }
    var ready = readiness.readyCount | 0;
    var total = readiness.totalCount | 0;
    if (ready >= 1) {
      el.innerHTML =
        '你已经有 <span class="text-white/90 font-medium">' + ready + '</span> 条视频就绪。' +
        '<br/>回「批量视频生成」页，在想用的视频卡片上点「导入剪辑工作台」即可开剪。';
    } else if (total >= 1) {
      el.innerHTML =
        '所有视频还在生成中。<br/>' +
        '任意一条视频生成成功后，就可以在卡片上点「导入剪辑工作台」开始剪辑，<br/>' +
        '不必等全部生成完。';
    } else {
      el.innerHTML =
        '还没有可用的视频片段。<br/>' +
        '先去「批量视频生成」生成至少一条视频，之后在卡片上点「导入剪辑工作台」。';
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
      var btnEdl2 = $("btnEditGenEdl");
      if (btnEdl2) btnEdl2.disabled = false;
    }
    var btnExp = $("btnEditExport");
    if (btnExp) {
      btnExp.disabled = !(segments.length > 0);
    }

    if (_editState.edl && _editState._undoStack.length === 0) {
      _editSaveUndo();
    }

    _buildSegStartTimes();
    _renderEditTimeline();
    _updateEditTimeDisplay();

    _initDoubleBuffer();

    _loadUploadedMedia().then(function () { _renderMediaLibrary(); });
    _renderMediaLibrary();

    // 刷新时也要把 BGM 选择器渲出来——之前只在 _analyzeEditSegments / _generateEditEdl
    // 之后才 render，导致用户刷新页面就完全看不到 BGM 区域，反馈"刷新后没看到 bgm"。
    _renderBgmSelector();

    // 刷新进来如果 EDL 已经选了 BGM，把 audio 元素 src 同步上，但不 autoplay
    // （等用户按播放才起播）。这样用户一进剪辑页就有正确的 BGM 状态。
    if (_editState.edl && _editState.edl.bgm && _editState.edl.bgm.trackId) {
      setTimeout(_syncBgmPlayback, 0);
    }

    // E-2.2：若上一次导出任务尚未完成（editData.exportTaskId 有值且无 exportUrl），
    // 刷新回来时自动重订 SSE，保证"刷新不丢状态"宪法。
    _tryResumeExportStream();
  }

  function _renderEditTimeline() {
    var track = $("editVideoTrack");
    if (!track) return;
    track.innerHTML = "";

    var segs = _editState.edl ? _editState.edl.timeline : _editState.segments;
    var pps = _editState.pixelsPerSecond * _editState.zoom;

    var PLOT_COLORS = {
      setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE",
      resolution: "#2C3E50", climax: "#0B1320",
    };

    segs.forEach(function (seg, i) {
      var dur = _segDuration(seg);
      var w = Math.max(dur * pps, 40);
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
        var transLabel = trans === "crossfade" ? "叠" : trans === "fade_from_black" ? "淡" : trans === "fade_to_black" ? "黑" : "切";
        var transEl = document.createElement("div");
        transEl.className = "edit-transition-marker";
        transEl.title = "点击切换转场: " + trans;
        transEl.textContent = transLabel;
        (function (idx) {
          transEl.addEventListener("click", function (ev) { ev.stopPropagation(); _cycleTransition(idx); });
        })(i);
        track.appendChild(transEl);
      }

      /* segment block */
      var block = document.createElement("div");
      block.className = "edit-segment-block";
      block.style.width = w + "px";
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
        '<button class="edit-seg-regen-btn" title="重新生成此片段" data-gidx="' + gIdx + '">&#x21bb;</button>';

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

      track.appendChild(block);
    });

    var totalDur = 0;
    segs.forEach(function (s) { totalDur += _segDuration(s); });
    track.style.minWidth = (totalDur * pps + 100) + "px";

    /* render tag track above video track */
    _renderTagTrack(segs, pps);

    /* render time ruler */
    _renderTimeRuler(totalDur, pps);

    /* render filmstrips (async) */
    _renderAllFilmstrips(segs, pps);

    /* render waveforms (async) */
    _renderAllWaveforms(segs, pps);

    /* render BGM track */
    _renderBgmTrack(totalDur, pps);
  }

  /* ── Tag track (AI segment labels above video track) ── */

  var _TAG_PLOT_LABELS = { setup: "铺垫", rising: "递进", climax: "高潮", falling: "回落", resolution: "收尾" };
  var _TAG_PLOT_COLORS = { setup: "#ECEFF1", rising: "#CFD8DC", falling: "#90A4AE", resolution: "#2C3E50", climax: "#0B1320" };

  function _renderTagTrack(segs, pps) {
    var container = $("editTagTrack");
    if (!container) return;
    container.innerHTML = "";

    if (!_editState.segmentTags || !_editState.segmentTags.segments || !segs.length) {
      container.style.display = "none";
      return;
    }

    container.style.display = "flex";

    segs.forEach(function (seg, i) {
      var dur = _segDuration(seg);
      var w = Math.max(dur * pps, 40);
      var gIdx = seg.groupIdx != null ? seg.groupIdx : i;

      if (i > 0) {
        var spacer = document.createElement("div");
        spacer.className = "edit-tag-spacer";
        container.appendChild(spacer);
      }

      var tag = _editState.segmentTags.segments.find(function (t) { return t.groupIdx === gIdx; });
      var block = document.createElement("div");
      block.className = "edit-tag-block";
      block.style.width = w + "px";

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

          var newW = Math.max(item.duration * pps, 40);
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
      var w = Math.max(dur * pps, 40);
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
      var w = Math.max(dur * pps, 40);

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

  function _renderTimeRuler(totalDur, pps) {
    var rulerCanvas = $("editRuler");
    if (!rulerCanvas) return;
    var totalW = Math.max(totalDur * pps + 100, 600);
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
      var x = t * pps;
      ctx.fillRect(x, 14, 1, 10);
      ctx.fillText(_formatTime(t), x + 3, 2);
    }

    var subInterval = interval / 5;
    if (subInterval >= 0.2) {
      ctx.fillStyle = "rgba(207,216,220,0.1)";
      for (var st = 0; st <= totalDur + subInterval; st += subInterval) {
        var sx = st * pps;
        ctx.fillRect(sx, 18, 1, 6);
      }
    }
  }

  /* ── BGM track visualization ── */

  function _renderBgmTrack(totalDur, pps) {
    var aTrack = $("editAudioTrack");
    if (!aTrack) return;
    aTrack.innerHTML = "";
    aTrack.style.minWidth = (totalDur * pps + 100) + "px";

    var bgm = _editState.edl && _editState.edl.bgm;
    if (!bgm || !bgm.trackId) {
      aTrack.innerHTML = '<p class="text-[11px] text-white/10 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">BGM 轨道</p>';
      return;
    }

    var catalog = _bgmCatalogCache || [];
    var entry = catalog.find(function (t) { return t.id === bgm.trackId; });
    var name = entry ? entry.name : bgm.trackId;
    var bgmDur = entry ? entry.duration : totalDur;
    var bgmW = Math.max(bgmDur * pps, 60);
    var offsetX = (bgm.offsetTime || 0) * pps;

    var block = document.createElement("div");
    block.className = "edit-bgm-block";
    block.style.width = bgmW + "px";
    block.style.marginLeft = offsetX + "px";
    block.innerHTML = '<span class="material-symbols-outlined text-xs" style="font-variation-settings:\'FILL\' 1">music_note</span>' +
      '<span class="text-[10px] font-bold truncate">' + escapeHtml(name) + '</span>' +
      '<span class="text-[9px] opacity-50">' + _formatTime(bgmDur) + '</span>';

    var dragStartX = 0;
    var dragStartOffset = 0;
    block.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      dragStartX = ev.clientX;
      dragStartOffset = bgm.offsetTime || 0;

      function onMove(me) {
        var dx = me.clientX - dragStartX;
        var newOffset = Math.max(0, dragStartOffset + dx / pps);
        bgm.offsetTime = Math.round(newOffset * 10) / 10;
        block.style.marginLeft = (bgm.offsetTime * pps) + "px";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // E-4.2：BGM 偏移拖动收尾 → PATCH bgm-offset；内存 bgm.offsetTime 已同步更新。
        _sendTimelineOp({
          op: "bgm-offset",
          offsetTime: bgm.offsetTime || 0,
        });
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    aTrack.appendChild(block);
  }

  /* ── Undo / Redo ── */

  function _editSaveUndo() {
    if (!_editState.edl) return;
    var snapshot = JSON.parse(JSON.stringify(_editState.edl));
    if (_editState._undoPtr < _editState._undoStack.length - 1) {
      _editState._undoStack.splice(_editState._undoPtr + 1);
    }
    _editState._undoStack.push(snapshot);
    if (_editState._undoStack.length > 50) _editState._undoStack.shift();
    _editState._undoPtr = _editState._undoStack.length - 1;
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
    _sendTimelineOp({ op: "set-edl", edl: snap });
    _buildSegStartTimes();
    _renderEditTimeline();
    _updatePlayhead();
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
    _sendTimelineOp({ op: "set-edl", edl: snap });
    _buildSegStartTimes();
    _renderEditTimeline();
    _updatePlayhead();
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
    showConfirm("确定重新生成片段 " + (groupIdx + 1) + " 的视频？", function () {
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
              if (sbs[groupIdx]) sbs[groupIdx].videoUrl = newUrl;
              var segs = _editState.edl ? _editState.edl.timeline : _editState.segments;
              segs.forEach(function (s) {
                if (s.groupIdx === groupIdx) s.videoUrl = newUrl;
              });
              _renderEditTimeline();
              _previewEditSegment(groupIdx);
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
    showToast("转场: " + (_TRANSITION_LABELS[next] || next), "ok");
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
    return (orig && orig.videoUrl) || seg.videoUrl || "";
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

    // 字幕浮层：底部居中、白字黑边、跟着 globalTime 切换内容
    if (!_editState._subtitleEl) {
      var sub = document.createElement('div');
      sub.id = 'editSubtitleOverlay';
      sub.style.cssText =
        'position:absolute;left:0;right:0;bottom:32px;text-align:center;' +
        'pointer-events:none;z-index:20;padding:0 24px;';
      sub.innerHTML = '<span style="display:inline-block;max-width:90%;font:600 18px/1.4 \'PingFang SC\',sans-serif;' +
        'color:#fff;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,0 0 6px rgba(0,0,0,.7);"></span>';
      area.appendChild(sub);
      _editState._subtitleEl = sub;
    }

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
        _editState._vidA.currentTime = segs[0].inPoint || 0;
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

  function _loadSegToVid(vid, segIdx) {
    var segs = _getTimelineSegs();
    var seg = segs[segIdx];
    if (!seg || !vid) return;
    var url = _segVideoUrl(seg, segIdx);
    if (!url) return;
    if (vid.getAttribute("src") !== url) {
      vid.src = url;
    }
    vid.currentTime = seg.inPoint || 0;
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
      if (_editState._vidA) { _editState._vidA.style.display = "none"; _editState._vidA.style.opacity = "1"; }
      if (_editState._vidB) { _editState._vidB.style.display = "none"; _editState._vidB.style.opacity = "1"; }
      if (vid) vid.style.display = "block";
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
      if (vid) { vid.style.display = "block"; vid.style.opacity = "0"; }
      if (outgoing && outgoing !== vid) outgoing.style.display = "block";
      var start = performance.now();
      function crossfadeTick(now) {
        var p = Math.min((now - start) / dur, 1);
        if (vid) vid.style.opacity = p;
        if (outgoing && outgoing !== vid) outgoing.style.opacity = (1 - p);
        if (p < 1) requestAnimationFrame(crossfadeTick);
        else { if (outgoing && outgoing !== vid) { outgoing.style.display = "none"; outgoing.style.opacity = "1"; } }
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
    var t = Math.max(0, Math.min(timelineX / pps, _editState.totalDuration));

    var segs = _getTimelineSegs();
    var starts = _editState.segStartTimes;
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

    _updatePlayhead();
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
      var localOffset = _editState.globalTime - (_editState.segStartTimes[segIdx] || 0);
      var targetTime = (seg.inPoint || 0) + localOffset;
      vid.currentTime = targetTime;
      _showVid(vid);
      _seekThenPlay(vid, targetTime);
    }

    _prebufferNext(segIdx);

    _editState.isPlaying = true;
    if (_tickCache.playBtnSpan) _tickCache.playBtnSpan.textContent = "pause";
    _highlightActiveSeg(segIdx);

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

    if (_tickCache.playBtnSpan) _tickCache.playBtnSpan.textContent = "play_arrow";
  }

  /** 把 BGM audio 同步到当前播放状态：选了 BGM 就 play 并按 globalTime 起跳 */
  function _syncBgmPlayback() {
    var bgm = _editState._bgmAudio;
    if (!bgm) return;
    var trackId = _editState.edl && _editState.edl.bgm && _editState.edl.bgm.trackId;
    if (!trackId) {
      try { bgm.pause(); } catch (_) {}
      bgm.removeAttribute('src');
      return;
    }
    var url = '/api/edit/bgm/' + encodeURIComponent(trackId);
    if (bgm.getAttribute('src') !== url) {
      bgm.src = url;
      bgm.load();
    }
    var setStart = function () {
      // BGM 循环播放：currentTime = globalTime mod bgmDuration
      var bgmDur = isFinite(bgm.duration) && bgm.duration > 0 ? bgm.duration : 28;
      var startAt = ((_editState.globalTime || 0) % bgmDur);
      try { bgm.currentTime = startAt; } catch (_) {}
      if (_editState.isPlaying) {
        bgm.play().catch(function () { /* autoplay blocked，无视即可 */ });
      }
    };
    if (bgm.readyState >= 1) setStart();
    else bgm.addEventListener('loadedmetadata', setStart, { once: true });
  }

  function _seekThenPlay(vid, seekTime) {
    if (!vid) return;
    var hasSeek = typeof seekTime === "number" && isFinite(seekTime);

    var _doPlay = function () {
      vid.play().catch(function (err) {
        if (err && err.name === "NotAllowedError" && !vid.muted) {
          vid.muted = true;
          vid.play().then(function () { vid.muted = false; }).catch(function () {});
          return;
        }
        console.warn("[EditPlay] play failed:", err);
        showToast("视频播放失败: " + ((err && err.message) || "未知错误"), "warn");
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
    standby.currentTime = nextSeg.inPoint || 0;
    standby.load();
  }

  function _editTickLoop() {
    if (!_editState.isPlaying) return;

    // 切换中：standby 还没就绪，不要推进时间也不要再次触发下一次切换，
    // 否则 globalTime 会读到旧 vid 的越界 currentTime → playhead 抽搐
    // 或者还没切到 nextIdx 就又触发一次切到 nextIdx+1 的连锁错位。
    if (_editState._swapping) {
      _updatePlayheadFast();
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
    }

    var segEnd = (starts[curIdx] || 0) + _segDuration(seg);

    if (_editState.globalTime >= segEnd - 0.08) {
      var nextIdx = curIdx + 1;
      if (nextIdx >= segs.length) {
        _editState.globalTime = _editState.totalDuration;
        _editPause();
        _updatePlayheadFast();
        _updateTimeDisplayFast();
        return;
      }

      var standby = _getStandbyVid();
      var nextSeg = segs[nextIdx];
      var nextUrl = _segVideoUrl(nextSeg, nextIdx);
      var transType = (nextSeg.transitionIn && nextSeg.transitionIn.type) || "cut";

      if (standby) {
        var nextInPt = nextSeg.inPoint || 0;
        var srcChanged = standby.getAttribute("src") !== nextUrl;
        if (srcChanged) { standby.src = nextUrl; standby.load(); }

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
          _showVid(standby, transType);
          _swapBuffers();
          _seekThenPlay(standby, nextInPt);
          _highlightActiveSeg(nextIdx);
          _prebufferNext(nextIdx);
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
        // 否则就是把已经播了 1.5s 的视频 seek 回起点，制造"第一秒重播"
        setTimeout(function () {
          if (swapped) return;
          try { standby.currentTime = nextInPt; } catch (_) {}
          doSwap();
        }, 1500);
      } else if (vid) {
        try { vid.pause(); } catch (_) {}
        _editState.currentSegIdx = nextIdx;
        _highlightActiveSeg(nextIdx);
      }
    }

    _updatePlayheadFast();
    _updateTimeDisplayFast();
    _updateSubtitleFast();

    _editState._rafId = requestAnimationFrame(_editTickLoop);
  }

  /** 当前 globalTime 应该展示的字幕文本（含 speaker 前缀剥除） */
  function _currentSubtitleText() {
    var segs = _tickCache.segs;
    var starts = _tickCache.starts;
    var idx = _editState.currentSegIdx;
    var seg = segs && segs[idx];
    if (!seg || !project) return '';
    var gIdx = seg.groupIdx != null ? seg.groupIdx : idx;
    var sbs = Array.isArray(project.storyboards) ? project.storyboards : [];
    var shots = Array.isArray(project.shots) ? project.shots : [];
    var sb = sbs[gIdx];
    var shotIdxs = (sb && Array.isArray(sb.shotIndices) && sb.shotIndices.length) ? sb.shotIndices : [gIdx];
    var lines = [];
    for (var i = 0; i < shotIdxs.length; i++) {
      var sh = shots[shotIdxs[i]];
      if (!sh) continue;
      var raw = String(sh.dialogue || '').trim();
      if (!raw || raw === '——' || raw === '-' || raw === '无') continue;
      // 剥 "角色名："前缀
      lines.push(raw.replace(/^\s*[^：:]{1,12}\s*[：:]\s*/, '').replace(/^["'"'「]+|["'"'」]+$/g, '').trim());
    }
    if (!lines.length) return '';
    // 把段时长按行数均分；预留头 0.15s + 尾 0.15s
    var segDur = _segDuration(seg);
    var segStart = starts[idx] || 0;
    var localT = _editState.globalTime - segStart;
    var usable = Math.max(0.5, segDur - 0.3);
    var each = usable / lines.length;
    var k = Math.floor((localT - 0.15) / each);
    if (k < 0 || k >= lines.length) return '';
    return lines[k];
  }

  function _updateSubtitleFast() {
    var sub = _editState._subtitleEl;
    if (!sub) return;
    var text = _currentSubtitleText();
    var span = sub.firstElementChild;
    if (span && span.textContent !== text) span.textContent = text;
  }

  /* ── UI update helpers (fast path uses cached DOM refs) ── */

  function _updatePlayheadFast() {
    var el = _tickCache.playheadEl;
    if (!el) return;
    var pps = _editState.pixelsPerSecond * _editState.zoom;
    var x = _editState.globalTime * pps;

    var scroll = _tickCache.scrollEl;
    if (scroll) {
      var visible = scroll.clientWidth;
      if (x > scroll.scrollLeft + visible - 60) scroll.scrollLeft = x - visible / 2;
      else if (x < scroll.scrollLeft + 30) scroll.scrollLeft = Math.max(0, x - 30);
      // playhead is outside scroll container — offset by padding (32px) minus scrollLeft
      el.style.left = (x - scroll.scrollLeft + 32) + "px";
    } else {
      el.style.left = (x + 32) + "px";
    }
  }

  function _updateTimeDisplayFast() {
    var el = _tickCache.timeEl;
    if (!el) return;
    el.textContent = _formatTime(_editState.globalTime) + " / " + _formatTime(_editState.totalDuration);
  }

  function _updatePlayhead() {
    _tickCache.playheadEl = _tickCache.playheadEl || $("editPlayhead");
    _tickCache.scrollEl = _tickCache.scrollEl || $("editTimelineScroll");
    _updatePlayheadFast();
  }

  function _updateEditTimeDisplay() {
    _tickCache.timeEl = _tickCache.timeEl || $("editTimeDisplay");
    _updateTimeDisplayFast();
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

  async function _renderBgmSelector() {
    var container = $("editBgmSelector");
    if (!container) return;
    var tracks = await _loadBgmLibrary();
    if (!tracks.length) {
      container.innerHTML = '<p class="text-[11px] text-on-surface-variant/40">暂无背景音乐，请联系管理员添加</p>';
      return;
    }

    var CAT_LABELS = { calm: "平静", tense: "紧张", action: "动作", romantic: "浪漫", sad: "悲伤", epic: "史诗", mysterious: "神秘", hopeful: "希望" };
    var suggestedCat = "";
    if (_editState.segmentTags && _editState.segmentTags.suggestedBGMCategory) {
      suggestedCat = _editState.segmentTags.suggestedBGMCategory;
    }

    var html = '<div class="space-y-1.5">';
    tracks.forEach(function (t) {
      var catLabel = CAT_LABELS[t.category] || t.category;
      var isRecommended = suggestedCat && t.category === suggestedCat;
      var isSelected = _editState.edl && _editState.edl.bgm && _editState.edl.bgm.trackId === t.id;
      var hasFile = !!t.file;

      html += '<div class="flex items-center gap-2 p-2 rounded-lg hover:bg-surface-container cursor-pointer transition-all' +
        (isSelected ? ' bg-primary/5 ring-1 ring-primary/20' : '') + '" data-bgm-id="' + t.id + '">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-1.5">' +
            '<span class="text-[11px] font-bold text-on-background">' + escapeHtml(t.name) + '</span>' +
            (isRecommended ? '<span class="text-[8px] px-1 py-0.5 bg-primary/10 text-primary rounded-full font-bold">推荐</span>' : '') +
          '</div>' +
          '<div class="flex items-center gap-1.5 mt-0.5">' +
            '<span class="text-[9px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant/50">' + catLabel + '</span>' +
            '<span class="text-[9px] text-on-surface-variant/40">' + t.duration + 's</span>' +
            '<span class="text-[9px] text-on-surface-variant/30">' + t.bpm + ' BPM</span>' +
          '</div>' +
        '</div>' +
        (hasFile ? '<button type="button" class="bgm-preview-btn w-6 h-6 rounded-full bg-surface-container flex items-center justify-center hover:bg-surface-container-high transition-colors" data-bgm-preview="' + t.id + '">' +
          '<span class="material-symbols-outlined text-xs text-on-surface-variant/50">play_arrow</span>' +
        '</button>' : '') +
      '</div>';
    });
    html += '</div>';

    container.innerHTML = html;

    container.querySelectorAll("[data-bgm-id]").forEach(function (el) {
      el.addEventListener("click", function () {
        var bgmId = el.dataset.bgmId;
        if (_editState.edl) {
          if (!_editState.edl.bgm) _editState.edl.bgm = {};
          _editState.edl.bgm.trackId = bgmId;
          // E-4.2：BGM 选择 PATCH bgm-select。
          _sendTimelineOp({ op: "bgm-select", trackId: bgmId });
          _renderBgmSelector();
          // 立即同步到预览的 BGM player —— 用户点完应当立刻能在工作台听到效果
          _syncBgmPlayback();
          showToast("已选择 BGM，预览即时生效", "ok");
        } else {
          showToast("请先生成剪辑方案", "warn");
        }
      });
    });

    container.querySelectorAll("[data-bgm-preview]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var audio = document.getElementById("_bgmPreviewAudio");
        if (!audio) {
          audio = document.createElement("audio");
          audio.id = "_bgmPreviewAudio";
          document.body.appendChild(audio);
        }
        var id = btn.dataset.bgmPreview;
        if (audio.dataset.playing === id) {
          audio.pause();
          audio.dataset.playing = "";
          btn.querySelector("span").textContent = "play_arrow";
        } else {
          audio.src = "/api/edit/bgm/" + id;
          audio.play().catch(function () {});
          audio.dataset.playing = id;
          btn.querySelector("span").textContent = "pause";
          audio.onended = function () {
            btn.querySelector("span").textContent = "play_arrow";
            audio.dataset.playing = "";
          };
        }
      });
    });
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
      $("btnEditGenEdl").disabled = false;
      showToast("AI 分析完成", "ok");
    } catch (e) {
      showToast("AI 分析失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    _editActionEnd("btnEditAnalyze", "editCardAnalyze", "AI 分析");
  }

  async function _generateEditEdl() {
    if (!_editState.segmentTags) {
      showToast("请先进行 AI 分析", "error");
      return;
    }
    if (!_editActionStart("btnEditGenEdl", "editCardGenEdl", "#c084fc", "正在生成剪辑方案…", "Generating")) return;

    try {
      var _edlChars = 0;
      var resp = await apiPostStream("/api/edit/generate-edl", {
        projectId: (project && project.id) || "",
        segmentTags: _editState.segmentTags,
        segments: _editState.segments.map(function (s) {
          return { groupIdx: s.groupIdx, videoUrl: s.videoUrl, duration: s.duration };
        }),
      }, function (chunk) {
        _edlChars += chunk.length;
        var pct = Math.min(90, 10 + Math.floor(_edlChars / 40));
        _editActionProgress("editCardGenEdl", "生成进度 " + pct + "%");
      });

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

      // 自动选 BGM：按 AI 分析的 suggestedBGMCategory 命中第一首匹配类别的 BGM —— 
      // 用户点完 AI 剪辑就能在工作台预览听到 BGM、看到字幕，不用再去选。
      if (!_editState.edl.bgm || !_editState.edl.bgm.trackId) {
        var bgmList = await _loadBgmLibrary(); // ensure cache populated
        var sugCat = _editState.segmentTags && _editState.segmentTags.suggestedBGMCategory;
        var picked = sugCat && bgmList.find(function (t) { return t.category === sugCat; });
        if (!picked && bgmList.length) picked = bgmList[0]; // 兜底：实在没匹配就拿第一首（hopeful，最通用）
        if (picked) {
          _editState.edl.bgm = { trackId: picked.id };
          _sendTimelineOp({ op: "bgm-select", trackId: picked.id });
        }
      }

      _renderEditTimeline();
      _renderBgmSelector();
      _syncBgmPlayback();
      $("btnEditExport").disabled = false;
      // 把 LLM 给的剪辑思路一起 toast 出来，方便用户看出"AI 怎么剪的"
      var narr = (resp.result && resp.result.narrative) || (resp && resp.narrative) || "";
      var dur = (resp.result && resp.result.duration) || 0;
      var msg = "AI 剪辑方案已生成";
      if (dur > 0) msg += "（共 " + dur.toFixed(1) + "s）";
      if (narr) msg += "：" + narr;
      showToast(msg, "ok");
    } catch (e) {
      showToast("AI 剪辑失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    _editActionEnd("btnEditGenEdl", "editCardGenEdl", "AI 剪辑");
  }

  // E-2.2：正在订阅中的导出 SSE 句柄。刷新 / 重入时幂等重订。
  var _exportStreamHandle = null;

  var _exportDownloaded = false;

  function _downloadExportFile(url) {
    if (_exportDownloaded) return;
    _exportDownloaded = true;
    var fname = "export_" + (project && project.id ? project.id : "video") + ".mp4";
    fetch(url, { headers: getAuthHeaders() })
      .then(function (resp) {
        if (!resp.ok) throw new Error("下载失败: " + resp.status);
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
        if (project && url) {
          if (!project.editData) project.editData = {};
          // E-3.3 前置：exportUrl/exportTaskId 的权威落盘将由后端 _run_export → task_store
          // 承担（这里不再 saveProject 写盘），只把内存里的展示字段更新，让 UI 立刻显示下载按钮。
          project.editData.exportUrl = url; // arch-guard:allow-editdata 内存镜像（后端 task_store 是权威源）
          project.editData.exportTaskId = taskId;
        }
        if (url) {
          _downloadExportFile(url);
          showToast("成片导出完成，正在下载！", "ok");
        }
        _editActionEnd("btnEditExport", "editCardExport", "导出成片");
        _exportStreamHandle = null;
      },
      onFailed: function (data) {
        var msg = (data && (data.reason || data.errorMsg)) || "导出失败";
        showToast("导出失败: " + _diagnoseApiError(msg), "error");
        _editActionEnd("btnEditExport", "editCardExport", "导出成片");
        _exportStreamHandle = null;
      },
      onClose: function () {
        // SSE 异常断开：兜底拉一次 HTTP 状态确认结果，避免按钮卡死。
        apiGet("/api/edit/export-status/" + taskId).then(function (status) {
          if (!status) return;
          if (status.done) {
            if (status.downloadUrl) {
              if (project) {
                if (!project.editData) project.editData = {};
                project.editData.exportUrl = status.downloadUrl; // arch-guard:allow-editdata HTTP 兜底内存镜像
                project.editData.exportTaskId = taskId;
              }
              _downloadExportFile(status.downloadUrl);
              showToast("成片导出完成，正在下载！", "ok");
            } else if (status.restarted) {
              showToast("服务刚刚重启了，这次导出中断了，点「导出成片」重试一次就好", "warn");
            } else if (status.error) {
              showToast("导出失败: " + _diagnoseApiError(status.error), "error");
            }
            _editActionEnd("btnEditExport", "editCardExport", "导出成片");
          }
        }).catch(function () {});
        _exportStreamHandle = null;
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
    if (!_editActionStart("btnEditExport", "editCardExport", "#34d399", "正在导出成片…", "Exporting")) return;

    var exportEdl = _editState.edl || {
      timeline: segs.map(function (s) {
        return {
          groupIdx: s.groupIdx,
          videoUrl: s.videoUrl,
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
        segments: segs.map(function (s) {
          return { groupIdx: s.groupIdx, videoUrl: s.videoUrl, duration: s.duration };
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
      }
      showToast("导出任务已提交，正在处理…", "ok");
      _attachExportStream(taskId);
    } catch (e) {
      if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
        showBillingPaywall(e.billing || null);
      } else {
        showToast("导出失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      }
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
      _editActionStart("btnEditExport", "editCardExport", "#34d399", "正在导出成片…", "Exporting");
    } catch (_e) {}
    _attachExportStream(tid);
  }

  /* ── Media library panel ── */

  var _mediaActiveTab = "clips";
  var _uploadedMedia = [];

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
        var card = _buildMediaCard({
          type: "upload",
          idx: i,
          name: m.name || "素材 " + (i + 1),
          thumbUrl: m.thumbnailUrl || "",
          videoUrl: m.url || "",
          duration: m.duration || 0,
          mediaId: m.id,
        });
        list.appendChild(card);
      });
    }
  }

  function _buildMediaCard(info) {
    var card = document.createElement("div");
    card.className = "edit-media-card mb-2";
    card.setAttribute("draggable", "true");

    var thumbHtml;
    if (info.thumbUrl) {
      thumbHtml = '<img src="' + escapeHtml(info.thumbUrl) + '" loading="lazy" />';
    } else if (info.videoUrl) {
      thumbHtml = '<video src="' + escapeHtml(info.videoUrl) + '" muted preload="metadata"></video>';
    } else {
      thumbHtml = '<div style="aspect-ratio:16/9;background:rgba(0,0,0,0.05);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-on-surface-variant/20">movie</span></div>';
    }

    var durText = info.duration ? _formatTime(info.duration) : "";
    card.innerHTML = thumbHtml +
      '<div class="edit-media-card-info">' +
        '<span class="edit-media-card-name">' + escapeHtml(info.name) + '</span>' +
        (durText ? '<span class="edit-media-card-dur">' + durText + '</span>' : '') +
      '</div>' +
      (info.type === "upload" ? '<span class="edit-media-card-delete material-symbols-outlined" data-media-id="' + (info.mediaId || "") + '">close</span>' : '');

    card.addEventListener("dragstart", function (ev) {
      ev.dataTransfer.setData("application/x-edit-media", JSON.stringify({
        type: info.type,
        idx: info.idx,
        videoUrl: info.videoUrl,
        duration: info.duration,
        name: info.name,
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
        _deleteUploadedMedia(info.mediaId, info.idx);
      });
    }

    return card;
  }

  function _initMediaTabEvents() {
    var tabs = document.querySelectorAll(".edit-media-tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        _mediaActiveTab = tab.dataset.tab;
        tabs.forEach(function (t) { t.classList.remove("edit-media-tab--active"); });
        tab.classList.add("edit-media-tab--active");
        _renderMediaLibrary();
      });
    });
  }

  function _initMediaUpload() {
    var input = $("editMediaUploadInput");
    if (!input) return;
    input.addEventListener("change", async function () {
      var files = Array.from(input.files || []);
      if (!files.length) return;
      input.value = "";

      for (var i = 0; i < files.length; i++) {
        try {
          var fd = new FormData();
          fd.append("file", files[i]);
          fd.append("projectId", project ? project.id : "default");

          var resp = await fetch("/api/edit/upload-media", {
            method: "POST",
            headers: { Authorization: "Bearer " + (_getAuthToken() || "") },
            body: fd,
          });
          if (!resp.ok) throw new Error("上传失败");
          var data = await resp.json();
          _uploadedMedia.push(data);
          showToast("素材已上传: " + (data.name || files[i].name), "ok");
        } catch (e) {
          showToast("上传失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
        }
      }
      _mediaActiveTab = "uploads";
      document.querySelectorAll(".edit-media-tab").forEach(function (t) {
        t.classList.toggle("edit-media-tab--active", t.dataset.tab === "uploads");
      });
      _renderMediaLibrary();
    });
  }

  async function _loadUploadedMedia() {
    if (!project) return;
    try {
      var resp = await apiGet("/api/edit/media-library/" + project.id);
      _uploadedMedia = resp.media || [];
    } catch (e) {
      _uploadedMedia = [];
    }
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
    track.addEventListener("dragover", function (ev) {
      if (ev.dataTransfer.types.indexOf("application/x-edit-media") >= 0) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        track.style.outline = "2px dashed #3b82f6";
      }
    });
    track.addEventListener("dragleave", function () { track.style.outline = ""; });
    track.addEventListener("drop", function (ev) {
      track.style.outline = "";
      var raw = ev.dataTransfer.getData("application/x-edit-media");
      if (!raw) return;
      ev.preventDefault();
      try {
        var info = JSON.parse(raw);
        _addMediaToTimeline(info);
      } catch (e) {}
    });
  }

  function _addMediaToTimeline(info) {
    if (!_editState.edl) {
      _editState.edl = { timeline: [], bgm: null, totalDuration: 0 };
    }
    _editSaveUndo();
    var newEntry = {
      groupIdx: info.type === "clip" ? info.idx : 900 + (_editState.edl.timeline.length),
      videoUrl: info.videoUrl,
      inPoint: 0,
      outPoint: info.duration || 5,
      duration: info.duration || 5,
      transitionIn: { type: "cut", duration: 0 },
      _isExternalMedia: info.type === "upload",
      _mediaName: info.name,
    };
    _editState.edl.timeline.push(newEntry);

    // E-4.2：add-media PATCH /api/edit/timeline。后端把 entry 追加进 timeline
    // 并返回权威 edl；前端乐观更新一份即时渲染。
    _sendTimelineOp({ op: "add-media", entry: newEntry });

    _buildSegStartTimes();
    _renderEditTimeline();
    _updateEditTimeDisplay();
    showToast("已添加到时间线: " + (info.name || ""), "ok");
  }

  function _initEditEvents() {
    var btnAnalyze = $("btnEditAnalyze");
    if (btnAnalyze) btnAnalyze.addEventListener("click", _analyzeEditSegments);

    var btnEdl = $("btnEditGenEdl");
    if (btnEdl) btnEdl.addEventListener("click", _generateEditEdl);

    var btnExport = $("btnEditExport");
    if (btnExport) btnExport.addEventListener("click", _exportEditVideo);

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
        return clientX - rect.left + timelineScroll.scrollLeft - 32;
      };

      var _scrubTo = function (clientX) {
        var x = _xToTimelinePixels(clientX);
        var pps = _editState.pixelsPerSecond * _editState.zoom;
        var t = Math.max(0, Math.min(x / pps, _editState.totalDuration));

        var segs = _getTimelineSegs();
        var starts = _editState.segStartTimes;
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
        ev.preventDefault();
        if (ev.shiftKey) {
          timelineScroll.scrollLeft += ev.deltaY || ev.deltaX;
        } else {
          timelineScroll.scrollTop += ev.deltaY;
          timelineScroll.scrollLeft += ev.deltaX;
        }
      }, { passive: false });

      var rulerCanvas = $("editRuler");
      timelineScroll.addEventListener("scroll", function () {
        if (rulerCanvas) {
          rulerCanvas.style.transform = "translateX(" + (-timelineScroll.scrollLeft) + "px)";
        }
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
