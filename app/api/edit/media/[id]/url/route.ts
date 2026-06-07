import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedUploadUrl, normalizeAssetUrlTtl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 给上传素材换一个带签名的临时直链，供 <video>/<audio>/<img> 在带不了 Bearer 的场景使用。
 * 与 /api/videos/[id]/url 对等（生成片段那套）。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return jsonError('bad id', 400);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM uploads WHERE id = @id AND owner_id = @uid LIMIT 1',
    )
    .get({ id, uid: user.id });
  if (!row) return jsonError('素材不存在', 404);

  const reqUrl = new URL(req.url);
  const ttl = normalizeAssetUrlTtl(reqUrl.searchParams.get('ttl'));
  const signed = buildSignedUploadUrl(id, user.id, ttl);
  return jsonOk({
    ...signed,
    protectedUrl: '/api/edit/media/' + encodeURIComponent(id),
  });
}
