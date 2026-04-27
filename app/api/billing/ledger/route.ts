import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { listLedger } from '@/lib/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const items = listLedger(user.id, limit, offset);
  return jsonOk({ items, total: items.length });
}
