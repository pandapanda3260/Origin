import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { sendOtpCode } from '@/lib/otp';
import { findUserByLogin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getClientIp(req: NextRequest): string | null {
  const h = req.headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return h.get('x-real-ip') || null;
}

/**
 * 发送注册邮箱验证码。
 *
 * 开发环境：验证码会 console.log 到后端日志。
 * 生产环境：在 lib/otp.ts 的 sendEmail() 接入真实 SMTP。
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const username = (body.username || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  if (!username || !email || !password) return jsonError('请先填写用户名、邮箱和密码', 400);
  if (password.length < 6) return jsonError('密码至少 6 位', 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonError('邮箱格式不正确', 400);
  if (!/^[\w一-龥]{2,32}$/.test(username)) {
    return jsonError('用户名只能含中文/字母/数字/下划线，长度 2-32', 400);
  }

  // 邮箱已被注册——早返回，避免冷却期被滥用探测
  const existed = await findUserByLogin(email);
  if (existed) return jsonError('邮箱已被注册', 409);

  const res = await sendOtpCode({
    email,
    purpose: 'register',
    ip: getClientIp(req),
  });
  if (!res.ok) return jsonError(res.error, res.status);
  return jsonOk({
    ok: true,
    message: '验证码已发送，请查收邮件（开发环境请看后端控制台日志）',
  });
}
