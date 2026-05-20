import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { mergeProjectCharacterLocksIntoWorldTemplate } from '@/lib/world-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return jsonError('缺少 projectId', 400);
  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);
  const characterIds = Array.isArray(body.characterIds)
    ? body.characterIds.map((id: any) => String(id || '').trim()).filter(Boolean)
    : undefined;
  const template = mergeProjectCharacterLocksIntoWorldTemplate(user.id, params.id, project, { characterIds });
  if (!template) return jsonError('模板不存在', 404);
  return jsonOk({ ok: true, template });
}
