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
  // 开发环境兜底密钥（提示用户在生产环境务必通过 JWT_SECRET 覆盖）
  if (process.env.NODE_ENV === 'production') {
    console.warn('[auth] JWT_SECRET 未设置（或长度不足 32），使用开发兜底，请在生产环境设置！');
  }
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
  return m ? m[1].trim() : null;
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
  const row = db
    .prepare<{ key: string }, UserRow>('SELECT * FROM users WHERE username = @key OR email = @key LIMIT 1')
    .get({ key: usernameOrEmail });
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
