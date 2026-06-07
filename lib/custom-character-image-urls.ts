import { buildSignedImageUrl } from './signed-asset-url';

const IMAGE_FILE_PATH_RE = /^\/api\/images\/file\/([0-9a-fA-F-]{36})$/;
const URL_BASE = 'http://origin.local';

function signedImageFileUrl(value: string, ownerId: number) {
  const raw = String(value || '').trim();
  if (!raw) return value;

  let parsed: URL;
  try {
    parsed = new URL(raw, URL_BASE);
  } catch {
    return value;
  }

  const match = IMAGE_FILE_PATH_RE.exec(parsed.pathname);
  if (!match) return value;

  const signed = new URL(buildSignedImageUrl(match[1], ownerId).url, URL_BASE);
  parsed.searchParams.forEach((paramValue, key) => {
    if (key === 'exp' || key === 'sig') return;
    signed.searchParams.set(key, paramValue);
  });
  return signed.pathname + signed.search + parsed.hash;
}

export function signCustomCharacterImageUrls<T>(value: T, ownerId: number, depth = 0): T {
  if (depth > 10 || value === null || value === undefined) return value;
  if (typeof value === 'string') return signedImageFileUrl(value, ownerId) as T;
  if (Array.isArray(value)) {
    return value.map((item) => signCustomCharacterImageUrls(item, ownerId, depth + 1)) as T;
  }
  if (typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    output[key] = signCustomCharacterImageUrls(item, ownerId, depth + 1);
  }
  return output as T;
}
