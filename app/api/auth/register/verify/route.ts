import { NextRequest } from 'next/server';
import { createUser, findUserByLogin, signToken, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { verifyOtpCode } from '@/lib/otp';
import { isRegistrationEnabled } from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isRegistrationEnabled()) {
    return jsonError('注册暂时关闭，请稍后再试', 503);
  }

  const body = await req.json().catch(() => ({} as any));
  const username = (body.username || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  const token = (body.token || '').toString().trim();

  if (!username || !email || !password || !token) {
    return jsonError('请填写所有注册字段和验证码', 400);
  }
  if (!/^[\w一-龥]{2,32}$/.test(username)) {
    return jsonError('用户名只能含中文/字母/数字/下划线，长度 2-32', 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonError('邮箱格式不正确', 400);
  if (password.length < 6) return jsonError('密码至少 6 位', 400);
  if (!/^\d{4,8}$/.test(token)) return jsonError('验证码格式不正确', 400);

  // 真正校验 OTP
  const otpRes = await verifyOtpCode({ email, code: token, purpose: 'register' });
  if (!otpRes.ok) return jsonError(otpRes.error || '验证码校验失败', 400);

  const existed = await findUserByLogin(username);
  if (existed) return jsonError('用户名已被使用', 409);
  const existedEmail = await findUserByLogin(email);
  if (existedEmail) return jsonError('邮箱已被使用', 409);

  let user;
  try {
    user = await createUser({ username, password, email });
  } catch (e: any) {
    // UNIQUE 竞争兜底 → 409
    if (e && typeof e.message === 'string' && /UNIQUE/i.test(e.message)) {
      return jsonError('用户名或邮箱已被使用', 409);
    }
    throw e;
  }
  const jwt = await signToken(user);
  return jsonOk({ token: jwt, user: userToPublic(user) });
}
