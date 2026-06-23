import { getDb } from '@/lib/db';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';
import { computeEditReadiness } from './edit-readiness';
import { projectVideoPromptReadiness } from './prompt-readiness';
import {
  buildProtectedVideoUrl,
  buildSignedVideoPlaybackUrl,
  resolveVideoTaskIdFromSources,
} from './urls';

function stringContainsTaskId(value: any, taskId: string): boolean {
  return typeof value === 'string' && taskId.length > 0 && value.includes(taskId);
}

function rowBelongsToCurrentSlot(project: any, row: any): boolean {
  const taskId = String(row?.id || '');
  const groupIdx = Number(row?.group_idx);
  if (!taskId || !Number.isInteger(groupIdx) || groupIdx < 0) return false;
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const sb = storyboards[groupIdx];
  if (!sb) return false;
  try {
    storyboardShotIndices(project, groupIdx, sb, { mode: 'single-shot-strict' });
  } catch {
    return false;
  }

  const vt = videoTasks[groupIdx];
  const linkedIds = [
    sb?.videoTaskId,
    vt?.taskId,
    vt?.serverTaskId,
    vt?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean);
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

function latestVideoTaskRowsByGroup(project: any, projectId: string, ownerId: number) {
  const rows = getDb()
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, group_idx, status, progress, filename, duration_sec, cover_image_id,
              error_msg, prompt, created_at, updated_at
       FROM video_tasks
       WHERE owner_id = @uid AND project_id = @pid
       ORDER BY group_idx ASC, created_at DESC`,
    )
    .all({ uid: ownerId, pid: projectId });
  const seen = new Set<number>();
  const byGroup = new Map<number, any>();
  for (const row of rows) {
    const groupIdx = Number(row?.group_idx);
    if (!Number.isInteger(groupIdx) || groupIdx < 0 || seen.has(groupIdx)) continue;
    if (!rowBelongsToCurrentSlot(project, row)) continue;
    seen.add(groupIdx);
    byGroup.set(groupIdx, row);
  }
  return byGroup;
}

function rowVideoStatus(row: any) {
  const status = String(row?.status || '').toLowerCase();
  if (status === 'failed' || status === 'timeout' || status === 'error') return 'failed';
  if (status === 'queued' || status === 'running') return 'generating';
  if ((status === 'succeeded' || status === 'done' || status === 'completed') && row?.filename) return 'ready';
  return '';
}

function currentVideoStatus(sb: any, vt: any, taskId: string, taskRow: any) {
  const rawStatus = String(sb?.videoStatus || vt?.status || '').toLowerCase();
  const latestRowStatus = rowVideoStatus(taskRow);
  if (latestRowStatus === 'failed') return 'failed';
  if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'timeout') return 'failed';
  if (latestRowStatus === 'generating') return 'generating';
  if (rawStatus === 'generating' || rawStatus === 'running' || rawStatus === 'queued') return 'generating';
  if (sb?.videoIsCurrent === false || vt?.isCurrent === false || vt?.outdated) return 'outdated';
  if (latestRowStatus === 'ready' || taskId || sb?.videoUrl || vt?.url || vt?.protectedUrl) return 'ready';
  return 'missing';
}

export function getVideoCreationState(args: {
  projectId: string;
  ownerId: number;
}) {
  const project = getProjectByIdForUser(args.projectId, args.ownerId) as any;
  if (!project) return null;
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  const promptReadiness = projectVideoPromptReadiness(project);
  const latestTaskRows = latestVideoTaskRowsByGroup(project, args.projectId, args.ownerId);
  const segments = storyboards.map((sb: any, groupIdx: number) => {
    const vt = videoTasks[groupIdx] || {};
    const latestTaskRow = latestTaskRows.get(groupIdx) || null;
    const latestTaskRowHasVideo = !!(latestTaskRow?.id && latestTaskRow?.filename);
    const taskId = resolveVideoTaskIdFromSources(
      latestTaskRow?.id,
      sb?.videoTaskId,
      vt?.taskId,
      vt?.serverTaskId,
      vt?.id,
      sb?._originVideoUrl,
      sb?.videoUrl,
      vt?.protectedUrl,
      vt?.url,
      vt?.videoUrl,
    );
    const protectedUrl = latestTaskRowHasVideo
      ? buildProtectedVideoUrl(String(latestTaskRow.id))
      : (taskId && !latestTaskRow ? buildProtectedVideoUrl(taskId) : String(sb?._originVideoUrl || vt?.protectedUrl || '').trim());
    const playbackUrl = latestTaskRowHasVideo
      ? buildSignedVideoPlaybackUrl(String(latestTaskRow.id), args.ownerId)
      : (taskId && !latestTaskRow ? buildSignedVideoPlaybackUrl(taskId, args.ownerId) : '');
    const status = currentVideoStatus(sb, vt, taskId, latestTaskRow);
    const latestNames = latestTaskRow ? buildVideoSegmentNamesForRow(latestTaskRow, project) : null;
    const errorMsg = String(vt?.errorMsg || vt?.error_msg || sb?.videoLastError || sb?.videoError || latestTaskRow?.error_msg || '').trim();
    return {
      groupIdx,
      prompt: promptReadiness[groupIdx] || null,
      video: {
        status,
        taskId,
        protectedUrl,
        playbackUrl,
        videoUrl: protectedUrl,
        imported: !!sb?.importedToEdit,
        isCurrent: status === 'ready',
        canImport: status === 'ready' && !!protectedUrl,
        durationSec: Number(sb?.videoDurationSec || vt?.durationSec || latestTaskRow?.duration_sec || 0) || 0,
        filename: String(sb?.videoFilename || vt?.filename || latestNames?.filename || '').trim(),
        displayName: String(sb?.videoDisplayName || vt?.displayName || latestNames?.displayName || `片段${groupIdx + 1}`).trim(),
        downloadFilename: String(sb?.videoDownloadFilename || vt?.downloadFilename || latestNames?.downloadFilename || '').trim(),
        coverUrl: String(sb?.videoCoverUrl || vt?.coverUrl || '').trim(),
        errorMsg,
        updatedAt: sb?.videoTaskFinishedAt || vt?.finishedAt || vt?.updatedAt || null,
      },
    };
  });
  return {
    projectId: args.projectId,
    serverVersion: Number(project.version) || undefined,
    readiness: computeEditReadiness(project),
    promptReadiness,
    segments,
  };
}
