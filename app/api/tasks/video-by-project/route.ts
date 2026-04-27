import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return jsonError('缺 projectId', 400);

  const db = getDb();
  const rows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, group_idx, status, progress, filename, duration_sec, cover_image_id, created_at, updated_at
       FROM video_tasks
       WHERE owner_id = @uid AND project_id = @pid
       ORDER BY group_idx ASC, created_at DESC`,
    )
    .all({ uid: user.id, pid: projectId });

  const items = rows.map((r: any) => ({
    taskId: r.id,
    groupIdx: r.group_idx,
    status: r.status,
    progress: r.progress,
    durationSec: r.duration_sec,
    url: r.filename ? `/api/videos/file/${r.id}` : null,
    coverUrl: r.cover_image_id ? `/api/images/file/${r.cover_image_id}` : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return jsonOk({ items, total: items.length });
}
