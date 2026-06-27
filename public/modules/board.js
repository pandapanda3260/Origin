import { assertModuleSingleton } from '/modules/module_singleton_guard.js';
import { buildBoardViewModel } from '/modules/board_state.js';
import { createViewport } from '/modules/board_viewport.js';
import { resolveProtectedImageBlobUrl } from '/modules/utils.js';

assertModuleSingleton('board', import.meta.url);

export const BOARD_CTX_KEYS = ['getProject', 'getStoryboardGroups', 'hydrateProtectedImageElements', 'showToast', 'uPrefix'];

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
let _viewport = null;
let _nodeEls = new Map();
let _selectedId = '';
let _lastProjectId = '';
let _cameraReadyProjectId = '';
let _handMode = false;
const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

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

function hydrateBoardImages(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('img[data-board-src]').forEach((img) => {
    const source = String(img.getAttribute('data-board-src') || '').trim();
    if (!source || img.getAttribute('data-board-resolved-source') === source) return;
    img.setAttribute('data-board-resolved-source', source);
    resolveProtectedImageBlobUrl(source).then((resolved) => {
      if (img.getAttribute('data-board-src') !== source) return;
      img.src = resolved || EMPTY_IMAGE_SRC;
      img.classList.remove('is-image-missing');
    }).catch(() => {
      if (img.getAttribute('data-board-src') !== source) return;
      img.classList.add('is-image-missing');
    });
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

function projectIdOf(project) {
  return String(project && project.id ? project.id : 'draft');
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
}

function ensureRoot() {
  if (_root) return true;
  _root = document.getElementById('boardRoot');
  if (!_root) return false;
  _root.innerHTML = [
    '<div class="board-shell">',
    '  <header class="board-topbar" data-board-control>',
    '    <div><h1>画板</h1><p>参考图、镜头计划、首帧和视频片段</p></div>',
    '    ' + disabledButton('确认视频，进入下一步', 'arrow_forward'),
    '  </header>',
    '  <div class="board-viewport" data-board-viewport>',
    '    <div class="board-world" data-board-world>',
    '      <div class="board-surface" aria-hidden="true"></div>',
    '      <svg class="board-edges" data-board-edges aria-hidden="true"></svg>',
    '      <div class="board-nodes" data-board-nodes></div>',
    '    </div>',
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
    '    <button type="button" class="board-tool" data-board-tool="help" title="帮助"><span class="material-symbols-outlined">help</span></button>',
    '  </div>',
    '</div>',
  ].join('');

  _viewportRoot = _root.querySelector('[data-board-viewport]');
  _worldEl = _root.querySelector('[data-board-world]');
  _nodesEl = _root.querySelector('[data-board-nodes]');
  _edgesEl = _root.querySelector('[data-board-edges]');
  _surfaceEl = _root.querySelector('.board-surface');
  _toolsEl = _root.querySelector('.board-tools');
  _scaleLabelEl = _root.querySelector('[data-board-scale]');

  _viewport = createViewport(_viewportRoot, {
    worldEl: _worldEl,
    edgesSvgEl: _edgesEl,
    onViewportChange(transform) {
      if (_scaleLabelEl) _scaleLabelEl.textContent = Math.round(transform.k * 100) + '%';
      const projectId = projectIdOf(currentProject());
      saveCamera(projectId, transform);
    },
    onEscape() {
      _selectedId = '';
    },
  });

  _viewportRoot.addEventListener('click', onViewportClick);
  _toolsEl.addEventListener('click', onToolClick);
  return true;
}

function currentProject() {
  if (_project) return _project;
  return typeof _ctx.getProject === 'function' ? _ctx.getProject() : null;
}

function setSurfaceBounds(bounds) {
  if (!_surfaceEl || !_edgesEl) return;
  const w = Math.max(1600, Math.ceil((bounds && bounds.w) || 0) + 800);
  const h = Math.max(1000, Math.ceil((bounds && bounds.h) || 0) + 800);
  _surfaceEl.style.left = '-400px';
  _surfaceEl.style.top = '-400px';
  _surfaceEl.style.width = w + 'px';
  _surfaceEl.style.height = h + 'px';
  _edgesEl.setAttribute('width', String(w));
  _edgesEl.setAttribute('height', String(h));
  _edgesEl.setAttribute('viewBox', '-400 -400 ' + w + ' ' + h);
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

function renderSegmentNode(data) {
  const rows = (data && data.shotRows ? data.shotRows : []).map((row) => {
    const candidate = row.candidates && row.candidates[0];
    return '<div class="board-shot-row">' +
      '<div class="board-shot-label">镜头 ' + escapeHtml(row.shotIdx + 1) + '</div>' +
      '<div class="board-frame-card">' +
      assetImg(candidate && candidate.url, '镜头' + (row.shotIdx + 1) + '首帧') +
      '<span>镜头' + escapeHtml(row.shotIdx + 1) + '首帧图</span>' +
      '</div>' +
      (candidate ? '' : '<div class="board-frame-actions">' + disabledButton('生成图片', 'auto_awesome') + disabledButton('上传图片', 'upload') + '</div>') +
    '</div>';
  }).join('');
  return '<div class="board-node-card board-node-card--segment">' +
    '<div class="board-node-head"><h2>片段 ' + escapeHtml((data && data.gIdx) + 1) + '</h2><span>首帧 ' +
    escapeHtml((data && data.shotRows ? data.shotRows.filter((row) => row.coverUrl).length : 0) + '/' + (data && data.shotRows ? data.shotRows.length : 0)) +
    '</span></div>' +
    '<div class="board-shot-rows">' + (rows || '<p class="board-muted">暂无镜头</p>') + '</div>' +
    disabledButton('一键全生成', 'auto_awesome') +
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

function renderVideoNode(data) {
  const status = data && data.status ? data.status : 'missing';
  return '<div class="board-node-card board-node-card--video">' +
    '<div class="board-node-head"><h2>视频</h2><span class="board-status board-status--' + escapeHtml(status) + '">' + escapeHtml(statusLabel(status)) + '</span></div>' +
    '<div class="board-video-cover">' + assetImg(data && data.coverUrl, '视频封面') + '<span class="board-radio" aria-hidden="true"></span></div>' +
    disabledButton('生成新视频', 'movie') +
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
    _viewport.removeNode(id);
    _nodeEls.delete(id);
  });
}

function applyCamera(projectId) {
  if (!_viewport || _cameraReadyProjectId === projectId) return;
  const saved = loadCamera(projectId);
  if (saved) _viewport.setTransform(saved, { immediate: true });
  else _viewport.fit();
  _cameraReadyProjectId = projectId;
}

function hydrate() {
  hydrateBoardImages(_root);
  if (typeof _ctx.hydrateProtectedImageElements === 'function') {
    _ctx.hydrateProtectedImageElements(_root);
  }
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
  } else if (tool === 'help' && typeof _ctx.showToast === 'function') {
    _ctx.showToast('下一阶段接入画板帮助', 'info');
  }
}

export function initBoard(ctx) {
  ensureCtx(ctx);
  ensureRoot();
}

export function syncBoardProject(project) {
  _project = project || null;
  const projectId = projectIdOf(_project);
  if (_lastProjectId !== projectId) {
    _lastProjectId = projectId;
    _cameraReadyProjectId = '';
    _selectedId = '';
  }
}

export function refreshBoardPage() {
  if (!ensureRoot()) return;
  const project = currentProject();
  if (!project) {
    _nodesEl.innerHTML = '<div class="board-no-project"><h2>画板</h2><p>暂无项目</p></div>';
    _nodeEls.clear();
    _viewport.setEdges([]);
    return;
  }
  const groups = typeof _ctx.getStoryboardGroups === 'function' ? _ctx.getStoryboardGroups() : [];
  const vm = buildBoardViewModel(project, { groups });
  setSurfaceBounds(vm.bounds);
  removeStaleNodes(vm.nodes.map((node) => node.id));
  vm.nodes.forEach(ensureNodeElement);
  _viewport.setEdges(vm.edges);
  _viewport.setSelected(_selectedId);
  applyCamera(projectIdOf(project));
  _viewport.refreshCulling();
  hydrate();
}
