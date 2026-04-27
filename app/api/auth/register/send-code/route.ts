import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 阶段一：本地不发真邮件，验证码暂时接受任何 8 位数字。
// 阶段五接邮件服务时再补真实发送逻辑（SMTP / Resend / 阿里云邮推等）。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const username = (body.username || '').trim();
  const email = (body.email || '').trim();
  const password = body.password || '';
  if (!username || !email || !password) return jsonError('请先填写用户名、邮箱和密码', 400);
  if (password.length < 6) return jsonError('密码至少 6 位', 400);
  return jsonOk({
    ok: true,
    message: '[本地] 验证码已"发送"，注册时填任意 8 位数字（如 12345678）即可',
  });
}
