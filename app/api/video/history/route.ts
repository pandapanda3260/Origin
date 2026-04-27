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
  const scope = url.searchParams.get('scope') || 'user';
  const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));

  const db = getDb();
  const rows = db
    .prepare<{ uid: number; lim: number }, any>(
      `SELECT id, project_id, group_idx, prompt, status, progress, filename, duration_sec, cover_image_id, created_at, updated_at
       FROM video_tasks
       WHERE owner_id = @uid AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT @lim`,
    )
    .all({ uid: user.id, lim: limit });

  const items = rows.map((r: any) => ({
    taskId: r.id,
    projectId: r.project_id,
    groupIdx: r.group_idx,
    prompt: r.prompt,
    status: r.status,
    durationSec: r.duration_sec,
    url: `/api/videos/file/${r.id}`,
    coverUrl: r.cover_image_id ? `/api/images/file/${r.cover_image_id}` : null,
    createdAt: r.created_at,
  }));

  return jsonOk({ items, total: items.length, scope });
}
