import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getDataDir } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKETS = ['images', 'videos', 'uploads', 'exports'] as const;
const QUARANTINE_DAYS = 7;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }
  const url = new URL(req.url);
  const minAgeHours = clampInt(url.searchParams.get('minAgeHours'), 24, 0, 24 * 30);
  return jsonOk(storageSnapshot(minAgeHours));
}

export const POST = withAdminAudit(async function mutateStorage(_req: NextRequest, audit) {
  const body = audit.body || {};
  const action = String(body.action || '').trim();
  if (!['quarantine_orphans', 'cleanup_quarantine'].includes(action)) return jsonError('unsupported action', 400);
  const minAgeHours = clampInt(body.minAgeHours, 24, 0, 24 * 30);

  if (action === 'quarantine_orphans') {
    const snapshot = storageSnapshot(minAgeHours);
    const candidateHash = orphanFileSetHash(snapshot.orphanFiles);
    const before = { candidates: snapshot.orphanFiles };
    const after = { candidateHash, quarantined: snapshot.orphanFiles.map((file: any) => file.path) };
    audit.setAuditTarget({ type: 'storage_orphan_file', ids: snapshot.orphanFiles.map((file: any) => file.path) });
    audit.setAuditDiff({ before, after });
    if (audit.dryRun) {
      return jsonOk({
        ...dryRunPayload('storage.quarantine_orphans', audit.target, audit.diff),
        candidateHash,
        candidatePaths: snapshot.orphanFiles.map((file: any) => file.path),
      });
    }
    if (!body.candidateHash) return jsonError('candidateHash required; run dry-run again first', 400);
    if (String(body.candidateHash) !== candidateHash) {
      return jsonError('orphan file candidate set changed; run dry-run again', 409);
    }
    const result = quarantineFiles(snapshot.orphanFiles, audit.admin.username);
    return jsonOk({ success: true, action, result });
  }

  const candidates = cleanupCandidates();
  audit.setAuditTarget({ type: 'storage_quarantine', ids: candidates.map((item) => item.dir) });
  audit.setAuditDiff({ before: { candidates }, after: { deleted: candidates.map((item) => item.dir) } });
  if (audit.dryRun) return jsonOk(dryRunPayload('storage.cleanup_quarantine', audit.target, audit.diff));
  const deleted: string[] = [];
  const failed: Array<{ dir: string; error: string }> = [];
  for (const item of candidates) {
    try {
      rmSync(item.fullPath, { recursive: true, force: true });
      deleted.push(item.dir);
    } catch (error: any) {
      failed.push({ dir: item.dir, error: error?.message || String(error) });
    }
  }
  return jsonOk({ success: true, action, deleted, failed });
}, 'storage.mutate', {
  category: 'storage',
  supportDryRun: true,
  idempotent: true,
});

function storageSnapshot(minAgeHours: number) {
  const files = orphanFiles(minAgeHours);
  return {
    dataDir: getDataDir(),
    usage: storageUsage(),
    orphanRows: orphanRowSummary(),
    orphanFiles: files,
    orphanFileSetHash: orphanFileSetHash(files),
    quarantine: quarantineInventory(),
    minAgeHours,
    quarantineDays: QUARANTINE_DAYS,
    generatedAt: new Date().toISOString(),
  };
}

function storageUsage() {
  const dataDir = getDataDir();
  const rows: Array<{ bucket: string; ownerId: string; files: number; bytes: number }> = [];
  for (const bucket of BUCKETS) {
    const bucketDir = join(dataDir, bucket);
    if (!existsSync(bucketDir)) continue;
    for (const ownerId of readdirSync(bucketDir)) {
      const ownerDir = join(bucketDir, ownerId);
      if (!safeStat(ownerDir)?.isDirectory()) continue;
      let files = 0;
      let bytes = 0;
      for (const filename of readdirSync(ownerDir)) {
        const file = join(ownerDir, filename);
        const stat = safeStat(file);
        if (!stat?.isFile()) continue;
        files++;
        bytes += stat.size;
      }
      rows.push({ bucket, ownerId, files, bytes });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

function orphanRowSummary() {
  const db = getDb();
  const projectIds = new Set((db.prepare('SELECT id FROM projects').all() as any[]).map((row) => row.id));
  const tables = ['images', 'video_tasks', 'uploads', 'exports', 'batches', 'continuity_cache', 'script_library_items'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    if (!tableExists(table)) continue;
    const rows = db.prepare(`SELECT project_id FROM ${table} WHERE project_id IS NOT NULL AND project_id <> ''`).all() as any[];
    const count = rows.filter((row) => !projectIds.has(row.project_id)).length;
    if (count) out[table] = count;
  }
  return out;
}

function orphanFiles(minAgeHours: number) {
  const refs = referencedFiles();
  const cutoff = Date.now() - minAgeHours * 60 * 60 * 1000;
  const dataDir = getDataDir();
  const files: Array<{ bucket: string; ownerId: string; filename: string; path: string; bytes: number; mtime: string; reason: string }> = [];
  for (const bucket of BUCKETS) {
    const bucketDir = join(dataDir, bucket);
    if (!existsSync(bucketDir)) continue;
    for (const ownerId of readdirSync(bucketDir)) {
      const ownerDir = join(bucketDir, ownerId);
      if (!safeStat(ownerDir)?.isDirectory()) continue;
      for (const filename of readdirSync(ownerDir)) {
        const file = join(ownerDir, filename);
        const stat = safeStat(file);
        if (!stat?.isFile()) continue;
        const key = `${ownerId}/${filename}`;
        if (refs[bucket].has(key)) continue;
        if (stat.mtime.getTime() > cutoff) continue;
        files.push({
          bucket,
          ownerId,
          filename,
          path: relative(dataDir, file),
          bytes: stat.size,
          mtime: stat.mtime.toISOString(),
          reason: 'unreferenced file',
        });
      }
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes).slice(0, 500);
}

function referencedFiles() {
  const db = getDb();
  const refs: Record<string, Set<string>> = {
    images: new Set(),
    videos: new Set(),
    uploads: new Set(),
    exports: new Set(),
  };
  if (tableExists('images')) {
    for (const row of db.prepare("SELECT owner_id, filename, style, asset_ref FROM images WHERE filename IS NOT NULL AND filename <> ''").all() as any[]) {
      const bucket = row.style === 'video-cover' || String(row.asset_ref || '').startsWith('video-cover/') ? 'videos' : 'images';
      refs[bucket].add(`${row.owner_id}/${row.filename}`);
    }
  }
  if (tableExists('video_tasks')) {
    for (const row of db.prepare("SELECT id, owner_id, filename FROM video_tasks WHERE filename IS NOT NULL AND filename <> ''").all() as any[]) {
      refs.videos.add(`${row.owner_id}/${row.filename}`);
      refs.videos.add(`${row.owner_id}/${row.id}.cover.png`);
    }
  }
  if (tableExists('uploads')) {
    for (const row of db.prepare("SELECT owner_id, filename FROM uploads WHERE filename IS NOT NULL AND filename <> ''").all() as any[]) {
      refs.uploads.add(`${row.owner_id}/${row.filename}`);
    }
  }
  if (tableExists('exports')) {
    for (const row of db.prepare("SELECT owner_id, filename FROM exports WHERE filename IS NOT NULL AND filename <> ''").all() as any[]) {
      refs.exports.add(`${row.owner_id}/${row.filename}`);
    }
  }
  return refs;
}

function quarantineFiles(files: Array<{ bucket: string; ownerId: string; filename: string; path: string; reason: string }>, adminUsername: string) {
  const dataDir = getDataDir();
  const quarantineId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const quarantineDir = join(dataDir, 'quarantine', quarantineId);
  mkdirSync(quarantineDir, { recursive: true });
  const moved: any[] = [];
  const failed: any[] = [];
  for (const file of files) {
    const src = safeMediaPath(file.bucket, file.ownerId, file.filename);
    if (!src || !existsSync(src)) continue;
    const dest = join(quarantineDir, file.bucket, String(file.ownerId), file.filename);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
      moved.push({ ...file, originalPath: relative(dataDir, src), quarantinePath: relative(dataDir, dest) });
    } catch (error: any) {
      failed.push({ ...file, error: error?.message || String(error) });
    }
  }
  writeFileSync(join(quarantineDir, 'manifest.json'), JSON.stringify({
    quarantineId,
    adminUsername,
    createdAt: new Date().toISOString(),
    deleteAfter: new Date(Date.now() + QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    moved,
    failed,
  }, null, 2));
  return { quarantineId, moved, failed };
}

function quarantineInventory() {
  const root = join(getDataDir(), 'quarantine');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((dir) => {
    const fullPath = join(root, dir);
    const stat = safeStat(fullPath);
    if (!stat?.isDirectory()) return null;
    const manifest = readQuarantineManifest(fullPath);
    return {
      dir,
      createdAt: manifest?.createdAt || stat.mtime.toISOString(),
      deleteAfter: manifest?.deleteAfter || new Date(stat.mtime.getTime() + QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      bytes: dirSize(fullPath),
      fullPath,
    };
  }).filter(Boolean).map(({ fullPath: _fullPath, ...item }: any) => item);
}

function cleanupCandidates() {
  const root = join(getDataDir(), 'quarantine');
  if (!existsSync(root)) return [];
  const now = Date.now();
  return readdirSync(root).map((dir) => {
    const fullPath = join(root, dir);
    const stat = safeStat(fullPath);
    if (!stat?.isDirectory()) return null;
    const manifest = readQuarantineManifest(fullPath);
    const createdAt = manifest?.createdAt || stat.mtime.toISOString();
    const deleteAfter = manifest?.deleteAfter || new Date(stat.mtime.getTime() + QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const deleteAfterMs = Date.parse(deleteAfter);
    if (!Number.isFinite(deleteAfterMs) || deleteAfterMs > now) return null;
    return { dir, fullPath, createdAt, deleteAfter, bytes: dirSize(fullPath) };
  }).filter(Boolean) as Array<{ dir: string; fullPath: string; createdAt: string; bytes: number }>;
}

function orphanFileSetHash(files: Array<{ path: string; bytes?: number; mtime?: string }>) {
  const normalized = files
    .map((file) => ({
      path: String(file.path || ''),
      bytes: Number(file.bytes || 0),
      mtime: String(file.mtime || ''),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function readQuarantineManifest(fullPath: string): { createdAt?: string; deleteAfter?: string } | null {
  try {
    const raw = readFileSync(join(fullPath, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function tableExists(table: string) {
  return !!getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function safeMediaPath(bucket: string, ownerId: string, filename: string) {
  if (!(BUCKETS as readonly string[]).includes(bucket)) return null;
  const base = resolve(getDataDir(), bucket, String(ownerId));
  const target = resolve(base, String(filename || ''));
  if (target === base || !target.startsWith(base + '/')) return null;
  return target;
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return null; }
}

function dirSize(path: string): number {
  const stat = safeStat(path);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name)), 0);
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
