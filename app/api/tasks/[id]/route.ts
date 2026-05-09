import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const id = params.id;

  const db = getDb();
  const v = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM video_tasks WHERE id = @id AND owner_id = @uid')
    .get({ id, uid: user.id });
  if (v) {
    const protectedUrl = v.filename ? `/api/videos/file/${v.id}` : null;
    return jsonOk({
      taskId: v.id,
      type: 'video_segment',
      status: v.status,
      progress: v.progress,
      url: v.filename ? buildSignedVideoUrl(v.id, user.id).url : null,
      protectedUrl,
      coverUrl: v.cover_image_id ? `/api/images/file/${v.cover_image_id}` : null,
      durationSec: v.duration_sec,
      errorMsg: v.error_msg,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    });
  }
  return jsonError('任务不存在', 404);
}

export async function DELETE() {
  return jsonOk({ ok: true });
}
