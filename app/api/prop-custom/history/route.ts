import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import { cleanupStaleCustomPropDrafts, listCustomProps } from '@/lib/custom-prop-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') || null;
  const limit = Number(url.searchParams.get('limit') || 0);
  const lifecycleStatus = url.searchParams.get('lifecycle') === 'draft' ? 'draft' : 'confirmed';
  cleanupStaleCustomPropDrafts(user.id, 48);
  const items = listCustomProps({ ownerId: user.id, projectId, limit, lifecycleStatus });
  return jsonOk({ ok: true, items: signCustomCharacterImageUrls(items, user.id) });
}
