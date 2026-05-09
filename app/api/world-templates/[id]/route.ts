import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonOk, jsonError } from '@/lib/api-helpers';
import { deleteWorldTemplate, getWorldTemplate } from '@/lib/world-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const template = getWorldTemplate(user.id, params.id);
  if (!template) return jsonError('模板不存在', 404);
  return jsonOk({ template });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const ok = deleteWorldTemplate(user.id, params.id);
  if (!ok) return jsonError('模板不存在', 404);
  return jsonOk({ ok: true });
}
