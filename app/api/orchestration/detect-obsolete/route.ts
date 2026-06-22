import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { detectObsoleteAssets } from '@/lib/obsolete-assets';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || body?.id || '').trim();
  if (!projectId) return jsonError('projectId is required', 400);
  const storedProject = getProjectByIdForUser(projectId, user.id);
  if (!storedProject) return jsonError('项目不存在', 404);
  const snapshot = body?.project && typeof body.project === 'object'
    ? { ...body.project, id: projectId }
    : storedProject;
  const obsolete = detectObsoleteAssets(snapshot as any);
  return jsonOk({ obsolete, updatedAt: new Date().toISOString() });
}
