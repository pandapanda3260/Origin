import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { deleteToolboxItem, getToolboxItemForUser, serializeToolboxItem, syncRunningVideoToolboxItems } from '@/lib/toolbox-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  syncRunningVideoToolboxItems(user.id);
  const item = getToolboxItemForUser(params.id, user.id);
  if (!item) return jsonError('工具箱历史不存在', 404);
  return jsonOk({ ok: true, item: serializeToolboxItem(item) });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const deleted = deleteToolboxItem(params.id, user.id);
  if (!deleted) return jsonError('工具箱历史不存在', 404);
  return jsonOk({ ok: true });
}
