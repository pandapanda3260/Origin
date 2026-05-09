import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: params.id, uid: user.id });
  if (!row) return jsonError('导出任务不存在', 404);

  const status = String(row.status || '');
  const url = status === 'completed' ? `/api/edit/export-file/${row.id}` : null;
  const errorMsg = row.error_msg || '';

  return jsonOk({
    taskId: row.id,
    status,
    progress: row.progress,
    url,
    errorMsg,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    done: status === 'completed' || status === 'failed',
    downloadUrl: url,
    error: status === 'failed' ? errorMsg || '导出失败' : '',
    restarted: status === 'failed' && errorMsg === 'orphaned by server restart',
  });
}
