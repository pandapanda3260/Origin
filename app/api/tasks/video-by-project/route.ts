import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedVideoUrl } from '@/lib/signed-asset-url';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { syncEditProjectClips } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stringContainsTaskId(value: any, taskId: string): boolean {
  return typeof value === 'string' && taskId.length > 0 && value.includes(taskId);
}

function rowBelongsToCurrentSlot(project: any, row: any): boolean {
  const taskId = String(row?.id || '');
  const gi = Number(row?.group_idx);
  if (!taskId || !Number.isInteger(gi) || gi < 0) return false;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const sb = storyboards[gi];
  if (!sb) return false;
  try {
    storyboardShotIndices(project, gi, sb, { mode: 'single-shot-strict' });
  } catch {
    return false;
  }

  const vt = videoTasks[gi];
  const linkedIds = [
    sb?.videoTaskId,
    vt?.taskId,
    vt?.serverTaskId,
    vt?.id,
  ].map((v) => String(v || '').trim()).filter(Boolean);
  if (linkedIds.includes(taskId)) return true;

  return [
    sb?.videoUrl,
    sb?._originVideoUrl,
    vt?.url,
    vt?.videoUrl,
    vt?.protectedUrl,
    vt?._originVideoUrl,
  ].some((value) => stringContainsTaskId(value, taskId));
}

function computeReadiness(project: any) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  let readyCount = 0;
  for (let i = 0; i < storyboards.length; i += 1) {
    const sb = storyboards[i];
    const vt = videoTasks[i];
    if (sb && typeof sb.videoUrl === 'string' && sb.videoUrl.trim() && sb.videoIsCurrent !== false && vt?.isCurrent !== false) {
      readyCount += 1;
    }
  }
  return {
    totalCount: storyboards.length,
    readyCount,
    canEnterEdit: readyCount >= 1,
  };
}

function clearStoryboardVideoFields(sb: any) {
  if (!sb || typeof sb !== 'object') return sb;
  const next = { ...sb, importedToEdit: false };
  delete next.videoUrl;
  delete next._originVideoUrl;
  delete next.videoTaskId;
  delete next.videoCoverUrl;
  delete next.videoStatus;
  delete next.videoMode;
  delete next.videoTaskFinishedAt;
  delete next.videoDurationSec;
  delete next.readyForEdit;
  delete next.videoWarnings;
  delete next.videoIsCurrent;
  // ⚠️ 关键：videoAssetId 也要清掉。前端 hydrateProjectAssetUrls 会用
  // videoAssetId 重签出新的 videoUrl 塞回 storyboard，于是「删除 → 全部生成 →
  // 该片段立刻显示已完成」的鬼影 bug 就出现了。
  delete next.videoAssetId;
  return next;
}

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

  const project = getProjectByIdForUser(projectId, user.id) as any;
  if (!project) return jsonError('项目不存在', 404);

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
    if (!rowBelongsToCurrentSlot(project, r)) continue;
    seen.add(gi);
    const protectedUrl = r.filename ? `/api/videos/file/${r.id}` : '';
    const resultUrl = r.filename ? buildSignedVideoUrl(r.id, user.id).url : '';
    tasks.push({
      task_id: r.id,
      task_type: 'video',
      target_type: 'storyboard',
      target_idx: gi,
      status: r.status,
      progress: r.progress,
      duration_sec: r.duration_sec,
      result_url: resultUrl,
      protected_url: protectedUrl,
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
    protectedUrl: t.protected_url || null,
    coverUrl: t.cover_url || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  return jsonOk({ tasks, items, total: tasks.length });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || url.searchParams.get('projectId') || '').trim();
  const groupIdx = Number(body?.groupIdx ?? url.searchParams.get('groupIdx'));
  if (!projectId) return jsonError('缺 projectId', 400);
  if (!Number.isInteger(groupIdx) || groupIdx < 0) return jsonError('非法 groupIdx', 400);

  const patched = patchProjectForUser(projectId, user.id, (fresh: any) => {
    const storyboards = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
    if (groupIdx >= storyboards.length || !storyboards[groupIdx]) return null;

    storyboards[groupIdx] = clearStoryboardVideoFields(storyboards[groupIdx]);

    const videoTasks = Array.isArray(fresh?.videoTasks) ? [...fresh.videoTasks] : [];
    if (groupIdx < videoTasks.length) videoTasks[groupIdx] = null;

    const editData = fresh?.editData && typeof fresh.editData === 'object'
      ? { ...fresh.editData }
      : {};
    const edl = editData.edl && typeof editData.edl === 'object'
      ? { ...editData.edl }
      : null;
    if (edl && Array.isArray(edl.timeline)) {
      edl.timeline = edl.timeline.filter((entry: any) => !(entry && Number(entry.groupIdx) === groupIdx));
      edl.version = (Number(edl.version) || 0) + 1;
      editData.edl = edl;
    }

    return {
      storyboards,
      videoTasks,
      editData: {
        ...editData,
        readiness: computeReadiness({ ...fresh, storyboards, videoTasks }),
      },
    };
  });

  if (!patched) return jsonError('项目不存在或片段不存在', 404);

  const edl = patched?.editData?.edl;
  try {
    syncEditProjectClips({
      ownerId: user.id,
      projectId,
      timeline: Array.isArray(edl?.timeline) ? edl.timeline : [],
    });
  } catch (clipError) {
    console.warn('[video-by-project] edit clip sync skipped:', clipError);
  }

  return jsonOk({
    ok: true,
    groupIdx,
    readiness: computeReadiness(patched),
    edl: edl || null,
    serverVersion: Number(patched.version) || undefined,
  });
}
