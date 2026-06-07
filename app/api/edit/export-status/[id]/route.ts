import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseExportMeta(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: params.id, uid: user.id });
  if (!row) return jsonError('导出任务不存在', 404);

  const status = String(row.status || '');
  const filenameRaw = String(row.filename || '');
  const hasLocalFile = Boolean(filenameRaw) && !/^https?:\/\//i.test(filenameRaw);
  const url = status === 'completed' && hasLocalFile ? `/api/edit/export-file/${row.id}` : null;
  const errorMsg = row.error_msg || '';
  const meta = parseExportMeta(row.edl_json);
  const exportedEdlSignature = String(meta.exportedEdlSignature || meta.edlSignature || '');
  const exportedEdlSignatureMeta = meta.exportedEdlSignatureMeta || null;
  const localDownloadStatus = row.local_download_status || meta.vevDemo?.localDownloadStatus || null;
  const needsReviewReason = meta.vevDemo?.needsReviewReason || null;

  return jsonOk({
    taskId: row.id,
    status,
    progress: row.progress,
    url,
    remoteUrl: meta.vevDemo?.remoteUrl || meta.vevDemo?.outputUrl || null,
    remoteProvider: meta.vevDemo?.remoteProvider || meta.vevDemo?.provider || null,
    remoteUrlExpiresAt: meta.vevDemo?.remoteUrlExpiresAt || null,
    localDownloadStatus,
    needsReviewReason,
    reexportRequired: Boolean(meta.vevDemo?.reexportRequired || needsReviewReason === 'url_expired_need_reexport'),
    errorMsg,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edlVersion: row.edl_version,
    edlSignature: exportedEdlSignature,
    exportedEdlSignature,
    exportedEdlSignatureMeta,
    done: status === 'completed' || status === 'failed',
    downloadUrl: url,
    error: status === 'failed' ? errorMsg || '导出失败' : '',
    restarted: status === 'failed' && errorMsg === 'orphaned by server restart',
  });
}
