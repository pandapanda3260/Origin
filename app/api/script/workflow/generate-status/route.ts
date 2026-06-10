import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getStageRun, SCRIPT_GENERATE_STAGE } from '@/lib/stage-inflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 查询某项目的剧本生成（full-create / expand / consult/confirm 任一路）
 * 是否仍在后台进行（前端刷新后续接进度 UI 用）。
 *
 * 用法：GET /api/script/workflow/generate-status?projectId=xxx
 *      → { status: 'none'|'running'|'done'|'error', step, pct, mode, startedAt, endedAt, error }
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const projectId = new URL(req.url).searchParams.get('projectId') || '';
  if (!projectId) return jsonError('projectId required');

  const st = getStageRun(user.id, projectId, SCRIPT_GENERATE_STAGE);
  if (!st) return jsonOk({ status: 'none' });
  return jsonOk({
    status: st.status,
    step: st.step,
    pct: st.pct,
    mode: (st.meta && st.meta.mode) || null,
    startedAt: st.startedAt,
    endedAt: st.endedAt || null,
    error: st.error || null,
  });
}
