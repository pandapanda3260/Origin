/**
 * ORIGINRISE · AI 可视化分镜工作台 — v2.7-web
 */
import { $, escapeHtml, showToast, showConfirm, formatTime, setLoading,
  consumeStreamStepTags, apiPost, apiGet, apiPostStream,
  getAuthToken, getAuthHeaders, checkAuth, ensureSession, getCachedAuthUser, getSessionUser, fetchAssetSignedUrl,
  hydrateProtectedImageElements } from '/modules/utils.js';
import { appStore } from '/modules/store.js';
import { installGlobalHandlers as _installErrorHub } from '/modules/error_hub.js';
import { initEdit, syncEditProject, refreshEditPage, _initEditEvents,
  removeGroupFromTimeline, isGroupImported } from '/modules/edit.js';
import { initSettings, loadSettings, saveModelSlots, getSlotConfig,
  refreshSettingsFormFromState, wireSettingsPageOnce } from '/modules/settings.js';
import { initTasks, syncTasksProject, _startMaintenanceBannerPoll } from '/modules/tasks.js';
import { initProject, getProject, setProject, loadProject, loadProjectData, saveProject,
  _serializeProject, cleanupBlobUrls, _registerServerTask, _updateServerTaskStatus,
  _notifyServerTaskDone,
  _archiveOldImage, _safeWriteBack, _flushServerSave, fetchProjectByIdShared,
  flushPendingProjectSaveOnUnload } from '/modules/project.js';
import { EPISODE_FIELDS } from '/modules/episode_fields.js';
import { initEpisodes, syncEpisodesProject,
  _ensureEpisodes, _saveCurrentEpisode, _loadEpisode, _switchEpisode,
  _getCurrentEpisodeTitle, _getPreviousEpisodeAssets,
  _renderEpisodeTabs, _openNewEpisodeDialog } from '/modules/episodes.js';
import { initVideoTasks, syncVideoTasksProject, _restoreVideoTasks, reconcileVideoTasksOnWake,
  refreshBatchPage, startBatchGeneration, generateAllVideos, generateVideoForGroup,
  getVideoResultState, subscribeVideoResultChanges, openVideoHistoryForGroup,
  downloadVideoForGroup, deleteVideoForGroup, importVideoForGroup,
  _initBatchPlayerEvents, handleVideoTaskAction,
  syncTaskListVisibility, updateBadge, createWorkflowVideoTask, importAllGeneratedSegments,
  confirmSegmentsAndEnterEdit } from '/modules/videoTasks.js';
import { initVideoPrompts, syncVideoPromptsProject, vpFetchAndCache, vpGetCache,
  refreshPromptsPage, renderVideoPromptList, renderVideoResultCard, updateVpCard, checkVideoPromptsConfirm,
  generateGroupVideoPrompt, generateAllVideoPrompts, prepareVideoPromptsForVideoGeneration,
  refineVideoPrompt, handleVideoPromptAction,
  getVpSelectedGroup, setVpSelectedGroup, flushVideoPromptAutoSave,
  reattachVideoPromptBatches } from '/modules/videoPrompts.js';
import { initShots, syncShotsProject, refreshShotsPage, renderShotList,
  generateShots, acceptShotPlanForStoryboard, handleShotAction,
  _syncSingleShotSlotsAfterInsert, _syncSingleShotSlotsAfterDelete } from '/modules/shots.js';
import { initScrollAnchorGuard } from '/modules/scroll_anchor_guard.js';
import { initStoryboard, syncStoryboardProject, getStoryboardGroups,
  refreshImagesPage, renderImageGrid,
  convertSinglePrompt, convertAllPrompts,
  updateStoryboardCard, checkImagesConfirm, generateStoryboardSheet,
  generateStoryboardTailFrame,
  generateAllImages, confirmImages, handleImageAction, scrollToCard, getSbCurrentIdx,
  reattachStoryboardBatches, registerStoryboardBatchReconciler, refreshStoryboardMaterialPanels } from '/modules/storyboard.js';
import { initScript, syncScriptProject, refreshScriptPage,
  chatClearWelcome, chatAddMsg, chatShowDots, chatRemoveDots, typewriter, chatAutoResize,
  handleScriptInput, generateScript, reviseScript,
  extractStyleBible,
  initScriptImportEvents, confirmScript, tagEmotions, renderEmotionSegments, renderScriptAnalysis,
  refreshScriptImportDraft, emotionBadgeHtml, showScriptEdit, showScriptDisplay, isScriptGenerating,
  recordManualScriptEditToTimeline, noteScriptDraftSuperseded } from '/modules/script.js';
import { initAssets, syncAssetsProject, refreshAssetsPage, extractAssets,
  renderAssets, renderAssetGrid, updateAssetCardImage, generateSingleAssetImage,
  generateAllAssetImages, checkAssetsConfirm, confirmAssets, handleAssetAction,
  saveAsWorldTemplate, openKnowledgeSnapshot,
  refreshLibraryPage, _initLibraryEvents, _openVideoLightbox,
  resetLibraryState, _showAssetActions, _restoreAssetGenStatus, _diagnoseApiError,
  _toastErrorWithActions,
  snapshotWorldTemplate, _normalizeWorldPreferredAspectRatio,
  _syncAssetToStyleBible, _getAssetDescText, _getAssetName, _autoSyncUpstream,
  _checkEquipmentChange, _detectObsoleteAssets, _removeObsoleteAssets, _showCleanObsoleteDialog,
  _markDownstreamStale, _markDownstreamStaleFallback, _getShotGroupIndices,
  _isStale, _clearStale, _applyServerStaleFlagsToProject,
  _primeWorldTemplates, _getWorldTemplates, _applyWorldTemplateReferenceFromStylePage,
  _primeStyleTemplates, _getStyleTemplates, _styleTemplatesLoaded, _applyStyleTemplateFromStylePage,
  _openLightbox } from '/modules/assets.js';
import { initToolbox, refreshToolboxPage, _initToolboxEvents } from '/modules/toolbox.js';
import { initCharacterCustom, refreshCharacterCustomPage, _initCharacterCustomEvents } from '/modules/character_custom.js';
import { initSceneCustom, refreshSceneCustomPage, _initSceneCustomEvents } from '/modules/scene_custom.js';
import { initPropCustom, refreshPropCustomPage, _initPropCustomEvents } from '/modules/prop_custom.js';
import { initBilling, loadBillingSummary, renderBillingPage, showBillingPaywall, handleBillingReturnFromUrl, refreshBillingBadge } from '/modules/billing.js';
import { mountPixelCard } from '/modules/pixel_card.js';
import { createSwLoading } from '/modules/loading.js';
import { initOnlineEditor, mountOnlineEditor, onOnlineEditorPageEnter, destroyOnlineEditor, syncOnlineEditorProject, syncOnlineEditorProjectTitle } from '/modules/online_editor.js';

// Aliases so existing code using underscore-prefixed names keeps working
var _getAuthToken = getAuthToken;
var _getAuthHeaders = getAuthHeaders;
var _checkAuth = checkAuth;
var _consumeStreamStepTags = consumeStreamStepTags;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// project/videoState live here in main.js; project.js gets a reference via initProject
var project = null;
var videoState = { tasks: [], form: { ratio: '9:16', quality: '1080p', duration: 8, startDataUrl: '', endDataUrl: '' } };
var _projectEpoch = 0;
var _projectActivationToken = 0;
var _projectSkeletonToken = 0;
var _projectActivating = false;
var _projectActivationAbort = null;
var _scriptEditInitialText = "";

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
  var PAGES = ["overview", "script", "style", "assets", "shots", "images", "prompts", "batch", "edit", "library", "characterCustom", "sceneCustom", "propCustom", "toolbox", "profile", "settings", "onlineEditor"];
  // 下线但暂不删除的工作台旧页面。保留 DOM/模块，统一阻止导航、hash 直达和历史恢复。
  var DISABLED_WORKSPACE_PAGES = ["profile", "settings"];
  var SIDEBAR_PIPELINE_PAGES = ["script", "style", "assets", "shots", "prompts", "batch", "edit"];
  var settings = {
    models: {
      text:       { key: "", base: "", model: "" },
      image:      { key: "", base: "", model: "", provider: "openai_compat" },
      multimodal: { key: "", base: "", model: "" },
      video:      { key: "", base: "", model: "", adapter: "openai_compat" },
    },
  };
  var activePage = "overview";
  var WORKSPACE_ACTIVE_PAGE_KEY = _uPrefix + "sw_workspace_active_page";
  var WORKSPACE_ACTIVE_PAGE_FALLBACK_KEY = _uPrefix + "sw_workspace_active_page_fallback";
  var WORKSPACE_ACTIVE_PAGE_STATE_KEY = "originWorkspaceActivePage";
  var WORKSPACE_ACTIVE_PAGE_HASH_KEY = "workspacePage";
  var _appBootstrapping = true;
  var _bootUserNavigated = false;
  var _bootDeferredPageRefresh = "";

  // ── 统一页面内加载层：权威态（独立 _swLoadToken，硬刷新与切项目共用）──
  var _swLoadToken = 0;
  var _swLoad = { projectId: "", token: 0, status: "loading" };
  var _swActiveLoadFailed = false;
  var _swStartupToken = 0;
  var _swLoadingUI = createSwLoading({ pages: ["assets", "shots", "prompts", "batch", "edit"] });
  function _isSwLoadCurrent(t) { return t === _swLoadToken; }
  function _pageUsesInlineLoader(p) { return p === "assets" || p === "shots" || p === "prompts" || p === "batch" || p === "edit"; }
  function _swActivationRetryOptions(options) {
    options = options || {};
    return {
      silent: !!options.silent,
      navigateToOverview: !!options.navigateToOverview,
      showSkeleton: !!options.showSkeleton,
      refreshPages: !!options.refreshPages,
      resetViewState: !!options.resetViewState,
    };
  }
  function swLoadBegin(projectId, meta) {
    meta = meta || {};
    _swActiveLoadFailed = false;
    _swLoad = {
      projectId: projectId || "",
      token: ++_swLoadToken,
      status: "loading",
      retryMode: meta.retryMode || "loadProject",
      retryOptions: meta.retryOptions || null,
    };
    _swLoadingUI.showAll();
    return _swLoad.token;
  }
  function swLoadDone(t) {
    if (!_isSwLoadCurrent(t)) return;
    _swLoad.status = "ready";
    _swLoadingUI.hideAll();
  }
  function swLoadError(t) {
    if (!_isSwLoadCurrent(t)) return;
    _swLoad.status = "error";
    _swLoadingUI.errorAll(_retryActiveLoad);
  }
  async function _retryActiveLoad() {
    var projectId = _swLoad.projectId || "";
    var retryMode = _swLoad.retryMode || "loadProject";
    var retryOptions = _swLoad.retryOptions ? Object.assign({}, _swLoad.retryOptions) : null;
    if (retryMode === "activateProject" && projectId) {
      var beforeToken = _swLoadToken;
      try {
        await _activateProjectContext(projectId, retryOptions || { showSkeleton: true, refreshPages: true, resetViewState: true });
        if (_swLoadToken === beforeToken) swLoadDone(_swLoad.token);
      } catch (e) {
        console.warn("[SwLoad] retry activate project failed:", e);
      }
      return;
    }
    var t = swLoadBegin(projectId, { retryMode: "loadProject" });
    try { await loadProject(); } catch (_) {}
    switchPage(activePage, { forceRefresh: true, skipAnimation: true });
    if (_swActiveLoadFailed) swLoadError(t); else swLoadDone(t);
  }

  var _coreNavigationBound = false;
  var onlineEditorConfig = null;
  var _onlineEditorConfigPromise = null;
  var _createProjectInFlight = false;
  var _newProjectDialogOpen = false;
  var _lastMaybeCreatedProject = null;
  var CLIENT_FEATURES = {};
  var _clientConfigPollTimer = null;

  function _normalizeWorkspacePage(page) {
    page = String(page || "");
    if (page === "online-editor") page = "onlineEditor";
    if (page === "images") page = "shots";
    if (DISABLED_WORKSPACE_PAGES.indexOf(page) !== -1) return "";
    if (PAGES.indexOf(page) === -1) return "";
    return page;
  }

  function _hasRememberedProjectHint() {
    try { return !!window.localStorage.getItem(_uPrefix + "sw_last_project_id"); } catch (_) {}
    return false;
  }

  function _isProjectWorkspacePage(page) {
    return SIDEBAR_PIPELINE_PAGES.indexOf(page) !== -1;
  }

  function _isWorkspacePageOpenable(page, options) {
    options = options || {};
    page = _normalizeWorkspacePage(page);
    if (!page) return "";
    if (_isProjectWorkspacePage(page) && !project) {
      if (options.allowUnknownProject) return page;
      if (options.allowProjectHint && _hasRememberedProjectHint()) return page;
      return "";
    }
    return page;
  }

  function _syncWorkspaceBootPage(page) {
    page = _normalizeWorkspacePage(page) || "overview";
    try { document.documentElement.setAttribute("data-workspace-boot-page", page); } catch (_) {}
  }

  function _markWorkspaceBootReady() {
    try { document.documentElement.setAttribute("data-workspace-boot-ready", "1"); } catch (_) {}
  }

  function _rememberWorkspacePage(page) {
    page = _normalizeWorkspacePage(page);
    try {
      if (!page) {
        window.sessionStorage.removeItem(WORKSPACE_ACTIVE_PAGE_KEY);
        window.localStorage.removeItem(WORKSPACE_ACTIVE_PAGE_FALLBACK_KEY);
      } else {
        window.sessionStorage.setItem(WORKSPACE_ACTIVE_PAGE_KEY, page);
        window.localStorage.setItem(WORKSPACE_ACTIVE_PAGE_FALLBACK_KEY, page);
      }
    } catch (_) {}
    try {
      var nextState = Object.assign({}, (window.history && window.history.state) || {});
      if (!page) delete nextState[WORKSPACE_ACTIVE_PAGE_STATE_KEY];
      else nextState[WORKSPACE_ACTIVE_PAGE_STATE_KEY] = page;
      if (window.history && window.history.replaceState) {
        window.history.replaceState(nextState, "", window.location.href);
      }
    } catch (_) {}
    try {
      window.location.hash = page && page !== "overview"
        ? (WORKSPACE_ACTIVE_PAGE_HASH_KEY + "=" + encodeURIComponent(page))
        : "";
    } catch (_) {}
  }

  function _readRememberedWorkspacePage(options) {
    var page = "";
    var hasWorkspacePageHash = false;
    try {
      var hash = String(window.location.hash || "");
      var prefix = "#" + WORKSPACE_ACTIVE_PAGE_HASH_KEY + "=";
      if (hash.indexOf(prefix) === 0) {
        hasWorkspacePageHash = true;
        page = decodeURIComponent(hash.slice(prefix.length));
      }
    } catch (_) {}
    if (!hasWorkspacePageHash) {
      return _isWorkspacePageOpenable("overview", options);
    }
    return _isWorkspacePageOpenable(page, options) || _isWorkspacePageOpenable("overview", options);
  }

  /* ================================================================
     持久化：设置
     ================================================================ */

  /* ================================================================
     持久化：项目
     ================================================================ */
  function _scriptEditValue() {
    var scriptTA = $("scriptOutput");
    return String((scriptTA && scriptTA.value) || "").trim();
  }

  function _resizeScriptEditTextarea() {
    var scriptTA = $("scriptOutput");
    if (!scriptTA || scriptTA.classList.contains("hidden")) return;
    scriptTA.style.height = "auto";
    scriptTA.style.height = Math.max(260, scriptTA.scrollHeight) + "px";
  }

  function _enterScriptEditMode() {
    if (isScriptGenerating()) return;
    var scriptTA = $("scriptOutput");
    if (!scriptTA) return;
    var current = String((project && (project.script || project.scriptDraft)) || scriptTA.value || "").trim();
    scriptTA.value = current;
    _scriptEditInitialText = current;
    showScriptEdit();
    if (scriptTA.classList.contains("hidden")) return;
    _resizeScriptEditTextarea();
  }

  function _saveScriptEdit() {
    var scriptTA = $("scriptOutput");
    var displayText = $("scriptDisplayText");
    if (!scriptTA) return;
    var next = _scriptEditValue();
    if (!next) {
      showToast("剧本不能为空", "warn");
      return;
    }
    var current = String((project && project.script) || "").trim();
    if (project && next !== current) {
      project.script = next;
      project.scriptDraft = next;
      project.scriptApproved = false;
      project.scriptReviewState = "modified";
      _markDownstreamStale("script", {});
      saveProject();
      // 时间线：记 draft(edit) 事件 + 改前版本沉为折叠卡
      recordManualScriptEditToTimeline(current, next);
      showToast("剧本修改已保存，下游内容已标记为需重新生成", "success");
    } else {
      showToast("剧本没有变化", "info");
    }
    if (displayText) displayText.textContent = next;
    refreshScriptImportDraft();
    renderScriptAnalysis();
    showScriptDisplay();
  }

  function _cancelScriptEdit() {
    var scriptTA = $("scriptOutput");
    var displayText = $("scriptDisplayText");
    var original = _scriptEditInitialText || String((project && project.script) || "").trim();
    if (scriptTA) {
      scriptTA.value = original;
      scriptTA.style.height = "";
    }
    if (displayText) displayText.textContent = original;
    showScriptDisplay();
  }

  function _handleScriptEditKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      _cancelScriptEdit();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && String(e.key || "").toLowerCase() === "s") {
      e.preventDefault();
      _saveScriptEdit();
    }
  }

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
  // If snap.info is present, also restore the full info field set (char/scene/prop fields).
  function _setHistoryAsCurrent(item, snapIndex) {
    if (!item || !Array.isArray(item.imageHistory)) return false;
    var snap = item.imageHistory[snapIndex];
    if (!snap) return false;
    // Snapshot current first (it'll include current info via _captureItemInfo), then the chosen snapshot replaces current.
    _archiveOldImage(item, "restore");
    // Remove the chosen snapshot from history (it's about to become current).
    item.imageHistory.splice(snapIndex, 1);
    // Recovery may come from an entry that only had a specific URL kind.
    if (snap.url) { item.imageUrl = snap.url; }
    if (snap.rawUrl) { item.rawUrl = snap.rawUrl; } else if (snap.url) { item.rawUrl = snap.url; }
    if (snap.realPhotoUrl) { item.realPhotoUrl = snap.realPhotoUrl; }
    if (snap.pencilUrl) { item.pencilUrl = snap.pencilUrl; }
    // Restore info fields if the snapshot carried them (new-style snapshot from info_changed re-extraction or post-Step2 archive).
    if (snap.info && typeof snap.info === "object") {
      Object.keys(snap.info).forEach(function (k) {
        item[k] = snap.info[k];
      });
    }
    // 还原后必须清掉两类「记忆了替换前那张图」的派生字段，否则替换看起来不生效：
    //  1) _origin* 备份：_serializeProject 存盘时会优先写 _origin* 而非 imageUrl，
    //     不清就会把替换前的旧 URL 写回后端，刷新后替换丢失。
    //  2) originalUrl/displayUrl/thumbUrl（含 pencil 变体）：hydration 时从 base URL 派生的
    //     展示字段，deriveAssetCardState 会优先读它们，不清卡片就一直显示旧图。
    // 两者都会在下一次渲染 / hydrateProjectAssetUrls 时按还原后的 base URL 重新生成。
    ["_originImageUrl", "_originRawUrl", "_originRealPhotoUrl", "_originPencilUrl",
     "originalUrl", "displayUrl", "thumbUrl",
     "pencilOriginalUrl", "pencilDisplayUrl", "pencilThumbUrl"].forEach(function (k) {
      delete item[k];
    });
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
    // 缩略图同样是受保护图（/api/images/file/…），普通 <img> 带不了 Bearer，需走 fetch→blob，否则裂图。
    hydrateProtectedImageElements(pop);
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

  // ─── 资产卡的"历史记录"全屏弹窗 ───────────────────────────────────
  // 弹窗居中、白底圆角带阴影；列表里每条历史展示图 + 关键信息；
  // 点击某条进入「已选中」高亮态；右下角"取消 / 替换"；右上角 ✕ 直接关闭。
  // onApply(snapIndex) 由调用方完成持久化，跟旧 _openHistoryPopover 一致。
  var _activeAssetHistoryModal = null;
  function _closeAssetHistoryModal() {
    if (!_activeAssetHistoryModal) return;
    try { _activeAssetHistoryModal.remove(); } catch (_) {}
    document.removeEventListener("keydown", _onAssetHistoryModalKey, true);
    _activeAssetHistoryModal = null;
  }
  function _onAssetHistoryModalKey(e) { if (e.key === "Escape") _closeAssetHistoryModal(); }

  function _formatHistoryInfoLines(snap, type) {
    // 返回 2-3 行关键信息字符串（按 type 取最显眼字段）
    var info = (snap && snap.info) || {};
    var lines = [];
    if (type === "char") {
      if (info.appearance) lines.push("外观：" + info.appearance);
      if (info.clothing) lines.push("服装：" + info.clothing);
      if (info.equipment) lines.push("随身：" + info.equipment);
      if (!lines.length && (info.role || info.identity)) lines.push((info.role || "") + (info.identity ? " · " + info.identity : ""));
    } else if (type === "scene") {
      if (info.location) lines.push("地点：" + info.location);
      if (info.timeSetting) lines.push("时间：" + info.timeSetting);
      if (info.atmosphere) lines.push("氛围：" + info.atmosphere);
    } else if (type === "prop") {
      if (info.propType) lines.push("类型：" + info.propType);
      if (info.features) lines.push("特征：" + info.features);
      if (info.material) lines.push("材质：" + info.material);
    }
    if (!lines.length) lines.push("仅图片版本（无信息快照）");
    return lines;
  }

  function _openAssetHistoryModal(item, type, onApply) {
    _closeAssetHistoryModal();
    if (!item || !Array.isArray(item.imageHistory) || !item.imageHistory.length) {
      showToast("暂无历史版本", "warn");
      return;
    }
    var typeLabel = type === "char" ? "角色" : type === "scene" ? "场景" : "道具";

    var overlay = document.createElement("div");
    overlay.id = "assetHistoryModal";
    overlay.style.cssText = [
      "position:fixed","inset:0","z-index:10003",
      "background:rgba(11,19,32,0.45)","backdrop-filter:blur(4px)",
      "display:flex","align-items:center","justify-content:center","padding:32px",
    ].join(";");

    var card = document.createElement("div");
    card.style.cssText = [
      "background:#ffffff","border-radius:24px","width:min(720px,100%)","max-height:80vh",
      "display:flex","flex-direction:column","overflow:hidden",
      "box-shadow:0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)",
      "border:1px solid rgba(0,0,0,0.06)",
    ].join(";");

    // header
    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid rgba(144,164,174,0.18)";
    header.innerHTML =
      '<div>' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:0.18em;color:#90A4AE;text-transform:uppercase">History</div>' +
        '<div style="font-size:18px;font-weight:700;color:#0B1320;margin-top:2px">' + typeLabel + '历史版本（共 ' + item.imageHistory.length + '）</div>' +
        '<div style="font-size:12px;color:#546E7A;margin-top:2px">' + (item.name || "") + '</div>' +
      '</div>' +
      '<button type="button" class="ahm-close" aria-label="关闭" style="background:transparent;border:none;cursor:pointer;color:#546E7A;font-size:20px;line-height:1;padding:6px 8px;border-radius:8px">✕</button>';
    card.appendChild(header);

    // list
    var list = document.createElement("div");
    list.style.cssText = "flex:1;overflow-y:auto;padding:16px 24px;display:flex;flex-direction:column;gap:12px";

    var _selectedIdx = -1;
    item.imageHistory.forEach(function (snap, hi) {
      var row = document.createElement("div");
      row.dataset.hi = String(hi);
      row.className = "ahm-row";
      row.style.cssText = [
        "display:flex","gap:16px","padding:14px","border-radius:16px",
        "background:#F5F7FA","border:2px solid transparent","cursor:pointer",
        "transition:all .15s ease","align-items:center",
      ].join(";");
      var u = snap.url || snap.rawUrl || snap.realPhotoUrl || snap.pencilUrl || "";
      var dateStr = snap.at ? new Date(snap.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      var srcTag = snap.source === "info_changed" ? "信息变更归档" : (snap.source ? snap.source : "");
      var infoLines = _formatHistoryInfoLines(snap, type);

      var thumb = u
        ? '<img src="' + String(u).replace(/"/g,"&quot;") + '" alt="v' + (hi + 1) + '" style="width:96px;height:96px;object-fit:cover;border-radius:12px;flex-shrink:0;background:#ECEFF1" />'
        : '<div style="width:96px;height:96px;border-radius:12px;background:#ECEFF1;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#90A4AE;font-size:11px">无图</div>';

      var infoHtml = infoLines.map(function (ln) {
        return '<div style="font-size:12px;color:#37474F;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + _escapeHtml(ln) + '</div>';
      }).join("");

      row.innerHTML = thumb +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
            '<span style="font-weight:700;color:#0B1320;font-size:14px">v' + (hi + 1) + '</span>' +
            (dateStr ? '<span style="font-size:11px;color:#90A4AE">' + dateStr + '</span>' : '') +
            (srcTag ? '<span style="font-size:10px;color:#546E7A;background:rgba(11,19,32,0.06);padding:2px 8px;border-radius:999px">' + _escapeHtml(srcTag) + '</span>' : '') +
          '</div>' +
          infoHtml +
        '</div>';

      row.addEventListener("click", function () {
        if (_selectedIdx >= 0) {
          var prev = list.querySelector('[data-hi="' + _selectedIdx + '"]');
          if (prev) {
            prev.style.background = "#F5F7FA";
            prev.style.borderColor = "transparent";
          }
        }
        _selectedIdx = hi;
        row.style.background = "rgba(11,19,32,0.04)";
        row.style.borderColor = "#0B1320";
        replaceBtn.disabled = false;
        replaceBtn.style.opacity = "1";
        replaceBtn.style.cursor = "pointer";
      });
      list.appendChild(row);
    });
    card.appendChild(list);

    // footer
    var footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:12px;padding:16px 24px;border-top:1px solid rgba(144,164,174,0.18);background:#FAFBFC";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:10px 24px;border-radius:999px;background:#ECEFF1;border:none;color:#37474F;font-size:13px;font-weight:600;cursor:pointer";
    var replaceBtn = document.createElement("button");
    replaceBtn.type = "button";
    replaceBtn.textContent = "替换";
    replaceBtn.disabled = true;
    replaceBtn.style.cssText = "padding:10px 28px;border-radius:999px;background:#0B1320;border:none;color:#fff;font-size:13px;font-weight:700;cursor:not-allowed;opacity:0.4;transition:opacity .15s";
    footer.appendChild(cancelBtn);
    footer.appendChild(replaceBtn);
    card.appendChild(footer);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    // 历史缩略图是受保护图（/api/images/file/…），普通 <img> 带不了 Bearer，
    // 必须走 fetch→blob 流程才能显示，否则裂图。和资产卡渲染后的处理保持一致。
    hydrateProtectedImageElements(overlay);

    // wire close + outside click + escape
    header.querySelector(".ahm-close").addEventListener("click", _closeAssetHistoryModal);
    cancelBtn.addEventListener("click", _closeAssetHistoryModal);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) _closeAssetHistoryModal();
    });
    replaceBtn.addEventListener("click", function () {
      if (_selectedIdx < 0) return;
      var idxToApply = _selectedIdx;
      _closeAssetHistoryModal();
      try { onApply(idxToApply); } catch (err) { console.error("[AssetHistoryModal] apply failed:", err); }
    });

    _activeAssetHistoryModal = overlay;
    document.addEventListener("keydown", _onAssetHistoryModalKey, true);
  }

  function _escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c];
    });
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
          '<button type="button" id="expandConfirm" class="flex-1 py-3 rounded-full text-sm font-bold text-on-primary bg-primary hover:opacity-90 transition-all shadow-lg flex items-center justify-center gap-2" data-write-action>' +
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
	      var _expandPrevScript = String(project.script || "");
	      project.script = resp.script || "";
	      project.scriptDraft = resp.script || "";
	      // 后端 expand 已落库 version+1，对齐内存 version 避免随后的 PUT 撞 409
	      if (typeof resp.serverVersion === "number" && resp.serverVersion > (Number(project.version) || 0)) {
	        project.version = resp.serverVersion;
	      }
	      // 后端已 append 时间线；同步回内存，避免随后的整项目 PUT 用旧数组盖掉
	      if (Array.isArray(resp.scriptTimeline)) project.scriptTimeline = resp.scriptTimeline;
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
      project.scriptReviewState = "draft";
      saveProject();

      if (resp.clearedDownstream) {
        showToast("剧本已扩充。后续步骤数据已重置，请重新确认剧本。", "info");
      } else {
        showToast("剧本扩充完成！", "success");
      }
      overlay.remove();
      refreshScriptPage();
      // 时间线：扩充前的版本沉为折叠卡
      if (_expandPrevScript.trim() && _expandPrevScript.trim() !== String(resp.script || "").trim()) {
        noteScriptDraftSuperseded(_expandPrevScript);
      }
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

  function _cleanProjectName(value) {
    return String(value || "").trim();
  }

  function _nextDefaultProjectNameFromList(list) {
    var used = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item) return;
      [_cleanProjectName(item.name), _cleanProjectName(item.title)].forEach(function (name) {
        if (name) used[name] = true;
      });
    });
    if (!used["新项目"]) return "新项目";
    for (var i = 2; i < 10000; i++) {
      var candidate = "新项目" + i;
      if (!used[candidate]) return candidate;
    }
    return "新项目" + Date.now();
  }

  function _resolveNewProjectName(name, list) {
    return _cleanProjectName(name) || _nextDefaultProjectNameFromList(list);
  }

  function _newProjectWorldTemplateIdOf(tpl) {
    return String(tpl && (tpl.id || tpl.templateId || tpl.template_id) || "").trim();
  }

  async function _fetchWorldTemplateOptionsForNewProject() {
    try { await _primeWorldTemplates(); } catch (_) {}
    var cached = _getWorldTemplates();
    if (cached && cached.length) return cached;

    var resp = await fetch("/api/world-templates", { headers: _getAuthHeaders() });
    if (!resp.ok) throw new Error("世界观模板列表加载失败 (" + resp.status + ")");
    var body = await resp.json().catch(function () { return {}; });
    return (body && (body.templates || body.items)) || [];
  }

  async function _fetchWorldTemplateDetailForNewProject(tplId) {
    var resp = await fetch("/api/world-templates/" + encodeURIComponent(tplId), {
      headers: _getAuthHeaders(),
    });
    if (!resp.ok) throw new Error("世界观模板加载失败 (" + resp.status + ")");
    var body = await resp.json().catch(function () { return {}; });
    if (!body || !body.template) throw new Error("世界观模板数据为空");
    return body.template;
  }

  async function _decorateNewProjectDraftWithWorldTemplate(draft, tplId, options) {
    tplId = String(tplId || "").trim();
    if (!draft || !tplId) return draft;
    options = options || {};
    if (typeof options.onStatus === "function") options.onStatus("正在载入世界观模板…");

    var fullTpl = await _fetchWorldTemplateDetailForNewProject(tplId);
    var snap = snapshotWorldTemplate(fullTpl);
    draft.selectedWorldTemplateId = snap.id || tplId;
    draft.worldTemplateSnapshot = snap;

    var tplAspect = _normalizeWorldPreferredAspectRatio(
      snap.preferredAspectRatio || snap.preferred_aspect_ratio
    );
    if (tplAspect) {
      draft.styleOptions = Object.assign({}, draft.styleOptions || {}, {
        aspectRatio: tplAspect,
        aspectRatioDefaultVersion: _STYLE_ASPECT_DEFAULT_VERSION || "2026-05-14-9x16",
      });
    }
    return draft;
  }

  async function _resolveDefaultNewProjectNameForDialog() {
    try {
      var list = await getProjectListFromServer();
      if (!Array.isArray(list)) list = [];
      return _resolveNewProjectName("", list);
    } catch (_) {
      return _resolveNewProjectName("", getProjectList());
    }
  }

  function _openNewProjectDialog(options) {
    if (_newProjectDialogOpen) return;
    options = options || {};
    _newProjectDialogOpen = true;

    var overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
    overlay.style.animation = "fadeIn .2s ease";

    var fallbackName = _resolveNewProjectName("", getProjectList());
    overlay.innerHTML =
      '<div class="bg-surface-container-lowest rounded-[2rem] p-8 w-[480px] max-w-[90vw] shadow-2xl border border-white/30" onclick="event.stopPropagation()">' +
        '<div class="flex items-center justify-between mb-1">' +
          '<h3 class="text-lg font-bold text-on-background">创建新任务</h3>' +
          '<button type="button" id="npClose" class="text-on-surface-variant hover:text-primary transition-all" title="关闭">' +
            '<span class="material-symbols-outlined">close</span>' +
          '</button>' +
        '</div>' +
        '<p class="text-xs text-on-surface-variant mb-4">从空白任务开始，或先带入一个世界观模板，再进入剧本页继续创作。</p>' +
        '<div class="mb-4">' +
          '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">任务名称</label>' +
          '<input id="npName" type="text" class="w-full bg-surface-container-low rounded-xl p-2.5 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none" />' +
        '</div>' +
        '<div class="mb-6 space-y-2">' +
          '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">世界观</label>' +
          '<label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">' +
            '<input type="radio" name="npMode" value="blank" checked />新建空白任务' +
          '</label>' +
          '<label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">' +
            '<input type="radio" name="npMode" value="template" />选择世界观模板' +
          '</label>' +
          '<select id="npWorldSelect" class="w-full bg-surface-container-low rounded-xl p-2.5 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none">' +
            '<option value="">加载中…</option>' +
          '</select>' +
        '</div>' +
        '<div class="flex gap-3">' +
          '<button type="button" id="npCancel" class="flex-1 py-3 rounded-full text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-all">取消</button>' +
          '<button type="button" id="npConfirm" class="flex-1 py-3 rounded-full text-sm font-bold text-on-primary bg-primary hover:opacity-90 transition-all shadow-lg flex items-center justify-center gap-2">' +
            '<span class="material-symbols-outlined text-sm">add</span>确认' +
          '</button>' +
        '</div>' +
        '<p id="npStatus" class="text-xs text-center text-on-surface-variant mt-4" hidden></p>' +
      '</div>';

    document.body.appendChild(overlay);

    var nameInput = overlay.querySelector("#npName");
    var selectEl = overlay.querySelector("#npWorldSelect");
    var statusEl = overlay.querySelector("#npStatus");
    var state = { nameDirty: false };
    if (nameInput) {
      nameInput.value = fallbackName;
      nameInput.addEventListener("input", function () { state.nameDirty = true; });
      try { nameInput.focus({ preventScroll: true }); nameInput.select(); } catch (_) {}
    }

    function close() {
      overlay.remove();
      _newProjectDialogOpen = false;
    }

    function syncSelectEnabled() {
      var mode = overlay.querySelector('input[name="npMode"]:checked');
      var useTpl = mode && mode.value === "template";
      if (!selectEl) return;
      selectEl.disabled = !useTpl;
      selectEl.classList.toggle("opacity-60", !useTpl);
      selectEl.classList.toggle("pointer-events-none", !useTpl);
    }

    overlay.querySelectorAll('input[name="npMode"]').forEach(function (r) {
      r.addEventListener("change", syncSelectEnabled);
    });
    syncSelectEnabled();

    _resolveDefaultNewProjectNameForDialog().then(function (name) {
      if (!overlay.isConnected || state.nameDirty || !nameInput) return;
      nameInput.value = name;
    });

    _fetchWorldTemplateOptionsForNewProject().then(function (templates) {
      if (!overlay.isConnected || !selectEl) return;
      if (!templates.length) {
        selectEl.innerHTML = '<option value="">（暂无世界观模板）</option>';
        syncSelectEnabled();
        return;
      }
      selectEl.innerHTML = templates.map(function (tpl) {
        var rawId = _newProjectWorldTemplateIdOf(tpl);
        var id = escapeHtml(rawId);
        var name = escapeHtml(String(tpl.name || tpl.id || "未命名模板"));
        return '<option value="' + id + '">' + name + '</option>';
      }).join("");
      syncSelectEnabled();
    }).catch(function (e) {
      if (!overlay.isConnected || !selectEl) return;
      selectEl.innerHTML = '<option value="">（模板列表加载失败）</option>';
      showToast(((e && e.message) || e).toString(), "warn");
      syncSelectEnabled();
    });

    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) close(); });
    overlay.querySelector("#npClose").addEventListener("click", close);
    overlay.querySelector("#npCancel").addEventListener("click", close);
    overlay.querySelector("#npConfirm").addEventListener("click", async function () {
      var confirmBtn = overlay.querySelector("#npConfirm");
      var mode = overlay.querySelector('input[name="npMode"]:checked');
      var useTemplate = mode && mode.value === "template";
      var tplId = useTemplate && selectEl ? String(selectEl.value || "").trim() : "";
      if (useTemplate && !tplId) {
        showToast("请选择一个世界观模板，或改为新建空白任务", "warn");
        return;
      }
      var name = nameInput ? nameInput.value.trim() : "";
      if (confirmBtn) confirmBtn.disabled = true;
      if (statusEl) { statusEl.hidden = false; statusEl.textContent = "正在创建任务…"; }
      try {
        var ok = await createNewProject(name, {
          worldTemplateId: tplId,
          onStatus: function (text) {
            if (statusEl) { statusEl.hidden = false; statusEl.textContent = text; }
          },
        });
        if (ok !== false) {
          close();
          if (typeof options.afterCreated === "function") await options.afterCreated();
        } else if (confirmBtn) {
          confirmBtn.disabled = false;
          if (statusEl) statusEl.textContent = "创建未完成，请检查提示后重试。";
        }
      } catch (e) {
        var errMsg = ((e && e.message) || e).toString().slice(0, 160);
        if (statusEl) statusEl.textContent = "创建失败: " + errMsg;
        if (confirmBtn) confirmBtn.disabled = false;
        showToast("新建任务失败: " + _diagnoseApiError(errMsg), "error");
      }
    });
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

  function _resetProjectRuntime() {
    setVpSelectedGroup(0);
    resetLibraryState();

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
      "imagesActionBar",
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

  function _resetProjectViewState() {
    var chatBox = $("chatMessages");
    if (chatBox) {
      var innerWrap = chatBox.querySelector(".max-w-2xl") || chatBox;
      var msgs = innerWrap.querySelectorAll(".chat-msg:not(#scriptResultCard)");
      msgs.forEach(function (m) { m.parentNode.removeChild(m); });
    }
  }

  function _resetProjectUI() {
    _resetProjectRuntime();
    _resetProjectViewState();
  }

  function _isProjectActivationCurrent(token) {
    return token && token === _projectActivationToken;
  }

  function _setProjectActivating(on, token) {
    if (on) {
      _projectActivating = true;
      if (document.body) document.body.classList.add("is-activating");
      return;
    }
    if (token && !_isProjectActivationCurrent(token)) return;
    _projectActivating = false;
    if (document.body) document.body.classList.remove("is-activating");
  }

  function _syncProjectModules(nextProject) {
    syncEditProject(nextProject);
    syncTasksProject(nextProject);
    syncVideoTasksProject(nextProject);
    syncVideoPromptsProject(nextProject);
    syncShotsProject(nextProject);
    syncStoryboardProject(nextProject);
    syncScriptProject(nextProject);
    syncAssetsProject(nextProject);
    syncEpisodesProject(nextProject);
    syncOnlineEditorProject(nextProject);
  }

  async function _activateProjectContext(projId, options) {
    options = options || {};
    if (!projId) return null;
    var token = ++_projectActivationToken;
    var swT = 0;
    var useSkeleton = !!options.showSkeleton;
    if (_projectActivationAbort) {
      try { _projectActivationAbort.abort(); } catch (_) {}
      _projectActivationAbort = null;
    }
    var activationCtl = (typeof AbortController === "function") ? new AbortController() : null;
    _projectActivationAbort = activationCtl;
    _setProjectActivating(true);
    if (useSkeleton) {
      _projectSkeletonToken = token;
      _showProjectSkeleton(true);
    }
    try {
      if (project && project.id === projId) return project;
      swT = swLoadBegin(projId, {
        retryMode: "activateProject",
        retryOptions: _swActivationRetryOptions(options),
      });
      if (project && project.id && project.id !== projId) {
        try { await _flushServerSave(); }
        catch (e) { console.warn("[activateProject] flush before switch failed:", e); }
        if (!_isProjectActivationCurrent(token)) return null;
      }

      var p = await fetchProjectByIdShared(projId, {
        signal: activationCtl ? activationCtl.signal : undefined,
        force: true,
        throwOnError: true,
      });
      if (!_isProjectActivationCurrent(token)) return null;
      if (!p || !p.id) throw new Error("项目详情返回异常：缺少项目 ID，请刷新后重试。");

      var oldProject = project;
      _resetProjectRuntime(oldProject);
      if (options.resetViewState) _resetProjectViewState();

      project = p;
      cleanupBlobUrls(project);
      // Phase 5.9：只记 projectId 这一个 key；不再 mirror 整包到 localStorage。
      try { localStorage.setItem(_uPrefix + "sw_last_project_id", project.id); } catch (_) {}
      _ovSelectCurrentProjectTask();
      _syncProjectModules(project);
      _ensureEpisodes();

      if (options.refreshPages) refreshAllPages();
      var restored = _restoreVideoTasks({
        projectId: project.id,
        isCurrent: function () { return _isProjectActivationCurrent(token); },
      });
      if (restored && typeof restored.then === "function") {
        await restored;
        if (!_isProjectActivationCurrent(token)) return null;
      }
      _renderEpisodeTabs();
      _loadProjectProfileOverride();
      if (options.navigateToOverview) switchPage("overview");
      console.log("[Project] Loaded from server:", project.name, "v=", project.version);
      swLoadDone(swT);
      return project;
    } catch (e) {
      swLoadError(swT);
      throw e;
    } finally {
      if (_projectActivationAbort === activationCtl) _projectActivationAbort = null;
      if (useSkeleton && _projectSkeletonToken === token) {
        _showProjectSkeleton(false);
        _projectSkeletonToken = 0;
      }
      _setProjectActivating(false, token);
    }
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
      await _activateProjectContext(projId, {
        silent: false,
        navigateToOverview: true,
        showSkeleton: true,
        refreshPages: true,
        resetViewState: true,
      });
    } catch (e) {
      console.error("[Project] Switch error:", e);
      showToast("切换项目失败", "error");
    }
  }

  async function _loadProjectFromServerAndSwitch(projId) {
    try {
      await _activateProjectContext(projId, {
        silent: false,
        navigateToOverview: true,
        showSkeleton: true,
        refreshPages: true,
        resetViewState: true,
      });
    } catch (e) {
      console.error("[Project] Server load failed:", e);
      showToast("加载项目失败", "error");
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
          syncOnlineEditorProject(null);
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
    if (activePage === "characterCustom") {
      try { refreshCharacterCustomPage({ force: true }); } catch (e) { console.error("[RefreshAll] characterCustom:", e); }
    }
    if (activePage === "sceneCustom") {
      try { refreshSceneCustomPage({ force: true }); } catch (e) { console.error("[RefreshAll] sceneCustom:", e); }
    }
    if (activePage === "propCustom") {
      try { refreshPropCustomPage({ force: true }); } catch (e) { console.error("[RefreshAll] propCustom:", e); }
    }
    try { refreshToolboxPage(); } catch (e) { console.error("[RefreshAll] toolbox:", e); }
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
    if (on === true && _pageUsesInlineLoader(activePage)) return;
    if (on) {
      if (_projectSkeletonEl) { _projectSkeletonEl.style.display = "flex"; }
      else {
        var el = document.createElement("div");
        el.id = "sw-project-skeleton";
        el.style.cssText = "position:fixed;inset:0;z-index:55;display:flex;pointer-events:none;" +
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
      var resp = await fetch("/api/config/client", { headers: _getAuthHeaders(), cache: "no-store" });
      if (!resp.ok) return;
      var cfg = await resp.json();
      var limits = cfg && cfg.limits && typeof cfg.limits === "object" ? cfg.limits : {};
      if (cfg && cfg.features && typeof cfg.features === "object") CLIENT_FEATURES = cfg.features;
      if (cfg && typeof cfg.maxProjects === "number") MAX_PROJECTS = cfg.maxProjects;
      else if (typeof limits.maxProjects === "number") MAX_PROJECTS = limits.maxProjects;
      if (cfg && typeof cfg.maxConcurrent === "number") MAX_CONCURRENT = cfg.maxConcurrent;
      else if (typeof limits.maxConcurrentVideoTasks === "number") MAX_CONCURRENT = limits.maxConcurrentVideoTasks;
      if (cfg && typeof cfg.maxTasksTotal === "number") MAX_TASKS_TOTAL = cfg.maxTasksTotal;
      else if (typeof limits.maxTasksTotal === "number") MAX_TASKS_TOTAL = limits.maxTasksTotal;
    } catch (e) {
      console.warn("[ClientConfig] fetch failed, keeping defaults:", e);
    }
  }

  function _startClientConfigPoll() {
    if (_clientConfigPollTimer) return;
    _clientConfigPollTimer = setInterval(function () {
      _loadClientConfig();
    }, 60000);
  }

  function _clientFeatureEnabled(key, fallback) {
    if (!CLIENT_FEATURES || typeof CLIENT_FEATURES !== "object") return fallback !== false;
    if (Object.prototype.hasOwnProperty.call(CLIENT_FEATURES, key)) return CLIENT_FEATURES[key] !== false;
    return fallback !== false;
  }

  function _newClientRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (_) {}
    return "cr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
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
  async function createNewProject(name, options) {
    if (_createProjectInFlight) {
      showToast("正在创建任务，请稍候", "info");
      return false;
    }
    options = options || {};
    _createProjectInFlight = true;
    try {
      return await _createNewProjectLocked(name, options);
    } finally {
      _createProjectInFlight = false;
    }
  }

  async function _recoverMaybeCreatedProject(name) {
    var marker = _lastMaybeCreatedProject;
    if (!marker || Date.now() - marker.at > 60000) {
      _lastMaybeCreatedProject = null;
      return false;
    }
    var list = await getProjectListFromServer();
    var expected = _cleanProjectName(name || marker.name) || "新项目";
    var hit = (list || []).find(function (item) {
      return item && marker.clientRequestId && item.clientRequestId === marker.clientRequestId;
    });
    if (!hit) {
      hit = (list || []).find(function (item) {
        if (!item || !(item.name === expected || item.title === expected)) return false;
        var createdMs = Date.parse(item.createdAt || "");
        return Number.isFinite(createdMs) ? createdMs >= marker.at - 60000 : true;
      });
    }
    if (!hit || !hit.id) return false;
    _lastMaybeCreatedProject = null;
    showToast("检测到刚才的任务已创建，正在打开", "info");
    await _activateProjectContext(hit.id, { resetViewState: true, refreshPages: true, showSkeleton: true });
    return true;
  }

  async function _createNewProjectLocked(name, options) {
    options = options || {};
    if (await _recoverMaybeCreatedProject(name)) return true;
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
      try { await _loadClientConfig(); } catch (_) {}
    }
    if (list.length >= MAX_PROJECTS) {
      showToast("最多保存 " + MAX_PROJECTS + " 个项目，请先删除旧项目", "warn");
      return false;
    }
    var projectName = _resolveNewProjectName(name, list);

    // Phase 5.2：切出当前项目前，先把最后的改动刷到后端，再起新项目。
    if (project && project.id) {
      try { await _flushServerSave(); }
      catch (_e) { console.warn("[createNewProject] flushServerSave failed:", _e); }
    }

    var epId = "ep_" + Date.now();
    var clientRequestId = _newClientRequestId();
    var draft = {
      id: "proj_" + Date.now(),
      clientRequestId: clientRequestId,
      name: projectName,
      createdAt: Date.now(),
      currentStep: 1,
      idea: "",
      script: "",
      scriptTargetDurationSec: null,
      scriptApproved: false,
      scriptReviewState: "",
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
        idea: "", script: "", scriptTargetDurationSec: null, scriptApproved: false, scriptReviewState: "",
        assets: null, assetsApproved: false,
        shots: [], shotsApproved: false,
        storyboards: [], imagesApproved: false,
        videoPrompts: [], videoPromptsApproved: false,
        narrations: [], currentStep: 1
      }],
      currentEpisodeIdx: 0,
    };
    await _decorateNewProjectDraftWithWorldTemplate(draft, options.worldTemplateId, options);
    if (typeof options.onStatus === "function") options.onStatus("正在创建任务…");

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
        if (resp.status >= 500) {
          _lastMaybeCreatedProject = { name: projectName, clientRequestId: clientRequestId, at: Date.now() };
        }
      }
    } catch (e) {
      console.warn("[createNewProject] POST /api/projects failed:", e);
      _lastMaybeCreatedProject = { name: projectName, clientRequestId: clientRequestId, at: Date.now() };
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

    return await _finalizeCreatedProject(serverProj);
  }

  /**
   * 创建成功后的统一收尾：加入列表 → 激活上下文 → 概览任务列表同步 → 刷新。
   * createNewProject 与"续写下一集"（episodes.js 新弹窗，经 ctx.finalizeCreatedProject）
   * 共用这一份，避免双实现漂移（docs/series-episode-continue-plan.md §7）。
   */
  async function _finalizeCreatedProject(serverProj) {
    if (_clientFeatureEnabled("projectActivationGuard", true)) {
      addProjectToList(serverProj);
      var activated = await _activateProjectContext(serverProj.id, {
        resetViewState: true,
        refreshPages: true,
        showSkeleton: true,
      });
      if (!activated || !project || project.id !== serverProj.id) {
        showToast("任务已创建，但打开失败，请刷新后重试", "warn");
        return false;
      }
    } else {
      project = serverProj;
      try { localStorage.setItem(_uPrefix + "sw_last_project_id", project.id); } catch (_) {}
      _syncProjectModules(project);
      addProjectToList(project);
      refreshAllPages();
    }
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
      // iframe 保活：切页不再销毁在线精修 iframe（方案：在线精修iframe保活-方案.md）。
      // 跨项目销毁走 _syncProjectModules 里的 syncOnlineEditorProject；假活走进页 ping 对账。
      if (page === "overview") refreshOverview();
      if (page === "script") refreshScriptPage();
      if (page === "style") refreshStylePage();
      if (page === "assets") refreshAssetsPage();
      if (page === "shots") {
        refreshShotsPage();
        refreshImagesPage();
      }
      if (page === "prompts") refreshPromptsPage();
      if (page === "batch") refreshBatchPage();
      if (page === "edit") refreshEditPage();
      if (page === "onlineEditor") {
        onOnlineEditorPageEnter();
        mountOnlineEditor();
      }
      if (page === "library") refreshLibraryPage();
      if (page === "characterCustom") refreshCharacterCustomPage();
      if (page === "sceneCustom") refreshSceneCustomPage();
      if (page === "propCustom") refreshPropCustomPage();
      if (page === "toolbox") refreshToolboxPage();
    } catch (e) {
      console.error("[SwitchPage] refresh failed:", page, e);
    }
  }

  function _normalizeOnlineEditorConfig(data) {
    data = data || {};
    var missingKeys = Array.isArray(data.missingKeys) ? data.missingKeys : [];
    var enabled = data.enabled === true;
    var configured = enabled && data.configured === true;
    var reason = data.reason || (enabled ? (configured ? "ok" : "missing_config") : "disabled");
    var openMode = data.openMode === "tab" ? "tab" : "iframe";
    var iframeUrl = data.iframeProjectUrl || data.iframeUrl || data.iframeBaseUrl || "";
    return {
      enabled: enabled,
      configured: configured,
      reason: reason,
      missingKeys: missingKeys,
      openMode: openMode,
      iframeBaseUrl: data.iframeBaseUrl || data.iframeUrl || "",
      iframeProjectUrl: data.iframeProjectUrl || iframeUrl || "",
      iframeUrl: iframeUrl || "",
      apiBase: data.apiBase || "",
      message: data.message || "",
    };
  }

  function getOnlineEditorConfig() {
    return onlineEditorConfig;
  }

  function loadOnlineEditorConfig(options) {
    options = options || {};
    if (onlineEditorConfig && !options.force) return Promise.resolve(onlineEditorConfig);
    if (_onlineEditorConfigPromise && !options.force) return _onlineEditorConfigPromise;
    _onlineEditorConfigPromise = fetch("/api/volcengine/config", { headers: getAuthHeaders() })
      .then(function (res) {
        if (!res.ok) throw new Error("配置读取失败 (" + res.status + ")");
        return res.json();
      })
      .then(function (data) {
        onlineEditorConfig = _normalizeOnlineEditorConfig(data);
        return onlineEditorConfig;
      })
      .catch(function (err) {
        console.warn("[OnlineEditor] config load failed:", err);
        onlineEditorConfig = null;
        throw err;
      })
      .finally(function () {
        _onlineEditorConfigPromise = null;
      });
    return _onlineEditorConfigPromise;
  }

  function openOnlineEditorFromEntry() {
    var cfg = getOnlineEditorConfig();
    if (!cfg) {
      showToast("在线精修配置正在读取，请稍后再试", "info");
      try { loadOnlineEditorConfig({ force: true }).catch(function () {}); } catch (_) {}
      return;
    }
    if (!cfg.enabled) {
      showToast("在线精修剪辑器当前未启用", "info");
      return;
    }
    if (!cfg.configured) {
      switchPage("onlineEditor", { user: true });
      return;
    }
    if (cfg.openMode === "tab") {
      var targetUrl = cfg.iframeProjectUrl || cfg.iframeUrl;
      if (!targetUrl) {
        showToast("在线精修打开地址未配置", "error");
        return;
      }
      var win = window.open(targetUrl, "_blank", "noopener");
      if (!win) showToast("浏览器拦截了新标签页，请允许弹窗后重试", "error");
      return;
    }
    switchPage("onlineEditor", { user: true });
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

  function _syncFixedWorkbenchRoute(page) {
    var isOnlineEditor = page === "onlineEditor";
    var isPrompts = page === "prompts";
    var locked = page === "script" || page === "style" || page === "edit" || isPrompts || isOnlineEditor;
    [document.documentElement, document.body].forEach(function (node) {
      if (!node) return;
      node.classList.toggle("is-fixed-workbench-page", locked);
      node.classList.toggle("is-script-workbench-page", page === "script");
      node.classList.toggle("is-style-workbench-page", page === "style");
      node.classList.toggle("is-prompts-workbench-page", isPrompts);
      node.classList.toggle("is-edit-workbench-page", page === "edit");
      node.classList.toggle("is-online-editor-page", isOnlineEditor);
    });
  }

  function switchPage(page, options) {
    options = options || {};
    // TODO(remove-after-phase7): remove legacy online-editor route alias once Online Editor Phase 7 passes.
    // billing 不再是独立 page，而是浮层弹窗，提前 return 不影响当前 activePage
    if (page === "billing") { openBillingModal(); return; }
    page = _normalizeWorkspacePage(page);
    if (!page) return;
    if (activePage === "prompts" && page !== "prompts") {
      flushVideoPromptAutoSave().catch(function (e) { console.warn("[VideoPromptDraft] leave-page flush failed:", e); });
    }
    _rememberWorkspacePage(page);
    if (options.user && _appBootstrapping) _bootUserNavigated = true;
    activePage = page;
    _syncFixedWorkbenchRoute(page);
    var activePageEl = null;
    for (var i = 0; i < PAGES.length; i++) {
      var pid = "page" + PAGES[i].charAt(0).toUpperCase() + PAGES[i].slice(1);
      var el = $(pid);
      if (el) {
        var show = PAGES[i] === page;
        if (show) {
          activePageEl = el;
          el.hidden = false;
          if (options.skipAnimation) {
            el.classList.remove("page-enter-anim");
          } else {
            el.classList.remove("page-enter-anim");
            void el.offsetWidth;
            el.classList.add("page-enter-anim");
            setTimeout(function (node) {
              return function () { if (node) node.classList.remove("page-enter-anim"); };
            }(el), 320);
          }
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
      if (navEl) navEl.addEventListener("click", function () {
        if (_projectActivating) return;
        switchPage(page, { user: true });
      });
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
      if (el) {
        e.preventDefault();
        if (_projectActivating) return;
        if (el.dataset.goto === "onlineEditor" || el.dataset.goto === "online-editor") {
          openOnlineEditorFromEntry();
          return;
        }
        switchPage(el.dataset.goto, { user: true });
      }
    });

    // Batch switch status labels
    var batchAudio = $("batchAudio");
    var batchWatermark = $("batchWatermark");
    if (batchAudio) {
      batchAudio.addEventListener("change", function () {
        batchAudio.dataset.userTouched = "1";
        var statusEl = document.querySelector(".batch-switch-status[data-for='batchAudio']");
        if (statusEl) statusEl.textContent = batchAudio.checked ? "有音频" : "无音频";
      });
    }
    if (batchWatermark) {
      batchWatermark.addEventListener("change", function () {
        batchWatermark.dataset.userTouched = "1";
        var statusEl = document.querySelector(".batch-switch-status[data-for='batchWatermark']");
        if (statusEl) statusEl.textContent = batchWatermark.checked ? "有水印" : "无水印";
      });
    }
  }

  /* ================================================================
     全局唤醒对账（2026-06）
     ----------------------------------------------------------------
     修"切走再回来 / 电脑睡醒 / 网络恢复后，任务完成了页面不刷新"：
     focus / visibilitychange→visible / online 时把"后台批次重挂/补课"
     分发到各模块。storyboard 原本就有自己的 reconciler（focus/visibility/
     interval），这里补 videoPrompts / assets / videoTasks 三家，并给
     四家都盖上 online 事件。
     幂等性依据：videoPrompts 有 _vpAttachedBatchesByKey、assets 有
     _reattachedBatchKeys、storyboard 有 _shouldSkipStoryboardRunningReattach、
     videoTasks 走 reconcileVideoTasksOnWake（本地有活跃闭包就不动）；
     /api/batch/active 走 getActiveBatchesShared 共享缓存，一次唤醒
     不会放大成多个 GET。
     ================================================================ */
  var _globalBatchReconcilerBound = false;
  var _globalBatchReconcileLastAt = 0;
  function _registerGlobalBatchReconciler() {
    if (_globalBatchReconcilerBound) return;
    _globalBatchReconcilerBound = true;
    // 节流只限"两次对账的最小间隔"（focus/visibilitychange 常成对触发），
    // 首次触发不等待。5s 与 getActiveBatchesShared 缓存 TTL(5s) 对齐——
    // 降得更低拿到的也是同一份缓存，没有意义。
    var THROTTLE_MS = 5000;
    function run(reason) {
      if (!project || !project.id) return;
      if (_projectActivating) return;
      var now = Date.now();
      if (now - _globalBatchReconcileLastAt < THROTTLE_MS) return;
      _globalBatchReconcileLastAt = now;
      try { reattachVideoPromptBatches("wake:" + reason); }
      catch (e) { console.warn("[GlobalReconcile] videoPrompts failed:", e); }
      try { _restoreAssetGenStatus(); }
      catch (e) { console.warn("[GlobalReconcile] assets failed:", e); }
      try { reconcileVideoTasksOnWake(reason); }
      catch (e) { console.warn("[GlobalReconcile] videoTasks failed:", e); }
      try { reattachStoryboardBatches(); }
      catch (e) { console.warn("[GlobalReconcile] storyboard failed:", e); }
    }
    window.addEventListener("focus", function () { run("focus"); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") run("visibilitychange");
    });
    window.addEventListener("online", function () { run("online"); });
  }

  /* ================================================================
     帐号栏 + 管理面板
     ================================================================ */
  function _initAccountBar() {
    async function logoutCurrentUser() {
      var token = "";
      try { token = localStorage.getItem("sw_auth_token") || ""; } catch (_) { token = ""; }
      try {
        if (token) {
          await fetch("/api/auth/logout", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token }
          });
        }
      } catch (_) {
      } finally {
        try {
          localStorage.removeItem("sw_auth_token");
          localStorage.removeItem("sw_auth_user");
        } catch (_) {}
        window.location.href = "/";
      }
    }

    function accountDisplayName(user) {
      var value = "";
      if (user) value = user.displayName || user.phone || "";
      value = String(value || "").trim();
      return value || "用户";
    }

    function setAccountMenuOpen(open) {
      var accountBar = $("accountBar");
      var accountMenu = $("accountMenu");
      var accountChevron = accountBar ? accountBar.querySelector(".account-entry-chevron") : null;
      if (!accountBar || !accountMenu) return;
      accountMenu.hidden = !open;
      accountBar.classList.toggle("is-open", !!open);
      accountBar.classList.toggle("is-active", !!open);
      accountBar.setAttribute("aria-expanded", open ? "true" : "false");
      if (accountChevron) accountChevron.textContent = open ? "chevron_left" : "chevron_right";
    }

    ["btnLogout", "btnSettingsLogout"].forEach(function (id) {
      var logoutBtn = $(id);
      if (logoutBtn) logoutBtn.addEventListener("click", logoutCurrentUser);
    });

    var user = getSessionUser() || getCachedAuthUser();
    var displayName = accountDisplayName(user);
    var nameEl = $("accountUsername");
    if (nameEl) nameEl.textContent = displayName;

    var accountBar = $("accountBar");
    var accountMenu = $("accountMenu");
    if (accountBar && accountMenu) {
      accountBar.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setAccountMenuOpen(accountMenu.hidden);
      });
      accountMenu.addEventListener("click", function (ev) {
        var actionEl = ev.target && ev.target.closest ? ev.target.closest("[data-account-menu-action]") : null;
        if (!actionEl) return;
        ev.preventDefault();
        ev.stopPropagation();
        var action = actionEl.getAttribute("data-account-menu-action");
        setAccountMenuOpen(false);
        if (action === "billing") {
          switchPage("billing", { user: true });
        } else if (action === "logout") {
          logoutCurrentUser();
        }
      });
      document.addEventListener("click", function (ev) {
        if (accountMenu.hidden) return;
        var target = ev.target;
        if ((accountBar.contains && accountBar.contains(target)) || (accountMenu.contains && accountMenu.contains(target))) return;
        setAccountMenuOpen(false);
      });
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape" && !accountMenu.hidden) setAccountMenuOpen(false);
      });
    }

    startUserActivityHeartbeat();
    try { loadBillingSummary(); } catch (_) {}
    try { refreshBillingBadge(); } catch (_) {}
    // 暴露给其它模块（如 shots/storyboard/videoPrompts）判断是否挂诊断面板。
    // 只读、刻意全局、刷新即重置，避免本地存储被改假冒管理员。
    window.__qdIsAdmin = false;
    // 设置入口暂时隐藏（当前无实际功能）。需要放出时，取消下面两行注释即可。
    // var navSettings = $("navSettings");
    // if (navSettings) navSettings.hidden = false;
    var diagIds = ["shotsDiagnostic", "sbDiagnostic", "vpDiagnostic"];
    diagIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.hidden = true; el.style.display = "none"; }
    });
  }

  function startUserActivityHeartbeat() {
    if (window.__originUserActivityTimer) return;
    function beat() {
      var token = "";
      try { token = localStorage.getItem("sw_auth_token") || ""; } catch (_) {}
      if (!token) return;
      fetch("/api/activity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
          path: location.pathname + location.search + location.hash
        })
      }).catch(function () {});
    }
    beat();
    window.__originUserActivityTimer = setInterval(beat, 60000);
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
    var isCurrentProject = !!(project && project.id === pid);
    var versionForWrite = null;
    try {
      if (isCurrentProject) {
        var saved = await _flushServerSave();
        if (saved && saved.ok === false && !saved.stale) {
          showToast("重命名失败：服务器未保存成功", "error");
          return false;
        }
        if (project && project.id === pid && typeof project.version === "number") {
          versionForWrite = project.version;
        }
      } else {
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
        if (typeof p.version === "number") versionForWrite = p.version;
      }

      var headers = Object.assign({}, _getAuthHeaders(), { "X-Origin-Title-Update": "1" });
      if (typeof versionForWrite === "number") headers["If-Match"] = "v" + versionForWrite;
      var putResp = await fetch("/api/projects/" + encodeURIComponent(pid), {
        method: "PUT",
        headers: headers,
        body: JSON.stringify({ name: newName, title: newName, __titleUpdate: true }),
      });
      if (putResp.status === 409) {
        showToast("项目在另一处被修改，请刷新后再重命名", "warn");
        return false;
      }
      if (!putResp.ok) {
        showToast("重命名失败：服务器拒绝（" + putResp.status + "）", "error");
        return false;
      }
      var updated = await putResp.json().catch(function () { return null; });
      if (project && project.id === pid) {
        project.name = newName;
        project.title = newName;
        if (updated && typeof updated.version === "number") project.version = updated.version;
        try { syncOnlineEditorProjectTitle(); }
        catch (e) { console.warn("[OnlineEditor] sync title after rename failed:", e); }
      }
    } catch (e) {
      console.warn("[RenameProject] server failed:", e);
      showToast("重命名失败：网络错误", "error");
      return false;
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
    activatingId: "",
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
  var _ovLastCardClick = { id: "", time: 0 };
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
    _ovSyncSearchClearButton(search);
  }

  function _ovSyncSearchClearButton(search) {
    var clear = $("ovTaskSearchClear");
    if (!clear) return;
    if (!search) search = $("ovTaskSearch");
    var current = search ? search.value : _ovSearchValue();
    clear.hidden = !String(current || "").trim();
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
	      if (stored && stored.phone) candidates.push(String(stored.phone));
	      if (stored && stored.displayName) candidates.push(String(stored.displayName));
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

  // ── 任务页右侧预览/下载用的视频地址签名 ──
  // task.videoUrl 是持久化在项目里的"内部受保护地址"（/api/videos/file/{id}，无签名）。
  // <video src> 和 <a download> 都不会带 Authorization 头，后端那条路要么认 Bearer
  // 头、要么认 ?exp=&sig= 签名，二者都没有 → 401 → 点了播不出来、下载也失败。
  // 这里按需把它换成带签名的临时地址（和片段卡 reattach / 剪辑预览同款链路：
  // GET /api/videos/{id}/url）。外链或已带有效签名的地址原样返回。
  var _OV_INTERNAL_VIDEO_RE = /\/api\/videos\/file\/([a-zA-Z0-9-]+)/;
  var _OV_EXPORT_FILE_RE = /\/api\/edit\/export-file\/([a-zA-Z0-9-]+)/;
  function _ovVideoIdFromUrl(url) {
    var m = _OV_INTERNAL_VIDEO_RE.exec(String(url || ""));
    return m ? m[1] : "";
  }
  function _ovExportIdFromUrl(url) {
    var m = _OV_EXPORT_FILE_RE.exec(String(url || ""));
    return m ? m[1] : "";
  }
  // 需要换签名的两类内部地址：片段视频 /api/videos/file/{id}、剪辑成片 /api/edit/export-file/{id}。
  // 已带有效签名(exp 未过期)的不用再换。外链不管。
  function _ovVideoUrlNeedsSigning(url) {
    if (_ovExportIdFromUrl(url)) return !_ovSignedImageUrlStillValid(url);
    return !!_ovVideoIdFromUrl(url) && !_ovSignedImageUrlStillValid(url);
  }
  // 签名地址缓存：同一个原始地址在多次渲染/点击间复用，避免每次 detail 重渲都打一次签名接口。
  var _ovSignedUrlCache = new Map();
  async function _ovResolvePlayableVideoUrl(url) {
    url = String(url || "").trim();
    if (!url || !_ovVideoUrlNeedsSigning(url)) return url;
    var cached = _ovSignedUrlCache.get(url);
    if (cached && _ovSignedImageUrlStillValid(cached)) return cached;
    var endpoint = "";
    var exportId = _ovExportIdFromUrl(url);
    if (exportId) {
      endpoint = "/api/edit/export-file/" + encodeURIComponent(exportId) + "/url";
    } else {
      var id = _ovVideoIdFromUrl(url);
      if (!id) return url;
      endpoint = "/api/videos/" + encodeURIComponent(id) + "/url";
    }
    try {
      var resp = await apiGet(endpoint);
      var signed = (resp && resp.url) || "";
      if (signed) _ovSignedUrlCache.set(url, signed);
      return signed;
    } catch (e) {
      console.warn("[overview] 播放地址签名获取失败:", e && e.message);
      return "";
    }
  }
  // 异步把签名地址塞进预览 <video>。解析期间该 video 可能已被下一次渲染替换，
  // 用 isConnected + dataset 兜一下，避免把地址写到已脱离文档/已切到别的任务的旧元素上。
  function _ovApplyPreviewVideoSrc(videoEl, rawUrl) {
    if (!videoEl || !rawUrl) return;
    if (!_ovVideoUrlNeedsSigning(rawUrl)) { videoEl.src = rawUrl; return; }
    videoEl.dataset.ovRawSrc = rawUrl;
    _ovResolvePlayableVideoUrl(rawUrl).then(function (signed) {
      if (!signed || !videoEl.isConnected) return;
      if (videoEl.dataset.ovRawSrc !== rawUrl) return;
      videoEl.src = signed;
    });
  }

  function _hydrateVideoResultPlayback(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll(".video-result-video[data-raw-src]").forEach(function (videoEl) {
      var rawUrl = String(videoEl.dataset.rawSrc || "").trim();
      if (!rawUrl) return;
      if (videoEl.dataset.videoResultRawSrc === rawUrl && videoEl.src) return;
      videoEl.dataset.videoResultRawSrc = rawUrl;
      _ovApplyPreviewVideoSrc(videoEl, rawUrl);
    });
    // 播放交互态：复用总览同款加载遮罩绑定（驱动 [data-ov-preview-loading]）+ 同步动作栏播放按钮状态。
    scope.querySelectorAll(".video-result-preview-frame").forEach(function (frame) {
      var videoEl = frame.querySelector(".video-result-video");
      if (!videoEl || videoEl.dataset.vrUxBound === "1") return;
      videoEl.dataset.vrUxBound = "1";
      _ovBindPreviewVideoUx(videoEl, frame);
      _bindVideoResultPlayButton(videoEl, frame.closest("[data-video-result-group]"));
    });
  }

  // 动作栏「播放」按钮跟随 video 真实状态：playing→暂停态，pause/ended→播放态（含 aria-pressed）。
  function _bindVideoResultPlayButton(video, card) {
    if (!video || !card) return;
    var btn = card.querySelector("[data-video-result-action='play']");
    if (!btn) return;
    var icon = btn.querySelector("[data-vr-play-icon]");
    var label = btn.querySelector("[data-vr-play-label]");
    function setPlaying(on) {
      if (icon) icon.textContent = on ? "pause" : "play_arrow";
      if (label) label.textContent = on ? "暂停" : "播放";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    video.addEventListener("play", function () { setPlaying(true); });
    video.addEventListener("pause", function () { setPlaying(false); });
    video.addEventListener("ended", function () { setPlaying(false); });
  }

  async function _ensureVideoResultPlayable(videoEl) {
    if (!videoEl) return false;
    if (videoEl.src) return true;
    var rawUrl = String(videoEl.dataset.rawSrc || videoEl.dataset.ovRawSrc || "").trim();
    if (!rawUrl) return false;
    var signed = await _ovResolvePlayableVideoUrl(rawUrl);
    if (!signed || !videoEl.isConnected) return false;
    videoEl.src = signed;
    return true;
  }

  // 预览封面（poster）也是无签名图片地址（/api/images/file/{id}），<video poster> 一样
  // 带不了 Bearer → 黑底/裂图。走和列表缩略图同一套 fetchAssetSignedUrl 换签名图，
  // 异步塞 poster。外链/已带有效签名的直接用（inline poster 已设，这里不覆盖）。
  function _ovApplyPreviewPoster(videoEl, thumbUrl) {
    thumbUrl = String(thumbUrl || "").trim();
    if (!videoEl || !thumbUrl) return;
    var id = _ovImageAssetIdFromUrl(thumbUrl);
    if (!id || _ovSignedImageUrlStillValid(thumbUrl)) {
      if (!videoEl.getAttribute("poster")) videoEl.poster = _ovOverviewThumbnailDisplayUrl(thumbUrl);
      return;
    }
    videoEl.dataset.ovPosterRaw = thumbUrl;
    fetchAssetSignedUrl(id, 3600).then(function (signed) {
      if (!signed || !videoEl.isConnected) return;
      if (videoEl.dataset.ovPosterRaw !== thumbUrl) return;
      videoEl.poster = _ovOverviewThumbnailDisplayUrl(signed);
    }).catch(function (e) { console.warn("[overview] 预览封面签名失败:", e && e.message); });
  }
  // 预览播放器交互态：加载圈跟随 waiting/playing/error，播放钮跟随 play/pause/ended。
  // 解决"点了播放黑屏一阵不知道在干嘛"——签名+缓冲期间显式转圈"正在加载视频…"。
  function _ovBindPreviewVideoUx(video, preview) {
    if (!video || !preview) return;
    var loadingEl = preview.querySelector("[data-ov-preview-loading]");
    var playBtn = preview.querySelector("[data-ov-action='preview-play']");
    function setLoading(on) { if (loadingEl) loadingEl.hidden = !on; }
    function showPlayBtn(on) { if (playBtn) playBtn.hidden = !on; }
    video.addEventListener("waiting", function () { setLoading(true); });
    video.addEventListener("playing", function () { setLoading(false); showPlayBtn(false); });
    video.addEventListener("canplay", function () { setLoading(false); });
    video.addEventListener("pause", function () { if (!video.ended) { setLoading(false); showPlayBtn(true); } });
    video.addEventListener("ended", function () { setLoading(false); showPlayBtn(true); });
    video.addEventListener("error", function () { setLoading(false); showPlayBtn(true); });
  }

  function _ovPreviewPlayIconHtml() {
    return '<svg class="vtd-preview-play-icon" viewBox="0 0 28 28" aria-hidden="true" focusable="false">' +
      '<path d="M9.2 6.3c0-.9 1-1.45 1.78-.95l10.86 7.01c.7.45.7 1.48 0 1.93L10.98 21.3c-.78.5-1.78-.05-1.78-.95V6.3z"/>' +
      '</svg>';
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

  // 状态胶囊的阶段文案。images/prompts/batch 三个阶段带百分比，失败时显示"xx生成失败"。
  var _ovStageLabels = {
    script: "剧本创作中",
    style: "风格编辑中",
    assets: "资产整理中",
    shots: "镜头设计中",
    images: "镜头生成",
    prompts: "提示词生成",
    batch: "片段生成",
    edit: "成片剪辑中",
    done: "已完成",
  };

  // 资产阶段的产物倒推：已提取出资产且每个资产都有图 → 视为资产阶段已完成（用户常跳过"确认资产"按钮）。
  // "有图"的字段口径对齐 modules/assets.js 的 _hasAssetImage（含真人参考/铅笔稿/参考锁/三视图面板）；
  // 角色 reference.status=failed 视为未完成（casting 失败需回资产页处理）。
  // 与服务端 lib/projects-db.ts 的 projectSummaryAssetsArtifactComplete 保持同构，改一处必须同步另一处。
  function _ovAssetsArtifactComplete(proj) {
    var assets = proj && proj.assets;
    if (!assets) return false;
    var groups = [
      { list: assets.characters || [], isChar: true },
      { list: assets.scenes || [], isChar: false },
      { list: assets.props || [], isChar: false },
    ];
    var count = 0;
    for (var g = 0; g < groups.length; g++) {
      var list = Array.isArray(groups[g].list) ? groups[g].list : [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i] || {};
        count++;
        var ref = it.reference && typeof it.reference === "object" ? it.reference : {};
        var panels = it.panels && typeof it.panels === "object" ? it.panels : {};
        if (groups[g].isChar && String(ref.status || "").toLowerCase() === "failed") return false;
        var url = _ovFirst(
          it.imageUrl, it.rawUrl, it.realPhotoUrl, it.pencilUrl,
          ref.currentUrl, ref.lastKnownGoodUrl,
          it.referenceLock && it.referenceLock.sheetUrl,
          panels.sheetUrl, panels.frontUrl, panels.sideUrl, panels.backUrl
        );
        if (!url) return false;
      }
    }
    return count > 0;
  }

  // 项目阶段判定（与服务端 lib/projects-db.ts 的 projectSummaryStageInfo 保持同构，改一处必须同步另一处）。
  // 从最远的下游产物倒推阶段（成片 > 可剪辑 > 片段 > 提示词 > 镜头图 > 镜头设计），
  // 不依赖 *Approved 确认 flag——实际数据里用户经常跳过确认按钮，flag 与真实进度脱节；
  // 只有尚无任何生成产物的早期创作阶段（剧本/风格/资产/镜头设计）才用 flag 区分，
  // 其中资产阶段额外认产物：资产已提取且全部有图 → 视为完成推进到镜头设计（_ovAssetsArtifactComplete）。
  // 有成片导出（editData.exportUrl）就算已完成，之后剪辑页再改动也不回退状态。
  function _ovProjectStageInfo(proj, counts, segmentCount) {
    proj = proj || {};
    counts = counts || { running: 0, done: 0, failed: 0 };
    segmentCount = Number(segmentCount) || 0;
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var panelTotal = sbs.length;
    var imgDone = 0, imgFailed = 0, prReady = 0, prGen = 0, prFailed = 0;
    sbs.forEach(function (raw) {
      var sb = raw || {};
      if (_ovFirst(sb.rawUrl, sb.imageUrl, sb.firstFrameUrl)) imgDone++;
      else if (sb.firstFrameLastError) imgFailed++;
      if (sb.videoPromptStatus === "generating") prGen++;
      else if (sb.videoPromptStatus === "failed") prFailed++;
      else if (sb.videoPrompt && (!sb.videoPromptStatus || sb.videoPromptStatus === "ready")) prReady++;
    });
    function info(stage, done, total, failed, running) {
      return { stage: stage, done: done || 0, total: total || 0, failed: failed || 0, running: running || 0 };
    }
    if (proj.editData && proj.editData.exportUrl) return info("done", segmentCount, segmentCount);
    // 有片段正在生成：优先于"成片剪辑中"展示（重生成片段时回到片段生成态）。
    if (counts.running > 0) {
      return info("batch", counts.done, segmentCount, counts.failed, counts.running);
    }
    if (_ovProjectCanEnterEdit(proj)) return info("edit", counts.done, segmentCount);
    if (counts.done + counts.failed > 0) {
      // 片段全部完成 → 视为进入剪辑阶段（生成已结束，下一步就是剪）。
      if (segmentCount > 0 && counts.done >= segmentCount) return info("edit", counts.done, segmentCount);
      return info("batch", counts.done, segmentCount, counts.failed, counts.running);
    }
    if (prReady + prGen + prFailed > 0) {
      // 提示词全就绪 → 下一步是片段生成，从 0% 开始展示。
      if (panelTotal > 0 && prReady >= panelTotal) return info("batch", 0, segmentCount);
      return info("prompts", prReady, panelTotal, prFailed, prGen);
    }
    if (imgDone + imgFailed > 0) {
      if (panelTotal > 0 && imgDone >= panelTotal) return info("prompts", prReady, panelTotal);
      return info("images", imgDone, panelTotal, imgFailed);
    }
    if (Array.isArray(proj.shots) && proj.shots.length > 0) return info("images", imgDone, panelTotal || proj.shots.length);
    if (!proj.script || !proj.scriptApproved) return info("script");
    if (!_ovHasUsableStyleBible(proj)) return info("style");
    if (!proj.assetsApproved && !_ovAssetsArtifactComplete(proj)) return info("assets");
    return info("shots");
  }

  function _ovStatusLabel(task) {
    if (!task) return "待处理";
    if (task.status === "loading") return "同步中";
    if (task.status === "unknown") return "待同步";
    var stage = task.stage;
    if (stage === "images" || stage === "prompts" || stage === "batch") {
      var base = _ovStageLabels[stage];
      if (task.status === "failed") return base + "失败";
      var pct = (stage === "batch" && task.status === "running")
        ? Number(task.progress) || 0
        : Number(task.stagePct) || 0;
      return base + " " + pct + "%";
    }
    if (stage && _ovStageLabels[stage]) return _ovStageLabels[stage];
    // 兜底（理论上不会走到）：维持旧文案
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
    _ovSyncSearchClearButton();
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
    var hasDetail = !!detail || !!(project && project.id === projectId && proj === project);
    var summarySegmentCount = Number(summary && summary.segmentCount);
    var segmentCount = hasDetail
      ? _ovProjectSegmentCount(proj, localTasks)
      : Math.max(Number.isFinite(summarySegmentCount) ? summarySegmentCount : 0, _ovProjectSegmentCount(proj, localTasks));
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj.videoTasks) ? proj.videoTasks : [];
    var summaryCounts = summary && summary.statusCounts && typeof summary.statusCounts === "object"
      ? summary.statusCounts
      : null;
    var counts = !hasDetail && summaryCounts
      ? {
          running: Number(summaryCounts.running || 0),
          done: Number(summaryCounts.done || 0),
          failed: Number(summaryCounts.failed || 0),
          pending: Number(summaryCounts.pending || 0),
        }
      : { running: 0, done: 0, failed: 0, pending: 0 };
    var progressTotal = 0;

    if (hasDetail || !summaryCounts) {
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
    }

    var rawProjectStatus = String(proj.status || summary && summary.status || "").toLowerCase();
    // 阶段信息：当前项目/已加载详情的项目本地实时算；其它项目用服务端 summary 里算好的。
    var summaryStageInfo = summary && summary.stageInfo && typeof summary.stageInfo === "object" && summary.stageInfo.stage
      ? summary.stageInfo
      : null;
    var stageInfo = (hasDetail || !summaryStageInfo)
      ? _ovProjectStageInfo(proj, counts, segmentCount)
      : summaryStageInfo;
    var stage = stageInfo.stage;
    var stagePct = stageInfo.total > 0
      ? Math.max(0, Math.min(100, Math.round(stageInfo.done / stageInfo.total * 100)))
      : 0;

    // 机器状态（驱动筛选 tab 与配色）：从阶段推导。
    // running/failed 只对"有东西在生成/生成失败"的阶段成立；创作类阶段一律 pending。
    var taskStatus = "pending";
    if (options.loading) taskStatus = "loading";
    else if (stage === "done") taskStatus = "done";
    else if (rawProjectStatus === "completed" || rawProjectStatus === "done" || rawProjectStatus === "succeeded") taskStatus = "done";
    else if (stage === "batch" && (counts.running > 0 || stageInfo.running > 0)) taskStatus = "running";
    else if (stage === "prompts" && stageInfo.running > 0) taskStatus = "running";
    else if ((stage === "batch" || stage === "prompts" || stage === "images") && stageInfo.failed > 0) taskStatus = "failed";
    else if (rawProjectStatus === "failed" || rawProjectStatus === "error") taskStatus = "failed";
    else if (options.detailFailed) taskStatus = "unknown";

    var progress = 0;
    if (taskStatus === "done") progress = 100;
    else if (taskStatus === "running" && stage === "batch") {
      var smooth = segmentCount ? Math.round(progressTotal / segmentCount) : 0;
      progress = Math.max(8, Math.min(99, Math.max(smooth, stagePct)));
    } else {
      progress = Math.min(99, stagePct);
    }

    var media = hasDetail
      ? _ovProjectMedia(proj)
      : { videoUrl: "", thumbnail: _ovFirst(summary && summary.thumbnail, _ovProjectMedia(proj).thumbnail) };
    // 剪辑页合成成片：editData.exportUrl（导出完成时由后端写入，指向 /api/edit/export-file/{id}）。
    // 任务页右侧预览优先播它（完整成片），没有时才退回片段视频。只有加载了详情的项目能拿到。
    var composedVideoUrl = "";
    if (hasDetail && proj.editData && proj.editData.exportUrl) {
      composedVideoUrl = String(proj.editData.exportUrl || "");
    }
    var promptText = _ovProjectPromptSummary(proj);
    var summaryDurationSec = Number(summary && summary.durationSec);
    var durationSec = hasDetail
      ? _ovProjectDurationSec(proj)
      : (Number.isFinite(summaryDurationSec) && summaryDurationSec > 0 ? summaryDurationSec : _ovProjectDurationSec(proj));
    var summaryAssetCount = Number(summary && summary.assetCount);
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
      assetCount: hasDetail
        ? _ovProjectAssetCount(proj)
        : (Number.isFinite(summaryAssetCount) ? summaryAssetCount : _ovProjectAssetCount(proj)),
      resolution: "1080 x 1920",
      model: _ovText(_ovCurrentModelLabel(), "--"),
      ratio: "9:16",
      audio: "开启",
      status: taskStatus,
      progress: progress,
      stage: stage,
      stagePct: stagePct,
      stageDone: stageInfo.done,
      stageTotal: stageInfo.total,
      stageFailed: stageInfo.failed,
      stageRunning: stageInfo.running,
      thumbnail: media.thumbnail,
      videoUrl: media.videoUrl,
      composedVideoUrl: composedVideoUrl,
      prompt: promptText || "",
      promptCount: promptText ? String(promptText).length : 0,
    };
  }

  function _ovPrimeProjectTasksFromSummaries(summaries, options) {
    options = options || {};
    var loadingNonCurrent = options.loadingNonCurrent !== false;
    summaries = Array.isArray(summaries) ? summaries : [];
    _ovProjectTasks = summaries.map(function (sp) {
      var detail = project && project.id === sp.id ? project : null;
      return _ovProjectTaskFromSummary(sp, detail, { loading: loadingNonCurrent && !detail });
    });
  }

  async function _ovFetchProjectDataForOverview(projectId) {
    if (!projectId) return null;
    if (project && project.id === projectId) return _ovHydrateProjectOverviewThumbnail(project);
    try {
      var data = await fetchProjectByIdShared(projectId);
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
        return Object.assign({}, sp, {
          name: sp.name || sp.title,
          title: sp.title || sp.name,
        });
      }).filter(function (sp) { return !!sp.id; });
      try { saveProjectList(summaries.map(function (sp) { return { id: sp.id, name: sp.name, createdAt: sp.createdAt }; })); } catch (_) {}
      _ovPrimeProjectTasksFromSummaries(summaries, { loadingNonCurrent: false });
      _ovProjectTasksLoaded = true;
      if (seq === _ovProjectTasksSeq) _ovRenderDashboard();
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

  function _ovCurrentProjectTaskId() {
    return project && project.id ? "p:" + project.id : "";
  }

  function _ovHasTaskId(tasks, id) {
    if (!id) return false;
    return (tasks || []).some(function (t) { return t && t.id === id; });
  }

  function _ovSelectCurrentProjectTask() {
    if (!_ovTaskState) return;
    var currentId = _ovCurrentProjectTaskId();
    if (currentId) _ovTaskState.selectedId = currentId;
  }

  function _ovAlignSelectedToCurrentProject(tasks) {
    if (!_ovTaskState) return false;
    if (_ovTaskState.activatingId) return false;
    var currentId = _ovCurrentProjectTaskId();
    if (!currentId || !_ovHasTaskId(tasks, currentId)) return false;
    _ovTaskState.selectedId = currentId;
    return true;
  }

  function _ovSetSelected(id, tasks, options) {
    options = options || {};
    tasks = tasks || _ovBuildTasks();
    if (options.preferCurrent !== false && _ovAlignSelectedToCurrentProject(tasks)) return;
    if (id && tasks.some(function (t) { return t.id === id; })) { _ovTaskState.selectedId = id; return; }
    if (_ovTaskState.selectedId && tasks.some(function (t) { return t.id === _ovTaskState.selectedId; })) return;
    _ovTaskState.selectedId = tasks.length ? tasks[0].id : "";
  }

  function _ovHasUsableStyleBible(proj) {
    if (!proj || !proj.styleBible || !_styleBibleHasContent(proj.styleBible)) return false;
    if (proj.styleBibleStatus === "ready") return true;
    if (!proj.styleBibleStatus) return true;
    return false;
  }

  function _ovProjectCanEnterEdit(proj) {
    if (!proj) return false;
    var readiness = proj.editData && proj.editData.readiness;
    if (readiness && readiness.canEnterEdit === true) return true;
    var timeline = proj.editData && proj.editData.edl && Array.isArray(proj.editData.edl.timeline)
      ? proj.editData.edl.timeline
      : [];
    if (timeline.length > 0) return true;
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    return sbs.some(function (sb) { return sb && sb.importedToEdit === true; });
  }

  function _ovContinuePageForProject(proj) {
    // 与状态胶囊同口径（_ovProjectStageInfo）：从最远下游产物倒推阶段，不信 *Approved flag。
    // 旧实现按 flag 链判定，但用户常跳过各步"确认"按钮（如已导出成片的项目 imagesApproved 仍 false），
    // 导致已完成的项目"继续制作"跳回分镜/镜头页。counts 算法与 _ovProjectTaskFromSummary 的 hasDetail 分支一致。
    if (!proj) return "script";
    var localTasks = _ovLocalTasksForProject(proj.id);
    var segmentCount = _ovProjectSegmentCount(proj, localTasks);
    var sbs = Array.isArray(proj.storyboards) ? proj.storyboards : [];
    var vts = Array.isArray(proj.videoTasks) ? proj.videoTasks : [];
    var counts = { running: 0, done: 0, failed: 0, pending: 0 };
    for (var i = 0; i < segmentCount; i++) {
      var localTask = _ovLocalTaskForProjectGroup(localTasks, i);
      var serverStatus = _ovStatusFrom(null, vts[i] || {}, sbs[i] || {});
      var status = (serverStatus === "done" || serverStatus === "failed")
        ? serverStatus
        : _ovStatusFrom(localTask, vts[i] || {}, sbs[i] || {});
      if (counts[status] === undefined) status = "pending";
      counts[status]++;
    }
    var stage = _ovProjectStageInfo(proj, counts, segmentCount).stage;
    // 已完成 → 剪辑页（看成片/微调/重导出）。其余 stage 与页面名一一对应（images 由 switchPage 归一到 shots）。
    if (stage === "done") return "edit";
    return stage;
  }

  function _ovContinuePageLabel(page) {
    return {
      script: "剧本",
      style: "风格",
      assets: "资产",
      shots: "镜头",
      images: "分镜",
      prompts: "提示词",
      batch: "片段",
      edit: "剪辑",
    }[page] || "流程";
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
    var deleteDisabled = t.projectId ? "" : " disabled";
    var renameDisabled = t.projectId ? "" : " disabled";
    var titleText = t.title || "未命名任务";
    var isEditingTitle = _ovTaskState.editingTitleId === t.id;
    // 失败也展示胶囊：新文案带阶段信息（如"片段生成失败"），不再隐藏。
    var statusHtml = '<span class="vtd-status ' + statusClass + '">' + escapeHtml(_ovStatusLabel(t)) + '</span>';
    var titleHtml = isEditingTitle
      ? '<div class="vtd-title-edit-row is-editing">' +
          '<input type="text" class="vtd-title-input" data-ov-title-input value="' + escapeHtml(titleText) + '" maxlength="200" autocomplete="off" spellcheck="false" aria-label="任务标题">' +
          '<button type="button" class="vtd-title-icon-btn" data-ov-action="rename-save" title="保存标题" aria-label="保存标题"><span class="material-symbols-outlined">check</span></button>' +
          '<button type="button" class="vtd-title-icon-btn" data-ov-action="rename-cancel" title="取消编辑" aria-label="取消编辑"><span class="material-symbols-outlined">close</span></button>' +
        '</div>'
      : '<div class="vtd-title-edit-row">' +
          '<h3>' + escapeHtml(titleText) + '</h3>' +
          '<button type="button" class="vtd-title-edit-btn" data-ov-action="rename" title="编辑标题" aria-label="编辑标题"' + renameDisabled + '><span class="material-symbols-outlined">edit</span></button>' +
          '<button type="button" class="vtd-title-edit-btn" data-ov-action="copy-title" title="复制标题" aria-label="复制标题"><span class="material-symbols-outlined">content_copy</span></button>' +
        '</div>';
    var activating = _ovTaskState.activatingId === t.id;
    var continueDisabled = t.projectId ? "" : " disabled";
    return '' +
      '<article class="vtd-task-card' + (selected ? ' is-selected' : '') + (activating ? ' is-activating' : '') + '" data-task-id="' + escapeHtml(t.id) + '">' +
        '<button type="button" class="vtd-select-dot" data-ov-action="select" aria-label="选择任务"></button>' +
        '<div class="vtd-thumb">' + thumb + '</div>' +
        '<div class="vtd-task-body">' +
          '<div class="vtd-task-title-row">' +
            '<div class="min-w-0">' + titleHtml + '<p>创建时间&nbsp;&nbsp;' + escapeHtml(t.createdText || "--") + '</p></div>' +
          '</div>' +
          '<div class="vtd-task-meta">' +
            '<span><i class="material-symbols-outlined">schedule</i>' + escapeHtml(t.durationText) + '</span>' +
            '<span><i class="material-symbols-outlined">folder</i>片段 ' + escapeHtml(String(t.segmentCount || 0)) + ' 个</span>' +
            '<span><i class="material-symbols-outlined">aspect_ratio</i>比例 ' + escapeHtml(t.ratio) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="vtd-task-status-actions">' +
          '<button type="button" class="vtd-continue-btn" data-ov-action="continue" title="继续制作到当前流程进度"' + continueDisabled + '>' +
            '<span class="material-symbols-outlined">play_arrow</span><span>继续制作</span>' +
          '</button>' +
          statusHtml +
          '<div class="vtd-icon-actions">' +
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
    _ovSelectTask(task.id, { activate: false });
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

  function _ovCopyText(text) {
    text = String(text || "");
    if (!text) return Promise.reject(new Error("empty"));
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).catch(function () { return _ovExecCopyText(text); });
    }
    return Promise.resolve(_ovExecCopyText(text));
  }

  function _ovExecCopyText(text) {
    var el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.left = "-32000px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    try { document.execCommand("copy"); } catch (_) {}
    try { document.body.removeChild(el); } catch (_) {}
  }

  function _ovCopyProjectTaskTitle(task) {
    var title = String((task && task.title) || "").trim();
    if (!title) {
      showToast("没有可复制的标题", "warn");
      return;
    }
    _ovCopyText(title).then(function () {
      showToast("任务名称已复制", "success");
    }, function () {
      showToast("复制失败", "error");
    });
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
      { label: "片段生成", value: videoDone ? videoDone + "/" + sbTotal + " 个片段" : (proj.videoPromptsApproved ? "就绪（" + sbTotal + " 个片段）" : "待处理"), done: sbTotal > 0 && videoDone >= sbTotal, ready: !!proj.videoPromptsApproved },
    ];
  }

  function _ovRenderDetail(allTasks) {
    allTasks = allTasks || _ovBuildTasks();
    var task = allTasks.find(function (t) { return t.id === _ovTaskState.selectedId; }) || allTasks[0] || null;
    _ovSetSelected(task && task.id, allTasks);
    var preview = $("ovPreviewWrap"), param = $("ovParamList"), flow = $("ovWorkflowStatus");
    var dl = $("ovDownloadVideoBtn");
    if (!task) {
      if (preview) preview.innerHTML = '<div class="vtd-preview-empty"><span class="material-symbols-outlined">movie_filter</span><p>未选择任务</p></div>';
      if (param) param.innerHTML = "";
      if (flow) flow.innerHTML = "";
      if (dl) dl.disabled = true;
      return;
    }
    if (preview) {
      if (task.videoUrl || task.composedVideoUrl) {
        // 优先播剪辑合成片；没有合成片时退回片段视频（默认就是片段1）。
        var _ovPlayUrl = task.composedVideoUrl || task.videoUrl;
        preview.innerHTML =
          '<video poster="' + escapeHtml(_ovThumbnailPosterUrl(task.thumbnail)) + '" controls playsinline preload="metadata"></video>' +
          '<button type="button" class="vtd-preview-play" data-ov-action="preview-play" title="播放" aria-label="播放视频">' + _ovPreviewPlayIconHtml() + '</button>' +
          '<div class="vtd-preview-loading" data-ov-preview-loading hidden><span class="vtd-preview-spinner"></span><span>正在加载视频…</span></div>';
        var _ovPrevVideo = preview.querySelector("video");
        _ovApplyPreviewVideoSrc(_ovPrevVideo, _ovPlayUrl);
        _ovApplyPreviewPoster(_ovPrevVideo, task.thumbnail);
        _ovBindPreviewVideoUx(_ovPrevVideo, preview);
      } else if (task.thumbnail) {
        preview.innerHTML = _ovThumbnailImgHtml(task.thumbnail) + '<div class="vtd-preview-unavailable"><span class="material-symbols-outlined">videocam_off</span><p>视频未生成</p></div>';
      } else {
        preview.innerHTML = '<div class="vtd-preview-empty"><span class="material-symbols-outlined">movie_filter</span><p>暂无视频</p></div>';
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
    if (dl) { dl.disabled = !(task.composedVideoUrl || task.videoUrl); dl.dataset.taskId = task.id; }
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

  function _ovSyncCurrentProjectTaskSnapshot() {
    if (!project || !project.id) return;
    var updated = _ovProjectTaskFromSummary({
      id: project.id,
      name: project.name,
      title: project.title,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      status: project.status,
    }, project);
    var idx = _ovProjectTasks.findIndex(function (t) { return t && t.projectId === project.id; });
    if (idx >= 0) _ovProjectTasks[idx] = updated;
    else _ovProjectTasks.unshift(updated);
  }

  async function _ovSelectTask(id, options) {
    options = options || {};
    var shouldActivate = options.activate !== false;
    _ovTaskState.selectedId = id || "";
    var task = id ? _ovTaskById(id) : null;
    if (shouldActivate && task && task.projectId) _ovTaskState.activatingId = id;
    _ovRenderDashboard();
    if (!shouldActivate || !id) return true;

    if (!task || !task.projectId) return true;
    try {
      var activated = await _activateProjectContext(task.projectId, {
        silent: true,
        navigateToOverview: false,
        showSkeleton: false,
        refreshPages: false,
        resetViewState: false,
      });
      if (!activated) return false;
      _ovSyncCurrentProjectTaskSnapshot();
      _ovRenderDashboard();
      return true;
    } catch (e) {
      console.warn("[OverviewSelectTask] activate failed:", e);
      var fallbackTask = _ovProjectTasks.find(function (t) {
        return t && project && t.projectId === project.id;
      });
      _ovTaskState.selectedId = fallbackTask ? fallbackTask.id : "";
      _ovRenderDashboard();
      showToast((e && e.message) || "切换任务失败", "error");
      return false;
    } finally {
      if (_ovTaskState.activatingId === id) {
        _ovTaskState.activatingId = "";
        _ovRenderDashboard();
      }
    }
  }

  function _ovCreateProjectTask() {
    if (_ovProjectTaskCreating) return;
    _openNewProjectDialog({
      afterCreated: async function () {
        refreshOverview();
        switchPage("script");
      },
    });
  }

  async function _ovDownloadVideo(task) {
    if (!task || !(task.composedVideoUrl || task.videoUrl)) {
      showToast("视频尚未生成", "warn");
      return;
    }
    // 下载也优先给合成片；和预览同理，持久化的无签名地址直接 <a download> 会 401，先换签名地址。
    var href = await _ovResolvePlayableVideoUrl(task.composedVideoUrl || task.videoUrl);
    if (!href) {
      showToast("下载地址获取失败，请刷新后重试", "warn");
      return;
    }
    try {
      var name = String(task.title || task.name || task.id || "video").replace(/[\\/:*?"<>|]+/g, "_").trim();
      var a = document.createElement("a");
      a.href = href;
      a.download = (name || "video") + ".mp4";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (_) {} }, 0);
    } catch (_) {
      showToast("浏览器阻止了下载，请稍后重试", "warn");
    }
  }

  async function _ovContinueTask(task) {
    if (!task || !task.projectId || _ovProjectTaskNavigating) return;
    _ovProjectTaskNavigating = true;
    try {
      _ovTaskState.activatingId = task.id;
      _ovRenderDashboard();
      var activated = await _activateProjectContext(task.projectId, {
        silent: true,
        navigateToOverview: false,
        showSkeleton: true,
        refreshPages: true,
        resetViewState: false,
      });
      if (!activated || !project || project.id !== task.projectId) {
        showToast("无法打开该项目，请刷新后重试", "error");
        return;
      }
      _ovSyncCurrentProjectTaskSnapshot();
      var targetPage = _ovContinuePageForProject(project);
      switchPage(targetPage, { user: true });
      showToast("继续制作：已进入「" + _ovContinuePageLabel(targetPage) + "」", "ok");
    } catch (e) {
      console.warn("[OverviewContinueTask] failed:", e);
      showToast((e && e.message) || "继续制作失败", "error");
    } finally {
      _ovProjectTaskNavigating = false;
      if (_ovTaskState.activatingId === task.id) _ovTaskState.activatingId = "";
      refreshOverview();
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
          syncOnlineEditorProject(null);
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

    var searchClear = $("ovTaskSearchClear");
    if (searchClear) {
      searchClear.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        _ovSearchComposing = false;
        _ovMarkSearchUserInput();
        _ovClearSearchInput(search);
        _ovRenderDashboard();
        if (search && typeof search.focus === "function") {
          try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
        }
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
      _ovCreateProjectTask();
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
      if (action === "copy-title") {
        e.preventDefault();
        _ovCopyProjectTaskTitle(task);
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
        _ovDownloadVideo(task);
        return;
      }
      if (action === "continue") {
        e.preventDefault();
        _ovContinueTask(task);
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
      if (!actionBtn && !e.target.closest("button, input, select, textarea, a, [contenteditable='true']")) {
        var clickNow = Date.now();
        var isDoubleCardClick = _ovLastCardClick.id === id && clickNow - _ovLastCardClick.time <= 500;
        _ovLastCardClick = { id: id, time: clickNow };
        if (isDoubleCardClick && task.projectId) {
          e.preventDefault();
          _ovContinueTask(task);
          return;
        }
      }
      _ovSelectTask(id);
      if (action === "play" && (task.videoUrl || task.composedVideoUrl)) {
        // 预览 <video> 的签名地址是异步塞进去的（要一次签名接口往返），
        // 等 src 就绪再 play，避免在签名返回前就 play 一个空 src 静默失败。
        // 等待期间显示加载圈（playing 事件会收掉）。
        var _ovPlayWaitStart = Date.now();
        (function waitAndPlay() {
          var wrap = $("ovPreviewWrap");
          var video = wrap && wrap.querySelector("video");
          if (!video) return;
          var loadingEl = wrap.querySelector("[data-ov-preview-loading]");
          var playBtn = wrap.querySelector("[data-ov-action='preview-play']");
          if (playBtn) playBtn.hidden = true;
          if (loadingEl) loadingEl.hidden = false;
          if (video.src) { video.play().catch(function () {}); return; }
          if (Date.now() - _ovPlayWaitStart > 4000) { if (loadingEl) loadingEl.hidden = true; if (playBtn) playBtn.hidden = false; return; }
          setTimeout(waitAndPlay, 80);
        })();
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
      _ovDownloadVideo(_ovTaskById(dl.dataset.taskId));
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
      if (!video) return;
      var loadingEl = preview.querySelector("[data-ov-preview-loading]");
      btn.hidden = true;
      if (loadingEl) loadingEl.hidden = false; // 点下立刻转圈，playing 事件会把它收掉
      function fail() { btn.hidden = false; if (loadingEl) loadingEl.hidden = true; }
      function tryPlay() { video.play().catch(fail); }
      // src 已就绪（_ovApplyPreviewVideoSrc 大多数情况下已提前签好）直接播；
      // 万一用户在签名返回前抢先点了，这里再兜底解析一次再播。
      if (video.src) { tryPlay(); return; }
      _ovResolvePlayableVideoUrl(video.dataset.ovRawSrc || "").then(function (signed) {
        if (signed && video.isConnected) { video.src = signed; tryPlay(); }
        else { fail(); showToast("预览加载失败，请刷新后重试", "warn"); }
      });
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
				  var _styleOptionsSaveTimer = null;
					  var _styleTemplateModalOpen = false;
					  var _styleTemplateModalTempId = "";
					  var _styleWorldTemplateModalOpen = false;
					  var _styleWorldTemplateModalTempId = "";
					  var _styleWorldTemplateModalLoading = false;
					  var _styleWorldPersistSeq = 0;
					  var _styleAutoRecommendPromise = null;
			  var _styleAutoRecommendKey = "";
			  var _STYLE_AUTO_RECOMMENDATION_VERSION = "2026-06-06-world-preferred-style-v1";
			  var _STYLE_ASPECT_RATIOS = { "16:9": true, "9:16": true, "1:1": true };
		  var _STYLE_ASPECT_DEFAULT_VERSION = "2026-05-14-9x16";
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
	    "深夜蓝黑": "#06192d",
	    "墨夜黑": "#06192d",
	    "暗红": "#a70d12",
	    "霓血红": "#a70d12",
	    "赭金": "#d28a22",
	    "香槟金": "#d28a22",
	    "雾白": "#eeeae4",
	    "婚纱白": "#eeeae4",
	    "雨幕青": "#8f9896",
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
	        var mappedHex = _STYLE_PALETTE_HEX[name] || "";
	        var hasHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex);
	        var displayHex = mappedHex || (hasHex ? hex : "#cfd8dc");
	        return { name: name || hex || "色彩", hex: displayHex };
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

		  function _ensureStyleOptions() {
		    if (!project) return {};
		    if (!project.styleOptions || typeof project.styleOptions !== "object") project.styleOptions = {};
		    if (!project.styleOptions.aspectRatioDefaultVersion) {
		      if (!project.styleOptions.aspectRatio || project.styleOptions.aspectRatio === "16:9") {
		        project.styleOptions.aspectRatio = "9:16";
		      }
		      project.styleOptions.aspectRatioDefaultVersion = _STYLE_ASPECT_DEFAULT_VERSION;
		      _scheduleStyleOptionsSave();
		    }
		    return project.styleOptions;
		  }

		  function _styleAspectRatioValue() {
		    var opts = _ensureStyleOptions();
		    var sb = (project && project.styleBible) || {};
	    var value = opts.aspectRatio || sb.aspectRatio || (project && project.videoAspectRatio) || "9:16";
	    value = String(value || "9:16");
	    return _STYLE_ASPECT_RATIOS[value] ? value : "9:16";
	  }

	  function _scheduleStyleOptionsSave() {
	    if (_styleOptionsSaveTimer) clearTimeout(_styleOptionsSaveTimer);
	    _styleOptionsSaveTimer = setTimeout(function () {
	      _styleOptionsSaveTimer = null;
	      saveProject();
	    }, 300);
	  }

	  function _setStyleAspectRatio(ratio) {
	    if (!project || !_STYLE_ASPECT_RATIOS[ratio]) return;
	    var opts = _ensureStyleOptions();
	    if (opts.aspectRatio === ratio) return;
	    opts.aspectRatio = ratio;
	    _renderStyleAspectRatio();
	    _renderStylePageBiblePanel();
	    _scheduleStyleOptionsSave();
	  }

	  function _renderStyleAspectRatio() {
	    var selected = _styleAspectRatioValue();
	    var list = $("styleAspectList");
	    if (!list) return;
	    var buttons = list.querySelectorAll("[data-style-ratio]");
	    for (var i = 0; i < buttons.length; i++) {
	      var btn = buttons[i];
	      btn.classList.toggle("is-selected", btn.getAttribute("data-style-ratio") === selected);
	    }
	  }

	  function _renderStyleInferenceHint() {
	    var hint = $("styleInferenceHint");
	    if (!hint) return;
	    hint.hidden = true;
	    hint.textContent = "";
	  }

		  function _selectedWorldTemplateId() {
		    return String((project && project.selectedWorldTemplateId) || "");
		  }

		  function _selectedStyleTemplateId() {
		    var opts = (project && project.styleOptions) || {};
		    return String((project && project.selectedStyleTemplateId) || opts.selectedTemplateId || "");
		  }

		  function _styleTemplateSnapshotName(snapshot) {
		    return String((snapshot && snapshot.name) || "原模板").trim() || "原模板";
		  }

		  function _styleTemplateNameById(templateId) {
		    templateId = String(templateId || "");
		    if (!templateId) return "";
		    var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
		    var tpl = _findStyleTemplateById(templates, templateId);
		    if (tpl && String(tpl.name || "").trim()) return String(tpl.name || "").trim();
		    var snapshot = project && project.styleTemplateSnapshot;
		    if (snapshot && String(snapshot.id || snapshot.templateId || snapshot.template_id || "") === templateId) {
		      return _styleTemplateSnapshotName(snapshot);
		    }
		    return "";
		  }

		  function _styleCurrentSelectedTemplateName() {
		    var selectedId = _selectedStyleTemplateId();
		    if (selectedId) {
		      var byId = _styleTemplateNameById(selectedId);
		      if (byId) return byId;
		    }
		    var snapshot = project && project.styleTemplateSnapshot;
		    return snapshot ? _styleTemplateSnapshotName(snapshot) : "";
		  }

		  function _styleTemplateSelectionMode() {
		    var opts = (project && project.styleOptions) || {};
		    var mode = String(opts.styleTemplateSelectionMode || "").trim();
		    return (mode === "auto" || mode === "manual" || mode === "manual_clear") ? mode : "";
		  }

		  function _styleHasManualTemplateSelection() {
		    var mode = _styleTemplateSelectionMode();
		    return mode === "manual" || mode === "manual_clear";
		  }

		  function _styleHasGeneratedStyleBible() {
		    if (!project) return false;
		    if (project.styleBibleGeneratedAt) return true;
		    if (project.styleBibleGenerationContext && project.styleBibleGenerationContext.styleTemplateId) return true;
		    return _styleBibleHasContent(project.styleBible);
		  }

		  function _styleAutoScriptKey() {
		    if (!project) return "";
		    var text = String(project.script || "");
		    var world = project.worldTemplateSnapshot || {};
		    var seed = [
		      _STYLE_AUTO_RECOMMENDATION_VERSION,
		      text,
		      project.selectedWorldTemplateId || "",
		      world.updatedAt || world.updated_at || "",
		      world.id || world.templateId || world.template_id || "",
		      _styleWorldTemplatePreferredStyleId(world),
		      _styleWorldTemplatePreferredStyleName(world)
		    ].join("\n");
		    var hash = 0;
		    for (var i = 0; i < seed.length; i++) {
		      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
		    }
		    return seed.length + ":" + Math.abs(hash).toString(36);
		  }

		  function _styleCanAutoSelectTemplate() {
		    if (!project || !String(project.script || "").trim()) return false;
		    if (_styleHasManualTemplateSelection()) return false;
		    var mode = _styleTemplateSelectionMode();
		    if (mode === "auto") return true;
		    var selectedId = _selectedStyleTemplateId();
		    if (!selectedId) return true;
		    return selectedId === "style_live_action_realistic" && !_styleHasGeneratedStyleBible();
		  }

		  function _styleSetTemplateSelectionMeta(mode, source, tpl, reason, scriptKey) {
		    var opts = _ensureStyleOptions();
		    opts.styleTemplateSelectionMode = mode;
		    opts.styleTemplateSelectionSource = source || mode;
		    opts.styleTemplateSelectedAt = new Date().toISOString();
		    if (mode === "auto") {
		      opts.autoStyleTemplateId = (tpl && tpl.id) || "";
		      opts.autoStyleTemplateReason = String(reason || "").slice(0, 300);
		      opts.autoStyleTemplateScriptKey = scriptKey || _styleAutoScriptKey();
		    } else {
		      delete opts.autoStyleTemplateId;
		      delete opts.autoStyleTemplateReason;
		      delete opts.autoStyleTemplateScriptKey;
		    }
		    return opts;
		  }

		  async function _ensureAutoStyleTemplateForStylePage(options) {
		    options = options || {};
		    if (!project || !project.id || !_styleCanAutoSelectTemplate()) {
		      if (_styleHasManualTemplateSelection()) _renderStyleTemplateRecommendHint("manual", null);
		      return false;
		    }
		    var scriptKey = _styleAutoScriptKey();
		    var opts = _ensureStyleOptions();
		    if (!options.refresh && _styleTemplateSelectionMode() === "auto" && _selectedStyleTemplateId() && opts.autoStyleTemplateScriptKey === scriptKey) {
		      var cachedTpl = _findStyleTemplateById((typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [], _selectedStyleTemplateId());
		      if (cachedTpl) _renderStyleTemplateRecommendHint(opts.styleTemplateSelectionSource || "script_auto_cached", cachedTpl);
		      return false;
		    }
		    if (_styleAutoRecommendPromise && _styleAutoRecommendKey === scriptKey && !options.force) return _styleAutoRecommendPromise;
		    _styleAutoRecommendKey = scriptKey;
		    _styleAutoRecommendPromise = (async function () {
		      try {
		        if (typeof _primeStyleTemplates === "function") await _primeStyleTemplates();
		        var resp = await apiGet("/api/style-templates/recommend?projectId=" + encodeURIComponent(project.id));
		        var tpl = resp && resp.styleTemplate;
		        if (!tpl || !_isVisibleStyleTemplate(tpl)) {
		          _renderStyleTemplateRecommendHint("none", null);
		          return false;
		        }
		        var currentId = _selectedStyleTemplateId();
		        var nextId = String(tpl.id || "");
		        var previousMode = _styleTemplateSelectionMode();
		        var previousScriptKey = opts.autoStyleTemplateScriptKey || "";
		        project.selectedStyleTemplateId = nextId || null;
		        project.styleTemplateSnapshot = JSON.parse(JSON.stringify(tpl));
		        _styleSetTemplateSelectionMeta("auto", (resp && resp.source) || "script_auto", tpl, (resp && resp.reason) || "", scriptKey);
		        _renderStyleTemplateRecommendHint((resp && resp.source) || "script_auto", tpl);
		        _renderStylePageTemplates();
		        _renderStyleBibleTemplateBadge();
		        _renderStylePageBiblePanel();
		        if (nextId && nextId !== currentId) {
		          saveProject();
		        } else if (previousMode !== "auto" || previousScriptKey !== scriptKey) {
		          saveProject();
		        }
		        return true;
		      } catch (e) {
		        console.warn("[StylePage] auto style recommendation failed:", e);
		        _renderStyleTemplateRecommendHint("none", null);
		        return false;
		      } finally {
		        _styleAutoRecommendPromise = null;
		      }
		    })();
		    return _styleAutoRecommendPromise;
		  }

		  function _renderStyleBibleTemplateBadge() {
		    var badge = $("styleBibleTemplateBadge");
		    if (!badge) return;
		    if (!project) {
		      badge.hidden = true;
		      badge.textContent = "";
		      badge.removeAttribute("title");
		      return;
		    }
		    var hasBible = _styleBibleHasContent(project.styleBible) || project.styleBibleStatus === "ready" ||
		      project.styleBibleStatus === "failed" || project.styleBibleStatus === "generating";
		    var generatedStyleId = project.styleBibleGenerationContext && project.styleBibleGenerationContext.styleTemplateId;
		    var generatedName = generatedStyleId ? _styleTemplateNameById(generatedStyleId) : "";
		    var selectedName = _styleCurrentSelectedTemplateName();
		    var text = "";
		    var title = "";
		    if (project.styleBibleStatus === "generating" && generatedStyleId) {
		      text = "正在用：" + (generatedName || "已下线模板");
		      title = "本次正在生成的风格圣经使用该风格模板。";
		    } else if (project.styleBibleStatus === "generating" && selectedName) {
		      text = "将用：" + selectedName;
		      title = "正在生成的风格圣经将使用当前选择的风格模板。生成完成后会显示实际使用的模板。";
		    } else if (project.styleBibleSource === "world_import") {
		      text = "世界观强导入";
		      title = "当前风格圣经来自世界观模板强导入，未关联独立风格模板。";
		    } else if (hasBible && generatedStyleId) {
		      text = generatedName || "已下线模板";
		      title = "这份风格圣经生成时使用的风格模板。";
		    } else if (hasBible && selectedName) {
		      text = "来源未知";
		      title = "这份风格圣经缺少生成来源记录。重新生成后会显示实际使用的风格模板。";
		    } else if (selectedName) {
		      text = "将用：" + selectedName;
		      title = "点击生成风格圣经时会使用当前选择的风格模板。";
		    } else {
		      text = "未选模板";
		      title = "不选择模板也可以生成，系统会基于剧本自由推断视觉风格。";
		    }
		    badge.hidden = false;
		    badge.textContent = text;
		    badge.title = title;
		  }

		  function _templateSnapshotId(snapshot) {
		    if (!snapshot || typeof snapshot !== "object") return null;
		    var id = String(snapshot.id || snapshot.templateId || snapshot.template_id || "").trim();
		    return id || null;
		  }

		  function _templateSnapshotHash(snapshot) {
		    var id = _templateSnapshotId(snapshot);
		    if (!id) return null;
		    var updatedAt = String(
		      (snapshot && (snapshot.updatedAt || snapshot.updated_at || snapshot.lastUpdatedAt || snapshot.last_updated_at)) || ""
		    ).trim();
		    return id + ":" + updatedAt;
		  }

		  function _styleCurrentGenerationContext() {
		    var worldSnapshot = (project && project.worldTemplateSnapshot) || null;
		    var styleSnapshot = (project && project.styleTemplateSnapshot) || null;
		    var worldId = (project && project.selectedWorldTemplateId) || _templateSnapshotId(worldSnapshot);
		    var styleId = (project && project.selectedStyleTemplateId) || _templateSnapshotId(styleSnapshot);
		    return {
		      aspectRatio: _styleAspectRatioValue(),
		      worldTemplateId: worldId ? String(worldId) : null,
		      worldTemplateHash: _templateSnapshotHash(worldSnapshot),
		      styleTemplateId: styleId ? String(styleId) : null,
		      styleTemplateHash: _templateSnapshotHash(styleSnapshot),
		    };
		  }

		  function _styleGenerationContextChangedFields() {
		    var empty = { aspectRatio: false, world: false, style: false };
		    if (!project || !project.styleBibleGenerationContext || typeof project.styleBibleGenerationContext !== "object") return empty;
		    var prev = project.styleBibleGenerationContext;
		    var cur = _styleCurrentGenerationContext();
		    var hasOwn = function (obj, key) {
		      return Object.prototype.hasOwnProperty.call(obj, key);
		    };
		    var norm = function (value) {
		      return value == null ? null : String(value);
		    };
		    var compareStrict = function (key) {
		      if (!hasOwn(prev, key)) return false;
		      return norm(prev[key]) !== norm(cur[key]);
		    };
		    var compareHash = function (key) {
		      if (!prev[key]) return false;
		      return String(prev[key]) !== String(cur[key] || "");
		    };
		    return {
		      aspectRatio: compareStrict("aspectRatio"),
		      world: compareStrict("worldTemplateId") || compareHash("worldTemplateHash"),
		      style: compareStrict("styleTemplateId") || compareHash("styleTemplateHash"),
		    };
		  }

		  function _styleGenerationContextChanged() {
		    var f = _styleGenerationContextChangedFields();
		    return f.aspectRatio || f.world || f.style;
		  }

		  function _styleBibleFreshnessReasons() {
		    if (!project || !_hasUsableStyleBibleForStylePage()) return [];
		    var reasons = [];
		    if (project.styleBibleStaleReason || (typeof _isStale === "function" && _isStale("style_bible"))) {
		      reasons.push("剧本");
		    }
		    var changed = _styleGenerationContextChangedFields();
		    if (changed.style) reasons.push("风格模板");
		    if (changed.world) reasons.push("世界观");
		    if (changed.aspectRatio) reasons.push("画幅");
		    return reasons;
		  }

		  // —— freshness 横幅的关闭持久化：按「差异状态签名」记忆 ——
		  // 签名包含差异原因 + 生成时/当前上下文 + 剧本指纹：用户点 X 后，同一状态下
		  // （含刷新）不再展示；一旦又有新的修改（签名变化），横幅重新出现。
		  function _styleFreshnessDismissSignature(reasons) {
		    var seed = JSON.stringify([
		      reasons,
		      (project && project.styleBibleGenerationContext) || null,
		      _styleCurrentGenerationContext(),
		      (project && project.styleBibleStaleReason) || "",
		      _styleAutoScriptKey()
		    ]);
		    var hash = 0;
		    for (var i = 0; i < seed.length; i++) {
		      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
		    }
		    return seed.length + ":" + Math.abs(hash).toString(36);
		  }

		  function _styleFreshnessDismissStorageKey() {
		    return "originStyleFreshnessDismiss:" + ((project && project.id) || "");
		  }

		  function _isStyleFreshnessBannerDismissed(signature) {
		    if (!signature) return false;
		    try {
		      return localStorage.getItem(_styleFreshnessDismissStorageKey()) === signature;
		    } catch (e) {
		      return false;
		    }
		  }

	  function _isStyleBibleGeneratingForStylePage() {
	    return !!(project && project.styleBibleStatus === "generating");
	  }

	  function _styleBibleStageLabel(stage) {
	    var map = {
	      core: "基础风格生成中",
	      characters: "角色视觉生成中",
	      visual: "视觉细节生成中",
		      visual_palette: "配色方案生成中",
		      visual_prompts: "Prompt 约束生成中",
	      visual_lens: "镜头与构图生成中",
	      production: "声音与字幕生成中"
	    };
	    return map[stage] || stage || "后台正在分段生成";
	  }

  function _normalizeStyleBible(sb) {
    sb = sb || {};
    return {
      visualStyle: sb.visualStyle || sb.vision || "",
      visualStyleDesc: sb.visualStyleDesc || "",
      colorPalette: sb.colorPalette || "",
      era: sb.era || "",
      mood: sb.mood || sb.tone || "",
      cameraStyle: sb.cameraStyle || "",
      lighting: sb.lighting || "",
      texture: sb.texture || "",
      editingRhythm: sb.editingRhythm || "",
      audio: sb.audio || sb.audioStyle || "",
      subtitleStyle: sb.subtitleStyle || "",
      dialogueStyle: sb.dialogueStyle || sb.narrationStyle || sb.voiceoverStyle || sb.dialogueRules || "",
      worldRules: sb.worldRules || "",
      characters: Array.isArray(sb.characters) ? sb.characters : [],
      negativePrompt: sb.negativePrompt || sb.videoNegativePrompt || "",
      additionalPrompt: sb.additionalPrompt || "",
    };
  }

  function _styleBibleFieldHtml(field, label, value, editable) {
    var displayValue = String(value || "").trim();
	    return '<div class="style-bible-field' + (editable ? ' is-editable' : '') + (displayValue ? '' : ' style-bible-empty') + '"' +
	      (editable ? ' data-style-field="' + escapeHtml(field) + '" data-style-label="' + escapeHtml(label) + '"' : '') + '>' +
	        '<span class="style-bible-field-label">' + escapeHtml(label) + '</span>' +
	        '<span class="style-bible-field-value" data-role="value">' + escapeHtml(displayValue || "待补充") + '</span>' +
	      '</div>';
	  }

	  function _styleUsageRuleHtml(field, label, value, icon, compact) {
	    var displayValue = String(value || "").trim();
	    return '<article class="style-usage-rule' + (compact ? ' style-usage-rule--compact' : '') + ' is-editable' + (displayValue ? '' : ' style-bible-empty') + '"' +
	      ' data-style-field="' + escapeHtml(field) + '" data-style-label="' + escapeHtml(label) + '">' +
	        (compact ? '' : '<span class="material-symbols-outlined style-usage-rule-icon">' + escapeHtml(icon || "notes") + '</span>') +
	        '<span class="style-usage-rule-copy">' +
	          '<strong>' + escapeHtml(label) + '</strong>' +
	          '<span class="style-usage-rule-value" data-role="value">' + escapeHtml(displayValue || "待补充") + '</span>' +
	        '</span>' +
	      '</article>';
	  }

  function _styleBibleSectionIcon(title) {
    var icons = {
      "视觉": "flare",
      "色彩": "palette",
      "镜头 / 光线": "camera",
      "时代 / 节奏": "history_edu",
      "音频 / 字幕": "subtitles",
      "Prompt 约束": "edit_note",
    };
    return icons[title] || "auto_awesome";
  }

  function _styleBibleSectionEn(title) {
    var labels = {
      "视觉": "VISUAL",
      "色彩": "COLOR PALETTE",
      "镜头 / 光线": "LENS / LIGHT",
      "时代 / 节奏": "ERA / RHYTHM",
      "音频 / 字幕": "AUDIO / SUBTITLE",
      "Prompt 约束": "PROMPT",
    };
    return labels[title] || "STYLE";
  }

  function _styleBibleSectionHtml(title, body, wide) {
    return '<section class="style-bible-section' + (wide ? ' style-bible-section--wide' : '') + '">' +
      '<h3><span class="material-symbols-outlined style-bible-section-icon">' + _styleBibleSectionIcon(title) + '</span>' +
      '<span>' + escapeHtml(title) + '</span><em>' + _styleBibleSectionEn(title) + '</em></h3>' +
      body +
    '</section>';
  }

  function _styleBibleSwatchesHtml(value) {
    if (Array.isArray(value)) {
      var palette = _stylePaletteItemsFromValue(value);
      if (palette.length) {
        return '<div class="style-bible-field is-editable" data-style-field="colorPalette" data-style-label="色彩调板">' +
          '<span class="style-bible-field-label">色彩调板</span>' +
          '<div class="style-bible-swatches">' +
            palette.map(function (item) {
              return '<div class="style-bible-swatch">' +
                '<span style="background:' + escapeHtml(item.hex || "#cfd8dc") + '"></span>' +
                '<strong>' + escapeHtml(item.name || item.hex || "色彩") + '</strong>' +
              '</div>';
            }).join("") +
          '</div>' +
        '</div>';
      }
    }
    return _styleBibleFieldHtml("colorPalette", "色彩调板", _stylePaletteText(value) || value || "", true);
  }

  function _styleBiblePromptValue(field) {
    var raw = (project && project.styleBible) || {};
    var normalized = _normalizeStyleBible(raw);
    if (field === "colorPalette") return _stylePaletteText(normalized.colorPalette);
    return String(normalized[field] || "").trim();
  }

	  function _commitStyleBibleFieldValue(field, label, next) {
	    if (!project) return false;
	    var cur = _styleBiblePromptValue(field);
	    next = String(next == null ? "" : next).trim();
	    if (next === cur) return false;
	    if (!project.styleBible || typeof project.styleBible !== "object") project.styleBible = {};
	    project.styleBible[field] = field === "colorPalette" ? _stylePaletteItemsFromValue(next) : next;
	    project.styleBible.updatedAt = new Date().toISOString();
	    project.styleBibleManuallyEditedAt = project.styleBible.updatedAt;
	    project.styleBibleSource = "manual";
	    _markDownstreamStale("style_bible", {});
	    saveProject();
	    _renderStylePageBiblePanel();
	    refreshStylePage();
	    showToast("已保存「" + label + "」；下游画面/视频提示词已标记为需重新生成", "success");
	    return true;
	  }

	  function _editStyleBibleField(field, label) {
	    // colorPalette 走原来的弹窗（"name:#hex" 语法不适合 inline）
	    if (!project) return;
	    var cur = _styleBiblePromptValue(field);
	    var next = window.prompt("编辑「" + label + "」\n\n保存后，下游画面/视频提示词会标记为需重新生成", cur);
	    if (next === null) return;
	    _commitStyleBibleFieldValue(field, label, next);
	  }

	  function _activateStyleBibleFieldInlineEdit(fieldEl) {
	    if (!fieldEl) return;
	    var field = fieldEl.getAttribute("data-style-field");
	    var label = fieldEl.getAttribute("data-style-label") || "";
	    if (!field) return;
	    // 色彩调板：name:#hex 语法用 prompt 更清晰
	    if (field === "colorPalette") {
	      _editStyleBibleField(field, label);
	      return;
	    }
	    var valueEl = fieldEl.querySelector('[data-role="value"]');
	    if (!valueEl) return;
	    if (valueEl.isContentEditable) return; // 已在编辑

	    var originalRaw = _styleBiblePromptValue(field);
	    var wasEmpty = fieldEl.classList.contains("style-bible-empty");
	    // 清掉「待补充」占位
	    if (wasEmpty) valueEl.textContent = "";
	    fieldEl.classList.add("is-editing");
	    valueEl.setAttribute("contenteditable", "true");
	    valueEl.setAttribute("spellcheck", "false");
	    valueEl.focus();
	    try {
	      var range = document.createRange();
	      range.selectNodeContents(valueEl);
	      var sel = window.getSelection();
	      sel.removeAllRanges();
	      sel.addRange(range);
	    } catch (e) {}

	    var state = { settled: false, cancelled: false };
	    function teardown() {
	      valueEl.removeAttribute("contenteditable");
	      valueEl.removeAttribute("spellcheck");
	      fieldEl.classList.remove("is-editing");
	    }
	    function settle() {
	      if (state.settled) return;
	      state.settled = true;
	      valueEl.removeEventListener("blur", onBlur);
	      valueEl.removeEventListener("keydown", onKeydown);

	      if (state.cancelled) {
	        teardown();
	        valueEl.textContent = originalRaw || "待补充";
	        if (!originalRaw) fieldEl.classList.add("style-bible-empty");
	        else fieldEl.classList.remove("style-bible-empty");
	        return;
	      }
	      var next = (valueEl.textContent || "").trim();
	      if (next === originalRaw) {
	        teardown();
	        valueEl.textContent = next || "待补充";
	        if (!next) fieldEl.classList.add("style-bible-empty");
	        else fieldEl.classList.remove("style-bible-empty");
	        return;
	      }
	      // _commitStyleBibleFieldValue 会触发整面板重渲染，先 teardown 一下避免遗留 class
	      teardown();
	      _commitStyleBibleFieldValue(field, label, next);
	    }
	    function onBlur() { settle(); }
	    function onKeydown(ev) {
	      if (ev.key === "Escape") {
	        ev.preventDefault();
	        state.cancelled = true;
	        valueEl.blur();
	      }
	    }
	    valueEl.addEventListener("blur", onBlur);
	    valueEl.addEventListener("keydown", onKeydown);
	  }

	  function _bindStyleBibleEditableFields(root) {
	    if (!root) return;
	    var editables = root.querySelectorAll("[data-style-field]");
	    for (var i = 0; i < editables.length; i++) {
	      editables[i].addEventListener("click", function (ev) {
	        var target = ev.currentTarget;
	        // 已在编辑中：让点击穿透到 contenteditable，正常移动光标
	        var valueEl = target.querySelector('[data-role="value"]');
	        if (valueEl && valueEl.isContentEditable) return;
	        _activateStyleBibleFieldInlineEdit(target);
	      });
	    }
	  }

	  function _renderStylePageBiblePanel() {
    var el = $("stylePageBiblePanel");
    if (!el) return;
	    var promptEl = $("stylePromptReferencePanel");
	    var usageEl = $("styleUsageNotesPanel");
    if (!project) {
      el.innerHTML = '<div class="style-bible-section style-bible-section--wide"><p class="style-bible-hint">请先创建或选择项目。</p></div>';
	      if (promptEl) promptEl.innerHTML = "";
		      if (usageEl) usageEl.innerHTML = "";
      return;
    }
    var sb = _normalizeStyleBible(project.styleBible);
    var html = "";
		    if (_isStyleBibleGeneratingForStylePage()) {
		      var hasPreviousStyleBible = _styleBibleHasContent(project.styleBible);
		      html += '<div class="upstream-stale-banner style-bible-section--wide is-generating">' +
		        '<span class="material-symbols-outlined upstream-stale-spinner">progress_activity</span>' +
		        '<div><strong>' + (hasPreviousStyleBible ? "风格圣经重新生成中……" : "风格圣经生成中……") + '</strong>' +
		        '</div>' +
		      '</div>';
		    }
		    if (!_isStyleBibleGeneratingForStylePage() && project && project.styleBibleStatus === "failed") {
		      var failedHasPrevious = _styleBibleHasContent(project.styleBible);
		      html += '<div class="upstream-stale-banner style-bible-section--wide is-error">' +
		        '<span class="material-symbols-outlined">error</span>' +
		        '<div><strong>风格圣经生成失败</strong>' +
		        '<p>' + escapeHtml(project.styleBibleError || "生成结果不完整或上游暂时不可用，请稍后重新生成。") + '</p>' +
		        (failedHasPrevious ? '<p>当前下方预览仍保留上一次可用结果，没有被失败任务覆盖。</p>' : "") +
		        '</div>' +
		      '</div>';
		    }
		    var freshnessReasons = _styleBibleFreshnessReasons();
		    if (!_isStyleBibleGeneratingForStylePage() && freshnessReasons.length) {
		      var freshnessSig = _styleFreshnessDismissSignature(freshnessReasons);
		      if (!_isStyleFreshnessBannerDismissed(freshnessSig)) {
		        html += '<div class="upstream-stale-banner style-bible-section--wide"' +
		          ' data-dismiss-store="' + escapeHtml(_styleFreshnessDismissStorageKey()) + '"' +
		          ' data-dismiss-key="' + escapeHtml(freshnessSig) + '">' +
		          '<span class="material-symbols-outlined">warning</span>' +
		          '<div><p>' + escapeHtml(freshnessReasons.join("、")) + '已修改，请点击「重新生成风格圣经」</p></div>' +
		        '</div>';
		      }
	    }
	    html += _styleBibleSectionHtml("视觉", [
	      _styleBibleFieldHtml("visualStyle", "视觉风格", sb.visualStyle, true),
	      _styleBibleFieldHtml("visualStyleDesc", "视觉风格描述", sb.visualStyleDesc, true),
	    ].join(""), false);
	    html += _styleBibleSectionHtml("色彩", _styleBibleSwatchesHtml(sb.colorPalette), false);
	    html += _styleBibleSectionHtml("镜头 / 光线", [
	      _styleBibleFieldHtml("cameraStyle", "镜头语言", sb.cameraStyle, true),
	      _styleBibleFieldHtml("lighting", "光线", sb.lighting, true),
	      _styleBibleFieldHtml("texture", "画面质感", sb.texture, true),
	    ].join(""), true);
	    el.innerHTML = html;

	    if (promptEl) {
	      promptEl.innerHTML = [
	        _styleBibleFieldHtml("negativePrompt", "禁止项 / 负向约束", sb.negativePrompt, true),
	        _styleBibleFieldHtml("additionalPrompt", "正向增强提示", sb.additionalPrompt, true),
	      ].join("");
	    }
	    if (usageEl) {
	      usageEl.innerHTML = [
	        _styleUsageRuleHtml("era", "时代与场景", sb.era, "event_note", false),
	        _styleUsageRuleHtml("worldRules", "世界观设定", sb.worldRules, "psychology", false),
	        _styleUsageRuleHtml("mood", "情绪基调", sb.mood, "mood", false),
	        _styleUsageRuleHtml("editingRhythm", "情绪节奏", sb.editingRhythm, "wb_sunny", false),
	        _styleUsageRuleHtml("audio", "声音风格", sb.audio, "volume_up", false),
	        _styleUsageRuleHtml("subtitleStyle", "字幕风格", sb.subtitleStyle, "", true),
	        _styleUsageRuleHtml("dialogueStyle", "旁白 / 对白", sb.dialogueStyle, "", true),
	      ].join("");
	    }

	    _bindStyleBibleEditableFields(el);
	    _bindStyleBibleEditableFields(promptEl);
	    _bindStyleBibleEditableFields(usageEl);
	  }

	  function _renderStyleWorldTemplateHint() {
	    var hint = $("styleWorldTemplateHint");
	    if (!hint) return;
	    if (project && project.styleBibleSource === "world_import") {
	      hint.hidden = false;
	      hint.textContent = "当前风格圣经来自世界观模板强导入，未关联风格模板。";
	      return;
	    }
	    hint.hidden = true;
	    hint.textContent = "";
	  }

	  function _styleWorldTemplateCount(tpl, countKey, listKeys) {
	    var num = Number(tpl && tpl[countKey]);
	    if (Number.isFinite(num) && num >= 0) return Math.floor(num);
	    for (var i = 0; i < listKeys.length; i++) {
	      var list = tpl && tpl[listKeys[i]];
	      if (Array.isArray(list)) return list.length;
	    }
	    return 0;
	  }

	  function _styleWorldTemplateCharacterKey(item) {
	    if (!item || typeof item !== "object") return String(item || "").trim().toLowerCase();
	    return String(item.characterId || item.id || item.sourceAssetId || item.name || item.title || item.role || "").trim().toLowerCase();
	  }

	  function _styleWorldTemplateCharacters(tpl) {
	    var byKey = {};
	    var keys = [];
	    var loose = [];
	    [tpl && tpl.characters, tpl && tpl.characterCandidates].forEach(function (list) {
	      if (!Array.isArray(list)) return;
	      list.forEach(function (item) {
	        var key = _styleWorldTemplateCharacterKey(item);
	        if (!key) {
	          loose.push(item);
	          return;
	        }
	        if (!Object.prototype.hasOwnProperty.call(byKey, key)) keys.push(key);
	        byKey[key] = byKey[key] ? Object.assign({}, item, byKey[key]) : item;
	      });
	    });
	    return keys.map(function (key) { return byKey[key]; }).concat(loose);
	  }

	  function _styleWorldTemplateCharacterCount(tpl) {
	    var num = Number(tpl && tpl.characterCount);
	    if (Number.isFinite(num) && num >= 0) return Math.floor(num);
	    return _styleWorldTemplateCharacters(tpl).length;
	  }

	  function _styleWorldTemplateEntityPreviewUrl(item) {
	    if (!item || typeof item !== "object") return "";
	    return String(
	      item.coverImageUrl ||
	      item.thumbnailUrl ||
	      item.realPhotoUrl ||
	      item.rawUrl ||
	      item.imageUrl ||
	      item.pencilUrl ||
	      item.referenceImageUrl ||
	      (item.referencePanels && (
	        item.referencePanels.headshotUrl ||
	        item.referencePanels.frontUrl ||
	        item.referencePanels.sheetUrl
	      )) ||
	      ""
	    ).trim();
	  }

	  function _styleWorldTemplatePreviewUrl(tpl) {
	    var lists = [
	      tpl && tpl.locationPreviewUrls,
	      tpl && tpl.scenePreviewUrls,
	      tpl && tpl.environmentPreviewUrls,
	      tpl && tpl.locations,
	      tpl && tpl.scenes,
	      tpl && tpl.environments,
	      tpl && tpl.propPreviewUrls,
	      tpl && tpl.props,
	      tpl && tpl.items,
	      tpl && tpl.keyItems,
	      tpl && tpl.artifacts,
	      tpl && tpl.characterPreviewUrls,
	      tpl && tpl.characters,
	      tpl && tpl.characterCandidates
	    ];
	    for (var i = 0; i < lists.length; i++) {
	      var list = lists[i];
	      if (!Array.isArray(list)) continue;
	      for (var j = 0; j < list.length; j++) {
	        var item = list[j];
	        var candidate = typeof item === "string" ? item : _styleWorldTemplateEntityPreviewUrl(item);
	        candidate = String(candidate || "").trim();
	        if (candidate) return candidate;
	      }
	    }
	    var direct = [
	      tpl && tpl.coverImageUrl,
	      tpl && tpl.thumbnailUrl,
	      tpl && tpl.previewUrl,
	      tpl && tpl.imageUrl
	    ];
	    for (var k = 0; k < direct.length; k++) {
	      var url = String(direct[k] || "").trim();
	      if (url) return url;
	    }
	    return "";
	  }

	  function _styleWorldTemplatePreferredStyleId(tpl) {
	    var preference = tpl && tpl.styleTemplatePreference;
	    return String(
	      (tpl && (
	        tpl.preferredStyleTemplateId ||
	        tpl.preferred_style_template_id
	      )) ||
	      (preference && (
	        preference.styleTemplateId ||
	        preference.templateId ||
	        preference.id
	      )) ||
	      ""
	    ).trim();
	  }

	  function _styleWorldTemplatePreferredAspect(tpl) {
	    var ratio = String(
	      (tpl && (tpl.preferredAspectRatio || tpl.preferred_aspect_ratio)) || ""
	    ).trim();
	    return _STYLE_ASPECT_RATIOS[ratio] ? ratio : "";
	  }

	  function _styleWorldTemplatePreferredStyleName(tpl) {
	    var preference = tpl && tpl.styleTemplatePreference;
	    return String(
	      (tpl && (
	        tpl.preferredStyleTemplateName ||
	        tpl.preferred_style_template_name
	      )) ||
	      (preference && (
	        preference.styleTemplateName ||
	        preference.name ||
	        preference.title
	      )) ||
	      ""
	    ).trim();
	  }

	  function _styleWorldTemplateStyleLabel(tpl) {
	    var preferredId = _styleWorldTemplatePreferredStyleId(tpl);
	    var raw = _styleWorldTemplatePreferredStyleName(tpl);
	    if (!raw && preferredId) raw = _styleTemplateNameById(preferredId);
	    if (!raw && project && tpl && String(project.selectedWorldTemplateId || "") === String(tpl.id || tpl.templateId || tpl.template_id || "")) {
	      raw = _styleCurrentSelectedTemplateName();
	    }
	    if (!raw) {
	      raw = String(
	        (tpl && (
	          tpl.styleLabel ||
	          tpl.worldStyle ||
	          tpl.styleName ||
	          tpl.styleTemplateName
	        )) ||
	        ""
	      ).trim();
	    }
	    raw = String(raw || "").trim().replace(/\s+/g, "");
	    if (!raw) return "世界观风格";
	    if (raw.length > 14) raw = raw.slice(0, 14);
	    return raw;
	  }

	  function _styleWorldTemplateSubtitle(tpl) {
	    var parts = [
	      _styleWorldTemplateCharacterCount(tpl) + "个角色",
	      _styleWorldTemplateCount(tpl, "locationCount", ["locations", "scenes", "environments", "places"]) + "个场景",
	      _styleWorldTemplateCount(tpl, "propCount", ["props", "items", "keyItems", "artifacts"]) + "个道具",
	      _styleWorldTemplateStyleLabel(tpl)
	    ];
	    var aspect = _styleWorldTemplatePreferredAspect(tpl);
	    if (aspect) parts.push(aspect);
	    return parts.join("、");
	  }

	  function _styleWorldTemplateThumbHtml(tpl) {
	    var url = _styleWorldTemplatePreviewUrl(tpl);
	    if (url) {
	      return '<span class="style-world-template-thumb"><img class="style-world-template-thumb-img" src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async"></span>';
	    }
	    return '<span class="style-world-template-thumb style-world-template-thumb--empty"><span class="material-symbols-outlined" aria-hidden="true">public</span></span>';
	  }

	  function _findWorldTemplateById(templates, tplId) {
	    tplId = String(tplId || "");
	    if (!tplId || !Array.isArray(templates)) return null;
	    for (var i = 0; i < templates.length; i++) {
	      if (String((templates[i] && templates[i].id) || "") === tplId) return templates[i];
	    }
	    return null;
	  }

	  function _styleWorldTemplateCardInnerHtml(tpl) {
	    var name = (tpl && tpl.name) || "未命名世界观";
	    var subtitle = _styleWorldTemplateSubtitle(tpl || {});
	    return _styleWorldTemplateThumbHtml(tpl || {}) +
	      '<span class="style-world-template-copy">' +
	        '<span class="style-template-name style-world-template-name">' + escapeHtml(name) + '</span>' +
	        '<span class="style-template-meta style-world-template-meta">' + escapeHtml(subtitle) + '</span>' +
	      '</span>';
	  }

	  function _renderStylePageWorldTemplates() {
	    var list = $("stylePageWorldTemplateList");
	    if (!list) return;
	    _renderStyleWorldTemplateHint();
	    var templates = (typeof _getWorldTemplates === "function") ? _getWorldTemplates() : [];
	    var selectedId = _selectedWorldTemplateId();
	    var clearBtn = $("btnStyleWorldClear");
	    if (clearBtn) {
	      clearBtn.disabled = !selectedId;
	      clearBtn.setAttribute("aria-disabled", selectedId ? "false" : "true");
	    }
	    if (selectedId) {
	      var selectedTpl = _findWorldTemplateById(templates, selectedId) || (project && project.worldTemplateSnapshot) || {};
	      list.innerHTML = '<article class="style-template-card style-world-template-card style-world-template-card--linked is-selected" aria-label="' + escapeHtml(((selectedTpl && selectedTpl.name) || "已关联世界观") + "，已关联") + '">' +
	        _styleWorldTemplateCardInnerHtml(selectedTpl) +
	      '</article>';
	    } else {
	      list.innerHTML = '<button type="button" class="style-template-card style-world-template-card style-world-template-card--add" data-world-add-toggle aria-haspopup="dialog" aria-controls="styleWorldTemplateModal">' +
	        '<span class="style-world-template-add-mark" aria-hidden="true">+</span>' +
	        '<span class="style-world-template-add-text">添加世界观</span>' +
	      '</button>';
	    }
	    hydrateProtectedImageElements(list);
	  }

	  function _renderStyleTemplateRecommendHint(source, tpl) {
	    var hint = $("styleTemplateRecommendHint");
	    if (!hint) return;
		    if (source === "manual") {
		      hint.hidden = true;
		      hint.textContent = "";
		      return;
		    }
		    if (tpl && _isLegacySystemStyleTemplate(tpl)) {
		      if (project && project.selectedWorldTemplateId) {
		        hint.hidden = false;
		        hint.textContent = "推荐风格「" + _styleTemplateSnapshotName(tpl) + "」可点击「更多」后手动选择。";
		      } else {
		        hint.hidden = true;
		        hint.textContent = "";
	      }
	      return;
	    }
	    var unavailable = !source || source === "none" || !tpl || !_isVisibleStyleTemplate(tpl);
	    if (unavailable) {
	      if (project && project.selectedWorldTemplateId) {
	        hint.hidden = false;
	        hint.textContent = "该世界观暂无可显示推荐风格，请手动选择画面风格。";
	      } else {
	        hint.hidden = true;
	        hint.textContent = "";
	      }
	      return;
	    }
	    hint.hidden = false;
	    if (source === "user_recent") {
	      hint.textContent = "你上次为该世界观使用了「" + _styleTemplateSnapshotName(tpl) + "」，可继续使用或手动修改。";
	    } else if (source === "world_preferred") {
	      hint.textContent = "世界观关联风格「" + _styleTemplateSnapshotName(tpl) + "」，可手动修改。";
	    } else if (source === "script_auto" || source === "script_auto_cached") {
	      hint.textContent = "系统已根据剧本默认选择「" + _styleTemplateSnapshotName(tpl) + "」，可手动修改。";
	    } else {
	      hint.textContent = "系统为该世界观推荐「" + _styleTemplateSnapshotName(tpl) + "」，可修改。";
	    }
	  }

			  var STYLE_LIBRARY_ORDER = [
			    "style_live_action_realistic",
			    "style_3d_xuanhuan",
			    "style_live_action_costume",
			    "style_3d_realistic",
			    "style_2d_animation",
			    "style_2d_movie",
			    "style_hollywood_blockbuster",
			  ];
			  var STYLE_LIBRARY_ORDER_MAP = STYLE_LIBRARY_ORDER.reduce(function (acc, id, idx) {
			    acc[id] = idx + 1;
			    return acc;
			  }, {});
			  var STYLE_LIBRARY_NAME_ORDER_MAP = {
			    "真人写实": 1,
			    "3D玄幻": 2,
			    "3D东方玄幻": 2,
			    "真人古装": 3,
			    "3D写实": 4,
			    "2D动画": 5,
			    "清新2D动画": 5,
			    "2D电影": 6,
			    "2D动画电影": 6,
			    "好莱坞大片": 7,
			  };

			  function _styleTemplateLibraryOrder(tpl) {
			    if (!tpl) return 0;
			    var tplId = String(tpl.id || "");
			    if (STYLE_LIBRARY_ORDER_MAP[tplId]) return STYLE_LIBRARY_ORDER_MAP[tplId];
			    var name = String(tpl.name || "").replace(/\s+/g, "");
			    return STYLE_LIBRARY_NAME_ORDER_MAP[name] || 0;
			  }

			  function _isVisibleStyleTemplate(tpl) {
			    return !!(tpl && (_styleTemplateLibraryOrder(tpl) || (tpl.source === "system" && String(tpl.category || "").trim() === "画面风格")));
			  }

		  function _isUserStyleTemplate(tpl) {
		    return !!(tpl && tpl.source === "user");
		  }

		  function _isLegacySystemStyleTemplate(tpl) {
		    return !!(tpl && tpl.source === "system" && !_isVisibleStyleTemplate(tpl));
		  }

			  function _styleTemplateSortOrder(tpl) {
			    var libraryOrder = _styleTemplateLibraryOrder(tpl);
			    if (libraryOrder) return libraryOrder;
			    var raw = tpl
			      ? (tpl.sort_order != null ? tpl.sort_order : tpl.sortOrder)
			      : undefined;
		    var value = Number(raw != null ? raw : 999);
		    return Number.isFinite(value) ? value : 999;
		  }

		  function _styleTemplateSortCompare(a, b) {
		    var byOrder = _styleTemplateSortOrder(a) - _styleTemplateSortOrder(b);
		    if (byOrder) return byOrder;
		    return String((a && a.name) || "").localeCompare(String((b && b.name) || ""), "zh-Hans-CN");
		  }

			  function _findStyleTemplateById(templates, id) {
			    id = String(id || "");
			    if (!id || !Array.isArray(templates)) return null;
			    for (var i = 0; i < templates.length; i++) {
			      if (String((templates[i] && templates[i].id) || "") === id) return templates[i];
			    }
			    return null;
			  }

			  function _styleTemplateBuckets(templates) {
			    var buckets = {
			      visibleSystem: [],
			      legacySystem: [],
			      mine: [],
			    };
			    if (!Array.isArray(templates)) return buckets;
			    for (var i = 0; i < templates.length; i++) {
			      if (_isVisibleStyleTemplate(templates[i])) buckets.visibleSystem.push(templates[i]);
			      else if (_isLegacySystemStyleTemplate(templates[i])) buckets.legacySystem.push(templates[i]);
			      else if (_isUserStyleTemplate(templates[i])) buckets.mine.push(templates[i]);
			    }
			    buckets.visibleSystem.sort(_styleTemplateSortCompare);
			    buckets.legacySystem.sort(_styleTemplateSortCompare);
			    buckets.mine.sort(_styleTemplateSortCompare);
			    return buckets;
			  }

			  function _styleTemplateWithoutId(items, id) {
			    id = String(id || "");
			    if (!id || !Array.isArray(items)) return Array.isArray(items) ? items.slice() : [];
			    return items.filter(function (tpl) {
			      return String((tpl && tpl.id) || "") !== id;
			    });
			  }

		  function _styleTemplateCurrentHiddenHtml(templates, selectedId) {
		    selectedId = String(selectedId || "");
		    if (!selectedId) return "";
		    var tpl = _findStyleTemplateById(templates, selectedId);
		    if (tpl && (_isVisibleStyleTemplate(tpl) || _isLegacySystemStyleTemplate(tpl) || _isUserStyleTemplate(tpl))) return "";
		    var snapshot = (project && project.styleTemplateSnapshot) || tpl || {};
		    if (!String((snapshot && snapshot.name) || "").trim()) return "";
		    var name = _styleTemplateSnapshotName(snapshot);
		    return '<div class="style-template-hint style-template-hint--legacy">' +
		      '当前使用「' + escapeHtml(name) + '」（已下线，仍可用于重新生成，建议重新选择画面风格）' +
		    '</div>';
		  }

		  function _styleTemplateMeta(tpl) {
		    var category = String((tpl && tpl.category) || "").trim();
		    var summary = String((tpl && tpl.summary) || "").trim();
		    var source = tpl && tpl.source === "system" ? "系统模板" : "我的模板";
		    return [source, category, summary].filter(Boolean).join(" · ");
		  }

		  function _styleTemplateImageUrl(tpl) {
		    tpl = tpl || {};
		    var value = String(
		      tpl.thumbnailUrl || tpl.thumbnail_url ||
		      tpl.coverUrl || tpl.cover_url ||
		      tpl.previewUrl || tpl.preview_url ||
		      tpl.imageUrl || tpl.image_url ||
		      ""
		    ).trim();
		    if (!value) return "";
		    if (/^(https?:|\/|blob:)/i.test(value)) return value;
		    if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value)) return value;
		    return "";
		  }

		  function _styleTemplateThemeKey(tpl) {
		    var text = [
		      tpl && tpl.id,
		      tpl && tpl.name,
		      tpl && tpl.category,
		      tpl && tpl.summary,
		    ].filter(Boolean).join(" ").toLowerCase();
		    if (text.indexOf("cyber") >= 0 || text.indexOf("霓虹") >= 0 || text.indexOf("赛博") >= 0) return "cyber";
		    if (text.indexOf("ink") >= 0 || text.indexOf("水墨") >= 0 || text.indexOf("诗意") >= 0) return "ink";
		    if (text.indexOf("fresh") >= 0 || text.indexOf("清新") >= 0 || text.indexOf("现代") >= 0) return "fresh";
		    if (text.indexOf("mock") >= 0 || text.indexOf("纪实") >= 0 || text.indexOf("手持") >= 0 || text.indexOf("纪录") >= 0) return "doc";
		    return "cinematic";
		  }

		  function _styleTemplateFallbackColors(theme) {
		    var palettes = {
		      cyber: ["#07111f", "#00d7ff", "#ff3db8", "#6d4dff", "#d9f8ff"],
		      ink: ["#f4efe5", "#17212a", "#6f8582", "#b63430", "#d8bb72"],
		      fresh: ["#f8f3e7", "#7fb6e8", "#9fcf95", "#d8b179", "#ffffff"],
		      doc: ["#e8ece8", "#2d3437", "#8aa1a8", "#cfd8dc", "#f6f0dc"],
		      cinematic: ["#0e2128", "#b58b45", "#e8dcc0", "#4b2c22", "#97a7aa"],
		    };
		    return palettes[theme] || palettes.cinematic;
		  }

		  function _styleTemplateColorFromToken(token) {
		    var value = String(token || "").trim();
		    if (!value) return "";
		    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
		    var named = {
		      "墨青": "#17323a", "鎏金": "#b58b45", "暖玉白": "#e8dcc0", "深檀": "#4b2c22", "雾灰": "#97a7aa",
		      "电蓝": "#00d7ff", "品红": "#ff3db8", "深紫": "#2c174d", "冷黑": "#07111f", "湿银": "#9fb3bd",
		      "奶油白": "#f8f3e7", "浅木": "#d8b179", "晴空蓝": "#7fb6e8", "草绿": "#9fcf95", "暖灰": "#b8b3aa",
		      "宣纸白": "#f4efe5", "墨黑": "#17212a", "远山青": "#6f8582", "朱砂": "#b63430", "淡金": "#d8bb72",
		      "冷白": "#e8ece8", "灰蓝": "#8aa1a8", "荧光绿": "#8cf06e", "水泥灰": "#8c9698", "浅棕": "#b89775",
		    };
		    for (var key in named) {
		      if (Object.prototype.hasOwnProperty.call(named, key) && value.indexOf(key) >= 0) return named[key];
		    }
		    return "";
		  }

		  function _styleTemplatePaletteColors(tpl) {
		    var theme = _styleTemplateThemeKey(tpl || {});
		    var fallback = _styleTemplateFallbackColors(theme);
		    var rules = (tpl && (tpl.visual_rules || tpl.visualRules)) || {};
		    var raw = rules.color_palette || rules.colorPalette || (tpl && (tpl.colorPalette || tpl.palette)) || [];
		    if (typeof raw === "string") raw = raw.split(/[、,，/|]/);
		    if (!Array.isArray(raw)) raw = [];
		    var colors = raw.map(_styleTemplateColorFromToken).filter(Boolean);
		    for (var i = 0; colors.length < 5 && i < fallback.length; i++) colors.push(fallback[i]);
		    return colors.slice(0, 5);
		  }

		  function _styleTemplateThumbSvg(tpl) {
		    var theme = _styleTemplateThemeKey(tpl || {});
		    var colors = _styleTemplatePaletteColors(tpl || {});
		    var c1 = colors[0], c2 = colors[1], c3 = colors[2], c4 = colors[3], c5 = colors[4];
		    var motif = "";
		    if (theme === "cyber") {
		      motif = '<rect x="16" y="54" width="13" height="44" rx="2" fill="' + c4 + '" opacity=".82"/><rect x="34" y="35" width="14" height="63" rx="2" fill="' + c2 + '" opacity=".68"/><rect x="55" y="46" width="11" height="52" rx="2" fill="' + c3 + '" opacity=".72"/><path d="M8 82 C38 58 59 69 112 28" fill="none" stroke="' + c3 + '" stroke-width="4" opacity=".82"/><path d="M6 101 L113 54" stroke="' + c2 + '" stroke-width="2" opacity=".8"/>';
		    } else if (theme === "ink") {
		      motif = '<circle cx="83" cy="31" r="17" fill="' + c4 + '" opacity=".88"/><path d="M-4 87 C20 50 42 78 61 48 C79 22 95 61 126 31 L126 126 L-4 126 Z" fill="' + c3 + '" opacity=".56"/><path d="M0 94 C27 72 45 91 70 66 C86 49 100 74 122 55" fill="none" stroke="' + c2 + '" stroke-width="8" stroke-linecap="round" opacity=".62"/><path d="M19 30 C36 22 53 26 68 16" fill="none" stroke="' + c2 + '" stroke-width="3" stroke-linecap="round" opacity=".38"/>';
		    } else if (theme === "fresh") {
		      motif = '<circle cx="89" cy="28" r="21" fill="' + c2 + '" opacity=".75"/><rect x="16" y="45" width="58" height="48" rx="13" fill="#fff" opacity=".72"/><path d="M20 71 C39 45 64 52 79 25" fill="none" stroke="' + c3 + '" stroke-width="7" stroke-linecap="round" opacity=".78"/><path d="M19 95 C42 83 66 94 101 75" stroke="' + c4 + '" stroke-width="5" stroke-linecap="round" opacity=".6"/>';
		    } else if (theme === "doc") {
		      motif = '<rect x="15" y="18" width="90" height="84" rx="6" fill="none" stroke="' + c2 + '" stroke-width="4" opacity=".74"/><path d="M30 18 L16 18 L16 32 M90 18 L104 18 L104 32 M16 88 L16 102 L30 102 M104 88 L104 102 L90 102" stroke="' + c2 + '" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="59" cy="59" r="19" fill="' + c3 + '" opacity=".44"/><path d="M25 78 C42 66 54 92 75 70 C84 61 94 67 104 58" stroke="' + c4 + '" stroke-width="4" fill="none" opacity=".7"/>';
		    } else {
		      motif = '<circle cx="88" cy="30" r="18" fill="' + c2 + '" opacity=".86"/><path d="M10 88 C28 53 49 67 63 38 C78 9 92 57 116 26 L116 120 L10 120 Z" fill="' + c1 + '" opacity=".72"/><path d="M13 94 C40 76 57 91 84 65 C95 55 103 62 116 51" stroke="' + c3 + '" stroke-width="6" fill="none" opacity=".82"/><rect x="20" y="64" width="40" height="34" rx="3" fill="' + c4 + '" opacity=".48"/>';
		    }
		    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
		      '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c1 + '"/><stop offset=".58" stop-color="' + c5 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient><pattern id="grain" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#fff" opacity=".18"/></pattern></defs>' +
		      '<rect width="120" height="120" rx="22" fill="url(#bg)"/><rect width="120" height="120" rx="22" fill="url(#grain)" opacity=".5"/>' +
		      motif +
		      '<rect x="8" y="8" width="104" height="104" rx="18" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2"/></svg>';
		  }

		  function _styleTemplateThumbHtml(tpl) {
		    var url = _styleTemplateImageUrl(tpl || {});
		    var src = url || ("data:image/svg+xml;charset=UTF-8," + encodeURIComponent(_styleTemplateThumbSvg(tpl || {})));
		    return '<span class="style-template-thumb" aria-hidden="true">' +
		      '<img class="style-template-thumb-img" src="' + escapeHtml(src) + '" alt="" loading="lazy" />' +
		      '</span>';
		  }

		  function _styleTemplateGroupHtml(title, items, selectedId, opts) {
		    opts = opts || {};
		    var library = !!opts.library;
		    var legacy = !!opts.legacy;
		    var moreCount = Number(opts.moreCount || 0);
		    if (!items.length && !(library && moreCount > 0)) return "";
			    var html = "";
			    if (String(title || "").trim()) {
			      html += '<div class="style-template-group-title' + (library ? ' style-template-group-title--library' : '') + '">' + escapeHtml(title) + '</div>';
			    }
		    html += '<div class="' + (library ? 'style-template-library-row' : 'style-template-user-row') + (legacy ? ' style-template-library-row--more' : '') + '">';
		    html += items.map(function (tpl, i) {
		      var tplId = String(tpl.id || "");
		      var selected = selectedId && tplId && selectedId === tplId;
		      if (library) {
		        return '<button type="button" class="style-template-card style-template-card--style style-template-card--library' + (legacy ? ' style-template-card--legacy' : '') + (selected ? ' is-selected' : '') + '" data-style-tpl-id="' + escapeHtml(tplId) + '">' +
		          _styleTemplateThumbHtml(tpl) +
		          '<span class="style-template-card-title">' + escapeHtml(tpl.name || "未命名风格") + '</span>' +
		        '</button>';
		      }
		      return '<button type="button" class="style-template-card style-template-card--style' + (selected ? ' is-selected' : '') + '" data-style-tpl-id="' + escapeHtml(tplId) + '">' +
		        _styleTemplateThumbHtml(tpl) +
		        '<div class="style-template-copy">' +
		          '<div class="style-template-name">' + escapeHtml(tpl.name || "未命名风格") + '</div>' +
		          '<div class="style-template-meta">' + escapeHtml(_styleTemplateMeta(tpl)) + (selected ? ' · 已选中' : '') + '</div>' +
		        '</div>' +
		        '</button>';
			    }).join("");
			    if (library && moreCount > 0) {
			      html += '<button type="button" class="style-template-card style-template-card--library style-template-card--more" data-style-more-toggle="1" aria-haspopup="dialog" aria-controls="styleTemplateModal">' +
			        '<span>更多<span aria-hidden="true">→</span></span>' +
			      '</button>';
			    }
		    html += '</div>';
		    return html;
		  }

	  function _styleTemplateSkeletonCardHtml() {
	    return '<div class="style-template-card style-template-card--style style-template-card--library style-template-card--loading"></div>';
	  }

	  // 幂等渲染：内容相同「且列表仍有子元素」才跳过，避免反复重建 <img> 缩略图导致 lazy-load 闪烁。
	  // refreshStylePage 一次刷新会多次触发本渲染（同步 + prime 回调 + 其它入口），不去重每次都会
	  // 重建图片、缩略图反复 dark→loaded 闪。childElementCount 兜底：列表若被别处清空（签名仍是旧值），
	  // 也照常重渲染，杜绝留白空白。
	  function _setStyleTplListHtml(list, html) {
	    if (list.childElementCount > 0 && list.getAttribute('data-style-tpl-sig') === html) return;
	    list.setAttribute('data-style-tpl-sig', html);
	    list.innerHTML = html;
	  }

	  function _renderStylePageTemplates() {
	    var list = $("stylePageTemplateList");
	    if (!list) return;
	    var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
	    if (!templates.length) {
	      // 模板还在异步拉取（首次进入 / 浏览器刷新，缓存尚未 prime）时，不要闪一下
	      // 「暂无可用风格模板」空态：渲染同尺寸占位骨架，prime 完成后会再次渲染真实模板。
	      var styleTplLoaded = (typeof _styleTemplatesLoaded === "function") ? _styleTemplatesLoaded() : true;
	      if (!styleTplLoaded) {
	        _setStyleTplListHtml(list, '<div class="style-template-library-row" aria-hidden="true">' +
	          _styleTemplateSkeletonCardHtml() + _styleTemplateSkeletonCardHtml() +
	          _styleTemplateSkeletonCardHtml() + _styleTemplateSkeletonCardHtml() + '</div>');
	        return;
	      }
	      _setStyleTplListHtml(list, '<p class="style-template-empty">暂无可用风格模板。系统模板初始化后会显示在这里。</p>');
	      _renderStyleTemplateRecommendHint("none", null);
	      return;
		    }
		    var selectedId = _selectedStyleTemplateId();
			    var buckets = _styleTemplateBuckets(templates);
			    var selectedTpl = _findStyleTemplateById(templates, selectedId);
			    var featured = buckets.visibleSystem.slice();
			    if (selectedTpl && (_isLegacySystemStyleTemplate(selectedTpl) || _isUserStyleTemplate(selectedTpl))) {
			      featured = [selectedTpl].concat(featured);
			      buckets.legacySystem = _styleTemplateWithoutId(buckets.legacySystem, selectedId);
			      buckets.mine = _styleTemplateWithoutId(buckets.mine, selectedId);
			    }
		    var moreCount = buckets.legacySystem.length + buckets.mine.length;
		    var html = "";
		    html += _styleTemplateCurrentHiddenHtml(templates, selectedId);
		    html += _styleTemplateGroupHtml("", featured, selectedId, { library: true, moreCount: moreCount });
		    html += _styleTemplateGroupHtml("我的风格模板", buckets.mine, selectedId, { library: false });
			    if (!html) html = '<p class="style-template-empty">暂无可用风格模板。</p>';
			    _setStyleTplListHtml(list, html);
			  }

			  function _styleTemplateModalCardHtml(tpl, badge) {
			    var tplId = String((tpl && tpl.id) || "");
			    var selected = _styleTemplateModalTempId && tplId && _styleTemplateModalTempId === tplId;
			    return '<button type="button" class="style-template-modal-card' + (selected ? ' is-selected' : '') + '" data-style-modal-tpl-id="' + escapeHtml(tplId) + '">' +
			      '<span class="style-template-modal-badge">' + escapeHtml(badge || "精选") + '</span>' +
			      _styleTemplateThumbHtml(tpl) +
			      '<span class="style-template-card-title">' + escapeHtml((tpl && tpl.name) || "未命名风格") + '</span>' +
			      '<span class="style-template-modal-check" aria-hidden="true">✓</span>' +
			    '</button>';
			  }

			  function _styleTemplateModalGroupHtml(title, items, badge) {
			    if (!Array.isArray(items) || !items.length) return "";
			    return '<div class="style-template-modal-group">' +
			      '<div class="style-template-modal-group-title">' + escapeHtml(title || "") + '</div>' +
			      '<div class="style-template-modal-grid">' +
			        items.map(function (tpl) { return _styleTemplateModalCardHtml(tpl, badge); }).join("") +
			      '</div>' +
			    '</div>';
			  }

			  function _renderStyleTemplateModal() {
			    var existing = $("styleTemplateModal");
			    if (!_styleTemplateModalOpen) {
			      if (existing) existing.remove();
			      document.body.classList.remove("style-template-modal-lock");
			      return;
			    }
			    var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
			    var buckets = _styleTemplateBuckets(templates);
			    var selectedTpl = _findStyleTemplateById(templates, _styleTemplateModalTempId);
			    var groupsHtml = "";
			    groupsHtml += _styleTemplateModalGroupHtml("精选风格", buckets.visibleSystem, "精选");
			    groupsHtml += _styleTemplateModalGroupHtml("更多风格", buckets.legacySystem, "更多");
			    groupsHtml += _styleTemplateModalGroupHtml("我的风格模板", buckets.mine, "我的");
			    if (!groupsHtml) {
			      groupsHtml = '<div class="style-template-modal-empty">暂无可用风格模板。</div>';
			    }
			    var html = '<div class="style-template-modal-backdrop" id="styleTemplateModal" role="presentation">' +
			      '<section class="style-template-modal" role="dialog" aria-modal="true" aria-labelledby="styleTemplateModalTitle">' +
			        '<header class="style-template-modal-head">' +
			          '<div>' +
			            '<h2 id="styleTemplateModalTitle">全部风格</h2>' +
			            '<p>选择一个风格模板，确认后应用到当前项目。</p>' +
			          '</div>' +
			          '<button type="button" class="style-template-modal-close" data-style-template-modal-close aria-label="关闭">×</button>' +
			        '</header>' +
			        '<div class="style-template-modal-body">' + groupsHtml + '</div>' +
			        '<footer class="style-template-modal-foot">' +
			          '<div class="style-template-modal-current">当前选择：<strong>' + escapeHtml(selectedTpl ? (selectedTpl.name || "未命名风格") : "未选择") + '</strong></div>' +
			          '<div class="style-template-modal-actions">' +
			            '<button type="button" class="style-template-modal-btn style-template-modal-btn--ghost" data-style-template-modal-cancel>取消</button>' +
			            '<button type="button" class="style-template-modal-btn style-template-modal-btn--primary" data-style-template-modal-confirm' + (_styleTemplateModalTempId ? '' : ' disabled') + '>确认</button>' +
			          '</div>' +
			        '</footer>' +
			      '</section>' +
			    '</div>';
			    if (existing) existing.outerHTML = html;
			    else document.body.insertAdjacentHTML("beforeend", html);
			    document.body.classList.add("style-template-modal-lock");
			  }

			  function _openStyleTemplateModal() {
			    var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
			    var selectedId = _selectedStyleTemplateId();
			    _styleTemplateModalTempId = _findStyleTemplateById(templates, selectedId) ? selectedId : "";
			    _styleTemplateModalOpen = true;
			    _renderStyleTemplateModal();
			    setTimeout(function () {
			      var selectedCard = document.querySelector(".style-template-modal-card.is-selected");
			      var closeBtn = document.querySelector("[data-style-template-modal-close]");
			      var focusTarget = selectedCard || closeBtn || $("styleTemplateModal");
			      if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
			    }, 0);
			  }

			  function _closeStyleTemplateModal() {
			    _styleTemplateModalOpen = false;
			    _styleTemplateModalTempId = "";
			    _renderStyleTemplateModal();
			  }

			  function _confirmStyleTemplateModal() {
			    if (!_styleTemplateModalOpen) return;
			    var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
			    var tplId = String(_styleTemplateModalTempId || "");
			    var tpl = _findStyleTemplateById(templates, tplId);
			    if (!tpl) {
			      showToast("请先选择一个风格模板", "warn");
			      return;
			    }
			    if (tplId === _selectedStyleTemplateId()) {
			      _closeStyleTemplateModal();
			      return;
			    }
				    Promise.resolve(_applyStyleTemplateFromStylePage(tpl))
				      .then(function () { _closeStyleTemplateModal(); })
				      .catch(function (err) {
				        showToast("风格模板选择失败: " + ((err && err.message) || err), "error");
				      });
				  }

				  function _styleWorldTemplateModalOptionHtml(tpl) {
				    var tplId = String((tpl && tpl.id) || "");
				    var selected = _styleWorldTemplateModalTempId && tplId && _styleWorldTemplateModalTempId === tplId;
				    return '<button type="button" class="style-world-modal-option' + (selected ? ' is-selected' : '') + '" data-world-modal-tpl-id="' + escapeHtml(tplId) + '">' +
				      _styleWorldTemplateThumbHtml(tpl) +
				      '<span class="style-world-template-copy">' +
				        '<span class="style-template-name style-world-template-name">' + escapeHtml((tpl && tpl.name) || "未命名世界观") + '</span>' +
				        '<span class="style-template-meta style-world-template-meta">' + escapeHtml(_styleWorldTemplateSubtitle(tpl || {})) + '</span>' +
				      '</span>' +
				      '<span class="style-template-modal-check" aria-hidden="true">✓</span>' +
				    '</button>';
				  }

				  function _renderStyleWorldTemplateModal() {
				    var existing = $("styleWorldTemplateModal");
				    if (!_styleWorldTemplateModalOpen) {
				      if (existing) existing.remove();
				      if (!_styleTemplateModalOpen) document.body.classList.remove("style-template-modal-lock");
				      return;
				    }
				    var templates = (typeof _getWorldTemplates === "function") ? _getWorldTemplates() : [];
				    var selectedTpl = _findWorldTemplateById(templates, _styleWorldTemplateModalTempId);
				    var bodyHtml = "";
				    if (_styleWorldTemplateModalLoading) {
				      bodyHtml = '<div class="style-template-modal-empty">正在加载世界观模板...</div>';
				    } else if (templates.length) {
				      bodyHtml = '<div class="style-world-modal-options">' + templates.map(_styleWorldTemplateModalOptionHtml).join("") + '</div>';
				    } else {
				      bodyHtml = '<div class="style-template-modal-empty">还没有保存过世界观模板。可先在资产库保存世界观模板。</div>';
				    }
				    var html = '<div class="style-template-modal-backdrop style-world-modal-backdrop" id="styleWorldTemplateModal" role="presentation">' +
				      '<section class="style-template-modal style-world-modal" role="dialog" aria-modal="true" aria-labelledby="styleWorldTemplateModalTitle">' +
				        '<header class="style-template-modal-head style-world-modal-head">' +
				          '<div>' +
				            '<h2 id="styleWorldTemplateModalTitle">选择世界观</h2>' +
				            '<p>选择一个世界观作为当前项目的内容规则和资产候选池参考。</p>' +
				          '</div>' +
				          '<button type="button" class="style-template-modal-close style-world-modal-close" data-world-template-modal-close aria-label="关闭">×</button>' +
				        '</header>' +
				        '<div class="style-template-modal-body style-world-modal-body">' + bodyHtml + '</div>' +
				        '<footer class="style-template-modal-foot style-world-modal-foot">' +
				          '<div class="style-template-modal-current style-world-modal-current">待关联：<strong>' + escapeHtml(selectedTpl ? (selectedTpl.name || "未命名世界观") : "未选择") + '</strong></div>' +
				          '<div class="style-template-modal-actions">' +
				            '<button type="button" class="style-template-modal-btn style-template-modal-btn--ghost style-world-modal-btn" data-world-template-modal-cancel>取消</button>' +
				            '<button type="button" class="style-template-modal-btn style-template-modal-btn--primary style-world-modal-btn" data-world-template-modal-confirm' + (_styleWorldTemplateModalTempId ? '' : ' disabled') + '>确认</button>' +
				          '</div>' +
				        '</footer>' +
				      '</section>' +
				    '</div>';
				    if (existing) existing.outerHTML = html;
				    else document.body.insertAdjacentHTML("beforeend", html);
				    document.body.classList.add("style-template-modal-lock");
				    hydrateProtectedImageElements($("styleWorldTemplateModal"));
				  }

				  function _openStyleWorldTemplateModal() {
				    _styleWorldTemplateModalTempId = "";
				    _styleWorldTemplateModalOpen = true;
				    var templates = (typeof _getWorldTemplates === "function") ? _getWorldTemplates() : [];
				    _styleWorldTemplateModalLoading = !templates.length && typeof _primeWorldTemplates === "function";
				    _renderStyleWorldTemplateModal();
				    if (_styleWorldTemplateModalLoading) {
				      _primeWorldTemplates().then(function () {
				        _styleWorldTemplateModalLoading = false;
				        _renderStyleWorldTemplateModal();
				      }).catch(function (err) {
				        _styleWorldTemplateModalLoading = false;
				        _renderStyleWorldTemplateModal();
				        showToast("世界观模板加载失败: " + ((err && err.message) || err), "error");
				      });
				    }
				    setTimeout(function () {
				      var closeBtn = document.querySelector("[data-world-template-modal-close]");
				      if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
				    }, 0);
				  }

				  function _closeStyleWorldTemplateModal() {
				    _styleWorldTemplateModalOpen = false;
				    _styleWorldTemplateModalTempId = "";
				    _styleWorldTemplateModalLoading = false;
				    _renderStyleWorldTemplateModal();
				  }

				  function _normalizeStyleWorldIntent(intent) {
				    intent = intent || {};
				    var worldId = intent.selectedWorldTemplateId == null ? null : String(intent.selectedWorldTemplateId || "").trim();
				    var snapshot = intent.worldTemplateSnapshot && typeof intent.worldTemplateSnapshot === "object"
				      ? intent.worldTemplateSnapshot
				      : null;
				    if (!worldId && snapshot) {
				      worldId = String(snapshot.id || snapshot.templateId || snapshot.template_id || "").trim() || null;
				    }
				    return {
				      selectedWorldTemplateId: worldId || null,
				      worldTemplateSnapshot: snapshot,
				    };
				  }

				  function _renderStyleWorldIntentUi(intent) {
				    intent = _normalizeStyleWorldIntent(intent);
				    _renderStylePageWorldTemplates();
				    // 应用世界观可能同步了记录的画面比例，刷新画幅选中态
				    _renderStyleAspectRatio();
				    var templates = (typeof _getWorldTemplates === "function") ? _getWorldTemplates() : [];
				    var tpl = intent.selectedWorldTemplateId
				      ? _findWorldTemplateById(templates, intent.selectedWorldTemplateId)
				      : null;
				    _renderStyleTemplateRecommendHint(intent.selectedWorldTemplateId ? "world" : "none", tpl);
				    _renderStyleInferenceHint();
				    _renderStylePageBiblePanel();
				  }

				  function _applyStyleWorldIntentLocal(intent) {
				    if (!project || !intent || (intent.projectId && project.id !== intent.projectId)) return false;
				    var normalized = _normalizeStyleWorldIntent(intent);
				    project.selectedWorldTemplateId = normalized.selectedWorldTemplateId;
				    project.worldTemplateSnapshot = normalized.worldTemplateSnapshot;
				    _syncProjectModules(project);
				    _renderStyleWorldIntentUi(normalized);
				    return true;
				  }

				  function _flushStyleWorldIntent(job, attempt) {
				    return Promise.resolve(_flushServerSave()).then(function (result) {
				      if (!job || job.seq !== _styleWorldPersistSeq) return result;
				      if (result && result.ok) return result;
				      if (result && result.stale && attempt < 1) {
				        if (!_applyStyleWorldIntentLocal(job)) return result;
				        return _flushStyleWorldIntent(job, attempt + 1);
				      }
				      if (_applyStyleWorldIntentLocal(job)) {
				        try { saveProject(); } catch (e) { console.warn("[StyleWorld] deferred save failed:", e); }
				        showToast("世界观关联保存失败，已保留页面状态，系统会稍后重试。", "warn");
				      }
				      return result;
				    }).catch(function (err) {
				      if (job && job.seq === _styleWorldPersistSeq && _applyStyleWorldIntentLocal(job)) {
				        try { saveProject(); } catch (e) { console.warn("[StyleWorld] deferred save failed:", e); }
				        showToast("世界观关联保存失败，已保留页面状态，系统会稍后重试。", "warn");
				      }
				      console.warn("[StyleWorld] background save failed:", err);
				      return { ok: false, error: err };
				    });
				  }

				  function _persistStyleWorldIntent(intent) {
				    if (!project || !project.id) return Promise.resolve({ ok: false, reason: "no-project" });
				    var normalized = _normalizeStyleWorldIntent(intent);
				    var job = {
				      projectId: project.id,
				      seq: ++_styleWorldPersistSeq,
				      selectedWorldTemplateId: normalized.selectedWorldTemplateId,
				      worldTemplateSnapshot: normalized.worldTemplateSnapshot,
				    };
				    _applyStyleWorldIntentLocal(job);
				    return _flushStyleWorldIntent(job, 0);
				  }

					  function _applyWorldTemplateSelection(tpl) {
					    return Promise.resolve(_applyWorldTemplateReferenceFromStylePage(tpl))
					      .then(function () {
					        return _applyRecommendedStyleTemplateForWorld();
					      });
					  }

					  function _confirmStyleWorldTemplateModal() {
					    if (!_styleWorldTemplateModalOpen) return;
					    var templates = (typeof _getWorldTemplates === "function") ? _getWorldTemplates() : [];
					    var tpl = _findWorldTemplateById(templates, _styleWorldTemplateModalTempId);
					    if (!tpl) {
					      showToast("请先选择一个世界观", "warn");
					      return;
					    }
					    _closeStyleWorldTemplateModal();
					    _applyWorldTemplateSelection(tpl)
					      .catch(function (err) {
					        showToast("世界观关联失败: " + ((err && err.message) || err), "error");
					      });
					  }

			  function _styleBibleHasContent(sb) {
	    if (!sb || typeof sb !== "object") return false;
	    return Object.keys(sb).some(function (key) {
	      var value = sb[key];
	      if (Array.isArray(value)) return value.length > 0;
	      if (value && typeof value === "object") return Object.keys(value).length > 0;
	      return String(value || "").trim().length > 0;
	    });
	  }

	  function _hasUsableStyleBibleForStylePage() {
	    if (!project || !project.styleBible || !_styleBibleHasContent(project.styleBible)) return false;
	    if (project.styleBibleStatus === "ready") return true;
	    if (!project.styleBibleStatus) return true;
	    return false;
	  }

	  function _styleEffectiveOptionsForRequest() {
	    var opts = (project && project.styleOptions) || {};
	    return {
	      aspectRatio: _styleAspectRatioValue(),
	      styleTemplateSelectionMode: opts.styleTemplateSelectionMode || "",
	      styleTemplateSelectionSource: opts.styleTemplateSelectionSource || "",
	      styleTemplateSelectedAt: opts.styleTemplateSelectedAt || "",
	      autoStyleTemplateId: opts.autoStyleTemplateId || "",
	      autoStyleTemplateReason: opts.autoStyleTemplateReason || "",
	      autoStyleTemplateScriptKey: opts.autoStyleTemplateScriptKey || "",
	    };
	  }

	  async function _confirmStyleBibleRegeneration() {
	    if (!_hasUsableStyleBibleForStylePage()) return true;
	    var editedAt = Date.parse(project.styleBibleManuallyEditedAt || "");
	    var generatedAt = Date.parse(project.styleBibleGeneratedAt || "");
	    if (Number.isFinite(editedAt) && (!Number.isFinite(generatedAt) || editedAt > generatedAt)) {
	      return showConfirm("重新生成风格圣经", "将覆盖你手工修改过的风格字段。确认继续？", "覆盖并生成", "取消");
	    }
	    if (_styleBibleFreshnessReasons().length) return true;
	    return showConfirm("重新生成风格圣经", "将基于当前已确认剧本重新生成项目风格圣经。确认继续？", "重新生成", "取消");
	  }

	  function _renderStylePageStatusPanels() {
	    var page = $("pageStyle");
	    if (!page) return;
	    var kicker = $("styleProjectKicker");
	    if (kicker) kicker.textContent = "PROJECT STYLE";
	    var extractBtn = $("btnStyleExtract");
	    if (extractBtn) {
	      var generating = _isStyleBibleGeneratingForStylePage();
	      var hasExistingStyleBible = _styleBibleHasContent(project && project.styleBible);
	      var hasUsableStyleBible = _hasUsableStyleBibleForStylePage();
	      var hasStyleBibleAttempt = !!(project && project.styleBibleStatus === "failed");
	      extractBtn.innerHTML = '<span class="material-symbols-outlined">auto_awesome</span>' +
	        (generating ? (hasExistingStyleBible ? "风格圣经重新生成中……" : "风格圣经生成中……") : ((hasUsableStyleBible || hasExistingStyleBible || hasStyleBibleAttempt) ? "重新生成风格圣经" : "生成风格圣经"));
	      extractBtn.disabled = !!generating;
	    }
	    _renderStyleBibleTemplateBadge();
	    _renderStyleInferenceHint();
	    _renderStylePageBiblePanel();
	  }

	  async function _reloadCurrentProjectForStylePage(options) {
	    options = options || {};
	    if (!project || !project.id) return false;
	    try {
	      var p = await loadProjectData(project.id);
	      if (!p || !p.id || p.id !== project.id) return false;
	      project = p;
	      _syncProjectModules(project);
	      if (options.statusOnly && project.styleBibleStatus === "generating") {
	        _renderStylePageStatusPanels();
	      } else {
	        refreshStylePage();
	      }
	      return true;
	    } catch (e) {
	      console.warn("[StylePage] reload project failed:", e);
	      return false;
	    }
	  }

	  async function _waitForStyleBibleGeneration() {
	    showToast("另一处正在生成风格圣经，请稍候", "info");
	    for (var i = 0; i < 30; i++) {
	      await sleep(2000);
	      await _reloadCurrentProjectForStylePage({ statusOnly: true });
	      if (!project) break;
	      if (project.styleBibleStatus === "ready") {
	        showToast("风格圣经已生成", "success");
	        return true;
	      }
	      if (project.styleBibleStatus === "failed") {
	        showToast("风格圣经生成失败: " + (project.styleBibleError || "未知错误"), "error");
	        return false;
	      }
	    }
	    showToast("生成仍在进行或已超时，可稍后点击重新生成", "warn");
	    return false;
	  }

	  var _styleBiblePollActive = false;
	  async function _ensureStyleBiblePollingForStylePage() {
	    if (_styleBiblePollActive) return;
	    if (!project || project.styleBibleStatus !== "generating") return;
	    _styleBiblePollActive = true;
	    var pollingProjectId = project.id;
	    try {
	      var deadline = Date.now() + 30 * 60 * 1000;
	      var attempt = 0;
	      while (Date.now() < deadline) {
	        if (!project || project.id !== pollingProjectId) return;
	        if (project.styleBibleStatus !== "generating") return;
	        await sleep(attempt < 5 ? 2000 : 5000);
	        attempt++;
	        if (!project || project.id !== pollingProjectId) return;
	        if (project.styleBibleStatus !== "generating") return;
	        var reloaded = await _reloadCurrentProjectForStylePage({ statusOnly: true });
	        if (!reloaded) continue;
	        if (!project || project.id !== pollingProjectId) return;
	        if (project.styleBibleStatus === "ready") { showToast("风格圣经已生成", "success"); return; }
	        if (project.styleBibleStatus === "failed") { showToast("风格圣经生成失败: " + (project.styleBibleError || "未知错误"), "error"); return; }
	      }
	    } finally {
	      _styleBiblePollActive = false;
	    }
	  }

	  function refreshStylePage() {
	    var page = $("pageStyle");
	    if (!page) return;
	    _renderStylePageStatusPanels();
	    _renderStyleAspectRatio();
	    _ensureStyleBiblePollingForStylePage();
	    _renderStylePageWorldTemplates();
	    _renderStylePageTemplates();
    if (typeof _primeWorldTemplates === "function") {
      _primeWorldTemplates().then(function () { _renderStylePageWorldTemplates(); });
    }
    if (typeof _primeStyleTemplates === "function") {
      _primeStyleTemplates().then(function () {
        _renderStylePageTemplates();
        _renderStyleBibleTemplateBadge();
        _ensureAutoStyleTemplateForStylePage();
      });
    }
  }

		  function _confirmStyleAndContinue() {
	    if (project && project.styleBibleStatus === "generating") {
	      showToast("风格圣经正在生成，请稍候", "warn");
	      return;
	    }
	    if (project && project.styleBibleStatus === "failed") {
	      showToast("风格圣经生成失败，请先重新生成", "warn");
	      return;
	    }
	    if (!_hasUsableStyleBibleForStylePage()) {
	      showToast("请先生成风格圣经，再进入资产库", "warn");
	      return;
	    }
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
	    if (!project.scriptApproved) {
	      showToast("请先确认剧本，再生成风格圣经", "warn");
	      return;
	    }
	    await _ensureAutoStyleTemplateForStylePage({ force: true });
	    var confirmed = await _confirmStyleBibleRegeneration();
	    if (!confirmed) return;
	    project.styleBibleStatus = "generating";
	    project.styleBibleError = "";
	    project.styleBibleStartedAt = new Date().toISOString();
	    refreshStylePage();
	    var finalStylePageRendered = false;
	    try {
	      await extractStyleBible({
	        styleOptions: _styleEffectiveOptionsForRequest(),
	        styleTemplateSnapshot: project.styleTemplateSnapshot || null,
	        worldTemplateSnapshot: project.worldTemplateSnapshot || null,
	        creatorProfile: formatCreatorProfileForApi ? formatCreatorProfileForApi() : null,
	      });
	      var reloadedAfterExtract = await _reloadCurrentProjectForStylePage();
	      if (!reloadedAfterExtract) refreshStylePage();
	      finalStylePageRendered = true;
	      showToast("风格圣经已生成，下游内容已标记为需重新生成", "success");
	    } catch (e) {
	      if (e && e.status === 409) {
	        await _waitForStyleBibleGeneration();
	        finalStylePageRendered = true;
	        return;
	      }
	      if (project) {
	        project.styleBibleStatus = "failed";
	        project.styleBibleError = ((e && e.message) || e || "未知错误").toString().slice(0, 180);
	      }
	      refreshStylePage();
	      finalStylePageRendered = true;
	      showToast("重新提取失败: " + ((e && e.message) || e), "error");
	    } finally {
	      if (!finalStylePageRendered) refreshStylePage();
	    }
	  }

	  async function _applyRecommendedStyleTemplateForWorld() {
	    if (!project || !project.selectedWorldTemplateId) {
	      _renderStyleTemplateRecommendHint("none", null);
	      return;
	    }
	    await _ensureAutoStyleTemplateForStylePage({ force: true });
	  }

  function wireStylePageOnce() {
    if (_stylePageBound) return;
    _stylePageBound = true;
	    var confirmBtn = $("btnStyleConfirm");
	    if (confirmBtn) confirmBtn.addEventListener("click", _confirmStyleAndContinue);
	    var extractBtn = $("btnStyleExtract");
    if (extractBtn) extractBtn.addEventListener("click", _extractStyleFromStylePage);
		    var worldTplList = $("stylePageWorldTemplateList");
		    if (worldTplList) {
		      worldTplList.addEventListener("click", function (e) {
		        var addBtn = e.target && e.target.closest ? e.target.closest("[data-world-add-toggle]") : null;
		        if (!addBtn) return;
		        _openStyleWorldTemplateModal();
		      });
		    }
	    var tplList = $("stylePageTemplateList");
	    if (tplList) {
	      tplList.addEventListener("click", function (e) {
		        var moreBtn = e.target && e.target.closest ? e.target.closest("[data-style-more-toggle]") : null;
		        if (moreBtn) {
		          _openStyleTemplateModal();
		          return;
		        }
	        var btn = e.target && e.target.closest ? e.target.closest("[data-style-tpl-id]") : null;
	        if (!btn) return;
	        var tplId = btn.getAttribute("data-style-tpl-id");
	        var templates = (typeof _getStyleTemplates === "function") ? _getStyleTemplates() : [];
	        var tpl = _findStyleTemplateById(templates, tplId);
	        if (tpl) {
	          Promise.resolve(_applyStyleTemplateFromStylePage(tpl)).catch(function (err) {
	            showToast("风格模板选择失败: " + ((err && err.message) || err), "error");
	          });
		        }
		      });
		    }
			    document.addEventListener("click", function (e) {
			      var target = e.target;
			      if (_styleWorldTemplateModalOpen) {
			        if (target && target.id === "styleWorldTemplateModal") {
			          _closeStyleWorldTemplateModal();
			          return;
			        }
			        if (target && target.closest && target.closest("[data-world-template-modal-close], [data-world-template-modal-cancel]")) {
			          _closeStyleWorldTemplateModal();
			          return;
			        }
			        if (target && target.closest && target.closest("[data-world-template-modal-confirm]")) {
			          _confirmStyleWorldTemplateModal();
			          return;
			        }
			        var worldModalCard = target && target.closest ? target.closest("[data-world-modal-tpl-id]") : null;
			        if (worldModalCard) {
			          _styleWorldTemplateModalTempId = String(worldModalCard.getAttribute("data-world-modal-tpl-id") || "");
			          _renderStyleWorldTemplateModal();
			          return;
			        }
			      }
			      if (!_styleTemplateModalOpen) return;
			      if (target && target.id === "styleTemplateModal") {
			        _closeStyleTemplateModal();
			        return;
			      }
		      if (target && target.closest && target.closest("[data-style-template-modal-close], [data-style-template-modal-cancel]")) {
		        _closeStyleTemplateModal();
		        return;
		      }
		      if (target && target.closest && target.closest("[data-style-template-modal-confirm]")) {
		        _confirmStyleTemplateModal();
		        return;
		      }
		      var modalCard = target && target.closest ? target.closest("[data-style-modal-tpl-id]") : null;
		      if (modalCard) {
		        _styleTemplateModalTempId = String(modalCard.getAttribute("data-style-modal-tpl-id") || "");
		        _renderStyleTemplateModal();
		      }
			    });
			    document.addEventListener("keydown", function (e) {
			      if (_styleWorldTemplateModalOpen && e.key === "Escape") {
			        _closeStyleWorldTemplateModal();
			        return;
			      }
			      if (_styleTemplateModalOpen && e.key === "Escape") {
			        _closeStyleTemplateModal();
			      }
		    });
		    var clearWorldBtn = $("btnStyleWorldClear");
		    if (clearWorldBtn) {
		      clearWorldBtn.addEventListener("click", function () {
		        if (!project) return;
		        // 关联世界观时会自动改选推荐风格模板（_applyWorldTemplateSelection），
		        // 清除时必须对称地重跑一次无世界观推荐，否则模板选择残留会让
		        // 「风格模板已修改」横幅一直误报。等服务端保存完成后再推荐，
		        // 避免 recommend 接口读到未清除的旧世界观快照。
		        _persistStyleWorldIntent({ selectedWorldTemplateId: null, worldTemplateSnapshot: null })
		          .then(function () {
		            return _ensureAutoStyleTemplateForStylePage({ force: true });
		          })
		          .catch(function (err) {
		            console.warn("[StyleWorld] re-recommend after clear failed:", err);
		          });
		        showToast("已清除关联世界观", "info");
		      });
		    }
	    var clearTplBtn = $("btnStyleTemplateClear");
	    if (clearTplBtn) {
	      clearTplBtn.addEventListener("click", function () {
	        if (!project) return;
	        project.selectedStyleTemplateId = null;
	        project.styleTemplateSnapshot = null;
	        if (project.styleOptions) {
	          delete project.styleOptions.selectedTemplateId;
	          delete project.styleOptions.selectedTemplateName;
	          delete project.styleOptions.templateStyleBibleSnapshot;
	        }
	        _styleSetTemplateSelectionMeta("manual_clear", "manual_clear", null, "", "");
	        saveProject();
	        _renderStylePageTemplates();
	        _renderStyleTemplateRecommendHint("manual", null);
	        _renderStyleInferenceHint();
	        _renderStylePageBiblePanel();
	        showToast("已清除风格模板选择", "info");
	      });
	    }
	    var aspectList = $("styleAspectList");
	    if (aspectList) {
	      aspectList.addEventListener("click", function (e) {
	        var btn = e.target && e.target.closest ? e.target.closest("[data-style-ratio]") : null;
	        if (!btn) return;
	        _setStyleAspectRatio(btn.getAttribute("data-style-ratio"));
	      });
	    }
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
    // [创作偏好已停用] 一律不向后端发送创作者画像。恢复：取消下一行注释并删除 return null。
    // return _compactCreatorProfileForApi(getActiveCreatorProfile());
    return null;
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
    if (project.id) ctx.id = project.id;
    if (project.title || project.name) ctx.title = project.title || project.name;
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
      var projectContext = _buildAgentContext();
      var body = {
        projectId: project && project.id ? project.id : "",
        message: msg,
        refs: refs,
        references: refs,
        history: historySnapshot,
        projectContext: projectContext,
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
    runEditExport: "下载导出",
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

    var FIELD_LABELS = { appearance: "外貌", clothing: "服装", equipment: "装备", temperament: "气质", actionTraits: "动作特征", identity: "身份", role: "角色定位", gender: "性别", entityType: "实体类型", name: "名称", description: "描述", timeSetting: "时间", location: "地点", lighting: "光线", atmosphere: "氛围", elements: "元素", features: "特征", ownership: "归属", propType: "类型", function: "功能", visualFeatures: "视觉特征" };
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
        '<span style="font-size:11px;opacity:.6;margin-left:6px">' + escapeHtml(assetName) + '（' + actions.length + ' 项' + (autoRegen ? ' + 重新生成' : '') + '）</span>' +
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
      preview = "下载导出";
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
      project.scriptApproved = false;
      project.scriptReviewState = "modified";
      _markDownstreamStale("script", {});
      saveProject();
      refreshScriptPage();
      showToast("剧本已更新", "ok");

	    } else if (t === "updateStyleBible") {
	      if (!project.styleBible) project.styleBible = {};
	      project.styleBible[action.field] = action.value;
	      project.styleBible.updatedAt = new Date().toISOString();
	      project.styleBibleManuallyEditedAt = project.styleBible.updatedAt;
	      project.styleBibleSource = "manual";
	      _markDownstreamStale("style_bible", {});
	      saveProject();
      _renderStylePageBiblePanel();
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
      showToast("正在下载导出…", "ok");
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
          var removeResult = await _removeObsoleteAssets(toRemove);
          if (removeResult.removed) showToast("已清理 " + removeResult.removed + " 个过时资产", "ok");
          else showToast("未清理任何资产，列表可能已更新", "warn");
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
    var hasStyleReference = function (c) {
      return !!(
        c.pencilUrl || c.imageUrl || c.rawUrl || c.realPhotoUrl ||
        (c.reference && (c.reference.currentUrl || c.reference.lastKnownGoodUrl)) ||
        (c.referenceLock && c.referenceLock.sheetUrl) ||
        (c.panels && (c.panels.sheetUrl || c.panels.frontUrl || c.panels.sideUrl || c.panels.backUrl))
      );
    };
    var noPencil = chars.filter(function (c) { return !hasStyleReference(c); });
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
        failed.length + " 张关键帧生成失败（片段 " + failed.slice(0, 5).join("、") + "），建议重试",
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
  // 启动链专用：判空绑定。元素缺失只 warn 不 throw——历史上任何一个按钮被
  // 删掉都会让 init 在裸 $("id").addEventListener 处炸断，症状是整页静默空白。
  function _bindClick(id, handler) {
    var el = $(id);
    if (el) el.addEventListener("click", handler);
    else console.warn("[Init] 元素缺失，跳过绑定：#" + id);
  }

	  async function init() {
	    var session = await ensureSession({ redirectOnInvalid: true, timeoutMs: 5000 });
	    if (!session || session.status === "invalid") {
	      _syncWorkspaceBootPage("overview");
	      _markWorkspaceBootReady();
	      try {
	        if (window.location.pathname !== "/" || window.location.search !== "?auth=1") {
	          window.location.replace("/?auth=1");
	        }
	      } catch (_) {}
	      return;
	    }
	    if (session.status === "valid" && session.user && session.user.id && Number(_currentUid || 0) !== Number(session.user.id)) {
	      window.location.replace("/workspace" + (window.location.hash || ""));
	      return;
	    }
	    _wireCoreNavigationOnce();
    var initialBootTargetPage = _readRememberedWorkspacePage({ allowUnknownProject: true }) || "overview";
    _syncWorkspaceBootPage(initialBootTargetPage);
    switchPage(initialBootTargetPage, { preserveScroll: true, skipAnimation: true });
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
      applyServerProject: (p) => {
        if (!p || !p.id || (project && project.id && p.id !== project.id)) return null;
        project = p;
        cleanupBlobUrls(project);
        _syncProjectModules(project);
        _ensureEpisodes();
        return project;
      },
      // 续写下一集（一集=一个任务）：复用 createNewProject 的创建收尾，避免双实现漂移
      finalizeCreatedProject: (p) => _finalizeCreatedProject(p),
      newClientRequestId: () => _newClientRequestId(),
    });
    initVideoTasks({
      getProject: () => project,
      getSettings: () => settings,
      getVideoState: () => videoState,
      getProjectEpoch: () => _projectEpoch,
      swRegion: {
        show: () => _swLoadingUI.showRegion(document.querySelector('.batch-workbench-scroll')),
        hide: () => _swLoadingUI.hideRegion(document.querySelector('.batch-workbench-scroll')),
      },
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
	      removeGroupFromTimeline,
      isGroupImported,
	      vpFetchAndCache: (sb) => vpFetchAndCache(sb),
	      vpGetCache: (sb) => vpGetCache(sb),
	      getVpSelectedGroup: () => getVpSelectedGroup(),
	      setVpSelectedGroup: (idx) => setVpSelectedGroup(idx),
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
      setProject: (p) => {
        project = p;
        // 整包替换 project 对象时必须同步所有模块的本地引用，否则 script/assets
        // 等模块继续读旧对象：写入走 safeWriteBack 落到新对象（数据没丢），但
        // 渲染读的是旧对象 → 按钮"点了没反应"。实例：409 整包回拉后，剧本页
        // "保留此原稿"点击后导入卡片不消失（proj_1781092769217, 2026-06-10）。
        // 旧实现只在 _loadProjectFromServer 里手动补 syncEdit/syncTasks 两家，
        // 模块拆分后清单漂移；现在收口到 setProject 一处，所有替换路径自动覆盖。
        _syncProjectModules(project);
        _ovSelectCurrentProjectTask();
      },
      getVideoState: () => videoState,
      ensureEpisodes: () => _ensureEpisodes(),
      restoreAssetGenStatus: () => _restoreAssetGenStatus(),
      restoreVideoTasks: () => _restoreVideoTasks(),
      addProjectToList: (p) => addProjectToList(p),
      refreshAllPages: () => refreshAllPages(),
      refreshActivePage: () => _refreshPageForActiveRoute(activePage),
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
      setActiveLoadOutcome: (failed) => { _swActiveLoadFailed = !!failed; },
    });
    // Phase 5.9：server-first boot — await 保证 loadProject 返回前，后续
    // syncXxxProject / initXxx 都拿到的是服务器权威 project。loadProject 内部
    // 显示骨架屏，资料到位后自己关闭；异常也不会阻塞后续初始化。
    _swStartupToken = swLoadBegin('', { retryMode: "loadProject" });
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
    try { await loadSettings(); } catch (e) { console.warn("[Init] loadSettings failed:", e); }
    try { await loadCreatorProfile(); } catch (e) { console.warn("[Init] loadCreatorProfile failed:", e); }
    try { _loadProjectProfileOverride(); } catch (e) { console.warn("[Init] loadProjectProfileOverride failed:", e); }
    _initAccountBar();

    if (project) _renderEpisodeTabs();

    initTasks({ switchPage: (p) => switchPage(p) });
    initBilling({ switchPage: (p) => switchPage(p) });
    initToolbox({
      getAuthToken: () => getAuthToken(),
      showToast: (msg, type) => showToast(msg, type || "info"),
    });
    initCharacterCustom({
      getAuthToken: () => getAuthToken(),
      showToast: (msg, type) => showToast(msg, type || "info"),
      getProject: () => project,
      openLightbox: (url, title, originalUrl) => _openLightbox(url, title, originalUrl),
    });
    initSceneCustom({
      getAuthToken: () => getAuthToken(),
      showToast: (msg, type) => showToast(msg, type || "info"),
      getProject: () => project,
      openLightbox: (url, title, originalUrl) => _openLightbox(url, title, originalUrl),
    });
    initPropCustom({
      getAuthToken: () => getAuthToken(),
      showToast: (msg, type) => showToast(msg, type || "info"),
      getProject: () => project,
      openLightbox: (url, title, originalUrl) => _openLightbox(url, title, originalUrl),
    });
    syncTasksProject(project);
        syncVideoTasksProject(project);
    syncEpisodesProject(project);
    initVideoPrompts({
      getProject: () => project,
      getSettings: () => settings,
      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn, serverVersion) => _safeWriteBack(id, fn, serverVersion),
      getStoryboardGroups: () => getStoryboardGroups(),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
	      checkAndSuggest: (stage) => _checkAndSuggest(stage),
	      switchPage: (p) => switchPage(p),
	      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
	      sleep: (ms) => sleep(ms),
      diagnoseApiError: (msg) => _diagnoseApiError(msg),
      invalidateVideoForGroup: (gIdx) => _invalidateVideoForGroup(gIdx),
      getVideoResultState: (gIdx) => getVideoResultState(gIdx),
      subscribeVideoResultChanges: (handler) => subscribeVideoResultChanges(handler),
      hydrateVideoResultPlayback: (root) => _hydrateVideoResultPlayback(root),
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
    // 全局滚动锚定守卫：根治长列表整重建（renderShotList/renderImageGrid/SSE 回调等）
    // 导致的 window 滚动跳变。context = 页 + 项目，切页/切项目锚点自动作废。
    initScrollAnchorGuard({
      getContext: () => activePage + "|" + (project && project.id ? project.id : ""),
    });
    initShots({
      getProject: () => project,
      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn, serverVersion) => _safeWriteBack(id, fn, serverVersion),
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
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn, serverVersion) => _safeWriteBack(id, fn, serverVersion),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      diagnoseApiError: (msg) => _diagnoseApiError(msg),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      applyServerStaleFlags: (prefixes, serverFlags) => _applyServerStaleFlagsToProject(project, prefixes, serverFlags),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      archiveOldImage: (item, source) => _archiveOldImage(item, source),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      openLightbox: (url, title) => _openLightbox(url, title),
      historyBtnHtml: (item, variant) => _historyBtnHtml(item, variant),
      openHistoryPopover: (btn, item, onApply) => _openHistoryPopover(btn, item, onApply),
      openAssetHistoryModal: (item, type, onApply) => _openAssetHistoryModal(item, type, onApply),
      setHistoryAsCurrent: (item, hi) => _setHistoryAsCurrent(item, hi),
      emotionBadgeHtml: (emotion, intensity) => emotionBadgeHtml(emotion, intensity),
      sleep: (ms) => sleep(ms),
      invalidateVideoForGroup: (gIdx) => _invalidateVideoForGroup(gIdx),
      acceptShotPlanForStoryboard: () => acceptShotPlanForStoryboard(),
    });
    syncStoryboardProject(project);
    initScript({
      getProject: () => project,
      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      // 注意第三参 serverVersion 必须透传：剧本生成/改写后端已落库 version+1，
      // done 事件带回 serverVersion，前端写回内存才能避免下一次 PUT 必撞 409。
      safeWriteBack: (id, fn, serverVersion) => _safeWriteBack(id, fn, serverVersion),
      switchPage: (p) => switchPage(p),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      toastErrorWithActions: (msg) => _toastErrorWithActions(msg),
      getAuthToken: () => getAuthToken(),
      isFeatureEnabled: (key, fallback) => _clientFeatureEnabled(key, fallback),
      uPrefix: _uPrefix,
      createNewProject: () => createNewProject(),
      triggerExtractAssets: () => extractAssets(),
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
    syncScriptProject(project);
    syncAssetsProject(project);
	    initAssets({
	      getProject: () => project,
	      getVideoState: () => videoState,
	      saveProject: () => saveProject(),
      flushServerSave: () => _flushServerSave(),
      safeWriteBack: (id, fn, serverVersion) => _safeWriteBack(id, fn, serverVersion),
      switchPage: (p) => switchPage(p),
      // 资产确认 → 跳到分镜页后自动启动镜头计划生成（仅在 project.shots 为空时）。
      // 体验对齐 _confirmStyleAndContinue 的"确认风格 → 自动 extractAssets"。
      generateShots: (opts) => generateShots(opts),
      formatCreatorProfileForApi: () => formatCreatorProfileForApi(),
      markDownstreamStale: (scope, detail) => _markDownstreamStale(scope, detail),
      isStale: (key) => _isStale(key),
      clearStale: (key) => _clearStale(key),
      checkAndSuggest: (stage) => _checkAndSuggest(stage),
      archiveOldImage: (item, kind) => _archiveOldImage(item, kind),
      registerServerTask: (id, kind, type, idx) => _registerServerTask(id, kind, type, idx),
	      updateServerTaskStatus: (id, status, url) => _updateServerTaskStatus(id, status, url),
		      refreshStylePage: () => refreshStylePage(),
		      persistWorldTemplateSelection: (intent) => _persistStyleWorldIntent(intent),
		      applyWorldTemplateSelection: (tpl) => _applyWorldTemplateSelection(tpl),
		      updateStoryboardCard: (idx, status, url, text) => updateStoryboardCard(idx, status, url, text),
      historyBtnHtml: (item, variant) => _historyBtnHtml(item, variant),
      openHistoryPopover: (btn, item, onApply) => _openHistoryPopover(btn, item, onApply),
      openAssetHistoryModal: (item, type, onApply) => _openAssetHistoryModal(item, type, onApply),
      setHistoryAsCurrent: (item, hi) => _setHistoryAsCurrent(item, hi),
      agentInsertRef: (type, label, data) => agentInsertRef(type, label, data),
      refreshOverview: () => refreshOverview(),
      refreshStoryboardMaterialPanels: (opts) => refreshStoryboardMaterialPanels(opts),
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
    // running/pending 的 asset_images batch 拉回来重建 spinner。
    // 首次 (line 2633) 的 no-op 保留不删 —— 幂等调用，代价只有一次 `null` 检查。
    if (project && project.id) {
      try { _restoreAssetGenStatus(); }
      catch (e) { console.warn("[Init] restoreAssetGenStatus (post-sync) failed:", e); }
      try { reattachVideoPromptBatches("init"); }
      catch (e) { console.warn("[Init] reattachVideoPromptBatches failed:", e); }
      try { reattachStoryboardBatches(); }
      catch (e) { console.warn("[Init] reattachStoryboardBatches failed:", e); }
      try { registerStoryboardBatchReconciler(); }
      catch (e) { console.warn("[Init] registerStoryboardBatchReconciler failed:", e); }
      try { _registerGlobalBatchReconciler(); }
      catch (e) { console.warn("[Init] globalBatchReconciler failed:", e); }
    }
    // Phase 3-B-10：世界观模板搬后端 /api/world-templates，启动时 prime 一次
    try { _primeWorldTemplates(); } catch (e) { console.warn("[Init] primeWorldTemplates failed:", e); }
    // Phase 5.5：接管 window.onerror / unhandledrejection，老代码忘 catch 的
    // promise 异常由 error_hub 兜底记一条 warn，不再静默吞掉。默认不 toast
    // 以免惊扰用户——真正关心的场景由调用方主动 reportError(..., {toast:true})。
    try { _installErrorHub({ toastOnUncaught: false }); } catch (e) { console.warn("[Init] errorHub failed:", e); }
    // Phase 5.7：拉一次服务器侧常量配置，覆盖本地默认 MAX_* 值
    try { _loadClientConfig(); } catch (e) { console.warn("[Init] loadClientConfig failed:", e); }
    try { _startClientConfigPoll(); } catch (e) { console.warn("[Init] clientConfigPoll failed:", e); }
    try { loadBillingSummary(); } catch (e) { console.warn("[Init] loadBillingSummary failed:", e); }
    try { handleBillingReturnFromUrl(); } catch (e) { console.warn("[Init] handleBillingReturnFromUrl failed:", e); }
    try { _startMaintenanceBannerPoll(); } catch (e) { console.warn("[Init] maintenanceBanner failed:", e); }

    window.addEventListener("beforeunload", function () {
      flushPendingProjectSaveOnUnload();
    });

    _wireCoreNavigationOnce();

    /* Project overview — all guarded with try/catch to prevent breaking event chain */
    try {
      var _btnNew = $("btnNewProject");
      if (_btnNew) _btnNew.addEventListener("click", async function () {
        try {
          console.log("[UI] btnNewProject clicked");
          _openNewProjectDialog({
            afterCreated: async function () {
              refreshOverview();
              switchPage("script");
            },
          });
        } catch (e) { console.error("[NewProject]", e); }
      });

      var _btnReset = $("btnResetProject");
      if (_btnReset) _btnReset.addEventListener("click", async function () {
        try {
          console.log("[UI] btnResetProject clicked");
          _openNewProjectDialog({
            afterCreated: async function () {
              refreshOverview();
            },
          });
        } catch (e) { console.error("[ResetProject]", e); }
      });

      _wireOverviewDashboardOnce();

      var _plistWrap = $("projectListWrap");
      if (_plistWrap) _plistWrap.addEventListener("click", handleProjectListAction);
      _bindProjNameEdit();
    } catch (e) { console.error("[ProjectInit]", e); }

    /* Script page — chat input */
    _bindClick("btnGenScript", handleScriptInput);
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
    var scriptHeaderConfirm = $("btnScriptHeaderRegen");
    if (scriptHeaderConfirm) scriptHeaderConfirm.addEventListener("click", confirmScript);
    var scriptFooterConfirm = $("btnConfirmScript");
    if (scriptFooterConfirm) scriptFooterConfirm.addEventListener("click", confirmScript);
    initScriptImportEvents();

    var editBtn = $("btnEditScript");
    if (editBtn) editBtn.addEventListener("click", _enterScriptEditMode);
    var saveScriptEditBtn = $("btnSaveScriptEdit");
    if (saveScriptEditBtn) saveScriptEditBtn.addEventListener("click", _saveScriptEdit);
    var cancelScriptEditBtn = $("btnCancelScriptEdit");
    if (cancelScriptEditBtn) cancelScriptEditBtn.addEventListener("click", _cancelScriptEdit);
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
    var scriptTA = $("scriptOutput");
    if (scriptTA) {
      scriptTA.addEventListener("input", _resizeScriptEditTextarea);
      scriptTA.addEventListener("keydown", _handleScriptEditKeydown);
    }

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
      getOnlineEditorConfig: () => getOnlineEditorConfig(),
      loadOnlineEditorConfig: (options) => loadOnlineEditorConfig(options),
      openOnlineEditor: () => openOnlineEditorFromEntry(),
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

    /* Online Editor page */
    initOnlineEditor({
      switchPage: (p) => switchPage(p),
      showToast: (msg, type) => showToast(msg, type || "info"),
      getAuthToken: () => getAuthToken(),
      getProject: () => project,
      saveProject: () => saveProject(),
      apiGet: (url, options) => apiGet(url, options),
      apiPost: (url, body, method, options) => apiPost(url, body, method, options),
      getOnlineEditorConfig: () => getOnlineEditorConfig(),
      loadOnlineEditorConfig: (options) => loadOnlineEditorConfig(options),
    });

    /* Assets page */
    _bindClick("btnExtractAssets", extractAssets);
    var btnExtractAssetsEmpty = $("btnExtractAssetsEmpty");
    if (btnExtractAssetsEmpty) btnExtractAssetsEmpty.addEventListener("click", extractAssets);
    _bindClick("btnGenAssetImages", generateAllAssetImages);
	    _bindClick("btnConfirmAssets", confirmAssets);
	    var btnConfirmAssetsTop = $("btnConfirmAssetsTop");
	    if (btnConfirmAssetsTop) btnConfirmAssetsTop.addEventListener("click", confirmAssets);
	    _bindClick("btnCleanObsolete", _showCleanObsoleteDialog);
    var _btnSaveTpl = $("btnSaveWorldTemplate");
    if (_btnSaveTpl) _btnSaveTpl.addEventListener("click", saveAsWorldTemplate);
    var _btnKnowledgeSnapshot = $("btnKnowledgeSnapshot");
    if (_btnKnowledgeSnapshot) _btnKnowledgeSnapshot.addEventListener("click", openKnowledgeSnapshot);
    var charGrid = $("assetCharGrid");
    var sceneGrid = $("assetSceneGrid");
    var propGrid = $("assetPropGrid");
    if (charGrid) charGrid.addEventListener("click", handleAssetAction);
    if (sceneGrid) sceneGrid.addEventListener("click", handleAssetAction);
    if (propGrid) propGrid.addEventListener("click", handleAssetAction);

    /* Shots page */
    _bindClick("btnGenShots", generateShots);
    var btnGenShotsEmpty = $("btnGenShotsEmpty");
    if (btnGenShotsEmpty) btnGenShotsEmpty.addEventListener("click", generateShots);
    _bindClick("btnConfirmShots", confirmImages);
    var slw = $("shotListWrap");
    if (slw) slw.addEventListener("click", handleShotAction);
    if (slw) slw.addEventListener("click", handleImageAction);

    /* Images page — unified storyboard generation */
    var _btnGenAll = $("btnGenAllImages");
    if (_btnGenAll) _btnGenAll.addEventListener("click", generateAllImages);
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
    _bindClick("btnGenAllVideoPrompts", generateAllVideoPrompts);
    _bindClick("btnGenerateAllVideos", async function () {
      var ok = await prepareVideoPromptsForVideoGeneration();
      if (ok) await generateAllVideos();
    });
    var confirmVpTopBtn = $("btnConfirmVideoPromptsTop");
    if (confirmVpTopBtn) confirmVpTopBtn.addEventListener("click", confirmSegmentsAndEnterEdit);
    var vpList = $("videoPromptList");
    if (vpList) vpList.addEventListener("click", handleVideoPromptAction);
    var videoResultRoot = $("videoResultCard");
    if (videoResultRoot && !videoResultRoot._videoResultBound) {
      videoResultRoot._videoResultBound = true;
      videoResultRoot.addEventListener("click", async function (e) {
        var btn = e.target.closest("[data-video-result-action]");
        if (!btn || btn.disabled) return;
        var card = btn.closest("[data-video-result-group]");
        if (!card) return;
        var gIdx = parseInt(card.dataset.videoResultGroup, 10);
        if (isNaN(gIdx)) gIdx = getVpSelectedGroup();
        var action = btn.dataset.videoResultAction;
        if (action === "toggle-menu") {
          e.preventDefault();
          e.stopPropagation();
          var wrap = btn.closest(".video-result-more-wrap");
          var menu = wrap && wrap.querySelector(".video-result-more-menu");
          var willOpen = menu && menu.hidden;
          videoResultRoot.querySelectorAll(".video-result-more-menu").forEach(function (m) { if (m !== menu) m.hidden = true; });
          videoResultRoot.querySelectorAll("[data-video-result-action='toggle-menu']").forEach(function (b) { if (b !== btn) b.setAttribute("aria-expanded", "false"); });
          if (menu) menu.hidden = !willOpen;
          btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
          if (willOpen && menu) {
            var firstItem = menu.querySelector("button:not([disabled])");
            if (firstItem) firstItem.focus();
          }
          return;
        }
        var menuHost = btn.closest(".video-result-more-wrap");
        if (menuHost) {
          var openMenu = menuHost.querySelector(".video-result-more-menu");
          if (openMenu) openMenu.hidden = true;
          var menuBtn = menuHost.querySelector("[data-video-result-action='toggle-menu']");
          if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
        }
        if (action === "play") {
          var video = card.querySelector("video");
          if (!video) return;
          if (video.paused) {
            var vrFrame = card.querySelector(".video-result-preview-frame");
            var vrLoading = vrFrame && vrFrame.querySelector("[data-ov-preview-loading]");
            if (vrLoading) vrLoading.hidden = false; // 点下立刻转圈，playing 事件会收掉
            var playable = await _ensureVideoResultPlayable(video);
            if (!playable) {
              if (vrLoading) vrLoading.hidden = true;
              showToast("视频预览加载失败，请刷新后重试", "warn");
              return;
            }
            video.play().catch(function () { if (vrLoading) vrLoading.hidden = true; });
          }
          else video.pause();
          return;
        }
        if (action === "regenerate") {
          var ready = await prepareVideoPromptsForVideoGeneration([gIdx]);
          if (ready) await generateVideoForGroup(gIdx);
          renderVideoResultCard(gIdx);
          return;
        }
        if (action === "history") {
          await openVideoHistoryForGroup(gIdx);
          return;
        }
        if (action === "download") {
          await downloadVideoForGroup(gIdx, btn);
          return;
        }
	        if (action === "import") {
	          var imported = await importVideoForGroup(gIdx);
	          if (imported) renderVideoResultCard(gIdx);
	          return;
	        }
        if (action === "delete") {
          var deleted = await deleteVideoForGroup(gIdx, btn);
          if (deleted) renderVideoResultCard(gIdx);
        }
      });
      document.addEventListener("click", function (e) {
        if (!videoResultRoot.contains(e.target)) {
          videoResultRoot.querySelectorAll(".video-result-more-menu").forEach(function (m) { m.hidden = true; });
          videoResultRoot.querySelectorAll("[data-video-result-action='toggle-menu']").forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
        }
      });
      // 更多菜单键盘可用（disclosure）：Esc 关闭并回焦触发钮；↑↓ 在可用项间循环移动。
      videoResultRoot.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          var openMenu = null;
          videoResultRoot.querySelectorAll(".video-result-more-menu").forEach(function (m) { if (!m.hidden) openMenu = m; });
          if (!openMenu) return;
          e.preventDefault();
          openMenu.hidden = true;
          var host = openMenu.closest(".video-result-more-wrap");
          var tBtn = host && host.querySelector("[data-video-result-action='toggle-menu']");
          if (tBtn) { tBtn.setAttribute("aria-expanded", "false"); tBtn.focus(); }
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          var inMenu = e.target.closest(".video-result-more-menu");
          if (!inMenu) return;
          e.preventDefault();
          var items = Array.prototype.slice.call(inMenu.querySelectorAll("button:not([disabled])"));
          if (!items.length) return;
          var i = items.indexOf(e.target);
          var next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
          items[next].focus();
        }
      });
    }

    // @ / 重新生成 / 复制 这三个按钮已移到左侧每张镜头卡片右下角，事件由
    // videoPrompts.js _renderVpStoryboardFrames 在 frame 创建时直接绑（带 ev.stopPropagation
    // 避免触发卡片本身的选中冒泡），agentInsertRef 通过 initVideoPrompts 的 ctx 透传过去。
    // 这里不再绑定 vpBtn{RefAgent,RegenSingle,Copy}——对应 DOM 已从 workspace.html 删除。
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

    /* Segment generation page */
    _bindClick("btnStartBatch", confirmSegmentsAndEnterEdit);
    var btnGenerateAllSegments = $("btnGenerateAllSegments");
    if (btnGenerateAllSegments) btnGenerateAllSegments.addEventListener("click", startBatchGeneration);
    var btnImportAllSegments = $("btnImportAllSegments");
    if (btnImportAllSegments) btnImportAllSegments.addEventListener("click", importAllGeneratedSegments);
    _initBatchPlayerEvents();

    /* Library page */
    _initLibraryEvents();

    /* Toolbox page */
    _initToolboxEvents();
    _initCharacterCustomEvents();
    _initSceneCustomEvents();
    _initPropCustomEvents();

    /* Batch video task events */
    var batchTW = $("batchTaskListWrap");
    if (batchTW) batchTW.addEventListener("click", handleVideoTaskAction);
    syncTaskListVisibility(); updateBadge();

    /* Agent */
    _wireAgentEvents();

    /* 给所有 .upstream-stale-banner / .stale-banner 自动挂关闭按钮 */
    _initDismissibleBanners();

    /* Initial page */
    var bootTargetPage = _bootUserNavigated
      ? (_bootDeferredPageRefresh || activePage || "overview")
      : (_bootDeferredPageRefresh || _readRememberedWorkspacePage() || activePage || "overview");
    bootTargetPage = _isWorkspacePageOpenable(bootTargetPage) || "overview";
    _syncWorkspaceBootPage(bootTargetPage);
    _appBootstrapping = false;
    _bootDeferredPageRefresh = "";
    switchPage(bootTargetPage, { forceRefresh: true, skipAnimation: true });
    _markWorkspaceBootReady();
    requestAnimationFrame(function () {
      if (_swActiveLoadFailed) swLoadError(_swStartupToken); else swLoadDone(_swStartupToken);
    });
  }

  /* 通用：给所有 .upstream-stale-banner / .stale-banner 自动追加 X 关闭按钮 */
  function _initDismissibleBanners() {
    var BANNER_SELECTOR = ".upstream-stale-banner, .stale-banner";
    var ATTACHED_ATTR = "data-dismissible-attached";
    function attachAll() {
      var els = document.querySelectorAll(
        ".upstream-stale-banner:not([" + ATTACHED_ATTR + "]), .stale-banner:not([" + ATTACHED_ATTR + "])"
      );
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        el.setAttribute(ATTACHED_ATTR, "1");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "banner-dismiss-btn";
        btn.setAttribute("aria-label", "关闭");
        btn.title = "关闭";
        btn.innerHTML = '<span class="material-symbols-outlined">close</span>';
        el.appendChild(btn);
      }
    }
    var pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        attachAll();
      });
    }
    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest && ev.target.closest(".banner-dismiss-btn");
      if (!btn) return;
      ev.stopPropagation();
      var banner = btn.closest(".upstream-stale-banner, .stale-banner");
      if (!banner) return;
      // 带 data-dismiss-store/key 的横幅：记住当前状态签名，重渲染/刷新后同一状态不再出现
      var dismissStore = banner.getAttribute("data-dismiss-store");
      var dismissKey = banner.getAttribute("data-dismiss-key");
      if (dismissStore && dismissKey) {
        try { localStorage.setItem(dismissStore, dismissKey); } catch (e) {}
      }
      banner.remove();
    });
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    attachAll();
  }

  // 启动兜底：init 是 async，之前裸调用时任何未捕获异常都是 unhandledrejection——
  // ready 标记设不上、遮罩也没人收，用户看到的就是一张无提示的静默空白页。
  // 这里兜住：标记 boot ready（让 bootCSS 退场、静态壳可见）+ 把加载层切到错误态（带重试按钮）。
  function _bootInit() {
    init().catch(function (e) {
      console.error("[Init] 启动失败:", e);
      try { _markWorkspaceBootReady(); } catch (_) {}
      try { swLoadError(_swStartupToken); } catch (_) {}
    });
  }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", _bootInit); }
  else { _bootInit(); }
