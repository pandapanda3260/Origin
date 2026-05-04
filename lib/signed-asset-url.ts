import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 7 * 24 * 3600;

function getSecret(): string {
  return (
    process.env.ASSET_URL_SECRET ||
    process.env.JWT_SECRET ||
    'dev-jwt-secret-please-change-me-32-bytes-long'
  );
}

function signPayload(imageId: string, ownerId: number, exp: number): string {
  return `asset-url-v1:${imageId}:${ownerId}:${exp}`;
}

function digest(imageId: string, ownerId: number, exp: number): string {
  return createHmac('sha256', getSecret())
    .update(signPayload(imageId, ownerId, exp))
    .digest('base64url');
}

export function normalizeAssetUrlTtl(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.max(60, Math.min(Math.floor(n), MAX_TTL_SECONDS));
}

export function buildSignedImageUrl(imageId: string, ownerId: number, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = normalizeAssetUrlTtl(ttlSeconds);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = digest(imageId, ownerId, exp);
  return {
    url: `/api/images/file/${encodeURIComponent(imageId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
    ttl,
    expiresAt: exp,
  };
}

export function verifySignedImageUrl(opts: {
  imageId: string;
  ownerId: number;
  exp: string | null;
  sig: string | null;
}) {
  const exp = Number(opts.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  if (!opts.sig) return false;

  const expected = digest(opts.imageId, opts.ownerId, exp);
  const a = Buffer.from(opts.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
