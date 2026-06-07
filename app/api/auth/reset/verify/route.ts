import { NextRequest } from 'next/server';
import { findUserByPhone, hashPassword, revokeUserTokens, signToken, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb, type UserRow } from '@/lib/db';
import { normalizePhone, verifyOtpCode } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone((body.phone || '').toString());
  const code = (body.code || '').toString().trim();
  const newPassword = (body.newPassword || '').toString();
  if (!phone || !code || !newPassword) return jsonError('请填写手机号、验证码和新密码', 400);
  if (newPassword.length < 6) return jsonError('密码至少 6 位', 400);
  if (!/^\d{6}$/.test(code)) return jsonError('验证码格式不正确', 400);

  const otpRes = await verifyOtpCode({ phone, code, purpose: 'reset_password' });
  if (!otpRes.ok) return jsonError(otpRes.error || '验证码校验失败', 400);

  const user = await findUserByPhone(phone);
  if (!user || user.disabled_at) return jsonError('账号不存在或不可用', 404);

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
