import { $, escapeHtml, showToast, showConfirm, apiPost, apiGet, apiPostStream, consumeStreamStepTags, ApiError, getAuthHeaders, hydrateProtectedImageElements } from './utils.js';
import { loadProjectData } from './project.js';
import { subscribeBatch, subscribeTask } from './backend_stream.js';
import { renderAssetCard } from './render_hooks.js';
import { attachShotsBatch } from './shots.js';
import { reattachStoryboardBatches } from './storyboard.js';
import { showBillingPaywall } from './billing.js';

const _getAuthHeaders = getAuthHeaders;

var _ctx = {};
var project = null;

export function initAssets(ctx) { _ctx = ctx; }
export function syncAssetsProject(p) { project = p; }
export function resetLibraryState() { _libActiveProject = null; _libActiveTab = "all"; }

var _assetsExtracting = false;
var _assetImagesGenerating = false;
var _assetGenStatus = {};
var _pendingAssetRerender = false;
var _assetStyleStaleSyncing = false;
var _assetStyleStaleSyncKey = "";
var _libActiveProject = null;
var _libActiveTab = "all";
var ASSET_ENTRANCE_ANIM_MS = 1400;
var _assetEntranceClearTimer = null;

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
  if (!project || !project.scriptApproved) {
    need.hidden = false;
    if (ready) ready.hidden = true;
    if (content) content.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    if (knowledgeBtn) knowledgeBtn.hidden = true;
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
    _syncAssetStyleStaleFlags();
    _showAssetActions();
    checkAssetsConfirm();
    _updateStylizeBadge();
  } else {
    if (content) content.hidden = true;
    var banner = $("assetsExtractBanner");
    if (banner) banner.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    if (knowledgeBtn) knowledgeBtn.hidden = true;
  }
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
      proj.assets = resp.assets;
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

  _injectAssetStaleBadges();
  if (preserveScroll) {
    requestAnimationFrame(function () {
      if (!pageEl || pageEl.hidden) return;
      pageEl.scrollTop = prevScrollTop;
      pageEl.scrollLeft = prevScrollLeft;
    });
  }
}

function _injectAssetStaleBadges() {
  if (!project || !project.assets) return;
  ["scene", "prop"].forEach(function (tp) {
    var list = tp === "scene" ? project.assets.scenes : project.assets.props;
    if (!list) return;
    var gridId = tp === "scene" ? "assetSceneGrid" : "assetPropGrid";
    var container = $(gridId);
    if (!container) return;
    list.forEach(function (_, i) {
      if (_ctx.isStale("asset_img_" + tp + "_" + i)) {
        var cardEl = container.querySelector('[data-type="' + tp + '"][data-idx="' + i + '"]');
        if (cardEl && !cardEl.querySelector(".stale-badge")) {
          var badge = document.createElement("span");
          badge.className = "stale-badge";
          badge.title = "该资产图基于的风格圣经或风格锁版本与当前不一致，可按需重新生成";
          badge.textContent = "需更新";
          badge.style.cssText = "position:absolute;top:8px;left:8px;z-index:5;";
          cardEl.style.position = "relative";
          cardEl.appendChild(badge);
        }
      }
    });
  });
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

function _styleBibleSyncFingerprint() {
  try {
    return JSON.stringify(project && project.styleBible ? project.styleBible : {});
  } catch (_e) {
    return "";
  }
}

function _assetStyleSyncKey() {
  if (!project || !project.assets) return "";
  return [
    project.id || "",
    project.styleBibleGeneratedAt || "",
    project.styleBibleManuallyEditedAt || "",
    project.styleBibleSourceHash || "",
    project.styleBibleSource || "",
    _styleBibleSyncFingerprint(),
    (project.assets.characters || []).length,
    (project.assets.scenes || []).length,
    (project.assets.props || []).length
  ].join("|");
}

function _syncAssetStyleStaleFlags() {
  if (!project || !project.assets || _assetStyleStaleSyncing) return;
  var key = _assetStyleSyncKey();
  if (!key || key === _assetStyleStaleSyncKey) return;
  _assetStyleStaleSyncing = true;
  _assetStyleStaleSyncKey = key;
  var body = project.id
    ? { projectId: project.id }
    : { project: { styleBible: project.styleBible, shots: project.shots, storyboards: project.storyboards, assets: project.assets } };
  apiPost("/api/orchestration/compute-stale", body).then(function (resp) {
    var staleFlags = resp && resp.staleFlags;
    if (!staleFlags) return;
    var changed = _applyServerStaleFlagsToProject(project, "asset_img_", staleFlags);
    if (changed) {
      _ctx.saveProject();
      renderAssets();
    }
  }).catch(function (e) {
    console.warn("[AssetStyleStale] sync failed:", e);
  }).finally(function () {
    _assetStyleStaleSyncing = false;
  });
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

function _characterReferenceFailureMessage(lastError) {
  if (!lastError || typeof lastError !== "object") {
    return "本次角色图未通过参考图切片，未用于后续镜头/视频引用";
  }
  if (lastError.message) {
    return "参考图切片失败：" + String(lastError.message);
  }
  if (lastError.cropMethod === "percent-fallback") {
    return "模型背景不够纯白或 panel 边界不可靠，未用于后续镜头/视频引用";
  }
  if (Array.isArray(lastError.unusablePanels) && lastError.unusablePanels.length) {
    return "部分角色视图切片不可用（" + lastError.unusablePanels.join("、") + "），未用于后续镜头/视频引用";
  }
  return "本次角色图未通过参考图切片，未用于后续镜头/视频引用";
}

export function deriveAssetCardState(item) {
  item = item || {};
  var reference = (item.reference && typeof item.reference === "object") ? item.reference : {};
  var mainImageUrl = item.realPhotoUrl || item.rawUrl || item.imageUrl || "";
  var failed = reference.status === "failed";
  return {
    status: failed ? "failed" : (mainImageUrl ? "ready" : "missing"),
    mainImageUrl: mainImageUrl,
    thumbnailUrl: mainImageUrl,
    failedAttemptUrl: failed ? (reference.lastAttemptUrl || "") : "",
    statusLabel: failed ? "生成失败" : (mainImageUrl ? "已完成" : "待生成"),
    statusMessage: failed ? _characterReferenceFailureMessage(reference.lastError) : "",
  };
}

function _renderCharCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.className = "asset-card group relative bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500";
    card.dataset.type = "char";
    card.dataset.idx = idx;

    var cardState = deriveAssetCardState(item);
    var imgSrc = cardState.mainImageUrl || '';

    var imgHtml = '';
    if (imgSrc) {
      imgHtml = '<img src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(item.name) + '" class="w-full h-full object-cover object-[left_top] transform group-hover:scale-105 transition-transform duration-700" />';
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

    var isAssetStale = _ctx.isStale("asset_img_char_" + idx);
    var statusHtml = '';
    if (cardState.status === "failed") {
      var staleFailedTag = isAssetStale ? '<span class="stale-badge" title="该资产图基于的风格圣经或风格锁版本与当前不一致，可按需重新生成">需更新</span>' : '';
      var failedPreview = cardState.failedAttemptUrl
        ? '<div class="w-full aspect-square rounded-lg overflow-hidden bg-[#ECEFF1] cursor-pointer hover:ring-2 hover:ring-red-400/30 transition-all" data-action="zoom-img" data-img="' + escapeHtml(cardState.failedAttemptUrl) + '">' +
            '<img src="' + escapeHtml(cardState.failedAttemptUrl) + '" class="w-full h-full object-cover object-[left_top] opacity-85" />' +
          '</div>'
        : '<div class="w-full aspect-square rounded-lg bg-red-500/5 border border-red-500/20 flex items-center justify-center text-red-400 text-[11px] font-bold">无失败图预览</div>';
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">参考图</span><span class="text-[10px] font-bold text-red-500">' + escapeHtml(cardState.statusLabel) + staleFailedTag + '</span></div>' +
        failedPreview +
        '<p class="mt-2 text-[11px] leading-relaxed text-red-500/80">' + escapeHtml(cardState.statusMessage) + '</p>';
    } else if (imgSrc) {
      var staleTag = isAssetStale ? '<span class="stale-badge" title="该资产图基于的风格圣经或风格锁版本与当前不一致，可按需重新生成">需更新</span>' : '';
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">三视图</span><span class="text-[10px] font-bold text-primary">已完成' + staleTag + '</span></div>' +
        '<div class="w-full aspect-square rounded-lg overflow-hidden bg-[#ECEFF1] cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all" data-action="zoom-img" data-img="' + escapeHtml(imgSrc) + '">' +
          '<img src="' + escapeHtml(imgSrc) + '" class="w-full h-full object-cover object-[right_center]" />' +
        '</div>';
    } else {
      statusHtml =
        '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">参考图</span><span class="text-[10px] font-bold text-on-surface-variant/40">待生成</span></div>';
    }

    card.innerHTML =
      '<div class="flex flex-col md:flex-row h-full min-h-[360px]">' +
        '<div class="w-full md:w-[45%] relative h-72 md:h-auto overflow-hidden rounded-lg cursor-pointer" data-action="zoom-img" data-img="' + escapeHtml(imgSrc) + '">' +
          imgHtml +
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
              '<textarea class="asset-desc-edit hidden w-full text-[11px] text-on-surface-variant leading-relaxed bg-surface-container-lowest border border-outline-variant/20 rounded-lg p-2 mt-1 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30" rows="4">' + escapeHtml(desc.slice(0, 300)) + '</textarea>' +
            '</div>' +
            tagsHtml +
            '<div class="p-3 bg-surface-container-lowest rounded-lg border border-outline-variant/10 mt-5">' + statusHtml + '</div>' +
          '</div>' +
          '<div class="flex gap-3 mt-5">' +
            '<button type="button" class="flex-1 py-3 bg-primary text-on-primary rounded-full font-bold text-[11px] tracking-wider uppercase hover:shadow-lg transition-all" data-action="regen-asset">重新生成</button>' +
            _ctx.historyBtnHtml(item, "pill-dark") +
            '<button type="button" class="p-3 bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all" data-action="ref-agent" title="引用到 AI 助手"><span class="material-symbols-outlined text-on-surface text-lg">alternate_email</span></button>' +
            '<button type="button" class="p-3 bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all" data-action="edit-asset"><span class="material-symbols-outlined text-on-surface text-lg">edit</span></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    container.appendChild(card);
  });
}

function _renderSceneCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.dataset.type = "scene";
    card.dataset.idx = idx;

    var imgSrc = item.rawUrl || item.imageUrl || '';
    var isMain = !!item.isMain || idx === 0;
    var imageAttrs = imgSrc ? ' data-action="zoom-img" data-img="' + escapeHtml(imgSrc) + '"' : '';
    var imageClass = imgSrc ? ' cursor-pointer' : '';
    var imgHtml = imgSrc
      ? '<img src="' + escapeHtml(imgSrc) + '" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />'
      : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-4xl text-on-surface-variant/15">landscape</span></div>';

    var metaTags = '';
    if (item.timeSetting) metaTags += '<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant"><span class="material-symbols-outlined text-xs">schedule</span>' + escapeHtml(item.timeSetting) + '</span>';
    if (item.atmosphere) metaTags += '<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant"><span class="material-symbols-outlined text-xs">cloud</span>' + escapeHtml(item.atmosphere.split(/[,，]/).slice(0, 2).join(', ')) + '</span>';

    card.className = "asset-card group bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500";
    card.innerHTML =
      '<div class="relative aspect-[16/9] rounded-lg overflow-hidden' + imageClass + '"' + imageAttrs + '>' +
        imgHtml +
        '<div class="asset-card-loading absolute inset-0 flex items-center justify-center bg-surface/80 z-10"' + (_assetGenStatus["scene_" + idx] ? '' : ' hidden') + '><div class="tc-spinner"></div></div>' +
        '<div class="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/65 via-black/20 to-transparent">' +
          '<div class="flex items-center gap-2">' +
            (isMain ? '<span class="bg-primary/90 text-on-primary px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest">主场景</span>' : '') +
            (item.location ? '<span class="text-[11px] font-medium text-white/80 truncate">' + escapeHtml(item.location) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="p-4">' +
        '<div class="flex items-start justify-between gap-3">' +
          '<div class="min-w-0">' +
            '<h4 class="text-base font-bold tracking-tight text-on-background truncate">' + escapeHtml(item.name || '场景') + '</h4>' +
            (item.description ? '<p class="text-[11px] text-on-surface-variant/60 mt-1.5 leading-relaxed max-h-10 overflow-hidden">' + escapeHtml(item.description.slice(0, 120)) + '</p>' : '') +
          '</div>' +
          '<div class="flex gap-1.5 shrink-0">' +
            (imgSrc ? '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="zoom-img" data-img="' + escapeHtml(imgSrc) + '"><span class="material-symbols-outlined text-on-surface text-sm">zoom_in</span></button>' : '') +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="ref-agent" title="引用到 AI 助手"><span class="material-symbols-outlined text-on-surface text-sm">alternate_email</span></button>' +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="regen-asset" title="重新生成"><span class="material-symbols-outlined text-on-surface text-sm">refresh</span></button>' +
            _ctx.historyBtnHtml(item, "chip") +
            '<button type="button" class="w-8 h-8 bg-surface-container-highest/30 hover:bg-surface-container-highest rounded-full flex items-center justify-center transition-colors" data-action="edit-asset" title="编辑"><span class="material-symbols-outlined text-on-surface text-sm">edit</span></button>' +
          '</div>' +
        '</div>' +
        (metaTags ? '<div class="flex flex-wrap gap-3 mt-3">' + metaTags + '</div>' : '') +
      '</div>';
    container.appendChild(card);
  });
}

function _renderPropCards(container, items) {
  items.forEach(function (item, idx) {
    var card = document.createElement("div");
    card.className = "asset-card group relative bg-surface-container-low rounded-xl p-5 flex flex-col justify-between border border-transparent hover:border-outline-variant/20 transition-all min-h-[220px]";
    card.dataset.type = "prop";
    card.dataset.idx = idx;

    var imgSrc = item.rawUrl || item.imageUrl || '';
    var thumbHtml = imgSrc
      ? '<div class="asset-prop-thumb rounded-2xl overflow-hidden border border-outline-variant/20 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all shrink-0" data-action="zoom-img" data-img="' + escapeHtml(imgSrc) + '"><img src="' + escapeHtml(imgSrc) + '" class="w-full h-full object-cover" /></div>'
      : '<div class="asset-prop-thumb rounded-2xl bg-surface-container flex items-center justify-center border border-outline-variant/10 shrink-0"><span class="material-symbols-outlined text-on-surface-variant/20 text-3xl">handyman</span></div>';

    var typeLabel = item.propType || '道具';

    var tagsHtml = '';
    var tags = [];
    if (item.propType) tags.push(item.propType);
    if (item.ownership) tags.push(item.ownership);
    if (item.features) tags.push(item.features);
    if (item.function) tags.push(item.function);
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
          (item.description ? '<p class="text-[11px] text-on-surface-variant/50 mt-1 line-clamp-2 leading-relaxed">' + escapeHtml(item.description.slice(0, 80)) + '</p>' : '') +
          tagsHtml +
          '<div class="flex flex-wrap items-center gap-1">' + carriesTagHtml + warnHtml + '</div>' +
        '</div>' +
        thumbHtml +
      '</div>' +
      '<div class="asset-card-loading absolute inset-0 flex items-center justify-center bg-surface/80 z-10 rounded-xl"' + (_assetGenStatus["prop_" + idx] ? '' : ' hidden') + '><div class="tc-spinner"></div></div>' +
      '<div class="flex gap-1.5 mt-auto pt-3 flex-wrap">' +
        '<button type="button" class="flex-1 py-2 bg-surface-container-highest/40 text-on-surface text-[9px] font-bold uppercase tracking-[0.15em] rounded-lg hover:bg-surface-container-highest transition-colors" data-action="regen-asset">重新生成</button>' +
        _ctx.historyBtnHtml(item, "chip") +
        '<button type="button" class="py-2 px-3 bg-surface-container-highest/40 text-on-surface text-[9px] font-bold uppercase tracking-[0.15em] rounded-lg hover:bg-surface-container-highest transition-colors" data-action="ref-agent" title="引用到 AI 助手">@</button>' +
        '<button type="button" class="py-2 px-3 bg-surface-container-highest/40 text-on-surface text-[9px] font-bold uppercase tracking-[0.15em] rounded-lg hover:bg-surface-container-highest transition-colors" data-action="edit-asset">编辑</button>' +
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
      _ctx.saveProject();
    }
  }
  if (status === "done") {
    console.log("[updateAssetCardImage] " + type + "#" + idx + " DONE url=" + (imgUrl || "").slice(0, 80));
  }

  var result = renderAssetCard(type, idx, status, { imgUrl: imgUrl, loadingText: loadingText });
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
  _injectAssetStaleBadges();
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
    return item.imageUrl || item.pencilUrl || item.realPhotoUrl || item.rawUrl || "";
  }
  return item.imageUrl || item.rawUrl || "";
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
    await _ctx.saveProject();
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
  _assetImagesGenerating = true;
  var btn = $("btnGenAssetImages");
  var hint = $("assetImgHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "正在批量生成参考图…（gpt-image-1 单张约 20-40 秒，请耐心等待）";

  var originId = project.id;

  // Phase 3-B-7：扫描 project.assets，把需要生成的主资产统一排进一个队列。
  var allTargets = [];
  ["characters", "scenes", "props"].forEach(function (cat) {
    var type = cat === "characters" ? "char" : cat === "scenes" ? "scene" : "prop";
    (project.assets[cat] || []).forEach(function (item, idx) {
      var needsGen = !item.imageUrl && item.imagePrompt;
      if (!needsGen) return;
      allTargets.push({ type: type, idx: idx });
    });
  });

  var totalTasks = allTargets.length;
  if (totalTasks === 0) {
    if (hint) hint.textContent = "没有需要生成的资产";
    _assetImagesGenerating = false;
    if (btn) btn.disabled = false;
    return;
  }

  // 为所有 target 先置 loading 占位。
  allTargets.forEach(function (t) {
    updateAssetCardImage(t.type, t.idx, "loading");
  });

  var batchResult = await _runAssetImageBatch(originId, allTargets, hint, totalTasks);
  // batchResult: { done, failed }

  _assetImagesGenerating = false;
  if (btn) btn.disabled = false;

  // 汇总文案（沿用旧版口径）
  var done = 0;
  var still_missing = 0;
  var pencil_pending = 0;
    ["characters", "scenes", "props"].forEach(function (cat) {
    (project.assets[cat] || []).forEach(function (item) {
      if (item.imageUrl) done++;
      else if (item.imagePrompt) still_missing++;
    });
  });
  (project.assets.characters || []).forEach(function (item) {
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
        _ctx.archiveOldImage(item, type === "char" ? "character" : type);
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
          status: "ready",
          updatedAt: new Date().toISOString(),
          styleBibleSignature: extra.styleBibleSignature,
          styleLockVersion: extra.styleLockVersion,
          resolvedBackdropColor: extra.resolvedBackdropColor
        });
        if (extra.assetId) item.assetId = extra.assetId;
        if (extra.fetchStatus) item.fetchStatus = extra.fetchStatus;
        delete item.imageLastError;
        delete item.imageFailedAt;
	        if (item.reference) delete item.reference.lastError;
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
    data = await apiGet("/api/batch/active?projectId=" + encodeURIComponent(originId));
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

export function checkAssetsConfirm() {
  var area = $("assetsConfirmArea");
  var topBtn = $("btnConfirmAssetsTop");
  var saveTplBtn = $("btnSaveWorldTemplate");
  var knowledgeBtn = $("btnKnowledgeSnapshot");
  if (!area || !project || !project.assets) {
    if (topBtn) topBtn.hidden = true;
    if (saveTplBtn) saveTplBtn.hidden = true;
    if (knowledgeBtn) knowledgeBtn.hidden = true;
    return;
  }
  var hasAssets = (project.assets.characters || []).length > 0 || (project.assets.scenes || []).length > 0;
  area.hidden = !hasAssets;
  if (topBtn) topBtn.hidden = !hasAssets;
  if (saveTplBtn) saveTplBtn.hidden = !hasAssets;
  if (knowledgeBtn) knowledgeBtn.hidden = false;
}

export function confirmAssets() {
  if (!project || !project.assets) { showToast("请先分析资产", "warn"); return; }

  var chars = project.assets.characters || [];
  var missingPencil = [];
  for (var ci = 0; ci < chars.length; ci++) {
    if (chars[ci].realPhotoUrl && !chars[ci].pencilUrl) {
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
        _ctx.saveProject();
        _ctx.checkAndSuggest("assetConfirm");
        _ctx.switchPage("shots");
      }
    );
    return;
  }

  project.assetsApproved = true;
  project.currentStep = Math.max(project.currentStep, 3);
  _ctx.saveProject();
  _ctx.checkAndSuggest("assetConfirm");
  _ctx.switchPage("shots");
}

export function handleAssetAction(e) {
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;

  if (action === "zoom-img") {
    var imgUrl = btn.dataset.img;
    if (imgUrl) _openLightbox(imgUrl);
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

  if (action === "show-history") {
    _ctx.openHistoryPopover(btn, item, function (hi) {
      if (_ctx.setHistoryAsCurrent(item, hi)) {
        _ctx.saveProject();
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
        } else {
          item.description = newVal;
        }
        item._descEdited = true;
        _ctx.markDownstreamStale("asset", { type: type, idx: idx, name: item.name || "" });
        _ctx.saveProject();
        textEl.textContent = newVal;
        _autoSyncUpstream(type, idx);
      };
    }
  } else if (action === "edit-char-mode") {
    if (type !== "char") return;
    var curVia = item.via || '';
    var newVia = prompt("修改出现方式（回忆 / 照片 / 梦境 / 通缉令 / 电话那头 / 别人的讲述 等）\n留空则改回「当下活动角色」。", curVia);
    if (newVia === null) return;
    newVia = newVia.trim();
    if (newVia) {
      item.appearanceMode = 'referenced';
      item.via = newVia;
    } else {
      item.appearanceMode = 'main';
      delete item.via;
    }
    _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
    _ctx.saveProject();
    renderAssetsUI();
    showToast("出现方式已更新", "ok");
  } else if (action === "edit-char-crowd") {
    if (type !== "char") return;
    var curSize = item.crowdSize || '';
    var newSize = prompt("修改群体规模（如：三四个 / 一队（十几人） / 成群）\n留空则改回「单人角色」。", curSize);
    if (newSize === null) return;
    newSize = newSize.trim();
    if (newSize) {
      item.isCrowd = true;
      item.crowdSize = newSize;
    } else {
      item.isCrowd = false;
      delete item.crowdSize;
    }
    _ctx.markDownstreamStale("asset", { type: "char", idx: idx, name: item.name || "" });
    _ctx.saveProject();
    renderAssetsUI();
    showToast("群体规模已更新", "ok");
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
      _ctx.saveProject();
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
      _ctx.saveProject();
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
    var newCarries = prompt(helpText, curCarries);
    if (newCarries === null) return;
    newCarries = (newCarries || '').trim();
    var list = newCarries ? newCarries.split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean) : [];
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
    _ctx.saveProject();
    renderAssetsUI();
    showToast(list.length ? "载体承载已更新" : "已改回普通道具", "ok");
  } else if (action === "show-carry-warning") {
    var w = project && project._carryWarnings && project._carryWarnings[idx];
    if (w) alert("⚠ 载体校验问题\n\n" + (w.message || "未知问题"));
  }
}

/* ── 角色卡右上角菜单 ── */
var _charMenuDismissHandler = null;

function _showCharMenu(anchor, type, idx) {
  var existing = document.getElementById("charContextMenu");
  _dismissCharMenu();
  if (type !== "char") return;
  if (existing) return;

  var menu = document.createElement("div");
  menu.id = "charContextMenu";
  menu.className = "absolute right-0 top-full mt-2 z-50 min-w-[200px] bg-white rounded-2xl py-2 border border-black/[0.06]";
  menu.style.cssText = "box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);";
  var _charItem = project.assets.characters[idx];
  var _hasPencilIssue = _charItem && _charItem.realPhotoUrl && !_charItem.pencilUrl;
  var _menuEntityType = (((_charItem || {}).entityType) || 'human').toString().toLowerCase();
  var _isNonHumanMenu = _menuEntityType === 'non-human';
  var _retryLabel = _isNonHumanMenu ? '重试实体概念图' : '重试风格转换';
  menu.innerHTML =
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-xl" data-menu="upload-char-img">' +
      '<span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传角色图' +
    '</button>' +
    (_hasPencilIssue ? '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e65100] hover:bg-orange-50 transition-colors" data-menu="retry-pencil">' +
      '<span class="material-symbols-outlined text-lg">brush</span>' + _retryLabel +
    '</button>' : '') +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-xl" data-menu="delete-char">' +
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
      _ctx.saveProject();
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

  var wrapper = anchor.closest(".flex.justify-between");
  if (wrapper) {
    wrapper.style.position = "relative";
    wrapper.appendChild(menu);
  }

  _charMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || anchor.contains(ev.target)) return;
    _dismissCharMenu();
  };
  setTimeout(function () {
    document.addEventListener("click", _charMenuDismissHandler);
  }, 0);
}

function _dismissCharMenu() {
  var m = document.getElementById("charContextMenu");
  if (m) m.remove();
  if (_charMenuDismissHandler) {
    document.removeEventListener("click", _charMenuDismissHandler);
    _charMenuDismissHandler = null;
  }
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
      _ctx.saveProject();
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

export function _openLightbox(imgUrl, title) {
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
      '<img src="' + escapeHtml(imgUrl) + '" class="asset-lightbox-image" />' +
      '<button class="asset-lightbox-close" onclick="this.closest(\'#assetLightbox\').remove()">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  overlay.addEventListener("click", function () { overlay.remove(); });
  document.body.appendChild(overlay);
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
          '<p class="text-[11px] text-[#90A4AE] mt-0.5">保存角色与世界观参考，不包含风格圣经</p>' +
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

  var worldSnapshot = snapshotWorldTemplate(tpl);
  project.selectedWorldTemplateId = worldSnapshot.id || tpl.id || project.selectedWorldTemplateId || null;
  project.worldTemplateSnapshot = worldSnapshot;

  if (tpl.characters && tpl.characters.length) {
    if (!project.assets) project.assets = { characters: [], scenes: [], props: [] };
    var existing = project.assets.characters || [];
    var existingNames = {};
    existing.forEach(function (c) { if (c.name) existingNames[c.name] = true; });

    tpl.characters.forEach(function (ch) {
      var copy = JSON.parse(JSON.stringify(ch));
      if (existingNames[copy.name]) {
        copy.name = copy.name + "（模板）";
      }
      copy._fromTemplate = tpl.name || "模板";
      existing.push(copy);
    });
    project.assets.characters = existing;
  }

  if (project.shots && project.shots.length) {
    project.shots = [];
    project.shotsApproved = false;
  }
  if (project.storyboards && project.storyboards.length) {
    project.storyboards = [];
    project.imagesApproved = false;
    project.videoPromptsApproved = false;
  }

  _ctx.saveProject();

  var charCount = (tpl.characters || []).length;
  showToast("已导入世界观模板：世界观来源已记录，" + charCount + " 个角色已追加到资产库", "success");

  _ctx.refreshOverview();
  _ctx.switchPage("assets");
}

export async function _applyWorldTemplateReferenceFromStylePage(tpl) {
  if (!project || !tpl) return;

  var selectedId = String(project.selectedWorldTemplateId || "");
  var tplId = String(tpl.id || "");
  if (selectedId && tplId && selectedId === tplId) {
    project.selectedWorldTemplateId = null;
    project.worldTemplateSnapshot = null;
    _ctx.saveProject();
    if (_ctx.refreshStylePage) _ctx.refreshStylePage();
    showToast("已清除关联世界观", "info");
    return;
  }

  var full = await _loadWorldTemplateDetail(tpl);
  var worldSnapshot = snapshotWorldTemplate(full || tpl);
  project.selectedWorldTemplateId = worldSnapshot.id || full.id || tpl.id || null;
  project.worldTemplateSnapshot = worldSnapshot;
  _ctx.saveProject();
  if (_ctx.refreshStylePage) _ctx.refreshStylePage();
  showToast("已关联世界观「" + ((full && full.name) || "未命名") + "」。它会作为资产候选池和内容规则参考。", "success");
}

export async function _applyWorldTemplateFromStylePage(tpl) {
  return _applyWorldTemplateReferenceFromStylePage(tpl);
}

export async function _applyStyleTemplateFromStylePage(tpl) {
  if (!project || !tpl) return;

  var selectedId = String(project.selectedStyleTemplateId || "");
  var tplId = String(tpl.id || "");
  if (selectedId && tplId && selectedId === tplId) {
    project.selectedStyleTemplateId = null;
    project.styleTemplateSnapshot = null;
    _ctx.saveProject();
    if (_ctx.refreshStylePage) _ctx.refreshStylePage();
    showToast("已清除风格模板选择", "info");
    return;
  }

  project.selectedStyleTemplateId = tpl.id || null;
  project.styleTemplateSnapshot = JSON.parse(JSON.stringify(tpl));
  _ctx.saveProject();
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
          '<p class="text-xs text-on-surface-variant/60 mt-0.5">选择一个模板，将关联世界观并追加角色到当前项目</p>' +
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
        "将关联世界观并追加角色到资产库，已有镜头表和分镜将被清空，确定继续？",
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

export async function refreshLibraryPage() {
  var projList = _ctx.getProjectList();
  if (project && !projList.some(function (p) { return p.id === project.id; })) {
    projList.unshift({ id: project.id, name: project.name });
  }
  if (!_libActiveProject && project) _libActiveProject = project.id;
  if (!_libActiveProject && projList.length) _libActiveProject = projList[0].id;

  var tabsWrap = $("libProjectTabs");
  if (tabsWrap) {
    var html = "";
    projList.forEach(function (p) {
      var active = p.id === _libActiveProject;
      html += '<button class="lib-proj-btn px-6 py-2.5 rounded-xl text-xs font-bold tracking-[0.1em] uppercase transition-all duration-200 ' +
        (active
          ? 'bg-[#2C3E50] text-white shadow-lg'
          : 'bg-white/60 text-[#2C3E50] hover:bg-white/80 border border-[#CFD8DC]') +
        '" data-proj-id="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || "未命名项目") + '</button>';
    });
    tabsWrap.innerHTML = html;
  }

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
  var projSection = tabsWrap ? tabsWrap.closest("section") : null;
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

  var targetProj = (_libActiveProject === (project && project.id)) ? project : await loadProjectData(_libActiveProject);
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
            '<img class="w-full h-full object-cover" src="' + escapeHtml(asset.url) + '" alt="' + escapeHtml(asset.name) + '" loading="lazy" />' +
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
      if (!confirm("导入模板将关联世界观并追加角色到资产库，已有的镜头表和分镜将被清空，确定继续？")) return;
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
      _ctx.saveProject();
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
      _ctx.saveProject();
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
      _ctx.saveProject();
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
      _ctx.saveProject();
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
  _ctx.saveProject();
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
    _ctx.saveProject();
  }).catch(function (e) {
    console.warn("[Stale] backend compute failed, using fallback:", e);
    _markDownstreamStaleFallback(scope, detail);
    _ctx.saveProject();
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
    _ctx.saveProject();
  }
}
