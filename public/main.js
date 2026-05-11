/**
 * ORIGINRISE · AI 可视化分镜工作台 — v2.7-web
 */
import { $, escapeHtml, showToast, showConfirm, formatTime, setLoading,
  consumeStreamStepTags, apiPost, apiGet, apiPostStream,
  getAuthToken, getAuthHeaders, checkAuth, fetchAssetSignedUrl } from './modules/utils.js';
import { appStore } from './modules/store.js';
import { installGlobalHandlers as _installErrorHub } from './modules/error_hub.js';
import { initEdit, syncEditProject, refreshEditPage, _initEditEvents } from './modules/edit.js';
import { initSettings, loadSettings, saveModelSlots, getSlotConfig,
  refreshSettingsFormFromState, wireSettingsPageOnce } from './modules/settings.js';
import { initTasks, syncTasksProject, _startMaintenanceBannerPoll } from './modules/tasks.js';
import { initProject, getProject, setProject, loadProject, loadProjectData, saveProject,
  _serializeProject, cleanupBlobUrls, _registerServerTask, _updateServerTaskStatus,
  _notifyServerTaskDone,
  _archiveOldImage, _safeWriteBack, _flushServerSave } from './modules/project.js';
import { initEpisodes, syncEpisodesProject,
  _ensureEpisodes, _saveCurrentEpisode, _loadEpisode, _switchEpisode,
  _getCurrentEpisodeTitle, _getPreviousEpisodeAssets,
  _renderEpisodeTabs, _openNewEpisodeDialog, _createNewEpisode } from './modules/episodes.js';
import { initVideoTasks, syncVideoTasksProject, _restoreVideoTasks,
  refreshBatchPage, startBatchGeneration, _initBatchPlayerEvents, handleVideoTaskAction,
  syncTaskListVisibility, updateBadge, createWorkflowVideoTask } from './modules/videoTasks.js';
import { initVideoPrompts, syncVideoPromptsProject, vpFetchAndCache, vpGetCache,
  refreshPromptsPage, renderVideoPromptList, updateVpCard, checkVideoPromptsConfirm,
  generateGroupVideoPrompt, generateAllVideoPrompts, confirmVideoPrompts,
  refineVideoPrompt, handleVideoPromptAction,
  getVpSelectedGroup, setVpSelectedGroup } from './modules/videoPrompts.js';
import { initShots, syncShotsProject, refreshShotsPage, renderShotList,
  generateShots, saveShotEdits, confirmShots, handleShotAction,
  _syncSingleShotSlotsAfterInsert, _syncSingleShotSlotsAfterDelete } from './modules/shots.js';
import { initStoryboard, syncStoryboardProject, getStoryboardGroups,
  refreshImagesPage, renderImageGrid, renderPromptPreviewList, updatePromptCard,
  checkConvertConfirm, convertSinglePrompt, convertAllPrompts, confirmPrompts, handleConvertAction,
  updateStoryboardCard, checkImagesConfirm, generateStoryboardSheet,
  generateStoryboardTailFrame, generateAllTailFrames, upgradeLegacyFirstFrames,
  generateAllImages, confirmImages, handleImageAction, scrollToCard, getSbCurrentIdx,
  reattachStoryboardBatches } from './modules/storyboard.js';
import { initScript, syncScriptProject, refreshScriptPage, renderStyleBible,
  chatClearWelcome, chatAddMsg, chatShowDots, chatRemoveDots, typewriter, chatAutoResize,
  handleScriptInput, generateScript, reviseScript,
  startNewScript, extractStyleBible,
  initScriptImportEvents, confirmScript, tagEmotions, renderEmotionSegments,
  emotionBadgeHtml, showScriptEdit, showScriptDisplay } from './modules/script.js';
import { initAssets, syncAssetsProject, refreshAssetsPage, extractAssets,
  renderAssets, renderAssetGrid, updateAssetCardImage, generateSingleAssetImage,
  generateAllAssetImages, checkAssetsConfirm, confirmAssets, handleAssetAction,
  saveAsWorldTemplate, refreshLibraryPage, _initLibraryEvents, _openVideoLightbox,
  resetLibraryState, _showAssetActions, _restoreAssetGenStatus, _diagnoseApiError,
  _toastErrorWithActions,
  _syncAssetToStyleBible, _getAssetDescText, _getAssetName, _autoSyncUpstream,
  _checkEquipmentChange, _detectObsoleteAssets, _removeObsoleteAssets, _showCleanObsoleteDialog,
  _markDownstreamStale, _markDownstreamStaleFallback, _getShotGroupIndices,
  _isStale, _clearStale,
  _primeWorldTemplates,
  _openLightbox } from './modules/assets.js';
import { initBilling, loadBillingSummary, renderBillingPage, showBillingPaywall, handleBillingReturnFromUrl, refreshBillingBadge } from './modules/billing.js';
import { mountPixelCard } from './modules/pixel_card.js';

// Aliases so existing code using underscore-prefixed names keeps working
var _getAuthToken = getAuthToken;
var _getAuthHeaders = getAuthHeaders;
var _checkAuth = checkAuth;
var _consumeStreamStepTags = consumeStreamStepTags;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// project/videoState live here in main.js; project.js gets a reference via initProject
var project = null;
var videoState = { tasks: [], form: { ratio: '16:9', quality: '1080p', duration: 8, startDataUrl: '', endDataUrl: '' } };
var _projectEpoch = 0;

  /* ================================================================
     常量
     ================================================================ */
  var _currentUid = (function () {
    try { var u = JSON.parse(localStorage.getItem("sw_auth_user") || "{}"); return u.id || 0; }
    catch (e) { return 0; }
  })();
  var _uPrefix = _currentUid ? ("u" + _currentUid + "_") : "";

  var STORAGE_PROJECT = _uPrefix + "sw_project";
  var STORAGE_PROJECT_LIST = _uPrefix + "sw_project_list";
  var STORAGE_WORLD_TEMPLATES = _uPrefix + "sw_world_templates";


  var EPISODE_FIELDS = [
    "idea", "script", "scriptDraft", "scriptTargetDurationSec", "scriptApproved",
    "assets", "assetsApproved",
    "shots", "shotsApproved",
    "storyboards", "imagesApproved",
    "videoPrompts", "videoPromptsApproved",
    "narrations", "emotionSegments", "currentStep"
  ];

  var _isLocalProxy = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var MAX_CONCURRENT = 10;
  var MAX_TASKS_TOTAL = 20;

  var STORAGE_MODELS = _uPrefix + "sw_model_slots_v2";
  var MODEL_SLOT_META = {
    text:       { label: "大语言模型",   icon: "edit_note",  desc: "剧本生成、风格圣经、资产提取、镜头设计", placeholderModel: "gpt-4o" },
    image:      { label: "图片生成模型", icon: "palette",    desc: "资产参考图、分镜板绘制", placeholderModel: "gemini-3-pro-image-preview" },
    multimodal: { label: "多模态模型",   icon: "visibility", desc: "视频提示词生成、风格转换、图片分析", placeholderModel: "gemini-2.5-pro" },
    video:      { label: "视频生成模型", icon: "movie",      desc: "视频片段生成", placeholderModel: "doubao-seedance-2-0-260128" },
  };
  var STEP_TO_SLOT = {
    script:       "text",
    styleBible:   "text",
    assetExtract: "text",
    shots:        "text",
    imagePrompt:  "multimodal",
    assetImages:  "image",
    images:       "image",
    motionDesign: "multimodal",
    video:        "video",
  };
  var VIDEO_ADAPTERS = {
    seedance:      { name: "豆包视频 2.0（火山方舟）", submitPath: "/contents/generations/tasks", pollPath: "/contents/generations/tasks/{id}" },
    "seedance-fast": { name: "豆包视频 2.0 Fast（火山方舟）", submitPath: "/contents/generations/tasks", pollPath: "/contents/generations/tasks/{id}" },
    grok:          { name: "Grok（xAI / 中转）", submitPath: "/v1/videos/generations", pollPath: "/v1/videos/generations/{id}" },
    kling:         { name: "可灵 Kling（快手）", submitPath: "/v1/videos/text2video", pollPath: "/v1/videos/text2video/{id}" },
    hailuo:        { name: "海螺 Hailuo（MiniMax）", submitPath: "/v1/video_generation", pollPath: "/v1/query/video_generation?task_id={id}" },
    runway:        { name: "Runway Gen-4", submitPath: "/v1/image_to_video", pollPath: "/v1/tasks/{id}" },
    vidu:          { name: "Vidu（生数科技）", submitPath: "/v1/videos", pollPath: "/v1/videos/{id}" },
    openai_compat: { name: "通用中转（OpenAI 兼容）", submitPath: "/v1/videos/generations", pollPath: "/v1/videos/generations/{id}" },
  };
  var IMAGE_PROVIDERS = {
    openai_compat: { name: "通用（OpenAI 兼容）", hint: "适用于大多数中转站和 OpenAI 官方" },
    gemini:        { name: "Google Gemini (Imagen)", hint: "API 地址填 https://generativelanguage.googleapis.com，Key 填 Google AI Studio 的 API Key，模型如 imagen-4.0-generate-001" },
  };
  var STATUS_COPY = {
    queued: { cn: "排队中", en: "排队中" }, pending: { cn: "等待中", en: "等待中" },
    running: { cn: "生成中", en: "生成中" }, processing: { cn: "生成中", en: "生成中" },
    submitting: { cn: "提交中", en: "提交中" }, polling: { cn: "生成中", en: "生成中" },
    succeeded: { cn: "已完成", en: "已完成" }, success: { cn: "已完成", en: "已完成" },
    completed: { cn: "已完成", en: "已完成" },
    failed: { cn: "未成功", en: "未成功" }, error: { cn: "未成功", en: "未成功" },
    cancelled: { cn: "已取消", en: "已取消" }, canceled: { cn: "已取消", en: "已取消" },
  };
  // 注意：billing 不再是独立 page，而是顶层 modal（#billingModal），所以不放进 PAGES。
  // 顶部任务列表卡片走 data-goto="overview"，会员升级按钮走 switchPage("billing")。
  var PAGES = ["overview", "script", "style", "assets", "shots", "images", "prompts", "batch", "edit", "library", "profile", "settings", "admin"];
  var SIDEBAR_PIPELINE_PAGES = ["script", "style", "assets", "shots", "images", "prompts", "batch", "edit"];
  var settings = {
    models: {
      text:       { key: "", base: "", model: "" },
      image:      { key: "", base: "", model: "", provider: "openai_compat" },
      multimodal: { key: "", base: "", model: "" },
      video:      { key: "", base: "", model: "", adapter: "openai_compat" },
    },
  };
  var activePage = "overview";
  var _appBootstrapping = true;
  var _bootUserNavigated = false;
  var _bootDeferredPageRefresh = "";
  var _coreNavigationBound = false;

  /* ================================================================
     持久化：设置
     ================================================================ */

  /* ================================================================
     持久化：项目
     ================================================================ */
  function _historyBtnHtml(item, variant) {
    var n = item && Array.isArray(item.imageHistory) ? item.imageHistory.length : 0;
    if (!n) return "";
    var label = "历史(" + n + ")";
    var title = "查看并恢复之前 " + n + " 个版本";
    if (variant === "pill-white") {
      return '<button type="button" class="w-10 h-10 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-white/20 transition-all border border-white/20" data-action="show-history" title="' + title + '"><span class="material-symbols-outlined text-white text-sm">history</span></button>';
    }
    if (variant === "pill-dark") {
      return '<button type="button" class="p-3 bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all" data-action="show-history" title="' + title + '"><span class="material-symbols-outlined text-on-surface text-lg">history</span></button>';
    }
    if (variant === "sb") {
      return '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-white/60 hover:bg-white/90 text-on-surface-variant rounded-full text-[10px] font-bold tracking-widest uppercase transition-all active:scale-95 border border-outline-variant/20" data-action="show-history" title="' + title + '">' +
        '<span class="material-symbols-outlined text-sm">history</span>' + label +
      '</button>';
    }
    return '<button type="button" class="h-7 px-3 text-[9px] font-bold text-on-surface-variant bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-lg transition-colors uppercase tracking-wide" data-action="show-history" title="' + title + '">' + label + '</button>';
  }

  // Swap a historical snapshot back onto the item as the current image,
  // while archiving whatever was current so the rotation is lossless.
  function _setHistoryAsCurrent(item, snapIndex) {
    if (!item || !Array.isArray(item.imageHistory)) return false;
    var snap = item.imageHistory[snapIndex];
    if (!snap) return false;
    // Snapshot current first (so it lands in history top after we swap in the old one).
    _archiveOldImage(item, "restore");
    // Remove the chosen snapshot from history (it's about to become current).
    item.imageHistory.splice(snapIndex, 1);
    // Recovery may come from an entry that only had a specific URL kind.
    if (snap.url) { item.imageUrl = snap.url; }
    if (snap.rawUrl) { item.rawUrl = snap.rawUrl; } else if (snap.url) { item.rawUrl = snap.url; }
    if (snap.realPhotoUrl) { item.realPhotoUrl = snap.realPhotoUrl; }
    if (snap.pencilUrl) { item.pencilUrl = snap.pencilUrl; }
    return true;
  }

  var _activeHistoryPop = null;
  function _closeHistoryPop() {
    if (_activeHistoryPop) {
      try { _activeHistoryPop.remove(); } catch (_) {}
      _activeHistoryPop = null;
    }
    document.removeEventListener("click", _onHistoryPopOutsideClick, true);
    document.removeEventListener("keydown", _onHistoryPopKey, true);
  }
  function _onHistoryPopOutsideClick(e) {
    if (!_activeHistoryPop) return;
    if (_activeHistoryPop.contains(e.target)) return;
    _closeHistoryPop();
  }
  function _onHistoryPopKey(e) {
    if (e.key === "Escape") _closeHistoryPop();
  }

  /**
   * Floating dropdown anchored to the clicked "历史(N)" button. For each
   * snapshot: thumbnail + timestamp + source tag + two actions.
   * onApply(snapIndex) is invoked for "设为当前"; caller owns persistence.
   */
  function _openHistoryPopover(anchorBtn, item, onApply) {
    _closeHistoryPop();
    if (!item || !Array.isArray(item.imageHistory) || !item.imageHistory.length) {
      showToast("暂无历史版本", "warn");
      return;
    }

    var pop = document.createElement("div");
    pop.className = "history-pop";
    pop.style.cssText = [
      "position:fixed",
      "z-index:9999",
      "min-width:260px",
      "max-width:320px",
      "max-height:60vh",
      "overflow-y:auto",
      "background:rgba(255,255,255,0.97)",
      "backdrop-filter:blur(24px)",
      "-webkit-backdrop-filter:blur(24px)",
      "border:1px solid rgba(144,164,174,0.25)",
      "border-radius:16px",
      "box-shadow:0 12px 40px rgba(11,19,32,0.18)",
      "padding:10px",
      "color:#0B1320",
      "font-size:12px",
    ].join(";");

    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:4px 6px 8px;border-bottom:1px solid rgba(144,164,174,0.2);margin-bottom:8px";
    header.innerHTML = '<span style="font-weight:700;letter-spacing:0.04em">历史版本（共 ' + item.imageHistory.length + '）</span>' +
      '<button type="button" class="hp-close" style="background:transparent;border:none;cursor:pointer;color:#546E7A;padding:2px 4px">✕</button>';
    pop.appendChild(header);

    item.imageHistory.forEach(function (snap, hi) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;padding:8px;border-radius:10px;margin-bottom:6px;background:rgba(11,19,32,0.03);align-items:center";
      var u = snap.url || snap.rawUrl || snap.realPhotoUrl || snap.pencilUrl || "";
      var dateStr = snap.at ? new Date(snap.at).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "";
      var src = snap.source ? ' · ' + snap.source : "";
      var thumb = u
        ? '<img src="' + String(u).replace(/"/g,"&quot;") + '" style="width:56px;height:56px;object-fit:cover;border-radius:8px;flex-shrink:0;background:#eceff1" />'
        : '<div style="width:56px;height:56px;border-radius:8px;background:#eceff1;flex-shrink:0"></div>';
      row.innerHTML = thumb +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">v' + (hi + 1) + '</div>' +
          '<div style="color:#546E7A;font-size:11px">' + dateStr + src + '</div>' +
          '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<button type="button" class="hp-apply" data-hi="' + hi + '" style="flex:1;padding:4px 8px;background:#0B1320;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">设为当前</button>' +
            '<button type="button" class="hp-view" data-u="' + String(u).replace(/"/g,"&quot;") + '" style="padding:4px 8px;background:transparent;color:#0B1320;border:1px solid rgba(11,19,32,0.2);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">查看</button>' +
          '</div>' +
        '</div>';
      pop.appendChild(row);
    });

    pop.addEventListener("click", function (e) {
      var t = e.target.closest("button");
      if (!t) return;
      if (t.classList.contains("hp-close")) { _closeHistoryPop(); return; }
      if (t.classList.contains("hp-view")) {
        var u = t.dataset.u;
        if (u) _openLightbox(u);
        return;
      }
      if (t.classList.contains("hp-apply")) {
        var hi = parseInt(t.dataset.hi, 10);
        _closeHistoryPop();
        try { onApply(hi); } catch (err) { console.error("[History] apply failed:", err); }
      }
    });

    document.body.appendChild(pop);
    // Position: directly below the anchor button, right-aligned if close to viewport edge.
    var rect = anchorBtn.getBoundingClientRect();
    var popRect = pop.getBoundingClientRect();
    var top = rect.bottom + 6;
    var left = rect.left;
    if (left + popRect.width > window.innerWidth - 12) left = window.innerWidth - popRect.width - 12;
    if (left < 12) left = 12;
    if (top + popRect.height > window.innerHeight - 12) top = Math.max(12, rect.top - popRect.height - 6);
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    _activeHistoryPop = pop;

    // Defer outside-click listener by one tick so the opening click doesn't close it.
    setTimeout(function () {
      document.addEventListener("click", _onHistoryPopOutsideClick, true);
      document.addEventListener("keydown", _onHistoryPopKey, true);
    }, 0);
  }


  function _openExpandScriptDialog() {
    if (!project || !project.script) {
      showToast("请先生成剧本", "warn");
      return;
    }

    var overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
    overlay.style.animation = "fadeIn .2s ease";

    overlay.innerHTML =
      '<div class="bg-surface-container-lowest rounded-[2rem] p-8 w-[480px] max-w-[90vw] shadow-2xl border border-white/30" onclick="event.stopPropagation()">' +
        '<h3 class="text-lg font-bold text-on-background mb-1">扩充剧本</h3>' +
        '<p class="text-xs text-on-surface-variant mb-6">AI 将在现有剧本末尾继续写新内容，保持风格和角色一致。</p>' +
        '<div class="mb-6">' +
          '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">扩充方向（可选）</label>' +
          '<textarea id="expandDirection" class="w-full bg-surface-container-low rounded-2xl p-3 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none" rows="3" placeholder="例：增加一场追逐戏…（留空则 AI 自由发挥）"></textarea>' +
        '</div>' +
        '<div class="flex gap-3">' +
          '<button type="button" id="expandCancel" class="flex-1 py-3 rounded-full text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-all">取消</button>' +
          '<button type="button" id="expandConfirm" class="flex-1 py-3 rounded-full text-sm font-bold text-on-primary bg-primary hover:opacity-90 transition-all shadow-lg flex items-center justify-center gap-2">' +
            '<span class="material-symbols-outlined text-sm">add_circle</span>开始扩充' +
          '</button>' +
        '</div>' +
        '<p id="expandStatus" class="text-xs text-center text-on-surface-variant mt-4" hidden></p>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) overlay.remove();
    });
    $("expandCancel").addEventListener("click", function () { overlay.remove(); });
    $("expandConfirm").addEventListener("click", function () {
      _doExpandScript(overlay);
    });
  }

  async function _doExpandScript(overlay) {
    var directionEl = $("expandDirection");
    var statusEl = $("expandStatus");
    var confirmBtn = $("expandConfirm");
    var direction = directionEl ? directionEl.value.trim() : "";

    if (confirmBtn) confirmBtn.disabled = true;
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = "正在扩充剧本…"; }

    try {
      var resp = await apiPostStream("/api/script/workflow/expand", {
        projectId: project.id,
        direction: direction,
        durationSec: project.scriptTargetDurationSec,
      }, null, function (evt) {
        if (evt.type === "phase" && statusEl) {
          if (evt.name === "expand_start") statusEl.textContent = "正在扩充剧本…";
          else if (evt.name === "tag_emotions_start") statusEl.textContent = "正在重标情绪…";
        }
      });

      // 后端 workflow 已完成：追加剧本内容 + 清下游（shots / storyboards /
      // imagesApproved）+ 重标情绪段并落盘 project.json。前端只负责把 done
      // 事件里的字段同步回内存，避免再起网络往返。
	      project.script = resp.script || "";
	      project.scriptDraft = resp.script || "";
	      project.emotionSegments = Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [];
      if (resp.clearedDownstream) {
        project.shots = [];
        project.shotsApproved = false;
        project.storyboards = [];
        project.imagesApproved = false;
        project.videoPrompts = [];
        project.videoPromptsApproved = false;
      }
      project.scriptApproved = false;
      saveProject();

      if (resp.clearedDownstream) {
        showToast("剧本已扩充。后续步骤数据已重置，请重新确认剧本。", "info");
      } else {
        showToast("剧本扩充完成！", "success");
      }
      overlay.remove();
      refreshScriptPage();
    } catch (e) {
      var errMsg = ((e && e.message) || e).toString().slice(0, 120);
      if (statusEl) statusEl.textContent = "扩充失败: " + errMsg;
      if (confirmBtn) confirmBtn.disabled = false;
      showToast("扩充失败: " + _diagnoseApiError(errMsg), "error");
    }
  }

  function getProjectList() {
    try {
      var raw = localStorage.getItem(STORAGE_PROJECT_LIST);
      if (raw) { var list = JSON.parse(raw); if (Array.isArray(list)) return list; }
    } catch (e) {}
    return [];
  }

  async function getProjectListFromServer() {
    try {
      var resp = await fetch("/api/projects", { headers: _getAuthHeaders() });
      _checkAuth(resp);
      if (!resp.ok) return [];
      var data = await resp.json();
      return data.projects || [];
    } catch (e) { return []; }
  }

  function saveProjectList(list) {
    localStorage.setItem(STORAGE_PROJECT_LIST, JSON.stringify(list));
  }

  function addProjectToList(proj) {
    var list = getProjectList();
    var exists = list.some(function (p) { return p.id === proj.id; });
    if (!exists) {
      list.unshift({ id: proj.id, name: proj.name, createdAt: proj.createdAt });
    }
    saveProjectList(list);
  }

  function updateProjectListEntry(proj) {
    var list = getProjectList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === proj.id) {
        list[i].name = proj.name;
        break;
      }
    }
    saveProjectList(list);
  }

  function _resetProjectUI() {
    setVpSelectedGroup(0);
    resetLibraryState();

    var chatBox = $("chatMessages");
    if (chatBox) {
      var innerWrap = chatBox.querySelector(".max-w-2xl") || chatBox;
      var msgs = innerWrap.querySelectorAll(".chat-msg:not(#scriptResultCard)");
      msgs.forEach(function (m) { m.parentNode.removeChild(m); });
    }

    var domIds = [
      "assetCharGrid", "assetSceneGrid", "assetPropGrid",
      "shotListWrap",
      "imageGrid",
      "vpStoryboardFrames", "videoPromptList",
      "batchClipList",
      "batchTaskListWrap"
    ];
    domIds.forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = "";
    });

    var sbDots = $("sbNavDots");
    if (sbDots) sbDots.innerHTML = "";

    var hideIds = [
      "assetsContent", "shotsConfirmArea",
      "imagesConfirmArea", "imagesActionBar",
      "videoPromptsConfirmArea",
    ];
    hideIds.forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });

    try {
      _projectEpoch++;
      videoState.tasks.forEach(function (t) {
        if (t._sseHandle) { try { t._sseHandle.close(); } catch (_e) {} t._sseHandle = null; }
        t._killed = true;
      });
      videoState.tasks = [];
    } catch (e) {}
  }

  function _invalidateVideoForGroup(gIdx) {
    var idx = Number(gIdx);
    if (!Number.isFinite(idx) || idx < 0) return;

    if (project && project.storyboards && project.storyboards[idx]) {
      delete project.storyboards[idx].videoUrl;
      delete project.storyboards[idx]._originVideoUrl;
      delete project.storyboards[idx].videoTaskId;
      delete project.storyboards[idx].videoCoverUrl;
      delete project.storyboards[idx].videoStatus;
      delete project.storyboards[idx].videoMode;
      delete project.storyboards[idx].videoTaskFinishedAt;
      delete project.storyboards[idx].videoDurationSec;
    }
    if (project && Array.isArray(project.videoTasks) && project.videoTasks.length > idx) {
      project.videoTasks[idx] = {};
    }
    if (videoState && Array.isArray(videoState.tasks)) {
      videoState.tasks = videoState.tasks.filter(function (t) {
        if (Number(t && t._groupIdx) !== idx) return true;
        if (t && t._sseHandle) {
          try { t._sseHandle.close(); } catch (_e) {}
          t._sseHandle = null;
        }
        if (t) t._killed = true;
        return false;
      });
    }
  }

  /**
   * Phase 5.2：切项目 = await _flushServerSave() → GET 新项目。
   *
   * 老实现先 localStorage 秒切、同时 fire-and-forget 拉服务器，中间
   * 窗口里可能：
   *   1) 前一项目的 debounce PUT 还没发（PUT 里带的是 B 项目的快照）
   *   2) B 项目 GET 回来 merge 进 _getProject()（其实 GET 的是 B 快照）
   *   3) 前一项目的 PUT 发成功了，但 localStorage 里 B 的 sw_proj_* 已被刷新
   *   → 最后前一项目的资产丢失、B 项目也被污染。
   *
   * 改成严格串行：落前一个盘 → 再 GET。用户感知上切换会慢 200-400ms，
   * 但数据不会乱串。
   */
  async function switchToProject(projId) {
    console.log("[Project] Switching to:", projId);
    try {
      if (project && project.id === projId) return;
      // 前一项目挂起的 PUT 必须先落盘——否则后续 GET 新项目时旧数据会被吞掉
      if (project && project.id && project.id !== projId) {
        try { await _flushServerSave(); }
        catch (e) { console.warn("[switchToProject] flush before switch failed:", e); }
      }
      await _loadProjectFromServerAndSwitch(projId);
    } catch (e) {
      console.error("[Project] Switch error:", e);
      showToast("切换项目失败", "error");
    }
  }

  async function _loadProjectFromServerAndSwitch(projId) {
    try {
      _showProjectSkeleton(true);
      var resp = await fetch("/api/projects/" + encodeURIComponent(projId), { headers: _getAuthHeaders() });
      if (!resp.ok) { showToast("无法加载项目", "error"); return; }
      var p = await resp.json();
      if (p && p.id) {
        project = p;
        // Phase 5.9：只记 projectId 这一个 key；不再 mirror 整包到 localStorage。
        try { localStorage.setItem(_uPrefix + "sw_last_project_id", project.id); } catch (_) {}
        syncEditProject(project);
        syncTasksProject(project);
        syncVideoTasksProject(project);
        syncVideoPromptsProject(project);
        syncShotsProject(project);
        syncStoryboardProject(project);
        syncScriptProject(project);
        syncAssetsProject(project);
        _ensureEpisodes();
        cleanupBlobUrls(project);
        _resetProjectUI();
        refreshAllPages();
        _restoreVideoTasks();
        _renderEpisodeTabs();
        _loadProjectProfileOverride();
        switchPage("overview");
        console.log("[Project] Loaded from server:", project.name, "v=", project.version);
      }
    } catch (e) {
      console.error("[Project] Server load failed:", e);
      showToast("加载项目失败", "error");
    } finally {
      _showProjectSkeleton(false);
    }
  }

  function deleteProject(projId) {
    console.log("[Project] Deleting:", projId);
    try {
      var list = getProjectList();
      list = list.filter(function (p) { return p.id !== projId; });
      saveProjectList(list);
      localStorage.removeItem(_uPrefix + "sw_proj_" + projId);
      _ovProjectTasks = _ovProjectTasks.filter(function (t) { return t && t.projectId !== projId; });
      if (_ovTaskState.selectedId === "p:" + projId) _ovTaskState.selectedId = "";
      _ovProjectTasksLoaded = true;
      _ovRenderDashboard();

      fetch("/api/projects/" + encodeURIComponent(projId), {
        method: "DELETE",
        headers: _getAuthHeaders(),
      }).then(function (resp) {
        if (!resp || !resp.ok) console.warn("[ServerDelete] non-2xx:", resp && resp.status);
        _ovInvalidateProjectTasks(true);
      }).catch(function (e) { console.warn("[ServerDelete] failed:", e); });

      if (project && project.id === projId) {
        if (list.length > 0) {
          switchToProject(list[0].id);
        } else {
          project = null;
          syncEditProject(null);
          syncTasksProject(null);
          syncVideoTasksProject(null);
          syncVideoPromptsProject(null);
          syncShotsProject(null);
          syncStoryboardProject(null);
          syncScriptProject(null);
          syncAssetsProject(null);
          localStorage.removeItem(STORAGE_PROJECT);
          refreshOverview();
        }
      }
      console.log("[Project] Deleted OK, remaining:", list.length);
    } catch (e) {
      console.error("[Project] Delete error:", e);
    }
  }

  function refreshAllPages() {
    try { refreshOverview(); } catch (e) { console.error("[RefreshAll] overview:", e); }
    try { refreshScriptPage(); } catch (e) { console.error("[RefreshAll] script:", e); }
    try { refreshStylePage(); } catch (e) { console.error("[RefreshAll] style:", e); }
    try { refreshAssetsPage(); } catch (e) { console.error("[RefreshAll] assets:", e); }
    try { refreshShotsPage(); } catch (e) { console.error("[RefreshAll] shots:", e); }
    try { refreshImagesPage(); } catch (e) { console.error("[RefreshAll] images:", e); }
    try { refreshPromptsPage(); } catch (e) { console.error("[RefreshAll] prompts:", e); }
    try { refreshBatchPage(); } catch (e) { console.error("[RefreshAll] batch:", e); }
    try { refreshEditPage(); } catch (e) { console.error("[RefreshAll] edit:", e); }
    try { _renderEpisodeTabs(); } catch (e) {}
    try { renderProjectList(); } catch (e) {}
  }

  /**
   * Phase 5.9：启动 / 切项目期间的极简骨架层。
   *
   * 背景：旧代码在 `loadProject()` 同步时先回填 `localStorage.sw_project` 再
   * 异步对账服务器，保证首屏立刻有东西但一旦服务器比本地新就"闪回"。现在
   * `loadProject` 改为 server-first + async，启动期间 0.5–2s 不能让用户看到
   * 半空不空的老 UI——给一层半透明遮罩 + spinner 文案，服务器响应到了再撤掉。
   *
   * 用极简 DOM + 内联样式，不依赖任何已有 overlay 组件，避免新增一堆 css。
   */
  var _projectSkeletonEl = null;
  var _projectSkeletonWatchdog = null;
  // 骨架屏硬性最长展示时间：超过这个时间必定强制隐藏，防止"某个 await 永远不
  // resolve"导致用户被卡在同步屏（极端场景：后端接了 TCP 但没返回响应 / 浏览
  // 器扩展拦截 fetch / 维护期网络抖动）。比 fetch 超时长 1 倍留冗余。
  var _PROJECT_SKELETON_MAX_MS = 20000;
  function _showProjectSkeleton(on) {
    if (on) {
      if (_projectSkeletonEl) { _projectSkeletonEl.style.display = "flex"; }
      else {
        var el = document.createElement("div");
        el.id = "sw-project-skeleton";
        el.style.cssText = "position:fixed;inset:0;z-index:35;display:flex;pointer-events:none;" +
          "align-items:center;justify-content:center;flex-direction:column;gap:14px;" +
          "background:rgba(10,10,12,0.72);backdrop-filter:blur(6px);" +
          "color:#e8e8ea;font-size:14px;font-family:inherit;" +
          "transition:opacity 180ms ease;";
        var spinner = document.createElement("div");
        spinner.style.cssText = "width:32px;height:32px;border:3px solid rgba(255,255,255,0.22);" +
          "border-top-color:#fff;border-radius:50%;animation:sw-skeleton-spin 0.9s linear infinite;";
        var text = document.createElement("div");
        text.textContent = "正在从服务器同步项目…";
        text.style.cssText = "opacity:0.85;letter-spacing:0.3px;";
        var style = document.createElement("style");
        style.textContent = "@keyframes sw-skeleton-spin{to{transform:rotate(360deg)}}";
        el.appendChild(style);
        el.appendChild(spinner);
        el.appendChild(text);
        document.body.appendChild(el);
        _projectSkeletonEl = el;
      }
      if (_projectSkeletonWatchdog) clearTimeout(_projectSkeletonWatchdog);
      _projectSkeletonWatchdog = setTimeout(function () {
        if (_projectSkeletonEl) {
          console.warn("[ProjectSkeleton] watchdog fired after " + _PROJECT_SKELETON_MAX_MS +
                       "ms — force hiding, loadProject 可能某个 await 未 resolve");
          _showProjectSkeleton(false);
        }
      }, _PROJECT_SKELETON_MAX_MS);
    } else if (_projectSkeletonEl) {
      if (_projectSkeletonWatchdog) { clearTimeout(_projectSkeletonWatchdog); _projectSkeletonWatchdog = null; }
      _projectSkeletonEl.style.opacity = "0";
      var target = _projectSkeletonEl;
      setTimeout(function () {
        if (target && target.parentNode) target.parentNode.removeChild(target);
        if (_projectSkeletonEl === target) _projectSkeletonEl = null;
      }, 220);
    }
  }

  // Phase 5.7：默认值即启动瞬间的兜底；`_loadClientConfig()` 会在首屏后覆盖。
  var MAX_PROJECTS = 10;

  async function _loadClientConfig() {
    try {
      var resp = await fetch("/api/config/client", { headers: _getAuthHeaders() });
      if (!resp.ok) return;
      var cfg = await resp.json();
      if (cfg && typeof cfg.maxProjects === "number") MAX_PROJECTS = cfg.maxProjects;
      if (cfg && typeof cfg.maxConcurrent === "number") MAX_CONCURRENT = cfg.maxConcurrent;
      if (cfg && typeof cfg.maxTasksTotal === "number") MAX_TASKS_TOTAL = cfg.maxTasksTotal;
    } catch (e) {
      console.warn("[ClientConfig] fetch failed, keeping defaults:", e);
    }
  }

  /**
   * Phase 5.9：新建项目改为 server-first。
   *
   * 旧实现先在前端攒好一份 project 直接 `saveProject`（写入已废弃的
   * `_STORAGE_PROJECT` + 防抖 PUT），然后 fire-and-forget 一个 POST
   * `/api/projects`——服务端在 version / updatedAt 这些关键字段上跟前端内存
   * 不对齐的概率极高，刷新回来要么看到"空项目"，要么因为 PUT 先于 POST 而
   * 被后端 403/404。
   *
   * 现在：先构造 draft → POST `/api/projects` 等服务器返回（带着服务器生成的
   * id / version / updatedAt）→ 用这份权威响应替换内存 project → 再进入
   * syncXxxProject + refreshAllPages 系列。整个过程是 async，按钮回调
   * `await createNewProject(...)`。
   *
   * 返回 true = 成功，false = 失败（配额 / 网络）。
   */
  async function createNewProject(name) {
    // Phase 5.9：配额检查以服务器列表为准，不再读 localStorage。
    // 历史症状：管理员等 legacy 用户的 `sw_project_list` 残留 10 条老元数据
    // 但服务器端 `data/projects/<uid>/` 为空，前端误判"已满 10 个"挡掉新建。
    // 服务器 fetch 失败才退回 local list 兜底（维护期 / 离线也别完全锁死）。
    var list;
    try {
      list = await getProjectListFromServer();
      if (!Array.isArray(list)) list = [];
    } catch (_e) {
      list = getProjectList();
    }
    if (list.length >= MAX_PROJECTS) {
      showToast("最多保存 " + MAX_PROJECTS + " 个项目，请先删除旧项目", "warn");
      return false;
    }

    // Phase 5.2：切出当前项目前，先把最后的改动刷到后端，再起新项目。
    if (project && project.id) {
      try { await _flushServerSave(); }
      catch (_e) { console.warn("[createNewProject] flushServerSave failed:", _e); }
    }

    var epId = "ep_" + Date.now();
    var draft = {
      id: "proj_" + Date.now(),
      name: name || "新项目",
      createdAt: Date.now(),
      currentStep: 1,
      idea: "",
      script: "",
      scriptTargetDurationSec: null,
      scriptApproved: false,
      styleBible: null,
      assets: null,
      assetsApproved: false,
      shots: [],
      shotsApproved: false,
      storyboards: [],
      imagesApproved: false,
      videoPromptsApproved: false,
      narrations: [],
      videoPrompts: [],
      editData: null,
      episodes: [{
        id: epId,
        title: "第 1 集",
        idea: "", script: "", scriptTargetDurationSec: null, scriptApproved: false,
        assets: null, assetsApproved: false,
        shots: [], shotsApproved: false,
        storyboards: [], imagesApproved: false,
        videoPrompts: [], videoPromptsApproved: false,
        narrations: [], currentStep: 1
      }],
      currentEpisodeIdx: 0,
    };

    var serverProj = null;
    var quotaErr = null;
    try {
      var resp = await fetch("/api/projects", {
        method: "POST",
        headers: _getAuthHeaders(),
        body: JSON.stringify(draft),
      });
      if (resp.ok) {
        var body = await resp.json();
        if (body && body.id) serverProj = body;
      } else if (resp.status === 409) {
        try {
          var err = await resp.json();
          if (err && err.error === "project_quota_exceeded") quotaErr = err;
        } catch (_) {}
        console.warn("[createNewProject] POST /api/projects quota 409:", quotaErr);
      } else {
        console.warn("[createNewProject] POST /api/projects non-2xx:", resp.status);
      }
    } catch (e) {
      console.warn("[createNewProject] POST /api/projects failed:", e);
    }

    // Phase 5.9：后端配额拒绝优先级高——前端 UX 检查可能因为 list 不一致漏判。
    if (quotaErr) {
      showToast(quotaErr.detail || ("最多保存 " + (quotaErr.max || MAX_PROJECTS) + " 个项目，请先删除旧项目"), "warn");
      return false;
    }
    if (!serverProj) {
      showToast("创建项目失败，请检查网络后重试", "error");
      return false;
    }

    project = serverProj;
    try { localStorage.setItem(_uPrefix + "sw_last_project_id", project.id); } catch (_) {}

    syncEditProject(project);
    syncTasksProject(project);
    syncVideoTasksProject(project);
    syncVideoPromptsProject(project);
    syncShotsProject(project);
    syncStoryboardProject(project);
    syncScriptProject(project);
    syncAssetsProject(project);
    addProjectToList(project);
    _ovProjectTasks = _ovProjectTasks.filter(function (t) { return t && t.projectId !== project.id; });
    _ovProjectTasks.unshift(_ovProjectTaskFromSummary({ id: project.id, name: project.name, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, status: project.status }, project));
    _ovInvalidateProjectTasks(true);
    refreshAllPages();
    _renderEpisodeTabs();
    console.log("[Project] Created (server-first):", project.id, project.name, "v=", project.version);
    return true;
  }

  /* ================================================================
     导航
     ================================================================ */
  function updateSidebarNavDot() {
    try {
      var dot = $("sidebarNavDot");
      var trackLine = $("sidebarNavTrackLine");
      var wrap = $("sidebarPipelineWrap");
      if (!dot || !trackLine || !wrap) return;
      if (SIDEBAR_PIPELINE_PAGES.indexOf(activePage) < 0) {
        dot.style.opacity = "0";
        return;
      }
      var navId = "nav" + activePage.charAt(0).toUpperCase() + activePage.slice(1);
      var activeBtn = $(navId);
      if (!activeBtn || !wrap.contains(activeBtn)) {
        dot.style.opacity = "0";
        return;
      }
      dot.style.opacity = "1";
      var lineRect = trackLine.getBoundingClientRect();
      var btnRect = activeBtn.getBoundingClientRect();
      var y = btnRect.top + btnRect.height / 2 - lineRect.top;
      var pad = 8;
      var h = lineRect.height;
      if (y < pad) y = pad;
      if (y > h - pad) y = h - pad;
      dot.style.top = y + "px";
    } catch (e) {}
  }

  // ----------------------------------------------------------------
  // 订阅与积分弹窗（#billingModal）
  // 点积分卡片或任意 switchPage("billing") 调用点都走这里；
  // 打开 modal 只是覆盖浮层，不影响 activePage / 其他 page 的 hidden 状态，
  // 关闭后用户回到原来的工作页面（符合"积分是账户辅助浮层"的语义）。
  // 关闭路径：右上 × / 点遮罩 / 按 ESC，三条路径最终都走 closeBillingModal。
  // 渲染：#billingContent 仍由 static/modules/billing.js 的 renderBillingPage() 注入，
  //      这里只负责开关外壳 + 必要时触发一次 loadBillingSummary() 以刷新数据。
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Billing modal 的"工作台点阵"canvas 动画
  //   复用 static/index.html 里 #dotMatrixCanvas 的绘制参数（22px 网格、
  //   rgba(11,19,32,0.22~0.32) 深色点、呼吸 + 波浪 + 鼠标磁吸）。
  //   独立实例绘制，避免依赖原 canvas 的层叠穿透；在 modal 关闭时停止 RAF
  //   节省 CPU。
  // ----------------------------------------------------------------
  var _billingDotsCtx = null;
  var _billingDotsRAF = 0;
  var _billingDotsDots = [];
  var _billingDotsMx = -9999;
  var _billingDotsMy = -9999;
  var _billingDotsMouseBound = false;
  var _billingDotsResizeObs = null;
  var _billingDotsRect = null;
  var _billingDotsW = 0;
  var _billingDotsH = 0;

  var _bdOpBuckets = {};
  for (var _bdi = 0; _bdi <= 20; _bdi++) {
    var _bdOp = (0.22 + (_bdi / 20) * 0.10).toFixed(3);
    _bdOpBuckets[_bdi] = "rgba(11,19,32," + _bdOp + ")";
  }

  function _billingDotsResize() {
    var canvas = document.getElementById("billingModalDots");
    if (!canvas) return;
    var dialog = canvas.parentElement;
    if (!dialog) return;
    var rect = dialog.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(Math.max(rect.height, dialog.scrollHeight)));
    if (w === _billingDotsW && h === _billingDotsH) return;
    _billingDotsW = w;
    _billingDotsH = h;
    canvas.width = w;
    canvas.height = h;
    canvas.style.height = h + "px";
    _billingDotsRect = rect;
    var spacing = 22;
    _billingDotsDots = [];
    var rows = Math.ceil(h / spacing) + 1;
    var cols = Math.ceil(w / spacing) + 1;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        _billingDotsDots.push({
          ox: c * spacing,
          oy: r * spacing,
          x: c * spacing,
          y: r * spacing,
          phase: Math.random() * Math.PI * 2
        });
      }
    }
  }

  function _billingDotsDraw(t) {
    var canvas = document.getElementById("billingModalDots");
    if (!canvas || !_billingDotsCtx) { _billingDotsRAF = 0; return; }
    var ctx = _billingDotsCtx;
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var sec = (t * 0.001) || 0;
    var rect = _billingDotsRect;
    if (!rect) { rect = canvas.getBoundingClientRect(); _billingDotsRect = rect; }
    var localMx = _billingDotsMx - rect.left;
    var localMy = _billingDotsMy - rect.top;
    var dots = _billingDotsDots;
    var len = dots.length;
    var buckets = {};
    for (var i = 0; i < len; i++) {
      var d = dots[i];
      var wvX = Math.sin(sec * 0.6 + d.ox * 0.004) * 6;
      var wvY = Math.cos(sec * 0.5 + d.oy * 0.004) * 6;
      var dx = localMx - d.ox;
      var dy = localMy - d.oy;
      var distSq = dx * dx + dy * dy;
      var iX = 0, iY = 0, iS = 1;
      if (distSq < 40000) {
        var dist = Math.sqrt(distSq);
        var f = (200 - dist) / 200;
        iX = -(dx / dist) * f * 14;
        iY = -(dy / dist) * f * 14;
        iS = 1 + f * 0.6;
      }
      var breath = 1 + Math.sin(sec * 1.0 + d.phase) * 0.25;
      d.x = d.ox + wvX + iX;
      d.y = d.oy + wvY + iY;
      var pulse = Math.abs(Math.sin(sec * 0.8 + d.phase));
      var bucketKey = Math.round(pulse * 20);
      var sz = 1.0 * iS * breath;
      if (!buckets[bucketKey]) buckets[bucketKey] = [];
      buckets[bucketKey].push(d.x, d.y, sz);
    }
    for (var key in buckets) {
      ctx.fillStyle = _bdOpBuckets[key] || "rgba(11,19,32,0.22)";
      ctx.beginPath();
      var arr = buckets[key];
      for (var j = 0; j < arr.length; j += 3) {
        var cx = arr[j], cy = arr[j + 1], r = arr[j + 2];
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, 6.2832);
      }
      ctx.fill();
    }
    _billingDotsRAF = requestAnimationFrame(_billingDotsDraw);
  }

  function _startBillingDots() {
    var canvas = document.getElementById("billingModalDots");
    if (!canvas) return;
    if (_billingDotsRAF) return;
    _billingDotsCtx = canvas.getContext("2d");
    _billingDotsRect = null;
    _billingDotsW = 0;
    _billingDotsH = 0;
    _billingDotsResize();
    if (!_billingDotsMouseBound) {
      _billingDotsMouseBound = true;
      document.addEventListener("mousemove", function (e) {
        _billingDotsMx = e.clientX;
        _billingDotsMy = e.clientY;
      });
      document.addEventListener("mouseleave", function () {
        _billingDotsMx = -9999;
        _billingDotsMy = -9999;
      });
    }
    if (typeof ResizeObserver !== "undefined" && !_billingDotsResizeObs) {
      var dialog = canvas.parentElement;
      if (dialog) {
        var _bdResizeTimer = 0;
        _billingDotsResizeObs = new ResizeObserver(function () {
          clearTimeout(_bdResizeTimer);
          _bdResizeTimer = setTimeout(function () { _billingDotsRect = null; _billingDotsResize(); }, 100);
        });
        _billingDotsResizeObs.observe(dialog);
      }
    }
    _billingDotsRAF = requestAnimationFrame(_billingDotsDraw);
  }

  function _stopBillingDots() {
    if (_billingDotsRAF) {
      cancelAnimationFrame(_billingDotsRAF);
      _billingDotsRAF = 0;
    }
    if (_billingDotsResizeObs) {
      try { _billingDotsResizeObs.disconnect(); } catch (_e) {}
      _billingDotsResizeObs = null;
    }
  }

  function openBillingModal() {
    var modal = document.getElementById("billingModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("billing-modal-lock");
    // 先渲染当前已有的 _summary，再异步拉一次最新账务状态，保证数据新鲜
    try { renderBillingPage(); } catch (e) { console.warn("[BillingModal] renderBillingPage failed:", e); }
    try { loadBillingSummary().then(function () { try { renderBillingPage(); } catch (_) {} }); } catch (e) {}
    // 下一帧加 is-open，让 CSS transition 生效
    requestAnimationFrame(function () { modal.classList.add("is-open"); });
    // 启动点阵动画（工作台同款）；等 transition 起跑再启动避免动画与尺寸同步
    setTimeout(function () { _startBillingDots(); }, 40);
  }
  function closeBillingModal() {
    var modal = document.getElementById("billingModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    _stopBillingDots();
    // 和 CSS transition (220ms) 对齐，结束后再隐藏，避免闪烁
    setTimeout(function () {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("billing-modal-lock");
    }, 200);
  }

  function _refreshPageForActiveRoute(page) {
    try {
      if (page === "overview") refreshOverview();
      if (page === "script") refreshScriptPage();
      if (page === "style") refreshStylePage();
      if (page === "assets") refreshAssetsPage();
      if (page === "shots") refreshShotsPage();
      if (page === "images") refreshImagesPage();
      if (page === "prompts") refreshPromptsPage();
      if (page === "batch") refreshBatchPage();
      if (page === "edit") refreshEditPage();
      if (page === "library") refreshLibraryPage();
      if (page === "admin") refreshAdminPage();
    } catch (e) {
      console.error("[SwitchPage] refresh failed:", page, e);
    }
  }

  function _resetRouteScroll(pageEl) {
    try {
      if (pageEl) pageEl.scrollTop = 0;
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      if (window.scrollTo) window.scrollTo(0, 0);
    } catch (e) {
      console.warn("[SwitchPage] reset scroll failed:", e);
    }
  }

  function switchPage(page, options) {
    options = options || {};
    // billing 不再是独立 page，而是浮层弹窗，提前 return 不影响当前 activePage
    if (page === "billing") { openBillingModal(); return; }
    if (PAGES.indexOf(page) === -1) return;
    if (options.user && _appBootstrapping) _bootUserNavigated = true;
    activePage = page;
    var activePageEl = null;
    for (var i = 0; i < PAGES.length; i++) {
      var pid = "page" + PAGES[i].charAt(0).toUpperCase() + PAGES[i].slice(1);
      var el = $(pid);
      if (el) {
        var show = PAGES[i] === page;
        if (show) {
          activePageEl = el;
          el.hidden = false;
          el.classList.remove("page-enter-anim");
          void el.offsetWidth;
          el.classList.add("page-enter-anim");
          setTimeout(function (node) {
            return function () { if (node) node.classList.remove("page-enter-anim"); };
          }(el), 320);
        } else {
          el.hidden = true;
          el.classList.remove("page-enter-anim");
        }
      }
      var nav = $("nav" + PAGES[i].charAt(0).toUpperCase() + PAGES[i].slice(1));
      if (nav) nav.classList.toggle("is-active", PAGES[i] === page);
    }
    if (!options.preserveScroll) _resetRouteScroll(activePageEl);
    requestAnimationFrame(function () {
      if (!options.preserveScroll) _resetRouteScroll(activePageEl);
      requestAnimationFrame(updateSidebarNavDot);
    });
    if (_appBootstrapping && !options.forceRefresh) {
      _bootDeferredPageRefresh = page;
      return;
    }
    _refreshPageForActiveRoute(page);
  }

  function _wireCoreNavigationOnce() {
    if (_coreNavigationBound) return;
    _coreNavigationBound = true;
    PAGES.forEach(function (page) {
      var navId = "nav" + page.charAt(0).toUpperCase() + page.slice(1);
      var navEl = $(navId);
      if (navEl) navEl.addEventListener("click", function () { switchPage(page, { user: true }); });
    });

    var billingModalEl = $("billingModal");
    var billingCloseBtn = $("billingModalClose");
    if (billingCloseBtn) billingCloseBtn.addEventListener("click", closeBillingModal);
    if (billingModalEl) {
      billingModalEl.addEventListener("click", function (ev) {
        var t = ev && ev.target;
        if (t && t.getAttribute && t.getAttribute("data-billing-close") === "1") closeBillingModal();
      });
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!billingModalEl) return;
      if (billingModalEl.classList.contains("hidden")) return;
      closeBillingModal();
    });

    window.addEventListener("resize", updateSidebarNavDot);
    var trackHost = $("sidebarNavTrackHost");
    if (trackHost) trackHost.addEventListener("scroll", updateSidebarNavDot, { passive: true });

    document.addEventListener("click", function (e) {
      var el = e.target.closest("[data-goto]");
      if (el) { e.preventDefault(); switchPage(el.dataset.goto, { user: true }); }
    });
  }

  /* ================================================================
     帐号栏 + 管理面板
     ================================================================ */
  var _isAdmin = false;

  function _initAccountBar() {
    try {
      var stored = JSON.parse(localStorage.getItem("sw_auth_user") || "{}");
      var nameEl = $("accountUsername");
      if (nameEl && stored.username) nameEl.textContent = stored.username;
    } catch (e) {}

    function logoutCurrentUser() {
      localStorage.removeItem("sw_auth_token");
      localStorage.removeItem("sw_auth_user");
      window.location.href = "/";
    }
    ["btnLogout", "btnSettingsLogout"].forEach(function (id) {
      var logoutBtn = $(id);
      if (logoutBtn) logoutBtn.addEventListener("click", logoutCurrentUser);
    });

    fetch("/api/auth/me", { headers: _getAuthHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var nameEl = $("accountUsername");
        if (nameEl) nameEl.textContent = data.displayName || data.username;
        try { loadBillingSummary(); } catch (_) {}
        try { refreshBillingBadge(); } catch (_) {}
        // 暴露给其它模块（如 shots/storyboard/videoPrompts）判断是否挂诊断面板。
        // 只读、刻意全局、刷新即重置，避免本地存储被改假冒管理员。
        window.__qdIsAdmin = !!data.isAdmin;
        if (data.isAdmin) {
          _isAdmin = true;
          var navAdmin = $("navAdmin");
          if (navAdmin) navAdmin.hidden = false;
          var navSettings = $("navSettings");
          if (navSettings) navSettings.hidden = false;
        } else {
          // 非管理员：把所有诊断容器立即隐藏，避免短暂闪烁
          var diagIds = ["shotsDiagnostic", "sbDiagnostic", "vpDiagnostic"];
          diagIds.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) { el.hidden = true; el.style.display = "none"; }
          });
        }
      })
      .catch(function (e) { console.warn("[Account] /me failed:", e); });
  }

  async function refreshAdminPage() {
    if (!_isAdmin) return;
    var usersEl = $("statTotalUsers");
    var projectsEl = $("statTotalProjects");
    var onlineEl = $("statOnlineCount");
    var paidUsersEl = $("statPaidUsers");
    var paidAmountEl = $("statPaidAmount");
    var tbody = $("adminUserTableBody");
    var usageTbody = $("adminUsageTableBody");
    var onlineTbody = $("adminOnlineTableBody");
    try {
      var resp = await fetch("/api/auth/admin/stats", { headers: _getAuthHeaders() });
      if (!resp.ok) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-red-400">无权限或请求失败 (' + resp.status + ')</td></tr>';
        if (onlineTbody) onlineTbody.innerHTML = '<tr><td colspan="3" class="px-6 py-8 text-center text-red-400">无权限或请求失败 (' + resp.status + ')</td></tr>';
        return;
      }
      var data = await resp.json();
      if (usersEl) { usersEl.textContent = data.totalUsers || 0; usersEl.classList.remove("hidden"); }
      if (projectsEl) { projectsEl.textContent = data.totalProjects || 0; projectsEl.classList.remove("hidden"); }
      if (onlineEl) { onlineEl.textContent = data.onlineCount || 0; onlineEl.classList.remove("hidden"); }
      if (paidUsersEl) { paidUsersEl.textContent = data.paidUsers || 0; paidUsersEl.classList.remove("hidden"); }
      if (paidAmountEl) { paidAmountEl.textContent = _formatMoneyList(data.paidAmounts); paidAmountEl.classList.remove("hidden"); }
      var _skelIds = ["statTotalUsersSkel", "statTotalProjectsSkel", "statOnlineCountSkel", "statPaidUsersSkel", "statPaidAmountSkel"];
      _skelIds.forEach(function (id) { var el = $(id); if (el) el.style.display = "none"; });

      var onlineSet = {};
      if (data.onlineUsers) {
        data.onlineUsers.forEach(function (o) { onlineSet[o.username] = true; });
      }

      if (onlineTbody) {
        if (!data.onlineUsers || !data.onlineUsers.length) {
          onlineTbody.innerHTML = '<tr><td colspan="3" class="px-6 py-8 text-center text-on-surface-variant/40">暂无在线用户</td></tr>';
        } else {
          onlineTbody.innerHTML = data.onlineUsers.map(function (u) {
            return '<tr class="border-b border-outline-variant/5 hover:bg-white/[0.02] transition-colors">' +
              '<td class="px-6 py-3 text-on-surface-variant/60">' + _escHtml(String(u.userId || "--")) + '</td>' +
              '<td class="px-6 py-3 font-medium"><span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-2" title="在线"></span>' + _escHtml(u.username || "--") + '</td>' +
              '<td class="px-6 py-3 text-on-surface-variant/50 text-xs whitespace-nowrap">' + _escHtml(_formatAdminTime(u.lastActive)) + '</td>' +
            '</tr>';
          }).join("");
        }
      }

      if (usageTbody && data.userUsage) {
        if (data.userUsage.length === 0 || data.userUsage.every(function (u) { return u.totalCalls === 0; })) {
          usageTbody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-on-surface-variant/40">暂无调用数据</td></tr>';
        } else {
          usageTbody.innerHTML = data.userUsage.filter(function (u) { return u.totalCalls > 0; }).map(function (u) {
            var dot = onlineSet[u.username]
              ? '<span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-2" title="在线"></span>'
              : '<span class="inline-block w-2 h-2 rounded-full bg-gray-600 mr-2" title="离线"></span>';
            return '<tr class="border-b border-outline-variant/5 hover:bg-white/[0.02] transition-colors">' +
              '<td class="px-4 py-3 font-medium">' + dot + _escHtml(u.username) + '</td>' +
              '<td class="px-4 py-3 text-right">' + u.totalCalls + '</td>' +
              '<td class="px-4 py-3 text-right text-on-surface-variant/60">' + _formatNum(u.totalTokens) + '</td>' +
              '<td class="px-4 py-3 text-right text-on-surface-variant/60">' + (u.textCalls + u.multimodalCalls) + '</td>' +
              '<td class="px-4 py-3 text-right text-on-surface-variant/60">' + u.imageCalls + '</td>' +
              '<td class="px-4 py-3 text-right text-on-surface-variant/60">' + u.videoCalls + '</td>' +
            '</tr>';
          }).join("");
        }
      }

      if (tbody && data.recentUsers) {
        tbody.innerHTML = data.recentUsers.map(function (u) {
          var dot = onlineSet[u.username]
            ? '<span class="inline-block w-2 h-2 rounded-full bg-green-400 mr-2" title="在线"></span>'
            : '';
          return '<tr class="border-b border-outline-variant/5 hover:bg-white/[0.02] transition-colors">' +
            '<td class="px-6 py-3 text-on-surface-variant/60">' + u.id + '</td>' +
            '<td class="px-6 py-3 font-medium">' + dot + _escHtml(u.username) + '</td>' +
            '<td class="px-6 py-3 text-on-surface-variant/70">' + _escHtml(u.displayName || "--") + '</td>' +
            '<td class="px-6 py-3 text-on-surface-variant/50 text-xs">' + _escHtml(u.createdAt || "--") + '</td>' +
          '</tr>';
        }).join("");
      }
    } catch (e) {
      console.error("[Admin] stats failed:", e);
      if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-red-400">加载失败</td></tr>';
      if (onlineTbody) onlineTbody.innerHTML = '<tr><td colspan="3" class="px-6 py-8 text-center text-red-400">加载失败</td></tr>';
    }
    _loadAdminLogs();
  }

  var _adminLogLevel = "warning";

  async function _loadAdminLogs(level) {
    _adminLogLevel = level || _adminLogLevel;
    var info = $("adminLogInfo");
    var content = $("adminLogContent");
    var btnW = $("btnLogWarning");
    var btnA = $("btnLogAll");
    if (btnW) {
      btnW.className = _adminLogLevel === "warning"
        ? "px-3 py-1 text-xs rounded-full bg-primary/10 text-primary font-bold"
        : "px-3 py-1 text-xs rounded-full bg-surface-container text-on-surface-variant font-bold";
    }
    if (btnA) {
      btnA.className = _adminLogLevel === "all"
        ? "px-3 py-1 text-xs rounded-full bg-primary/10 text-primary font-bold"
        : "px-3 py-1 text-xs rounded-full bg-surface-container text-on-surface-variant font-bold";
    }
    try {
      var resp = await fetch("/api/auth/admin/logs?level=" + _adminLogLevel + "&lines=300", { headers: _getAuthHeaders() });
      if (!resp.ok) { if (content) content.textContent = "无权限或请求失败"; return; }
      var data = await resp.json();
      if (info) info.textContent = data.file + " · 共 " + data.total + " 行 · 显示最近 " + data.lines.length + " 行";
      if (content) {
        if (!data.lines.length) {
          content.textContent = "暂无日志";
        } else {
          content.textContent = data.lines.join("\n");
          content.scrollTop = content.scrollHeight;
        }
      }
    } catch (e) {
      if (content) content.textContent = "加载失败: " + e.message;
    }
  }

  function _initAdminLogButtons() {
    var btnW = $("btnLogWarning");
    var btnA = $("btnLogAll");
    var btnR = $("btnLogRefresh");
    if (btnW) btnW.addEventListener("click", function () { _loadAdminLogs("warning"); });
    if (btnA) btnA.addEventListener("click", function () { _loadAdminLogs("all"); });
    if (btnR) btnR.addEventListener("click", function () { _loadAdminLogs(); });
  }

  function _formatMoneyList(items) {
    if (!Array.isArray(items) || !items.length) return "USD 0.00";
    return items.map(function (item) {
      return _formatMoney(item.amountCents, item.currency);
    }).join("\n");
  }

  function _formatMoney(amountCents, currency) {
    var cents = Number(amountCents || 0);
    var code = String(currency || "USD").toUpperCase();
    if (!isFinite(cents)) cents = 0;
    return code + " " + (cents / 100).toFixed(2);
  }

  function _formatNum(n) {
    if (!n || n < 1000) return String(n || 0);
    if (n < 1000000) return (n / 1000).toFixed(1) + "K";
    return (n / 1000000).toFixed(1) + "M";
  }

  function _formatAdminTime(value) {
    if (!value) return "--";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function _escHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ================================================================
     模型适配器（热插拔核心 — Responses API 格式）
     ================================================================ */
  function convertToResponsesInput(messages) {
    var input = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var content;
      if (typeof msg.content === "string") {
        content = [{ type: "input_text", text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        content = msg.content;
      } else {
        content = [{ type: "input_text", text: String(msg.content) }];
      }
      input.push({ role: msg.role, content: content });
    }
    return { input: input };
  }

  /* convertToChatMessages — moved to Python backend */

  /* extractResponseText, stripSseCommentLines, parseChatApiResponseBody, callChatCompletion — all moved to Python backend */


  /* ================================================================
     任务列表页
     ================================================================ */
  /**
   * Phase 5.9：项目列表改为服务器权威源。
   *
   * 历史坑：之前 `renderProjectList` 从 `localStorage.u<uid>_sw_project_list`
   * 读，一旦 `_uPrefix` 计算错（sw_auth_user 里 id 字段缺失 / 格式变化 / 旧
   * 账号残留），key 就对不上，服务器数据明明到了浏览器也显示不出来——用户
   * 看到"空账号"，点新建又被后端配额挡回去，诡异得一塌糊涂。
   *
   * 现在：每次 render 都从 `/api/projects` 实时拉，UI 直接反映服务器真实
   * 状态。localStorage 依旧写，但只作为离线兜底（fetch 失败 / 网络断时才
   * 降级用本地）。保证"刷新后前端 UI = 服务器 project.json"。
   */
  function renderProjectList() {
    var wrap = $("projectListWrap");
    if (!wrap) return;

    // 先用本地 cache 做即时渲染（避免从服务器拉回来之前空白闪一下）。
    _renderProjectListFromArray(wrap, getProjectList());

    // 然后同步去拉服务器权威列表，拿到再覆盖渲染。
    getProjectListFromServer().then(function (serverList) {
      if (!Array.isArray(serverList)) return;
      // 归一成前端 list 结构：id / name / createdAt（updatedAt 不影响列表渲染）
      var normalized = serverList.map(function (sp) {
        return { id: sp.id, name: sp.name, createdAt: sp.createdAt };
      });
      try { saveProjectList(normalized); } catch (_) {}
      _renderProjectListFromArray(wrap, normalized);
    }).catch(function (err) {
      console.warn("[renderProjectList] server fetch failed, keep local:", err);
    });
  }

  function _renderProjectListFromArray(wrap, list) {
    if (!wrap) return;
    list = Array.isArray(list) ? list : [];
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">暂无已保存的项目</div>';
      return;
    }
    var html = '<div style="font-size:10px;color:#888;margin-bottom:6px">' + list.length + '/' + MAX_PROJECTS + ' 个项目</div>';
    list.forEach(function (p) {
      var isCurrent = project && project.id === p.id;
      var d = p.createdAt ? new Date(p.createdAt) : null;
      var dateStr = d ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') : '';
      html +=
        '<div class="plist-item' + (isCurrent ? ' plist-current' : '') + '">' +
          '<div class="plist-info">' +
            '<span class="plist-name">' + escapeHtml(p.name || '未命名') + '</span>' +
            '<span class="plist-date">' + dateStr + '</span>' +
          '</div>' +
          '<div class="plist-actions">' +
            (isCurrent ? '<span class="plist-badge">当前</span>' :
              '<button type="button" class="btn btn-secondary btn-sm" data-paction="switch" data-pid="' + escapeHtml(p.id) + '">切换</button>') +
            '<button type="button" class="btn btn-secondary btn-sm" data-paction="rename" data-pid="' + escapeHtml(p.id) + '" data-pname="' + escapeHtml(p.name || '未命名') + '" style="margin-left:4px" title="重命名">✏</button>' +
            '<button type="button" class="btn btn-secondary btn-sm" data-paction="delete" data-pid="' + escapeHtml(p.id) + '" data-pname="' + escapeHtml(p.name || '未命名') + '" style="margin-left:4px;color:#f44">删除</button>' +
          '</div>' +
        '</div>';
    });
    wrap.innerHTML = html;
  }

  function handleProjectListAction(e) {
    var btn = e.target.closest("[data-paction]");
    if (!btn) return;
    var action = btn.getAttribute("data-paction");
    var pid = btn.getAttribute("data-pid");
    try {
      if (action === "switch" && pid) {
        switchToProject(pid);
        renderProjectList();
      } else if (action === "delete" && pid) {
        deleteProject(pid);
        renderProjectList();
        refreshOverview();
      } else if (action === "rename" && pid) {
        var oldName = btn.getAttribute("data-pname") || "未命名";
        var newName = prompt("输入新的项目名称：", oldName);
        if (newName && newName.trim() && newName.trim() !== oldName) {
          _renameProject(pid, newName.trim());
        }
      }
    } catch (err) {
      console.error("[ProjectListAction]", err);
    }
  }

  /**
   * Phase 5.3/5.4：非当前项目不再走 localStorage 影子写；直接 GET→patch→PUT
   * 让后端 project.json 成为唯一权威源。失败时给用户 toast，避免静默。
   */
  async function _renameProject(pid, newName) {
    newName = String(newName || "").trim().slice(0, 200);
    if (!pid || !newName) return false;
    if (project && project.id === pid) {
      project.name = newName;
      project.title = newName;
      saveProject();
      var saved = await _flushServerSave();
      if (!saved || !saved.ok) {
        showToast("重命名失败：服务器未保存成功", "error");
        return false;
      }
    } else {
      try {
        var resp = await fetch("/api/projects/" + encodeURIComponent(pid), {
          headers: _getAuthHeaders(),
        });
        if (!resp.ok) {
          showToast("重命名失败：项目读取失败（" + resp.status + "）", "error");
          return false;
        }
        var p = await resp.json();
        if (!p || !p.id) {
          showToast("重命名失败：项目数据异常", "error");
          return false;
        }
        p.name = newName;
        p.title = newName;
        var headers = Object.assign({}, _getAuthHeaders());
        if (typeof p.version === "number") headers["If-Match"] = "v" + p.version;
        var putResp = await fetch("/api/projects/" + encodeURIComponent(pid), {
          method: "PUT",
          headers: headers,
          body: JSON.stringify(p),
        });
        if (putResp.status === 409) {
          showToast("项目在另一处被修改，请刷新后再重命名", "warn");
          return false;
        }
        if (!putResp.ok) {
          showToast("重命名失败：服务器拒绝（" + putResp.status + "）", "error");
          return false;
        }
      } catch (e) {
        console.warn("[RenameProject] server failed:", e);
        showToast("重命名失败：网络错误", "error");
        return false;
      }
    }
    var list = getProjectList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === pid) { list[i].name = newName; list[i].title = newName; break; }
    }
    localStorage.setItem(_uPrefix + "sw_project_list", JSON.stringify(list));
    _ovProjectTasks = _ovProjectTasks.map(function (t) {
      if (!t || t.projectId !== pid) return t;
      return Object.assign({}, t, { title: newName });
    });
    _ovInvalidateProjectTasks(true);
    renderProjectList();
    refreshOverview();
    return true;
  }

  var _ovTaskState = {
    status: "all",
    query: "",
    page: 1,
    pageSize: 10,
    selectedId: "",
    editingTitleId: "",
  };
  var _overviewDashboardBound = false;
  var _ovProjectTasks = [];
  var _ovProjectTasksLoaded = false;
  var _ovProjectTasksLoading = false;
  var _ovProjectTasksDirty = false;
  var _ovProjectTasksSeq = 0;
  var _ovProjectTaskNavigating = false;
  var _ovProjectTaskDeleting = false;
  var _ovProjectTaskCreating = false;
  var _ovSearchLastUserInputAt = 0;
  var _ovSearchLastFocusAt = 0;
  var _ovSearchComposing = false;

  function _ovSearchValue() {
    return String(_ovTaskState.query || "");
  }

  function _ovMarkSearchUserInput() {
    _ovSearchLastUserInputAt = Date.now();
  }

  function _ovIsTrustedUserEvent(e) {
    return !!(e && e.isTrusted);
  }

  function _ovIsRecentSearchUserInput() {
    return Date.now() - _ovSearchLastUserInputAt < 1500;
  }

  function _ovMarkSearchFocus() {
    _ovSearchLastFocusAt = Date.now();
  }

  function _ovIsRecentSearchFocus() {
    return Date.now() - _ovSearchLastFocusAt < 5000;
  }

  function _ovResetSearchInput(search) {
    if (!search) search = $("ovTaskSearch");
    if (!search) return;
    if (_ovSearchComposing && document.activeElement === search) return;
    var expected = _ovSearchValue();
    if (search.value !== expected) search.value = expected;
  }

  function _ovClearSearchInput(search) {
    if (!search) search = $("ovTaskSearch");
    _ovTaskState.query = "";
    _ovTaskState.page = 1;
    _ovResetSearchInput(search);
  }

  function _ovDeferSearchReset(search) {
    _ovResetSearchInput(search);
    setTimeout(function () { _ovResetSearchInput(search); }, 0);
    setTimeout(function () { _ovResetSearchInput(search); }, 120);
  }

  function _ovGuardSearchAutofill(search) {
    if (!search) search = $("ovTaskSearch");
    if (!search) return;
    if (_ovSearchComposing) return;
    if (document.activeElement === search || _ovIsRecentSearchUserInput()) return;
    if (!_ovTaskState.query && search.value) search.value = "";
  }

  function _ovScheduleSearchAutofillGuard(search) {
    [0, 80, 250, 700, 1500, 3200].forEach(function (ms) {
      setTimeout(function () { _ovGuardSearchAutofill(search); }, ms);
    });
  }

  function _ovIsCredentialReplacementInput(e) {
    return e && (
      e.inputType === "insertReplacementText" ||
      e.inputType === "insertFromAutoComplete" ||
      e.inputType === "insertFromSuggestion"
    );
  }

  function _ovCredentialSearchCandidates() {
    var candidates = [];
    try {
      var stored = JSON.parse(localStorage.getItem("sw_auth_user") || "{}");
      if (stored && stored.username) candidates.push(String(stored.username));
    } catch (_) {}
    var accountName = $("accountUsername");
    if (accountName && accountName.textContent) candidates.push(accountName.textContent);
    var honey = document.querySelector('input[name="username"]');
    if (honey && honey.value) candidates.push(honey.value);
    return candidates.map(function (v) { return String(v || "").trim(); }).filter(Boolean);
  }

  function _ovLooksLikeCredentialSearchValue(value) {
    var trimmed = String(value || "").trim();
    if (!trimmed) return false;
    return _ovCredentialSearchCandidates().some(function (candidate) { return candidate === trimmed; });
  }

  function _ovHasActiveSearchIntent(search) {
    if (!search) search = $("ovTaskSearch");
    return document.activeElement === search && (_ovIsRecentSearchUserInput() || _ovIsRecentSearchFocus());
  }

  function _ovApplySearchInput(search) {
    if (!search) search = $("ovTaskSearch");
    if (!search) return;
    if (_ovLooksLikeCredentialSearchValue(search.value)) {
      _ovClearSearchInput(search);
      _ovRenderDashboard();
      return;
    }
    _ovTaskState.query = search.value || "";
    _ovTaskState.page = 1;
    _ovRenderDashboard();
  }

  function _ovAllowSearchInputEvent(e, search) {
    if (!e) return false;
    if (_ovIsCredentialReplacementInput(e)) return false;
    if (!_ovIsTrustedUserEvent(e) && !_ovHasActiveSearchIntent(search)) return false;
    if (e.isComposing) return false;
    return true;
  }

  function _blockCredentialReplacementInput(input) {
    if (!input) return;
    input.addEventListener("beforeinput", function (e) {
      if (!_ovIsCredentialReplacementInput(e)) return;
      e.preventDefault();
      setTimeout(function () { input.value = ""; }, 0);
    });
    input.addEventListener("input", function (e) {
      if (!_ovIsCredentialReplacementInput(e)) return;
      input.value = "";
    });
  }

  function _ovPaginationItems(totalPages, currentPage) {
    totalPages = Math.max(1, Number(totalPages) || 1);
    currentPage = Math.max(1, Math.min(totalPages, Number(currentPage) || 1));
    if (totalPages <= 5) {
      var all = [];
      for (var i = 1; i <= totalPages; i++) all.push(i);
      return all;
    }
    var start = Math.max(2, currentPage - 1);
    var end = Math.min(totalPages - 1, currentPage + 1);
    if (currentPage <= 3) { start = 2; end = 4; }
    if (currentPage >= totalPages - 2) { start = totalPages - 3; end = totalPages - 1; }
    var pages = [1];
    if (start > 2) pages.push("gap-left");
    for (var p = start; p <= end; p++) pages.push(p);
    if (end < totalPages - 1) pages.push("gap-right");
    pages.push(totalPages);
    return pages;
  }

  function _ovPad2(n) {
    n = Number(n) || 0;
    return String(n).padStart(2, "0");
  }

  function _ovFormatDate(ts) {
    if (!ts) return "--";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "--";
    return d.getFullYear() + "/" + _ovPad2(d.getMonth() + 1) + "/" + _ovPad2(d.getDate()) + " " + _ovPad2(d.getHours()) + ":" + _ovPad2(d.getMinutes());
  }

  function _ovShortTime(ts) {
    if (!ts) return "--";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "--";
    return _ovPad2(d.getHours()) + ":" + _ovPad2(d.getMinutes());
  }

  function _ovFormatDuration(sec) {
    var n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return "--";
    n = Math.round(n);
    return _ovPad2(Math.floor(n / 60)) + ":" + _ovPad2(n % 60);
  }

  function _ovText(v, fallback) {
    if (v === null || v === undefined) return fallback || "--";
    var s = String(v).trim();
    return s ? s : (fallback || "--");
  }

  function _ovFirst() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && String(v).trim()) return v;
    }
    return "";
  }

  var _OV_INTERNAL_IMAGE_RE = /\/api\/images\/file\/([0-9a-fA-F-]{36})/;
  var _OV_BLANK_THUMB_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  function _ovImageAssetIdFromUrl(url) {
    var m = _OV_INTERNAL_IMAGE_RE.exec(String(url || ""));
    return m ? m[1] : "";
  }

  function _ovSignedImageUrlStillValid(url) {
    url = String(url || "").trim();
    if (!url || url.indexOf("sig=") < 0 || url.indexOf("exp=") < 0) return false;
    try {
      var u = new URL(url, window.location.origin);
      var exp = parseInt(u.searchParams.get("exp") || "0", 10);
      return Number.isFinite(exp) && exp * 1000 > Date.now() + 15000;
    } catch (_) {
      return false;
    }
  }

  function _ovThumbnailNeedsSigning(url) {
    return !!_ovImageAssetIdFromUrl(url) && !_ovSignedImageUrlStillValid(url);
  }

  function _ovOverviewThumbnailDisplayUrl(url) {
    url = String(url || "").trim();
    if (!url || !_ovImageAssetIdFromUrl(url)) return url;
    try {
      var u = new URL(url, window.location.origin);
      u.searchParams.set("w", "192");
      return u.pathname + u.search + u.hash;
    } catch (_) {
      return url;
    }
  }

  function _ovThumbnailPosterUrl(url) {
    url = String(url || "").trim();
    if (!url || _ovThumbnailNeedsSigning(url)) return "";
    return _ovOverviewThumbnailDisplayUrl(url);
  }

  function _ovThumbnailImgHtml(url) {
    url = String(url || "").trim();
    if (!url) return "";
    var id = _ovImageAssetIdFromUrl(url);
    var src = _ovThumbnailNeedsSigning(url) ? _OV_BLANK_THUMB_SRC : _ovOverviewThumbnailDisplayUrl(url);
    return '<img src="' + escapeHtml(src) + '" alt="" loading="lazy" decoding="async" data-ov-thumb-src="' + escapeHtml(url) + '"' + (id ? ' data-ov-thumb-id="' + escapeHtml(id) + '"' : "") + '>';
  }

  async function _ovEnsureThumbnailImage(img, force) {
    if (!img || img.dataset.ovThumbLoading === "1") return;
    var original = img.getAttribute("data-ov-thumb-src") || img.getAttribute("src") || "";
    var id = img.getAttribute("data-ov-thumb-id") || _ovImageAssetIdFromUrl(original);
    if (!id) return;
    var current = img.getAttribute("src") || "";
    if (!force && current && current !== _OV_BLANK_THUMB_SRC && _ovSignedImageUrlStillValid(current)) return;
    img.dataset.ovThumbLoading = "1";
    try {
      var signed = await fetchAssetSignedUrl(id, 3600);
      if (signed && img.isConnected) {
        img.src = _ovOverviewThumbnailDisplayUrl(signed);
        img.setAttribute("data-ov-thumb-src", signed);
      }
    } finally {
      if (img.isConnected) delete img.dataset.ovThumbLoading;
    }
  }

  function _ovRefreshThumbnailImages(root) {
    root = root || document;
    root.querySelectorAll("img[data-ov-thumb-src]").forEach(function (img) {
      _ovEnsureThumbnailImage(img, false).catch(function (err) {
        console.warn("[overview] refresh thumbnail failed:", err);
      });
    });
  }

  async function _ovHydrateProjectOverviewThumbnail(proj) {
    if (!proj || typeof proj !== "object") return proj;
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj.videoTasks) ? proj.videoTasks : [];
    for (var i = 0; i < Math.max(sbs.length, vts.length); i++) {
      var sb = sbs[i] || {};
      var vt = vts[i] || {};
      var candidates = [
        [vt, "coverUrl"], [vt, "videoCoverUrl"],
        [sb, "videoCoverUrl"], [sb, "coverUrl"], [sb, "rawUrl"], [sb, "imageUrl"],
      ];
      for (var j = 0; j < candidates.length; j++) {
        var obj = candidates[j][0];
        var key = candidates[j][1];
        var url = obj && obj[key];
        if (!url) continue;
        if (_ovThumbnailNeedsSigning(url)) {
          var id = _ovImageAssetIdFromUrl(url);
          var signed = id ? await fetchAssetSignedUrl(id, 3600) : "";
          if (signed) obj[key] = signed;
        }
        return proj;
      }
    }
    return proj;
  }

  function _ovCurrentModelLabel() {
    try {
      var m = settings && settings.models && settings.models.video;
      return _ovFirst(m && m.label, m && m.model, m && m.adapter);
    } catch (_) {
      return "";
    }
  }

  function _ovLocalTaskForGroup(gIdx) {
    if (!videoState || !Array.isArray(videoState.tasks)) return null;
    var best = null;
    for (var i = 0; i < videoState.tasks.length; i++) {
      var t = videoState.tasks[i];
      if (!t || t._killed) continue;
      if (project && t._projectId && t._projectId !== project.id) continue;
      if (Number(t._groupIdx) === Number(gIdx)) {
        if (!best || Number(t.createdAt || 0) > Number(best.createdAt || 0)) best = t;
      }
    }
    return best;
  }

	  function _ovStatusFrom(localTask, persisted, sb) {
	    if ((persisted && persisted.isCurrent === false) || (sb && sb.videoIsCurrent === false)) return "pending";
	    var raw = _ovFirst(localTask && localTask.status, persisted && persisted.status, sb && sb.videoStatus);
    raw = String(raw || "").toLowerCase();
    if (raw === "done" || raw === "completed" || raw === "complete" || raw === "succeeded" || (sb && sb.videoUrl && !raw)) return "done";
    if (raw === "failed" || raw === "timeout" || raw === "cancelled" || raw === "retry_failed") return "failed";
    if (raw === "polling" || raw === "running" || raw === "queued" || raw === "submit" || raw === "submitting" || raw === "preparing" || raw === "fetching" || raw === "in_progress") return "running";
    if (sb && sb.videoUrl) return "done";
    return "pending";
  }

  function _ovStatusLabel(task) {
    if (!task) return "待处理";
    if (task.status === "loading") return "同步中";
    if (task.status === "unknown") return "待同步";
    if (task.status === "running") return "生成中 " + task.progress + "%";
    if (task.status === "done") return "已完成";
    if (task.status === "failed") return "失败";
    return "待处理";
  }

  function _ovStatusBucket(status) {
    if (status === "loading" || status === "unknown") return "pending";
    return status || "pending";
  }

  function _ovStatusClass(status) {
    if (status === "running") return "is-running";
    if (status === "done") return "is-done";
    if (status === "failed") return "is-failed";
    return "is-pending";
  }

  function _ovSyncToolbarState() {
    var recharge = $("ovBillingRechargeBtn");
    if (recharge) {
      recharge.innerHTML = '<span class="material-symbols-outlined">rocket_launch</span>会员升级';
      recharge.title = "会员升级";
      recharge.setAttribute("aria-label", "会员升级，打开订阅积分页面");
      recharge.classList.remove("is-active");
    }
  }

  function _ovProgressFor(localTask, status) {
    if (status === "done") return 100;
    if (status === "failed" || status === "pending") return 0;
    var direct = Number(localTask && (localTask.progress || localTask.percent || localTask.pct));
    if (Number.isFinite(direct) && direct > 0) return Math.max(1, Math.min(99, Math.round(direct)));
    var elapsed = localTask && localTask.createdAt ? (Date.now() - Number(localTask.createdAt)) / 1000 : 0;
    return Math.max(8, Math.min(95, Math.round(elapsed / 90 * 100) || 12));
  }

  function _ovProjectTaskSummariesFallback() {
    var list = getProjectList();
    if (project && project.id && !list.some(function (p) { return p && p.id === project.id; })) {
      list = [{ id: project.id, name: project.name, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt }].concat(list);
    }
    return list;
  }

  function _ovProjectAssetCount(proj) {
    var assets = proj && proj.assets;
    if (!assets) return 0;
    return (assets.characters || []).length + (assets.scenes || []).length + (assets.props || []).length;
  }

  function _ovProjectSegmentCount(proj, localTasks) {
    if (!proj) return 0;
    var storyboards = Array.isArray(proj.storyboards) ? proj.storyboards.length : 0;
    var videoTasksLen = Array.isArray(proj.videoTasks) ? proj.videoTasks.length : 0;
    var prompts = Array.isArray(proj.videoPrompts) ? proj.videoPrompts.length : 0;
    var localMax = 0;
    (localTasks || []).forEach(function (t) {
      if (t && t._groupIdx != null) localMax = Math.max(localMax, Number(t._groupIdx) + 1);
    });
    return Math.max(storyboards, videoTasksLen, prompts, localMax);
  }

  function _ovLocalTasksForProject(projectId) {
    if (!videoState || !Array.isArray(videoState.tasks) || !projectId) return [];
    return videoState.tasks.filter(function (t) {
      if (!t || t._killed) return false;
      if (t._projectId) return t._projectId === projectId;
      return project && project.id === projectId;
    });
  }

  function _ovLocalTaskForProjectGroup(localTasks, gIdx) {
    var best = null;
    (localTasks || []).forEach(function (t) {
      if (!t || Number(t._groupIdx) !== Number(gIdx)) return;
      if (!best || Number(t.createdAt || 0) > Number(best.createdAt || 0)) best = t;
    });
    return best;
  }

  function _ovProjectMedia(proj) {
    var media = { videoUrl: "", thumbnail: "" };
    var sbs = Array.isArray(proj && proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj && proj.videoTasks) ? proj.videoTasks : [];
    for (var i = 0; i < Math.max(sbs.length, vts.length); i++) {
      var sb = sbs[i] || {};
      var vt = vts[i] || {};
      if (!media.videoUrl) media.videoUrl = _ovFirst(vt.url, vt.videoUrl, vt.protectedUrl, sb.videoUrl, sb._originVideoUrl);
      if (!media.thumbnail) media.thumbnail = _ovFirst(vt.coverUrl, vt.videoCoverUrl, sb.videoCoverUrl, sb.coverUrl, sb.rawUrl, sb.imageUrl);
      if (media.videoUrl && media.thumbnail) break;
    }
    return media;
  }

  function _ovProjectPromptSummary(proj) {
    if (!proj) return "";
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var firstPrompt = "";
    for (var i = 0; i < sbs.length; i++) {
      if (sbs[i] && sbs[i].videoPrompt) { firstPrompt = sbs[i].videoPrompt; break; }
    }
    return _ovFirst(proj.oneSentence, proj.description, firstPrompt, proj.scriptDraft, proj.script);
  }

  function _ovProjectDurationSec(proj) {
    var total = 0;
    var seen = false;
    var sbs = Array.isArray(proj && proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj && proj.videoTasks) ? proj.videoTasks : [];
    for (var i = 0; i < Math.max(sbs.length, vts.length); i++) {
      var n = Number(_ovFirst(vts[i] && vts[i].durationSec, vts[i] && vts[i].duration_sec, sbs[i] && sbs[i].videoDurationSec));
      if (Number.isFinite(n) && n > 0) { total += n; seen = true; }
    }
    return seen ? total : 0;
  }

  function _ovProjectTaskFromSummary(summary, detail, options) {
    options = options || {};
    var proj = detail || summary || {};
    var projectId = _ovFirst(proj.id, summary && summary.id);
    var localTasks = _ovLocalTasksForProject(projectId);
    var segmentCount = _ovProjectSegmentCount(proj, localTasks);
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj.videoTasks) ? proj.videoTasks : [];
    var counts = { running: 0, done: 0, failed: 0, pending: 0 };
    var progressTotal = 0;

    for (var i = 0; i < segmentCount; i++) {
      var localTask = _ovLocalTaskForProjectGroup(localTasks, i);
      var serverStatus = _ovStatusFrom(null, vts[i] || {}, sbs[i] || {});
      var status = (serverStatus === "done" || serverStatus === "failed")
        ? serverStatus
        : _ovStatusFrom(localTask, vts[i] || {}, sbs[i] || {});
      if (counts[status] === undefined) status = "pending";
      counts[status]++;
      progressTotal += _ovProgressFor(localTask, status);
    }

    var rawProjectStatus = String(proj.status || summary && summary.status || "").toLowerCase();
    var taskStatus = "pending";
    if (options.loading) taskStatus = "loading";
    else if (counts.running > 0) taskStatus = "running";
    else if (counts.failed > 0) taskStatus = "failed";
    else if (segmentCount > 0 && counts.done === segmentCount) taskStatus = "done";
    else if (rawProjectStatus === "completed" || rawProjectStatus === "done" || rawProjectStatus === "succeeded") taskStatus = "done";
    else if (rawProjectStatus === "failed" || rawProjectStatus === "error") taskStatus = "failed";
    else if (options.detailFailed) taskStatus = "unknown";

    var progress = taskStatus === "done" ? 100 : 0;
    if (taskStatus === "running") {
      progress = segmentCount ? Math.max(8, Math.min(99, Math.round(progressTotal / segmentCount))) : 8;
    }

    var media = _ovProjectMedia(proj);
    var promptText = _ovProjectPromptSummary(proj);
    var durationSec = _ovProjectDurationSec(proj);
    var createdAt = _ovFirst(proj.createdAt, summary && summary.createdAt);
    var updatedAt = _ovFirst(proj.updatedAt, summary && summary.updatedAt, createdAt);
    var title = _ovFirst(proj.name, proj.title, summary && (summary.name || summary.title), "未命名项目");

    return {
      id: "p:" + projectId,
      projectId: projectId,
      projectData: detail || (project && project.id === projectId ? project : null),
      title: title,
      createdAt: createdAt,
      updatedAt: updatedAt,
      createdText: _ovFormatDate(createdAt),
      type: segmentCount ? segmentCount + " 个片段" : "视频项目",
      segmentCount: segmentCount,
      segmentCounts: counts,
      durationSec: durationSec,
      durationText: _ovFormatDuration(durationSec),
      assetCount: _ovProjectAssetCount(proj),
      resolution: "1080 x 1920",
      model: _ovText(_ovCurrentModelLabel(), "--"),
      ratio: "9:16",
      audio: "开启",
      status: taskStatus,
      progress: progress,
      thumbnail: media.thumbnail,
      videoUrl: media.videoUrl,
      prompt: promptText || "",
      promptCount: promptText ? String(promptText).length : 0,
    };
  }

  function _ovPrimeProjectTasksFromSummaries(summaries) {
    summaries = Array.isArray(summaries) ? summaries : [];
    _ovProjectTasks = summaries.map(function (sp) {
      var detail = project && project.id === sp.id ? project : null;
      return _ovProjectTaskFromSummary(sp, detail, { loading: !detail });
    });
  }

  async function _ovFetchProjectDataForOverview(projectId) {
    if (!projectId) return null;
    if (project && project.id === projectId) return _ovHydrateProjectOverviewThumbnail(project);
    try {
      var resp = await fetch("/api/projects/" + encodeURIComponent(projectId), { headers: _getAuthHeaders() });
      _checkAuth(resp);
      if (!resp.ok) return null;
      var data = await resp.json();
      if (data && data.id) await _ovHydrateProjectOverviewThumbnail(data);
      return data && data.id ? data : null;
    } catch (_) {
      return null;
    }
  }

  async function _ovLoadProjectTasks(force) {
    if (_ovProjectTasksLoading) {
      if (force) _ovProjectTasksDirty = true;
      return;
    }
    if (_ovProjectTasksLoaded && !force) return;
    if (force) _ovProjectTasksDirty = false;
    _ovProjectTasksLoading = true;
    var seq = ++_ovProjectTasksSeq;
    try {
      var summaries = await getProjectListFromServer();
      if (!Array.isArray(summaries) || !summaries.length) summaries = _ovProjectTaskSummariesFallback();
      summaries = summaries.map(function (sp) {
        return { id: sp.id, name: sp.name || sp.title, title: sp.title || sp.name, createdAt: sp.createdAt, updatedAt: sp.updatedAt, status: sp.status };
      }).filter(function (sp) { return !!sp.id; });
      try { saveProjectList(summaries.map(function (sp) { return { id: sp.id, name: sp.name, createdAt: sp.createdAt }; })); } catch (_) {}
      _ovPrimeProjectTasksFromSummaries(summaries);
      _ovProjectTasksLoaded = true;
      if (seq === _ovProjectTasksSeq) _ovRenderDashboard();

      var details = await Promise.all(summaries.map(function (sp) {
        if (project && project.id === sp.id) return Promise.resolve(project);
        return _ovFetchProjectDataForOverview(sp.id);
      }));
      if (seq !== _ovProjectTasksSeq) return;
      _ovProjectTasks = summaries.map(function (sp, idx) {
        return _ovProjectTaskFromSummary(sp, details[idx], { detailFailed: !details[idx] });
      });
      _ovProjectTasksLoaded = true;
      _ovRenderDashboard();
    } finally {
      if (seq === _ovProjectTasksSeq) {
        _ovProjectTasksLoading = false;
        if (_ovProjectTasksDirty) {
          _ovProjectTasksDirty = false;
          _ovLoadProjectTasks(true).catch(function (err) {
            console.warn("[overview] reload dirty project tasks failed:", err);
          });
        }
      }
    }
  }

  function _ovEnsureProjectTasks(force) {
    _ovLoadProjectTasks(!!force).catch(function (err) {
      console.warn("[overview] load project tasks failed:", err);
    });
  }

  function _ovInvalidateProjectTasks(refetch) {
    _ovProjectTasksLoaded = false;
    if (refetch !== false) _ovEnsureProjectTasks(true);
  }

  function _ovAssetCount(sb, group) {
    if (sb && Array.isArray(sb._matchedRefs) && sb._matchedRefs.length) return sb._matchedRefs.length;
    if (group && Array.isArray(group.shots)) {
      var names = Object.create(null);
      group.shots.forEach(function (sh) {
        (sh.characters || []).forEach(function (n) { if (n) names["c:" + n] = 1; });
        (sh.props || []).forEach(function (n) { if (n) names["p:" + n] = 1; });
        if (sh.scene) names["s:" + sh.scene] = 1;
      });
      return Object.keys(names).length;
    }
    var assets = project && project.assets;
    if (!assets) return 0;
    return (assets.characters || []).length + (assets.scenes || []).length + (assets.props || []).length;
  }

  function _ovTaskTitle(gIdx, group, sb, persisted) {
    var firstShot = group && group.shots && group.shots[0] ? group.shots[0] : {};
    var visual = _ovFirst(firstShot.title, firstShot.name, firstShot.scene, firstShot.shotType, firstShot.visual, firstShot.description);
    if (visual && visual.length > 20) visual = visual.slice(0, 20) + "...";
    return _ovFirst(
      persisted && (persisted.name || persisted.title),
      sb && (sb.name || sb.title),
      project && project.name ? project.name + " - " + (visual || ("片段 " + (gIdx + 1))) : "",
      "未命名任务"
    );
  }

  function _ovTaskType(group, sb) {
    var firstShot = group && group.shots && group.shots[0] ? group.shots[0] : {};
    return _ovFirst(sb && sb.taskType, firstShot.sceneType, firstShot.shotType, firstShot.type, "视频生成任务");
  }

  function _ovTaskCreatedAt(localTask, persisted, sb) {
    return _ovFirst(
      localTask && localTask.createdAt,
      persisted && (persisted.createdAt || persisted.created_at),
      sb && (sb.videoTaskFinishedAt || sb.updatedAt || sb.createdAt),
      project && (project.updatedAt || project.createdAt)
    );
  }

  function _ovTaskUpdatedAt(localTask, persisted, sb) {
    return _ovFirst(
      localTask && (localTask._doneAt || localTask.updatedAt || localTask.createdAt),
      persisted && (persisted.updatedAt || persisted.updated_at || persisted.createdAt),
      sb && (sb.videoTaskFinishedAt || sb.updatedAt || sb.createdAt),
      project && (project.updatedAt || project.createdAt)
    );
  }

  function _ovBuildTasks() {
    if (!_ovProjectTasksLoaded && !_ovProjectTasksLoading) {
      _ovPrimeProjectTasksFromSummaries(_ovProjectTaskSummariesFallback());
      _ovEnsureProjectTasks(false);
    }
    var tasks = _ovProjectTasks.slice();
    if (project && project.id) {
      var currentId = "p:" + project.id;
      var replaced = false;
      tasks = tasks.map(function (t) {
        if (t.id !== currentId) return t;
        replaced = true;
        return _ovProjectTaskFromSummary({ id: project.id, name: project.name, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, status: project.status }, project);
      });
      if (!replaced) {
        tasks.unshift(_ovProjectTaskFromSummary({ id: project.id, name: project.name, title: project.title, createdAt: project.createdAt, updatedAt: project.updatedAt, status: project.status }, project));
      }
    }
    return tasks;
  }

  function _ovCurrentTasks() {
    var tasks = _ovBuildTasks();
    var query = String(_ovTaskState.query || "").trim().toLowerCase();
    if (_ovTaskState.status !== "all") tasks = tasks.filter(function (t) { return _ovStatusBucket(t.status) === _ovTaskState.status; });
    if (query) {
      tasks = tasks.filter(function (t) {
        return [t.title, t.id, t.type, t.model, t.prompt].some(function (v) {
          return String(v || "").toLowerCase().indexOf(query) >= 0;
        });
      });
    }
    tasks.sort(function (a, b) {
      var aKey = a.createdAt;
      var bKey = b.createdAt;
      var av = new Date(aKey || 0).getTime() || 0;
      var bv = new Date(bKey || 0).getTime() || 0;
      return bv - av;
    });
    return tasks;
  }

  function _ovAllCounts() {
    var all = _ovBuildTasks();
    var c = { all: all.length, running: 0, done: 0, failed: 0, pending: 0 };
    all.forEach(function (t) {
      var bucket = _ovStatusBucket(t.status);
      if (c[bucket] !== undefined) c[bucket]++;
    });
    return c;
  }

  function _ovSetSelected(id, tasks) {
    tasks = tasks || _ovBuildTasks();
    if (id && tasks.some(function (t) { return t.id === id; })) { _ovTaskState.selectedId = id; return; }
    if (_ovTaskState.selectedId && tasks.some(function (t) { return t.id === _ovTaskState.selectedId; })) return;
    _ovTaskState.selectedId = tasks.length ? tasks[0].id : "";
  }

  function _ovRenderTabs(counts) {
    var map = { ovTabAll: counts.all, ovTabRunning: counts.running, ovTabDone: counts.done, ovTabFailed: counts.failed, ovTabPending: counts.pending };
    Object.keys(map).forEach(function (id) { var el = $(id); if (el) el.textContent = map[id]; });
    var tabs = $("ovTaskTabs");
    if (tabs) tabs.querySelectorAll("button[data-ov-status]").forEach(function (btn) { btn.classList.toggle("is-active", btn.dataset.ovStatus === _ovTaskState.status); });
  }

  function _ovTaskCardHtml(t, selected) {
    var statusClass = _ovStatusClass(t.status);
    var thumb = t.thumbnail
      ? _ovThumbnailImgHtml(t.thumbnail)
      : '<div class="vtd-thumb-empty"><span class="material-symbols-outlined">movie_filter</span></div>';
    var retryDisabled = t.projectId ? "" : " disabled";
    var deleteDisabled = t.projectId ? "" : " disabled";
    var renameDisabled = t.projectId ? "" : " disabled";
    var titleText = t.title || "未命名任务";
    var isEditingTitle = _ovTaskState.editingTitleId === t.id;
    var titleHtml = isEditingTitle
      ? '<div class="vtd-title-edit-row is-editing">' +
          '<input type="text" class="vtd-title-input" data-ov-title-input value="' + escapeHtml(titleText) + '" maxlength="200" autocomplete="off" spellcheck="false" aria-label="任务标题">' +
          '<button type="button" class="vtd-title-icon-btn" data-ov-action="rename-save" title="保存标题" aria-label="保存标题"><span class="material-symbols-outlined">check</span></button>' +
          '<button type="button" class="vtd-title-icon-btn" data-ov-action="rename-cancel" title="取消编辑" aria-label="取消编辑"><span class="material-symbols-outlined">close</span></button>' +
        '</div>'
      : '<div class="vtd-title-edit-row">' +
          '<h3>' + escapeHtml(titleText) + '</h3>' +
          '<button type="button" class="vtd-title-edit-btn" data-ov-action="rename" title="编辑标题" aria-label="编辑标题"' + renameDisabled + '><span class="material-symbols-outlined">edit</span></button>' +
        '</div>';
    return '' +
      '<article class="vtd-task-card' + (selected ? ' is-selected' : '') + '" data-task-id="' + escapeHtml(t.id) + '">' +
        '<button type="button" class="vtd-select-dot" data-ov-action="select" aria-label="选择任务"></button>' +
        '<div class="vtd-thumb">' + thumb + '</div>' +
        '<div class="vtd-task-body">' +
          '<div class="vtd-task-title-row">' +
            '<div class="min-w-0">' + titleHtml + '<p>创建时间&nbsp;&nbsp;' + escapeHtml(t.createdText || "--") + '</p></div>' +
          '</div>' +
          '<div class="vtd-task-meta">' +
            '<span><i class="material-symbols-outlined">schedule</i>' + escapeHtml(t.durationText) + '</span>' +
            '<span><i class="material-symbols-outlined">folder</i>素材 ' + escapeHtml(String(t.assetCount || 0)) + '</span>' +
            '<span><i class="material-symbols-outlined">crop_portrait</i>' + escapeHtml(t.resolution) + '</span>' +
            '<span><i class="material-symbols-outlined">memory</i>' + escapeHtml(t.model) + '</span>' +
            '<span><i class="material-symbols-outlined">aspect_ratio</i>比例 ' + escapeHtml(t.ratio) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="vtd-task-status-actions">' +
          '<span class="vtd-type-pill">' + escapeHtml(t.type || "视频生成任务") + '</span>' +
          '<span class="vtd-status ' + statusClass + '">' + escapeHtml(_ovStatusLabel(t)) + '</span>' +
          '<div class="vtd-icon-actions">' +
            (t.status === "failed"
              ? '<button type="button" data-ov-action="retry" title="进入批量页处理失败任务"' + retryDisabled + '><span class="material-symbols-outlined">rule</span></button>'
              : '') +
            '<button type="button" data-ov-action="delete" title="删除项目任务"' + deleteDisabled + '><span class="material-symbols-outlined">delete</span></button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function _ovFindTaskCard(taskId) {
    var list = $("ovTaskList");
    if (!list) return null;
    var cards = list.querySelectorAll(".vtd-task-card");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].dataset.taskId === taskId) return cards[i];
    }
    return null;
  }

  function _ovFocusTitleEditor(taskId) {
    setTimeout(function () {
      var card = _ovFindTaskCard(taskId);
      var input = card && card.querySelector("[data-ov-title-input]");
      if (!input) return;
      input.focus();
      input.select();
    }, 30);
  }

  function _ovStartRenameProjectTask(task) {
    if (!task || !task.projectId) {
      showToast("这个任务暂不支持修改标题", "warn");
      return;
    }
    _ovTaskState.editingTitleId = task.id;
    _ovSelectTask(task.id);
    _ovRenderDashboard();
    _ovFocusTitleEditor(task.id);
  }

  function _ovCancelRenameProjectTask() {
    _ovTaskState.editingTitleId = "";
    _ovRenderDashboard();
  }

  async function _ovSaveRenameProjectTask(task, input) {
    if (!task || !task.projectId) return;
    var nextTitle = String((input && input.value) || "").trim();
    if (!nextTitle) {
      showToast("标题不能为空", "warn");
      if (input) input.focus();
      return;
    }
    if (nextTitle === String(task.title || "").trim()) {
      _ovCancelRenameProjectTask();
      return;
    }
    if (input) input.disabled = true;
    var ok = await _renameProject(task.projectId, nextTitle);
    if (!ok) {
      if (input) {
        input.disabled = false;
        input.focus();
      }
      return;
    }
    _ovTaskState.editingTitleId = "";
    showToast("标题已更新", "success");
    _ovRenderDashboard();
  }

  function _ovRenderTaskList(tasks) {
    var listEl = $("ovTaskList");
    if (!listEl) return;
    var pageSize = Number(_ovTaskState.pageSize) || 10;
    var totalPages = Math.max(1, Math.ceil(tasks.length / pageSize));
    if (_ovTaskState.page > totalPages) _ovTaskState.page = totalPages;
    if (_ovTaskState.page < 1) _ovTaskState.page = 1;
    var start = (_ovTaskState.page - 1) * pageSize;
    var pageItems = tasks.slice(start, start + pageSize);
    if (pageItems.length && !pageItems.some(function (t) { return t.id === _ovTaskState.selectedId; })) {
      _ovTaskState.selectedId = pageItems[0].id;
    }
    if (!pageItems.length) {
      listEl.innerHTML = '<div class="vtd-empty-state"><span class="material-symbols-outlined">movie</span><strong>暂无任务</strong><p>没有匹配当前筛选条件的视频任务。</p></div>';
    } else {
      listEl.innerHTML = pageItems.map(function (t) { return _ovTaskCardHtml(t, t.id === _ovTaskState.selectedId); }).join("");
    }
    var totalText = $("ovTaskTotalText");
    if (totalText) totalText.textContent = "共 " + tasks.length + " 条";
    var pageNums = $("ovTaskPageNumbers");
    if (pageNums) {
      var html = _ovPaginationItems(totalPages, _ovTaskState.page).map(function (item) {
        if (typeof item !== "number") return '<span aria-hidden="true">...</span>';
        return '<button type="button" class="' + (item === _ovTaskState.page ? 'is-active' : '') + '" data-ov-page="' + item + '">' + item + '</button>';
      }).join("");
      pageNums.innerHTML = html;
    }
    var prev = $("ovTaskPrevPage"), next = $("ovTaskNextPage"), size = $("ovTaskPageSize");
    if (prev) prev.disabled = _ovTaskState.page <= 1;
    if (next) next.disabled = _ovTaskState.page >= totalPages;
    if (size) size.value = String(pageSize);
  }

  function _ovWorkflowData(targetProject) {
    var proj = targetProject || project;
    if (!proj) return [];
    var groups = [];
    if (proj === project) {
      try { groups = getStoryboardGroups() || []; } catch (_) { groups = []; }
    }
    var assetCount = _ovProjectAssetCount(proj);
    var sbTotal = Math.max(groups.length, Array.isArray(proj.storyboards) ? proj.storyboards.length : 0, Array.isArray(proj.videoTasks) ? proj.videoTasks.length : 0);
    var sbDone = proj.storyboards ? proj.storyboards.filter(function (s) { return s && s.imageUrl; }).length : 0;
    var vpDone = proj.storyboards ? proj.storyboards.filter(function (s) { return s && s.videoPrompt; }).length : 0;
    var videoDone = 0;
    if (Array.isArray(proj.storyboards)) videoDone = proj.storyboards.filter(function (s) { return s && s.videoUrl; }).length;
    if (Array.isArray(proj.videoTasks)) {
      videoDone = Math.max(videoDone, proj.videoTasks.filter(function (t) { return t && (t.url || t.videoUrl || t.protectedUrl || String(t.status || "").toLowerCase() === "done"); }).length);
    }
    return [
      { label: "脚本生成", value: proj.script ? "已生成" : "未开始", done: !!proj.scriptApproved || !!proj.script },
      { label: "资产库", value: proj.assetsApproved ? "已确认（" + assetCount + " 项）" : (assetCount ? assetCount + " 项已分析" : "未开始"), done: !!proj.assetsApproved },
      { label: "镜头设计", value: proj.shots && proj.shots.length ? proj.shots.length + " 个镜头" : "未开始", done: !!proj.shotsApproved },
      { label: "分镜图生成", value: proj.imagesApproved ? "已确认" : (sbDone ? "分镜板 " + sbDone + "/" + sbTotal : "未开始"), done: !!proj.imagesApproved },
      { label: "视频提示词", value: proj.videoPromptsApproved ? "已确认" : (vpDone ? vpDone + "/" + sbTotal + " 条" : "未开始"), done: !!proj.videoPromptsApproved },
      { label: "批量视频生成", value: videoDone ? videoDone + "/" + sbTotal + " 个片段" : (proj.videoPromptsApproved ? "就绪（" + sbTotal + " 个片段）" : "待处理"), done: sbTotal > 0 && videoDone >= sbTotal, ready: !!proj.videoPromptsApproved },
    ];
  }

  function _ovRenderDetail(allTasks) {
    allTasks = allTasks || _ovBuildTasks();
    var task = allTasks.find(function (t) { return t.id === _ovTaskState.selectedId; }) || allTasks[0] || null;
    _ovSetSelected(task && task.id, allTasks);
    var preview = $("ovPreviewWrap"), param = $("ovParamList"), flow = $("ovWorkflowStatus"), summary = $("ovPromptSummary");
    var dl = $("ovDownloadVideoBtn");
    if (!task) {
      if (preview) preview.innerHTML = '<div class="vtd-preview-empty"><span class="material-symbols-outlined">movie_filter</span><p>未选择任务</p></div>';
      if (param) param.innerHTML = "";
      if (flow) flow.innerHTML = "";
      if (summary) summary.textContent = "暂无内容摘要";
      if (dl) dl.disabled = true;
      return;
    }
    if (preview) {
      if (task.videoUrl) {
        preview.innerHTML = '<video src="' + escapeHtml(task.videoUrl) + '" poster="' + escapeHtml(_ovThumbnailPosterUrl(task.thumbnail)) + '" controls playsinline preload="metadata"></video><button type="button" class="vtd-preview-play" data-ov-action="preview-play" title="播放"><span class="material-symbols-outlined">play_arrow</span></button>';
      } else if (task.thumbnail) {
        preview.innerHTML = _ovThumbnailImgHtml(task.thumbnail) + '<div class="vtd-preview-unavailable"><span class="material-symbols-outlined">videocam_off</span><p>视频未生成</p></div>';
      } else {
        preview.innerHTML = '<div class="vtd-preview-empty"><span class="material-symbols-outlined">movie_filter</span><p>暂无缩略图</p></div>';
      }
    }
    if (param) {
      var rows = [["片段数", task.segmentCount ? task.segmentCount + " 个" : "--"], ["总时长", task.durationText], ["比例", "9:16 竖版"], ["内容字数", task.promptCount ? task.promptCount + " 字" : "--"]];
      param.innerHTML = rows.map(function (r) { return '<div class="vtd-param-row"><span>' + escapeHtml(r[0]) + '</span><strong>' + escapeHtml(r[1]) + '</strong></div>'; }).join("");
    }
    if (flow) {
      flow.innerHTML = _ovWorkflowData(task.projectData || (project && project.id === task.projectId ? project : null)).map(function (s, idx) {
        return '<div class="vtd-workflow-item' + (s.done ? ' is-done' : s.ready ? ' is-ready' : '') + '"><span class="vtd-workflow-num">' + (idx + 1) + '</span><div><strong>' + escapeHtml(s.label) + '</strong><p>' + escapeHtml(s.value) + '</p></div>' + (s.done ? '<span class="material-symbols-outlined">check</span>' : s.ready ? '<em>就绪</em>' : '<em>待处理</em>') + '</div>';
      }).join("");
    }
    if (summary) {
      var p = String(task.prompt || "").trim();
      summary.textContent = p ? (p.length > 120 ? p.slice(0, 120) + "..." : p) : "暂无内容摘要";
    }
    if (dl) { dl.disabled = !task.videoUrl; dl.dataset.taskId = task.id; }
  }

  function _ovRenderStats(counts) {
    var grid = $("ovStatsGrid");
    if (!grid) return;
    var items = [
      { key: "all", icon: "grid_view", label: "全部任务", value: counts.all },
      { key: "running", icon: "timelapse", label: "生成中", value: counts.running },
      { key: "done", icon: "task_alt", label: "已完成", value: counts.done },
      { key: "failed", icon: "error", label: "失败", value: counts.failed },
      { key: "pending", icon: "pending_actions", label: "待处理", value: counts.pending },
    ];
    grid.innerHTML = items.map(function (it) {
      var active = _ovTaskState.status === it.key;
      return '<button type="button" class="vtd-stat-card is-' + it.key + (active ? ' is-active' : '') + '" data-ov-stat-filter="' + it.key + '" aria-pressed="' + (active ? 'true' : 'false') + '"><span class="material-symbols-outlined">' + it.icon + '</span><strong>' + it.value + '</strong><p>' + it.label + '</p></button>';
    }).join("");
  }

  function _ovRenderTrend(tasks) {
    var el = $("ovTrendChart");
    if (!el) return;
    var days = [], now = new Date();
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      days.push({ d: d, key: d.toISOString().slice(0, 10), label: (d.getMonth() + 1) + "/" + d.getDate(), count: 0 });
    }
    tasks.forEach(function (t) {
      var d = t.createdAt ? new Date(t.createdAt) : null;
      if (!d || isNaN(d.getTime())) return;
      var key = d.toISOString().slice(0, 10);
      var hit = days.find(function (x) { return x.key === key; });
      if (hit) hit.count++;
    });
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }));
    if (!max) {
      el.innerHTML = '<div class="vtd-empty-state compact"><span class="material-symbols-outlined">show_chart</span><p>暂无最近 7 天生成数据</p></div>';
      return;
    }
    var width = 560, height = 170, padX = 32, padY = 22;
    var points = days.map(function (d, idx) {
      var x = padX + idx * ((width - padX * 2) / 6);
      var y = height - padY - (d.count / max) * (height - padY * 2);
      return { x: x, y: y, d: d };
    });
    var poly = points.map(function (p) { return p.x + "," + p.y; }).join(" ");
    el.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="近 7 天生成趋势"><g class="vtd-trend-grid"><line x1="28" y1="24" x2="' + (width - 24) + '" y2="24"></line><line x1="28" y1="82" x2="' + (width - 24) + '" y2="82"></line><line x1="28" y1="140" x2="' + (width - 24) + '" y2="140"></line></g><polyline points="' + poly + '" fill="none" stroke="#4b6695" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>' + points.map(function (p) { return '<circle cx="' + p.x + '" cy="' + p.y + '" r="4.5"></circle>'; }).join("") + points.map(function (p) { return '<text x="' + p.x + '" y="162" text-anchor="middle">' + escapeHtml(p.d.label) + '</text>'; }).join("") + '</svg>';
  }

  function _ovRenderActivity(tasks) {
    var el = $("ovActivityList");
    if (!el) return;
    var items = tasks.slice().sort(function (a, b) { return (new Date(b.updatedAt || b.createdAt || 0).getTime() || 0) - (new Date(a.updatedAt || a.createdAt || 0).getTime() || 0); }).slice(0, 3);
    if (!items.length) {
      el.innerHTML = '<div class="vtd-empty-state compact"><span class="material-symbols-outlined">notifications</span><p>暂无最近动态</p></div>';
      return;
    }
    el.innerHTML = items.map(function (t) {
      var icon = t.status === "done" ? "check" : t.status === "failed" ? "priority_high" : t.status === "running" ? "sync" : "schedule";
      return '<button type="button" class="vtd-activity-item" data-task-id="' + escapeHtml(t.id) + '"><span class="vtd-activity-dot ' + _ovStatusClass(t.status) + '"><i class="material-symbols-outlined">' + icon + '</i></span><span><strong>' + escapeHtml(t.title) + '</strong><em>' + escapeHtml(_ovStatusLabel(t)) + ' · ' + escapeHtml(_ovShortTime(t.updatedAt || t.createdAt)) + '</em></span><i class="material-symbols-outlined">chevron_right</i></button>';
    }).join("");
  }

  function _ovRenderDashboard() {
    _ovResetSearchInput();
    var allTasks = _ovBuildTasks();
    var filtered = _ovCurrentTasks();
    _ovSetSelected(_ovTaskState.selectedId, filtered.length ? filtered : allTasks);
    var counts = _ovAllCounts();
    _ovRenderTabs(counts);
    _ovSyncToolbarState();
    _ovRenderTaskList(filtered);
    _ovRenderDetail(allTasks);
    _ovRenderStats(counts);
    _ovRenderTrend(allTasks);
    _ovRenderActivity(allTasks);
    _ovRefreshThumbnailImages($("overviewContent") || document);
  }

  function refreshOverview() {
    var empty = $("overviewEmpty");
    var content = $("overviewContent");
    var hasKnownTasks = _ovProjectTasks.length || getProjectList().length;
    if (!project && !hasKnownTasks) {
      _ovEnsureProjectTasks(false);
      empty.hidden = false;
      if (content) content.hidden = true;
      return;
    }
    _ovEnsureProjectTasks(false);
    empty.hidden = true;
    content.hidden = false;
    var projNameEl = $("ovProjName");
    if (projNameEl) {
      var total = _ovProjectTasks.length || getProjectList().length || (project ? 1 : 0);
      projNameEl.textContent = total ? "全部项目 · " + total + " 个" : "全部项目";
      projNameEl.title = "按项目聚合的视频任务列表";
    }
    _ovRenderDashboard();
  }

  function _ovTaskById(id) {
    var tasks = _ovBuildTasks();
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  function _ovSelectTask(id) {
    _ovTaskState.selectedId = id || "";
    _ovRenderDashboard();
  }

  function _ovDefaultProjectTaskName() {
    var d = new Date();
    var mm = String(d.getMinutes());
    if (mm.length < 2) mm = "0" + mm;
    return "项目 " + (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + mm;
  }

  async function _ovCreateProjectTask(btn) {
    if (_ovProjectTaskCreating) return;
    _ovProjectTaskCreating = true;
    if (btn) btn.disabled = true;
    try {
      var ok = await createNewProject(_ovDefaultProjectTaskName());
      if (ok !== false) {
        refreshOverview();
        switchPage("script");
      }
    } catch (e) {
      console.error("[OverviewNewTask]", e);
      showToast("新建任务失败", "error");
    } finally {
      _ovProjectTaskCreating = false;
      if (btn) btn.disabled = false;
    }
  }

  function _ovOpenVideo(task) {
    if (!task || !task.videoUrl) {
      showToast("视频尚未生成", "warn");
      return;
    }
    try {
      window.open(task.videoUrl, "_blank", "noopener,noreferrer");
    } catch (_) {
      showToast("浏览器阻止了新窗口，请允许弹窗后重试", "warn");
    }
  }

  async function _ovRetryTask(task) {
    if (!task || !task.projectId || _ovProjectTaskNavigating) return;
    _ovProjectTaskNavigating = true;
    try {
      if (!project || project.id !== task.projectId) {
        await switchToProject(task.projectId);
      }
      if (!project || project.id !== task.projectId) {
        showToast("无法打开该项目，请刷新后重试", "error");
        return;
      }
      switchPage("batch");
    } catch (e) {
      showToast((e && e.message) || "打开失败任务处理页失败", "error");
    } finally {
      _ovProjectTaskNavigating = false;
    }
  }

  async function _ovDeleteProjectTask(task) {
    if (!task || !task.projectId || _ovProjectTaskDeleting) return;
    var title = task.title || "未命名任务";
    var ok = await showConfirm(
      "删除项目任务",
      "确定删除「" + title + "」？\n这会删除该项目任务及其关联素材、生成视频、上传素材、导出文件和批量记录，操作不可恢复。",
      "删除",
      "取消"
    );
    if (!ok) return;

    var projectId = task.projectId;
    var previousTasks = _ovProjectTasks.slice();
    _ovProjectTaskDeleting = true;
    try {
      _ovProjectTasks = _ovProjectTasks.filter(function (item) { return item && item.projectId !== projectId; });
      if (_ovTaskState.selectedId === task.id) _ovTaskState.selectedId = "";
      _ovProjectTasksLoaded = true;
      _ovRenderDashboard();

      var resp = await fetch("/api/projects/" + encodeURIComponent(projectId), {
        method: "DELETE",
        headers: _getAuthHeaders(),
      });
      if (!resp || !resp.ok) {
        var msg = "删除失败";
        try {
          var body = await resp.json();
          msg = body && (body.error || body.message) ? (body.error || body.message) : msg;
        } catch (_) {}
        throw new Error(msg);
      }

      var list = getProjectList().filter(function (p) { return p && p.id !== projectId; });
      saveProjectList(list);
      localStorage.removeItem(_uPrefix + "sw_proj_" + projectId);

      if (project && project.id === projectId) {
        if (list.length > 0) {
          await switchToProject(list[0].id);
        } else {
          project = null;
          syncEditProject(null);
          syncTasksProject(null);
          syncVideoTasksProject(null);
          syncVideoPromptsProject(null);
          syncShotsProject(null);
          syncStoryboardProject(null);
          syncScriptProject(null);
          syncAssetsProject(null);
          localStorage.removeItem(STORAGE_PROJECT);
          refreshOverview();
        }
      }

      _ovInvalidateProjectTasks(true);
      renderProjectList();
      refreshOverview();
      showToast("已删除视频任务", "success");
    } catch (e) {
      _ovProjectTasks = previousTasks;
      _ovProjectTasksLoaded = true;
      _ovRenderDashboard();
      _ovInvalidateProjectTasks(true);
      showToast((e && e.message) || "删除视频任务失败", "error");
    } finally {
      _ovProjectTaskDeleting = false;
    }
  }

  function _wireOverviewDashboardOnce() {
    if (_overviewDashboardBound) return;
    _overviewDashboardBound = true;

    var tabs = $("ovTaskTabs");
    if (tabs) tabs.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ov-status]");
      if (!btn) return;
      _ovTaskState.status = btn.dataset.ovStatus || "all";
      _ovTaskState.page = 1;
      _ovRenderDashboard();
    });

    var search = $("ovTaskSearch");
    if (search) {
      _ovClearSearchInput(search);
      _ovScheduleSearchAutofillGuard(search);
      search.addEventListener("beforeinput", function (e) {
        if (_ovIsCredentialReplacementInput(e) || (!_ovIsTrustedUserEvent(e) && !_ovHasActiveSearchIntent(search))) {
          e.preventDefault();
          _ovDeferSearchReset(search);
          return;
        }
        _ovMarkSearchUserInput();
      }, true);
      search.addEventListener("pointerdown", function (e) { if (_ovIsTrustedUserEvent(e)) _ovMarkSearchFocus(); }, true);
      search.addEventListener("click", function () { _ovMarkSearchFocus(); }, true);
      search.addEventListener("keydown", function (e) { if (_ovIsTrustedUserEvent(e)) _ovMarkSearchUserInput(); }, true);
      search.addEventListener("paste", function (e) { if (_ovIsTrustedUserEvent(e)) _ovMarkSearchUserInput(); }, true);
      search.addEventListener("drop", function (e) { if (_ovIsTrustedUserEvent(e)) _ovMarkSearchUserInput(); }, true);
      search.addEventListener("compositionstart", function (e) {
        if (_ovIsTrustedUserEvent(e) || _ovHasActiveSearchIntent(search)) {
          _ovMarkSearchUserInput();
          _ovSearchComposing = true;
        }
      }, true);
      search.addEventListener("focus", function () {
        _ovMarkSearchFocus();
        if (!_ovTaskState.query && !_ovIsRecentSearchUserInput()) {
          _ovClearSearchInput(search);
          _ovRenderDashboard();
        } else {
          _ovResetSearchInput(search);
        }
      });
      search.addEventListener("blur", function () {
        _ovSearchComposing = false;
      });
      search.addEventListener("change", function () { _ovResetSearchInput(search); });
      search.addEventListener("input", function (e) {
        if (!_ovAllowSearchInputEvent(e, search)) {
          _ovDeferSearchReset(search);
          return;
        }
        _ovMarkSearchUserInput();
        _ovApplySearchInput(search);
      });
      search.addEventListener("compositionend", function (e) {
        _ovSearchComposing = false;
        if (!_ovIsTrustedUserEvent(e) && !_ovHasActiveSearchIntent(search)) {
          _ovDeferSearchReset(search);
          return;
        }
        _ovMarkSearchUserInput();
        _ovApplySearchInput(search);
      });
    }

    var recharge = $("ovBillingRechargeBtn");
    if (recharge) recharge.addEventListener("click", function (e) {
      e.preventDefault();
      switchPage("billing", { user: true });
    });

    var stats = $("ovStatsGrid");
    if (stats) stats.addEventListener("click", function (e) {
      var card = e.target.closest("[data-ov-stat-filter]");
      if (!card || !stats.contains(card)) return;
      _ovTaskState.status = card.dataset.ovStatFilter || "all";
      _ovTaskState.page = 1;
      _ovRenderDashboard();
    });

    var newTask = $("ovNewTaskBtn");
    if (newTask) newTask.addEventListener("click", function () {
      _ovCreateProjectTask(newTask);
    });

    var list = $("ovTaskList");
    if (list) list.addEventListener("click", function (e) {
      if (e.target.closest("[data-ov-title-input]")) return;
      var card = e.target.closest(".vtd-task-card");
      if (!card) return;
      var id = card.dataset.taskId;
      var actionBtn = e.target.closest("[data-ov-action]");
      var action = actionBtn ? actionBtn.dataset.ovAction : "select";
      var task = _ovTaskById(id);
      if (!task) return;
      if (action === "rename") {
        e.preventDefault();
        _ovStartRenameProjectTask(task);
        return;
      }
      if (action === "rename-save") {
        e.preventDefault();
        _ovSaveRenameProjectTask(task, card.querySelector("[data-ov-title-input]"));
        return;
      }
      if (action === "rename-cancel") {
        e.preventDefault();
        _ovCancelRenameProjectTask();
        return;
      }
      if (action === "download") {
        e.preventDefault();
        _ovOpenVideo(task);
        return;
      }
      if (action === "retry") {
        e.preventDefault();
        _ovRetryTask(task);
        return;
      }
      if (action === "delete") {
        e.preventDefault();
        _ovDeleteProjectTask(task);
        return;
      }
      if (action === "details") {
        e.preventDefault();
        _ovSelectTask(id);
        var panel = document.querySelector(".vtd-detail-panel");
        if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      _ovSelectTask(id);
      if (action === "play" && task.videoUrl) {
        setTimeout(function () {
          var video = $("ovPreviewWrap") && $("ovPreviewWrap").querySelector("video");
          if (video) video.play().catch(function () {});
        }, 40);
      }
    });
    if (list) list.addEventListener("keydown", function (e) {
      var input = e.target.closest("[data-ov-title-input]");
      if (!input || e.isComposing) return;
      var card = input.closest(".vtd-task-card");
      var task = card && _ovTaskById(card.dataset.taskId);
      if (!task) return;
      if (e.key === "Enter") {
        e.preventDefault();
        _ovSaveRenameProjectTask(task, input);
      } else if (e.key === "Escape") {
        e.preventDefault();
        _ovCancelRenameProjectTask();
      }
    });

    var pageNums = $("ovTaskPageNumbers");
    if (pageNums) pageNums.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-ov-page]");
      if (!btn) return;
      _ovTaskState.page = Number(btn.dataset.ovPage) || 1;
      _ovRenderDashboard();
    });
    var prev = $("ovTaskPrevPage");
    if (prev) prev.addEventListener("click", function () {
      _ovTaskState.page = Math.max(1, _ovTaskState.page - 1);
      _ovRenderDashboard();
    });
    var next = $("ovTaskNextPage");
    if (next) next.addEventListener("click", function () {
      _ovTaskState.page = _ovTaskState.page + 1;
      _ovRenderDashboard();
    });
    var pageSize = $("ovTaskPageSize");
    if (pageSize) pageSize.addEventListener("change", function () {
      _ovTaskState.pageSize = Number(pageSize.value) || 10;
      _ovTaskState.page = 1;
      _ovRenderDashboard();
    });

    var activity = $("ovActivityList");
    if (activity) activity.addEventListener("click", function (e) {
      var item = e.target.closest("[data-task-id]");
      if (item) {
        _ovTaskState.status = "all";
        _ovTaskState.page = 1;
        _ovSelectTask(item.dataset.taskId);
      }
    });

    var dl = $("ovDownloadVideoBtn");
    if (dl) dl.addEventListener("click", function () {
      _ovOpenVideo(_ovTaskById(dl.dataset.taskId));
    });

    var preview = $("ovPreviewWrap");
    document.addEventListener("error", function (e) {
      var img = e.target && e.target.closest && e.target.closest("img[data-ov-thumb-src]");
      if (!img) return;
      _ovEnsureThumbnailImage(img, true).catch(function (err) {
        console.warn("[overview] retry thumbnail failed:", err);
      });
    }, true);
    if (preview) preview.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-ov-action='preview-play']");
      if (!btn) return;
      var video = preview.querySelector("video");
      if (video) {
        btn.hidden = true;
        video.play().catch(function () { btn.hidden = false; });
      }
    });
  }

  /* ── 项目名 inline 编辑 ── */
  var _projNameEditBound = false;
  function _bindProjNameEdit() {
    var el = $("ovProjName");
    if (!el) return;
    _projNameEditBound = true;
    el.style.cursor = "default";
  }

  /* ================================================================
     PROJECT STYLE — project-level visual style control
     ================================================================ */
  var _stylePageBound = false;
  var _stylePageDirty = false;
  var _STYLE_PALETTE_HEX = {
    "雾灰": "#bfc9ca",
    "霜白": "#f3f6fb",
    "松墨": "#263934",
    "石棕": "#96653f",
    "朱砂": "#cf4934",
    "冷灰": "#b9c4c9",
    "冷白": "#f5f7fb",
    "墨黑": "#111c1a",
    "靛蓝": "#2f456b",
    "血红": "#a93532",
  };

  function _styleShortText(text, fallback, maxLen) {
    var s = String(text || fallback || "").trim();
    if (!s) return "";
    maxLen = maxLen || 42;
    return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
  }

  function _stylePaletteItemsFromValue(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) {
        if (typeof item === "string") return { name: item.trim(), hex: _STYLE_PALETTE_HEX[item.trim()] || "#cfd8dc" };
        var name = String((item && (item.name || item.label || item.color)) || "").trim();
        var hex = String((item && (item.hex || item.value)) || "").trim();
        return { name: name || hex || "色彩", hex: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex : (_STYLE_PALETTE_HEX[name] || "#cfd8dc") };
      }).filter(function (item) { return item.name || item.hex; }).slice(0, 5);
    }
    return String(value || "")
      .split(/[,，、/]/)
      .map(function (name) {
        name = name.trim();
        if (!name) return null;
        return { name: name, hex: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name) ? name : (_STYLE_PALETTE_HEX[name] || "#cfd8dc") };
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  function _stylePaletteText(items) {
    var arr = _stylePaletteItemsFromValue(items);
    return arr.map(function (item) { return item.name || item.hex; }).join(", ");
  }

  function _styleSetSaveState(text, saved) {
    var el = $("styleSaveState");
    if (!el) return;
    el.textContent = text || "未保存";
    el.classList.toggle("is-saved", !!saved);
  }

  function _styleReadValuesFromForm() {
    var intensityEl = $("styleIntensityInput");
    return {
      visualStyle: (($("styleVisualInput") || {}).value || "").trim(),
      mood: (($("styleMoodInput") || {}).value || "").trim(),
      cameraStyle: (($("styleCameraInput") || {}).value || "").trim(),
      negativePrompt: (($("styleNegativeInput") || {}).value || "").trim(),
      colorPalette: _stylePaletteItemsFromValue((($("stylePaletteInput") || {}).value || "").trim()),
      styleIntensity: Math.max(0, Math.min(100, Number((intensityEl && intensityEl.value) || 70))),
    };
  }

  function _styleUpdatePalettePreview(items) {
    var preview = $("stylePalettePreview");
    if (!preview) return;
    var palette = _stylePaletteItemsFromValue(items);
    if (!palette.length) palette = _stylePaletteItemsFromValue("雾灰, 霜白, 松墨, 石棕, 朱砂");
    preview.innerHTML = palette.map(function (item) {
      return '<div class="style-palette-chip">' +
        '<span style="background:' + escapeHtml(item.hex || "#cfd8dc") + '"></span>' +
        '<strong>' + escapeHtml(item.name || item.hex || "色彩") + '</strong>' +
      '</div>';
    }).join("");
  }

  function _styleUpdateHero(values) {
    values = values || _styleReadValuesFromForm();
    var title = $("styleHeroTitle");
    var desc = $("styleHeroDesc");
    var chips = $("styleHeroChips");
    var intensity = $("styleIntensityValue");
    if (title) title.textContent = _styleShortText(values.visualStyle, "等待风格设定", 34);
    if (desc) desc.textContent = _styleShortText(values.mood || values.cameraStyle || values.negativePrompt, "保存或重新提取风格后，这里会汇总当前项目的整体视频气质。", 86);
    if (intensity) intensity.textContent = String(values.styleIntensity || 70) + "%";
    if (chips) {
      var chipVals = [
        values.cameraStyle ? "镜头锁定" : "",
        values.mood ? "情绪基调" : "",
        values.negativePrompt ? "负向约束" : "",
        "强度 " + String(values.styleIntensity || 70) + "%",
      ].filter(Boolean);
      chips.innerHTML = chipVals.map(function (c) { return '<span>' + escapeHtml(c) + '</span>'; }).join("");
    }
    _styleUpdatePalettePreview(values.colorPalette);
  }

  function refreshStylePage() {
    var page = $("pageStyle");
    if (!page) return;
    var sb = (project && project.styleBible && typeof project.styleBible === "object") ? project.styleBible : {};
    var profile = getActiveCreatorProfile ? getActiveCreatorProfile() : {};
    var values = {
      visualStyle: sb.visualStyle || sb.vision || profile.visualStyle || "",
      mood: sb.mood || sb.tone || profile.moodStyle || profile.moodTone || "",
      cameraStyle: sb.cameraStyle || profile.cameraStyle || profile.cameraPrefs || "",
      negativePrompt: sb.negativePrompt || sb.videoNegativePrompt || "",
      colorPalette: _stylePaletteItemsFromValue(sb.colorPalette && _stylePaletteItemsFromValue(sb.colorPalette).length ? sb.colorPalette : "雾灰, 霜白, 松墨, 石棕, 朱砂"),
      styleIntensity: Number(sb.styleIntensity || sb.intensity || 70),
    };
    var projectTitle = project && (project.name || project.title);
    var kicker = $("styleProjectKicker");
    if (kicker) kicker.textContent = (projectTitle ? projectTitle : "未选择项目") + " · PROJECT STYLE";
    var fill = function (id, value) {
      var el = $(id);
      if (el) el.value = value || "";
    };
    fill("styleVisualInput", values.visualStyle);
    fill("styleMoodInput", values.mood);
    fill("styleCameraInput", values.cameraStyle);
    fill("styleNegativeInput", values.negativePrompt);
    fill("stylePaletteInput", _stylePaletteText(values.colorPalette));
    var intensity = $("styleIntensityInput");
    if (intensity) intensity.value = String(values.styleIntensity || 70);
    _stylePageDirty = false;
    _styleSetSaveState(project && project.styleBible ? "已同步" : "待设置", !!(project && project.styleBible));
    _styleUpdateHero(values);
  }

	  function _saveStylePage() {
	    if (!project) {
	      showToast("请先创建或选择项目", "warn");
	      return false;
	    }
    var values = _styleReadValuesFromForm();
    var sb = Object.assign({}, project.styleBible || {});
    sb.visualStyle = values.visualStyle;
    sb.mood = values.mood;
    sb.cameraStyle = values.cameraStyle;
    sb.negativePrompt = values.negativePrompt;
    sb.colorPalette = values.colorPalette;
    sb.styleIntensity = values.styleIntensity;
    sb.updatedAt = new Date().toISOString();
    project.styleBible = sb;
	    project.styleBibleStatus = "ready";
	    project.styleBibleError = "";
	    project.styleBibleGeneratedAt = project.styleBibleGeneratedAt || sb.updatedAt;
	    _markDownstreamStale("style_bible", {});
	    saveProject();
    _stylePageDirty = false;
    _styleSetSaveState("已保存", true);
    _styleUpdateHero(values);
	    if (typeof renderStyleBible === "function") renderStyleBible(project.styleBible);
	    showToast("视频整体风格已保存", "success");
	    return true;
	  }

	  function _confirmStyleAndContinue() {
	    if (!_saveStylePage()) return;
	    switchPage("assets");
	    setTimeout(function () {
	      if (project && !project.assets) extractAssets();
	    }, 300);
	  }

  async function _extractStyleFromStylePage() {
    if (!project || !project.script) {
      showToast("需要先有剧本，才能重新提取风格", "warn");
      return;
    }
    var btn = $("btnStyleExtract");
    if (btn) btn.disabled = true;
    try {
      await extractStyleBible();
      refreshStylePage();
      showToast("已从剧本重新提取风格", "success");
    } catch (e) {
      showToast("重新提取失败: " + ((e && e.message) || e), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireStylePageOnce() {
    if (_stylePageBound) return;
    _stylePageBound = true;
	    var saveBtn = $("btnStyleSave");
	    if (saveBtn) saveBtn.addEventListener("click", _saveStylePage);
	    var confirmBtn = $("btnStyleConfirm");
	    if (confirmBtn) confirmBtn.addEventListener("click", _confirmStyleAndContinue);
	    var extractBtn = $("btnStyleExtract");
    if (extractBtn) extractBtn.addEventListener("click", _extractStyleFromStylePage);
    ["styleVisualInput", "styleMoodInput", "styleCameraInput", "styleNegativeInput", "stylePaletteInput", "styleIntensityInput"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener("input", function () {
        _stylePageDirty = true;
        _styleSetSaveState("未保存", false);
        _styleUpdateHero(_styleReadValuesFromForm());
      });
    });
  }

  /* ================================================================
     CREATOR PROFILE — chat-based preference collection
     ================================================================ */
  var _profileChatHistory = [];
  var _profileChatSending = false;
  var _globalCreatorProfile = {};

  function _profilePick(p, keys) {
    p = p || {};
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  function _normalizeCreatorProfileClient(profile) {
    var p = profile || {};
    var camera = _profilePick(p, ["cameraStyle", "cameraPrefs"]);
    var mood = _profilePick(p, ["moodStyle", "moodTone"]);
    var updatedAt = _profilePick(p, ["updatedAt", "lastUpdated"]);
    return Object.assign({}, p, {
      visualStyle: _profilePick(p, ["visualStyle"]),
      narrativeStyle: _profilePick(p, ["narrativeStyle"]),
      cameraStyle: camera,
      cameraPrefs: camera,
      moodStyle: mood,
      moodTone: mood,
      promptHabits: _profilePick(p, ["promptHabits"]),
      duration: _profilePick(p, ["duration"]),
      freeText: _profilePick(p, ["freeText"]),
      updatedAt: updatedAt,
      lastUpdated: updatedAt,
      rawDialog: Array.isArray(p.rawDialog) ? p.rawDialog : [],
    });
  }

  function _hasCreatorProfileContent(profile) {
    var p = _normalizeCreatorProfileClient(profile);
    return ["visualStyle", "narrativeStyle", "cameraStyle", "moodStyle", "promptHabits", "duration", "freeText"].some(function (key) {
      return !!(p[key] || "").trim();
    });
  }

  function _compactCreatorProfileForApi(profile) {
    var p = _normalizeCreatorProfileClient(profile);
    if (!_hasCreatorProfileContent(p)) return null;
    return {
      visualStyle: p.visualStyle,
      narrativeStyle: p.narrativeStyle,
      cameraStyle: p.cameraStyle,
      cameraPrefs: p.cameraPrefs,
      moodStyle: p.moodStyle,
      moodTone: p.moodTone,
      promptHabits: p.promptHabits,
      duration: p.duration,
      freeText: p.freeText,
    };
  }
  
  function getActiveCreatorProfile() {
    if (project && project.creatorProfileOverride) {
      var ov = _normalizeCreatorProfileClient(project.creatorProfileOverride);
      if (_hasCreatorProfileContent(ov)) return ov;
    }
    return _normalizeCreatorProfileClient(_globalCreatorProfile || {});
  }
  
  function formatCreatorProfileForApi() {
    return _compactCreatorProfileForApi(getActiveCreatorProfile());
  }
  
  async function loadCreatorProfile() {
    try {
      var resp = await fetch("/api/profile", { headers: _getAuthHeaders() });
      if (resp.ok) {
        _globalCreatorProfile = _normalizeCreatorProfileClient(await resp.json());
        _profileChatHistory = Array.isArray(_globalCreatorProfile.rawDialog) ? _globalCreatorProfile.rawDialog.slice() : [];
        _renderProfileCard();
      }
    } catch (e) { console.warn("[Profile] load failed:", e); }
  }
  
  function _renderProfileCard() {
    var container = $("profileCardContent");
    if (!container) return;
    var p = _normalizeCreatorProfileClient(_globalCreatorProfile || {});
    var fields = [
      { key: "visualStyle", label: "视觉风格", labelEn: "Visual Style" },
      { key: "narrativeStyle", label: "叙事风格", labelEn: "Narrative Tone" },
      { key: "cameraStyle", label: "镜头偏好", labelEn: "Camera Prefs" },
      { key: "moodStyle", label: "情绪基调", labelEn: "Mood & Tone" },
      { key: "promptHabits", label: "提示词习惯", labelEn: "Prompt Habits" },
      { key: "duration", label: "常用时长", labelEn: "Duration" },
      { key: "freeText", label: "其他偏好", labelEn: "Other" },
    ];
    var hasAny = fields.some(function (f) { return (p[f.key] || "").trim(); });
    if (!hasAny) {
      container.innerHTML = '<div class="text-center text-[#a5b4bc] text-sm py-16">暂无偏好数据<br/>开始对话后自动生成</div>';
      return;
    }

    var html = '';

    var filledFields = fields.filter(function (f) { return (p[f.key] || "").trim(); });
    var filledCount = filledFields.length;
    var pct = Math.round((filledCount / fields.length) * 100);

    html +=
      '<div class="p-5 bg-white rounded-xl border border-[#a5b4bc]/10">' +
        '<div class="flex justify-between items-center mb-3">' +
          '<span class="text-[10px] font-bold tracking-[0.15em] uppercase text-[#526168]">完成度</span>' +
          '<span class="text-[10px] font-mono text-[#5a5e6a]">' + pct + '%</span>' +
        '</div>' +
        '<div class="h-1.5 w-full bg-[#eef5f9] rounded-full overflow-hidden">' +
          '<div class="h-full bg-[#5a5e6a] rounded-full transition-all duration-500" style="width:' + pct + '%"></div>' +
        '</div>' +
      '</div>';

    filledFields.forEach(function (f) {
      var val = (p[f.key] || "").trim();
      html +=
        '<div class="p-5 bg-white rounded-xl border border-[#a5b4bc]/10">' +
          '<div class="flex justify-between items-center mb-3">' +
            '<span class="text-[10px] font-bold tracking-[0.15em] uppercase text-[#526168]">' + escapeHtml(f.labelEn) + '</span>' +
          '</div>' +
          '<p class="text-[13px] text-[#26353b] leading-relaxed font-medium">' + escapeHtml(val) + '</p>' +
        '</div>';
    });

    var tags = [];
    filledFields.forEach(function (f) {
      var val = (p[f.key] || "").trim();
      val.split(/[\/,、]/).forEach(function (t) {
        t = t.trim();
        if (t && t.length <= 10 && tags.length < 8) tags.push(t);
      });
    });
    if (tags.length > 0) {
      html += '<div class="flex flex-wrap gap-2 pt-2">';
      tags.forEach(function (t, i) {
        var cls = i === 0
          ? 'bg-[#5a5e6a] text-white'
          : 'bg-[#d5e5ed]/50 text-[#26353b]';
        html += '<span class="px-3 py-1 rounded-full text-[10px] font-bold tracking-[0.1em] uppercase ' + cls + '">' + escapeHtml(t) + '</span>';
      });
      html += '</div>';
    }

    if (p.updatedAt) {
      var d = new Date(p.updatedAt);
      html += '<div class="text-[10px] text-[#a5b4bc] pt-4">更新于 ' + d.toLocaleString("zh-CN") + '</div>';
    }
    container.innerHTML = html;
  }

  function _appendProfileBubble(role, text) {
    var wrap = $("profileChatMessages");
    if (!wrap) return;
    var inner = wrap.querySelector(".profile-chat-inner");
    if (!inner) return;
    var welcome = $("profileChatWelcome");
    if (welcome) welcome.hidden = true;

    var div = document.createElement("div");
    div.className = role === "user"
      ? "profile-msg profile-msg--user"
      : "profile-msg profile-msg--ai";

    if (role === "user") {
      div.innerHTML =
        '<div class="profile-text">' + escapeHtml(text) + '</div>' +
        '<div class="profile-avatar profile-avatar--user"><span class="material-symbols-outlined text-[#5a5e6a]" style="font-size:18px">person</span></div>';
    } else {
      div.innerHTML =
        '<div class="profile-avatar profile-avatar--ai"><span class="material-symbols-outlined text-white" style="font-size:18px">auto_awesome</span></div>' +
        '<div class="profile-text">' + escapeHtml(text) + '</div>';
    }
    inner.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function _showProfileLoading(show) {
    var wrap = $("profileChatMessages");
    if (!wrap) return;
    var inner = wrap.querySelector(".profile-chat-inner");
    if (!inner) return;
    var existing = inner.querySelector(".profile-loading-indicator");
    if (existing) existing.remove();
    if (!show) return;
    var div = document.createElement("div");
    div.className = "profile-msg profile-msg--ai profile-loading-indicator";
    div.innerHTML =
      '<div class="profile-avatar profile-avatar--ai"><span class="material-symbols-outlined text-white" style="font-size:18px">auto_awesome</span></div>' +
      '<div class="profile-text" style="color:#a5b4bc">' +
        '<span class="inline-flex items-center gap-3"><span class="inline-block w-4 h-4 border-2 border-[#a5b4bc]/30 border-t-[#5a5e6a] rounded-full animate-spin"></span>正在思考…</span>' +
      '</div>';
    inner.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function _sendProfileMessage(text) {
    if (_profileChatSending) return;
    _profileChatSending = true;

    if (text) {
      _appendProfileBubble("user", text);
    }

    var inputWrap = $("profileInputWrap");
    var input = $("profileMsgInput");
    if (input) input.value = "";

    _showProfileLoading(true);
    var _profileStreamTarget = null;
    var _profileStepState = { buf: "" };

    try {
      _appendProfileBubble("assistant", "");
      _showProfileLoading(false);
      var _profileBubbles = document.querySelectorAll("#profileChatMessages .profile-msg--ai");
      var _lastBubble = _profileBubbles.length ? _profileBubbles[_profileBubbles.length - 1] : null;
      _profileStreamTarget = _lastBubble ? _lastBubble.querySelector(".profile-text") : null;

      if (_profileStreamTarget) _profileStreamTarget.classList.add("streaming-wave");
      var _profileChatWrap = $("profileChatMessages");

      var resp = await apiPostStream("/api/profile/chat", {
        message: text || "",
        history: _profileChatHistory,
        currentProfile: _globalCreatorProfile,
      }, function (chunk) {
        var cleanChunk = _consumeStreamStepTags(chunk, _profileStepState, function () {});
        if (_profileStreamTarget && cleanChunk) _profileStreamTarget.textContent += cleanChunk;
        if (_profileChatWrap) _profileChatWrap.scrollTop = _profileChatWrap.scrollHeight;
      });

      if (_profileStreamTarget) _profileStreamTarget.classList.remove("streaming-wave");

      if (resp.error) {
        if (_profileStreamTarget) _profileStreamTarget.textContent = "抱歉，出了点问题：" + resp.error;
      } else {
        var reply = resp.reply || "...";
        if (_profileStreamTarget) _profileStreamTarget.textContent = reply;

        if (text) {
          _profileChatHistory.push({ role: "user", content: text });
        } else if (!_profileChatHistory.length) {
          _profileChatHistory.push({ role: "user", content: "你好，请开始引导我定义创作偏好。" });
        }
        _profileChatHistory.push({ role: "assistant", content: reply });

        if (resp.profile) {
          _globalCreatorProfile = _normalizeCreatorProfileClient(resp.profile);
          _renderProfileCard();
          // Phase 3-B-10：/api/profile/chat 成功时后端已经把 creatorProfile
          // 落进 user_<uid>.json 了，前端不再 mirror 到 localStorage。
        }
      }

      if (inputWrap) inputWrap.hidden = false;
    } catch (e) {
      if (_profileStreamTarget) _profileStreamTarget.classList.remove("streaming-wave");
      _showProfileLoading(false);
      _appendProfileBubble("assistant", "请求失败：" + ((e && e.message) || e));
      if (inputWrap) inputWrap.hidden = false;
    }
    _profileChatSending = false;
  }

  function _startProfileChat() {
    _profileChatHistory = [];
    var inputWrap = $("profileInputWrap");
    if (inputWrap) inputWrap.hidden = false;
    _sendProfileMessage("");
  }

  function _resetProfile() {
    showConfirm("重置创作偏好", "确定要重置所有创作偏好吗？", function () {
    _globalCreatorProfile = _normalizeCreatorProfileClient({});
    _profileChatHistory = [];
    // Phase 3-B-10：重置只改内存 + 下方 apiPost("/api/profile", {profile:{}})
    // 就够了，sw_creator_profile 这个 localStorage 镜像已经不再写入。
    _renderProfileCard();
    var inner = $("profileChatMessages");
    if (inner) {
      var container = inner.querySelector(".profile-chat-inner");
      if (container) container.innerHTML =
        '<div id="profileChatWelcome">' +
          '<div class="mt-16 mb-16">' +
            '<h1 class="text-[2.8rem] font-extralight tracking-[-0.02em] leading-tight text-[#26353b]">定义你的<span class="font-bold">创作</span>基因</h1>' +
            '<p class="text-[#526168] text-lg mt-5 max-w-md leading-relaxed">通过对话让 AI 理解你的风格偏好，后续所有创作环节将自动贴合你的审美。</p>' +
          '</div>' +
          '<button type="button" id="btnStartProfileChat" class="px-8 py-4 bg-[#5a5e6a] text-white rounded-xl text-xs font-bold tracking-[0.15em] uppercase shadow-[0_0_60px_rgba(90,94,106,0.08)] hover:opacity-90 transition-all">开始对话</button>' +
        '</div>';
      var newBtn = $("btnStartProfileChat");
      if (newBtn) newBtn.addEventListener("click", _startProfileChat);
    }
    var inputWrap = $("profileInputWrap");
    if (inputWrap) {
      inputWrap.hidden = true;
      inputWrap.classList.remove("glow-active");
    }
    apiPost("/api/profile", { profile: {} }).catch(function () {});
    });
  }

  function _loadProjectProfileOverride() {
    var toggle = $("toggleProjectProfile");
    var editor = $("projectProfileEditor");
    if (!toggle || !editor) return;
    if (!project || !project.creatorProfileOverride) {
      toggle.checked = false;
      editor.hidden = true;
      return;
    }
    var ov = _normalizeCreatorProfileClient(project.creatorProfileOverride);
    var hasContent = _hasCreatorProfileContent(ov);
    toggle.checked = hasContent;
    editor.hidden = !hasContent;
    if (hasContent) {
      var f = function (id, key) { var el = $(id); if (el) el.value = ov[key] || ""; };
      f("ppVisualStyle", "visualStyle");
      f("ppNarrativeStyle", "narrativeStyle");
      f("ppCameraPrefs", "cameraPrefs");
      f("ppMoodTone", "moodTone");
      f("ppPromptHabits", "promptHabits");
    }
  }

  function _saveProjectProfileOverride() {
    if (!project) return;
    project.creatorProfileOverride = {
      visualStyle: ($("ppVisualStyle") || {}).value || "",
      narrativeStyle: ($("ppNarrativeStyle") || {}).value || "",
      cameraPrefs: ($("ppCameraPrefs") || {}).value || "",
      moodTone: ($("ppMoodTone") || {}).value || "",
      promptHabits: ($("ppPromptHabits") || {}).value || "",
      lastUpdated: new Date().toISOString(),
    };
    saveProject();
    showToast("项目偏好已保存");
  }

  function wireProjectProfileOverride() {
    var toggle = $("toggleProjectProfile");
    var editor = $("projectProfileEditor");
    if (!toggle || !editor) return;
    toggle.addEventListener("change", function () {
      editor.hidden = !toggle.checked;
      if (!toggle.checked && project) {
        project.creatorProfileOverride = null;
        saveProject();
        showToast("已切换为全局偏好");
      }
    });
    var saveBtn = $("btnSaveProjectProfile");
    if (saveBtn) saveBtn.addEventListener("click", _saveProjectProfileOverride);
  }

  function _wireGlowBorder(el) {
    if (!el) return;
    el.addEventListener("mouseenter", function () { el.classList.add("glow-active"); });
    el.addEventListener("mouseleave", function () {
      if (document.activeElement && el.contains(document.activeElement)) return;
      el.classList.remove("glow-active");
      el.style.setProperty("--edge-proximity", "0");
    });
    el.addEventListener("focusin", function () {
      el.classList.add("glow-active");
      el.style.setProperty("--edge-proximity", "80");
    });
    el.addEventListener("focusout", function () {
      el.classList.remove("glow-active");
      el.style.setProperty("--edge-proximity", "0");
    });
    el.addEventListener("pointermove", function (e) {
      var rect = el.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var cx = rect.width / 2;
      var cy = rect.height / 2;
      var dx = x - cx;
      var dy = y - cy;
      var angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
      if (angle < 0) angle += 360;
      el.style.setProperty("--cursor-angle", angle.toFixed(1) + "deg");
      var kx = dx !== 0 ? cx / Math.abs(dx) : 1e6;
      var ky = dy !== 0 ? cy / Math.abs(dy) : 1e6;
      var prox = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1) * 100;
      el.style.setProperty("--edge-proximity", prox.toFixed(1));
    });
  }

  function wireProfilePageOnce() {
    var startBtn = $("btnStartProfileChat");
    if (startBtn) startBtn.addEventListener("click", _startProfileChat);

    var sendBtn = $("btnSendProfileMsg");
    if (sendBtn) sendBtn.addEventListener("click", function () {
      var input = $("profileMsgInput");
      var text = (input && input.value || "").trim();
      if (text) _sendProfileMessage(text);
    });

    var input = $("profileMsgInput");
    if (input) input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var text = (input.value || "").trim();
        if (text) _sendProfileMessage(text);
      }
    });

    var resetBtn = $("btnResetProfile");
    if (resetBtn) resetBtn.addEventListener("click", _resetProfile);

    _wireGlowBorder($("profileInputWrap"));
  }

  /* ================================================================
     AGENT MODULE — 全局 AI 视频助手
     ================================================================ */
  var _agentOpen = false;
  var _agentHistory = [];
  var _agentRefs = [];
  var _agentBusy = false;
  var _agentFabSuppressClick = false;
  var AGENT_FAB_POS_KEY = _uPrefix + "sw_agent_fab_pos_v2";

  function _agentFabBounds(fab) {
    var margin = 12;
    var size = fab && fab.offsetWidth ? fab.offsetWidth : 52;
    return {
      minX: margin,
      minY: margin,
      maxX: Math.max(margin, window.innerWidth - size - margin),
      maxY: Math.max(margin, window.innerHeight - size - margin),
    };
  }

  function _clampAgentFabPos(fab, pos) {
    var bounds = _agentFabBounds(fab);
    return {
      x: Math.min(bounds.maxX, Math.max(bounds.minX, pos.x)),
      y: Math.min(bounds.maxY, Math.max(bounds.minY, pos.y)),
    };
  }

  function _applyAgentFabPos(fab, pos) {
    if (!fab || !pos) return;
    var next = _clampAgentFabPos(fab, pos);
    fab.style.left = next.x + "px";
    fab.style.top = next.y + "px";
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  }

  function _readAgentFabPos() {
    try {
      var raw = localStorage.getItem(AGENT_FAB_POS_KEY);
      if (!raw) return null;
      var pos = JSON.parse(raw);
      if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return null;
      return pos;
    } catch (_) {
      return null;
    }
  }

  function _saveAgentFabPos(fab) {
    if (!fab) return;
    var rect = fab.getBoundingClientRect();
    var pos = _clampAgentFabPos(fab, { x: rect.left, y: rect.top });
    _applyAgentFabPos(fab, pos);
    try { localStorage.setItem(AGENT_FAB_POS_KEY, JSON.stringify(pos)); } catch (_) {}
  }

  function _wireAgentFabDrag(fab) {
    if (!fab || fab.dataset.dragBound === "1") return;
    fab.dataset.dragBound = "1";

    var saved = _readAgentFabPos();
    if (saved) _applyAgentFabPos(fab, saved);

    var drag = null;

    function finishDrag(e) {
      if (!drag) return;
      try { fab.releasePointerCapture(drag.pointerId); } catch (_) {}
      fab.classList.remove("is-dragging");
      if (drag.moved) {
        _saveAgentFabPos(fab);
        _agentFabSuppressClick = true;
        setTimeout(function () { _agentFabSuppressClick = false; }, 180);
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      drag = null;
    }

    fab.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      var rect = fab.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      fab.classList.add("is-dragging");
      try { fab.setPointerCapture(e.pointerId); } catch (_) {}
    });

    fab.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      _applyAgentFabPos(fab, { x: drag.left + dx, y: drag.top + dy });
      e.preventDefault();
    });

    fab.addEventListener("pointerup", finishDrag);
    fab.addEventListener("pointercancel", finishDrag);

    window.addEventListener("resize", function () {
      var current = _readAgentFabPos();
      if (current) {
        _applyAgentFabPos(fab, current);
        _saveAgentFabPos(fab);
      }
    });
  }

  function toggleAgentPanel(forceState) {
    var panel = $("agentPanel");
    var fab = $("navAgent");
    if (!panel) return;
    if (forceState !== undefined) _agentOpen = forceState;
    else _agentOpen = !_agentOpen;
    panel.hidden = !_agentOpen;
    if (fab) {
      if (_agentOpen) fab.classList.add("is-open");
      else fab.classList.remove("is-open");
    }
    if (_agentOpen) {
      var ta = $("agentInput");
      if (ta) setTimeout(function () { ta.focus(); }, 100);
    }
  }

  function _agentScrollBottom() {
    var box = $("agentMessages");
    if (box) box.scrollTop = box.scrollHeight;
  }

  function agentAddMsg(role, content, extra) {
    var box = $("agentMessages");
    if (!box) return;
    var welcome = box.querySelector(".agent-welcome");
    if (welcome) welcome.remove();

    var div = document.createElement("div");
    div.className = "agent-msg agent-msg--" + (role === "user" ? "user" : "ai");

    var bubble = document.createElement("div");
    bubble.className = "agent-msg-bubble";
    bubble.textContent = content;

    var label = document.createElement("span");
    label.className = "agent-msg-label";
    label.textContent = role === "user" ? "YOU" : "AGENT";

    div.appendChild(bubble);
    div.appendChild(label);
    box.appendChild(div);

    if (extra && extra.actions && extra.actions.length) {
      var groupedActions = _groupAssetDescActions(extra.actions);
      groupedActions.forEach(function (item) {
        var card = item.grouped
          ? _buildGroupedAssetCard(item.actions, item.autoRegen)
          : _buildActionCard(item.actions[0], item.originalIdx);
        box.appendChild(card);
      });
    }

    _agentScrollBottom();
    return div;
  }

  function _agentShowLoading() {
    var box = $("agentMessages");
    if (!box) return null;
    var div = document.createElement("div");
    div.className = "agent-msg agent-msg--ai";
    div.id = "_agentLoading";
    div.innerHTML =
      '<div class="agent-msg-loading"><span></span><span></span><span></span></div>' +
      '<span class="agent-msg-label">AGENT</span>';
    box.appendChild(div);
    _agentScrollBottom();
    return div;
  }

  function _agentRemoveLoading() {
    var el = document.getElementById("_agentLoading");
    if (el) el.remove();
  }

  function _buildAgentContext() {
    if (!project) return {};
    var ctx = {};
    if (project.script) ctx.script = project.script.slice(0, 3000);
    if (project.styleBible) ctx.styleBible = project.styleBible;
    if (project.assets) ctx.assets = project.assets;
    if (project.shots) ctx.shots = project.shots;
    var groups = getStoryboardGroups();
    if (groups.length) {
      ctx.storyboardGroups = groups.map(function (g) {
        return {
          groupIdx: g.groupIdx,
          shotIndices: g.shotIndices,
          hasImage: !!(project.storyboards && project.storyboards[g.groupIdx] && project.storyboards[g.groupIdx].imageUrl),
          hasVideoPrompt: !!(project.storyboards && project.storyboards[g.groupIdx] && project.storyboards[g.groupIdx].videoPrompt),
        };
      });
    }
    if (project.storyboards) {
      ctx.videoPrompts = project.storyboards.map(function (sb) {
        return (sb && sb.videoPrompt) || "";
      });
    }
    ctx.currentPage = activePage || "";
    return ctx;
  }

  async function agentSendMessage() {
    if (_agentBusy) return;
    var ta = $("agentInput");
    if (!ta) return;
    var msg = ta.value.trim();
    if (!msg) return;

    ta.value = "";
    ta.style.height = "auto";

    var refs = _agentRefs.slice();
    _agentRefs = [];
    _renderAgentRefs();

    var displayMsg = msg;
    if (refs.length) {
      displayMsg = refs.map(function (r) { return "@" + r.type + "#" + r.label; }).join(" ") + "\n" + msg;
    }

    var historySnapshot = _agentHistory.slice(-20);
    agentAddMsg("user", displayMsg);
    _agentHistory.push({ role: "user", content: displayMsg });

    _agentBusy = true;
    $("agentSendBtn").disabled = true;
    _agentShowLoading();

    try {
      var body = {
        message: msg,
        references: refs,
        history: historySnapshot,
        projectContext: _buildAgentContext(),
        creatorProfile: formatCreatorProfileForApi(),
      };

      _agentRemoveLoading();
      var _agentStreamBox = document.createElement("div");
      _agentStreamBox.className = "agent-msg agent-msg--ai";
      var _agentStreamBubble = document.createElement("div");
      _agentStreamBubble.className = "agent-msg-bubble streaming-wave";
      _agentStreamBox.appendChild(_agentStreamBubble);
      var _agentMsgBox = $("agentMessages");
      if (_agentMsgBox) _agentMsgBox.appendChild(_agentStreamBox);

      var resp = await apiPostStream("/api/agent/chat", body, function (chunk) {
        _agentStreamBubble.textContent += chunk;
      });

      _agentStreamBubble.classList.remove("streaming-wave");
      if (_agentStreamBox.parentNode) _agentStreamBox.parentNode.removeChild(_agentStreamBox);

      if (resp.error) {
        agentAddMsg("ai", "抱歉，出错了：" + resp.error);
        _agentHistory.push({ role: "assistant", content: resp.error });
      } else {
        agentAddMsg("ai", resp.reply, { actions: resp.actions || [] });
        _agentHistory.push({ role: "assistant", content: resp.reply });
      }
    } catch (e) {
      _agentRemoveLoading();
      agentAddMsg("ai", "网络错误：" + (e.message || e));
    }

    _agentBusy = false;
    $("agentSendBtn").disabled = false;
  }

  function agentInsertRef(type, label, data) {
    var exists = _agentRefs.some(function (r) { return r.type === type && r.label === label; });
    if (exists) return;
    _agentRefs.push({ type: type, label: label, data: data || {} });
    _renderAgentRefs();
    toggleAgentPanel(true);
    var ta = $("agentInput");
    if (ta) ta.focus();
  }

  function _renderAgentRefs() {
    var bar = $("agentRefsBar");
    var container = $("agentRefChips");
    if (!bar || !container) return;
    if (!_agentRefs.length) { bar.hidden = true; return; }
    bar.hidden = false;
    container.innerHTML = "";
    _agentRefs.forEach(function (ref, i) {
      var chip = document.createElement("span");
      chip.className = "agent-ref-chip";
      chip.innerHTML =
        '<span class="material-symbols-outlined">alternate_email</span>' +
        escapeHtml(ref.type + "#" + ref.label) +
        '<span class="agent-ref-close material-symbols-outlined" data-ref-idx="' + i + '">close</span>';
      container.appendChild(chip);
    });
    container.addEventListener("click", function (e) {
      var close = e.target.closest(".agent-ref-close");
      if (!close) return;
      var idx = parseInt(close.dataset.refIdx, 10);
      if (!isNaN(idx)) { _agentRefs.splice(idx, 1); _renderAgentRefs(); }
    });
  }

  /* ── Action Card rendering + apply ── */

  var ACTION_LABELS = {
    updateScript: "修改剧本",
    updateStyleBible: "修改风格圣经",
    updateShot: "修改分镜",
    addShot: "插入分镜",
    deleteShot: "删除分镜",
    updateAssetDesc: "修改资产描述",
    updateVideoPrompt: "修改视频提示词",
    regenAssetImage: "重新生成参考图",
    regenShotPrompt: "重新生成提示词",
    regenAllShotPrompts: "重新生成全部提示词",
    regenVideoPrompt: "重新生成视频提示词",
    regenStoryboard: "重新生成分镜板",
    regenVideo: "重新生成视频",
    runEditAnalyze: "AI 叙事分析",
    runEditEdl: "AI 剪辑方案",
    runEditExport: "导出成片",
  };

  function _groupAssetDescActions(actions) {
    var result = [];
    var assetGroups = {};
    var absorbedRegen = {};

    actions.forEach(function (action, idx) {
      if (action.type === "updateAssetDesc") {
        var key = action.assetType + "_" + action.assetIdx;
        if (!assetGroups[key]) {
          assetGroups[key] = { actions: [], originalIdx: idx, grouped: false, autoRegen: false };
          result.push(assetGroups[key]);
        }
        assetGroups[key].actions.push(action);
        if (assetGroups[key].actions.length > 1) assetGroups[key].grouped = true;
      } else if (action.type === "regenAssetImage") {
        var rKey = action.assetType + "_" + action.assetIdx;
        if (assetGroups[rKey]) {
          assetGroups[rKey].autoRegen = true;
          assetGroups[rKey].grouped = true;
          absorbedRegen[rKey] = true;
        } else {
          result.push({ actions: [action], originalIdx: idx, grouped: false });
        }
      } else {
        result.push({ actions: [action], originalIdx: idx, grouped: false });
      }
    });

    return result;
  }

  function _buildGroupedAssetCard(actions, autoRegen) {
    var card = document.createElement("div");
    card.className = "agent-action-card";
    var first = actions[0];
    var typeLabel = first.assetType === "char" ? "角色" : first.assetType === "scene" ? "场景" : "道具";
    var assetName = "";
    var list = first.assetType === "char" ? project.assets.characters : first.assetType === "scene" ? project.assets.scenes : project.assets.props;
    if (list && list[first.assetIdx]) assetName = list[first.assetIdx].name || "";

    var FIELD_LABELS = { appearance: "外貌", clothing: "服装", equipment: "装备", temperament: "气质", actionTraits: "动作特征", identity: "身份", role: "角色定位", name: "名称", description: "描述", timeSetting: "时间", location: "地点", lighting: "光线", atmosphere: "氛围", elements: "元素", features: "特征", ownership: "归属", propType: "类型" };
    var previewHtml = "";
    actions.forEach(function (a) {
      var fl = FIELD_LABELS[a.field] || a.field;
      previewHtml += '<div style="margin-bottom:4px;line-height:1.4"><span style="font-weight:700;color:#526168">' + escapeHtml(fl) + '</span> → <span style="opacity:.85">' + escapeHtml((a.value || "").slice(0, 80)) + '</span></div>';
    });
    if (autoRegen) {
      previewHtml += '<div style="margin-top:4px;color:#1976D2;font-size:10px">+ 应用后自动重新生成参考图</div>';
    }

    card.innerHTML =
      '<div class="agent-action-card-head">' +
        '<span class="agent-action-type"><span class="material-symbols-outlined text-xs">build</span>修改' + typeLabel + '描述</span>' +
        '<span style="font-size:11px;opacity:.6;margin-left:6px">' + escapeHtml(assetName) + '（' + actions.length + ' 项' + (autoRegen ? ' + 重生成' : '') + '）</span>' +
      '</div>' +
      '<div class="agent-action-preview" style="font-size:11px">' + previewHtml + '</div>' +
      '<div class="agent-action-btns">' +
        '<button type="button" class="agent-action-apply">应用</button>' +
        '<button type="button" class="agent-action-skip">跳过</button>' +
      '</div>';

    card.querySelector(".agent-action-apply").addEventListener("click", function () {
      _applyGroupedAssetActions(actions, false);
      if (autoRegen) {
        var _raType = first.assetType;
        var _raIdx = first.assetIdx;
        var _raList = _raType === "char" ? project.assets.characters : _raType === "scene" ? project.assets.scenes : project.assets.props;
        if (!_raList || !_raList[_raIdx]) return;
        generateSingleAssetImage(_raType, _raIdx);
        showToast("开始重新生成参考图…", "ok");
      }
      card.style.opacity = "0.4";
      card.style.pointerEvents = "none";
      card.querySelector(".agent-action-apply").textContent = "已应用 ✓";
    });
    card.querySelector(".agent-action-skip").addEventListener("click", function () {
      card.style.opacity = "0.3";
      card.style.pointerEvents = "none";
    });

    return card;
  }

  function _applyGroupedAssetActions(actions, skipRegen) {
    if (!project || !actions.length) return;
    var first = actions[0];
    var aType = first.assetType;
    var aIdx = first.assetIdx;
    var list = aType === "char" ? project.assets.characters : aType === "scene" ? project.assets.scenes : project.assets.props;
    if (!list || !list[aIdx]) return;

    var oldDesc = _getAssetDescText(aType, aIdx);

    actions.forEach(function (a) {
      list[aIdx][a.field] = a.value;
    });
    list[aIdx]._descEdited = true;
    _markDownstreamStale("asset", { type: aType, idx: aIdx, name: list[aIdx].name || "" });
    saveProject();
    refreshAssetsPage();
    showToast("资产描述已更新（" + actions.length + " 个字段）", "ok");
    _showCascadeReminder(first);
    _autoSyncUpstream(aType, aIdx, oldDesc);

    if (skipRegen) return;
    if (aType === "char") _checkEquipmentChange(aIdx, oldDesc);
  }

  function _buildActionCard(action, aIdx) {
    var card = document.createElement("div");
    card.className = "agent-action-card";

    var label = ACTION_LABELS[action.type] || action.type;
    var preview = "";
    if (action.type === "updateScript") {
      preview = "剧本 → " + (action.value || "").slice(0, 80) + "…";
    } else if (action.type === "updateStyleBible") {
      preview = (action.field || "") + " → " + (action.value || "").slice(0, 100);
    } else if (action.type === "updateShot") {
      preview = "分镜 " + ((action.shotIdx || 0) + 1) + " · " + (action.field || "") + " → " + (action.value || "").slice(0, 100);
    } else if (action.type === "addShot") {
      preview = "在分镜 " + ((action.afterShotIdx || 0) + 1) + " 之后插入";
    } else if (action.type === "deleteShot") {
      preview = "删除分镜 " + ((action.shotIdx || 0) + 1);
    } else if (action.type === "updateAssetDesc") {
      preview = (action.assetType || "") + " #" + ((action.assetIdx || 0) + 1) + " · " + (action.field || "") + " → " + (action.value || "").slice(0, 100);
    } else if (action.type === "updateVideoPrompt") {
      preview = "片段 " + ((action.groupIdx || 0) + 1) + " → " + (action.value || "").slice(0, 100);
    } else if (action.type === "regenAssetImage") {
      preview = (action.assetType || "") + " #" + ((action.assetIdx || 0) + 1) + " 参考图";
    } else if (action.type === "regenShotPrompt") {
      preview = "分镜 " + ((action.shotIdx || 0) + 1) + " 提示词";
    } else if (action.type === "regenAllShotPrompts") {
      preview = "全部分镜提示词";
    } else if (action.type === "regenVideoPrompt") {
      preview = "片段 " + ((action.groupIdx || 0) + 1);
    } else if (action.type === "regenStoryboard") {
      preview = "分镜板 " + ((action.groupIdx || 0) + 1);
    } else if (action.type === "regenVideo") {
      preview = "片段 " + ((action.groupIdx || 0) + 1) + " 视频";
    } else if (action.type === "runEditAnalyze") {
      preview = "AI 叙事分析";
    } else if (action.type === "runEditEdl") {
      preview = "AI 生成剪辑方案";
    } else if (action.type === "runEditExport") {
      preview = "导出成片";
    }

    card.innerHTML =
      '<div class="agent-action-card-head">' +
        '<span class="agent-action-type"><span class="material-symbols-outlined text-xs">build</span>' + escapeHtml(label) + '</span>' +
      '</div>' +
      (preview ? '<div class="agent-action-preview">' + escapeHtml(preview) + '</div>' : '') +
      '<div class="agent-action-btns">' +
        '<button type="button" class="agent-action-apply" data-agent-action-idx="' + aIdx + '">应用</button>' +
        '<button type="button" class="agent-action-skip" data-agent-action-skip="' + aIdx + '">跳过</button>' +
      '</div>';

    card._actionData = action;

    card.querySelector(".agent-action-apply").addEventListener("click", function () {
      applyAgentAction(action);
      card.style.opacity = "0.4";
      card.style.pointerEvents = "none";
      card.querySelector(".agent-action-apply").textContent = "已应用 ✓";
    });
    card.querySelector(".agent-action-skip").addEventListener("click", function () {
      card.style.opacity = "0.3";
      card.style.pointerEvents = "none";
    });

    return card;
  }

  function applyAgentAction(action) {
    if (!project) return;
    var t = action.type;

    if (t === "updateScript") {
      project.script = action.value;
      _markDownstreamStale("script", {});
      saveProject();
      refreshScriptPage();
      showToast("剧本已更新", "ok");

	    } else if (t === "updateStyleBible") {
	      if (!project.styleBible) project.styleBible = {};
	      project.styleBible[action.field] = action.value;
	      _markDownstreamStale("style_bible", {});
	      saveProject();
      if (typeof renderStyleBible === "function") renderStyleBible(project.styleBible);
      refreshStylePage();
      showToast("风格圣经已更新", "ok");

    } else if (t === "updateShot") {
      var si = action.shotIdx;
      if (project.shots && project.shots[si]) {
        project.shots[si][action.field] = action.value;
        _markDownstreamStale("shot", { idx: si });
        saveProject();
        renderShotList();
        showToast("分镜 " + (si + 1) + " 已更新", "ok");
      }

    } else if (t === "addShot") {
      if (project.shots) {
        var insertIdx = (action.afterShotIdx != null ? action.afterShotIdx + 1 : project.shots.length);
        var newShot = action.shot || {};
        newShot.id = "shot_" + (project.shots.length + 1);
        newShot.order = insertIdx + 1;
        newShot.imagePrompt = "";
        newShot.imagePromptGenerated = false;
        newShot.imageUrl = "";
        newShot.videoPrompt = "";
        newShot.videoStatus = "pending";
        project.shots.splice(insertIdx, 0, newShot);
        for (var _ri = 0; _ri < project.shots.length; _ri++) {
          project.shots[_ri].order = _ri + 1;
          project.shots[_ri].id = "shot_" + (_ri + 1);
        }
        _syncSingleShotSlotsAfterInsert(insertIdx);
        saveProject();
        renderShotList();
        showToast("已在分镜 " + insertIdx + " 后插入新分镜", "ok");
      }

    } else if (t === "deleteShot") {
      var _di = action.shotIdx;
      if (project.shots && project.shots[_di]) {
        project.shots.splice(_di, 1);
        for (var _dri = 0; _dri < project.shots.length; _dri++) {
          project.shots[_dri].order = _dri + 1;
          project.shots[_dri].id = "shot_" + (_dri + 1);
        }
        _syncSingleShotSlotsAfterDelete(_di);
        saveProject();
        renderShotList();
        showToast("分镜 " + (_di + 1) + " 已删除", "ok");
      }

    } else if (t === "updateAssetDesc") {
      var aType = action.assetType;
      var aIdx = action.assetIdx;
      var list = aType === "char" ? project.assets.characters : aType === "scene" ? project.assets.scenes : project.assets.props;
      if (list && list[aIdx]) {
        var oldDesc = _getAssetDescText(aType, aIdx);
        list[aIdx][action.field] = action.value;
        list[aIdx]._descEdited = true;
        _markDownstreamStale("asset", { type: aType, idx: aIdx, name: list[aIdx].name || "" });
        saveProject();
        refreshAssetsPage();
        showToast("资产描述已更新", "ok");
        _showCascadeReminder(action);
        _autoSyncUpstream(aType, aIdx, oldDesc);
        if (aType === "char") _checkEquipmentChange(aIdx, oldDesc);
      }

    } else if (t === "updateVideoPrompt") {
      var gi = action.groupIdx;
      if (!project.storyboards) project.storyboards = [];
      if (!project.storyboards[gi]) project.storyboards[gi] = {};
      project.storyboards[gi].videoPrompt = action.value;
      _clearStale("video_prompt_" + gi);
      saveProject();
      renderVideoPromptList();
      showToast("视频提示词已更新", "ok");

    } else if (t === "regenAssetImage") {
      var _raType = action.assetType;
      var _raIdx = action.assetIdx;
      var _raList = _raType === "char" ? project.assets.characters : _raType === "scene" ? project.assets.scenes : project.assets.props;
      if (!_raList || !_raList[_raIdx]) return;
      generateSingleAssetImage(_raType, _raIdx);
      showToast("开始重新生成参考图…", "ok");

    } else if (t === "regenShotPrompt") {
      convertSinglePrompt(action.shotIdx);
      showToast("开始重新生成提示词…", "ok");

    } else if (t === "regenAllShotPrompts") {
      if (typeof convertAllPrompts === "function") convertAllPrompts();
      showToast("开始重新生成全部提示词…", "ok");

    } else if (t === "regenVideoPrompt") {
      generateGroupVideoPrompt(action.groupIdx);
      showToast("开始重新生成视频提示词…", "ok");

    } else if (t === "regenStoryboard") {
      var groups = getStoryboardGroups();
      if (groups[action.groupIdx]) {
        generateStoryboardSheet(action.groupIdx);
      }
      showToast("开始重新生成分镜板…", "ok");

    } else if (t === "regenVideo") {
      var _vGroups = getStoryboardGroups();
      if (_vGroups[action.groupIdx]) {
        createWorkflowVideoTask(action.groupIdx);
      }
      showToast("开始重新生成视频…", "ok");

    } else if (t === "runEditAnalyze") {
      switchPage("edit");
      setTimeout(function () { _analyzeEditSegments(); }, 300);
      showToast("正在进行 AI 叙事分析…", "ok");

    } else if (t === "runEditEdl") {
      switchPage("edit");
      setTimeout(function () { _generateEditEdl(); }, 300);
      showToast("正在生成 AI 剪辑方案…", "ok");

    } else if (t === "runEditExport") {
      switchPage("edit");
      setTimeout(function () { _exportEditVideo(); }, 300);
      showToast("正在导出成片…", "ok");
    }
  }

  async function _showCascadeReminder(action) {
    if (!project || action.type !== "updateAssetDesc") return;
    var box = $("agentMessages");
    if (!box) return;

    var impacts = [];
    var aType = action.assetType;
    var aIdx = action.assetIdx;
    var assetName = "";
    var list = aType === "char" ? project.assets.characters : aType === "scene" ? project.assets.scenes : project.assets.props;
    if (list && list[aIdx]) assetName = list[aIdx].name || "";

    impacts.push({ key: "asset_img_" + aType + "_" + aIdx, label: assetName + " 参考图", action: async function () {
      var _l = aType === "char" ? project.assets.characters : aType === "scene" ? project.assets.scenes : project.assets.props;
      if (!_l || !_l[aIdx]) return;
      try {
        await generateSingleAssetImage(aType, aIdx);
      } catch (e) {
        console.error("[Cascade] regen failed:", aType, aIdx, e);
        showToast("重新生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
      }
      refreshAssetsPage();
    } });

    if (aType === "char" && project.assets && project.shots) {
      var relatedScenes = {};
      var relatedProps = {};
      project.shots.forEach(function (shot) {
        if ((shot.characters || []).indexOf(assetName) !== -1) {
          (shot.scenes || []).forEach(function (sn) { relatedScenes[sn] = true; });
          (shot.props || []).forEach(function (pn) { relatedProps[pn] = true; });
        }
      });
      var _charEquipment = (list[aIdx] && list[aIdx].equipment) || "";
      if (_charEquipment) {
        _charEquipment.split(/[,，、/\s]+/).forEach(function (eq) {
          eq = eq.trim();
          if (eq) relatedProps[eq] = true;
        });
      }
      (project.assets.scenes || []).forEach(function (s, si) {
        if (relatedScenes[s.name] && s.imageUrl) {
          impacts.push({ key: "asset_img_scene_" + si, label: "关联场景「" + s.name + "」参考图", action: async function () {
            try { await generateSingleAssetImage("scene", si); } catch (e) {
              console.error("[Cascade] scene regen failed:", si, e);
              showToast("场景重新生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
            }
            refreshAssetsPage();
          }});
        }
      });
      (project.assets.props || []).forEach(function (p, pi) {
        if (relatedProps[p.name] && p.imageUrl) {
          impacts.push({ key: "asset_img_prop_" + pi, label: "关联道具「" + p.name + "」参考图", action: async function () {
            try { await generateSingleAssetImage("prop", pi); } catch (e) {
              console.error("[Cascade] prop regen failed:", pi, e);
              showToast("道具重新生成失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
            }
            refreshAssetsPage();
          }});
        }
      });
    }

    if (project.shots) {
      project.shots.forEach(function (shot, si) {
        if (_isStale("shot_prompt_" + si)) {
          impacts.push({ key: "shot_prompt_" + si, label: "分镜 " + (si + 1) + " 提示词", action: function () { convertSinglePrompt(si); } });
        }
      });
    }
    if (project.storyboards) {
      project.storyboards.forEach(function (sb, gi) {
        if (_isStale("video_prompt_" + gi)) {
          impacts.push({ key: "video_prompt_" + gi, label: "片段 " + (gi + 1) + " 视频提示词", action: function () { generateGroupVideoPrompt(gi); } });
        }
      });
    }

    if (!impacts.length) return;

    var card = document.createElement("div");
    card.className = "agent-cascade-card";

    var html = '<div class="agent-cascade-title"><span class="material-symbols-outlined text-sm">warning</span>级联影响提醒</div>';
    html += '<div class="text-[10px] text-[#e65100]/70 mb-2">以下元素可能受此修改影响：</div>';

    impacts.forEach(function (imp, i) {
      html += '<div class="agent-cascade-item"><input type="checkbox" data-cascade-idx="' + i + '" checked /><span>' + escapeHtml(imp.label) + '</span></div>';
    });

    if (project.script && assetName) {
      html += '<div class="agent-cascade-item" style="border-top:1px solid #ffcc8044;padding-top:6px;margin-top:4px;opacity:.6">' +
        '<span class="material-symbols-outlined text-xs" style="color:#4caf50">check_circle</span>' +
        '<span>剧本 & 风格圣经已自动更新「' + escapeHtml(assetName) + '」的描述</span></div>';
    }

    var _obsoleteItems = await _detectObsoleteAssets();
    if (_obsoleteItems.length) {
      html += '<div style="border-top:1px solid #ffcc8044;padding-top:6px;margin-top:6px;">' +
        '<div class="text-[10px] font-bold text-[#d84315] mb-2"><span class="material-symbols-outlined text-xs align-middle">delete_sweep</span> 检测到可能过时的资产：</div>';
      _obsoleteItems.forEach(function (obs, oi) {
        var typeLabel = obs.type === "prop" ? "道具" : "场景";
        html += '<div class="agent-cascade-item"><input type="checkbox" data-obsolete-idx="' + oi + '" checked />' +
          '<span>' + typeLabel + '「' + escapeHtml(obs.name) + '」<span style="opacity:.6;font-size:9px;margin-left:4px">' + escapeHtml(obs.reasons[0]) + '</span></span></div>';
      });
      html += '</div>';
    }

    html += '<div class="agent-cascade-btns">' +
      '<button type="button" class="agent-cascade-regen" id="_cascadeRegen">勾选并重新生成</button>' +
      '<button type="button" class="agent-cascade-later" id="_cascadeLater">稍后再说</button>' +
      '</div>';

    card.innerHTML = html;
    box.appendChild(card);
    _agentScrollBottom();

    card.querySelector("#_cascadeRegen").addEventListener("click", async function () {
      card.style.opacity = "0.6";
      card.style.pointerEvents = "none";
      card.querySelector("#_cascadeRegen").textContent = "执行中…";

      var tasks = [];
      var checks = card.querySelectorAll("[data-cascade-idx]");
      checks.forEach(function (cb) {
        if (cb.checked) {
          var idx = parseInt(cb.dataset.cascadeIdx, 10);
          if (impacts[idx] && impacts[idx].action) tasks.push(impacts[idx].action);
        }
      });

      if (_obsoleteItems.length) {
        var toRemove = [];
        card.querySelectorAll("[data-obsolete-idx]").forEach(function (cb) {
          if (cb.checked) {
            var oi = parseInt(cb.dataset.obsoleteIdx, 10);
            if (_obsoleteItems[oi]) toRemove.push(_obsoleteItems[oi]);
          }
        });
        if (toRemove.length) {
          _removeObsoleteAssets(toRemove);
          showToast("已清理 " + toRemove.length + " 个过时资产", "ok");
        }
      }

      showToast("已提交 " + tasks.length + " 项重新生成任务", "ok");
      for (var ti = 0; ti < tasks.length; ti++) {
        try { await tasks[ti](); } catch (e) { console.error("[Cascade] task failed:", e); }
      }
      card.style.opacity = "0.4";
      card.querySelector("#_cascadeRegen").textContent = "已完成 ✓";
    });

    card.querySelector("#_cascadeLater").addEventListener("click", function () {
      card.style.opacity = "0.3";
      card.style.pointerEvents = "none";
      showToast("已标记为待更新，稍后可手动处理", "warn");
    });
  }

  async function _patchScriptForAsset(assetName, action) {
    if (!project || !project.script) return;
    try {
      var resp = await fetch("/api/agent/patch-script", {
        method: "POST",
        headers: _getAuthHeaders(),
        body: JSON.stringify({
          script: project.script,
          assetName: assetName,
          oldDesc: "",
          newDesc: action.value || "",
        }),
      }).then(function (r) { return r.json(); });

      if (resp.script && resp.script !== project.script) {
        project.script = resp.script;
        saveProject();
        refreshScriptPage();
        agentAddMsg("ai", "已自动更新剧本中关于「" + assetName + "」的描述。");
      } else if (resp.error) {
        agentAddMsg("ai", "剧本更新失败：" + resp.error);
      }
    } catch (e) {
      agentAddMsg("ai", "剧本更新网络错误：" + (e.message || e));
    }
  }

  function _agentRefFromCard(e, type, label, data) {
    e.preventDefault();
    e.stopPropagation();
    agentInsertRef(type, label, data);
  }

  function _wireAgentEvents() {
    var agentBtn = $("navAgent");
    if (agentBtn) {
      _wireAgentFabDrag(agentBtn);
      agentBtn.addEventListener("click", function (e) {
        if (_agentFabSuppressClick) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        toggleAgentPanel();
      });
    }

    var closeBtn = $("agentCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", function () { toggleAgentPanel(false); });

    var clearBtn = $("agentClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      _agentHistory = [];
      _agentRefs = [];
      var box = $("agentMessages");
      if (box) box.innerHTML =
        '<div class="agent-welcome">' +
          '<div class="w-14 h-14 rounded-full bg-[#5a5e6a]/10 flex items-center justify-center mb-4">' +
            '<span class="material-symbols-outlined text-2xl text-[#5a5e6a]/40">auto_awesome</span>' +
          '</div>' +
          '<p class="text-sm text-on-surface-variant/50 leading-relaxed font-medium">已连接创作引擎。<br/>点击任意元素的 <strong>@</strong> 按钮引用，<br/>然后告诉我你想怎么改。</p>' +
        '</div>';
      _renderAgentRefs();
    });

    var sendBtn = $("agentSendBtn");
    if (sendBtn) sendBtn.addEventListener("click", function () { agentSendMessage(); });

    var agentTA = $("agentInput");
    if (agentTA) {
      agentTA.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agentSendMessage(); }
      });
      agentTA.addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 100) + "px";
      });
    }
  }

  /* ================================================================
     Smart Suggestions — lightweight rules engine
     ================================================================ */
  function _checkAndSuggest(stage) {
    if (!project) return;
    try {
      if (stage === "assetExtract") _suggestAfterAssetExtract();
      else if (stage === "assetConfirm") _suggestBeforeAssetConfirm();
      else if (stage === "images") _suggestAfterImages();
      else if (stage === "videoPrompts") _suggestAfterVideoPrompts();
    } catch (e) { console.warn("[Suggest] error:", e); }
  }

  function _suggestAfterAssetExtract() {
    var chars = (project.assets && project.assets.characters) || [];
    var shortChars = chars.filter(function (c) { return !c.appearance || c.appearance.length < 20; });
    if (shortChars.length) {
      var names = shortChars.slice(0, 3).map(function (c) { return c.name; }).join("、");
      showToast(
        "角色「" + names + "」" + (shortChars.length > 3 ? "等" : "") + "外貌描述较短，建议补充以提升参考图质量",
        "info", 8000,
        [{ label: "去编辑", action: function () { switchPage("assets"); } }]
      );
    }
  }

  function _suggestBeforeAssetConfirm() {
    var chars = (project.assets && project.assets.characters) || [];
    var noPencil = chars.filter(function (c) { return !c.pencilUrl; });
    if (noPencil.length) {
      showToast(
        noPencil.length + " 个角色尚未生成风格参考图，可能影响后续视频参考图质量",
        "info", 6000
      );
    }
  }

  function _suggestAfterImages() {
    if (!project.storyboards) return;
    var groups = getStoryboardGroups();
    var failed = [];
    groups.forEach(function (_, i) {
      if (!project.storyboards[i] || !project.storyboards[i].imageUrl) failed.push(i + 1);
    });
    if (failed.length) {
      showToast(
        failed.length + " 张首帧图生成失败（片段 " + failed.slice(0, 5).join("、") + "），建议重试",
        "warn", 8000,
        [{ label: "重试失败项", action: function () { generateAllImages(); } }]
      );
    }
  }

  function _suggestAfterVideoPrompts() {
    if (!project.storyboards || !project.assets) return;
    var chars = (project.assets.characters || []);
    if (!chars.length) return;
    var groups = getStoryboardGroups();
    var issues = [];
    groups.forEach(function (_, gIdx) {
      var sb = project.storyboards[gIdx];
      if (!sb || !sb.videoPrompt) return;
      var vp = sb.videoPrompt;
      chars.forEach(function (c) {
        if (!c.name) return;
        var shots = groups[gIdx] && groups[gIdx].shots || [];
        var isTagged = shots.some(function (s) {
          return (s.characters || []).indexOf(c.name) !== -1;
        });
        if (isTagged && vp.indexOf(c.name) === -1) {
          issues.push("片段 " + (gIdx + 1) + " 未提及角色「" + c.name + "」");
        }
      });
    });
    if (issues.length) {
      showToast(
        issues[0] + (issues.length > 1 ? "（共 " + issues.length + " 处）" : "") + "，可能影响一致性",
        "info", 8000,
        [{ label: "查看提示词", action: function () { switchPage("prompts"); } }]
      );
    }
  }

  /* ================================================================
     INIT
     ================================================================ */
  async function init() {
    if (!_getAuthToken()) {
      window.location.href = "/?auth=1";
      return;
    }
    _wireCoreNavigationOnce();
    initSettings({
      settings,
      STORAGE_MODELS,
      STEP_TO_SLOT,
      MODEL_SLOT_META,
      VIDEO_ADAPTERS,
      IMAGE_PROVIDERS,
    });
    initEpisodes({
      getProject: () => project,
      EPISODE_FIELDS: EPISODE_FIELDS,
      $: $,
      saveProject: () => saveProject(),
      tagEmotions: () => tagEmotions(),
      resetProjectUI: () => _resetProjectUI(),
      refreshAllPages: () => refreshAllPages(),
      restoreVideoTasks: () => _restoreVideoTasks(),
      switchPage: (p) => switchPage(p),
      diagnoseApiError: (m) => _diagnoseApiError(m),
    });
    initVideoTasks({
      getProject: () => project,
      getSettings: () => settings,
      getVideoState: () => videoState,
      getProjectEpoch: () => _projectEpoch,
      MAX_CONCURRENT,
      MAX_TASKS_TOTAL,
      STATUS_COPY,
      VIDEO_ADAPTERS,
      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      registerServerTask: (taskId, taskType, targetType, targetIdx, extra) => _registerServerTask(taskId, taskType, targetType, targetIdx, extra),
      notifyServerTaskDone: (taskId) => _notifyServerTaskDone(taskId),
      archiveOldImage: (item, source) => _archiveOldImage(item, source),
      updateAssetCardImage: (type, idx, status, imgUrl, loadingText) => updateAssetCardImage(type, idx, status, imgUrl, loadingText),
      updateStoryboardCard: (gIdx, status, imgUrl, errMsg) => updateStoryboardCard(gIdx, status, imgUrl, errMsg),
      getStoryboardGroups: () => getStoryboardGroups(),
      vpFetchAndCache: (sb) => vpFetchAndCache(sb),
      vpGetCache: (sb) => vpGetCache(sb),
      switchPage: (p) => switchPage(p),
	      diagnoseApiError: (msg) => _diagnoseApiError(msg),
	      sleep: (ms) => sleep(ms),
	      refreshOverview: () => refreshOverview(),
	      reloadProjectFromServer: async () => {
	        if (!project || !project.id) return false;
	        try {
	          var p = await loadProjectData(project.id);
	          if (!p || !p.id || p.id !== project.id) return false;
	          project = p;
	          syncEditProject(project);
	          syncTasksProject(project);
	          syncVideoTasksProject(project);
	          syncVideoPromptsProject(project);
	          syncShotsProject(project);
	          syncStoryboardProject(project);
	          syncScriptProject(project);
	          syncAssetsProject(project);
	          syncEpisodesProject(project);
	          return true;
	        } catch (e) {
	          console.warn("[reloadProjectFromServer] failed:", e);
	          return false;
	        }
	      },
	    });
    initProject({
      getProject: () => project,
      setProject: (p) => { project = p; },
      getVideoState: () => videoState,
      ensureEpisodes: () => _ensureEpisodes(),
      restoreAssetGenStatus: () => _restoreAssetGenStatus(),
      restoreVideoTasks: () => _restoreVideoTasks(),
      addProjectToList: (p) => addProjectToList(p),
      refreshAllPages: () => refreshAllPages(),
      resetProjectUI: () => _resetProjectUI(),
      renderEpisodeTabs: () => _renderEpisodeTabs(),
      syncEditProject: (p) => syncEditProject(p),
      syncTasksProject: (p) => syncTasksProject(p),
      getProjectList: () => getProjectList(),
      saveProjectList: (list) => saveProjectList(list),
      loadProjectFromServerAndSwitch: (id) => _loadProjectFromServerAndSwitch(id),
      saveCurrentEpisode: () => _saveCurrentEpisode(),
      tagEmotions: () => tagEmotions(),
      recoverTasksFromServer: () => _restoreVideoTasks(),
      STORAGE_PROJECT: STORAGE_PROJECT,
      uPrefix: _uPrefix,
      EPISODE_FIELDS: EPISODE_FIELDS,
      showProjectSkeleton: (on) => _showProjectSkeleton(on),
    });
    // Phase 5.9：server-first boot — await 保证 loadProject 返回前，后续
    // syncXxxProject / initXxx 都拿到的是服务器权威 project。loadProject 内部
    // 显示骨架屏，资料到位后自己关闭；异常也不会阻塞后续初始化。
    try { await loadProject(); }
    catch (e) { console.warn("[Init] loadProject failed:", e); }
    wireSettingsPageOnce();
    wireProfilePageOnce();
    wireStylePageOnce();
    wireProjectProfileOverride();
    _wireGlowBorder($("scriptInputWrap"));
    _wireGlowBorder($("projectProfileSection"));
    _wireGlowBorder($("editCardAnalyze"));
    _wireGlowBorder($("editCardGenEdl"));
    _wireGlowBorder($("editCardExport"));
    // 左侧导航「任务列表」快捷入口：改用 PixelCard canvas 动画（像素从中心向外
    // 按距离延迟 appear → 到达后 shimmer；mouseleave / blur 触发 disappear）。
    // 原 glow-border-wrap 边缘彩光已撤。实现在 static/modules/pixel_card.js，
    // HTML wrap 结构见 static/index.html 的 #navTaskListWrap。
    // gap 覆盖 variant.blue 默认的 10 -> 5，像素网格密度翻倍（每 5px 一个点），
    // 色板仍走 blue 的 #e0f2fe / #7dd3fc / #0ea5e9 三段浅蓝。
    try { mountPixelCard($("navTaskListWrap"), { variant: "blue", gap: 5 }); }
    catch (e) { console.warn("[Init] mountPixelCard(navTaskListWrap) failed:", e); }
    try { mountPixelCard($("styleHeroPixelWrap"), { variant: "blue", gap: 7, speed: 28 }); }
    catch (e) { console.warn("[Init] mountPixelCard(styleHeroPixelWrap) failed:", e); }
    try { await loadSettings(); } catch (e) { console.warn("[Init] loadSettings failed:", e); }
    try { await loadCreatorProfile(); } catch (e) { console.warn("[Init] loadCreatorProfile failed:", e); }
    try { _loadProjectProfileOverride(); } catch (e) { console.warn("[Init] loadProjectProfileOverride failed:", e); }
    _initAccountBar();
    _initAdminLogButtons();

    if (project) _renderEpisodeTabs();

    initTasks({ switchPage: (p) => switchPage(p) });
    initBilling({ switchPage: (p) => switchPage(p) });
    syncTasksProject(project);
        syncVideoTasksProject(project);
    syncEpisodesProject(project);
    initVideoPrompts({
      getProject: () => project,
      getSettings: () => settings,
      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn) => _safeWriteBack(id, fn),
      getStoryboardGroups: () => getStoryboardGroups(),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
	      checkAndSuggest: (stage) => _checkAndSuggest(stage),
	      switchPage: (p) => switchPage(p),
	      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
	      sleep: (ms) => sleep(ms),
	      diagnoseApiError: (msg) => _diagnoseApiError(msg),
	      invalidateVideoForGroup: (gIdx) => _invalidateVideoForGroup(gIdx),
	      applyProjectFromServer: (p) => {
	        if (!p || !p.id || (project && p.id !== project.id)) return false;
	        project = p;
	        syncEditProject(project);
	        syncTasksProject(project);
	        syncVideoTasksProject(project);
	        syncVideoPromptsProject(project);
	        syncShotsProject(project);
	        syncStoryboardProject(project);
	        syncScriptProject(project);
	        syncAssetsProject(project);
	        syncEpisodesProject(project);
	        return true;
	      },
	      reloadProjectFromServer: async () => {
	        if (!project || !project.id) return false;
	        try {
	          var p = await loadProjectData(project.id);
	          if (!p || !p.id || p.id !== project.id) return false;
	          project = p;
	          syncEditProject(project);
	          syncTasksProject(project);
	          syncVideoTasksProject(project);
	          syncVideoPromptsProject(project);
	          syncShotsProject(project);
	          syncStoryboardProject(project);
	          syncScriptProject(project);
	          syncAssetsProject(project);
	          syncEpisodesProject(project);
	          return true;
	        } catch (e) {
	          console.warn("[reloadProjectFromServer] failed:", e);
	          return false;
	        }
	      },
	    });
    syncVideoPromptsProject(project);
    initShots({
      getProject: () => project,
      saveProject: () => saveProject(),
      safeWriteBack: (id, fn) => _safeWriteBack(id, fn),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      diagnoseApiError: (msg) => _diagnoseApiError(msg),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      emotionBadgeHtml: (emotion, intensity) => emotionBadgeHtml(emotion, intensity),
    });
    syncShotsProject(project);
    initStoryboard({
      getProject: () => project,
      saveProject: () => saveProject(),
      safeWriteBack: (id, fn) => _safeWriteBack(id, fn),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      diagnoseApiError: (msg) => _diagnoseApiError(msg),
      isStale: (key) => _isStale(key),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      archiveOldImage: (item, source) => _archiveOldImage(item, source),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      openLightbox: (url) => _openLightbox(url),
      historyBtnHtml: (item, variant) => _historyBtnHtml(item, variant),
      openHistoryPopover: (btn, item, onApply) => _openHistoryPopover(btn, item, onApply),
      setHistoryAsCurrent: (item, hi) => _setHistoryAsCurrent(item, hi),
      emotionBadgeHtml: (emotion, intensity) => emotionBadgeHtml(emotion, intensity),
      sleep: (ms) => sleep(ms),
      invalidateVideoForGroup: (gIdx) => _invalidateVideoForGroup(gIdx),
    });
    syncStoryboardProject(project);
    initScript({
      getProject: () => project,
      saveProject: () => saveProject(),
      safeWriteBack: (id, fn) => _safeWriteBack(id, fn),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      toastErrorWithActions: (msg) => _toastErrorWithActions(msg),
      getAuthToken: () => getAuthToken(),
      uPrefix: _uPrefix,
      createNewProject: () => createNewProject(),
      triggerExtractAssets: () => extractAssets(),
    });
    syncScriptProject(project);
    syncAssetsProject(project);
	    initAssets({
	      getProject: () => project,
	      getVideoState: () => videoState,
	      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn) => _safeWriteBack(id, fn),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      archiveOldImage: (item, kind) => _archiveOldImage(item, kind),
      registerServerTask: (id, kind, type, idx) => _registerServerTask(id, kind, type, idx),
      updateServerTaskStatus: (id, status, url) => _updateServerTaskStatus(id, status, url),
      renderStyleBible: (sb) => renderStyleBible(sb),
      updateStoryboardCard: (idx, status, url, text) => updateStoryboardCard(idx, status, url, text),
      historyBtnHtml: (item, variant) => _historyBtnHtml(item, variant),
      openHistoryPopover: (btn, item, onApply) => _openHistoryPopover(btn, item, onApply),
      setHistoryAsCurrent: (item, hi) => _setHistoryAsCurrent(item, hi),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      refreshOverview: () => refreshOverview(),
      getPreviousEpisodeAssets: () => _getPreviousEpisodeAssets(),
      getProjectList: () => getProjectList(),
      refreshScriptPage: () => refreshScriptPage(),
      getStoryboardGroups: () => getStoryboardGroups(),
      // 安全网：批次完成时调一次，从服务端整包重新拉项目并把 in-memory 替换掉，
      // 这样即便 SSE 单帧丢失（网络抖动 / 浏览器节流），UI 最终一定会和服务器
      // 真实状态一致——相当于"自动帮用户按一次 F5"。
      reloadProjectFromServer: async () => {
        if (!project || !project.id) return false;
        try {
          var p = await loadProjectData(project.id);
          if (!p || !p.id || p.id !== project.id) return false;
          project = p;
          syncEditProject(project);
          syncTasksProject(project);
          syncVideoTasksProject(project);
          syncVideoPromptsProject(project);
          syncShotsProject(project);
          syncStoryboardProject(project);
          syncScriptProject(project);
          syncAssetsProject(project);
          return true;
        } catch (e) {
          console.warn("[reloadProjectFromServer] failed:", e);
          return false;
        }
      },
    });
    syncAssetsProject(project);
    // Phase 5.10 · 启动时序补丁：`loadProject()`（line 2633）内部触发的
    // `restoreAssetGenStatus()` 跑得太早——那时 `assets.js` 的 module-level
    // `project` 还没被 `syncAssetsProject()` 塞进去（它要到 line 2745 才跑），
    // 所以 `_restoreAssetGenStatus()` 第一行 `if (!project) return;` 直接 no-op，
    // `/api/batch/active` 根本不会被调，刷新后 spinner 永远恢复不了。
    //
    // 修法：在 `syncAssetsProject(project)` 之后**显式再调一次** —— 此时
    // `assets.js::project` 已就位，`reattachActiveBatches` 才能真正发 GET
    // `/api/batch/active?projectId=...`，从后端 `_BATCHES` + task_store 把
    // running/pending 的 asset_images / asset_stylize batch 拉回来重建 spinner。
    // 首次 (line 2633) 的 no-op 保留不删 —— 幂等调用，代价只有一次 `null` 检查。
    if (project && project.id) {
      try { _restoreAssetGenStatus(); }
      catch (e) { console.warn("[Init] restoreAssetGenStatus (post-sync) failed:", e); }
      try { reattachStoryboardBatches(); }
      catch (e) { console.warn("[Init] reattachStoryboardBatches failed:", e); }
    }
    // Phase 3-B-10：世界观模板搬后端 /api/world-templates，启动时 prime 一次
    try { _primeWorldTemplates(); } catch (e) { console.warn("[Init] primeWorldTemplates failed:", e); }
    // Phase 5.5：接管 window.onerror / unhandledrejection，老代码忘 catch 的
    // promise 异常由 error_hub 兜底记一条 warn，不再静默吞掉。默认不 toast
    // 以免惊扰用户——真正关心的场景由调用方主动 reportError(..., {toast:true})。
    try { _installErrorHub({ toastOnUncaught: false }); } catch (e) { console.warn("[Init] errorHub failed:", e); }
    // Phase 5.7：拉一次服务器侧常量配置，覆盖本地默认 MAX_* 值
    try { _loadClientConfig(); } catch (e) { console.warn("[Init] loadClientConfig failed:", e); }
    try { loadBillingSummary(); } catch (e) { console.warn("[Init] loadBillingSummary failed:", e); }
    try { handleBillingReturnFromUrl(); } catch (e) { console.warn("[Init] handleBillingReturnFromUrl failed:", e); }
    try { _startMaintenanceBannerPoll(); } catch (e) { console.warn("[Init] maintenanceBanner failed:", e); }

    window.addEventListener("beforeunload", function () {
      if (project) { saveProject(); }
    });

    _wireCoreNavigationOnce();

    /* Project overview — all guarded with try/catch to prevent breaking event chain */
    try {
      var _btnNew = $("btnNewProject");
      if (_btnNew) _btnNew.addEventListener("click", async function () {
        try {
          console.log("[UI] btnNewProject clicked");
          var d = new Date();
          var mm = String(d.getMinutes());
          if (mm.length < 2) mm = "0" + mm;
          var name = "项目 " + (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + mm;
          var ok = await createNewProject(name);
          if (ok !== false) {
            refreshOverview();
            switchPage("script");
          }
        } catch (e) { console.error("[NewProject]", e); }
      });

      var _btnReset = $("btnResetProject");
      if (_btnReset) _btnReset.addEventListener("click", async function () {
        try {
          console.log("[UI] btnResetProject clicked");
          var d = new Date();
          var mm = String(d.getMinutes());
          if (mm.length < 2) mm = "0" + mm;
          var name = "项目 " + (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + mm;
          var ok = await createNewProject(name);
          if (ok !== false) refreshOverview();
        } catch (e) { console.error("[ResetProject]", e); }
      });

      var _btnTpl = $("btnFromTemplate");
      if (_btnTpl) _btnTpl.addEventListener("click", function () {
        try { _openTemplateImportModal(); } catch (e) { console.error("[FromTemplate]", e); }
      });
      var _btnTpl2 = $("btnFromTemplate2");
      if (_btnTpl2) _btnTpl2.addEventListener("click", function () {
        try { _openTemplateImportModal(); } catch (e) { console.error("[FromTemplate2]", e); }
      });

      _wireOverviewDashboardOnce();

      var _plistWrap = $("projectListWrap");
      if (_plistWrap) _plistWrap.addEventListener("click", handleProjectListAction);
      _bindProjNameEdit();
    } catch (e) { console.error("[ProjectInit]", e); }

    /* Script page — chat input */
    $("btnGenScript").addEventListener("click", handleScriptInput);
    var ideaEl = $("ideaInput");
    if (ideaEl) {
      ideaEl.addEventListener("input", function () { chatAutoResize(ideaEl); });
      ideaEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleScriptInput(); }
      });
    }
    var scriptChipWrap = $("scriptExampleChips");
    if (scriptChipWrap) {
      scriptChipWrap.addEventListener("click", function (e) {
        var chip = e.target.closest(".script-chip");
        if (!chip || !scriptChipWrap.contains(chip)) return;
        var idea = chip.getAttribute("data-idea") || "";
        var input = $("ideaInput");
        if (input) {
          input.value = idea;
          chatAutoResize(input);
          input.focus();
        }
      });
    }
    $("btnRegenScript").addEventListener("click", function () {
      var lastIdea = (project && project.idea) || "";
      if (lastIdea) { $("ideaInput").value = lastIdea; }
      generateScript(lastIdea);
    });
    var scriptHeaderRegen = $("btnScriptHeaderRegen");
    if (scriptHeaderRegen) scriptHeaderRegen.addEventListener("click", function () {
      var regen = $("btnRegenScript");
      if (regen) regen.click();
    });
    var scriptHistoryBtn = $("btnScriptHistory");
    if (scriptHistoryBtn) scriptHistoryBtn.addEventListener("click", function () {
      showToast("历史版本入口已保留，版本管理功能待接入", "info");
    });
    var scriptSettingsBtn = $("btnScriptSettings");
    if (scriptSettingsBtn) scriptSettingsBtn.addEventListener("click", function () {
      showToast("剧本设置入口已保留，配置功能待接入", "info");
    });
    $("btnConfirmScript").addEventListener("click", confirmScript);
    initScriptImportEvents();

    var editBtn = $("btnEditScript");
    if (editBtn) editBtn.addEventListener("click", showScriptEdit);
    var expandBtn = $("btnExpandScript");
    if (expandBtn) expandBtn.addEventListener("click", _openExpandScriptDialog);
    var retagBtn = $("btnRetagEmotions");
    if (retagBtn) retagBtn.addEventListener("click", function () {
      retagBtn.disabled = true;
      retagBtn.textContent = "分析中…";
      Promise.resolve(tagEmotions()).finally(function () {
        retagBtn.disabled = false;
        retagBtn.textContent = "重新分析情绪";
      });
    });
    var displayText = $("scriptDisplayText");
    if (displayText) displayText.addEventListener("click", showScriptEdit);
    var scriptTA = $("scriptOutput");
    if (scriptTA) scriptTA.addEventListener("blur", function () {
      if (project && project.script !== scriptTA.value.trim()) {
        project.script = scriptTA.value.trim();
        _markDownstreamStale("script", {});
        saveProject();
      }
      if (displayText) displayText.textContent = scriptTA.value.trim();
      showScriptDisplay();
    });

    initEdit({
      saveProject: () => saveProject(),
      getStoryboardGroups: () => getStoryboardGroups(),
      switchPage: (p) => switchPage(p),
      getSettings: () => settings,
      getActivePage: () => activePage,
      // E-1.1：edit.js 需要的三件套（以前在全局 var / assets.js export 里）
      sleep: (ms) => sleep(ms),
      getAuthToken: () => getAuthToken(),
      diagnoseApiError: (msg) => _diagnoseApiError(msg),
      // E-3.3：AI 分析 / AI 剪辑 SSE 把结果落到后端 + 返回 serverVersion，
      // 前端不再自己 saveProject，只把内存版本号推到 max(cur, serverVersion)。
      bumpProjectVersion: (sv) => {
        if (sv == null || !project) return;
        var n = Number(sv);
        if (!Number.isFinite(n)) return;
        var cur = Number(project.version || 0);
        if (n > cur) project.version = n;
      },
      getProject: () => project,
    });
    syncEditProject(project);
    _initEditEvents();

    /* Assets page */
    $("btnExtractAssets").addEventListener("click", extractAssets);
    $("btnGenAssetImages").addEventListener("click", generateAllAssetImages);
    $("btnConfirmAssets").addEventListener("click", confirmAssets);
    $("btnCleanObsolete").addEventListener("click", _showCleanObsoleteDialog);
    var _btnSaveTpl = $("btnSaveWorldTemplate");
    if (_btnSaveTpl) _btnSaveTpl.addEventListener("click", saveAsWorldTemplate);
    var charGrid = $("assetCharGrid");
    var sceneGrid = $("assetSceneGrid");
    var propGrid = $("assetPropGrid");
    if (charGrid) charGrid.addEventListener("click", handleAssetAction);
    if (sceneGrid) sceneGrid.addEventListener("click", handleAssetAction);
    if (propGrid) propGrid.addEventListener("click", handleAssetAction);

    /* Shots page */
    $("btnGenShots").addEventListener("click", generateShots);
    $("btnConfirmShots").addEventListener("click", confirmShots);
    var slw = $("shotListWrap");
    if (slw) slw.addEventListener("click", handleShotAction);

    /* Images page — unified storyboard generation */
    var _btnGenAll = $("btnGenAllImages");
    if (_btnGenAll) _btnGenAll.addEventListener("click", generateAllImages);
    var _btnGenAllTail = $("btnGenAllTailFrames");
    if (_btnGenAllTail) _btnGenAllTail.addEventListener("click", generateAllTailFrames);
    var _btnUpgradeLegacy = $("btnUpgradeLegacyFirstFrames");
    if (_btnUpgradeLegacy) _btnUpgradeLegacy.addEventListener("click", upgradeLegacyFirstFrames);
    var _btnConfirmImg = $("btnConfirmImages");
    if (_btnConfirmImg) _btnConfirmImg.addEventListener("click", confirmImages);
    var imgGrid = $("imageGrid");
    if (imgGrid) imgGrid.addEventListener("click", handleImageAction);

    var _sbPrev = $("sbNavPrev");
    var _sbNext = $("sbNavNext");
    if (_sbPrev) _sbPrev.addEventListener("click", function () { scrollToCard(getSbCurrentIdx() - 1); });
    if (_sbNext) _sbNext.addEventListener("click", function () { scrollToCard(getSbCurrentIdx() + 1); });
    var _sbDots = $("sbNavDots");
    if (_sbDots) _sbDots.addEventListener("click", function (e) {
      var dot = e.target.closest("[data-dot-idx]");
      if (dot) scrollToCard(parseInt(dot.dataset.dotIdx, 10));
    });

    /* Video prompts page (Phase 3) */
    $("btnGenAllVideoPrompts").addEventListener("click", generateAllVideoPrompts);
    $("btnConfirmVideoPrompts").addEventListener("click", confirmVideoPrompts);
    var vpList = $("videoPromptList");
    if (vpList) vpList.addEventListener("click", handleVideoPromptAction);

    var vpRefAgentBtn = $("vpBtnRefAgent");
    if (vpRefAgentBtn) vpRefAgentBtn.addEventListener("click", function () {
      var gIdx = getVpSelectedGroup();
      var sb = project && project.storyboards && project.storyboards[gIdx];
      agentInsertRef("视频提示词", "片段" + (gIdx + 1), { groupIdx: gIdx, prompt: (sb && sb.videoPrompt) || "" });
    });
    var vpRegenBtn = $("vpBtnRegenSingle");
    if (vpRegenBtn) vpRegenBtn.addEventListener("click", function () {
      if (!project || !project.storyboards) return;
      var gIdx = getVpSelectedGroup();
      generateGroupVideoPrompt(gIdx);
    });
    var vpCopyBtn = $("vpBtnCopy");
    if (vpCopyBtn) vpCopyBtn.addEventListener("click", function () {
      var sb = project && project.storyboards && project.storyboards[getVpSelectedGroup()];
      if (sb && sb.videoPrompt) {
        navigator.clipboard.writeText(sb.videoPrompt).then(function () { showToast("提示词已复制", "ok"); });
      } else { showToast("当前没有可复制的提示词", "warn"); }
    });
    var vpRefineBtn = $("vpBtnRefine");
    if (vpRefineBtn) vpRefineBtn.addEventListener("click", function () {
      var input = $("vpRefineInput");
      var val = input && input.value.trim();
      if (val) refineVideoPrompt(val);
    });
    var vpRefineInput = $("vpRefineInput");
    if (vpRefineInput) {
      _blockCredentialReplacementInput(vpRefineInput);
      vpRefineInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          var val = e.target.value.trim();
          if (val) refineVideoPrompt(val);
        }
      });
    }

    /* Batch generation page */
    $("btnStartBatch").addEventListener("click", startBatchGeneration);
    _initBatchPlayerEvents();

    /* Library page */
    _initLibraryEvents();

    /* Batch video task events */
    var batchTW = $("batchTaskListWrap");
    if (batchTW) batchTW.addEventListener("click", handleVideoTaskAction);
    syncTaskListVisibility(); updateBadge();

    /* Agent */
    _wireAgentEvents();

    /* Initial page */
    var bootTargetPage = _bootUserNavigated
      ? (_bootDeferredPageRefresh || activePage || "overview")
      : "overview";
    _appBootstrapping = false;
    _bootDeferredPageRefresh = "";
    switchPage(bootTargetPage, { forceRefresh: true });
  }

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); }
  else { init(); }
