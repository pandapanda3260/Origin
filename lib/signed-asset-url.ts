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

function signVideoPayload(videoId: string, ownerId: number, exp: number): string {
  return `video-url-v1:${videoId}:${ownerId}:${exp}`;
}

function digest(imageId: string, ownerId: number, exp: number): string {
  return createHmac('sha256', getSecret())
    .update(signPayload(imageId, ownerId, exp))
    .digest('base64url');
}

function videoDigest(videoId: string, ownerId: number, exp: number): string {
  return createHmac('sha256', getSecret())
    .update(signVideoPayload(videoId, ownerId, exp))
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

export function buildSignedVideoUrl(videoId: string, ownerId: number, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = normalizeAssetUrlTtl(ttlSeconds);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = videoDigest(videoId, ownerId, exp);
  return {
    url: `/api/videos/file/${encodeURIComponent(videoId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
    ttl,
    expiresAt: exp,
  };
}

function signUploadPayload(uploadId: string, ownerId: number, exp: number): string {
  return `upload-url-v1:${uploadId}:${ownerId}:${exp}`;
}

function uploadDigest(uploadId: string, ownerId: number, exp: number): string {
  return createHmac('sha256', getSecret())
    .update(signUploadPayload(uploadId, ownerId, exp))
    .digest('base64url');
}

export function buildSignedUploadUrl(uploadId: string, ownerId: number, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = normalizeAssetUrlTtl(ttlSeconds);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = uploadDigest(uploadId, ownerId, exp);
  return {
    url: `/api/edit/media/${encodeURIComponent(uploadId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
    ttl,
    expiresAt: exp,
  };
}

export function verifySignedUploadUrl(opts: {
  uploadId: string;
  ownerId: number;
  exp: string | null;
  sig: string | null;
}) {
  const exp = Number(opts.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  if (!opts.sig) return false;

  const expected = uploadDigest(opts.uploadId, opts.ownerId, exp);
  const a = Buffer.from(opts.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

export function verifySignedVideoUrl(opts: {
  videoId: string;
  ownerId: number;
  exp: string | null;
  sig: string | null;
}) {
  const exp = Number(opts.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  if (!opts.sig) return false;

  const expected = videoDigest(opts.videoId, opts.ownerId, exp);
  const a = Buffer.from(opts.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// 剪辑导出的成片（exports 表）。和视频片段同理：/api/edit/export-file/{id} 是 Bearer-only，
// <video src> 带不了登录头，给它一条 exp+sig 签名路径，前端拿签名地址就能直接流式播放。
function signExportPayload(exportId: string, ownerId: number, exp: number): string {
  return `export-url-v1:${exportId}:${ownerId}:${exp}`;
}

function exportDigest(exportId: string, ownerId: number, exp: number): string {
  return createHmac('sha256', getSecret())
    .update(signExportPayload(exportId, ownerId, exp))
    .digest('base64url');
}

export function buildSignedExportUrl(exportId: string, ownerId: number, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = normalizeAssetUrlTtl(ttlSeconds);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = exportDigest(exportId, ownerId, exp);
  return {
    url: `/api/edit/export-file/${encodeURIComponent(exportId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
    ttl,
    expiresAt: exp,
  };
}

export function verifySignedExportUrl(opts: {
  exportId: string;
  ownerId: number;
  exp: string | null;
  sig: string | null;
}) {
  const exp = Number(opts.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  if (!opts.sig) return false;

  const expected = exportDigest(opts.exportId, opts.ownerId, exp);
  const a = Buffer.from(opts.sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
