import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedUploadUrl, buildSignedVideoUrl } from '@/lib/signed-asset-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 列出剪辑工作台素材库。
 * scope 取值：
 *   - 'project' + ?projectId=xxx → 仅该项目下生成视频 + 上传素材
 *   - 'user'   → 当前用户全部素材
 */
export async function GET(req: NextRequest, { params }: { params: { scope: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  const scope = params.scope;

  const db = getDb();
  const items: any[] = [];

  // 视频任务（生成的片段）
  let videoRows: any[] = [];
  if (scope === 'project' && projectId) {
    videoRows = db
      .prepare<{ uid: number; pid: string }, any>(
        `SELECT id, group_idx, prompt, duration_sec, cover_image_id, created_at FROM video_tasks
         WHERE owner_id = @uid AND project_id = @pid AND status = 'completed' ORDER BY group_idx ASC`,
      )
      .all({ uid: user.id, pid: projectId });
  } else {
    videoRows = db
      .prepare<{ uid: number }, any>(
        `SELECT id, group_idx, prompt, duration_sec, cover_image_id, created_at FROM video_tasks
         WHERE owner_id = @uid AND status = 'completed' ORDER BY created_at DESC`,
      )
      .all({ uid: user.id });
  }
  for (const v of videoRows) {
    const protectedUrl = `/api/videos/file/${v.id}`;
    items.push({
      mediaId: v.id,
      kind: 'video',
      source: 'generated',
      title: `片段 ${v.group_idx ?? ''}`,
      url: buildSignedVideoUrl(v.id, user.id).url,
      protectedUrl,
      coverUrl: v.cover_image_id ? `/api/images/file/${v.cover_image_id}` : null,
      durationSec: v.duration_sec,
      createdAt: v.created_at,
    });
  }

  // 用户上传素材
  let uploadRows: any[] = [];
  if (scope === 'project' && projectId) {
    uploadRows = db
      .prepare<{ uid: number; pid: string }, any>(
        `SELECT id, kind, filename, mime, size_bytes, duration_sec, created_at FROM uploads
         WHERE owner_id = @uid AND project_id = @pid ORDER BY created_at DESC`,
      )
      .all({ uid: user.id, pid: projectId });
  } else {
    uploadRows = db
      .prepare<{ uid: number }, any>(
        `SELECT id, kind, filename, mime, size_bytes, duration_sec, created_at FROM uploads
         WHERE owner_id = @uid ORDER BY created_at DESC`,
      )
      .all({ uid: user.id });
  }
  for (const u of uploadRows) {
    items.push({
      mediaId: u.id,
      kind: u.kind,
      source: 'uploaded',
      title: u.filename,
      // 签名直链：上传素材在 <video>/<img> 里带不了 Bearer，未签名会 401（拖入主时间线静默不出画）。
      url: buildSignedUploadUrl(u.id, user.id).url,
      protectedUrl: `/api/edit/media/${u.id}`,
      mime: u.mime,
      sizeBytes: u.size_bytes,
      durationSec: u.duration_sec,
      createdAt: u.created_at,
    });
  }

  return jsonOk({ items, total: items.length, scope });
}
