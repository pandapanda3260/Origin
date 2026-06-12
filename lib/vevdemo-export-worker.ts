import { saveVevDemoExportRecord } from './online-editor-export-records';
import { claimDueScheduledJob, completeScheduledJob, ensureScheduledJob, failScheduledJob } from './scheduled-jobs';
import {
  attachVevDemoExportRecord,
  listDueVevDemoExportTasks,
  markVevDemoExportRemoteCompleted,
  markVevDemoExportRemoteFailed,
  markVevDemoExportRemoteRunning,
  reconcileVevDemoExportDownloadStatuses,
  updateVevDemoExportTaskStatus,
  type VevDemoExportTaskRow,
} from './vevdemo-export-tasks';
import { getVevDemoExportTaskResult, type VevDemoRemoteTaskResult } from './vevdemo-vod-openapi';

const VEVD_EXPORT_JOB = 'vevdemo_export_polling';
const VEVD_EXPORT_RUNNER = 'vevdemo-export-worker';
const VEVD_EXPORT_LOOP_KEY = '__origin_vevdemo_export_polling_loop__';

type SaveExportRecord = typeof saveVevDemoExportRecord;
type ResolveRemoteTask = (task: VevDemoExportTaskRow) => Promise<VevDemoRemoteTaskResult>;

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function retryAt(atMs: number, retryCount: number) {
  const delay = Math.min(15_000 * Math.pow(2, Math.max(0, retryCount)), 5 * 60_000);
  return new Date(atMs + delay).toISOString();
}

async function defaultResolveRemoteTask(task: VevDemoExportTaskRow) {
  if (!task.provider_task_id) throw new Error('missing provider task id');
  return getVevDemoExportTaskResult({
    providerTaskId: task.provider_task_id,
    space: task.vev_space,
  });
}

export async function processVevDemoExportTask(
  task: VevDemoExportTaskRow,
  deps: {
    nowMs?: number;
    resolveRemoteTask?: ResolveRemoteTask;
    saveExportRecord?: SaveExportRecord;
  } = {},
) {
  const nowMs = deps.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const resolveRemoteTask = deps.resolveRemoteTask || defaultResolveRemoteTask;
  const saveExportRecord = deps.saveExportRecord || saveVevDemoExportRecord;
  try {
    const remote = await resolveRemoteTask(task);
    if (remote.state === 'failed') {
      const updated = markVevDemoExportRemoteFailed({
        id: task.id,
        errorMsg: remote.errorMsg || 'remote task failed',
        pollResult: remote.raw,
        nowIso: now,
      });
      return { status: 'remote_failed' as const, task: updated };
    }
    if (remote.state === 'completed') {
      if (!remote.outputUrl) {
        const updated = updateVevDemoExportTaskStatus({
          id: task.id,
          status: 'needs_review',
          errorMsg: remote.outputVid
            ? 'remote task completed with output Vid but no playable URL'
            : 'remote task completed without output URL or Vid',
          pollResult: remote.raw,
          lastCheckedAt: now,
          nowIso: now,
        });
        return { status: 'needs_review' as const, task: updated };
      }
      const completed = markVevDemoExportRemoteCompleted({
        id: task.id,
        outputUrl: remote.outputUrl,
        outputVid: remote.outputVid,
        pollResult: remote.raw,
        nowIso: now,
      });
      const exportPayload = saveExportRecord({
        userId: Number(task.owner_id),
        projectId: task.project_id,
        taskId: task.provider_task_id,
        outputUrl: remote.outputUrl,
        format: 'mp4',
        edlJson: {
          vevDemo: {
            providerTaskId: task.provider_task_id,
            outputVid: remote.outputVid || null,
            source: 'GetTaskList',
          },
        },
      });
      if (!exportPayload.success || !exportPayload.exportId) {
        const updated = updateVevDemoExportTaskStatus({
          id: task.id,
          status: 'needs_review',
          errorMsg: (exportPayload as any).error || 'failed to persist completed VevDemo export',
          pollResult: remote.raw,
          lastCheckedAt: now,
          nowIso: now,
        });
        return { status: 'needs_review' as const, task: updated };
      }
      const attached = attachVevDemoExportRecord({
        id: completed.id,
        exportId: exportPayload.exportId,
        outputUrl: remote.outputUrl,
        outputVid: remote.outputVid,
        nowIso: now,
      });
      return { status: 'origin_downloading' as const, task: attached, exportId: exportPayload.exportId };
    }
    const running = markVevDemoExportRemoteRunning({
      id: task.id,
      pollResult: remote.raw,
      nextRetryAt: retryAt(nowMs, task.retry_count),
      nowIso: now,
    });
    return { status: 'remote_running' as const, task: running };
  } catch (error: any) {
    const updated = updateVevDemoExportTaskStatus({
      id: task.id,
      status: 'remote_running',
      errorMsg: error?.message || String(error),
      lastCheckedAt: now,
      nextRetryAt: retryAt(nowMs, task.retry_count),
      incrementRetry: true,
      nowIso: now,
    });
    return { status: 'poll_error' as const, task: updated, error };
  }
}

export async function runVevDemoExportPollingPass(opts: {
  intervalMs?: number;
  limit?: number;
  nowMs?: number;
  resolveRemoteTask?: ResolveRemoteTask;
  saveExportRecord?: SaveExportRecord;
} = {}) {
  const intervalMs = opts.intervalMs || envInt('VEVDEMO_EXPORT_POLLING_INTERVAL_MS', 10_000, 2_000, 10 * 60_000);
  const limit = opts.limit || envInt('VEVDEMO_EXPORT_POLLING_LIMIT', 10, 1, 100);
  ensureScheduledJob({
    jobName: VEVD_EXPORT_JOB,
    catchUpStrategy: 'current_state_only',
    nextRunAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
    meta: { intervalMs, limit },
  });
  const claimed = claimDueScheduledJob({
    jobName: VEVD_EXPORT_JOB,
    runnerId: VEVD_EXPORT_RUNNER,
    nowMs: opts.nowMs,
  });
  if (!claimed) return { claimed: false, scanned: 0, processed: 0, download: { scanned: 0, ready: 0, failed: 0, needsReview: 0 } };

  const nowMs = opts.nowMs ?? Date.now();
  const nextRunAt = new Date(nowMs + intervalMs).toISOString();
  try {
    const download = reconcileVevDemoExportDownloadStatuses({ limit, nowIso: new Date(nowMs).toISOString() });
    const due = listDueVevDemoExportTasks({ limit, nowIso: new Date(nowMs).toISOString() });
    let processed = 0;
    for (const task of due) {
      await processVevDemoExportTask(task, {
        nowMs,
        resolveRemoteTask: opts.resolveRemoteTask,
        saveExportRecord: opts.saveExportRecord,
      });
      processed += 1;
    }
    completeScheduledJob({
      jobName: VEVD_EXPORT_JOB,
      runnerId: VEVD_EXPORT_RUNNER,
      nextRunAt,
      meta: { scanned: due.length, processed, download },
    });
    return { claimed: true, scanned: due.length, processed, download };
  } catch (error: any) {
    failScheduledJob({
      jobName: VEVD_EXPORT_JOB,
      runnerId: VEVD_EXPORT_RUNNER,
      nextRunAt,
      error: error?.message || String(error),
    });
    throw error;
  }
}

export function startVevDemoExportPollingWorker() {
  const globalScope = globalThis as any;
  if (globalScope[VEVD_EXPORT_LOOP_KEY]) return globalScope[VEVD_EXPORT_LOOP_KEY] as NodeJS.Timeout;

  const intervalMs = envInt('VEVDEMO_EXPORT_POLLING_INTERVAL_MS', 10_000, 2_000, 10 * 60_000);
  const limit = envInt('VEVDEMO_EXPORT_POLLING_LIMIT', 10, 1, 100);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runVevDemoExportPollingPass({ intervalMs, limit })
      .then((result) => {
        if (result.scanned > 0 || result.download.scanned > 0) {
          console.warn(`[vevdemo-export-poll] scanned=${result.scanned} processed=${result.processed} download=${JSON.stringify(result.download)}`);
        }
      })
      .catch((error) => {
        console.error('[vevdemo-export-poll] pass failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  globalScope[VEVD_EXPORT_LOOP_KEY] = timer;
  console.log(`[vevdemo-export-poll] loop started interval=${intervalMs}ms limit=${limit}`);
  tick();
  return timer;
}
