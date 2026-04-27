import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { deleteProjectForUser, getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const proj = getProjectByIdForUser(params.id, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(proj);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const proj = updateProjectForUser(params.id, user.id, body);
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(proj);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const ok = deleteProjectForUser(params.id, user.id);
  if (!ok) return jsonError('项目不存在', 404);
  return jsonOk({ ok: true });
}
