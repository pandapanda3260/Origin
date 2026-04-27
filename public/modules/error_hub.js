/**
 * Phase 5.5 · 前端错误集中站 (error_hub)
 *
 * 为啥要集中：
 *   - 老代码 40+ 处 `try { ... } catch (e) { console.warn(x); showToast(y) }`
 *     各自拼消息、各自决定要不要上报，常见坑：
 *       ① 把 upstream key/endpoint 等泄露进 toast
 *       ② 同一个错误在 3 个层级都 toast 一次
 *       ③ 某个 callsite 漏了上报，问题排查全靠 console
 *   - 这里提供 3 个对外 API，后续 callsite 逐步迁过来即可：
 *       reportError(ctx, err, opts?) — 记一次错误（console.warn + 可选 toast）
 *       friendlyMessage(err, fallback?) — 把原始 err 对象 / 字符串脱敏成用户语
 *       installGlobalHandlers() — 启动时调一次，接管 window.onerror /
 *                                 unhandledrejection（给"忘 catch"的兜底）
 *
 * 脱敏规则（friendlyMessage 内部）：
 *   - 422 / 429 / 5xx 直接给固定文案
 *   - 带 "Bearer "、"api_key"、"token" 等敏感 token 的 → 吞掉
 *   - 其他走回"生成失败，请稍后重试"（与 assets.js::_diagnoseApiError 一致）
 *
 * 不在这里做：
 *   - Sentry / 远程上报：单独的 `services.error_report` 要单开 endpoint；
 *     这里只保证本地 UI 一致。
 */

const _SAFE_FALLBACK = "操作失败，请稍后重试";
const _SENSITIVE_PATTERNS = [
  /bearer\s+[^\s]+/gi,
  /api[_-]?key[=:]\s*[^\s]+/gi,
  /token[=:]\s*[^\s]+/gi,
  /sk-[a-z0-9]+/gi,
];

/**
 * 把原始 error（字符串 / Error / fetch Response / 任意对象）转成用户可看的一句话。
 * 永远返回 string；即使 err 是 null/undefined 也给 fallback。
 */
export function friendlyMessage(err, fallback) {
  if (!err) return fallback || _SAFE_FALLBACK;
  let raw = "";
  try {
    if (typeof err === "string") raw = err;
    else if (err instanceof Error) raw = err.message || String(err);
    else if (typeof err === "object" && err !== null) {
      // 常见 fetch 包装：{ status, error, detail, message }
      raw = err.detail || err.error || err.message || "";
      if (!raw && typeof err.status === "number") raw = "HTTP " + err.status;
      if (!raw) raw = JSON.stringify(err).slice(0, 200);
    } else {
      raw = String(err);
    }
  } catch (_e) {
    raw = "";
  }

  // HTTP 状态码语义
  const statusMatch = raw.match(/\b(4\d\d|5\d\d)\b/);
  if (statusMatch) {
    const code = statusMatch[1];
    if (code === "401" || code === "403") return "未登录或会话过期，请刷新页面后重试";
    if (code === "404") return "内容不存在或已被删除";
    if (code === "409") return "内容在其他地方被修改，请刷新页面";
    if (code === "413") return "内容过大，请缩小后再试";
    if (code === "429") return "请求过于频繁，请稍后重试";
    if (code.startsWith("5")) return "服务暂时不可用，请稍后重试";
  }

  // 脱敏：含敏感字段就直接 fallback，不把原文塞给用户
  for (const pat of _SENSITIVE_PATTERNS) {
    if (pat.test(raw)) return fallback || _SAFE_FALLBACK;
  }

  // 太长 / 英文堆栈之类直接兜底
  if (raw.length > 80 || /^[\s{\[]/.test(raw) || /at .+:\d+:\d+/.test(raw)) {
    return fallback || _SAFE_FALLBACK;
  }
  return raw || fallback || _SAFE_FALLBACK;
}

/**
 * 记一次错误。
 *
 * @param {string} context  触发位置 tag，例如 "assets/batch_start"
 * @param {any}    err      原始错误
 * @param {{toast?:boolean, toastFn?:Function, fallback?:string}} opts
 *   - toast=true（默认）：调 `opts.toastFn(msg, "error")` 或全局 showToast
 *   - fallback：友好文案兜底
 */
export function reportError(context, err, opts) {
  opts = opts || {};
  const msg = friendlyMessage(err, opts.fallback);
  try { console.warn("[ErrorHub][" + context + "]", err); } catch (_e) {}
  const shouldToast = opts.toast !== false;
  if (shouldToast) {
    const fn = opts.toastFn || (typeof window !== "undefined" && window.showToast);
    if (typeof fn === "function") {
      try { fn(msg, "error"); } catch (_e) {}
    }
  }
  return msg;
}

/**
 * 启动时调一次：接管 `window.onerror` 和 `unhandledrejection`，兜底上报
 * 那些老代码忘了 catch 的 promise / 事件循环异常，避免 UI 一片沉默。
 *
 * 重复调用会覆盖旧 handler；返回一个 dispose 函数恢复上一个 handler。
 */
export function installGlobalHandlers(opts) {
  if (typeof window === "undefined") return function () {};
  opts = opts || {};
  const prevErr = window.onerror;
  const prevRej = window.onunhandledrejection;

  window.onerror = function (msg, src, lineno, colno, err) {
    reportError("window.onerror", err || msg, { toast: !!opts.toastOnUncaught });
    if (typeof prevErr === "function") {
      try { return prevErr.apply(this, arguments); } catch (_e) {}
    }
    return false;
  };
  window.onunhandledrejection = function (ev) {
    reportError("unhandledrejection", ev && ev.reason, { toast: !!opts.toastOnUncaught });
    if (typeof prevRej === "function") {
      try { return prevRej.apply(this, arguments); } catch (_e) {}
    }
  };
  return function dispose() {
    window.onerror = prevErr;
    window.onunhandledrejection = prevRej;
  };
}
