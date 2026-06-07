import { NextRequest } from 'next/server';
import { hashPassword, requireUser, revokeUserTokens, signToken, userToPublic, verifyPassword } from '@/lib/auth';
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
  const oldPassword = (body.oldPassword || '').toString();
  const newPassword = (body.newPassword || '').toString();
  if (!oldPassword || !newPassword) return jsonError('请填写旧密码和新密码', 400);
  if (newPassword.length < 6) return jsonError('密码至少 6 位', 400);
  if (!(await verifyPassword(oldPassword, user.password_hash))) return jsonError('旧密码不正确', 400);

  const passwordHash = await hashPassword(newPassword);
  getDb()
    .prepare(
      `UPDATE users
          SET password_hash = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(passwordHash, user.id);
  revokeUserTokens(user.id);

  const fresh = getDb().prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: user.id })!;
  const token = await signToken(fresh);
  return jsonOk({ token, user: userToPublic(fresh) });
}
