/**
 * 模块加载即"注册"所有 batch executor + 装日志钩子。
 *
 * Next.js 在每个 Route 文件首次被调用时会按需加载它的 import 链，
 * 所以我们让 /api/batch/start 和 /api/batch/[id]/stream 都 import 这个文件，
 * 进程内只会有一份注册（registerExecutor 是 Map.set，幂等）。
 */
import './batch-executors';
import { installConsoleHook } from './sys-logs';
import { reapOrphanBatches } from './batches';
import { reapOrphanExports } from './exports-reap';

installConsoleHook();

// 启动时回收上次进程留下的孤儿 batch/export + 退款
// 用 globalThis 标记避免 HMR 下重复 reap
const reapKey = '__qd_batches_reaped__';
if (!(globalThis as any)[reapKey]) {
  (globalThis as any)[reapKey] = true;
  try { reapOrphanBatches(); } catch (e) { console.error('[init] reapOrphanBatches:', e); }
  try { reapOrphanExports(); } catch (e) { console.error('[init] reapOrphanExports:', e); }
}

export const __EXECUTORS_INITIALIZED__ = true;

