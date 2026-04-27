import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 任务中心：列出当前用户所有"活跃"任务。
 * 包括：
 *   - 未完成的视频生成任务（video_tasks 表）
 *   - 未完成的批量任务（batches 表，状态 running 或 queued）
 *   - 未完成的导出任务（exports 表）
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const db = getDb();
  const items: any[] = [];

  const videos = db
    .prepare<{ uid: number }, any>(
      `SELECT id, project_id, group_idx, status, progress, created_at FROM video_tasks
       WHERE owner_id = @uid AND status IN ('queued','running')`,
    )
    .all({ uid: user.id });
  for (const v of videos) {
    items.push({
      taskId: v.id, type: 'video_segment', status: v.status, progress: v.progress,
      title: `视频片段 ${v.group_idx ?? ''}`, projectId: v.project_id, createdAt: v.created_at,
    });
  }

  const batches = db
    .prepare<{ uid: number }, any>(
      `SELECT id, batch_type, status, total, succeeded, failed, project_id, created_at FROM batches
       WHERE owner_id = @uid AND status IN ('queued','running')`,
    )
    .all({ uid: user.id });
  for (const b of batches) {
    const pct = b.total > 0 ? Math.round((b.succeeded * 100) / b.total) : 0;
    items.push({
      taskId: b.id, type: b.batch_type, status: b.status, progress: pct,
      title: `批量：${batchTitle(b.batch_type)} ${b.succeeded}/${b.total}`,
      projectId: b.project_id, createdAt: b.created_at,
    });
  }

  const exps = db
    .prepare<{ uid: number }, any>(
      `SELECT id, project_id, status, progress, created_at FROM exports
       WHERE owner_id = @uid AND status IN ('queued','running')`,
    )
    .all({ uid: user.id });
  for (const e of exps) {
    items.push({
      taskId: e.id, type: 'video_export', status: e.status, progress: e.progress,
      title: '导出成片', projectId: e.project_id, createdAt: e.created_at,
    });
  }

  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return jsonOk({ items, total: items.length });
}

function batchTitle(type: string) {
  if (type === 'asset_images') return '资产参考图';
  if (type === 'storyboard_prompts') return '提示词转换';
  if (type === 'storyboard_images') return '分镜图';
  if (type === 'video_segments') return '视频片段';
  return type;
}
