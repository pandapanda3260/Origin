import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { getDb } from './db';

export const ASSET_LIBRARY_LIMITS = {
  hotTotalBytes: 150 * 1024 * 1024 * 1024,
  hotImageBytes: 30 * 1024 * 1024 * 1024,
  hotVideoBytes: 100 * 1024 * 1024 * 1024,
  hotImageCount: 50000,
  hotVideoCount: 20000,
  videoHardLimitBytes: 200 * 1024 * 1024,
  toolboxRunningLimit: 3,
  staleRunningMinutes: 30,
  recycleBinDays: 60,
  purgeAuditDays: 180,
} as const;

export type AssetKind = 'image' | 'video';
export type AssetSource = 'generated' | 'uploaded' | 'toolbox' | 'edit_export' | 'imported';
export type AssetDependencyRole = 'first_frame' | 'tail_frame' | 'reference_image' | 'source_video' | 'edit_source_clip';
export type GenerationBatchStatus = 'running' | 'success' | 'partial_success' | 'failed' | 'cancelled';
export type GenerationFailureReason =
  | 'provider_error'
  | 'timeout'
  | 'cancelled'
  | 'rejected_output'
  | 'corrupt_output'
  | 'quota_blocked'
  | 'missing_input'
  | 'unknown';

export type AssetRecordInput = {
  assetId?: string;
  ownerId: number;
  projectId?: string | null;
  shotUid?: string | null;
  legacyShotId?: string | number | null;
  versionGroupId?: string | null;
  batchId?: string | null;
  assetKind: AssetKind;
  source: AssetSource;
  stage: string;
  fileUri: string;
  thumbUri?: string | null;
  fileHash?: string | null;
  byteSize?: number | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  predecessorVersionAssetId?: string | null;
  makeCurrent?: boolean;
};

export type GenerationBatchInput = {
  batchId?: string;
  ownerId: number;
  projectId?: string | null;
  shotUid?: string | null;
  legacyShotId?: string | number | null;
  stage: string;
  requestedCount?: number;
  contextHash?: string | null;
  contextSnapshot?: Record<string, any> | null;
  source?: 'project' | 'toolbox' | 'upload' | 'edit';
};

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function cleanProjectRelation(projectId: string | null | undefined) {
  return cleanText(projectId) ? 'linked' : 'no_project';
}

function cleanShotRelation(shotUid: string | null | undefined, legacyShotId?: string | number | null) {
  if (cleanText(shotUid)) return 'linked';
  if (cleanText(legacyShotId)) return 'unknown';
  return 'no_shot';
}

export function hashFile(path: string) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function fileSize(path: string) {
  return statSync(path).size;
}

export function localAssetUri(bucket: 'images' | 'videos' | 'uploads' | 'exports', ownerId: number, filename: string) {
  return `local://${bucket}/${ownerId}/${filename}`;
}

export function createGenerationBatch(input: GenerationBatchInput) {
  const db = getDb();
  const batchId = input.batchId || randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO generation_batches
      (batch_id, owner_id, project_id, shot_uid, legacy_shot_id, stage, status,
       requested_count, context_hash, context_snapshot, source, started_at, heartbeat_at,
       created_at, updated_at)
     VALUES
      (@batchId, @ownerId, @projectId, @shotUid, @legacyShotId, @stage, 'running',
       @requestedCount, @contextHash, @contextSnapshot, @source, @now, @now, @now, @now)`,
  ).run({
    batchId,
    ownerId: input.ownerId,
    projectId: cleanText(input.projectId),
    shotUid: cleanText(input.shotUid),
    legacyShotId: cleanText(input.legacyShotId),
    stage: input.stage,
    requestedCount: Math.max(1, Number(input.requestedCount || 1)),
    contextHash: cleanText(input.contextHash),
    contextSnapshot: JSON.stringify(input.contextSnapshot || {}),
    source: input.source || (input.projectId ? 'project' : 'toolbox'),
    now,
  });
  return batchId;
}

export function heartbeatGenerationBatch(batchId: string, ownerId: number) {
  const info = getDb().prepare(
    `UPDATE generation_batches
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE batch_id = ? AND owner_id = ? AND status = 'running'`,
  ).run(batchId, ownerId);
  return info.changes > 0;
}

export function finishGenerationBatch(batchId: string, ownerId: number, status?: GenerationBatchStatus) {
  const db = getDb();
  const counts = db.prepare<{ batchId: string }, { failedCount: number; assetCount: number }>(
    `SELECT
       (SELECT COUNT(*) FROM generation_failures WHERE batch_id = @batchId) AS failedCount,
       (SELECT COUNT(*) FROM assets WHERE batch_id = @batchId) AS assetCount`,
  ).get({ batchId }) || { failedCount: 0, assetCount: 0 };
  const failedCount = Number(counts.failedCount || 0);
  const assetCount = Number(counts.assetCount || 0);
  const nextStatus = status || (assetCount > 0 && failedCount > 0
    ? 'partial_success'
    : assetCount > 0
      ? 'success'
      : failedCount > 0
        ? 'failed'
        : 'cancelled');
  db.prepare(
    `UPDATE generation_batches
        SET status = @status,
            succeeded_count = @assetCount,
            failed_count = @failedCount,
            completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE batch_id = @batchId AND owner_id = @ownerId`,
  ).run({ batchId, ownerId, status: nextStatus, assetCount, failedCount });
  return nextStatus;
}

export function recordGenerationFailure(input: {
  failureId?: string;
  batchId: string;
  ownerId: number;
  slotIndex?: number;
  failureReason?: GenerationFailureReason;
  errorMessage?: string | null;
  retryable?: boolean;
}) {
  const failureId = input.failureId || randomUUID();
  getDb().prepare(
    `INSERT INTO generation_failures
      (failure_id, batch_id, owner_id, slot_index, failure_reason, error_message, retryable)
     VALUES
      (@failureId, @batchId, @ownerId, @slotIndex, @failureReason, @errorMessage, @retryable)`,
  ).run({
    failureId,
    batchId: input.batchId,
    ownerId: input.ownerId,
    slotIndex: Number.isInteger(input.slotIndex) ? input.slotIndex : 0,
    failureReason: input.failureReason || 'unknown',
    errorMessage: input.errorMessage || null,
    retryable: input.retryable === false ? 0 : 1,
  });
  return failureId;
}

export function failStaleRunningBatches(maxAgeMinutes = ASSET_LIBRARY_LIMITS.staleRunningMinutes) {
  const threshold = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const info = getDb().prepare(
    `UPDATE generation_batches
        SET status = 'failed',
            error_message = COALESCE(error_message, 'running batch heartbeat expired'),
            completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status = 'running'
        AND heartbeat_at < @threshold`,
  ).run({ threshold });
  return info.changes;
}

export function countRunningToolboxBatches(ownerId: number) {
  const row = getDb().prepare<{ ownerId: number }, { c: number }>(
    `SELECT COUNT(*) AS c
       FROM generation_batches
      WHERE owner_id = @ownerId
        AND status = 'running'
        AND project_id IS NULL`,
  ).get({ ownerId });
  return Number(row?.c || 0);
}

export function ensureAssetVersionGroup(input: {
  ownerId: number;
  projectId?: string | null;
  shotUid?: string | null;
  stage: string;
  versionGroupId?: string | null;
}) {
  const db = getDb();
  if (input.versionGroupId) {
    const existing = db.prepare<{ id: string; ownerId: number }, any>(
      `SELECT version_group_id FROM asset_version_groups
        WHERE version_group_id = @id AND owner_id = @ownerId LIMIT 1`,
    ).get({ id: input.versionGroupId, ownerId: input.ownerId });
    if (existing) return input.versionGroupId;
  }

  const projectId = cleanText(input.projectId);
  const shotUid = cleanText(input.shotUid);
  const existing = projectId
    ? db.prepare<any, any>(
      `SELECT version_group_id FROM asset_version_groups
        WHERE owner_id = @ownerId
          AND project_id = @projectId
          AND COALESCE(shot_uid, '') = COALESCE(@shotUid, '')
          AND stage = @stage
        ORDER BY updated_at DESC
        LIMIT 1`,
    ).get({ ownerId: input.ownerId, projectId, shotUid, stage: input.stage })
    : null;
  if (existing?.version_group_id) return String(existing.version_group_id);

  const versionGroupId = input.versionGroupId || randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO asset_version_groups
      (version_group_id, owner_id, project_id, shot_uid, stage, created_at, updated_at)
     VALUES
      (@versionGroupId, @ownerId, @projectId, @shotUid, @stage, @now, @now)`,
  ).run({
    versionGroupId,
    ownerId: input.ownerId,
    projectId,
    shotUid,
    stage: input.stage,
    now,
  });
  return versionGroupId;
}

export function createAssetRecord(input: AssetRecordInput) {
  const db = getDb();
  const tx = db.transaction(() => {
    const versionGroupId = ensureAssetVersionGroup({
      ownerId: input.ownerId,
      projectId: input.projectId,
      shotUid: input.shotUid,
      stage: input.stage,
      versionGroupId: input.versionGroupId,
    });
    const existing = db.prepare<any, any>(
      `SELECT * FROM assets
        WHERE owner_id = @ownerId
          AND COALESCE(project_id, '') = COALESCE(@projectId, '')
          AND COALESCE(shot_uid, COALESCE(legacy_shot_id, '')) = COALESCE(@shotUid, COALESCE(@legacyShotId, ''))
          AND stage = @stage
          AND COALESCE(file_hash, file_uri) = COALESCE(@fileHash, @fileUri)
        LIMIT 1`,
    ).get({
      ownerId: input.ownerId,
      projectId: cleanText(input.projectId),
      shotUid: cleanText(input.shotUid),
      legacyShotId: cleanText(input.legacyShotId),
      stage: input.stage,
      fileHash: cleanText(input.fileHash),
      fileUri: input.fileUri,
    });
    if (existing) {
      if (input.makeCurrent) setCurrentAsset(versionGroupId, existing.asset_id, input.ownerId);
      refreshQuotaUsage(input.ownerId);
      return existing.asset_id as string;
    }

    const row = db.prepare<{ versionGroupId: string }, { n: number }>(
      'SELECT COALESCE(MAX(version_index), 0) + 1 AS n FROM assets WHERE version_group_id = @versionGroupId',
    ).get({ versionGroupId });
    const assetId = input.assetId || randomUUID();
    const versionIndex = Number(row?.n || 1);
    const projectId = cleanText(input.projectId);
    const shotUid = cleanText(input.shotUid);
    const legacyShotId = cleanText(input.legacyShotId);
    db.prepare(
      `INSERT INTO assets
        (asset_id, owner_id, project_id, shot_uid, legacy_shot_id, version_group_id,
         batch_id, asset_kind, source, stage, file_uri, thumb_uri, file_hash, byte_size,
         duration_ms, width, height, version_index, predecessor_version_asset_id,
         project_relation_status, shot_relation_status, accessed_at)
       VALUES
        (@assetId, @ownerId, @projectId, @shotUid, @legacyShotId, @versionGroupId,
         @batchId, @assetKind, @source, @stage, @fileUri, @thumbUri, @fileHash, @byteSize,
         @durationMs, @width, @height, @versionIndex, @predecessorVersionAssetId,
         @projectRelationStatus, @shotRelationStatus, @now)`,
    ).run({
      assetId,
      ownerId: input.ownerId,
      projectId,
      shotUid,
      legacyShotId,
      versionGroupId,
      batchId: cleanText(input.batchId),
      assetKind: input.assetKind,
      source: input.source,
      stage: input.stage,
      fileUri: input.fileUri,
      thumbUri: cleanText(input.thumbUri),
      fileHash: cleanText(input.fileHash),
      byteSize: Math.max(0, Number(input.byteSize || 0)),
      durationMs: input.durationMs == null ? null : Math.max(0, Number(input.durationMs || 0)),
      width: input.width == null ? null : Math.max(0, Number(input.width || 0)),
      height: input.height == null ? null : Math.max(0, Number(input.height || 0)),
      versionIndex,
      predecessorVersionAssetId: cleanText(input.predecessorVersionAssetId),
      projectRelationStatus: cleanProjectRelation(projectId),
      shotRelationStatus: cleanShotRelation(shotUid, legacyShotId),
      now: nowIso(),
    });
    if (input.makeCurrent) setCurrentAsset(versionGroupId, assetId, input.ownerId);
    refreshQuotaUsage(input.ownerId);
    return assetId;
  });
  return tx.immediate();
}

export function setCurrentAsset(versionGroupId: string, assetId: string | null, ownerId: number) {
  getDb().prepare(
    `UPDATE asset_version_groups
        SET current_asset_id = @assetId,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE version_group_id = @versionGroupId
        AND owner_id = @ownerId`,
  ).run({ versionGroupId, assetId, ownerId });
}

function auditAssetEvent(ownerId: number, assetId: string | null, eventType: string, meta: Record<string, any> = {}) {
  getDb().prepare(
    `INSERT INTO asset_audit_events
      (id, owner_id, asset_id, event_type, meta_json)
     VALUES
      (@id, @ownerId, @assetId, @eventType, @metaJson)`,
  ).run({
    id: randomUUID(),
    ownerId,
    assetId,
    eventType,
    metaJson: JSON.stringify(meta),
  });
}

function purgeEligibleAt(days = ASSET_LIBRARY_LIMITS.recycleBinDays) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function getAssetStrongReferences(ownerId: number, assetId: string) {
  const db = getDb();
  const currentGroups = db.prepare<{ ownerId: number; assetId: string }, any>(
    `SELECT version_group_id, current_asset_id
       FROM asset_version_groups
      WHERE owner_id = @ownerId
        AND current_asset_id = @assetId`,
  ).all({ ownerId, assetId });
  const editRefs = db.prepare<{ assetId: string }, { c: number }>(
    `SELECT COUNT(*) AS c
       FROM edit_project_clips
      WHERE asset_id = @assetId`,
  ).get({ assetId })?.c || 0;
  return {
    currentGroups,
    editRefCount: Number(editRefs || 0),
    hasStrongReference: currentGroups.length > 0 || Number(editRefs || 0) > 0,
  };
}

export function softDeleteAsset(input: {
  ownerId: number;
  assetId: string;
  clearCurrentIfOnlyVersion?: boolean;
}) {
  const db = getDb();
  const tx = db.transaction(() => {
    const asset = db.prepare<{ ownerId: number; assetId: string }, any>(
      `SELECT * FROM assets
        WHERE owner_id = @ownerId
          AND asset_id = @assetId
        LIMIT 1`,
    ).get({ ownerId: input.ownerId, assetId: input.assetId });
    if (!asset) return { ok: false, status: 404, error: 'asset_not_found' };
    if (asset.lifecycle_status === 'purged') return { ok: false, status: 409, error: 'asset_already_purged' };

    const refs = getAssetStrongReferences(input.ownerId, input.assetId);
    if (refs.editRefCount > 0) {
      return { ok: false, status: 409, error: 'asset_used_by_edit_project', refs };
    }
    if (refs.currentGroups.length > 0) {
      if (!input.clearCurrentIfOnlyVersion) {
        return { ok: false, status: 409, error: 'asset_is_current', refs };
      }
      for (const group of refs.currentGroups) {
        const count = db.prepare<{ groupId: string }, { c: number }>(
          `SELECT COUNT(*) AS c
             FROM assets
            WHERE version_group_id = @groupId
              AND lifecycle_status != 'purged'`,
        ).get({ groupId: group.version_group_id })?.c || 0;
        if (Number(count) > 1) {
          return { ok: false, status: 409, error: 'current_asset_has_alternatives_select_other_first', refs };
        }
      }
      for (const group of refs.currentGroups) {
        db.prepare(
          `UPDATE asset_version_groups
              SET current_asset_id = NULL,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE version_group_id = ? AND owner_id = ?`,
        ).run(group.version_group_id, input.ownerId);
      }
    }

    db.prepare(
      `UPDATE assets
          SET lifecycle_status = 'soft_deleted',
              purge_eligible_at = @purgeEligibleAt,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = @ownerId
          AND asset_id = @assetId`,
    ).run({
      ownerId: input.ownerId,
      assetId: input.assetId,
      purgeEligibleAt: purgeEligibleAt(),
    });
    auditAssetEvent(input.ownerId, input.assetId, 'soft_delete', { clearCurrentIfOnlyVersion: !!input.clearCurrentIfOnlyVersion });
    refreshQuotaUsage(input.ownerId);
    return { ok: true, assetId: input.assetId };
  });
  return tx.immediate();
}

export function restoreAsset(ownerId: number, assetId: string, eventType = 'restore') {
  const db = getDb();
  const tx = db.transaction(() => {
    const asset = db.prepare<{ ownerId: number; assetId: string }, any>(
      `SELECT lifecycle_status FROM assets
        WHERE owner_id = @ownerId
          AND asset_id = @assetId
        LIMIT 1`,
    ).get({ ownerId, assetId });
    if (!asset) return { ok: false, status: 404, error: 'asset_not_found' };
    if (asset.lifecycle_status === 'purged') return { ok: false, status: 409, error: 'asset_already_purged' };
    db.prepare(
      `UPDATE assets
          SET lifecycle_status = 'active',
              purge_eligible_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = @ownerId
          AND asset_id = @assetId`,
    ).run({ ownerId, assetId });
    auditAssetEvent(ownerId, assetId, eventType);
    refreshQuotaUsage(ownerId);
    return { ok: true, assetId };
  });
  return tx.immediate();
}

export function adoptAssetAsCurrent(ownerId: number, assetId: string) {
  const db = getDb();
  const tx = db.transaction(() => {
    const asset = db.prepare<{ ownerId: number; assetId: string }, any>(
      `SELECT * FROM assets
        WHERE owner_id = @ownerId
          AND asset_id = @assetId
        LIMIT 1`,
    ).get({ ownerId, assetId });
    if (!asset) return { ok: false, status: 404, error: 'asset_not_found' };
    if (asset.lifecycle_status === 'purged') return { ok: false, status: 409, error: 'asset_already_purged' };
    if (asset.lifecycle_status === 'soft_deleted') {
      db.prepare(
        `UPDATE assets
            SET lifecycle_status = 'active',
                purge_eligible_at = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE owner_id = @ownerId
            AND asset_id = @assetId`,
      ).run({ ownerId, assetId });
      auditAssetEvent(ownerId, assetId, 'resurrect_set_current');
    }
    db.prepare(
      `UPDATE asset_version_groups
          SET current_asset_id = @assetId,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = @ownerId
          AND version_group_id = @versionGroupId`,
    ).run({ ownerId, assetId, versionGroupId: asset.version_group_id });
    refreshQuotaUsage(ownerId);
    return { ok: true, assetId, versionGroupId: asset.version_group_id };
  });
  return tx.immediate();
}

export function purgeSoftDeletedAssets(limit = 100) {
  const db = getDb();
  const now = nowIso();
  const rows = db.prepare<{ now: string; limit: number }, any>(
    `SELECT asset_id, owner_id
       FROM assets
      WHERE lifecycle_status = 'soft_deleted'
        AND purge_eligible_at IS NOT NULL
        AND purge_eligible_at <= @now
      ORDER BY purge_eligible_at ASC
      LIMIT @limit`,
  ).all({ now, limit: Math.max(1, Math.min(1000, Number(limit || 100))) });
  let purged = 0;
  for (const row of rows) {
    const refs = getAssetStrongReferences(Number(row.owner_id), String(row.asset_id));
    if (refs.hasStrongReference) continue;
    db.prepare(
      `UPDATE assets
          SET lifecycle_status = 'purged',
              file_availability = 'missing',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = ?
          AND asset_id = ?
          AND lifecycle_status = 'soft_deleted'`,
    ).run(Number(row.owner_id), String(row.asset_id));
    auditAssetEvent(Number(row.owner_id), String(row.asset_id), 'purge_marked');
    refreshQuotaUsage(Number(row.owner_id));
    purged += 1;
  }
  return { scanned: rows.length, purged };
}

export function refreshQuotaUsage(ownerId: number) {
  const db = getDb();
  const row = db.prepare<{ ownerId: number }, any>(
    `SELECT
       SUM(CASE WHEN asset_kind = 'image' THEN 1 ELSE 0 END) AS hot_image_count,
       SUM(CASE WHEN asset_kind = 'image' THEN byte_size ELSE 0 END) AS hot_image_bytes,
       SUM(CASE WHEN asset_kind = 'video' THEN 1 ELSE 0 END) AS hot_video_count,
       SUM(CASE WHEN asset_kind = 'video' THEN byte_size ELSE 0 END) AS hot_video_bytes,
       SUM(byte_size) AS hot_total_bytes
     FROM assets
     WHERE owner_id = @ownerId
       AND lifecycle_status = 'active'
       AND storage_tier = 'hot'
       AND file_availability = 'present'`,
  ).get({ ownerId }) || {};
  const hotImageCount = Number(row.hot_image_count || 0);
  const hotImageBytes = Number(row.hot_image_bytes || 0);
  const hotVideoCount = Number(row.hot_video_count || 0);
  const hotVideoBytes = Number(row.hot_video_bytes || 0);
  const hotTotalBytes = Number(row.hot_total_bytes || 0);
  const isOverQuota =
    hotTotalBytes > ASSET_LIBRARY_LIMITS.hotTotalBytes ||
    hotImageBytes > ASSET_LIBRARY_LIMITS.hotImageBytes ||
    hotVideoBytes > ASSET_LIBRARY_LIMITS.hotVideoBytes ||
    hotImageCount > ASSET_LIBRARY_LIMITS.hotImageCount ||
    hotVideoCount > ASSET_LIBRARY_LIMITS.hotVideoCount;
  db.prepare(
    `INSERT INTO quota_usage
      (owner_id, hot_image_count, hot_image_bytes, hot_video_count, hot_video_bytes,
       hot_total_bytes, is_over_quota, updated_at)
     VALUES
      (@ownerId, @hotImageCount, @hotImageBytes, @hotVideoCount, @hotVideoBytes,
       @hotTotalBytes, @isOverQuota, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(owner_id) DO UPDATE SET
       hot_image_count = excluded.hot_image_count,
       hot_image_bytes = excluded.hot_image_bytes,
       hot_video_count = excluded.hot_video_count,
       hot_video_bytes = excluded.hot_video_bytes,
       hot_total_bytes = excluded.hot_total_bytes,
       is_over_quota = excluded.is_over_quota,
       updated_at = excluded.updated_at`,
  ).run({
    ownerId,
    hotImageCount,
    hotImageBytes,
    hotVideoCount,
    hotVideoBytes,
    hotTotalBytes,
    isOverQuota: isOverQuota ? 1 : 0,
  });
  return {
    ownerId,
    hotImageCount,
    hotImageBytes,
    hotVideoCount,
    hotVideoBytes,
    hotTotalBytes,
    isOverQuota,
  };
}

export function getQuotaUsage(ownerId: number) {
  const existing = getDb().prepare<{ ownerId: number }, any>(
    'SELECT * FROM quota_usage WHERE owner_id = @ownerId',
  ).get({ ownerId });
  if (existing) {
    return {
      ownerId,
      hotImageCount: Number(existing.hot_image_count || 0),
      hotImageBytes: Number(existing.hot_image_bytes || 0),
      hotVideoCount: Number(existing.hot_video_count || 0),
      hotVideoBytes: Number(existing.hot_video_bytes || 0),
      hotTotalBytes: Number(existing.hot_total_bytes || 0),
      isOverQuota: !!existing.is_over_quota,
    };
  }
  return refreshQuotaUsage(ownerId);
}

export class AssetQuotaError extends Error {
  status = 409;
  quota: ReturnType<typeof getQuotaUsage>;

  constructor(quota: ReturnType<typeof getQuotaUsage>) {
    super('素材库热存配额已超限，请先清理或归档素材后再生成。');
    this.quota = quota;
  }
}

export function assertCanStartAssetGeneration(ownerId: number) {
  const quota = getQuotaUsage(ownerId);
  if (quota.isOverQuota) throw new AssetQuotaError(quota);
  return quota;
}

export function markColdAssets(opts: { ownerId?: number | null; inactiveDays?: number; limit?: number } = {}) {
  const db = getDb();
  const inactiveDays = Math.max(1, Number(opts.inactiveDays || 30));
  const limit = Math.max(1, Math.min(1000, Number(opts.limit || 200)));
  const threshold = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000).toISOString();
  const params: any = { threshold, limit };
  const ownerClause = opts.ownerId ? 'AND a.owner_id = @ownerId' : '';
  if (opts.ownerId) params.ownerId = opts.ownerId;
  const rows = db.prepare<any, any>(
    `SELECT a.asset_id, a.owner_id
       FROM assets a
      WHERE a.lifecycle_status = 'active'
        AND a.storage_tier = 'hot'
        AND a.file_availability = 'present'
        AND COALESCE(a.accessed_at, a.created_at) < @threshold
        ${ownerClause}
        AND NOT EXISTS (
          SELECT 1 FROM asset_version_groups vg
           WHERE vg.owner_id = a.owner_id
             AND vg.current_asset_id = a.asset_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM edit_project_clips epc
           WHERE epc.asset_id = a.asset_id
        )
      ORDER BY COALESCE(a.accessed_at, a.created_at) ASC
      LIMIT @limit`,
  ).all(params);
  for (const row of rows) {
    db.prepare(
      `UPDATE assets
          SET storage_tier = 'cold',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = ?
          AND asset_id = ?
          AND storage_tier = 'hot'`,
    ).run(Number(row.owner_id), String(row.asset_id));
  }
  const owners = new Set(rows.map((row: any) => Number(row.owner_id)));
  for (const ownerId of owners) refreshQuotaUsage(ownerId);
  return { scanned: rows.length, markedCold: rows.length };
}

export function ensureEditProject(ownerId: number, projectId: string) {
  const db = getDb();
  const existing = db.prepare<{ ownerId: number; projectId: string }, { edit_project_id: string }>(
    `SELECT edit_project_id FROM edit_projects
      WHERE owner_id = @ownerId
        AND project_id = @projectId
        AND status != 'deleted'
      ORDER BY updated_at DESC
      LIMIT 1`,
  ).get({ ownerId, projectId });
  if (existing?.edit_project_id) return existing.edit_project_id;
  const editProjectId = randomUUID();
  db.prepare(
    `INSERT INTO edit_projects
      (edit_project_id, owner_id, project_id, status)
     VALUES
      (@editProjectId, @ownerId, @projectId, 'draft')`,
  ).run({ editProjectId, ownerId, projectId });
  return editProjectId;
}

export function syncEditProjectClips(input: {
  ownerId: number;
  projectId: string;
  timeline: Array<{ clipId?: string; in?: number; out?: number; track?: number }>;
}) {
  const db = getDb();
  const tx = db.transaction(() => {
    const editProjectId = ensureEditProject(input.ownerId, input.projectId);
    db.prepare('DELETE FROM edit_project_clips WHERE edit_project_id = ?').run(editProjectId);
    const insert = db.prepare(
      `INSERT INTO edit_project_clips
        (edit_project_id, asset_id, position, in_ms, out_ms, track)
       VALUES
        (@editProjectId, @assetId, @position, @inMs, @outMs, @track)`,
    );
    let inserted = 0;
    input.timeline.forEach((clip, position) => {
      const assetId = cleanText(clip?.clipId);
      if (!assetId) return;
      const found = db.prepare<{ assetId: string; ownerId: number }, { asset_id: string }>(
        `SELECT asset_id FROM assets
          WHERE asset_id = @assetId
            AND owner_id = @ownerId
            AND lifecycle_status != 'purged'
          LIMIT 1`,
      ).get({ assetId, ownerId: input.ownerId });
      if (!found) return;
      insert.run({
        editProjectId,
        assetId,
        position,
        inMs: Math.max(0, Math.round(Number(clip.in || 0) * 1000)),
        outMs: clip.out == null ? null : Math.max(0, Math.round(Number(clip.out || 0) * 1000)),
        track: Number.isInteger(Number(clip.track)) ? Number(clip.track) : 0,
      });
      inserted += 1;
    });
    db.prepare(
      `UPDATE edit_projects
          SET status = CASE WHEN status = 'exported' THEN status ELSE 'draft' END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE edit_project_id = ?`,
    ).run(editProjectId);
    return { editProjectId, inserted };
  });
  return tx.immediate();
}

export function assetPublicUrl(asset: any) {
  const assetId = String(asset?.asset_id || asset?.assetId || '');
  const fileUri = String(asset?.file_uri || '');
  if (!assetId) return '';
  if (fileUri.startsWith('local://uploads/')) return `/api/edit/media/${assetId}`;
  if (fileUri.startsWith('local://exports/')) return `/api/edit/export-file/${assetId}`;
  if (asset?.asset_kind === 'video' || fileUri.startsWith('local://videos/')) return `/api/videos/file/${assetId}`;
  return `/api/images/file/${assetId}`;
}

export function serializeAsset(row: any) {
  if (!row) return null;
  return {
    assetId: row.asset_id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    shotUid: row.shot_uid,
    legacyShotId: row.legacy_shot_id,
    versionGroupId: row.version_group_id,
    batchId: row.batch_id,
    kind: row.asset_kind,
    source: row.source,
    stage: row.stage,
    url: assetPublicUrl(row),
    thumbUrl: row.thumb_uri || assetPublicUrl(row),
    fileUri: row.file_uri,
    byteSize: Number(row.byte_size || 0),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    versionIndex: Number(row.version_index || 1),
    lifecycleStatus: row.lifecycle_status,
    storageTier: row.storage_tier,
    fileAvailability: row.file_availability,
    projectRelationStatus: row.project_relation_status,
    shotRelationStatus: row.shot_relation_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAssetLibraryItems(opts: {
  ownerId: number;
  projectId?: string | null;
  assetKind?: AssetKind | null;
  stage?: string | null;
  source?: AssetSource | null;
  limit?: number;
  offset?: number;
}) {
  const where = ['a.owner_id = @ownerId', "a.lifecycle_status != 'purged'"];
  const params: any = {
    ownerId: opts.ownerId,
    limit: Math.max(1, Math.min(100, Number(opts.limit || 50))),
    offset: Math.max(0, Number(opts.offset || 0)),
  };
  if (opts.projectId) {
    where.push('a.project_id = @projectId');
    params.projectId = opts.projectId;
  }
  if (opts.assetKind) {
    where.push('a.asset_kind = @assetKind');
    params.assetKind = opts.assetKind;
  }
  if (opts.stage) {
    where.push('a.stage = @stage');
    params.stage = opts.stage;
  }
  if (opts.source) {
    where.push('a.source = @source');
    params.source = opts.source;
  }
  const db = getDb();
  const rows = db.prepare<any, any>(
    `SELECT a.*
       FROM assets a
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.asset_id DESC
      LIMIT @limit OFFSET @offset`,
  ).all(params);
  const total = db.prepare<any, { c: number }>(
    `SELECT COUNT(*) AS c FROM assets a WHERE ${where.join(' AND ')}`,
  ).get(params)?.c || 0;
  return {
    items: rows.map(serializeAsset),
    total: Number(total),
    limit: params.limit,
    offset: params.offset,
  };
}

export function getProjectAssetLibrarySnapshot(ownerId: number, projectId: string) {
  const perfDiag = process.env.PERF_DIAG === '1';
  const t0 = perfDiag ? performance.now() : 0;
  const db = getDb();
  const currentRows = db.prepare<{ ownerId: number; projectId: string }, any>(
    `SELECT a.*, vg.current_asset_id
       FROM asset_version_groups vg
       LEFT JOIN assets a
         ON a.asset_id = vg.current_asset_id
        AND a.owner_id = vg.owner_id
      WHERE vg.owner_id = @ownerId
        AND vg.project_id = @projectId
        AND vg.current_asset_id IS NOT NULL
        AND a.lifecycle_status = 'active'
        AND a.file_availability = 'present'
      ORDER BY vg.stage ASC, vg.updated_at DESC`,
  ).all({ ownerId, projectId });
  const tCurrent = perfDiag ? performance.now() : 0;
  const runningBatches = db.prepare<{ ownerId: number; projectId: string }, any>(
    `SELECT batch_id, shot_uid, legacy_shot_id, stage, requested_count, started_at, heartbeat_at
       FROM generation_batches
      WHERE owner_id = @ownerId
        AND project_id = @projectId
        AND status = 'running'
      ORDER BY started_at DESC`,
  ).all({ ownerId, projectId });
  const tBatches = perfDiag ? performance.now() : 0;
  const failures = db.prepare<{ ownerId: number; projectId: string }, any>(
    `SELECT gb.batch_id, gb.shot_uid, gb.legacy_shot_id, gb.stage, gf.slot_index, gf.failure_reason, gf.error_message, gf.created_at
       FROM generation_batches gb
       JOIN generation_failures gf ON gf.batch_id = gb.batch_id
      WHERE gb.owner_id = @ownerId
        AND gb.project_id = @projectId
      ORDER BY gf.created_at DESC
      LIMIT 100`,
  ).all({ ownerId, projectId });
  const tFailures = perfDiag ? performance.now() : 0;
  const result = {
    current: currentRows.map(serializeAsset),
    runningBatches,
    failures,
  };
  if (perfDiag) {
    const tSerialize = performance.now();
    const fmt = (n: number) => n.toFixed(0);
    console.log(
      `[perf-diag] WIP getProjectAssetLibrarySnapshot pid=${projectId} uid=${ownerId} total=${fmt(tSerialize - t0)}ms`
        + ` currentRowsSql=${fmt(tCurrent - t0)}ms`
        + ` runningBatchesSql=${fmt(tBatches - tCurrent)}ms`
        + ` failuresSql=${fmt(tFailures - tBatches)}ms`
        + ` serializeCurrent=${fmt(tSerialize - tFailures)}ms`
        + ` counts(current=${currentRows.length},batches=${runningBatches.length},failures=${failures.length})`,
    );
  }
  return result;
}

function shotUidForProjectSlot(project: any, groupIdx: number) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shot = shots[groupIdx] || {};
  return cleanText(sb.shotUid || sb.shot_uid || sb.uid || sb.id || shot.shotUid || shot.shot_uid || shot.uid || shot.id);
}

export function attachAssetLibraryCurrentToProject(project: any, ownerId: number) {
  if (!project?.id) return project;
  const snapshot = getProjectAssetLibrarySnapshot(ownerId, String(project.id));
  if (!snapshot.current.length && !snapshot.runningBatches.length && !snapshot.failures.length) {
    return { ...project, assetLibrary: snapshot };
  }

  const next = { ...project };
  const storyboards = Array.isArray(project.storyboards) ? [...project.storyboards] : [];
  const videoTasks = Array.isArray(project.videoTasks) ? [...project.videoTasks] : [];
  const uidToIdx = new Map<string, number>();
  const legacyToIdx = new Map<string, number>();
  for (let i = 0; i < storyboards.length; i += 1) {
    const uid = shotUidForProjectSlot(project, i);
    if (uid) uidToIdx.set(uid, i);
    legacyToIdx.set(`shot_${i}`, i);
  }

  for (const asset of snapshot.current as any[]) {
    const idx = asset.shotUid ? uidToIdx.get(asset.shotUid) : legacyToIdx.get(asset.legacyShotId || '');
    if (idx == null || idx < 0 || idx >= storyboards.length) continue;
    const url = asset.url;
    const sb = { ...(storyboards[idx] || {}) };
    if (asset.stage === 'storyboard') {
      sb.url = url;
      sb.imageUrl = url;
      sb.assetLibraryAssetId = asset.assetId;
    } else if (asset.stage === 'first_frame') {
      const frames = sb.frames && typeof sb.frames === 'object' ? { ...sb.frames } : {};
      frames.first = { ...(frames.first || {}), url, status: 'ready', assetId: asset.assetId };
      sb.frames = frames;
      sb.firstFrameUrl = url;
      sb.imageUrl = sb.imageUrl || url;
    } else if (asset.stage === 'tail_frame') {
      const frames = sb.frames && typeof sb.frames === 'object' ? { ...sb.frames } : {};
      frames.tail = { ...(frames.tail || {}), url, status: 'ready', assetId: asset.assetId };
      sb.frames = frames;
      sb.tailFrameUrl = url;
    } else if (asset.stage === 'video_segment') {
      sb.videoUrl = url;
      sb.videoTaskId = asset.assetId;
      sb.videoDurationSec = asset.durationMs ? asset.durationMs / 1000 : sb.videoDurationSec;
      videoTasks[idx] = {
        ...(videoTasks[idx] || {}),
        taskId: asset.assetId,
        status: 'completed',
        url,
        durationSec: asset.durationMs ? asset.durationMs / 1000 : videoTasks[idx]?.durationSec,
        isCurrent: true,
      };
    }
    storyboards[idx] = sb;
  }

  next.storyboards = storyboards;
  if (videoTasks.length) next.videoTasks = videoTasks;
  next.assetLibrary = snapshot;
  return next;
}
