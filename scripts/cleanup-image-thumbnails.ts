import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from '../lib/runtime-paths';

type CacheFile = {
  path: string;
  size: number;
  mtimeMs: number;
  isTmp: boolean;
  version: string | null;
};

const thumbRoot = dataPath('image-thumbs');
const activeVersions = new Set(
  String(process.env.IMAGE_THUMB_ACTIVE_VERSIONS || 'v1')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);
const maxAgeDays = Number(process.env.IMAGE_THUMB_MAX_AGE_DAYS || 90);
const maxBytes = Number(process.env.IMAGE_THUMB_CACHE_MAX_BYTES || 20 * 1024 * 1024 * 1024);
const tmpMaxAgeMs = Number(process.env.IMAGE_THUMB_TMP_MAX_HOURS || 6) * 60 * 60 * 1000;
const now = Date.now();

async function walk(dir: string, files: CacheFile[] = []) {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const s = await stat(path);
    const version = entry.name.match(/_(v\d+)_w\d+_q\d+\.(webp|jpe?g)$/i)?.[1] || null;
    files.push({
      path,
      size: s.size,
      mtimeMs: s.mtimeMs,
      isTmp: entry.name.includes('.tmp.'),
      version,
    });
  }
  return files;
}

async function remove(path: string) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    console.warn('[cleanup:image-thumbs] unlink failed:', path, error);
    return false;
  }
}

async function main() {
  const files = await walk(thumbRoot);
  const deleted = new Set<string>();
  let deletedBytes = 0;

  for (const file of files) {
    const tmpExpired = file.isTmp && now - file.mtimeMs > tmpMaxAgeMs;
    const versionExpired = file.version && !activeVersions.has(file.version);
    const ageExpired = !file.isTmp && now - file.mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000;
    if (!tmpExpired && !versionExpired && !ageExpired) continue;
    if (await remove(file.path)) {
      deleted.add(file.path);
      deletedBytes += file.size;
    }
  }

  const remaining = files.filter(file => !deleted.has(file.path) && !file.isTmp);
  let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0);
  if (Number.isFinite(maxBytes) && maxBytes > 0 && totalBytes > maxBytes) {
    const targetBytes = Math.floor(maxBytes * 0.8);
    const byMtime = [...remaining].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of byMtime) {
      if (totalBytes <= targetBytes) break;
      if (await remove(file.path)) {
        deleted.add(file.path);
        deletedBytes += file.size;
        totalBytes -= file.size;
      }
    }
  }

  console.info(
    '[cleanup:image-thumbs] scanned=%d deleted=%d deletedBytes=%d remainingBytes=%d activeVersions=%s',
    files.length,
    deleted.size,
    deletedBytes,
    totalBytes,
    [...activeVersions].join(',')
  );
}

main().catch(error => {
  console.error('[cleanup:image-thumbs] failed:', error);
  process.exitCode = 1;
});
