/**
 * Shared utilities — extracted from main.js (stage 1 refactor).
 * All functions are pure or DOM-only with no dependency on app state.
 */

// ── Auth ──────────────────────────────────────────────────────────────────

export function getAuthToken() {
  try {
    return localStorage.getItem('sw_auth_token') || '';
  } catch (_e) {
    return '';
  }
}

export function getAuthHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const t = getAuthToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

export function checkAuth(resp) {
  if (resp.status === 401) {
    try {
      localStorage.removeItem('sw_auth_token');
      localStorage.removeItem('sw_auth_user');
    } catch (_e) {}
    window.location.href = '/?auth=1';
    throw new Error('认证已过期，请重新登录');
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function _diagnoseHttpHtml(status) {
  if (status === 502) return '服务器网关错误（502），后端服务可能未启动，请联系管理员';
  if (status === 503) return '服务暂时不可用（503），服务器可能正在重启，请稍后重试';
  if (status === 504) return '请求超时，请稍后重试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return '请求失败（' + status + '），请检查网络连接';
}

async function _safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch (_) {
    if (!resp.ok && text.trim().charAt(0) === '<') throw new Error(_diagnoseHttpHtml(resp.status));
    throw new Error(resp.ok ? '服务器返回了无效数据' : '服务器错误 (' + resp.status + ')');
  }
}

// 维护模式 soft-block 名单：这里列的 path 一旦命中、且用户未确认"已知风险
// 继续使用"，apiPost 会在发出请求前直接 reject 掉。`/api/images/submit` 虽然
// 在前端业务代码里已被 Phase 3-B-8 淘汰，但保留在这张名单里做兼容兜底——
// 万一老版缓存还在 fire，这里仍能维护期生效。
const _SOFT_BLOCKED_PATHS = {
  '/api/images/submit': 1, // arch-guard:allow-endpoint
  '/api/video/submit': 1,
  '/api/edit/export': 1,
};

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.status = status || 0;
    this.payload = payload || null;
    this.errorCode = payload && payload.errorCode ? payload.errorCode : '';
    this.billing = payload && payload.billing ? payload.billing : null;
  }
}

export async function apiPost(path, body, method) {
  method = method || 'POST';
  if (method === 'POST' && _SOFT_BLOCKED_PATHS[path] && typeof window.maintenanceSoftBlock === 'function') {
    if (!window.maintenanceSoftBlock()) throw new Error('系统即将维护，请稍后再开始新任务');
  }
  const resp = await fetch(path, { method, headers: getAuthHeaders(), body: JSON.stringify(body) });
  checkAuth(resp);
  const data = await _safeJson(resp);
  if (data.error) throw new ApiError(data.error, resp.status, data);
  return data;
}

export async function apiGet(path) {
  const resp = await fetch(path, { headers: getAuthHeaders(), cache: 'no-store' });
  checkAuth(resp);
  const data = await _safeJson(resp);
  if (data.error) throw new ApiError(data.error, resp.status, data);
  return data;
}

/**
 * 对外错误文案一刀切：任何生成类失败，用户只看到「生成失败，请稍后重试」。
 * 真实原因只写入 console.debug 给开发排查，不暴露给用户。
 */
export function friendlyModelError(rawMsg) {
  const msg = String(rawMsg || '').trim();
  try { if (msg) console.debug('[friendlyModelError] raw:', msg); } catch (_e) {}
  return '生成失败，请稍后重试';
}

export async function apiPostStream(path, body, onChunk, onEvent) {
  const resp = await fetch(path, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) });
  checkAuth(resp);
  if (!resp.ok) {
    const text = await resp.text();
    if (text.trim().charAt(0) === '<') throw new Error(_diagnoseHttpHtml(resp.status));
    throw new Error('生成失败，请稍后重试');
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalData = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (onEvent) {
          try { onEvent(evt); } catch (_e) { /* ignore listener errors */ }
        }
        if (evt.type === 'chunk' && onChunk) onChunk(evt.content || '');
        else if (evt.type === 'done') finalData = evt;
        else if (evt.type === 'error') throw new Error(friendlyModelError(evt.error));
      } catch (parseErr) {
        if (parseErr.message && !parseErr.message.startsWith('Unexpected')) throw parseErr;
      }
    }
  }
  if (!finalData) throw new Error('生成失败，请稍后重试');
  return finalData;
}

// Phase 3-B-8：apiImageGenerate / _pollImageFallback 整条「前端自持提交+轮询」
// 链路已废弃。所有走 /api/images/submit + /api/images/poll 的单张图请求
// （单资产、批量资产、变体场景、单/批分镜图）全部改走
// POST /api/batch/start + subscribeBatch，由 services/batch_runner 统一调度。
// 这里仅保留注释占位，勿复活。

const _assetUrlCache = new Map();

export async function fetchAssetSignedUrl(assetId, ttl) {
  assetId = (assetId || '').trim();
  ttl = ttl || 3600;
  if (!assetId) return '';
  var now = Date.now();
  var cached = _assetUrlCache.get(assetId);
  if (cached && cached.url && cached.expiresAt > now + 5000) return cached.url;
  // Phase 5.9 bugfix：单条签名 URL 请求必须有超时，否则任何一条 hang 都会
  // 把 `hydrateProjectAssetUrls` 的 Promise.all 整体卡死，导致 loadProject
  // 永不退出、`refreshAllPages` 跑不到、侧边栏永远空白。
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  if (ctl) {
    timer = setTimeout(function () { try { ctl.abort(); } catch (_) {} }, 8000);
  }
  var data = null;
  try {
    var resp = await fetch(
      '/api/asset/' + encodeURIComponent(assetId) + '/url?ttl=' + encodeURIComponent(String(ttl)),
      { headers: getAuthHeaders(), signal: ctl ? ctl.signal : undefined },
    );
    checkAuth(resp);
    data = await _safeJson(resp);
  } catch (e) {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
  var url = data && data.url ? data.url : '';
  var ttlSec = Math.max(60, Math.min(parseInt((data && data.ttl) || ttl, 10) || 3600, 7 * 24 * 3600));
  if (url) _assetUrlCache.set(assetId, { url: url, expiresAt: now + Math.max(30000, (ttlSec - 30) * 1000) });
  return url;
}

async function _applyResolvedUrl(obj, assetKey, urlKeys) {
  if (!obj || !assetKey || !urlKeys || !urlKeys.length) return;
  var assetId = (obj[assetKey] || '').trim();
  if (!assetId) return;
  try {
    var url = await fetchAssetSignedUrl(assetId);
    if (!url) return;
    urlKeys.forEach(function (key) {
      var originKey = '_origin' + key.charAt(0).toUpperCase() + key.slice(1);
      if (typeof obj[originKey] === 'undefined') obj[originKey] = obj[key] || '';
      obj[key] = url;
    });
  } catch (_e) {}
}

export async function hydrateProjectAssetUrls(project) {
  if (!project || typeof project !== 'object') return project;
  var jobs = [];
  (project.storyboards || []).forEach(function (sb) {
    if (!sb) return;
    jobs.push(_applyResolvedUrl(sb, 'imageAssetId', ['imageUrl', 'rawUrl']));
    jobs.push(_applyResolvedUrl(sb, 'videoAssetId', ['videoUrl']));
  });
  var assets = project.assets || {};
  (assets.characters || []).forEach(function (ch) {
    if (!ch) return;
    jobs.push(_applyResolvedUrl(ch, 'assetId', ['realPhotoUrl', 'imageUrl', 'rawUrl']));
    jobs.push(_applyResolvedUrl(ch, 'pencilAssetId', ['pencilUrl']));
  });
  (assets.scenes || []).forEach(function (it) {
    if (!it) return;
    jobs.push(_applyResolvedUrl(it, 'assetId', ['imageUrl', 'rawUrl']));
  });
  (assets.props || []).forEach(function (it) {
    if (!it) return;
    jobs.push(_applyResolvedUrl(it, 'assetId', ['imageUrl', 'rawUrl']));
  });
  await Promise.all(jobs);
  return project;
}

// ── DOM / UI helpers ──────────────────────────────────────────────────────

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

export function formatTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0') + ':' +
         String(d.getSeconds()).padStart(2, '0');
}

export function setLoading(btnEl, hintEl, loading, text) {
  if (btnEl) btnEl.disabled = loading;
  if (hintEl) hintEl.textContent = loading ? (text || '请稍候…') : '';
}

let _toastMaxVisible = 5;

function _getToastContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function _dismissToast(el) {
  if (!el || !el.parentElement) return;
  el.classList.remove('toast-visible');
  el.classList.add('toast-hiding');
  setTimeout(() => { if (el.parentElement) el.remove(); }, 350);
}

export function showToast(msg, type, actions) {
  type = type || 'error';
  const colors = { error: 'bg-red-500/90', warn: 'bg-amber-500/90', info: 'bg-[#2C3E50]/90', success: 'bg-emerald-500/90', ok: 'bg-emerald-500/90' };
  const icons  = { error: 'error', warn: 'warning', info: 'info', success: 'check_circle', ok: 'check_circle' };
  const container = _getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast-item px-6 py-3 rounded-xl shadow-2xl text-white text-sm flex items-center gap-3 max-w-[90vw] flex-wrap ' + (colors[type] || colors.error);
  el.innerHTML =
    '<span class="material-symbols-outlined text-lg shrink-0">' + (icons[type] || 'error') + '</span>' +
    '<span class="flex-1 min-w-[12rem]">' + escapeHtml(msg) + '</span>' +
    '<span class="toast-actions flex flex-wrap gap-2 shrink-0"></span>' +
    '<button type="button" class="material-symbols-outlined text-white/60 hover:text-white text-lg shrink-0 toast-close-btn">close</button>';
  el.querySelector('.toast-close-btn').addEventListener('click', () => _dismissToast(el));
  const actWrap = el.querySelector('.toast-actions');
  if (actions && actions.length && actWrap) {
    for (const act of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'px-3 py-1.5 rounded-lg bg-white/25 hover:bg-white/35 text-xs font-bold whitespace-nowrap';
      b.textContent = act.label;
      b.onclick = ev => { ev.stopPropagation(); try { act.onClick(); } catch (e) {} _dismissToast(el); };
      actWrap.appendChild(b);
    }
  } else if (actWrap) {
    actWrap.remove();
  }
  container.prepend(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  while (container.children.length > _toastMaxVisible) {
    const oldest = container.lastElementChild;
    if (oldest) oldest.remove();
  }
  const dismissMs = actions && actions.length ? Math.max(type === 'error' ? 8000 : 4000, 12000) : (type === 'error' ? 8000 : 4000);
  setTimeout(() => _dismissToast(el), dismissMs);
}

/**
 * 通用确认弹窗。支持两种用法：
 *   1. 回调式：showConfirm(title, msg, () => onOk(), () => onCancel())
 *   2. 文案式 + Promise：const ok = await showConfirm(title, msg, '确定文案', '取消文案')
 *
 * 第 3、4 个参数若为 function 则当作回调；为 string/undefined 则当按钮文案。
 * 函数总是返回 Promise<boolean>（true=确定/false=取消），方便 await。
 */
export function showConfirm(title, message, arg3, arg4) {
  const okIsFn = typeof arg3 === 'function';
  const cancelIsFn = typeof arg4 === 'function';
  const okText = okIsFn ? '确定' : (typeof arg3 === 'string' && arg3 ? arg3 : '确定');
  const cancelText = cancelIsFn ? '取消' : (typeof arg4 === 'string' && arg4 ? arg4 : '取消');

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[10002] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4';
    overlay.innerHTML =
      '<div class="bg-surface-container-lowest rounded-2xl shadow-2xl max-w-md w-full border border-outline-variant/20 p-6">' +
        '<h3 class="text-lg font-bold text-on-background mb-2">' + escapeHtml(title || '确认') + '</h3>' +
        '<p class="text-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap mb-6">' + escapeHtml(message || '') + '</p>' +
        '<div class="flex justify-end gap-3">' +
          '<button type="button" class="qd-confirm-cancel px-5 py-2.5 rounded-full text-sm font-bold text-on-surface-variant border border-outline-variant/30 hover:bg-surface-container transition-colors">' + escapeHtml(cancelText) + '</button>' +
          '<button type="button" class="qd-confirm-ok px-5 py-2.5 rounded-full text-sm font-bold bg-primary text-on-primary hover:opacity-90 transition-opacity">' + escapeHtml(okText) + '</button>' +
        '</div>' +
      '</div>';
    const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    let settled = false;
    const finishOk = () => {
      if (settled) return; settled = true;
      close();
      if (okIsFn) { try { arg3(); } catch (_e) {} }
      resolve(true);
    };
    const finishCancel = () => {
      if (settled) return; settled = true;
      close();
      if (cancelIsFn) { try { arg4(); } catch (_e) {} }
      resolve(false);
    };
    overlay.querySelector('.qd-confirm-cancel').onclick = finishCancel;
    overlay.querySelector('.qd-confirm-ok').onclick = finishOk;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finishCancel(); });
    document.body.appendChild(overlay);
  });
}

export function consumeStreamStepTags(chunk, state, onStep) {
  if (!chunk) return '';
  if (!state) state = { buf: '' };
  let s = state.buf + chunk;
  state.buf = '';
  const re = /<step>([^<]*)<\/step>/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    last = m.lastIndex;
    const hint = (m[1] || '').trim();
    if (hint && onStep) onStep(hint);
  }
  out += s.slice(last);
  const open = out.lastIndexOf('<step>');
  if (open >= 0) {
    const tail = out.slice(open);
    if (tail.indexOf('</step>') < 0) { state.buf = tail; out = out.slice(0, open); }
  }
  return out;
}

// 显示剧本/画面描述/台词等文本时的防御性清洁器。
// 历史上 gpt-5.5 / claude-thinking 这类推理模型偶尔会无视 prompt 里
// "禁止输出 <step>" 的指令，把 <step>铺垫</step> 当段落标记输出。
// 后端 full-create / consult/confirm 已经剥了一道，但老数据/边缘路径仍可能
// 穿漏，所以所有显示剧本/镜头描述的位置都再过一次这个函数兜底。
export function stripStepTags(text) {
  if (typeof text !== 'string' || !text) return text;
  if (text.indexOf('<step>') < 0 && text.indexOf('</step>') < 0) return text;
  return text.replace(/<step>[^<]*<\/step>\s*/gi, '').trim();
}

export function $(id) { return document.getElementById(id); }
