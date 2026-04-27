import { NextRequest } from 'next/server';
import { getProject, updateProject, deleteProject } from '@/mocks/projects';
import { jsonOk, jsonError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const proj = getProject(params.id);
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(proj);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const proj = updateProject(params.id, body);
  if (!proj) return jsonError('项目不存在', 404);
  return jsonOk(proj);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const ok = deleteProject(params.id);
  if (!ok) return jsonError('项目不存在', 404);
  return jsonOk({ ok: true });
}
