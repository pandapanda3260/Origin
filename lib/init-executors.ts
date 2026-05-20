/**
 * 模块加载即"注册"所有 batch executor + 装日志钩子。
 *
 * Next.js 在每个 Route 文件首次被调用时会按需加载它的 import 链，
 * 所以我们让 /api/batch/start、/api/batch/[id]、/api/batch/[id]/stream
 * 和 /api/batch/active 都 import 这个文件，
 * 进程内只会有一份注册（registerExecutor 是 Map.set，幂等）。
 */
import './batch-executors';
import { installConsoleHook } from './sys-logs';
import { reapOrphanBatches, startBatchOrphanReaper, startBatchRecoveryLoop } from './batches';
import { reapOrphanExports } from './exports-reap';
import { recoverOrphanedOnlineEditorDownloads, requeuePendingOnlineEditorDownloads, startOnlineEditorDownloadWorker } from './online-editor-downloads';
import { recoverRunningVideoTasks, startVideoRecoveryLoop } from './video-gen';
import { startProviderPollingLoop } from './provider-polling-worker';

installConsoleHook();

function isNextProductionBuild() {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isWorkerProcess() {
  return process.env.ORIGIN_PROCESS_ROLE === 'worker' || envFlag('WORKER_ENABLED', false);
}

// 启动时回收上次进程留下的孤儿 batch/export + 退款
// 用 globalThis 标记避免 HMR 下重复 reap
const reapKey = '__qd_batches_reaped__';
const workerProcess = isWorkerProcess();
const recoveryEnabled = workerProcess || envFlag('BATCH_RECOVERY_ENABLED', false);
const reapOnStart = envFlag('REAP_ORPHANS_ON_START', !recoveryEnabled);

if (!isNextProductionBuild() && reapOnStart && !(globalThis as any)[reapKey]) {
  (globalThis as any)[reapKey] = true;
  try { reapOrphanBatches(); } catch (e) { console.error('[init] reapOrphanBatches:', e); }
  try { reapOrphanExports(); } catch (e) { console.error('[init] reapOrphanExports:', e); }
  try { recoverOrphanedOnlineEditorDownloads(); } catch (e) { console.error('[init] recoverOrphanedOnlineEditorDownloads:', e); }
  try { requeuePendingOnlineEditorDownloads(); } catch (e) { console.error('[init] requeuePendingOnlineEditorDownloads:', e); }
}

if (!isNextProductionBuild() && recoveryEnabled) {
  try { startBatchRecoveryLoop(); } catch (e) { console.error('[init] startBatchRecoveryLoop:', e); }
  try { startOnlineEditorDownloadWorker(); } catch (e) { console.error('[init] startOnlineEditorDownloadWorker:', e); }
  try { startProviderPollingLoop(); } catch (e) { console.error('[init] startProviderPollingLoop:', e); }
} else if (!isNextProductionBuild()) {
  try { startBatchOrphanReaper(); } catch (e) { console.error('[init] startBatchOrphanReaper:', e); }
}

const videoRecoverKey = '__qd_video_recovery_started__';
if (!isNextProductionBuild() && (recoveryEnabled || reapOnStart) && !(globalThis as any)[videoRecoverKey]) {
  (globalThis as any)[videoRecoverKey] = true;
  try { recoverRunningVideoTasks(); } catch (e) { console.error('[init] recoverRunningVideoTasks:', e); }
  if (recoveryEnabled) {
    try { startVideoRecoveryLoop(); } catch (e) { console.error('[init] startVideoRecoveryLoop:', e); }
  }
}

export const __EXECUTORS_INITIALIZED__ = true;
