import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  deleteUserStyleTemplate,
  getStyleTemplateForUser,
  updateUserStyleTemplate,
} from '@/lib/style-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const template = getStyleTemplateForUser(user.id, params.id);
  if (!template) return jsonError('风格模板不存在', 404);
  return jsonOk({ template });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const result = updateUserStyleTemplate(user.id, params.id, body.template || body);
  if (result.error === 'not_found') return jsonError('风格模板不存在', 404);
  if (result.error === 'forbidden') return jsonError('不能修改系统模板或其他用户的模板', 403);
  return jsonOk({ ok: true, template: result.template });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const result = deleteUserStyleTemplate(user.id, params.id);
  if (result.error === 'not_found') return jsonError('风格模板不存在', 404);
  if (result.error === 'forbidden') return jsonError('不能删除系统模板或其他用户的模板', 403);
  return jsonOk({ ok: true });
}

