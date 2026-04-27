/**
 * 模块加载即"注册"所有 batch executor。
 *
 * Next.js 在每个 Route 文件首次被调用时会按需加载它的 import 链，
 * 所以我们让 /api/batch/start 和 /api/batch/[id]/stream 都 import 这个文件，
 * 进程内只会有一份注册（registerExecutor 是 Map.set，幂等）。
 */
import './batch-executors';

export const __EXECUTORS_INITIALIZED__ = true;
