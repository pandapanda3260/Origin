import { apiGet, escapeHtml } from './utils.js?v=201';

export const MATERIAL_PANEL_ROLES = ['scene', 'char', 'prop'];
export const MATERIAL_PANEL_CACHE_TTL_MS = 60000;

export const materialPanelState = {
  projectId: '',
  projectUpdatedAt: '',
  panelsByGroupIdx: Object.create(null),
  sourceHashesByGroupIdx: Object.create(null),
  selectionVersionsByGroupIdx: Object.create(null),
  fetchedAtByGroupIdx: Object.create(null),
  pendingByKey: Object.create(null),
  activePicker: null,
  activeRolePicker: null,
  uploadingByKey: Object.create(null),
  refreshAfterInteraction: Object.create(null),
};

const DEFAULT_ACTIONS = {
  view: 'view-ref',
  remove: 'remove-reference-tile',
  toggleRolePicker: 'toggle-reference-role-picker',
  chooseRole: 'choose-reference-upload-role',
  select: 'select-reference-material',
  closePicker: 'close-reference-material-picker',
  upload: 'upload-reference-material',
  confirm: 'confirm-reference-material',
  downloadAll: 'download-all-material',
};

function actionAttr(action, opts) {
  opts = opts || {};
  var attr = opts.actionAttr || 'data-material-action';
  return ' ' + attr + '="' + escapeHtml(action) + '"';
}

function panelScopeAttrs(opts) {
  opts = opts || {};
  var out = '';
  if (opts.scope) out += ' data-material-scope="' + escapeHtml(opts.scope) + '"';
  if (opts.groupIdx != null) out += ' data-group-idx="' + escapeHtml(String(opts.groupIdx)) + '"';
  return out;
}

function actionsFor(opts) {
  return Object.assign({}, DEFAULT_ACTIONS, (opts && opts.actions) || {});
}

function normalizeGroupIdx(groupIdx) {
  var n = Number(groupIdx);
  if (!Number.isFinite(n) || n < 0) return '';
  return String(Math.floor(n));
}

function materialPanelCacheKey(projectId, scope, groupIdx) {
  return [String(projectId || ''), String(scope || 'panel'), normalizeGroupIdx(groupIdx)].join(':');
}

function resetMaterialPanelMaps() {
  materialPanelState.panelsByGroupIdx = Object.create(null);
  materialPanelState.sourceHashesByGroupIdx = Object.create(null);
  materialPanelState.selectionVersionsByGroupIdx = Object.create(null);
  materialPanelState.fetchedAtByGroupIdx = Object.create(null);
  materialPanelState.pendingByKey = Object.create(null);
  materialPanelState.refreshAfterInteraction = Object.create(null);
}

export function setMaterialPanelProject(projectId, projectUpdatedAt) {
  projectId = String(projectId || '');
  projectUpdatedAt = projectUpdatedAt == null ? null : String(projectUpdatedAt || '');
  if (materialPanelState.projectId === projectId) {
    if (projectUpdatedAt !== null && materialPanelState.projectUpdatedAt && materialPanelState.projectUpdatedAt !== projectUpdatedAt) {
      materialPanelState.projectUpdatedAt = projectUpdatedAt;
      resetMaterialPanelMaps();
    } else if (projectUpdatedAt !== null && !materialPanelState.projectUpdatedAt) {
      materialPanelState.projectUpdatedAt = projectUpdatedAt;
    }
    return;
  }
  materialPanelState.projectId = projectId;
  materialPanelState.projectUpdatedAt = projectUpdatedAt || '';
  materialPanelState.activePicker = null;
  materialPanelState.activeRolePicker = null;
  materialPanelState.uploadingByKey = Object.create(null);
  resetMaterialPanelMaps();
}

export function getMaterialPanel(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  return key ? (materialPanelState.panelsByGroupIdx[key] || null) : null;
}

export function getMaterialPanelSourceHash(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  return key ? (materialPanelState.sourceHashesByGroupIdx[key] || '') : '';
}

export function getMaterialPanelSelectionVersion(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  return key ? (materialPanelState.selectionVersionsByGroupIdx[key] || '') : '';
}

export function setMaterialPanel(groupIdx, panel, meta) {
  var key = normalizeGroupIdx(groupIdx);
  if (!key) return null;
  meta = meta || {};
  if (panel) materialPanelState.panelsByGroupIdx[key] = panel;
  else delete materialPanelState.panelsByGroupIdx[key];
  if (meta.sourceHash != null) materialPanelState.sourceHashesByGroupIdx[key] = String(meta.sourceHash || '');
  else if (panel && panel.sourceHash) materialPanelState.sourceHashesByGroupIdx[key] = String(panel.sourceHash || '');
  if (meta.selectionVersion != null) materialPanelState.selectionVersionsByGroupIdx[key] = String(meta.selectionVersion || '');
  else if (panel && panel.selectionVersion) materialPanelState.selectionVersionsByGroupIdx[key] = String(panel.selectionVersion || '');
  materialPanelState.fetchedAtByGroupIdx[key] = Date.now();
  delete materialPanelState.refreshAfterInteraction[key];
  return panel || null;
}

export function setMaterialPanelFromEntry(entry) {
  if (!entry || entry.groupIdx == null) return null;
  return setMaterialPanel(entry.groupIdx, entry.firstFrameMaterialPanel || null, {
    sourceHash: entry.sourceHash || '',
    selectionVersion: entry.firstFrameMaterialPanel && entry.firstFrameMaterialPanel.selectionVersion || '',
  });
}

export function invalidateMaterialPanel(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  if (!key) return;
  delete materialPanelState.panelsByGroupIdx[key];
  delete materialPanelState.sourceHashesByGroupIdx[key];
  delete materialPanelState.selectionVersionsByGroupIdx[key];
  delete materialPanelState.fetchedAtByGroupIdx[key];
  delete materialPanelState.refreshAfterInteraction[key];
}

export function invalidateAllMaterialPanels() {
  resetMaterialPanelMaps();
}

export function materialPanelInteractionKey(surface, groupIdx) {
  return String(surface || 'shot') + ':' + normalizeGroupIdx(groupIdx);
}

export function setMaterialPanelActivePicker(state) {
  materialPanelState.activePicker = state && state.groupIdx != null ? Object.assign({}, state) : null;
}

export function setMaterialPanelActiveRolePicker(state) {
  materialPanelState.activeRolePicker = state && state.groupIdx != null ? Object.assign({}, state) : null;
}

export function setMaterialPanelUploading(surface, groupIdx, uploading) {
  var key = materialPanelInteractionKey(surface, groupIdx);
  if (!key || key.endsWith(':')) return;
  if (uploading) materialPanelState.uploadingByKey[key] = true;
  else delete materialPanelState.uploadingByKey[key];
}

export function isMaterialPanelInActiveInteraction(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  if (!key) return false;
  if (materialPanelState.activePicker && normalizeGroupIdx(materialPanelState.activePicker.groupIdx) === key) return true;
  if (materialPanelState.activeRolePicker && normalizeGroupIdx(materialPanelState.activeRolePicker.groupIdx) === key) return true;
  return Object.keys(materialPanelState.uploadingByKey).some(function (uploadKey) {
    return uploadKey.endsWith(':' + key);
  });
}

export function shouldRefreshMaterialPanel(groupIdx, now) {
  var key = normalizeGroupIdx(groupIdx);
  if (!key) return false;
  if (isMaterialPanelInActiveInteraction(key)) {
    materialPanelState.refreshAfterInteraction[key] = true;
    return false;
  }
  if (!materialPanelState.panelsByGroupIdx[key]) return true;
  now = Number(now || Date.now());
  var fetchedAt = Number(materialPanelState.fetchedAtByGroupIdx[key] || 0);
  return !fetchedAt || now - fetchedAt > MATERIAL_PANEL_CACHE_TTL_MS;
}

export function materialPanelNeedsPostInteractionRefresh(groupIdx) {
  var key = normalizeGroupIdx(groupIdx);
  return !!(key && materialPanelState.refreshAfterInteraction[key]);
}

export async function fetchMaterialPanels(projectId, options) {
  options = options || {};
  projectId = String(projectId || '').trim();
  if (!projectId) return [];
  setMaterialPanelProject(projectId);
  var groupIdx = options.groupIdx == null ? null : normalizeGroupIdx(options.groupIdx);
  var pendingKey = materialPanelCacheKey(projectId, groupIdx ? 'one' : 'all', groupIdx || 'all');
  if (materialPanelState.pendingByKey[pendingKey]) return materialPanelState.pendingByKey[pendingKey];
  var url = '/api/frames/material-panels?projectId=' + encodeURIComponent(projectId);
  if (groupIdx) url += '&groupIdx=' + encodeURIComponent(groupIdx);
  var promise = apiGet(url).then(function (resp) {
    var panels = Array.isArray(resp && resp.panels) ? resp.panels : [];
    panels.forEach(setMaterialPanelFromEntry);
    return panels;
  }).finally(function () {
    delete materialPanelState.pendingByKey[pendingKey];
  });
  materialPanelState.pendingByKey[pendingKey] = promise;
  return promise;
}

export function materialPanelRoleLabel(role) {
  if (role === 'scene') return '场景图';
  if (role === 'char') return '角色图';
  return '道具图';
}

export function materialPanelRoleIcon(role) {
  if (role === 'scene') return 'landscape';
  if (role === 'char') return 'person';
  return 'category';
}

export function materialPanelTileIds(panel) {
  panel = panel || {};
  if (Array.isArray(panel.orderedTileIds) && panel.orderedTileIds.length) {
    return panel.orderedTileIds.map(function (id) { return String(id || '').trim(); }).filter(Boolean);
  }
  var groups = panel.groups || {};
  return MATERIAL_PANEL_ROLES.reduce(function (out, role) {
    (groups[role] || []).forEach(function (tile) {
      if (tile && tile.id) out.push(tile.id);
    });
    return out;
  }, []);
}

export function materialPanelOrderedTiles(panel) {
  panel = panel || {};
  if (Array.isArray(panel.orderedTiles) && panel.orderedTiles.length) {
    return panel.orderedTiles.filter(Boolean);
  }
  var groups = panel.groups || {};
  var byId = {};
  MATERIAL_PANEL_ROLES.forEach(function (role) {
    (groups[role] || []).forEach(function (tile) {
      if (tile && tile.id) byId[tile.id] = tile;
    });
  });
  if (Array.isArray(panel.orderedTileIds) && panel.orderedTileIds.length) {
    return panel.orderedTileIds.map(function (id) { return byId[id]; }).filter(Boolean);
  }
  return MATERIAL_PANEL_ROLES.reduce(function (out, role) {
    return out.concat(groups[role] || []);
  }, []);
}

export function materialPanelCandidateTilesForRole(panel, role) {
  panel = panel || {};
  var candidateGroups = panel.candidateGroups || {};
  var candidates = Array.isArray(candidateGroups[role]) ? candidateGroups[role] : null;
  if (candidates) return candidates.filter(Boolean);
  var groups = panel.groups || {};
  return (Array.isArray(groups[role]) ? groups[role] : []).filter(Boolean);
}

export function materialPanelSelectedTileIdSet(panel) {
  return materialPanelTileIds(panel).reduce(function (set, id) {
    set[String(id || '')] = true;
    return set;
  }, {});
}

export function materialPanelReferenceCapMessage(panel) {
  panel = panel || {};
  var used = Number(panel.used || 0);
  var cap = Number(panel.cap || 0);
  if (cap <= 0) return '当前模型不支持图片参考。';
  if (cap === 1 && used >= 1) {
    var firstTile = materialPanelOrderedTiles(panel)[0] || null;
    if (firstTile && firstTile.name) return '当前模型最多支持 1 张参考图。请先移除「' + firstTile.name + '」后再添加。';
  }
  return used >= cap ? '参考图已达上限，请先移除一张后再添加。' : '';
}

export function materialPanelReferenceAddDisabled(panel) {
  panel = panel || {};
  var used = Number(panel.used || 0);
  var cap = Number(panel.cap || 0);
  var remaining = Number(panel.remaining || 0);
  return !panel || cap <= 0 || used >= cap || remaining <= 0;
}

export function renderMaterialImageWithFallbackHtml(url, opts) {
  opts = opts || {};
  url = String(url || '').trim();
  var variant = opts.variant || 'thumb';
  var alt = String(opts.alt || opts.fallbackTitle || '图片暂不可用');
  var fallbackTitle = opts.fallbackTitle || '图片暂不可用';
  var fallbackText = opts.fallbackText || '原图链接失效或文件不可访问';
  var frameClass = 'ffe-image-frame ffe-image-frame--' + escapeHtml(variant) + (opts.className ? ' ' + escapeHtml(opts.className) : '');
  var frameAttrs = '';
  if (opts.dataAction) frameAttrs += actionAttr(opts.dataAction, opts);
  if (opts.dataUrl) frameAttrs += ' data-url="' + escapeHtml(opts.dataUrl) + '"';
  return '<div class="' + frameClass + '"' + frameAttrs + '>' +
    (url ? '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async" onerror="window.__originMarkImageMissing && window.__originMarkImageMissing(this)" />' : '') +
    '<div class="ffe-image-fallback" role="img" aria-label="' + escapeHtml(alt) + '">' +
      '<span class="material-symbols-outlined">broken_image</span>' +
      '<strong>' + escapeHtml(fallbackTitle) + '</strong>' +
      '<span>' + escapeHtml(fallbackText) + '</span>' +
    '</div>' +
  '</div>';
}

function materialThumbHtml(role, tile, opts) {
  opts = opts || {};
  var actions = actionsFor(opts);
  tile = tile || {};
  var name = tile.name || materialPanelRoleLabel(role);
  var url = tile.thumbUrl || tile.url || '';
  var icon = materialPanelRoleIcon(role);
  var imageHtml = url
    ? renderMaterialImageWithFallbackHtml(url, {
      variant: 'thumb',
      alt: name,
      dataAction: actions.view,
      dataUrl: tile.url || url,
      actionAttr: opts.actionAttr,
    })
    : '<div class="sb-material-placeholder"><span class="material-symbols-outlined">' + icon + '</span></div>';
  return '<div class="sb-material-thumb ffe-material-thumb" data-role="' + escapeHtml(role) + '" data-tile-id="' + escapeHtml(tile.id || '') + '">' +
    '<div class="sb-material-thumb-image">' +
      imageHtml +
      '<button type="button" class="sb-material-thumb-delete"' + actionAttr(actions.remove, opts) + ' data-tile-id="' + escapeHtml(tile.id || '') + '" title="从本次首帧参考中移除"><span class="material-symbols-outlined">delete_outline</span></button>' +
    '</div>' +
  '</div>';
}

function rolePickerHtml(opts) {
  opts = opts || {};
  if (!opts.rolePickerOpen) return '';
  var actions = actionsFor(opts);
  return '<div class="ffe-material-role-picker" role="menu" aria-label="选择参考图类型"' + panelScopeAttrs(opts) + '>' +
    MATERIAL_PANEL_ROLES.map(function (role) {
      return '<button type="button" class="ffe-material-role-option"' + actionAttr(actions.chooseRole, opts) + ' data-role="' + escapeHtml(role) + '" role="menuitem">' +
        '<span class="material-symbols-outlined">' + escapeHtml(materialPanelRoleIcon(role)) + '</span>' +
        '<em>' + escapeHtml(materialPanelRoleLabel(role)) + '</em>' +
      '</button>';
    }).join('') +
  '</div>';
}

function addBoxHtml(panel, opts) {
  opts = opts || {};
  var actions = actionsFor(opts);
  var capMessage = materialPanelReferenceCapMessage(panel);
  var disabled = materialPanelReferenceAddDisabled(panel) || !!capMessage;
  var msg = disabled ? capMessage : '添加图片';
  var disabledAttrs = disabled ? ' aria-disabled="true"' : ' aria-disabled="false"';
  return '<div class="ffe-material-add-wrap">' +
    '<button type="button" class="sb-material-add-box ffe-material-add-box"' + actionAttr(actions.toggleRolePicker, opts) + panelScopeAttrs(opts) + ' data-disabled-computed="' + (disabled ? 'true' : 'false') + '" title="' + escapeHtml(msg) + '"' + disabledAttrs + ' aria-haspopup="menu" aria-expanded="' + (opts.rolePickerOpen ? 'true' : 'false') + '">' +
      '<span>+</span>' +
      '<em>添加素材</em>' +
    '</button>' +
    rolePickerHtml(opts) +
  '</div>';
}

function omittedHtml(panel) {
  var omitted = panel && panel.omitted || {};
  var items = [];
  if (Number(omitted.unavailableImage || 0) > 0) items.push(Number(omitted.unavailableImage) + ' 个素材无可用图片');
  if (Number(omitted.capacityLimited || 0) > 0) items.push(Number(omitted.capacityLimited) + ' 个素材未进入本次参考');
  if (Number(omitted.legacyUnavailable || 0) > 0) items.push(Number(omitted.legacyUnavailable) + ' 个旧参考已不可用');
  if (!items.length) return '';
  return '<div class="ffe-material-omitted">' + items.map(function (item) {
    return '<span>' + escapeHtml(item) + '</span>';
  }).join('') + '</div>';
}

export function renderMaterialImagePanelHtml(opts) {
  opts = opts || {};
  var panel = opts.panel;
  if (!panel) {
    return '<section class="sb-material-panel ffe-material-panel"' + panelScopeAttrs(opts) + '>' +
      '<div class="sb-material-panel-title"><span class="sb-material-panel-title-copy"><span>素材图展示区</span><em>REFERENCE ASSETS</em></span></div>' +
      '<div class="ffe-material-empty">本次将不附带参考图。</div>' +
    '</section>';
  }
  var used = Number(panel.used || 0);
  var cap = Number(panel.cap || 0);
  var displayCap = Number(cap || 0);
  var orderedTiles = materialPanelOrderedTiles(panel);
  var slotCount = cap > 0 ? cap + 1 : Math.max(1, orderedTiles.length || 1);
  var invalidHtml = panel.invalid && panel.invalid.message
    ? '<div class="ffe-field-warning">' + escapeHtml(panel.invalid.message) + '</div>'
    : '';
  var emptyText = cap <= 0 ? '当前模型不支持图片参考。' : '本次将不附带参考图。';
  var emptyHtml = used <= 0
    ? '<div class="ffe-material-empty">' + escapeHtml(emptyText) + '</div>'
    : '';
  var stripContent = orderedTiles.map(function (tile) {
    return materialThumbHtml(tile.role, tile, opts);
  }).join('');
  if (cap > 0) stripContent += addBoxHtml(panel, opts);
  var actions = actionsFor(opts);
  var downloadDisabled = orderedTiles.length === 0;
  var downloadTitle = downloadDisabled ? '暂无素材图可下载' : '下载全部素材图';
  // 复用 styles.css 已有但此前未被任何 HTML 使用的 .sb-material-download-btn 样式
  // （24×24 圆形按钮，悬停翻黑，disabled 半透明）。
  var downloadBtnHtml = '<button type="button" class="sb-material-download-btn"' +
    actionAttr(actions.downloadAll, opts) +
    ' title="' + escapeHtml(downloadTitle) + '"' +
    ' aria-label="' + escapeHtml(downloadTitle) + '"' +
    (downloadDisabled ? ' disabled aria-disabled="true"' : '') +
    '><span class="material-symbols-outlined">download</span></button>';
  return '<section class="sb-material-panel ffe-material-panel" data-ffe-material-version="ordered-strip-v2"' + panelScopeAttrs(opts) + '>' +
    '<div class="sb-material-panel-title">' +
      '<span class="sb-material-panel-title-copy"><span>素材图展示区</span><em>REFERENCE ASSETS</em></span>' +
      '<span class="ffe-material-budget">' + used + '/' + displayCap + '</span>' +
      downloadBtnHtml +
    '</div>' +
    invalidHtml +
    emptyHtml +
    '<div class="ffe-material-strip" style="--ffe-material-slot-count: ' + String(slotCount) + '">' + stripContent + '</div>' +
    omittedHtml(panel) +
  '</section>';
}

export function renderMaterialPickerHtml(opts) {
  opts = opts || {};
  var panel = opts.panel || {};
  var picker = opts.picker || {};
  if (!picker.open) return '';
  var actions = actionsFor(opts);
  var role = picker.role || 'scene';
  var candidates = materialPanelCandidateTilesForRole(panel, role);
  var selectedSet = materialPanelSelectedTileIdSet(panel);
  var remaining = Number(panel.remaining || 0);
  var title = '选择' + materialPanelRoleLabel(role);
  var cards = candidates.map(function (tile) {
    var id = tile.id || '';
    var isSelected = picker.selectedId === id;
    var alreadySelected = !!selectedSet[id];
    var disabled = alreadySelected || (remaining <= 0 && !isSelected);
    var computedDisabledAttr = disabled ? ' data-disabled-computed="true"' : ' data-disabled-computed="false"';
    var name = tile.name || materialPanelRoleLabel(role);
    var url = tile.thumbUrl || tile.url || '';
    var status = alreadySelected ? '已添加' : (isSelected ? '已选中' : (tile.source === 'upload' ? '上传素材' : (tile.source === 'library' ? '资产库素材' : '项目素材')));
    return '<article class="ffe-material-picker-card ' + (isSelected ? 'is-selected ' : '') + (alreadySelected ? 'is-added ' : '') + (disabled ? 'is-disabled' : '') + '" data-tile-id="' + escapeHtml(id) + '">' +
      '<button type="button" class="ffe-material-picker-select"' + actionAttr(actions.select, opts) + ' data-tile-id="' + escapeHtml(id) + '" data-image-missing-disable="true"' + computedDisabledAttr + (disabled ? ' disabled' : '') + '>' +
        '<span class="ffe-material-picker-check"><span class="material-symbols-outlined">check</span></span>' +
        (url ? renderMaterialImageWithFallbackHtml(url, { variant: 'picker', alt: name }) : '<span class="ffe-material-picker-placeholder material-symbols-outlined">' + escapeHtml(materialPanelRoleIcon(role)) + '</span>') +
      '</button>' +
      '<div class="ffe-material-picker-card-meta"><strong>' + escapeHtml(name) + '</strong><span>' + escapeHtml(status) + '</span></div>' +
    '</article>';
  }).join('');
  if (!cards) {
    cards = '<div class="ffe-material-picker-empty"><span class="material-symbols-outlined">image_search</span><strong>暂无可用素材</strong><span>可以先上传一张图片。</span></div>';
  }
  return '<div class="ffe-material-picker-backdrop" role="presentation"' + panelScopeAttrs(opts) + '>' +
    '<section class="ffe-material-picker-modal" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
      '<header class="ffe-material-picker-head">' +
        '<div><h3>' + escapeHtml(title) + '</h3></div>' +
        '<button type="button" class="ffe-material-picker-close"' + actionAttr(actions.closePicker, opts) + ' title="关闭"><span class="material-symbols-outlined">close</span></button>' +
      '</header>' +
      (picker.error ? '<div class="ffe-field-warning">' + escapeHtml(picker.error) + '</div>' : '') +
      '<div class="ffe-material-picker-body">' + cards + '</div>' +
      '<footer class="ffe-material-picker-foot">' +
        '<button type="button" class="ffe-action-secondary"' + actionAttr(actions.upload, opts) + (picker.uploading ? ' disabled' : '') + '><span class="material-symbols-outlined">upload</span><span>' + (picker.uploading ? '上传中...' : '上传图片') + '</span></button>' +
        '<span class="ffe-material-picker-foot-spacer"></span>' +
        '<button type="button" class="ffe-action-ghost"' + actionAttr(actions.closePicker, opts) + '>取消</button>' +
        '<button type="button" class="ffe-action-primary"' + actionAttr(actions.confirm, opts) + '>确认</button>' +
      '</footer>' +
    '</section>' +
  '</div>';
}
