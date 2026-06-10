/**
 * backend_stream.js — SSE subscription helpers for backend-driven tasks.
 *
 * subscribeTask(taskId, callbacks)   — single task stream (/api/tasks/{id}/stream)
 * subscribeBatch(batchId, callbacks) — batch stream     (/api/batch/{id}/stream)
 *
 * Both return a { close() } handle so callers can tear down early.
 *
 * 2026-06 · SSE 断流自愈（修"任务完成了但页面不刷新，必须 F5"）：
 *   1. 重连计数在收到任何事件后清零。此前 MAX_RETRIES=3 是**终身额度**，
 *      长任务（视频生成动辄几分钟）期间累计 3 次网络抖动 / 睡眠唤醒 /
 *      dev 热重载，这条 SSE 就永久死了，且不通知任何人重建。
 *   2. 重连额度耗尽后不再直接判死：自动降级为 5s 兜底轮询
 *      GET /api/batch/{id} / GET /api/tasks/{id}（两个端点均已存在），
 *      把权威状态合成与 SSE 同构的回调继续投递；批次/任务到终态后停止
 *      轮询并触发 onClose。这样没有自带轮询的订阅方（片段页单条重生成、
 *      单任务流等）也不会卡死在"生成中"。
 *   3. 终态事件在本层按 taskId 去重——SSE 与降级轮询不会对同一任务双发
 *      task_completed / task_failed（订阅方自带的 _seenDone 去重不受影响，
 *      属双保险）。
 *
 * 降级轮询合成的 task_completed 帧与 lib/batches.ts `_emit('task_completed')`
 * 真帧同构：{ taskId, targetSeq, target, resultUrl, patch, extra, serverVersion }
 * —— batch_tasks.result_json 存的就是发帧用的同一份 resultForStore。
 */

import { getAuthToken, apiGet } from './utils.js?v=300';

const MAX_RETRIES = 3;
const FALLBACK_POLL_INTERVAL_MS = 5000;
// 兜底轮询硬上限 ≈ 2 小时，防僵尸 interval（正常批次远早于此到终态）
const FALLBACK_MAX_TICKS = 1440;
// 连续 401/403/404 次数上限：任务不存在 / 登录态失效时放弃，行为退回
// "SSE 死亡即 onClose"的旧语义（只是晚约 15s）
const FALLBACK_MAX_MISSES = 3;

function _buildUrl(path) {
  const token = getAuthToken();
  return path + (token ? '?token=' + encodeURIComponent(token) : '');
}

function _isTerminalBatchStatus(status) {
  status = String(status || '').toLowerCase();
  return status === 'completed' || status === 'succeeded' || status === 'done' ||
    status === 'failed' || status === 'cancelled' || status === 'canceled' ||
    status === 'partial';
}

/**
 * Subscribe to a single task's SSE stream.
 *
 * callbacks:
 *   onProgress(data)   — task_progress event (optional)
 *   onCompleted(data)  — task_completed: { taskId, resultUrl, targetIdx }
 *   onFailed(data)     — task_failed:    { taskId, reason, targetIdx }
 *   onClose()          — stream closed (terminal, or SSE+兜底轮询都到头)
 */
export function subscribeTask(taskId, callbacks) {
  const { onProgress, onCompleted, onFailed, onClose } = callbacks || {};
  let terminalSeen = false;

  function _completedOnce(data) {
    if (terminalSeen) return true;
    terminalSeen = true;
    if (onCompleted) onCompleted(data);
    return true;
  }
  function _failedOnce(data) {
    if (terminalSeen) return true;
    terminalSeen = true;
    if (onFailed) onFailed(data);
    return true;
  }

  const url = _buildUrl('/api/tasks/' + encodeURIComponent(taskId) + '/stream');
  return _openStream(url, {
    task_progress:  onProgress,
    task_completed: _completedOnce,
    task_failed:    _failedOnce,
    task_cancelled: () => { return true; },
  }, onClose, async function _pollTaskOnce(ctl) {
    // GET /api/tasks/{id} 覆盖 video_tasks（片段任务）；exports 等其它任务
    // 404 计 miss，3 次后放弃 —— edit.js 的 onClose 自带 export-status 兜底。
    const info = await apiGet('/api/tasks/' + encodeURIComponent(taskId));
    if (!info) return;
    const status = String(info.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'done') {
      _completedOnce({
        taskId: taskId,
        resultUrl: info.url || '',
        videoUrl: info.url || '',
        progress: 100,
        extra: {
          protectedUrl: info.protectedUrl || '',
          filename: info.filename,
          displayName: info.displayName,
          downloadFilename: info.downloadFilename,
          durationSec: info.durationSec,
          coverUrl: info.coverUrl,
        },
      });
      ctl.finish();
    } else if (status === 'failed' || status === 'cancelled' || status === 'canceled' ||
               status === 'error' || status === 'timeout') {
      const msg = info.errorMsg || 'failed';
      _failedOnce({ taskId: taskId, reason: msg, errorMsg: msg });
      ctl.finish();
    } else if (onProgress && typeof info.progress === 'number') {
      onProgress({ taskId: taskId, progress: info.progress });
    }
  });
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

  // 终态事件层内去重：SSE 与降级轮询喂同一份回调，不双发
  const seenDone = Object.create(null);
  const seenFailed = Object.create(null);
  let batchTerminalSeen = false;

  function _taskCompletedOnce(data) {
    const tid = data && data.taskId;
    if (tid) {
      if (seenDone[tid] || seenFailed[tid]) return false;
      seenDone[tid] = true;
    }
    if (onTaskCompleted) onTaskCompleted(data);
    return false;
  }
  function _taskFailedOnce(data) {
    const tid = data && data.taskId;
    if (tid) {
      if (seenDone[tid] || seenFailed[tid]) return false;
      seenFailed[tid] = true;
    }
    if (onTaskFailed) onTaskFailed(data);
    return false;
  }
  function _batchDoneOnce(data) {
    if (batchTerminalSeen) return true;
    batchTerminalSeen = true;
    if (onBatchCompleted) onBatchCompleted(data);
    return true;
  }

  const url = _buildUrl('/api/batch/' + encodeURIComponent(batchId) + '/stream');
  return _openStream(url, {
    snapshot:         onSnapshot,
    task_started:     onTaskStarted,
    task_progress:    onTaskProgress,
    task_completed:   _taskCompletedOnce,
    task_failed:      _taskFailedOnce,
    batch_completed:  _batchDoneOnce,
    batch_cancelled:  _batchDoneOnce,
  }, onClose, async function _pollBatchOnce(ctl) {
    const snap = await apiGet('/api/batch/' + encodeURIComponent(batchId));
    if (!snap) return;
    const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
    tasks.forEach(function (t) {
      if (!t || !t.taskId) return;
      const status = String(t.status || '').toLowerCase();
      const result = (t.result && typeof t.result === 'object') ? t.result : {};
      if (status === 'completed' || status === 'succeeded' || status === 'done') {
        _taskCompletedOnce({
          taskId: t.taskId,
          targetSeq: t.seq,
          target: t.target || {},
          resultUrl: result.resultUrl || result.url || (result.patch && result.patch.url) || '',
          patch: result.patch,
          extra: result.extra,
          serverVersion: result.serverVersion,
        });
      } else if (status === 'failed' || status === 'error') {
        const msg = t.errorMsg || '生成失败';
        _taskFailedOnce({
          taskId: t.taskId,
          targetSeq: t.seq,
          target: t.target || {},
          errorMsg: msg,
          reason: msg,
        });
      }
    });
    if (_isTerminalBatchStatus(snap.status)) {
      _batchDoneOnce({
        batchId: batchId,
        status: snap.status,
        total: snap.total,
        succeeded: snap.succeeded,
        failed: snap.failed,
      });
      ctl.finish();
    }
  });
}

/**
 * Internal: open an EventSource, dispatch events, auto-reconnect up to MAX_RETRIES.
 *
 * handlers map: eventName -> fn(data). If fn returns true, the stream is closed
 * after the call (terminal event).
 *
 * fallbackPollOnce(ctl): 重连额度耗尽后每 5s 调一次的兜底轮询；终态时调
 * ctl.finish()（停轮询 + 触发 onClose）。轮询抛 401/403/404 连续 3 次放弃。
 */
function _openStream(url, handlers, onClose, fallbackPollOnce) {
  let es = null;
  let retries = 0;
  let closed = false;
  let pollTimer = null;
  let pollBusy = false;
  let pollTicks = 0;
  let pollMisses = 0;
  let polling = false;

  function _stopPoll() {
    polling = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function _finish() {
    if (closed) return;
    closed = true;
    _stopPoll();
    if (es) { try { es.close(); } catch (_) {} }
    if (onClose) onClose();
  }

  const ctl = { finish: _finish };

  function _startFallbackPoll() {
    if (closed || polling) return;
    if (typeof fallbackPollOnce !== 'function') { _finish(); return; }
    polling = true;
    pollTicks = 0;
    pollMisses = 0;
    console.warn('[BackendStream] SSE retries exhausted, degrading to poll:', url.split('?')[0]);
    async function tick() {
      if (closed) { _stopPoll(); return; }
      if (pollBusy) return;
      pollTicks++;
      if (pollTicks > FALLBACK_MAX_TICKS) { _finish(); return; }
      pollBusy = true;
      try {
        await fallbackPollOnce(ctl);
        pollMisses = 0;
      } catch (e) {
        const st = e && e.status;
        if (st === 401 || st === 403 || st === 404) {
          pollMisses++;
          if (pollMisses >= FALLBACK_MAX_MISSES) { _finish(); return; }
        }
        // 网络错 / 5xx：不计 miss，等恢复（受 FALLBACK_MAX_TICKS 总上限约束）
      } finally {
        pollBusy = false;
      }
    }
    pollTimer = setInterval(tick, FALLBACK_POLL_INTERVAL_MS);
    // 立即补一拍：SSE 失联期间任务可能早已到终态
    setTimeout(tick, 0);
  }

  function open() {
    if (closed) return;
    es = new EventSource(url);

    es.onopen = function () {
      // 重连成功即恢复额度（事件层还会再清，双保险：个别代理环境下
      // onopen 不可靠）
      retries = 0;
    };

    es.onerror = function () {
      es.close();
      if (closed) return;
      if (retries < MAX_RETRIES) {
        retries++;
        const delay = Math.min(1000 * Math.pow(2, retries - 1), 8000);
        setTimeout(open, delay);
      } else {
        // 重连额度耗尽：不再直接判死，降级为权威状态轮询
        _startFallbackPoll();
      }
    };

    // 注意：即使调用方没传某事件的回调，也要注册监听——"流上有任何事件"
    // 都说明连接健康，必须清零重连计数（修"3 次重连是终身额度"的硬伤）。
    Object.entries(handlers).forEach(function ([eventName, handler]) {
      es.addEventListener(eventName, function (ev) {
        if (closed) return;
        retries = 0;
        if (!handler) return;
        let parsed = {};
        try { parsed = JSON.parse(ev.data); } catch (_) {}
        // 后端 batch/[id]/stream 与 tasks/[id]/stream 的 SSE 帧结构是
        // `data: {"data": <真正 payload>, "ts": <毫秒>}`——外层再套了一层。
        // 这里剥到 handler 手里直接是真正 payload（{taskId, targetSeq, patch, extra, ...}），
        // 避免每个消费方都写 `data.data.targetSeq` 这种别扭形式。
        const data = (parsed && typeof parsed === "object" && parsed.data !== undefined)
          ? parsed.data
          : parsed;
        const terminal = handler(data);
        if (terminal) {
          closed = true;
          _stopPoll();
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
      _stopPoll();
      if (es) es.close();
    },
  };
}
