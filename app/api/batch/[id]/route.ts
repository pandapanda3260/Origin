import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { cancelBatchForUser, getBatchSnapshot } from '@/lib/batches';
import '@/lib/init-executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const snap = getBatchSnapshot(params.id, user.id);
  if (!snap) return jsonError('batch 不存在', 404);
  return jsonOk(snap);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '').trim();
  if (action !== 'cancel') return jsonError('unsupported batch action', 400);
  try {
    const result = cancelBatchForUser({
      batchId: params.id,
      ownerId: user.id,
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
    });
    return jsonOk({ success: true, ...result });
  } catch (e: any) {
    return jsonError(e?.message || 'cancel batch failed', Number(e?.status || 500));
  }
}
