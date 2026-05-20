import { $, escapeHtml, checkAuth, fetchAssetSignedUrl } from './utils.js';

var _ctx = {};
var _wired = false;
var _activeView = 'home';
var _activeTool = 'image';
var _history = { image: [], video: [] };
var _cursor = { image: null, video: null };
var _selected = null;
var _blobUrlCache = new Map();
var _busy = false;
var _pollTimers = { video: null };
var _polling = { video: false };
var _imageForm = { mode: 'text_to_image', ratio: '1:1', count: 1, refs: [], prompt: '' };
var _videoForm = {
  mode: 'image_to_video',
  ratio: '9:16',
  resolution: '720p',
  cameraMotion: '无',
  specialShot: '无',
  firstRef: null,
  tailRef: null,
  prompt: '',
  cameraMotionDescription: '',
};

export function initToolbox(ctx) {
  _ctx = ctx || {};
}

function _toast(msg, type) {
  if (_ctx.showToast) _ctx.showToast(msg, type || 'info');
}

function _authHeaders(json) {
  var h = {};
  if (json) h['Content-Type'] = 'application/json';
  var token = _ctx.getAuthToken ? _ctx.getAuthToken() : '';
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

async function _jsonFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, _authHeaders(true), opts.headers || {});
  var resp = await fetch(url, opts);
  checkAuth(resp);
  var data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) throw new Error(data.detail || data.error || ('请求失败：' + resp.status));
  return data;
}

function _toolTitle(tool) {
  return tool === 'video' ? '视频生成' : '图片生成';
}

function _toolIcon(tool) {
  return tool === 'video' ? 'movie' : 'image';
}

function _historyItemTitle(item) {
  if (!item) return '未命名';
  if (item.sourceType === 'upload') return item.result && item.result.filename ? item.result.filename : '上传素材';
  if (item.sourceType === 'enhance') return '重绘高清';
  if (item.mode === 'text_to_image') return '文生图';
  if (item.mode === 'image_to_image') return '图生图';
  if (item.mode === 'first_last_frame_video') return '首尾帧视频';
  return '图生视频';
}

function _statusLabel(item) {
  if (!item) return '';
  if (item.status === 'failed') return '生成失败';
  if (item.status === 'running') return '生成中';
  if (item.result && item.result.deleted) return '原结果已删除';
  return item.sourceType === 'upload' ? '上传' : '完成';
}

function _statusClass(item) {
  if (!item) return '';
  if (item.status === 'failed') return 'is-failed';
  if (item.status === 'running') return 'is-running';
  if (item.result && item.result.deleted) return 'is-missing';
  return 'is-done';
}

function _summarizeItems(items) {
  var list = Array.isArray(items) ? items : [];
  return list.reduce(function (acc, item) {
    acc.total += 1;
    if (item && item.status === 'completed') acc.done += 1;
    else if (item && item.status === 'failed') acc.failed += 1;
    else if (item && item.status === 'running') acc.running += 1;
    return acc;
  }, { total: 0, done: 0, failed: 0, running: 0 });
}

function _toastForImageGeneration(data) {
  var summary = _summarizeItems(data && data.items);
  if (summary.total > 0 && summary.done === 0 && summary.failed > 0) {
    _toast('图片生成失败，已记录到历史', 'error');
    return;
  }
  if (summary.failed > 0 || data.partial) {
    _toast('部分图片生成完成' + (data.error ? '：' + data.error : ''), 'warn');
    return;
  }
  _toast('图片生成完成', 'ok');
}

function _toastForVideoGeneration(item) {
  if (item && item.status === 'failed') {
    _toast('视频生成失败，已记录到历史', 'warn');
    return;
  }
  if (item && item.status === 'running') {
    _toast('视频任务已提交，可在右侧历史跟踪进度', 'ok');
    return;
  }
  _toast('视频生成完成', 'ok');
}

function _toastForEnhance(item) {
  if (item && item.status === 'failed') {
    _toast(item.errorMessage || '重绘失败，已记录到历史', 'warn');
    return;
  }
  if (item && item.status === 'running') {
    _toast('重绘任务已提交，可在右侧历史跟踪进度', 'ok');
    return;
  }
  _toast('重绘高清完成', 'ok');
}

function _homeHtml() {
  var tools = [
    { tool: 'image', icon: 'image', title: '图片生成', sub: '文生图 / 图生图', enabled: true },
    { tool: 'video', icon: 'movie', title: '视频生成', sub: '图生视频 / 首尾帧视频', enabled: true },
    { tool: 'prompt', icon: 'auto_fix_high', title: '提示词优化', sub: '敬请期待', enabled: false },
    { tool: 'breakdown', icon: 'video_settings', title: '视频拆解', sub: '敬请期待', enabled: false },
    { tool: 'audio', icon: 'graphic_eq', title: '音频生成', sub: '敬请期待', enabled: false },
  ];
  return '' +
    '<header class="toolbox-hero">' +
      '<div>' +
        '<p class="toolbox-kicker">ORIGIN TOOLBOX</p>' +
        '<h1>工具箱</h1>' +
      '</div>' +
    '</header>' +
    '<section class="toolbox-home-grid">' +
      tools.map(function (t) {
        return '<button type="button" class="toolbox-entry ' + (t.enabled ? '' : 'is-disabled') + '" ' +
          (t.enabled ? 'data-toolbox-open="' + t.tool + '"' : 'disabled') + '>' +
          '<span class="material-symbols-outlined">' + t.icon + '</span>' +
          '<strong>' + escapeHtml(t.title) + '</strong>' +
          '<small>' + escapeHtml(t.sub) + '</small>' +
          (!t.enabled ? '<em>敬请期待</em>' : '') +
        '</button>';
      }).join('') +
    '</section>';
}

function _modeTabsHtml(tool) {
  if (tool === 'video') {
    return '<div class="toolbox-tabs">' +
      '<button type="button" class="' + (_videoForm.mode === 'image_to_video' ? 'is-active' : '') + '" data-toolbox-video-mode="image_to_video">图生视频</button>' +
      '<button type="button" class="' + (_videoForm.mode === 'first_last_frame_video' ? 'is-active' : '') + '" data-toolbox-video-mode="first_last_frame_video">首尾帧视频</button>' +
    '</div>';
  }
  return '<div class="toolbox-tabs">' +
    '<button type="button" class="' + (_imageForm.mode === 'text_to_image' ? 'is-active' : '') + '" data-toolbox-image-mode="text_to_image">文生图</button>' +
    '<button type="button" class="' + (_imageForm.mode === 'image_to_image' ? 'is-active' : '') + '" data-toolbox-image-mode="image_to_image">图生图</button>' +
  '</div>';
}

function _ratioButtons(current, values, attr) {
  return '<div class="toolbox-choice-row">' + values.map(function (value) {
    return '<button type="button" class="' + (current === value ? 'is-active' : '') + '" ' + attr + '="' + value + '">' + value + '</button>';
  }).join('') + '</div>';
}

function _refSummary(ref, fallback) {
  return ref && ref.name ? ref.name : fallback;
}

function _revokeRefPreview(ref) {
  if (ref && ref.localPreviewUrl) {
    try { URL.revokeObjectURL(ref.localPreviewUrl); } catch (_) {}
  }
}

function _refThumbHtml(ref, fallback, uploadAttr, clearAttr) {
  if (!ref || !ref.refId) {
    return '<button type="button" class="toolbox-ref-upload" ' + uploadAttr + '>' +
      '<span class="material-symbols-outlined">add_photo_alternate</span>' +
      '<span class="toolbox-ref-label">' + escapeHtml(fallback) + '</span>' +
    '</button>';
  }
  var src = ref.localPreviewUrl || '';
  return '<div class="toolbox-ref-chip">' +
    '<button type="button" class="toolbox-ref-chip-main" ' + uploadAttr + ' title="点击更换">' +
      (src
        ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(ref.name || '参考图') + '" />'
        : '<span class="material-symbols-outlined">image</span>') +
      '<span class="toolbox-ref-chip-name">' + escapeHtml(ref.name || '参考图') + '</span>' +
    '</button>' +
    '<button type="button" class="toolbox-ref-chip-remove" ' + clearAttr + ' title="移除">' +
      '<span class="material-symbols-outlined">close</span>' +
    '</button>' +
  '</div>';
}

function _imageFormHtml() {
  return '' +
    '<label class="toolbox-field"><span>提示词</span><textarea id="toolboxImagePrompt" rows="5" placeholder="描述你想生成的画面">' + escapeHtml(_imageForm.prompt || '') + '</textarea></label>' +
    (_imageForm.mode === 'image_to_image'
      ? '<div class="toolbox-field"><span>参考图</span>' +
        _refThumbHtml(_imageForm.refs[0], '上传 1 张参考图', 'data-toolbox-ref-upload="image-reference"', 'data-toolbox-ref-clear="image-reference"') +
        '<input type="file" id="toolboxImageRefInput" accept="image/*" hidden /></div>'
      : '') +
    '<div class="toolbox-field"><span>图片比例</span>' + _ratioButtons(_imageForm.ratio, ['1:1', '9:16', '16:9'], 'data-toolbox-image-ratio') + '</div>' +
    '<label class="toolbox-field"><span>生成数量</span><select id="toolboxImageCount">' +
      [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + (_imageForm.count === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
    '</select></label>' +
    '<button type="button" class="toolbox-generate" data-toolbox-generate="image" ' + (_busy ? 'disabled' : '') + '>' +
      '<span class="material-symbols-outlined">auto_awesome</span>' + (_busy && _activeTool === 'image' ? '生成中' : '生成图片') +
    '</button>';
}

function _selectOptions(values, current) {
  return values.map(function (value) {
    return '<option value="' + escapeHtml(value) + '"' + (current === value ? ' selected' : '') + '>' + escapeHtml(value) + '</option>';
  }).join('');
}

function _videoFormHtml() {
  var motions = ['无','固定机位','跟拍','环绕','变焦拉近','变焦拉远','镜头左摇','镜头右摇','镜头上仰','镜头下俯','镜头前移','镜头后移','镜头左移','镜头右移','摇臂上升','摇臂下降','无人机航拍','360°横滚'];
  var shots = ['无','希区柯克变焦','延时摄影','急推镜头','急拉镜头','快速甩镜','子弹时间','FPV穿梭','微距特写','第一人称','慢镜头','探针镜头','旋转倾斜镜头'];
  return '' +
    '<div class="toolbox-field"><span>首帧图</span>' +
      _refThumbHtml(_videoForm.firstRef, '上传首帧图', 'data-toolbox-ref-upload="video-first"', 'data-toolbox-ref-clear="video-first"') +
      '<input type="file" id="toolboxVideoFirstInput" accept="image/*" hidden /></div>' +
    (_videoForm.mode === 'first_last_frame_video'
      ? '<div class="toolbox-field"><span>尾帧图</span>' +
        _refThumbHtml(_videoForm.tailRef, '上传尾帧图', 'data-toolbox-ref-upload="video-tail"', 'data-toolbox-ref-clear="video-tail"') +
        '<input type="file" id="toolboxVideoTailInput" accept="image/*" hidden /></div>'
      : '') +
    '<label class="toolbox-field"><span>提示词</span><textarea id="toolboxVideoPrompt" rows="4" placeholder="描述视频内容和主体动作">' + escapeHtml(_videoForm.prompt || '') + '</textarea></label>' +
    '<label class="toolbox-field"><span>镜头运动方式</span><select id="toolboxCameraMotion">' + _selectOptions(motions, _videoForm.cameraMotion) + '</select></label>' +
    '<label class="toolbox-field"><span>镜头运动描述</span><input id="toolboxCameraMotionDesc" type="text" placeholder="可选，补充运动节奏和路径" value="' + escapeHtml(_videoForm.cameraMotionDescription || '') + '" /></label>' +
    '<label class="toolbox-field"><span>特殊拍摄手法</span><select id="toolboxSpecialShot">' + _selectOptions(shots, _videoForm.specialShot) + '</select></label>' +
    '<div class="toolbox-field"><span>画面比例</span>' + _ratioButtons(_videoForm.ratio, ['9:16', '16:9', '1:1'], 'data-toolbox-video-ratio') + '</div>' +
    '<label class="toolbox-field"><span>分辨率</span><select id="toolboxVideoResolution">' +
      '<option value="720p"' + (_videoForm.resolution === '720p' ? ' selected' : '') + '>720p</option>' +
      '<option value="1080p"' + (_videoForm.resolution === '1080p' ? ' selected' : '') + '>1080p</option>' +
    '</select></label>' +
    '<button type="button" class="toolbox-generate" data-toolbox-generate="video" ' + (_busy ? 'disabled' : '') + '>' +
      '<span class="material-symbols-outlined">movie_creation</span>' + (_busy && _activeTool === 'video' ? '生成中' : '生成视频') +
    '</button>';
}

function _toolHtml(tool) {
  return '' +
    '<header class="toolbox-tool-head">' +
      '<button type="button" class="toolbox-back" data-toolbox-back title="返回工具箱">' +
        '<span class="material-symbols-outlined">arrow_back</span>' +
      '</button>' +
      '<div>' +
        '<p class="toolbox-kicker">TOOLBOX</p>' +
        '<h1>' + _toolTitle(tool) + '</h1>' +
      '</div>' +
    '</header>' +
    '<div class="toolbox-workbench" data-toolbox-tool="' + tool + '">' +
      '<section class="toolbox-panel toolbox-config">' +
        _modeTabsHtml(tool) +
        '<div class="toolbox-form">' + (tool === 'video' ? _videoFormHtml() : _imageFormHtml()) + '</div>' +
      '</section>' +
      '<section class="toolbox-panel toolbox-preview">' +
        '<div id="toolboxPreviewArea" class="toolbox-preview-area">' + _previewHtml(_selected) + '</div>' +
      '</section>' +
      '<aside class="toolbox-panel toolbox-history">' +
        '<div class="toolbox-history-head">' +
          '<div>' +
            '<strong>历史记录</strong>' +
            '<small>用户级全局</small>' +
          '</div>' +
          '<button type="button" class="toolbox-upload-btn" data-toolbox-upload title="上传">' +
            '<span class="material-symbols-outlined">upload</span>' +
          '</button>' +
          '<input type="file" id="toolboxUploadInput" ' + (tool === 'video' ? 'accept="video/*"' : 'accept="image/*"') + ' hidden />' +
        '</div>' +
        '<div id="toolboxHistoryList" class="toolbox-history-list">' + _historyHtml(tool) + '</div>' +
        '<button type="button" id="toolboxLoadMore" class="toolbox-load-more" ' + (_cursor[tool] ? '' : 'hidden') + '>加载更多</button>' +
      '</aside>' +
    '</div>';
}

function _historyHtml(tool) {
  var list = _history[tool] || [];
  if (!list.length) {
    return '<div class="toolbox-empty-history">' +
      '<span class="material-symbols-outlined">history</span>' +
      '<p>暂无历史</p>' +
    '</div>';
  }
  return list.map(function (item) {
    var selected = _selected && _selected.id === item.id;
    return '<button type="button" class="toolbox-history-card ' + (selected ? 'is-selected ' : '') + _statusClass(item) + '" data-toolbox-history-id="' + escapeHtml(item.id) + '">' +
      '<span class="toolbox-history-thumb">' + _thumbHtml(item) + '</span>' +
      '<span class="toolbox-history-copy">' +
        '<strong>' + escapeHtml(_historyItemTitle(item)) + '</strong>' +
        '<small>' + escapeHtml(_statusLabel(item)) + '</small>' +
      '</span>' +
    '</button>';
  }).join('');
}

function _thumbHtml(item) {
  if (!item) return '<span class="material-symbols-outlined">draft</span>';
  if (item.status === 'failed') return '<span class="material-symbols-outlined">error</span>';
  if (item.toolType === 'video') return '<span class="material-symbols-outlined">movie</span>';
  return '<span class="material-symbols-outlined">image</span>';
}

function _hasRunning(tool) {
  return (_history[tool] || []).some(function (item) { return item.status === 'running'; });
}

function _syncSelectedFromHistory(tool) {
  if (!_history[tool] || !_history[tool].length) {
    if (_selected && _selected.toolType === tool) _selected = null;
    return;
  }
  if (!_selected) {
    _selected = _history[tool][0];
    return;
  }
  if (_selected.toolType && _selected.toolType !== tool) return;
  var updated = _history[tool].find(function (item) { return item.id === _selected.id; });
  if (updated) _selected = updated;
}

function _stopVideoStatusPolling() {
  if (!_pollTimers.video) return;
  window.clearInterval(_pollTimers.video);
  _pollTimers.video = null;
  _polling.video = false;
}

async function _pollVideoHistoryOnce() {
  if (_polling.video) return;
  _polling.video = true;
  try {
    await _loadHistory('video', false);
    if (_activeView === 'video') _render();
    if (!_hasRunning('video')) _stopVideoStatusPolling();
  } catch (e) {
    console.warn('[Toolbox] video status polling failed:', e);
  } finally {
    _polling.video = false;
  }
}

function _startVideoStatusPolling() {
  if (_pollTimers.video) return;
  _pollTimers.video = window.setInterval(function () {
    _pollVideoHistoryOnce();
  }, 6000);
}

function _previewHtml(item) {
  if (!item) {
    return '<div class="toolbox-preview-empty">' +
      '<span class="material-symbols-outlined">auto_awesome</span>' +
      '<p>生成结果会显示在这里</p>' +
      '<small>点击历史项或右上角 ↑ 上传素材后也会在这里预览</small>' +
    '</div>';
  }
  if (item.status === 'failed') {
    return '<div class="toolbox-preview-empty is-error">' +
      '<span class="material-symbols-outlined">error</span>' +
      '<p>' + escapeHtml(item.errorMessage || '生成失败') + '</p>' +
    '</div>';
  }
  if (item.result && item.result.deleted) {
    return '<div class="toolbox-preview-empty is-error">' +
      '<span class="material-symbols-outlined">broken_image</span>' +
      '<p>原结果已删除</p>' +
    '</div>';
  }
  if (item.status === 'running') {
    return '<div class="toolbox-preview-empty">' +
      '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>' +
      '<p>生成中</p>' +
    '</div>';
  }
  return '<div class="toolbox-preview-empty">' +
    '<span class="material-symbols-outlined">hourglass_empty</span>' +
    '<p>正在加载预览</p>' +
  '</div>';
}

async function _resolveDisplayUrl(item) {
  if (!item || !item.result || !item.result.exists) return '';
  if (item.result.type === 'image') {
    var id = item.result.id || '';
    return id ? fetchAssetSignedUrl(id) : item.result.url;
  }
  if (item.result.type === 'video') return item.result.url || item.result.protectedUrl || '';
  if (item.result.type === 'upload') {
    var uploadUrl = item.result.url || '';
    if (!uploadUrl) return '';
    if (_blobUrlCache.has(uploadUrl)) return _blobUrlCache.get(uploadUrl);
    var resp = await fetch(uploadUrl, { headers: _authHeaders(false) });
    checkAuth(resp);
    if (!resp.ok) return '';
    var blob = await resp.blob();
    var objectUrl = URL.createObjectURL(blob);
    _blobUrlCache.set(uploadUrl, objectUrl);
    return objectUrl;
  }
  return '';
}

function _uploadBlobCacheKey(item) {
  return item && item.result && item.result.type === 'upload' ? item.result.url || '' : '';
}

function _revokeBlobUrlsExcept(retainKey) {
  _blobUrlCache.forEach(function (objectUrl, key) {
    if (retainKey && key === retainKey) return;
    URL.revokeObjectURL(objectUrl);
    _blobUrlCache.delete(key);
  });
}

async function _renderPreviewMedia(item) {
  var area = $('toolboxPreviewArea');
  if (!area || !item || item.status !== 'completed' || !item.result || !item.result.exists) {
    _revokeBlobUrlsExcept('');
    return;
  }
  var retainKey = _uploadBlobCacheKey(item);
  var url = await _resolveDisplayUrl(item).catch(function () { return ''; });
  _revokeBlobUrlsExcept(retainKey);
  if (!url) {
    area.innerHTML = '<div class="toolbox-preview-empty is-error"><span class="material-symbols-outlined">broken_image</span><p>预览加载失败</p></div>';
    return;
  }
  var isVideo = item.toolType === 'video' || item.result.kind === 'video';
  area.innerHTML = '<div class="toolbox-media-frame">' +
    (isVideo
      ? '<video controls src="' + escapeHtml(url) + '"></video>'
      : '<img src="' + escapeHtml(url) + '" alt="工具箱结果" />') +
    '<div class="toolbox-media-actions">' +
      '<a href="' + escapeHtml(url) + '" download title="下载"><span class="material-symbols-outlined">download</span></a>' +
      (item.canEnhance ? '<button type="button" data-toolbox-enhance title="重绘高清"><span class="material-symbols-outlined">high_quality</span></button>' : '') +
      '<button type="button" data-toolbox-delete title="删除历史"><span class="material-symbols-outlined">delete</span></button>' +
    '</div>' +
  '</div>';
}

function _render() {
  var root = $('toolboxRoot');
  if (!root) return;
  root.innerHTML = _activeView === 'home' ? _homeHtml() : _toolHtml(_activeTool);
  if (_activeView === 'home') _revokeBlobUrlsExcept('');
  if (_activeView !== 'home') _renderPreviewMedia(_selected);
}

async function _loadHistory(tool, append) {
  var url = '/api/toolbox/history?tool=' + encodeURIComponent(tool) + '&limit=30';
  if (append && _cursor[tool]) url += '&cursor=' + encodeURIComponent(_cursor[tool]);
  var data = await _jsonFetch(url, { method: 'GET', headers: _authHeaders(false) });
  var items = data.items || [];
  _history[tool] = append ? (_history[tool] || []).concat(items) : items;
  _cursor[tool] = data.nextCursor || null;
  _syncSelectedFromHistory(tool);
}

export async function refreshToolboxPage() {
  if (!$('toolboxRoot')) return;
  _render();
  if (_activeView !== 'home') {
    try {
      await _loadHistory(_activeTool, false);
      if (_selected && _selected.toolType !== _activeTool) _selected = null;
      if (_activeTool === 'video' && _hasRunning('video')) _startVideoStatusPolling();
    } catch (e) {
      console.warn('[Toolbox] load history failed:', e);
    }
    _render();
  }
}

async function _uploadCurrentTool(file) {
  var fd = new FormData();
  fd.append('file', file);
  var resp = await fetch('/api/edit/upload-media', {
    method: 'POST',
    headers: _authHeaders(false),
    body: fd,
  });
  checkAuth(resp);
  var upload = await resp.json().catch(function () { return {}; });
  if (!resp.ok) throw new Error(upload.detail || upload.error || '上传失败');
  var created = await _jsonFetch('/api/toolbox/items', {
    method: 'POST',
    body: JSON.stringify({ uploadId: upload.mediaId }),
  });
  _selected = created.item || null;
  await _loadHistory(_activeTool, false);
  if (_selected) {
    _history[_activeTool] = [_selected].concat((_history[_activeTool] || []).filter(function (item) { return item.id !== _selected.id; }));
  }
  _render();
}

async function _uploadReference(file) {
  var fd = new FormData();
  fd.append('file', file);
  var resp = await fetch('/api/edit/upload-media', {
    method: 'POST',
    headers: _authHeaders(false),
    body: fd,
  });
  checkAuth(resp);
  var upload = await resp.json().catch(function () { return {}; });
  if (!resp.ok) throw new Error(upload.detail || upload.error || '上传失败');
  if (upload.kind !== 'image') throw new Error('参考素材必须是图片');
  var localPreviewUrl = '';
  try { localPreviewUrl = URL.createObjectURL(file); } catch (_) {}
  return {
    role: 'reference',
    refType: 'upload',
    refId: upload.mediaId,
    mime: file.type || upload.mime || '',
    name: file.name || upload.filename || '参考图',
    urlAtCreation: upload.url || '',
    localPreviewUrl: localPreviewUrl,
  };
}

function _syncImageFormFromDom() {
  var prompt = $('toolboxImagePrompt');
  var count = $('toolboxImageCount');
  if (prompt) _imageForm.prompt = prompt.value;
  _imageForm.count = Math.max(1, Math.min(4, Number(count && count.value || 1)));
}

function _syncVideoFormFromDom() {
  var motion = $('toolboxCameraMotion');
  var special = $('toolboxSpecialShot');
  var resolution = $('toolboxVideoResolution');
  var desc = $('toolboxCameraMotionDesc');
  var prompt = $('toolboxVideoPrompt');
  if (prompt) _videoForm.prompt = prompt.value;
  _videoForm.cameraMotion = motion ? motion.value : _videoForm.cameraMotion;
  _videoForm.specialShot = special ? special.value : _videoForm.specialShot;
  _videoForm.resolution = resolution ? resolution.value : _videoForm.resolution;
  _videoForm.cameraMotionDescription = desc ? desc.value.trim() : '';
}

async function _generateImage() {
  _syncImageFormFromDom();
  var prompt = String(_imageForm.prompt || '').trim();
  if (!prompt) throw new Error('请输入提示词');
  if (_imageForm.mode === 'image_to_image' && !_imageForm.refs.length) throw new Error('请先上传参考图');
  _busy = true;
  _render();
  try {
    var data = await _jsonFetch('/api/toolbox/image/generate', {
      method: 'POST',
      body: JSON.stringify({
        mode: _imageForm.mode,
        prompt: prompt,
        params: { ratio: _imageForm.ratio, count: _imageForm.count },
        inputRefs: _imageForm.mode === 'image_to_image' ? _imageForm.refs : [],
      }),
    });
    _selected = data.items && data.items[0] || null;
    await _loadHistory('image', false);
    if (_selected) _history.image = [_selected].concat((_history.image || []).filter(function (item) { return item.id !== _selected.id; }));
    _toastForImageGeneration(data);
  } finally {
    _busy = false;
    _render();
  }
}

async function _generateVideo() {
  _syncVideoFormFromDom();
  var prompt = String(_videoForm.prompt || '').trim();
  if (!prompt) throw new Error('请输入提示词');
  if (!_videoForm.firstRef) throw new Error('请先上传首帧图');
  if (_videoForm.mode === 'first_last_frame_video' && !_videoForm.tailRef) throw new Error('请先上传尾帧图');
  var refs = [Object.assign({}, _videoForm.firstRef, { role: 'first_frame' })];
  if (_videoForm.mode === 'first_last_frame_video') refs.push(Object.assign({}, _videoForm.tailRef, { role: 'tail_frame' }));
  _busy = true;
  _render();
  _startVideoStatusPolling();
  try {
    var data = await _jsonFetch('/api/toolbox/video/generate', {
      method: 'POST',
      body: JSON.stringify({
        mode: _videoForm.mode,
        prompt: prompt,
        params: {
          ratio: _videoForm.ratio,
          resolution: _videoForm.resolution,
          cameraMotion: _videoForm.cameraMotion,
          cameraMotionDescription: _videoForm.cameraMotionDescription || '',
          specialShot: _videoForm.specialShot,
          durationSec: 4,
        },
        inputRefs: refs,
      }),
    });
    _selected = data.item || null;
    await _loadHistory('video', false);
    if (_selected) _history.video = [_selected].concat((_history.video || []).filter(function (item) { return item.id !== _selected.id; }));
    if (_hasRunning('video')) _startVideoStatusPolling();
    else _stopVideoStatusPolling();
    _toastForVideoGeneration(_selected);
  } finally {
    _busy = false;
    _render();
  }
}

async function _enhanceSelected() {
  if (!_selected) return;
  var isVideoEnhance = _selected.toolType === 'video';
  _busy = true;
  _render();
  if (isVideoEnhance) _startVideoStatusPolling();
  try {
    var data = await _jsonFetch('/api/toolbox/items/' + encodeURIComponent(_selected.id) + '/enhance', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    _selected = data.item || _selected;
    await _loadHistory(_activeTool, false);
    if (_selected) _history[_activeTool] = [_selected].concat((_history[_activeTool] || []).filter(function (item) { return item.id !== _selected.id; }));
    if (isVideoEnhance && _hasRunning('video')) _startVideoStatusPolling();
    else if (isVideoEnhance) _stopVideoStatusPolling();
    _toastForEnhance(_selected);
  } finally {
    _busy = false;
    _render();
  }
}

async function _deleteSelected() {
  if (!_selected) return;
  var id = _selected.id;
  await _jsonFetch('/api/toolbox/items/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({}) });
  _history[_activeTool] = (_history[_activeTool] || []).filter(function (item) { return item.id !== id; });
  _selected = _history[_activeTool][0] || null;
  _render();
  _toast('历史已删除', 'ok');
}

export function _initToolboxEvents() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('click', function (ev) {
    var open = ev.target.closest('[data-toolbox-open]');
    if (open) {
      _activeTool = open.getAttribute('data-toolbox-open') === 'video' ? 'video' : 'image';
      _activeView = _activeTool;
      _selected = null;
      refreshToolboxPage();
      return;
    }
    if (ev.target.closest('[data-toolbox-back]')) {
      _activeView = 'home';
      _selected = null;
      _render();
      return;
    }
    if (ev.target.closest('[data-toolbox-upload]')) {
      var input = $('toolboxUploadInput');
      if (input) input.click();
      return;
    }
    var imageModeBtn = ev.target.closest('[data-toolbox-image-mode]');
    if (imageModeBtn) {
      _syncImageFormFromDom();
      _imageForm.mode = imageModeBtn.getAttribute('data-toolbox-image-mode') || 'text_to_image';
      _render();
      return;
    }
    var videoModeBtn = ev.target.closest('[data-toolbox-video-mode]');
    if (videoModeBtn) {
      _syncVideoFormFromDom();
      _videoForm.mode = videoModeBtn.getAttribute('data-toolbox-video-mode') || 'image_to_video';
      _render();
      return;
    }
    var imageRatioBtn = ev.target.closest('[data-toolbox-image-ratio]');
    if (imageRatioBtn) {
      _syncImageFormFromDom();
      _imageForm.ratio = imageRatioBtn.getAttribute('data-toolbox-image-ratio') || '1:1';
      _render();
      return;
    }
    var videoRatioBtn = ev.target.closest('[data-toolbox-video-ratio]');
    if (videoRatioBtn) {
      _syncVideoFormFromDom();
      _videoForm.ratio = videoRatioBtn.getAttribute('data-toolbox-video-ratio') || '9:16';
      _render();
      return;
    }
    var refClear = ev.target.closest('[data-toolbox-ref-clear]');
    if (refClear) {
      var clearTarget = refClear.getAttribute('data-toolbox-ref-clear');
      if (clearTarget === 'image-reference') {
        _revokeRefPreview(_imageForm.refs[0]);
        _imageForm.refs = [];
      } else if (clearTarget === 'video-first') {
        _revokeRefPreview(_videoForm.firstRef);
        _videoForm.firstRef = null;
      } else if (clearTarget === 'video-tail') {
        _revokeRefPreview(_videoForm.tailRef);
        _videoForm.tailRef = null;
      }
      _render();
      return;
    }
    var refUpload = ev.target.closest('[data-toolbox-ref-upload]');
    if (refUpload) {
      var target = refUpload.getAttribute('data-toolbox-ref-upload');
      var inputId = target === 'image-reference' ? 'toolboxImageRefInput' : target === 'video-tail' ? 'toolboxVideoTailInput' : 'toolboxVideoFirstInput';
      var refInput = $(inputId);
      if (refInput) refInput.click();
      return;
    }
    var gen = ev.target.closest('[data-toolbox-generate]');
    if (gen && !_busy) {
      var which = gen.getAttribute('data-toolbox-generate');
      (which === 'video' ? _generateVideo() : _generateImage()).catch(function (e) {
        _busy = false;
        _render();
        _toast(e.message || '生成失败', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-toolbox-enhance]') && !_busy) {
      _enhanceSelected().catch(function (e) {
        _busy = false;
        _render();
        _toast(e.message || '重绘失败', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-toolbox-delete]') && !_busy) {
      _deleteSelected().catch(function (e) { _toast(e.message || '删除失败', 'error'); });
      return;
    }
    var card = ev.target.closest('[data-toolbox-history-id]');
    if (card) {
      var id = card.getAttribute('data-toolbox-history-id');
      var found = (_history[_activeTool] || []).find(function (item) { return item.id === id; });
      if (found) {
        _selected = found;
        _render();
      }
      return;
    }
    if (ev.target && ev.target.id === 'toolboxLoadMore') {
      _loadHistory(_activeTool, true).then(_render).catch(function (e) { _toast(e.message || '加载失败', 'error'); });
    }
  });

  document.addEventListener('change', function (ev) {
    if (!ev.target) return;
    if (ev.target.id === 'toolboxImageCount') {
      _syncImageFormFromDom();
      return;
    }
    if (ev.target.id === 'toolboxCameraMotion' || ev.target.id === 'toolboxSpecialShot' || ev.target.id === 'toolboxVideoResolution') {
      _syncVideoFormFromDom();
      return;
    }
    if (ev.target.id === 'toolboxImageRefInput' || ev.target.id === 'toolboxVideoFirstInput' || ev.target.id === 'toolboxVideoTailInput') {
      var refFile = ev.target.files && ev.target.files[0];
      var refInputId = ev.target.id;
      ev.target.value = '';
      if (!refFile) return;
      _uploadReference(refFile).then(function (ref) {
        if (refInputId === 'toolboxImageRefInput') {
          _revokeRefPreview(_imageForm.refs[0]);
          _imageForm.refs = [Object.assign({}, ref, { role: 'reference' })];
        } else if (refInputId === 'toolboxVideoTailInput') {
          _revokeRefPreview(_videoForm.tailRef);
          _videoForm.tailRef = Object.assign({}, ref, { role: 'tail_frame' });
        } else {
          _revokeRefPreview(_videoForm.firstRef);
          _videoForm.firstRef = Object.assign({}, ref, { role: 'first_frame' });
        }
        _render();
        _toast('参考图已上传', 'ok');
      }).catch(function (e) { _toast(e.message || '参考图上传失败', 'error'); });
      return;
    }
    if (ev.target.id !== 'toolboxUploadInput') return;
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    _uploadCurrentTool(file)
      .then(function () { _toast('上传成功', 'ok'); })
      .catch(function (e) { _toast(e.message || '上传失败', 'error'); });
  });
}
