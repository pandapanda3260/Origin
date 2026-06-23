import { $, ApiError, apiRequest, apiUpload, escapeHtml, hydrateProtectedImageElements, showConfirm } from '/modules/utils.js';

var _ctx = {};
var _wired = false;
var _view = 'list';
var _items = [];
var _drafts = [];
var _versions = [];
var _selectedScene = null;
var _selectedSceneId = null;
var _selectedVersion = null;
var _busy = false;
var _busyRole = '';
var _refUploading = false;
var _ref = null;
var _listCache = { key: '', items: null, loadedAt: 0 };
var _LIST_CACHE_TTL_MS = 2 * 60 * 1000;
var _DRAFT_POLL_INTERVAL_MS = 5000;
var _draftPollTimer = 0;
var _draftPollInFlight = false;
var SCENE_TITLE_MAX = 24;
var SCENE_PROMPT_MAX = 420;
var SCENE_REFERENCE_UPLOAD_SURFACE = 'scene_reference';
var SCENE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
var SCENE_VIEW_ROLES = ['establishing', 'topdown', 'reverse', 'alt'];
var SCENE_VIEW_LABELS = {
  establishing: '主视图',
  topdown: '俯视图',
  reverse: '反向视图',
  alt: '侧向视图',
};
var _form = {
  title: '',
  prompt: '',
  params: {
    timeSetting: '',
    weather: '',
    lighting: '',
    atmosphere: '',
  },
};

export function initSceneCustom(ctx) {
  _ctx = ctx || {};
}

function _toast(msg, type) {
  if (_ctx.showToast) _ctx.showToast(msg, type || 'info');
}

function _projectId() {
  var p = _ctx.getProject ? _ctx.getProject() : null;
  return p && p.id ? p.id : '';
}

function _jsonFetch(url, opts) {
  opts = opts || {};
  return apiRequest(url, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: opts.headers,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    responseType: 'json',
  }).catch(function (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error('请求时间较长，请稍后查看历史记录或重新尝试');
    throw e;
  });
}

function _setBusy(value, role) {
  _busy = !!value;
  _busyRole = _busy ? String(role || 'main') : '';
}

function _openZoom(url, title) {
  url = String(url || '').trim();
  if (!url) return;
  if (_ctx.openLightbox) {
    _ctx.openLightbox(url, title || '场景图');
    return;
  }
  _toast('暂时无法打开大图，请稍后再试', 'warn');
}

function _afterRender(fn) {
  try {
    requestAnimationFrame(function () { try { fn(); } catch (_) {} });
  } catch (_) {
    setTimeout(function () { try { fn(); } catch (__) {} }, 0);
  }
}

function _scrollEditorTop() {
  _afterRender(function () {
    var root = $('sceneCustomRoot');
    var target = root && root.querySelector('.toolbox-tool-head') || root;
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function _scrollPreviewIntoView() {
  _afterRender(function () {
    var target = $('scenePreviewArea');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function _listCacheKey() {
  return '__all__';
}

function _listCacheFresh(key) {
  return _listCache && _listCache.key === key && Array.isArray(_listCache.items) && Date.now() - Number(_listCache.loadedAt || 0) < _LIST_CACHE_TTL_MS;
}

function _storeListCache() {
  _listCache = { key: _listCacheKey(), items: (_items || []).slice(), loadedAt: Date.now() };
}

function _invalidateListCache() {
  _listCache = { key: '', items: null, loadedAt: 0 };
}

function _versionStatus(version) {
  return String(version && (version.generationStatus || version.status) || '').toLowerCase();
}

function _versionSceneData(version) {
  return version && (version.sceneData || version.fields) || {};
}

function _currentSceneData() {
  return _versionSceneData(_selectedVersion) || _selectedScene && _selectedScene.current || {};
}

function _draftVersionStatus(item) {
  return _versionStatus(item && item.currentVersion);
}

function _hasRunningDrafts() {
  if (_selectedScene && _selectedScene.lifecycleStatus === 'draft' && _versionStatus(_selectedVersion) === 'running') return true;
  return (_drafts || []).some(function (item) { return _draftVersionStatus(item) === 'running'; });
}

function _clearDraftPoll() {
  if (_draftPollTimer) {
    clearTimeout(_draftPollTimer);
    _draftPollTimer = 0;
  }
}

function _shouldPollDrafts() {
  if (_view !== 'draftEditor') return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  return _hasRunningDrafts();
}

function _syncDraftPolling() {
  if (!_shouldPollDrafts()) {
    _clearDraftPoll();
    return;
  }
  if (_draftPollTimer || _draftPollInFlight) return;
  _draftPollTimer = setTimeout(_pollRunningDrafts, _DRAFT_POLL_INTERVAL_MS);
}

function _draftStatusMap() {
  var out = {};
  (_drafts || []).forEach(function (item) {
    if (item && item.id) out[item.id] = _draftVersionStatus(item);
  });
  return out;
}

async function _pollRunningDrafts() {
  _draftPollTimer = 0;
  if (!_shouldPollDrafts() || _draftPollInFlight) return;
  _draftPollInFlight = true;
  var before = _draftStatusMap();
  var selectedId = _selectedSceneId;
  var selectedWasRunning = _versionStatus(_selectedVersion) === 'running';
  try {
    await _loadDrafts();
    var selectedDraft = (_drafts || []).find(function (item) { return item && item.id === selectedId; });
    var selectedStatus = _draftVersionStatus(selectedDraft);
    if (selectedId && selectedWasRunning && selectedStatus && selectedStatus !== 'running') {
      await _loadScene(selectedId);
    } else {
      _render();
    }
    (_drafts || []).forEach(function (item) {
      var prev = before[item && item.id];
      var next = _draftVersionStatus(item);
      if (prev === 'running' && next === 'completed') _toast('场景草稿已生成完成', 'ok');
      if (prev === 'running' && next === 'failed') _toast(_versionErrorText(item && item.currentVersion) || '场景草稿生成失败', 'warn');
    });
  } catch (_) {
    _render();
  } finally {
    _draftPollInFlight = false;
    _syncDraftPolling();
  }
}

function _sceneViewUrl(scene, role) {
  scene = scene || {};
  role = String(role || 'establishing');
  var views = Array.isArray(scene.views) ? scene.views : [];
  var view = views.find(function (item) { return String(item && item.role || '') === role; }) || null;
  if (view) {
    var viewRef = view.reference || {};
    var viewUrl = view.imageUrl || view.rawUrl || viewRef.currentUrl || viewRef.lastKnownGoodUrl || '';
    if (viewUrl) return viewUrl;
  }
  if (role === 'establishing') {
    var ref = scene.reference || {};
    return scene.imageUrl || scene.rawUrl || ref.currentUrl || ref.lastKnownGoodUrl || '';
  }
  return '';
}

function _sceneViewStatus(scene, role) {
  var url = _sceneViewUrl(scene, role);
  if (!url) return 'missing';
  var views = Array.isArray(scene && scene.views) ? scene.views : [];
  var view = views.find(function (item) { return String(item && item.role || '') === role; }) || {};
  var status = String(view.reference && view.reference.status || scene.reference && scene.reference.status || 'ready');
  if (status === 'failed') return 'failed';
  if (status === 'degraded') return 'degraded';
  return 'ready';
}

function _isConfirmableVersion(version) {
  return _versionStatus(version) === 'completed' && !!_sceneViewUrl(_versionSceneData(version), 'establishing');
}

function _versionErrorText(version) {
  var fields = _versionSceneData(version);
  var referenceError = fields.reference && fields.reference.lastError && fields.reference.lastError.message;
  return String(version && version.errorMessage || fields.imageLastError || referenceError || '').trim();
}

function _fieldCounterHtml(key, value, max) {
  return '<small class="character-field-counter" data-scene-counter="' + escapeHtml(key) + '">' + String(value || '').length + '/' + max + '</small>';
}

function _refHtml() {
  if (_refUploading) {
    return '<button type="button" class="toolbox-ref-upload" data-scene-ref-upload disabled><span class="material-symbols-outlined toolbox-spin">progress_activity</span>参考图上传中</button><input type="file" id="sceneRefInput" accept="image/*" hidden />';
  }
  if (!_ref) {
    return '<button type="button" class="toolbox-ref-upload" data-scene-ref-upload><span class="material-symbols-outlined">upload</span>上传参考图</button><input type="file" id="sceneRefInput" accept="image/*" hidden />';
  }
  var img = _ref.localPreviewUrl || _ref.urlAtCreation || '';
  return '<div class="toolbox-ref-chip">' +
    '<button type="button" class="toolbox-ref-chip-main" data-scene-ref-upload>' +
      (img ? '<img src="' + escapeHtml(img) + '" alt="参考图" />' : '<span class="material-symbols-outlined">image</span>') +
      '<span class="toolbox-ref-chip-name">' + escapeHtml(_ref.name || '参考图') + '</span>' +
    '</button>' +
    '<button type="button" class="toolbox-ref-chip-remove" data-scene-ref-clear title="移除参考图"><span class="material-symbols-outlined">close</span></button>' +
    '<input type="file" id="sceneRefInput" accept="image/*" hidden />' +
  '</div>';
}

function _restoreRefFromVersion(version) {
  var refs = version && Array.isArray(version.inputRefs) ? version.inputRefs : [];
  var ref = refs.find(function (item) { return item && item.role === 'reference' && item.refType === 'upload' && item.refId; });
  if (!ref) {
    _ref = null;
    return;
  }
  _ref = {
    role: 'reference',
    refType: 'upload',
    refId: ref.refId,
    mime: ref.mime || '',
    name: ref.name || '历史参考图',
    urlAtCreation: ref.urlAtCreation || ('/api/edit/media/' + encodeURIComponent(ref.refId)),
  };
}

function _sceneSummary(scene) {
  scene = scene || {};
  return [scene.location, scene.description, scene.timeSetting, scene.weather, scene.lighting, scene.atmosphere]
    .map(function (v) { return String(v || '').trim(); })
    .filter(Boolean)
    .join(' | ');
}

function _sceneTagsHtml(scene) {
  var tags = [];
  if (scene.timeSetting) tags.push(scene.timeSetting);
  if (scene.weather) tags.push(scene.weather);
  if (scene.atmosphere) tags = tags.concat(String(scene.atmosphere).split(/[,，、]/));
  if (Array.isArray(scene.elements)) tags = tags.concat(scene.elements);
  tags = tags.map(function (t) { return String(t || '').trim(); }).filter(Boolean).slice(0, 6);
  if (!tags.length) return '';
  return '<div class="scene-tag-row">' + tags.map(function (tag) {
    return '<span>' + escapeHtml(tag) + '</span>';
  }).join('') + '</div>';
}

function _viewSlotHtml(scene, role, opts) {
  opts = opts || {};
  var url = _sceneViewUrl(scene, role);
  var status = _sceneViewStatus(scene, role);
  var label = SCENE_VIEW_LABELS[role] || role;
  var busy = _busy && (_busyRole === role || _busyRole === 'fill');
  var statusText = status === 'missing' ? '未生成' : status === 'failed' ? '失败' : status === 'degraded' ? '可用·降级' : '可用';
  return '<div class="scene-view-slot scene-view-slot--' + escapeHtml(status) + '">' +
    '<div class="scene-view-slot__media ' + (url ? '' : 'is-empty') + '" ' + (url ? 'data-scene-zoom="' + escapeHtml(url) + '"' : '') + '>' +
      (url ? '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(label) + '" loading="lazy" decoding="async" />' : '<span class="material-symbols-outlined">landscape</span>') +
      (busy ? '<div class="scene-view-slot__busy"><span class="material-symbols-outlined toolbox-spin">progress_activity</span></div>' : '') +
    '</div>' +
    '<div class="scene-view-slot__bar">' +
      '<div><strong>' + escapeHtml(label) + '</strong><small>' + escapeHtml(statusText) + '</small></div>' +
      (opts.actions && role !== 'establishing' ? '<button type="button" data-scene-view-regenerate="' + escapeHtml(role) + '" ' + (_busy ? 'disabled' : '') + ' title="重新生成' + escapeHtml(label) + '"><span class="material-symbols-outlined">' + (busy ? 'progress_activity' : 'autorenew') + '</span></button>' : '') +
    '</div>' +
  '</div>';
}

function _sceneViewGridHtml(scene, opts) {
  return '<div class="scene-view-grid">' + SCENE_VIEW_ROLES.map(function (role) {
    return _viewSlotHtml(scene, role, opts);
  }).join('') + '</div>';
}

function _listHtml() {
  var cards = _items.length
    ? _items.map(function (item) { return _sceneCardHtml(item); }).join('')
    : '<div class="toolbox-preview-empty character-list-empty"><span class="material-symbols-outlined">add_photo_alternate</span><p>暂无自定义场景</p></div>';
  return '' +
    '<header class="toolbox-hero character-custom-head">' +
      '<div class="toolbox-head-left">' +
        '<button type="button" class="toolbox-back" data-toolbox-back data-goto="toolbox" title="返回工具箱"><span class="material-symbols-outlined">arrow_back</span></button>' +
        '<div><p class="toolbox-kicker">SCENE CUSTOM</p><h1>场景定制</h1></div>' +
      '</div>' +
      '<button type="button" class="character-new-btn" data-scene-new><span class="material-symbols-outlined">add</span>新建场景</button>' +
    '</header>' +
    '<div class="character-card-grid scene-card-grid">' + cards + '</div>';
}

function _sceneCardHtml(item) {
  var scene = item && item.current || {};
  var id = item && item.id || '';
  var title = scene.name || item.title || '未命名场景';
  var desc = _sceneSummary(scene);
  var cardBusy = _busy && _busyRole === 'card:' + id;
  var establishing = _sceneViewUrl(scene, 'establishing');
  return '<div class="asset-card scene-custom-card bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500" data-scene-card="' + escapeHtml(id) + '">' +
    '<div class="scene-custom-card__hero ' + (establishing ? '' : 'is-empty') + '" ' + (establishing ? 'data-scene-zoom="' + escapeHtml(establishing) + '"' : '') + '>' +
      (establishing ? '<img src="' + escapeHtml(establishing) + '" alt="' + escapeHtml(title) + '" loading="lazy" decoding="async" />' : '<span class="material-symbols-outlined">landscape</span>') +
    '</div>' +
    '<div class="scene-custom-card__body">' +
      '<div class="scene-custom-card__title-row"><div><h4>' + escapeHtml(title) + '</h4>' + (scene.location ? '<small>' + escapeHtml(scene.location) + '</small>' : '') + '</div>' +
        '<button type="button" data-scene-delete-card="' + escapeHtml(id) + '" title="删除场景"><span class="material-symbols-outlined">delete_outline</span></button>' +
      '</div>' +
      (desc ? '<p class="scene-custom-card__desc">' + escapeHtml(desc.slice(0, 260)) + '</p>' : '<p class="scene-custom-card__desc is-muted">暂无场景描述</p>') +
      _sceneTagsHtml(scene) +
      _sceneViewGridHtml(scene, { actions: false }) +
      '<div class="scene-custom-card__actions">' +
        '<button type="button" data-scene-card-regenerate="' + escapeHtml(id) + '" ' + (_busy ? 'disabled' : '') + '>' + (cardBusy ? '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>重新生成中' : '重新生成主视图') + '</button>' +
        '<button type="button" data-scene-edit-card="' + escapeHtml(id) + '" ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined">edit</span></button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function _draftEditorHtml() {
  var canConfirm = _isConfirmableVersion(_selectedVersion);
  return '' +
    '<header class="toolbox-tool-head character-generation-head">' +
      '<button type="button" class="toolbox-back" data-scene-back title="返回场景定制"><span class="material-symbols-outlined">arrow_back</span></button>' +
      '<div><p class="toolbox-kicker">SCENE CUSTOM</p><h1>场景生成</h1></div>' +
      '<button type="button" class="character-new-btn" data-scene-confirm ' + (canConfirm && !_busy ? '' : 'disabled') + '><span class="material-symbols-outlined">check</span>确认添加</button>' +
    '</header>' +
    '<div class="toolbox-workbench character-generation-grid" data-scene-editor data-scene-generation-editor>' +
      '<section class="toolbox-panel toolbox-config character-generation-form-card">' +
        '<div class="toolbox-form character-generate-form character-generation-form">' +
          '<div class="toolbox-field character-field character-ref-field"><span>参考图</span>' + _refHtml() + '</div>' +
          '<label class="toolbox-field character-field character-field-with-counter"><span>场景名称</span><input id="sceneTitleInput" type="text" maxlength="' + SCENE_TITLE_MAX + '" data-scene-counter-source="title" data-scene-counter-max="' + SCENE_TITLE_MAX + '" placeholder="为场景命名（可选）" value="' + escapeHtml(_form.title || '') + '" />' + _fieldCounterHtml('title', _form.title, SCENE_TITLE_MAX) + '</label>' +
          '<label class="toolbox-field character-field character-field-with-counter"><span>提示词</span><textarea id="scenePromptInput" rows="7" maxlength="' + SCENE_PROMPT_MAX + '" data-scene-counter-source="prompt" data-scene-counter-max="' + SCENE_PROMPT_MAX + '" placeholder="描述地点、空间结构、时段、天气、灯光、氛围和关键元素">' + escapeHtml(_form.prompt || '') + '</textarea>' + _fieldCounterHtml('prompt', _form.prompt, SCENE_PROMPT_MAX) + '</label>' +
          _sceneParamFieldsHtml() +
        '</div>' +
        '<div class="character-generation-actions">' +
          '<button type="button" class="toolbox-generate character-generation-submit" data-scene-generate ' + (_busy || _refUploading ? 'disabled' : '') + '>' +
            '<span class="material-symbols-outlined ' + (_busy || _refUploading ? 'toolbox-spin' : '') + '">' + (_busy || _refUploading ? 'progress_activity' : 'auto_awesome') + '</span>' +
            (_busy ? '生成中' : _refUploading ? '等待上传' : '生成场景') +
          '</button>' +
        '</div>' +
      '</section>' +
      '<section class="toolbox-panel toolbox-preview character-generation-preview">' +
        '<div id="scenePreviewArea" class="toolbox-preview-area">' + _previewHtml() + '</div>' +
      '</section>' +
      '<aside class="toolbox-panel toolbox-history character-generation-drafts">' +
        '<div class="toolbox-history-head"><div><strong>草稿箱</strong><small>未确认场景</small></div></div>' +
        '<div class="toolbox-history-list">' + _draftBoxHtml() + '</div>' +
      '</aside>' +
    '</div>';
}

function _sceneParamFieldsHtml() {
  var p = _form.params || {};
  return '' +
    '<div class="scene-param-grid">' +
      '<label class="toolbox-field character-field"><span>时段</span><input id="sceneTimeInput" value="' + escapeHtml(p.timeSetting || '') + '" placeholder="如：黄昏 / 深夜" /></label>' +
      '<label class="toolbox-field character-field"><span>天气</span><input id="sceneWeatherInput" value="' + escapeHtml(p.weather || '') + '" placeholder="如：小雨 / 晴朗" /></label>' +
      '<label class="toolbox-field character-field"><span>灯光</span><input id="sceneLightingInput" value="' + escapeHtml(p.lighting || '') + '" placeholder="如：冷色霓虹侧光" /></label>' +
      '<label class="toolbox-field character-field"><span>氛围</span><input id="sceneAtmosphereInput" value="' + escapeHtml(p.atmosphere || '') + '" placeholder="如：压迫，潮湿，神秘" /></label>' +
    '</div>';
}

function _fieldHtml(key, label, value, rows) {
  var field = rows
    ? '<textarea data-scene-field="' + escapeHtml(key) + '" rows="' + rows + '">' + escapeHtml(value || '') + '</textarea>'
    : '<input data-scene-field="' + escapeHtml(key) + '" value="' + escapeHtml(value || '') + '" />';
  return '<label class="toolbox-field"><span>' + escapeHtml(label) + '</span>' + field + '</label>';
}

function _confirmedEditorHtml() {
  var scene = _currentSceneData();
  return '' +
    '<header class="toolbox-tool-head">' +
      '<button type="button" class="toolbox-back" data-scene-back title="返回场景定制"><span class="material-symbols-outlined">arrow_back</span></button>' +
      '<div><p class="toolbox-kicker">SCENE CUSTOM</p><h1>场景编辑</h1></div>' +
    '</header>' +
    '<div class="toolbox-workbench scene-editor-grid" data-scene-editor data-scene-confirmed-editor>' +
      '<section class="toolbox-panel toolbox-config">' +
        '<div class="toolbox-form">' +
          _fieldHtml('name', '场景名', scene.name || '', 0) +
          _fieldHtml('location', '地点', scene.location || '', 0) +
          _fieldHtml('description', '描述', scene.description || '', 4) +
          _fieldHtml('timeSetting', '时段', scene.timeSetting || '', 0) +
          _fieldHtml('weather', '天气', scene.weather || '', 0) +
          _fieldHtml('lighting', '灯光', scene.lighting || '', 2) +
          _fieldHtml('atmosphere', '氛围', scene.atmosphere || '', 2) +
          '<label class="toolbox-field"><span>关键元素</span><input data-scene-elements-field value="' + escapeHtml(Array.isArray(scene.elements) ? scene.elements.join('，') : '') + '" placeholder="用逗号分隔" /></label>' +
          '<button type="button" class="toolbox-generate" data-scene-save-fields ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined">save</span>保存字段</button>' +
          '<button type="button" class="toolbox-generate character-secondary-action" data-scene-editor-regenerate ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined ' + (_busy && _busyRole === 'main' ? 'toolbox-spin' : '') + '">' + (_busy && _busyRole === 'main' ? 'progress_activity' : 'autorenew') + '</span>' + (_busy && _busyRole === 'main' ? '重新生成中' : '重新生成主视图') + '</button>' +
          '<button type="button" class="toolbox-generate character-secondary-action" data-scene-fill-views ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined ' + (_busy && _busyRole === 'fill' ? 'toolbox-spin' : '') + '">' + (_busy && _busyRole === 'fill' ? 'progress_activity' : 'view_in_ar') + '</span>' + (_busy && _busyRole === 'fill' ? '补齐中' : '补齐副视图') + '</button>' +
        '</div>' +
      '</section>' +
      '<section class="toolbox-panel toolbox-preview">' +
        '<div id="scenePreviewArea" class="toolbox-preview-area">' + _previewHtml() + '</div>' +
      '</section>' +
      '<aside class="toolbox-panel toolbox-history">' +
        '<div class="toolbox-history-head"><div><strong>历史记录</strong><small>正式版本</small></div></div>' +
        '<div class="toolbox-history-list">' + _historyHtml() + '</div>' +
      '</aside>' +
    '</div>';
}

function _previewHtml() {
  var scene = _versionSceneData(_selectedVersion);
  var status = _versionStatus(_selectedVersion);
  var errorText = _versionErrorText(_selectedVersion);
  if (_busy || status === 'running') {
    return '<div class="toolbox-preview-empty character-preview-generating" aria-live="polite"><span class="material-symbols-outlined toolbox-spin">progress_activity</span><p>场景图生成中</p><small>完成后会自动显示在这里</small></div>';
  }
  if (!_sceneViewUrl(scene, 'establishing')) {
    return '<div class="toolbox-preview-empty"><span class="material-symbols-outlined">landscape</span><p>' + (errorText ? '生成失败' : '场景图将在这里显示') + '</p>' + (errorText ? '<small>' + escapeHtml(errorText.slice(0, 160)) + '</small>' : '') + '</div>';
  }
  return '<div class="scene-preview-stack">' + _sceneViewGridHtml(scene, { actions: _selectedScene && _selectedScene.lifecycleStatus === 'confirmed' }) + '</div>';
}

function _historyHtml() {
  if (!_versions.length) return '<div class="toolbox-empty-history"><span class="material-symbols-outlined">history</span><p>暂无历史版本</p></div>';
  return _versions.map(function (version) {
    var scene = _versionSceneData(version);
    var url = _sceneViewUrl(scene, 'establishing');
    var errorText = _versionErrorText(version);
    return '<button type="button" class="toolbox-history-card ' + (version.id === (_selectedVersion && _selectedVersion.id) ? 'is-selected' : '') + '" data-scene-version="' + escapeHtml(version.id) + '">' +
      '<span class="toolbox-history-thumb">' + (url ? '<img src="' + escapeHtml(url) + '" alt="" />' : '<span class="material-symbols-outlined">landscape</span>') + '</span>' +
      '<span class="toolbox-history-copy"><strong>版本 ' + escapeHtml(String(version.versionNo || '')) + '</strong><small>' + escapeHtml(_versionStatus(version) || '') + '</small>' +
        (errorText ? '<small>' + escapeHtml(errorText.slice(0, 72)) + '</small>' : '') +
      '</span>' +
    '</button>';
  }).join('');
}

function _formatDraftTime(iso) {
  var t = Date.parse(iso || '');
  if (!t) return '';
  var diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  var d = new Date(t);
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function _draftBoxHtml() {
  if (!_drafts.length) return '<div class="toolbox-empty-history"><span class="material-symbols-outlined">inbox</span><p>草稿箱是空的</p><small>点「生成场景」后，未确认的场景会暂存在这里</small></div>';
  return _drafts.map(function (item) {
    var scene = item && item.current || {};
    var version = item && item.currentVersion || null;
    var status = _versionStatus(version);
    var url = _sceneViewUrl(scene, 'establishing');
    var title = scene.name || item.title || '未命名草稿';
    var statusLabel = status === 'running' ? '生成中' : status === 'failed' ? '生成失败' : '待确认';
    var time = _formatDraftTime((version && version.createdAt) || (item && item.createdAt) || (item && item.updatedAt));
    var thumb = status === 'running' ? '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>' : (url ? '<img src="' + escapeHtml(url) + '" alt="" />' : '<span class="material-symbols-outlined">landscape</span>');
    return '<div class="toolbox-history-card ' + (item && item.id === _selectedSceneId ? 'is-selected ' : '') + '">' +
      '<button type="button" class="toolbox-history-main" data-scene-draft-open="' + escapeHtml(item.id) + '">' +
        '<span class="toolbox-history-thumb">' + thumb + '</span>' +
        '<span class="toolbox-history-copy"><strong>' + escapeHtml(title) + '</strong><small>' + escapeHtml(time ? statusLabel + ' · ' + time : statusLabel) + '</small><em>' + escapeHtml(String(scene.description || version && version.prompt || '').slice(0, 40)) + '</em></span>' +
      '</button>' +
      '<button type="button" class="toolbox-history-delete" data-scene-draft-delete="' + escapeHtml(item.id) + '" title="删除草稿"><span class="material-symbols-outlined">close</span></button>' +
    '</div>';
  }).join('');
}

function _render() {
  var root = $('sceneCustomRoot');
  if (!root) return;
  root.innerHTML = _view === 'draftEditor' ? _draftEditorHtml() : _view === 'confirmedEditor' ? _confirmedEditorHtml() : _listHtml();
  hydrateProtectedImageElements(root);
  if (_view === 'draftEditor') _syncDraftPolling();
  else _clearDraftPoll();
}

function _hasRenderedView() {
  var root = $('sceneCustomRoot');
  if (!root || !root.firstElementChild) return false;
  if (_view === 'draftEditor' || _view === 'confirmedEditor') return !!root.querySelector('[data-scene-editor]');
  return !!root.querySelector('.scene-card-grid');
}

async function _loadList(options) {
  options = options || {};
  var key = _listCacheKey();
  if (!options.force && _listCacheFresh(key)) {
    _items = (_listCache.items || []).slice();
    return;
  }
  var data = await _jsonFetch('/api/scene-custom/history?limit=80', { method: 'GET' });
  _items = data.items || [];
  _storeListCache();
}

async function _loadDrafts() {
  try {
    var data = await _jsonFetch('/api/scene-custom/history?lifecycle=draft&limit=80', { method: 'GET' });
    _drafts = data.items || [];
  } catch (_) {
    _drafts = _drafts || [];
  }
}

async function _loadScene(id) {
  var data = await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(id), { method: 'GET' });
  _selectedScene = data.scene || null;
  _selectedSceneId = id;
  _versions = data.versions || [];
  _selectedVersion = _versions.find(function (item) { return item.id === (_selectedScene && _selectedScene.currentVersionId); }) || _versions[0] || null;
  if (_selectedVersion) {
    var scene = _versionSceneData(_selectedVersion);
    _form.title = scene.name || '';
    _form.prompt = _selectedVersion.prompt || '';
    _form.params = Object.assign({}, _form.params, _selectedVersion.params || {});
    if (_selectedScene && _selectedScene.lifecycleStatus === 'draft') _restoreRefFromVersion(_selectedVersion);
    else _ref = null;
  } else {
    _ref = null;
  }
  _view = _selectedScene && _selectedScene.lifecycleStatus === 'draft' ? 'draftEditor' : 'confirmedEditor';
  _render();
  _scrollEditorTop();
}

export async function refreshSceneCustomPage(options) {
  options = options || {};
  try {
    if (!options.force && _hasRenderedView()) {
      if (_view === 'draftEditor' || _view === 'confirmedEditor') return;
      if (_view === 'list' && _listCacheFresh(_listCacheKey())) return;
    }
    if ((_view === 'draftEditor' || _view === 'confirmedEditor') && _selectedSceneId) {
      if (!options.force && _selectedScene) {
        _render();
        return;
      }
      await _loadScene(_selectedSceneId);
      return;
    }
    await _loadList({ force: !!options.force });
    _render();
  } catch (e) {
    _toast(e && e.message || '场景列表加载失败，请刷新页面或稍后重试', 'error');
    _render();
  }
}

function _startNew() {
  _view = 'draftEditor';
  _selectedScene = null;
  _selectedSceneId = null;
  _selectedVersion = null;
  _versions = [];
  _ref = null;
  _refUploading = false;
  _form = { title: '', prompt: '', params: { timeSetting: '', weather: '', lighting: '', atmosphere: '' } };
  _render();
  _scrollEditorTop();
  _loadDrafts().then(function () { if (_view === 'draftEditor') _render(); }).catch(function () {});
}

function _syncFormFromDom() {
  var prompt = $('scenePromptInput');
  if (prompt) _form.prompt = prompt.value;
  var title = $('sceneTitleInput');
  if (title) _form.title = title.value;
  var time = $('sceneTimeInput');
  if (time) _form.params.timeSetting = time.value;
  var weather = $('sceneWeatherInput');
  if (weather) _form.params.weather = weather.value;
  var lighting = $('sceneLightingInput');
  if (lighting) _form.params.lighting = lighting.value;
  var atmosphere = $('sceneAtmosphereInput');
  if (atmosphere) _form.params.atmosphere = atmosphere.value;
}

function _updateCounter(input) {
  if (!input) return;
  var key = input.getAttribute('data-scene-counter-source') || '';
  var max = Number(input.getAttribute('data-scene-counter-max') || 0);
  var counter = key && document.querySelector('[data-scene-counter="' + key + '"]');
  if (counter && max) counter.textContent = String(input.value || '').length + '/' + max;
}

function _newUploadRequestId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch (_) {}
  return 'sceneref-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function _validateSceneReferenceFile(file) {
  if (!file) return '没有选择参考图';
  var mime = file.type || '';
  if (!mime || mime.indexOf('image/') !== 0) return '参考图只能上传图片文件（JPG、PNG 等）';
  var size = Number(file.size || 0);
  if (size && size > SCENE_REFERENCE_MAX_BYTES) return '参考图不能超过 ' + Math.round(SCENE_REFERENCE_MAX_BYTES / 1024 / 1024) + ' MB';
  return '';
}

function _uploadErrorMessage(e) {
  if (e instanceof ApiError) {
    if (e.status === 413) return e.message || '参考图不能超过 ' + Math.round(SCENE_REFERENCE_MAX_BYTES / 1024 / 1024) + ' MB';
    if (e.status === 415) return e.message || '参考图只能上传图片文件（JPG、PNG 等）';
  }
  return e && e.message || '参考图上传失败，请重试';
}

async function _uploadReference(file, requestId) {
  var fd = new FormData();
  fd.append('file', file);
  fd.append('purpose', SCENE_REFERENCE_UPLOAD_SURFACE);
  var projectId = _projectId();
  if (projectId) fd.append('projectId', projectId);
  var data = await apiUpload('/api/edit/upload-media', fd, {
    headers: {
      'X-Origin-Request-Id': requestId,
      'X-Origin-Upload-Surface': SCENE_REFERENCE_UPLOAD_SURFACE,
    },
  });
  if (data.kind !== 'image') throw new Error('参考图只能是图片文件（JPG、PNG 等）');
  var localPreviewUrl = '';
  try { localPreviewUrl = URL.createObjectURL(file); } catch (_) {}
  _ref = {
    role: 'reference',
    refType: 'upload',
    refId: data.mediaId,
    mime: file.type || data.mime || '',
    name: file.name || data.filename || '参考图',
    urlAtCreation: data.url || '',
    localPreviewUrl: localPreviewUrl,
  };
}

function _readFieldsFromDom() {
  var fields = Object.assign({}, _currentSceneData());
  try {
    document.querySelectorAll('[data-scene-field]').forEach(function (el) {
      var key = el.getAttribute('data-scene-field') || '';
      if (key) fields[key] = el.value || '';
    });
    var elementsInput = document.querySelector('[data-scene-elements-field]');
    if (elementsInput) {
      fields.elements = String(elementsInput.value || '')
        .split(/[,，、/\n]/)
        .map(function (item) { return item.trim(); })
        .filter(Boolean)
        .slice(0, 10);
    }
  } catch (_) {}
  return fields;
}

async function _saveFields(fields) {
  if (!_selectedSceneId) throw new Error('没有找到要保存的场景');
  var data = await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(_selectedSceneId), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields || _readFieldsFromDom() }),
  });
  if (data.version) {
    _selectedVersion = data.version;
    _versions = (_versions || []).map(function (item) { return item.id === data.version.id ? data.version : item; });
    _invalidateListCache();
  }
  return data;
}

async function _confirmDraft() {
  if (_busy || !_selectedSceneId || !_selectedVersion) return;
  if (!_isConfirmableVersion(_selectedVersion)) throw new Error('请先选择一个生成成功的场景版本');
  _syncFormFromDom();
  _setBusy(true, 'confirm');
  _render();
  try {
    await _jsonFetch('/api/scene-custom/drafts/' + encodeURIComponent(_selectedSceneId) + '/confirm', {
      method: 'POST',
      body: JSON.stringify({ versionId: _selectedVersion.id, title: String(_form.title || '').trim() }),
    });
    _toast('场景已添加', 'ok');
    _selectedScene = null;
    _selectedSceneId = null;
    _selectedVersion = null;
    _versions = [];
    _ref = null;
    _view = 'list';
    await _loadList({ force: true });
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _backToList() {
  _selectedScene = null;
  _selectedSceneId = null;
  _selectedVersion = null;
  _versions = [];
  _ref = null;
  _view = 'list';
  await _loadList();
  _render();
}

async function _deleteDraft(id) {
  id = String(id || '').trim();
  if (!id) return;
  await _jsonFetch('/api/scene-custom/drafts/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function () {});
  if (id === _selectedSceneId) {
    _selectedScene = null;
    _selectedSceneId = null;
    _selectedVersion = null;
    _versions = [];
    _ref = null;
  }
  await _loadDrafts();
  _render();
}

async function _generate() {
  if (_busy) return;
  if (_refUploading) throw new Error('参考图仍在上传，请上传完成后再生成');
  _syncFormFromDom();
  if (!String(_form.prompt || '').trim() && !_ref) throw new Error('请先填写场景描述，或上传一张参考图');
  _setBusy(true, 'generate');
  _render();
  var revealPreview = false;
  try {
    var data = await _jsonFetch('/api/scene-custom/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: _projectId() || null,
        title: String(_form.title || '').trim(),
        prompt: _form.prompt || '',
        params: _form.params,
        mediaId: _ref && _ref.refId || '',
      }),
      timeoutMs: 600000,
    });
    _selectedSceneId = data.sceneId;
    await _loadDrafts();
    await _loadScene(_selectedSceneId);
    revealPreview = true;
    if (data.ok === false) {
      _toast((data.error || '这次场景没有生成成功') + '，本次尝试已存入草稿', 'warn');
      return;
    }
    _toast('场景生成完成', 'ok');
  } finally {
    _setBusy(false);
    _render();
    if (revealPreview) _scrollPreviewIntoView();
  }
}

async function _regenerateMain(fromCardId) {
  var id = fromCardId || _selectedSceneId;
  if (_busy || !id) return;
  var fields = fromCardId ? {} : _readFieldsFromDom();
  _setBusy(true, fromCardId ? ('card:' + fromCardId) : 'main');
  _render();
  try {
    if (!fromCardId && _selectedSceneId) await _saveFields(fields);
    var data = await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(id) + '/regenerate', {
      method: 'POST',
      body: JSON.stringify({ fields: fields }),
      timeoutMs: 600000,
    });
    if (fromCardId) {
      await _loadList({ force: true });
    } else {
      await _loadScene(id);
    }
    if (data.ok === false) {
      _toast((data.error || '这次场景没有生成成功') + '，当前场景仍保留上一版', 'warn');
      return;
    }
    _toast('场景主视图已重新生成', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _regenerateView(role) {
  if (_busy || !_selectedSceneId) return;
  role = String(role || '').trim();
  _setBusy(true, role);
  _render();
  try {
    var data = await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(_selectedSceneId) + '/views/' + encodeURIComponent(role) + '/regenerate', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 600000,
    });
    if (data.version) {
      _selectedVersion = data.version;
      _versions = (_versions || []).map(function (item) { return item.id === data.version.id ? data.version : item; });
      _invalidateListCache();
    }
    if (data.ok === false) {
      _toast(data.error || '副视图生成失败，请稍后重试', 'warn');
      return false;
    }
    _toast((SCENE_VIEW_LABELS[role] || role) + '已生成', data.qualityAudit && data.qualityAudit.status === 'skipped' ? 'warn' : 'ok');
    return true;
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _fillViews() {
  if (_busy || !_selectedSceneId) return;
  _setBusy(true, 'fill');
  _render();
  try {
    for (var i = 0; i < 3; i++) {
      var role = ['topdown', 'reverse', 'alt'][i];
      var data = await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(_selectedSceneId) + '/views/' + encodeURIComponent(role) + '/regenerate', {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 600000,
      });
      if (data.version) _selectedVersion = data.version;
      if (data.ok === false) throw new Error(data.error || (SCENE_VIEW_LABELS[role] + '生成失败'));
    }
    await _loadScene(_selectedSceneId);
    _toast('场景副视图已补齐', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _deleteCard(id) {
  var item = (_items || []).find(function (candidate) { return candidate && candidate.id === id; });
  if (!item) throw new Error('没有找到要删除的场景');
  var name = item.current && item.current.name || item.title || '未命名场景';
  var ok = await showConfirm('删除实例', '确定删除场景「' + name + '」？删除后不会再显示在场景定制页面。', '删除', '取消');
  if (!ok) return;
  _setBusy(true, 'delete');
  _render();
  try {
    await _jsonFetch('/api/scene-custom/items/' + encodeURIComponent(id), { method: 'DELETE' });
    _items = (_items || []).filter(function (candidate) { return !candidate || candidate.id !== id; });
    _storeListCache();
    _toast('场景实例已删除', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

export function _initSceneCustomEvents() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      _clearDraftPoll();
      return;
    }
    if (_view === 'draftEditor' && _hasRunningDrafts()) _pollRunningDrafts();
  });
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.matches && ev.target.matches('[data-scene-counter-source]')) _updateCounter(ev.target);
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'sceneRefInput') {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var validation = _validateSceneReferenceFile(file);
      if (validation) {
        _toast(validation, 'warn');
        ev.target.value = '';
        return;
      }
      _refUploading = true;
      _render();
      _uploadReference(file, _newUploadRequestId()).then(function () {
        _toast('参考图已上传', 'ok');
      }).catch(function (e) {
        _toast(_uploadErrorMessage(e), 'error');
      }).finally(function () {
        _refUploading = false;
        _render();
      });
    }
  });
  document.addEventListener('click', function (ev) {
    var zoom = ev.target.closest('[data-scene-zoom]');
    if (zoom) {
      _openZoom(zoom.getAttribute('data-scene-zoom') || '', '场景图');
      return;
    }
    if (ev.target.closest('[data-scene-new]')) { _startNew(); return; }
    if (ev.target.closest('[data-scene-back]')) {
      _backToList().catch(function (e) { _toast(e && e.message || '返回失败，请稍后重试', 'error'); });
      return;
    }
    if (ev.target.closest('[data-scene-ref-upload]')) {
      var input = $('sceneRefInput');
      if (input && !_refUploading) input.click();
      return;
    }
    if (ev.target.closest('[data-scene-ref-clear]')) {
      _ref = null;
      _render();
      return;
    }
    if (ev.target.closest('[data-scene-generate]')) {
      _generate().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '场景生成失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-scene-confirm]')) {
      _confirmDraft().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '确认添加失败，请重新生成后再试', 'error');
      });
      return;
    }
    var draftOpen = ev.target.closest('[data-scene-draft-open]');
    if (draftOpen) {
      var draftOpenId = draftOpen.getAttribute('data-scene-draft-open') || '';
      if (draftOpenId) _loadScene(draftOpenId);
      return;
    }
    var draftDel = ev.target.closest('[data-scene-draft-delete]');
    if (draftDel) {
      _deleteDraft(draftDel.getAttribute('data-scene-draft-delete') || '').catch(function (e) {
        _toast(e && e.message || '删除草稿失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-scene-save-fields]')) {
      _saveFields().then(function () {
        _toast('场景字段已保存', 'ok');
        _render();
      }).catch(function (e) { _toast(e && e.message || '字段保存失败，请稍后重试', 'error'); });
      return;
    }
    if (ev.target.closest('[data-scene-editor-regenerate]')) {
      _regenerateMain().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '场景重新生成失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-scene-fill-views]')) {
      _fillViews().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '副视图补齐失败，请稍后重试', 'error');
      });
      return;
    }
    var viewBtn = ev.target.closest('[data-scene-view-regenerate]');
    if (viewBtn) {
      _regenerateView(viewBtn.getAttribute('data-scene-view-regenerate') || '').catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '副视图生成失败，请稍后重试', 'error');
      });
      return;
    }
    var editCard = ev.target.closest('[data-scene-edit-card]');
    if (editCard) {
      var editId = editCard.getAttribute('data-scene-edit-card') || '';
      if (editId) _loadScene(editId);
      return;
    }
    var regenCard = ev.target.closest('[data-scene-card-regenerate]');
    if (regenCard) {
      _regenerateMain(regenCard.getAttribute('data-scene-card-regenerate') || '').catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '场景重新生成失败，请稍后重试', 'error');
      });
      return;
    }
    var delCard = ev.target.closest('[data-scene-delete-card]');
    if (delCard) {
      _deleteCard(delCard.getAttribute('data-scene-delete-card') || '').catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '删除失败，请稍后重试', 'error');
      });
    }
  });
}
