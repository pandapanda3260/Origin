import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { getDb } from './db';
import { invalidateContentFlagVisibilityCache } from './content-flags';
import { recordObservabilityEvent } from './observability-events';
import { getDataDir } from './runtime-paths';

const QUARANTINE_DAYS = 7;

type ContentFlagRow = {
  id: string;
  owner_id: number;
  project_id?: string | null;
  source_type: string;
  source_id: string;
  status: string;
};

type MediaCandidate = {
  bucket: 'images' | 'videos';
  ownerId: number;
  filename: string;
  sourceTable: string;
  sourceId: string;
};

export function hideContentFlagWithDisposition(opts: {
  flagId: string;
  adminId: number;
  adminUsername: string;
}) {
  const db = getDb();
  const flag = db.prepare<{ id: string }, ContentFlagRow>('SELECT * FROM content_flags WHERE id = @id').get({ id: opts.flagId });
  if (!flag) throw new Error('content flag not found');
  if (flag.status !== 'pending') throw new Error('content flag is not pending');

  const disposition = quarantineFlagMedia(flag, opts.adminUsername);
  const info = db.prepare(
    `UPDATE content_flags
        SET status = 'hidden',
            reviewed_by = @adminId,
            reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @flagId
        AND status = 'pending'`,
  ).run({ flagId: opts.flagId, adminId: opts.adminId });
  if (info.changes <= 0) throw new Error('content flag review race');

  invalidateContentFlagVisibilityCache();
  recordObservabilityEvent({
    type: 'system_warn',
    status: disposition.failed.length ? 'warn' : 'ok',
    message: 'content hidden',
    meta: {
      flagId: flag.id,
      sourceType: flag.source_type,
      sourceId: flag.source_id,
      projectId: flag.project_id || null,
      adminUsername: opts.adminUsername,
      disposition,
    },
  });
  return disposition;
}

export function dismissContentFlag(flagId: string, adminId: number) {
  const info = getDb().prepare(
    `UPDATE content_flags
        SET status = 'dismissed',
            reviewed_by = @adminId,
            reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @flagId
        AND status = 'pending'`,
  ).run({ flagId, adminId });
  invalidateContentFlagVisibilityCache();
  return info.changes > 0;
}

function quarantineFlagMedia(flag: ContentFlagRow, adminUsername: string) {
  const candidates = mediaCandidatesForFlag(flag);
  if (!candidates.length) {
    return {
      mode: 'metadata_only',
      quarantineId: null,
      moved: [],
      failed: [],
      reason: 'no local media candidate for source',
    };
  }

  const dataDir = getDataDir();
  const quarantineId = `content-${flag.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const quarantineDir = join(dataDir, 'quarantine', quarantineId);
  mkdirSync(quarantineDir, { recursive: true });

  const moved: any[] = [];
  const failed: any[] = [];
  for (const candidate of candidates) {
    const src = safeMediaPath(candidate.bucket, candidate.ownerId, candidate.filename);
    if (!src || !existsSync(src)) {
      failed.push({ ...candidate, reason: 'file missing' });
      continue;
    }
    const dest = join(quarantineDir, candidate.bucket, String(candidate.ownerId), candidate.filename);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      const stat = statSync(src);
      renameSync(src, dest);
      moved.push({
        ...candidate,
        originalPath: relative(dataDir, src),
        quarantinePath: relative(dataDir, dest),
        bytes: stat.size,
      });
    } catch (error: any) {
      failed.push({ ...candidate, error: error?.message || String(error) });
    }
  }

  writeFileSync(join(quarantineDir, 'manifest.json'), JSON.stringify({
    quarantineId,
    kind: 'content_hide',
    flagId: flag.id,
    sourceType: flag.source_type,
    sourceId: flag.source_id,
    projectId: flag.project_id || null,
    adminUsername,
    createdAt: new Date().toISOString(),
    deleteAfter: new Date(Date.now() + QUARANTINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    moved,
    failed,
  }, null, 2));

  return { mode: 'quarantine', quarantineId, moved, failed };
}

function mediaCandidatesForFlag(flag: ContentFlagRow): MediaCandidate[] {
  const db = getDb();
  const sourceId = String(flag.source_id || '').trim();
  if (!sourceId) return [];

  if (flag.source_type === 'image') {
    const rows = db.prepare<{ sourceId: string }, any>(
      `SELECT id, owner_id, filename, style, asset_ref
         FROM images
        WHERE id = @sourceId
           OR correlation_id = @sourceId`,
    ).all({ sourceId });
    return rows
      .filter((row) => row.filename)
      .map((row) => ({
        bucket: row.style === 'video-cover' || String(row.asset_ref || '').startsWith('video-cover/') ? 'videos' : 'images',
        ownerId: Number(row.owner_id),
        filename: String(row.filename),
        sourceTable: 'images',
        sourceId: String(row.id),
      }));
  }

  if (flag.source_type === 'video') {
    const rows = db.prepare<{ sourceId: string }, any>(
      `SELECT id, owner_id, filename
         FROM video_tasks
        WHERE id = @sourceId
           OR provider_task = @sourceId`,
    ).all({ sourceId });
    const out: MediaCandidate[] = [];
    for (const row of rows) {
      if (row.filename) {
        out.push({
          bucket: 'videos',
          ownerId: Number(row.owner_id),
          filename: String(row.filename),
          sourceTable: 'video_tasks',
          sourceId: String(row.id),
        });
      }
      const cover = `${row.id}.cover.png`;
      if (existsSync(safeMediaPath('videos', Number(row.owner_id), cover) || '')) {
        out.push({
          bucket: 'videos',
          ownerId: Number(row.owner_id),
          filename: cover,
          sourceTable: 'video_tasks',
          sourceId: String(row.id),
        });
      }
    }
    return out;
  }

  return [];
}

function safeMediaPath(bucket: 'images' | 'videos', ownerId: number | string, filename: string) {
  const base = resolve(getDataDir(), bucket, String(ownerId));
  const target = resolve(base, String(filename || ''));
  if (target === base || !target.startsWith(base + '/')) return null;
  return target;
}
