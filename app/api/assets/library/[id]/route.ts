import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  adoptAssetAsCurrent,
  restoreAsset,
  serializeAsset,
  softDeleteAsset,
} from '@/lib/asset-library';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readAsset(ownerId: number, assetId: string) {
  const row = getDb().prepare<{ ownerId: number; assetId: string }, any>(
    `SELECT * FROM assets
      WHERE owner_id = @ownerId
        AND asset_id = @assetId
      LIMIT 1`,
  ).get({ ownerId, assetId });
  return row ? serializeAsset(row) : null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const asset = readAsset(user.id, params.id);
  if (!asset) return jsonError('素材不存在', 404);
  return jsonOk({ ok: true, asset });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const action = String(body.action || '').trim();
  let result: any;
  if (action === 'restore') result = restoreAsset(user.id, params.id);
  else if (action === 'set-current') result = adoptAssetAsCurrent(user.id, params.id);
  else return jsonError('未知素材操作', 400);
  if (!result?.ok) return jsonError(result?.error || '素材操作失败', result?.status || 400);
  return jsonOk({ ok: true, result, asset: readAsset(user.id, params.id) });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const result = softDeleteAsset({
    ownerId: user.id,
    assetId: params.id,
    clearCurrentIfOnlyVersion: body.clearCurrentIfOnlyVersion === true,
  });
  if (!result?.ok) return jsonError(result?.error || '素材删除失败', result?.status || 400);
  return jsonOk({ ok: true, result, asset: readAsset(user.id, params.id) });
}
