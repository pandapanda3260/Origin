import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { deleteScriptLibraryItem, updateScriptLibraryItem } from '@/lib/script-library-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } },
) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const item = updateScriptLibraryItem(user.id, params.id, params.itemId, body);
  if (!item) return jsonError('剧本库条目不存在', 404);
  return jsonOk({ ok: true, item });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: { id: string; itemId: string } },
) {
  return PATCH(req, ctx);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } },
) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const ok = deleteScriptLibraryItem(user.id, params.id, params.itemId);
  if (!ok) return jsonError('剧本库条目不存在', 404);
  return jsonOk({ ok: true });
}
