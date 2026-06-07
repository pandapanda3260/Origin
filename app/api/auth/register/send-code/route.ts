import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { normalizePhone, sendOtpCode } from '@/lib/otp';
import { findUserByPhone } from '@/lib/auth';
import { isRegistrationEnabled } from '@/lib/system-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getClientIp(req: NextRequest): string | null {
  const h = req.headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return h.get('x-real-ip') || null;
}

/**
 * 发送注册短信验证码。
 *
 * 开发环境：验证码会 console.log 到后端日志。
 * 生产环境：通过腾讯云短信发送。
 */
export async function POST(req: NextRequest) {
  if (!isRegistrationEnabled()) {
    return jsonError('注册暂时关闭，请稍后再试', 503);
  }

  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone((body.phone || '').toString());
  if (!phone) return jsonError('手机号格式不正确', 400);

  const existed = await findUserByPhone(phone);
  if (existed) return jsonError('手机号已注册', 409);

  const res = await sendOtpCode({
    phone,
    purpose: 'register',
    ip: getClientIp(req),
  });
  if (!res.ok) return jsonError(res.error, res.status);
  return jsonOk({
    ok: true,
    message: '验证码已发送，请查收短信（开发环境请看后端控制台日志）',
  });
}
