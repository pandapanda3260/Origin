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
  // 先把"已在 provider 侧结束但本地还标记 running"的视频项对账掉，避免误拦真正已完成的项。
  syncRunningVideoToolboxItems(user.id);
  const existing = getToolboxItemForUser(params.id, user.id);
  if (!existing) return jsonError('工具箱历史不存在', 404);
  // 运行中的项不允许删除：删除后会切断失败退款路径，可能造成资损。
  if (existing.status === 'running') return jsonError('生成中，完成后才可删除', 409);
  const deleted = deleteToolboxItem(params.id, user.id);
  if (!deleted) return jsonError('工具箱历史不存在', 404);
  return jsonOk({ ok: true });
}
