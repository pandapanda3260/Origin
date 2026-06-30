import { assertModuleSingleton } from '/modules/module_singleton_guard.js';
import { buildBoardViewModel } from '/modules/board_state.js';
import { createViewport } from '/modules/board_viewport.js';
import { resolveProtectedImageBlobUrl } from '/modules/utils.js';

assertModuleSingleton('board', import.meta.url);

export const BOARD_CTX_KEYS = [
  'getProject',
  'getStoryboardGroups',
  'hydrateProtectedImageElements',
  'showToast',
  'uPrefix',
  'selectShotFrameCandidate',
  'deleteShotFrameCandidate',
  'reorderShotFrameCandidates',
  'generateShotFrameCandidate',
  'generateStoryboardSheet',
  'uploadShotFrameCandidate',
  'getVideoCandidatesForGroup',
  'setVideoCandidateCurrent',
  'generateVideoForGroup',
  'getVideoGenerateReadiness',
  'confirmSegmentsAndEnterEdit',
  'subscribeVideoResultChanges',
  'reloadProjectFromServer',
];

let _ctx = {};
let _project = null;
let _root = null;
let _viewportRoot = null;
let _worldEl = null;
let _nodesEl = null;
let _edgesEl = null;
let _surfaceEl = null;
let _toolsEl = null;
let _scaleLabelEl = null;
let _miniMapEl = null;
let _miniMapSvgEl = null;
let _helpEl = null;
let _viewport = null;
let _nodeEls = new Map();
let _selectedId = '';
let _lastProjectId = '';
let _lastProjectVersion = '';
let _cameraReadyProjectId = '';
let _handMode = false;
let _helpOpen = false;
let _lastViewModel = null;
const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const BOARD_IMAGE_VIEWPORT_MARGIN = 640;
const BOARD_IMAGE_CONCURRENCY = 6;
const MINIMAP_W = 180;
const MINIMAP_H = 132;
const MINIMAP_PAD = 10;
let _boardImageObserver = null;
let _boardImageQueue = [];
let _boardImageActive = 0;
let _boardImageHydrateRaf = 0;
let _boardActionBusy = false;
let _dragCandidate = null;
let _videoHistoryCache = new Map();
let _videoHistoryInflight = new Map();
let _videoHistoryRefreshRaf = 0;
let _videoSubmitModesByGroup = new Map();
let _videoResultUnsubscribe = null;
let _videoResultReloading = false;
let _videoResultReloadQueued = false;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function assetImg(url, alt) {
  const src = String(url || '').trim();
  if (!src) return '<div class="board-thumb board-thumb--empty"><span class="material-symbols-outlined">image</span></div>';
  return '<img class="board-thumb" src="' + EMPTY_IMAGE_SRC + '" data-board-src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || '') + '" loading="lazy" decoding="async">';
}

function requestBoardFrame(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function currentLodLevel() {
  if (_viewport && typeof _viewport.getLodLevel === 'function') return _viewport.getLodLevel();
  return 'detail';
}

function isBoardImageHidden(img) {
  return !!(img && img.closest && img.closest('[hidden]'));
}

function isImageNearViewport(img) {
  if (!_viewportRoot || !img || !img.getBoundingClientRect || !_viewportRoot.getBoundingClientRect) return false;
  if (isBoardImageHidden(img)) return false;
  const viewportRect = _viewportRoot.getBoundingClientRect();
  const imageRect = img.getBoundingClientRect();
  if (!imageRect || (imageRect.width <= 0 && imageRect.height <= 0)) return false;
  const margin = BOARD_IMAGE_VIEWPORT_MARGIN;
  return imageRect.right >= viewportRect.left - margin &&
    imageRect.left <= viewportRect.right + margin &&
    imageRect.bottom >= viewportRect.top - margin &&
    imageRect.top <= viewportRect.bottom + margin;
}

function shouldLoadThumb(img) {
  return currentLodLevel() !== 'overview' && isImageNearViewport(img);
}

function pumpBoardImageQueue() {
  while (_boardImageActive < BOARD_IMAGE_CONCURRENCY && _boardImageQueue.length) {
    const img = _boardImageQueue.shift();
    const source = String(img && img.getAttribute && img.getAttribute('data-board-src') || '').trim();
    if (!source || img.getAttribute('data-board-resolved-source') === source || !shouldLoadThumb(img)) {
      if (img && img.getAttribute && img.getAttribute('data-board-pending-source') === source) {
        img.removeAttribute('data-board-pending-source');
      }
      continue;
    }
    _boardImageActive += 1;
    Promise.resolve().then(() => resolveProtectedImageBlobUrl(source)).then((resolved) => {
      if (img.getAttribute('data-board-src') !== source) return;
      img.src = resolved || EMPTY_IMAGE_SRC;
      img.setAttribute('data-board-resolved-source', source);
      img.classList.remove('is-image-missing');
    }).catch(() => {
      if (img.getAttribute('data-board-src') !== source) return;
      img.setAttribute('data-board-resolved-source', source);
      img.classList.add('is-image-missing');
    }).finally(() => {
      if (img.getAttribute('data-board-pending-source') === source) {
        img.removeAttribute('data-board-pending-source');
      }
      _boardImageActive = Math.max(0, _boardImageActive - 1);
      pumpBoardImageQueue();
    });
  }
}

function queueBoardImage(img) {
  const source = String(img && img.getAttribute && img.getAttribute('data-board-src') || '').trim();
  if (!source || img.getAttribute('data-board-resolved-source') === source) return;
  if (img.getAttribute('data-board-pending-source') === source) return;
  if (!shouldLoadThumb(img)) return;
  img.setAttribute('data-board-pending-source', source);
  _boardImageQueue.push(img);
  pumpBoardImageQueue();
}

function ensureBoardImageObserver() {
  if (_boardImageObserver || !_viewportRoot || typeof IntersectionObserver === 'undefined') return _boardImageObserver;
  _boardImageObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const img = entry.target;
      img.dataset.boardVisible = entry.isIntersecting ? '1' : '0';
      if (entry.isIntersecting) queueBoardImage(img);
    });
  }, {
    root: _viewportRoot,
    rootMargin: BOARD_IMAGE_VIEWPORT_MARGIN + 'px',
    threshold: 0,
  });
  return _boardImageObserver;
}

function hydrateBoardImages(root) {
  if (!root || !root.querySelectorAll) return;
  const observer = ensureBoardImageObserver();
  root.querySelectorAll('img[data-board-src]').forEach((img) => {
    if (observer && img.getAttribute('data-board-observed') !== '1') {
      img.setAttribute('data-board-observed', '1');
      observer.observe(img);
    }
    if (!observer || img.dataset.boardVisible === '1' || isImageNearViewport(img)) queueBoardImage(img);
  });
}

function unobserveBoardImages(root) {
  if (!root || !root.querySelectorAll) return;
  if (_boardImageObserver) {
    root.querySelectorAll('img[data-board-src]').forEach((img) => {
      _boardImageObserver.unobserve(img);
      img.removeAttribute('data-board-observed');
    });
  }
  if (root.contains) _boardImageQueue = _boardImageQueue.filter((img) => !root.contains(img));
}

function scheduleBoardImageHydration() {
  if (!_root || _boardImageHydrateRaf) return;
  _boardImageHydrateRaf = requestBoardFrame(() => {
    _boardImageHydrateRaf = 0;
    hydrateBoardImages(_root);
  });
}

function disabledButton(label, icon) {
  return '<button type="button" class="board-btn board-btn--disabled" disabled aria-disabled="true" title="下一阶段接入">' +
    (icon ? '<span class="material-symbols-outlined">' + escapeHtml(icon) + '</span>' : '') +
    '<span>' + escapeHtml(label) + '</span></button>';
}

function actionButton(label, icon, action) {
  return '<button type="button" class="board-btn" data-action="' + escapeHtml(action) + '">' +
    (icon ? '<span class="material-symbols-outlined">' + escapeHtml(icon) + '</span>' : '') +
    '<span>' + escapeHtml(label) + '</span></button>';
}

function boardActionButton(label, icon, action, attrs) {
  return '<button type="button" class="board-btn" data-board-control data-board-action="' + escapeHtml(action) + '" ' + (attrs || '') + '>' +
    (icon ? '<span class="material-symbols-outlined">' + escapeHtml(icon) + '</span>' : '') +
    '<span>' + escapeHtml(label) + '</span></button>';
}

function boardIconButton(action, icon, title, attrs) {
  return '<button type="button" class="board-icon-btn" data-board-control data-board-action="' + escapeHtml(action) + '" ' + (attrs || '') + ' title="' + escapeHtml(title || '') + '" aria-label="' + escapeHtml(title || '') + '">' +
    '<span class="material-symbols-outlined">' + escapeHtml(icon) + '</span></button>';
}

function boardActionAttrs(groupIdx, shotUid, candidateId) {
  let attrs = 'data-group-idx="' + escapeHtml(groupIdx) + '" data-shot-uid="' + escapeHtml(shotUid || '') + '"';
  if (candidateId) attrs += ' data-candidate-id="' + escapeHtml(candidateId) + '"';
  return attrs;
}

function videoActionAttrs(groupIdx, taskId) {
  return 'data-group-idx="' + escapeHtml(groupIdx) + '" data-task-id="' + escapeHtml(taskId || '') + '"';
}

function normalizeVideoSubmitMode(value) {
  const mode = String(value || 'auto').trim();
  if (mode === 'auto' || mode === 'reference_images' || mode === 'first_last_frame') return mode;
  return 'auto';
}

function videoSubmitModeForGroup(groupIdx) {
  return normalizeVideoSubmitMode(_videoSubmitModesByGroup.get(Number(groupIdx)) || 'auto');
}

function videoSubmitModeLabel(mode) {
  const labels = {
    auto: '全能参考',
    reference_images: '智能多帧',
    first_last_frame: '首尾帧',
  };
  return labels[normalizeVideoSubmitMode(mode)] || labels.auto;
}

function projectIdOf(project) {
  return String(project && project.id ? project.id : 'draft');
}

function projectVersionOf(project) {
  return String(project && project.version != null ? project.version : 0);
}

function videoHistoryCacheKey(project, groupIdx) {
  return projectIdOf(project) + ':' + projectVersionOf(project) + ':' + String(groupIdx);
}

function pruneVideoHistoryCacheForCurrentVersion(project) {
  const prefix = projectIdOf(project) + ':' + projectVersionOf(project) + ':';
  Array.from(_videoHistoryCache.keys()).forEach((key) => {
    if (!String(key).startsWith(prefix)) _videoHistoryCache.delete(key);
  });
  Array.from(_videoHistoryInflight.keys()).forEach((key) => {
    if (!String(key).startsWith(prefix)) _videoHistoryInflight.delete(key);
  });
}

function videoHistoryRowsFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (response && Array.isArray(response.history)) return response.history;
  if (response && Array.isArray(response.items)) return response.items;
  if (response && Array.isArray(response.tasks)) return response.tasks;
  return [];
}

function videoHistoriesForView(project, groups) {
  const result = {};
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    const groupIdx = Number(group && (group.gIdx ?? group.groupIdx));
    if (!Number.isInteger(groupIdx) || groupIdx < 0) return;
    const key = videoHistoryCacheKey(project, groupIdx);
    if (_videoHistoryCache.has(key)) result[groupIdx] = _videoHistoryCache.get(key);
  });
  return result;
}

function scheduleVideoHistoryRefresh() {
  if (_videoHistoryRefreshRaf) return;
  _videoHistoryRefreshRaf = requestBoardFrame(() => {
    _videoHistoryRefreshRaf = 0;
    refreshBoardPage();
  });
}

function ensureVideoHistories(project, groups) {
  if (!project || !project.id || typeof _ctx.getVideoCandidatesForGroup !== 'function') return;
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    const groupIdx = Number(group && (group.gIdx ?? group.groupIdx));
    if (!Number.isInteger(groupIdx) || groupIdx < 0) return;
    const key = videoHistoryCacheKey(project, groupIdx);
    if (_videoHistoryCache.has(key) || _videoHistoryInflight.has(key)) return;
    const request = Promise.resolve(_ctx.getVideoCandidatesForGroup({ projectId: project.id, groupIdx }))
      .then((response) => {
        if (videoHistoryCacheKey(currentProject(), groupIdx) !== key) return;
        _videoHistoryCache.set(key, videoHistoryRowsFromResponse(response));
        scheduleVideoHistoryRefresh();
      })
      .catch(() => {
        if (videoHistoryCacheKey(currentProject(), groupIdx) !== key) return;
        _videoHistoryCache.set(key, []);
        scheduleVideoHistoryRefresh();
      })
      .finally(() => {
        _videoHistoryInflight.delete(key);
      });
    _videoHistoryInflight.set(key, request);
  });
}

function cameraKey(projectId) {
  return String(_ctx.uPrefix || '') + 'board_cam_' + projectId;
}

function safeParseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function loadCamera(projectId) {
  try {
    const parsed = safeParseJson(localStorage.getItem(cameraKey(projectId)));
    if (parsed && Number.isFinite(Number(parsed.k)) && Number.isFinite(Number(parsed.x)) && Number.isFinite(Number(parsed.y))) {
      return { k: Number(parsed.k), x: Number(parsed.x), y: Number(parsed.y) };
    }
  } catch (_) {}
  return null;
}

function saveCamera(projectId, transform) {
  if (!projectId || !transform) return;
  try {
    localStorage.setItem(cameraKey(projectId), JSON.stringify({
      k: transform.k,
      x: transform.x,
      y: transform.y,
    }));
  } catch (_) {}
}

function ensureCtx(ctx) {
  const input = ctx || {};
  const allowed = new Set(BOARD_CTX_KEYS);
  Object.keys(input).forEach((key) => {
    if (!allowed.has(key)) throw new Error('initBoard received unsupported ctx key: ' + key);
  });
  _ctx = {};
  BOARD_CTX_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(input, key)) _ctx[key] = input[key];
  });
  bindVideoResultSubscription();
}

function shouldReloadForVideoResult(evt) {
  const reason = String(evt && evt.reason || '').trim();
  return reason === 'current' || reason === 'failed' || reason === 'delete';
}

function scheduleVideoResultReload(evt) {
  if (!shouldReloadForVideoResult(evt)) return;
  if (typeof _ctx.reloadProjectFromServer !== 'function') {
    scheduleVideoHistoryRefresh();
    return;
  }
  if (_videoResultReloading) {
    _videoResultReloadQueued = true;
    return;
  }
  _videoResultReloading = true;
  Promise.resolve(_ctx.reloadProjectFromServer()).then((ok) => {
    if (ok === false) scheduleVideoHistoryRefresh();
    else refreshBoardPage();
  }).catch(() => {
    scheduleVideoHistoryRefresh();
  }).finally(() => {
    _videoResultReloading = false;
    if (_videoResultReloadQueued) {
      _videoResultReloadQueued = false;
      scheduleVideoResultReload({ reason: 'current' });
    }
  });
}

function bindVideoResultSubscription() {
  if (_videoResultUnsubscribe) {
    try { _videoResultUnsubscribe(); } catch (_) {}
    _videoResultUnsubscribe = null;
  }
  if (typeof _ctx.subscribeVideoResultChanges !== 'function') return;
  _videoResultUnsubscribe = _ctx.subscribeVideoResultChanges(scheduleVideoResultReload);
}

function ensureRoot() {
  if (_root) return true;
  _root = document.getElementById('boardRoot');
  if (!_root) return false;
  _root.innerHTML = [
    '<div class="board-shell">',
    '  <header class="board-topbar" data-board-control>',
    '    <div><h1>画板</h1><p>参考图、镜头计划、首帧和视频片段</p></div>',
    '    ' + boardActionButton('确认视频，进入下一步', 'arrow_forward', 'confirm-enter-edit'),
    '  </header>',
    '  <div class="board-viewport" data-board-viewport>',
    '    <div class="board-world" data-board-world>',
    '      <div class="board-surface" aria-hidden="true"></div>',
    '      <svg class="board-edges" data-board-edges aria-hidden="true"></svg>',
    '      <div class="board-nodes" data-board-nodes></div>',
    '    </div>',
    '  </div>',
    '  <div class="board-minimap" data-board-minimap data-board-control aria-label="画板小地图">',
    '    <svg class="board-minimap-svg" data-board-minimap-svg viewBox="0 0 ' + MINIMAP_W + ' ' + MINIMAP_H + '" aria-hidden="true"></svg>',
    '  </div>',
    '  <div class="board-tools" data-board-control>',
    '    <button type="button" class="board-tool" data-board-tool="undo" disabled title="下一阶段接入"><span class="material-symbols-outlined">undo</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="redo" disabled title="下一阶段接入"><span class="material-symbols-outlined">redo</span></button>',
    '    <span class="board-tool-divider"></span>',
    '    <button type="button" class="board-tool" data-board-tool="hand" title="抓手"><span class="material-symbols-outlined">pan_tool</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="zoom-out" title="缩小"><span class="material-symbols-outlined">remove</span></button>',
    '    <button type="button" class="board-tool board-tool-scale" data-board-tool="fit" title="全览"><span data-board-scale>100%</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="zoom-in" title="放大"><span class="material-symbols-outlined">add</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="zoom-selected" title="缩放到选中"><span class="material-symbols-outlined">center_focus_strong</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="reset" title="100%"><span class="material-symbols-outlined">zoom_in_map</span></button>',
    '    <button type="button" class="board-tool" data-board-tool="help" title="帮助" aria-expanded="false" aria-controls="boardHelpPanel"><span class="material-symbols-outlined">help</span></button>',
    '  </div>',
    '  <section class="board-help-panel" id="boardHelpPanel" data-board-help data-board-control hidden aria-label="画板帮助">',
    '    <header><h2>画板操作</h2><button type="button" class="board-help-close" data-board-help-close aria-label="关闭帮助"><span class="material-symbols-outlined">close</span></button></header>',
    '    <dl>',
    '      <div><dt>移动</dt><dd>双指拖动，或按住空格拖动画板</dd></div>',
    '      <div><dt>缩放</dt><dd>触控板捏合，或 Ctrl/⌘ + 滚轮</dd></div>',
    '      <div><dt>全览</dt><dd>Shift + 1</dd></div>',
    '      <div><dt>选中节点</dt><dd>点击节点后按 Shift + 2 聚焦</dd></div>',
    '      <div><dt>重置</dt><dd>按 0 回到 100%</dd></div>',
    '    </dl>',
    '  </section>',
    '</div>',
  ].join('');

  _viewportRoot = _root.querySelector('[data-board-viewport]');
  _worldEl = _root.querySelector('[data-board-world]');
  _nodesEl = _root.querySelector('[data-board-nodes]');
  _edgesEl = _root.querySelector('[data-board-edges]');
  _surfaceEl = _root.querySelector('.board-surface');
  _toolsEl = _root.querySelector('.board-tools');
  _scaleLabelEl = _root.querySelector('[data-board-scale]');
  _miniMapEl = _root.querySelector('[data-board-minimap]');
  _miniMapSvgEl = _root.querySelector('[data-board-minimap-svg]');
  _helpEl = _root.querySelector('[data-board-help]');

  _viewport = createViewport(_viewportRoot, {
    worldEl: _worldEl,
    edgesSvgEl: _edgesEl,
    onViewportChange(transform) {
      if (_scaleLabelEl) _scaleLabelEl.textContent = Math.round(transform.k * 100) + '%';
      const projectId = projectIdOf(currentProject());
      saveCamera(projectId, transform);
      scheduleBoardImageHydration();
      updateMiniMapViewport();
    },
    onEscape() {
      _selectedId = '';
    },
  });

	  _viewportRoot.addEventListener('click', onViewportClick);
	  _toolsEl.addEventListener('click', onToolClick);
	  _root.addEventListener('click', onRootClick);
	  _root.addEventListener('dragstart', onCandidateDragStart);
	  _root.addEventListener('dragover', onCandidateDragOver);
	  _root.addEventListener('drop', onCandidateDrop);
	  _root.addEventListener('dragend', onCandidateDragEnd);
	  if (_miniMapEl) _miniMapEl.addEventListener('pointerdown', onMiniMapPointerDown);
	  return true;
	}

function currentProject() {
  if (_project) return _project;
  return typeof _ctx.getProject === 'function' ? _ctx.getProject() : null;
}

function minimapMetrics(bounds) {
  const box = bounds || {};
  const w = Math.max(1, Number(box.w) || 1);
  const h = Math.max(1, Number(box.h) || 1);
  const usableW = MINIMAP_W - MINIMAP_PAD * 2;
  const usableH = MINIMAP_H - MINIMAP_PAD * 2;
  const scale = Math.min(usableW / w, usableH / h);
  const drawnW = w * scale;
  const drawnH = h * scale;
  return {
    bounds: { x: Number(box.x) || 0, y: Number(box.y) || 0, w, h },
    scale,
    ox: (MINIMAP_W - drawnW) / 2,
    oy: (MINIMAP_H - drawnH) / 2,
  };
}

function mapWorldRect(rect, metrics) {
  return {
    x: metrics.ox + (Number(rect.x) - metrics.bounds.x) * metrics.scale,
    y: metrics.oy + (Number(rect.y) - metrics.bounds.y) * metrics.scale,
    w: Math.max(1, Number(rect.w) * metrics.scale),
    h: Math.max(1, Number(rect.h) * metrics.scale),
  };
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampMiniMapViewRect(rect, metrics) {
  const maxW = metrics.bounds.w * metrics.scale;
  const maxH = metrics.bounds.h * metrics.scale;
  const w = Math.min(maxW, Math.max(6, rect.w));
  const h = Math.min(maxH, Math.max(6, rect.h));
  return {
    x: maxW <= w ? metrics.ox : clampValue(rect.x, metrics.ox, metrics.ox + maxW - w),
    y: maxH <= h ? metrics.oy : clampValue(rect.y, metrics.oy, metrics.oy + maxH - h),
    w,
    h,
  };
}

function currentViewportWorldRect() {
  if (!_viewport || !_viewportRoot) return null;
  const transform = _viewport.getTransform();
  const rect = _viewportRoot.getBoundingClientRect ? _viewportRoot.getBoundingClientRect() : null;
  const vw = Math.max(1, Number((rect && rect.width) || _viewportRoot.clientWidth) || 1);
  const vh = Math.max(1, Number((rect && rect.height) || _viewportRoot.clientHeight) || 1);
  const k = Math.max(0.01, Number(transform.k) || 1);
  return {
    x: -Number(transform.x || 0) / k,
    y: -Number(transform.y || 0) / k,
    w: vw / k,
    h: vh / k,
  };
}

function nodeMiniMapClass(kind) {
  const safe = String(kind || 'node').replace(/[^a-z0-9_-]/gi, '');
  return 'board-minimap-node board-minimap-node--' + (safe || 'node');
}

function updateMiniMap(vm) {
  _lastViewModel = vm || null;
  if (!_miniMapSvgEl || !vm || !Array.isArray(vm.nodes)) {
    if (_miniMapSvgEl) _miniMapSvgEl.innerHTML = '';
    return;
  }
  const metrics = minimapMetrics(vm.bounds);
  const nodes = vm.nodes.map((node) => {
    const r = mapWorldRect(node, metrics);
    return '<rect class="' + nodeMiniMapClass(node.kind) + '" x="' + r.x.toFixed(2) + '" y="' + r.y.toFixed(2) + '" width="' + r.w.toFixed(2) + '" height="' + r.h.toFixed(2) + '" rx="3"></rect>';
  }).join('');
  _miniMapSvgEl.innerHTML =
    '<rect class="board-minimap-bg" x="0.5" y="0.5" width="' + (MINIMAP_W - 1) + '" height="' + (MINIMAP_H - 1) + '" rx="8"></rect>' +
    nodes +
    '<rect class="board-minimap-view" data-board-minimap-view x="0" y="0" width="1" height="1" rx="3"></rect>';
  updateMiniMapViewport();
}

function updateMiniMapViewport() {
  if (!_miniMapSvgEl || !_lastViewModel) return;
  const viewEl = _miniMapSvgEl.querySelector('[data-board-minimap-view]');
  const worldView = currentViewportWorldRect();
  if (!viewEl || !worldView) return;
  const metrics = minimapMetrics(_lastViewModel.bounds);
  const r = clampMiniMapViewRect(mapWorldRect(worldView, metrics), metrics);
  viewEl.setAttribute('x', r.x.toFixed(2));
  viewEl.setAttribute('y', r.y.toFixed(2));
  viewEl.setAttribute('width', r.w.toFixed(2));
  viewEl.setAttribute('height', r.h.toFixed(2));
}

function onMiniMapPointerDown(event) {
  if (!_viewport || !_viewportRoot || !_miniMapSvgEl || !_lastViewModel) return;
  const rect = _miniMapSvgEl.getBoundingClientRect ? _miniMapSvgEl.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return;
  const metrics = minimapMetrics(_lastViewModel.bounds);
  const px = (Number(event.clientX) - rect.left) * (MINIMAP_W / rect.width);
  const py = (Number(event.clientY) - rect.top) * (MINIMAP_H / rect.height);
  const worldX = clampValue(metrics.bounds.x + (px - metrics.ox) / metrics.scale, metrics.bounds.x, metrics.bounds.x + metrics.bounds.w);
  const worldY = clampValue(metrics.bounds.y + (py - metrics.oy) / metrics.scale, metrics.bounds.y, metrics.bounds.y + metrics.bounds.h);
  const rootRect = _viewportRoot && _viewportRoot.getBoundingClientRect ? _viewportRoot.getBoundingClientRect() : null;
  const vw = Math.max(1, Number((rootRect && rootRect.width) || _viewportRoot.clientWidth) || 1);
  const vh = Math.max(1, Number((rootRect && rootRect.height) || _viewportRoot.clientHeight) || 1);
  const transform = _viewport.getTransform();
  _viewport.setTransform({
    k: transform.k,
    x: vw / 2 - worldX * transform.k,
    y: vh / 2 - worldY * transform.k,
  });
  event.preventDefault();
}

function toggleBoardHelp(force) {
  _helpOpen = typeof force === 'boolean' ? force : !_helpOpen;
  if (_helpEl) _helpEl.hidden = !_helpOpen;
  const helpBtn = _toolsEl && _toolsEl.querySelector('[data-board-tool="help"]');
  if (helpBtn) {
    helpBtn.classList.toggle('is-active', _helpOpen);
    helpBtn.setAttribute('aria-expanded', _helpOpen ? 'true' : 'false');
	  }
	}

function boardActionPayload(el) {
  return {
    groupIdx: Number(el && el.dataset ? el.dataset.groupIdx : NaN),
    shotUid: String(el && el.dataset ? el.dataset.shotUid || '' : '').trim(),
    candidateId: String(el && el.dataset ? el.dataset.candidateId || '' : '').trim(),
    taskId: String(el && el.dataset ? el.dataset.taskId || '' : '').trim(),
    submitMode: normalizeVideoSubmitMode(el && el.dataset ? el.dataset.submitMode || '' : ''),
  };
}

function pickBoardImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      try { input.remove(); } catch (_) {}
      resolve(file);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => { try { input.remove(); } catch (_) {} }, 30000);
  });
}

async function runBoardAction(action, payload) {
  const project = currentProject();
  if (!project || !project.id) throw new Error('no_project');
  if (action === 'candidate-select') {
    if (!_ctx.selectShotFrameCandidate) throw new Error('select_not_available');
    await _ctx.selectShotFrameCandidate(payload);
  } else if (action === 'candidate-delete') {
    if (!_ctx.deleteShotFrameCandidate) throw new Error('delete_not_available');
    await _ctx.deleteShotFrameCandidate(payload);
  } else if (action === 'candidate-generate') {
    if (!_ctx.generateShotFrameCandidate) throw new Error('generate_not_available');
    await _ctx.generateShotFrameCandidate(payload);
  } else if (action === 'candidate-upload') {
    if (!_ctx.uploadShotFrameCandidate) throw new Error('upload_not_available');
    const file = await pickBoardImageFile();
    if (!file) return;
    await _ctx.uploadShotFrameCandidate({ ...payload, file });
  } else if (action === 'segment-generate-all') {
    if (!_ctx.generateStoryboardSheet) throw new Error('segment_generate_not_available');
    await _ctx.generateStoryboardSheet(payload.groupIdx);
  } else if (action === 'video-candidate-current') {
    if (!_ctx.setVideoCandidateCurrent) throw new Error('video_current_not_available');
    await _ctx.setVideoCandidateCurrent(payload);
  } else if (action === 'video-mode-select') {
    _videoSubmitModesByGroup.set(payload.groupIdx, normalizeVideoSubmitMode(payload.submitMode));
  } else if (action === 'video-generate') {
    if (!_ctx.generateVideoForGroup) throw new Error('video_generate_not_available');
    await _ctx.generateVideoForGroup({
      groupIdx: payload.groupIdx,
      submitMode: videoSubmitModeForGroup(payload.groupIdx),
    });
  } else if (action === 'confirm-enter-edit') {
    if (!_ctx.confirmSegmentsAndEnterEdit) throw new Error('confirm_edit_not_available');
    await _ctx.confirmSegmentsAndEnterEdit();
  }
}

async function handleBoardAction(actionEl) {
  const action = String(actionEl && actionEl.dataset ? actionEl.dataset.boardAction || '' : '').trim();
  if (!action || _boardActionBusy) return;
  const payload = boardActionPayload(actionEl);
  if (action !== 'confirm-enter-edit' && (!Number.isInteger(payload.groupIdx) || payload.groupIdx < 0)) return;
  if (action !== 'confirm-enter-edit' && action !== 'segment-generate-all' && action !== 'video-candidate-current' && action !== 'video-mode-select' && action !== 'video-generate' && !payload.shotUid) {
    if (_ctx.showToast) _ctx.showToast('该镜头缺少 shotUid，不能写入候选', 'error');
    return;
  }
  if ((action === 'candidate-select' || action === 'candidate-delete') && !payload.candidateId) return;
  if (action === 'video-candidate-current' && !payload.taskId) return;
  _boardActionBusy = true;
  actionEl.disabled = true;
  try {
    await runBoardAction(action, payload);
    if (action === 'candidate-generate' || action === 'segment-generate-all') {
      if (_ctx.showToast) _ctx.showToast('已开始生成首帧候选', 'success');
    } else if (action === 'candidate-upload') {
      if (_ctx.showToast) _ctx.showToast('已上传首帧候选', 'success');
    } else if (action === 'video-candidate-current') {
      if (_ctx.showToast) _ctx.showToast('当前视频已更新', 'success');
    } else if (action === 'video-mode-select') {
      if (_ctx.showToast) _ctx.showToast('视频模式已切换为' + videoSubmitModeLabel(payload.submitMode), 'success');
    } else if (action === 'video-generate') {
      if (_ctx.showToast) _ctx.showToast('已开始生成视频', 'success');
    } else if (action === 'confirm-enter-edit') {
      // confirmSegmentsAndEnterEdit owns its import result toasts.
    } else {
      if (_ctx.showToast) _ctx.showToast('候选已更新', 'success');
    }
    if (action !== 'confirm-enter-edit') refreshBoardPage();
  } catch (err) {
    const msg = ((err && err.message) || err || '操作失败').toString().slice(0, 160);
    if (_ctx.showToast) _ctx.showToast(msg, 'error');
  } finally {
    _boardActionBusy = false;
    actionEl.disabled = false;
  }
}

function candidateCardFromEvent(event) {
  return event && event.target && event.target.closest ? event.target.closest('.board-candidate-card[data-candidate-id]') : null;
}

function candidatePayloadFromCard(card) {
  return {
    groupIdx: Number(card && card.dataset ? card.dataset.groupIdx : NaN),
    shotUid: String(card && card.dataset ? card.dataset.shotUid || '' : '').trim(),
    candidateId: String(card && card.dataset ? card.dataset.candidateId || '' : '').trim(),
  };
}

function sameCandidateScope(a, b) {
  return a && b && Number(a.groupIdx) === Number(b.groupIdx) && a.shotUid && a.shotUid === b.shotUid;
}

function onCandidateDragStart(event) {
  const card = candidateCardFromEvent(event);
  if (!card || card.getAttribute('draggable') !== 'true') return;
  const payload = candidatePayloadFromCard(card);
  if (!payload.shotUid || !payload.candidateId) return;
  _dragCandidate = payload;
  card.classList.add('is-dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', payload.candidateId);
  }
}

function onCandidateDragOver(event) {
  if (!_dragCandidate) return;
  const card = candidateCardFromEvent(event);
  const strip = event.target && event.target.closest ? event.target.closest('.board-candidate-strip') : null;
  if (!card && !strip) return;
  const targetPayload = card ? candidatePayloadFromCard(card) : _dragCandidate;
  if (!sameCandidateScope(_dragCandidate, targetPayload)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

async function onCandidateDrop(event) {
  if (!_dragCandidate || !_ctx.reorderShotFrameCandidates) return;
  const card = candidateCardFromEvent(event);
  const strip = event.target && event.target.closest ? event.target.closest('.board-candidate-strip') : null;
  if (!strip) return;
  const targetPayload = card ? candidatePayloadFromCard(card) : _dragCandidate;
  if (!sameCandidateScope(_dragCandidate, targetPayload)) return;
  event.preventDefault();
  const cards = Array.from(strip.querySelectorAll('.board-candidate-card[data-candidate-id]'))
    .filter((item) => item.getAttribute('draggable') === 'true');
  let orderedIds = cards.map((item) => String(item.dataset.candidateId || '').trim()).filter(Boolean);
  orderedIds = orderedIds.filter((id) => id !== _dragCandidate.candidateId);
  if (card && card.dataset.candidateId && card.dataset.candidateId !== _dragCandidate.candidateId) {
    const rect = card.getBoundingClientRect ? card.getBoundingClientRect() : null;
    const after = rect ? event.clientX > rect.left + rect.width / 2 : false;
    const targetId = String(card.dataset.candidateId || '').trim();
    const targetIndex = orderedIds.indexOf(targetId);
    const insertAt = targetIndex < 0 ? orderedIds.length : targetIndex + (after ? 1 : 0);
    orderedIds.splice(insertAt, 0, _dragCandidate.candidateId);
  } else {
    orderedIds.push(_dragCandidate.candidateId);
  }
  const original = cards.map((item) => String(item.dataset.candidateId || '').trim()).filter(Boolean);
  if (orderedIds.length !== original.length || orderedIds.every((id, idx) => id === original[idx])) return;
  _boardActionBusy = true;
  try {
    await _ctx.reorderShotFrameCandidates({
      groupIdx: _dragCandidate.groupIdx,
      shotUid: _dragCandidate.shotUid,
      orderedIds,
    });
    if (_ctx.showToast) _ctx.showToast('候选顺序已更新', 'success');
    refreshBoardPage();
  } catch (err) {
    const msg = ((err && err.message) || err || '候选排序失败').toString().slice(0, 160);
    if (_ctx.showToast) _ctx.showToast(msg, 'error');
  } finally {
    _boardActionBusy = false;
    onCandidateDragEnd();
  }
}

function onCandidateDragEnd() {
  if (_root && _root.querySelectorAll) {
    _root.querySelectorAll('.board-candidate-card.is-dragging').forEach((card) => card.classList.remove('is-dragging'));
  }
  _dragCandidate = null;
}

function onRootClick(event) {
  const actionEl = event.target && event.target.closest ? event.target.closest('[data-board-action]') : null;
  if (actionEl) {
    event.preventDefault();
    event.stopPropagation();
    handleBoardAction(actionEl);
    return;
  }
	  const close = event.target && event.target.closest ? event.target.closest('[data-board-help-close]') : null;
	  if (close) toggleBoardHelp(false);
	}

function setSurfaceBounds(bounds) {
  if (!_surfaceEl || !_edgesEl) return;
  const pad = 400;
  const w = Math.max(1600, Math.ceil((bounds && bounds.w) || 0) + pad * 2);
  const h = Math.max(1000, Math.ceil((bounds && bounds.h) || 0) + pad * 2);
  _surfaceEl.style.left = -pad + 'px';
  _surfaceEl.style.top = -pad + 'px';
  _surfaceEl.style.width = w + 'px';
  _surfaceEl.style.height = h + 'px';
  _edgesEl.style.left = -pad + 'px';
  _edgesEl.style.top = -pad + 'px';
  _edgesEl.setAttribute('width', String(w));
  _edgesEl.setAttribute('height', String(h));
  _edgesEl.setAttribute('viewBox', `${-pad} ${-pad} ${w} ${h}`);
}

function referenceSection(label, items) {
  const rows = (items || []).map((item) => {
    return '<div class="board-ref-item">' +
      assetImg(item.coverUrl, item.name) +
      '<span>' + escapeHtml(item.name) + '</span>' +
    '</div>';
  }).join('');
  return '<section class="board-ref-section"><h3>' + escapeHtml(label) + '</h3>' + (rows || '<p class="board-muted">暂无</p>') + '</section>';
}

function renderReferenceNode(data) {
  if (!data || data.empty) {
    return '<div class="board-node-card board-node-card--reference board-empty-reference">' +
      '<h2>参考图</h2><p>点击导入参考图</p>' +
      disabledButton('导入参考图', 'add_photo_alternate') +
    '</div>';
  }
  return '<div class="board-node-card board-node-card--reference">' +
    '<div class="board-node-head"><h2>参考图</h2><span>' +
    escapeHtml((data.characters.length + data.scenes.length + data.props.length) + ' 项') +
    '</span></div>' +
    referenceSection('角色', data.characters) +
    referenceSection('场景', data.scenes) +
    referenceSection('道具', data.props) +
    disabledButton('生成镜头计划', 'auto_awesome') +
  '</div>';
}

function stepRow(done, label) {
  return '<li class="' + (done ? 'is-done' : '') + '"><span>' + (done ? '✓' : '•') + '</span>' + escapeHtml(label) + '</li>';
}

function renderShotPlanNode(data) {
  const steps = data && data.steps ? data.steps : {};
  return '<div class="board-node-card board-node-card--plan">' +
    '<div class="board-node-head"><h2>镜头计划</h2><span>' + escapeHtml((data && data.shotCount) || 0) + ' 镜头</span></div>' +
    '<ul class="board-plan-steps">' +
    stepRow(steps.confirmShots, '确认镜头') +
    stepRow(steps.prepareAssets, '准备资产') +
    stepRow(steps.composePrompt, '合成提示词') +
    '</ul>' +
    actionButton('打开脚本节点', 'open_in_new', 'open-shot-plan-dialog') +
	  '</div>';
	}

function renderCandidateCard(groupIdx, row, candidate, idx) {
  const selected = !!(candidate && candidate.selected);
  const placeholder = candidate && candidate.kind === 'segment-cover-placeholder';
  const candidateId = candidate && candidate.id ? candidate.id : '';
  const attrs = boardActionAttrs(groupIdx, row.shotUid, candidateId);
  return '<div class="board-candidate-card ' + (selected ? 'is-selected ' : '') + (placeholder ? 'is-placeholder' : '') + '" ' + attrs + ' ' + (placeholder || !row.shotUid || candidate.readOnly ? '' : 'draggable="true"') + '>' +
    '<button type="button" class="board-candidate-thumb" data-board-control data-board-action="candidate-select" ' + attrs + ' ' + (placeholder || !row.shotUid ? 'disabled aria-disabled="true"' : '') + '>' +
    assetImg(candidate && candidate.url, '镜头' + (row.shotIdx + 1) + '候选' + (idx + 1)) +
    (selected ? '<span class="board-candidate-check material-symbols-outlined">check_circle</span>' : '') +
    '</button>' +
    '<div class="board-candidate-meta">' +
    '<span>' + escapeHtml(candidate && candidate.label ? candidate.label : ('候选 ' + (idx + 1))) + '</span>' +
    (placeholder || !row.shotUid || candidate.readOnly ? '' : boardIconButton('candidate-delete', 'delete', '删除候选', attrs)) +
    '</div>' +
  '</div>';
}

function renderRowActions(groupIdx, row, hasCandidates) {
  if (!row.shotUid) return '<div class="board-frame-actions"><span class="board-muted">缺 shotUid</span></div>';
  const attrs = boardActionAttrs(groupIdx, row.shotUid);
  const generateLabel = hasCandidates ? '重新生成' : '生成图片';
  return '<div class="board-frame-actions">' +
    '<button type="button" class="board-btn" data-board-control data-board-action="candidate-generate" ' + attrs + '><span class="material-symbols-outlined">auto_awesome</span><span>' + escapeHtml(generateLabel) + '</span></button>' +
    '<button type="button" class="board-btn" data-board-control data-board-action="candidate-upload" ' + attrs + '><span class="material-symbols-outlined">upload</span><span>上传图片</span></button>' +
  '</div>';
}

function renderSegmentNode(data) {
	  const shotRows = data && data.shotRows ? data.shotRows : [];
	  const placeholderCount = shotRows.filter((row) => row.candidates && row.candidates[0] && row.candidates[0].kind === 'segment-cover-placeholder').length;
	  const readyCount = shotRows.filter((row) => (row.candidates || []).some((candidate) => candidate && candidate.kind !== 'segment-cover-placeholder')).length;
	  const badgeText = readyCount ? '首帧 ' + readyCount + '/' + shotRows.length : (placeholderCount ? '封面占位 ' + placeholderCount + '/' + shotRows.length : '首帧 0/' + shotRows.length);
	  const allReady = shotRows.length > 0 && readyCount === shotRows.length;
	  const rows = shotRows.map((row) => {
	    const candidates = row.candidates || [];
	    const realCandidateCount = candidates.filter((candidate) => candidate && candidate.kind !== 'segment-cover-placeholder').length;
	    return '<div class="board-shot-row">' +
	      '<div class="board-shot-label">镜头 ' + escapeHtml(row.shotIdx + 1) + '</div>' +
	      '<div class="board-candidate-strip">' +
	      (candidates.length ? candidates.map((candidate, idx) => renderCandidateCard(data.gIdx, row, candidate, idx)).join('') : '<div class="board-frame-card">' + assetImg('', '') + '<span>待生成</span></div>') +
	      '</div>' +
	      renderRowActions(data.gIdx, row, realCandidateCount > 0) +
	    '</div>';
	  }).join('');
	  return '<div class="board-node-card board-node-card--segment">' +
	    '<div class="board-node-head"><h2>片段 ' + escapeHtml((data && data.gIdx) + 1) + '</h2><span>' + escapeHtml(badgeText) + '</span></div>' +
	    '<div class="board-shot-rows">' + (rows || '<p class="board-muted">暂无镜头</p>') + '</div>' +
	    (allReady ? '' : '<button type="button" class="board-btn" data-board-control data-board-action="segment-generate-all" data-group-idx="' + escapeHtml((data && data.gIdx) || 0) + '"><span class="material-symbols-outlined">auto_awesome</span><span>一键全生成</span></button>') +
	  '</div>';
	}

function statusLabel(status) {
  const map = {
    ready: '已生成',
    generating: '生成中',
    failed: '失败',
    outdated: '已过期',
    missing: '待生成',
  };
  return map[status] || '待生成';
}

function videoCandidateMeta(candidate) {
  const parts = [];
  const duration = Number(candidate && candidate.durationSec);
  if (Number.isFinite(duration) && duration > 0) parts.push(Math.round(duration) + 's');
  const createdAt = String(candidate && candidate.createdAt ? candidate.createdAt : '').trim();
  if (createdAt) parts.push(createdAt.slice(0, 10));
  return parts.join(' · ');
}

function renderVideoCandidateCard(groupIdx, data, candidate, idx) {
  const taskId = candidate && candidate.taskId ? candidate.taskId : '';
  const selected = !!(taskId && taskId === (data && data.selectedTaskId));
  const attrs = videoActionAttrs(groupIdx, taskId);
  const prompt = String(candidate && candidate.prompt ? candidate.prompt : '').trim();
  const meta = videoCandidateMeta(candidate);
  return '<div class="board-video-candidate ' + (selected ? 'is-selected' : '') + '">' +
    '<button type="button" class="board-video-candidate-thumb" data-board-control data-board-action="video-candidate-current" ' + attrs + ' aria-pressed="' + (selected ? 'true' : 'false') + '" title="设为当前视频">' +
    assetImg((candidate && candidate.coverUrl) || (data && data.coverUrl), '视频候选' + (idx + 1)) +
    '<span class="board-radio" aria-hidden="true"></span>' +
    '</button>' +
    '<div class="board-video-candidate-meta">' +
    '<strong>' + escapeHtml(candidate && candidate.label ? candidate.label : ('候选 ' + (idx + 1))) + '</strong>' +
    (meta ? '<span>' + escapeHtml(meta) + '</span>' : '') +
    (prompt ? '<p>' + escapeHtml(prompt) + '</p>' : '') +
    '</div>' +
  '</div>';
}

function renderVideoModeSelector(groupIdx) {
  const current = videoSubmitModeForGroup(groupIdx);
  const modes = [
    ['auto', '全能参考'],
    ['reference_images', '智能多帧'],
    ['first_last_frame', '首尾帧'],
  ];
  return '<div class="board-video-mode" role="group" aria-label="视频生成模式">' +
    modes.map(([mode, label]) => {
      const active = mode === current;
      return '<button type="button" class="' + (active ? 'is-active' : '') + '" data-board-control data-board-action="video-mode-select" data-group-idx="' + escapeHtml(groupIdx) + '" data-submit-mode="' + escapeHtml(mode) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' + escapeHtml(label) + '</button>';
    }).join('') +
  '</div>';
}

function videoGenerateReadinessForGroup(groupIdx) {
  if (typeof _ctx.getVideoGenerateReadiness !== 'function') return { canStart: true, message: '' };
  const readiness = _ctx.getVideoGenerateReadiness(groupIdx) || {};
  return {
    canStart: readiness.canStart !== false,
    message: String(readiness.message || '').trim(),
  };
}

function renderVideoNode(data) {
  const status = data && data.status ? data.status : 'missing';
  const candidates = Array.isArray(data && data.candidates) ? data.candidates : [];
  const groupIdx = Number(data && data.gIdx);
  const generateReadiness = videoGenerateReadinessForGroup(groupIdx);
  const generateDisabled = generateReadiness.canStart
    ? ''
    : ' disabled aria-disabled="true" title="' + escapeHtml(generateReadiness.message || '视频提示词未就绪') + '"';
  const generateClass = generateReadiness.canStart ? 'board-btn' : 'board-btn board-btn--disabled';
  const candidateList = candidates.length
    ? '<div class="board-video-candidate-list">' + candidates.map((candidate, idx) => renderVideoCandidateCard(groupIdx, data, candidate, idx)).join('') + '</div>'
    : '<div class="board-video-empty"><div class="board-video-cover">' + assetImg(data && data.coverUrl, '视频封面') + '<span class="board-radio" aria-hidden="true"></span></div><span>暂无视频候选</span></div>';
  return '<div class="board-node-card board-node-card--video">' +
    '<div class="board-node-head"><h2>视频</h2><span class="board-status board-status--' + escapeHtml(status) + '">' + escapeHtml(statusLabel(status)) + '</span></div>' +
    candidateList +
    renderVideoModeSelector(groupIdx) +
    '<button type="button" class="' + generateClass + '" data-board-control data-board-action="video-generate" data-group-idx="' + escapeHtml(groupIdx) + '"' + generateDisabled + '><span class="material-symbols-outlined">movie</span><span>生成新视频</span></button>' +
  '</div>';
}

function renderNode(node) {
  if (node.kind === 'reference') return renderReferenceNode(node.data);
  if (node.kind === 'shot-plan') return renderShotPlanNode(node.data);
  if (node.kind === 'segment') return renderSegmentNode(node.data);
  if (node.kind === 'video') return renderVideoNode(node.data);
  return '<div class="board-node-card"><p class="board-muted">未知节点</p></div>';
}

function ensureNodeElement(node) {
  let el = _nodeEls.get(node.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'board-node board-node--' + node.kind;
    el.dataset.boardNodeId = node.id;
    el.tabIndex = 0;
    _nodesEl.appendChild(el);
    _nodeEls.set(node.id, el);
    _viewport.mountNode(node.id, el, node);
  } else {
    el.className = 'board-node board-node--' + node.kind;
    _viewport.updateNode(node.id, node);
  }
  const html = renderNode(node);
  if (el.dataset.renderHash !== html) {
    el.innerHTML = html;
    el.dataset.renderHash = html;
  }
  return el;
}

function removeStaleNodes(nextIds) {
  const keep = new Set(nextIds);
  Array.from(_nodeEls.keys()).forEach((id) => {
    if (keep.has(id)) return;
    unobserveBoardImages(_nodeEls.get(id));
    _viewport.removeNode(id);
    _nodeEls.delete(id);
  });
}

function applyCamera(projectId) {
  if (!_viewport || _cameraReadyProjectId === projectId) return;
  const saved = loadCamera(projectId);
  if (saved) {
    _viewport.setTransform(saved, { immediate: true });
    _cameraReadyProjectId = projectId;
  } else if (_viewport.fit()) {
    _cameraReadyProjectId = projectId;
  }
}

function hydrate() {
  scheduleBoardImageHydration();
}

function onViewportClick(event) {
  const nodeEl = event.target && event.target.closest ? event.target.closest('[data-board-node-id]') : null;
  const controlEl = event.target && event.target.closest ? event.target.closest('[data-board-control]') : null;
  if (controlEl) return;
  _selectedId = nodeEl ? nodeEl.dataset.boardNodeId : '';
  if (_viewport) _viewport.setSelected(_selectedId);
}

function onToolClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('[data-board-tool]') : null;
  if (!btn || !_viewport || btn.disabled) return;
  const tool = btn.dataset.boardTool;
  if (tool === 'fit') _viewport.fit();
  else if (tool === 'zoom-in') _viewport.zoomBy(1.1);
  else if (tool === 'zoom-out') _viewport.zoomBy(1 / 1.1);
  else if (tool === 'zoom-selected') _viewport.zoomToSelection();
  else if (tool === 'reset') _viewport.zoomTo(1);
  else if (tool === 'hand') {
    _handMode = !_handMode;
    _viewport.setHandMode(_handMode);
    btn.classList.toggle('is-active', _handMode);
  } else if (tool === 'help') {
    toggleBoardHelp();
  }
}

export function initBoard(ctx) {
  ensureCtx(ctx);
  ensureRoot();
}

export function syncBoardProject(project) {
  _project = project || null;
  const projectId = projectIdOf(_project);
  const projectVersion = projectVersionOf(_project);
  if (_lastProjectId !== projectId) {
    _lastProjectId = projectId;
    _lastProjectVersion = projectVersion;
    _cameraReadyProjectId = '';
    _selectedId = '';
    _videoHistoryCache = new Map();
    _videoHistoryInflight = new Map();
    _videoSubmitModesByGroup = new Map();
  } else if (_lastProjectVersion !== projectVersion) {
    _lastProjectVersion = projectVersion;
    pruneVideoHistoryCacheForCurrentVersion(_project);
  }
}

export function refreshBoardPage() {
  if (!ensureRoot()) return;
  const project = currentProject();
  if (!project) {
    unobserveBoardImages(_nodesEl);
    _nodesEl.innerHTML = '<div class="board-no-project"><h2>画板</h2><p>暂无项目</p></div>';
    _nodeEls.clear();
    _viewport.setEdges([]);
    updateMiniMap(null);
    return;
  }
  const groups = typeof _ctx.getStoryboardGroups === 'function' ? _ctx.getStoryboardGroups() : [];
  ensureVideoHistories(project, groups);
  const vm = buildBoardViewModel(project, { groups, videoHistoriesByGroup: videoHistoriesForView(project, groups) });
  setSurfaceBounds(vm.bounds);
  removeStaleNodes(vm.nodes.map((node) => node.id));
  vm.nodes.forEach(ensureNodeElement);
  _viewport.setEdges(vm.edges);
  _viewport.setSelected(_selectedId);
  updateMiniMap(vm);
  applyCamera(projectIdOf(project));
  _viewport.refreshCulling();
  hydrate();
}
