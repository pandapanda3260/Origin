import { NextRequest } from 'next/server';
import { findUserByPhone } from '@/lib/auth';
import { jsonOk } from '@/lib/api-helpers';
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
  const message = '如果该手机号已注册，验证码将发送到对应手机';
  if (!phone) return jsonOk({ ok: true, message });

  const user = await findUserByPhone(phone);
  if (user && !user.disabled_at) {
    const res = await sendOtpCode({ phone, purpose: 'reset_password', ip: getClientIp(req) });
    if (!res.ok) console.warn('[auth/reset] send code failed:', res.error);
  }
  return jsonOk({ ok: true, message });
}
