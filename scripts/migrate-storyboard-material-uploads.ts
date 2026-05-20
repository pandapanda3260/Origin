import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../lib/db';
import {
  processStoryboardMaterialImageBuffer,
  StoryboardMaterialImageError,
  type ProcessedStoryboardMaterialImage,
} from '../lib/storyboard-material-images';
import {
  materialRoleToImageKind,
  normalizeStoryboardMaterialRole,
  storyboardMaterialAssetRef,
  STORYBOARD_MATERIAL_IMAGE_STYLE,
  STORYBOARD_MATERIAL_UPLOAD_PROMPT,
  type StoryboardMaterialRole,
} from '../lib/reference-roles';

type Args = {
  dryRun: boolean;
  apply: boolean;
  projectId: string | null;
  ownerId: number | null;
};

type ProjectRow = {
  id: string;
  owner_id: number;
  data_json: string;
};

type ProjectCursor = {
  ownerId: number;
  id: string;
} | null;

type UploadRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  filename: string;
  mime: string;
  size_bytes: number;
};

type ImageRow = {
  id: string;
  owner_id: number;
  project_id: string | null;
  asset_ref: string | null;
  filename: string;
  width: number | null;
  height: number | null;
  mime: string | null;
  size_bytes: number | null;
};

type MaterialListSpec = {
  key: 'scenes' | 'characters' | 'props';
  role: StoryboardMaterialRole;
};

type MaterialIdSource = 'materialId' | 'id' | 'uploadId' | 'uuid';

type StagedImageInsert = {
  id: string;
  ownerId: number;
  projectId: string;
  kind: string;
  assetRef: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  buffer: Buffer;
  fullPath: string;
};

type ProjectMutation = {
  imageInserts: StagedImageInsert[];
  imageDeletes: ImageRow[];
};

const DATA_DIR = process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || join(process.cwd(), 'data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const IMAGES_DIR = join(DATA_DIR, 'images');
const SQLITE_PATH = join(DATA_DIR, 'qd.sqlite');
const OLD_MEDIA_PREFIX = '/api/edit/media/';
const NEW_IMAGE_PREFIX = '/api/images/file/';
const LOG_DIR = join(process.cwd(), 'logs');
const PROJECT_BATCH_SIZE = 50;

const MATERIAL_LISTS: MaterialListSpec[] = [
  { key: 'scenes', role: 'scene' },
  { key: 'characters', role: 'character' },
  { key: 'props', role: 'prop' },
];

const summary = {
  dryRun: false,
  projectsScanned: 0,
  projectsWouldUpdate: 0,
  projectsUpdated: 0,
  candidates: 0,
  skippedAlreadyMigrated: 0,
  skippedAlreadyImagesUrl: 0,
  skippedAlreadyMissing: 0,
  skippedInvalidScope: 0,
  skippedNoSourceUrl: 0,
  reusedExistingImage: 0,
  orphanImageRowsDeleted: 0,
  orphanImageRowsWouldDelete: 0,
  migrated: 0,
  copied: 0,
  reencoded: 0,
  fileMissing: 0,
  processFailed: 0,
  legacyIndexExclusionKeysRemoved: 0,
  videoRolesNormalized: 0,
  materialIdFromMaterialId: 0,
  materialIdFromId: 0,
  materialIdFromUploadId: 0,
  materialIdFromUuid: 0,
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    apply: false,
    projectId: null,
    ownerId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--project-id') args.projectId = argv[++i] || null;
    else if (arg === '--owner-id') {
      const n = Number(argv[++i]);
      args.ownerId = Number.isInteger(n) && n > 0 ? n : null;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (args.dryRun === args.apply) {
    throw new Error('请明确传入且只传入一个模式: --dry-run 或 --apply');
  }
  return args;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

const logPath = join(LOG_DIR, `migrate-storyboard-material-uploads-${timestampSlug()}.log`);

function log(message: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

function imageFullPath(row: ImageRow): string {
  return join(IMAGES_DIR, String(row.owner_id), String(row.filename || ''));
}

function imagePathForOwner(ownerId: number, filename: string): string {
  return join(IMAGES_DIR, String(ownerId), filename);
}

function uploadFullPath(row: UploadRow): string {
  return join(UPLOADS_DIR, String(row.owner_id), String(row.filename || ''));
}

function parseUploadId(url: string | null): string | null {
  if (!url) return null;
  const idx = url.indexOf(OLD_MEDIA_PREFIX);
  if (idx < 0) return null;
  const rest = url.slice(idx + OLD_MEDIA_PREFIX.length);
  const id = rest.split(/[?#/]/)[0];
  return id && /^[a-zA-Z0-9-]+$/.test(id) ? id : null;
}

function firstNonEmpty(values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
}

function existingCurrentImageUrl(item: any): string | null {
  return firstNonEmpty([
    item?.reference?.currentUrl,
    item?.thumbUrl,
    item?.rawUrl,
    item?.imageUrl,
    item?.pencilUrl,
    item?.realPhotoUrl,
  ]);
}

function sourceUrlForMigration(item: any): string | null {
  return firstNonEmpty([
    item?.reference?.currentUrl,
    item?.rawUrl,
    item?.imageUrl,
    item?.pencilUrl,
    item?.realPhotoUrl,
    item?.url,
    item?.reference?.lastKnownGoodUrl,
  ]);
}

function isMaterialCandidate(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.source === STORYBOARD_MATERIAL_IMAGE_STYLE) return true;
  if (item.storyboardMaterialAddedAt || item.storyboardMaterialRole) return true;
  return JSON.stringify(item).includes(OLD_MEDIA_PREFIX);
}

function stableMaterialId(item: any, uploadId: string | null): { value: string; source: MaterialIdSource } {
  const materialId = String(item?.materialId || '').trim();
  if (materialId) return { value: materialId, source: 'materialId' };
  const id = String(item?.id || '').trim();
  if (id) return { value: id, source: 'id' };
  if (uploadId) return { value: uploadId, source: 'uploadId' };
  return { value: randomUUID(), source: 'uuid' };
}

function countMaterialIdSource(source: MaterialIdSource) {
  if (source === 'materialId') summary.materialIdFromMaterialId += 1;
  else if (source === 'id') summary.materialIdFromId += 1;
  else if (source === 'uploadId') summary.materialIdFromUploadId += 1;
  else summary.materialIdFromUuid += 1;
}

function roleForItem(item: any, fallback: StoryboardMaterialRole): StoryboardMaterialRole | null {
  return normalizeStoryboardMaterialRole(item?.storyboardMaterialRole) || fallback;
}

function existingImageByAssetRef(ownerId: number, projectId: string, assetRef: string): ImageRow | null {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, owner_id, project_id, asset_ref, filename, width, height, mime, size_bytes
         FROM images
        WHERE owner_id = ?
          AND project_id = ?
          AND asset_ref = ?
          AND style = ?
        LIMIT 1`,
    )
    .get(ownerId, projectId, assetRef, STORYBOARD_MATERIAL_IMAGE_STYLE) as ImageRow | undefined || null;
}

function uploadById(ownerId: number, uploadId: string): UploadRow | null {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, owner_id, project_id, filename, mime, size_bytes
         FROM uploads
        WHERE owner_id = ?
          AND id = ?
        LIMIT 1`,
    )
    .get(ownerId, uploadId) as UploadRow | undefined || null;
}

function safeUnlink(path: string) {
  try {
    if (path && existsSync(path)) unlinkSync(path);
  } catch (_) {}
}

function deleteImageRow(row: ImageRow, mutation?: ProjectMutation) {
  if (summary.dryRun) {
    summary.orphanImageRowsWouldDelete += 1;
    return;
  }
  mutation?.imageDeletes.push(row);
  summary.orphanImageRowsDeleted += 1;
}

function markMissing(item: any, role: StoryboardMaterialRole, groupIdx: number, materialId: string, detail: string): boolean {
  const changed = wouldMarkMissing(item, role, groupIdx, materialId, detail);
  item.materialId = materialId;
  item.storyboardMaterialRole = role;
  item.storyboardMaterialGroupIdx = groupIdx;
  item.reference = {
    ...(item.reference || {}),
    status: 'missing',
    missingReason: detail,
  };
  return changed;
}

function wouldMarkMissing(item: any, role: StoryboardMaterialRole, groupIdx: number, materialId: string, detail: string): boolean {
  const previous = {
    materialId: item.materialId,
    role: item.storyboardMaterialRole,
    groupIdx: item.storyboardMaterialGroupIdx,
    status: item.reference?.status,
    missingReason: item.reference?.missingReason,
  };
  return previous.materialId !== materialId
    || previous.role !== role
    || previous.groupIdx !== groupIdx
    || previous.status !== 'missing'
    || previous.missingReason !== detail;
}

function applyStoredImage(item: any, opts: {
  role: StoryboardMaterialRole;
  groupIdx: number;
  materialId: string;
  uploadId: string | null;
  imageId: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  assetRef: string;
}) {
  item.materialId = opts.materialId;
  item.rawUrl = opts.url;
  item.imageUrl = opts.url;
  item.thumbUrl = opts.thumbUrl;
  item.source = STORYBOARD_MATERIAL_IMAGE_STYLE;
  item.storyboardMaterialRole = opts.role;
  item.storyboardMaterialGroupIdx = opts.groupIdx;
  item._migratedFromUploadId = opts.uploadId || item._migratedFromUploadId || null;
  item.reference = {
    ...(item.reference || {}),
    currentUrl: opts.url,
    lastKnownGoodUrl: opts.url,
    thumbUrl: opts.thumbUrl,
    status: 'ready',
    imageId: opts.imageId,
    assetRef: opts.assetRef,
    width: opts.width,
    height: opts.height,
  };
}

function normalizeVideoReferenceRoles(value: any, mutate: boolean): number {
  if (!value || typeof value !== 'object') return 0;
  let changed = 0;
  if (Array.isArray(value)) {
    for (const item of value) changed += normalizeVideoReferenceRoles(item, mutate);
    return changed;
  }
  if (value.role === 'char') {
    if (mutate) value.role = 'character';
    changed += 1;
  }
  for (const nested of Object.values(value)) changed += normalizeVideoReferenceRoles(nested, mutate);
  return changed;
}

function logMaterialFailure(row: ProjectRow, item: any, role: StoryboardMaterialRole, groupIdx: number, detail: string) {
  log(
    `素材迁移失败 project=${row.id} owner=${row.owner_id} groupIdx=${groupIdx} role=${role} ` +
    `item=${String(item?.id || item?.materialId || item?.name || '').slice(0, 120)} detail=${detail}`,
  );
}

function pruneLegacyIndexExclusionKeys(data: any): number {
  const root = data?.storyboardMaterialExclusions;
  if (!root || typeof root !== 'object') return 0;
  let removed = 0;
  for (const groupBucket of Object.values(root) as any[]) {
    if (!groupBucket || typeof groupBucket !== 'object') continue;
    for (const bucket of Object.values(groupBucket) as any[]) {
      if (!bucket || typeof bucket !== 'object') continue;
      for (const key of Object.keys(bucket)) {
        if (key.includes(':idx:')) {
          delete bucket[key];
          removed += 1;
        }
      }
      for (const key of Object.keys(bucket)) {
        const entry = bucket[key];
        if (!entry || !Array.isArray(entry.keys)) continue;
        const nextKeys = entry.keys.filter((entryKey: unknown) => !String(entryKey || '').includes(':idx:'));
        removed += entry.keys.length - nextKeys.length;
        if (nextKeys.length) entry.keys = nextKeys;
        else delete bucket[key];
      }
    }
  }
  return removed;
}

function storedImageFromProcessed(opts: {
  ownerId: number;
  projectId: string;
  role: StoryboardMaterialRole;
  assetRef: string;
  processed: ProcessedStoryboardMaterialImage;
}): {
  insert: StagedImageInsert;
  imageId: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  assetRef: string;
  mode: 'copied' | 'reencoded';
} {
  const kind = materialRoleToImageKind(opts.role);
  if (!kind) throw new StoryboardMaterialImageError('invalid_material_scope', '素材归属无效');
  const imageId = randomUUID();
  const filename = `${imageId}.${opts.processed.extension}`;
  return {
    insert: {
      id: imageId,
      ownerId: opts.ownerId,
      projectId: opts.projectId,
      kind,
      assetRef: opts.assetRef,
      filename,
      mime: opts.processed.mime,
      sizeBytes: opts.processed.buffer.length,
      width: opts.processed.width,
      height: opts.processed.height,
      buffer: opts.processed.buffer,
      fullPath: imagePathForOwner(opts.ownerId, filename),
    },
    imageId,
    url: `${NEW_IMAGE_PREFIX}${imageId}`,
    thumbUrl: `${NEW_IMAGE_PREFIX}${imageId}?w=256`,
    width: opts.processed.width,
    height: opts.processed.height,
    assetRef: opts.assetRef,
    mode: opts.processed.mode,
  };
}

async function migrateMaterialItem(args: Args, row: ProjectRow, item: any, spec: MaterialListSpec, mutation: ProjectMutation): Promise<boolean> {
  if (!isMaterialCandidate(item)) return false;
  summary.candidates += 1;

  if (item._migratedFromUploadId) {
    summary.skippedAlreadyMigrated += 1;
    return false;
  }

  const currentUrl = existingCurrentImageUrl(item);
  if (currentUrl?.startsWith(NEW_IMAGE_PREFIX)) {
    summary.skippedAlreadyImagesUrl += 1;
    return false;
  }

  const groupIdx = Number(item.storyboardMaterialGroupIdx);
  const role = roleForItem(item, spec.role);
  if (!role || !Number.isInteger(groupIdx) || groupIdx < 0) {
    summary.skippedInvalidScope += 1;
    return false;
  }

  const sourceUrl = sourceUrlForMigration(item);
  const uploadId = parseUploadId(sourceUrl);
  const material = stableMaterialId(item, uploadId);
  countMaterialIdSource(material.source);
  const assetRef = storyboardMaterialAssetRef(groupIdx, role, material.value);
  if (!assetRef) {
    summary.skippedInvalidScope += 1;
    return false;
  }

  if (item?.reference?.status === 'missing' && !uploadId) {
    summary.skippedAlreadyMissing += 1;
    return false;
  }

  const existing = existingImageByAssetRef(row.owner_id, row.id, assetRef);
  if (existing) {
    if (existsSync(imageFullPath(existing))) {
      if (args.dryRun) {
        summary.reusedExistingImage += 1;
        return true;
      }
      applyStoredImage(item, {
        role,
        groupIdx,
        materialId: material.value,
        uploadId,
        imageId: existing.id,
        url: `${NEW_IMAGE_PREFIX}${existing.id}`,
        thumbUrl: `${NEW_IMAGE_PREFIX}${existing.id}?w=256`,
        width: Number(existing.width || 0),
        height: Number(existing.height || 0),
        assetRef,
      });
      summary.reusedExistingImage += 1;
      return true;
    }
    deleteImageRow(existing, mutation);
  }

  if (!uploadId) {
    summary.skippedNoSourceUrl += 1;
    return false;
  }

  const upload = uploadById(row.owner_id, uploadId);
  if (!upload || !existsSync(uploadFullPath(upload))) {
    const changed = args.dryRun
      ? wouldMarkMissing(item, role, groupIdx, material.value, 'source_upload_missing')
      : markMissing(item, role, groupIdx, material.value, 'source_upload_missing');
    logMaterialFailure(row, item, role, groupIdx, 'source_upload_missing');
    summary.fileMissing += 1;
    return changed;
  }

  let sourceBuffer: Buffer;
  try {
    sourceBuffer = readFileSync(uploadFullPath(upload));
  } catch (error: any) {
    const changed = args.dryRun
      ? wouldMarkMissing(item, role, groupIdx, material.value, 'source_read_failed')
      : markMissing(item, role, groupIdx, material.value, 'source_read_failed');
    logMaterialFailure(row, item, role, groupIdx, 'source_read_failed');
    summary.processFailed += 1;
    return changed;
  }
  if (args.dryRun) {
    try {
      const processed = await processStoryboardMaterialImageBuffer(sourceBuffer);
      if (processed.mode === 'reencoded') summary.reencoded += 1;
      else summary.copied += 1;
      summary.migrated += 1;
      return true;
    } catch (error: any) {
      const detail = error?.code || 'process_failed';
      const changed = wouldMarkMissing(item, role, groupIdx, material.value, detail);
      logMaterialFailure(row, item, role, groupIdx, detail);
      summary.processFailed += 1;
      return changed;
    }
  }

  try {
    const processed = await processStoryboardMaterialImageBuffer(sourceBuffer);
    const stored = storedImageFromProcessed({
      ownerId: row.owner_id,
      projectId: row.id,
      role,
      assetRef,
      processed,
    });
    mutation.imageInserts.push(stored.insert);
    applyStoredImage(item, {
      role,
      groupIdx,
      materialId: material.value,
      uploadId,
      imageId: stored.imageId,
      url: stored.url,
      thumbUrl: stored.thumbUrl,
      width: stored.width,
      height: stored.height,
      assetRef: stored.assetRef,
    });
    if (stored.mode === 'reencoded') summary.reencoded += 1;
    else summary.copied += 1;
    summary.migrated += 1;
    return true;
  } catch (error: any) {
    const detail = error instanceof StoryboardMaterialImageError
      ? error.code
      : 'process_failed';
    const changed = markMissing(item, role, groupIdx, material.value, detail);
    logMaterialFailure(row, item, role, groupIdx, detail);
    summary.processFailed += 1;
    return changed;
  }
}

function applyProjectMutation(row: ProjectRow, data: any, mutation: ProjectMutation) {
  const db = getDb();
  const writtenFiles: string[] = [];
  const deletedFiles: string[] = [];
  try {
    db.transaction(() => {
      for (const image of mutation.imageDeletes) {
        db.prepare(
          `DELETE FROM images
            WHERE id = ?
              AND owner_id = ?
              AND asset_ref = ?
            AND style = ?`,
        ).run(image.id, image.owner_id, image.asset_ref, STORYBOARD_MATERIAL_IMAGE_STYLE);
        deletedFiles.push(imageFullPath(image));
      }

      for (const image of mutation.imageInserts) {
        mkdirSync(join(IMAGES_DIR, String(image.ownerId)), { recursive: true });
        writeFileSync(image.fullPath, image.buffer);
        writtenFiles.push(image.fullPath);
        const inserted = db.prepare(
          `INSERT INTO images
            (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          image.id,
          image.ownerId,
          image.projectId,
          image.kind,
          image.assetRef,
          image.filename,
          image.mime,
          image.sizeBytes,
          image.width,
          image.height,
          STORYBOARD_MATERIAL_UPLOAD_PROMPT,
          STORYBOARD_MATERIAL_IMAGE_STYLE,
        );
        if (inserted.changes !== 1) {
          throw new Error(`image insert failed for asset_ref=${image.assetRef}`);
        }
      }

      db.prepare(
        `UPDATE projects
            SET data_json = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?
            AND owner_id = ?`,
      ).run(JSON.stringify(data), row.id, row.owner_id);
    })();
    for (const path of deletedFiles) safeUnlink(path);
  } catch (error) {
    for (const path of writtenFiles) safeUnlink(path);
    throw error;
  }
}

async function migrateProject(args: Args, row: ProjectRow): Promise<void> {
  summary.projectsScanned += 1;
  let data: any;
  try {
    data = JSON.parse(row.data_json || '{}');
  } catch (error: any) {
    log(`跳过项目 ${row.id}: data_json 解析失败 ${error?.message || String(error)}`);
    return;
  }

  let changed = false;
  const mutation: ProjectMutation = { imageInserts: [], imageDeletes: [] };
  const assets = data.assets && typeof data.assets === 'object' ? data.assets : {};
  for (const spec of MATERIAL_LISTS) {
    const list = Array.isArray(assets[spec.key]) ? assets[spec.key] : [];
    for (const item of list) {
      const itemChanged = await migrateMaterialItem(args, row, item, spec, mutation);
      changed = changed || itemChanged;
    }
  }

  const videoRoleChanges = normalizeVideoReferenceRoles(data.videoReferenceManifest, !args.dryRun);
  if (videoRoleChanges) {
    summary.videoRolesNormalized += videoRoleChanges;
    changed = true;
  }

  const legacyIndexExclusionKeysRemoved = pruneLegacyIndexExclusionKeys(data);
  if (legacyIndexExclusionKeysRemoved) {
    summary.legacyIndexExclusionKeysRemoved += legacyIndexExclusionKeysRemoved;
    changed = true;
  }

  if (!changed) return;
  if (args.dryRun) {
    summary.projectsWouldUpdate += 1;
    return;
  }

  applyProjectMutation(row, data, mutation);
  summary.projectsUpdated += 1;
}

async function ensureApplyPreflight() {
  if (!existsSync(SQLITE_PATH)) {
    throw new Error(`sqlite 文件不存在: ${SQLITE_PATH}`);
  }
  const backupPath = `${SQLITE_PATH}.bak.${timestampSlug()}`;
  const db = getDb();
  await db.backup(backupPath);
  log(`已备份 sqlite: ${backupPath}`);

  const index = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_images_storyboard_material_asset_ref'`,
  ).get();
  if (!index) {
    throw new Error('缺少 idx_images_storyboard_material_asset_ref partial unique index');
  }
  const duplicates = db.prepare(
    `SELECT owner_id, project_id, asset_ref, count(*) AS n
       FROM images
      WHERE style = ?
        AND asset_ref IS NOT NULL
      GROUP BY owner_id, project_id, asset_ref
     HAVING count(*) > 1
      LIMIT 5`,
  ).all(STORYBOARD_MATERIAL_IMAGE_STYLE);
  if (duplicates.length) {
    throw new Error(`检测到 storyboard material image 重复 asset_ref: ${JSON.stringify(duplicates)}`);
  }
}

function projectRows(args: Args, cursor: ProjectCursor, limit: number): ProjectRow[] {
  const clauses: string[] = [
    `(instr(data_json, ?) > 0 OR instr(data_json, ?) > 0 OR instr(data_json, ?) > 0)`,
  ];
  const params: any[] = [OLD_MEDIA_PREFIX, STORYBOARD_MATERIAL_IMAGE_STYLE, '"role":"char"'];
  if (args.projectId) {
    clauses.push('id = ?');
    params.push(args.projectId);
  }
  if (args.ownerId) {
    clauses.push('owner_id = ?');
    params.push(args.ownerId);
  }
  if (cursor) {
    clauses.push('(owner_id > ? OR (owner_id = ? AND id > ?))');
    params.push(cursor.ownerId, cursor.ownerId, cursor.id);
  }
  params.push(limit);
  return getDb()
    .prepare(
      `SELECT id, owner_id, data_json
         FROM projects
        WHERE ${clauses.join(' AND ')}
        ORDER BY owner_id, id
        LIMIT ?`,
    )
    .all(...params) as ProjectRow[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  summary.dryRun = args.dryRun;
  log(`开始迁移 storyboard material uploads, mode=${args.dryRun ? 'dry-run' : 'apply'}, log=${logPath}`);
  if (args.apply) await ensureApplyPreflight();
  let cursor: ProjectCursor = null;
  let batchNo = 0;
  while (true) {
    const rows = projectRows(args, cursor, PROJECT_BATCH_SIZE);
    if (!rows.length) break;
    batchNo += 1;
    log(`命中项目批次 ${batchNo}: ${rows.length}`);
    for (const row of rows) {
      await migrateProject(args, row);
    }
    const last = rows[rows.length - 1];
    cursor = { ownerId: last.owner_id, id: last.id };
  }
  log(`summary ${JSON.stringify(summary, null, 2)}`);
}

main().catch((error) => {
  log(`迁移失败: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
