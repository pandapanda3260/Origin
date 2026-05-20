import { getDb } from './db';

const USER_AUTH_CACHE_TTL_MS = 30_000;

type CachedUserAuthState = {
  revokedAt: string | null;
  disabledAt: string | null;
  expiresAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __origin_user_auth_cache: Map<number, CachedUserAuthState> | undefined;
}

function cache() {
  if (!global.__origin_user_auth_cache) {
    global.__origin_user_auth_cache = new Map<number, CachedUserAuthState>();
  }
  return global.__origin_user_auth_cache;
}

export function isUserTokenStillValid(userId: number, issuedAt: number, issuedAtMs = 0): boolean {
  if (!issuedAt) return false;
  const now = Date.now();
  const stateCache = cache();
  const cached = stateCache.get(userId);
  let state = cached;
  if (!state || state.expiresAt <= now) {
    const row = getDb()
      .prepare<{ id: number }, { token_revoked_at: string | null; disabled_at: string | null }>(
        'SELECT token_revoked_at, disabled_at FROM users WHERE id = @id',
      )
      .get({ id: userId });
    if (!row) return false;
    state = {
      revokedAt: row.token_revoked_at || null,
      disabledAt: row.disabled_at || null,
      expiresAt: now + USER_AUTH_CACHE_TTL_MS,
    };
    stateCache.set(userId, state);
  }
  if (state.disabledAt) return false;
  return !(state.revokedAt && tokenIssuedBeforeRevocation(issuedAt, issuedAtMs, state.revokedAt));
}

export function clearUserAuthCache(userId?: number) {
  const stateCache = cache();
  if (userId) stateCache.delete(userId);
  else stateCache.clear();
}

function tokenIssuedBeforeRevocation(issuedAt: number, issuedAtMs: number, revokedAt: string): boolean {
  const revokedAtMs = Date.parse(revokedAt);
  if (!Number.isFinite(revokedAtMs)) return true;
  if (issuedAtMs > 0) return issuedAtMs < revokedAtMs;
  return issuedAt <= Math.floor(revokedAtMs / 1000);
}
