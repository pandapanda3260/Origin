import { NextRequest } from 'next/server';
import { getDb, type AdminUserRow } from '@/lib/db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signAdminToken, toPublicAdmin, verifyAdminPassword } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8H6QZyq3oG7Lqzz.vl4mJwJ3ZpQ0vu';
const ADMIN_TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60;
const FAILED_LOGIN_WINDOW_MS = 60_000;
const FAILED_LOGIN_LIMIT = 5;
const FAILED_LOGIN_MAX_BUCKETS = 10_000;
const globalLoginState = globalThis as typeof globalThis & {
  __originAdminFailedLoginBuckets?: Map<string, { count: number; firstAt: number; blockedUntil: number }>;
};
const failedLoginBuckets = globalLoginState.__originAdminFailedLoginBuckets
  || (globalLoginState.__originAdminFailedLoginBuckets = new Map<string, { count: number; firstAt: number; blockedUntil: number }>());

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const ip = getClientIp(req);
  if (isLoginBlocked(ip)) {
    console.warn(`[admin-auth] blocked admin login attempt ip=${ip} username=${username || '<empty>'}`);
    return jsonError('后台登录尝试过于频繁，请稍后再试', 429);
  }
  if (!username || !password) {
    recordFailedLogin(ip, username, 'missing_credentials');
    return jsonError('请填写后台账号和密码', 400);
  }

  const admin = getDb()
    .prepare<{ username: string }, AdminUserRow>(
      'SELECT * FROM admin_users WHERE username = @username LIMIT 1',
    )
    .get({ username });

  const hashToCompare = admin ? admin.password_hash : DUMMY_HASH;
  const ok = await verifyAdminPassword(password, hashToCompare);
  if (!admin || admin.disabled_at || !ok) {
    recordFailedLogin(ip, username, admin?.disabled_at ? 'disabled_admin' : 'invalid_credentials');
    return jsonError('后台账号或密码错误', 401);
  }
  clearFailedLogin(ip);

  getDb()
    .prepare(
      `UPDATE admin_users
          SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(admin.id);

  const fresh = getDb()
    .prepare<{ id: number }, AdminUserRow>('SELECT * FROM admin_users WHERE id = @id')
    .get({ id: admin.id }) || admin;
  const token = await signAdminToken(fresh);
  const resp = jsonOk({ ok: true, admin: toPublicAdmin(fresh) });
  resp.cookies.set('admin_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldUseSecureAdminCookie(req),
    path: '/',
    maxAge: ADMIN_TOKEN_MAX_AGE_SECONDS,
  });
  return resp;
}

function shouldUseSecureAdminCookie(req: NextRequest): boolean {
  const forwardedProto = String(req.headers.get('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  if (forwardedProto) return forwardedProto === 'https';
  return req.nextUrl.protocol === 'https:';
}

function getClientIp(req: NextRequest): string {
  const directIp = String((req as any).ip || '').trim();
  const realIp = String(req.headers.get('x-real-ip') || '').trim();
  if (process.env.ADMIN_TRUST_PROXY === '1') {
    const forwarded = req.headers.get('x-forwarded-for') || '';
    const firstForwarded = forwarded.split(',')[0]?.trim();
    return firstForwarded || realIp || directIp || fallbackClientKey(req);
  }
  return directIp || realIp || fallbackClientKey(req);
}

function fallbackClientKey(req: NextRequest): string {
  const ua = req.headers.get('user-agent') || 'unknown-user-agent';
  const acceptLanguage = req.headers.get('accept-language') || '';
  return `local:${smallHash(`${ua}|${acceptLanguage}`)}`;
}

function smallHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function isLoginBlocked(ip: string): boolean {
  const now = Date.now();
  pruneFailedLoginBuckets(now);
  const bucket = failedLoginBuckets.get(ip);
  if (!bucket) return false;
  if (bucket.blockedUntil > now) return true;
  if (now - bucket.firstAt > FAILED_LOGIN_WINDOW_MS) {
    failedLoginBuckets.delete(ip);
    return false;
  }
  return bucket.count >= FAILED_LOGIN_LIMIT;
}

function recordFailedLogin(ip: string, username: string, reason: string) {
  const now = Date.now();
  pruneFailedLoginBuckets(now);
  const bucket = failedLoginBuckets.get(ip);
  const next = !bucket || now - bucket.firstAt > FAILED_LOGIN_WINDOW_MS
    ? { count: 1, firstAt: now, blockedUntil: 0 }
    : { ...bucket, count: bucket.count + 1 };
  if (next.count >= FAILED_LOGIN_LIMIT) {
    next.blockedUntil = now + FAILED_LOGIN_WINDOW_MS;
  }
  failedLoginBuckets.set(ip, next);
  console.warn(`[admin-auth] failed admin login ip=${ip} username=${username || '<empty>'} reason=${reason} count=${next.count}`);
}

function clearFailedLogin(ip: string) {
  failedLoginBuckets.delete(ip);
}

function pruneFailedLoginBuckets(now: number) {
  for (const [ip, bucket] of failedLoginBuckets) {
    if (bucket.blockedUntil <= now && now - bucket.firstAt > FAILED_LOGIN_WINDOW_MS) {
      failedLoginBuckets.delete(ip);
    }
  }
  if (failedLoginBuckets.size <= FAILED_LOGIN_MAX_BUCKETS) return;
  const overflow = failedLoginBuckets.size - FAILED_LOGIN_MAX_BUCKETS;
  const oldest = Array.from(failedLoginBuckets.entries())
    .sort((a, b) => a[1].firstAt - b[1].firstAt)
    .slice(0, overflow);
  for (const [ip] of oldest) failedLoginBuckets.delete(ip);
}
