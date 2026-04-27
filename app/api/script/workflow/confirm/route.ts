import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 用户在剧本页点"确认剧本，进入资产库"时调用，标记 scriptApproved=true。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  if (!projectId) return jsonError('缺 projectId', 400);

  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);

  updateProjectForUser(projectId, user.id, {
    scriptApproved: true,
    currentStep: 2,
  });

  return jsonOk({ ok: true, projectId });
}
