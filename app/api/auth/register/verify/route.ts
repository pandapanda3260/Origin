import { NextRequest } from 'next/server';
import { createUser, findUserByPhone, signToken, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { normalizePhone, verifyOtpCode } from '@/lib/otp';
import { isRegistrationEnabled } from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isRegistrationEnabled()) {
    return jsonError('注册暂时关闭，请稍后再试', 503);
  }

  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone((body.phone || '').toString());
  const displayName = (body.displayName || '').toString().trim();
  const password = (body.password || '').toString();
  const code = (body.code || body.token || '').toString().trim();

  if (!phone || !displayName || !password || !code) {
    return jsonError('请填写所有注册字段和验证码', 400);
  }
  if (displayName.length < 2 || displayName.length > 20) return jsonError('昵称长度需为 2-20 个字符', 400);
  if (password.length < 6) return jsonError('密码至少 6 位', 400);
  if (!/^\d{6}$/.test(code)) return jsonError('验证码格式不正确', 400);

  // 先做账号冲突检查，避免验证码被消费后才提示手机号不可用。
  const existed = await findUserByPhone(phone);
  if (existed) return jsonError('手机号已注册', 409);

  // 真正校验 OTP
  const otpRes = await verifyOtpCode({ phone, code, purpose: 'register' });
  if (!otpRes.ok) return jsonError(otpRes.error || '验证码校验失败', 400);

  let user;
  try {
    user = await createUser({ phone, password, displayName });
  } catch (e: any) {
    // UNIQUE 竞争兜底 → 409
    if (e && typeof e.message === 'string' && /UNIQUE/i.test(e.message)) {
      return jsonError('手机号已注册', 409);
    }
    throw e;
  }
  const jwt = await signToken(user);
  return jsonOk({ token: jwt, user: userToPublic(user) });
}
