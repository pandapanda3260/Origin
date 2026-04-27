import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const db = getDb();
  db.prepare(
    `UPDATE user_credits SET cancel_at_period_end = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  ).run(user.id);
  return jsonOk({ ok: true, message: '已恢复自动续订' });
}
