import { NextRequest } from 'next/server';
import { findUserByLogin, signToken, userToPublic, verifyPassword } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) return jsonError('请填写用户名/邮箱和密码', 400);

  const user = await findUserByLogin(username);
  if (!user) return jsonError('账号或密码错误', 401);
  if (!(await verifyPassword(password, user.password_hash))) return jsonError('账号或密码错误', 401);

  const token = await signToken(user);
  return jsonOk({ token, user: userToPublic(user) });
}
