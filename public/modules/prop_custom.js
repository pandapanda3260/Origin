import { $, ApiError, apiRequest, apiUpload, escapeHtml, hydrateProtectedImageElements, showConfirm } from '/modules/utils.js';

var _ctx = {};
var _wired = false;
var _view = 'list';
var _items = [];
var _drafts = [];
var _versions = [];
var _selectedProp = null;
var _selectedPropId = null;
var _selectedVersion = null;
var _busy = false;
var _busyRole = '';
var _uploadingCardId = null;
var _propMenuDismissHandler = null;
var _propMenuScrollHandler = null;
var _refUploading = false;
var _ref = null;
var _listCache = { key: '', items: null, loadedAt: 0 };
var _draftPollTimer = 0;
var _draftPollInFlight = false;
var _LIST_CACHE_TTL_MS = 2 * 60 * 1000;
var _DRAFT_POLL_INTERVAL_MS = 5000;
var PROP_VIEW_SLOTS = ['hero', 'front', 'back', 'side_left', 'side_right', 'top'];
var PROP_VIEW_LABELS = {
  hero: '3/4 主图',
  front: '正面',
  back: '背面',
  side_left: '左侧',
  side_right: '右侧',
  side: '侧面',
  top: '俯视',
};
var PROP_REFERENCE_UPLOAD_SURFACE = 'prop_reference';
var PROP_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
var _form = {
  name: '',
  prompt: '',
  params: {
    dimensionality: 'volumetric',
    propType: '',
    material: '',
  },
};

export function initPropCustom(ctx) {
  _ctx = ctx || {};
}

function _toast(msg, type) {
  if (_ctx.showToast) _ctx.showToast(msg, type || 'info');
}

function _projectId() {
  var p = _ctx.getProject ? _ctx.getProject() : null;
  return p && p.id ? p.id : '';
}

function _newUploadRequestId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  } catch (_) {}
  return 'propref-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function _normalizeViewRole(role) {
  role = String(role || '').trim();
  return (PROP_VIEW_SLOTS.indexOf(role) >= 0 || role === 'side') ? role : '';
}

function _propViews(item) {
  var views = item && item.views && typeof item.views === 'object' ? item.views : {};
  return views || {};
}

function _propViewBySlot(item, slot) {
  slot = _normalizeViewRole(slot);
  if (!slot) return null;
  var views = _propViews(item);
  var slots = views.slots && typeof views.slots === 'object' ? views.slots : {};
  if (slots[slot]) return slots[slot];
  if (views[slot]) return views[slot];
  if ((slot === 'side_left' || slot === 'side_right') && views.side) return views.side;
  return null;
}

function _firstUrl() {
  for (var i = 0; i < arguments.length; i++) {
    var value = String(arguments[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function _propViewOriginalUrl(item, slot) {
  var view = _propViewBySlot(item, slot);
  var ref = view && view.reference && typeof view.reference === 'object' ? view.reference : {};
  return _firstUrl(ref.currentUrl, ref.lastKnownGoodUrl, view && view.imageUrl, view && view.rawUrl);
}

function _propHasViewSlots(item) {
  if (!item || !item.views || typeof item.views !== 'object') return false;
  if (item.views.slots && typeof item.views.slots === 'object' && Object.keys(item.views.slots).length) return true;
  return PROP_VIEW_SLOTS.some(function (slot) { return !!_propViewOriginalUrl(item, slot); });
}

function _itemPropData(item) {
  return (item && item.current) || (item && item.propData) || (item && item.fields) || item || {};
}

function _itemDisplayImageUrl(item) {
  return String(item && (item.displayImageUrl || (item.currentVersion && item.currentVersion.displayImageUrl)) || '').trim();
}

function _findPropListEntry(id) {
  id = String(id || '').trim();
  if (!id) return null;
  return (_items || []).find(function (entry) { return entry && entry.id === id; }) ||
    (_drafts || []).find(function (entry) { return entry && entry.id === id; }) ||
    null;
}

function _versionPropData(version) {
  return (version && (version.propData || version.fields)) || {};
}

function _versionStatus(version) {
  return String(version && (version.generationStatus || version.status) || '');
}

function _versionErrorText(version) {
  var prop = _versionPropData(version);
  return String(version && version.errorMessage || prop.imageLastError || prop.viewsError || '').trim();
}

function _listCacheKey() {
  return '__all__';
}

function _listCacheFresh(key) {
  return _listCache
    && _listCache.key === key
    && Array.isArray(_listCache.items)
    && Date.now() - Number(_listCache.loadedAt || 0) < _LIST_CACHE_TTL_MS;
}

function _storeListCache() {
  _listCache = { key: _listCacheKey(), items: (_items || []).slice(), loadedAt: Date.now() };
}

function _invalidateListCache() {
  _listCache = { key: '', items: null, loadedAt: 0 };
}

function _setBusy(value, role) {
  _busy = !!value;
  _busyRole = value ? String(role || '') : '';
}

function _jsonFetch(path, options) {
  options = options || {};
  return apiRequest(path, {
    method: options.method || (options.body == null ? 'GET' : 'POST'),
    body: options.body,
    timeoutMs: options.timeoutMs,
  });
}

function _defaultForm() {
  _form = {
    name: '',
    prompt: '',
    params: {
      dimensionality: 'volumetric',
      propType: '',
      material: '',
    },
  };
  _ref = null;
}

function _readDraftForm() {
  var name = $('propCustomName');
  var prompt = $('propCustomPrompt');
  var dimensionality = $('propCustomDimensionality');
  var propType = $('propCustomType');
  var material = $('propCustomMaterial');
  _form.name = name ? name.value.trim() : _form.name;
  _form.prompt = prompt ? prompt.value.trim() : _form.prompt;
  _form.params = {
    dimensionality: dimensionality ? dimensionality.value : _form.params.dimensionality,
    propType: propType ? propType.value.trim() : _form.params.propType,
    material: material ? material.value.trim() : _form.params.material,
  };
  return _form;
}

function _readFieldsFromDom() {
  var fields = {};
  [
    ['name', 'propEditorName'],
    ['propType', 'propEditorType'],
    ['function', 'propEditorFunction'],
    ['features', 'propEditorFeatures'],
    ['material', 'propEditorMaterial'],
    ['visualFeatures', 'propEditorVisual'],
    ['ownership', 'propEditorOwnership'],
    ['description', 'propEditorDescription'],
    ['dimensionality', 'propEditorDimensionality'],
  ].forEach(function (pair) {
    var el = $(pair[1]);
    if (el) fields[pair[0]] = el.value;
  });
  return fields;
}

function _validateReferenceFile(file) {
  if (!file) return '没有选择参考图';
  var mime = file.type || '';
  if (!mime || mime.indexOf('image/') !== 0) return '参考图只能上传图片文件（JPG、PNG 等）';
  var size = Number(file.size || 0);
  if (size && size > PROP_REFERENCE_MAX_BYTES) return '参考图不能超过 ' + Math.round(PROP_REFERENCE_MAX_BYTES / 1024 / 1024) + ' MB';
  return '';
}

function _uploadErrorMessage(e) {
  if (e instanceof ApiError) {
    if (e.status === 413) return e.message || '参考图不能超过 ' + Math.round(PROP_REFERENCE_MAX_BYTES / 1024 / 1024) + ' MB';
    if (e.status === 415) return e.message || '参考图只能上传图片文件（JPG、PNG 等）';
  }
  return e && e.message || '参考图上传失败，请重试';
}

async function _uploadReference(file, requestId) {
  var fd = new FormData();
  fd.append('file', file);
  fd.append('purpose', PROP_REFERENCE_UPLOAD_SURFACE);
  var projectId = _projectId();
  if (projectId) fd.append('projectId', projectId);
  var data = await apiUpload('/api/edit/upload-media', fd, {
    headers: {
      'X-Origin-Request-Id': requestId,
      'X-Origin-Upload-Surface': PROP_REFERENCE_UPLOAD_SURFACE,
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
  return _ref;
}

function _statusBadge(version) {
  var status = _versionStatus(version);
  if (status === 'running') return '<span class="toolbox-status running">生成中</span>';
  if (status === 'failed') return '<span class="toolbox-status failed">未成功</span>';
  return '<span class="toolbox-status done">已完成</span>';
}

function _propViewsErrorHtml(prop) {
  var splitMsg = prop && prop.viewsError ? String(prop.viewsError) : '';
  var imageMsg = prop && prop.imageLastError ? String(prop.imageLastError) : '';
  var html = '';
  if (splitMsg) {
    html += '<div class="prop-custom-error prop-custom-error--split" data-prop-views-error>' +
      '<span class="material-symbols-outlined">warning</span>' +
      '<span>新图已生成，但没有切出可用的多视图；系统没有替换当前道具图。</span>' +
      '<small>' + escapeHtml(splitMsg.slice(0, 140)) + '</small>' +
    '</div>';
  }
  if (imageMsg && imageMsg !== splitMsg) {
    html += '<div class="prop-custom-error prop-custom-error--image" data-prop-image-error>' +
      '<span class="material-symbols-outlined">error</span>' +
      '<span>道具图生成失败；系统没有替换当前道具图。</span>' +
      '<small>' + escapeHtml(imageMsg.slice(0, 140)) + '</small>' +
    '</div>';
  }
  return html;
}

function _propThumbHtml(item, id) {
  var prop = _itemPropData(item);
  var src = _itemDisplayImageUrl(item);
  var hasViews = _propHasViewSlots(prop);
  if (!src) {
    return '<div class="prop-custom-thumb prop-custom-thumb--empty"><span class="material-symbols-outlined">handyman</span></div>';
  }
  return '<button type="button" class="prop-custom-thumb" data-prop-' + (hasViews ? 'views' : 'image') + '="' + escapeHtml(id) + '">' +
    '<img src="' + escapeHtml(src) + '" loading="lazy" decoding="async" alt="" />' +
    (hasViews ? '<span class="prop-custom-view-badge">六视图</span>' : '') +
  '</button>';
}

function _propCardHtml(item) {
  var prop = _itemPropData(item);
  var id = String(item && item.id || '');
  var version = item && item.currentVersion;
  var cardBusy = _busy && (_busyRole === 'card:' + id || _uploadingCardId === id);
  var title = prop.name || item.title || '未命名道具';
  var typeLabel = prop.propType || '道具';
  var desc = prop.description || prop.features || '';
  var tags = [];
  if (prop.material) tags.push(prop.material);
  if (prop.ownership) tags.push('归属：' + prop.ownership);
  if (prop.dimensionality) tags.push(prop.dimensionality === 'flat' ? '平面' : '立体');
  return '<article class="prop-custom-card" data-prop-card="' + escapeHtml(id) + '">' +
    '<div class="prop-custom-card-main">' +
      _propThumbHtml(item, id) +
      '<div class="prop-custom-card-copy">' +
        '<div class="prop-custom-card-head">' +
          '<span>' + escapeHtml(typeLabel) + '</span>' +
          (version ? _statusBadge(version) : '') +
        '</div>' +
        '<h3>' + escapeHtml(title) + '</h3>' +
        (prop.function ? '<p class="prop-custom-card-function">' + escapeHtml(prop.function) + '</p>' : '') +
        (desc ? '<p class="prop-custom-card-desc">' + escapeHtml(desc) + '</p>' : '') +
        (tags.length ? '<div class="prop-custom-tags">' + tags.map(function (tag) { return '<span>' + escapeHtml(tag) + '</span>'; }).join('') + '</div>' : '') +
        _propViewsErrorHtml(prop) +
      '</div>' +
    '</div>' +
    '<div class="prop-custom-card-actions">' +
      '<button type="button" data-prop-open="' + escapeHtml(id) + '">编辑</button>' +
      '<button type="button" data-prop-card-regenerate="' + escapeHtml(id) + '" ' + (_busy ? 'disabled' : '') + '>' + (cardBusy && _busyRole === 'card:' + id ? '生成中' : '重新生成') + '</button>' +
      '<button type="button" class="prop-custom-icon-btn" data-prop-card-menu="' + escapeHtml(id) + '" title="更多"><span class="material-symbols-outlined">more_horiz</span></button>' +
    '</div>' +
  '</article>';
}

function _draftCardHtml(item) {
  var prop = _itemPropData(item);
  var id = String(item && item.id || '');
  var version = item && item.currentVersion;
  return '<article class="prop-custom-draft-card" data-prop-draft="' + escapeHtml(id) + '">' +
    _propThumbHtml(item, id) +
    '<div>' +
      '<div class="prop-custom-card-head"><span>草稿</span>' + (version ? _statusBadge(version) : '') + '</div>' +
      '<h3>' + escapeHtml(prop.name || item.title || '草稿道具') + '</h3>' +
      '<p>' + escapeHtml(prop.description || prop.features || _versionErrorText(version) || '等待生成结果') + '</p>' +
    '</div>' +
    '<div class="prop-custom-card-actions">' +
      '<button type="button" data-prop-open-draft="' + escapeHtml(id) + '">打开</button>' +
      '<button type="button" data-prop-draft-delete="' + escapeHtml(id) + '">删除</button>' +
    '</div>' +
  '</article>';
}

function _refUploadHtml() {
  if (_refUploading) {
    return '<button type="button" class="toolbox-ref-upload" data-prop-ref-upload disabled><span class="material-symbols-outlined toolbox-spin">progress_activity</span>参考图上传中</button><input type="file" id="propRefInput" accept="image/*" hidden />';
  }
  if (!_ref) {
    return '<button type="button" class="toolbox-ref-upload" data-prop-ref-upload><span class="material-symbols-outlined">upload</span>上传参考图</button><input type="file" id="propRefInput" accept="image/*" hidden />';
  }
  var preview = _ref.localPreviewUrl || _ref.urlAtCreation || '';
  return '<div class="toolbox-ref-chip">' +
    (preview ? '<img src="' + escapeHtml(preview) + '" alt="" />' : '<span class="material-symbols-outlined">image</span>') +
    '<button type="button" class="toolbox-ref-chip-main" data-prop-ref-upload>' +
      '<span>' + escapeHtml(_ref.name || '参考图') + '</span>' +
      '<small>点击替换</small>' +
    '</button>' +
    '<button type="button" class="toolbox-ref-remove" data-prop-ref-remove title="移除参考图"><span class="material-symbols-outlined">close</span></button>' +
    '<input type="file" id="propRefInput" accept="image/*" hidden />' +
  '</div>';
}

function _listHtml() {
  return '<div class="prop-custom-page">' +
    '<header class="toolbox-page-head">' +
      '<div><p class="toolbox-kicker">PROP CUSTOM</p><h1>道具定制</h1><p>定制可复用的道具资产，支持单图和六视图。</p></div>' +
      '<button type="button" class="toolbox-generate" data-prop-new><span class="material-symbols-outlined">add</span>道具生成</button>' +
    '</header>' +
    (_drafts.length ? '<section><div class="prop-custom-section-title"><h2>草稿箱</h2></div><div class="prop-custom-draft-grid">' + _drafts.map(_draftCardHtml).join('') + '</div></section>' : '') +
    '<section><div class="prop-custom-section-title"><h2>已添加道具</h2><span>' + _items.length + ' 个</span></div>' +
      (_items.length ? '<div class="prop-custom-grid">' + _items.map(_propCardHtml).join('') + '</div>' : '<div class="toolbox-empty"><span class="material-symbols-outlined">handyman</span><p>还没有定制道具</p></div>') +
    '</section>' +
  '</div>';
}

function _draftEditorHtml() {
  var selectedProp = _selectedVersion ? _versionPropData(_selectedVersion) : (_selectedProp && _selectedProp.current) || {};
  var generating = _busy && _busyRole === 'generate';
  return '<div class="character-generation-screen" data-prop-editor data-prop-generation-editor>' +
    '<button type="button" class="character-generation-back" data-prop-back><span class="material-symbols-outlined">arrow_back</span></button>' +
    '<div class="character-generation-head">' +
      '<p class="toolbox-kicker">PROP GENERATION</p><h1>道具生成</h1><p>输入道具描述，生成草稿后确认添加。</p>' +
    '</div>' +
    '<div class="character-generation-layout">' +
      '<section class="character-generation-form-card">' +
        '<label>名称<input id="propCustomName" value="' + escapeHtml(_form.name || '') + '" placeholder="例如：青铜罗盘" /></label>' +
        '<label>描述<textarea id="propCustomPrompt" rows="7" placeholder="描述用途、材质、结构、颜色、磨损和特殊标记">' + escapeHtml(_form.prompt || '') + '</textarea></label>' +
        '<div class="prop-custom-form-row">' +
          '<label>维度<select id="propCustomDimensionality"><option value="volumetric" ' + (_form.params.dimensionality !== 'flat' ? 'selected' : '') + '>立体六视图</option><option value="flat" ' + (_form.params.dimensionality === 'flat' ? 'selected' : '') + '>平面单图</option></select></label>' +
          '<label>类型<input id="propCustomType" value="' + escapeHtml(_form.params.propType || '') + '" placeholder="武器 / 器物 / 服饰配件" /></label>' +
        '</div>' +
        '<label>材质<input id="propCustomMaterial" value="' + escapeHtml(_form.params.material || '') + '" placeholder="金属、皮革、玉石..." /></label>' +
        _refUploadHtml() +
        '<button type="button" class="toolbox-generate" data-prop-generate ' + (_busy || _refUploading ? 'disabled' : '') + '><span class="material-symbols-outlined ' + (generating ? 'toolbox-spin' : '') + '">' + (generating ? 'progress_activity' : 'auto_awesome') + '</span>' + (generating ? '生成中' : '生成道具') + '</button>' +
      '</section>' +
      '<section class="character-generation-preview">' + _previewHtml(selectedProp, _selectedVersion) + '</section>' +
      '<section class="character-generation-drafts">' +
        '<h2>候选版本</h2>' +
        (_versions.length ? _versions.map(_versionRowHtml).join('') : '<p class="prop-custom-muted">生成后会出现在这里。</p>') +
      '</section>' +
    '</div>' +
  '</div>';
}

function _confirmedEditorHtml() {
  var version = _selectedVersion;
  var prop = version ? _versionPropData(version) : (_selectedProp && _selectedProp.current) || {};
  return '<div class="prop-custom-editor" data-prop-editor>' +
    '<header class="toolbox-page-head">' +
      '<div><button type="button" class="toolbox-secondary" data-prop-back><span class="material-symbols-outlined">arrow_back</span>返回</button><p class="toolbox-kicker">PROP DETAIL</p><h1>' + escapeHtml(prop.name || '道具详情') + '</h1></div>' +
      '<button type="button" class="toolbox-generate" data-prop-editor-regenerate ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined ' + (_busy && _busyRole === 'main' ? 'toolbox-spin' : '') + '">' + (_busy && _busyRole === 'main' ? 'progress_activity' : 'autorenew') + '</span>' + (_busy && _busyRole === 'main' ? '重新生成中' : '重新生成整张道具图') + '</button>' +
    '</header>' +
    '<div class="prop-custom-editor-grid">' +
      '<section class="prop-custom-editor-form">' +
        _fieldInput('名称', 'propEditorName', prop.name || '') +
        _fieldInput('类型', 'propEditorType', prop.propType || '') +
        _fieldInput('用途', 'propEditorFunction', prop.function || '') +
        _fieldInput('结构特征', 'propEditorFeatures', prop.features || '', true) +
        _fieldInput('材质', 'propEditorMaterial', prop.material || '') +
        _fieldInput('视觉细节', 'propEditorVisual', prop.visualFeatures || '', true) +
        _fieldInput('归属', 'propEditorOwnership', prop.ownership || '') +
        '<label>维度<select id="propEditorDimensionality"><option value="volumetric" ' + (prop.dimensionality !== 'flat' ? 'selected' : '') + '>立体六视图</option><option value="flat" ' + (prop.dimensionality === 'flat' ? 'selected' : '') + '>平面单图</option></select></label>' +
        _fieldInput('描述', 'propEditorDescription', prop.description || '', true) +
        '<div class="prop-custom-editor-actions"><button type="button" data-prop-save>保存字段</button><button type="button" data-prop-upload-current>上传图片</button><button type="button" data-prop-delete-current>删除道具</button></div>' +
      '</section>' +
      '<section class="prop-custom-editor-preview">' + _previewHtml(prop, version) + '</section>' +
    '</div>' +
  '</div>';
}

function _fieldInput(label, id, value, textarea) {
  if (textarea) return '<label>' + escapeHtml(label) + '<textarea id="' + escapeHtml(id) + '" rows="3">' + escapeHtml(value || '') + '</textarea></label>';
  return '<label>' + escapeHtml(label) + '<input id="' + escapeHtml(id) + '" value="' + escapeHtml(value || '') + '" /></label>';
}

function _versionRowHtml(version) {
  var prop = _versionPropData(version);
  var id = String(version && version.id || '');
  var selected = _selectedVersion && _selectedVersion.id === id;
  return '<button type="button" class="prop-custom-version-row ' + (selected ? 'is-selected' : '') + '" data-prop-version="' + escapeHtml(id) + '">' +
    '<span>v' + escapeHtml(String(version.versionNo || '')) + '</span>' +
    '<strong>' + escapeHtml(prop.name || '候选道具') + '</strong>' +
    _statusBadge(version) +
  '</button>';
}

function _previewHtml(prop, version) {
  prop = prop || {};
  var src = version && version.displayImageUrl || '';
  var errorHtml = _propViewsErrorHtml(prop);
  var imageError = _versionErrorText(version);
  if (!errorHtml && imageError) {
    errorHtml = '<div class="prop-custom-error prop-custom-error--image" data-prop-image-error><span class="material-symbols-outlined">error</span><span>道具图生成失败；系统没有替换当前道具图。</span><small>' + escapeHtml(imageError.slice(0, 140)) + '</small></div>';
  }
  return '<div class="prop-custom-preview-stack">' +
    '<div class="prop-custom-preview-frame">' +
      (_propHasViewSlots(prop) ? _propViewGridHtml(prop, { lightbox: false }) : (src ? '<img src="' + escapeHtml(src) + '" loading="lazy" decoding="async" alt="" />' : '<div class="prop-custom-empty-preview"><span class="material-symbols-outlined">handyman</span><p>等待道具图</p></div>')) +
    '</div>' +
    errorHtml +
    (version && _selectedProp && _selectedProp.lifecycleStatus === 'draft' && _versionStatus(version) === 'completed' ? '<button type="button" class="toolbox-generate" data-prop-confirm="' + escapeHtml(version.id) + '">确认添加</button>' : '') +
  '</div>';
}

function _propViewGridHtml(prop, opts) {
  if (!_propHasViewSlots(prop)) return '';
  opts = opts || {};
  var lightbox = !!opts.lightbox;
  return '<div class="prop-custom-view-grid ' + (lightbox ? 'is-lightbox' : '') + '">' +
    PROP_VIEW_SLOTS.map(function (slot) {
      var url = _propViewOriginalUrl(prop, slot);
      return '<div class="prop-custom-view-slot">' +
        (url ? '<img src="' + escapeHtml(url) + '" loading="lazy" decoding="async" alt="" />' : '<span class="material-symbols-outlined">image_not_supported</span>') +
        (lightbox ? '' : '<small>' + escapeHtml(PROP_VIEW_LABELS[slot] || slot) + '</small>') +
      '</div>';
    }).join('') +
  '</div>';
}

function _openPropViewsLightbox(prop) {
  var existing = document.getElementById('propCustomLightbox');
  if (existing) existing.remove();
  var grid = _propViewGridHtml(prop, { lightbox: true });
  var src = '';
  if (!grid && _selectedVersion) src = _selectedVersion.displayImageUrl || '';
  var overlay = document.createElement('div');
  overlay.id = 'propCustomLightbox';
  overlay.className = 'asset-lightbox';
  overlay.innerHTML =
    '<div class="asset-lightbox-dialog prop-custom-lightbox" onclick="event.stopPropagation()">' +
      '<div class="ffe-image-frame ffe-image-frame--preview asset-lightbox-image-frame">' +
        (grid || (src ? '<img src="' + escapeHtml(src) + '" loading="lazy" decoding="async" alt="" />' : '')) +
      '</div>' +
      '<button class="asset-lightbox-close" onclick="this.closest(\'#propCustomLightbox\').remove()"><span class="material-symbols-outlined">close</span></button>' +
    '</div>';
  overlay.addEventListener('click', function () { overlay.remove(); });
  document.body.appendChild(overlay);
  hydrateProtectedImageElements(overlay);
}

function _render() {
  var root = $('propCustomRoot');
  if (!root) return;
  root.innerHTML = _view === 'draftEditor' ? _draftEditorHtml() : _view === 'confirmedEditor' ? _confirmedEditorHtml() : _listHtml();
  hydrateProtectedImageElements(root);
  if (_view === 'draftEditor') _syncDraftPolling();
  else _clearDraftPoll();
}

function _hasRenderedView() {
  var root = $('propCustomRoot');
  if (!root || !root.firstElementChild) return false;
  if (_view === 'draftEditor' || _view === 'confirmedEditor') return !!root.querySelector('[data-prop-editor]');
  return !!root.querySelector('.prop-custom-page');
}

async function _loadList(options) {
  options = options || {};
  var key = _listCacheKey();
  if (!options.force && _listCacheFresh(key)) {
    _items = (_listCache.items || []).slice();
    return;
  }
  var data = await _jsonFetch('/api/prop-custom/history?limit=80', { method: 'GET' });
  _items = data.items || [];
  _storeListCache();
}

async function _loadDrafts() {
  try {
    var data = await _jsonFetch('/api/prop-custom/history?lifecycle=draft&limit=80', { method: 'GET' });
    _drafts = data.items || [];
  } catch (_) {
    _drafts = _drafts || [];
  }
}

async function _loadProp(id) {
  var data = await _jsonFetch('/api/prop-custom/items/' + encodeURIComponent(id), { method: 'GET' });
  _selectedProp = data.prop || null;
  _selectedPropId = id;
  _versions = data.versions || [];
  _selectedVersion = _versions.find(function (item) { return item.id === (_selectedProp && _selectedProp.currentVersionId); }) || _versions[0] || null;
  if (_selectedVersion) {
    var prop = _versionPropData(_selectedVersion);
    _form.name = prop.name || '';
    _form.prompt = _selectedVersion.prompt || '';
    _form.params = Object.assign({}, _form.params, _selectedVersion.params || {});
    if (_selectedProp && _selectedProp.lifecycleStatus !== 'draft') _ref = null;
  } else {
    _ref = null;
  }
  _view = _selectedProp && _selectedProp.lifecycleStatus === 'draft' ? 'draftEditor' : 'confirmedEditor';
  _render();
}

export async function refreshPropCustomPage(options) {
  options = options || {};
  try {
    if (!options.force && _hasRenderedView()) return;
    await Promise.all([_loadList(options), _loadDrafts()]);
    if (!_selectedPropId) _view = 'list';
    _render();
  } catch (e) {
    console.error('[PropCustom] refresh failed:', e);
    _toast(e && e.message || '道具定制加载失败', 'error');
  }
}

function _draftStatusMap() {
  var map = {};
  (_drafts || []).forEach(function (item) {
    map[item && item.id] = _versionStatus(item && item.currentVersion);
  });
  return map;
}

function _syncDraftPolling() {
  var hasRunning = (_drafts || []).some(function (item) { return _versionStatus(item && item.currentVersion) === 'running'; });
  if (!hasRunning) {
    _clearDraftPoll();
    return;
  }
  if (_draftPollTimer) return;
  _draftPollTimer = window.setInterval(function () { _pollDrafts().catch(function () {}); }, _DRAFT_POLL_INTERVAL_MS);
}

function _clearDraftPoll() {
  if (_draftPollTimer) {
    window.clearInterval(_draftPollTimer);
    _draftPollTimer = 0;
  }
}

async function _pollDrafts() {
  if (_draftPollInFlight) return;
  _draftPollInFlight = true;
  var before = _draftStatusMap();
  try {
    await _loadDrafts();
    if (_selectedPropId && _selectedProp && _selectedProp.lifecycleStatus === 'draft') await _loadProp(_selectedPropId);
    else _render();
    (_drafts || []).forEach(function (item) {
      var prev = before[item && item.id];
      var next = _versionStatus(item && item.currentVersion);
      if (prev === 'running' && next === 'completed') _toast('道具草稿已生成完成', 'ok');
      if (prev === 'running' && next === 'failed') _toast(_versionErrorText(item && item.currentVersion) || '道具草稿生成失败', 'warn');
    });
  } finally {
    _draftPollInFlight = false;
    _syncDraftPolling();
  }
}

async function _generateProp() {
  if (_busy || _refUploading) return;
  var form = _readDraftForm();
  if (!form.prompt && !(_ref && _ref.refId)) {
    _toast('请先填写道具描述，或上传一张参考图', 'warn');
    return;
  }
  _setBusy(true, 'generate');
  _render();
  try {
    var data = await _jsonFetch('/api/prop-custom/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: _projectId() || undefined,
        prompt: form.prompt,
        title: form.name,
        params: form.params,
        mediaId: _ref && _ref.refId,
      }),
      timeoutMs: 600000,
    });
    _invalidateListCache();
    await _loadDrafts();
    if (data.propId) await _loadProp(data.propId);
    if (data.ok === false) _toast(data.viewsError || data.error || '这次道具没有生成完整，请查看候选版本', 'warn');
    else _toast('道具生成完成', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _confirmDraft(versionId) {
  if (!_selectedPropId || !versionId) return;
  _setBusy(true, 'confirm');
  _render();
  try {
    await _jsonFetch('/api/prop-custom/drafts/' + encodeURIComponent(_selectedPropId) + '/confirm', {
      method: 'POST',
      body: JSON.stringify({ versionId: versionId }),
    });
    _invalidateListCache();
    await Promise.all([_loadList({ force: true }), _loadDrafts()]);
    _selectedPropId = null;
    _selectedProp = null;
    _selectedVersion = null;
    _versions = [];
    _view = 'list';
    _toast('道具已添加', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _saveFields(fields) {
  if (!_selectedPropId) return;
  var data = await _jsonFetch('/api/prop-custom/items/' + encodeURIComponent(_selectedPropId), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields }),
  });
  if (data.version) {
    _selectedVersion = data.version;
    _versions = (_versions || []).map(function (item) { return item.id === data.version.id ? data.version : item; });
  }
  _invalidateListCache();
}

async function _regenerateProp(fromCardId) {
  var id = fromCardId || _selectedPropId;
  if (_busy || !id) return;
  var fields = fromCardId ? {} : _readFieldsFromDom();
  _setBusy(true, fromCardId ? ('card:' + fromCardId) : 'main');
  _render();
  try {
    if (!fromCardId && _selectedPropId) await _saveFields(fields);
    var data = await _jsonFetch('/api/prop-custom/items/' + encodeURIComponent(id) + '/regenerate', {
      method: 'POST',
      body: JSON.stringify({ fields: fields }),
      timeoutMs: 600000,
    });
    if (fromCardId) await _loadList({ force: true });
    else await _loadProp(id);
    if (data.ok === false) {
      _toast((data.viewsError || data.error || '这次道具没有生成完整') + '，当前道具仍保留上一版', 'warn');
      return;
    }
    _toast('道具图已重新生成', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

function _dismissPropCardMenu() {
  var menu = document.getElementById('propCustomCardMenu');
  if (menu) menu.remove();
  if (_propMenuDismissHandler) document.removeEventListener('click', _propMenuDismissHandler);
  if (_propMenuScrollHandler) {
    window.removeEventListener('scroll', _propMenuScrollHandler, true);
    window.removeEventListener('resize', _propMenuScrollHandler);
  }
  _propMenuDismissHandler = null;
  _propMenuScrollHandler = null;
}

function _showPropCardMenu(anchor, id) {
  id = String(id || '').trim();
  if (!id || _busy) return;
  var existing = document.getElementById('propCustomCardMenu');
  _dismissPropCardMenu();
  if (existing) return;
  var menu = document.createElement('div');
  menu.id = 'propCustomCardMenu';
  menu.className = 'fixed z-50 min-w-[200px] bg-white rounded-2xl overflow-hidden border border-black/[0.06]';
  menu.style.cssText = 'box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);';
  menu.innerHTML =
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-2xl" data-prop-menu-action="upload"><span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传图片</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-2xl" data-prop-menu-action="delete"><span class="material-symbols-outlined text-lg">delete_outline</span>删除实例</button>';
  menu.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var btn = ev.target.closest('[data-prop-menu-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-prop-menu-action') || '';
    _dismissPropCardMenu();
    if (action === 'upload') _triggerPropCardImageUpload(id);
    if (action === 'delete') _deleteProp(id).catch(function (e) { _toast(e && e.message || '删除失败，请稍后重试', 'error'); });
  });
  var rect = anchor.getBoundingClientRect();
  menu.style.top = (rect.bottom + 8) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);
  _propMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || anchor.contains(ev.target)) return;
    _dismissPropCardMenu();
  };
  _propMenuScrollHandler = function () {
    var current = document.getElementById('propCustomCardMenu');
    if (!current || !document.body.contains(anchor)) { _dismissPropCardMenu(); return; }
    var r = anchor.getBoundingClientRect();
    current.style.top = (r.bottom + 8) + 'px';
    current.style.right = (window.innerWidth - r.right) + 'px';
  };
  setTimeout(function () {
    document.addEventListener('click', _propMenuDismissHandler);
    window.addEventListener('scroll', _propMenuScrollHandler, true);
    window.addEventListener('resize', _propMenuScrollHandler);
  }, 0);
}

function _triggerPropCardImageUpload(id) {
  if (_busy || _uploadingCardId) {
    _toast('当前道具正在处理中，请稍候', 'warn');
    return;
  }
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.hidden = true;
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    if (file.size > 20 * 1024 * 1024) {
      input.remove();
      _toast('图片过大，最大 20MB', 'error');
      return;
    }
    _uploadPropCardImage(id, file).catch(function (e) {
      _toast(e && e.message || '图片上传失败，请稍后重试', 'error');
    }).finally(function () {
      input.remove();
    });
  });
  document.body.appendChild(input);
  input.click();
}

async function _uploadPropCardImage(id, file) {
  _uploadingCardId = id;
  _render();
  try {
    var fd = new FormData();
    fd.append('file', file);
    var data = await apiUpload('/api/prop-custom/items/' + encodeURIComponent(id) + '/image', fd);
    _invalidateListCache();
    if (_selectedPropId === id && data.version) {
      await _loadProp(id);
    } else {
      await _loadList({ force: true });
    }
    _toast('道具图片已更新', 'ok');
  } finally {
    _uploadingCardId = null;
    _render();
  }
}

async function _deleteProp(id) {
  if (!id) return;
  var ok = await showConfirm({
    title: '删除道具',
    message: '删除后无法在道具定制中继续使用这个实例。',
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  await _jsonFetch('/api/prop-custom/items/' + encodeURIComponent(id), { method: 'DELETE' });
  _invalidateListCache();
  await Promise.all([_loadList({ force: true }), _loadDrafts()]);
  if (_selectedPropId === id) {
    _selectedPropId = null;
    _selectedProp = null;
    _selectedVersion = null;
    _view = 'list';
  }
  _toast('道具已删除', 'ok');
  _render();
}

async function _deleteDraft(id) {
  await _jsonFetch('/api/prop-custom/drafts/' + encodeURIComponent(id), { method: 'DELETE' });
  await _loadDrafts();
  if (_selectedPropId === id) {
    _selectedPropId = null;
    _selectedProp = null;
    _selectedVersion = null;
    _versions = [];
    _view = 'list';
  }
  _render();
}

function _triggerReferenceUpload() {
  var input = $('propRefInput');
  if (input) input.click();
}

async function _handleReferenceFile(file) {
  var error = _validateReferenceFile(file);
  if (error) {
    _toast(error, 'error');
    return;
  }
  _refUploading = true;
  _render();
  try {
    await _uploadReference(file, _newUploadRequestId());
    _toast('参考图已上传', 'ok');
  } catch (e) {
    _toast(_uploadErrorMessage(e), 'error');
  } finally {
    _refUploading = false;
    _render();
  }
}

export function _initPropCustomEvents() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-prop-new]')) {
      _defaultForm();
      _selectedPropId = null;
      _selectedProp = null;
      _selectedVersion = null;
      _versions = [];
      _view = 'draftEditor';
      _render();
      return;
    }
    if (ev.target.closest('[data-prop-back]')) {
      _selectedPropId = null;
      _selectedProp = null;
      _selectedVersion = null;
      _versions = [];
      _view = 'list';
      _render();
      refreshPropCustomPage({ force: true }).catch(function () {});
      return;
    }
    var open = ev.target.closest('[data-prop-open]');
    if (open) {
      _loadProp(open.getAttribute('data-prop-open') || '').catch(function (e) { _toast(e && e.message || '打开失败', 'error'); });
      return;
    }
    var openDraft = ev.target.closest('[data-prop-open-draft]');
    if (openDraft) {
      _loadProp(openDraft.getAttribute('data-prop-open-draft') || '').catch(function (e) { _toast(e && e.message || '打开失败', 'error'); });
      return;
    }
    if (ev.target.closest('[data-prop-generate]')) {
      _generateProp().catch(function (e) { _setBusy(false); _toast(e && e.message || '生成失败', 'error'); _render(); });
      return;
    }
    var confirm = ev.target.closest('[data-prop-confirm]');
    if (confirm) {
      _confirmDraft(confirm.getAttribute('data-prop-confirm') || '').catch(function (e) { _setBusy(false); _toast(e && e.message || '确认失败', 'error'); _render(); });
      return;
    }
    var version = ev.target.closest('[data-prop-version]');
    if (version) {
      var id = version.getAttribute('data-prop-version') || '';
      _selectedVersion = (_versions || []).find(function (item) { return item.id === id; }) || _selectedVersion;
      _render();
      return;
    }
    if (ev.target.closest('[data-prop-save]')) {
      _saveFields(_readFieldsFromDom()).then(function () { _toast('字段已保存', 'ok'); _render(); }).catch(function (e) { _toast(e && e.message || '保存失败', 'error'); });
      return;
    }
    if (ev.target.closest('[data-prop-editor-regenerate]')) {
      _regenerateProp().catch(function (e) { _setBusy(false); _toast(e && e.message || '重新生成失败', 'error'); _render(); });
      return;
    }
    var regenCard = ev.target.closest('[data-prop-card-regenerate]');
    if (regenCard) {
      _regenerateProp(regenCard.getAttribute('data-prop-card-regenerate') || '').catch(function (e) { _setBusy(false); _toast(e && e.message || '重新生成失败', 'error'); _render(); });
      return;
    }
    var menu = ev.target.closest('[data-prop-card-menu]');
    if (menu) {
      _showPropCardMenu(menu, menu.getAttribute('data-prop-card-menu') || '');
      return;
    }
    if (ev.target.closest('[data-prop-upload-current]')) {
      if (_selectedPropId) _triggerPropCardImageUpload(_selectedPropId);
      return;
    }
    if (ev.target.closest('[data-prop-delete-current]')) {
      if (_selectedPropId) _deleteProp(_selectedPropId).catch(function (e) { _toast(e && e.message || '删除失败', 'error'); });
      return;
    }
    var deleteDraft = ev.target.closest('[data-prop-draft-delete]');
    if (deleteDraft) {
      _deleteDraft(deleteDraft.getAttribute('data-prop-draft-delete') || '').catch(function (e) { _toast(e && e.message || '删除草稿失败', 'error'); });
      return;
    }
    if (ev.target.closest('[data-prop-ref-upload]')) {
      _triggerReferenceUpload();
      return;
    }
    if (ev.target.closest('[data-prop-ref-remove]')) {
      _ref = null;
      _render();
      return;
    }
    var views = ev.target.closest('[data-prop-views]');
    if (views) {
      var item = _findPropListEntry(views.getAttribute('data-prop-views'));
      if (item) _openPropViewsLightbox(_itemPropData(item));
      return;
    }
    var image = ev.target.closest('[data-prop-image]');
    if (image) {
      var imgItem = _findPropListEntry(image.getAttribute('data-prop-image'));
      var url = _itemDisplayImageUrl(imgItem);
      if (_ctx.openLightbox && url) _ctx.openLightbox(url, imgItem && imgItem.title || '道具图', url);
      return;
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'propRefInput') {
      var file = ev.target.files && ev.target.files[0];
      if (file) _handleReferenceFile(file);
      ev.target.value = '';
    }
  });
}
