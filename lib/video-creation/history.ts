import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { buildSignedImageUrl } from '@/lib/signed-asset-url';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';
import {
  buildProtectedVideoUrl,
  buildSignedVideoPlaybackUrl,
} from './urls';

function stringContainsTaskId(value: any, taskId: string): boolean {
  return typeof value === 'string' && taskId.length > 0 && value.includes(taskId);
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

export function getVideoCreationHistoryForGroup(args: {
  req: NextRequest;
  projectId: string;
  ownerId: number;
  groupIdx: number;
}) {
  const project = getProjectByIdForUser(args.projectId, args.ownerId) as any;
  if (!project) return { status: 404, body: { detail: '项目不存在' } };
  if (!Number.isInteger(args.groupIdx) || args.groupIdx < 0) return { status: 400, body: { detail: '非法 groupIdx' } };

  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const sb = storyboards[args.groupIdx];
  let slotValid = false;
  if (sb) {
    try {
      storyboardShotIndices(project, args.groupIdx, sb, { mode: 'single-shot-strict' });
      slotValid = true;
    } catch {
      slotValid = false;
    }
  }
  if (!slotValid) return { status: 200, body: { history: [], total: 0 } };

  const db = getDb();
  const rows = db
    .prepare<{ uid: number; pid: string; gi: number }, any>(
      `SELECT id, group_idx, status, duration_sec, filename, cover_image_id, prompt, created_at
       FROM video_tasks
       WHERE owner_id = @uid AND project_id = @pid AND group_idx = @gi
       ORDER BY created_at DESC`,
    )
    .all({ uid: args.ownerId, pid: args.projectId, gi: args.groupIdx });

  const videoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  const vt = videoTasks[args.groupIdx];
  const currentIds = [sb?.videoTaskId, vt?.taskId, vt?.serverTaskId, vt?.id]
    .map((value: any) => String(value || '').trim())
    .filter(Boolean);
  const currentUrls = [sb?.videoUrl, sb?._originVideoUrl, vt?.url, vt?.protectedUrl].map((value: any) => String(value || ''));

  const history = rows
    .filter((row: any) => {
      const status = String(row?.status || '').toLowerCase();
      return (status === 'succeeded' || status === 'done' || status === 'completed') && row?.filename;
    })
    .map((row: any) => {
      const taskId = String(row.id);
      const names = buildVideoSegmentNamesForRow(row, project);
      const isCurrent = currentIds.includes(taskId) || currentUrls.some((url: string) => stringContainsTaskId(url, taskId));
      return {
        task_id: taskId,
        target_idx: args.groupIdx,
        title: names.displayName,
        name: names.displayName,
        displayName: names.displayName,
        filename: names.filename,
        downloadFilename: names.downloadFilename,
        status: row.status,
        duration_sec: row.duration_sec,
        url: buildSignedVideoPlaybackUrl(taskId, args.ownerId),
        protected_url: buildProtectedVideoUrl(taskId),
        cover_url: buildSignedCoverDisplayUrl(args.req, row.cover_image_id, args.ownerId),
        prompt: row.prompt || '',
        created_at: row.created_at,
        is_current: isCurrent,
      };
    });

  return { status: 200, body: { history, total: history.length } };
}
