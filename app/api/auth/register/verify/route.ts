import { NextRequest } from 'next/server';
import { createUser, findUserByLogin, signToken, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const username = (body.username || '').trim();
  const email = (body.email || '').trim();
  const password = body.password || '';
  const token = (body.token || '').trim();

  if (!username || !email || !password || !token) {
    return jsonError('请填写所有注册字段和验证码', 400);
  }
  if (!/^[\w\u4e00-\u9fa5]{2,32}$/.test(username)) {
    return jsonError('用户名只能含中文/字母/数字/下划线，长度 2-32', 400);
  }
  if (password.length < 6) return jsonError('密码至少 6 位', 400);
  if (!/^\d{6,8}$/.test(token)) return jsonError('验证码格式不正确（6-8 位数字）', 400);

  // 阶段一：本地不校验 OTP，任意数字均通过。阶段五接邮件服务时改为真校验。
  const existed = await findUserByLogin(username);
  if (existed) return jsonError('用户名已被使用', 409);
  const existedEmail = await findUserByLogin(email);
  if (existedEmail) return jsonError('邮箱已被使用', 409);

  const user = await createUser({ username, password, email });
  const jwt = await signToken(user);
  return jsonOk({ token: jwt, user: userToPublic(user) });
}
