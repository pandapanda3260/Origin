import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getBatchSnapshot } from '@/lib/batches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const snap = getBatchSnapshot(params.id);
  if (!snap) return jsonError('batch 不存在', 404);
  return jsonOk(snap);
}
