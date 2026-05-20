import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { describeProjectArtifactStatus } from '@/lib/sentinel';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || body?.id || '').trim();
  if (!projectId) return jsonError('projectId is required', 400);
  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);
  const obsolete = describeProjectArtifactStatus(project as any, projectId, {
    includeUsable: false,
    consumerOperation: 'detect_obsolete',
  });
  return jsonOk({ obsolete, updatedAt: new Date().toISOString() });
}
