import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 编辑工作台时间轴状态：保存到 project.timeline。
 * GET 入参从 query string 取 projectId；PUT 从 body 取。
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  const tl = (proj as any).timeline || { tracks: [], clips: [], duration: 0 };
  return jsonOk(tl);
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = body.projectId;
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  const timeline = body.timeline ?? { tracks: body.tracks || [], clips: body.clips || [], duration: body.duration || 0 };
  updateProjectForUser(projectId, user.id, { timeline });
  return jsonOk({ ok: true, timeline });
}
