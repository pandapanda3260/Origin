import { $, apiRequest, apiUpload, escapeHtml, fetchAssetSignedUrl, hydrateProtectedImageElements, showConfirm } from './utils.js?v=201';

var _ctx = {};
var _wired = false;
var _activeView = 'home';
var _activeTool = 'image';
var _history = { image: [], video: [] };
var _cursor = { image: null, video: null };
var _selected = null;
var _blobUrlCache = new Map();
var _busy = { image: false, video: false };
var _notice = { image: null, video: null };
var _pollTimers = { video: null };
var _polling = { video: false };
var _previewRenderSeq = 0;
var _imageForm = { mode: 'text_to_image', ratio: '9:16', count: 1, refs: [], prompt: '' };
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

async function _jsonFetch(url, opts) {
  opts = opts || {};
  return await apiRequest(url, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: opts.headers,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    responseType: 'json',
  });
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
  if (item.sourceType === 'enhance') return '高清重绘';
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

function _isToolBusy(tool) {
  return !!_busy[tool];
}

function _setToolBusy(tool, value) {
  _busy[tool] = !!value;
}

function _isActiveToolBusy() {
  return _isToolBusy(_activeTool);
}

function _disabledAttr(disabled) {
  return disabled ? ' disabled aria-disabled="true"' : '';
}

function _lockedTitle(tool, fallback) {
  return _isToolBusy(tool) ? '生成中，请稍候' : fallback;
}

function _setToolNotice(tool, kind, title, detail) {
  if (tool !== 'image' && tool !== 'video') return;
  _notice[tool] = {
    kind: kind === 'success' || kind === 'warn' || kind === 'error' ? kind : 'running',
    title: String(title || '').trim(),
    detail: String(detail || '').trim(),
  };
}

function _clearToolNotice(tool) {
  if (tool !== 'image' && tool !== 'video') return;
  _notice[tool] = null;
}

function _noticeIcon(kind) {
  if (kind === 'success') return 'check_circle';
  if (kind === 'warn') return 'warning';
  if (kind === 'error') return 'error';
  return 'progress_activity';
}

function _noticeHtml(tool) {
  var note = _notice[tool];
  if (!note || (!note.title && !note.detail)) return '';
  return '<div class="toolbox-status-note is-' + escapeHtml(note.kind) + '">' +
    '<span class="material-symbols-outlined ' + (note.kind === 'running' ? 'toolbox-spin' : '') + '">' + _noticeIcon(note.kind) + '</span>' +
    '<div>' +
      (note.title ? '<strong>' + escapeHtml(note.title) + '</strong>' : '') +
      (note.detail ? '<p>' + escapeHtml(note.detail) + '</p>' : '') +
    '</div>' +
  '</div>';
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

// 把后端/依赖返回的原始报错（Azure moderation JSON、超时、HTTP 状态等）翻译成用户能看懂的文案。
// 已知类别→统一友好文案；明显技术噪声→返回空串，由调用处用各自兜底；已是干净中文文案→原样返回。
function _humanizeError(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (/moderation|safety|content[_ ]?policy|image_generation_user_error|safety_violation|rejected|blocked|安全审核/i.test(text)) {
    return '内容未通过安全审核（例如涉及真实人物、儿童或敏感内容），请调整提示词或参考图后重试';
  }
  if (/retry_deadline|timed?\s*out|timeout|超时|deadline/i.test(text)) {
    return '处理超时，请稍后重试';
  }
  if (/rate.?limit|too many requests|\b429\b|限流/i.test(text)) {
    return '当前生成繁忙（限流），请稍后重试';
  }
  if (/invalid svg|svg image|图片解析异常/i.test(text)) {
    return '图片解析异常，请更换图片后重试';
  }
  if (/unauthorized|\b401\b|登录已过期|未登录/i.test(text)) {
    return '登录已过期，请重新登录后重试';
  }
  // 明显技术噪声：返回空串，交给调用处用各自的兜底文案（如"上传失败""生成失败"）。
  if (/Image API|Azure|\{\s*"?error|"code"\s*:|请求失败：|fetch failed|NetworkError|TypeError|HTTP \d/i.test(text)) {
    return '';
  }
  return text;
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
    _toast(_humanizeError(item && item.errorMessage) || '高清重绘失败，已记录到历史', 'warn');
    return;
  }
  if (item && item.status === 'running') {
    _toast('重绘任务已提交，可在右侧历史跟踪进度', 'ok');
    return;
  }
  _toast('高清重绘完成', 'ok');
}

function _homeHtml() {
  var tools = [
    { tool: 'image', icon: 'image', title: '图片生成', sub: '文生图 / 图生图', enabled: true },
    { tool: 'video', icon: 'movie', title: '视频生成', sub: '图生视频 / 首尾帧视频', enabled: true },
    { tool: 'prompt', icon: 'auto_fix_high', title: '提示词优化', sub: '提示词改写', enabled: false },
    { tool: 'breakdown', icon: 'video_settings', title: '视频拆解', sub: '成片解析', enabled: false },
    { tool: 'audio', icon: 'graphic_eq', title: '音频生成', sub: '旁白 / 音效', enabled: false },
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
  var disabled = _disabledAttr(_isToolBusy(tool));
  if (tool === 'video') {
    return '<div class="toolbox-tabs">' +
      '<button type="button" class="' + (_videoForm.mode === 'image_to_video' ? 'is-active' : '') + '" data-toolbox-video-mode="image_to_video"' + disabled + '>图生视频</button>' +
      '<button type="button" class="' + (_videoForm.mode === 'first_last_frame_video' ? 'is-active' : '') + '" data-toolbox-video-mode="first_last_frame_video"' + disabled + '>首尾帧视频</button>' +
    '</div>';
  }
  return '<div class="toolbox-tabs">' +
    '<button type="button" class="' + (_imageForm.mode === 'text_to_image' ? 'is-active' : '') + '" data-toolbox-image-mode="text_to_image"' + disabled + '>文生图</button>' +
    '<button type="button" class="' + (_imageForm.mode === 'image_to_image' ? 'is-active' : '') + '" data-toolbox-image-mode="image_to_image"' + disabled + '>图生图</button>' +
  '</div>';
}

function _ratioButtons(current, values, attr, disabled) {
  var disabledAttr = _disabledAttr(disabled);
  return '<div class="toolbox-choice-row">' + values.map(function (value) {
    return '<button type="button" class="' + (current === value ? 'is-active' : '') + '" ' + attr + '="' + value + '"' + disabledAttr + '>' + value + '</button>';
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

function _refThumbHtml(ref, fallback, uploadAttr, clearAttr, disabled, tool) {
  var disabledAttr = _disabledAttr(disabled);
  var titleTool = tool || _activeTool;
  if (!ref || !ref.refId) {
    return '<button type="button" class="toolbox-ref-upload" ' + uploadAttr + disabledAttr + ' title="' + escapeHtml(_lockedTitle(titleTool, fallback)) + '">' +
      '<span class="material-symbols-outlined">add_photo_alternate</span>' +
      '<span class="toolbox-ref-label">' + escapeHtml(fallback) + '</span>' +
    '</button>';
  }
  // 刚上传有本地 blob 预览；从历史恢复时没有，回退到受保护的 /api/edit/media（由 hydrate 带 token 加载）。
  var src = ref.localPreviewUrl || ref.urlAtCreation || (ref.refId ? '/api/edit/media/' + encodeURIComponent(ref.refId) : '');
  return '<div class="toolbox-ref-chip">' +
    '<button type="button" class="toolbox-ref-chip-main" ' + uploadAttr + disabledAttr + ' title="' + escapeHtml(_lockedTitle(titleTool, '点击更换')) + '">' +
      (src
        ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(ref.name || '参考图') + '" />'
        : '<span class="material-symbols-outlined">image</span>') +
      '<span class="toolbox-ref-chip-name">' + escapeHtml(ref.name || '参考图') + '</span>' +
    '</button>' +
    '<button type="button" class="toolbox-ref-chip-remove" ' + clearAttr + disabledAttr + ' title="' + escapeHtml(_lockedTitle(titleTool, '移除')) + '">' +
      '<span class="material-symbols-outlined">close</span>' +
    '</button>' +
  '</div>';
}

function _imageFormHtml() {
  var locked = _isToolBusy('image');
  var disabled = _disabledAttr(locked);
  return '' +
    (_imageForm.mode === 'image_to_image'
      ? '<div class="toolbox-field"><span>参考图</span>' +
        _refThumbHtml(_imageForm.refs[0], '上传 1 张参考图', 'data-toolbox-ref-upload="image-reference"', 'data-toolbox-ref-clear="image-reference"', locked, 'image') +
        '<input type="file" id="toolboxImageRefInput" accept="image/*" hidden /></div>'
      : '') +
    '<label class="toolbox-field"><span>提示词</span><textarea id="toolboxImagePrompt" rows="5" placeholder="描述你想生成的画面"' + disabled + '>' + escapeHtml(_imageForm.prompt || '') + '</textarea></label>' +
    '<div class="toolbox-field"><span>图片比例</span>' + _ratioButtons(_imageForm.ratio, ['1:1', '9:16', '16:9'], 'data-toolbox-image-ratio', locked) + '</div>' +
    '<label class="toolbox-field"><span>生成数量</span><select id="toolboxImageCount"' + disabled + '>' +
      [1, 2, 3, 4].map(function (n) { return '<option value="' + n + '"' + (_imageForm.count === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
    '</select></label>' +
    '<button type="button" class="toolbox-generate" data-toolbox-generate="image" ' + (_isToolBusy('image') ? 'disabled' : '') + '>' +
      '<span class="material-symbols-outlined">auto_awesome</span>' + (_isToolBusy('image') ? '生成中' : '生成图片') +
    '</button>' +
    _noticeHtml('image');
}

function _selectOptions(values, current) {
  return values.map(function (value) {
    return '<option value="' + escapeHtml(value) + '"' + (current === value ? ' selected' : '') + '>' + escapeHtml(value) + '</option>';
  }).join('');
}

function _compactSelectField(label, id, values, current, disabled) {
  return '<label class="toolbox-field toolbox-field--compact-select">' +
    '<span>' + escapeHtml(label) + '</span>' +
    '<select id="' + escapeHtml(id) + '"' + _disabledAttr(disabled) + '>' + _selectOptions(values, current) + '</select>' +
  '</label>';
}

function _videoFormHtml() {
  var locked = _isToolBusy('video');
  var disabled = _disabledAttr(locked);
  var motions = ['无','固定机位','跟拍','环绕','变焦拉近','变焦拉远','镜头左摇','镜头右摇','镜头上仰','镜头下俯','镜头前移','镜头后移','镜头左移','镜头右移','摇臂上升','摇臂下降','无人机航拍','360°横滚'];
  var shots = ['无','希区柯克变焦','延时摄影','急推镜头','急拉镜头','快速甩镜','子弹时间','FPV穿梭','微距特写','第一人称','慢镜头','探针镜头','旋转倾斜镜头'];
  return '' +
    '<div class="toolbox-field"><span>首帧图</span>' +
      _refThumbHtml(_videoForm.firstRef, '上传首帧图', 'data-toolbox-ref-upload="video-first"', 'data-toolbox-ref-clear="video-first"', locked, 'video') +
      '<input type="file" id="toolboxVideoFirstInput" accept="image/*" hidden /></div>' +
    (_videoForm.mode === 'first_last_frame_video'
      ? '<div class="toolbox-field"><span>尾帧图</span>' +
        _refThumbHtml(_videoForm.tailRef, '上传尾帧图', 'data-toolbox-ref-upload="video-tail"', 'data-toolbox-ref-clear="video-tail"', locked, 'video') +
        '<input type="file" id="toolboxVideoTailInput" accept="image/*" hidden /></div>'
      : '') +
    '<label class="toolbox-field"><span>提示词</span><textarea id="toolboxVideoPrompt" rows="4" placeholder="描述视频内容和主体动作"' + disabled + '>' + escapeHtml(_videoForm.prompt || '') + '</textarea></label>' +
    _compactSelectField('镜头运动方式', 'toolboxCameraMotion', motions, _videoForm.cameraMotion, locked) +
    _compactSelectField('特殊拍摄手法', 'toolboxSpecialShot', shots, _videoForm.specialShot, locked) +
    '<label class="toolbox-field"><span>镜头运动描述</span><input id="toolboxCameraMotionDesc" type="text" placeholder="可选，补充运动节奏和路径" value="' + escapeHtml(_videoForm.cameraMotionDescription || '') + '"' + disabled + ' /></label>' +
    '<div class="toolbox-field"><span>画面比例</span>' + _ratioButtons(_videoForm.ratio, ['9:16', '16:9', '1:1'], 'data-toolbox-video-ratio', locked) + '</div>' +
    _compactSelectField('分辨率', 'toolboxVideoResolution', ['720p', '1080p'], _videoForm.resolution, locked) +
    '<button type="button" class="toolbox-generate" data-toolbox-generate="video" ' + (_isToolBusy('video') ? 'disabled' : '') + '>' +
      '<span class="material-symbols-outlined">movie_creation</span>' + (_isToolBusy('video') ? '生成中' : '生成视频') +
    '</button>' +
    _noticeHtml('video');
}

function _toolHtml(tool) {
  var locked = _isToolBusy(tool);
  var disabled = _disabledAttr(locked);
  return '' +
    '<header class="toolbox-tool-head">' +
      '<button type="button" class="toolbox-back" data-toolbox-back title="' + escapeHtml(_lockedTitle(tool, '返回工具箱')) + '"' + disabled + '>' +
        '<span class="material-symbols-outlined">arrow_back</span>' +
      '</button>' +
      '<div>' +
        '<p class="toolbox-kicker">TOOLBOX</p>' +
        '<h1>' + _toolTitle(tool) + '</h1>' +
      '</div>' +
    '</header>' +
    '<div class="toolbox-workbench ' + (locked ? 'is-locked' : '') + '" data-toolbox-tool="' + tool + '" data-toolbox-busy="' + (locked ? 'true' : 'false') + '">' +
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
          '<button type="button" class="toolbox-upload-btn" data-toolbox-upload title="' + escapeHtml(_lockedTitle(tool, '上传')) + '"' + disabled + '>' +
            '<span class="material-symbols-outlined">upload</span>' +
          '</button>' +
          '<input type="file" id="toolboxUploadInput" ' + (tool === 'video' ? 'accept="video/*"' : 'accept="image/*"') + ' hidden />' +
        '</div>' +
        '<div id="toolboxHistoryList" class="toolbox-history-list">' + _historyHtml(tool) + '</div>' +
        '<button type="button" id="toolboxLoadMore" class="toolbox-load-more" ' + (_cursor[tool] ? '' : 'hidden') + disabled + '>加载更多</button>' +
      '</aside>' +
    '</div>';
}

function _historyHtml(tool) {
  var list = _history[tool] || [];
  var locked = _isToolBusy(tool);
  var disabled = _disabledAttr(locked);
  if (!list.length) {
    return '<div class="toolbox-empty-history">' +
      '<span class="material-symbols-outlined">history</span>' +
      '<p>暂无历史</p>' +
    '</div>';
  }
  return list.map(function (item) {
    var selected = _selected && _selected.id === item.id;
    return '<div class="toolbox-history-card ' + (selected ? 'is-selected ' : '') + (locked ? 'is-locked ' : '') + _statusClass(item) + '">' +
      '<button type="button" class="toolbox-history-main" data-toolbox-history-id="' + escapeHtml(item.id) + '"' + disabled + ' title="' + escapeHtml(_lockedTitle(tool, '切换预览')) + '">' +
        '<span class="toolbox-history-thumb">' + _thumbHtml(item) + '</span>' +
        '<span class="toolbox-history-copy">' +
          '<strong>' + escapeHtml(_historyItemTitle(item)) + '</strong>' +
          '<small>' + escapeHtml(_historyStatusMeta(item)) + '</small>' +
          '<em>' + escapeHtml(_historyDetail(item)) + '</em>' +
        '</span>' +
      '</button>' +
      '<button type="button" class="toolbox-history-delete" data-toolbox-history-delete="' + escapeHtml(item.id) + '" title="' + escapeHtml(_lockedTitle(tool, '删除历史')) + '"' + disabled + '>' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  }).join('');
}

function _timeAgo(iso) {
  var time = Date.parse(iso || '');
  if (!time) return '';
  var diff = Math.max(0, Date.now() - time);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

function _historyStatusMeta(item) {
  var label = _statusLabel(item);
  var ago = _timeAgo(item && item.createdAt);
  return ago ? (label + ' · ' + ago) : label;
}

function _clipText(text, maxLen) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  maxLen = maxLen || 36;
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

function _historyDetail(item) {
  if (!item) return '';
  if (item.status === 'failed') return _clipText(_humanizeError(item.errorMessage) || '可调整参数后重试', 42);
  if (item.status === 'running') return item.toolType === 'video' ? '任务已提交，自动刷新中' : '正在生成，请稍候';
  if (item.result && item.result.deleted) return '原文件不可用';
  if (item.sourceType === 'upload') return _clipText(item.result && item.result.filename || '手动上传素材', 42);
  return _clipText(item.prompt || '无提示词', 42);
}

function _extractProtectedFileId(url) {
  var match = String(url || '').match(/\/api\/images\/file\/([^/?#]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : '';
}

function _thumbHtml(item) {
  if (!item) return '<span class="material-symbols-outlined">draft</span>';
  if (item.status === 'failed') return '<span class="material-symbols-outlined">error</span>';
  var result = item.result || {};
  var imageId = result.type === 'image' ? (result.id || _extractProtectedFileId(result.url)) : '';
  var coverId = result.coverUrl ? _extractProtectedFileId(result.coverUrl) : '';
  var thumbId = imageId || coverId;
  if (thumbId) {
    return '<span class="toolbox-thumb-loader" data-toolbox-thumb-id="' + escapeHtml(thumbId) + '">' +
      '<span class="material-symbols-outlined">' + (item.toolType === 'video' ? 'movie' : 'image') + '</span>' +
    '</span>';
  }
  if (item.toolType === 'video') return '<span class="material-symbols-outlined">movie</span>';
  return '<span class="material-symbols-outlined">image</span>';
}

function _hasRunning(tool) {
  return (_history[tool] || []).some(function (item) { return item.status === 'running'; });
}

function _choice(value, allowed, fallback) {
  value = String(value || '').trim();
  return allowed.indexOf(value) >= 0 ? value : fallback;
}

function _boundedNumber(value, min, max, fallback) {
  var next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  next = Math.floor(next);
  return Math.max(min, Math.min(max, next));
}

function _cloneInputRefs(refs) {
  return Array.isArray(refs)
    ? refs.filter(function (ref) { return ref && ref.refId; }).map(function (ref) {
        var clone = Object.assign({}, ref);
        // 历史里存的 localPreviewUrl 是上传当次的 blob: 地址，跨会话/刷新后已失效。
        // 去掉它，缩略图就会回退到 urlAtCreation(/api/edit/media)，由 hydrate 带 token 加载。
        delete clone.localPreviewUrl;
        return clone;
      })
    : [];
}

function _replaceImageRefs(refs) {
  (_imageForm.refs || []).forEach(_revokeRefPreview);
  _imageForm.refs = refs;
}

function _replaceVideoRefs(firstRef, tailRef) {
  _revokeRefPreview(_videoForm.firstRef);
  _revokeRefPreview(_videoForm.tailRef);
  _videoForm.firstRef = firstRef || null;
  _videoForm.tailRef = tailRef || null;
}

function _findInputRef(refs, roles) {
  refs = _cloneInputRefs(refs);
  roles = Array.isArray(roles) ? roles : [roles];
  for (var i = 0; i < roles.length; i += 1) {
    var found = refs.find(function (ref) { return ref.role === roles[i]; });
    if (found) return found;
  }
  return refs[0] || null;
}

function _applyImageItemToForm(item) {
  var params = item && item.params && typeof item.params === 'object' ? item.params : {};
  var mode = item && item.mode === 'image_to_image' ? 'image_to_image' : 'text_to_image';
  _imageForm.mode = mode;
  _imageForm.prompt = String(item && item.prompt || '');
  _imageForm.ratio = _choice(params.ratio, ['1:1', '9:16', '16:9'], '9:16');
  _imageForm.count = _boundedNumber(params.count, 1, 4, 1);
  _replaceImageRefs(mode === 'image_to_image' ? _cloneInputRefs(item && item.inputRefs) : []);
}

function _applyVideoItemToForm(item) {
  var params = item && item.params && typeof item.params === 'object' ? item.params : {};
  var refs = _cloneInputRefs(item && item.inputRefs);
  var mode = item && item.mode === 'first_last_frame_video' ? 'first_last_frame_video' : 'image_to_video';
  _videoForm.mode = mode;
  _videoForm.prompt = String(item && item.prompt || '');
  _videoForm.ratio = _choice(params.ratio, ['9:16', '16:9', '1:1'], '9:16');
  _videoForm.resolution = _choice(params.resolution, ['720p', '1080p'], '720p');
  _videoForm.cameraMotion = String(params.cameraMotion || '无');
  _videoForm.specialShot = String(params.specialShot || '无');
  _videoForm.cameraMotionDescription = String(params.cameraMotionDescription || '');
  _replaceVideoRefs(
    _findInputRef(refs, ['first_frame', 'reference']),
    mode === 'first_last_frame_video' ? _findInputRef(refs, 'tail_frame') : null,
  );
}

function _applySelectedToForm(item) {
  if (!item || item.toolType !== _activeTool) return;
  if (item.toolType === 'image') _applyImageItemToForm(item);
  else if (item.toolType === 'video') _applyVideoItemToForm(item);
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
    if (_isActiveToolBusy()) {
      var note = _notice[_activeTool] || {};
      return '<div class="toolbox-preview-empty">' +
        '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>' +
        '<p>' + escapeHtml(note.title || '正在处理') + '</p>' +
        '<small>' + escapeHtml(note.detail || '完成后结果会显示在这里') + '</small>' +
      '</div>';
    }
    return '<div class="toolbox-preview-empty">' +
      '<span class="material-symbols-outlined">auto_awesome</span>' +
      '<p>生成结果会显示在这里</p>' +
      '<small>左侧生成，或从右侧上传素材后预览</small>' +
    '</div>';
  }
  if (item.status === 'failed') {
    return '<div class="toolbox-preview-empty is-error">' +
      '<span class="material-symbols-outlined">error</span>' +
      '<p>' + escapeHtml(_humanizeError(item.errorMessage) || '生成失败，请稍后重试') + '</p>' +
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
      '<small>' + (item.toolType === 'video' ? '右侧历史会自动刷新，完成后可预览' : '请稍候，完成后自动显示结果') + '</small>' +
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
    var blob = await apiRequest(uploadUrl, { method: 'GET', responseType: 'blob' }).catch(function () { return null; });
    if (!blob) return '';
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

function _selectedPreviewStillMatches(item, seq) {
  return seq === _previewRenderSeq && (!_selected && !item || (_selected && item && _selected.id === item.id));
}

function _previewBusyOverlayHtml() {
  if (!_isActiveToolBusy()) return '';
  var note = _notice[_activeTool] || {};
  return '<div class="toolbox-preview-busy">' +
    '<span class="material-symbols-outlined toolbox-spin">progress_activity</span>' +
    '<div><strong>' + escapeHtml(note.title || '正在处理') + '</strong>' +
    '<p>' + escapeHtml(note.detail || '旧结果暂保留预览') + '</p></div>' +
  '</div>';
}

async function _renderPreviewMedia(item, seq) {
  var area = $('toolboxPreviewArea');
  if (!area || !item || item.status !== 'completed' || !item.result || !item.result.exists) {
    if (seq === _previewRenderSeq) _revokeBlobUrlsExcept('');
    return;
  }
  var retainKey = _uploadBlobCacheKey(item);
  var url = await _resolveDisplayUrl(item).catch(function () { return ''; });
  if (!_selectedPreviewStillMatches(item, seq)) return;
  _revokeBlobUrlsExcept(retainKey);
  if (!url) {
    area.innerHTML = '<div class="toolbox-preview-empty is-error"><span class="material-symbols-outlined">broken_image</span><p>预览加载失败</p></div>';
    return;
  }
  var isVideo = item.toolType === 'video' || item.result.kind === 'video';
  var locked = _isActiveToolBusy();
  var disabled = _disabledAttr(locked);
  area.innerHTML = '<div class="toolbox-media-frame ' + (isVideo ? 'is-video' : 'is-image') + '">' +
    (isVideo
      ? '<video controls src="' + escapeHtml(url) + '"></video>'
      : '<img src="' + escapeHtml(url) + '" alt="工具箱结果" />') +
    (isVideo && item.result && item.result.durationSec
      ? '<div class="toolbox-media-meta">时长 约 ' + Math.round(Number(item.result.durationSec)) + ' 秒</div>'
      : '') +
    _previewBusyOverlayHtml() +
    '<div class="toolbox-media-actions">' +
      '<a ' + (locked ? 'class="is-disabled" aria-disabled="true" tabindex="-1"' : 'href="' + escapeHtml(url) + '" download') + ' title="' + escapeHtml(_lockedTitle(_activeTool, '下载')) + '"><span class="material-symbols-outlined">download</span></a>' +
      (item.canEnhance ? '<button type="button" data-toolbox-enhance title="' + escapeHtml(_lockedTitle(_activeTool, item.toolType === 'video' ? '高清重绘：以更高分辨率重新生成' : '高清重绘：按原提示词生成更清晰的新图')) + '"' + disabled + '><span class="material-symbols-outlined">high_quality</span></button>' : '') +
      '<button type="button" data-toolbox-delete title="' + escapeHtml(_lockedTitle(_activeTool, '删除历史')) + '"' + disabled + '><span class="material-symbols-outlined">delete</span></button>' +
    '</div>' +
  '</div>';
}

function _render() {
  var root = $('toolboxRoot');
  if (!root) return;
  var page = $('pageToolbox');
  if (page) page.classList.toggle('toolbox-no-scroll', _activeView !== 'home');
  _previewRenderSeq += 1;
  var seq = _previewRenderSeq;
  root.innerHTML = _activeView === 'home' ? _homeHtml() : _toolHtml(_activeTool);
  hydrateProtectedImageElements(root);
  if (_activeView === 'home') _revokeBlobUrlsExcept('');
  if (_activeView !== 'home') {
    _renderPreviewMedia(_selected, seq);
    _hydrateHistoryThumbs().catch(function () {});
  }
}

async function _hydrateHistoryThumbs() {
  var root = $('toolboxHistoryList');
  if (!root) return;
  var nodes = Array.prototype.slice.call(root.querySelectorAll('[data-toolbox-thumb-id]'));
  nodes.forEach(function (node) {
    var id = node.getAttribute('data-toolbox-thumb-id') || '';
    if (!id || node.getAttribute('data-thumb-loaded') === '1') return;
    node.setAttribute('data-thumb-loaded', '1');
    fetchAssetSignedUrl(id).then(function (url) {
      if (!url || !node.isConnected) return;
      node.innerHTML = '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" />';
    }).catch(function () {});
  });
}

async function _loadHistory(tool, append) {
  var url = '/api/toolbox/history?tool=' + encodeURIComponent(tool) + '&limit=30';
  if (append && _cursor[tool]) url += '&cursor=' + encodeURIComponent(_cursor[tool]);
  var data = await _jsonFetch(url, { method: 'GET' });
  var items = data.items || [];
  var previousSelectedId = _selected && _selected.id;
  _history[tool] = append ? (_history[tool] || []).concat(items) : items;
  _cursor[tool] = data.nextCursor || null;
  _syncSelectedFromHistory(tool);
  if (tool === _activeTool && _selected && _selected.id !== previousSelectedId) {
    _applySelectedToForm(_selected);
  }
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
  _setToolNotice(_activeTool, 'running', '正在上传素材', '上传完成后会加入右侧历史');
  _render();
  var fd = new FormData();
  fd.append('file', file);
  var upload = await apiUpload('/api/edit/upload-media', fd);
  var created = await _jsonFetch('/api/toolbox/items', {
    method: 'POST',
    body: JSON.stringify({ uploadId: upload.mediaId }),
  });
  _selected = created.item || null;
  await _loadHistory(_activeTool, false);
  if (_selected) {
    _history[_activeTool] = [_selected].concat((_history[_activeTool] || []).filter(function (item) { return item.id !== _selected.id; }));
    _applySelectedToForm(_selected);
  }
  _setToolNotice(_activeTool, 'success', '上传成功', '素材已加入右侧历史并显示在预览区');
  _render();
}

async function _uploadReference(file) {
  var fd = new FormData();
  fd.append('file', file);
  var upload = await apiUpload('/api/edit/upload-media', fd);
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

function _ingestImageItem(item, collected, total) {
  if (!item || !item.id) return;
  collected.push(item);
  _history.image = [item].concat((_history.image || []).filter(function (x) { return x.id !== item.id; }));
  _setToolNotice('image', 'running', '正在生成图片', '已返回 ' + collected.length + ' / ' + total + '，完成后自动显示最新结果');
  if (_activeView === 'image') _render();
}

async function _generateImage() {
  _syncImageFormFromDom();
  var prompt = String(_imageForm.prompt || '').trim();
  if (!prompt) {
    _setToolNotice('image', 'error', '请输入提示词', '描述画面主体、风格和构图后再生成');
    throw new Error('请输入提示词');
  }
  if (_imageForm.mode === 'image_to_image' && !_imageForm.refs.length) {
    _setToolNotice('image', 'error', '请先上传参考图', '图生图需要 1 张参考图');
    throw new Error('请先上传参考图');
  }
  // 拆成 N 个 count=1 的并行请求：单请求时长 ≈ 单张（而非 N 张串行），并能逐张回显。
  var count = Math.max(1, Math.min(4, Number(_imageForm.count) || 1));
  var mode = _imageForm.mode;
  var ratio = _imageForm.ratio;
  var refs = mode === 'image_to_image' ? _imageForm.refs : [];
  _setToolBusy('image', true);
  _setToolNotice('image', 'running', '正在生成图片', '已返回 0 / ' + count + '，请稍候');
  _render();
  var collected = [];
  var transportErrors = [];
  try {
    var jobs = [];
    for (var i = 0; i < count; i += 1) {
      jobs.push(
        _jsonFetch('/api/toolbox/image/generate', {
          method: 'POST',
          body: JSON.stringify({ mode: mode, prompt: prompt, params: { ratio: ratio, count: 1 }, inputRefs: refs }),
        })
          .then(function (data) { _ingestImageItem(data && data.items && data.items[0], collected, count); })
          .catch(function (e) { transportErrors.push(e && e.message ? e.message : String(e)); })
      );
    }
    await Promise.allSettled(jobs);
    await _loadHistory('image', false);
    // 收尾时若当前选中不是已完成图，优先选中一张已完成的结果。
    if (_activeTool === 'image') {
      var firstDone = collected.filter(function (x) { return x && x.status === 'completed'; })[0];
      var firstReturned = collected[0] || null;
      var nextSelected = firstDone || firstReturned;
      if (nextSelected) {
        _selected = (_history.image || []).find(function (x) { return x.id === nextSelected.id; }) || nextSelected;
        _applySelectedToForm(_selected);
      }
    }
    var summary = _summarizeItems(collected);
    if (!summary.total && transportErrors.length) {
      _setToolNotice('image', 'error', '图片请求失败', _humanizeError(transportErrors[0]) || '请稍后重试');
    } else if (summary.done > 0 && summary.failed > 0) {
      _setToolNotice('image', 'warn', '部分图片已完成', '成功 ' + summary.done + ' 张，失败 ' + summary.failed + ' 张；最新结果已显示');
    } else if (summary.failed > 0) {
      _setToolNotice('image', 'error', '图片生成失败', '失败记录已保留在右侧历史，可调整后重试');
    } else if (summary.done > 0) {
      _setToolNotice('image', 'success', '图片生成完成', '已完成 ' + summary.done + ' 张，最新结果已显示在预览区');
    }
    if (collected.length) _toastForImageGeneration({ items: collected });
    if (transportErrors.length) _toast('部分图片请求失败：' + (_humanizeError(transportErrors[0]) || '请稍后重试'), 'warn');
  } finally {
    _setToolBusy('image', false);
    if (_activeView === 'image') _render();
  }
}

async function _generateVideo() {
  _syncVideoFormFromDom();
  var prompt = String(_videoForm.prompt || '').trim();
  var missing = [];
  if (!_videoForm.firstRef) missing.push('首帧图');
  if (_videoForm.mode === 'first_last_frame_video' && !_videoForm.tailRef) missing.push('尾帧图');
  if (!prompt) missing.push('提示词');
  if (missing.length) {
    var missingMsg = '请先补充' + missing.join('、');
    _setToolNotice('video', 'error', missingMsg, '上传参考帧并填写主体动作后再生成视频');
    throw new Error(missingMsg);
  }
  var refs = [Object.assign({}, _videoForm.firstRef, { role: 'first_frame' })];
  if (_videoForm.mode === 'first_last_frame_video') refs.push(Object.assign({}, _videoForm.tailRef, { role: 'tail_frame' }));
  _setToolBusy('video', true);
  _setToolNotice('video', 'running', '正在提交视频任务', '提交成功后会在右侧历史持续刷新');
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
    var nextSelected = data.item || null;
    if (_activeTool === 'video') _selected = nextSelected;
    await _loadHistory('video', false);
    if (nextSelected) _history.video = [nextSelected].concat((_history.video || []).filter(function (item) { return item.id !== nextSelected.id; }));
    if (_activeTool === 'video' && nextSelected) _applySelectedToForm(_selected);
    if (_hasRunning('video')) _startVideoStatusPolling();
    else _stopVideoStatusPolling();
    if (nextSelected && nextSelected.status === 'failed') {
      _setToolNotice('video', 'error', '视频生成失败', _humanizeError(nextSelected.errorMessage) || '失败记录已保留在历史');
    } else if (nextSelected && nextSelected.status === 'running') {
      _setToolNotice('video', 'running', '视频任务已提交', '右侧历史会自动刷新，完成后可直接预览');
    } else {
      _setToolNotice('video', 'success', '视频生成完成', '结果已显示在预览区');
    }
    _toastForVideoGeneration(nextSelected);
  } finally {
    _setToolBusy('video', false);
    if (_activeView === 'video') _render();
  }
}

async function _enhanceSelected() {
  if (!_selected) return;
  var isVideoEnhance = _selected.toolType === 'video';
  var busyTool = isVideoEnhance ? 'video' : 'image';
  _setToolBusy(busyTool, true);
  _setToolNotice(busyTool, 'running', isVideoEnhance ? '正在提交高清重绘' : '正在重绘高清图片', '完成后会作为新历史版本显示');
  _render();
  if (isVideoEnhance) _startVideoStatusPolling();
  try {
    var data = await _jsonFetch('/api/toolbox/items/' + encodeURIComponent(_selected.id) + '/enhance', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    var nextSelected = data.item || _selected;
    if (_activeTool === busyTool) _selected = nextSelected;
    await _loadHistory(busyTool, false);
    if (nextSelected) _history[busyTool] = [nextSelected].concat((_history[busyTool] || []).filter(function (item) { return item.id !== nextSelected.id; }));
    if (_activeTool === busyTool && nextSelected) _applySelectedToForm(_selected);
    if (isVideoEnhance && _hasRunning('video')) _startVideoStatusPolling();
    else if (isVideoEnhance) _stopVideoStatusPolling();
    if (nextSelected && nextSelected.status === 'failed') {
      _setToolNotice(busyTool, 'error', '高清重绘失败', _humanizeError(nextSelected.errorMessage) || '失败记录已保留在历史');
    } else if (nextSelected && nextSelected.status === 'running') {
      _setToolNotice(busyTool, 'running', '高清重绘任务已提交', '右侧历史会自动刷新');
    } else {
      _setToolNotice(busyTool, 'success', '高清重绘完成', '新结果已显示在预览区');
    }
    _toastForEnhance(nextSelected);
  } finally {
    _setToolBusy(busyTool, false);
    if (_activeView === busyTool) _render();
  }
}

async function _deleteSelected() {
  if (!_selected) return;
  var confirmed = await showConfirm('删除工具箱历史', '只会移除这条工具箱记录，不会删除已保存到其他页面的素材。', '删除', '取消');
  if (!confirmed) return;
  var id = _selected.id;
  await _jsonFetch('/api/toolbox/items/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({}) });
  _history[_activeTool] = (_history[_activeTool] || []).filter(function (item) { return item.id !== id; });
  _selected = _history[_activeTool][0] || null;
  _applySelectedToForm(_selected);
  _setToolNotice(_activeTool, 'success', '历史已删除', '已切换到下一条可预览记录');
  _render();
  _toast('历史已删除', 'ok');
}

export function _initToolboxEvents() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('click', function (ev) {
    var open = ev.target.closest('[data-toolbox-open]');
    if (open) {
      if (_isActiveToolBusy()) return;
      _activeTool = open.getAttribute('data-toolbox-open') === 'video' ? 'video' : 'image';
      _activeView = _activeTool;
      _selected = null;
      _clearToolNotice(_activeTool);
      refreshToolboxPage();
      return;
    }
    if (ev.target.closest('[data-toolbox-back]')) {
      if (_isActiveToolBusy()) return;
      _activeView = 'home';
      _selected = null;
      _render();
      return;
    }
    if (ev.target.closest('[data-toolbox-upload]')) {
      if (_isActiveToolBusy()) return;
      var input = $('toolboxUploadInput');
      if (input) input.click();
      return;
    }
    var imageModeBtn = ev.target.closest('[data-toolbox-image-mode]');
    if (imageModeBtn) {
      if (_isToolBusy('image')) return;
      _syncImageFormFromDom();
      _imageForm.mode = imageModeBtn.getAttribute('data-toolbox-image-mode') || 'text_to_image';
      _clearToolNotice('image');
      _render();
      return;
    }
    var videoModeBtn = ev.target.closest('[data-toolbox-video-mode]');
    if (videoModeBtn) {
      if (_isToolBusy('video')) return;
      _syncVideoFormFromDom();
      _videoForm.mode = videoModeBtn.getAttribute('data-toolbox-video-mode') || 'image_to_video';
      _clearToolNotice('video');
      _render();
      return;
    }
    var imageRatioBtn = ev.target.closest('[data-toolbox-image-ratio]');
    if (imageRatioBtn) {
      if (_isToolBusy('image')) return;
      _syncImageFormFromDom();
      _imageForm.ratio = imageRatioBtn.getAttribute('data-toolbox-image-ratio') || '9:16';
      _clearToolNotice('image');
      _render();
      return;
    }
    var videoRatioBtn = ev.target.closest('[data-toolbox-video-ratio]');
    if (videoRatioBtn) {
      if (_isToolBusy('video')) return;
      _syncVideoFormFromDom();
      _videoForm.ratio = videoRatioBtn.getAttribute('data-toolbox-video-ratio') || '9:16';
      _clearToolNotice('video');
      _render();
      return;
    }
    var refClear = ev.target.closest('[data-toolbox-ref-clear]');
    if (refClear) {
      if (_isActiveToolBusy()) return;
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
      if (_isActiveToolBusy()) return;
      var target = refUpload.getAttribute('data-toolbox-ref-upload');
      var inputId = target === 'image-reference' ? 'toolboxImageRefInput' : target === 'video-tail' ? 'toolboxVideoTailInput' : 'toolboxVideoFirstInput';
      var refInput = $(inputId);
      if (refInput) refInput.click();
      return;
    }
    var gen = ev.target.closest('[data-toolbox-generate]');
    if (gen) {
      var which = gen.getAttribute('data-toolbox-generate');
      if (_isToolBusy(which === 'video' ? 'video' : 'image')) return;
      (which === 'video' ? _generateVideo() : _generateImage()).catch(function (e) {
        var toolName = which === 'video' ? 'video' : 'image';
        _setToolBusy(toolName, false);
        if (!_notice[toolName] || _notice[toolName].kind !== 'error') {
          _setToolNotice(toolName, 'error', _humanizeError(e.message) || (which === 'video' ? '视频生成失败' : '图片生成失败'), '请检查左侧必填项或稍后重试');
        }
        _render();
        _toast(_humanizeError(e.message) || '生成失败，请稍后重试', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-toolbox-enhance]')) {
      if (_isActiveToolBusy()) return;
      _enhanceSelected().catch(function (e) {
        _setToolBusy(_activeTool, false);
        _setToolNotice(_activeTool, 'error', _humanizeError(e.message) || '高清重绘失败', '请稍后重试');
        _render();
        _toast(_humanizeError(e.message) || '高清重绘失败', 'error');
      });
      return;
    }
    if (ev.target.closest('[data-toolbox-delete]')) {
      if (_isActiveToolBusy()) return;
      _deleteSelected().catch(function (e) { _toast(_humanizeError(e.message) || '删除失败', 'error'); });
      return;
    }
    var historyDelete = ev.target.closest('[data-toolbox-history-delete]');
    if (historyDelete) {
      if (_isActiveToolBusy()) return;
      var deleteId = historyDelete.getAttribute('data-toolbox-history-delete');
      var deleteItem = (_history[_activeTool] || []).find(function (item) { return item.id === deleteId; });
      if (deleteItem) {
        _selected = deleteItem;
        _deleteSelected().catch(function (e) { _toast(_humanizeError(e.message) || '删除失败', 'error'); });
      }
      return;
    }
    var card = ev.target.closest('[data-toolbox-history-id]');
    if (card) {
      if (_isActiveToolBusy()) return;
      var id = card.getAttribute('data-toolbox-history-id');
      var found = (_history[_activeTool] || []).find(function (item) { return item.id === id; });
      if (found) {
        _selected = found;
        _applySelectedToForm(found);
        if (!_isActiveToolBusy()) _clearToolNotice(_activeTool);
        _render();
      }
      return;
    }
    if (ev.target && ev.target.id === 'toolboxLoadMore') {
      if (_isActiveToolBusy()) return;
      _loadHistory(_activeTool, true).then(_render).catch(function (e) { _toast(_humanizeError(e.message) || '加载失败', 'error'); });
    }
  });

  document.addEventListener('change', function (ev) {
    if (!ev.target) return;
    if (ev.target.id === 'toolboxImageCount') {
      if (_isToolBusy('image')) return;
      _syncImageFormFromDom();
      return;
    }
    if (ev.target.id === 'toolboxCameraMotion' || ev.target.id === 'toolboxSpecialShot' || ev.target.id === 'toolboxVideoResolution') {
      if (_isToolBusy('video')) return;
      _syncVideoFormFromDom();
      return;
    }
    if (ev.target.id === 'toolboxImageRefInput' || ev.target.id === 'toolboxVideoFirstInput' || ev.target.id === 'toolboxVideoTailInput') {
      var refFile = ev.target.files && ev.target.files[0];
      var refInputId = ev.target.id;
      ev.target.value = '';
      if (_isToolBusy(refInputId === 'toolboxImageRefInput' ? 'image' : 'video')) return;
      if (!refFile) return;
      _setToolNotice(_activeTool, 'running', '正在上传参考图', '上传完成后会显示在左侧参数区');
      _render();
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
        _setToolNotice(_activeTool, 'success', '参考图已上传', '可以继续填写提示词并生成');
        _render();
        _toast('参考图已上传', 'ok');
      }).catch(function (e) {
        _setToolNotice(_activeTool, 'error', '参考图上传失败', _humanizeError(e.message) || '请确认文件是图片后重试');
        _render();
        _toast(_humanizeError(e.message) || '参考图上传失败', 'error');
      });
      return;
    }
    if (ev.target.id !== 'toolboxUploadInput') return;
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (_isActiveToolBusy()) return;
    if (!file) return;
    _uploadCurrentTool(file)
      .then(function () { _toast('上传成功', 'ok'); })
      .catch(function (e) {
        _setToolNotice(_activeTool, 'error', '上传失败', _humanizeError(e.message) || '请稍后重试');
        _render();
        _toast(_humanizeError(e.message) || '上传失败', 'error');
      });
  });
}
