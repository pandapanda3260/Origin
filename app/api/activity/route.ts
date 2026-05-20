import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({}));
  const path = String(body.path || '').slice(0, 500);
  const userAgent = String(req.headers.get('user-agent') || '').slice(0, 500);
  getDb()
    .prepare(
      `INSERT INTO user_activity (user_id, last_seen_at, path, user_agent, updated_at)
       VALUES (@userId, strftime('%Y-%m-%dT%H:%M:%fZ','now'), @path, @userAgent, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         path = excluded.path,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`,
    )
    .run({ userId: user.id, path, userAgent });
  return jsonOk({ ok: true });
}

