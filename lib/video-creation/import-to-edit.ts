import { syncEditProjectClips } from '@/lib/asset-library';
import { resolveGroupImportDurationSec, resolveTrustedActualDurationSec } from '@/lib/edit-duration-runtime';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';
import { computeEditReadiness } from './edit-readiness';

type Edl = {
  timeline: any[];
  bgm?: { trackId?: string | null; offsetTime?: number; enabled?: boolean } | null;
  version?: number;
};

export type ImportGroupApplyResult = {
  edl: Edl;
  storyboards: any[] | null;
  error?: string;
};

export type ImportGroupOutcome = {
  status: number;
  body: any;
};

function emptyEdl(): Edl {
  return { timeline: [], bgm: null, version: 0 };
}

function ensureEdl(proj: any): Edl {
  const ed = (proj && proj.editData) || {};
  const edl: Edl = ed.edl && typeof ed.edl === 'object' ? { ...ed.edl } : emptyEdl();
  if (!Array.isArray(edl.timeline)) edl.timeline = [];
  if (!edl.bgm || typeof edl.bgm !== 'object') edl.bgm = null;
  if (typeof edl.version !== 'number') edl.version = 0;
  return edl;
}

function resolveSegmentNames(proj: any, groupIdx: number) {
  const sb = Array.isArray(proj?.storyboards) ? proj.storyboards[groupIdx] || {} : {};
  const vt = Array.isArray(proj?.videoTasks) ? proj.videoTasks[groupIdx] || {} : {};
  const taskId = sb.videoTaskId || vt.taskId || vt.serverTaskId || vt.id || '';
  if (taskId) {
    return buildVideoSegmentNamesForRow({
      id: taskId,
      project_id: proj?.id,
      group_idx: groupIdx,
      filename: sb.videoFilename || vt.filename,
    }, proj);
  }
  const displayName = String(sb.videoDisplayName || vt.displayName || `片段${groupIdx + 1}`).trim();
  const downloadFilename = String(sb.videoDownloadFilename || vt.downloadFilename || `${displayName}.mp4`).trim();
  return {
    displayName,
    filename: String(sb.videoFilename || vt.filename || downloadFilename).trim(),
    downloadFilename,
  };
}

function normalizeTimelineDurations(proj: any, edl: Edl, storyboards: any[]) {
  for (const seg of edl.timeline) {
    if (!seg || seg.groupIdx == null) continue;
    const sb = storyboards[seg.groupIdx];
    if (!sb) continue;
    const realDur = resolveTrustedActualDurationSec(proj, Number(seg.groupIdx));
    if (!realDur) continue;
    const curDur = Number(seg.duration) || 0;
    if (Math.abs(curDur - realDur) < 0.05) continue;
    const inP = Number(seg.inPoint) || 0;
    if (inP === 0) {
      seg.duration = realDur;
      seg.outPoint = realDur;
    }
  }
}

export function applyImportGroupToEdit(proj: any, groupIdx: number): ImportGroupApplyResult {
  const edl = ensureEdl(proj);
  const sbs: any[] = Array.isArray(proj?.storyboards) ? [...proj.storyboards] : [];
  normalizeTimelineDurations(proj, edl, sbs);

  if (!Number.isInteger(groupIdx) || groupIdx < 0 || groupIdx >= sbs.length) {
    return { edl, storyboards: null, error: '非法 groupIdx' };
  }
  const sb = sbs[groupIdx] || {};
  const vt = Array.isArray(proj?.videoTasks) ? proj.videoTasks[groupIdx] : null;
  if (!sb.videoUrl || sb.videoIsCurrent === false || vt?.isCurrent === false) {
    return { edl, storyboards: null, error: '该片段还没有视频，无法导入' };
  }

  sbs[groupIdx] = { ...sb, importedToEdit: true };
  const exists = edl.timeline.some((entry: any) => entry && entry.groupIdx === groupIdx);
  if (!exists) {
    const duration = resolveGroupImportDurationSec(proj, groupIdx);
    const names = resolveSegmentNames(proj, groupIdx);
    edl.timeline.push({
      groupIdx,
      videoUrl: sb.videoUrl,
      protectedUrl: sb._originVideoUrl || vt?.protectedUrl || sb.videoUrl,
      _originVideoUrl: sb._originVideoUrl || vt?.protectedUrl || sb.videoUrl,
      filename: names.filename,
      displayName: names.displayName,
      downloadFilename: names.downloadFilename,
      _mediaName: names.displayName,
      inPoint: 0,
      outPoint: duration,
      duration,
      transitionIn: { type: 'cut', duration: 0 },
    });
    edl.timeline.sort((a: any, b: any) => (a.groupIdx || 0) - (b.groupIdx || 0));
  }
  edl.version = (Number(edl.version) || 0) + 1;
  return { edl, storyboards: sbs };
}

export function importVideoGroupToEdit(args: {
  projectId: string;
  ownerId: number;
  groupIdx: number;
}): ImportGroupOutcome {
  if (!args.projectId) return { status: 400, body: { detail: '缺 projectId' } };
  const project = getProjectByIdForUser(args.projectId, args.ownerId) as any;
  if (!project) return { status: 404, body: { detail: '项目不存在' } };

  const { edl, storyboards, error } = applyImportGroupToEdit(project, args.groupIdx);
  if (error) return { status: 400, body: { detail: error } };

  const editData = { ...(project.editData || {}), edl };
  const patch: any = { editData };
  if (storyboards) patch.storyboards = storyboards;
  updateProjectForUser(args.projectId, args.ownerId, patch);
  try {
    syncEditProjectClips({ ownerId: args.ownerId, projectId: args.projectId, timeline: edl.timeline || [] });
  } catch (clipError) {
    console.warn('[video-creation] import clip sync skipped:', clipError);
  }

  const finalProject = storyboards ? { ...project, storyboards } : project;
  return {
    status: 200,
    body: {
      ok: true,
      edl,
      readiness: computeEditReadiness(finalProject),
      serverVersion: edl.version || 0,
    },
  };
}
