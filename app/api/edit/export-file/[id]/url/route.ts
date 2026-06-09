import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedExportUrl, normalizeAssetUrlTtl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 返回剪辑导出成片的签名播放地址。前端任务页右侧预览用它把 Bearer-only 的
 * /api/edit/export-file/{id} 换成带 exp+sig 的地址，<video> 才能直接流式播放。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return jsonError('bad id', 400);

  const db = getDb();
  const row = db
    .prepare<{ id: string }, { id: string; owner_id: number; status: string; filename: string | null }>(
      'SELECT id, owner_id, status, filename FROM exports WHERE id = @id LIMIT 1',
    )
    .get({ id });
  if (!row || !row.filename || row.status !== 'completed') return jsonError('成片不存在或未完成', 404);
  if (Number(row.owner_id) !== Number(user.id)) return jsonError('forbidden', 403);

  const reqUrl = new URL(req.url);
  const ttl = normalizeAssetUrlTtl(reqUrl.searchParams.get('ttl'));
  const signed = buildSignedExportUrl(id, user.id, ttl);
  return jsonOk({
    ...signed,
    protectedUrl: '/api/edit/export-file/' + encodeURIComponent(id),
  });
}
