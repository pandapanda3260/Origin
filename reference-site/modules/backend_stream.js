/**
 * backend_stream.js — SSE subscription helpers for backend-driven tasks.
 *
 * subscribeTask(taskId, callbacks)   — single task stream (/api/tasks/{id}/stream)
 * subscribeBatch(batchId, callbacks) — batch stream     (/api/batch/{id}/stream)
 *
 * Both return a { close() } handle so callers can tear down early.
 */

import { getAuthToken } from './utils.js';

const MAX_RETRIES = 3;

function _buildUrl(path) {
  const token = getAuthToken();
  return path + (token ? '?token=' + encodeURIComponent(token) : '');
}

/**
 * Subscribe to a single task's SSE stream.
 *
 * callbacks:
 *   onProgress(data)   — task_progress event (optional)
 *   onCompleted(data)  — task_completed: { taskId, resultUrl, targetIdx }
 *   onFailed(data)     — task_failed:    { taskId, reason, targetIdx }
 *   onClose()          — stream closed (terminal or max retries exhausted)
 */
export function subscribeTask(taskId, callbacks) {
  const { onProgress, onCompleted, onFailed, onClose } = callbacks || {};
  const url = _buildUrl('/api/tasks/' + encodeURIComponent(taskId) + '/stream');
  return _openStream(url, {
    task_progress:  onProgress,
    task_completed: (data) => { if (onCompleted) onCompleted(data); return true; },
    task_failed:    (data) => { if (onFailed)    onFailed(data);    return true; },
    task_cancelled: ()     => { return true; },
  }, onClose);
}

/**
 * Subscribe to a batch's SSE stream.
 *
 * callbacks:
 *   onSnapshot(data)       — snapshot: 连上后推的第一帧，含当前 batch 状态全景
 *                             { total, succeeded, failed, running, tasks: [...] }
 *                             给刷新页面 / 晚订阅的场景用来重建 UI
 *   onTaskStarted(data)    — task_started
 *   onTaskProgress(data)   — task_progress
 *   onTaskCompleted(data)  — task_completed: { taskId, targetSeq, resultUrl }
 *   onTaskFailed(data)     — task_failed:    { taskId, targetSeq, errorMsg }
 *   onBatchCompleted(data) — batch_completed / batch_cancelled
 *   onClose()              — stream closed
 */
export function subscribeBatch(batchId, callbacks) {
  const {
    onSnapshot, onTaskStarted, onTaskProgress, onTaskCompleted,
    onTaskFailed, onBatchCompleted, onClose,
  } = callbacks || {};
  const url = _buildUrl('/api/batch/' + encodeURIComponent(batchId) + '/stream');
  return _openStream(url, {
    snapshot:         onSnapshot,
    task_started:     onTaskStarted,
    task_progress:    onTaskProgress,
    task_completed:   onTaskCompleted,
    task_failed:      onTaskFailed,
    batch_completed:  (data) => { if (onBatchCompleted) onBatchCompleted(data); return true; },
    batch_cancelled:  (data) => { if (onBatchCompleted) onBatchCompleted(data); return true; },
  }, onClose);
}

/**
 * Internal: open an EventSource, dispatch events, auto-reconnect up to MAX_RETRIES.
 *
 * handlers map: eventName -> fn(data). If fn returns true, the stream is closed
 * after the call (terminal event).
 */
function _openStream(url, handlers, onClose) {
  let es = null;
  let retries = 0;
  let closed = false;

  function open() {
    if (closed) return;
    es = new EventSource(url);

    es.onerror = function () {
      es.close();
      if (closed) return;
      if (retries < MAX_RETRIES) {
        retries++;
        const delay = Math.min(1000 * Math.pow(2, retries - 1), 8000);
        setTimeout(open, delay);
      } else {
        closed = true;
        if (onClose) onClose();
      }
    };

    Object.entries(handlers).forEach(function ([eventName, handler]) {
      if (!handler) return;
      es.addEventListener(eventName, function (ev) {
        let parsed = {};
        try { parsed = JSON.parse(ev.data); } catch (_) {}
        // 后端 routers/batch_api._format_sse / routers/task_api 的 SSE 帧结构是
        // `data: {"data": <真正 payload>, "ts": <毫秒>}`——外层再套了一层。
        // 这里剥到 handler 手里直接是真正 payload（{taskId, targetSeq, patch, extra, ...}），
        // 避免每个消费方都写 `data.data.targetSeq` 这种别扭形式。
        const data = (parsed && typeof parsed === "object" && parsed.data !== undefined)
          ? parsed.data
          : parsed;
        const terminal = handler(data);
        if (terminal) {
          closed = true;
          es.close();
          if (onClose) onClose();
        }
      });
    });
  }

  open();

  return {
    close() {
      closed = true;
      if (es) es.close();
    },
  };
}
