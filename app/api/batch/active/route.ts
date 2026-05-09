import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getActiveBatchesForUser } from '@/lib/batches';
import '@/lib/init-executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 列出当前用户在指定项目下所有未完成（queued/running）的批次。
 * 前端 reattach 用来恢复 SSE 订阅与 UI 进度。
 *
 * 用法：GET /api/batch/active?projectId=xxx
 *      返回 { items: [{ batchId, batchType, status, snapshot, tasks }], total }
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') || undefined;

  try {
    const items = getActiveBatchesForUser({ ownerId: user.id, projectId });
    // 前端各模块（storyboard.js/videoTasks.js/assets.js）历史上读 `resp.batches`，
    // 同时 main.js 等地方也有读 `resp.items`，两个字段都返回兼容
    return jsonOk({ batches: items, items, total: items.length });
  } catch (e: any) {
    return jsonError('查询活跃批次失败：' + (e?.message || String(e)), 500);
  }
}
