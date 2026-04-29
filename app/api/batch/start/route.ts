import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { createBatch } from '@/lib/batches';
import '@/lib/init-executors'; // 副作用：注册所有 executor

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const batchType: string = (body.batchType || '').toString();
  const projectId: string = (body.projectId || '').toString();
  const options: any = body.options || {};

  if (!batchType) return jsonError('缺 batchType', 400);
  if (!projectId) return jsonError('缺 projectId', 400);

  // targets 兼容：
  //   1. 标准：body.targets = [{...}, ...]
  //   2. videoTasks.js 老协议：body.storyboardIndices = [0, 2, 3]
  //      → 自动展开成 [{ groupIdx, idx, storyboardIdx }]
  let targets: any[] = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length && Array.isArray(body.storyboardIndices)) {
    targets = body.storyboardIndices
      .map((v: any) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n >= 0)
      .map((n: number) => ({ groupIdx: n, idx: n, storyboardIdx: n }));
  }

  if (!targets.length) return jsonError('targets 不能为空', 400);

  try {
    const { batchId, total } = createBatch({ user, batchType, projectId, targets, options });
    return jsonOk({ batchId, total, status: 'queued' });
  } catch (e: any) {
    return jsonError('创建 batch 失败：' + (e?.message || String(e)), 500);
  }
}
