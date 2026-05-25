import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { batchPreflightPayload } from '@/lib/batch-preflight';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const batchType = String(body?.batchType || '');
  const projectId = String(body?.projectId || '');
  const targets = Array.isArray(body?.targets) ? body.targets : [];

  if (!batchType) return jsonError('缺 batchType', 400);
  if (!projectId) return jsonError('缺 projectId', 400);
  if (!targets.length) return jsonError('targets 不能为空', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  return jsonOk(batchPreflightPayload(project, projectId, batchType, targets));
}
