import { $, apiRequest, apiUpload, escapeHtml, hydrateProtectedImageElements, showConfirm } from './utils.js?v=300';
import { deriveAssetCardState } from './assets.js?v=170';

var _ctx = {};
var _wired = false;
var _view = 'list';
var _items = [];
var _drafts = [];
var _versions = [];
var _selectedCharacter = null;
var _selectedCharacterId = null;
var _selectedVersion = null;
var _busy = false;
var _regeneratingCardId = null;
var _uploadingCardId = null;
var _characterMenuDismissHandler = null;
var _characterMenuScrollHandler = null;
var _refUploading = false;
var _ref = null;
var _listCache = { key: '', items: null, loadedAt: 0 };
var _generationFitRaf = 0;
var _LIST_CACHE_TTL_MS = 2 * 60 * 1000;
var _form = {
  name: '',
  prompt: '',
  params: {
    entityType: 'auto',
    gender: 'auto',
    ageRange: 'auto',
    isCrowd: false,
    crowdSize: '',
  },
};
var CHARACTER_NAME_MAX = 20;
var CHARACTER_PROMPT_MAX = 300;

export function initCharacterCustom(ctx) {
  _ctx = ctx || {};
}

function _toast(msg, type) {
  if (_ctx.showToast) _ctx.showToast(msg, type || 'info');
}

function _projectId() {
  var p = _ctx.getProject ? _ctx.getProject() : null;
  return p && p.id ? p.id : '';
}

function _listCacheKey() {
  // 用户级全局库：不按项目分缓存，避免切换项目后看到旧的、缺角色的列表。
  return '__all__';
}

function _listCacheFresh(key) {
  return _listCache
    && _listCache.key === key
    && Array.isArray(_listCache.items)
    && Date.now() - Number(_listCache.loadedAt || 0) < _LIST_CACHE_TTL_MS;
}

function _storeListCache() {
  _listCache = {
    key: _listCacheKey(),
    items: (_items || []).slice(),
    loadedAt: Date.now(),
  };
}

function _invalidateListCache() {
  _listCache = { key: '', items: null, loadedAt: 0 };
}

async function _jsonFetch(url, opts) {
  opts = opts || {};
  try {
    return await apiRequest(url, {
      method: opts.method || 'GET',
      body: opts.body,
      headers: opts.headers,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      responseType: 'json',
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error('请求时间较长，请稍后查看历史记录或重新尝试');
    throw e;
  }
}

function _setBusy(value) {
  _busy = !!value;
}

function _openZoom(url, title) {
  url = String(url || '').trim();
  if (!url) return;
  if (_ctx.openLightbox) {
    _ctx.openLightbox(url, title || '角色设定图');
    return;
  }
  _toast('暂时无法打开大图，请稍后再试', 'warn');
}

function _afterRender(fn) {
  try {
    requestAnimationFrame(function () {
      try { fn(); } catch (_) {}
    });
  } catch (_) {
    setTimeout(function () {
      try { fn(); } catch (__) {}
    }, 0);
  }
}

function _scrollEditorTop() {
  _afterRender(function () {
    var root = $('characterCustomRoot');
    var target = root && root.querySelector('.toolbox-tool-head') || root;
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function _scrollPreviewIntoView() {
  _afterRender(function () {
    var target = $('characterPreviewArea');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

function _baseParams(params) {
  return Object.assign({ entityType: 'auto', gender: 'auto', ageRange: 'auto', isCrowd: false, crowdSize: '' }, params || {});
}

function _characterMetaTagsHtml(fields, cardId) {
  fields = fields || {};
  var modeTagHtml = '';
  var appearanceMode = String(fields.appearanceMode || 'main').trim();
  if (appearanceMode === 'referenced') {
    var viaText = String(fields.via || '').trim() || '未指明';
    modeTagHtml = '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors" data-character-edit-mode="' + escapeHtml(cardId) + '" title="点击修改出现方式；留空则改回当下活动角色">非当下·' + escapeHtml(viaText) + '</button>';
  }
  var crowdTagHtml = '';
  if (fields.isCrowd) {
    var sizeText = String(fields.crowdSize || '').trim() || '一群';
    crowdTagHtml = '<button type="button" class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors" data-character-edit-crowd="' + escapeHtml(cardId) + '" title="点击修改群体规模；留空则改回单人角色">群体·' + escapeHtml(sizeText) + '</button>';
  }
  var entityTagHtml = '';
  if (String(fields.entityType || 'human').toLowerCase() === 'non-human') {
    entityTagHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500/10 text-cyan-400" title="非人叙事实体">实体·非人</span>';
  }
  var addTagHtml = (!modeTagHtml || !crowdTagHtml)
    ? '<button type="button" class="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border border-dashed border-outline-variant/40 text-on-surface-variant/50 hover:text-on-surface-variant hover:border-outline-variant/80 transition-colors" data-character-add-tag="' + escapeHtml(cardId) + '" title="标注为非当下角色或群体角色">+ 标签</button>'
    : '';
  return modeTagHtml + crowdTagHtml + entityTagHtml + addTagHtml;
}

function _characterTraitTagsHtml(fields) {
  fields = fields || {};
  var tags = [];
  if (fields.tags) tags.push(_tagsValue(fields.tags));
  if (fields.temperament) tags.push(fields.temperament);
  if (fields.actionTraits) tags.push(fields.actionTraits);
  if (!tags.length) return '';
  var html = '<div class="flex flex-wrap gap-1.5 mt-3">';
  tags.join('，').split(/[,，/、]/).slice(0, 5).forEach(function (t) {
    t = t.trim();
    if (t) html += '<span class="inline-block px-2.5 py-1 text-[10px] font-medium bg-surface-container rounded-md text-on-surface-variant/60">' + escapeHtml(t) + '</span>';
  });
  return html + '</div>';
}

function _fieldsDescText(fields) {
  fields = fields || {};
  return [fields.appearance, fields.description, fields.clothing, fields.equipment]
    .map(function (v) { return String(v || '').trim(); })
    .filter(Boolean)
    .join(' | ');
}

function _isConfirmableVersion(version) {
  var fields = version && version.fields || {};
  var status = String(fields.reference && fields.reference.status || '');
  return version && version.status === 'completed' && !!String(fields.imageUrl || '').trim() && (status === 'ready' || status === 'degraded');
}

function _currentFields() {
  return _selectedVersion && _selectedVersion.fields || _selectedCharacter && _selectedCharacter.current || {};
}

function _parseDescPatch(value, current) {
  var parts = String(value || '').split(/\s*\|\s*/).map(function (p) { return p.trim(); });
  current = current || {};
  if (parts.length >= 4) {
    return { appearance: parts[0] || '', description: parts[1] || '', clothing: parts[2] || '', equipment: parts.slice(3).join(' | ') || '' };
  }
  if (parts.length === 3) return { appearance: parts[0] || '', description: current.description || '', clothing: parts[1] || '', equipment: parts[2] || '' };
  if (parts.length === 2) return { appearance: parts[0] || '', description: current.description || '', clothing: parts[1] || '', equipment: current.equipment || '' };
  return { appearance: parts[0] || '', description: current.description || '', clothing: current.clothing || '', equipment: current.equipment || '' };
}

function _paramButton(value, current, attr, label) {
  return '<button type="button" class="' + (value === current ? 'is-active' : '') + '" ' + attr + '="' + escapeHtml(value) + '">' + escapeHtml(label) + '</button>';
}

function _fieldCounterHtml(key, value, max) {
  return '<small class="character-field-counter" data-character-counter="' + escapeHtml(key) + '">' +
    String(value || '').length + '/' + max +
  '</small>';
}

function _paramRowHtml(label, buttonsHtml) {
  return '<div class="character-attribute-row">' +
    '<span class="character-attribute-label">' + escapeHtml(label) + '</span>' +
    '<div class="toolbox-choice-row character-choice-row character-attribute-options">' + buttonsHtml + '</div>' +
  '</div>';
}

function _optionHtml(value, current, label) {
  return '<option value="' + escapeHtml(value) + '" ' + (String(value) === String(current) ? 'selected' : '') + '>' + escapeHtml(label) + '</option>';
}

function _tagsValue(tags) {
  if (Array.isArray(tags)) return tags.join('，');
  return String(tags || '');
}

function _paramRowsHtml() {
  var p = _form.params || {};
  return '' +
    '<section class="character-attributes">' +
      '<h2 class="character-attributes-title">角色属性</h2>' +
      '<div class="character-attributes-card">' +
        _paramRowHtml('类型',
      _paramButton('auto', p.entityType, 'data-character-param-entity', '自动') +
      _paramButton('human', p.entityType, 'data-character-param-entity', '真人') +
      _paramButton('non-human', p.entityType, 'data-character-param-entity', '非人')) +
        _paramRowHtml('性别',
      _paramButton('auto', p.gender, 'data-character-param-gender', '自动') +
      _paramButton('male', p.gender, 'data-character-param-gender', '男') +
      _paramButton('female', p.gender, 'data-character-param-gender', '女') +
      _paramButton('unspecified', p.gender, 'data-character-param-gender', '不限')) +
        _paramRowHtml('年龄',
      _paramButton('auto', p.ageRange, 'data-character-param-age', '自动') +
      _paramButton('teen', p.ageRange, 'data-character-param-age', '少年') +
      _paramButton('young', p.ageRange, 'data-character-param-age', '青年') +
      _paramButton('middle', p.ageRange, 'data-character-param-age', '中年') +
      _paramButton('elder', p.ageRange, 'data-character-param-age', '老年') +
      _paramButton('unspecified', p.ageRange, 'data-character-param-age', '不限')) +
        _paramRowHtml('群体',
      _paramButton('0', p.isCrowd ? '1' : '0', 'data-character-param-crowd', '单体') +
      _paramButton('1', p.isCrowd ? '1' : '0', 'data-character-param-crowd', '群体')) +
      '</div>' +
    '</section>' +
    (p.isCrowd ? '<label class="toolbox-field character-field"><span>群体规模</span><input id="characterCrowdSizeInput" value="' + escapeHtml(p.crowdSize || '') + '" placeholder="如：三人 / 一群 / 十余人" /></label>' : '');
}

function _refHtml() {
  if (_refUploading) {
    return '<button type="button" class="toolbox-ref-upload" data-character-ref-upload disabled>' +
      '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>参考图上传中</button>' +
      '<input type="file" id="characterRefInput" accept="image/*" hidden />';
  }
  if (!_ref) {
    return '<button type="button" class="toolbox-ref-upload" data-character-ref-upload>' +
      '<span class="material-symbols-outlined">upload</span>上传参考图</button>' +
      '<input type="file" id="characterRefInput" accept="image/*" hidden />';
  }
  var img = _ref.localPreviewUrl || _ref.urlAtCreation || '';
  return '<div class="toolbox-ref-chip">' +
    '<button type="button" class="toolbox-ref-chip-main" data-character-ref-upload>' +
      (img ? '<img src="' + escapeHtml(img) + '" alt="参考图" />' : '<span class="material-symbols-outlined">image</span>') +
      '<span class="toolbox-ref-chip-name">' + escapeHtml(_ref.name || '参考图') + '</span>' +
    '</button>' +
    '<button type="button" class="toolbox-ref-chip-remove" data-character-ref-clear title="移除参考图"><span class="material-symbols-outlined">close</span></button>' +
    '<input type="file" id="characterRefInput" accept="image/*" hidden />' +
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

function _versionErrorText(version) {
  var fields = version && version.fields || {};
  var referenceError = fields.reference && fields.reference.lastError && fields.reference.lastError.message;
  return String(version && version.errorMessage || fields.imageLastError || referenceError || '').trim();
}

function _listHtml() {
  var cards = _items.length
    ? _items.map(function (item) { return _characterCardHtml(item); }).join('')
    : '<div class="toolbox-preview-empty character-list-empty"><span class="material-symbols-outlined">person_add</span><p>暂无自定义角色</p></div>';
  return '' +
    '<header class="toolbox-hero character-custom-head">' +
      '<div><p class="toolbox-kicker">CHARACTER CUSTOM</p><h1>角色定制</h1></div>' +
      '<button type="button" class="character-new-btn" data-character-new><span class="material-symbols-outlined">add</span>新建角色</button>' +
    '</header>' +
    '<div class="character-card-grid">' + cards + '</div>';
}

function _characterCardHtml(item) {
  var fields = item && item.current || {};
  var currentVersion = item && item.currentVersion || null;
  var cardState = deriveAssetCardState(fields, 0);
  var imgSrc = cardState.previewImageUrl || '';
  var thumbSrc = cardState.previewThumbUrl || imgSrc;
  var zoomSrc = cardState.previewZoomUrl || imgSrc;
  var name = fields.name || item.title || '未命名角色';
  var cardId = item && item.id || '';
  var roleText = fields.role || '';
  if (fields.identity) roleText += (roleText ? ' · ' : '') + fields.identity;
  var desc = _fieldsDescText(fields);
  var cardBusy = _busy && _regeneratingCardId === cardId;
  var imgHtml = imgSrc
    ? '<img src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(name) + '" loading="lazy" decoding="async" class="w-full h-full object-cover object-[left_top] transform group-hover:scale-105 transition-transform duration-700" />'
    : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-5xl text-on-surface-variant/15">person</span></div>';
  var metaTagsHtml = _characterMetaTagsHtml(fields, cardId);
  var tagsHtml = _characterTraitTagsHtml(fields);
  var statusTone = cardState.status === 'degraded' ? 'text-amber-500' : cardState.status === 'failed' ? 'text-red-500' : 'text-primary';
  var statusPreview = imgSrc
    ? '<div class="w-full aspect-square rounded-lg overflow-hidden bg-[#ECEFF1] cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all" data-character-zoom="' + escapeHtml(zoomSrc) + '">' +
        '<img src="' + escapeHtml(thumbSrc) + '" loading="lazy" decoding="async" class="w-full h-full object-cover object-[right_center]" />' +
      '</div>'
    : '<div class="w-full aspect-square rounded-lg bg-surface-container border border-outline-variant/20 flex items-center justify-center text-on-surface-variant/60 text-[11px] font-bold">无预览</div>';
  return '' +
    '<div class="asset-card group relative bg-surface-container-low rounded-xl overflow-hidden p-1 border border-transparent hover:border-outline-variant/20 transition-all duration-500" data-character-card="' + escapeHtml(cardId) + '">' +
      '<div class="flex flex-col md:flex-row h-full min-h-[360px]">' +
        '<div class="w-full md:w-[45%] relative h-72 md:h-auto overflow-hidden rounded-xl cursor-pointer -mt-1 -ml-1 -mr-1 md:mr-0 md:-mb-1" data-character-zoom="' + escapeHtml(zoomSrc) + '">' +
          imgHtml +
          '<div class="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/20"><span class="material-symbols-outlined text-white text-3xl drop-shadow-lg">zoom_in</span></div>' +
        '</div>' +
        '<div class="w-full md:w-[55%] p-7 flex flex-col justify-between">' +
          '<div>' +
            '<div class="flex justify-between items-start mb-1">' +
              '<div class="flex-1 min-w-0">' +
                '<div class="flex items-center gap-1.5 min-w-0" data-character-name-wrap="' + escapeHtml(cardId) + '">' +
                  '<h4 class="min-w-0 truncate text-2xl font-bold tracking-tight text-on-background" data-character-name-text="' + escapeHtml(cardId) + '">' + escapeHtml(name) + '</h4>' +
                  '<input class="character-card-name-input hidden min-w-0 flex-1 h-auto bg-transparent text-2xl font-bold tracking-tight text-on-background focus:outline-none focus:ring-0" style="background:transparent;border:0;padding:0;box-shadow:none;outline:none;" maxlength="60" value="' + escapeHtml(name) + '" data-character-name-input="' + escapeHtml(cardId) + '" />' +
                  '<button type="button" class="character-card-name-edit shrink-0 inline-flex w-4 h-4 items-center justify-center rounded-full text-on-surface-variant/35 hover:text-on-surface-variant/70 hover:bg-surface-container-highest/30 transition-colors" data-character-name-edit="' + escapeHtml(cardId) + '" title="修改角色名称" ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined leading-none" style="font-size:12px;">edit</span></button>' +
                '</div>' +
                (roleText ? '<p class="text-sm text-on-surface-variant font-medium mt-0.5">' + escapeHtml(roleText) + '</p>' : '') +
                (metaTagsHtml ? '<div class="flex flex-wrap items-center gap-1.5 mt-2">' + metaTagsHtml + '</div>' : '') +
              '</div>' +
              '<span class="material-symbols-outlined text-primary cursor-pointer hover:scale-110 transition-transform text-lg" data-character-menu="' + escapeHtml(cardId) + '" title="更多操作">more_vert</span>' +
            '</div>' +
            '<div class="asset-desc-wrap mt-3" data-character-desc-wrap="' + escapeHtml(cardId) + '" title="点击编辑角色描述">' +
              '<p class="asset-desc-text text-[11px] text-on-surface-variant/60 leading-relaxed cursor-text hover:text-on-surface-variant transition-colors" data-character-desc-text="' + escapeHtml(cardId) + '">' + escapeHtml((desc || '暂无角色描述').slice(0, 300)) + '</p>' +
              '<textarea class="asset-desc-edit hidden w-full text-[11px] text-on-surface-variant leading-relaxed bg-surface-container-lowest border border-outline-variant/20 rounded p-2 mt-1 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30" rows="4" data-character-desc-edit="' + escapeHtml(cardId) + '">' + escapeHtml(desc.slice(0, 300)) + '</textarea>' +
            '</div>' +
            tagsHtml +
            '<div class="p-3 bg-surface-container-lowest rounded-lg border border-outline-variant/10 mt-5">' +
              '<div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold tracking-widest text-[#90A4AE] uppercase">角色设定图</span><span class="text-[10px] font-bold ' + statusTone + '">' + escapeHtml(cardState.statusLabel) + '</span></div>' +
              statusPreview +
              (cardState.statusMessage ? '<p class="mt-2 text-[11px] leading-relaxed text-on-surface-variant/60">' + escapeHtml(cardState.statusMessage) + '</p>' : '') +
            '</div>' +
          '</div>' +
          '<div class="flex items-center gap-3 mt-5">' +
            '<button type="button" class="flex-1 h-10 flex items-center justify-center bg-primary text-on-primary rounded-full font-bold text-[11px] tracking-wider uppercase hover:shadow-lg transition-all disabled:opacity-60 disabled:cursor-wait" data-character-card-regenerate="' + escapeHtml(cardId) + '" ' + (_busy ? 'disabled' : '') + '>' +
              (cardBusy ? '<span class="material-symbols-outlined toolbox-spin text-sm mr-1.5">progress_activity</span>重新生成中' : '重新生成') +
            '</button>' +
            '<button type="button" class="w-10 h-10 flex items-center justify-center bg-surface-container-highest/30 rounded-full hover:bg-surface-container-highest transition-all disabled:opacity-60" data-character-edit-card="' + escapeHtml(cardId) + '" title="编辑" ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined text-on-surface text-lg">edit</span></button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function _findListItem(id) {
  id = String(id || '').trim();
  return (_items || []).find(function (item) { return item && item.id === id; }) || null;
}

function _applyVersionToListItem(id, version) {
  var item = _findListItem(id);
  if (!item || !version) return;
  item.currentVersion = version;
  item.currentVersionId = version.id || item.currentVersionId;
  item.current = version.fields || item.current;
  item.title = item.current && item.current.name || item.title;
}

function _openCardDescriptionEditor(id) {
  id = String(id || '').trim();
  if (!id) return;
  var wrap = document.querySelector('[data-character-desc-wrap="' + id + '"]');
  var text = wrap && wrap.querySelector('[data-character-desc-text]');
  var edit = wrap && wrap.querySelector('[data-character-desc-edit]');
  if (!text || !edit) return;
  if (!edit.classList.contains('hidden')) {
    edit.focus();
    return;
  }
  var item = _findListItem(id);
  var desc = _fieldsDescText(item && item.current || {});
  edit.value = desc;
  text.classList.add('hidden');
  edit.classList.remove('hidden');
  edit.focus();
  try { edit.setSelectionRange(edit.value.length, edit.value.length); } catch (_) {}
}

function _openCardNameEditor(id) {
  id = String(id || '').trim();
  if (!id || _busy) return;
  var wrap = document.querySelector('[data-character-name-wrap="' + id + '"]');
  var text = wrap && wrap.querySelector('[data-character-name-text]');
  var input = wrap && wrap.querySelector('[data-character-name-input]');
  var btn = wrap && wrap.querySelector('[data-character-name-edit]');
  if (!text || !input) return;
  if (!input.classList.contains('hidden')) {
    input.focus();
    try { input.select(); } catch (_) {}
    return;
  }
  var item = _findListItem(id);
  var name = item && item.current && item.current.name || item && item.title || text.textContent || '';
  input.value = String(name || '').trim();
  input.defaultValue = input.value;
  input.onkeydown = function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      _finishCardNameEdit(input);
    } else if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      input.setAttribute('data-character-name-cancel', '1');
      _finishCardNameEdit(input);
    }
  };
  input.onblur = function () {
    _finishCardNameEdit(input);
  };
  text.classList.add('hidden');
  if (btn) btn.classList.add('hidden');
  input.classList.remove('hidden');
  input.focus();
  try { input.select(); } catch (_) {}
}

function _closeCardNameEditor(input, nextName) {
  if (!input) return;
  var id = input.getAttribute('data-character-name-input') || '';
  var wrap = id && document.querySelector('[data-character-name-wrap="' + id + '"]');
  var text = wrap && wrap.querySelector('[data-character-name-text]');
  var btn = wrap && wrap.querySelector('[data-character-name-edit]');
  input.classList.add('hidden');
  if (text) {
    if (typeof nextName === 'string') text.textContent = nextName || '未命名角色';
    text.classList.remove('hidden');
  }
  if (btn) btn.classList.remove('hidden');
}

function _finishCardNameEdit(input) {
  if (!input || input.classList.contains('hidden')) return false;
  var nameId = input.getAttribute('data-character-name-input') || '';
  var originalName = input.defaultValue || '';
  var nextName = String(input.value || '').trim();
  if (input.getAttribute('data-character-name-cancel') === '1') {
    input.removeAttribute('data-character-name-cancel');
    _closeCardNameEditor(input, originalName);
    return true;
  }
  if (!nextName) {
    _closeCardNameEditor(input, originalName);
    _toast('角色名称不能为空', 'warn');
    return true;
  }
  _closeCardNameEditor(input, nextName);
  if (nextName === originalName.trim()) return true;
  _saveCardName(nameId, nextName).then(function () {
    input.defaultValue = nextName;
    _toast('角色名称已保存', 'ok');
  }).catch(function (e) {
    _toast(e && e.message || '名称保存失败，请稍后重试', 'error');
    refreshCharacterCustomPage();
  });
  return true;
}

async function _saveCardName(id, name) {
  var item = _findListItem(id);
  if (!item) throw new Error('没有找到要保存的角色');
  var nextName = String(name || '').trim();
  if (!nextName) throw new Error('角色名称不能为空');
  var fields = Object.assign({}, item.current || {}, { name: nextName });
  var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields }),
  });
  if (data.version) {
    item.currentVersion = data.version;
    item.current = data.version.fields || item.current;
    item.title = item.current.name || item.title;
    _storeListCache();
  }
  return data;
}

function _dismissCharacterCardMenu() {
  var menu = document.getElementById('characterCustomCardMenu');
  if (menu) menu.remove();
  if (_characterMenuDismissHandler) {
    document.removeEventListener('click', _characterMenuDismissHandler);
    _characterMenuDismissHandler = null;
  }
  if (_characterMenuScrollHandler) {
    window.removeEventListener('scroll', _characterMenuScrollHandler, true);
    window.removeEventListener('resize', _characterMenuScrollHandler);
    _characterMenuScrollHandler = null;
  }
}

function _showCharacterCardMenu(anchor, id) {
  id = String(id || '').trim();
  if (!id || _busy) return;
  var existing = document.getElementById('characterCustomCardMenu');
  _dismissCharacterCardMenu();
  if (existing) return;
  var item = _findListItem(id);
  if (!item) return;

  var menu = document.createElement('div');
  menu.id = 'characterCustomCardMenu';
  menu.className = 'fixed z-50 min-w-[200px] bg-white rounded-2xl overflow-hidden border border-black/[0.06]';
  menu.style.cssText = 'box-shadow: 0 8px 32px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.06);';
  menu.innerHTML =
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors rounded-t-2xl" data-character-menu-action="upload">' +
      '<span class="material-symbols-outlined text-lg text-[#2E7D32]">upload</span>上传图片' +
    '</button>' +
    '<div class="mx-4 border-t border-black/[0.06]"></div>' +
    '<button type="button" class="w-full flex items-center gap-3 px-5 py-3 text-[13px] font-medium text-[#e53935] hover:bg-red-50 transition-colors rounded-b-2xl" data-character-menu-action="delete">' +
      '<span class="material-symbols-outlined text-lg">delete_outline</span>删除实例' +
    '</button>';

  menu.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var btn = ev.target.closest('[data-character-menu-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-character-menu-action') || '';
    _dismissCharacterCardMenu();
    if (action === 'upload') {
      _triggerCharacterCardImageUpload(id);
    } else if (action === 'delete') {
      _deleteCharacterCard(id).catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '删除失败，请稍后重试', 'error');
      });
    }
  });

  var rect = anchor.getBoundingClientRect();
  menu.style.top = (rect.bottom + 8) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);

  _characterMenuDismissHandler = function (ev) {
    if (menu.contains(ev.target) || anchor.contains(ev.target)) return;
    _dismissCharacterCardMenu();
  };
  var repositionPending = false;
  _characterMenuScrollHandler = function () {
    if (repositionPending) return;
    repositionPending = true;
    requestAnimationFrame(function () {
      repositionPending = false;
      var current = document.getElementById('characterCustomCardMenu');
      if (!current) return;
      if (!document.body.contains(anchor)) { _dismissCharacterCardMenu(); return; }
      var r = anchor.getBoundingClientRect();
      current.style.top = (r.bottom + 8) + 'px';
      current.style.right = (window.innerWidth - r.right) + 'px';
    });
  };
  setTimeout(function () {
    document.addEventListener('click', _characterMenuDismissHandler);
    window.addEventListener('scroll', _characterMenuScrollHandler, true);
    window.addEventListener('resize', _characterMenuScrollHandler);
  }, 0);
}

function _triggerCharacterCardImageUpload(id) {
  if (_busy || _uploadingCardId) {
    _toast('当前角色正在处理中，请稍候', 'warn');
    return;
  }
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.hidden = true;
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) {
      input.remove();
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      input.remove();
      _toast('图片过大，最大 20MB', 'error');
      return;
    }
    _uploadCharacterCardImage(id, file).catch(function (e) {
      _toast(e && e.message || '图片上传失败，请稍后重试', 'error');
    }).finally(function () {
      input.remove();
    });
  });
  document.body.appendChild(input);
  input.click();
}

async function _uploadCharacterCardImage(id, file) {
  var item = _findListItem(id);
  if (!item) throw new Error('没有找到要上传图片的角色');
  _setBusy(true);
  _uploadingCardId = id;
  _render();
  _toast('正在上传角色图片...', 'info');
  try {
    var fd = new FormData();
    fd.append('file', file);
    var data = await apiUpload('/api/character-custom/items/' + encodeURIComponent(id) + '/image', fd);
    if (data.version) {
      _applyVersionToListItem(id, data.version);
      _storeListCache();
    }
    _toast('图片已上传并设为当前角色图', 'ok');
  } finally {
    _setBusy(false);
    _uploadingCardId = null;
    _render();
  }
}

async function _deleteCharacterCard(id) {
  var item = _findListItem(id);
  if (!item) throw new Error('没有找到要删除的角色');
  var name = item.current && item.current.name || item.title || '未命名角色';
  var ok = await showConfirm('删除实例', '确定删除角色「' + name + '」？删除后不会再显示在角色定制页面。', '删除', '取消');
  if (!ok) return;
  _setBusy(true);
  _render();
  try {
    await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id), { method: 'DELETE' });
    _items = (_items || []).filter(function (candidate) { return !candidate || candidate.id !== id; });
    _storeListCache();
    _toast('角色实例已删除', 'ok');
  } finally {
    _setBusy(false);
    _render();
  }
}

async function _patchCharacterCardFields(id, patch) {
  var item = _findListItem(id);
  if (!item) throw new Error('没有找到要修改的角色');
  var fields = Object.assign({}, item.current || {}, patch || {});
  var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields }),
  });
  if (data.version) {
    _applyVersionToListItem(id, data.version);
    _storeListCache();
  }
  _render();
  return data;
}

function _editCharacterMode(id) {
  var item = _findListItem(id);
  if (!item) return;
  var fields = item.current || {};
  var nextVia = window.prompt('通过什么方式出现？（如：回忆 / 照片 / 梦境 / 通缉令 / 电话那头）\n留空则改回「当下活动角色」。', fields.via || '');
  if (nextVia === null) return;
  nextVia = String(nextVia || '').trim();
  _patchCharacterCardFields(id, nextVia ? { appearanceMode: 'referenced', via: nextVia } : { appearanceMode: 'main', via: '' }).then(function () {
    _toast('出现方式已更新', 'ok');
  }).catch(function (e) {
    _toast(e && e.message || '出现方式保存失败', 'error');
  });
}

function _editCharacterCrowd(id) {
  var item = _findListItem(id);
  if (!item) return;
  var fields = item.current || {};
  var nextSize = window.prompt('群体规模（如：三四个 / 一队 / 成群）\n留空则改回「单人角色」。', fields.crowdSize || '');
  if (nextSize === null) return;
  nextSize = String(nextSize || '').trim();
  _patchCharacterCardFields(id, nextSize ? { isCrowd: true, crowdSize: nextSize } : { isCrowd: false, crowdSize: '' }).then(function () {
    _toast('群体规模已更新', 'ok');
  }).catch(function (e) {
    _toast(e && e.message || '群体标签保存失败', 'error');
  });
}

function _addCharacterTag(id) {
  var choice = window.prompt('添加哪类标签？\n1 = 非当下角色（回忆/照片/梦境等）\n2 = 群体角色\n输入 1 或 2：');
  if (choice === null) return;
  choice = String(choice || '').trim();
  if (choice === '1') {
    _editCharacterMode(id);
  } else if (choice === '2') {
    _editCharacterCrowd(id);
  }
}

function _draftEditorHtml() {
  var canConfirm = _isConfirmableVersion(_selectedVersion);
  return '' +
    '<header class="toolbox-tool-head character-generation-head">' +
      '<button type="button" class="toolbox-back" data-character-back title="返回角色定制"><span class="material-symbols-outlined">arrow_back</span></button>' +
      '<div><p class="toolbox-kicker">CHARACTER CUSTOM</p><h1>角色生成</h1></div>' +
      '<button type="button" class="character-new-btn" data-character-confirm ' + (canConfirm && !_busy ? '' : 'disabled') + '><span class="material-symbols-outlined">check</span>确认添加</button>' +
    '</header>' +
    '<div class="toolbox-workbench character-generation-grid" data-character-editor data-character-generation-editor>' +
      '<section class="toolbox-panel toolbox-config character-generation-form-card">' +
        '<div class="toolbox-form character-generate-form character-generation-form">' +
          '<div class="toolbox-field character-field character-ref-field"><span>参考图</span>' + _refHtml() + '</div>' +
          '<label class="toolbox-field character-field character-field-with-counter"><span>角色名称</span><input id="characterNameInput" type="text" maxlength="' + CHARACTER_NAME_MAX + '" data-character-counter-source="name" data-character-counter-max="' + CHARACTER_NAME_MAX + '" placeholder="为角色命名（留空则使用 AI 生成的名称）" value="' + escapeHtml(_form.name || '') + '" />' + _fieldCounterHtml('name', _form.name, CHARACTER_NAME_MAX) + '</label>' +
          '<label class="toolbox-field character-field character-field-with-counter"><span>提示词</span><textarea id="characterPromptInput" rows="6" maxlength="' + CHARACTER_PROMPT_MAX + '" data-character-counter-source="prompt" data-character-counter-max="' + CHARACTER_PROMPT_MAX + '" placeholder="描述角色外貌、服装、气质或需要复制的图片特征">' + escapeHtml(_form.prompt || '') + '</textarea>' + _fieldCounterHtml('prompt', _form.prompt, CHARACTER_PROMPT_MAX) + '</label>' +
          _paramRowsHtml() +
        '</div>' +
        '<div class="character-generation-actions">' +
          '<button type="button" class="toolbox-generate character-generation-submit" data-character-generate ' + (_busy || _refUploading ? 'disabled' : '') + '>' +
            '<span class="material-symbols-outlined ' + (_busy || _refUploading ? 'toolbox-spin' : '') + '">' + (_busy || _refUploading ? 'progress_activity' : 'auto_awesome') + '</span>' +
            (_busy ? '生成中' : _refUploading ? '等待上传' : '生成角色') +
          '</button>' +
        '</div>' +
      '</section>' +
      '<section class="toolbox-panel toolbox-preview character-generation-preview">' +
        '<div id="characterPreviewArea" class="toolbox-preview-area">' + _previewHtml() + '</div>' +
      '</section>' +
      '<aside class="toolbox-panel toolbox-history character-generation-drafts">' +
        '<div class="toolbox-history-head"><div><strong>草稿箱</strong><small>未确认角色</small></div></div>' +
        '<div class="toolbox-history-list">' + _draftBoxHtml() + '</div>' +
      '</aside>' +
    '</div>';
}

function _fieldHtml(key, label, value, rows) {
  var field = rows
    ? '<textarea data-character-field="' + escapeHtml(key) + '" rows="' + rows + '">' + escapeHtml(value || '') + '</textarea>'
    : '<input data-character-field="' + escapeHtml(key) + '" value="' + escapeHtml(value || '') + '" />';
  return '<label class="toolbox-field"><span>' + escapeHtml(label) + '</span>' + field + '</label>';
}

function _confirmedMetaControlsHtml(fields) {
  fields = fields || {};
  var appearanceMode = String(fields.appearanceMode || 'main');
  var crowdValue = fields.isCrowd ? '1' : '';
  return '' +
    '<div class="character-meta-grid">' +
      '<label class="toolbox-field"><span>角色状态</span><select data-character-field="appearanceMode">' +
        _optionHtml('main', appearanceMode, '当下角色') +
        _optionHtml('referenced', appearanceMode, '非当下活动') +
      '</select></label>' +
      '<label class="toolbox-field"><span>非当下来源</span><input data-character-field="via" value="' + escapeHtml(fields.via || '') + '" placeholder="如：回忆 / 新闻画面 / 监控记录" /></label>' +
      '<label class="toolbox-field"><span>群体角色</span><select data-character-field-bool="isCrowd">' +
        _optionHtml('', crowdValue, '单人/个体') +
        _optionHtml('1', crowdValue, '群体') +
      '</select></label>' +
      '<label class="toolbox-field"><span>群体规模</span><input data-character-field="crowdSize" value="' + escapeHtml(fields.crowdSize || '') + '" placeholder="如：三人 / 一群 / 十余人" /></label>' +
    '</div>' +
    '<label class="toolbox-field"><span>标签</span><input data-character-tags-field value="' + escapeHtml(_tagsValue(fields.tags)) + '" placeholder="用逗号分隔，如：冷静，敏锐，克制" /></label>';
}

function _confirmedEditorHtml() {
  var fields = _currentFields();
  return '' +
    '<header class="toolbox-tool-head">' +
      '<button type="button" class="toolbox-back" data-character-back title="返回角色定制"><span class="material-symbols-outlined">arrow_back</span></button>' +
      '<div><p class="toolbox-kicker">CHARACTER CUSTOM</p><h1>角色编辑</h1></div>' +
    '</header>' +
    '<div class="toolbox-workbench" data-character-editor data-character-confirmed-editor>' +
      '<section class="toolbox-panel toolbox-config">' +
        '<div class="toolbox-form">' +
          _fieldHtml('name', '角色名', fields.name || '', 0) +
          _fieldHtml('role', '角色身份', fields.role || '', 0) +
          _fieldHtml('identity', '一句话定位', fields.identity || '', 0) +
          _confirmedMetaControlsHtml(fields) +
          _fieldHtml('appearance', '外貌', fields.appearance || '', 4) +
          _fieldHtml('description', '描述', fields.description || '', 3) +
          _fieldHtml('clothing', '服装', fields.clothing || '', 3) +
          _fieldHtml('equipment', '携带/穿戴', fields.equipment || '', 2) +
          _fieldHtml('temperament', '气质标签', fields.temperament || '', 2) +
          _fieldHtml('actionTraits', '动作特征', fields.actionTraits || '', 2) +
          '<button type="button" class="toolbox-generate" data-character-save-fields ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined">save</span>保存字段</button>' +
          '<button type="button" class="toolbox-generate character-secondary-action" data-character-editor-regenerate ' + (_busy ? 'disabled' : '') + '><span class="material-symbols-outlined ' + (_busy ? 'toolbox-spin' : '') + '">' + (_busy ? 'progress_activity' : 'autorenew') + '</span>' + (_busy ? '重新生成中' : '重新生成') + '</button>' +
        '</div>' +
      '</section>' +
      '<section class="toolbox-panel toolbox-preview">' +
        '<div id="characterPreviewArea" class="toolbox-preview-area">' + _previewHtml() + '</div>' +
      '</section>' +
      '<aside class="toolbox-panel toolbox-history">' +
        '<div class="toolbox-history-head"><div><strong>历史记录</strong><small>正式版本</small></div></div>' +
        '<div class="toolbox-history-list">' + _historyHtml() + '</div>' +
      '</aside>' +
    '</div>';
}

function _previewHtml() {
  var fields = _selectedVersion && _selectedVersion.fields || null;
  var url = fields && (fields.imageUrl || fields.rawUrl || fields.realPhotoUrl || fields.reference && fields.reference.lastAttemptUrl) || '';
  var errorText = _versionErrorText(_selectedVersion);
  if (_busy) {
    return '<div class="toolbox-preview-empty"><span class="material-symbols-outlined toolbox-spin">progress_activity</span><p>正在生成角色设定图</p></div>';
  }
  if (!url) {
    return '<div class="toolbox-preview-empty"><span class="material-symbols-outlined">portrait</span><p>' + (errorText ? '生成失败' : '角色图将在这里显示') + '</p>' +
      (errorText ? '<small>' + escapeHtml(errorText.slice(0, 160)) + '</small>' : '') +
    '</div>';
  }
  return '<div class="toolbox-media-frame"><img src="' + escapeHtml(url) + '" alt="角色设定图" />' +
    '<div class="toolbox-media-actions"><button type="button" data-character-zoom="' + escapeHtml(url) + '" title="查看大图"><span class="material-symbols-outlined">zoom_in</span></button></div>' +
  '</div>';
}

function _historyHtml() {
  if (!_versions.length) return '<div class="toolbox-empty-history"><span class="material-symbols-outlined">history</span><p>暂无历史版本</p></div>';
  return _versions.map(function (version) {
    var fields = version.fields || {};
    var state = deriveAssetCardState(fields, 0);
    var url = state.previewThumbUrl || state.previewImageUrl || '';
    var errorText = _versionErrorText(version);
    return '<button type="button" class="toolbox-history-card ' + (version.id === (_selectedVersion && _selectedVersion.id) ? 'is-selected' : '') + '" data-character-version="' + escapeHtml(version.id) + '">' +
      '<span class="toolbox-history-thumb">' + (url ? '<img src="' + escapeHtml(url) + '" alt="" />' : '<span class="material-symbols-outlined">person</span>') + '</span>' +
      '<span class="toolbox-history-copy"><strong>版本 ' + escapeHtml(String(version.versionNo || '')) + '</strong><small>' + escapeHtml(state.statusLabel || version.status || '') + '</small>' +
        (errorText ? '<small>' + escapeHtml(errorText.slice(0, 72)) + '</small>' : '') +
      '</span>' +
    '</button>';
  }).join('');
}

function _formatDraftTime(iso) {
  var t = Date.parse(iso || '');
  if (!t) return '';
  var diff = Date.now() - t;
  if (diff < 0) diff = 0;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  var d = new Date(t);
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function _draftBoxHtml() {
  if (!_drafts.length) {
    return '<div class="toolbox-empty-history"><span class="material-symbols-outlined">inbox</span><p>草稿箱是空的</p><small>点「生成角色」后，未确认的角色会暂存在这里</small></div>';
  }
  return _drafts.map(function (item) {
    var fields = item && item.current || {};
    var version = item && item.currentVersion || null;
    var status = version && version.status || '';
    var state = deriveAssetCardState(fields, 0);
    var url = state.previewThumbUrl || state.previewImageUrl || '';
    var name = fields.name || item.title || '未命名草稿';
    var statusLabel = status === 'running' ? '生成中' : status === 'failed' ? '生成失败' : '待确认';
    var time = _formatDraftTime((version && version.createdAt) || (item && item.createdAt) || (item && item.updatedAt));
    var meta = time ? (statusLabel + ' · ' + time) : statusLabel;
    var detail = String((version && version.prompt) || fields.description || fields.appearance || '').replace(/\s+/g, ' ').trim();
    if (!detail) detail = status === 'running' ? '正在生成角色设定图' : (String(fields.entityType || '') === 'non-human' ? '非人角色' : '自定义角色');
    var selected = item && item.id === _selectedCharacterId;
    var thumb = status === 'running'
      ? '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>'
      : (url ? '<img src="' + escapeHtml(url) + '" alt="" />' : '<span class="material-symbols-outlined">person</span>');
    return '<div class="toolbox-history-card ' + (selected ? 'is-selected ' : '') + '">' +
      '<button type="button" class="toolbox-history-main" data-character-draft-open="' + escapeHtml(item.id) + '">' +
        '<span class="toolbox-history-thumb">' + thumb + '</span>' +
        '<span class="toolbox-history-copy">' +
          '<strong>' + escapeHtml(name) + '</strong>' +
          '<small>' + escapeHtml(meta) + '</small>' +
          '<em>' + escapeHtml(detail.slice(0, 40)) + '</em>' +
        '</span>' +
      '</button>' +
      '<button type="button" class="toolbox-history-delete" data-character-draft-delete="' + escapeHtml(item.id) + '" title="删除草稿">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  }).join('');
}

function _clearGenerationFit() {
  var root = $('characterCustomRoot');
  var page = $('pageCharacterCustom');
  if (root) {
    root.style.removeProperty('--character-generation-scale');
    root.style.removeProperty('--character-generation-fit-left');
    root.style.removeProperty('--character-generation-fit-top');
    root.style.removeProperty('--character-gen-panel-min');
    root.removeAttribute('data-character-generation-fit-scale');
  }
  if (page) page.removeAttribute('data-character-generation-scale');
}

function _fitGenerationEditor() {
  _generationFitRaf = 0;
  var page = $('pageCharacterCustom');
  var root = $('characterCustomRoot');
  if (!page || !root || page.hidden || _view !== 'draftEditor' || !root.querySelector('[data-character-generation-editor]')) {
    _clearGenerationFit();
    return;
  }
  var pageStyle = window.getComputedStyle(page);
  var padLeft = parseFloat(pageStyle.paddingLeft) || 0;
  var padRight = parseFloat(pageStyle.paddingRight) || 0;
  var padTop = parseFloat(pageStyle.paddingTop) || 0;
  var padBottom = parseFloat(pageStyle.paddingBottom) || 0;
  var availableWidth = Math.max(1, page.clientWidth - padLeft - padRight);
  var availableHeight = Math.max(1, page.clientHeight - padTop - padBottom);
  // 量自然尺寸前先清掉上一轮的面板高度覆写，避免在旧值基础上累计。
  root.style.removeProperty('--character-gen-panel-min');
  var naturalWidth = Math.max(1, Math.ceil(root.scrollWidth));
  var naturalHeight = Math.max(1, Math.ceil(root.scrollHeight));
  var scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  scale = Math.max(0.42, Math.min(1, scale));
  // 左中右三栏同行时，把面板高度补成「可用高度 ÷ 缩放 − 头部占高」，让三栏下边界贴齐页面下边界。
  var fillHead = root.querySelector('.character-generation-head');
  var fillForm = root.querySelector('.character-generation-form-card');
  var fillDrafts = root.querySelector('.character-generation-drafts');
  var fillSingleRow = !!(fillForm && fillDrafts && Math.abs(fillForm.offsetTop - fillDrafts.offsetTop) < 2);
  if (fillHead && fillSingleRow) {
    var fillHeadStyle = window.getComputedStyle(fillHead);
    var fillHeadBlock = Math.ceil(fillHead.offsetHeight + (parseFloat(fillHeadStyle.marginTop) || 0) + (parseFloat(fillHeadStyle.marginBottom) || 0));
    var fillPanelTarget = Math.floor(availableHeight / scale) - fillHeadBlock;
    if (fillPanelTarget >= 480) {
      root.style.setProperty('--character-gen-panel-min', fillPanelTarget + 'px');
      naturalHeight = Math.max(1, Math.ceil(root.scrollHeight));
    }
  }
  var visualWidth = naturalWidth * scale;
  var visualHeight = naturalHeight * scale;
  var left = padLeft + Math.max(0, (availableWidth - visualWidth) / 2);
  var top = padTop + Math.max(0, (availableHeight - visualHeight) / 2);
  root.style.setProperty('--character-generation-scale', scale.toFixed(4));
  root.style.setProperty('--character-generation-fit-left', left.toFixed(2) + 'px');
  root.style.setProperty('--character-generation-fit-top', top.toFixed(2) + 'px');
  root.setAttribute('data-character-generation-fit-scale', scale < 0.999 ? 'scaled' : 'none');
  page.setAttribute('data-character-generation-scale', scale.toFixed(4));
}

function _scheduleGenerationFit() {
  if (_generationFitRaf) window.cancelAnimationFrame(_generationFitRaf);
  _generationFitRaf = window.requestAnimationFrame(_fitGenerationEditor);
}

function _render() {
  var root = $('characterCustomRoot');
  if (!root) return;
  root.innerHTML = _view === 'draftEditor' ? _draftEditorHtml() : _view === 'confirmedEditor' ? _confirmedEditorHtml() : _listHtml();
  hydrateProtectedImageElements(root);
  if (_view === 'draftEditor') _scheduleGenerationFit();
  else _clearGenerationFit();
}

function _hasRenderedView() {
  var root = $('characterCustomRoot');
  if (!root || !root.firstElementChild) return false;
  if (_view === 'draftEditor' || _view === 'confirmedEditor') return !!root.querySelector('[data-character-editor]');
  return !!root.querySelector('.character-card-grid');
}

async function _loadList(options) {
  options = options || {};
  var key = _listCacheKey();
  if (!options.force && _listCacheFresh(key)) {
    _items = (_listCache.items || []).slice();
    return;
  }
  // 角色定制是用户级资产库（与工具箱历史一样「用户级全局」），不按当前项目过滤，
  // 否则切换项目后、其它项目里创建的角色会"消失"。
  var url = '/api/character-custom/history?limit=80';
  var data = await _jsonFetch(url, { method: 'GET' });
  _items = data.items || [];
  _storeListCache();
}

async function _loadDrafts() {
  // 草稿箱同样用户级全局（不按当前项目过滤），保持和正式列表一致。
  var url = '/api/character-custom/history?lifecycle=draft&limit=80';
  try {
    var data = await _jsonFetch(url, { method: 'GET' });
    _drafts = data.items || [];
  } catch (_) {
    _drafts = _drafts || [];
  }
}

async function _loadCharacter(id) {
  var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id), { method: 'GET' });
  _selectedCharacter = data.character || null;
  _selectedCharacterId = id;
  _versions = data.versions || [];
  _selectedVersion = _versions[0] || null;
  if (_selectedVersion) {
    _form.name = _selectedVersion.fields && _selectedVersion.fields.name || '';
    _form.prompt = _selectedVersion.prompt || '';
    _form.params = Object.assign({}, _form.params, _selectedVersion.params || {});
    if (_selectedCharacter && _selectedCharacter.lifecycleStatus === 'draft') _restoreRefFromVersion(_selectedVersion);
    else _ref = null;
  } else {
    _ref = null;
  }
  _view = _selectedCharacter && _selectedCharacter.lifecycleStatus === 'draft' ? 'draftEditor' : 'confirmedEditor';
  _render();
  _scrollEditorTop();
}

export async function refreshCharacterCustomPage(options) {
  options = options || {};
  try {
    if (!options.force && _hasRenderedView()) {
      if (_view === 'draftEditor' || _view === 'confirmedEditor') return;
      if (_view === 'list' && _listCacheFresh(_listCacheKey())) return;
    }
    if ((_view === 'draftEditor' || _view === 'confirmedEditor') && _selectedCharacterId) {
      if (!options.force && _selectedCharacter) {
        _render();
        return;
      }
      await _loadCharacter(_selectedCharacterId);
      return;
    }
    await _loadList({ force: !!options.force });
    _render();
  } catch (e) {
    _toast(e && e.message || '角色列表加载失败，请刷新页面或稍后重试', 'error');
    _render();
  }
}

function _startNew() {
  _view = 'draftEditor';
  _selectedCharacter = null;
  _selectedCharacterId = null;
  _selectedVersion = null;
  _versions = [];
  _ref = null;
  _refUploading = false;
  _form = {
    name: '',
    prompt: '',
    params: { entityType: 'auto', gender: 'auto', ageRange: 'auto', isCrowd: false, crowdSize: '' },
  };
  _render();
  _scrollEditorTop();
  _loadDrafts().then(function () { if (_view === 'draftEditor') _render(); }).catch(function () {});
}

function _syncFormFromDom() {
  var prompt = $('characterPromptInput');
  if (prompt) _form.prompt = prompt.value;
  var name = $('characterNameInput');
  if (name) _form.name = name.value;
  var crowdSize = $('characterCrowdSizeInput');
  if (crowdSize) _form.params.crowdSize = crowdSize.value;
}

function _updateCharacterFieldCounter(input) {
  if (!input) return;
  var key = input.getAttribute('data-character-counter-source') || '';
  var max = Number(input.getAttribute('data-character-counter-max') || 0);
  var counter = key && document.querySelector('[data-character-counter="' + key + '"]');
  if (!counter || !max) return;
  counter.textContent = String(input.value || '').length + '/' + max;
}

async function _uploadReference(file) {
  var fd = new FormData();
  fd.append('file', file);
  var projectId = _projectId();
  if (projectId) fd.append('projectId', projectId);
  var data = await apiUpload('/api/edit/upload-media', fd);
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

function _readConfirmedFieldsFromDom() {
  var fields = Object.assign({}, _currentFields());
  try {
    document.querySelectorAll('[data-character-field]').forEach(function (el) {
      var key = el.getAttribute('data-character-field') || '';
      if (key) fields[key] = el.value || '';
    });
    document.querySelectorAll('[data-character-field-bool]').forEach(function (el) {
      var key = el.getAttribute('data-character-field-bool') || '';
      if (key) fields[key] = !!el.value;
    });
    var tagsInput = document.querySelector('[data-character-tags-field]');
    if (tagsInput) {
      fields.tags = String(tagsInput.value || '')
        .split(/[,，、/\n]/)
        .map(function (item) { return item.trim(); })
        .filter(Boolean)
        .slice(0, 8);
    }
  } catch (_) {}
  return fields;
}

async function _saveConfirmedFields(fields) {
  if (!_selectedCharacterId) throw new Error('没有找到要保存的角色');
  var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(_selectedCharacterId), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields || _readConfirmedFieldsFromDom() }),
  });
  if (data.version) {
    _selectedVersion = data.version;
    _versions = (_versions || []).map(function (item) { return item.id === data.version.id ? data.version : item; });
    _invalidateListCache();
  }
  return data;
}

async function _confirmDraft() {
  if (_busy || !_selectedCharacterId || !_selectedVersion) return;
  if (!_isConfirmableVersion(_selectedVersion)) throw new Error('请先选择一个生成成功的角色版本');
  _syncFormFromDom();
  _setBusy(true);
  _render();
  try {
    await _jsonFetch('/api/character-custom/drafts/' + encodeURIComponent(_selectedCharacterId) + '/confirm', {
      method: 'POST',
      body: JSON.stringify({ versionId: _selectedVersion.id, name: String(_form.name || '').trim() }),
    });
    _toast('角色已添加', 'ok');
    _selectedCharacter = null;
    _selectedCharacterId = null;
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
  _selectedCharacter = null;
  _selectedCharacterId = null;
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
  await _jsonFetch('/api/character-custom/drafts/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function () {});
  if (id === _selectedCharacterId) {
    _selectedCharacter = null;
    _selectedCharacterId = null;
    _selectedVersion = null;
    _versions = [];
    _ref = null;
  }
  await _loadDrafts();
  _render();
}

async function _regenerateConfirmedEditor() {
  if (_busy || !_selectedCharacterId) return;
  var fields = _readConfirmedFieldsFromDom();
  _setBusy(true);
  _render();
  try {
    await _saveConfirmedFields(fields);
    var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(_selectedCharacterId) + '/regenerate', {
      method: 'POST',
      body: JSON.stringify({ fields: fields }),
      timeoutMs: 600000,
    });
    await _loadCharacter(_selectedCharacterId);
    if (data.ok === false) {
      _toast((data.error || '这次角色没有生成成功') + '，当前角色仍保留上一版', 'warn');
      return;
    }
    _toast(data.referenceStatus === 'degraded' ? '角色已重新生成，但参考切片采用兜底切分' : '角色已重新生成', data.referenceStatus === 'degraded' ? 'warn' : 'ok');
  } finally {
    _setBusy(false);
    _render();
    _scrollPreviewIntoView();
  }
}

async function _saveCardDescription(id, text) {
  var item = (_items || []).find(function (candidate) { return candidate && candidate.id === id; });
  if (!item) throw new Error('没有找到要保存的角色');
  var fields = Object.assign({}, item.current || {});
  Object.assign(fields, _parseDescPatch(text, fields));
  var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify({ fields: fields }),
  });
  if (data.version) {
    item.currentVersion = data.version;
    item.current = data.version.fields || item.current;
    item.title = item.current.name || item.title;
    _storeListCache();
  }
  return data;
}

async function _generate() {
  if (_busy) return;
  if (_refUploading) throw new Error('参考图仍在上传，请上传完成后再生成');
  _syncFormFromDom();
  if (!String(_form.prompt || '').trim() && !_ref) throw new Error('请先填写角色描述，或上传一张参考图');
  _setBusy(true);
  _render();
  var revealPreview = false;
  try {
    var data = await _jsonFetch('/api/character-custom/generate', {
      method: 'POST',
      body: JSON.stringify({
        draft: true,
        projectId: _projectId() || null,
        name: String(_form.name || '').trim(),
        prompt: _form.prompt || '',
        params: _form.params,
        mediaId: _ref && _ref.refId || '',
      }),
      timeoutMs: 600000,
    });
    _selectedCharacterId = data.characterId;
    await _loadDrafts();
    await _loadCharacter(_selectedCharacterId);
    revealPreview = true;
    if (data.ok === false) {
      _toast((data.error || '这次角色没有生成成功') + '，本次尝试已存入历史记录', 'warn');
      return;
    }
    _toast(data.referenceStatus === 'failed' ? '角色图已生成，但参考切片自动裁切没成功，可重新生成试试' : '角色生成完成', data.referenceStatus === 'failed' ? 'warn' : 'ok');
  } finally {
    _setBusy(false);
    _render();
    if (revealPreview) _scrollPreviewIntoView();
  }
}

async function _regenerateCard(id) {
  id = String(id || '').trim();
  if (!id || _busy) return;
  _setBusy(true);
  _regeneratingCardId = id;
  _render();
  try {
    var data = await _jsonFetch('/api/character-custom/items/' + encodeURIComponent(id) + '/regenerate', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 600000,
    });
    if (data.ok === false) {
      await _loadList({ force: true });
      _toast((data.error || '这次角色没有生成成功') + '，当前角色仍保留上一版', 'warn');
      return;
    }
    await _loadList({ force: true });
    _toast(data.referenceStatus === 'degraded' ? '角色已重新生成，但参考切片采用兜底切分' : '角色已重新生成', data.referenceStatus === 'degraded' ? 'warn' : 'ok');
  } finally {
    _setBusy(false);
    _regeneratingCardId = null;
    _render();
  }
}

export function _initCharacterCustomEvents() {
  if (_wired) return;
  _wired = true;
  window.addEventListener('resize', _scheduleGenerationFit);
  document.addEventListener('click', function (ev) {
    var activeNameInput = document.querySelector('[data-character-name-input]:not(.hidden)');
    if (activeNameInput) {
      var activeWrap = activeNameInput.closest('[data-character-name-wrap]');
      if (activeWrap && !activeWrap.contains(ev.target)) {
        _finishCardNameEdit(activeNameInput);
        return;
      }
    }
    var zoom = ev.target.closest('[data-character-zoom]');
    if (zoom) {
      var url = zoom.getAttribute('data-character-zoom') || '';
      _openZoom(url, '角色设定图');
      return;
    }
    var newBtn = ev.target.closest('[data-character-new]');
    if (newBtn) { _startNew(); return; }
    var draftDel = ev.target.closest('[data-character-draft-delete]');
    if (draftDel) {
      _deleteDraft(draftDel.getAttribute('data-character-draft-delete') || '').catch(function (e) {
        _toast(e && e.message || '删除草稿失败，请稍后重试', 'error');
      });
      return;
    }
    var draftOpen = ev.target.closest('[data-character-draft-open]');
    if (draftOpen) {
      var draftOpenId = draftOpen.getAttribute('data-character-draft-open') || '';
      if (draftOpenId) _loadCharacter(draftOpenId);
      return;
    }
    var menuBtn = ev.target.closest('[data-character-menu]');
    if (menuBtn) {
      var menuId = menuBtn.getAttribute('data-character-menu') || '';
      _showCharacterCardMenu(menuBtn, menuId);
      return;
    }
    var editCard = ev.target.closest('[data-character-edit-card]');
    if (editCard) {
      var editId = editCard.getAttribute('data-character-edit-card') || '';
      _openCardDescriptionEditor(editId);
      return;
    }
    var editName = ev.target.closest('[data-character-name-edit]');
    if (editName) {
      _openCardNameEditor(editName.getAttribute('data-character-name-edit') || '');
      return;
    }
    var editMode = ev.target.closest('[data-character-edit-mode]');
    if (editMode) {
      _editCharacterMode(editMode.getAttribute('data-character-edit-mode') || '');
      return;
    }
    var editCrowd = ev.target.closest('[data-character-edit-crowd]');
    if (editCrowd) {
      _editCharacterCrowd(editCrowd.getAttribute('data-character-edit-crowd') || '');
      return;
    }
    var addTag = ev.target.closest('[data-character-add-tag]');
    if (addTag) {
      _addCharacterTag(addTag.getAttribute('data-character-add-tag') || '');
      return;
    }
    if (ev.target.closest('[data-character-back]')) {
      _backToList().catch(function (e) {
        _toast(e && e.message || '返回失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-character-confirm]')) {
      _confirmDraft().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '确认添加失败，请重新生成后再试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-character-save-fields]')) {
      _saveConfirmedFields().then(function () {
        _toast('角色字段已保存', 'ok');
        _render();
      }).catch(function (e) {
        _toast(e && e.message || '字段保存失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-character-editor-regenerate]')) {
      _regenerateConfirmedEditor().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '角色重新生成失败，请稍后重试', 'error');
      });
      return;
    }
    var descText = ev.target.closest('[data-character-desc-text]');
    if (descText) {
      var descId = descText.getAttribute('data-character-desc-text') || '';
      var wrap = descId && document.querySelector('[data-character-desc-wrap="' + descId + '"]');
      var edit = wrap && wrap.querySelector('[data-character-desc-edit]');
      if (edit) {
        descText.classList.add('hidden');
        edit.classList.remove('hidden');
        edit.focus();
        try { edit.setSelectionRange(edit.value.length, edit.value.length); } catch (_) {}
      }
      return;
    }
    var regen = ev.target.closest('[data-character-card-regenerate]');
    if (regen) {
      var regenId = regen.getAttribute('data-character-card-regenerate') || '';
      _regenerateCard(regenId).catch(function (e) {
        _setBusy(false);
        _regeneratingCardId = null;
        _render();
        _toast(e && e.message || '角色重新生成失败，请稍后重试', 'error');
      });
      return;
    }
    var open = ev.target.closest('[data-character-open]');
    if (open) {
      var id = open.getAttribute('data-character-open') || '';
      if (id) _loadCharacter(id);
      return;
    }
    if (ev.target.closest('[data-character-ref-upload]')) {
      if (_refUploading) return;
      var input = $('characterRefInput');
      if (input) input.click();
      return;
    }
    if (ev.target.closest('[data-character-ref-clear]')) {
      _ref = null;
      _render();
      return;
    }
    var entity = ev.target.closest('[data-character-param-entity]');
    if (entity) {
      _syncFormFromDom();
      _form.params.entityType = entity.getAttribute('data-character-param-entity') || 'auto';
      _render();
      return;
    }
    var gender = ev.target.closest('[data-character-param-gender]');
    if (gender) {
      _syncFormFromDom();
      _form.params.gender = gender.getAttribute('data-character-param-gender') || 'auto';
      _render();
      return;
    }
    var age = ev.target.closest('[data-character-param-age]');
    if (age) {
      _syncFormFromDom();
      _form.params.ageRange = age.getAttribute('data-character-param-age') || 'auto';
      _render();
      return;
    }
    var crowd = ev.target.closest('[data-character-param-crowd]');
    if (crowd) {
      _syncFormFromDom();
      _form.params.isCrowd = crowd.getAttribute('data-character-param-crowd') === '1';
      if (!_form.params.isCrowd) _form.params.crowdSize = '';
      _render();
      return;
    }
    if (ev.target.closest('[data-character-generate]')) {
      if (_busy || _refUploading) return;
      _generate().catch(function (e) {
        _setBusy(false);
        _render();
        _toast(e && e.message || '角色生成失败，请稍后重试', 'error');
      });
      return;
    }
    var versionBtn = ev.target.closest('[data-character-version]');
    if (versionBtn) {
      var vid = versionBtn.getAttribute('data-character-version');
      _selectedVersion = (_versions || []).find(function (item) { return item.id === vid; }) || _selectedVersion;
      if (_selectedVersion) {
        _form.name = _selectedVersion.fields && _selectedVersion.fields.name || '';
        _form.prompt = _selectedVersion.prompt || '';
        _form.params = Object.assign({}, _form.params, _selectedVersion.params || {});
        if (_selectedCharacter && _selectedCharacter.lifecycleStatus === 'draft') _restoreRefFromVersion(_selectedVersion);
      }
      _render();
      _scrollPreviewIntoView();
      return;
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'characterRefInput') {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      _refUploading = true;
      _render();
      _uploadReference(file).then(function () {
        _render();
        _toast('参考图已上传', 'ok');
      }).catch(function (e) {
        _toast(e && e.message || '参考图上传失败，请重试', 'error');
      }).finally(function () {
        _refUploading = false;
        try { ev.target.value = ''; } catch (_) {}
        _render();
      });
    }
  });
  document.addEventListener('input', function (ev) {
    var counterField = ev.target && ev.target.closest && ev.target.closest('[data-character-counter-source]');
    if (counterField) _updateCharacterFieldCounter(counterField);
  });
  document.addEventListener('focusout', function (ev) {
    var nameInput = ev.target && ev.target.closest && ev.target.closest('[data-character-name-input]');
    if (nameInput) {
      _finishCardNameEdit(nameInput);
      return;
    }
    var descEdit = ev.target && ev.target.closest && ev.target.closest('[data-character-desc-edit]');
    if (!descEdit) return;
    var id = descEdit.getAttribute('data-character-desc-edit') || '';
    var wrap = id && document.querySelector('[data-character-desc-wrap="' + id + '"]');
    var text = wrap && wrap.querySelector('[data-character-desc-text]');
    var originalText = descEdit.defaultValue || '';
    var nextText = descEdit.value || '';
    descEdit.classList.add('hidden');
    if (text) {
      text.textContent = nextText || '暂无角色描述';
      text.classList.remove('hidden');
    }
    // 没有改动就退出：不触发保存，也不弹"已保存"（对齐资产页角色卡行为）
    if (nextText.trim() === originalText.trim()) return;
    _saveCardDescription(id, nextText).then(function () {
      _toast('角色字段已保存', 'ok');
    }).catch(function (e) {
      _toast(e && e.message || '字段保存失败，请稍后重试', 'error');
      refreshCharacterCustomPage();
    });
  });
  document.addEventListener('keydown', function (ev) {
    var nameInput = ev.target && ev.target.closest && ev.target.closest('[data-character-name-input]');
    if (!nameInput) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      _finishCardNameEdit(nameInput);
    } else if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      nameInput.setAttribute('data-character-name-cancel', '1');
      _finishCardNameEdit(nameInput);
    }
  });
}
