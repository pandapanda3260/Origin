/**
 * 在线精修剪辑器 (Online Editor) 模块
 *
 * 当前状态: VevDemo iframe 集成模式
 * 通过 iframe 嵌入 VevDemo 服务，使用 postMessage 进行通信
 *
 * 架构:
 * - VevDemo Editor 由 VEVDEMO_EDITOR_URL / VEVDEMO_FRONTEND_URL 配置
 * - Origin 后端 API 提供素材代理 (/api/volcengine/*)
 * - 消息通过 postMessage 在 iframe 和主页面之间传递
 */

var _oeCtx = null;
var _vevFrame = null;
var _vevDemoConfig = null;
var _messageHandlers = new Map();
var _isVevDemoReady = false;
var _eventsBound = false;
var _connectStarted = false;
var _messageListenerBound = false;
var _hasVevDemoMessage = false;
var _vevFrameAutoRetryTimer = null;
var _vevFrameAutoRetryCount = 0;
var _lastVevFrameUrl = '';
var _ORIGIN_VIDEO_ID_RE = /\/api\/videos\/file\/([^/?#]+)/;
var _exportState = _createDefaultExportState();
var _exportPollingTimer = null;
var _exportPollingStartedAt = 0;
var _lastVevDemoAutoVideoSyncSignature = '';
var _vevDemoAutoVideoSyncInFlight = null;
var _vevDemoProjectBindingReady = false;
var _vevDemoBoundOriginProjectId = '';
var _vevDemoBoundVevProjectId = '';
var _vevDemoBoundVevGroupId = '';
var _vevDemoBoundVevSpace = '';
var _vevDemoProjectBindingInFlight = null;
var _vevDemoProjectBindingInFlightProjectId = '';
var _vevDemoInitialAutoSyncKey = '';
var _lastVevTimelineApplyToastKey = '';
var _lastVevTimelineApplyToastAt = 0;

const OEV_IFRAME_LOAD_TIMEOUT_MS = 25000;
const OEV_IFRAME_READY_TIMEOUT_MS = 10000;
const OEV_IFRAME_AUTO_RETRY_DELAY_MS = 3000;
const OEV_IFRAME_AUTO_RETRY_MAX = 2;
const OEV_EXPORT_STORAGE_ID_KEY = 'oeLastExportId';
const OEV_EXPORT_STORAGE_UPDATED_KEY = 'oeLastExportUpdatedAt';
const OEV_EXPORT_STORAGE_STALE_MS = 24 * 60 * 60 * 1000;
const OEV_EXPORT_POLL_INTERVAL_MS = 3000;
const OEV_EXPORT_POLL_MAX_MS = 10 * 60 * 1000;
const OEV_AUTO_VIDEO_SYNC_STORAGE_PREFIX = 'oeVevAutoVideoSync';
const OEV_MATERIAL_REGISTER_TIMEOUT_MS = 12 * 60 * 1000;
const OEV_MATERIAL_SYNC_REQUEST_TIMEOUT_MAX_MS = 60 * 60 * 1000;
const OEV_MATERIAL_SYNC_REQUEST_TIMEOUT_GRACE_MS = 60 * 1000;
const OEV_MATERIAL_IMPORT_ACK_TIMEOUT_MIN_MS = 30000;
const OEV_MATERIAL_IMPORT_ACK_TIMEOUT_PER_ITEM_MS = 15000;
const OEV_MATERIAL_IMPORT_ACK_TIMEOUT_MAX_MS = 180000;
const OEV_TIMELINE_APPLY_TOAST_DEDUP_MS = 6000;

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 初始化在线剪辑器
 * @param {Object} ctx - 上下文对象
 */
function initOnlineEditor(ctx) {
  _oeCtx = ctx;

  if (_eventsBound) return;
  _eventsBound = true;

  // 绑定 UI 事件（保留占位 UI 作为 fallback）；真实连接在页面进入时懒加载。
  _bindToolbarEvents();
  _bindMediaPanelEvents();
  _bindInspectorEvents();
  _bindTimelineEvents();
  _bindPreviewEvents();
}

/**
 * 每次进入在线精修页都执行的轻量恢复钩子。
 * 必须独立于 mountOnlineEditor() 的 iframe guard，避免切页回来后状态轮询不恢复。
 */
function onOnlineEditorPageEnter() {
  if (!_oeCtx) return;
  _restoreExportStateFromStorage();
  syncOnlineEditorProjectTitle();
}

function _cleanOnlineEditorText(value) {
  return String(value == null ? '' : value).trim();
}

function _formatOnlineEditorEpisodeLabel(project) {
  const rawIdx = Number(project?.currentEpisodeIdx);
  const idx = Number.isFinite(rawIdx) && rawIdx >= 0 ? Math.floor(rawIdx) : 0;
  const episodes = Array.isArray(project?.episodes) ? project.episodes : [];
  const episode = episodes[idx] || null;
  const title = _cleanOnlineEditorText(episode?.title);
  const matched = title.match(/第\s*([0-9０-９一二三四五六七八九十百千万]+)\s*集/);
  if (matched) return `第${matched[1]}集`;
  return `第${idx + 1}集`;
}

function _buildOnlineEditorProjectTitle(project) {
  const taskTitle = _cleanOnlineEditorText(project?.name || project?.title) || '未命名项目';
  return `${taskTitle}${_formatOnlineEditorEpisodeLabel(project)}`;
}

function _currentOriginProjectPayload(binding) {
  const project = _oeCtx?.getProject?.();
  if (!project?.id) return null;
  const payload = {
    projectId: project.id,
    title: _buildOnlineEditorProjectTitle(project),
  };
  const vevProjectId = _cleanOnlineEditorText(binding?.vevProjectId || _vevDemoBoundVevProjectId);
  const vevGroupId = _cleanOnlineEditorText(binding?.vevGroupId || _vevDemoBoundVevGroupId);
  const vevSpace = _cleanOnlineEditorText(binding?.vevSpace || _vevDemoBoundVevSpace);
  if (vevProjectId && vevGroupId) {
    payload.vevProjectId = vevProjectId;
    payload.vevGroupId = vevGroupId;
    if (vevSpace) payload.vevSpace = vevSpace;
  }
  return payload;
}

function _sendCurrentOriginProjectToVevDemo(binding) {
  const payload = _currentOriginProjectPayload(binding);
  if (!payload) return false;
  return _sendToVevDemo('origin:setProject', payload);
}

function syncOnlineEditorProjectTitle() {
  if (!_oeCtx || !_vevFrame?.contentWindow) return false;
  if (!_isCurrentVevDemoProjectBindingReady()) return false;
  return _sendCurrentOriginProjectToVevDemo();
}

/**
 * 页面进入时懒加载在线剪辑服务。
 * 避免工作台启动阶段就请求 VevDemo 配置或创建 iframe。
 */
async function mountOnlineEditor() {
  if (!_oeCtx) {
    console.warn('[OnlineEditor] 尚未初始化上下文');
    return;
  }
  if (_connectStarted || _vevFrame || _isVevDemoReady) return;
  _setConnectionStatus('pending', '连接中');
  _setOnlineEditorControlsReady(false);
  console.log('[OnlineEditor] mount start');
  _connectStarted = true;

  try {
    _vevDemoConfig = await _loadVevDemoConfig();
    const missingKeys = Array.isArray(_vevDemoConfig.missingKeys) ? _vevDemoConfig.missingKeys : [];

    if (_vevDemoConfig.enabled === false || _vevDemoConfig.reason === 'disabled') {
      _showSetupGuide(_vevDemoConfig.message || '在线精修剪辑器当前未启用', 'disabled', missingKeys);
      console.log('[OnlineEditor] 在线精修未启用');
      return;
    }

    if (!_vevDemoConfig.configured || !_getConfiguredIframeUrl(_vevDemoConfig)) {
      const missingText = missingKeys.length > 0 ? `缺少配置项：${missingKeys.join(', ')}` : '';
      _showSetupGuide(_vevDemoConfig.message || missingText || 'VevDemo 服务未配置', 'missing_config', missingKeys);
      console.log('[OnlineEditor] VevDemo 未配置，显示设置引导');
      return;
    }

    if (_vevDemoConfig.openMode === 'tab') {
      _showSetupGuide('当前配置为新标签页打开，请从剪辑页入口进入 VevDemo。', 'tab_only', []);
      return;
    }

    // 创建 VevDemo iframe
    const iframeUrl = _getConfiguredIframeUrl(_vevDemoConfig);
    _lastVevFrameUrl = iframeUrl;
    _resetVevDemoAutoRetryState();
    _createVevDemoFrame(iframeUrl);

    // 监听 postMessage
    if (!_messageListenerBound) {
      window.addEventListener('message', _handleVevMessage);
      _messageListenerBound = true;
    }

    console.log('[OnlineEditor] VevDemo iframe 初始化中...', _vevDemoConfig);
  } catch (err) {
    console.error('[OnlineEditor] 初始化失败:', err);
    _connectStarted = false;
    _setConnectionStatus('error', '连接失败');
    _showSetupGuide('连接 VevDemo 服务失败: ' + err.message, 'load_failed');
  }
}

async function _loadVevDemoConfig() {
  if (_oeCtx.getOnlineEditorConfig) {
    const cached = _oeCtx.getOnlineEditorConfig();
    if (cached) return cached;
  }
  if (_oeCtx.loadOnlineEditorConfig) {
    return await _oeCtx.loadOnlineEditorConfig();
  }
  throw new Error('在线精修配置上下文未注入');
}

function _getConfiguredIframeUrl(config) {
  if (!config) return '';
  return config.iframeProjectUrl || config.iframeUrl || config.iframeBaseUrl || '';
}

function _materialSyncRequestTimeoutMs(body) {
  const videoCount = Array.isArray(body?.resourceIds) ? body.resourceIds.length : 0;
  const bgmCount = Array.isArray(body?.bgmTrackIds) ? body.bgmTrackIds.length : 0;
  const itemCount = Math.max(1, videoCount + bgmCount);
  return Math.min(
    OEV_MATERIAL_SYNC_REQUEST_TIMEOUT_MAX_MS,
    itemCount * OEV_MATERIAL_REGISTER_TIMEOUT_MS + OEV_MATERIAL_SYNC_REQUEST_TIMEOUT_GRACE_MS,
  );
}

async function _postMaterialImport(body, options) {
  const requestBody = { ...(body || {}) };
  if (requestBody.autoRegister !== false && requestBody.registerTimeoutMs == null) {
    requestBody.registerTimeoutMs = OEV_MATERIAL_REGISTER_TIMEOUT_MS;
  }
  const timeoutMs = options?.timeoutMs || (
    requestBody.autoRegister === false
      ? undefined
      : _materialSyncRequestTimeoutMs(requestBody)
  );
  return await _oeCtx?.apiPost?.('/api/volcengine/import', requestBody, 'POST', { timeoutMs });
}

function _setConnectionStatus(variant, label) {
  const chip = document.getElementById('oeConnectionStatus');
  const text = document.getElementById('oeConnectionStatusText');
  if (!chip || !text) return;
  const safeVariant = ['pending', 'ready', 'error', 'muted'].includes(variant) ? variant : 'pending';
  chip.classList.remove('oe-status-chip--pending', 'oe-status-chip--ready', 'oe-status-chip--error', 'oe-status-chip--muted');
  chip.classList.add(`oe-status-chip--${safeVariant}`);
  text.textContent = label || '连接中';
}

/**
 * 刷新素材列表
 */
async function refreshMediaList() {
  // 如果 VevDemo 已就绪，通知它刷新素材
  if (_isVevDemoReady) {
    _sendToVevDemo('origin:refreshMaterials', {});
  }
  // 本地素材列表刷新逻辑
  console.log('[OnlineEditor] 刷新素材列表');
}

/**
 * 初始化时间线
 */
function initTimeline() {
  if (_isVevDemoReady) {
    _sendToVevDemo('origin:initTimeline', {
      projectId: _oeCtx?.getProject?.()?.id,
    });
  }
  console.log('[OnlineEditor] 初始化时间线');
}

/**
 * 获取当前页面状态
 */
function getOnlineEditorState() {
  return {
    vevDemoReady: _isVevDemoReady,
    exportState: { ..._exportState },
    timestamp: Date.now(),
  };
}

/**
 * 恢复页面状态
 */
function restoreOnlineEditorState(state) {
  console.log('[OnlineEditor] 恢复状态', state);
}

// ============================================================================
// 导出状态：store + 恢复
// ============================================================================

function _createDefaultExportState() {
  return {
    exportId: null,
    vevTaskId: null,
    vevPayload: null,
    phase: 'idle',
    status: null,
    localDownloadStatus: null,
    url: null,
    remoteUrl: null,
    remoteUrlExpiresAt: null,
    needsReviewReason: null,
    reexportRequired: false,
    errorMsg: '',
    polling: false,
    retrying: false,
    callbackPosting: false,
    callbackDedupKey: null,
    stateVersion: 0,
    dismissed: false,
  };
}

function _setExportState(patch) {
  _exportState = {
    ..._exportState,
    ...(patch || {}),
  };
  _renderExportStatusCard();
  return _exportState;
}

function _replaceExportState(patch) {
  _clearExportPollingTimer();
  const nextVersion = (_exportState.stateVersion || 0) + 1;
  _exportState = {
    ..._createDefaultExportState(),
    stateVersion: nextVersion,
    ...(patch || {}),
  };
  _renderExportStatusCard();
  return _exportState;
}

function _resetExportState() {
  _replaceExportState({ phase: 'idle' });
  _clearPersistedExportState();
}

function _clearExportPollingTimer() {
  if (_exportPollingTimer) clearTimeout(_exportPollingTimer);
  _exportPollingTimer = null;
  _exportPollingStartedAt = 0;
}

function _renderExportStatusCard() {
  const slot = document.getElementById('oeExportStatusSlot');
  if (!slot) return;

  const view = _getExportStatusViewModel(_exportState);
  if (!view) {
    slot.hidden = true;
    slot.innerHTML = '';
    return;
  }

  slot.hidden = false;
  const busyHtml = view.busy
    ? '<span class="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"></span>'
    : `<span class="material-symbols-outlined text-[16px]">${view.icon}</span>`;
  const actionsHtml = view.actions.map((action) => {
    const disabled = action.disabled ? 'disabled aria-disabled="true"' : '';
    const extraClass = action.primary
      ? 'bg-white/90 text-black hover:bg-white'
      : 'bg-white/5 text-white/70 hover:bg-white/10';
    return `<button type="button" data-oe-export-action="${action.action}" class="h-5 shrink-0 rounded px-2 text-[10px] font-semibold leading-none transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${extraClass}" ${disabled}>${_escapeOnlineEditorHtml(action.label)}</button>`;
  }).join('');

  slot.innerHTML = `
    <div class="inline-flex h-7 max-w-full items-center gap-2 rounded-md border ${view.borderClass} ${view.bgClass} px-2 shadow-sm shadow-black/20">
      <div class="shrink-0 ${view.textClass}">${busyHtml}</div>
      <div class="min-w-0 truncate text-[11px] font-semibold text-white/80" title="${_escapeOnlineEditorHtml(view.detail)}">
        ${_escapeOnlineEditorHtml(view.title)}
      </div>
      ${view.badge ? `<span class="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold text-white/45">${_escapeOnlineEditorHtml(view.badge)}</span>` : ''}
      ${actionsHtml ? `<div class="flex shrink-0 items-center gap-1">${actionsHtml}</div>` : ''}
    </div>
  `;
  _bindExportStatusCardActions(slot);
}

function _getExportStatusViewModel(state) {
  const phase = state?.phase || 'idle';
  if (phase === 'idle' || state?.dismissed) return null;

  const errorText = _formatOnlineEditorExportError(state?.errorMsg);
  const expired = _isRemoteUrlExpired(state?.remoteUrlExpiresAt)
    || state?.errorMsg === 'remote_url_expired'
    || state?.errorMsg === 'url_expired_need_reexport'
    || state?.needsReviewReason === 'url_expired_need_reexport'
    || !!state?.reexportRequired;
  const base = {
    bgClass: 'bg-[#0d141d]/92',
    borderClass: 'border-white/10',
    textClass: 'text-cyan-200',
    titleClass: 'text-white/88',
    icon: 'info',
    badge: '',
    busy: false,
    actions: [],
  };

  switch (phase) {
    case 'vev_exporting':
      return {
        ...base,
        busy: true,
        title: state?.callbackPosting ? '正在回写 Origin' : 'VevDemo 正在导出',
        detail: state?.callbackPosting ? '导出地址已返回，正在写入 Origin 导出记录。' : '远程导出进行中，请不要关闭 VevDemo 标签页。',
        badge: '远程',
      };
    case 'origin_callback_failed':
      return {
        ...base,
        borderClass: 'border-amber-400/30',
        bgClass: 'bg-amber-500/10',
        textClass: 'text-amber-200',
        icon: 'sync_problem',
        title: 'Origin 回写失败',
        detail: errorText || '导出已完成，但写入 Origin 记录失败。',
        badge: '待回写',
        actions: [
          { action: 'retry-callback', label: state?.callbackPosting ? '回写中...' : '重新回写 Origin', primary: true, disabled: !!state?.callbackPosting },
          { action: 'close', label: '关闭' },
        ],
      };
    case 'vev_export_failed':
      return {
        ...base,
        borderClass: 'border-red-400/30',
        bgClass: 'bg-red-500/10',
        textClass: 'text-red-200',
        icon: 'error',
        title: 'VevDemo 导出失败',
        detail: errorText || '远程导出未完成，请在 VevDemo 内重新触发导出。',
        badge: '失败',
        actions: [{ action: 'close', label: '关闭' }],
      };
    case 'origin_waiting_download':
      return {
        ...base,
        busy: true,
        title: '等待下载到本地',
        detail: '远程导出已完成，Origin 正在准备下载成片。',
        badge: '本地化',
      };
    case 'origin_downloading':
      return {
        ...base,
        busy: true,
        title: '正在下载到本地',
        detail: '成片正在写入 Origin 本地导出目录，完成后可播放或下载。',
        badge: '下载中',
      };
    case 'origin_download_failed':
      return {
        ...base,
        borderClass: 'border-amber-400/30',
        bgClass: 'bg-amber-500/10',
        textClass: 'text-amber-200',
        icon: expired ? 'schedule' : 'warning',
        title: expired ? '远程地址已过期' : '本地下载失败',
        detail: expired ? '远程 MP4 地址已过期，请在 VevDemo 内重新导出。' : (errorText || '下载到本地失败，可重试本地下载。'),
        badge: '需处理',
        actions: expired
          ? [
              { action: 'reexport', label: '重新导出', primary: true },
              { action: 'close', label: '关闭' },
            ]
          : [{ action: 'retry-local', label: state?.retrying ? '重试中...' : '重试下载（本地）', primary: true, disabled: !!state?.retrying }],
      };
    case 'ready':
      return {
        ...base,
        borderClass: 'border-emerald-400/30',
        bgClass: 'bg-emerald-500/10',
        textClass: 'text-emerald-200',
        icon: 'check_circle',
        title: '导出完成',
        detail: '成片已下载到 Origin 本地，可直接播放或下载。',
        badge: '可用',
        actions: [
          { action: 'play', label: '播放', primary: true },
          { action: 'download', label: '下载' },
          { action: 'close', label: '关闭' },
        ],
      };
    case 'polling_paused':
    default:
      return {
        ...base,
        borderClass: 'border-amber-400/25',
        bgClass: 'bg-amber-500/10',
        textClass: 'text-amber-200',
        icon: 'hourglass_empty',
        title: '导出状态待确认',
        detail: errorText || '导出耗时较长或状态异常，可继续等待或手动刷新。',
        badge: '待确认',
        actions: [
          { action: 'continue-polling', label: '继续等待', primary: true },
          { action: 'refresh', label: '刷新状态' },
        ],
      };
  }
}

function _bindExportStatusCardActions(slot) {
  slot.querySelectorAll('[data-oe-export-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const action = button.dataset.oeExportAction;
      if (button.disabled) return;
      if (action === 'close') {
        _resetExportState();
        return;
      }
      if (action === 'play') {
        _openExportPlaybackModal(_exportState.url);
        return;
      }
      if (action === 'download') {
        _downloadReadyExport();
        return;
      }
      if (action === 'refresh' || action === 'continue-polling') {
        if (action === 'continue-polling') {
          _continueExportStatusPolling();
        } else {
          _refreshCurrentExportStatusOnce();
        }
        return;
      }
      if (action === 'retry-local') {
        _retryLocalDownload();
        return;
      }
      if (action === 'retry-callback') {
        _retryOriginCallback();
        return;
      }
      if (action === 'reexport') {
        _requestVevDemoReexport();
      }
    });
  });
}

function _refreshCurrentExportStatusOnce() {
  const exportId = _exportState.exportId;
  if (!exportId) {
    _oeCtx?.showToast?.('没有可刷新的导出任务', 'warning');
    return;
  }
  _refreshPersistedExportUpdatedAt();
  _fetchAndApplyExportStatus(exportId, _exportState.stateVersion, { allowPolling: false });
}

function _continueExportStatusPolling() {
  const exportId = _exportState.exportId;
  if (!exportId) {
    _oeCtx?.showToast?.('没有可继续等待的导出任务', 'warning');
    return;
  }
  _refreshPersistedExportUpdatedAt();
  _startExportStatusPolling(exportId);
}

function _downloadReadyExport() {
  if (!_exportState.url) return;
  const link = document.createElement('a');
  link.href = _exportState.url;
  link.download = `${_exportState.exportId || 'online-editor-export'}.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function _openExportPlaybackModal(url) {
  if (!url) return;
  _closeExportPlaybackModal();
  const modal = document.createElement('div');
  modal.id = 'oeExportPlaybackModal';
  modal.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-6 backdrop-blur-md';
  modal.innerHTML = `
    <div class="w-full max-w-4xl rounded-2xl border border-white/10 bg-[#080d13] shadow-2xl shadow-black/50 overflow-hidden">
      <div class="flex items-center justify-between gap-4 px-4 py-3 border-b border-white/10">
        <div>
          <p class="text-sm text-white/85">导出成片预览</p>
          <p class="text-[11px] text-white/40">播放的是 Origin 本地导出文件</p>
        </div>
        <button type="button" data-oe-export-modal-close class="w-8 h-8 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 flex items-center justify-center">
          <span class="material-symbols-outlined text-base text-white/60">close</span>
        </button>
      </div>
      <div class="bg-black">
        <video src="${_escapeOnlineEditorHtml(url)}" controls autoplay class="w-full max-h-[70vh] bg-black"></video>
      </div>
    </div>
  `;
  modal.addEventListener('click', (event) => {
    if (event.target === modal || event.target.closest('[data-oe-export-modal-close]')) {
      _closeExportPlaybackModal();
    }
  });
  document.body.appendChild(modal);
}

function _closeExportPlaybackModal() {
  const existing = document.getElementById('oeExportPlaybackModal');
  if (existing) existing.remove();
}

function _isRemoteUrlExpired(value) {
  const expiresAt = _getExportExpireTime(value);
  if (!expiresAt) return false;
  return Date.now() + 60 * 1000 >= expiresAt;
}

function _getExportExpireTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function _formatOnlineEditorExportError(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';
  if (raw === 'missing remote url from VevDemo') return 'VevDemo 未返回导出地址';
  if (raw === 'remote_url_expired') return '远程下载地址已过期';
  if (raw === 'url_expired_need_reexport') return '远程下载地址已过期，需要重新导出';
  if (raw === 'orphaned by server restart') return '服务重启导致下载中断';
  if (/^remote_http_/i.test(raw)) return '远程文件下载失败，请重试';
  if (raw === 'remote_empty_body' || raw === 'download_failed') return '下载失败，请重试';
  return raw;
}

function _persistExportId(exportId) {
  if (!exportId) return;
  try {
    localStorage.setItem(OEV_EXPORT_STORAGE_ID_KEY, String(exportId));
    localStorage.setItem(OEV_EXPORT_STORAGE_UPDATED_KEY, new Date().toISOString());
  } catch (err) {
    console.warn('[OnlineEditor] 保存导出状态失败:', err);
  }
}

function _refreshPersistedExportUpdatedAt() {
  try {
    const exportId = localStorage.getItem(OEV_EXPORT_STORAGE_ID_KEY);
    if (!exportId) return;
    localStorage.setItem(OEV_EXPORT_STORAGE_UPDATED_KEY, new Date().toISOString());
  } catch (err) {
    console.warn('[OnlineEditor] 刷新导出状态时间失败:', err);
  }
}

function _clearPersistedExportState() {
  try {
    localStorage.removeItem(OEV_EXPORT_STORAGE_ID_KEY);
    localStorage.removeItem(OEV_EXPORT_STORAGE_UPDATED_KEY);
  } catch (err) {
    console.warn('[OnlineEditor] 清理导出状态失败:', err);
  }
}

function _readPersistedExportState() {
  try {
    const exportId = localStorage.getItem(OEV_EXPORT_STORAGE_ID_KEY);
    if (!exportId) return null;
    const updatedAt = localStorage.getItem(OEV_EXPORT_STORAGE_UPDATED_KEY);
    const updatedTime = updatedAt ? new Date(updatedAt).getTime() : 0;
    if (!Number.isFinite(updatedTime) || Date.now() - updatedTime > OEV_EXPORT_STORAGE_STALE_MS) {
      _clearPersistedExportState();
      return null;
    }
    return { exportId, updatedAt };
  } catch (err) {
    console.warn('[OnlineEditor] 读取导出状态失败:', err);
    return null;
  }
}

function _restoreExportStateFromStorage() {
  const persisted = _readPersistedExportState();
  if (!persisted?.exportId) return;
  if (_exportState.exportId === persisted.exportId && _exportState.phase !== 'idle') return;

  const version = (_exportState.stateVersion || 0) + 1;
  _exportState = {
    ..._createDefaultExportState(),
    stateVersion: version,
    exportId: persisted.exportId,
    phase: 'origin_waiting_download',
  };
  _renderExportStatusCard();
  _fetchAndApplyExportStatus(persisted.exportId, version, { allowPolling: false });
}

async function _fetchAndApplyExportStatus(exportId, requestVersion, options) {
  options = options || {};
  if (!exportId || !_oeCtx?.apiGet) return null;
  try {
    const payload = await _oeCtx.apiGet(`/api/edit/export-status/${encodeURIComponent(exportId)}`);
    if (requestVersion !== _exportState.stateVersion) return null;
    if (payload?.detail) {
      if (/不存在|unauthorized|认证/.test(String(payload.detail))) {
        _resetExportState();
        return null;
      }
      throw new Error(payload.detail);
    }
    _applyServerExportStatus(payload);
    _refreshPersistedExportUpdatedAt();
    return payload;
  } catch (err) {
    if (requestVersion !== _exportState.stateVersion) return null;
    if (err?.payload && (err.payload.status === 'completed' || err.payload.status === 'failed')) {
      _applyServerExportStatus(err.payload);
      _refreshPersistedExportUpdatedAt();
      return err.payload;
    }
    if (err?.status === 401 || err?.status === 404 || /不存在|unauthorized|认证/.test(String(err?.message || ''))) {
      _resetExportState();
      return null;
    }
    console.warn('[OnlineEditor] 获取导出状态失败:', err);
    _setExportState({
      phase: 'polling_paused',
      errorMsg: err?.message || '获取导出状态失败',
      polling: false,
    });
    return null;
  }
}

function _startExportStatusPolling(exportId) {
  if (!exportId) return;
  _clearExportPollingTimer();
  _exportPollingStartedAt = Date.now();
  const version = _exportState.stateVersion;
  _setExportState({ polling: true, errorMsg: _exportState.errorMsg || '' });

  const tick = async () => {
    if (version !== _exportState.stateVersion || exportId !== _exportState.exportId) return;
    if (Date.now() - _exportPollingStartedAt > OEV_EXPORT_POLL_MAX_MS) {
      _clearExportPollingTimer();
      _setExportState({
        phase: 'polling_paused',
        polling: false,
        errorMsg: '导出耗时较长，可继续等待或手动刷新状态。',
      });
      return;
    }

    await _fetchAndApplyExportStatus(exportId, version, { allowPolling: true });
    if (version !== _exportState.stateVersion || exportId !== _exportState.exportId) return;

    if (_isExportPollingTerminalPhase(_exportState.phase)) {
      _clearExportPollingTimer();
      _setExportState({ polling: false });
      return;
    }

    _exportPollingTimer = setTimeout(tick, OEV_EXPORT_POLL_INTERVAL_MS);
  };

  tick();
}

function _isExportPollingTerminalPhase(phase) {
  return phase === 'ready'
    || phase === 'vev_export_failed'
    || phase === 'origin_callback_failed'
    || phase === 'origin_download_failed'
    || phase === 'polling_paused';
}

function _applyServerExportStatus(payload) {
  const phase = _deriveServerExportPhase(payload);
  _setExportState({
    exportId: payload?.taskId || _exportState.exportId,
    phase,
    status: payload?.status || null,
    localDownloadStatus: payload?.localDownloadStatus || null,
    url: payload?.url || payload?.downloadUrl || null,
    remoteUrl: payload?.remoteUrl || null,
    remoteUrlExpiresAt: payload?.remoteUrlExpiresAt || null,
    needsReviewReason: payload?.needsReviewReason || null,
    reexportRequired: !!payload?.reexportRequired,
    errorMsg: payload?.errorMsg || payload?.error || '',
  });
}

function _deriveServerExportPhase(payload) {
  const url = payload?.url || payload?.downloadUrl;
  if (url) return 'ready';
  if (payload?.status === 'failed') return 'vev_export_failed';
  if (payload?.status === 'completed') {
    switch (payload?.localDownloadStatus) {
      case 'pending':
        return 'origin_waiting_download';
      case 'downloading':
        return 'origin_downloading';
      case 'download_failed':
        return 'origin_download_failed';
      case 'completed':
        return 'polling_paused';
      default:
        return 'polling_paused';
    }
  }
  return 'polling_paused';
}

// ============================================================================
// iframe 管理
// ============================================================================

function _createVevDemoFrame(url) {
  const container = document.getElementById('oeEditorContainer');
  if (!container) {
    console.error('[OnlineEditor] 未找到编辑器承载容器');
    return;
  }

  // 清空容器
  container.innerHTML = '';
  container.style.position = 'relative';
  _hasVevDemoMessage = false;

  let iframeLoaded = false;
  let readyTimer = null;
  let loadTimer = null;
  const clearFrameTimers = () => {
    if (loadTimer) clearTimeout(loadTimer);
    if (readyTimer) clearTimeout(readyTimer);
  };
  const failFrameLoad = (message) => {
    clearFrameTimers();
    _vevFrame = null;
    _connectStarted = false;
    _setConnectionStatus('error', '连接失败');
    _scheduleVevDemoAutoRetry(url, message);
  };

  // 创建加载指示器
  _setConnectionStatus('pending', '加载中');
  const loadingOverlay = document.createElement('div');
  loadingOverlay.id = 'oeVevLoadingOverlay';
  loadingOverlay.className = 'oe-editor-empty-state';
  loadingOverlay.innerHTML = `
    <span class="material-symbols-outlined animate-spin">progress_activity</span>
    <h2>正在连接</h2>
    <p title="${_escapeOnlineEditorHtml(url)}">视频剪辑服务加载中。</p>
  `;
  container.appendChild(loadingOverlay);

  // 创建 iframe
  _vevFrame = document.createElement('iframe');
  _vevFrame.id = 'vevdemo-frame';
  _vevFrame.src = url;
  _vevFrame.style.cssText = `
    width: 100%;
    height: 100%;
    border: none;
    background: #0a0e14;
    display: none;
  `;
  const frame = _vevFrame;

  const backFallback = document.createElement('button');
  backFallback.type = 'button';
  backFallback.id = 'oeVevBackFallback';
  backFallback.className = 'oe-vev-back-fallback';
  backFallback.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    z-index: 4;
    width: 96px;
    height: 48px;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: transparent;
    cursor: pointer;
  `;
  backFallback.setAttribute('aria-label', '返回剪辑页');
  backFallback.setAttribute('title', '返回剪辑页');
  backFallback.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    _onVevDemoNavBack({ source: 'origin-fallback-hitarea' });
  });

  loadTimer = setTimeout(() => {
    if (iframeLoaded) return;
    failFrameLoad(`编辑器加载超时，请检查 VevDemo 前端是否可访问，以及 Origin CSP frame-src 是否允许 ${url}`);
  }, OEV_IFRAME_LOAD_TIMEOUT_MS);

  // iframe 加载完成后显示
  frame.addEventListener('load', () => {
    if (_vevFrame !== frame) return;
    iframeLoaded = true;
    if (loadTimer) clearTimeout(loadTimer);
    console.log('[OnlineEditor] VevDemo iframe 加载完成');
    _setConnectionStatus('pending', '等待就绪');
    frame.style.display = 'block';
    const overlay = document.getElementById('oeVevLoadingOverlay');
    if (overlay) overlay.remove();
    setTimeout(() => {
      if (_vevFrame === frame && !_isVevDemoReady) {
        _sendToVevDemo('origin:getState', { timestamp: Date.now(), source: 'iframe-load' });
      }
    }, 0);

    readyTimer = setTimeout(() => {
      if (_isVevDemoReady || _hasVevDemoMessage || !_vevFrame) return;
      _showEditorDiagnostic(
        '编辑器已加载但未收到就绪消息',
        '请检查 VevDemo 服务是否暴露 postMessage ready/beacon；页面可继续用于渲染验证。'
      );
    }, OEV_IFRAME_READY_TIMEOUT_MS);
  });

  // iframe 加载失败
  frame.addEventListener('error', () => {
    if (_vevFrame !== frame) return;
    clearFrameTimers();
    console.error('[OnlineEditor] VevDemo iframe 加载失败');
    failFrameLoad('VevDemo iframe 加载失败，请检查服务是否运行、URL 是否正确，或是否被浏览器策略阻断');
  });

  container.appendChild(frame);
  container.appendChild(backFallback);
}

function _clearVevDemoAutoRetryTimer() {
  if (_vevFrameAutoRetryTimer) {
    clearTimeout(_vevFrameAutoRetryTimer);
    _vevFrameAutoRetryTimer = null;
  }
}

function _resetVevDemoAutoRetryState() {
  _clearVevDemoAutoRetryTimer();
  _vevFrameAutoRetryCount = 0;
}

function _isOnlineEditorPageActive() {
  const page = document.getElementById('pageOnlineEditor');
  return !!page && !page.hidden;
}

function _scheduleVevDemoAutoRetry(url, message) {
  _clearVevDemoAutoRetryTimer();
  if (!_isOnlineEditorPageActive()) {
    _showSetupGuide(message, 'load_failed');
    return;
  }

  if (_vevFrameAutoRetryCount >= OEV_IFRAME_AUTO_RETRY_MAX) {
    _showSetupGuide(`${message} 已自动重试 ${OEV_IFRAME_AUTO_RETRY_MAX} 次，仍未连接成功。`, 'load_failed');
    return;
  }

  const nextAttempt = _vevFrameAutoRetryCount + 1;
  _showSetupGuide(
    `${message} ${Math.ceil(OEV_IFRAME_AUTO_RETRY_DELAY_MS / 1000)} 秒后自动重试（${nextAttempt}/${OEV_IFRAME_AUTO_RETRY_MAX}）。`,
    'load_failed'
  );

  _vevFrameAutoRetryTimer = setTimeout(() => {
    _vevFrameAutoRetryTimer = null;
    if (!_isOnlineEditorPageActive()) return;
    _vevFrameAutoRetryCount = nextAttempt;
    console.log(`[OnlineEditor] VevDemo iframe 自动重试 ${nextAttempt}/${OEV_IFRAME_AUTO_RETRY_MAX}`);
    _retryVevDemoConnection({ auto: true, url });
  }, OEV_IFRAME_AUTO_RETRY_DELAY_MS);
}

async function _retryVevDemoConnection(options) {
  options = options || {};
  const manual = !!options.manual;
  const urlFromOptions = options.url || '';

  _clearVevDemoAutoRetryTimer();
  if (manual) _vevFrameAutoRetryCount = 0;
  if (!_oeCtx) return;
  if (!_isOnlineEditorPageActive()) return;

  if (_vevFrame) {
    _vevFrame.remove();
    _vevFrame = null;
  }
  _isVevDemoReady = false;
  _hasVevDemoMessage = false;
  _vevDemoInitialAutoSyncKey = '';
  _connectStarted = false;
  _setConnectionStatus('pending', manual ? '重试连接' : '连接中');
  _setOnlineEditorControlsReady(false);

  try {
    if (!_vevDemoConfig || !_getConfiguredIframeUrl(_vevDemoConfig)) {
      _vevDemoConfig = await _loadVevDemoConfig();
    }
    const url = urlFromOptions || _getConfiguredIframeUrl(_vevDemoConfig) || _lastVevFrameUrl;
    if (!url) {
      _showSetupGuide(_vevDemoConfig?.message || 'VevDemo 服务未配置', 'missing_config', _vevDemoConfig?.missingKeys || []);
      return;
    }
    _lastVevFrameUrl = url;
    if (!_messageListenerBound) {
      window.addEventListener('message', _handleVevMessage);
      _messageListenerBound = true;
    }
    _connectStarted = true;
    _createVevDemoFrame(url);
  } catch (err) {
    console.error('[OnlineEditor] 重连 VevDemo 失败:', err);
    _connectStarted = false;
    _showSetupGuide(`连接 VevDemo 服务失败: ${err.message || '未知错误'}`, 'load_failed');
  }
}

function _destroyVevDemoFrame() {
  _clearVevDemoAutoRetryTimer();
  if (_vevFrame) {
    _vevFrame.remove();
    _vevFrame = null;
  }
  _isVevDemoReady = false;
  _setConnectionStatus('muted', '未连接');
  _setOnlineEditorControlsReady(false);
  _connectStarted = false;
  _hasVevDemoMessage = false;
  _vevDemoInitialAutoSyncKey = '';
  if (_messageListenerBound) {
    window.removeEventListener('message', _handleVevMessage);
    _messageListenerBound = false;
  }
}

function destroyOnlineEditor() {
  _destroyVevDemoFrame();
}

function _getVevDemoOrigin() {
  if (!_vevDemoConfig?.iframeUrl) return '';
  try {
    const url = new URL(_vevDemoConfig.iframeUrl);
    return url.origin;
  } catch {
    console.warn('[OnlineEditor] VevDemo iframeUrl 无效，拒绝发送消息');
    return '';
  }
}

function _isFromVevDemo(origin) {
  if (!_vevDemoConfig?.iframeUrl) return false;
  try {
    const expectedOrigin = new URL(_vevDemoConfig.iframeUrl).origin;
    return origin === expectedOrigin;
  } catch {
    console.warn('[OnlineEditor] VevDemo iframeUrl 无效，拒绝接收消息');
    return false;
  }
}

// ============================================================================
// postMessage 通信
// ============================================================================

function _sendToVevDemo(type, data) {
  if (!_vevFrame?.contentWindow) {
    console.warn('[OnlineEditor] VevDemo iframe 未就绪，无法发送消息:', type);
    return false;
  }

  try {
    const targetOrigin = _getVevDemoOrigin();
    if (!targetOrigin) return false;
    _vevFrame.contentWindow.postMessage({ type, data }, targetOrigin);
    console.log('[OnlineEditor] -> VevDemo:', type, data);
    return true;
  } catch (err) {
    console.error('[OnlineEditor] 发送消息失败:', err);
    return false;
  }
}

function _handleVevMessage(event) {
  // 验证消息来源
  if (!_isFromVevDemo(event.origin)) {
    return;
  }

  _hasVevDemoMessage = true;
  const { type, data } = event.data || {};
  if (!type) return;

  console.log('[OnlineEditor] <- VevDemo:', type, data);

  // 处理预注册的处理器
  const handler = _messageHandlers.get(type);
  if (handler) {
    try {
      handler(data);
    } catch (err) {
      console.error('[OnlineEditor] 消息处理错误:', type, err);
    }
    return;
  }

  // 内置消息处理
  switch (type) {
    case 'vevdemo:ready':
      _onVevDemoReady(data);
      break;

    case 'vevdemo:navBack':
      _onVevDemoNavBack(data);
      break;

    case 'vevdemo:exportComplete':
      _onExportComplete(data);
      break;

    case 'vevdemo:exportStatus':
      _onVevDemoStatus(data);
      break;

    case 'vevdemo:exportError':
      _onExportError(data);
      break;

    case 'vevdemo:timelineChange':
      _onTimelineChange(data);
      break;

    case 'vevdemo:materialsImported':
      _onMaterialsImported(data);
      break;

    case 'vevdemo:error':
      _onVevDemoError(data);
      break;

    case 'vevdemo:status':
      _onVevDemoStatus(data);
      break;

    case 'vevdemo:originRequest':
      _handleVevDemoOriginRequest(data);
      break;

    default:
      console.log('[OnlineEditor] 未处理的消息:', type, data);
  }
}

// ============================================================================
// VevDemo 消息处理
// ============================================================================

function _onVevDemoNavBack() {
  // SDK header「返回」按钮:回到 Origin 剪辑页(在线精修的上一步)。
  // 等价于顶栏「返回剪辑页」,复用同一套 switchPage,不另搞导航。
  if (typeof _oeCtx?.switchPage === 'function') {
    _oeCtx.switchPage('edit');
  } else {
    try {
      window.location.hash = 'workspacePage=edit';
    } catch (_) {}
    console.warn('[OnlineEditor] 收到 vevdemo:navBack 但无 switchPage,已写入 edit hash');
  }
}

function _confirmVevDemoProjectBindingFromBridge(data, source) {
  const currentProjectId = String(_oeCtx?.getProject?.()?.id || '').trim();
  const receivedProjectId = String(data?.originProjectId || '').trim();
  const explicitProjectId = String(data?.vevProjectId || '').trim();
  const explicitGroupId = String(data?.vevGroupId || '').trim();
  const bridgeProjectId = String(data?.projectId || '').trim();
  const bridgeGroupId = String(data?.groupId || '').trim();
  const hasExplicitBinding = Boolean(explicitProjectId && explicitGroupId);
  const hasSwitchedBoundProject = Boolean(data?.projectIsolationReady && bridgeProjectId && bridgeGroupId);
  const bindingReady = Boolean(
    currentProjectId
      && receivedProjectId === currentProjectId
      && (hasExplicitBinding || hasSwitchedBoundProject)
  );
  _vevDemoProjectBindingReady = bindingReady;
  _vevDemoBoundOriginProjectId = bindingReady ? currentProjectId : '';
  _vevDemoBoundVevProjectId = bindingReady ? (explicitProjectId || bridgeProjectId) : '';
  _vevDemoBoundVevGroupId = bindingReady ? (explicitGroupId || bridgeGroupId) : '';
  if (bindingReady) {
    console.log('[OnlineEditor] VevDemo 项目绑定已确认:', {
      source,
      originProjectId: currentProjectId,
      vevProjectId: explicitProjectId || bridgeProjectId,
      vevGroupId: explicitGroupId || bridgeGroupId,
    });
  }
  return bindingReady;
}

function _isCurrentVevDemoProjectBindingReady() {
  const currentProjectId = String(_oeCtx?.getProject?.()?.id || '').trim();
  return Boolean(currentProjectId && _vevDemoProjectBindingReady && _vevDemoBoundOriginProjectId === currentProjectId);
}

function _isVevDemoAwaitingProjectBindingState(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.status === 'bridge-ready' || data.awaitingProjectBinding === true) return true;
  if (data.status !== 'state') return false;
  return data.ready === false && data.projectIsolationReady === false;
}

function _markVevDemoBoundReady(data, source, wasReady) {
  if (data?.ready === true) _isVevDemoReady = true;
  _resetVevDemoAutoRetryState();
  if (!_isVevDemoReady) {
    _setConnectionStatus('pending', '绑定项目中');
    _setOnlineEditorControlsReady(false);
    return;
  }
  _setConnectionStatus('ready', '已连接');
  _setOnlineEditorControlsReady(true);
  const diagnostic = document.getElementById('oeVevDiagnostic');
  if (diagnostic) diagnostic.remove();
  console.log('[OnlineEditor] VevDemo 项目绑定已就绪:', source, data);
  if (!wasReady && data && data.uploadWorkflowConfigured === false) {
    _oeCtx?.showToast?.('VevDemo 上传转码工作流未配置，新上传 MP4 可能仍无法拖入轨道', 'warning');
  }
  if (!wasReady) {
    _sendToVevDemo('origin:ping', { timestamp: Date.now() });
    _oeCtx?.showToast?.('视频剪辑服务已连接', 'success');
  }
}

function _triggerInitialVevDemoAutoSyncOnce(source) {
  if (!_isCurrentVevDemoProjectBindingReady()) return null;
  const key = `${_vevDemoBoundOriginProjectId}:${_vevDemoBoundVevProjectId}`;
  if (!key || key === _vevDemoInitialAutoSyncKey) return null;
  console.log('[OnlineEditor] 触发 VevDemo 初始自动同步:', { source, key });
  return Promise.resolve(_autoSyncCurrentEdlVideosToVevDemo()).then((result) => {
    if (!result?.error) _vevDemoInitialAutoSyncKey = key;
    return result;
  });
}

function _ensureVevDemoProjectBinding(source) {
  const project = _oeCtx?.getProject?.();
  const projectId = String(project?.id || '').trim();
  if (!projectId) return Promise.resolve(false);
  if (_isCurrentVevDemoProjectBindingReady()) return Promise.resolve(true);
  if (_vevDemoProjectBindingInFlight && _vevDemoProjectBindingInFlightProjectId === projectId) {
    return _vevDemoProjectBindingInFlight;
  }
  _setConnectionStatus('pending', '绑定项目中');
  _setOnlineEditorControlsReady(false);
  _vevDemoProjectBindingInFlightProjectId = projectId;
  console.log('[OnlineEditor] 开始绑定 VevDemo 项目:', { source, projectId });
  _vevDemoProjectBindingInFlight = _bindCurrentOriginProjectToVevDemo()
    .finally(() => {
      if (_vevDemoProjectBindingInFlightProjectId === projectId) {
        _vevDemoProjectBindingInFlight = null;
        _vevDemoProjectBindingInFlightProjectId = '';
      }
    });
  return _vevDemoProjectBindingInFlight;
}

function _onVevDemoReady(data) {
  const wasReady = _isVevDemoReady;
  _isVevDemoReady = true;
  console.log('[OnlineEditor] VevDemo 就绪', wasReady ? '(重复 ready，仅刷新状态)' : '');
  if (_confirmVevDemoProjectBindingFromBridge(data, 'ready')) {
    _markVevDemoBoundReady(data, 'ready', wasReady);
    _triggerInitialVevDemoAutoSyncOnce('ready');
    return;
  }

  _isVevDemoReady = false;
  _resetVevDemoAutoRetryState();
  _setConnectionStatus('pending', '绑定项目中');
  _setOnlineEditorControlsReady(false);
  console.warn('[OnlineEditor] VevDemo ready 但项目绑定未确认，继续绑定:', data);
  _ensureVevDemoProjectBinding('ready');
}

async function _bindCurrentOriginProjectToVevDemo() {
  const project = _oeCtx?.getProject?.();
  if (!project?.id) return false;
  _vevDemoProjectBindingReady = false;
  _vevDemoBoundOriginProjectId = '';
  _vevDemoBoundVevProjectId = '';
  _vevDemoBoundVevGroupId = '';
  _vevDemoBoundVevSpace = '';
  try {
    const payload = await _oeCtx?.apiPost?.('/api/online-editor/project-binding', {
      projectId: project.id,
    });
    if (!payload?.success || !payload?.vevProjectId || !payload?.vevGroupId) {
      throw new Error(payload?.detail || 'VevDemo 工程绑定信息不完整');
    }
    _vevDemoBoundVevProjectId = _cleanOnlineEditorText(payload.vevProjectId);
    _vevDemoBoundVevGroupId = _cleanOnlineEditorText(payload.vevGroupId);
    _vevDemoBoundVevSpace = _cleanOnlineEditorText(payload.vevSpace);
    _sendCurrentOriginProjectToVevDemo(payload);
    return true;
  } catch (err) {
    console.error('[OnlineEditor] VevDemo 工程绑定失败:', err);
    _vevDemoProjectBindingReady = false;
    _vevDemoBoundOriginProjectId = '';
    _vevDemoBoundVevProjectId = '';
    _vevDemoBoundVevGroupId = '';
    _vevDemoBoundVevSpace = '';
    _oeCtx?.showToast?.(`VevDemo 工程隔离暂不可用: ${err?.message || 'unknown error'}`, 'warning');
    _setConnectionStatus('error', '工程未绑定');
    _setOnlineEditorControlsReady(false);
    _showSetupGuide(`VevDemo 工程隔离未就绪: ${err?.message || 'unknown error'}`, 'binding_failed');
    return false;
  }
}

function _onExportComplete(data) {
  const payload = _normalizeVevExportPayload(data);
  const key = _getExportCallbackDedupKey(payload);
  console.log('[OnlineEditor] 导出完成:', payload);

  if (!key) {
    _setExportState({
      phase: 'vev_export_failed',
      errorMsg: 'VevDemo 导出完成事件缺少 taskId 和 outputUrl',
      vevPayload: payload,
      callbackPosting: false,
    });
    return;
  }

  if (key === _exportState.callbackDedupKey && (_exportState.callbackPosting || _exportState.exportId)) {
    console.log('[OnlineEditor] 忽略重复导出完成事件:', key);
    return;
  }

  if (key !== _exportState.callbackDedupKey || _exportState.phase !== 'vev_exporting') {
    _beginNewVevExport(payload);
  } else {
    _setExportState({
      vevTaskId: payload.taskId || _exportState.vevTaskId,
      vevPayload: payload,
      callbackDedupKey: key,
      phase: 'vev_exporting',
      status: payload.status || _exportState.status,
      errorMsg: '',
    });
  }

  _submitExportCallbackFromPayload(payload, _exportState.stateVersion);
}

function _onExportError(data) {
  const payload = _normalizeVevExportPayload(data);
  const key = _getExportCallbackDedupKey(payload);
  if (_exportState.exportId && (!key || key === _exportState.callbackDedupKey)) {
    console.log('[OnlineEditor] 忽略已入库导出的迟到错误事件:', payload);
    return;
  }
  console.error('[OnlineEditor] 导出错误:', payload.code, payload.message);
  _clearExportPollingTimer();
  _setExportState({
    phase: 'vev_export_failed',
    status: payload.status || 'failed',
    vevTaskId: payload.taskId || _exportState.vevTaskId,
    vevPayload: payload,
    callbackDedupKey: key || _exportState.callbackDedupKey,
    callbackPosting: false,
    polling: false,
    retrying: false,
    errorMsg: payload.message || 'VevDemo 导出失败',
  });
  _oeCtx?.showToast?.(`导出失败: ${payload.message || '未知错误'}`, 'error');
}

function _onTimelineChange(data) {
  console.log('[OnlineEditor] 时间线变化:', data);
  // 可以在这里同步本地状态
}

function _onMaterialsImported(data) {
  const { count, mediaIds, results, mode, registeredCount, probedCount, registrationResults } = data || {};
  console.log('[OnlineEditor] 素材同步完成:', { count, mediaIds, results, registrationResults });
  if (mode === 'create-edit-material' && Number(registeredCount || 0) > 0) {
    _oeCtx?.showToast?.(`已同步 ${registeredCount} 个素材到 VevDemo 素材库`, 'success');
    return;
  }
  const skipped = Array.isArray(registrationResults)
    ? registrationResults.filter((item) => item && item.ok === false).length
    : 0;
  const suffix = skipped > 0 ? `，${skipped} 个素材尚未完成 VOD/TOS 注册` : '，尚未完成 VOD/TOS 注册';
  _oeCtx?.showToast?.(`已检测 ${probedCount || count || 0} 个浏览器侧可访问素材${suffix}`, 'warning');
}

function _onVevDemoError(data) {
  const { message, code } = data || {};
  console.error('[OnlineEditor] VevDemo 错误:', code, message);
  _oeCtx?.showToast?.(`VevDemo 错误: ${message || '未知错误'}`, 'error');
}

function _onVevDemoStatus(data) {
  const payload = _normalizeVevExportPayload(data);
  if (!_isVevExportStatusPayload(payload)) {
    if (_isVevDemoAwaitingProjectBindingState(data)) {
      console.log('[OnlineEditor] VevDemo 桥已就绪，等待 Origin 工程绑定:', data);
      _ensureVevDemoProjectBinding(data?.status || 'state');
      return;
    }
    if (data?.status === 'project-binding-missing') {
      console.warn('[OnlineEditor] VevDemo 阻止未绑定项目进入默认工程:', data);
      _setConnectionStatus('pending', '绑定项目中');
      _setOnlineEditorControlsReady(false);
      _ensureVevDemoProjectBinding('project-binding-missing');
      return;
    }
    if (data?.status === 'state') {
      if (_confirmVevDemoProjectBindingFromBridge(data, 'state')) {
        _markVevDemoBoundReady(data, 'state', _isVevDemoReady);
        _triggerInitialVevDemoAutoSyncOnce('state');
      } else {
        console.log('[OnlineEditor] VevDemo state 未满足项目绑定:', data);
      }
      return;
    }
    if (data?.status === 'origin-project-received') {
      console.log('[OnlineEditor] VevDemo 已接收当前 Origin 项目:', data);
      if (!_confirmVevDemoProjectBindingFromBridge(data, 'status')) {
        const currentProjectId = String(_oeCtx?.getProject?.()?.id || '').trim();
        const receivedProjectId = String(data?.originProjectId || '').trim();
        console.warn('[OnlineEditor] VevDemo 项目绑定未确认，跳过自动同步/铺轨:', {
          currentProjectId,
          receivedProjectId,
          vevProjectId: data?.vevProjectId || null,
          vevGroupId: data?.vevGroupId || null,
        });
        _oeCtx?.showToast?.('VevDemo 项目绑定未确认，已暂停自动同步，避免写入默认工程', 'warning');
        return;
      }
      _markVevDemoBoundReady(data, 'origin-project-received', _isVevDemoReady);
      _triggerInitialVevDemoAutoSyncOnce('origin-project-received');
      return;
    }
    console.log('[OnlineEditor] VevDemo 状态:', data);
    return;
  }

  if (_isVevExportFailureStatus(payload.status)) {
    _onExportError(payload);
    return;
  }

  const key = _getExportCallbackDedupKey(payload);
  const isPreTerminalFail = _exportState.phase === 'vev_export_failed'
    || _exportState.phase === 'origin_callback_failed';

  if (isPreTerminalFail) {
    _beginNewVevExport(payload);
    return;
  }

  if (key && _exportState.callbackDedupKey && key !== _exportState.callbackDedupKey) {
    _beginNewVevExport(payload);
    return;
  }

  if (!_exportState.exportId) {
    _setExportState({
      phase: 'vev_exporting',
      status: payload.status || _exportState.status,
      vevTaskId: payload.taskId || _exportState.vevTaskId,
      vevPayload: payload,
      callbackDedupKey: key || _exportState.callbackDedupKey,
      errorMsg: payload.message || '',
    });
  }
  console.log('[OnlineEditor] VevDemo 导出状态:', payload);
}

async function _handleVevDemoOriginRequest(data) {
  const requestId = String(data?.requestId || '').trim();
  const requestType = String(data?.requestType || '').trim();
  const payload = data?.payload && typeof data.payload === 'object' ? data.payload : {};
  if (!requestId) return;

  try {
    let result;
    switch (requestType) {
      case 'searchProjectVideos':
        result = await _searchCurrentProjectVideosForVevDemo(payload);
        break;
      case 'registerProjectVideo':
        result = await _registerProjectVideoForVevDemo(payload);
        break;
      default:
        throw new Error(`不支持的 VevDemo Origin 请求: ${requestType || '(empty)'}`);
    }
    _sendToVevDemo('origin:response', { requestId, ok: true, result });
  } catch (err) {
    console.error('[OnlineEditor] VevDemo Origin 请求失败:', requestType, err);
    _sendToVevDemo('origin:response', {
      requestId,
      ok: false,
      error: err?.message || String(err || 'unknown error'),
    });
  }
}

async function _searchCurrentProjectVideosForVevDemo(payload) {
  const project = _oeCtx?.getProject?.();
  const requestedProjectId = String(payload?.projectId || '').trim();
  if (!project?.id) throw new Error('当前项目不存在，无法读取项目视频库');
  if (requestedProjectId && requestedProjectId !== project.id) {
    throw new Error('VevDemo 请求的项目与当前 Origin 项目不一致');
  }
  return await _oeCtx?.apiGet?.(
    `/api/tasks/video-by-project?projectId=${encodeURIComponent(project.id)}&scope=all-completed`,
  );
}

async function _registerProjectVideoForVevDemo(payload) {
  const project = _oeCtx?.getProject?.();
  const videoTaskId = String(payload?.videoTaskId || payload?.resourceId || '').trim();
  const requestedProjectId = String(payload?.projectId || '').trim();
  if (!project?.id) throw new Error('当前项目不存在，无法注册项目视频');
  if (requestedProjectId && requestedProjectId !== project.id) {
    throw new Error('VevDemo 注册请求的项目与当前 Origin 项目不一致');
  }
  if (!videoTaskId) throw new Error('缺 videoTaskId');
  return await _postMaterialImport({
    projectId: project.id,
    resourceIds: [videoTaskId],
  });
}

function _normalizeVevExportPayload(data) {
  const raw = data?.status === 'export-status' && data?.payload ? data.payload : (data || {});
  return {
    taskId: raw.taskId || raw.exportId || raw.id || null,
    outputUrl: raw.outputUrl || raw.url || raw.downloadUrl || null,
    duration: raw.duration ?? raw.durationSec ?? null,
    format: raw.format || 'mp4',
    status: raw.status || raw.exportStatus || null,
    message: raw.message || raw.error || raw.errorMsg || '',
    code: raw.code || raw.errorCode || null,
    raw,
  };
}

function _isVevExportStatusPayload(payload) {
  if (!payload) return false;
  return Boolean(
    payload.taskId
    || payload.outputUrl
    || _isKnownVevExportStatus(payload.status)
    || payload.raw?.status === 'export-status'
  );
}

function _isKnownVevExportStatus(status) {
  return /export|queue|pending|submit|process|running|complete|success|fail|error|cancel/i.test(String(status || ''));
}

function _isVevExportFailureStatus(status) {
  return /fail|error|cancel/i.test(String(status || ''));
}

function _getExportCallbackDedupKey(payload) {
  return payload?.taskId || payload?.outputUrl || null;
}

function _beginNewVevExport(payload) {
  const normalized = _normalizeVevExportPayload(payload);
  const key = _getExportCallbackDedupKey(normalized);
  _clearPersistedExportState();
  return _replaceExportState({
    phase: 'vev_exporting',
    vevTaskId: normalized.taskId || null,
    vevPayload: normalized,
    callbackDedupKey: key,
    status: normalized.status || null,
    url: null,
    remoteUrl: normalized.outputUrl || null,
    remoteUrlExpiresAt: null,
    errorMsg: normalized.message || '',
    localDownloadStatus: null,
    callbackPosting: false,
    polling: false,
    retrying: false,
  });
}

async function _submitExportCallbackFromPayload(payload, requestVersion) {
  const normalized = _normalizeVevExportPayload(payload);
  const key = _getExportCallbackDedupKey(normalized);
  if (!key) {
    _setExportState({
      phase: 'vev_export_failed',
      errorMsg: '缺少 VevDemo 导出标识，无法回写 Origin',
      callbackPosting: false,
    });
    return;
  }

  _setExportState({
    phase: 'vev_exporting',
    vevTaskId: normalized.taskId || _exportState.vevTaskId,
    vevPayload: normalized,
    callbackDedupKey: key,
    callbackPosting: true,
    errorMsg: '',
  });

  try {
    const response = await _oeCtx?.apiPost?.('/api/online-editor/export-complete', {
      projectId: _oeCtx?.getProject?.()?.id,
      taskId: normalized.taskId,
      outputUrl: normalized.outputUrl,
      duration: normalized.duration,
      format: normalized.format,
    });
    if (requestVersion !== _exportState.stateVersion) return;

    if (response?.success && response?.exportId) {
      _persistExportId(response.exportId);
      _setExportState({
        exportId: response.exportId,
        phase: 'origin_waiting_download',
        status: response.status || 'completed',
        localDownloadStatus: response.vevDemo?.localDownloadStatus || 'pending',
        remoteUrl: response.vevDemo?.remoteUrl || normalized.outputUrl || null,
        remoteUrlExpiresAt: response.vevDemo?.remoteUrlExpiresAt || null,
        callbackPosting: false,
        errorMsg: '',
      });
      _oeCtx?.showToast?.('导出完成，正在下载到 Origin 本地', 'success');
      _startExportStatusPolling(response.exportId);
      return;
    }

    const message = response?.error || response?.message || 'Origin 未能确认导出回写结果';
    _setExportState({
      exportId: response?.exportId || null,
      phase: 'vev_export_failed',
      status: response?.status || 'failed',
      callbackPosting: false,
      errorMsg: message,
    });
    _oeCtx?.showToast?.(`导出回写异常: ${message}`, 'error');
  } catch (err) {
    if (requestVersion !== _exportState.stateVersion) return;
    console.error('[OnlineEditor] 导出回调失败:', err);
    _setExportState({
      phase: 'origin_callback_failed',
      callbackPosting: false,
      errorMsg: err?.message || 'Origin 回写失败',
    });
    _oeCtx?.showToast?.('导出已完成但 Origin 回写失败，可在状态卡片里重新回写', 'error');
  }
}

function _retryOriginCallback() {
  if (_exportState.callbackPosting) return;
  if (!_exportState.vevPayload) {
    _oeCtx?.showToast?.('没有可重新回写的 VevDemo 导出信息', 'warning');
    return;
  }
  _submitExportCallbackFromPayload(_exportState.vevPayload, _exportState.stateVersion);
}

async function _retryLocalDownload() {
  const exportId = _exportState.exportId;
  if (!exportId) {
    _oeCtx?.showToast?.('没有可重试的导出任务', 'warning');
    return;
  }
  if (_isRemoteUrlExpired(_exportState.remoteUrlExpiresAt)) {
    _setExportState({
      errorMsg: 'remote_url_expired',
      retrying: false,
    });
    _oeCtx?.showToast?.('远程下载地址已过期，请在 VevDemo 内重新导出', 'warning');
    return;
  }

  const version = _exportState.stateVersion;
  _refreshPersistedExportUpdatedAt();
  _setExportState({ retrying: true, errorMsg: '' });

  try {
    const response = await _oeCtx?.apiPost?.(`/api/online-editor/download/${encodeURIComponent(exportId)}/retry`, {});
    if (version !== _exportState.stateVersion) return;
    if (response?.success !== true) {
      _handleLocalRetryFailure(response?.detail || response?.error || response?.message || '重试下载失败');
      return;
    }
    _setExportState({
      phase: 'origin_waiting_download',
      localDownloadStatus: response?.localDownloadStatus || 'pending',
      retrying: false,
      errorMsg: '',
    });
    _oeCtx?.showToast?.('已重新提交本地下载', 'success');
    _startExportStatusPolling(exportId);
  } catch (err) {
    if (version !== _exportState.stateVersion) return;
    _handleLocalRetryFailure(err?.message || '重试下载失败', err?.status);
  }
}

function _handleLocalRetryFailure(detail, status) {
  const message = String(detail || '重试下载失败');
  if (status === 404 || /不存在/.test(message)) {
    _resetExportState();
    _oeCtx?.showToast?.('导出任务不存在，已清理本地状态', 'warning');
    return;
  }
  if (status === 409 || /过期|expired/i.test(message)) {
    _setExportState({
      phase: 'origin_download_failed',
      retrying: false,
      errorMsg: 'remote_url_expired',
    });
    _oeCtx?.showToast?.('远程下载地址已过期，请在 VevDemo 内重新导出', 'warning');
    return;
  }
  _setExportState({
    phase: 'origin_download_failed',
    retrying: false,
    errorMsg: message,
  });
  _oeCtx?.showToast?.(`重试下载失败: ${message}`, 'error');
}

function _requestVevDemoReexport() {
  if (_isVevDemoReady) {
    _sendToVevDemo('origin:requestExport', {
      reason: 'url_expired_need_reexport',
      previousExportId: _exportState.exportId || null,
      previousRemoteUrlExpiresAt: _exportState.remoteUrlExpiresAt || null,
    });
  }
  _oeCtx?.showToast?.('请在 VevDemo 中重新触发导出，完成后 Origin 会重新接收回写。', 'info');
}

// ============================================================================
// 公开方法：与 VevDemo 交互
// ============================================================================

/**
 * 同步 Origin 视频素材到 VevDemo。
 * 后端会优先补齐 VOD/EditMaterial binding；bridge 收到 vid:// 后会复用或创建 VevDemo 素材。
 * @param {string[]} resourceIds - 素材 ID 数组
 */
// 素材是否可送进 VevDemo：浏览器侧可达(签名直链) 或 已有云端源(vid:// / tos:// / directurl:// / editMid) 都算可用。
// 上传素材注册 VOD 后 browserReachable 仍为 false，但有 vevSource，必须放行，否则时间线拿不到它。
function _isVevUsableMaterial(item) {
  if (!item) return false;
  if (item.browserReachable !== false) return true;
  return Boolean(item.vevSource || item.vevEditMid || (item.vevCreatePayload && item.vevCreatePayload.Source));
}

function _assertVevMaterialsBelongToBoundProject(materials, source) {
  const list = Array.isArray(materials) ? materials : [];
  const targetProjectId = String(_vevDemoBoundVevProjectId || '').trim();
  if (!targetProjectId) {
    const err = new Error('VevDemo 项目绑定未确认，拒绝发送素材');
    err.code = 'vevdemo_binding_missing';
    err.source = source || '';
    throw err;
  }
  const mismatched = list.filter((item) => {
    const materialProjectId = String(item?.vevProjectId || '').trim();
    const payloadProjectId = String(item?.vevCreatePayload?.ProjectId || '').trim();
    return materialProjectId !== targetProjectId && payloadProjectId !== targetProjectId;
  });
  if (mismatched.length) {
    const err = new Error(`检测到 ${mismatched.length} 条素材不属于当前 VevDemo 工程，已取消同步`);
    err.code = 'vevdemo_material_project_mismatch';
    err.source = source || '';
    err.details = mismatched.map((item) => ({
      id: item?.id || item?.resourceId || item?.title || '',
      title: item?.title || item?.name || '',
      vevProjectId: item?.vevProjectId || '',
      payloadProjectId: item?.vevCreatePayload?.ProjectId || '',
      boundVevProjectId: targetProjectId,
    }));
    console.error('[OnlineEditor] VevDemo 素材工程归属不匹配:', err.details);
    throw err;
  }
  return list;
}

async function importMaterialsToVevDemo(resourceIds, options) {
  options = options || {};
  const silent = options.silent === true;
  if (!_isVevDemoReady) {
    if (!silent) _oeCtx?.showToast?.('VevDemo 未就绪', 'warning');
    return null;
  }
  if (!_isCurrentVevDemoProjectBindingReady()) {
    if (!silent) _oeCtx?.showToast?.('VevDemo 项目绑定未确认，暂不能同步素材，避免写入默认工程', 'warning');
    console.warn('[OnlineEditor] VevDemo 项目绑定未确认，拒绝同步素材:', {
      currentProjectId: _oeCtx?.getProject?.()?.id || '',
      boundOriginProjectId: _vevDemoBoundOriginProjectId,
      bindingReady: _vevDemoProjectBindingReady,
    });
    return null;
  }
  const ids = Array.isArray(resourceIds) && resourceIds.length > 0
    ? resourceIds
    : _collectCurrentVideoResourceIds();
  const bgmTrackIds = Array.isArray(options.bgmTrackIds)
    ? options.bgmTrackIds.filter(Boolean)
    : _collectCurrentBgmTrackIds();
  if (!ids.length && !bgmTrackIds.length) {
    if (!silent) _oeCtx?.showToast?.('当前项目没有可同步的视频素材或 BGM', 'warning');
    return null;
  }

  try {
    _setSyncMaterialsBusy(true);
    if (!silent) {
      _oeCtx?.showToast?.('首次同步会上传素材并等待转码，可能需要几分钟', 'info');
    }
    // 调用后端获取素材；缺少 binding 的视频任务会在服务端自动注册到 VOD/VevDemo。
    const payload = await _postMaterialImport({
      projectId: _oeCtx?.getProject?.()?.id,
      resourceIds: ids,
      bgmTrackIds,
    });
    const materials = Array.isArray(payload.materials) ? payload.materials : [];
    if (!materials.length) {
      if (!silent) _oeCtx?.showToast?.('没有找到可同步的视频素材', 'warning');
      return { materials: [], reachableMaterials: [], payload };
    }
    const reachableMaterials = materials.filter((item) => _isVevUsableMaterial(item));
    const skippedCount = materials.length - reachableMaterials.length;
    if (!silent && skippedCount > 0) {
      _oeCtx?.showToast?.(`${skippedCount} 条素材无法同步到 VevDemo（无云端源），已跳过`, 'warning');
    }
    if (!reachableMaterials.length) {
      if (!silent) _oeCtx?.showToast?.('没有可发送到 VevDemo 的素材', 'warning');
      return { materials, reachableMaterials: [], payload };
    }
    _assertVevMaterialsBelongToBoundProject(reachableMaterials, options.source || 'manual-import');

    // 发送到 VevDemo bridge：带 vevEditMid 的素材会直接复用；带 vid:// / tos:// / directurl:// 的素材会尝试注册。
    await _sendMaterialsToVevDemo(reachableMaterials);

    const shouldApplyTimeline = options.applyTimeline === true || (!silent && options.applyTimeline !== false);
    if (shouldApplyTimeline) {
      await _applyCurrentEdlTimelineToVevDemo(reachableMaterials);
    }

    console.log('[OnlineEditor] 同步素材到 VevDemo:', reachableMaterials.length);
    return { materials, reachableMaterials, payload };
  } catch (err) {
    console.error('[OnlineEditor] 同步素材失败:', err);
    if (!silent) _oeCtx?.showToast?.('同步素材失败: ' + err.message, 'error');
    return { error: err };
  } finally {
    _setSyncMaterialsBusy(false);
  }
}

function _sendMaterialsToVevDemo(materials) {
  return new Promise((resolve, reject) => {
    if (!_isVevDemoReady) {
      reject(new Error('VevDemo 未就绪'));
      return;
    }

    const itemCount = Array.isArray(materials) ? materials.length : 0;
    const timeoutMs = Math.min(
      OEV_MATERIAL_IMPORT_ACK_TIMEOUT_MAX_MS,
      Math.max(OEV_MATERIAL_IMPORT_ACK_TIMEOUT_MIN_MS, OEV_MATERIAL_IMPORT_ACK_TIMEOUT_PER_ITEM_MS * Math.max(1, itemCount)),
    );
    const timeout = setTimeout(() => {
      _messageHandlers.delete('vevdemo:materialsImported');
      reject(new Error(`未收到 VevDemo 素材同步回执（${Math.round(timeoutMs / 1000)} 秒超时），请检查 console`));
    }, timeoutMs);

    _messageHandlers.set('vevdemo:materialsImported', (data) => {
      clearTimeout(timeout);
      _messageHandlers.delete('vevdemo:materialsImported');
      _onMaterialsImported(data);
      resolve(data);
    });

    const sent = _sendToVevDemo('origin:importMaterials', { materials });
    if (!sent) {
      clearTimeout(timeout);
      _messageHandlers.delete('vevdemo:materialsImported');
      reject(new Error('发送素材同步消息失败'));
    }
  });
}

function _collectCurrentVideoResourceIds() {
  const edlIds = _collectCurrentEdlVideoResourceIds();
  if (edlIds.length) return edlIds;

  const project = _oeCtx?.getProject?.();
  const ids = new Set();
  const addFromUrl = (url) => {
    const match = _ORIGIN_VIDEO_ID_RE.exec(String(url || ''));
    if (match && match[1]) ids.add(decodeURIComponent(match[1]));
  };
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  storyboards.forEach((sb) => {
    addFromUrl(sb?._originVideoUrl);
    addFromUrl(sb?.protectedUrl);
    addFromUrl(sb?.videoUrl);
  });
  const tasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  tasks.forEach((task) => {
    addFromUrl(task?.protectedUrl);
    addFromUrl(task?.videoUrl);
    addFromUrl(task?.url);
    if (task?.id && /^[a-zA-Z0-9-]{16,}$/.test(String(task.id))) ids.add(String(task.id));
    if (task?.serverTaskId && /^[a-zA-Z0-9-]{16,}$/.test(String(task.serverTaskId))) ids.add(String(task.serverTaskId));
  });
  return Array.from(ids);
}

function _collectCurrentEdlVideoResourceIds() {
  const project = _oeCtx?.getProject?.();
  const edl = project?.editData?.edl;
  const timeline = Array.isArray(edl?.timeline) ? edl.timeline : [];
  const ids = new Set();
  const addId = (value) => {
    const text = String(value || '').trim();
    if (text) ids.add(text);
  };
  const addFromUrl = (url) => {
    const match = _ORIGIN_VIDEO_ID_RE.exec(String(url || ''));
    if (match && match[1]) ids.add(decodeURIComponent(match[1]));
  };
  timeline.forEach((entry) => {
    if (!entry) return;
    if (entry._isExternalMedia === true) return;
    let hasEntryResource = false;
    const addEntryId = (value) => {
      addId(value);
      hasEntryResource = hasEntryResource || Boolean(String(value || '').trim());
    };
    const addEntryFromUrl = (url) => {
      const match = _ORIGIN_VIDEO_ID_RE.exec(String(url || ''));
      addFromUrl(url);
      hasEntryResource = hasEntryResource || Boolean(match && match[1]);
    };
    addEntryId(entry.clipId);
    addEntryId(entry.videoTaskId);
    addEntryId(entry.mediaId);
    addEntryId(entry.resourceId);
    addEntryFromUrl(entry.videoUrl);
    addEntryFromUrl(entry.protectedUrl);
    addEntryFromUrl(entry._originVideoUrl);
    if (!hasEntryResource && Number.isInteger(Number(entry.groupIdx))) {
      addId(_currentVideoTaskIdForGroup(Number(entry.groupIdx)));
    }
  });
  return Array.from(ids);
}

function _collectCurrentBgmTrackIds() {
  const project = _oeCtx?.getProject?.();
  const bgm = project?.editData?.edl?.bgm;
  if (!bgm || bgm.enabled !== true) return [];
  const trackId = String(bgm.trackId || '').trim();
  return trackId ? [trackId] : [];
}

function _currentVideoTaskIdForGroup(groupIdx) {
  const project = _oeCtx?.getProject?.();
  if (!project || !Number.isInteger(Number(groupIdx))) return '';
  const gi = Number(groupIdx);
  const sb = Array.isArray(project.storyboards) ? project.storyboards[gi] : null;
  const vt = Array.isArray(project.videoTasks) ? project.videoTasks[gi] : null;
  const extract = (url) => {
    const match = _ORIGIN_VIDEO_ID_RE.exec(String(url || ''));
    return match && match[1] ? decodeURIComponent(match[1]) : '';
  };
  return String(
    sb?.videoTaskId ||
    vt?.taskId ||
    vt?.serverTaskId ||
    vt?.id ||
    extract(sb?.videoUrl || sb?._originVideoUrl) ||
    extract(vt?.url || vt?.videoUrl || vt?.protectedUrl) ||
    ''
  ).trim();
}

function _stableVevSyncStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(_stableVevSyncStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${_stableVevSyncStringify(value[key])}`
  )).join(',')}}`;
}

function _roundVevSyncSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(Math.max(0, n) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

async function _sha256Hex(text) {
  const input = String(text || '');
  try {
    if (window.crypto?.subtle && window.TextEncoder) {
      const bytes = new TextEncoder().encode(input);
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (err) {
    console.warn('[OnlineEditor] crypto.subtle digest failed, falling back to lightweight hash:', err);
  }
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function _computeCurrentEdlVideoSyncSignature(ids, bgmTrackIds) {
  const project = _oeCtx?.getProject?.();
  const edl = project?.editData?.edl;
  const timeline = Array.isArray(edl?.timeline) ? edl.timeline : [];
  const bgm = edl?.bgm && typeof edl.bgm === 'object' ? edl.bgm : null;
  const payload = {
    version: 1,
    projectId: project?.id || '',
    edlVersion: Number(edl?.version) || 0,
    videoIds: Array.from(new Set(ids || [])).sort(),
    bgm: {
      enabled: Boolean(bgm && bgm.enabled === true && bgm.trackId),
      trackIds: Array.from(new Set(bgmTrackIds || [])).sort(),
      offsetTime: _roundVevSyncSec(bgm?.offsetTime),
    },
    items: timeline.map((entry) => ({
      clipId: String(entry?.clipId || entry?.videoTaskId || entry?.mediaId || entry?.resourceId || '').trim(),
      groupIdx: Number.isInteger(Number(entry?.groupIdx)) ? Number(entry.groupIdx) : null,
      inSec: _roundVevSyncSec(entry?.inPoint ?? entry?.in ?? 0),
      outSec: _roundVevSyncSec(entry?.outPoint ?? entry?.out ?? entry?.duration ?? 0),
      transitionInType: String(entry?.transitionIn?.type || entry?.transitionIn || 'cut').trim().toLowerCase() || 'cut',
      transitionOutType: String(entry?.transitionOut?.type || entry?.transitionOut || 'cut').trim().toLowerCase() || 'cut',
    })),
  };
  return `vev-material-sync-v1:${await _sha256Hex(_stableVevSyncStringify(payload))}`;
}

function _autoVideoSyncStorageKey(signature) {
  const project = _oeCtx?.getProject?.();
  return `${OEV_AUTO_VIDEO_SYNC_STORAGE_PREFIX}:${project?.id || 'no-project'}:${signature}`;
}

async function _autoSyncCurrentEdlVideosToVevDemo() {
  if (!_isVevDemoReady) return null;
  if (!_isCurrentVevDemoProjectBindingReady()) {
    console.warn('[OnlineEditor] VevDemo 项目绑定未就绪，跳过自动同步/铺轨:', {
      currentProjectId: _oeCtx?.getProject?.()?.id || '',
      boundOriginProjectId: _vevDemoBoundOriginProjectId,
      bindingReady: _vevDemoProjectBindingReady,
    });
    return null;
  }
  if (_vevDemoAutoVideoSyncInFlight) return _vevDemoAutoVideoSyncInFlight;

  const ids = _collectCurrentEdlVideoResourceIds();
  const bgmTrackIds = _collectCurrentBgmTrackIds();
  if (!ids.length && !bgmTrackIds.length) {
    console.log('[OnlineEditor] 当前 EDL 没有可自动同步的视频素材或 BGM');
    return null;
  }

  const signature = await _computeCurrentEdlVideoSyncSignature(ids, bgmTrackIds);
  const storageKey = _autoVideoSyncStorageKey(signature);
  try {
    if (_lastVevDemoAutoVideoSyncSignature === signature || window.sessionStorage?.getItem(storageKey) === 'ok') {
      console.log('[OnlineEditor] 跳过重复 EDL 视频自动同步:', signature);
      const payload = await _postMaterialImport({
        projectId: _oeCtx?.getProject?.()?.id,
        resourceIds: ids,
        bgmTrackIds,
        autoRegister: false,
      });
      const materials = Array.isArray(payload?.materials)
        ? payload.materials.filter((item) => _isVevUsableMaterial(item))
        : [];
      if (materials.length) {
        const scopedMaterials = _assertVevMaterialsBelongToBoundProject(materials, 'auto-edl-reuse');
        await _applyCurrentEdlTimelineToVevDemo(scopedMaterials);
        return null;
      }
      console.warn('[OnlineEditor] 已有自动同步标记但未找到可用 VevDemo binding，重新执行完整同步:', signature);
      try { window.sessionStorage?.removeItem(storageKey); } catch (_) {}
    }
  } catch (err) {
    console.warn('[OnlineEditor] 自动同步复用 binding 失败，改走完整同步:', err);
  }

  _vevDemoAutoVideoSyncInFlight = (async () => {
    const result = await importMaterialsToVevDemo(ids, {
      silent: true,
      source: 'auto-edl-material',
      bgmTrackIds,
      applyTimeline: false,
    });
    if (result?.error) throw result.error;
    if (Array.isArray(result?.reachableMaterials) && result.reachableMaterials.length > 0) {
      _lastVevDemoAutoVideoSyncSignature = signature;
      try { window.sessionStorage?.setItem(storageKey, 'ok'); } catch (_) {}
      console.log('[OnlineEditor] 当前 EDL 视频已自动同步到 VevDemo:', {
        count: result.reachableMaterials.length,
        videoCount: ids.length,
        bgmCount: bgmTrackIds.length,
        signature,
      });
      await _applyCurrentEdlTimelineToVevDemo(result.reachableMaterials);
    }
    return result;
  })();

  try {
    return await _vevDemoAutoVideoSyncInFlight;
  } catch (err) {
    console.warn('[OnlineEditor] 当前 EDL 视频自动同步失败，可使用手动同步重试:', err);
    return { error: err };
  } finally {
    _vevDemoAutoVideoSyncInFlight = null;
  }
}

function _materialMapById(materials) {
  const map = new Map();
  (Array.isArray(materials) ? materials : []).forEach((material) => {
    const id = String(material?.id || '').trim();
    if (id) map.set(id, material);
  });
  return map;
}

function _resolveEdlEntryVideoTaskId(entry) {
  if (!entry || entry._isExternalMedia === true) return '';
  const direct = String(entry.clipId || entry.videoTaskId || entry.mediaId || entry.resourceId || '').trim();
  if (direct) return direct;
  const extract = (url) => {
    const match = _ORIGIN_VIDEO_ID_RE.exec(String(url || ''));
    return match && match[1] ? decodeURIComponent(match[1]) : '';
  };
  return (
    extract(entry.videoUrl) ||
    extract(entry.protectedUrl) ||
    extract(entry._originVideoUrl) ||
    (Number.isInteger(Number(entry.groupIdx)) ? _currentVideoTaskIdForGroup(Number(entry.groupIdx)) : '')
  );
}

function _buildCurrentVevTimelinePlan(materials) {
  const project = _oeCtx?.getProject?.();
  const edl = project?.editData?.edl;
  const timeline = Array.isArray(edl?.timeline) ? edl.timeline : [];
  if (!project?.id || !timeline.length) return null;

  const materialMap = _materialMapById(materials);
  const entries = [];
  const missingItems = [];
  let cursorSec = 0;
  timeline.forEach((entry, index) => {
    const resourceId = _resolveEdlEntryVideoTaskId(entry);
    const material = resourceId ? materialMap.get(resourceId) : null;
    const source = String(material?.vevSource || material?.source || material?.vevCreatePayload?.Source || '').trim();
    if (!resourceId || !source) {
      missingItems.push({
        index,
        groupIdx: Number.isInteger(Number(entry?.groupIdx)) ? Number(entry.groupIdx) : null,
        resourceId,
        reason: resourceId ? 'missing_vev_source' : (entry?._isExternalMedia === true ? 'external_media_not_registered' : 'missing_resource_id'),
      });
      return;
    }
    const inSec = _roundVevSyncSec(entry?.inPoint ?? entry?.in ?? 0);
    let outSec = Number(entry?.outPoint ?? entry?.out);
    if (!Number.isFinite(outSec) || outSec <= inSec) {
      outSec = Number(entry?.duration) > 0 ? inSec + Number(entry.duration) : inSec;
    }
    outSec = _roundVevSyncSec(outSec);
    const durationSec = Math.max(0.1, outSec - inSec);
    const transitionIn = entry?.transitionIn && typeof entry.transitionIn === 'object'
      ? entry.transitionIn
      : { type: entry?.transitionIn || 'cut', duration: 0 };
    const transitionOut = entry?.transitionOut && typeof entry.transitionOut === 'object'
      ? entry.transitionOut
      : { type: entry?.transitionOut || 'cut', duration: 0 };
    entries.push({
      index,
      resourceId,
      source,
      editMid: material?.vevEditMid || '',
      type: 'video',
      groupIdx: Number.isInteger(Number(entry?.groupIdx)) ? Number(entry.groupIdx) : null,
      inSec,
      outSec,
      durationSec,
      targetStartSec: cursorSec,
      targetEndSec: cursorSec + durationSec,
      transitionIn: {
        type: String(transitionIn?.type || 'cut').trim().toLowerCase() || 'cut',
        durationSec: _roundVevSyncSec(transitionIn?.duration),
      },
      transitionOut: {
        type: String(transitionOut?.type || 'cut').trim().toLowerCase() || 'cut',
        durationSec: _roundVevSyncSec(transitionOut?.duration),
      },
    });
    cursorSec += durationSec;
  });

  if (missingItems.length) {
    return {
      ok: false,
      code: 'missing_materials',
      message: `${missingItems.length} 段素材还没同步到 VevDemo，已取消自动铺轨`,
      missingTimelineItems: missingItems,
    };
  }

  if (!entries.length) return null;

  const bgm = edl?.bgm && typeof edl.bgm === 'object' ? edl.bgm : null;
  const bgmTrackId = bgm && bgm.enabled === true ? String(bgm.trackId || '').trim() : '';
  const bgmMaterial = bgmTrackId ? materialMap.get(bgmTrackId) : null;
  const bgmSource = String(bgmMaterial?.vevSource || bgmMaterial?.source || bgmMaterial?.vevCreatePayload?.Source || '').trim();

  return {
    projectId: project.id,
    edlVersion: Number(edl?.version) || 0,
    totalDurationSec: cursorSec,
    video: entries,
    bgm: bgmTrackId && bgmSource ? {
      resourceId: bgmTrackId,
      source: bgmSource,
      editMid: bgmMaterial?.vevEditMid || '',
      offsetSec: _roundVevSyncSec(bgm?.offsetTime),
      volume: 0.32,
    } : null,
  };
}

function _sendTimelinePlanToVevDemo(plan) {
  return new Promise((resolve, reject) => {
    if (!_isVevDemoReady) {
      const error = new Error('VevDemo 未就绪');
      error.code = 'vevdemo_not_ready';
      error.reason = 'bridge_not_ready';
      reject(error);
      return;
    }

    const timeout = setTimeout(() => {
      _messageHandlers.delete('vevdemo:timelineApplied');
      const error = new Error('未收到 VevDemo 时间线铺轨回执');
      error.code = 'timeline_apply_timeout';
      error.reason = 'ack_timeout';
      reject(error);
    }, 15000);

    _messageHandlers.set('vevdemo:timelineApplied', (data) => {
      clearTimeout(timeout);
      _messageHandlers.delete('vevdemo:timelineApplied');
      if (data?.ok === false) {
        const error = new Error(data?.error || 'VevDemo 时间线铺轨失败');
        error.code = data?.code || '';
        error.reason = data?.reason || '';
        error.details = data?.details || null;
        error.raw = data || null;
        reject(error);
        return;
      }
      resolve(data);
    });

    const sent = _sendToVevDemo('origin:applyTimeline', { plan });
    if (!sent) {
      clearTimeout(timeout);
      _messageHandlers.delete('vevdemo:timelineApplied');
      const error = new Error('发送时间线铺轨消息失败');
      error.code = 'timeline_apply_send_failed';
      error.reason = 'post_message_failed';
      reject(error);
    }
  });
}

function _normalizeVevTimelineApplyError(err) {
  const raw = err?.raw && typeof err.raw === 'object' ? err.raw : {};
  return {
    code: String(err?.code || raw.code || '').trim(),
    reason: String(err?.reason || raw.reason || '').trim(),
    details: err?.details || raw.details || null,
    message: String(err?.message || raw.error || 'VevDemo 时间线铺轨失败').trim(),
    raw,
  };
}

function _isVevTimelineTimeUnitError(meta) {
  if (meta?.code === 'timeline_time_unit') return true;
  return [
    'track_timing_does_not_match_plan',
    'ambiguous_track_timing_scores',
    'ambiguous_track_timing',
    'no_track_sample',
    'no_significant_timing_value',
    'origin_written_track_not_trusted',
    'unverified',
  ].includes(String(meta?.reason || '').trim());
}

function _isVevTimelineSetupTimeUnitError(meta) {
  return [
    'no_track_sample',
    'no_significant_timing_value',
    'origin_written_track_not_trusted',
    'unverified',
  ].includes(String(meta?.reason || '').trim());
}

function _formatVevTimelineApplyToast(meta) {
  if (_isVevTimelineTimeUnitError(meta)) {
    if (_isVevTimelineSetupTimeUnitError(meta)) {
      return '请先在 VevDemo 手动拖入一段样本素材，确认时间单位后再自动铺轨';
    }
    return 'VevDemo 时间单位存在冲突，已暂停自动铺轨，避免时间线错乱';
  }
  const code = String(meta?.code || '').trim();
  const reason = String(meta?.reason || '').trim();
  const messages = {
    vevdemo_not_ready: 'VevDemo 尚未就绪，请等待连接完成后再铺轨',
    timeline_apply_timeout: 'VevDemo 时间线铺轨超时，未收到回执，请稍后重试',
    timeline_apply_send_failed: 'VevDemo 铺轨消息发送失败，请检查连接后重试',
    timeline_project_not_ready: 'VevDemo 工程尚未完成绑定，已取消自动铺轨',
    timeline_plan_empty: '当前没有可铺到 VevDemo 的时间线内容，已取消自动铺轨',
    timeline_track_empty: '没有生成有效的视频轨道，已取消自动铺轨',
  };
  const reasonMessages = {
    bridge_not_ready: messages.vevdemo_not_ready,
    ack_timeout: messages.timeline_apply_timeout,
    post_message_failed: messages.timeline_apply_send_failed,
    project_not_ready: messages.timeline_project_not_ready,
    plan_empty: messages.timeline_plan_empty,
    track_empty: messages.timeline_track_empty,
  };
  return messages[code] || reasonMessages[reason] || 'VevDemo 时间线铺轨失败，请稍后重试';
}

function _vevTimelineApplyToastType(meta) {
  if (_isVevTimelineSetupTimeUnitError(meta)) return 'warning';
  return 'error';
}

function _showVevTimelineApplyToast(meta) {
  const message = _formatVevTimelineApplyToast(meta);
  const type = _vevTimelineApplyToastType(meta);
  const key = `${type}:${meta?.code || ''}:${meta?.reason || ''}:${message}`;
  const now = Date.now();
  if (_lastVevTimelineApplyToastKey === key && now - _lastVevTimelineApplyToastAt < OEV_TIMELINE_APPLY_TOAST_DEDUP_MS) {
    return;
  }
  _lastVevTimelineApplyToastKey = key;
  _lastVevTimelineApplyToastAt = now;
  _oeCtx?.showToast?.(message, type);
}

async function _applyCurrentEdlTimelineToVevDemo(materials) {
  const plan = _buildCurrentVevTimelinePlan(materials);
  if (plan?.ok === false) {
    console.warn('[OnlineEditor] VevDemo 时间线铺轨已拦截:', plan);
    _oeCtx?.showToast?.(plan.message || '部分素材还没准备好，已取消自动铺轨', 'warning');
    return { blocked: true, plan };
  }
  if (!plan) {
    console.log('[OnlineEditor] 当前 EDL 没有可铺到 VevDemo 的 timeline plan');
    return null;
  }
  try {
    const result = await _sendTimelinePlanToVevDemo(plan);
    console.log('[OnlineEditor] VevDemo 时间线铺轨完成:', result);
    return result;
  } catch (err) {
    console.warn('[OnlineEditor] VevDemo 时间线铺轨未完成:', err);
    const meta = _normalizeVevTimelineApplyError(err);
    _showVevTimelineApplyToast(meta);
    return { error: err };
  }
}

/**
 * 触发导出
 * @param {Object} options - 导出选项
 */
function triggerExport(options = {}) {
  if (!_isVevDemoReady) {
    _oeCtx?.showToast?.('VevDemo 未就绪', 'warning');
    return;
  }

  _sendToVevDemo('origin:triggerExport', {
    format: options.format || 'mp4',
    quality: options.quality || 'high',
    callbackUrl: `${window.location.origin}/api/online-editor/export-complete`,
  });

  _oeCtx?.showToast?.('正在导出...', 'info');
}

/**
 * 获取时间线数据
 * @returns {Promise} 时间线数据
 */
function requestTimelineData() {
  return new Promise((resolve, reject) => {
    if (!_isVevDemoReady) {
      reject(new Error('VevDemo 未就绪'));
      return;
    }

    const timeout = setTimeout(() => {
      _messageHandlers.delete('vevdemo:timelineData');
      reject(new Error('获取时间线超时'));
    }, 5000);

    _messageHandlers.set('vevdemo:timelineData', (data) => {
      clearTimeout(timeout);
      _messageHandlers.delete('vevdemo:timelineData');
      resolve(data);
    });

    _sendToVevDemo('origin:getTimeline', {});
  });
}

// ============================================================================
// 导出到 ffmpeg（降级方案）
// ============================================================================

/**
 * 将 VevDemo 时间线转换为 EDL 格式并导出到 ffmpeg
 */
async function exportToFfmpeg() {
  if (!_isVevDemoReady) {
    _oeCtx?.showToast?.('VevDemo 未就绪', 'warning');
    return;
  }

  try {
    // 获取时间线数据
    const timeline = await requestTimelineData();

    // 转换为 EDL 格式
    const edl = _convertTimelineToEDL(timeline);

    // 调用现有 ffmpeg 导出 API
    const res = await _oeCtx?.apiPost?.('/api/edit/export', {
      projectId: _oeCtx?.getProject?.()?.id,
      edl,
    });

    if (res?.ok) {
      const result = await res.json();
      _oeCtx?.showToast?.('已提交到 ffmpeg 导出队列', 'success');
      return result;
    } else {
      throw new Error('提交导出失败');
    }
  } catch (err) {
    console.error('[OnlineEditor] ffmpeg 导出失败:', err);
    _oeCtx?.showToast?.('导出失败: ' + err.message, 'error');
  }
}

/**
 * 将 VevDemo 时间线格式转换为 EDL 格式
 */
function _convertTimelineToEDL(timeline) {
  if (!timeline || !Array.isArray(timeline.tracks)) {
    return [];
  }

  const edl = [];
  for (const track of timeline.tracks) {
    if (track.type !== 'video') continue;

    for (const clip of track.clips || []) {
      edl.push({
        clipId: clip.mediaId,
        videoUrl: clip.url,
        inPoint: clip.inPoint || 0,
        outPoint: clip.outPoint || clip.duration,
        duration: clip.duration,
        groupIdx: clip.groupIdx,
        transitionIn: clip.transition?.type || 'cut',
      });
    }
  }

  return edl;
}

// ============================================================================
// 设置引导
// ============================================================================

function _showSetupGuide(message, state, missingKeys) {
  const container = document.getElementById('oeEditorContainer');
  if (!container) return;
  state = state || 'missing_config';
  missingKeys = Array.isArray(missingKeys) ? missingKeys : [];
  const stateMap = {
    disabled: {
      title: '在线精修剪辑器未启用',
      intro: message || '当前环境关闭了在线精修入口，请在 Origin 配置中启用后再使用。',
      icon: 'power_settings_new',
      statusVariant: 'muted',
      statusText: '未启用',
    },
    missing_config: {
      title: '视频剪辑服务未配置',
      intro: message || '请先配置 VevDemo 服务。',
      icon: 'settings_alert',
      statusVariant: 'error',
      statusText: '未配置',
    },
    load_failed: {
      title: '视频剪辑服务加载失败',
      intro: message || '请检查 VevDemo 服务、iframe 地址与 CSP frame-src 配置。',
      icon: 'sync_problem',
      statusVariant: 'error',
      statusText: '连接失败',
    },
    binding_failed: {
      title: 'VevDemo 工程隔离未就绪',
      intro: message || '当前 Origin 项目未绑定到独立 VevDemo 工程，已阻止进入默认工程。',
      icon: 'lock',
      statusVariant: 'error',
      statusText: '工程未绑定',
    },
    tab_only: {
      title: '在线精修配置为新标签页模式',
      intro: message || '当前配置为新标签页打开，请从剪辑页入口进入 VevDemo。',
      icon: 'open_in_new',
      statusVariant: 'muted',
      statusText: '新标签页',
    },
  };
  const copy = stateMap[state] || stateMap.missing_config;
  _setConnectionStatus(copy.statusVariant, copy.statusText);
  const introSuffix = (state === 'disabled' || state === 'missing_config')
    ? ' 修改配置后请刷新页面。'
    : '';
  const introText = `${copy.intro}${introSuffix}`;
  const missingHtml = missingKeys.length
    ? `<p>缺少配置项：${missingKeys.map(_escapeOnlineEditorHtml).join(', ')}</p>`
    : '';
  let actionHtml = '';
  if (state === 'disabled' || state === 'tab_only') {
    actionHtml = `
      <button type="button" data-goto="edit" class="oe-sync-btn">
        <span class="material-symbols-outlined">arrow_back</span>
        返回剪辑页
      </button>`;
  } else if (state === 'load_failed' || state === 'binding_failed') {
    actionHtml = `
      <button type="button" data-oe-retry-connect class="oe-sync-btn">
        <span class="material-symbols-outlined">refresh</span>
        重试连接
      </button>`;
  } else {
    actionHtml = `
      <button type="button" data-oe-reload-config class="oe-sync-btn">
        <span class="material-symbols-outlined">refresh</span>
        重新读取配置
      </button>`;
  }

  container.innerHTML = `
    <div class="oe-editor-empty-state">
      <span class="material-symbols-outlined">${copy.icon}</span>
      <h2>${_escapeOnlineEditorHtml(copy.title)}</h2>
      <p>${_escapeOnlineEditorHtml(introText)}</p>
      ${missingHtml}
      <div class="mt-4">${actionHtml}</div>
    </div>
	  `;

  const retryButton = container.querySelector('[data-oe-retry-connect]');
  if (retryButton) {
    retryButton.addEventListener('click', (event) => {
      event.preventDefault();
      _retryVevDemoConnection({ manual: true });
    });
  }
  const reloadButton = container.querySelector('[data-oe-reload-config]');
  if (reloadButton) {
    reloadButton.addEventListener('click', (event) => {
      event.preventDefault();
      location.reload();
    });
  }
}

function _escapeOnlineEditorHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _showEditorDiagnostic(message, detail) {
  const container = document.getElementById('oeEditorContainer');
  if (!container) return;

  let diagnostic = document.getElementById('oeVevDiagnostic');
  if (!diagnostic) {
    diagnostic = document.createElement('div');
    diagnostic.id = 'oeVevDiagnostic';
    diagnostic.className = 'absolute left-4 right-4 top-4 z-20 rounded-xl border border-amber-400/30 bg-[#171006]/92 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl';
    container.appendChild(diagnostic);
  }

  diagnostic.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="material-symbols-outlined text-amber-300 text-lg mt-0.5">info</span>
      <div class="min-w-0">
        <p class="text-sm text-amber-100">${message}</p>
        <p class="text-xs text-amber-100/60 mt-1">${detail || ''}</p>
      </div>
    </div>
  `;
}

// ============================================================================
// 内部事件绑定（保留占位 UI 的交互）
// ============================================================================

function _bindToolbarEvents() {
  const toolbarBtns = document.querySelectorAll('.oe-toolbar-btn');
  toolbarBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      console.log(`[OnlineEditor] 工具栏按钮点击: ${tool}`);
    });
  });

  // 导出按钮
  const exportBtn = document.getElementById('oeBtnExport');
  if (exportBtn) {
    exportBtn.hidden = true;
    exportBtn.disabled = true;
    exportBtn.setAttribute('aria-hidden', 'true');
  }
}

function _bindMediaPanelEvents() {
  const mediaTabs = document.querySelectorAll('.oe-media-tab');
  mediaTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      mediaTabs.forEach(t => t.classList.remove('oe-media-tab--active'));
      tab.classList.add('oe-media-tab--active');
      const category = tab.dataset.cat;
      console.log(`[OnlineEditor] 素材分类切换: ${category}`);
      refreshMediaList();
    });
  });

  const mediaItems = document.querySelectorAll('.oe-media-item');
  mediaItems.forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      const name = item.querySelector('.oe-media-name')?.textContent;
      console.log(`[OnlineEditor] 素材点击: ${name} (${type})`);
    });
  });
}

function _bindInspectorEvents() {
  const inspectorTabs = document.querySelectorAll('.oe-inspector-tab');
  inspectorTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      inspectorTabs.forEach(t => t.classList.remove('oe-inspector-tab--active'));
      tab.classList.add('oe-inspector-tab--active');
      console.log(`[OnlineEditor] 属性面板切换: ${tab.dataset.tab}`);
    });
  });
}

function _bindTimelineEvents() {
  const undoBtn = document.getElementById('oeUndoBtn');
  const redoBtn = document.getElementById('oeRedoBtn');

  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      console.log('[OnlineEditor] 撤销');
      if (_isVevDemoReady) {
        _sendToVevDemo('origin:undo', {});
      }
    });
  }

  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      console.log('[OnlineEditor] 重做');
      if (_isVevDemoReady) {
        _sendToVevDemo('origin:redo', {});
      }
    });
  }
}

function _bindPreviewEvents() {
  const playBtn = document.getElementById('oePlayBtn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      console.log('[OnlineEditor] 播放按钮点击');
      if (_isVevDemoReady) {
        _sendToVevDemo('origin:togglePlayback', {});
      }
    });
  }
}

function _setOnlineEditorControlsReady(ready) {
  const syncBtn = document.getElementById('oeBtnSyncMaterials');
  if (!syncBtn) return;
  syncBtn.hidden = !ready;
  syncBtn.disabled = !ready;
  const syncHint = document.getElementById('oeSyncHint');
  if (syncHint) syncHint.hidden = !ready;
  _renderSyncMaterialsButtonLabel(false);
  syncBtn.onclick = ready
    ? (event) => {
        event.preventDefault();
        importMaterialsToVevDemo();
      }
    : null;
}

function _setSyncMaterialsBusy(busy) {
  const syncBtn = document.getElementById('oeBtnSyncMaterials');
  if (!syncBtn) return;
  syncBtn.disabled = !!busy;
  _renderSyncMaterialsButtonLabel(busy);
}

function _renderSyncMaterialsButtonLabel(busy) {
  const syncBtn = document.getElementById('oeBtnSyncMaterials');
  if (!syncBtn) return;
  syncBtn.innerHTML = `
    <span class="material-symbols-outlined ${busy ? 'animate-spin' : ''}">sync</span>
    <span>${busy ? '同步中' : '同步素材'}</span>
  `;
}

// ============================================================================
// 导出处理
// ============================================================================

function _handleExport() {
  _oeCtx?.showToast?.('P0 阶段请在 VevDemo 编辑器内部触发导出，Origin 只负责展示导出状态。', 'info');
}

// ============================================================================
// 模块导出
// ============================================================================

export {
  initOnlineEditor,
  mountOnlineEditor,
  onOnlineEditorPageEnter,
  destroyOnlineEditor,
  refreshMediaList,
  initTimeline,
  getOnlineEditorState,
  restoreOnlineEditorState,
  importMaterialsToVevDemo,
  triggerExport,
  exportToFfmpeg,
  requestTimelineData,
  syncOnlineEditorProjectTitle,
};
