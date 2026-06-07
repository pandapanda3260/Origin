import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 用户在剧本页确认最终剧本时调用，标记 scriptApproved=true。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const scriptText = (body.script || body.scriptText || '').toString().trim();
  if (!projectId) return jsonError('缺 projectId', 400);

  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  const finalScript = scriptText || ((proj as any).script || (proj as any).scriptDraft || '').toString().trim();
  if (!finalScript) return jsonError('当前没有剧本可确认', 400);

  updateProjectForUser(projectId, user.id, {
    script: finalScript,
    scriptDraft: finalScript,
    scriptApproved: true,
    scriptReviewState: 'approved',
    currentStep: 2,
  });

  return jsonOk({ ok: true, projectId });
}
