import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { buildWorldTemplateFromProject, getWorldTemplate, upsertWorldTemplate } from '@/lib/world-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body.projectId || '').trim();
  if (!projectId) return jsonError('缺少 projectId', 400);
  const mode = String(body.mode || '').trim();
  if (mode !== 'create' && mode !== 'update') return jsonError('mode 必须是 create 或 update', 400);
  const templateId = body.templateId ? String(body.templateId).trim() : '';
  if (mode === 'update' && !templateId) return jsonError('更新世界观模板需要 templateId', 400);
  if (mode === 'create' && templateId) return jsonError('新建世界观模板时不要传 templateId', 400);
  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);
  if (mode === 'update' && !getWorldTemplate(user.id, templateId)) return jsonError('模板不存在', 404);
  if (mode === 'create') {
    const derivedId = `world_${String(projectId).replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 80)}`;
    if (getWorldTemplate(user.id, derivedId)) return jsonError('该项目已存在派生世界观模板，请选择更新已有模板或先删除旧模板', 409);
  }
  const input = buildWorldTemplateFromProject(project, {
    templateId: templateId || undefined,
    name: body.name ? String(body.name) : undefined,
    include: body.include && typeof body.include === 'object' ? {
      characters: body.include.characters !== false,
      locations: body.include.locations !== false,
      props: body.include.props !== false,
      terminology: body.include.terminology !== false,
    } : undefined,
  });
  const template = upsertWorldTemplate(user.id, input);
  return jsonOk({ ok: true, template });
}
