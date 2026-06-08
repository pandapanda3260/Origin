import { $, escapeHtml, showToast, showConfirm, showPrompt, apiPost, apiGet, apiPostStream, consumeStreamStepTags, ApiError, getAuthHeaders, hydrateProtectedImageElements, imageVariantUrl, getActiveBatchesShared } from './utils.js?v=201';
import { loadProjectData } from './project.js';
import { subscribeBatch, subscribeTask } from './backend_stream.js';
import { renderAssetCard } from './render_hooks.js';
import { attachShotsBatch } from './shots.js';
import { reattachStoryboardBatches } from './storyboard.js';
import { showBillingPaywall } from './billing.js';
import { invalidateAllMaterialPanels } from './material_image_panel.js?v=103';

const _getAuthHeaders = getAuthHeaders;

var _ctx = {};
var project = null;

export function initAssets(ctx) { _ctx = ctx; }
export function syncAssetsProject(p) { project = p; }
export function resetLibraryState() { _libActiveProject = null; _libActiveTab = "all"; _libProjPage = 0; _libProjPages = []; _libProjList = []; }

function _invalidateMaterialPanelsAfterAssetChange() {
  invalidateAllMaterialPanels();
  if (_ctx.refreshStoryboardMaterialPanels) {
    try { _ctx.refreshStoryboardMaterialPanels({ force: true }); }
    catch (e) { console.warn("[MaterialPanel] refresh after asset change failed:", e); }
  }
}

function _saveAssetsProject() {
  _invalidateMaterialPanelsAfterAssetChange();
  return _ctx.saveProject ? _ctx.saveProject() : undefined;
}

var _assetsExtracting = false;
var _assetImagesGenerating = false;
var _assetGenStatus = {};
var _assetReviewSnapshot = null;
var _pendingAssetRerender = false;
var _libActiveProject = null;
var _libActiveTab = "all";
var _libProjPage = 0;          // 素材库项目切换：当前页（0 基）
var _libProjPages = [];        // 每页对应的按钮 DOM 数组
var _libProjList = [];         // 最近一次渲染的项目列表（resize 时复用）
var _libProjPagerBound = false;
var _LIB_PROJ_GAP = 12;        // 对应 libProjectTabs 的 gap-3 (0.75rem)
var ASSET_ENTRANCE_ANIM_MS = 1400;
var _assetEntranceClearTimer = null;
var ASSET_CARD_DISPLAY_W = 1024;
var ASSET_CARD_THUMB_W = 512;
var ASSET_LIGHTBOX_W = 1600;

function _assetVariant(url, width) {
  return imageVariantUrl(url || "", { w: width });
}

function _assetOriginal(url) {
  return imageVariantUrl(url || "", { w: 0 });
}

function _attrOriginal(url) {
  return url ? ' data-original-img="' + escapeHtml(url) + '"' : '';
}

function _firstAssetUrl() {
  for (var i = 0; i < arguments.length; i++) {
    var url = (arguments[i] || "").toString().trim();
    if (url) return url;
  }
  return "";
}

var _ASSET_GENERATED_FIELDS = [
  "imageUrl",
  "rawUrl",
  "realPhotoUrl",
  "pencilUrl",
  "assetId",
  "imageAssetId",
  "pencilAssetId",
  "submittedImagePrompt",
  "imageSafetyAudit",
  "effectiveVisualDescription",
  "reference",
  "imageGeneratedAt",
  "skippedStylize",
];

function _assetTypeLabel(type) {
  return type === "char" ? "角色" : type === "scene" ? "场景" : "道具";
}

function _assetTypeCat(type) {
  return type === "char" ? "characters" : type === "scene" ? "scenes" : "props";
}

function _assetTypeTopKey(type) {
  return type === "char" ? "characters" : type === "scene" ? "environments" : "props";
}

function _assetListByTypeFromAssets(assets, type) {
  if (!assets) return [];
  var cat = _assetTypeCat(type);
  return Array.isArray(assets[cat]) ? assets[cat] : [];
}

function _cloneAssetReviewAssets(assets) {
  assets = assets || {};
  return {
    characters: _deepClonePlain(Array.isArray(assets.characters) ? assets.characters : []),
    scenes: _deepClonePlain(Array.isArray(assets.scenes) ? assets.scenes : []),
    props: _deepClonePlain(Array.isArray(assets.props) ? assets.props : []),
  };
}

function _captureAssetReviewSnapshot() {
  if (!project || !project.id) {
    _assetReviewSnapshot = null;
    return;
  }
  _assetReviewSnapshot = {
    projectId: String(project.id),
    assets: _cloneAssetReviewAssets(project.assets),
  };
}

function _currentAssetReviewSnapshotAssets() {
  if (!project || !project.id || !_assetReviewSnapshot || !_assetReviewSnapshot.projectId) return null;
  if (String(_assetReviewSnapshot.projectId) !== String(project.id)) return null;
  return _assetReviewSnapshot.assets || null;
}

function _cloneAssetReviewValue(value) {
  if (typeof value === "undefined") return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_e) {
    return value;
  }
}

function _normalizeAssetReviewKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, "");
}

function _assetReviewKeys(item) {
  item = item || {};
  return [item.characterId, item.name].map(_normalizeAssetReviewKey).filter(Boolean);
}

function _assetReviewHasSharedKey(left, right) {
  var leftKeys = _assetReviewKeys(left);
  var rightKeys = _assetReviewKeys(right);
  if (!leftKeys.length || !rightKeys.length) return false;
  return leftKeys.some(function (key) { return rightKeys.indexOf(key) >= 0; });
}

function _findAssetReviewMatchIndex(item, list) {
  list = Array.isArray(list) ? list : [];
  for (var i = 0; i < list.length; i++) {
    if (_assetReviewHasSharedKey(item, list[i])) return i;
  }
  return -1;
}

function _hasAssetImage(type, item) {
  if (!item) return false;
  var reference = item.reference && typeof item.reference === "object" ? item.reference : {};
  var panels = item.panels && typeof item.panels === "object" ? item.panels : {};
  if (type === "char" && String(reference.status || "").toLowerCase() === "failed") return false;
  return !!_firstAssetUrl(
    item.imageUrl,
    item.rawUrl,
    item.realPhotoUrl,
    item.pencilUrl,
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    item.referenceLock && item.referenceLock.sheetUrl,
    panels.sheetUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
  );
}

function _assetHasHistory(item) {
  return !!(item && Array.isArray(item.imageHistory) && item.imageHistory.length);
}

function _latestInfoChangedSnap(item) {
  if (!item || !Array.isArray(item.imageHistory) || !item.imageHistory.length) return null;
  var snap = item.imageHistory[0] || null;
  return snap && snap.source === "info_changed" ? snap : null;
}

function _reviewSnapshotUrl(snap) {
  snap = snap || {};
  var ref = snap.reference && typeof snap.reference === "object" ? snap.reference : {};
  return _firstAssetUrl(
    snap.imageUrl,
    snap.pencilUrl,
    snap.realPhotoUrl,
    snap.rawUrl,
    snap.url,
    ref.currentUrl,
    ref.lastKnownGoodUrl,
  );
}

function _reviewAssetUrl(type, item, snap) {
  item = item || {};
  var ref = item.reference && typeof item.reference === "object" ? item.reference : {};
  var panels = item.panels && typeof item.panels === "object" ? item.panels : {};
  var currentUrl = _firstAssetUrl(
    item.thumbUrl,
    item.displayUrl,
    item.imageUrl,
    type === "char" ? item.pencilUrl : "",
    item.realPhotoUrl,
    item.rawUrl,
    ref.currentUrl,
    ref.lastKnownGoodUrl,
    item.referenceLock && item.referenceLock.sheetUrl,
    panels.sheetUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
  );
  return currentUrl || _reviewSnapshotUrl(snap);
}

function _assetReviewThumbHtml(row) {
  var url = row.thumbUrl || "";
  var label = row.iconText || "待生成";
  if (url) {
    return '<img src="' + escapeHtml(_assetVariant(url, ASSET_CARD_THUMB_W)) + '" alt="' + escapeHtml(row.name || "") + '" class="w-full h-full object-cover" loading="lazy" decoding="async" onerror="window.__originMarkImageMissing && window.__originMarkImageMissing(this)" />';
  }
  return '<div class="w-full h-full flex items-center justify-center bg-surface-container-highest/40 text-on-surface-variant text-[11px] font-bold tracking-wider">' + escapeHtml(label) + '</div>';
}

function _assetReviewRowId(type, idx, deletedIndex) {
  if (deletedIndex != null) return type + "_deleted_" + deletedIndex;
  return type + "_" + idx;
}

function _assetReviewMakeRow(type, idx, item, oldList) {
  item = item || {};
  var typeLabel = _assetTypeLabel(type);
  var hasImage = _hasAssetImage(type, item);
  var infoSnap = _latestInfoChangedSnap(item);
  var oldMatch = _findAssetReviewMatchIndex(item, oldList);
  var isAdded = oldList && oldList.length && oldMatch < 0;
  var name = item.name || (typeLabel + "#" + (idx + 1));
  var row = {
    id: _assetReviewRowId(type, idx),
    type: type,
    idx: idx,
    name: name,
    disabled: false,
    checked: false,
    kind: "stable",
    status: typeLabel + "信息无变化，建议不勾选",
    iconText: "待生成",
    thumbUrl: _reviewAssetUrl(type, item, infoSnap),
  };
  if (hasImage) {
    row.kind = infoSnap ? "changed_with_image" : "stable_with_image";
    row.checked = false;
    row.status = infoSnap ? "已经重新生成或手动更新了参考图，建议不勾选" : (typeLabel + "信息无变化，建议不勾选");
    row.iconText = "已生成";
    return row;
  }
  if (infoSnap) {
    row.kind = "changed_missing";
    row.checked = true;
    row.status = typeLabel + "信息发生了变化，建议勾选";
    row.iconText = "旧图";
    row.thumbUrl = _reviewAssetUrl(type, item, infoSnap);
    return row;
  }
  if (isAdded) {
    row.kind = "added";
    row.checked = true;
    row.status = "新增" + typeLabel + "，建议勾选";
    row.iconText = "新" + typeLabel;
    row.thumbUrl = "";
    return row;
  }
  row.kind = "missing";
  row.checked = true;
  row.status = typeLabel + "图尚未生成，建议勾选";
  row.iconText = "待生成";
  return row;
}

function _buildDeletedAssetReviewRows(type, currentList, oldList) {
  if (!oldList || !oldList.length) return [];
  var typeLabel = _assetTypeLabel(type);
  var rows = [];
  oldList.forEach(function (oldItem, oldIdx) {
    if (_findAssetReviewMatchIndex(oldItem, currentList) >= 0) return;
    var name = (oldItem && oldItem.name) || (typeLabel + "#" + (oldIdx + 1));
    rows.push({
      id: _assetReviewRowId(type, oldIdx, oldIdx),
      type: type,
      idx: null,
      deleted: true,
      disabled: true,
      checked: false,
      kind: "deleted",
      name: name,
      status: name + "已移除，建议不勾选",
      iconText: "已移除",
      thumbUrl: _reviewAssetUrl(type, oldItem, null),
    });
  });
  return rows;
}

function _buildAssetRegenerationReviewRows() {
  if (!project || !project.assets) return [];
  var rows = [];
  var snapshotAssets = _currentAssetReviewSnapshotAssets();
  ["char", "scene", "prop"].forEach(function (type) {
    var currentList = _assetListByTypeFromAssets(project.assets, type);
    var oldList = snapshotAssets ? _assetListByTypeFromAssets(snapshotAssets, type) : [];
    rows = rows.concat(_buildDeletedAssetReviewRows(type, currentList, oldList));
    currentList.forEach(function (item, idx) {
      rows.push(_assetReviewMakeRow(type, idx, item, oldList));
    });
  });
  return rows;
}

function _assetsHaveExistingGeneratedState(assets) {
  var found = false;
  ["char", "scene", "prop"].forEach(function (type) {
    if (found) return;
    _assetListByTypeFromAssets(assets, type).forEach(function (item) {
      if (found) return;
      if (_hasAssetImage(type, item) || _assetHasHistory(item)) found = true;
    });
  });
  return found;
}

function _shouldShowAssetRegenerationReview() {
  if (!project || !project.assets) return false;
  var snapshotAssets = _currentAssetReviewSnapshotAssets();
  return _assetsHaveExistingGeneratedState(project.assets) || _assetsHaveExistingGeneratedState(snapshotAssets);
}

function _normalizeCharacterEntityType(value) {
  var text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "non-human" || text === "nonhuman" || text.indexOf("非人") >= 0) return "non-human";
  if (text === "human" || text.indexOf("人物") >= 0 || text.indexOf("人类") >= 0) return "human";
  return text;
}

function _panelSchemaEntityType(panels) {
  var schema = String((panels && panels.schema) || "").trim().toLowerCase();
  if (!schema) return "";
  if (schema.indexOf("non-human") >= 0 || schema.indexOf("nonhuman") >= 0) return "non-human";
  if (schema.indexOf("human-character") >= 0) return "human";
  return "";
}

function _characterIdentityKeys(item) {
  item = item || {};
  return [item.characterId, item.id, item.name].filter(Boolean).map(function (value) {
    return String(value).trim().toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, "");
  }).filter(Boolean);
}

function _hasSharedCharacterKey(left, right) {
  var leftKeys = _characterIdentityKeys(left);
  var rightKeys = _characterIdentityKeys(right);
  if (!leftKeys.length || !rightKeys.length) return false;
  return leftKeys.some(function (key) { return rightKeys.indexOf(key) >= 0; });
}

function _canUseCharacterFallback(current, fallback, options) {
  if (!fallback || typeof fallback !== "object") return false;
  options = options || {};
  var currentEntity = _normalizeCharacterEntityType(current && current.entityType);
  var fallbackEntity = _normalizeCharacterEntityType(fallback.entityType);
  var fallbackSchemaEntity = _panelSchemaEntityType(fallback.panels);

  if (currentEntity && fallbackEntity && currentEntity !== fallbackEntity) return false;
  if (currentEntity && fallbackSchemaEntity && currentEntity !== fallbackSchemaEntity) return false;
  if (currentEntity === "non-human" && !fallbackEntity && !fallbackSchemaEntity) {
    // 非人角色没有显式实体/切片 schema 证据时，不从 legacy mirror 或 consistency lock 里猜旧图。
    return false;
  }
  if (fallbackSchemaEntity === "human" && currentEntity === "non-human") return false;
  if (fallbackSchemaEntity === "non-human" && currentEntity === "human") return false;

  if (options.requireIdentityMatch && !_hasSharedCharacterKey(current, fallback)) return false;
  return true;
}

function _characterFallbackImageUrl(item, idx) {
  item = item || {};
  var reference = (item.reference && typeof item.reference === "object") ? item.reference : {};
  var ownReferenceUrl = _firstAssetUrl(reference.lastKnownGoodUrl, reference.currentUrl);
  if (ownReferenceUrl && _canUseCharacterFallback(item, item, { requireIdentityMatch: false })) return ownReferenceUrl;

  var topChar = project && Array.isArray(project.characters) && typeof idx === "number"
    ? project.characters[idx]
    : null;
  var topReference = topChar && typeof topChar.reference === "object" ? topChar.reference : {};
  var topPanels = topChar && typeof topChar.panels === "object" ? topChar.panels : {};
  var topUrl = topChar ? _firstAssetUrl(
    topChar.originalUrl,
    topChar.realPhotoUrl,
    topChar.rawUrl,
    topChar.imageUrl,
    topChar.pencilUrl,
    topReference.lastKnownGoodUrl,
    topReference.currentUrl,
    topPanels.sheetUrl,
  ) : "";
  if (topUrl && _canUseCharacterFallback(item, topChar, { requireIdentityMatch: false })) return topUrl;

  var keys = [item.characterId, item.id, item.name].filter(Boolean).map(function (v) { return String(v); });
  var locks = project && project.consistency && Array.isArray(project.consistency.characters)
    ? project.consistency.characters
    : [];
  for (var lockIdx = 0; lockIdx < locks.length; lockIdx++) {
    var lock = locks[lockIdx] || {};
    var matches = keys.indexOf(String(lock.characterId || "")) >= 0
      || keys.indexOf(String(lock.canonicalName || "")) >= 0;
    if (!matches && !keys.length && typeof idx === "number") matches = lockIdx === idx;
    if (!matches) continue;
    var referenceLock = lock.referenceLock || {};
    var lockFallback = {
      characterId: lock.characterId || lock.sourceAssetId,
      id: lock.sourceAssetId || lock.characterId,
      name: lock.canonicalName,
      entityType: lock.identityLock && lock.identityLock.entityType,
    };
    if (!_canUseCharacterFallback(item, lockFallback, { requireIdentityMatch: true })) continue;
    var lockUrl = _firstAssetUrl(
      referenceLock.sheetUrl,
      referenceLock.headshotUrl,
      referenceLock.frontUrl,
      referenceLock.sideUrl,
      referenceLock.backUrl,
    );
    if (lockUrl) return lockUrl;
  }

  return "";
}

function _characterOwnImageUrl(item) {
  item = item || {};
  var ownUrl = _firstAssetUrl(item.originalUrl, item.realPhotoUrl, item.rawUrl, item.imageUrl);
  if (!ownUrl) return "";
  return _canUseCharacterFallback(item, item, { requireIdentityMatch: false }) ? ownUrl : "";
}

function _getVideoTasksForLibrary() {
  var state = _ctx.getVideoState ? _ctx.getVideoState() : null;
  return state && Array.isArray(state.tasks) ? state.tasks : [];
}

function _assetContentEl() {
  return $("assetsContent");
}

function _clearAssetEntranceAnimation() {
  if (_assetEntranceClearTimer) {
    clearTimeout(_assetEntranceClearTimer);
    _assetEntranceClearTimer = null;
  }
  var contentEl = _assetContentEl();
  if (contentEl) contentEl.classList.remove("asset-cards-entrance");
}

function _scheduleAssetEntranceAnimationClear() {
  if (_assetEntranceClearTimer) clearTimeout(_assetEntranceClearTimer);
  _assetEntranceClearTimer = setTimeout(function () {
    _assetEntranceClearTimer = null;
    var contentEl = _assetContentEl();
    if (contentEl) contentEl.classList.remove("asset-cards-entrance");
  }, ASSET_ENTRANCE_ANIM_MS);
}

// 后台转绘任务托管：一键生成"资产阶段"完成后，Step2 彩铅转绘继续
// 在后台跑，用户可以立刻进入编辑/剧本/分镜，不用盯着进度条 4 分钟。
// 只有视频生成入口会硬等 pencilUrl 就绪。
//
// Map<charIdx, { charIdx, charName, taskId, status, startedAt }>
//   status: "submitting" | "running" | "done" | "failed"
//
// 注意：此 Map 仅代表当前 project 正在后台跑的转绘任务。切项目时
// 不清空——一个项目的后台任务可以在另一个项目打开时继续跑完写回。
var _backgroundStylizeTasks = new Map();
// 暴露给视频入口做"能不能开始生成"的前置检查
export function getBackgroundStylizeCount() { return _backgroundStylizeTasks.size; }

/* ================================================================
   资产库（角色/场景/道具 提取 + 参考图生成）
   ================================================================ */

export function refreshAssetsPage() {
  _pendingAssetRerender = false;
  var need = $("assetsNeedScript");
  var ready = $("assetsReady");
  var content = $("assetsContent");
  var saveTplBtn = $("btnSaveWorldTemplate");
  var knowledgeBtn = $("btnKnowledgeSnapshot");
  var pendingWorldBtn = $("btnConfirmPendingWorldFacts");
  var hasScript = !!(project && (project.finalScript || project.script));
  if (!project || !hasScript) {
    // 真实数据不存在（无项目 / 无剧本）时仍显示 need 状态，避免空页面误导用户
    need.hidden = false;
    if (ready) ready.hidden = true;
    if (content) content.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    if (knowledgeBtn) knowledgeBtn.hidden = true;
    if (pendingWorldBtn) pendingWorldBtn.hidden = true;
    return;
  }
  need.hidden = true;
  ready.hidden = false;
  if (project.assets) {
    if (content) content.hidden = false;
    var _staleBannerEl = content && content.querySelector(".upstream-stale-banner");
    if (_staleBannerEl) _staleBannerEl.remove();
    if (_ctx.isStale("assets") && content) {
      var _sb = document.createElement("div");
      _sb.className = "upstream-stale-banner";
      _sb.innerHTML = '<span class="material-symbols-outlined">warning</span>剧本已修改，资产可能需要重新分析以保持一致性';
      content.insertBefore(_sb, content.firstChild);
    }
    renderAssets();
    _showAssetActions();
    checkAssetsConfirm();
    _refreshWorldKnowledgeButtons();
    _updateStylizeBadge();
  } else {
    if (content) content.hidden = true;
    var banner = $("assetsExtractBanner");
    if (banner) banner.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    checkAssetsConfirm();
  }
}

function _hasConsistencyAttention() {
  var meta = project && project.consistency && project.consistency.meta;
  return !!(meta && (meta.needsRoleSync || (Array.isArray(meta.roleSyncReasons) && meta.roleSyncReasons.length)));
}

function _hasPendingWorldFacts() {
  return !!(project && project.pendingWorldFacts && project.pendingWorldFacts.worldTemplateSnapshot);
}

function _refreshWorldKnowledgeButtons() {
  var knowledgeBtn = $("btnKnowledgeSnapshot");
  var pendingWorldBtn = $("btnConfirmPendingWorldFacts");
  var hasProject = !!(project && project.id);
  var hasAttention = _hasConsistencyAttention() || _hasPendingWorldFacts();
  if (knowledgeBtn) {
    knowledgeBtn.hidden = !hasProject;
    var icon = knowledgeBtn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = hasAttention ? "priority_high" : "info";
    knowledgeBtn.classList.toggle("text-[#8A5A00]", hasAttention);
    knowledgeBtn.classList.toggle("border-[#F7D48B]", hasAttention);
    knowledgeBtn.classList.toggle("bg-[#FFF8E6]", hasAttention);
  }
  if (pendingWorldBtn) pendingWorldBtn.hidden = !_hasPendingWorldFacts();
}

function _setExtractProgress(pct, title, hint) {
  var bar = $("assetsExtractProgress");
  var banner = $("assetsExtractBanner");
  var titleEl = $("assetsExtractTitle");
  var hintEl = $("assetsExtractHint");
  if (bar) bar.style.width = pct + "%";
  if (banner) banner.hidden = false;
  if (titleEl && title) titleEl.textContent = title;
  if (hintEl && hint) hintEl.textContent = hint;
}

export async function extractAssets() {
  if (_assetsExtracting) return;
  _assetsExtracting = true;
  _captureAssetReviewSnapshot();
  checkAssetsConfirm();
  var originId = project.id;
  var btn = $("btnExtractAssets");
  if (btn) btn.disabled = true;
  _setExtractProgress(10, "正在分析剧本", "识别角色、场景与道具");

  var _extractCharCount = 0;

  try {
	    var extractBody = {
	      projectId: project.id,
	      script: project.script,
	      worldTemplateSnapshot: project.worldTemplateSnapshot || null,
	    };
    if (!extractBody.projectId && project.styleBible) extractBody.styleBible = project.styleBible;

    _setExtractProgress(20, "正在提取资产", "");
    var _extractProgressBar = $("assetsExtractProgress");
    if (_extractProgressBar) _extractProgressBar.classList.add("extract-bar-pulse");
    var _extractStepState = { buf: "" };
    var _lastExtractPct = 20;

    var resp = await apiPostStream("/api/assets/extract", extractBody, function (chunk) {
      consumeStreamStepTags(chunk, _extractStepState, function (hint) {
        _setExtractProgress(_lastExtractPct, "正在提取资产", hint);
      });
      _extractCharCount += chunk.length;
      _lastExtractPct = Math.min(85, 20 + Math.floor(_extractCharCount / 80));
      _setExtractProgress(_lastExtractPct, "正在提取资产", "");
    });

    if (_extractProgressBar) _extractProgressBar.classList.remove("extract-bar-pulse");
    _setExtractProgress(90, "整理中", "正在整理角色、场景、道具");

    var warningsMap = {};
    if (resp && Array.isArray(resp.warnings)) {
      resp.warnings.forEach(function (w) {
        if (!w || typeof w.propIndex !== 'number') return;
        warningsMap[w.propIndex] = { missing: w.missing || [], message: w.message || '' };
      });
    }

    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
      var nextAssets = resp.assets || { characters: [], scenes: [], props: [] };
      proj.assets = nextAssets;
      proj.characters = Array.isArray(resp.characters) ? resp.characters : _deepClonePlain(nextAssets.characters || []);
      proj.environments = Array.isArray(resp.environments) ? resp.environments : _deepClonePlain(nextAssets.scenes || []);
      proj.props = Array.isArray(resp.props) ? resp.props : _deepClonePlain(nextAssets.props || []);
      if (Object.prototype.hasOwnProperty.call(resp, "pendingWorldFacts")) {
        proj.pendingWorldFacts = resp.pendingWorldFacts;
      }
      if (proj._staleFlags) delete proj._staleFlags["assets"];
      if (Object.keys(warningsMap).length) {
        proj._carryWarnings = warningsMap;
      } else if (proj._carryWarnings) {
        delete proj._carryWarnings;
      }
    });

    if (isCurrent) {
      var nc = (resp.assets.characters || []).length;
      var ns = (resp.assets.scenes || []).length;
      var np = (resp.assets.props || []).length;
      var summary = nc + " 个角色，" + ns + " 个场景，" + np + " 个道具";
      _setExtractProgress(100, "提取完成", summary);
      showToast("资产分析完成：共 " + nc + " 个角色、" + ns + " 个场景、" + np + " 个道具", "success");
      var warningCount = Object.keys(warningsMap).length;
      if (warningCount) {
        showToast("⚠ 载体校验有 " + warningCount + " 项提示，请在道具卡上查看", "warn");
      }
      setTimeout(function () { _ctx.checkAndSuggest("assetExtract"); }, 1500);
      setTimeout(function () {
        var b = $("assetsExtractBanner");
        if (b) b.hidden = true;
      }, 2000);

      var contentEl = $("assetsContent");
      if (contentEl) {
        var staleBanner = contentEl.querySelector(".upstream-stale-banner");
        if (staleBanner) staleBanner.remove();
        contentEl.hidden = false;
        contentEl.classList.remove("asset-cards-entrance");
        void contentEl.offsetWidth;
        contentEl.classList.add("asset-cards-entrance");
        _scheduleAssetEntranceAnimationClear();
      }
      renderAssets({ animateEntrance: true, preserveScroll: false });
      _showAssetActions();
    }
  } catch (e) {
    var _errProgressBar = $("assetsExtractProgress");
    if (_errProgressBar) _errProgressBar.classList.remove("extract-bar-pulse");
    var errRaw = ((e && e.message) || e).toString();
    var friendly = _diagnoseApiError(errRaw);
    _setExtractProgress(0, "提取失败", friendly);
    var _errBanner = $("assetsExtractBanner");
    if (_errBanner) {
      var icon = _errBanner.querySelector(".animate-spin");
      if (icon) { icon.classList.remove("animate-spin"); icon.textContent = "error"; }
    }
    console.error("[Assets] Extract error:", e);
    showToast("资产分析失败：" + friendly, "error");
  }
  _assetsExtracting = false;
  checkAssetsConfirm();
  if (btn) btn.disabled = false;
}

export async function _showAssetActions() {
  var btnExtract = $("btnExtractAssets");
  var btnGen = $("btnGenAssetImages");
  var btnClean = $("btnCleanObsolete");
  if (btnExtract) btnExtract.hidden = false;
  if (btnGen) btnGen.hidden = false;
  if (btnClean) {
    var obsolete = await _detectObsoleteAssets();
    btnClean.hidden = obsolete.length === 0;
    if (obsolete.length) {
      btnClean.querySelector(".material-symbols-outlined").nextSibling.textContent = "清理过时资产 (" + obsolete.length + ")";
    }
  }
}

export function renderAssets(options) {
  options = options || {};
  if (!options.animateEntrance) _clearAssetEntranceAnimation();
  var pageEl = $("pageAssets");
  var preserveScroll = options.preserveScroll !== false && pageEl && !pageEl.hidden;
  var prevScrollTop = preserveScroll ? pageEl.scrollTop : 0;
  var prevScrollLeft = preserveScroll ? pageEl.scrollLeft : 0;
  if (!project || !project.assets) return;
  _cleanupStaleGenStatus();
  renderAssetGrid("assetCharGrid", project.assets.characters, "char", "&#128100;");
  renderAssetGrid("assetSceneGrid", project.assets.scenes, "scene", "&#127968;");
  renderAssetGrid("assetPropGrid", project.assets.props, "prop", "&#128295;");
  $("assetCharCount").textContent = project.assets.characters.length;
  $("assetSceneCount").textContent = project.assets.scenes.length;
  $("assetPropCount").textContent = project.assets.props.length;

  if (preserveScroll) {
    requestAnimationFrame(function () {
      if (!pageEl || pageEl.hidden) return;
      pageEl.scrollTop = prevScrollTop;
      pageEl.scrollLeft = prevScrollLeft;
    });
  }
}

export function _applyServerStaleFlagsToProject(targetProject, prefixes, serverFlags) {
  if (!targetProject) return false;
  var prefixList = Array.isArray(prefixes) ? prefixes : [prefixes || ""];
  var matchesPrefix = function (key) {
    return prefixList.some(function (prefix) {
      return !prefix || key.indexOf(prefix) === 0;
    });
  };
  var authoritativeFlags = serverFlags || {};
  if (!targetProject._staleFlags) targetProject._staleFlags = {};
  var changed = false;

  Object.keys(targetProject._staleFlags).forEach(function (key) {
    if (!matchesPrefix(key)) return;
    if (!authoritativeFlags[key] && targetProject._staleFlags[key]) {
      delete targetProject._staleFlags[key];
      changed = true;
    }
  });

  Object.keys(authoritativeFlags).forEach(function (key) {
    if (!matchesPrefix(key)) return;
    if (authoritativeFlags[key] && targetProject._staleFlags[key] !== true) {
      targetProject._staleFlags[key] = true;
      changed = true;
    }
  });

  return changed;
}

export function renderAssetGrid(containerId, items, type, placeholderIcon) {
  var container = $(containerId);
  if (!container) return;
  container.innerHTML = "";
  if (!items || !items.length) {
    container.innerHTML = '<div class="py-12 text-center text-sm text-on-surface-variant/40">该类别暂无资产</div>';
    return;
  }

  if (type === "char") {
    _renderCharCards(container, items);
  } else if (type === "scene") {
    _renderSceneCards(container, items);
  } else {
    _renderPropCards(container, items);
  }
  hydrateProtectedImageElements(container);
}

function _characterReferenceFailureMessage(_lastError) {
  return "本次生成结果不可用，请重新生成";
}

export function deriveAssetCardState(item, idx) {
  item = item || {};
  var reference = (item.reference && typeof item.reference === "object") ? item.reference : {};
  var mainOriginalUrl = _characterOwnImageUrl(item) || _characterFallbackImageUrl(item, idx) || "";
  var mainImageUrl = item.displayUrl || _assetVariant(mainOriginalUrl, ASSET_CARD_DISPLAY_W);
  var thumbnailUrl = item.thumbUrl || _assetVariant(mainOriginalUrl, ASSET_CARD_THUMB_W);
  var zoomUrl = _assetVariant(item.originalUrl || mainOriginalUrl, ASSET_LIGHTBOX_W);
  var failed = reference.status === "failed";
  var degraded = reference.status === "degraded" && !!mainImageUrl;
  var failedAttemptUrl = failed ? (reference.lastAttemptUrl || "") : "";
  var failedReason = reference.lastError && reference.lastError.reason ? String(reference.lastError.reason) : "";
  var canPreviewFailedAttempt = failed && failedAttemptUrl && failedReason === "character_panel_split_failed";
  var failedAttemptDisplayUrl = _assetVariant(failedAttemptUrl, ASSET_CARD_DISPLAY_W);
  var failedAttemptThumbUrl = _assetVariant(failedAttemptUrl, ASSET_CARD_THUMB_W);
  var failedAttemptZoomUrl = _assetVariant(failedAttemptUrl, ASSET_LIGHTBOX_W);
  var failedAttemptOriginalUrl = _assetOriginal(failedAttemptUrl);
  return {
    status: failed ? "failed" : (degraded ? "degraded" : (mainImageUrl ? "ready" : "missing")),
    originalUrl: _assetOriginal(mainOriginalUrl),
    mainImageUrl: mainImageUrl,
    thumbnailUrl: thumbnailUrl,
    zoomUrl: zoomUrl,
    previewMode: canPreviewFailedAttempt ? "failed_attempt" : (mainImageUrl ? "accepted" : "missing"),
    previewImageUrl: canPreviewFailedAttempt ? failedAttemptDisplayUrl : mainImageUrl,
    previewThumbUrl: canPreviewFailedAttempt ? failedAttemptThumbUrl : thumbnailUrl,
    previewZoomUrl: canPreviewFailedAttempt ? failedAttemptZoomUrl : zoomUrl,
    previewOriginalUrl: canPreviewFailedAttempt ? failedAttemptOriginalUrl : _assetOriginal(mainOriginalUrl),
    failedAttemptUrl: failedAttemptUrl,
    failedAttemptThumbUrl: failedAttemptThumbUrl,
    failedAttemptZoomUrl: failedAttemptZoomUrl,
    statusLabel: failed ? "生成失败" : (degraded ? "可用（比例兜底）" : (mainImageUrl ? "已完成" : "待生成")),
    statusMessage: failed
      ? _characterReferenceFailureMessage(reference.lastError)
      : (degraded ? "生成完成，采用比例兜底切片，可用于后续镜头/视频引用" : ""),
  };
}

function _renderCharCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.className = "asset-card group relative bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500";
    card.dataset.type = "char";
    card.dataset.idx = idx;

    var cardState = deriveAssetCardState(item, idx);
    var imgSrc = cardState.previewImageUrl || '';
    var thumbSrc = cardState.previewThumbUrl || imgSrc;
    var zoomSrc = cardState.previewZoomUrl || imgSrc;
    var originalSrc = cardState.previewOriginalUrl || _assetOriginal(imgSrc);
    var previewBadgeHtml = cardState.previewMode === "failed_attempt"
      ? '<div class="absolute left-3 top-3 z-10 rounded-full bg-on-surface-variant/15 px-2.5 py-1 text-[10px] font-bold tracking-wide text-on-surface-variant/70 shadow-sm">未通过切片</div>'
      : '';

    var imgHtml = '';
    if (imgSrc) {
      imgHtml = '<img src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" decoding="async" class="w-full h-full object-cover object-[left_top] transform group-hover:scale-105 transition-transform duration-700" />';
    } else {
      imgHtml = '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-5xl text-on-surface-variant/15">person</span></div>';
    }

    var roleText = item.role || '';
    if (item.identity) roleText += (roleText ? ' · ' : '') + item.identity;

    var descParts = [];
    if (item.appearance) descParts.push(item.appearance);
    if (item.description) descParts.push(item.description);
    if (item.clothing) descParts.push(item.clothing);
    if (item.equipment) descParts.push(item.equipment);
    var desc = descParts.join(' | ');

    var tagsHtml = '';
    var tags = [];
    if (item.temperament) tags.push(item.temperament);
    if (item.actionTraits) tags.push(item.actionTraits);
    if (tags.length) {
      tagsHtml = '<div class="flex flex-wrap gap-1.5 mt-3">';
      tags.join('，').split(/[,，/、]/).slice(0, 5).forEach(function (t) {
        t = t.trim();
        if (t) tagsHtml += '<span class="inline-block px-2.5 py-1 text-[10px] font-medium bg-surface-container rounded-md text-on-surface-variant/60">' + escapeHtml(t) + '</span>';
      });
      tagsHtml += '</div>';
    }

    var modeTagHtml = '';
    var appearanceMode = (item.appearanceMode || 'main').trim();
    if (appearanceMode === 'referenced') {
      var viaText = (item.via || '').trim() || '未指明';
      modeTagHtml = '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors" data-action="edit-char-mode" title="点击修改出现方式；留空则改回当下活动角色">非当下·' + escapeHtml(viaText) + '</button>';
    }
    var crowdTagHtml = '';
    if (item.isCrowd) {
      var sizeText = (item.crowdSize || '').trim() || '一群';
      crowdTagHtml = '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors" data-action="edit-char-crowd" title="点击修改群体规模；留空则改回单人角色">群体·' + escapeHtml(sizeText) + '</button>';
    }
    var entityTagHtml = '';
    var _eType = ((item.entityType || 'human') + '').toLowerCase();
    if (_eType === 'non-human') {
      entityTagHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500/10 text-cyan-400" title="非人叙事实体（机甲/载具/动物/异形等），不走彩铅转绘">实体·非人</span>';
    }
    var addTagHtml = (!modeTagHtml || !crowdTagHtml)
      ? '<button type="button" class="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-dashed border-outline-variant/40 text-on-surface-variant/50 hover:text-on-surface-variant hover:border-outline-variant/80 transition-colors" data-action="add-char-tag" title="标注为非当下角色（回忆/照片等）或群体角色">+ 标签</button>'
      : '';

    var statusHtml = '';
    if (cardState.status === "failed") {
      var failedPreview = cardState.failedAttemptUrl
        ? '<div class="w-full aspect-square rounded-lg overflow-hidden bg-[#ECEFF1] cursor-pointer hover:ring-2 hover:ring-outline-variant/30 transition-all" data-action="zoom-img" data-img="' + escapeHtml(cardState.failedAttemptZoomUrl) + '"' + _attrOriginal(_assetOriginal(cardState.failedAttemptUrl)) + '>' +
            '<img src="' + escapeHtml(cardState.failedAttemptThumbUrl) + '" loading="lazy" decoding="async" class="w-full h-full object-cover object-[left_top] opacity-85" />' +
          '</div>'
        : '<div class="w-full aspect-square rounded-lg bg-surface-container border border-outline-variant/20 flex items-center justify-center text-on-surface-variant/60 text-[11px] font-bold">无失败图预览</div>';
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">参考图</span><span class="text-[10px] font-bold text-on-surface-variant/70">' + escapeHtml(cardState.statusLabel) + '</span></div>' +
        failedPreview +
        '<p class="mt-2 text-[11px] leading-relaxed text-on-surface-variant/60">' + escapeHtml(cardState.statusMessage) + '</p>';
    } else if (imgSrc) {
      var statusTone = cardState.status === "degraded" ? "text-amber-500" : "text-primary";
      var degradedHint = cardState.statusMessage
        ? '<p class="mt-2 text-[11px] leading-relaxed text-amber-500/80">' + escapeHtml(cardState.statusMessage) + '</p>'
        : '';
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">三视图</span><span class="text-[10px] font-bold ' + statusTone + '">' + escapeHtml(cardState.statusLabel) + '</span></div>' +
        '<div class="w-full aspect-square rounded-lg overflow-hidden bg-[#ECEFF1] cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all" data-action="zoom-img" data-img="' + escapeHtml(zoomSrc) + '"' + _attrOriginal(originalSrc) + '>' +
          '<img src="' + escapeHtml(thumbSrc) + '" loading="lazy" decoding="async" class="w-full h-full object-cover object-[right_center]" />' +
        '</div>' +
        degradedHint;
    } else {
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">参考图</span><span class="text-[10px] font-bold text-on-surface-variant/40">待生成</span></div>';
    }

    card.innerHTML =
      '<div class="flex flex-col md:flex-row h-full min-h-[360px]">' +
        '<div class="w-full md:w-[45%] relative h-72 md:h-auto overflow-hidden rounded-xl cursor-pointer -mt-1 -ml-1 -mr-1 md:mr-0 md:-mb-1" data-action="zoom-img" data-img="' + escapeHtml(zoomSrc) + '"' + _attrOriginal(originalSrc) + '>' +
          imgHtml +
          previewBadgeHtml +
          '<div class="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/20"><span class="material-symbols-outlined text-white text-3xl drop-shadow-lg">zoom_in</span></div>' +
          '<div class="asset-card-loading absolute inset-0 flex items-center justify-center bg-[#0B1320]/40 backdrop-blur-sm z-10"' + (_assetGenStatus["char_" + idx] ? '' : ' hidden') + '>' +
            '<div class="text-center"><div class="inline-block w-7 h-7 border-2 border-white/20 border-t-white rounded-full animate-spin mb-3"></div><p class="text-white font-bold text-[10px] tracking-widest uppercase">生成中…</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="w-full md:w-[55%] p-7 flex flex-col justify-between">' +
          '<div>' +
            '<div class="flex justify-between items-start mb-1">' +
              '<div class="flex-1 min-w-0">' +
                '<h4 class="text-2xl font-bold tracking-tight text-on-background">' + escapeHtml(item.name) + '</h4>' +
                (roleText ? '<p class="text-sm text-on-surface-variant font-medium mt-0.5">' + escapeHtml(roleText) + '</p>' : '') +
                ((modeTagHtml || crowdTagHtml || entityTagHtml || addTagHtml) ? '<div class="flex flex-wrap items-center gap-1.5 mt-2">' + modeTagHtml + crowdTagHtml + entityTagHtml + addTagHtml + '</div>' : '') +
              '</div>' +
              '<span class="material-symbols-outlined text-primary cursor-pointer hover:scale-110 transition-transform text-lg" data-action="char-menu">more_vert</span>' +
            '</div>' +
            '<div class="asset-desc-wrap mt-3" data-action="edit-asset">' +
              '<p class="asset-desc-text text-[11px] text-on-surface-variant/60 leading-relaxed cursor-text hover:text-on-surface-variant transition-colors">' + escapeHtml(desc.slice(0, 300)) + '</p>' +
              '<textarea class="asset-desc-edit hidden w-full text-[11px] text-on-surface-variant leading-relaxed bg-surface-container-lowest border border-outline-variant/20 rounded p-2 mt-1 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30" rows="4">' + escapeHtml(desc.slice(0, 300)) + '</textarea>' +
            '</div>' +
            tagsHtml +
            '<div class="p-3 bg-surface-container-lowest rounded-lg border border-outline-variant/10 mt-5">' + statusHtml + '</div>' +
          '</div>' +
          '<div class="flex items-center gap-3 mt-5">' +
            '<button type="button" class="flex-1 h-10 flex items-center justify-center bg-primary text-on-primary rounded-full font-bold text-[11px] tracking-wider uppercase hover:shadow-lg transition-all" data-action="regen-asset">重新生成</button>' +
            '<button type="button" class="w-10 h-10 flex items-center justify-center bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all" data-action="ref-agent" title="引用到 AI 助手"><span class="material-symbols-outlined text-on-surface text-lg">alternate_email</span></button>' +
            '<button type="button" class="w-10 h-10 flex items-center justify-center bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all" data-action="edit-asset"><span class="material-symbols-outlined text-on-surface text-lg">edit</span></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    container.appendChild(card);
  });
}

function _sceneEditableFields(item) {
  item = item || {};
  return {
    location: (item.location || '').toString(),
    timeSetting: (item.timeSetting || '').toString(),
    atmosphere: (item.atmosphere || '').toString(),
    description: (item.description || '').toString(),
  };
}

function _sceneEditorField(editor, field) {
  return editor && editor.querySelector ? editor.querySelector('[data-scene-edit-field="' + field + '"]') : null;
}

function _readSceneEditorValues(editor) {
  var values = {};
  ["location", "timeSetting", "atmosphere", "description"].forEach(function (field) {
    var el = _sceneEditorField(editor, field);
    values[field] = el && el.value ? el.value.trim() : "";
  });
  return values;
}

function _sceneFieldsEqual(a, b) {
  return ["location", "timeSetting", "atmosphere", "description"].every(function (field) {
    return (a && a[field] || "") === (b && b[field] || "");
  });
}

function _syncSceneTopLevelFields(idx, values) {
  if (!project || !project.environments || !project.environments[idx]) return;
  project.environments[idx].location = values.location;
  project.environments[idx].timeSetting = values.timeSetting;
  project.environments[idx].atmosphere = values.atmosphere;
  project.environments[idx].description = values.description;
}

var _sceneEditPopoverDismissHandler = null;
var _sceneEditPopoverKeyHandler = null;
var _sceneMoreMenuDismissHandler = null;
var _sceneMoreMenuScrollHandler = null;

function _sceneEditFieldHtml(field, label, icon, value, placeholder, multiline) {
  var head = '<label class="qd-field">' +
    '<span class="qd-field-label">' + label + ' <span class="qd-field-label-en">' + field + '</span></span>';
  if (multiline) {
    return head +
      '<div class="qd-field-control qd-field-control--multi">' +
        '<span class="material-symbols-outlined qd-field-icon qd-field-icon--top">' + icon + '</span>' +
        '<textarea data-scene-edit-field="' + field + '" rows="4" placeholder="' + escapeHtml(placeholder) + '" class="qd-field-textarea">' + escapeHtml(value) + '</textarea>' +
      '</div>' +
    '</label>';
  }
  return head +
    '<div class="qd-field-control">' +
      '<span class="material-symbols-outlined qd-field-icon">' + icon + '</span>' +
      '<input type="text" data-scene-edit-field="' + field + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder) + '" class="qd-field-input" />' +
    '</div>' +
  '</label>';
}

function _sceneEditPopoverHtml(item) {
  var values = _sceneEditableFields(item);
  return '<div class="qd-modal-card rounded-[22px] border border-outline-variant/20 bg-white/95 p-5 shadow-2xl backdrop-blur-md">' +
    '<button type="button" class="qd-prompt-close" aria-label="关闭" data-scene-edit-close><span class="material-symbols-outlined">close</span></button>' +
    '<h3 class="text-base font-black tracking-tight text-on-background pr-8">编辑场景信息</h3>' +
    '<div class="qd-modal-fields">' +
      _sceneEditFieldHtml("location", "地点", "place", values.location, "街边门店外街区", false) +
      _sceneEditFieldHtml("timeSetting", "时间", "schedule", values.timeSetting, "夜晚", false) +
      _sceneEditFieldHtml("atmosphere", "氛围", "cloud", values.atmosphere, "冷清，都市", false) +
      _sceneEditFieldHtml("description", "描述", "notes", values.description, "补充场景空间、构图、视觉细节", true) +
    '</div>' +
    '<div class="qd-modal-foot">' +
      '<button type="button" class="qd-modal-btn qd-modal-btn--ghost" data-scene-edit-cancel>取消</button>' +
      '<button type="button" class="qd-modal-btn qd-modal-btn--primary" data-scene-edit-save>保存</button>' +
    '</div>' +
  '</div>';
}

function _positionSceneFloatingPanel(panel, anchor, width, fallbackHeight) {
  var rect = anchor && anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: 24, right: 24, top: 96, bottom: 128 };
  var vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  var vh = window.innerHeight || document.documentElement.clientHeight || 800;
  var gap = 12;
  var panelWidth = Math.min(width, Math.max(280, vw - 24));
  panel.style.width = panelWidth + "px";
  var left = rect.right + gap;
  if (left + panelWidth > vw - 12) left = rect.left - panelWidth - gap;
  if (left < 12) left = Math.max(12, vw - panelWidth - 12);
  var panelHeight = panel.offsetHeight || fallbackHeight || 420;
  var top = rect.top - 8;
  if (top + panelHeight > vh - 12) top = Math.max(12, vh - panelHeight - 12);
  panel.style.left = Math.round(left) + "px";
  panel.style.top = Math.round(top) + "px";
}

function _dismissSceneEditPopover() {
  var popover = document.getElementById("assetSceneEditPopover");
  if (popover) popover.remove();
  if (_sceneEditPopoverDismissHandler) {
    document.removeEventListener("click", _sceneEditPopoverDismissHandler);
    _sceneEditPopoverDismissHandler = null;
  }
  if (_sceneEditPopoverKeyHandler) {
    document.removeEventListener("keydown", _sceneEditPopoverKeyHandler);
    _sceneEditPopoverKeyHandler = null;
  }
}

function _commitSceneAssetEditor(sceneEditor, item, idx) {
  var original = {};
  try { original = JSON.parse(sceneEditor.dataset.original || "{}"); } catch (_e) { original = _sceneEditableFields(item); }
  var next = _readSceneEditorValues(sceneEditor);
  if (_sceneFieldsEqual(original, next)) { _dismissSceneEditPopover(); return; }

  item.location = next.location;
  item.timeSetting = next.timeSetting;
  item.atmosphere = next.atmosphere;
  item.description = next.description;
  _syncSceneTopLevelFields(idx, next);
  item._descEdited = true;
  _ctx.markDownstreamStale("asset", { type: "scene", idx: idx, name: item.name || "" });
  _saveAssetsProject();
  _dismissSceneEditPopover();
  _rerenderAssetGrid("scene");
  _autoSyncUpstream("scene", idx);
}

function _openSceneAssetEditor(anchor, item, idx) {
  _dismissSceneMoreMenu();
  _dismissSceneEditPopover();

  var overlay = document.createElement("div");
  overlay.id = "assetSceneEditPopover";
  overlay.className = "qd-prompt-overlay";
  overlay.dataset.original = JSON.stringify(_sceneEditableFields(item));
  overlay.innerHTML = _sceneEditPopoverHtml(item);
  document.body.appendChild(overlay);

  // 弹窗打开时锁住背景滚动，避免页面在弹窗后面滑动（修复"弹窗不跟随滚动"的观感）。
  var _blockSceneScroll = function (e) { e.preventDefault(); };
  overlay.addEventListener("wheel", _blockSceneScroll, { passive: false });
  overlay.addEventListener("touchmove", _blockSceneScroll, { passive: false });

  var saveBtn = overlay.querySelector("[data-scene-edit-save]");
  var cancelBtn = overlay.querySelector("[data-scene-edit-cancel]");
  var closeBtn = overlay.querySelector("[data-scene-edit-close]");
  if (saveBtn) {
    saveBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      _commitSceneAssetEditor(overlay, item, idx);
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      _dismissSceneEditPopover();
    });
  }
  // 右上角 X = 保存并关闭（与点遮罩一致）。
  if (closeBtn) {
    closeBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      _commitSceneAssetEditor(overlay, item, idx);
    });
  }
  // 点弹窗外的遮罩 = 保存并关闭。
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) _commitSceneAssetEditor(overlay, item, idx);
  });
  // 取消 / Esc = 放弃修改（保留一个明确的“不保存”出口）；Cmd/Ctrl+Enter = 保存。
  _sceneEditPopoverKeyHandler = function (ev) {
    if (ev.key === "Escape") {
      _dismissSceneEditPopover();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      _commitSceneAssetEditor(overlay, item, idx);
    }
  };
  setTimeout(function () {
    document.addEventListener("keydown", _sceneEditPopoverKeyHandler);
  }, 0);
}

function _dismissSceneMoreMenu() {
  var menu = document.getElementById("sceneContextMenu");
  if (menu) menu.remove();
  if (_sceneMoreMenuDismissHandler) {
    document.removeEventListener("click", _sceneMoreMenuDismissHandler);
    _sceneMoreMenuDismissHandler = null;
  }
  if (_sceneMoreMenuScrollHandler) {
    window.removeEventListener("scroll", _sceneMoreMenuScrollHandler, true);
    window.removeEventListener("resize", _sceneMoreMenuScrollHandler);
    _sceneMoreMenuScrollHandler = null;
  }
}

function _showSceneMenu(anchor, idx) {
  var existing = document.getElementById("sceneContextMenu");
  _dismissSceneMoreMenu();
  if (existing) return;
  var item = project && project.assets && project.assets.scenes && project.assets.scenes[idx];
  if (!item) return;
  var menu = document.createElement("div");
  menu.id = "sceneContextMenu";
  menu.className = "fixed z-[10002] min-w-[200px] bg-white rounded-2xl overflow-hidden border border-black/[0.06]";
  menu.style.cssText = "z-index: 10002; box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);";
  menu.innerHTML =
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-2xl" data-scene-menu="upload"><span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传场景图</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-scene-menu="download"><span class="material-symbols-outlined text-lg text-[#1565C0]">download</span>下载图片</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-scene-menu="history"><span class="material-symbols-outlined text-lg">history</span>历史记录</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-2xl" data-scene-menu="delete"><span class="material-symbols-outlined text-lg">delete_outline</span>删除场景</button>';
  document.body.appendChild(menu);
  var _sceneAnchorRect = anchor.getBoundingClientRect();
  menu.style.top = (_sceneAnchorRect.bottom + 8) + "px";
  menu.style.right = (window.innerWidth - _sceneAnchorRect.right) + "px";
  menu.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var btn = ev.target.closest("[data-scene-menu]");
    if (!btn) return;
    var act = btn.dataset.sceneMenu;
    _dismissSceneMoreMenu();
    if (act === "upload") {
      _triggerAssetImageUpload("scene", idx);
    } else if (act === "download") {
      _downloadAssetImage("scene", idx);
    } else if (act === "history") {
      _openAssetHistoryFor("scene", idx);
      return;
    } else if (act === "history-legacy") {
      _ctx.openHistoryPopover(anchor, item, function (hi) {
        if (_ctx.setHistoryAsCurrent(item, hi)) {
          _saveAssetsProject();
          refreshAssetsPage();
          showToast("已恢复到历史版本", "ok");
        }
      });
    } else if (act === "delete") {
      var _delSceneName = item.name || "";
      showConfirm("删除场景", "确定删除场景「" + _delSceneName + "」？", function () {
        _ctx.markDownstreamStale("asset", { type: "scene", idx: idx, name: _delSceneName });
        project.assets.scenes.splice(idx, 1);
        if (Array.isArray(project.environments)) project.environments.splice(idx, 1);
        if (project._staleFlags) delete project._staleFlags["asset_img_scene_" + idx];
        _saveAssetsProject();
        renderAssets();
        _showAssetActions();
      });
    }
  });
  _sceneMoreMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || (anchor && anchor.contains && anchor.contains(ev.target))) return;
    _dismissSceneMoreMenu();
  };
  var _sceneRepoPending = false;
  _sceneMoreMenuScrollHandler = function () {
    if (_sceneRepoPending) return;
    _sceneRepoPending = true;
    requestAnimationFrame(function () {
      _sceneRepoPending = false;
      var m = document.getElementById("sceneContextMenu");
      if (!m) return;
      if (!document.body.contains(anchor)) { _dismissSceneMoreMenu(); return; }
      var r = anchor.getBoundingClientRect();
      m.style.top = (r.bottom + 8) + "px";
      m.style.right = (window.innerWidth - r.right) + "px";
    });
  };
  setTimeout(function () {
    document.addEventListener("click", _sceneMoreMenuDismissHandler);
    window.addEventListener("scroll", _sceneMoreMenuScrollHandler, true);
    window.addEventListener("resize", _sceneMoreMenuScrollHandler);
  }, 0);
}

function _renderSceneCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.dataset.type = "scene";
    card.dataset.idx = idx;

    var originalSrc = item.originalUrl || item.rawUrl || item.imageUrl || '';
    var imgSrc = item.displayUrl || _assetVariant(originalSrc, ASSET_CARD_DISPLAY_W);
    var zoomSrc = _assetVariant(originalSrc, ASSET_LIGHTBOX_W);
    var originalCleanSrc = _assetOriginal(originalSrc);
    var isMain = !!item.isMain || idx === 0;
    var imageAttrs = imgSrc ? ' data-action="zoom-img" data-img="' + escapeHtml(zoomSrc) + '"' + _attrOriginal(originalCleanSrc) : '';
    var imageClass = imgSrc ? ' cursor-pointer' : '';
    var imgHtml = imgSrc
      ? '<img src="' + escapeHtml(imgSrc) + '" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />'
      : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-4xl text-on-surface-variant/15">landscape</span></div>';

    var metaTags = '';
    if (item.timeSetting) metaTags += '<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant"><span class="material-symbols-outlined text-xs">schedule</span>' + escapeHtml(item.timeSetting) + '</span>';
	    if (item.atmosphere) metaTags += '<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant"><span class="material-symbols-outlined text-xs">cloud</span>' + escapeHtml(item.atmosphere.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean).join(', ')) + '</span>';
	    var sceneDescText = item.description ? item.description.slice(0, 120) : '暂无场景描述';
	    var sceneDescClass = item.description
	      ? 'asset-desc-text text-[11px] text-on-surface-variant/60 mt-1.5 leading-relaxed max-h-10 overflow-hidden'
	      : 'asset-desc-text text-[11px] text-on-surface-variant/35 mt-1.5 leading-relaxed max-h-10 overflow-hidden';

    card.className = "asset-card group bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500";
    card.innerHTML =
      '<div class="relative aspect-[16/9] rounded-xl overflow-hidden -mt-1 -ml-1 -mr-1' + imageClass + '"' + imageAttrs + '>' +
        imgHtml +
        '<div class="asset-card-loading absolute inset-0 flex items-center justify-center bg-surface/80 z-10"' + (_assetGenStatus["scene_" + idx] ? '' : ' hidden') + '><div class="tc-spinner"></div></div>' +
        '<div class="absolute inset-x-0 bottom-0 p-3 pl-5 bg-gradient-to-t from-black/65 via-black/20 to-transparent">' +
          '<div class="flex items-center gap-2">' +
            (isMain ? '<span class="bg-primary/90 text-on-primary px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest">主场景</span>' : '') +
            (item.location ? '<span class="text-[11px] font-medium text-white/80 truncate">' + escapeHtml(item.location) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="p-4">' +
        '<div class="flex items-center justify-between gap-3">' +
          '<h4 class="text-base font-bold tracking-tight text-on-background truncate min-w-0 flex-1">' + escapeHtml(item.name || '场景') + '</h4>' +
          '<div class="flex gap-1.5 shrink-0">' +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="ref-agent" title="引用到 AI 助手"><span class="material-symbols-outlined text-on-surface text-sm">alternate_email</span></button>' +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="regen-asset" title="重新生成"><span class="material-symbols-outlined text-on-surface text-sm">refresh</span></button>' +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="edit-asset" title="编辑"><span class="material-symbols-outlined text-on-surface text-sm">edit</span></button>' +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="scene-more" title="更多"><span class="material-symbols-outlined text-on-surface text-sm">more_vert</span></button>' +
          '</div>' +
        '</div>' +
        (metaTags ? '<div class="flex flex-wrap items-center gap-3 mt-2">' + metaTags + '</div>' : '') +
        '<div class="asset-desc-wrap cursor-text" data-action="edit-scene-desc" title="点击直接编辑描述">' +
          '<p class="' + sceneDescClass + '">' + escapeHtml(sceneDescText) + '</p>' +
          '<textarea class="asset-desc-edit hidden w-full text-[11px] text-on-surface-variant leading-relaxed bg-surface-container-lowest border border-outline-variant/20 rounded p-2 mt-1 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30" rows="4"></textarea>' +
        '</div>' +
      '</div>';
    container.appendChild(card);
  });
}

/**
 * 把道具 ownership（角色 id，如 "c1"）解析成角色名用于展示。
 * 在 project.assets.characters 里按 id 精确匹配；查不到（角色被删/脏数据）
 * 回退显示原 id，保证不丢信息也不报错。公共道具 ownership 为空返回空串。
 */
function _resolveOwnerName(ownership) {
  var oid = (ownership == null ? '' : String(ownership)).trim();
  if (!oid) return '';
  var chars = (project && project.assets && project.assets.characters) || [];
  for (var i = 0; i < chars.length; i++) {
    var c = chars[i];
    if (c && c.id != null && String(c.id).trim() === oid) {
      var nm = c.name ? String(c.name).trim() : '';
      return nm || oid;
    }
  }
  return oid;
}

function _renderPropCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.className = "asset-card group relative bg-surface-container-low rounded-xl p-5 flex flex-col justify-between border border-transparent hover:border-outline-variant/20 transition-all min-h-[220px]";
    card.dataset.type = "prop";
    card.dataset.idx = idx;

    var originalSrc = item.originalUrl || item.rawUrl || item.imageUrl || '';
    var imgSrc = item.thumbUrl || _assetVariant(originalSrc, ASSET_CARD_THUMB_W);
    var zoomSrc = _assetVariant(originalSrc, ASSET_LIGHTBOX_W);
    var originalCleanSrc = _assetOriginal(originalSrc);
    var thumbHtml = imgSrc
      ? '<div class="asset-prop-thumb rounded-2xl overflow-hidden border border-outline-variant/20 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all shrink-0" data-action="zoom-img" data-img="' + escapeHtml(zoomSrc) + '"' + _attrOriginal(originalCleanSrc) + '><img src="' + escapeHtml(imgSrc) + '" loading="lazy" decoding="async" class="w-full h-full object-cover" /></div>'
      : '<div class="asset-prop-thumb rounded-2xl bg-surface-container flex items-center justify-center border border-outline-variant/10 shrink-0"><span class="material-symbols-outlined text-on-surface-variant/20 text-3xl">handyman</span></div>';

    var typeLabel = item.propType || '道具';
    var functionSubtitleHtml = item.function
      ? '<p class="text-[9px] text-on-surface-variant/70 mt-1 leading-relaxed">' + escapeHtml(item.function) + '</p>'
      : '';

    var propDescParts = [];
    if (item.features) propDescParts.push(item.features);
    if (item.material) propDescParts.push(item.material);
    var propDesc = propDescParts.join(' | ');

    var tagsHtml = '';
    var tags = [];
    if (item.ownership) {
      var ownerName = _resolveOwnerName(item.ownership);
      if (ownerName) tags.push('道具归属：' + ownerName);
    }
    if (tags.length) {
      tagsHtml = '<div class="flex flex-wrap gap-1 mt-2">';
      tags.forEach(function (t) {
        tagsHtml += '<span class="px-1.5 py-0.5 bg-surface-container text-[9px] text-on-surface-variant/60 rounded">' + escapeHtml(t) + '</span>';
      });
      tagsHtml += '</div>';
    }

    var carriesList = Array.isArray(item.carriesCharacter)
      ? item.carriesCharacter.map(function (n) { return (n || '').trim(); }).filter(Boolean)
      : [];
    var carriesTagHtml = '';
    var carryWarning = (project && project._carryWarnings && project._carryWarnings[idx]) || null;
    if (carriesList.length) {
      carriesTagHtml = '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 transition-colors mt-1.5" data-action="edit-prop-carries" title="点击修改载体承载的角色名，留空则改回普通道具">承载·' + escapeHtml(carriesList.join('、')) + '</button>';
    } else {
      carriesTagHtml = '<button type="button" class="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-dashed border-outline-variant/40 text-on-surface-variant/50 hover:text-on-surface-variant hover:border-outline-variant/80 transition-colors mt-1.5" data-action="edit-prop-carries" title="如果此道具是照片/画像/通缉令等承载人脸的载体，点此标注承载的角色">+ 载体</button>';
    }
    var warnHtml = carryWarning
      ? '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors mt-1.5 ml-1" data-action="show-carry-warning" title="点击查看问题详情">⚠ 校验问题</button>'
      : '';

    card.innerHTML =
      '<div class="flex justify-between items-start">' +
        '<div class="flex-1 min-w-0">' +
          '<span class="text-[9px] font-bold text-primary tracking-widest uppercase">' + escapeHtml(typeLabel) + '</span>' +
          '<h5 class="text-base font-bold mt-1 text-on-background">' + escapeHtml(item.name) + '</h5>' +
          functionSubtitleHtml +
          tagsHtml +
          '<div class="flex flex-wrap items-center gap-1">' + carriesTagHtml + warnHtml + '</div>' +
        '</div>' +
        thumbHtml +
      '</div>' +
      '<div class="asset-desc-wrap mt-3" data-action="edit-asset">' +
        '<p class="asset-desc-text text-[11px] text-on-surface-variant/60 leading-relaxed cursor-text hover:text-on-surface-variant transition-colors">' + escapeHtml(propDesc) + '</p>' +
        '<textarea class="asset-desc-edit hidden w-full text-[11px] text-on-surface-variant leading-relaxed bg-surface-container-lowest border border-outline-variant/20 rounded p-2 mt-1 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30" rows="4">' + escapeHtml(propDesc) + '</textarea>' +
      '</div>' +
      '<div class="asset-card-loading absolute inset-0 flex items-center justify-center bg-surface/80 z-10 rounded-xl"' + (_assetGenStatus["prop_" + idx] ? '' : ' hidden') + '><div class="tc-spinner"></div></div>' +
      '<div class="flex gap-1.5 mt-auto pt-3 flex-wrap">' +
        '<button type="button" class="flex-1 py-2 bg-surface-container-highest/40 text-on-surface text-[9px] font-bold uppercase tracking-[0.15em] rounded-lg hover:bg-surface-container-highest transition-colors" data-action="regen-asset">重新生成</button>' +
        '<button type="button" class="py-2 px-3 bg-surface-container-highest/40 text-on-surface text-[9px] font-bold uppercase tracking-[0.15em] rounded-lg hover:bg-surface-container-highest transition-colors" data-action="ref-agent" title="引用到 AI 助手">@</button>' +
        '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="edit-asset" title="编辑"><span class="material-symbols-outlined text-on-surface text-sm">edit</span></button>' +
        '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="prop-more" title="更多"><span class="material-symbols-outlined text-on-surface text-sm">more_vert</span></button>' +
      '</div>';
    container.appendChild(card);
  });
}


/**
 * Phase 3-B-8：刷新/切 tab 后状态恢复 = 后端权威视图重建。
 *
 * 唯一入口 `reattachActiveBatches(project.id)` —— 从 `/api/batch/active` 拿到
 * 后端当前还在跑的 batch + 每个 task 的 status，重建 `_assetGenStatus` +
 * 续挂 SSE 回调。没有别的"状态副本"可以信：
 *   - `project._generatingAssets`（3-B-7 起后端在 apply_patch_and_save 里清）
 *   - `project._pendingImageTasks`（3-B-8 起同上）
 *   - `TaskRecover` 的 asset/storyboard 分支（3-B-8 起后端 `/api/tasks/active`
 *     只返回 video，前端这条路径也删空）
 *
 * 角色 orphan-pencil 兜底（有 realPhotoUrl 但缺 pencilUrl）由
 * `_autoRecoverOrphanPencils` 处理——它会通过 `_retryPencilConversion`
 * 走新的 `_runStylizeBatch` 路径，落盘依旧权威。
 *
 * 函数整体 fire-and-forget：不 await 不影响首屏渲染，SSE 回来时刷 UI。
 */
export function _restoreAssetGenStatus() {
  if (!project || !project.id) return;
  reattachActiveBatches(project.id).catch(function (e) {
    console.warn("[RestoreGenStatus] reattach failed:", (e && e.message) || e);
  });
  _autoRecoverOrphanPencils();
}

/**
 * 角色缺 pencilUrl 的兜底：刷新后若发现历史数据里有 realPhotoUrl 但无
 * pencilUrl，且当前没有 asset_stylize batch 在跑（`_backgroundStylizeTasks`
 * 会在 reattach 时回填），就挨个补一次转绘。新路径走后端 batch。
 */
function _autoRecoverOrphanPencils() {
  if (!project || !project.assets || !project.assets.characters) return;
  var orphans = [];
  project.assets.characters.forEach(function (item, idx) {
    if (!item) return;
    if (item.isCrowd) return;
    var et = (item.entityType || "human").toString().toLowerCase();
    if (et === "non-human") return;
    if (item.realPhotoUrl && !item.pencilUrl && !_backgroundStylizeTasks.has(idx)) {
      orphans.push(idx);
    }
  });
  if (!orphans.length) return;
  console.log("[OrphanPencil] Found " + orphans.length + " chars needing pencil retry");
  _runOrphanPencilRecovery(orphans);
}

async function _runOrphanPencilRecovery(idxList) {
  for (var i = 0; i < idxList.length; i++) {
    var idx = idxList[i];
    var item = project && project.assets && project.assets.characters && project.assets.characters[idx];
    if (!item || !item.realPhotoUrl || item.pencilUrl) continue;
    try {
      await _retryPencilConversion(idx);
    } catch (e) {
      console.warn("[OrphanPencil] Recovery failed idx=" + idx, e && e.message);
    }
    if (i < idxList.length - 1) await sleep(3000);
  }
}

function _cleanupStaleGenStatus() {
  if (!project || !project.assets) return;
  var cats = { char: "characters", scene: "scenes", prop: "props" };
  Object.keys(_assetGenStatus).forEach(function (key) {
    var parts = key.split("_");
    var t = parts[0]; var i = parseInt(parts[1], 10);
    var catName = cats[t];
    if (!catName) return;
    var list = project.assets[catName];
    if (!list || !list[i]) { delete _assetGenStatus[key]; return; }
    var item = list[i];
    if (t === "char" && item.realPhotoUrl) { delete _assetGenStatus[key]; }
    else if (t !== "char" && item.imageUrl) { delete _assetGenStatus[key]; }
  });
  // Phase 3-B-7：`project._generatingAssets` 不再是权威源，也不再由此函数
  // 维护。如果历史项目 JSON 还带着这个字段，交给 `updateAssetCardImage` 的
  // "done/error" 分支或后端 `apply_patch_and_save` 按 key 清掉。
}

export function updateAssetCardImage(type, idx, status, imgUrl, loadingText) {
  // 业务状态管理依旧留在本模块；DOM 级渲染在 Phase 3-A 搬到 render_hooks.js。
  // Phase 3-B-7：`project._generatingAssets` 不再是权威源——后端
  // `batch_runner._BATCHES` 才是。此函数因此不再把 flag 写进 project.json
  // （减少和权威源打架的状态副本），loading 只在内存 `_assetGenStatus` 维护。
  // 刷新后由 `reattachActiveBatches()` 从后端权威视图重建 loading 态。
  var key = type + "_" + idx;
  if (status === "loading") {
    _assetGenStatus[key] = "loading";
  } else {
    delete _assetGenStatus[key];
    // 若历史项目 JSON 还残留 `_generatingAssets`，这里顺手擦掉，避免
    // 后续刷新时 `_restoreAssetGenStatus` 的兜底分支再误唤醒 loading。
    if (project && project._generatingAssets && project._generatingAssets[key]) {
      delete project._generatingAssets[key];
      if (!Object.keys(project._generatingAssets).length) delete project._generatingAssets;
      _saveAssetsProject();
    }
  }
  if (status === "done") {
    console.log("[updateAssetCardImage] " + type + "#" + idx + " DONE url=" + (imgUrl || "").slice(0, 80));
  }
  checkAssetsConfirm();

  var renderUrl = imgUrl;
  var zoomUrl = "";
  if (status === "done" && imgUrl) {
    var displayWidth = type === "prop" ? ASSET_CARD_THUMB_W : ASSET_CARD_DISPLAY_W;
    renderUrl = _assetVariant(imgUrl, displayWidth);
    zoomUrl = _assetVariant(imgUrl, ASSET_LIGHTBOX_W);
  }
  var result = renderAssetCard(type, idx, status, { imgUrl: renderUrl, zoomUrl: zoomUrl, loadingText: loadingText });
  if (!result.ok) {
    console.warn("[updateAssetCardImage] grid/card not in DOM, will re-render on re-enter");
    if (status === "done" || status === "error") _pendingAssetRerender = true;
    return;
  }
  if (result.needFullRerender) _rerenderAssetGrid(type);
}

function _rerenderAssetGrid(type) {
  if (!project || !project.assets) return;
  _clearAssetEntranceAnimation();
  var pageEl = $("pageAssets");
  var preserveScroll = pageEl && !pageEl.hidden;
  var prevScrollTop = preserveScroll ? pageEl.scrollTop : 0;
  var prevScrollLeft = preserveScroll ? pageEl.scrollLeft : 0;
  var gridId = type === "char" ? "assetCharGrid" : type === "scene" ? "assetSceneGrid" : "assetPropGrid";
  var items = type === "char" ? project.assets.characters : type === "scene" ? project.assets.scenes : project.assets.props;
  var icon = type === "char" ? "&#128100;" : type === "scene" ? "&#127968;" : "&#128295;";
  renderAssetGrid(gridId, items, type, icon);
  if (preserveScroll) {
    requestAnimationFrame(function () {
      if (!pageEl || pageEl.hidden) return;
      pageEl.scrollTop = prevScrollTop;
      pageEl.scrollLeft = prevScrollLeft;
    });
  }
}

function _assetItemFor(type, idx) {
  if (!project || !project.assets) return null;
  var list = type === "char" ? project.assets.characters
    : type === "scene" ? project.assets.scenes
    : project.assets.props;
  return list && list[idx] ? list[idx] : null;
}

function _assetDisplayUrl(type, item) {
  if (!item) return "";
  if (type === "char") {
    if (item.reference && item.reference.status === "failed") return "";
    var charOriginal = item.originalUrl || item.imageUrl || item.pencilUrl || item.realPhotoUrl || item.rawUrl || "";
    return item.displayUrl || _assetVariant(charOriginal, ASSET_CARD_DISPLAY_W);
  }
  var original = item.originalUrl || item.imageUrl || item.rawUrl || "";
  return item.displayUrl || _assetVariant(original, ASSET_CARD_DISPLAY_W);
}

function _assetDownloadTypeLabel(type) {
  return type === "char" ? "角色图" : type === "scene" ? "场景图" : "道具图";
}

function _sanitizeAssetDownloadPart(value, fallback) {
  var text = String(value || "").trim() || fallback || "未命名";
  return text
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || fallback || "未命名";
}

function _assetDownloadBaseName(type, item) {
  var taskName = _sanitizeAssetDownloadPart((project && (project.name || project.title)) || "", "未命名任务");
  var assetType = _assetDownloadTypeLabel(type);
  var assetName = _sanitizeAssetDownloadPart(item && item.name, _assetTypeLabel(type));
  return taskName + "-" + assetType + "-" + assetName;
}

function _assetDownloadUrl(type, item, idx) {
  if (!item) return "";
  if (type === "char") {
    var state = deriveAssetCardState(item, idx);
    return _firstAssetUrl(state.previewOriginalUrl, state.originalUrl, state.previewImageUrl, state.mainImageUrl);
  }
  var reference = item.reference && typeof item.reference === "object" ? item.reference : {};
  return _firstAssetUrl(
    item.originalUrl,
    item.rawUrl,
    item.imageUrl,
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    item.displayUrl,
    item.thumbUrl,
  );
}

function _assetDownloadExtFrom(url, contentType) {
  var type = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/svg+xml") return ".svg";
  var cleanUrl = String(url || "").split("?")[0].split("#")[0];
  var match = cleanUrl.match(/\.(jpe?g|png|webp|gif|svg)$/i);
  return match ? "." + match[1].toLowerCase().replace("jpeg", "jpg") : ".png";
}

function _assetDownloadFetchOptions(url) {
  var opts = { method: "GET" };
  try {
    var parsed = new URL(url, window.location.href);
    if (parsed.origin === window.location.origin) {
      var authHeaders = getAuthHeaders ? getAuthHeaders() : {};
      if (authHeaders.Authorization) opts.headers = { Authorization: authHeaders.Authorization };
      opts.credentials = "same-origin";
    }
  } catch (_e) {}
  return opts;
}

async function _downloadAssetImage(type, idx) {
  var item = _assetItemFor(type, idx);
  if (!item) {
    showToast("当前资产不存在", "warn");
    return;
  }
  var url = _assetDownloadUrl(type, item, idx);
  if (!url) {
    showToast("暂无可下载图片", "warn");
    return;
  }
  try {
    var resp = await fetch(url, _assetDownloadFetchOptions(url));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var blob = await resp.blob();
    var baseName = _assetDownloadBaseName(type, item);
    var ext = _assetDownloadExtFrom(url, blob.type || resp.headers.get("content-type") || "");
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = blobUrl;
    a.download = baseName + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
  } catch (e) {
    console.warn("[AssetDownload] failed:", e);
    showToast("下载失败，请稍后重试", "error");
  }
}

function _syncGeneratedAssetCardsFromProject() {
  var keys = Object.keys(_assetGenStatus);
  var updated = false;
  keys.forEach(function (key) {
    var parts = key.split("_");
    var type = parts[0];
    var idx = parseInt(parts[1], 10);
    if (!type || isNaN(idx)) return;
    var url = _assetDisplayUrl(type, _assetItemFor(type, idx));
    if (!url) return;
    updateAssetCardImage(type, idx, "done", url);
    updated = true;
  });
  return updated;
}

export async function _rebuildAssetImagePrompt(type, item) {
  var descParts = [];
  if (type === "char") {
    if (item.appearance) descParts.push(item.appearance);
    if (item.clothing) descParts.push(item.clothing);
    if (item.equipment) descParts.push(item.equipment);
  } else {
    if (item.description) descParts.push(item.description);
  }
  var desc = descParts.join(' | ');
  if (!desc) return null;
  try {
    var payload = {
      type: type,
      name: item.name || '',
      description: desc,
      styleBible: project.styleBible || null,
    };
    if (type === "scene") {
      if (item.timeSetting) payload.timeSetting = item.timeSetting;
      if (item.weather) payload.weather = item.weather;
      if (item.atmosphere) payload.atmosphere = item.atmosphere;
      if (item.lighting) payload.lighting = item.lighting;
      if (item.elements) payload.elements = item.elements;
      if (item.location) payload.location = item.location;
    }
    if (type === "char") {
      if (item.isCrowd) {
        payload.isCrowd = true;
        if (item.crowdSize) payload.crowdSize = item.crowdSize;
      }
    }
    if (type === "prop" && Array.isArray(item.carriesCharacter) && item.carriesCharacter.length) {
      payload.carriesCharacter = item.carriesCharacter;
    }
    var resp = await apiPost("/api/assets/rebuild-prompt", payload);
    return resp.imagePrompt || null;
  } catch (e) {
    console.error("[RebuildPrompt] failed:", e);
    return null;
  }
}

/**
 * Phase 3-B-8 · 单卡重新生成 = 单元素 `asset_images` batch。
 *
 * 和"一键生成全部资产"完全共用一条 executor 路径：
 *   - char：executor 内部 Step1（真人图）+ Step2（彩铅）一条龙，`apply_patch_and_save`
 *     把 realPhotoUrl + pencilUrl 一次落盘；刷新页面回来就有图
 *   - scene / prop：单 URL 写 imageUrl
 *
 * 不再自管 `_pendingImageTasks` / `registerServerTask` —— 后端 batch_runner
 * 是权威源，前端只挂 SSE 看进度 + 乐观渲染 UI。
 */
export async function generateSingleAssetImage(type, idx) {
  if (!project) return;
  var originId = project.id;
  var list = type === "char" ? project.assets.characters
           : type === "scene" ? project.assets.scenes
           : project.assets.props;
  var item = list && list[idx];
  if (!item) return;

  updateAssetCardImage(type, idx, "loading", null, "正在同步最新提示词…");

  var rebuiltPrompt = await _rebuildAssetImagePrompt(type, item);
  if (rebuiltPrompt) {
    item.imagePrompt = rebuiltPrompt;
    var topKey = type === "char" ? "characters" : type === "scene" ? "environments" : "props";
    if (project[topKey] && project[topKey][idx]) {
      project[topKey][idx].imagePrompt = rebuiltPrompt;
    }
  } else if (item.imagePrompt) {
    item.imagePrompt = "";
    var fallbackTopKey = type === "char" ? "characters" : type === "scene" ? "environments" : "props";
    if (project[fallbackTopKey] && project[fallbackTopKey][idx]) {
      project[fallbackTopKey][idx].imagePrompt = "";
    }
  }

  if (_ctx.flushServerSave) {
    await _ctx.flushServerSave();
  } else if (_ctx.saveProject) {
    await _saveAssetsProject();
  }

  updateAssetCardImage(type, idx, "loading");

  var batchTarget = { type: type, idx: idx };
  var totalTasks = 1;
  var hint = $("assetImgHint");

  return new Promise(function (resolve) {
    apiPost("/api/batch/start", {
      batchType: "asset_images",
      projectId: originId,
      targets: [batchTarget],
      options: {},
    }).then(function (startResp) {
      if (!startResp || !startResp.batchId) {
        var errMsg = (startResp && startResp.error) || "未能创建批量任务";
        updateAssetCardImage(type, idx, "error");
        showToast("生成失败：" + _diagnoseApiError(errMsg), "error");
        resolve({ done: 0, failed: 1 });
        return;
      }
      _attachAssetImageBatch({
        batchId: startResp.batchId,
        originId: originId,
        seqToTarget: { 0: batchTarget },
        hint: hint,
        totalTasks: totalTasks,
        onFinish: function (res) { resolve(res); },
      });
    }).catch(function (e) {
      console.error("[AssetImg] single /api/batch/start failed:", e);
      if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
        updateAssetCardImage(type, idx, "error");
        showBillingPaywall(e.billing || null);
        resolve({ done: 0, failed: 1 });
        return;
      }
      var errMsg = ((e && e.message) || e).toString();
      updateAssetCardImage(type, idx, "error");
      showToast("生成失败：" + _diagnoseApiError(errMsg), "error");
      resolve({ done: 0, failed: 1 });
    });
  });
}

export function _toastErrorWithActions(rawMsg) {
  showToast(_diagnoseApiError(rawMsg), "error");
}

/**
 * 把后端返回的原始错误转成用户看得懂的中文。
 * 优先识别这几类常见错误（按出现概率排）：
 *   - 中转站余额不足（yungpt: "user quota is not enough"）
 *   - 官方 OpenAI 余额/限额（"insufficient_quota" / "billing"）
 *   - 频率限制（"rate limit" / "429"）
 *   - Key 失效 / 没权限（"401" / "403" / "invalid api key"）
 *   - 模型不存在（"model_not_found" / "404"）
 *   - 上下文超限（"context length"）
 *   - 网络超时（"timeout" / "ETIMEDOUT" / "AbortError"）
 *   - 中转站连不上（5xx / "connect" / "ECONNREFUSED"）
 * 都没匹配上 → 显示截断后的原文，比"请稍后重试"更有帮助。
 */
export function _diagnoseApiError(msg) {
  var raw = String(msg == null ? "" : msg);
  try { if (raw) console.debug('[diagnoseApiError] raw:', raw.slice(0, 400)); } catch (_e) {}
  var s = raw.toLowerCase();
  if (s.indexOf("quota is not enough") >= 0 || s.indexOf("insufficient_quota") >= 0 || s.indexOf("insufficient quota") >= 0 || s.indexOf("billing") >= 0) {
    return "中转站/账户余额不足，请到中转站充值或换一个 Key";
  }
  if (
    raw.indexOf("未通过内容安全审核") >= 0 ||
    raw.indexOf("图像服务未返回具体拦截词") >= 0 ||
    raw.indexOf("系统推测可先弱化") >= 0
  ) {
    return raw.slice(0, 260);
  }
  // 图像内容安全审核拦截(moderation_blocked / safety system)。通用文案: 不带"首帧/尾帧"
  // 前缀, 因为本函数同样服务尾帧/资产/视频; 具体语境由调用处的卡片/前缀给出。
  if (s.indexOf("moderation_blocked") >= 0 || s.indexOf("safety system") >= 0 || s.indexOf("image_generation_user_error") >= 0 || s.indexOf("content_policy") >= 0 || s.indexOf("rejected by the safety") >= 0 || s.indexOf("内容安全") >= 0 || s.indexOf("安全审核") >= 0) {
    return "提示词违规，未通过安全审核";
  }
  if (s.indexOf("rate limit") >= 0 || s.indexOf("rate_limit") >= 0 || s.indexOf("429") >= 0 || s.indexOf("too many requests") >= 0) {
    return "调用太频繁触发限流，请等 30 秒后重试";
  }
  if (s.indexOf("invalid api key") >= 0 || s.indexOf("invalid_api_key") >= 0 || s.indexOf("incorrect api key") >= 0 || s.indexOf("401") >= 0 || s.indexOf("unauthorized") >= 0 || s.indexOf("403") >= 0 || s.indexOf("forbidden") >= 0) {
    return "API Key 无效或没权限，请到设置页检查 Key";
  }
  if (s.indexOf("model_not_found") >= 0 || s.indexOf("model not found") >= 0 || s.indexOf("does not exist") >= 0 || (s.indexOf("404") >= 0 && s.indexOf("model") >= 0)) {
    return "中转站不支持这个模型，请到设置页换一个模型";
  }
  if (s.indexOf("context length") >= 0 || s.indexOf("maximum context") >= 0 || s.indexOf("token limit") >= 0) {
    return "剧本/上下文太长超出模型限制，可考虑换更大上下文的模型";
  }
  if (s.indexOf("timeout") >= 0 || s.indexOf("etimedout") >= 0 || s.indexOf("aborterror") >= 0 || s.indexOf("超时") >= 0) {
    return "请求超时（中转站响应太慢），请重试或换中转站";
  }
  if (s.indexOf("econnrefused") >= 0 || s.indexOf("enotfound") >= 0 || s.indexOf("network") >= 0 || s.indexOf("fetch failed") >= 0) {
    return "无法连接到中转站，请检查网络或中转站地址";
  }
  if (/\b5\d\d\b/.test(s)) {
    return "中转站服务异常（5xx），请稍后重试或换中转站";
  }
  // 都没匹配上 → 截断原文（去掉前缀的"图像生成失败：" 之类，更干净）
  var cleaned = raw.replace(/^([\u4e00-\u9fa5]+(?:失败)?[:：]\s*)+/, "").trim();
  return cleaned ? cleaned.slice(0, 120) : "生成失败，请稍后重试";
}

function _markAssetImageFailedLocally(originId, type, idx, err, extra, serverVersion) {
  if (!type || typeof idx !== "number" || !_ctx.safeWriteBack) return false;
  var cat = type === "char" ? "characters" : type === "scene" ? "scenes" : "props";
  var topKey = type === "char" ? "characters" : type === "scene" ? "environments" : "props";
  var message = (err || "生成失败").toString().slice(0, 1000);
  var failedAt = new Date().toISOString();
  return _ctx.safeWriteBack(originId, function (proj) {
    if (!proj.assets) proj.assets = {};
    if (!Array.isArray(proj.assets[cat])) proj.assets[cat] = [];
    var item = proj.assets[cat][idx];
    if (!item) return;
    var existingUrl =
      (item.reference && (item.reference.currentUrl || item.reference.lastKnownGoodUrl)) ||
      item.imageUrl ||
      item.rawUrl ||
      item.realPhotoUrl ||
      item.pencilUrl ||
      "";
    var referenceStatus = (extra && extra.referenceStatus) || (existingUrl ? "degraded" : "failed");
    var lastError = {
      message: message,
      failedAt: failedAt,
      batchType: "asset_images",
      imageSafetyAudit: extra && extra.imageSafetyAudit
    };
    item.reference = Object.assign({}, item.reference || {}, {
      currentUrl: (item.reference && item.reference.currentUrl) || item.imageUrl || item.rawUrl || undefined,
      lastKnownGoodUrl: (item.reference && item.reference.lastKnownGoodUrl) || existingUrl || undefined,
      status: referenceStatus,
      lastError: lastError
    });
    item.imageLastError = message;
    item.imageFailedAt = failedAt;
    if (extra && extra.imageSafetyAudit) item.imageSafetyAudit = extra.imageSafetyAudit;

    var top = Array.isArray(proj[topKey]) ? proj[topKey] : null;
    if (top && top[idx]) {
      top[idx].reference = item.reference;
      top[idx].imageLastError = item.imageLastError;
      top[idx].imageFailedAt = item.imageFailedAt;
      if (item.imageSafetyAudit) top[idx].imageSafetyAudit = item.imageSafetyAudit;
    }
  }, serverVersion);
}

/**
 * 更新资产面板顶部的「风格图补全中 N/M」徽标。
 * N = 当前项目已就绪的 pencilUrl 数；M = 需要转绘的人形角色总数
 * （non-human 直接复用真人图所以不计入）。
 */
function _updateStylizeBadge() {
  var el = $("assetStylizeBadge");
  if (!el) return;
  var chars = (project && project.assets && project.assets.characters) || [];
  var total = 0;
  var done = 0;
  chars.forEach(function (c) {
    if (c && c.isCrowd) return;
    var et = (c.entityType || "human").toString().toLowerCase();
    if (et === "non-human") return;  // 不需要转绘
    if (!c.realPhotoUrl) return;      // 第一步都没完成
    total++;
    if (c.pencilUrl) done++;
  });
  var running = _backgroundStylizeTasks.size;
  if (running === 0 && total > 0 && done >= total) {
    el.hidden = true;
    return;
  }
  if (total === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (running > 0) {
    el.textContent = "风格图补全中 " + done + "/" + total + "（后台运行，可继续下一步）";
    } else {
    // 有缺口但没有 running —— 之前失败留下的
    el.textContent = "风格图待补全 " + done + "/" + total + "（点击卡片重试）";
  }
}

function _collectDefaultAssetImageTargets() {
  var targets = [];
  if (!project || !project.assets) return targets;
  ["characters", "scenes", "props"].forEach(function (cat) {
    var type = cat === "characters" ? "char" : cat === "scenes" ? "scene" : "prop";
    (project.assets[cat] || []).forEach(function (item, idx) {
      var needsGen = !item.imageUrl && item.imagePrompt;
      if (!needsGen) return;
      targets.push({ type: type, idx: idx });
    });
  });
  return targets;
}

function _setAssetImagesGeneratingLocked(locked) {
  _assetImagesGenerating = !!locked;
  var btn = $("btnGenAssetImages");
  if (btn) btn.disabled = !!locked;
  checkAssetsConfirm();
}

function _summarizeAssetImageGeneration(hint) {
  var done = 0;
  var still_missing = 0;
  var pencil_pending = 0;
  if (!project || !project.assets) return;
  ["characters", "scenes", "props"].forEach(function (cat) {
    (project.assets[cat] || []).forEach(function (item) {
      if (item.imageUrl) done++;
      else if (item.imagePrompt) still_missing++;
    });
  });
  (project.assets.characters || []).forEach(function (item) {
    if (item && item.isCrowd) return;
    var et = (item.entityType || "human").toString().toLowerCase();
    if (et === "non-human") return;
    if (item.realPhotoUrl && !item.pencilUrl) pencil_pending++;
  });
  if (hint) {
    var hintParts = [];
    if (still_missing > 0) hintParts.push(still_missing + " 张图仍失败");
    if (pencil_pending > 0) hintParts.push(pencil_pending + " 个角色风格图后台补全中");
    if (hintParts.length > 0) {
      hint.textContent = done + " 张已生成，" + hintParts.join("、") + "（可进入下一步）";
    } else {
      hint.textContent = done + " 张参考图全部生成完成 ✓";
    }
  }
  if (still_missing > 0) {
    showToast(still_missing + " 张参考图待优化（不影响后续步骤，可手动重试）", "info");
  } else if (pencil_pending > 0) {
    showToast("资产生成完成 ✓ 风格图在后台补全中，可直接进入下一步", "ok");
  } else if (done > 0) {
    showToast("资产参考图生成完成 ✓", "ok");
  }
  _updateStylizeBadge();
  checkAssetsConfirm();
}

async function _runAssetImageTargets(targets, hint) {
  if (!project || !project.id) return;
  targets = Array.isArray(targets) ? targets : [];
  if (_assetImagesGenerating) return;
  if (!targets.length) {
    if (hint) hint.textContent = "没有需要生成的资产";
    return;
  }
  _setAssetImagesGeneratingLocked(true);
  try {
    if (hint) hint.textContent = "正在批量生成参考图…（gpt-image-1 单张约 20-40 秒，请耐心等待）";
    targets.forEach(function (t) {
      updateAssetCardImage(t.type, t.idx, "loading");
    });
    await _runAssetImageBatch(project.id, targets, hint, targets.length);
    _summarizeAssetImageGeneration(hint);
  } finally {
    _setAssetImagesGeneratingLocked(false);
  }
}

function _clearAssetImageDerivedFields(item) {
  [
    "originalUrl",
    "displayUrl",
    "thumbUrl",
    "pencilOriginalUrl",
    "pencilDisplayUrl",
    "pencilThumbUrl",
    "_originImageUrl",
    "_originRawUrl",
    "_originRealPhotoUrl",
    "_originPencilUrl",
    "_originOriginalUrl",
    "_originDisplayUrl",
    "_originThumbUrl",
    "_originPencilOriginalUrl",
    "_originPencilDisplayUrl",
    "_originPencilThumbUrl",
  ].forEach(function (field) { delete item[field]; });
}

function _reuseLatestInfoChangedImage(type, idx) {
  if (!project || !project.assets) return false;
  var list = _assetListByTypeFromAssets(project.assets, type);
  var item = list && list[idx];
  var snap = _latestInfoChangedSnap(item);
  if (!item || !snap) return false;

  _ASSET_GENERATED_FIELDS.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(snap, field)) {
      item[field] = _cloneAssetReviewValue(snap[field]);
    } else {
      delete item[field];
    }
  });

  var restoredUrl = _reviewSnapshotUrl(snap);
  if (restoredUrl) {
    if (!item.imageUrl) item.imageUrl = restoredUrl;
    if (!item.rawUrl) item.rawUrl = restoredUrl;
    item.reference = Object.assign({}, item.reference || {}, {
      currentUrl: item.imageUrl || restoredUrl,
      lastKnownGoodUrl: item.imageUrl || restoredUrl,
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
  }

  _clearAssetImageDerivedFields(item);
  delete item.imageLastError;
  delete item.imageFailedAt;
  delete item._pencilFailed;
  delete item.panelsError;
  delete item.panelsErrorAt;
  if (item.reference) {
    delete item.reference.lastError;
    delete item.reference.lastAttemptUrl;
    delete item.reference.lastFailedAt;
  }
  if (project._staleFlags) delete project._staleFlags["asset_img_" + type + "_" + idx];

  var topKey = _assetTypeTopKey(type);
  if (!Array.isArray(project[topKey])) project[topKey] = [];
  project[topKey][idx] = _deepClonePlain(item);
  return true;
}

function _assetReviewGroupedRows(rows, type) {
  return rows.filter(function (row) { return row.type === type; });
}

function _assetReviewGroupHtml(rows, type, title) {
  var groupRows = _assetReviewGroupedRows(rows, type);
  if (!groupRows.length) return "";
  var body = groupRows.map(function (row) {
    var disabled = row.disabled ? " disabled" : "";
    var checked = row.checked ? " checked" : "";
    return '<label class="flex items-center gap-3 rounded-xl border border-outline/10 bg-surface/80 px-3 py-3 hover:border-outline/25 transition-colors' + (row.disabled ? ' opacity-60' : '') + '" data-review-row="' + escapeHtml(row.id) + '">' +
      '<span class="relative w-16 h-16 shrink-0 overflow-hidden rounded-lg border border-outline/10 bg-surface-container-highest/40">' +
        _assetReviewThumbHtml(row) +
      '</span>' +
      '<span class="min-w-0 flex-1">' +
        '<span class="block truncate text-sm font-bold text-on-surface">' + escapeHtml(row.name || "") + '</span>' +
        '<span class="mt-1 block text-xs text-on-surface-variant">' + escapeHtml(row.status || "") + '</span>' +
      '</span>' +
      '<input type="checkbox" class="w-5 h-5 rounded border-outline/30 accent-primary shrink-0" data-review-checkbox data-row-id="' + escapeHtml(row.id) + '"' + checked + disabled + ' />' +
    '</label>';
  }).join("");
  return '<section class="asset-review-section">' +
    '<div class="mb-3 flex items-center justify-between">' +
      '<h4 class="text-xs font-bold uppercase tracking-[0.16em] text-on-surface-variant">' + escapeHtml(title) + '</h4>' +
      '<span class="text-[11px] text-on-surface-variant/70">' + groupRows.length + ' 项</span>' +
    '</div>' +
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">' + body + '</div>' +
  '</section>';
}

function _assetReviewSelectedState(overlay, rows) {
  var rowMap = {};
  rows.forEach(function (row) { rowMap[row.id] = row; });
  var targets = [];
  var reuseRows = [];
  var inputs = overlay.querySelectorAll("[data-review-checkbox]");
  inputs.forEach(function (input) {
    var row = rowMap[input.getAttribute("data-row-id") || ""];
    if (!row || row.deleted || row.disabled) return;
    if (input.checked) {
      targets.push({ type: row.type, idx: row.idx });
      return;
    }
    if (row.kind === "changed_missing") {
      reuseRows.push(row);
    }
  });
  return { targets: targets, reuseRows: reuseRows };
}

function _updateAssetReviewConfirmEnabled(overlay, rows) {
  var confirmBtn = overlay.querySelector("[data-review-confirm]");
  if (!confirmBtn) return;
  var state = _assetReviewSelectedState(overlay, rows);
  confirmBtn.disabled = !(state.targets.length || state.reuseRows.length);
}

function _dismissAssetRegenerationReviewDialog() {
  var overlay = document.getElementById("assetRegenerationReviewDialog");
  if (overlay) overlay.remove();
}

async function _executeAssetRegenerationReview(targets, reuseRows) {
  if (!project || !project.id || _assetImagesGenerating) return;
  var hint = $("assetImgHint");
  var reused = 0;
  _setAssetImagesGeneratingLocked(true);
  try {
    if (hint) hint.textContent = reuseRows.length && targets.length ? "正在沿用历史图并生成选中资产…" : reuseRows.length ? "正在沿用历史参考图…" : "正在批量生成参考图…（gpt-image-1 单张约 20-40 秒，请耐心等待）";
    reuseRows.forEach(function (row) {
      if (_reuseLatestInfoChangedImage(row.type, row.idx)) reused++;
    });
    if (reused > 0) {
      if (_ctx.flushServerSave) {
        await _ctx.flushServerSave();
      } else if (_ctx.saveProject) {
        await _saveAssetsProject();
      }
      renderAssets();
      _showAssetActions();
    }
    if (targets.length) {
      targets.forEach(function (t) {
        updateAssetCardImage(t.type, t.idx, "loading");
      });
      await _runAssetImageBatch(project.id, targets, hint, targets.length);
      _summarizeAssetImageGeneration(hint);
    } else {
      if (hint) hint.textContent = reused > 0 ? "已沿用历史参考图" : "没有需要生成的资产";
      if (reused > 0) showToast("已沿用历史参考图", "ok");
      _updateStylizeBadge();
      checkAssetsConfirm();
    }
  } finally {
    _setAssetImagesGeneratingLocked(false);
  }
}

function _showAssetRegenerationReviewDialog() {
  var rows = _buildAssetRegenerationReviewRows();
  if (!rows.length) return false;
  _dismissAssetRegenerationReviewDialog();
  var overlay = document.createElement("div");
  overlay.id = "assetRegenerationReviewDialog";
  overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/35 backdrop-blur-sm px-4 py-6";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML =
    '<div class="w-full max-w-5xl max-h-[86vh] overflow-hidden rounded-[28px] bg-surface shadow-2xl border border-outline/10 flex flex-col">' +
      '<div class="flex items-start justify-between gap-4 border-b border-outline/10 px-6 py-5">' +
        '<div>' +
          '<h3 class="text-xl font-bold text-on-surface">请确认重新生成范围：</h3>' +
        '</div>' +
        '<button type="button" class="w-10 h-10 rounded-full border border-outline/15 bg-surface-container-low text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high flex items-center justify-center transition-colors" data-review-close aria-label="关闭">' +
          '<span class="material-symbols-outlined text-xl">close</span>' +
        '</button>' +
      '</div>' +
      '<div class="flex-1 overflow-y-auto px-6 py-5 space-y-6">' +
        _assetReviewGroupHtml(rows, "char", "角色 Characters") +
        _assetReviewGroupHtml(rows, "scene", "场景 Scenes") +
        _assetReviewGroupHtml(rows, "prop", "道具 Props") +
      '</div>' +
      '<div class="flex items-center justify-end gap-3 border-t border-outline/10 px-6 py-5">' +
        '<button type="button" class="h-11 px-7 rounded-full bg-surface-container-high text-on-surface-variant font-bold hover:bg-surface-container-highest transition-colors" data-review-close>取消</button>' +
        '<button type="button" class="h-11 px-8 rounded-full bg-primary text-on-primary font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg transition-all" data-review-confirm>确定</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  hydrateProtectedImageElements(overlay);
  _updateAssetReviewConfirmEnabled(overlay, rows);

  overlay.addEventListener("change", function (ev) {
    if (ev.target && ev.target.matches("[data-review-checkbox]")) {
      _updateAssetReviewConfirmEnabled(overlay, rows);
    }
  });
  overlay.addEventListener("click", function (ev) {
    var closeBtn = ev.target.closest("[data-review-close]");
    if (closeBtn) {
      _dismissAssetRegenerationReviewDialog();
      return;
    }
    var confirmBtn = ev.target.closest("[data-review-confirm]");
    if (!confirmBtn || confirmBtn.disabled) return;
    var state = _assetReviewSelectedState(overlay, rows);
    if (!state.targets.length && !state.reuseRows.length) {
      _updateAssetReviewConfirmEnabled(overlay, rows);
      return;
    }
    confirmBtn.disabled = true;
    _dismissAssetRegenerationReviewDialog();
    _executeAssetRegenerationReview(state.targets, state.reuseRows).catch(function (e) {
      console.error("[AssetReview] confirm failed:", e);
      showToast("生成范围确认失败：" + ((e && e.message) || e), "error");
      _setAssetImagesGeneratingLocked(false);
    });
  });
  return true;
}

export async function generateAllAssetImages() {
  // Phase 3-B-4 / 3-B-6 / 3-B-7 / 3-B-8：全部资产（角色一条龙 Step1+Step2、
  // 场景、道具）都进同一个后端 batch。**单卡重试**也走相同
  // executor —— `generateSingleAssetImage` 直接发单元素 batch，完全不再碰
  // `/api/images/submit` / `_pollStylizeTask` / `_pendingImageTasks`。
  // 前端只负责：
  //   1. 扫 project.assets 决定哪些要生成
  //   2. 挂 loading 占位
  //   3. POST /api/batch/start + subscribeBatch 看进度
  if (_assetImagesGenerating) return;
  var hint = $("assetImgHint");
  if (_shouldShowAssetRegenerationReview()) {
    if (_showAssetRegenerationReviewDialog()) return;
  }
  var allTargets = _collectDefaultAssetImageTargets();
  if (!allTargets.length) {
    if (hint) hint.textContent = "没有需要生成的资产";
    return;
  }
  await _runAssetImageTargets(allTargets, hint);
}

/**
 * Phase 3-B-4 / 3-B-6 / 3-B-7 · 主批流程：调 /api/batch/start 并 subscribeBatch。
 * 返回 { done, failed } 计数。
 *
 * Phase 3-B-6：角色 Step1 + Step2 由后端 `asset_image_executor` 一条龙完成；
 * extra 同时带 `realPhotoUrl` + `pencilUrl`。前端 onTaskCompleted 只负责 UI
 * 乐观更新，权威落盘已由 batch_runner 侧 `apply_patch_and_save` 写进
 * project.json——用户刷新 reload 出来的项目就是"有图"的权威版。
 *
 * Phase 3-B-7：场景图走同一个 batch，前端不再额外跑 Phase 2 串行流；
 * subscribe 回调抽成
 * `_attachAssetImageBatch` 以便"刷新后重连活跃 batch"复用。
 */
function _runAssetImageBatch(originId, mainTargets, hint, totalTasks) {
  if (!mainTargets.length) return Promise.resolve({ done: 0, failed: 0 });
  return new Promise(function (resolve) {
    var seqToTarget = {};
    mainTargets.forEach(function (t, seq) { seqToTarget[seq] = t; });

    apiPost("/api/batch/start", {
      batchType: "asset_images",
      projectId: originId,
      targets: mainTargets,
      options: {},
    }).then(function (startResp) {
      if (!startResp || !startResp.batchId) {
        var errMsg = (startResp && startResp.error) || "未能创建批量任务";
        if (hint) hint.textContent = "批量启动失败：" + errMsg;
        showToast("批量启动失败：" + _diagnoseApiError(errMsg), "error");
        mainTargets.forEach(function (t) { updateAssetCardImage(t.type, t.idx, "error"); });
        resolve({ done: 0, failed: mainTargets.length });
        return;
      }
      _attachAssetImageBatch({
        batchId: startResp.batchId,
        originId: originId,
        seqToTarget: seqToTarget,
        hint: hint,
        totalTasks: totalTasks,
        onFinish: function (res) { resolve(res); },
      });
    }).catch(function (e) {
      console.error("[AssetImg] /api/batch/start failed:", e);
      if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
        if (hint) hint.textContent = '积分不足';
        showBillingPaywall(e.billing || null);
      } else {
        var errMsg = ((e && e.message) || e).toString();
        if (hint) hint.textContent = "批量启动失败：" + errMsg;
        showToast("批量启动失败：" + _diagnoseApiError(errMsg), "error");
      }
      mainTargets.forEach(function (t) { updateAssetCardImage(t.type, t.idx, "error"); });
      resolve({ done: 0, failed: mainTargets.length });
      });
    });
  }

/**
 * Phase 3-B-7：把 subscribeBatch 回调独立抽出来，让"刚发起的 batch"和"刷新
 * 后从 /api/batch/active 拿到的旧 batch"走同一条回调逻辑。
 *
 * 参数：
 *   batchId:       后端 batch_runner 的 id
 *   originId:      所属 project id（回调里用来判当前 project 是否还是这个）
 *   seqToTarget:   { seq -> {type, idx} }，供 onTaskStarted/Completed/Failed
 *                  从 targetSeq 反查 target。刚发起的 batch 直接从 POST 的
 *                  targets 数组按 index 构造；reattach 场景从 tasks[].extra
 *                  里还原（task_store register 时塞了 extra={target, options}）
 *   hint:          progress hint DOM（可为 null）
 *   totalTasks:    进度分母
 *   onFinish:      resolve 的 { done, failed }；可选
 *   initialDone / initialFailed: reattach 场景需要把"刷新前已完成的"计进来
 */
function _attachAssetImageBatch(opts) {
  var batchId = opts.batchId;
  var originId = opts.originId;
  var seqToTarget = opts.seqToTarget || {};
  var hint = opts.hint || null;
  var totalTasks = opts.totalTasks || 0;
  var onFinish = opts.onFinish || function () {};
  var doneCount = opts.initialDone || 0;
  var failCount = opts.initialFailed || 0;
  var settled = false;
  var pollTimer = null;
  // 同一批里多张图同时撞积分上限时，只弹一次付费墙。否则用户每张失败都被弹
  // 一次会很烦。批次结束时自动 reset。
  var creditPaywallShown = false;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function finish(res) {
    if (settled) return;
    settled = true;
    _stopPoll();
    checkAssetsConfirm();
    onFinish(res);
  }

  // 启动时刻 + 每张完成时间，用来动态算"平均 X 秒/张" → 估剩余时间
  var startTs = Date.now();
  function _refreshHint() {
    if (!hint) return;
    var done = doneCount;
    var fail = failCount;
    var pending = Math.max(0, totalTasks - done - fail);
    var parts = ["生成中… " + done + "/" + totalTasks];
    if (fail > 0) parts.push(fail + " 张失败");
    if (pending > 0) {
      // 已完成至少 1 张：用真实速度估剩余；否则给 35 秒/张的初始猜测
      var avgSec;
      if (done + fail >= 1) {
        avgSec = (Date.now() - startTs) / 1000 / (done + fail);
      } else {
        avgSec = 35;
      }
      // 并发 3 → 实际墙钟时间约为 pending × avgSec ÷ 3
      var remain = Math.ceil(pending * avgSec / 3);
      parts.push("约剩 " + remain + " 秒");
    }
    // 积分不足场景：所有 pending 都不会再跑（积分预扣环节失败），换一行更醒目的文案
    if (creditPaywallShown) {
      hint.textContent = "积分不足，剩余 " + (totalTasks - done) + " 张已停 — 请充值后重试（已成功 " + done + "/" + totalTasks + "）";
      hint.style.color = "#dc2626";
    } else {
      hint.textContent = parts.join("，");
      hint.style.color = "";
    }
  }
  // 给一个初始 hint，避免空白
  _refreshHint();

  // ====================================================================
  // 兜底轮询：每 5 秒主动 GET /api/batch/<id> 拿后端权威状态。
  // SSE 在某些环境下不稳定（开发热重载、浏览器后台节流、反代 buffer 等），
  // 轮询保证不管 SSE 通不通，UI 最终一定追得上。
  // 轮询发现 status=completed/failed/cancelled → 立即触发 onBatchCompleted
  // 流程（reload + rerender + finish），并停掉自身。
  // ====================================================================
  // 上一轮看到的 succeeded —— 只要数字涨了就触发"中途增量刷新"，不再傻等
  // 整个 batch 完成才显图。这是这次修 "读秒在动 / 图不显示 / 必须 F5" 的关键：
  // 当 SSE task_completed 因任何原因丢帧（dev server 缓冲、反向代理、浏览器
  // 后台节流），轮询是唯一能 catch 到的兜底；以前轮询只更新计数 hint，不刷
  // 新图，导致用户 9/15 但所有卡都还在转。
  var lastPolledSucceeded = -1;
  async function _pollOnce() {
    if (settled) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
      if (!snap || settled) return;
      // 用后端权威值修正本地计数（即便 SSE 帧全丢，hint 也会刷新）
      if (typeof snap.succeeded === "number" && snap.succeeded > doneCount) doneCount = snap.succeeded;
      if (typeof snap.failed === "number" && snap.failed > failCount) failCount = snap.failed;
      _refreshHint();

      var succeededNow = (typeof snap.succeeded === "number") ? snap.succeeded : 0;
      var statusTerminal = (
        snap.status === "completed" ||
        snap.status === "failed" ||
        snap.status === "cancelled" ||
        snap.status === "partial"
      );

      // 中途增量刷新：只要新增完成的任务 ≥ 1 张，就 reload 一次 project 把
      // DB 里已落盘的图同步到内存，再优先只同步完成卡片，避免整页重建闪屏。
      // 这一段独立于"终态分支"——避免必须等所有 15 张全完成才看到前 9 张。
      if (succeededNow > lastPolledSucceeded && lastPolledSucceeded >= 0 && !statusTerminal) {
        console.log("[AssetImg] poll detected new succeeded " + lastPolledSucceeded + " → " + succeededNow + " — incremental reload");
        try {
          if (_ctx.reloadProjectFromServer) {
            var ok = await _ctx.reloadProjectFromServer();
            if (ok) {
              try {
                if (!_syncGeneratedAssetCardsFromProject()) renderAssets();
              } catch (e2) { console.warn("[AssetImg] incremental card sync failed:", e2); }
            }
          }
        } catch (e) { console.warn("[AssetImg] incremental reload failed:", e); }
      }
      lastPolledSucceeded = succeededNow;

      if (statusTerminal) {
        console.log("[AssetImg] poll detected batch finished status=" + snap.status + " — triggering safety net");
        try {
          if (_ctx.reloadProjectFromServer) await _ctx.reloadProjectFromServer();
        } catch (e) { console.warn("[AssetImg] reload after poll failed:", e); }
        try { renderAssets(); } catch (_) {}
        finish({ done: doneCount, failed: failCount });
      }
    } catch (e) {
      // 轮询失败不致命，下一轮重试
      console.warn("[AssetImg] poll failed:", (e && e.message) || e);
    }
  }
  // 3s 间隔：图像生成单张 30-60s，3s 轮询比 5s 更早看到新完成的图，开销可忽略
  pollTimer = setInterval(_pollOnce, 3000);
  // 立即跑一次，捕捉"刚发起 batch 时已有缓存图秒回"这种情况（不必等 3s）
  setTimeout(_pollOnce, 500);

  subscribeBatch(batchId, {
    onSnapshot: function (snap) {
      if (snap && typeof snap.total === "number") {
        // snapshot 里 succeeded/failed 是后端权威值，refresh 用它修正本地计数
        if (typeof snap.succeeded === "number") doneCount = Math.max(doneCount, snap.succeeded);
        if (typeof snap.failed === "number") failCount = Math.max(failCount, snap.failed);
      }
      _refreshHint();
    },
    onTaskStarted: function (data) {
      var tgt = (data && data.target) || seqToTarget[data.targetSeq] || {};
      if (tgt.type && typeof tgt.idx === "number") {
        updateAssetCardImage(tgt.type, tgt.idx, "loading", null, "生成中…");
      }
    },
    onTaskCompleted: function (data) {
      var extra = (data && data.extra) || {};
      var patch = (data && data.patch) || {};
      var tgt = seqToTarget[data.targetSeq] || { type: extra.type, idx: extra.idx };
      // patch.cat ('characters'/'scenes'/'props') → type ('char'/'scene'/'prop') 兜底
      if (!tgt.type && patch.cat) {
        var cat2type = { characters: "char", scenes: "scene", props: "prop" };
        tgt.type = cat2type[patch.cat];
      }
      if (!tgt.type && patch.type === "asset_image" && patch.cat) {
        var cat2type2 = { characters: "char", scenes: "scene", props: "prop" };
        tgt.type = cat2type2[patch.cat];
      }
      if (typeof tgt.idx !== "number" && typeof patch.idx === "number") tgt.idx = patch.idx;
      var type = tgt.type;
      var idx = tgt.idx;
      var url = extra.rawUrl || patch.value || patch.imageUrl || "";
      console.log("[AssetImg] task_completed seq=" + data.targetSeq + " type=" + type + " idx=" + idx + " url=" + (url || "<empty>").slice(0, 60) + " hasExtra=" + Object.keys(extra).join(","));
      if (type === "char" && typeof idx === "number" && extra.referenceStatus === "failed") {
        failCount++;
        var failedAttemptUrl = extra.lastAttemptUrl || "";
        var isFailedCurrent = _ctx.safeWriteBack(originId, function (proj) {
          if (!proj.assets) proj.assets = {};
          if (!proj.assets.characters) proj.assets.characters = [];
          var item = proj.assets.characters[idx];
          if (!item) return;
          item.reference = Object.assign({}, item.reference || {}, {
            status: "failed",
            updatedAt: new Date().toISOString(),
            styleBibleSignature: extra.styleBibleSignature,
            styleLockVersion: extra.styleLockVersion,
            resolvedBackdropColor: extra.resolvedBackdropColor,
            lastAttemptUrl: failedAttemptUrl,
            lastFailedAt: new Date().toISOString(),
            lastError: extra.lastError || { reason: "character_panel_split_failed", message: extra.panelsError || "" }
          });
          item.panelsError = extra.panelsError || "character_panel_split_failed";
          item.panelsErrorAt = item.reference.lastFailedAt;
          if (proj._staleFlags) delete proj._staleFlags["asset_img_char_" + idx];
        }, data && data.serverVersion);
        console.warn("[AssetImg] character reference rejected by panel split; keeping downstream URLs unchanged", extra.lastError || extra.panelsError || "");
        if (isFailedCurrent) {
          updateAssetCardImage(type, idx, "error");
          renderAssets();
        }
        _refreshHint();
        return;
      }
      if (!type || typeof idx !== "number" || !url) {
        // SSE 帧缺信息：图已落盘但 UI 收不到必要字段。改成主动从 server 拉一次
        // project，让当前还在 loading 的卡片按权威数据补图——而不是默默吞掉等用户 F5。
        console.warn("[AssetImg] task_completed missing target/url — pulling project from server to recover", data);
        doneCount++;
        if (_ctx.reloadProjectFromServer) {
          _ctx.reloadProjectFromServer().then(function (ok) {
            if (ok) {
              try {
                if (!_syncGeneratedAssetCardsFromProject()) renderAssets();
              } catch (e) { console.warn("[AssetImg] renderAssets after recovery failed:", e); }
            }
          }).catch(function (e) { console.warn("[AssetImg] recovery reload failed:", e); });
        }
        _refreshHint();
        return;
      }
      doneCount++;

      // 展示 URL 优先用 pencilUrl（角色最终态）
      var pencilUrl = (type === "char" ? (extra.pencilUrl || "") : "");
      var displayUrl = pencilUrl || url;

      var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
        var cat = type === "char" ? "characters" : type === "scene" ? "scenes" : "props";
        if (!proj.assets) proj.assets = {};
        if (!proj.assets[cat]) proj.assets[cat] = [];
        var item = proj.assets[cat][idx];
        if (!item) return;
        // 后端 asset_images executor 现在会归档旧图进 imageHistory；
        // 如果 polling 已经把新版（含归档）拉回内存，item.imageUrl 已经是 displayUrl，
        // 再调一次 archiveOldImage 会把"新 URL"也塞进 history（错）。
        // 用 URL 比对识别这种情况就跳过前端归档。
        var alreadySynced = (item.imageUrl === displayUrl) && (item.rawUrl === url);
        if (!alreadySynced) {
          _ctx.archiveOldImage(item, type === "char" ? "character" : type);
        }
        if (type === "char") {
          item.realPhotoUrl = url;
          if (pencilUrl) {
            item.pencilUrl = pencilUrl;
            if (extra.skippedStylize) item.skippedStylize = true;
            if (item._pencilFailed) delete item._pencilFailed;
          }
        }
        item.imageUrl = displayUrl;
        item.rawUrl = url;
        item.reference = Object.assign({}, item.reference || {}, {
          currentUrl: displayUrl,
          lastKnownGoodUrl: displayUrl,
          status: extra.referenceStatus || "ready",
          updatedAt: new Date().toISOString(),
          styleBibleSignature: extra.styleBibleSignature,
          styleLockVersion: extra.styleLockVersion,
          resolvedBackdropColor: extra.resolvedBackdropColor
        });
        if (extra.assetId) item.assetId = extra.assetId;
        if (extra.fetchStatus) item.fetchStatus = extra.fetchStatus;
        delete item.imageLastError;
        delete item.imageFailedAt;
        if (item.reference) {
          delete item.reference.lastError;
          delete item.reference.lastAttemptUrl;
          delete item.reference.lastFailedAt;
        }
        delete item.panelsError;
        delete item.panelsErrorAt;
        if (proj._staleFlags) delete proj._staleFlags["asset_img_" + type + "_" + idx];
      }, data && data.serverVersion);

      console.log("[AssetImg] writeback isCurrent=" + isCurrent + " displayUrl=" + (displayUrl || "").slice(0, 60));
      if (isCurrent) updateAssetCardImage(type, idx, "done", displayUrl);
      _refreshHint();
    },
    onTaskFailed: function (data) {
      failCount++;
      var extra = (data && data.extra) || {};
      var tgt = seqToTarget[data.targetSeq] || { type: extra.type, idx: extra.idx };
      var type = tgt.type;
      var idx = tgt.idx;
      var err = (data && data.errorMsg) || "生成失败";
      console.error("[AssetImg] task_failed:", type, idx, err);
      if (type && typeof idx === "number") {
        _markAssetImageFailedLocally(originId, type, idx, err, extra, data && data.serverVersion);
        updateAssetCardImage(type, idx, "error");
      }
      // 积分不足专门处理：弹一次付费墙、把 hint 改成醒目的提示，避免用户
      // 误以为是 bug 反复点"重新生成"。errorCode 由 batches.ts 的 _emit
      // task_failed 帧塞过来；老格式里只有中文 errorMsg，所以两条都判。
      var isCreditError = (data && data.errorCode === 'INSUFFICIENT_CREDITS')
        || /积分不足|insufficient/i.test(err);
      if (isCreditError && !creditPaywallShown) {
        creditPaywallShown = true;
        try { showBillingPaywall((data && data.billing) || null); } catch (_) {}
        try { showToast("积分不足，剩余 " + Math.max(0, totalTasks - doneCount - failCount) + " 张未生成 — 充值后可继续", "error"); } catch (_) {}
      }
      _refreshHint();
    },
    onBatchCompleted: async function () {
      console.log("[AssetImg] batch_completed → safety-net: reloading project from server");
      // 安全网：批次完成后从服务端整包拉一次项目数据，把 in-memory 替换掉。
      // 这样即便单条 task_completed SSE 帧因任何原因丢失，最终 UI 也一定会
      // 反映服务器真实状态（图都已经落到 DB 上了）。等于"自动帮用户按 F5"。
      try {
        if (_ctx.reloadProjectFromServer) {
          var ok = await _ctx.reloadProjectFromServer();
          console.log("[AssetImg] reloadProjectFromServer ok=" + ok);
        }
      } catch (e) {
        console.warn("[AssetImg] reloadProjectFromServer failed:", e);
      }
      // 安全网渲染：不管之前 task_completed 有没有走完，到这里把三个 grid
      // 全部按服务端权威数据重渲一次
      try { renderAssets(); } catch (e) { console.warn("[AssetImg] renderAssets after reload failed:", e); }
      finish({ done: doneCount, failed: failCount });
    },
    onClose: function () {
      if (pollTimer) {
        console.warn("[AssetImg] SSE closed; polling fallback remains active");
        _refreshHint();
      }
    },
    });
  }

/**
 * Phase 3-B-7 · 刷新后重连活跃 batch。
 *
 * 时机：`loadProjectData` 完成后调一次。拿到的是后端 batch_runner 内存里
 * 这个用户 + 这个项目下所有"未完成"的 batch 列表，以及每个 batch 的
 * `tasks[]` 数组（含 status / target_type / target_idx / extra）。
 *
 * 对资产图 batch（batchType 为 `asset_images` / `asset_stylize`）：
 *   1. 把 tasks 里 status=pending/running 的 target 拿出来置 `_assetGenStatus=loading`
 *      （**权威源**——不再信 project._generatingAssets 这种本地副本）
 *   2. 用 `_attachAssetImageBatch` 续挂 SSE 回调，继续看进度和完成事件
 *
 * 失败降级：接口挂了或没有 active batch → 默默返回，走 `_restoreAssetGenStatus`
 * 里的 orphan 兜底（处理 realPhotoUrl 没 pencilUrl 之类的历史碎片）。
 */
export async function reattachActiveBatches(originId) {
  if (!originId) return { reattached: 0 };
  var data;
  try {
    data = await getActiveBatchesShared(originId);
  } catch (e) {
    console.warn("[Reattach] /api/batch/active failed:", (e && e.message) || e);
    return { reattached: 0, err: e };
  }
  var batches = (data && data.batches) || [];
  if (!batches.length) return { reattached: 0 };

  var reattachedCount = 0;
  batches.forEach(function (b) {
    var bt = b.batchType || "";

    // Phase 5.13：shots 任务也走 batch_runner 了。刷新 / 关 tab 回来后
    // 发现后台还有 shots 在跑就直接调 shots.js 的 attachShotsBatch，
    // 由它重挂 SSE 订阅、驱动镜头页进度条。
    if (bt === "shots") {
      var shotBatchStatus = b.status || (b.snapshot && b.snapshot.status) || "";
      if (shotBatchStatus !== "queued" && shotBatchStatus !== "running") return;
      try { attachShotsBatch(b.batchId); }
      catch (e) { console.warn("[Reattach] attachShotsBatch failed:", e); }
      reattachedCount++;
      return;
    }

    if (bt === "storyboard_images" || bt === "storyboard_prompts") {
      reattachedCount++;
      return;
    }

    if (bt !== "asset_images" && bt !== "asset_stylize") {
      return;
    }
    var tasks = b.tasks || [];
    var seqToTarget = {};
    var initialDone = 0;
    var initialFailed = 0;
    tasks.forEach(function (t) {
      var seq = (typeof t.batch_seq === "number") ? t.batch_seq : 0;
      var target = (t.extra && t.extra.target) || {
        type: t.target_type, idx: t.target_idx,
      };
      seqToTarget[seq] = target;

      var status = String(t.status || "").toLowerCase();
      if (status === "succeeded" || status === "done") {
        initialDone++;
      } else if (status === "failed" || status === "error") {
        initialFailed++;
        if (target.type && typeof target.idx === "number") {
          updateAssetCardImage(target.type, target.idx, "error");
        }
      } else if (status === "running" || status === "pending" || status === "polling") {
        if (target.type && typeof target.idx === "number") {
          _assetGenStatus[target.type + "_" + target.idx] = "loading";
          updateAssetCardImage(target.type, target.idx, "loading", null,
            bt === "asset_stylize" ? "风格化中…" : "生成中…");
        }
      }
    });

    if (bt === "asset_images") {
      _attachAssetImageBatch({
        batchId: b.batchId,
        originId: originId,
        seqToTarget: seqToTarget,
        hint: $("assetImgHint"),
        totalTasks: tasks.length,
        initialDone: initialDone,
        initialFailed: initialFailed,
        onFinish: function () { _updateStylizeBadge(); },
      });
      reattachedCount++;
    } else if (bt === "asset_stylize") {
      // 转绘 batch 的回调复用 `_runStylizeBatch` 的写回逻辑。这里走一个
      // 最小兼容：直接 subscribeBatch，等 task_completed 时触发
      // `_safeWriteBack` 把 pencilUrl 写回。完整复用抽函数留到后续 phase。
      _attachStylizeBatchForReattach({
        batchId: b.batchId,
        originId: originId,
        seqToTarget: seqToTarget,
        tasks: tasks,
      });
      reattachedCount++;
    }
  });

  console.log("[Reattach] reattached " + reattachedCount + " asset batches for " + originId);
  return { reattached: reattachedCount };
}

/**
 * 最小化的转绘 batch 重连回调——只负责把 task_completed/failed 的结果写回
 * project.json（UI 乐观更新）和清 badge。完整抽取留到 Phase 3-B-8 或 5。
 */
function _attachStylizeBatchForReattach(opts) {
  var batchId = opts.batchId;
  var originId = opts.originId;
  var seqToTarget = opts.seqToTarget || {};
  var tasks = opts.tasks || [];

  // 重建 badge：运行中的 char 进 _backgroundStylizeTasks
  tasks.forEach(function (t) {
    var seq = (typeof t.batch_seq === "number") ? t.batch_seq : 0;
    var target = (t.extra && t.extra.target) || {
      type: t.target_type, idx: t.target_idx,
    };
    if (target.type !== "char") return;
    var status = String(t.status || "").toLowerCase();
    if (status === "running" || status === "pending" || status === "polling") {
      if (!_backgroundStylizeTasks.has(target.idx)) {
        _backgroundStylizeTasks.set(target.idx, {
          charIdx: target.idx,
          charName: "角色#" + target.idx,
          taskId: t.task_id,
          status: status === "running" ? "running" : "submitting",
          startedAt: Date.now(),
        });
      }
    }
  });
  _updateStylizeBadge();

  subscribeBatch(batchId, {
    onTaskCompleted: function (data) {
      var extra = (data && data.extra) || {};
      var tgt = seqToTarget[data.targetSeq] || { type: extra.type, idx: extra.idx };
      if (tgt.type !== "char" || typeof tgt.idx !== "number") return;
      var idx = tgt.idx;
      if (extra.skippedReason === 'anonymous_crowd_no_stylize') {
        _backgroundStylizeTasks.delete(idx);
        _updateStylizeBadge();
        return;
      }
      var url = extra.pencilUrl || extra.rawUrl || "";
      if (!url) return;
      _ctx.safeWriteBack(originId, function (proj) {
        var item = proj.assets && proj.assets.characters && proj.assets.characters[idx];
        if (!item) return;
        _ctx.archiveOldImage(item, "stylize");
        item.pencilUrl = url;
        item.imageUrl = url;
        if (extra.skippedStylize) item.skippedStylize = true;
        if (item._pencilFailed) delete item._pencilFailed;
      }, data && data.serverVersion);
      _backgroundStylizeTasks.delete(idx);
      _updateStylizeBadge();
    },
    onTaskFailed: function (data) {
      var extra = (data && data.extra) || {};
      var tgt = seqToTarget[data.targetSeq] || { type: extra.type, idx: extra.idx };
      if (tgt.type !== "char" || typeof tgt.idx !== "number") return;
      _ctx.safeWriteBack(originId, function (proj) {
        var item = proj.assets && proj.assets.characters && proj.assets.characters[tgt.idx];
        if (item) item._pencilFailed = true;
      });
      _backgroundStylizeTasks.delete(tgt.idx);
      _updateStylizeBadge();
    },
    onBatchCompleted: function () {
      _updateStylizeBadge();
    },
    onClose: function () {
      _updateStylizeBadge();
    },
  });
}

/**
 * Phase 3-B-5 · 角色彩铅化（Step 2）走后端 batch_runner。
 *
 * 输入：targets = [{ idx, charName }]（**只接 human 角色**，non-human 由 caller
 * 自己走本地 fast-path，避免一次无意义的 batch 往返）。
 *
 * 流程：
 *   1. 把 idx 全部注册进 `_backgroundStylizeTasks` → badge "风格图补全中 N/M"
 *   2. /api/batch/start batchType=asset_stylize targets=[{type:"char", idx}]
 *   3. subscribeBatch：
 *      - onTaskStarted：meta.status → running
 *      - onTaskCompleted：safeWriteBack 写 pencilUrl（或 non-human 的
 *        imageUrl=realPhotoUrl），清 _pencilFailed，从 Map 移除
 *      - onTaskFailed：safeWriteBack 标 _pencilFailed=true，从 Map 移除
 *      - onBatchCompleted / onClose：resolve 并刷 badge
 *
 * 返回 Promise<{ done, failed }>。
 */
function _runStylizeBatch(originId, targets) {
  if (!targets || !targets.length) return Promise.resolve({ done: 0, failed: 0 });

  var seqToTarget = {};
  targets.forEach(function (t, seq) { seqToTarget[seq] = t; });

  targets.forEach(function (t) {
    _backgroundStylizeTasks.set(t.idx, {
      charIdx: t.idx,
      charName: t.charName || ("角色#" + t.idx),
      taskId: null,
      status: "submitting",
      startedAt: Date.now(),
        });
      });
  _updateStylizeBadge();

  return new Promise(function (resolve) {
    var doneCount = 0;
    var failCount = 0;
    var settled = false;
    function finish(res) {
      if (settled) return;
      settled = true;
      // 兜底：尚未收到终态的 idx 从 Map 里清掉，避免 badge 僵住
      targets.forEach(function (t) {
        if (_backgroundStylizeTasks.has(t.idx)) _backgroundStylizeTasks.delete(t.idx);
      });
      _updateStylizeBadge();
      resolve(res);
    }

    var batchTargets = targets.map(function (t) { return { type: "char", idx: t.idx }; });

    apiPost("/api/batch/start", {
      batchType: "asset_stylize",
      projectId: originId,
      targets: batchTargets,
      options: {},
    }).then(function (startResp) {
      if (!startResp || !startResp.batchId) {
        var errMsg = (startResp && startResp.error) || "未能创建彩铅转绘批量任务";
        console.warn("[BgStylize] batch start failed:", errMsg);
        targets.forEach(function (t) {
          var idx = t.idx;
          _ctx.safeWriteBack(originId, function (proj) {
            if (proj.assets && proj.assets.characters && proj.assets.characters[idx]) {
              proj.assets.characters[idx]._pencilFailed = true;
            }
          });
        });
        finish({ done: 0, failed: targets.length });
        return;
      }

      subscribeBatch(startResp.batchId, {
        onTaskStarted: function (data) {
          var seq = (data && data.targetSeq) || 0;
          var t = seqToTarget[seq];
          if (!t) return;
          var meta = _backgroundStylizeTasks.get(t.idx);
          if (meta) {
            meta.status = "running";
            meta.taskId = (data && data.taskId) || meta.taskId;
            _backgroundStylizeTasks.set(t.idx, meta);
          }
          _updateStylizeBadge();
        },
        onTaskCompleted: function (data) {
          var extra = (data && data.extra) || {};
          var patch = (data && data.patch) || {};
          var seq = (data && data.targetSeq) || 0;
          var t = seqToTarget[seq] || { idx: extra.idx };
          var idx = (typeof t.idx === "number") ? t.idx : extra.idx;
          var pencilUrl = extra.imageUrl || patch.value || "";
          if (typeof idx !== "number" || !pencilUrl) {
            console.warn("[BgStylize] task_completed missing idx/url:", data);
            failCount++;
            if (typeof idx === "number") _backgroundStylizeTasks.delete(idx);
            _updateStylizeBadge();
            return;
          }
          doneCount++;
          _ctx.safeWriteBack(originId, function (proj) {
            if (proj.assets && proj.assets.characters && proj.assets.characters[idx]) {
              _ctx.archiveOldImage(proj.assets.characters[idx], "stylize");
              proj.assets.characters[idx].pencilUrl = pencilUrl;
              delete proj.assets.characters[idx]._pencilFailed;
            }
          }, data && data.serverVersion);
          // 同步当前 in-memory project（不经 safeWriteBack 的路径）
          if (project && project.id === originId
            && project.assets && project.assets.characters && project.assets.characters[idx]) {
            project.assets.characters[idx].pencilUrl = pencilUrl;
            delete project.assets.characters[idx]._pencilFailed;
          }
          _backgroundStylizeTasks.delete(idx);
          _updateStylizeBadge();
          console.log("[BgStylize] char#" + idx + " done, pencilUrl=" + String(pencilUrl).slice(0, 80));
        },
        onTaskFailed: function (data) {
          failCount++;
          var extra = (data && data.extra) || {};
          var seq = (data && data.targetSeq) || 0;
          var t = seqToTarget[seq] || { idx: extra.idx };
          var idx = (typeof t.idx === "number") ? t.idx : extra.idx;
          var err = (data && data.errorMsg) || "彩铅转绘失败";
          console.warn("[BgStylize] char#" + idx + " failed:", err);
          if (typeof idx === "number") {
            _ctx.safeWriteBack(originId, function (proj) {
              if (proj.assets && proj.assets.characters && proj.assets.characters[idx]) {
                proj.assets.characters[idx]._pencilFailed = true;
              }
            });
            if (project && project.id === originId
              && project.assets && project.assets.characters && project.assets.characters[idx]) {
              project.assets.characters[idx]._pencilFailed = true;
            }
            _backgroundStylizeTasks.delete(idx);
          }
          _updateStylizeBadge();
        },
        onBatchCompleted: function () { finish({ done: doneCount, failed: failCount }); },
        onClose: function () { finish({ done: doneCount, failed: failCount }); },
      });
    }).catch(function (e) {
      console.error("[BgStylize] /api/batch/start failed:", e);
      targets.forEach(function (t) {
        var idx = t.idx;
        _ctx.safeWriteBack(originId, function (proj) {
          if (proj.assets && proj.assets.characters && proj.assets.characters[idx]) {
            proj.assets.characters[idx]._pencilFailed = true;
          }
    });
  });
      finish({ done: 0, failed: targets.length });
    });
  });
}

function _assetItemsForConfirm() {
  if (!project || !project.assets) return [];
  var assets = project.assets;
  return []
    .concat((assets.characters || []).map(function (item) { return { type: "char", item: item }; }))
    .concat((assets.scenes || []).map(function (item) { return { type: "scene", item: item }; }))
    .concat((assets.props || []).map(function (item) { return { type: "prop", item: item }; }));
}

function _assetHasGeneratedReference(type, item) {
  if (!item) return false;
  var reference = item.reference && typeof item.reference === "object" ? item.reference : {};
  var panels = item.panels && typeof item.panels === "object" ? item.panels : {};
  if (type === "char" && reference.status === "failed") return false;
  return !!_firstAssetUrl(
    item.imageUrl,
    item.rawUrl,
    item.realPhotoUrl,
    item.pencilUrl,
    reference.currentUrl,
    reference.lastKnownGoodUrl,
    item.referenceLock && item.referenceLock.sheetUrl,
    panels.sheetUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
  );
}

function _assetImageAttemptFinished(item) {
  if (!item) return false;
  var reference = item.reference && typeof item.reference === "object" ? item.reference : {};
  var referenceStatus = String(reference.status || "").toLowerCase();
  return !!(
    item.imageFailedAt ||
    item.imageGeneratedAt ||
    reference.lastFailedAt ||
    reference.lastError ||
    referenceStatus === "failed"
  );
}

function _assetImagesReadyForConfirm() {
  if (_assetsExtracting || _assetImagesGenerating || Object.keys(_assetGenStatus).length > 0) return false;
  var items = _assetItemsForConfirm();
  if (!items.length) return false;
  var hasTerminalAssetImage = false;
  var hasPendingAssetImage = false;
  items.forEach(function (entry) {
    var item = entry.item || {};
    if (_assetHasGeneratedReference(entry.type, item) || _assetImageAttemptFinished(item)) {
      hasTerminalAssetImage = true;
      return;
    }
    if (item.imagePrompt || item.submittedImagePrompt || item.effectiveVisualDescription) {
      hasPendingAssetImage = true;
    }
  });
  return hasTerminalAssetImage && !hasPendingAssetImage;
}

export function checkAssetsConfirm() {
  var area = $("assetsConfirmArea");
  var topBtn = $("btnConfirmAssetsTop");
  var saveTplBtn = $("btnSaveWorldTemplate");
  _refreshWorldKnowledgeButtons();
  if (!area || !project || !project.assets) {
    if (area) area.hidden = true;
    if (topBtn) topBtn.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    return;
  }
  var hasAssets = _assetItemsForConfirm().length > 0;
  var canConfirm = _assetImagesReadyForConfirm();
  area.hidden = !canConfirm;
  if (topBtn) topBtn.hidden = !hasAssets;
  if (saveTplBtn) saveTplBtn.hidden = !hasAssets;
}

// 资产确认后跳分镜页时，如果项目还没生成过镜头计划，自动跑一次 generateShots()。
// 行为对齐 _confirmStyleAndContinue 的 "确认风格 → 跳资产页 → 自动 extractAssets"，
// 让 风格→资产→分镜 三步流水线在用户视角下连贯衔接，不必每页都手动再点一下生成。
// 用 300ms 延迟是为了等 switchPage 完成 DOM 切换、refreshShotsPage 把 #shotsReady
// 显示出来后再启动，避免生成中态的进度条 UI 还没挂上就被 generateShots 写入。
function _autoStartShotPlanAfterAssetConfirm() {
  var originId = project && project.id;
  setTimeout(function () {
    if (!_ctx || typeof _ctx.generateShots !== "function") return;
    // 项目被切走了 / 用户又跳回别的页面就不要触发，避免串项目或在错误页面打扰。
    if (!project || project.id !== originId) return;
    if (Array.isArray(project.shots) && project.shots.length > 0) return;
    try { _ctx.generateShots(); } catch (e) { console.warn("[ConfirmAssets] auto generateShots failed:", e); }
  }, 300);
}

export function confirmAssets() {
  if (!project || !project.assets) { showToast("请先分析资产", "warn"); return; }

  var chars = project.assets.characters || [];
  var hasStyleReference = function (c) {
    return !!(
      c.pencilUrl || c.imageUrl || c.rawUrl || c.realPhotoUrl ||
      (c.reference && (c.reference.currentUrl || c.reference.lastKnownGoodUrl)) ||
      (c.referenceLock && c.referenceLock.sheetUrl) ||
      (c.panels && (c.panels.sheetUrl || c.panels.frontUrl || c.panels.sideUrl || c.panels.backUrl))
    );
  };
  var missingPencil = [];
  for (var ci = 0; ci < chars.length; ci++) {
    if (!hasStyleReference(chars[ci])) {
      missingPencil.push(chars[ci].name || "角色 #" + (ci + 1));
    }
  }
  if (missingPencil.length > 0) {
    var names = missingPencil.slice(0, 5).join("、");
    if (missingPencil.length > 5) names += " 等";
    showConfirm(
      "缺少风格参考图",
      missingPencil.length + " 个角色缺少风格参考图（" + names + "），风格参考图在后续视频生成环节需要使用。\n\n确定：进入下一步（可稍后补生成）。取消：留在本页。",
      function () {
        project.assetsApproved = true;
        project.currentStep = Math.max(project.currentStep, 3);
        _saveAssetsProject();
        _ctx.checkAndSuggest("assetConfirm");
        _ctx.switchPage("shots");
        _autoStartShotPlanAfterAssetConfirm();
      }
    );
    return;
  }

  project.assetsApproved = true;
  project.currentStep = Math.max(project.currentStep, 3);
  _saveAssetsProject();
  _ctx.checkAndSuggest("assetConfirm");
  _ctx.switchPage("shots");
  _autoStartShotPlanAfterAssetConfirm();
}

export function handleAssetAction(e) {
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;

  if (action === "zoom-img") {
    var imgUrl = btn.dataset.img;
    var originalUrl = btn.dataset.originalImg || "";
    if (imgUrl) _openLightbox(imgUrl, "", originalUrl);
    return;
  }

  var card = btn.closest("[data-type]");
  if (!card) return;
  var type = card.dataset.type;
  var idx = parseInt(card.dataset.idx, 10);
  var list = type === "char" ? project.assets.characters : type === "scene" ? project.assets.scenes : project.assets.props;
  var item = list[idx];
  if (!item) return;

  if (action === "ref-agent") {
    var typeLabel = type === "char" ? "角色" : type === "scene" ? "场景" : "道具";
    _ctx.agentInsertRef(typeLabel, item.name || "#" + (idx + 1), { assetType: type, assetIdx: idx });
    return;
  }

  if (action === "char-menu") {
    _showCharMenu(btn, type, idx);
    return;
  }

  if (action === "scene-more") {
    if (type === "scene") _showSceneMenu(btn, idx);
    return;
  }

  if (action === "prop-more") {
    if (type === "prop") _showPropMenu(btn, idx);
    return;
  }

  // 场景卡描述「就地编辑」快捷入口：点描述文字直接改，铅笔按钮仍走弹窗。
  if (action === "edit-scene-desc") {
    if (type !== "scene") return;
    var swrap = card.querySelector(".asset-desc-wrap");
    if (!swrap) return;
    var stext = swrap.querySelector(".asset-desc-text");
    var sedit = swrap.querySelector(".asset-desc-edit");
    if (!stext || !sedit) return;
    if (sedit.classList.contains("hidden")) {
      var _sDescOrig = item.description || "";
      sedit.value = _sDescOrig;
      stext.classList.add("hidden");
      sedit.classList.remove("hidden");
      sedit.focus();
      sedit.onblur = function () {
        var nv = sedit.value.trim();
        sedit.classList.add("hidden");
        stext.classList.remove("hidden");
        if (nv === _sDescOrig) return;
        item.description = nv;
        if (project.environments && project.environments[idx]) project.environments[idx].description = nv;
        item._descEdited = true;
        _ctx.markDownstreamStale("asset", { type: "scene", idx: idx, name: item.name || "" });
        _saveAssetsProject();
        stext.textContent = nv || "暂无场景描述";
        _autoSyncUpstream("scene", idx);
      };
    }
    return;
  }

  if (action === "show-history") {
    _ctx.openHistoryPopover(btn, item, function (hi) {
      if (_ctx.setHistoryAsCurrent(item, hi)) {
        _saveAssetsProject();
        refreshAssetsPage();
        showToast("已恢复到历史版本", "ok");
      }
    });
    return;
  }

  if (action === "regen-asset") {
    if (_assetImagesGenerating) { showToast("正在批量生成中", "warn"); return; }
    generateSingleAssetImage(type, idx);
  } else if (action === "edit-asset") {
    if (type === "scene") {
      _openSceneAssetEditor(btn, item, idx);
      return;
    }
    var wrap = card.querySelector(".asset-desc-wrap");
    if (!wrap) return;
    var textEl = wrap.querySelector(".asset-desc-text");
    var editEl = wrap.querySelector(".asset-desc-edit");
    if (!textEl || !editEl) return;

    if (editEl.classList.contains("hidden")) {
      var fullDesc;
      if (type === "char") {
        var parts = [];
        if (item.appearance) parts.push(item.appearance);
        if (item.clothing) parts.push(item.clothing);
        if (item.equipment) parts.push(item.equipment);
        fullDesc = parts.join(' | ');
      } else if (type === "prop") {
        var pparts = [];
        if (item.features) pparts.push(item.features);
        if (item.material) pparts.push(item.material);
        fullDesc = pparts.join(' | ');
      } else {
        fullDesc = item.description || '';
      }
      var _originalDesc = fullDesc;
      editEl.value = fullDesc;
      textEl.classList.add("hidden");
      editEl.classList.remove("hidden");
      editEl.focus();
      editEl.onblur = function () {
        var newVal = editEl.value.trim();
        editEl.classList.add("hidden");
        textEl.classList.remove("hidden");
        if (newVal === _originalDesc) return;
        if (type === "char") {
          var segments = newVal.split(/\s*\|\s*/);
          item.appearance = segments[0] || '';
          item.clothing = segments[1] || '';
          item.equipment = segments[2] || '';
        } else if (type === "prop") {
          var psegs = newVal.split(/\s*\|\s*/);
          item.features = psegs[0] || '';
          item.material = psegs[1] || '';
        } else {
          item.description = newVal;
        }
        item._descEdited = true;
        _ctx.markDownstreamStale("asset", { type: type, idx: idx, name: item.name || "" });
        _saveAssetsProject();
        textEl.textContent = newVal;
        _autoSyncUpstream(type, idx);
      };
    }
  } else if (action === "edit-char-mode") {
    if (type !== "char") return;
    var curVia = item.via || '';
    showPrompt({
      title: "修改出现方式",
      message: "回忆 / 照片 / 梦境 / 通缉令 / 电话那头 / 别人的讲述 等。\n留空则改回「当下活动角色」。",
      defaultValue: curVia,
      placeholder: "例：回忆",
      icon: "auto_stories",
      okText: "好",
      hideCancel: true,
      commitOnDismiss: true,
    }).then(function (newVia) {
      if (newVia === null) return;
      newVia = newVia.trim();
      if (newVia === (item.via || '')) return;
      if (newVia) {
        item.appearanceMode = 'referenced';
        item.via = newVia;
      } else {
        item.appearanceMode = 'main';
        delete item.via;
      }
      _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
      _saveAssetsProject();
      renderAssetsUI();
      showToast("出现方式已更新", "ok");
    });
  } else if (action === "edit-char-crowd") {
    if (type !== "char") return;
    var curSize = item.crowdSize || '';
    showPrompt({
      title: "修改群体规模",
      message: "如：三四个 / 一队（十几人） / 成群。\n留空则改回「单人角色」。",
      defaultValue: curSize,
      placeholder: "例：三四个",
      icon: "groups",
      okText: "好",
      hideCancel: true,
      commitOnDismiss: true,
    }).then(function (newSize) {
      if (newSize === null) return;
      newSize = newSize.trim();
      if (newSize === (item.crowdSize || '')) return;
      if (newSize) {
        item.isCrowd = true;
        item.crowdSize = newSize;
      } else {
        item.isCrowd = false;
        delete item.crowdSize;
      }
      _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
      _saveAssetsProject();
      renderAssetsUI();
      showToast("群体规模已更新", "ok");
    });
  } else if (action === "add-char-tag") {
    if (type !== "char") return;
    var choice = prompt("添加哪类标签？\n  1 = 非当下角色（回忆/照片/梦境等）\n  2 = 群体角色（群演）\n输入 1 或 2：");
    if (choice === null) return;
    choice = (choice || '').trim();
    if (choice === "1") {
      var viaAdd = prompt("通过什么方式出现？（如：回忆/照片/梦境/通缉令/电话那头/别人的讲述）", "");
      if (viaAdd === null) return;
      viaAdd = viaAdd.trim();
      if (!viaAdd) { showToast("已取消", "warn"); return; }
      item.appearanceMode = 'referenced';
      item.via = viaAdd;
      _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
      _saveAssetsProject();
      renderAssetsUI();
      showToast("已标注为非当下角色", "ok");
    } else if (choice === "2") {
      var sizeAdd = prompt("群体规模（如：三四个 / 一队（十几人） / 成群）", "");
      if (sizeAdd === null) return;
      sizeAdd = sizeAdd.trim();
      if (!sizeAdd) { showToast("已取消", "warn"); return; }
      item.isCrowd = true;
      item.crowdSize = sizeAdd;
      _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
      _saveAssetsProject();
      renderAssetsUI();
      showToast("已标注为群体角色", "ok");
    }
  } else if (action === "edit-prop-carries") {
    if (type !== "prop") return;
    var curCarries = Array.isArray(item.carriesCharacter) ? item.carriesCharacter.join('，') : '';
    var helpText =
      "修改此道具承载的角色名（逗号或顿号分隔，必须和角色列表里的 name 一致）。\n" +
      "例：仇人，未婚妻\n" +
      "留空则改回普通道具。\n" +
      "仅当此道具是照片/通缉令/海报/画像/电视屏等「承载人脸的载体」时才填写。";
    showPrompt({
      title: "标注载体承载的角色",
      message: helpText,
      defaultValue: curCarries,
      placeholder: "例：仇人，未婚妻",
      icon: "portrait",
      okText: "好",
      cancelText: "取消",
      hideCancel: true,
      commitOnDismiss: true,
    }).then(function (newCarries) {
      if (newCarries === null) return;
      newCarries = (newCarries || '').trim();
      var list = newCarries ? newCarries.split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean) : [];
      // 内容没变就直接返回：点 X / 点遮罩等误触不再把下游标记为过期，也不弹无意义的提示。
      var _origCarries = Array.isArray(item.carriesCharacter) ? item.carriesCharacter.slice() : [];
      if (list.join('\u0001') === _origCarries.join('\u0001')) return;
      if (list.length) {
        var known = {};
        (project.assets && project.assets.characters || []).forEach(function (c) {
          if (c && c.name) known[c.name.trim()] = true;
        });
        var missing = list.filter(function (n) { return !known[n]; });
        item.carriesCharacter = list;
        if (!project._carryWarnings) project._carryWarnings = {};
        if (missing.length) {
          project._carryWarnings[idx] = {
            missing: missing,
            message: "载体承载的角色未在角色列表中：" + missing.join('、') + "。请先把这些角色补到角色卡片里。",
          };
        } else if (project._carryWarnings && project._carryWarnings[idx]) {
          delete project._carryWarnings[idx];
        }
      } else {
        delete item.carriesCharacter;
        if (project._carryWarnings && project._carryWarnings[idx]) delete project._carryWarnings[idx];
      }
      item._descEdited = true;
      _ctx.markDownstreamStale("asset", { type: "prop", idx: idx, name: item.name || "" });
      _saveAssetsProject();
      renderAssetsUI();
      showToast(list.length ? "载体承载已更新" : "已改回普通道具", "ok");
    });
  } else if (action === "show-carry-warning") {
    var w = project && project._carryWarnings && project._carryWarnings[idx];
    if (w) alert("⚠ 载体校验问题\n\n" + (w.message || "未知问题"));
  }
}

/* ── 角色卡右上角菜单 ── */
var _charMenuDismissHandler = null;
var _charMenuScrollHandler = null;
var _customCharReplaceDismissHandler = null;
var _customCharReplaceKeyHandler = null;
var _customCharReplaceSelection = "";
var _customCharReplaceItems = [];

/* ── 道具卡右上角菜单 ── */
var _propMoreMenuDismissHandler = null;
var _propMoreMenuScrollHandler = null;

function _dismissPropMoreMenu() {
  var menu = document.getElementById("propContextMenu");
  if (menu) menu.remove();
  if (_propMoreMenuDismissHandler) {
    document.removeEventListener("click", _propMoreMenuDismissHandler);
    _propMoreMenuDismissHandler = null;
  }
  if (_propMoreMenuScrollHandler) {
    window.removeEventListener("scroll", _propMoreMenuScrollHandler, true);
    window.removeEventListener("resize", _propMoreMenuScrollHandler);
    _propMoreMenuScrollHandler = null;
  }
}

function _showPropMenu(anchor, idx) {
  var existing = document.getElementById("propContextMenu");
  _dismissPropMoreMenu();
  if (existing) return;
  var item = project && project.assets && project.assets.props && project.assets.props[idx];
  if (!item) return;
  var menu = document.createElement("div");
  menu.id = "propContextMenu";
  menu.className = "fixed z-[10002] min-w-[200px] bg-white rounded-2xl overflow-hidden border border-black/[0.06]";
  menu.style.cssText = "z-index: 10002; box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);";
  menu.innerHTML =
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-2xl" data-prop-menu="upload"><span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传道具图</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-prop-menu="download"><span class="material-symbols-outlined text-lg text-[#1565C0]">download</span>下载图片</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-prop-menu="history"><span class="material-symbols-outlined text-lg">history</span>历史记录</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-2xl" data-prop-menu="delete"><span class="material-symbols-outlined text-lg">delete_outline</span>删除道具</button>';
  document.body.appendChild(menu);
  var _propAnchorRect = anchor.getBoundingClientRect();
  menu.style.top = (_propAnchorRect.bottom + 8) + "px";
  menu.style.right = (window.innerWidth - _propAnchorRect.right) + "px";

  menu.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var btn = ev.target.closest("[data-prop-menu]");
    if (!btn) return;
    var act = btn.dataset.propMenu;
    _dismissPropMoreMenu();
    if (act === "upload") {
      _triggerAssetImageUpload("prop", idx);
    } else if (act === "download") {
      _downloadAssetImage("prop", idx);
    } else if (act === "history") {
      _openAssetHistoryFor("prop", idx);
    } else if (act === "delete") {
      var _delPropName = item.name || "";
      showConfirm("删除道具", "确定删除道具「" + _delPropName + "」？", function () {
        _ctx.markDownstreamStale("asset", { type: "prop", idx: idx, name: _delPropName });
        project.assets.props.splice(idx, 1);
        if (project._staleFlags) delete project._staleFlags["asset_img_prop_" + idx];
        _saveAssetsProject();
        renderAssets();
        _showAssetActions();
      });
    }
  });
  _propMoreMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || (anchor && anchor.contains && anchor.contains(ev.target))) return;
    _dismissPropMoreMenu();
  };
  var _propRepoPending = false;
  _propMoreMenuScrollHandler = function () {
    if (_propRepoPending) return;
    _propRepoPending = true;
    requestAnimationFrame(function () {
      _propRepoPending = false;
      var m = document.getElementById("propContextMenu");
      if (!m) return;
      if (!document.body.contains(anchor)) { _dismissPropMoreMenu(); return; }
      var r = anchor.getBoundingClientRect();
      m.style.top = (r.bottom + 8) + "px";
      m.style.right = (window.innerWidth - r.right) + "px";
    });
  };
  setTimeout(function () {
    document.addEventListener("click", _propMoreMenuDismissHandler);
    window.addEventListener("scroll", _propMoreMenuScrollHandler, true);
    window.addEventListener("resize", _propMoreMenuScrollHandler);
  }, 0);
}

// 资产卡「历史记录」入口：菜单中"历史记录"项点击后调用。
// 走 main.js 的 _openAssetHistoryModal（统一弹窗 UI），onApply 处理替换 + 回写持久化。
function _openAssetHistoryFor(type, idx) {
  var list = type === "char" ? project.assets.characters
           : type === "scene" ? project.assets.scenes
           : project.assets.props;
  var item = list && list[idx];
  if (!item) return;
  if (!Array.isArray(item.imageHistory) || !item.imageHistory.length) {
    showToast("暂无历史版本", "warn");
    return;
  }
  _ctx.openAssetHistoryModal(item, type, function (snapIdx) {
    if (!_ctx.setHistoryAsCurrent(item, snapIdx)) {
      showToast("替换失败", "error");
      return;
    }
    _ctx.markDownstreamStale("asset", { type: type, idx: idx, name: item.name || "" });
    _saveAssetsProject();
    _rerenderAssetGrid(type);
    showToast("已替换为该历史版本", "ok");
  });
}

function _showCharMenu(anchor, type, idx) {
  var existing = document.getElementById("charContextMenu");
  _dismissCharMenu();
  if (type !== "char") return;
  if (existing) return;

  var menu = document.createElement("div");
  menu.id = "charContextMenu";
  menu.className = "fixed z-50 min-w-[200px] bg-white rounded-2xl overflow-hidden border border-black/[0.06]";
  menu.style.cssText = "box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);";
  var _charItem = project.assets.characters[idx];
  var _hasPencilIssue = _charItem && !_charItem.isCrowd && _charItem.realPhotoUrl && !_charItem.pencilUrl;
  var _menuEntityType = (((_charItem || {}).entityType) || 'human').toString().toLowerCase();
  var _isNonHumanMenu = _menuEntityType === 'non-human';
  var _retryLabel = _isNonHumanMenu ? '重试实体概念图' : '重试风格转换';
  menu.innerHTML =
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-2xl" data-menu="upload-char-img">' +
      '<span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传角色图' +
    '</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-menu="download-char-img">' +
      '<span class="material-symbols-outlined text-lg text-[#1565C0]">download</span>下载图片' +
    '</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-menu="replace-custom-char">' +
      '<span class="material-symbols-outlined text-lg text-primary">frame_person</span>替换角色特征' +
    '</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors" data-menu="char-history">' +
      '<span class="material-symbols-outlined text-lg">history</span>历史记录' +
    '</button>' +
    (_hasPencilIssue ? '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e65100] hover:bg-orange-50 transition-colors" data-menu="retry-pencil">' +
      '<span class="material-symbols-outlined text-lg">brush</span>' + _retryLabel +
    '</button>' : '') +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-2xl" data-menu="delete-char">' +
      '<span class="material-symbols-outlined text-lg">delete_outline</span>删除' + (_isNonHumanMenu ? '实体' : '角色') +
    '</button>';

  menu.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var btn = ev.target.closest("[data-menu]");
    if (!btn) return;
    var act = btn.dataset.menu;
    _dismissCharMenu();
    if (act === "upload-char-img") {
      _triggerCharImageUpload(idx);
    } else if (act === "download-char-img") {
      _downloadAssetImage("char", idx);
    } else if (act === "replace-custom-char") {
      _openCustomCharacterReplaceDialog(idx).catch(function (e) {
        showToast("定制角色加载失败：" + ((e && e.message) || e), "error");
      });
    } else if (act === "char-history") {
      _openAssetHistoryFor("char", idx);
    } else if (act === "retry-pencil") {
      _retryPencilConversion(idx);
    } else if (act === "delete-char") {
      var _delCharName = (project.assets.characters[idx] || {}).name || "";
      showConfirm("删除角色", "确定删除角色「" + _delCharName + "」？", function () {
      if (_delCharName) {
        _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: _delCharName });
        if (project.styleBible && project.styleBible.characters) {
          project.styleBible.characters = project.styleBible.characters.filter(function (c) { return c.name !== _delCharName; });
        }
      }
      project.assets.characters.splice(idx, 1);
      if (project._staleFlags) {
        delete project._staleFlags["asset_img_char_" + idx];
        var _maxCharIdx = project.assets.characters.length;
        for (var _ci = _maxCharIdx; _ci <= _maxCharIdx + 1; _ci++) {
          delete project._staleFlags["asset_img_char_" + _ci];
        }
      }
      _saveAssetsProject();
      renderAssets();
      _showAssetActions();
      if (project.styleBible && _ctx.refreshStylePage) _ctx.refreshStylePage();
      _detectObsoleteAssets().then(function (_afterDelObsolete) {
        if (_afterDelObsolete.length) {
          setTimeout(function () {
            showToast("检测到 " + _afterDelObsolete.length + " 个可能过时的关联资产，可点击「清理过时资产」按钮处理", "warn");
          }, 500);
        }
      });
      });
    }
  });

  var _anchorRect = anchor.getBoundingClientRect();
  menu.style.top = (_anchorRect.bottom + 8) + "px";
  menu.style.right = (window.innerWidth - _anchorRect.right) + "px";
  document.body.appendChild(menu);

  _charMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || anchor.contains(ev.target)) return;
    _dismissCharMenu();
  };
  var _repositionPending = false;
  _charMenuScrollHandler = function () {
    if (_repositionPending) return;
    _repositionPending = true;
    requestAnimationFrame(function () {
      _repositionPending = false;
      var m = document.getElementById("charContextMenu");
      if (!m) return;
      if (!document.body.contains(anchor)) { _dismissCharMenu(); return; }
      var r = anchor.getBoundingClientRect();
      m.style.top = (r.bottom + 8) + "px";
      m.style.right = (window.innerWidth - r.right) + "px";
    });
  };
  setTimeout(function () {
    document.addEventListener("click", _charMenuDismissHandler);
    window.addEventListener("scroll", _charMenuScrollHandler, true);
    window.addEventListener("resize", _charMenuScrollHandler);
  }, 0);
}

function _dismissCharMenu() {
  var m = document.getElementById("charContextMenu");
  if (m) m.remove();
  if (_charMenuDismissHandler) {
    document.removeEventListener("click", _charMenuDismissHandler);
    _charMenuDismissHandler = null;
  }
  if (_charMenuScrollHandler) {
    window.removeEventListener("scroll", _charMenuScrollHandler, true);
    window.removeEventListener("resize", _charMenuScrollHandler);
    _charMenuScrollHandler = null;
  }
}

function _deepClonePlain(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch (_e) {
    return {};
  }
}

function _customCharacterCurrentFields(item) {
  item = item || {};
  return item.current || item.currentVersion && item.currentVersion.fields || {};
}

function _customCharacterDisplayName(item) {
  var fields = _customCharacterCurrentFields(item);
  return fields.name || item.title || "未命名角色";
}

function _customCharacterThumbUrl(item) {
  var fields = _customCharacterCurrentFields(item);
  var state = deriveAssetCardState(fields, 0);
  return state.previewThumbUrl || state.previewImageUrl || "";
}

function _customCharacterCardHtml(item, selectedId) {
  var fields = _customCharacterCurrentFields(item);
  var id = item && item.id || "";
  var name = _customCharacterDisplayName(item);
  var thumb = _customCharacterThumbUrl(item);
  var identity = fields.identity || fields.role || "";
  var selected = id && id === selectedId;
  return '<button type="button" class="custom-char-choice' + (selected ? ' is-selected' : '') + '" data-custom-char-choice="' + escapeHtml(id) + '">' +
    '<span class="custom-char-choice-thumb">' +
      (thumb ? '<img src="' + escapeHtml(thumb) + '" alt="' + escapeHtml(name) + '" loading="lazy" decoding="async" />' : '<span class="material-symbols-outlined">person</span>') +
    '</span>' +
    '<span class="custom-char-choice-copy">' +
      '<strong>' + escapeHtml(name) + '</strong>' +
      (identity ? '<small>' + escapeHtml(String(identity).slice(0, 48)) + '</small>' : '<small>定制角色</small>') +
    '</span>' +
  '</button>';
}

function _renderCustomCharacterReplaceDialog(idx, loading, errorText) {
  var overlay = document.getElementById("customCharReplaceDialog");
  if (!overlay) return;
  var currentName = project && project.assets && project.assets.characters && project.assets.characters[idx]
    ? project.assets.characters[idx].name || ("角色 " + (idx + 1))
    : ("角色 " + (idx + 1));
  var listHtml = "";
  if (loading) {
    listHtml = '<div class="custom-char-picker-empty"><span class="material-symbols-outlined toolbox-spin">progress_activity</span><p>正在加载定制角色</p></div>';
  } else if (errorText) {
    listHtml = '<div class="custom-char-picker-empty"><span class="material-symbols-outlined">error</span><p>' + escapeHtml(errorText) + '</p></div>';
  } else if (!_customCharReplaceItems.length) {
    listHtml = '<div class="custom-char-picker-empty"><span class="material-symbols-outlined">person_off</span><p>暂无可替换的定制角色</p></div>';
  } else {
    listHtml = _customCharReplaceItems.map(function (item) {
      return _customCharacterCardHtml(item, _customCharReplaceSelection);
    }).join("");
  }
  overlay.innerHTML =
    '<div class="custom-char-replace-card" role="dialog" aria-modal="true" aria-label="替换角色特征" onclick="event.stopPropagation()">' +
      '<button type="button" class="custom-char-replace-close" data-custom-char-replace-close title="关闭"><span class="material-symbols-outlined">close</span></button>' +
      '<div class="custom-char-replace-head">' +
        '<p>REPLACE CHARACTER TRAITS</p>' +
        '<h3>替换角色特征</h3>' +
        '<small>将「' + escapeHtml(currentName) + '」的图片和特征替换为一个已确认的定制角色，角色名称和 ID 保持不变。</small>' +
      '</div>' +
      '<div class="custom-char-picker-grid">' + listHtml + '</div>' +
      '<div class="custom-char-replace-foot">' +
        '<button type="button" class="custom-char-replace-cancel" data-custom-char-replace-close>取消</button>' +
        '<button type="button" class="custom-char-replace-confirm" data-custom-char-replace-confirm="' + escapeHtml(String(idx)) + '" ' + (!_customCharReplaceSelection ? 'disabled' : '') + '>确认替换特征</button>' +
      '</div>' +
    '</div>';
  hydrateProtectedImageElements(overlay);
  var card = overlay.querySelector(".custom-char-replace-card");
  if (card) {
    card.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var close = ev.target.closest("[data-custom-char-replace-close]");
      if (close) {
        _dismissCustomCharacterReplaceDialog();
        return;
      }
      var choice = ev.target.closest("[data-custom-char-choice]");
      if (choice) {
        _customCharReplaceSelection = choice.getAttribute("data-custom-char-choice") || "";
        _renderCustomCharacterReplaceDialog(Number(overlay.getAttribute("data-replace-idx") || 0), false, "");
        return;
      }
      var confirm = ev.target.closest("[data-custom-char-replace-confirm]");
      if (confirm) {
        var idx = Number(confirm.getAttribute("data-custom-char-replace-confirm"));
        var selected = _customCharReplaceItems.find(function (item) { return item && item.id === _customCharReplaceSelection; });
        if (!selected) {
          showToast("请先选择一个定制角色", "warn");
          return;
        }
        _dismissCustomCharacterReplaceDialog();
        _replaceAssetCharacterWithCustom(idx, selected);
      }
    });
  }
}

function _dismissCustomCharacterReplaceDialog() {
  var overlay = document.getElementById("customCharReplaceDialog");
  if (overlay) overlay.remove();
  if (_customCharReplaceDismissHandler) {
    document.removeEventListener("click", _customCharReplaceDismissHandler);
    _customCharReplaceDismissHandler = null;
  }
  if (_customCharReplaceKeyHandler) {
    document.removeEventListener("keydown", _customCharReplaceKeyHandler);
    _customCharReplaceKeyHandler = null;
  }
}

async function _openCustomCharacterReplaceDialog(idx) {
  if (!project || !project.assets || !project.assets.characters || !project.assets.characters[idx]) return;
  _dismissCustomCharacterReplaceDialog();
  _customCharReplaceSelection = "";
  _customCharReplaceItems = [];

  var overlay = document.createElement("div");
  overlay.id = "customCharReplaceDialog";
  overlay.className = "custom-char-replace-overlay";
  overlay.setAttribute("data-replace-idx", String(idx));
  document.body.appendChild(overlay);
  _renderCustomCharacterReplaceDialog(idx, true, "");

  overlay.addEventListener("click", function () { _dismissCustomCharacterReplaceDialog(); });
  _customCharReplaceDismissHandler = function (ev) {
    if (!overlay.contains(ev.target)) _dismissCustomCharacterReplaceDialog();
  };
  _customCharReplaceKeyHandler = function (ev) {
    if (ev.key === "Escape") _dismissCustomCharacterReplaceDialog();
  };
  setTimeout(function () {
    document.addEventListener("click", _customCharReplaceDismissHandler);
    document.addEventListener("keydown", _customCharReplaceKeyHandler);
  }, 0);

  try {
    // 定制角色是用户级全局库：项目调用环节也不按项目过滤，确保能选到自己所有已确认角色。
    var url = "/api/character-custom/history?limit=100";
    var data = await apiGet(url, { timeoutMs: 15000 });
    _customCharReplaceItems = (data.items || []).filter(function (item) {
      var fields = _customCharacterCurrentFields(item);
      var state = deriveAssetCardState(fields, 0);
      return state.status === "ready" || state.status === "degraded";
    });
    if (!_customCharReplaceSelection && _customCharReplaceItems.length) {
      _customCharReplaceSelection = _customCharReplaceItems[0].id || "";
    }
    _renderCustomCharacterReplaceDialog(idx, false, "");
  } catch (e) {
    _renderCustomCharacterReplaceDialog(idx, false, (e && e.message) || "定制角色加载失败");
  }
}

function _customCharacterToAssetCharacter(item, previous) {
  var fields = _deepClonePlain(_customCharacterCurrentFields(item));
  previous = previous || {};
  var preservedName = previous.name || previous.canonicalName || fields.name || item.title || "未命名角色";
  var preservedId = previous.id || previous.characterId || fields.id || item.id || "";
  var preservedCharacterId = previous.characterId || previous.id || preservedId || fields.characterId || fields.id || item.id || "";
  var next = {
    ...fields,
    id: preservedId,
    characterId: preservedCharacterId,
    name: preservedName,
    customCharacterId: item.id || "",
    customCharacterVersionId: item.currentVersion && item.currentVersion.id || item.currentVersionId || "",
    _fromCustomCharacter: true,
  };
  next.canonicalName = previous.canonicalName || preservedName;
  if (previous.assetId) next.assetId = previous.assetId;
  if (previous.materialId) next.materialId = previous.materialId;
  if (previous.sourceAssetId) next.sourceAssetId = previous.sourceAssetId;
  delete next.imageLastError;
  delete next.imageFailedAt;
  delete next._pencilFailed;
  return next;
}

function _replaceAssetCharacterWithCustom(idx, item) {
  if (!project || !project.assets || !project.assets.characters || !project.assets.characters[idx]) return;
  var previous = project.assets.characters[idx] || {};
  var next = _customCharacterToAssetCharacter(item, previous);
  project.assets.characters[idx] = next;
  if (Array.isArray(project.characters)) {
    project.characters[idx] = _deepClonePlain(next);
  }
  if (project._staleFlags) {
    delete project._staleFlags["asset_img_char_" + idx];
  }
  _saveAssetsProject();
  renderAssets();
  _showAssetActions();
  if (project.styleBible && _ctx.refreshStylePage) _ctx.refreshStylePage();
  _syncAssetToStyleBible("char", idx);
  showToast("已替换角色特征，角色名称和 ID 已保留", "ok");
}

/**
 * 手动重试单个角色的彩铅转绘。
 *
 * Phase 3-B-8：走 `_runStylizeBatch` 单任务批次，后端 executor 负责上游调用
 * + 权威落盘；non-human 直接在前端本地同步写回（省一次无意义的 batch 往返）。
 */
export async function _retryPencilConversion(idx) {
  if (!project || !project.assets || !project.assets.characters) return;
  var item = project.assets.characters[idx];
  if (!item || !item.realPhotoUrl) {
    showToast("该实体没有原始参考图，请先重新生成", "warn");
    return;
  }
  if (item.isCrowd) {
    showToast("群像使用整体参考图，不需要风格转换", "info");
    delete item._pencilFailed;
    _updateStylizeBadge();
    return;
  }
  var originId = project.id;
  var _entityType = (item.entityType || "human").toString().toLowerCase();
  var _isNonHuman = _entityType === "non-human";
  var charName = item.name || ("角色#" + idx);

  if (_isNonHuman) {
    item.pencilUrl = item.realPhotoUrl;
    delete item._pencilFailed;
    _ctx.archiveOldImage(item, "stylize");
    _ctx.safeWriteBack(originId, function (proj) {
      if (proj.assets && proj.assets.characters && proj.assets.characters[idx]) {
        _ctx.archiveOldImage(proj.assets.characters[idx], "stylize");
        proj.assets.characters[idx].pencilUrl = item.realPhotoUrl;
        delete proj.assets.characters[idx]._pencilFailed;
      }
    });
    showToast("实体概念图已就绪！", "ok");
    updateAssetCardImage("char", idx, "done", item.realPhotoUrl);
    _updateStylizeBadge();
    return;
  }

  showToast("正在重试风格转换…", "ok");
  updateAssetCardImage("char", idx, "loading", null, "风格转换中…");

  var res = { done: 0, failed: 0 };
  try {
    res = await _runStylizeBatch(originId, [{ idx: idx, charName: charName }]);
  } catch (e) {
    console.warn("[Stylize] manual retry failed:", _diagnoseApiError((e && e.message || "").slice(0, 200)));
  }

  if (res.done > 0) {
    showToast("风格转换成功！", "ok");
  } else {
    showToast("风格图暂未生成，可稍后再试", "info");
  }
  if (project && project.id === originId) {
    updateAssetCardImage("char", idx, "done", item.realPhotoUrl);
  }
  _updateStylizeBadge();
}

var _charUploadStreams = {};
var _assetUploadStreams = {};

function _assetUploadLabel(type) {
  return type === "scene" ? "场景" : type === "prop" ? "道具" : "角色";
}

function _assetUploadList(type) {
  if (!project || !project.assets) return null;
  if (type === "char") return project.assets.characters;
  if (type === "scene") return project.assets.scenes;
  if (type === "prop") return project.assets.props;
  return null;
}

function _assetUploadTopList(type) {
  if (!project) return null;
  if (type === "char") return project.characters;
  if (type === "scene") return project.environments;
  if (type === "prop") return project.props;
  return null;
}

function _assetUploadRef(type, idx) {
  if (type === "char") return "characters[" + idx + "]";
  if (type === "scene") return "scenes[" + idx + "]";
  return "props[" + idx + "]";
}

function _triggerAssetImageUpload(type, idx) {
  if (type === "char") {
    _triggerCharImageUpload(idx);
    return;
  }
  var key = type + "_" + idx;
  var label = _assetUploadLabel(type);
  if (_assetUploadStreams[key]) {
    showToast("该" + label + "正在上传中，请稍候", "warn");
    return;
  }
  var input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/gif";
  input.style.display = "none";
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    if (file.size > 20 * 1024 * 1024) {
      showToast("图片过大，最大 20MB", "error");
      input.remove();
      return;
    }
    _uploadAssetImage(type, idx, file).finally(function () { input.remove(); });
  });
  document.body.appendChild(input);
  input.click();
}

async function _uploadAssetImage(type, idx, file) {
  var list = _assetUploadList(type);
  var item = list && list[idx];
  if (!item) {
    showToast("当前资产不存在", "warn");
    return;
  }
  var key = type + "_" + idx;
  var label = _assetUploadLabel(type);
  var assetName = item.name || (label + "#" + (idx + 1));
  _assetUploadStreams[key] = true;
  showToast("正在上传「" + assetName + "」的" + label + "图...", "info");

  var formData = new FormData();
  formData.append("file", file);
  formData.append("projectId", project.id || "default");
  formData.append("assetType", type);
  formData.append("idx", String(idx));
  formData.append("assetRef", _assetUploadRef(type, idx));

  try {
    var authToken = "";
    try { authToken = localStorage.getItem("sw_auth_token") || ""; } catch(_e) {}
    var resp = await fetch("/api/assets/upload-char-image", {
      method: "POST",
      headers: authToken ? { "Authorization": "Bearer " + authToken } : {},
      body: formData,
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || data.error) {
      showToast((data && (data.error || data.detail)) || "上传失败", "error");
      return;
    }
    var uploadedUrl = data.url || "";
    if (!uploadedUrl) {
      showToast("上传失败：没有返回图片地址", "error");
      return;
    }
    var displayUrl = data.signedUrl || uploadedUrl;
    if (typeof _ctx.archiveOldImage === "function") _ctx.archiveOldImage(item, type);
    item.rawUrl = uploadedUrl;
    item.imageUrl = uploadedUrl;
    item.assetId = data.assetId || data.id || item.assetId;
    item.imageGeneratedAt = new Date().toISOString();
    item.reference = Object.assign({}, item.reference || {}, {
      currentUrl: uploadedUrl,
      lastKnownGoodUrl: uploadedUrl,
      status: "ready",
      updatedAt: new Date().toISOString(),
    });
    delete item.imageLastError;
    delete item.imageFailedAt;
    if (item.reference) {
      delete item.reference.lastError;
      delete item.reference.lastFailedAt;
      delete item.reference.lastAttemptUrl;
    }

    var top = _assetUploadTopList(type);
    if (Array.isArray(top) && top[idx]) {
      top[idx].rawUrl = uploadedUrl;
      top[idx].imageUrl = uploadedUrl;
      top[idx].assetId = item.assetId;
      top[idx].imageGeneratedAt = item.imageGeneratedAt;
      top[idx].reference = Object.assign({}, top[idx].reference || {}, item.reference || {});
      delete top[idx].imageLastError;
      delete top[idx].imageFailedAt;
    }
    if (project._staleFlags) delete project._staleFlags["asset_img_" + type + "_" + idx];
    _saveAssetsProject();
    updateAssetCardImage(type, idx, "done", displayUrl);
    renderAssets();
    _showAssetActions();
    showToast(label + "图上传成功，已保存为当前参考图", "success");
  } catch (e) {
    showToast("上传失败：" + ((e && e.message) || e), "error");
  } finally {
    delete _assetUploadStreams[key];
  }
}

function _triggerCharImageUpload(charIdx) {
  if (_charUploadStreams[charIdx]) {
    showToast("该角色正在处理中，请稍候", "warn");
    return;
  }
  var input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/gif";
  input.style.display = "none";
  input.addEventListener("change", function () {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      showToast("图片过大，最大 20MB", "error");
      return;
    }
    _uploadCharImage(charIdx, file);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

async function _uploadCharImage(charIdx, file) {
  var charName = ((project.assets.characters[charIdx] || {}).name) || "角色";
  showToast("正在上传「" + charName + "」的角色图...", "info");

  var formData = new FormData();
  formData.append("file", file);
  formData.append("projectId", project.id || "default");
  formData.append("charIdx", String(charIdx));
  formData.append("assetRef", "characters[" + charIdx + "]");

  try {
    var authToken = "";
    try { authToken = localStorage.getItem("sw_auth_token") || ""; } catch(_e) {}
    var resp = await fetch("/api/assets/upload-char-image", {
      method: "POST",
      headers: authToken ? { "Authorization": "Bearer " + authToken } : {},
      body: formData,
    });
    var data = await resp.json();
    if (data.error) {
      showToast(data.error, "error");
      return;
    }
    if (!data.taskId && data.url) {
      var ch = project.assets && project.assets.characters && project.assets.characters[charIdx];
      if (!ch) {
        showToast("上传成功，但当前角色不存在", "warn");
        return;
      }
      var uploadedUrl = data.url;
      var displayUrl = data.signedUrl || uploadedUrl;
      if (typeof _ctx.archiveOldImage === "function") _ctx.archiveOldImage(ch, "character-upload");
      ch.realPhotoUrl = uploadedUrl;
      ch.rawUrl = uploadedUrl;
      ch.imageUrl = uploadedUrl;
      ch.pencilUrl = uploadedUrl;
      delete ch._pencilFailed;
      _saveAssetsProject();
      updateAssetCardImage("char", charIdx, "done", displayUrl);
      renderAssets();
      showToast("角色图上传成功，已保存为当前参考图", "success");
      var entityType = ((ch.entityType || "human") + "").toLowerCase();
      if (entityType !== "non-human") {
        _retryPencilConversion(charIdx).catch(function (e) {
          console.warn("[CharUpload] stylize after upload failed:", e && e.message);
        });
      }
      return;
    }
    if (!data.taskId) {
      showToast("上传失败：无任务 ID", "error");
      return;
    }

    showToast("角色图上传成功，正在自动处理（三视图→转绘→读图更新描述）...", "success");
    _charUploadStreams[charIdx] = true;
    renderAssets();

    subscribeTask(data.taskId, {
      onProgress: function (ev) {
        var step = ev.step || "";
        var pct = ev.progress || 0;
        var labels = {
          "upload_done": "上传完成",
          "triview": "生成三视图...",
          "triview_done": "三视图完成",
          "stylize": "转绘中...",
          "stylize_done": "转绘完成",
          "vision_read": "AI 读图分析...",
          "vision_done": "读图完成",
          "updating": "更新描述...",
          "update_done": "更新完成",
        };
        var label = labels[step] || step;
        showToast("「" + charName + "」" + label + "（" + pct + "%）", "info");
      },
      onCompleted: function (ev) {
        delete _charUploadStreams[charIdx];
        if (ev.description && project.assets && project.assets.characters[charIdx]) {
          var ch = project.assets.characters[charIdx];
          var descFields = ["appearance", "clothing", "equipment", "actionTraits", "temperament", "imagePrompt", "entityType", "appearanceMode"];
          descFields.forEach(function (f) {
            if (ev.description[f]) ch[f] = ev.description[f];
          });
          if (ev.realPhotoUrl) ch.realPhotoUrl = ev.realPhotoUrl;
          if (ev.pencilUrl) ch.pencilUrl = ev.pencilUrl;
        }
        renderAssets();
        showToast("「" + charName + "」角色图处理完成！描述已自动更新", "success");
      },
      onFailed: function (ev) {
        delete _charUploadStreams[charIdx];
        renderAssets();
        showToast("「" + charName + "」处理失败：" + (ev.reason || "未知错误"), "error");
      },
    });
  } catch (e) {
    showToast("上传失败：" + (e.message || e), "error");
  }
}

export function _openLightbox(imgUrl, title, originalUrl) {
  var existing = document.getElementById("assetLightbox");
  if (existing) existing.remove();

  var safeTitle = String(title || "").trim();
  var headerHtml = safeTitle
    ? '<div class="asset-lightbox-header" style="position:absolute;top:-52px;left:50%;transform:translateX(-50%);z-index:10010;width:100vw;height:42px;display:flex;align-items:center;justify-content:center;pointer-events:none;" onclick="event.stopPropagation()">' +
        '<div class="asset-lightbox-caption" style="width:auto;max-width:min(80vw,960px);padding:0 52px;border:0;background:transparent;color:#fff;font-size:16px;font-weight:900;line-height:1.45;text-align:center;box-shadow:none;text-shadow:0 2px 4px rgba(0,0,0,.95),0 8px 24px rgba(0,0,0,.72);">' + escapeHtml(safeTitle) + '</div>' +
      '</div>'
    : '';
  var overlayClass = 'asset-lightbox' + (safeTitle ? ' has-caption' : '');
  var overlay = document.createElement("div");
  overlay.id = "assetLightbox";
  overlay.className = overlayClass;
  overlay.style.animation = "fadeIn .2s ease";
  overlay.innerHTML =
    '<div class="asset-lightbox-dialog" onclick="event.stopPropagation()">' +
      headerHtml +
      '<div class="ffe-image-frame ffe-image-frame--preview asset-lightbox-image-frame">' +
        '<img src="' + escapeHtml(imgUrl) + '" alt="" class="asset-lightbox-image" decoding="async" onerror="window.__originMarkImageMissing && window.__originMarkImageMissing(this)" />' +
        '<div class="ffe-image-fallback" role="img" aria-label="图片不可用">' +
          '<span class="material-symbols-outlined">broken_image</span>' +
          '<strong>图片暂不可用</strong>' +
          '<span>原图链接失效或文件不可访问</span>' +
        '</div>' +
      '</div>' +
      '<button class="asset-lightbox-close" onclick="this.closest(\'#assetLightbox\').remove()">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  overlay.addEventListener("click", function () { overlay.remove(); });
  document.body.appendChild(overlay);
  hydrateProtectedImageElements(overlay);
}

/* getAssetReferenceImages 与 _assetMatchKeywords 已迁移到后端
   services/assets_matcher.py，前端通过 POST /api/assets/match-references 调用 */

/* ================================================================
   图片生成 API 适配器（分镜图用）
   ================================================================ */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * 滑动窗口并发池：替代 Promise.all 分批模式。
 *
 * 旧的 Promise.all([...10 个]) 模式："10 个同时跑，全部结束才开下一批 10 个"，
 * 一旦某一张图卡 30s，整批要等 30s 才能开下一批 → 拖慢整体进度 30%~50%。
 *
 * 滑动窗口模式："任意时刻最多 limit 个在跑，做完一个立刻填一个新的进来"，
 * 慢任务只占用自己那一个槽位，不阻塞其它槽位继续做新任务。
 *
 * 配合 getLimit (动态读) 还能在过程中改并发数（出错→降并发，恢复→升并发）。
 *
 * @param {Array} tasks
 * @param {Object} opts
 * @param {Function} opts.runFn       - (task) => Promise，跑一个任务
 * @param {Function} [opts.getLimit]  - () => number，每次拉新任务时读取当前并发上限
 * @param {number}   [opts.limit=10]  - 当不传 getLimit 时使用的固定上限
 * @param {number}   [opts.spacingMs=0] - 相邻两个任务"启动"之间的最小间隔（防瞬时打爆）
 * @param {Function} [opts.onComplete] - (task, ok, err) => void
 * @returns {Promise<void>} 全部任务结束后 resolve
 */
function runConcurrent(tasks, opts) {
  opts = opts || {};
  var runFn = opts.runFn;
  var onComplete = opts.onComplete || function () {};
  var getLimit = typeof opts.getLimit === "function"
    ? opts.getLimit
    : function () { return opts.limit || 10; };
  var spacingMs = opts.spacingMs || 0;

  var idx = 0;
  var active = 0;
  var lastStartAt = 0;
  var pumpScheduled = false;

  return new Promise(function (resolve) {
    if (!tasks || tasks.length === 0) { resolve(); return; }

    function pump() {
      pumpScheduled = false;
      var limit = Math.max(1, getLimit() | 0);

      while (active < limit && idx < tasks.length) {
        var now = Date.now();
        if (spacingMs > 0 && now - lastStartAt < spacingMs && active > 0) {
          if (!pumpScheduled) {
            pumpScheduled = true;
            setTimeout(pump, spacingMs - (now - lastStartAt));
          }
          return;
        }
        lastStartAt = now;

        var task = tasks[idx++];
        active++;
        Promise.resolve()
          .then(function () { return runFn(task); })
          // 用 IIFE 锁定 task 的引用（避免 var 闭包陷阱）
          .then((function (curTask) { return function (val) { onComplete(curTask, true, null, val); }; })(task))
          .catch((function (curTask) { return function (err) { onComplete(curTask, false, err); }; })(task))
          .then(function () {
            active--;
            if (idx >= tasks.length && active === 0) {
              resolve();
            } else {
              pump();
            }
          });
      }
    }

    pump();
  });
}

/* extractImageUrl, extractApimartImageUrl, downloadImageForDisplay, _imageUrlToBase64,
   pollApimartTask, callImageGeneration — all moved to Python backend services/ */


/* ================================================================
   世界观模板（Phase 3-B-10：后端 /api/world-templates）
   ================================================================

   历史上世界观模板写在 `localStorage.sw_world_templates`，跨设备 /
   重装浏览器就丢。Phase 3-B-10 搬到后端 `user_<uid>.json.worldTemplates`
   字段，前端这里维持一个**同步的内存镜像** + **写穿到后端 REST**：

     - `_getWorldTemplates()`  : 返回当前内存镜像（同步，调用者预期是列表）
     - `_primeWorldTemplates()`: 启动时 / 登录后调一次，拉取后端列表初始化
     - `_appendWorldTemplate(tpl)`: 本地 unshift + POST /api/world-templates
     - `_deleteWorldTemplateRemote(id)`: 本地 filter + DELETE /api/world-templates/{id}

   为什么保留内存镜像：
     - 模板选择框等 UI 要求同步读取；改成 async 全链条要改太多 UI 点。
     - 后端本身就是轻量 JSON，第一屏加载一次足够；之后 CRUD 走 REST。
*/

var _worldTemplatesMem = null;      // null = 尚未 prime，[] = prime 过但空
var _worldTemplatesPrimed = false;
var _worldTemplatesPrimePromise = null;
var _styleTemplatesMem = null;      // 独立风格模板，不再复用 world_templates
var _styleTemplatesPrimed = false;
var _styleTemplatesPrimePromise = null;

function _worldTemplatesStorageKey() {
  return (_ctx.uPrefix || "") + "sw_world_templates";
}

function _worldTemplatesMigratedKey() {
  return (_ctx.uPrefix || "") + "sw_world_templates_migrated_v1";
}

function _isSafeWorldTemplateId(id) {
  var value = String(id || "").trim();
  return !!(value && value.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(value));
}

function _stableWorldTemplateValue(value) {
  if (Array.isArray(value)) return value.map(_stableWorldTemplateValue);
  if (!value || typeof value !== "object") return value;
  var out = {};
  Object.keys(value).sort().forEach(function (key) {
    var v = _stableWorldTemplateValue(value[key]);
    if (typeof v !== "undefined") out[key] = v;
  });
  return out;
}

function _worldTemplateMigrationFingerprint(tpl) {
  var root = Object.assign({}, tpl || {});
  [
    "id",
    "createdAt",
    "updatedAt",
    "created_at",
    "updated_at",
    "source",
    "legacyId",
    "migrationKey",
    "schemaVersion",
    "schema_version",
  ].forEach(function (key) { delete root[key]; });
  return _hashWorldTemplateString(JSON.stringify(_stableWorldTemplateValue(root)));
}

function _hashWorldTemplateString(text) {
  var h = 2166136261;
  text = String(text || "");
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function _legacyWorldTemplateStableId(tpl) {
  return "tpl_legacy_" + _worldTemplateMigrationFingerprint(tpl);
}

export function _getWorldTemplates() {
  return Array.isArray(_worldTemplatesMem) ? _worldTemplatesMem : [];
}

export function _getStyleTemplates() {
  return Array.isArray(_styleTemplatesMem) ? _styleTemplatesMem : [];
}

// 是否已完成首次拉取（不论结果是否为空）。用于区分「加载中」与「真的没有模板」，
// 避免风格页刷新/重载时先闪一下「暂无可用风格模板」空态。
export function _styleTemplatesLoaded() {
  return _styleTemplatesPrimed;
}

async function _loadWorldTemplateDetail(tpl) {
  if (!tpl || !tpl.id) return tpl;
  if (!tpl.summaryOnly && (Array.isArray(tpl.characters) || tpl.styleBible || tpl.loadedAt)) return tpl;
  var resp = await fetch("/api/world-templates/" + encodeURIComponent(tpl.id), {
    headers: _getAuthHeaders(),
  });
  var data = await _parseWorldTemplateResponse(resp);
  var full = data.template || tpl;
  if (Array.isArray(_worldTemplatesMem)) {
    _worldTemplatesMem = _worldTemplatesMem.map(function (item) {
      return item && item.id === full.id ? full : item;
    });
  }
  return full;
}

export function snapshotWorldTemplate(tpl) {
  var source = tpl && typeof tpl === "object" ? tpl : {};
  var snap = {};
  try {
    snap = JSON.parse(JSON.stringify(source || {}));
  } catch (_) {
    snap = {};
  }
  var ownerId = snap.ownerId || snap.owner_id || source.ownerId || source.owner_id || null;
  if (typeof ownerId === "string" && ownerId.trim()) {
    var numericOwnerId = Number(ownerId);
    ownerId = Number.isFinite(numericOwnerId) ? numericOwnerId : ownerId;
  }
  delete snap.styleBible;
  delete snap.style_bible;
  delete snap.hasStyleBible;
  snap.ownerId = ownerId || null;
  if (!snap.id && source.id) snap.id = source.id;
  if (!snap.name && source.name) snap.name = source.name;
  return snap;
}

function _projectStyleTemplatePreferenceForWorldSnapshot() {
  if (!project || typeof project !== "object") return null;
  var snapshot = project.styleTemplateSnapshot && typeof project.styleTemplateSnapshot === "object"
    ? project.styleTemplateSnapshot
    : {};
  var id = String(
    project.selectedStyleTemplateId ||
    snapshot.id ||
    snapshot.templateId ||
    snapshot.template_id ||
    ""
  ).trim();
  if (!id) return null;
  var name = String(
    snapshot.name ||
    snapshot.title ||
    snapshot.styleName ||
    snapshot.label ||
    ""
  ).trim();
  return {
    preferredStyleTemplateId: id,
    preferredStyleTemplateName: name,
    preferredStyleTemplateSource: "project_style_selection"
  };
}

function _attachProjectStylePreferenceToWorldSnapshot(worldSnapshot) {
  if (!worldSnapshot || typeof worldSnapshot !== "object") return worldSnapshot;
  if (worldSnapshot.preferredStyleTemplateId || worldSnapshot.preferred_style_template_id) return worldSnapshot;
  var preference = _projectStyleTemplatePreferenceForWorldSnapshot();
  if (!preference) return worldSnapshot;
  worldSnapshot.preferredStyleTemplateId = preference.preferredStyleTemplateId;
  if (preference.preferredStyleTemplateName) worldSnapshot.preferredStyleTemplateName = preference.preferredStyleTemplateName;
  worldSnapshot.preferredStyleTemplateSource = preference.preferredStyleTemplateSource;
  return worldSnapshot;
}

function _parseWorldTemplateResponse(resp) {
  return resp.json().catch(function () { return {}; }).then(function (data) {
    if (!resp.ok) {
      throw new Error(data.detail || data.error || ("世界观模板接口失败：" + resp.status));
    }
    return data || {};
  });
}

async function _migrateLegacyWorldTemplatesIfNeeded(serverTemplates) {
  var migratedKey = _worldTemplatesMigratedKey();
  var storageKey = _worldTemplatesStorageKey();
  try {
    if (localStorage.getItem(migratedKey) === "1") return serverTemplates || [];
  } catch (_) { return serverTemplates || []; }

  var legacy = [];
  try {
    var raw = localStorage.getItem(_worldTemplatesStorageKey());
    legacy = raw ? JSON.parse(raw) : [];
  } catch (_) {
    legacy = [];
  }
  if (!Array.isArray(legacy) || legacy.length === 0) {
    try { localStorage.setItem(migratedKey, "1"); } catch (_) {}
    return serverTemplates || [];
  }

  var existingIds = {};
  var existingFingerprints = {};
  (serverTemplates || []).forEach(function (tpl) { if (tpl && tpl.id) existingIds[tpl.id] = true; });
  (serverTemplates || []).forEach(function (tpl) {
    if (!tpl || typeof tpl !== "object") return;
    if (tpl.migrationKey) existingFingerprints[tpl.migrationKey] = true;
    existingFingerprints[_worldTemplateMigrationFingerprint(tpl)] = true;
  });
  var migrated = [];
  var pending = legacy.slice();
  function persistPending() {
    try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch (_) {}
  }
  for (var i = 0; i < pending.length;) {
    var tpl = pending[i];
    if (!tpl || typeof tpl !== "object") {
      pending.splice(i, 1);
      persistPending();
      continue;
    }
    var migrationKey = _worldTemplateMigrationFingerprint(tpl);
    var stableId = _isSafeWorldTemplateId(tpl.id) ? String(tpl.id).trim() : _legacyWorldTemplateStableId(tpl);
    if (existingIds[stableId] || existingFingerprints[migrationKey]) {
      pending.splice(i, 1);
      persistPending();
      continue;
    }
    var payload = Object.assign({}, tpl, {
      id: stableId,
      source: "localStorage_migration",
      legacyId: tpl.id || "",
      migrationKey: migrationKey,
    });
    delete payload.styleBible;
    delete payload.style_bible;
    delete payload.hasStyleBible;
    var resp = await fetch("/api/world-templates", {
      method: "POST",
      headers: Object.assign({}, _getAuthHeaders(), { "Content-Type": "application/json" }),
      body: JSON.stringify({ template: payload }),
    });
    var data = await _parseWorldTemplateResponse(resp);
    if (data.template) {
      migrated.push(data.template);
      existingIds[data.template.id] = true;
      existingFingerprints[migrationKey] = true;
    }
    pending.splice(i, 1);
    persistPending();
  }
  try { localStorage.setItem(migratedKey, "1"); } catch (_) {}
  try { localStorage.setItem(storageKey, "[]"); } catch (_) {}
  return migrated.concat(serverTemplates || []);
}

/**
 * 启动时调一次：从后端把该用户的模板拉进内存，覆盖旧的 localStorage 镜像。
 * 不阻塞首屏——用户触发"导入模板"时若还没 prime 完，UI 会提示"加载中"。
 */
export async function _primeWorldTemplates() {
  if (_worldTemplatesPrimePromise) return _worldTemplatesPrimePromise;
  _worldTemplatesPrimePromise = (async function () {
    try {
      var resp = await fetch("/api/world-templates", { headers: _getAuthHeaders() });
      if (!resp.ok) {
        _worldTemplatesMem = _worldTemplatesMem || [];
        _worldTemplatesPrimed = true;
        return;
      }
      var data = await resp.json();
      var list = Array.isArray(data.templates) ? data.templates : (Array.isArray(data.items) ? data.items : []);
      _worldTemplatesMem = await _migrateLegacyWorldTemplatesIfNeeded(list);
      _worldTemplatesPrimed = true;
    } catch (e) {
      console.warn("[WorldTemplates] prime failed:", e);
      _worldTemplatesMem = _worldTemplatesMem || [];
      _worldTemplatesPrimed = true;
    } finally {
      _worldTemplatesPrimePromise = null;
    }
  })();
  return _worldTemplatesPrimePromise;
}

export async function _primeStyleTemplates() {
  if (_styleTemplatesPrimePromise) return _styleTemplatesPrimePromise;
  _styleTemplatesPrimePromise = (async function () {
    try {
      var resp = await fetch("/api/style-templates", { headers: _getAuthHeaders() });
      if (!resp.ok) {
        _styleTemplatesMem = _styleTemplatesMem || [];
        _styleTemplatesPrimed = true;
        return;
      }
      var data = await resp.json();
      _styleTemplatesMem = Array.isArray(data.templates) ? data.templates : (Array.isArray(data.items) ? data.items : []);
      _styleTemplatesPrimed = true;
    } catch (e) {
      console.warn("[StyleTemplates] prime failed:", e);
      _styleTemplatesMem = _styleTemplatesMem || [];
      _styleTemplatesPrimed = true;
    } finally {
      _styleTemplatesPrimePromise = null;
    }
  })();
  return _styleTemplatesPrimePromise;
}

/** 追加一条模板：本地 unshift + 后端 POST。返回 Promise 便于 UI 等落盘。 */
function _appendWorldTemplate(tpl) {
  return fetch("/api/world-templates", {
    method: "POST",
    headers: Object.assign({}, _getAuthHeaders(), { "Content-Type": "application/json" }),
    body: JSON.stringify({ template: tpl }),
  }).then(_parseWorldTemplateResponse).then(function (data) {
    var saved = data.template || tpl;
    if (!_worldTemplatesMem) _worldTemplatesMem = [];
    _worldTemplatesMem = _worldTemplatesMem.filter(function (t) { return t.id !== saved.id; });
    _worldTemplatesMem.unshift(saved);
    return saved;
  }).catch(function (e) {
    console.warn("[WorldTemplates] POST failed:", e);
    throw e;
  });
}

/** 删除一条：本地 filter + 后端 DELETE。 */
function _deleteWorldTemplateRemote(tplId) {
  var prev = _getWorldTemplates().slice();
  if (Array.isArray(_worldTemplatesMem)) {
    _worldTemplatesMem = _worldTemplatesMem.filter(function (t) { return t.id !== tplId; });
  }
  return fetch("/api/world-templates/" + encodeURIComponent(tplId), {
    method: "DELETE",
    headers: _getAuthHeaders(),
  }).then(_parseWorldTemplateResponse).catch(function (e) {
    _worldTemplatesMem = prev;
    console.warn("[WorldTemplates] DELETE failed:", e);
    throw e;
  });
}

export function saveAsWorldTemplate() {
  if (!project) { showToast("请先创建项目", "warn"); return; }
  if (!project.script) { showToast("当前项目没有剧本，无法保存为模板", "warn"); return; }
  _openSaveTemplateDialog();
}

function _knowledgeText(value, fallback) {
  var text = String(value || "").trim();
  return text || (fallback || "未设置");
}

function _knowledgeDriftLabel(drift) {
  if (!drift || !drift.hasSnapshot) return { text: "未绑定", cls: "text-[#90A4AE]" };
  if (!drift.hasSource) return { text: "源模板不可用", cls: "text-[#8A6D3B]" };
  if (drift.isDrifted) return { text: "项目使用旧快照", cls: "text-[#B45309]" };
  return { text: "与源模板一致", cls: "text-[#2E7D32]" };
}

function _knowledgeInfoRow(label, value) {
  return '<div class="grid grid-cols-[92px_1fr] gap-3 text-xs">' +
    '<div class="text-[#90A4AE] font-medium">' + escapeHtml(label) + '</div>' +
    '<div class="text-[#2C3E50] leading-relaxed">' + escapeHtml(_knowledgeText(value)) + '</div>' +
  '</div>';
}

function _renderKnowledgeTemplate(title, tpl, drift) {
  var d = _knowledgeDriftLabel(drift);
  if (!tpl) {
    return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<h4 class="text-sm font-bold text-[#1a1a1a]">' + escapeHtml(title) + '</h4>' +
        '<span class="text-[11px] font-bold ' + d.cls + '">' + escapeHtml(d.text) + '</span>' +
      '</div>' +
      '<p class="text-xs text-[#90A4AE]">当前项目还没有绑定模板。</p>' +
    '</section>';
  }
  return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4 space-y-2">' +
    '<div class="flex items-center justify-between mb-1">' +
      '<h4 class="text-sm font-bold text-[#1a1a1a]">' + escapeHtml(title) + '</h4>' +
      '<span class="text-[11px] font-bold ' + d.cls + '">' + escapeHtml(d.text) + '</span>' +
    '</div>' +
    _knowledgeInfoRow("名称", tpl.name || tpl.id) +
    (tpl.summary ? _knowledgeInfoRow("摘要", tpl.summary) : '') +
    (typeof tpl.characterCount === "number" ? _knowledgeInfoRow("内容", tpl.characterCount + " 个角色 / " + (tpl.locationCount || 0) + " 个场景 / " + (tpl.propCount || 0) + " 个道具") : '') +
  '</section>';
}

function _knowledgeConflictReasonText(reason) {
  var text = String(reason || "").trim();
  var m = /^world_template_conflict:([^:]+):(.+)$/.exec(text);
  if (!m) return text || "存在待复核的一致性差异";
  var fieldMap = {
    "canonicalName": "角色名称",
    "identityLock.role": "身份角色",
    "identityLock.identity": "身份设定",
    "identityLock.entityType": "实体类型",
    "identityLock.species": "物种",
    "identityLock.gender": "性别",
    "identityLock.ageBand": "年龄段",
    "visualLock.appearance": "外貌",
    "visualLock.clothing": "服装",
    "visualLock.equipment": "装备",
    "visualLock.scaleRule": "比例规则",
    "visualLock.negativeRules": "外观禁忌",
    "visualLock.signatureColors": "标志色",
    "performanceLock.temperament": "气质",
    "performanceLock.actionTraits": "动作习惯",
    "performanceLock.gestureRules": "手势规则",
    "voiceLock.voiceGender": "声音性别",
    "voiceLock.voiceAge": "声音年龄",
    "voiceLock.timbre": "音色",
    "voiceLock.speechStyle": "说话方式",
    "voiceLock.accent": "口音",
    "referenceLock.sheetUrl": "参考图",
  };
  return m[1] + "：" + (fieldMap[m[2]] || m[2]) + " 与世界观模板不一致";
}

function _renderKnowledgeConsistencyAlerts(consistency) {
  var reasons = consistency && Array.isArray(consistency.roleSyncReasons) ? consistency.roleSyncReasons : [];
  if (!(consistency && consistency.needsRoleSync) && !reasons.length) return "";
  var reasonHtml = reasons.length
    ? '<ul class="mt-2 space-y-1">' + reasons.slice(0, 8).map(function (reason) {
        return '<li class="text-xs text-[#8A5A00] leading-relaxed">• ' + escapeHtml(_knowledgeConflictReasonText(reason)) + '</li>';
      }).join("") + '</ul>'
    : '<p class="text-xs text-[#8A5A00] mt-2">角色锁与世界观模板存在待复核差异。</p>';
  return '<section class="rounded-xl border border-[#F7D48B] bg-[#FFF8E6] p-4">' +
    '<div class="flex items-center gap-2">' +
      '<span class="material-symbols-outlined text-base text-[#B45309]">warning</span>' +
      '<h4 class="text-sm font-bold text-[#8A5A00]">世界观 / 角色一致性待复核</h4>' +
    '</div>' +
    reasonHtml +
  '</section>';
}

function _renderKnowledgePendingWorldFacts(pending) {
  if (!pending) return "";
  var summary = pending.summary || {};
  return '<section class="rounded-xl border border-[#D6E4FF] bg-[#F5F8FF] p-4">' +
    '<div class="flex items-center gap-2">' +
      '<span class="material-symbols-outlined text-base text-[#3156A3]">priority_high</span>' +
      '<h4 class="text-sm font-bold text-[#24427A]">待确认的世界观回填</h4>' +
    '</div>' +
    '<p class="text-xs text-[#526989] mt-2 leading-relaxed">资产抽取发现可补充到世界观的空字段，确认后才会写入剧级世界观。</p>' +
    _knowledgeInfoRow("候选", (summary.characterCount || 0) + " 个角色 / " + (summary.locationCount || 0) + " 个场景 / " + (summary.propCount || 0) + " 个道具") +
  '</section>';
}

function _renderKnowledgeCharacters(characters) {
  if (!characters || !characters.length) {
    return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4">' +
      '<h4 class="text-sm font-bold text-[#1a1a1a] mb-2">角色一致性</h4>' +
      '<p class="text-xs text-[#90A4AE]">暂无角色锁。</p>' +
    '</section>';
  }
  return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4">' +
    '<h4 class="text-sm font-bold text-[#1a1a1a] mb-3">角色一致性</h4>' +
    '<div class="space-y-3 max-h-[260px] overflow-y-auto pr-1">' +
      characters.map(function (ch) {
        var identity = ch.identityLock || {};
        var visual = ch.visualLock || {};
        var performance = ch.performanceLock || {};
        var voice = ch.voiceLock || {};
        var reference = ch.referenceLock || {};
        return '<div class="rounded-lg bg-[#F8F9FA] p-3 text-xs">' +
          '<div class="flex items-center justify-between gap-3 mb-2">' +
            '<div class="font-bold text-[#2C3E50]">' + escapeHtml(ch.canonicalName || ch.characterId || "未命名角色") + '</div>' +
            '<span class="text-[10px] text-[#607D8B]">' + escapeHtml(ch.status || "unknown") + '</span>' +
          '</div>' +
          '<div class="space-y-1.5">' +
            _knowledgeInfoRow("身份", [identity.role, identity.identity, identity.entityType].filter(Boolean).join(" / ")) +
            _knowledgeInfoRow("外观", [visual.appearance, visual.clothing, visual.equipment].filter(Boolean).join("；")) +
            _knowledgeInfoRow("表演", [performance.temperament, performance.actionTraits].filter(Boolean).join("；")) +
            _knowledgeInfoRow("声音", [voice.voiceGender, voice.voiceAge, voice.timbre, voice.speechStyle, voice.accent].filter(Boolean).join(" / ")) +
            _knowledgeInfoRow("参考", [reference.referenceStatus, reference.qualityScore != null ? "质量 " + reference.qualityScore : ""].filter(Boolean).join(" / ")) +
          '</div>' +
        '</div>';
      }).join("") +
    '</div>' +
  '</section>';
}

function _renderKnowledgeStages(stages) {
  if (!stages || !stages.length) {
    return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4">' +
      '<h4 class="text-sm font-bold text-[#1a1a1a] mb-2">最近阶段上下文</h4>' +
      '<p class="text-xs text-[#90A4AE]">还没有知识上下文审计记录。</p>' +
    '</section>';
  }
  return '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4">' +
    '<h4 class="text-sm font-bold text-[#1a1a1a] mb-3">最近阶段上下文</h4>' +
    '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' +
      stages.map(function (stage) {
        return '<div class="rounded-lg bg-[#F8F9FA] px-3 py-2">' +
          '<div class="flex items-center justify-between gap-2">' +
            '<span class="text-xs font-bold text-[#2C3E50]">' + escapeHtml(stage.label || stage.stage) + '</span>' +
            '<span class="text-[10px] text-[#607D8B]">' + Number(stage.ruleCardCount || 0) + ' 条规则</span>' +
          '</div>' +
          '<div class="text-[10px] text-[#90A4AE] mt-1">' + escapeHtml(stage.updatedAt || '') + '</div>' +
        '</div>';
      }).join("") +
    '</div>' +
  '</section>';
}

export async function openKnowledgeSnapshot() {
  if (!project || !project.id) { showToast("请先打开项目", "warn"); return; }
  var existing = document.getElementById("knowledgeSnapshotDialog");
  if (existing) existing.remove();
  var overlay = document.createElement("div");
  overlay.id = "knowledgeSnapshotDialog";
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
  overlay.innerHTML =
    '<div class="bg-[#F8F9FA] rounded-2xl shadow-2xl w-[760px] max-w-[94vw] max-h-[86vh] overflow-hidden" onclick="event.stopPropagation()">' +
      '<div class="px-6 py-5 bg-white border-b border-[#ECEFF1] flex items-start justify-between gap-4">' +
        '<div>' +
          '<h3 class="text-base font-bold text-[#1a1a1a]">当前项目知识</h3>' +
          '<p class="text-xs text-[#90A4AE] mt-1">查看当前项目绑定的风格、世界观和角色一致性，不展示底层 prompt 与 hash。</p>' +
        '</div>' +
        '<button type="button" id="knowledgeSnapshotClose" class="w-9 h-9 rounded-full hover:bg-[#F8F9FA] text-[#607D8B] flex items-center justify-center">' +
          '<span class="material-symbols-outlined text-lg">close</span>' +
        '</button>' +
      '</div>' +
      '<div id="knowledgeSnapshotBody" class="p-5 overflow-y-auto max-h-[calc(86vh-86px)]">' +
        '<div class="rounded-xl border border-[#ECEFF1] bg-white p-5 text-sm text-[#607D8B]">正在读取项目知识快照…</div>' +
      '</div>' +
    '</div>';
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  overlay.querySelector("#knowledgeSnapshotClose").addEventListener("click", function () { overlay.remove(); });
  try {
    var resp = await fetch("/api/projects/" + encodeURIComponent(project.id) + "/knowledge-snapshot", {
      headers: _getAuthHeaders(),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(data.detail || "读取失败");
    var style = data.style || {};
    var world = data.world || {};
    var consistency = data.consistency || {};
    var body = overlay.querySelector("#knowledgeSnapshotBody");
    body.innerHTML =
      '<div class="space-y-4">' +
        '<section class="rounded-xl border border-[#ECEFF1] bg-white p-4 space-y-2">' +
          '<h4 class="text-sm font-bold text-[#1a1a1a] mb-2">风格圣经摘要</h4>' +
          _knowledgeInfoRow("视觉", style.styleBible && style.styleBible.vision) +
          _knowledgeInfoRow("镜头", style.styleBible && style.styleBible.camera) +
          _knowledgeInfoRow("节奏", style.styleBible && style.styleBible.editingRhythm) +
        '</section>' +
        _renderKnowledgeTemplate("风格模板", style.template, style.drift) +
        _renderKnowledgeTemplate("世界观模板", world.template, world.drift) +
        _renderKnowledgePendingWorldFacts(world.pendingFacts) +
        _renderKnowledgeConsistencyAlerts(consistency) +
        _renderKnowledgeCharacters(data.characters || []) +
        _renderKnowledgeStages(data.recentStages || []) +
      '</div>';
  } catch (e) {
    var errBody = overlay.querySelector("#knowledgeSnapshotBody");
    if (errBody) {
      errBody.innerHTML = '<div class="rounded-xl border border-[#FFCDD2] bg-[#FFF5F5] p-5 text-sm text-[#B71C1C]">读取失败：' + escapeHtml((e && e.message) || e) + '</div>';
    }
  }
}

export async function confirmPendingWorldFacts() {
  if (!project || !project.id) { showToast("请先打开项目", "warn"); return; }
  var pending = project.pendingWorldFacts;
  var snapshot = pending && pending.worldTemplateSnapshot;
  if (!snapshot) { showToast("没有待确认的世界观更新", "info"); return; }
  var summary = pending.summary || {};
  var msg = "将把本次资产抽取得到的空字段补充写入当前项目世界观。";
  if (summary.characterCount || summary.locationCount || summary.propCount) {
    msg += "\n\n候选包含：" + (summary.characterCount || 0) + " 个角色 / " + (summary.locationCount || 0) + " 个场景 / " + (summary.propCount || 0) + " 个道具。";
  }
  msg += "\n\n已存在的非空字段不会被覆盖。";
  var ok = await showConfirm("确认世界观更新", msg, "确认更新", "取消");
  if (!ok) return;
  project.worldTemplateSnapshot = snapshot;
  project.selectedWorldTemplateId = snapshot.id || project.selectedWorldTemplateId || null;
  project.pendingWorldFacts = null;
  _saveAssetsProject();
  _refreshWorldKnowledgeButtons();
  showToast("世界观更新已确认", "success");
}

function _openSaveTemplateDialog() {
  var existing = document.getElementById("saveTplDialog");
  if (existing) existing.remove();

  if (!_worldTemplatesPrimed) {
    showToast("正在加载世界观模板…", "info");
    _primeWorldTemplates().then(function () { _openSaveTemplateDialog(); });
    return;
  }

  var defaultName = (project.name || "未命名") + " · 世界观";
  var templates = _getWorldTemplates();
  var currentWorldId = (project.worldTemplateSnapshot && project.worldTemplateSnapshot.id) || project.selectedWorldTemplateId || "";
  var lockedCount = 0;
  var draftCount = 0;
  var locks = project.consistency && Array.isArray(project.consistency.characters) ? project.consistency.characters : [];
  locks.forEach(function (lock) {
    if (lock && lock.status === "locked") lockedCount += 1;
    else if (lock) draftCount += 1;
  });
  var charCount = lockedCount || ((project.assets && project.assets.characters) ? project.assets.characters.length : 0);

  var charPreviewHtml = "";
  if (project.assets && project.assets.characters) {
    project.assets.characters.slice(0, 5).forEach(function (ch) {
      var src = ch.realPhotoUrl || ch.rawUrl || ch.imageUrl || "";
      if (src) {
        charPreviewHtml += '<img src="' + escapeHtml(src) + '" class="w-10 h-10 rounded-full object-cover border-2 border-white shadow-sm -ml-2 first:ml-0" title="' + escapeHtml(ch.name) + '" />';
      }
    });
  }
  var updateOptions = templates.map(function (tpl) {
    return '<option value="' + escapeHtml(tpl.id) + '"' + (tpl.id === currentWorldId ? ' selected' : '') + '>' + escapeHtml(tpl.name || tpl.id) + '</option>';
  }).join("");

  var overlay = document.createElement("div");
  overlay.id = "saveTplDialog";
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
  overlay.style.animation = "fadeIn .2s ease";

  overlay.innerHTML =
    '<div class="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[90vw] overflow-hidden" onclick="event.stopPropagation()">' +
      '<div class="px-7 pt-7 pb-5">' +
        '<div class="flex items-center gap-3 mb-5">' +
          '<div class="w-11 h-11 rounded-xl bg-gradient-to-br from-[#5B6ABF]/15 to-[#5B6ABF]/5 flex items-center justify-center shrink-0">' +
            '<span class="material-symbols-outlined text-[#5B6ABF] text-xl">bookmark_add</span>' +
          '</div>' +
          '<div>' +
          '<h3 class="text-base font-bold text-[#1a1a1a]">保存为世界观模板</h3>' +
          '<p class="text-[11px] text-[#90A4AE] mt-0.5">保存角色与世界观参考，并记录当前风格模板偏好</p>' +
          '</div>' +
        '</div>' +
        '<div class="mb-5">' +
          '<label class="block text-[11px] font-bold text-[#607D8B] tracking-wide uppercase mb-2">模板名称</label>' +
          '<input type="text" id="saveTplNameInput" class="w-full px-4 py-3 bg-[#F8F9FA] border border-[#E0E0E0] rounded-xl text-sm text-[#1a1a1a] focus:outline-none focus:ring-2 focus:ring-[#5B6ABF]/30 focus:border-[#5B6ABF]/50 transition-all" value="' + escapeHtml(defaultName) + '" />' +
        '</div>' +
        '<div class="mb-5 bg-[#F8F9FA] rounded-xl p-4 space-y-3">' +
          '<label class="flex items-center gap-2 text-xs font-bold text-[#2C3E50]"><input type="radio" name="saveTplMode" value="create" checked />新建模板</label>' +
          '<label class="flex items-center gap-2 text-xs font-bold text-[#2C3E50] ' + (templates.length ? '' : 'opacity-40') + '"><input type="radio" name="saveTplMode" value="update" ' + (templates.length ? '' : 'disabled') + ' />更新已有模板</label>' +
          '<select id="saveTplUpdateSelect" class="w-full px-3 py-2 bg-white border border-[#E0E0E0] rounded-lg text-xs text-[#2C3E50]" ' + (templates.length ? '' : 'disabled') + '>' + updateOptions + '</select>' +
        '</div>' +
        '<div class="bg-[#F8F9FA] rounded-xl p-4 space-y-2.5">' +
          '<div class="flex items-center justify-between text-[11px]">' +
            '<span class="text-[#90A4AE] font-medium">locked 角色</span>' +
            '<div class="flex items-center gap-2">' +
              (charPreviewHtml ? '<div class="flex items-center">' + charPreviewHtml + '</div>' : '') +
              '<span class="text-[#2C3E50] font-bold">' + charCount + ' 个</span>' +
            '</div>' +
          '</div>' +
          (draftCount ? '<p class="text-[10px] text-[#8A6D3B]">另有 ' + draftCount + ' 个 draft / needs_review 角色，默认不会保存。</p>' : '') +
          '<div class="grid grid-cols-2 gap-2 pt-2 border-t border-[#E0E0E0]">' +
            '<label class="text-[11px] text-[#607D8B]"><input type="checkbox" id="saveTplIncludeCharacters" checked /> 包含角色</label>' +
            '<label class="text-[11px] text-[#607D8B]"><input type="checkbox" id="saveTplIncludeLocations" checked /> 包含场景</label>' +
            '<label class="text-[11px] text-[#607D8B]"><input type="checkbox" id="saveTplIncludeProps" checked /> 包含道具</label>' +
            '<label class="text-[11px] text-[#607D8B]"><input type="checkbox" id="saveTplIncludeTerminology" checked /> 包含术语</label>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex border-t border-[#F0F0F0]">' +
        '<button class="flex-1 py-4 text-sm font-bold text-[#90A4AE] hover:bg-[#F8F9FA] transition-colors" id="saveTplCancel">取消</button>' +
        '<button class="flex-1 py-4 text-sm font-bold text-white bg-[#2C3E50] hover:bg-[#34495E] transition-colors" id="saveTplConfirm">保存模板</button>' +
      '</div>' +
    '</div>';

  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);

  var input = overlay.querySelector("#saveTplNameInput");
  input.focus();
  input.select();

  async function submitSaveTemplate() {
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    var modeNode = overlay.querySelector('input[name="saveTplMode"]:checked');
    var mode = modeNode ? modeNode.value : "create";
    var select = overlay.querySelector("#saveTplUpdateSelect");
    var templateId = mode === "update" && select ? select.value : "";
    if (mode === "update" && !templateId) {
      showToast("请选择要更新的世界观模板", "warn");
      return;
    }
    try {
      await _doSaveWorldTemplate(name, {
        mode: mode,
        templateId: templateId,
        include: {
          characters: !!overlay.querySelector("#saveTplIncludeCharacters").checked,
          locations: !!overlay.querySelector("#saveTplIncludeLocations").checked,
          props: !!overlay.querySelector("#saveTplIncludeProps").checked,
          terminology: !!overlay.querySelector("#saveTplIncludeTerminology").checked
        }
      });
      overlay.remove();
    } catch (_) {}
  }

  overlay.querySelector("#saveTplCancel").addEventListener("click", function () { overlay.remove(); });
  overlay.querySelector("#saveTplConfirm").addEventListener("click", submitSaveTemplate);

  input.addEventListener("keydown", async function (ev) {
    if (ev.key === "Enter") {
      await submitSaveTemplate();
    }
  });
}

async function _doSaveWorldTemplate(name, options) {
  options = options || {};
  if (!project || !project.id) {
    showToast("当前项目尚未保存，无法沉淀世界观模板", "error");
    throw new Error("missing project id");
  }
  try {
    var resp = await fetch("/api/world-templates/from-project", {
      method: "POST",
      headers: Object.assign({}, _getAuthHeaders(), { "Content-Type": "application/json" }),
      body: JSON.stringify({
        projectId: project.id,
        name: name,
        mode: options.mode || "create",
        templateId: options.templateId || undefined,
        include: options.include || {}
      })
    });
    var data = await _parseWorldTemplateResponse(resp);
    var saved = data.template;
    if (saved) {
      if (!_worldTemplatesMem) _worldTemplatesMem = [];
      _worldTemplatesMem = _worldTemplatesMem.filter(function (tpl) { return tpl.id !== saved.id; });
      _worldTemplatesMem.unshift(saved);
    }
    showToast((options.mode === "update" ? "世界观模板已更新：" : "世界观模板已保存：") + "「" + name + "」", "success");
  } catch (e) {
    showToast("保存世界观模板失败：" + ((e && e.message) || e), "error");
    throw e;
  }
}

export function _applyWorldTemplate(tpl) {
  if (!project) return;

  var worldSnapshot = _attachProjectStylePreferenceToWorldSnapshot(snapshotWorldTemplate(tpl));
  project.selectedWorldTemplateId = worldSnapshot.id || tpl.id || project.selectedWorldTemplateId || null;
  project.worldTemplateSnapshot = worldSnapshot;

  if (project.shots && project.shots.length) {
    project.shots = [];
    project.shotsApproved = false;
  }
  if (project.storyboards && project.storyboards.length) {
    project.storyboards = [];
    project.imagesApproved = false;
    project.videoPromptsApproved = false;
  }

  _saveAssetsProject();

  var charCount = (tpl.characters || []).length;
  showToast("已应用世界观模板：世界观来源已记录，" + charCount + " 个角色将进入一致性对账", "success");

  _ctx.refreshOverview();
  _ctx.switchPage("assets");
}

export async function _applyWorldTemplateReferenceFromStylePage(tpl) {
  if (!project || !tpl) return;

  var full = await _loadWorldTemplateDetail(tpl);
  var worldSnapshot = _attachProjectStylePreferenceToWorldSnapshot(snapshotWorldTemplate(full || tpl));
  project.selectedWorldTemplateId = worldSnapshot.id || full.id || tpl.id || null;
  project.worldTemplateSnapshot = worldSnapshot;
  _saveAssetsProject();
  if (_ctx.refreshStylePage) _ctx.refreshStylePage();
  showToast("已关联世界观「" + ((full && full.name) || "未命名") + "」。它会作为资产候选池和内容规则参考。", "success");
}

export async function _applyWorldTemplateFromStylePage(tpl) {
  return _applyWorldTemplateReferenceFromStylePage(tpl);
}

export async function _applyStyleTemplateFromStylePage(tpl) {
  if (!project || !tpl) return;
  if (!project.styleOptions || typeof project.styleOptions !== "object") project.styleOptions = {};

  var selectedId = String(project.selectedStyleTemplateId || "");
  var tplId = String(tpl.id || "");
  if (selectedId && tplId && selectedId === tplId) {
    project.selectedStyleTemplateId = null;
    project.styleTemplateSnapshot = null;
    project.styleOptions.styleTemplateSelectionMode = "manual_clear";
    project.styleOptions.styleTemplateSelectionSource = "manual_clear";
    project.styleOptions.styleTemplateSelectedAt = new Date().toISOString();
    delete project.styleOptions.autoStyleTemplateId;
    delete project.styleOptions.autoStyleTemplateReason;
    delete project.styleOptions.autoStyleTemplateScriptKey;
    _saveAssetsProject();
    if (_ctx.refreshStylePage) _ctx.refreshStylePage();
    showToast("已清除风格模板选择", "info");
    return;
  }

  project.selectedStyleTemplateId = tpl.id || null;
  project.styleTemplateSnapshot = JSON.parse(JSON.stringify(tpl));
  project.styleOptions.styleTemplateSelectionMode = "manual";
  project.styleOptions.styleTemplateSelectionSource = "manual";
  project.styleOptions.styleTemplateSelectedAt = new Date().toISOString();
  delete project.styleOptions.autoStyleTemplateId;
  delete project.styleOptions.autoStyleTemplateReason;
  delete project.styleOptions.autoStyleTemplateScriptKey;
  _saveAssetsProject();
  if (_ctx.refreshStylePage) _ctx.refreshStylePage();
  showToast("已选择风格模板「" + ((tpl && tpl.name) || "未命名") + "」。它会参与生成风格圣经。", "success");
}

async function _deleteWorldTemplate(tplId) {
  try {
    await _deleteWorldTemplateRemote(tplId);
    showToast("世界观模板已删除", "ok");
  } catch (e) {
    showToast("删除世界观模板失败：" + ((e && e.message) || e), "error");
    throw e;
  }
}

export function _openTemplateImportModal() {
  var existing = document.getElementById("tplImportModal");
  if (existing) existing.remove();

  if (!_worldTemplatesPrimed) {
    showToast("正在加载世界观模板…", "info");
    _primeWorldTemplates().then(function () { _openTemplateImportModal(); });
    return;
  }

  var templates = _getWorldTemplates();
  if (!templates.length) {
    showToast("还没有保存过世界观模板", "warn");
    return;
  }

  var overlay = document.createElement("div");
  overlay.id = "tplImportModal";
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm";
  overlay.style.animation = "fadeIn .2s ease";

  var gridHtml = "";
  templates.forEach(function (tpl, i) {
    var charCount = typeof tpl.characterCount === "number" ? tpl.characterCount : (tpl.characters || []).length;
    var charImgs = "";
    var previewUrls = Array.isArray(tpl.characterPreviewUrls) ? tpl.characterPreviewUrls : [];
    if (!previewUrls.length) {
      previewUrls = (tpl.characters || []).slice(0, 3).map(function (ch) {
        return ch.realPhotoUrl || ch.rawUrl || ch.imageUrl || "";
      }).filter(Boolean);
    }
    previewUrls.slice(0, 3).forEach(function (src) {
      charImgs += '<img src="' + escapeHtml(src) + '" class="w-8 h-8 rounded-full object-cover border-2 border-white -ml-2 first:ml-0" />';
    });
    var date = tpl.createdAt ? new Date(tpl.createdAt).toLocaleDateString() : "";

    gridHtml +=
      '<div class="group bg-surface-container-low rounded-xl p-5 border-2 border-transparent hover:border-primary/40 transition-all duration-200">' +
        '<div class="flex items-start justify-between mb-3">' +
          '<h4 class="text-sm font-bold text-on-background truncate flex-1">' + escapeHtml(tpl.name) + '</h4>' +
          '<button class="opacity-0 group-hover:opacity-100 transition-opacity w-7 h-7 rounded-full hover:bg-error-container/30 flex items-center justify-center shrink-0 ml-2" data-tpl-delete="' + escapeHtml(tpl.id) + '" title="删除模板">' +
            '<span class="material-symbols-outlined text-error text-sm">delete_outline</span>' +
          '</button>' +
        '</div>' +
        '<p class="text-[11px] text-on-surface-variant/60 leading-relaxed mb-3">世界观参考 · ' + charCount + ' 个角色</p>' +
        '<div class="flex items-center justify-between">' +
          '<div class="flex items-center">' +
            (charImgs ? '<div class="flex items-center">' + charImgs + '</div>' : '') +
            '<span class="text-[10px] text-on-surface-variant/50 ml-2">' + charCount + ' 个角色</span>' +
          '</div>' +
          '<span class="text-[10px] text-on-surface-variant/40">' + escapeHtml(date) + '</span>' +
        '</div>' +
        '<button class="w-full mt-4 py-2.5 bg-primary text-on-primary rounded-xl text-xs font-bold tracking-wide hover:opacity-90 transition-all" data-tpl-apply="' + i + '">导入到当前项目</button>' +
      '</div>';
  });

  overlay.innerHTML =
    '<div class="bg-surface rounded-2xl shadow-2xl w-[90vw] max-w-3xl max-h-[80vh] flex flex-col overflow-hidden border border-outline-variant/10" onclick="event.stopPropagation()">' +
      '<div class="flex items-center justify-between px-6 py-4 border-b border-outline-variant/10">' +
        '<div>' +
          '<h3 class="text-lg font-bold text-on-background">从世界观模板创建</h3>' +
          '<p class="text-xs text-on-surface-variant/60 mt-0.5">选择一个模板，将关联世界观作为剧级内容参考</p>' +
        '</div>' +
        '<button class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors" id="btnCloseTplModal">' +
          '<span class="material-symbols-outlined text-on-surface-variant">close</span>' +
        '</button>' +
      '</div>' +
      '<div class="flex-1 overflow-y-auto p-6">' +
        '<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">' + gridHtml + '</div>' +
      '</div>' +
    '</div>';

  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);

  overlay.querySelector("#btnCloseTplModal").addEventListener("click", function () { overlay.remove(); });

  overlay.querySelectorAll("[data-tpl-apply]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var idx = parseInt(btn.dataset.tplApply, 10);
      var tpl = templates[idx];
      if (!tpl) return;
      showConfirm(
        "导入模板",
        "将关联世界观模板，已有镜头表和分镜将被清空，确定继续？",
        async function () {
          try {
            var full = await _loadWorldTemplateDetail(tpl);
            _applyWorldTemplate(full);
            overlay.remove();
          } catch (e) {
            showToast("加载世界观模板失败：" + ((e && e.message) || e), "error");
          }
        }
      );
    });
  });

  overlay.querySelectorAll("[data-tpl-delete]").forEach(function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var tplId = btn.dataset.tplDelete;
      showConfirm("删除模板", "确定删除这个模板？", function () {
        _deleteWorldTemplate(tplId);
        overlay.remove();
        _openTemplateImportModal();
      });
    });
  });
}

/* ================================================================
   素材库 (Library)
   ================================================================ */

export function _collectLibraryAssets(proj) {
  var assets = [];
  if (!proj) return assets;

  function _joinPublicDesc(parts) {
    return parts.map(function (v) { return (v || "").toString().trim(); })
      .filter(Boolean)
      .join(" · ")
      .slice(0, 160);
  }

  function _assetPublicDesc(item, cat) {
    if (!item) return "";
    if (item.description) return item.description;
    if (cat === "characters") {
      return _joinPublicDesc([item.role || item.identity, item.appearance, item.clothing, item.equipment, item.temperament]);
    }
    if (cat === "scenes") {
      return _joinPublicDesc([item.location, item.timeSetting, item.atmosphere, item.weather, item.lighting]);
    }
    return _joinPublicDesc([item.propType, item.material, item.features, item.function, item.ownership]);
  }

  function _shotSummaryForStoryboard(sb, idx) {
    var indices = sb && Array.isArray(sb.shotIndices) ? sb.shotIndices : [idx];
    var parts = [];
    indices.forEach(function (si) {
      var shot = proj.shots && proj.shots[si];
      if (!shot) return;
      var st = shot.shotType ? "【" + shot.shotType + "】" : "";
      var v = shot.visual || shot.description || shot.dialogue || "";
      if (v) parts.push((st + v).trim());
    });
    return _joinPublicDesc([sb && sb.visual, parts.join(" ")]);
  }

  // Helper: dump an item.imageHistory array into the library view. Each
  // historical snapshot surfaces as its own card with a "历史 vN" suffix
  // so the user can rediscover old generations even after a regen.
  function _expandHistory(item, baseName, baseCategory, baseDesc) {
    var hist = item && item.imageHistory;
    if (!Array.isArray(hist) || !hist.length) return;
    hist.forEach(function (snap, hi) {
      var u = snap && (snap.url || snap.rawUrl || snap.realPhotoUrl);
      if (u) {
        assets.push({
          type: "image",
          category: baseCategory + "·历史",
          name: baseName + " · 历史 v" + (hi + 1),
          url: u,
          description: "被覆盖的旧版本（" + (baseDesc || "") + "）",
          createdAt: snap.at || proj.createdAt || 0,
          isHistory: true,
        });
      }
      if (snap && snap.pencilUrl) {
        assets.push({
          type: "image",
          category: baseCategory + "·风格化·历史",
          name: baseName + " (风格化) · 历史 v" + (hi + 1),
          url: snap.pencilUrl,
          description: "风格化旧版本",
          createdAt: snap.at || proj.createdAt || 0,
          isHistory: true,
        });
      }
    });
  }

  if (proj.assets) {
    ["characters", "scenes", "props"].forEach(function (cat) {
      var list = proj.assets[cat] || [];
      var label = cat === "characters" ? "角色" : cat === "scenes" ? "场景" : "道具";
      list.forEach(function (item) {
        if (item.imageUrl || item.rawUrl || item.realPhotoUrl) {
          assets.push({
            type: "image",
            category: label,
            name: item.name || "未命名",
            url: item.realPhotoUrl || item.rawUrl || item.imageUrl,
            description: _assetPublicDesc(item, cat),
            createdAt: proj.createdAt || 0
          });
        }
        if (item.pencilUrl) {
          assets.push({
            type: "image",
            category: label + "·风格化",
            name: (item.name || "未命名") + " (风格化)",
            url: item.pencilUrl,
            description: "风格化版本",
            createdAt: proj.createdAt || 0
          });
        }
        _expandHistory(item, item.name || "未命名", label, _assetPublicDesc(item, cat));
      });
    });
  }
  if (proj.storyboards && proj.storyboards.length) {
    proj.storyboards.forEach(function (sb, i) {
      if (sb && sb.imageUrl) {
        var sbDesc = _shotSummaryForStoryboard(sb, i);
        assets.push({
          type: "image",
          category: "分镜",
          name: "分镜 #" + (i + 1),
          url: sb.rawUrl || sb.imageUrl,
          description: sbDesc,
          createdAt: proj.createdAt || 0
        });
      }
      if (sb && sb.videoUrl) {
        var clipDesc = _shotSummaryForStoryboard(sb, i);
        assets.push({
          type: "video",
          category: "视频片段",
          name: "片段 #" + (i + 1),
          url: sb.videoUrl,
          description: clipDesc,
          createdAt: proj.createdAt || 0
        });
      }
      _expandHistory(sb, "分镜 #" + (i + 1), "分镜", _shotSummaryForStoryboard(sb, i));
    });
  }
  if (project && proj.id === project.id) {
    _getVideoTasksForLibrary().forEach(function (t) {
      if (!(t.videoUrl || t.blobUrl)) return;
      var dominated = proj.storyboards && proj.storyboards.some(function (sb) {
        return sb && sb.videoUrl && sb.videoUrl === t.videoUrl;
      });
      if (dominated) return;
      var taskGroupIdx = t._groupIdx != null ? Number(t._groupIdx) : null;
      var taskName = Number.isFinite(taskGroupIdx) ? "片段 #" + (taskGroupIdx + 1) : "视频任务";
      var taskDesc = Number.isFinite(taskGroupIdx) ? _shotSummaryForStoryboard((proj.storyboards || [])[taskGroupIdx], taskGroupIdx) : "生成视频任务";
      assets.push({
        type: "video",
        category: "生成视频",
        name: taskName,
        url: t.blobUrl || t.videoUrl,
        description: taskDesc,
        createdAt: t.createdAt || 0
      });
    });
  }
  return assets;
}

// 项目创建时间倒序：优先 createdAt；老数据缺失时退回 updatedAt，数值(ms) 或 ISO 字符串都兼容。
function _projEntryTime(p) {
  if (!p) return 0;
  var t = (p.createdAt != null) ? p.createdAt : p.updatedAt;
  if (t == null) return 0;
  if (typeof t === "number") return t;
  var parsed = Date.parse(t);
  return isNaN(parsed) ? 0 : parsed;
}

function _projTabButtonHtml(p) {
  var active = p.id === _libActiveProject;
  var name = p.name || "未命名项目";
  return '<button type="button" class="lib-proj-btn px-6 py-2.5 rounded-xl text-xs font-bold tracking-[0.1em] uppercase transition-all duration-200 ' +
    (active
      ? 'bg-[#2C3E50] text-white shadow-lg'
      : 'bg-white/60 text-[#2C3E50] hover:bg-white/80 border border-[#CFD8DC]') +
    '" data-proj-id="' + escapeHtml(p.id) + '" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
}

// 贪心地把按钮按宽度排进若干行（和 flex-wrap 的换行算法一致），返回每行的按钮下标数组。
function _packTabRows(widths, avail) {
  var rows = [], cur = [], curW = 0;
  for (var i = 0; i < widths.length; i++) {
    var w = widths[i];
    var next = cur.length === 0 ? w : curW + _LIB_PROJ_GAP + w;
    if (cur.length && next > avail) { rows.push(cur); cur = [i]; curW = w; }
    else { cur.push(i); curW = next; }
  }
  if (cur.length) rows.push(cur);
  return rows;
}

/**
 * 素材库「项目切换」标签：最多显示两行，超出则分页。
 * Pager 显示在「全部 / 图片 / 视频」tabs 的右侧；项目标签区始终按自身全宽
 * 打包成每页两行，保证新项目排在第一页左上角。
 * 每页渲染时其余按钮 display:none，flex-wrap 会把当前页精确排成它的那两行。
 */
function _renderProjectTabs(projList) {
  _libProjList = projList || [];
  var tabsWrap = $("libProjectTabs");
  var pager = $("libProjectPager");
  if (!tabsWrap) return;

  tabsWrap.innerHTML = _libProjList.map(_projTabButtonHtml).join("");
  var btns = Array.prototype.slice.call(tabsWrap.querySelectorAll(".lib-proj-btn"));
  if (!btns.length) {
    _libProjPages = [];
    if (pager) { pager.hidden = true; pager.innerHTML = ""; }
    return;
  }

  // 容器还不可测量（页面尚未显示）→ 退化为单页不分页，后续 resize / 重进会修正。
  var fullWidth = tabsWrap.clientWidth;
  if (!fullWidth) {
    _libProjPages = [btns];
    _libProjPage = 0;
    if (pager) pager.hidden = true;
    return;
  }

  var widths = btns.map(function (b) { return b.offsetWidth; });
  var rows = _packTabRows(widths, fullWidth);
  if (rows.length <= 2) {
    _libProjPages = [btns];
    _libProjPage = 0;
    if (pager) { pager.hidden = true; pager.innerHTML = ""; }
    return;
  }

  var pages = [];
  for (var r = 0; r < rows.length; r += 2) {
    var idxs = rows[r].concat(rows[r + 1] || []);
    pages.push(idxs.map(function (i) { return btns[i]; }));
  }
  _libProjPages = pages;

  // 默认停在第 1 页（最新）；页码只随用户翻页 / resize 变化，刷新后回到第 1 页，
  // 不再自动跳到激活项目所在页（激活项目可能是较旧、在后面页的项目）。
  if (_libProjPage >= pages.length) _libProjPage = pages.length - 1;
  if (_libProjPage < 0) _libProjPage = 0;
  _applyProjectTabPage();
}

function _applyProjectTabPage() {
  var pager = $("libProjectPager");
  var pages = _libProjPages || [];
  if (pages.length <= 1) {
    if (pager) { pager.hidden = true; pager.innerHTML = ""; }
    (pages[0] || []).forEach(function (b) { b.style.display = ""; });
    return;
  }
  if (_libProjPage < 0) _libProjPage = 0;
  if (_libProjPage >= pages.length) _libProjPage = pages.length - 1;
  pages.forEach(function (pg, i) {
    var show = i === _libProjPage;
    pg.forEach(function (b) { b.style.display = show ? "" : "none"; });
  });
  _renderProjectPager();
}

function _projectPagerSequence(total, page) {
  if (total <= 4) {
    var all = [];
    for (var i = 1; i <= total; i++) all.push(i);
    return all;
  }
  if (page <= 2) return [1, 2, 3, "more-end"];
  if (page >= total - 1) return ["more-start", total - 2, total - 1, total];
  return ["more-start", page - 1, page, page + 1, "more-end"];
}

function _renderProjectPager() {
  var pager = $("libProjectPager");
  if (!pager) return;
  var total = (_libProjPages || []).length;
  if (total <= 1) {
    pager.hidden = true;
    pager.innerHTML = "";
    return;
  }

  var page = _libProjPage + 1;
  var html = "";
  html += '<button type="button" class="lib-project-pager__btn lib-project-pager__btn--nav" data-lib-proj-page-action="prev"' + (page <= 1 ? " disabled" : "") + '>上一页</button>';
  _projectPagerSequence(total, page).forEach(function (item) {
    if (typeof item === "number") {
      html += '<button type="button" class="lib-project-pager__btn' + (item === page ? " is-active" : "") + '" data-lib-proj-page="' + item + '"' + (item === page ? ' aria-current="page"' : "") + '>' + item + '</button>';
    } else {
      html += '<span class="lib-project-pager__ellipsis" aria-hidden="true">…</span>';
    }
  });
  html += '<button type="button" class="lib-project-pager__btn lib-project-pager__btn--nav" data-lib-proj-page-action="next"' + (page >= total ? " disabled" : "") + '>下一页</button>';
  pager.innerHTML = html;
  pager.hidden = false;
}

function _goProjectTabPage(pageIdx) {
  var total = (_libProjPages || []).length;
  if (!total) return;
  var next = Math.max(0, Math.min(total - 1, pageIdx));
  if (next === _libProjPage) return;
  _libProjPage = next;
  _applyProjectTabPage();
}

export async function refreshLibraryPage() {
  var projList = (_ctx && typeof _ctx.getProjectList === "function" ? _ctx.getProjectList() : []) || [];
  if (project && !projList.some(function (p) { return p.id === project.id; })) {
    projList.unshift({ id: project.id, name: project.name, createdAt: project.createdAt });
  }
  // 创建时间倒序：新项目在前、旧项目在后（配合分页：第 1 页最新，页码越大越旧）。
  projList.sort(function (a, b) { return _projEntryTime(b) - _projEntryTime(a); });
  if (!_libActiveProject && project) _libActiveProject = project.id;
  if (!_libActiveProject && projList.length) _libActiveProject = projList[0].id;

  _renderProjectTabs(projList);

  var templates = _getWorldTemplates();
  var countTpl = document.querySelector(".lib-count-template");
  if (countTpl) countTpl.textContent = String(templates.length);

  var tabs = document.querySelectorAll(".lib-tab");
  tabs.forEach(function (t) {
    var isActive = t.dataset.tab === _libActiveTab;
    t.classList.toggle("text-[#2C3E50]", isActive);
    t.classList.toggle("border-[#2C3E50]", isActive);
    t.classList.toggle("text-[#90A4AE]", !isActive);
  });

  var btnTplLib = $("btnLibWorldTemplates");
  if (btnTplLib) {
    if (_libActiveTab === "template") {
      btnTplLib.classList.remove("bg-surface-container-lowest", "text-on-surface-variant");
      btnTplLib.classList.add("bg-[#2C3E50]", "text-white", "border-[#2C3E50]");
    } else {
      btnTplLib.classList.add("bg-surface-container-lowest", "text-on-surface-variant");
      btnTplLib.classList.remove("bg-[#2C3E50]", "text-white", "border-[#2C3E50]");
    }
  }

  var typeTabs = tabs[0] && tabs[0].closest(".flex.items-center");
  var projTabsEl = $("libProjectTabs");
  var projSection = projTabsEl ? projTabsEl.closest("section") : null;
  if (_libActiveTab === "template") {
    if (typeTabs) typeTabs.hidden = true;
    if (projSection) projSection.hidden = true;
  } else {
    if (typeTabs) typeTabs.hidden = false;
    if (projSection) projSection.hidden = false;
  }

  var grid = $("libGrid");
  var tplGrid = $("libTemplateGrid");
  var empty = $("libEmpty");

  if (_libActiveTab === "template") {
    if (grid) grid.hidden = true;
    if (tplGrid) { tplGrid.hidden = false; _renderLibraryTemplates(tplGrid, templates); }
    if (empty) {
      if (templates.length === 0) { empty.hidden = false; empty.style.display = "flex"; }
      else { empty.hidden = true; }
    }
    return;
  }

  var targetProj = _libActiveProject
    ? ((_libActiveProject === (project && project.id)) ? project : await loadProjectData(_libActiveProject))
    : (project || null);
  var allAssets = _collectLibraryAssets(targetProj);

  var images = allAssets.filter(function (a) { return a.type === "image"; });
  var videos = allAssets.filter(function (a) { return a.type === "video"; });

  var countAll = document.querySelector(".lib-count-all");
  var countImg = document.querySelector(".lib-count-image");
  var countVid = document.querySelector(".lib-count-video");
  if (countAll) countAll.textContent = String(allAssets.length);
  if (countImg) countImg.textContent = String(images.length);
  if (countVid) countVid.textContent = String(videos.length);

  var filtered = _libActiveTab === "image" ? images : _libActiveTab === "video" ? videos : allAssets;
  if (grid) grid.hidden = false;
  if (tplGrid) tplGrid.hidden = true;
  if (!grid) return;

  if (filtered.length === 0) {
    grid.innerHTML = "";
    if (empty) { empty.hidden = false; empty.style.display = "flex"; }
    return;
  }
  if (empty) { empty.hidden = true; }

  var heroIdx = -1;
  for (var vi = 0; vi < filtered.length; vi++) {
    if (filtered[vi].type === "video") { heroIdx = vi; break; }
  }

  var cards = "";
  filtered.forEach(function (asset, idx) {
    var isHero = idx === heroIdx;
    var isVideo = asset.type === "video";

    var colSpan = isHero ? "col-span-1 lg:col-span-2 row-span-2" : "col-span-1";
    var aspect = isHero ? "aspect-[4/5]" : "aspect-square";

    if (isVideo) {
      cards +=
        '<div class="' + colSpan + ' relative group rounded-xl overflow-hidden bg-white/60 border border-[#CFD8DC] shadow-sm hover:shadow-2xl transition-all duration-500 cursor-pointer" data-lib-action="play-video" data-lib-url="' + escapeHtml(asset.url) + '">' +
          '<div class="' + aspect + ' relative bg-[#0B1320]">' +
            '<video src="' + escapeHtml(asset.url) + '" class="w-full h-full object-cover" preload="metadata" muted playsinline></video>' +
            '<div class="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent"></div>' +
            '<div class="absolute top-4 left-4 flex gap-2">' +
              '<span class="px-2.5 py-1 bg-white/20 backdrop-blur-md rounded-full text-[10px] font-bold text-white uppercase tracking-wider">' + escapeHtml(asset.category) + '</span>' +
            '</div>' +
            '<div class="absolute inset-0 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity duration-300">' +
              '<div class="w-16 h-16 bg-white/10 backdrop-blur-xl rounded-full flex items-center justify-center border border-white/20 transform group-hover:scale-110 transition-transform duration-300">' +
                '<span class="material-symbols-outlined text-white text-3xl" style="font-variation-settings:\'FILL\' 1">play_arrow</span>' +
              '</div>' +
            '</div>' +
            '<div class="absolute bottom-4 left-4 right-4">' +
              '<p class="text-white/60 text-[10px] font-bold tracking-widest uppercase mb-1 truncate">' + escapeHtml(asset.name) + '</p>' +
            '</div>' +
          '</div>' +
        '</div>';
    } else {
      cards +=
        '<div class="' + colSpan + ' relative group rounded-xl overflow-hidden bg-white/60 border border-[#CFD8DC] shadow-sm hover:shadow-xl transition-all duration-500 cursor-pointer" data-lib-action="view-image" data-lib-url="' + escapeHtml(asset.url) + '">' +
          '<div class="' + aspect + ' relative">' +
            '<img class="lib-img w-full h-full object-cover" src="' + escapeHtml(asset.url) + '" alt="' + escapeHtml(asset.name) + '" loading="lazy" />' +
            '<div class="lib-img-fallback hidden absolute inset-0 flex-col items-center justify-center bg-[#ECEFF1] text-[#90A4AE] pointer-events-none">' +
              '<span class="material-symbols-outlined text-3xl">broken_image</span>' +
              '<span class="text-[9px] font-bold uppercase tracking-widest mt-1">资源不可用</span>' +
            '</div>' +
            '<div class="absolute inset-0 bg-[#0B1320]/85 opacity-0 group-hover:opacity-100 transition-all duration-400 p-6 flex flex-col justify-between">' +
              '<div>' +
                '<div class="flex items-center gap-2 mb-4">' +
                  '<div class="w-2 h-2 rounded-full bg-[#CFD8DC]"></div>' +
                  '<span class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-[0.2em]">' + escapeHtml(asset.category) + '</span>' +
                '</div>' +
                '<p class="text-white/90 text-sm font-light leading-relaxed mb-3 line-clamp-4">' + escapeHtml(asset.description || asset.name) + '</p>' +
              '</div>' +
              '<div class="flex justify-between items-center">' +
                '<span class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest truncate max-w-[60%]">' + escapeHtml(asset.name) + '</span>' +
                '<div class="flex gap-3">' +
                  '<span class="material-symbols-outlined text-white/60 hover:text-white transition-colors text-lg" data-lib-action="download" data-lib-url="' + escapeHtml(asset.url) + '">download</span>' +
                  '<span class="material-symbols-outlined text-white/60 hover:text-white transition-colors text-lg" data-lib-action="view-image" data-lib-url="' + escapeHtml(asset.url) + '">zoom_in</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }
  });
  grid.innerHTML = cards;

  // 受保护图片（/api/images/file/<uuid> 等无签名路径）必须先换成带鉴权的 blob URL，
  // 否则 <img> 裸 src 直接打受保护接口会 401/403 → 浏览器破图。其余出图路径都做了
  // 这步水合，素材库历史快照卡片之前漏调用，导致「历史 vN」卡渲染成 "?"。
  hydrateProtectedImageElements(grid);

  // onerror 兜底：真正失效的 URL（过期 / 已删资产）不再显示生硬的浏览器破图，而是
  // 回落到占位；load 时再恢复，可自愈「先报错、水合后才换上 blob」的时序竞态。
  grid.querySelectorAll("img.lib-img").forEach(function (img) {
    img.addEventListener("error", function () {
      var fb = img.parentNode && img.parentNode.querySelector(".lib-img-fallback");
      if (fb) { fb.classList.remove("hidden"); fb.classList.add("flex"); }
      img.classList.add("hidden");
    });
    img.addEventListener("load", function () {
      var fb = img.parentNode && img.parentNode.querySelector(".lib-img-fallback");
      if (fb) { fb.classList.add("hidden"); fb.classList.remove("flex"); }
      img.classList.remove("hidden");
    });
  });
}

function _renderLibraryTemplates(container, templates) {
  if (!container) return;
  if (!templates.length) { container.innerHTML = ""; return; }

  var html = "";
  templates.forEach(function (tpl, i) {
    var charCount = typeof tpl.characterCount === "number" ? tpl.characterCount : (tpl.characters || []).length;
    var charImgs = "";
    var previewUrls = Array.isArray(tpl.characterPreviewUrls) ? tpl.characterPreviewUrls : [];
    if (!previewUrls.length) {
      previewUrls = (tpl.characters || []).slice(0, 4).map(function (ch) {
        return ch.realPhotoUrl || ch.rawUrl || ch.imageUrl || "";
      }).filter(Boolean);
    }
    previewUrls.slice(0, 4).forEach(function (src) {
      charImgs += '<img src="' + escapeHtml(src) + '" class="w-9 h-9 rounded-full object-cover border-2 border-white -ml-2 first:ml-0 shadow-sm" />';
    });
    var date = tpl.createdAt ? new Date(tpl.createdAt).toLocaleDateString() : "";

    html +=
      '<div class="group bg-white/60 rounded-xl p-6 border border-[#CFD8DC] shadow-sm hover:shadow-xl transition-all duration-300">' +
        '<div class="flex items-start justify-between mb-4">' +
          '<div class="flex items-center gap-3">' +
            '<div class="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shrink-0">' +
              '<span class="material-symbols-outlined text-primary text-lg">auto_stories</span>' +
            '</div>' +
            '<div>' +
              '<h4 class="text-sm font-bold text-[#2C3E50] truncate max-w-[200px]">' + escapeHtml(tpl.name) + '</h4>' +
              '<p class="text-[10px] text-[#90A4AE]">' + escapeHtml(date) + '</p>' +
            '</div>' +
          '</div>' +
          '<button class="opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 rounded-full hover:bg-red-50 flex items-center justify-center" data-tpl-lib-del="' + escapeHtml(tpl.id) + '" title="删除模板">' +
            '<span class="material-symbols-outlined text-[#e53935] text-base">delete_outline</span>' +
          '</button>' +
        '</div>' +
        '<div class="flex items-center justify-between mb-4">' +
          '<div class="flex items-center gap-3">' +
            '<div class="flex items-center gap-1.5 text-[10px] text-[#90A4AE]">' +
              '<span class="material-symbols-outlined text-xs">person</span>' + charCount + ' 角色' +
            '</div>' +
          '</div>' +
          (charImgs ? '<div class="flex items-center ml-2">' + charImgs + '</div>' : '') +
        '</div>' +
        '<button class="w-full py-2.5 bg-[#2C3E50] text-white rounded-xl text-xs font-bold tracking-wide hover:bg-[#34495E] transition-colors" data-tpl-lib-apply="' + i + '">导入到当前项目</button>' +
      '</div>';
  });
  container.innerHTML = html;

  container.querySelectorAll("[data-tpl-lib-del]").forEach(function (btn) {
    btn.addEventListener("click", async function (ev) {
      ev.stopPropagation();
      if (!confirm("确定删除这个模板？")) return;
      try {
        await _deleteWorldTemplate(btn.dataset.tplLibDel);
        refreshLibraryPage();
      } catch (_) {}
    });
  });

  container.querySelectorAll("[data-tpl-lib-apply]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var idx = parseInt(btn.dataset.tplLibApply, 10);
      var tpl = templates[idx];
      if (!tpl) return;
      if (!confirm("导入模板将关联世界观，已有的镜头表和分镜将被清空，确定继续？")) return;
      try {
        var full = await _loadWorldTemplateDetail(tpl);
        _applyWorldTemplate(full);
      } catch (e) {
        showToast("加载世界观模板失败：" + ((e && e.message) || e), "error");
      }
    });
  });
}

export function _initLibraryEvents() {
  var tabsWrap = $("libProjectTabs");
  if (tabsWrap) {
    tabsWrap.addEventListener("click", function (e) {
      var btn = e.target.closest(".lib-proj-btn");
      if (!btn) return;
      _libActiveProject = btn.dataset.projId;
      refreshLibraryPage();
    });
  }

  var projPager = $("libProjectPager");
  if (projPager && !projPager.dataset.bound) {
    projPager.dataset.bound = "1";
    projPager.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-lib-proj-page-action], [data-lib-proj-page]");
      if (!btn || btn.disabled) return;
      var action = btn.dataset.libProjPageAction;
      if (action === "prev") {
        _goProjectTabPage(_libProjPage - 1);
        return;
      }
      if (action === "next") {
        _goProjectTabPage(_libProjPage + 1);
        return;
      }
      var page = parseInt(btn.dataset.libProjPage || "", 10);
      if (!isNaN(page)) _goProjectTabPage(page - 1);
    });
  }

  // 容器宽度变化会改变每两行能放下的按钮数，需重新分页（防抖）。
  if (!_libProjPagerBound) {
    _libProjPagerBound = true;
    var _projResizeTimer = null;
    window.addEventListener("resize", function () {
      if (_projResizeTimer) clearTimeout(_projResizeTimer);
      _projResizeTimer = setTimeout(function () {
        var pageEl = $("pageLibrary");
        if (!pageEl || pageEl.hidden || !_libProjList.length) return;
        _renderProjectTabs(_libProjList);
      }, 150);
    });
  }

  document.querySelectorAll(".lib-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      _libActiveTab = this.dataset.tab;
      refreshLibraryPage();
    });
  });

  var btnTplLib = $("btnLibWorldTemplates");
  if (btnTplLib) {
    btnTplLib.addEventListener("click", function () {
      _libActiveTab = (_libActiveTab === "template") ? "all" : "template";
      refreshLibraryPage();
    });
  }

  var grid = $("libGrid");
  if (grid) {
    grid.addEventListener("click", function (e) {
      var target = e.target.closest("[data-lib-action]");
      if (!target) {
        target = e.target.closest("[data-lib-url]");
        if (!target) return;
      }
      var action = target.dataset.libAction;
      var url = target.dataset.libUrl;
      if (!url) return;

      if (action === "view-image") {
        _openLightbox(url);
      } else if (action === "play-video") {
        _openVideoLightbox(url);
      } else if (action === "download") {
        e.stopPropagation();
        var a = document.createElement("a");
        a.href = url;
        a.download = "";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
  }
}

export function _openVideoLightbox(videoUrl) {
  var existing = document.getElementById("videoLightbox");
  if (existing) existing.remove();

  var overlay = document.createElement("div");
  overlay.id = "videoLightbox";
  overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer";
  overlay.style.animation = "fadeIn .2s ease";
  overlay.innerHTML =
    '<div class="relative w-[85vw] max-w-[1200px] rounded-2xl overflow-hidden shadow-2xl bg-black" onclick="event.stopPropagation()">' +
      '<video src="' + escapeHtml(videoUrl) + '" class="w-full max-h-[80vh]" controls autoplay playsinline></video>' +
      '<button class="absolute top-3 right-3 w-10 h-10 bg-black/40 backdrop-blur rounded-full flex items-center justify-center text-white hover:bg-black/60 transition-colors" onclick="this.closest(\'#videoLightbox\').remove()">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  overlay.addEventListener("click", function () { overlay.remove(); });
  document.body.appendChild(overlay);

  var vidEl = overlay.querySelector("video");
  if (vidEl) {
    vidEl.addEventListener("error", function () {
      vidEl.outerHTML =
        '<div class="flex flex-col items-center justify-center py-20 text-white/60">' +
          '<span class="material-symbols-outlined text-5xl mb-3">error</span>' +
          '<p class="text-sm mb-3">视频加载失败（可能受跨域限制）</p>' +
          '<a href="' + escapeHtml(videoUrl) + '" target="_blank" class="text-blue-400 underline text-sm">点击在线播放</a>' +
        '</div>';
    });
  }
}


/* ── 上下游同步：编辑后保持数据一致性 ── */

export function _syncAssetToStyleBible(type, idx) {
  if (!project || !project.styleBible) return;
  apiPost("/api/orchestration/sync-upstream", {
    type: type,
    idx: idx,
    project: { styleBible: project.styleBible, assets: project.assets },
  }).then(function (resp) {
    if (resp.styleBible) {
      project.styleBible = resp.styleBible;
      _saveAssetsProject();
      if (_ctx.refreshStylePage) _ctx.refreshStylePage();
    }
  }).catch(function (e) {
    console.warn("[SyncUpstream] backend sync failed:", e);
  });
}

export function _getAssetDescText(type, idx) {
  if (!project || !project.assets) return "";
  var list = type === "char" ? project.assets.characters : type === "scene" ? project.assets.scenes : project.assets.props;
  var item = list && list[idx];
  if (!item) return "";
  if (type === "char") {
    var parts = [];
    if (item.appearance) parts.push(item.appearance);
    if (item.clothing) parts.push(item.clothing);
    if (item.equipment) parts.push(item.equipment);
    return parts.join(" | ");
  }
  if (type === "scene") {
    var sceneParts = [];
    if (item.description) sceneParts.push(item.description);
    if (item.location) sceneParts.push("地点：" + item.location);
    if (item.timeSetting) sceneParts.push("时间：" + item.timeSetting);
    if (item.atmosphere) sceneParts.push("氛围：" + item.atmosphere);
    return sceneParts.join(" | ");
  }
  return item.description || "";
}

export function _getAssetName(type, idx) {
  if (!project || !project.assets) return "";
  var list = type === "char" ? project.assets.characters : type === "scene" ? project.assets.scenes : project.assets.props;
  return (list && list[idx] && list[idx].name) || "";
}

var _scriptSyncPending = false;

export async function _autoSyncUpstream(type, idx, oldDesc) {
  _syncAssetToStyleBible(type, idx);
  if (project.styleBible && _ctx.refreshStylePage) _ctx.refreshStylePage();

  var assetName = _getAssetName(type, idx);
  var newDesc = _getAssetDescText(type, idx);
  if (!assetName || !newDesc || !project.script) return;

  if (_scriptSyncPending) return;
  _scriptSyncPending = true;
  try {
    var resp = await fetch("/api/agent/patch-script", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({
        script: project.script,
        assetName: assetName,
        oldDesc: oldDesc || "",
        newDesc: newDesc,
      }),
    }).then(function (r) { return r.json(); });

    if (resp.script && resp.script !== project.script) {
      project.script = resp.script;
      _saveAssetsProject();
      _ctx.refreshScriptPage();
      showToast("剧本中「" + assetName + "」的描述已自动更新", "ok");
    }
  } catch (e) {
    console.warn("[AutoSyncUpstream] script patch failed:", e);
  } finally {
    _scriptSyncPending = false;
  }
}

export async function _checkEquipmentChange(charIdx, oldDescText) {
  if (!project || !project.assets) return;
  if (!project.assets.characters || !project.assets.characters[charIdx]) return;

  var diff;
  try {
    diff = await apiPost('/api/assets/check-equipment-change', {
      project: { assets: project.assets },
      charIdx: charIdx,
      oldDescText: oldDescText || '',
    });
  } catch (e) {
    console.warn('[CheckEquip] backend call failed:', e);
    return;
  }

  var added = diff.added || [];
  var removed = diff.removed || [];
  var charName = diff.charName || '';
  if (!added.length && !removed.length) return;

  var msgParts = [];
  if (removed.length) {
    msgParts.push("旧道具可移除：" + removed.map(function (r) { return "「" + r.name + "」"; }).join("、"));
  }
  if (added.length) {
    msgParts.push("新装备可添加为道具：" + added.map(function (a) { return "「" + a + "」"; }).join("、"));
  }

  var box = $("agentMessages");
  if (!box) return;

  var tipDiv = document.createElement("div");
  tipDiv.className = "agent-msg agent-msg--ai";
  tipDiv.innerHTML =
    '<div class="agent-msg-bubble" style="font-size:12px;background:#FFF3E0;border:1px solid #FFE0B2">' +
      '<div style="font-weight:700;margin-bottom:4px;color:#E65100">道具变更提醒</div>' +
      '<div style="color:#5D4037">' + escapeHtml(msgParts.join("；")) + '</div>' +
      '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        (removed.length ? '<button type="button" class="agent-action-apply" id="_propRemoveBtn" style="font-size:11px">移除旧道具</button>' : '') +
        (added.length ? '<button type="button" class="agent-action-apply" id="_propAddBtn" style="font-size:11px">添加新道具</button>' : '') +
      '</div>' +
    '</div>';
  box.appendChild(tipDiv);

  var removeBtn = tipDiv.querySelector("#_propRemoveBtn");
  if (removeBtn) {
    removeBtn.addEventListener("click", function () {
      removed.sort(function (a, b) { return b.idx - a.idx; });
      removed.forEach(function (r) { project.assets.props.splice(r.idx, 1); });
      _saveAssetsProject();
      refreshAssetsPage();
      showToast("已移除 " + removed.length + " 个旧道具", "ok");
      removeBtn.textContent = "已移除 ✓";
      removeBtn.disabled = true;
    });
  }

  var addBtn = tipDiv.querySelector("#_propAddBtn");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      added.forEach(function (name) {
        project.assets.props.push({
          name: name,
          description: charName + "的" + name,
          ownership: charName,
          propType: "携带道具",
          features: "",
          imagePrompt: "",
          imageUrl: "",
          _descEdited: true,
        });
      });
      _saveAssetsProject();
      refreshAssetsPage();
      showToast("已添加 " + added.length + " 个新道具，请补充描述后生成参考图", "ok");
      addBtn.textContent = "已添加 ✓";
      addBtn.disabled = true;
    });
  }

  _agentScrollBottom();
}

export async function _detectObsoleteAssets() {
  if (!project || !project.assets) return [];
  try {
    var resp = await apiPost("/api/orchestration/detect-obsolete", {
      project: { assets: project.assets, shots: project.shots },
    });
    return resp.obsolete || [];
  } catch (e) {
    console.warn("[DetectObsolete] backend call failed:", e);
    return [];
  }
}

export function _removeObsoleteAssets(items) {
  if (!project || !project.assets || !items.length) return;
  var propIdxToRemove = {};
  var sceneIdxToRemove = {};
  items.forEach(function (item) {
    if (item.type === "prop") propIdxToRemove[item.idx] = true;
    if (item.type === "scene") sceneIdxToRemove[item.idx] = true;
  });
  if (Object.keys(propIdxToRemove).length && project.assets.props) {
    project.assets.props = project.assets.props.filter(function (_, i) { return !propIdxToRemove[i]; });
  }
  if (Object.keys(sceneIdxToRemove).length && project.assets.scenes) {
    project.assets.scenes = project.assets.scenes.filter(function (_, i) { return !sceneIdxToRemove[i]; });
  }
  _saveAssetsProject();
  renderAssets();
  _showAssetActions();
}

export async function _showCleanObsoleteDialog() {
  var items = await _detectObsoleteAssets();
  if (!items.length) {
    showToast("未检测到过时资产", "ok");
    return;
  }
  var existing = document.getElementById("obsoleteCleanModal");
  if (existing) existing.remove();

  var overlay = document.createElement("div");
  overlay.id = "obsoleteCleanModal";
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm";
  overlay.style.animation = "fadeIn .2s ease";

  var listHtml = "";
  items.forEach(function (obs, i) {
    var typeLabel = obs.type === "prop" ? "道具" : "场景";
    var icon = obs.type === "prop" ? "handyman" : "landscape";
    listHtml +=
      '<label class="flex items-start gap-3 p-3 rounded-lg hover:bg-surface-container transition-colors cursor-pointer">' +
        '<input type="checkbox" checked data-clean-idx="' + i + '" class="mt-0.5 accent-[#e65100]" />' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center gap-2">' +
            '<span class="material-symbols-outlined text-sm text-on-surface-variant/40">' + icon + '</span>' +
            '<span class="text-sm font-bold text-on-background">' + typeLabel + '「' + escapeHtml(obs.name) + '」</span>' +
          '</div>' +
          '<p class="text-[11px] text-on-surface-variant/60 mt-0.5">' + escapeHtml(obs.reasons.join("；")) + '</p>' +
        '</div>' +
      '</label>';
  });

  overlay.innerHTML =
    '<div class="bg-surface rounded-2xl shadow-2xl w-[90vw] max-w-lg max-h-[70vh] flex flex-col overflow-hidden border border-outline-variant/10" onclick="event.stopPropagation()">' +
      '<div class="px-6 py-4 border-b border-outline-variant/10">' +
        '<h3 class="text-lg font-bold text-on-background flex items-center gap-2"><span class="material-symbols-outlined text-[#e65100]">delete_sweep</span>清理过时资产</h3>' +
        '<p class="text-xs text-on-surface-variant/60 mt-1">以下资产可能已不再需要（归属角色不存在或无分镜引用）。勾选后确认移除。</p>' +
      '</div>' +
      '<div class="flex-1 overflow-y-auto px-6 py-3">' + listHtml + '</div>' +
      '<div class="flex justify-end gap-3 px-6 py-4 border-t border-outline-variant/10">' +
        '<button type="button" id="_cleanCancel" class="px-5 py-2 text-xs font-bold text-on-surface-variant rounded-lg hover:bg-surface-container transition-colors">取消</button>' +
        '<button type="button" id="_cleanConfirm" class="px-5 py-2 text-xs font-bold text-white bg-[#e65100] rounded-lg hover:opacity-90 transition-colors">确认清理</button>' +
      '</div>' +
    '</div>';

  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);

  overlay.querySelector("#_cleanCancel").addEventListener("click", function () { overlay.remove(); });
  overlay.querySelector("#_cleanConfirm").addEventListener("click", function () {
    var toRemove = [];
    overlay.querySelectorAll("[data-clean-idx]").forEach(function (cb) {
      if (cb.checked) {
        var ci = parseInt(cb.dataset.cleanIdx, 10);
        if (items[ci]) toRemove.push(items[ci]);
      }
    });
    if (toRemove.length) {
      _removeObsoleteAssets(toRemove);
      showToast("已清理 " + toRemove.length + " 个过时资产", "ok");
    }
    overlay.remove();
  });
}

export function _markDownstreamStale(scope, detail) {
  if (!project) return;
  if (!project._staleFlags) project._staleFlags = {};
  apiPost("/api/orchestration/compute-stale", {
    scope: scope,
    detail: detail,
    project: { styleBible: project.styleBible, shots: project.shots, storyboards: project.storyboards, assets: project.assets },
  }).then(function (resp) {
    if (resp.staleFlags) {
      _applyServerStaleFlagsToProject(project, ["asset_img_", "storyboard_", "tail_frame_"], resp.staleFlags);
      Object.keys(resp.staleFlags).forEach(function (k) {
        // Managed prefixes were mirrored above; other stale families keep their additive semantics.
        if (/^(asset_img_|storyboard_|tail_frame_)/.test(k)) return;
        if (resp.staleFlags[k]) project._staleFlags[k] = true;
      });
    }
    _saveAssetsProject();
  }).catch(function (e) {
    console.warn("[Stale] backend compute failed, using fallback:", e);
    _markDownstreamStaleFallback(scope, detail);
    _saveAssetsProject();
  });
}

export function _markDownstreamStaleFallback(scope, detail) {
  if (scope === "asset") {
    project._staleFlags["asset_img_" + detail.type + "_" + detail.idx] = true;
  } else if (scope === "shot") {
    project._staleFlags["shot_prompt_" + detail.idx] = true;
  } else if (scope === "script") {
    project._staleFlags["style_bible"] = true;
    project._staleFlags["assets"] = true;
  } else if (scope === "style_bible") {
    var shots1 = (project.shots || []);
    for (var si1 = 0; si1 < shots1.length; si1++) {
      if (shots1[si1].imagePromptGenerated) project._staleFlags["shot_prompt_" + si1] = true;
    }
    var sbs1 = (project.storyboards || []);
    for (var gi1 = 0; gi1 < sbs1.length; gi1++) {
      if (sbs1[gi1] && sbs1[gi1].imageUrl) project._staleFlags["storyboard_" + gi1] = true;
      if (sbs1[gi1] && sbs1[gi1].videoPrompt) project._staleFlags["video_prompt_" + gi1] = true;
    }
  } else if (scope === "emotion") {
    var shots2 = (project.shots || []);
    for (var si2 = 0; si2 < shots2.length; si2++) {
      project._staleFlags["shot_" + si2] = true;
      if (shots2[si2].imagePromptGenerated) project._staleFlags["shot_prompt_" + si2] = true;
    }
    var sbs2 = (project.storyboards || []);
    for (var gi2 = 0; gi2 < sbs2.length; gi2++) {
      if (sbs2[gi2] && sbs2[gi2].imageUrl) project._staleFlags["storyboard_" + gi2] = true;
      if (sbs2[gi2] && sbs2[gi2].videoPrompt) project._staleFlags["video_prompt_" + gi2] = true;
    }
  }
}

export function _getShotGroupIndices() {
  var map = {};
  if (!project || !project.shots) return map;
  var groups = _ctx.getStoryboardGroups();
  groups.forEach(function (g) {
    g.shotIndices.forEach(function (si) { map[si] = g.groupIdx; });
  });
  return map;
}

export function _isStale(key) {
  return project && project._staleFlags && project._staleFlags[key];
}

export function _clearStale(key) {
  if (project && project._staleFlags) {
    delete project._staleFlags[key];
    _saveAssetsProject();
  }
}
