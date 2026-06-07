import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { buildSignedVideoUrl } from './signed-asset-url';
import { refundToolboxCredits, toolboxCreditPrice } from './toolbox-billing';
import {
  TOOLBOX_HISTORY_DEFAULT_LIMIT,
  TOOLBOX_HISTORY_MAX_LIMIT,
} from './toolbox-limits';
import type {
  ToolboxInputRef,
  ToolboxMode,
  ToolboxResultRefType,
  ToolboxSourceType,
  ToolboxStatus,
  ToolboxToolType,
} from './toolbox-modes';

export type ToolboxItemRow = {
  id: string;
  owner_id: number;
  tool_type: ToolboxToolType;
  mode: ToolboxMode;
  source_type: ToolboxSourceType;
  status: ToolboxStatus;
  prompt: string;
  params_json: string;
  input_refs_json: string;
  result_ref_type: ToolboxResultRefType;
  result_ref_id: string | null;
  parent_item_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ToolboxItemInput = {
  id?: string;
  ownerId: number;
  toolType: ToolboxToolType;
  mode: ToolboxMode;
  sourceType?: ToolboxSourceType;
  status?: ToolboxStatus;
  prompt?: string;
  params?: Record<string, any>;
  inputRefs?: ToolboxInputRef[];
  resultRefType: ToolboxResultRefType;
  resultRefId?: string | null;
  parentItemId?: string | null;
  errorMessage?: string | null;
};

function safeJson(value: string | null | undefined, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function encodeCursor(row: { created_at: string; id: string } | null | undefined) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const createdAt = String(parsed.createdAt || '');
    const id = String(parsed.id || '');
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function normalizeLimit(limit: unknown) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return TOOLBOX_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(TOOLBOX_HISTORY_MAX_LIMIT, Math.floor(n)));
}

export function createToolboxItem(input: ToolboxItemInput): ToolboxItemRow {
  const db = getDb();
  const id = input.id || randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO toolbox_items
      (id, owner_id, tool_type, mode, source_type, status, prompt, params_json,
       input_refs_json, result_ref_type, result_ref_id, parent_item_id, error_message,
       created_at, updated_at)
     VALUES
      (@id, @ownerId, @toolType, @mode, @sourceType, @status, @prompt, @paramsJson,
       @inputRefsJson, @resultRefType, @resultRefId, @parentItemId, @errorMessage,
       @now, @now)`,
  ).run({
    id,
    ownerId: input.ownerId,
    toolType: input.toolType,
    mode: input.mode,
    sourceType: input.sourceType || 'generated',
    status: input.status || 'completed',
    prompt: (input.prompt || '').slice(0, 4000),
    paramsJson: JSON.stringify(input.params || {}),
    inputRefsJson: JSON.stringify(input.inputRefs || []),
    resultRefType: input.resultRefType,
    resultRefId: input.resultRefId || null,
    parentItemId: input.parentItemId || null,
    errorMessage: input.errorMessage || null,
    now,
  });
  return getToolboxItemForUser(id, input.ownerId)!;
}

export function getToolboxItemForUser(id: string, ownerId: number): ToolboxItemRow | null {
  return getDb()
    .prepare<{ id: string; ownerId: number }, ToolboxItemRow>(
      `SELECT * FROM toolbox_items WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
    )
    .get({ id, ownerId }) || null;
}

export function updateToolboxItem(
  id: string,
  ownerId: number,
  patch: Partial<{
    status: ToolboxStatus;
    resultRefType: ToolboxResultRefType;
    resultRefId: string | null;
    errorMessage: string | null;
    params: Record<string, any>;
  }>,
) {
  const current = getToolboxItemForUser(id, ownerId);
  if (!current) return null;
  const params = patch.params ? JSON.stringify(patch.params) : current.params_json;
  getDb().prepare(
    `UPDATE toolbox_items
        SET status = @status,
            result_ref_type = @resultRefType,
            result_ref_id = @resultRefId,
            error_message = @errorMessage,
            params_json = @paramsJson,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id AND owner_id = @ownerId`,
  ).run({
    id,
    ownerId,
    status: patch.status || current.status,
    resultRefType: patch.resultRefType || current.result_ref_type,
    resultRefId: typeof patch.resultRefId === 'undefined' ? current.result_ref_id : patch.resultRefId,
    errorMessage: typeof patch.errorMessage === 'undefined' ? current.error_message : patch.errorMessage,
    paramsJson: params,
  });
  return getToolboxItemForUser(id, ownerId);
}

export function deleteToolboxItem(id: string, ownerId: number) {
  const result = getDb()
    .prepare('DELETE FROM toolbox_items WHERE id = ? AND owner_id = ?')
    .run(id, ownerId);
  return result.changes > 0;
}

function enrichedResult(row: ToolboxItemRow) {
  const db = getDb();
  const resultId = row.result_ref_id || '';
  if (!resultId) return { exists: false };
  if (row.result_ref_type === 'image') {
    const image = db
      .prepare<{ id: string; ownerId: number }, any>(
        'SELECT id, width, height, mime, created_at FROM images WHERE id = @id AND owner_id = @ownerId LIMIT 1',
      )
      .get({ id: resultId, ownerId: row.owner_id });
    if (!image) return { exists: false, deleted: true };
    return {
      exists: true,
      id: image.id,
      type: 'image',
      url: `/api/images/file/${image.id}`,
      width: image.width,
      height: image.height,
      mime: image.mime,
      createdAt: image.created_at,
    };
  }
  if (row.result_ref_type === 'video') {
    const video = db
      .prepare<{ id: string; ownerId: number }, any>(
        `SELECT id, status, prompt, duration_sec, cover_image_id, created_at
           FROM video_tasks WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
      )
      .get({ id: resultId, ownerId: row.owner_id });
    if (!video) return { exists: false, deleted: true };
    const completed = String(video.status || '') === 'completed';
    return {
      exists: true,
      id: video.id,
      type: 'video',
      status: video.status,
      url: completed ? buildSignedVideoUrl(video.id, row.owner_id).url : '',
      protectedUrl: `/api/videos/file/${video.id}`,
      coverUrl: video.cover_image_id ? `/api/images/file/${video.cover_image_id}` : null,
      durationSec: video.duration_sec,
      createdAt: video.created_at,
    };
  }
  const upload = db
    .prepare<{ id: string; ownerId: number }, any>(
      `SELECT id, kind, filename, mime, size_bytes, duration_sec, created_at
         FROM uploads WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
    )
    .get({ id: resultId, ownerId: row.owner_id });
  if (!upload) return { exists: false, deleted: true };
  return {
    exists: true,
    id: upload.id,
    type: 'upload',
    kind: upload.kind,
    filename: upload.filename,
    url: `/api/edit/media/${upload.id}`,
    mime: upload.mime,
    sizeBytes: upload.size_bytes,
    durationSec: upload.duration_sec,
    createdAt: upload.created_at,
  };
}

function enrichInputRefs(row: ToolboxItemRow) {
  const db = getDb();
  const refs = safeJson(row.input_refs_json, []) as ToolboxInputRef[];
  return refs.map((ref) => {
    const id = String(ref.refId || '');
    if (!id) return { ...ref, exists: false };
    if (ref.refType === 'image') {
      const found = db
        .prepare<{ id: string; ownerId: number }, any>(
          'SELECT id FROM images WHERE id = @id AND owner_id = @ownerId LIMIT 1',
        )
        .get({ id, ownerId: row.owner_id });
      return { ...ref, exists: !!found };
    }
    const upload = db
      .prepare<{ id: string; ownerId: number }, any>(
        'SELECT id, kind, mime, filename FROM uploads WHERE id = @id AND owner_id = @ownerId LIMIT 1',
      )
      .get({ id, ownerId: row.owner_id });
    return { ...ref, exists: !!upload, kind: upload?.kind, mime: upload?.mime || ref.mime, name: upload?.filename || ref.name };
  });
}

export function serializeToolboxItem(row: ToolboxItemRow) {
  const params = safeJson(row.params_json, {});
  const result = enrichedResult(row);
  return {
    id: row.id,
    toolType: row.tool_type,
    mode: row.mode,
    sourceType: row.source_type,
    status: row.status,
    prompt: row.prompt,
    params,
    inputRefs: enrichInputRefs(row),
    resultRefType: row.result_ref_type,
    resultRefId: row.result_ref_id,
    result,
    parentItemId: row.parent_item_id,
    canEnhance:
      row.status === 'completed' &&
      row.source_type !== 'upload' &&
      result.exists &&
      (row.tool_type === 'image' || (row.tool_type === 'video' && params.resolution === '720p')),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function syncRunningVideoToolboxItems(ownerId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ ownerId: number }, ToolboxItemRow>(
      `SELECT * FROM toolbox_items
        WHERE owner_id = @ownerId
          AND tool_type = 'video'
          AND status = 'running'
        ORDER BY created_at DESC`,
    )
    .all({ ownerId });
  let changed = 0;
  for (const item of rows) {
    if (!item.result_ref_id) continue;
    const video = db
      .prepare<{ id: string; ownerId: number }, any>(
        `SELECT id, status, error_msg, error_message FROM video_tasks
          WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
      )
      .get({ id: item.result_ref_id, ownerId });
    if (!video) continue;
    const status = String(video.status || '');
    if (status !== 'completed' && status !== 'failed') continue;
    const errorMessage = status === 'failed'
      ? String(video.error_message || video.error_msg || '视频生成失败')
      : null;
    const info = db.prepare(
      `UPDATE toolbox_items
          SET status = @status,
              error_message = @errorMessage,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = @id AND owner_id = @ownerId AND status = 'running'`,
    ).run({ id: item.id, ownerId, status, errorMessage });
    if (info.changes === 0) continue;
    changed += 1;
    if (status === 'failed') {
      const params = safeJson(item.params_json, {});
      refundToolboxCredits({
        userId: ownerId,
        itemId: item.id,
        toolType: 'video',
        amount: Number(params?.billing?.creditAmount || toolboxCreditPrice('video')),
        reason: '工具箱视频生成失败退款',
      });
    }
  }
  return { scanned: rows.length, changed };
}

export function countRunningVideoToolboxItems(ownerId: number) {
  const row = getDb()
    .prepare<{ ownerId: number }, { c: number }>(
      `SELECT COUNT(*) AS c FROM toolbox_items
        WHERE owner_id = @ownerId
          AND tool_type = 'video'
          AND status = 'running'`,
    )
    .get({ ownerId });
  return Number(row?.c || 0);
}

// 图片为同步生成、无 provider 回收轮询；用 staleMs 过滤掉进程异常残留的孤儿 running 项，
// 仅统计"近期仍可能在跑"的图片项，作为软限流，避免孤儿把用户永久锁死。
export function countRunningImageToolboxItems(ownerId: number, staleMs: number) {
  const since = new Date(Date.now() - Math.max(0, staleMs)).toISOString();
  const row = getDb()
    .prepare<{ ownerId: number; since: string }, { c: number }>(
      `SELECT COUNT(*) AS c FROM toolbox_items
        WHERE owner_id = @ownerId
          AND tool_type = 'image'
          AND status = 'running'
          AND created_at >= @since`,
    )
    .get({ ownerId, since });
  return Number(row?.c || 0);
}

export function listToolboxItems(opts: {
  ownerId: number;
  toolType?: ToolboxToolType | null;
  status?: ToolboxStatus | null;
  limit?: number;
  cursor?: string | null;
}) {
  if (opts.toolType === 'video') syncRunningVideoToolboxItems(opts.ownerId);
  const limit = normalizeLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const conditions = ['owner_id = @ownerId'];
  const params: any = { ownerId: opts.ownerId, limit: limit + 1 };
  if (opts.toolType) {
    conditions.push('tool_type = @toolType');
    params.toolType = opts.toolType;
  }
  if (opts.status) {
    conditions.push('status = @status');
    params.status = opts.status;
  }
  if (cursor) {
    conditions.push('(created_at < @cursorAt OR (created_at = @cursorAt AND id < @cursorId))');
    params.cursorAt = cursor.createdAt;
    params.cursorId = cursor.id;
  }
  const rows = getDb()
    .prepare<any, ToolboxItemRow>(
      `SELECT * FROM toolbox_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`,
    )
    .all(params);
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeToolboxItem),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    limit,
  };
}
