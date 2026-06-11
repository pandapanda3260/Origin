import { compare, hash } from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import type { NextRequest } from 'next/server';
import { getDb, type AdminUserRow } from './db';
import { ensureAdminPreviewUser } from './admin-shadow';
import { isProductionBuildPhase, isSecretUsableForCurrentPhase } from './secret-safety';

const ALG = 'HS256';
const ADMIN_TOKEN_TTL = '12h';
const PASSWORD_MIN_LENGTH = 12;
const REVOCATION_CACHE_TTL_MS = 30_000;

export const ADMIN_ACTION_CATEGORIES = [
  'user_account',
  'admin_account',
  'billing',
  'task',
  'knowledge',
  'content',
  'config',
  'storage',
  'observability',
  'audit',
  'admin_self',
] as const;

export type AdminActionCategory = (typeof ADMIN_ACTION_CATEGORIES)[number];

type CachedRevocation = {
  disabledAt: string | null;
  revokedAt: string | null;
  expiresAt: number;
};

const revocationCache = new Map<number, CachedRevocation>();
let cachedSecret: Uint8Array | null = null;
let warnedDevSecret = false;

function getAdminJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const adminSecret = process.env.ADMIN_JWT_SECRET;
  const userSecret = process.env.JWT_SECRET;
  if (adminSecret && userSecret && adminSecret === userSecret) {
    throw new Error('[admin-auth] ADMIN_JWT_SECRET must be different from JWT_SECRET.');
  }
  if (adminSecret && isSecretUsableForCurrentPhase(adminSecret)) {
    cachedSecret = new TextEncoder().encode(adminSecret);
    return cachedSecret;
  }
  if (process.env.NODE_ENV === 'production' && !isProductionBuildPhase()) {
    throw new Error('[admin-auth] Production requires non-placeholder ADMIN_JWT_SECRET with at least 32 bytes.');
  }
  if (!warnedDevSecret) {
    console.warn('[admin-auth] ADMIN_JWT_SECRET is missing or too short; using a development-only fallback.');
    warnedDevSecret = true;
  }
  cachedSecret = new TextEncoder().encode('dev-admin-jwt-secret-change-me-32-bytes');
  return cachedSecret;
}

export function validateAdminPassword(plain: string) {
  const password = String(plain || '');
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`后台密码至少需要 ${PASSWORD_MIN_LENGTH} 位`);
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 2) {
    throw new Error('后台密码需至少包含大小写字母、数字、符号中的两类');
  }
}

export async function hashAdminPassword(plain: string): Promise<string> {
  validateAdminPassword(plain);
  return hash(plain, 10);
}

export async function verifyAdminPassword(plain: string, hashed: string): Promise<boolean> {
  return compare(plain, hashed);
}

export async function signAdminToken(admin: AdminUserRow): Promise<string> {
  const issuedAtMs = Date.now();
  return new SignJWT({ sub: String(admin.id), username: admin.username, iat_ms: issuedAtMs })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(Math.floor(issuedAtMs / 1000))
    .setExpirationTime(ADMIN_TOKEN_TTL)
    .sign(getAdminJwtSecret());
}

export async function verifyAdminToken(token: string): Promise<{ adminId: number; username: string; issuedAt: number; issuedAtMs: number } | null> {
  try {
    const { payload } = await jwtVerify(token, getAdminJwtSecret(), { algorithms: [ALG] });
    const adminId = Number(payload.sub);
    const username = String(payload.username || '');
    const issuedAt = Number(payload.iat || 0);
    const issuedAtMs = Number((payload as any).iat_ms || 0);
    if (!adminId || !username || !issuedAt) return null;
    return { adminId, username, issuedAt, issuedAtMs };
  } catch {
    return null;
  }
}

export function readAdminToken(req: NextRequest | Request): string | null {
  const cookie = req.headers.get('cookie') || '';
  const match = /(?:^|;\s*)admin_token=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function getCurrentAdmin(req: NextRequest | Request): Promise<AdminUserRow | null> {
  const token = readAdminToken(req);
  if (!token) return null;
  const decoded = await verifyAdminToken(token);
  if (!decoded) return null;

  const state = getAdminRevocationState(decoded.adminId);
  if (state.disabledAt) return null;
  if (state.revokedAt && tokenIssuedBeforeRevocation(decoded.issuedAt, decoded.issuedAtMs, state.revokedAt)) return null;

  const admin = getDb()
    .prepare<{ id: number }, AdminUserRow>('SELECT * FROM admin_users WHERE id = @id')
    .get({ id: decoded.adminId });
  if (!admin || admin.disabled_at) return null;
  return admin;
}

export async function requireAdmin(req: NextRequest | Request): Promise<AdminUserRow> {
  const admin = await getCurrentAdmin(req);
  if (!admin) {
    const err = new Error('unauthorized');
    (err as any).status = 401;
    throw err;
  }
  return admin;
}

function getAdminRevocationState(adminId: number): CachedRevocation {
  const now = Date.now();
  const cached = revocationCache.get(adminId);
  if (cached && cached.expiresAt > now) return cached;

  const row = getDb()
    .prepare<{ id: number }, Pick<AdminUserRow, 'disabled_at' | 'token_revoked_at'>>(
      'SELECT disabled_at, token_revoked_at FROM admin_users WHERE id = @id',
    )
    .get({ id: adminId });
  const state = {
    disabledAt: row?.disabled_at || null,
    revokedAt: row?.token_revoked_at || null,
    expiresAt: now + REVOCATION_CACHE_TTL_MS,
  };
  revocationCache.set(adminId, state);
  return state;
}

export function clearAdminAuthCache(adminId?: number) {
  if (adminId) revocationCache.delete(adminId);
  else revocationCache.clear();
}

export async function createAdminUser(opts: { username: string; password: string }): Promise<AdminUserRow> {
  return createAdminUserWithShadow(opts);
}

export async function createAdminUserWithShadow(opts: { username: string; password: string }): Promise<AdminUserRow> {
  const username = String(opts.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('后台用户名只能包含字母、数字、下划线、点和横线，长度 3-32');
  }
  const passwordHash = await hashAdminPassword(opts.password);
  const db = getDb();
  return db.transaction(() => {
    const admin = db
      .prepare<{ username: string; passwordHash: string }, AdminUserRow>(
        `INSERT INTO admin_users (username, password_hash)
         VALUES (@username, @passwordHash)
         RETURNING *`,
      )
      .get({ username, passwordHash })!;
    ensureAdminPreviewUser(db, admin);
    return db.prepare<{ id: number }, AdminUserRow>('SELECT * FROM admin_users WHERE id = @id').get({ id: admin.id })!;
  })();
}

export function disableAdminUser(id: number): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE admin_users
          SET disabled_at = COALESCE(disabled_at, ?),
              token_revoked_at = ?
        WHERE id = ?`,
    )
    .run(now, now, id);
  clearAdminAuthCache(id);
  return result.changes > 0;
}

export function revokeAdminTokens(id: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE admin_users
          SET token_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(id);
  clearAdminAuthCache(id);
  return result.changes > 0;
}

export async function changeOwnAdminPassword(adminId: number, oldPassword: string, newPassword: string): Promise<boolean> {
  const db = getDb();
  const admin = db.prepare<{ id: number }, AdminUserRow>('SELECT * FROM admin_users WHERE id = @id').get({ id: adminId });
  if (!admin || admin.disabled_at) return false;
  if (!(await verifyAdminPassword(oldPassword, admin.password_hash))) return false;
  const passwordHash = await hashAdminPassword(newPassword);
  db.prepare(
    `UPDATE admin_users
        SET password_hash = ?,
            token_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(passwordHash, adminId);
  clearAdminAuthCache(adminId);
  return true;
}

export async function resetAdminPassword(adminId: number, newPassword: string): Promise<boolean> {
  const passwordHash = await hashAdminPassword(newPassword);
  const result = getDb()
    .prepare(
      `UPDATE admin_users
          SET password_hash = ?,
              token_revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(passwordHash, adminId);
  clearAdminAuthCache(adminId);
  return result.changes > 0;
}

export function toPublicAdmin(admin: AdminUserRow) {
  return {
    id: admin.id,
    username: admin.username,
    disabledAt: admin.disabled_at,
    lastLoginAt: admin.last_login_at,
    tokenRevokedAt: admin.token_revoked_at,
    previewUserId: admin.preview_user_id,
    createdAt: admin.created_at,
  };
}

function tokenIssuedBeforeRevocation(issuedAt: number, issuedAtMs: number, revokedAt: string): boolean {
  const revokedAtMs = Date.parse(revokedAt);
  if (!Number.isFinite(revokedAtMs)) return true;
  if (issuedAtMs > 0) return issuedAtMs < revokedAtMs;
  return issuedAt <= Math.floor(revokedAtMs / 1000);
}
