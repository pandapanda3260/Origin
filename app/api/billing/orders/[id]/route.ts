import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM billing_orders WHERE id = @id AND user_id = @uid')
    .get({ id: params.id, uid: user.id });
  if (!row) return jsonError('订单不存在', 404);
  return jsonOk({
    id: row.id,
    kind: row.kind,
    planCode: row.plan_code,
    provider: row.provider,
    amountCents: row.amount_cents,
    currency: row.currency,
    creditsAdded: row.credits_added,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
