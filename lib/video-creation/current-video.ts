import { syncEditProjectClips } from '@/lib/asset-library';
import { getDb } from '@/lib/db';
import { patchProjectForUser } from '@/lib/projects-db';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';
import { computeEditReadiness } from './edit-readiness';
import {
  buildProtectedVideoUrl,
  buildSignedVideoPlaybackUrl,
} from './urls';

export type VideoCurrentOutcome = {
  status: number;
  body: any;
};

function ok(body: any): VideoCurrentOutcome {
  return { status: 200, body };
}

function error(detail: string, status = 400): VideoCurrentOutcome {
  return { status, body: { detail } };
}

export function clearStoryboardVideoFields(sb: any) {
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
  delete next.videoAssetId;
  return next;
}

export function setCurrentVideoForGroup(args: {
  projectId: string;
  ownerId: number;
  groupIdx: number;
  taskId: string;
}): VideoCurrentOutcome {
  if (!args.projectId) return error('缺 projectId', 400);
  if (!Number.isInteger(args.groupIdx) || args.groupIdx < 0) return error('非法 groupIdx', 400);
  if (!args.taskId) return error('缺 taskId', 400);

  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number; pid: string }, any>(
      `SELECT id, group_idx, status, duration_sec, filename, cover_image_id
       FROM video_tasks WHERE id = @id AND owner_id = @uid AND project_id = @pid`,
    )
    .get({ id: args.taskId, uid: args.ownerId, pid: args.projectId });
  if (!row) return error('历史视频不存在', 404);
  if (Number(row.group_idx) !== args.groupIdx) return error('groupIdx 与任务不匹配', 400);
  const status = String(row.status || '').toLowerCase();
  const succeeded = status === 'succeeded' || status === 'done' || status === 'completed';
  if (!succeeded || !row.filename) return error('该历史视频不可用', 400);

  const protectedUrl = buildProtectedVideoUrl(row.id);
  const signedUrl = buildSignedVideoPlaybackUrl(row.id, args.ownerId);
  const coverUrl = row.cover_image_id ? `/api/images/file/${row.cover_image_id}` : '';
  const durationSec = Number(row.duration_sec) || 0;

  let names: any = null;
  const patched = patchProjectForUser(args.projectId, args.ownerId, (fresh: any) => {
    const storyboards = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
    if (args.groupIdx >= storyboards.length || !storyboards[args.groupIdx]) return null;
    names = buildVideoSegmentNamesForRow(row, fresh);

    const sb = { ...storyboards[args.groupIdx] };
    sb.videoUrl = protectedUrl;
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
    delete sb.videoAssetId;
    storyboards[args.groupIdx] = sb;

    const videoTasks = Array.isArray(fresh?.videoTasks) ? [...fresh.videoTasks] : [];
    const prevVt = videoTasks[args.groupIdx] && typeof videoTasks[args.groupIdx] === 'object'
      ? videoTasks[args.groupIdx]
      : {};
    const vt: any = { ...prevVt };
    vt.groupIdx = args.groupIdx;
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
    videoTasks[args.groupIdx] = vt;

    const editData = fresh?.editData && typeof fresh.editData === 'object' ? { ...fresh.editData } : {};
    const edl = editData.edl && typeof editData.edl === 'object' ? { ...editData.edl } : null;
    if (edl && Array.isArray(edl.timeline)) {
      let touched = false;
      edl.timeline = edl.timeline.map((entry: any) => {
        if (entry && Number(entry.groupIdx) === args.groupIdx) {
          touched = true;
          return {
            ...entry,
            videoUrl: protectedUrl,
            protectedUrl,
            _originVideoUrl: protectedUrl,
            filename: names!.filename,
            displayName: names!.displayName,
            downloadFilename: names!.downloadFilename,
            _mediaName: names!.displayName,
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
        readiness: computeEditReadiness({ ...fresh, storyboards, videoTasks }),
      },
    };
  });

  if (!patched || !names) return error('项目不存在或片段不存在', 404);
  const edl = patched?.editData?.edl;
  try {
    syncEditProjectClips({
      ownerId: args.ownerId,
      projectId: args.projectId,
      timeline: Array.isArray(edl?.timeline) ? edl.timeline : [],
    });
  } catch (clipError) {
    console.warn('[video-creation] set-current clip sync skipped:', clipError);
  }

  return ok({
    ok: true,
    groupIdx: args.groupIdx,
    taskId: row.id,
    url: signedUrl,
    protectedUrl,
    filename: names.filename,
    displayName: names.displayName,
    downloadFilename: names.downloadFilename,
    coverUrl,
    durationSec,
    readiness: computeEditReadiness(patched),
    edl: edl || null,
    serverVersion: Number(patched.version) || undefined,
  });
}

export function deleteCurrentVideoForGroup(args: {
  projectId: string;
  ownerId: number;
  groupIdx: number;
}): VideoCurrentOutcome {
  if (!args.projectId) return error('缺 projectId', 400);
  if (!Number.isInteger(args.groupIdx) || args.groupIdx < 0) return error('非法 groupIdx', 400);

  const patched = patchProjectForUser(args.projectId, args.ownerId, (fresh: any) => {
    const storyboards = Array.isArray(fresh?.storyboards) ? [...fresh.storyboards] : [];
    if (args.groupIdx >= storyboards.length || !storyboards[args.groupIdx]) return null;
    storyboards[args.groupIdx] = clearStoryboardVideoFields(storyboards[args.groupIdx]);

    const videoTasks = Array.isArray(fresh?.videoTasks) ? [...fresh.videoTasks] : [];
    if (args.groupIdx < videoTasks.length) videoTasks[args.groupIdx] = null;

    const editData = fresh?.editData && typeof fresh.editData === 'object' ? { ...fresh.editData } : {};
    const edl = editData.edl && typeof editData.edl === 'object' ? { ...editData.edl } : null;
    if (edl && Array.isArray(edl.timeline)) {
      edl.timeline = edl.timeline.filter((entry: any) => !(entry && Number(entry.groupIdx) === args.groupIdx));
      edl.version = (Number(edl.version) || 0) + 1;
      editData.edl = edl;
    }

    return {
      storyboards,
      videoTasks,
      editData: {
        ...editData,
        readiness: computeEditReadiness({ ...fresh, storyboards, videoTasks }),
      },
    };
  });

  if (!patched) return error('项目不存在或片段不存在', 404);
  const edl = patched?.editData?.edl;
  try {
    syncEditProjectClips({
      ownerId: args.ownerId,
      projectId: args.projectId,
      timeline: Array.isArray(edl?.timeline) ? edl.timeline : [],
    });
  } catch (clipError) {
    console.warn('[video-creation] edit clip sync skipped:', clipError);
  }

  return ok({
    ok: true,
    groupIdx: args.groupIdx,
    readiness: computeEditReadiness(patched),
    edl: edl || null,
    serverVersion: Number(patched.version) || undefined,
  });
}
