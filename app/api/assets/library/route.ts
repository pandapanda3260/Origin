import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  getProjectAssetLibrarySnapshot,
  listAssetLibraryItems,
  type AssetKind,
  type AssetSource,
} from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enumParam<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  if (!value) return null;
  return allowed.includes(value as T) ? value as T : null;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const mode = url.searchParams.get('mode');
  if (mode === 'current' && projectId) {
    return jsonOk({
      ok: true,
      projectId,
      assetLibrary: getProjectAssetLibrarySnapshot(user.id, projectId),
    });
  }

  const assetKind = enumParam<AssetKind>(url.searchParams.get('kind'), ['image', 'video']);
  const source = enumParam<AssetSource>(
    url.searchParams.get('source'),
    ['generated', 'uploaded', 'toolbox', 'edit_export', 'imported'],
  );
  const stage = url.searchParams.get('stage');
  const limit = Number(url.searchParams.get('limit') || 50);
  const offset = Number(url.searchParams.get('offset') || 0);

  return jsonOk({
    ok: true,
    ...listAssetLibraryItems({
      ownerId: user.id,
      projectId,
      assetKind,
      source,
      stage,
      limit,
      offset,
    }),
  });
}
