import { buildSignedVideoUrl } from '@/lib/signed-asset-url';

const PROTECTED_VIDEO_FILE_RE = /\/api\/videos\/file\/([^/?#]+)/;

export function buildProtectedVideoUrl(taskId: string) {
  return `/api/videos/file/${encodeURIComponent(taskId)}`;
}

export function extractVideoTaskIdFromUrl(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(PROTECTED_VIDEO_FILE_RE);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function resolveVideoTaskIdFromSources(...sources: unknown[]): string {
  for (const source of sources) {
    const direct = String(source || '').trim();
    if (direct && !direct.includes('/')) return direct;
    const fromUrl = extractVideoTaskIdFromUrl(source);
    if (fromUrl) return fromUrl;
  }
  return '';
}

export function buildSignedVideoPlaybackUrl(taskId: string, ownerId: number) {
  const id = String(taskId || '').trim();
  if (!id) return '';
  return buildSignedVideoUrl(id, ownerId).url;
}
