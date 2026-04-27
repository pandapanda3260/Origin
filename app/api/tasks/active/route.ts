import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, any>(
      `SELECT id, project_id, group_idx, prompt, status, progress, created_at
       FROM video_tasks
       WHERE owner_id = @uid AND status IN ('queued','running')
       ORDER BY created_at DESC`,
    )
    .all({ uid: user.id });

  return jsonOk({ items: rows.map((r: any) => publicShape(r)), total: rows.length });
}

function publicShape(r: any) {
  return {
    taskId: r.id,
    projectId: r.project_id,
    groupIdx: r.group_idx,
    title: '视频片段 ' + (r.group_idx ?? '?'),
    type: 'video_segment',
    status: r.status,
    progress: r.progress,
    createdAt: r.created_at,
  };
}
