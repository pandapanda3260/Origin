import { NextRequest } from 'next/server';
import { findUserByPhone, signToken, userToPublic, verifyPassword } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { normalizePhone } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 预先生成的 dummy bcrypt 哈希（cost=10，明文是随机字符串），
// 用来在用户不存在时也跑一次 bcrypt compare，常量化响应时间避免用户名枚举。
// 这个哈希对应一个永远不会撞上的密码，不涉及任何真实用户数据。
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8H6QZyq3oG7Lqzz.vl4mJwJ3ZpQ0vu';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const phone = normalizePhone(body.phone || '');
  const password = body.password || '';
  if (!phone || !password) return jsonError('请填写手机号和密码', 400);

  const user = await findUserByPhone(phone);

  // 即使账号不存在也跑一次 bcrypt compare，让成功与失败耗时接近（~100ms 级）
  // 消除"快速失败 = 账号不存在"的时序侧信道。
  const hashToCompare = user ? user.password_hash : DUMMY_HASH;
  const passwordOk = await verifyPassword(password, hashToCompare);

  if (!user || !passwordOk) return jsonError('手机号或密码错误', 401);
  if (user.disabled_at) return jsonError('账号已停用，请联系管理员', 403);

  const token = await signToken(user);
  return jsonOk({ token, user: userToPublic(user) });
}
