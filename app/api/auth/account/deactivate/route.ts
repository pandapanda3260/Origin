import { NextRequest } from 'next/server';
import { requireUser, revokeUserTokens, verifyPassword } from '@/lib/auth';
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
  const password = (body.password || '').toString();
  if (!password) return jsonError('请填写当前密码', 400);
  if (!(await verifyPassword(password, user.password_hash))) return jsonError('当前密码不正确', 400);

  const now = new Date().toISOString();
  const deletedUsername = `deleted_${user.id}_${Date.now()}`;
  getDb()
    .prepare(
      `UPDATE users
          SET disabled_at = COALESCE(disabled_at, @now),
              phone = NULL,
              username = @username,
              email = NULL,
              display_name = '已注销用户',
              updated_at = @now
        WHERE id = @id`,
    )
    .run({ id: user.id, now, username: deletedUsername });
  revokeUserTokens(user.id);
  return jsonOk({ ok: true });
}
