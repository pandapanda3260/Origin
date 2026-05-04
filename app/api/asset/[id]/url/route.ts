import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getImageMeta } from '@/lib/image-gen';
import { buildSignedImageUrl, normalizeAssetUrlTtl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return jsonError('bad id', 400);

  const meta = getImageMeta(id, user.id);
  if (!meta) return jsonError('图片不存在', 404);

  const reqUrl = new URL(req.url);
  const ttl = normalizeAssetUrlTtl(reqUrl.searchParams.get('ttl'));
  return jsonOk(buildSignedImageUrl(id, user.id, ttl));
}
