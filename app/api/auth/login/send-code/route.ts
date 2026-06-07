import { NextRequest } from 'next/server';
import { findUserByPhone } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { normalizePhone, sendOtpCode } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getClientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone((body.phone || '').toString());
  if (!phone) return jsonError('手机号格式不正确', 400);

  const user = await findUserByPhone(phone);
  if (!user) return jsonError('该手机号未注册，请先注册', 404);
  if (user.disabled_at) return jsonError('账号已停用，请联系管理员', 403);

  const res = await sendOtpCode({ phone, purpose: 'login', ip: getClientIp(req) });
  if (!res.ok) return jsonError(res.error, res.status);
  return jsonOk({ ok: true, message: '验证码已发送，请查收短信' });
}
