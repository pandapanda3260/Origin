/**
 * 用户鉴权层：密码哈希 + JWT 签发/验证 + 从请求读当前用户
 */

import { compare, hash } from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { NextRequest } from 'next/server';
import { getDb, userToPublic, type UserRow } from './db';

const SECRET = (() => {
  const env = process.env.JWT_SECRET;
  if (env && env.length >= 32) return new TextEncoder().encode(env);
  // 生产环境：缺密钥或密钥过短 → 直接拒绝启动，避免用兜底密钥给攻击者自助伪造 token
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[auth] 生产环境必须设置 JWT_SECRET（≥32 字节）。请在环境变量中设置，然后重启服务。',
    );
  }
  console.warn('[auth] JWT_SECRET 未设置或长度不足 32 字节，开发环境使用兜底密钥。生产环境必须覆盖！');
  return new TextEncoder().encode('dev-jwt-secret-please-change-me-32-bytes-long');
})();

const TOKEN_TTL = '30d';
const ALG = 'HS256';

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, 10);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return compare(plain, hashed);
}

export async function signToken(user: UserRow): Promise<string> {
  return new SignJWT({ sub: String(user.id), username: user.username })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<{ userId: number; username: string } | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { algorithms: [ALG] });
    const userId = Number(payload.sub);
    const username = String(payload.username || '');
    if (!userId || !username) return null;
    return { userId, username };
  } catch {
    return null;
  }
}

export function readBearer(req: NextRequest | Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  // EventSource 不能带自定义 header，前端会把 token 放到 query string ?token=...
  // 仅在 Accept: text/event-stream（即 SSE 连接）时允许从 query 读取 token，
  // 其他请求类型不接受 ?token=，避免 token 被日志/Referer 泄漏。
  const accept = req.headers.get('accept') || '';
  if (!accept.includes('text/event-stream')) return null;
  try {
    const url = new URL((req as any).url || '');
    const q = url.searchParams.get('token');
    if (q) return q.trim();
  } catch (_) {}
  return null;
}

export async function getCurrentUser(req: NextRequest | Request): Promise<UserRow | null> {
  const token = readBearer(req);
  if (!token) return null;
  const decoded = await verifyToken(token);
  if (!decoded) return null;
  const db = getDb();
  const row = db.prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: decoded.userId });
  return row ?? null;
}

export async function requireUser(req: NextRequest | Request): Promise<UserRow> {
  const u = await getCurrentUser(req);
  if (!u) {
    const err = new Error('unauthorized');
    (err as any).status = 401;
    throw err;
  }
  return u;
}

export async function findUserByLogin(usernameOrEmail: string): Promise<UserRow | null> {
  const db = getDb();
  const key = (usernameOrEmail || '').trim();
  if (!key) return null;
  // 根据输入是否含 @ 明确按邮箱或按用户名查，避免 "a" 同时匹配用户名 a 和邮箱 a@... 的歧义
  const isEmail = key.includes('@');
  if (isEmail) {
    const row = db
      .prepare<{ key: string }, UserRow>('SELECT * FROM users WHERE email = @key COLLATE NOCASE LIMIT 1')
      .get({ key: key.toLowerCase() });
    return row ?? null;
  }
  const row = db
    .prepare<{ key: string }, UserRow>('SELECT * FROM users WHERE username = @key LIMIT 1')
    .get({ key });
  return row ?? null;
}

export async function createUser(opts: {
  username: string;
  password: string;
  email?: string;
  displayName?: string;
  isAdmin?: boolean;
}): Promise<UserRow> {
  const db = getDb();
  const passwordHash = await hashPassword(opts.password);
  const stmt = db.prepare<
    { username: string; email: string | null; displayName: string; passwordHash: string; isAdmin: number; emailVerified: number },
    UserRow
  >(`INSERT INTO users (username, email, display_name, password_hash, is_admin, email_verified)
     VALUES (@username, @email, @displayName, @passwordHash, @isAdmin, @emailVerified)
     RETURNING *`);
  return stmt.get({
    username: opts.username,
    email: opts.email || null,
    displayName: opts.displayName || opts.username,
    passwordHash,
    isAdmin: opts.isAdmin ? 1 : 0,
    emailVerified: 1,
  })!;
}

export { userToPublic };
