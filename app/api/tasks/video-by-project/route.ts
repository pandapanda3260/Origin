import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 返回当前项目下的视频任务历史，给前端 _reattachVideoTasks 用作刷新后
 * 的"已完成历史"补绑数据。
 *
 * 字段命名采用前端约定的蛇形（task_id / target_idx / result_url / error_msg ...），
 * 容器键名是 `tasks`。两边只要错一个字段，刷新后历史任务卡片就一张都建不出来，
 * 进而连"导入"按钮都不渲染。所以这里**严格**按前端读法对齐，不再用驼峰。
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return jsonError('缺 projectId', 400);

  const db = getDb();
  const rows = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, group_idx, status, progress, filename, duration_sec, cover_image_id,
              error_msg, prompt, created_at, updated_at
       FROM video_tasks
       WHERE owner_id = @uid AND project_id = @pid
       ORDER BY group_idx ASC, created_at DESC`,
    )
    .all({ uid: user.id, pid: projectId });

  // 同一个 group_idx 可能有多条历史（旧版重试留的），保留每个 group 最新一条
  const seen = new Set<number>();
  const tasks: any[] = [];
  for (const r of rows) {
    const gi = Number(r.group_idx);
    if (seen.has(gi)) continue;
    seen.add(gi);
    const resultUrl = r.filename ? `/api/videos/file/${r.id}` : '';
    tasks.push({
      task_id: r.id,
      task_type: 'video',
      target_type: 'storyboard',
      target_idx: gi,
      status: r.status,
      progress: r.progress,
      duration_sec: r.duration_sec,
      result_url: resultUrl,
      cover_url: r.cover_image_id ? `/api/images/file/${r.cover_image_id}` : '',
      error_msg: r.error_msg || '',
      prompt: r.prompt || '',
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }

  // 兼容老调用：同时回 items（旧字段格式）。前端最终会把 tasks 用起来。
  const items = tasks.map((t) => ({
    taskId: t.task_id,
    groupIdx: t.target_idx,
    status: t.status,
    progress: t.progress,
    durationSec: t.duration_sec,
    url: t.result_url || null,
    coverUrl: t.cover_url || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  return jsonOk({ tasks, items, total: tasks.length });
}
