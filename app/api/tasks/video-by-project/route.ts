import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { buildSignedImageUrl, buildSignedVideoUrl } from '@/lib/signed-asset-url';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { syncEditProjectClips } from '@/lib/asset-library';
import { getVevDemoMaterialBinding } from '@/lib/vevdemo-material-bindings';
import { getVevDemoProjectBinding } from '@/lib/vevdemo-project-bindings';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

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

function isCompletedVideoTask(row: any): boolean {
  const status = String(row?.status || '').toLowerCase();
  return (status === 'succeeded' || status === 'done' || status === 'completed') && Boolean(row?.filename);
}

function collectCurrentEdlVideoTaskIds(project: any): Set<string> {
  const edl = project?.editData?.edl;
  const timeline = Array.isArray(edl?.timeline) ? edl.timeline : [];
  const ids = new Set<string>();
  for (const entry of timeline) {
    [
      entry?.clipId,
      entry?.id,
      entry?.videoTaskId,
      entry?.mediaId,
      entry?.resourceId,
    ].forEach((value) => {
      const text = String(value || '').trim();
      if (text) ids.add(text);
    });
  }
  return ids;
}

function rowBelongsToCurrentEdl(project: any, row: any, currentEdlIds = collectCurrentEdlVideoTaskIds(project)): boolean {
  const taskId = String(row?.id || '').trim();
  if (!taskId) return false;
  if (currentEdlIds.has(taskId)) return true;
  const edl = project?.editData?.edl;
  const timeline = Array.isArray(edl?.timeline) ? edl.timeline : [];
  return timeline.some((entry: any) => (
    stringContainsTaskId(entry?.videoUrl, taskId) ||
    stringContainsTaskId(entry?._originVideoUrl, taskId) ||
    stringContainsTaskId(entry?.protectedUrl, taskId)
  ));
}

function getTargetVevProjectId(originProjectId: string): string | undefined {
  const binding = getVevDemoProjectBinding(originProjectId);
  return binding?.vevProjectId || undefined;
}

function buildSignedCoverDisplayUrl(req: NextRequest, imageId: unknown, ownerId: number) {
  const id = String(imageId || '').trim();
  if (!id) return '';
  try {
    const url = new URL(buildSignedImageUrl(id, ownerId).url, req.url);
    url.searchParams.set('w', '384');
    return url.toString();
  } catch {
    return buildSignedImageUrl(id, ownerId).url;
  }
}

function toProjectVideoLibraryItem(req: NextRequest, row: any, userId: number, project: any, currentEdlIds: Set<string>) {
  const taskId = String(row.id);
  const groupIdx = Number(row.group_idx);
  const signed = buildSignedVideoUrl(taskId, userId);
  const protectedUrl = `/api/videos/file/${encodeURIComponent(taskId)}`;
  const coverUrl = buildSignedCoverDisplayUrl(req, row.cover_image_id, userId);
  const vevProjectId = getTargetVevProjectId(String(row.project_id || project?.id || ''));
  const binding = getVevDemoMaterialBinding('video_task', taskId, vevProjectId);
  const absoluteSignedUrl = new URL(signed.url, req.url).toString();
  const names = buildVideoSegmentNamesForRow(row, project);

  return {
    id: taskId,
    task_id: taskId,
    taskId,
    resourceType: 'video_task',
    title: names.displayName,
    name: names.displayName,
    displayName: names.displayName,
    filename: names.filename,
    downloadFilename: names.downloadFilename,
    groupIdx,
    group_idx: groupIdx,
    target_idx: groupIdx,
    status: row.status,
    durationSec: row.duration_sec,
    duration_sec: row.duration_sec,
    url: absoluteSignedUrl,
    result_url: absoluteSignedUrl,
    protectedUrl,
    protected_url: protectedUrl,
    coverUrl,
    cover_url: coverUrl,
    prompt: row.prompt || '',
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
    rowBelongsToCurrentEdl: rowBelongsToCurrentEdl(project, row, currentEdlIds),
    is_current: rowBelongsToCurrentSlot(project, row),
    vevBinding: binding ? {
      vevSource: binding.vevSource,
      vevProjectId: binding.vevProjectId,
      vevGroupId: binding.vevGroupId,
      vevSpace: binding.vevSpace,
      vevEditMid: binding.vevEditMid,
      title: binding.title || '',
      vid: binding.vid || '',
      registeredAt: binding.registeredAt || '',
    } : null,
  };
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
  delete next.videoFilename;
  delete next.videoDisplayName;
  delete next.videoDownloadFilename;
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
  const scope = String(url.searchParams.get('scope') || '').trim();

  if (scope === 'all-completed') {
    const rows = db
      .prepare<{ uid: number; pid: string }, any>(
        `SELECT id, project_id, group_idx, status, progress, filename, duration_sec, cover_image_id,
                error_msg, prompt, created_at, updated_at
         FROM video_tasks
         WHERE owner_id = @uid AND project_id = @pid
         ORDER BY group_idx ASC, created_at DESC`,
      )
      .all({ uid: user.id, pid: projectId });

    const currentEdlIds = collectCurrentEdlVideoTaskIds(project);
    const videos = rows
      .filter(isCompletedVideoTask)
      .map((row: any) => toProjectVideoLibraryItem(req, row, user.id, project, currentEdlIds));

    return jsonOk({
      scope,
      projectId,
      videos,
      items: videos,
      tasks: videos,
      total: videos.length,
    });
  }

  // ── 历史模式：?groupIdx=N → 返回该片段「全部」成功生成历史（历史视频弹窗用）。
  //    「仅匹配当前镜头」：当前 slot 仍是合法单镜头才返回历史，否则返回空（前端显示「空」）。
  //    默认（不带 groupIdx）行为保持不变，给刷新补绑 _reattachVideoTasks 用。──
  const historyGroupRaw = url.searchParams.get('groupIdx');
  if (historyGroupRaw != null && historyGroupRaw !== '') {
    const gi = Number(historyGroupRaw);
    if (!Number.isInteger(gi) || gi < 0) return jsonError('非法 groupIdx', 400);

    const storyboardsH = Array.isArray(project?.storyboards) ? project.storyboards : [];
    const sbH = storyboardsH[gi];
    let slotValid = false;
    if (sbH) {
      try {
        storyboardShotIndices(project, gi, sbH, { mode: 'single-shot-strict' });
        slotValid = true;
      } catch {
        slotValid = false;
      }
    }
    if (!slotValid) return jsonOk({ history: [], total: 0 });

    const histRows = db
      .prepare<{ uid: number; pid: string; gi: number }, any>(
        `SELECT id, group_idx, status, duration_sec, filename, cover_image_id, prompt, created_at
         FROM video_tasks
         WHERE owner_id = @uid AND project_id = @pid AND group_idx = @gi
         ORDER BY created_at DESC`,
      )
      .all({ uid: user.id, pid: projectId, gi });

    const videoTasksH = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
    const vtH = videoTasksH[gi];
    const currentIds = [sbH?.videoTaskId, vtH?.taskId, vtH?.serverTaskId, vtH?.id]
      .map((v: any) => String(v || '').trim())
      .filter(Boolean);
    const currentUrls = [sbH?.videoUrl, sbH?._originVideoUrl, vtH?.url, vtH?.protectedUrl].map(
      (v: any) => String(v || ''),
    );

    const history = histRows
      .filter(
        (r: any) =>
          (r.status === 'succeeded' || r.status === 'done' || r.status === 'completed') && r.filename,
      )
	      .map((r: any) => {
	        const taskId = String(r.id);
	        const names = buildVideoSegmentNamesForRow(r, project);
	        const isCurrent =
          currentIds.includes(taskId) ||
          currentUrls.some((u: string) => stringContainsTaskId(u, taskId));
        return {
	          task_id: r.id,
	          target_idx: gi,
	          title: names.displayName,
	          name: names.displayName,
	          displayName: names.displayName,
	          filename: names.filename,
	          downloadFilename: names.downloadFilename,
	          status: r.status,
          duration_sec: r.duration_sec,
          url: buildSignedVideoUrl(r.id, user.id).url,
          protected_url: `/api/videos/file/${r.id}`,
          cover_url: buildSignedCoverDisplayUrl(req, r.cover_image_id, user.id),
          prompt: r.prompt || '',
          created_at: r.created_at,
          is_current: isCurrent,
        };
      });

    return jsonOk({ history, total: history.length });
  }

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
	    const names = buildVideoSegmentNamesForRow(r, project);
	    tasks.push({
	      task_id: r.id,
      task_type: 'video',
      target_type: 'storyboard',
	      target_idx: gi,
	      title: names.displayName,
	      name: names.displayName,
	      displayName: names.displayName,
	      filename: names.filename,
	      downloadFilename: names.downloadFilename,
	      status: r.status,
      progress: r.progress,
      duration_sec: r.duration_sec,
      result_url: resultUrl,
      protected_url: protectedUrl,
      cover_url: buildSignedCoverDisplayUrl(req, r.cover_image_id, user.id),
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
	    title: t.title,
	    name: t.name,
	    displayName: t.displayName,
	    filename: t.filename,
	    downloadFilename: t.downloadFilename,
	    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  return jsonOk({ tasks, items, total: tasks.length });
}

/**
 * 把某条历史视频「设为当前」——历史视频弹窗的「替换」按钮走这里。
 * 写回 storyboards[gi] + videoTasks[gi] 指向选中的历史任务，并同步剪辑时间线里
 * 该片段的 videoUrl。被替换掉的旧视频仍然留在 video_tasks 表里，下次打开弹窗
 * 仍会出现在历史列表中。采用专用动作（而非整包 PUT）避免旧版本覆盖，与 DELETE 一致。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || '').trim();
  if (action !== 'set-current') return jsonError('不支持的 action', 400);

  const projectId = String(body?.projectId || '').trim();
  const groupIdx = Number(body?.groupIdx);
  const taskId = String(body?.taskId || '').trim();
	  if (!projectId) return jsonError('缺 projectId', 400);
	  if (!Number.isInteger(groupIdx) || groupIdx < 0) return jsonError('非法 groupIdx', 400);
	  if (!taskId) return jsonError('缺 taskId', 400);
	  const project = getProjectByIdForUser(projectId, user.id) as any;
	  if (!project) return jsonError('项目不存在', 404);

	  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number; pid: string }, any>(
      `SELECT id, group_idx, status, duration_sec, filename, cover_image_id
       FROM video_tasks WHERE id = @id AND owner_id = @uid AND project_id = @pid`,
    )
    .get({ id: taskId, uid: user.id, pid: projectId });
  if (!row) return jsonError('历史视频不存在', 404);
  if (Number(row.group_idx) !== groupIdx) return jsonError('groupIdx 与任务不匹配', 400);
  const succeeded = row.status === 'succeeded' || row.status === 'done' || row.status === 'completed';
  if (!succeeded || !row.filename) return jsonError('该历史视频不可用', 400);

  const protectedUrl = `/api/videos/file/${row.id}`;
  const signedUrl = buildSignedVideoUrl(row.id, user.id).url;
	  const coverUrl = row.cover_image_id ? `/api/images/file/${row.cover_image_id}` : '';
	  const durationSec = Number(row.duration_sec) || 0;
	  const names = buildVideoSegmentNamesForRow(row, project);

  const patched = patchProjectForUser(projectId, user.id, (fresh: any) => {
    const storyboards = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
    if (groupIdx >= storyboards.length || !storyboards[groupIdx]) return null;

    const sb = { ...storyboards[groupIdx] };
	    sb.videoUrl = signedUrl;
	    sb._originVideoUrl = protectedUrl;
	    sb.videoTaskId = row.id;
	    sb.videoFilename = names.filename;
	    sb.videoDisplayName = names.displayName;
	    sb.videoDownloadFilename = names.downloadFilename;
    if (coverUrl) sb.videoCoverUrl = coverUrl;
    if (durationSec > 0) sb.videoDurationSec = durationSec;
    sb.videoStatus = 'done';
    sb.videoIsCurrent = true;
    delete sb.videoInvalidatedAt;
    delete sb.videoInvalidatedReason;
    delete sb.readyForEdit;
    // videoAssetId 可能指向旧资源；清掉以免 hydrateProjectAssetUrls 用旧的重签覆盖。
    delete sb.videoAssetId;
    storyboards[groupIdx] = sb;

    const videoTasks = Array.isArray(fresh?.videoTasks) ? [...fresh.videoTasks] : [];
    const prevVt =
      videoTasks[groupIdx] && typeof videoTasks[groupIdx] === 'object' ? videoTasks[groupIdx] : {};
    const vt: any = { ...prevVt };
    vt.groupIdx = groupIdx;
    vt.taskId = row.id;
	    vt.url = protectedUrl;
	    vt.protectedUrl = protectedUrl;
	    vt.filename = names.filename;
	    vt.displayName = names.displayName;
	    vt.downloadFilename = names.downloadFilename;
    if (durationSec > 0) vt.durationSec = durationSec;
    vt.status = 'completed';
    vt.isCurrent = true;
    delete vt.outdated;
    delete vt.invalidatedAt;
    delete vt.invalidatedReason;
    videoTasks[groupIdx] = vt;

    // 同步剪辑时间线：该片段若已在 timeline，把它的 videoUrl 换成新视频。
    const editData =
      fresh?.editData && typeof fresh.editData === 'object' ? { ...fresh.editData } : {};
    const edl = editData.edl && typeof editData.edl === 'object' ? { ...editData.edl } : null;
    if (edl && Array.isArray(edl.timeline)) {
      let touched = false;
      edl.timeline = edl.timeline.map((entry: any) => {
        if (entry && Number(entry.groupIdx) === groupIdx) {
          touched = true;
	          return {
	            ...entry,
	            videoUrl: signedUrl,
	            protectedUrl,
	            _originVideoUrl: protectedUrl,
	            filename: names.filename,
	            displayName: names.displayName,
	            downloadFilename: names.downloadFilename,
	            _mediaName: names.displayName,
	          };
        }
        return entry;
      });
      if (touched) edl.version = (Number(edl.version) || 0) + 1;
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
    console.warn('[video-by-project] set-current clip sync skipped:', clipError);
  }

  return jsonOk({
    ok: true,
    groupIdx,
    taskId: row.id,
    url: signedUrl,
	    protectedUrl,
	    filename: names.filename,
	    displayName: names.displayName,
	    downloadFilename: names.downloadFilename,
	    coverUrl,
    durationSec,
    readiness: computeReadiness(patched),
    edl: edl || null,
    serverVersion: Number(patched.version) || undefined,
  });
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
