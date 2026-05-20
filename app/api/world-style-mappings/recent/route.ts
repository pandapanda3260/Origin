import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { setRecentWorldStyleMapping } from '@/lib/style-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const result = setRecentWorldStyleMapping(user.id, {
    worldTemplateOwnerId: body.worldTemplateOwnerId || body.worldOwnerId,
    worldTemplateId: body.worldTemplateId || body.worldId || '',
    styleTemplateId: body.styleTemplateId || body.styleId || '',
  });
  if (result.error === 'invalid') return jsonError('参数不完整', 400);
  if (result.error === 'world_not_found') return jsonError('世界观模板不存在', 404);
  if (result.error === 'style_not_found') return jsonError('风格模板不存在', 404);
  return jsonOk({ ok: true });
}

