import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { deriveRemoteUrlExpiresAt, enqueueOnlineEditorDownload } from './online-editor-downloads';

export class OnlineEditorExportRecordError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'OnlineEditorExportRecordError';
    this.status = status;
  }
}

function parseOptionalJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function readExistingExportByExternalId(db: any, externalExportId: string) {
  return db
    .prepare(
      `SELECT id, owner_id, status, local_download_status, edl_json
         FROM exports
        WHERE provider = @provider
          AND external_export_id = @externalId
        LIMIT 1`,
    )
    .get({ provider: 'vevdemo', externalId: externalExportId });
}

function duplicateExportPayload(existing: any, userId: number) {
  if (Number(existing.owner_id) !== Number(userId)) {
    throw new OnlineEditorExportRecordError('duplicate external export id belongs to another user', 409);
  }
  const existingMeta = parseOptionalJson(existing.edl_json);
  return {
    success: true,
    duplicate: true,
    exportId: existing.id,
    status: existing.status,
    localDownloadStatus: existing.local_download_status || existingMeta.vevDemo?.localDownloadStatus || null,
    vevDemo: existingMeta.vevDemo || null,
  };
}

export function saveVevDemoExportRecord(input: {
  userId: number;
  projectId?: string | null;
  taskId?: string | null;
  outputUrl?: unknown;
  duration?: unknown;
  format?: unknown;
  edlJson?: unknown;
}) {
  const {
    userId,
    projectId,
    taskId,
    outputUrl,
    duration,
    format = 'mp4',
    edlJson,
  } = input;
  const externalExportId = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
  const exportId = randomUUID();
  const db = getDb();

  if (externalExportId) {
    const existing = readExistingExportByExternalId(db, externalExportId);
    if (existing) return duplicateExportPayload(existing, userId);
  }

  const baseEdlJson = parseOptionalJson(edlJson);
  const receivedAt = new Date().toISOString();
  const remoteUrl = typeof outputUrl === 'string' ? outputUrl.trim() : '';
  const hasRemoteUrl = Boolean(remoteUrl);
  const finalStatus = hasRemoteUrl ? 'completed' : 'failed';
  const finalProgress = hasRemoteUrl ? 100 : 0;
  const finalError = hasRemoteUrl ? null : 'missing remote url from VevDemo';
  const remoteUrlExpiresAt = hasRemoteUrl ? deriveRemoteUrlExpiresAt(remoteUrl) : null;
  const vevDemoExport = {
    provider: 'vevdemo',
    remoteProvider: 'volcengine',
    taskId: taskId || null,
    outputUrl: remoteUrl || null,
    remoteUrl: remoteUrl || null,
    format,
    durationSec: duration || null,
    receivedAt,
    remoteUrlExpiresAt,
    localDownloadStatus: hasRemoteUrl ? 'pending' : null,
  };
  const mergedEdlJson = {
    ...baseEdlJson,
    vevDemo: vevDemoExport,
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO exports (
      id, owner_id, project_id, status, progress,
      provider, external_export_id,
      filename, local_download_status, edl_json, duration_sec, error_msg,
      created_at, updated_at
    ) VALUES (
      @id, @owner_id, @project_id, @status, @progress,
      @provider, @external_export_id,
      @filename, @local_download_status, @edl_json, @duration_sec, @error_msg,
      @created_at, @updated_at
    )
  `).run({
    id: exportId,
    owner_id: userId,
    project_id: projectId || 'vevdemo',
    status: finalStatus,
    progress: finalProgress,
    provider: 'vevdemo',
    external_export_id: externalExportId,
    filename: null,
    local_download_status: hasRemoteUrl ? 'pending' : null,
    edl_json: JSON.stringify(mergedEdlJson),
    duration_sec: duration || null,
    error_msg: finalError,
    created_at: receivedAt,
    updated_at: receivedAt,
  });
  if (insert.changes !== 1 && externalExportId) {
    const existing = readExistingExportByExternalId(db, externalExportId);
    if (existing) return duplicateExportPayload(existing, userId);
    throw new OnlineEditorExportRecordError('导出记录写入被忽略，但未找到已有记录', 409);
  }

  if (hasRemoteUrl) {
    enqueueOnlineEditorDownload({ exportId, ownerId: Number(userId) });
  }

  return {
    success: hasRemoteUrl,
    exportId,
    status: finalStatus,
    error: finalError,
    message: hasRemoteUrl ? '导出记录已保存' : '导出记录已保存为失败状态：缺少远程 URL',
    vevDemo: vevDemoExport,
  };
}
