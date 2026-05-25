import { existsSync } from 'node:fs';
import { getDb } from '../lib/db';
import {
  createAssetRecord,
  hashFile,
  localAssetUri,
  refreshQuotaUsage,
} from '../lib/asset-library';
import { dataPath } from '../lib/runtime-paths';

type BackfillOptions = {
  dryRun?: boolean;
  ownerId?: number | null;
};

type ProjectCache = Map<string, any>;

function parseJson(value: string | null | undefined) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function text(value: unknown) {
  const str = String(value ?? '').trim();
  return str || null;
}

function imageStage(row: any) {
  const kind = String(row.kind || '').trim();
  const style = String(row.style || '').trim();
  const assetRef = String(row.asset_ref || '').trim();
  if (style === 'video-cover' || assetRef.startsWith('video-cover/')) return 'video_cover';
  if (kind === 'character') return 'asset_character';
  if (kind === 'scene') return 'asset_scene';
  if (kind === 'prop') return 'asset_prop';
  if (kind === 'storyboard') return 'storyboard';
  if (kind === 'frame_first') return 'first_frame';
  if (kind === 'frame_tail') return 'tail_frame';
  if (/firstFrame/i.test(assetRef)) return 'first_frame';
  if (/tailFrame/i.test(assetRef)) return 'tail_frame';
  if (/storyboards\[\d+\]/.test(assetRef)) return 'storyboard';
  return 'image';
}

function sourceForImage(row: any) {
  const prompt = String(row.prompt || '');
  const assetRef = String(row.asset_ref || '');
  if (assetRef.startsWith('toolbox/')) return 'toolbox' as const;
  if (prompt === '[uploaded]' || prompt.startsWith('[uploaded]')) return 'uploaded' as const;
  return 'generated' as const;
}

function parseStoryboardIndex(value: unknown): number | null {
  const match = /storyboards\[(\d+)\]/.exec(String(value || ''));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function readProjects() {
  const db = getDb();
  const rows = db.prepare('SELECT id, data_json FROM projects').all() as any[];
  const map: ProjectCache = new Map();
  for (const row of rows) map.set(String(row.id), parseJson(row.data_json));
  return map;
}

function projectShotInfo(projects: ProjectCache, projectId: string | null | undefined, groupIdx: number | null) {
  if (!projectId || groupIdx == null) return { shotUid: null, legacyShotId: groupIdx == null ? null : `shot_${groupIdx}` };
  const project = projects.get(projectId);
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shot = shots[groupIdx] || {};
  const shotUid = text(sb.shotUid || sb.shot_uid || sb.uid || sb.id || shot.shotUid || shot.shot_uid || shot.uid || shot.id);
  return {
    shotUid,
    legacyShotId: shotUid ? null : `shot_${groupIdx}`,
  };
}

function imageFileHash(ownerId: number, filename: string | null | undefined) {
  const name = text(filename);
  if (!name) return null;
  const path = dataPath('images', String(ownerId), name);
  return existsSync(path) ? hashFile(path) : null;
}

function videoFileHash(ownerId: number, filename: string | null | undefined) {
  const name = text(filename);
  if (!name) return null;
  const path = dataPath('videos', String(ownerId), name);
  return existsSync(path) ? hashFile(path) : null;
}

function uploadFileHash(ownerId: number, filename: string | null | undefined) {
  const name = text(filename);
  if (!name) return null;
  const path = dataPath('uploads', String(ownerId), name);
  return existsSync(path) ? hashFile(path) : null;
}

function exportFileHash(ownerId: number, filename: string | null | undefined) {
  const name = text(filename);
  if (!name) return null;
  const path = dataPath('exports', String(ownerId), name);
  return existsSync(path) ? hashFile(path) : null;
}

function stageForUpload(row: any) {
  const kind = String(row.kind || '').trim();
  if (kind === 'image') return 'edit_upload_image';
  if (kind === 'video') return 'edit_upload_video';
  return 'edit_upload';
}

function ownerFilter(ownerId?: number | null) {
  return ownerId ? { where: ' WHERE owner_id = @ownerId', params: { ownerId } } : { where: '', params: {} };
}

export function backfillAssetLibrary(options: BackfillOptions = {}) {
  const db = getDb();
  const projects = readProjects();
  const ownerIds = new Set<number>();
  const result = {
    dryRun: !!options.dryRun,
    images: 0,
    videos: 0,
    uploads: 0,
    exports: 0,
    skipped: 0,
  };

  const imageFilter = ownerFilter(options.ownerId);
  const imageRows = db.prepare(`SELECT * FROM images${imageFilter.where} ORDER BY created_at ASC, id ASC`).all(imageFilter.params) as any[];
  for (const row of imageRows) {
    ownerIds.add(Number(row.owner_id));
    const stage = imageStage(row);
    const groupIdx = parseStoryboardIndex(row.asset_ref);
    const shot = projectShotInfo(projects, text(row.project_id), groupIdx);
    const filename = text(row.filename);
    if (!filename) {
      result.skipped += 1;
      continue;
    }
    if (!options.dryRun) {
      createAssetRecord({
        assetId: row.id,
        ownerId: Number(row.owner_id),
        projectId: text(row.project_id),
        shotUid: shot.shotUid,
        legacyShotId: shot.legacyShotId,
        assetKind: 'image',
        source: sourceForImage(row),
        stage,
        fileUri: localAssetUri('images', Number(row.owner_id), filename),
        thumbUri: `/api/images/file/${row.id}`,
        fileHash: imageFileHash(Number(row.owner_id), filename) || `image:${row.id}`,
        byteSize: Number(row.size_bytes || 0),
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        makeCurrent: true,
      });
    }
    result.images += 1;
  }

  const videoFilter = ownerFilter(options.ownerId);
  const videoRows = db.prepare(`SELECT * FROM video_tasks${videoFilter.where} ORDER BY created_at ASC, id ASC`).all(videoFilter.params) as any[];
  for (const row of videoRows) {
    if (String(row.status || '') !== 'completed' || !text(row.filename)) continue;
    ownerIds.add(Number(row.owner_id));
    const groupIdx = Number.isInteger(Number(row.group_idx)) ? Number(row.group_idx) : null;
    const shot = projectShotInfo(projects, text(row.project_id), groupIdx);
    if (!options.dryRun) {
      createAssetRecord({
        assetId: row.id,
        ownerId: Number(row.owner_id),
        projectId: text(row.project_id),
        shotUid: shot.shotUid,
        legacyShotId: shot.legacyShotId,
        assetKind: 'video',
        source: row.project_id ? 'generated' : 'toolbox',
        stage: row.project_id ? 'video_segment' : 'toolbox_video',
        fileUri: localAssetUri('videos', Number(row.owner_id), String(row.filename)),
        thumbUri: row.cover_image_id ? `/api/images/file/${row.cover_image_id}` : null,
        fileHash: videoFileHash(Number(row.owner_id), row.filename) || `video:${row.id}`,
        byteSize: 0,
        durationMs: row.duration_sec == null ? null : Math.round(Number(row.duration_sec || 0) * 1000),
        makeCurrent: true,
      });
    }
    result.videos += 1;
  }

  const uploadFilter = ownerFilter(options.ownerId);
  const uploadRows = db.prepare(`SELECT * FROM uploads${uploadFilter.where} ORDER BY created_at ASC, id ASC`).all(uploadFilter.params) as any[];
  for (const row of uploadRows) {
    const kind = String(row.kind || '') === 'image' ? 'image' : String(row.kind || '') === 'video' ? 'video' : null;
    if (!kind || !text(row.filename)) continue;
    ownerIds.add(Number(row.owner_id));
    if (!options.dryRun) {
      createAssetRecord({
        assetId: row.id,
        ownerId: Number(row.owner_id),
        projectId: text(row.project_id),
        assetKind: kind,
        source: 'uploaded',
        stage: stageForUpload(row),
        fileUri: localAssetUri('uploads', Number(row.owner_id), String(row.filename)),
        thumbUri: `/api/edit/media/${row.id}`,
        fileHash: uploadFileHash(Number(row.owner_id), row.filename) || `upload:${row.id}`,
        byteSize: Number(row.size_bytes || 0),
        durationMs: row.duration_sec == null ? null : Math.round(Number(row.duration_sec || 0) * 1000),
        makeCurrent: false,
      });
    }
    result.uploads += 1;
  }

  const exportFilter = ownerFilter(options.ownerId);
  const exportRows = db.prepare(`SELECT * FROM exports${exportFilter.where} ORDER BY created_at ASC, id ASC`).all(exportFilter.params) as any[];
  for (const row of exportRows) {
    if (String(row.status || '') !== 'completed' || !text(row.filename)) continue;
    ownerIds.add(Number(row.owner_id));
    if (!options.dryRun) {
      createAssetRecord({
        assetId: row.id,
        ownerId: Number(row.owner_id),
        projectId: text(row.project_id),
        assetKind: 'video',
        source: 'edit_export',
        stage: 'edit_export',
        fileUri: localAssetUri('exports', Number(row.owner_id), String(row.filename)),
        thumbUri: null,
        fileHash: exportFileHash(Number(row.owner_id), row.filename) || `export:${row.id}`,
        byteSize: 0,
        durationMs: row.duration_sec == null ? null : Math.round(Number(row.duration_sec || 0) * 1000),
        makeCurrent: false,
      });
    }
    result.exports += 1;
  }

  if (!options.dryRun) {
    for (const ownerId of ownerIds) refreshQuotaUsage(ownerId);
  }
  return result;
}

function parseArgs(argv: string[]) {
  const opts: BackfillOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--owner-id') opts.ownerId = Number(argv[++i]);
  }
  return opts;
}

if (require.main === module) {
  const result = backfillAssetLibrary(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
