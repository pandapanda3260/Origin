import { NextRequest } from 'next/server';
import { findUserByPhone, signToken, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { normalizePhone, verifyOtpCode } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone((body.phone || '').toString());
  const code = (body.code || '').toString().trim();
  if (!phone || !code) return jsonError('请填写手机号和验证码', 400);
  if (!/^\d{6}$/.test(code)) return jsonError('验证码格式不正确', 400);

  const user = await findUserByPhone(phone);
  if (!user) return jsonError('该手机号未注册，请先注册', 404);
  if (user.disabled_at) return jsonError('账号已停用，请联系管理员', 403);

  const otpRes = await verifyOtpCode({ phone, code, purpose: 'login' });
  if (!otpRes.ok) return jsonError(otpRes.error || '验证码校验失败', 400);

  const token = await signToken(user);
  return jsonOk({ token, user: userToPublic(user) });
}
