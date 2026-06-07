import { NextRequest } from 'next/server';
import { requireUser, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb, type UserRow } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let user: UserRow;
  try {
    user = await requireUser(req);
  } catch {
    return jsonError('unauthorized', 401);
  }
  const body = await req.json().catch(() => ({} as any));
  const displayName = (body.displayName || '').toString().trim();
  if (displayName.length < 2 || displayName.length > 20) return jsonError('昵称长度需为 2-20 个字符', 400);

  getDb()
    .prepare(
      `UPDATE users
          SET display_name = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(displayName, user.id);
  const fresh = getDb().prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: user.id })!;
  return jsonOk({ ok: true, user: userToPublic(fresh) });
}
