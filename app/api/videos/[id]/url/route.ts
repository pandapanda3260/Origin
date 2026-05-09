import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl, normalizeAssetUrlTtl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return jsonError('bad id', 400);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM video_tasks WHERE id = @id AND owner_id = @uid LIMIT 1',
    )
    .get({ id, uid: user.id });
  if (!row) return jsonError('视频不存在', 404);

  const reqUrl = new URL(req.url);
  const ttl = normalizeAssetUrlTtl(reqUrl.searchParams.get('ttl'));
  const signed = buildSignedVideoUrl(id, user.id, ttl);
  return jsonOk({
    ...signed,
    protectedUrl: '/api/videos/file/' + encodeURIComponent(id),
  });
}
