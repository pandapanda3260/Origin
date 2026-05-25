import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, updateProjectForUser } from '@/lib/projects-db';
import { syncEditProjectClips } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 剪辑工作台时间线 API。
 *
 * 前端走的是 op 协议 —— 每个 mutation 一条 POST，body 形如：
 *   { projectId, op: "import-group" | "remove-group" | "set-edl" |
 *                   "reorder" | "trim" | "transition" |
 *                   "bgm-select" | "bgm-offset" | "add-media", ... }
 *
 * 后端在 project.editData.edl 上做权威写盘，并回 readiness 全景镜像
 * 与 serverVersion，让前端 _sendTimelineOp 把内存乐观更新和后端态对齐。
 *
 * GET / PUT 保留为旧字段 timeline 的读写入口（兼容历史调用，不再被剪辑页主动使用）。
 */

type Edl = {
  timeline: any[];
  bgm?: { trackId?: string | null; offsetTime?: number } | null;
  version?: number;
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

function sumGroupDuration(proj: any, groupIdx: number): number {
  const sbs: any[] = Array.isArray(proj?.storyboards) ? proj.storyboards : [];
  const sb = sbs[groupIdx];
  if (!sb) return 5;
  // 关键：优先用真实生成文件时长；镜头表 duration 只是计划时长。
  // 不走这一步会出现"计划时长和实际视频文件不一致"导致字幕串到下一段的错位。
  const real = Number(sb.videoDurationSec);
  if (real > 0) return real;
  if (!Array.isArray(sb.shots) || !sb.shots.length) return 5;
  let dur = 0;
  for (const s of sb.shots) dur += Number(s?.duration) || 4;
  return dur || 5;
}

function computeReadiness(proj: any) {
  const sbs: any[] = Array.isArray(proj?.storyboards) ? proj.storyboards : [];
  const videoTasks: any[] = Array.isArray(proj?.videoTasks) ? proj.videoTasks : [];
  const totalCount = sbs.length;
  let readyCount = 0;
  for (let i = 0; i < sbs.length; i++) {
    const sb = sbs[i];
    const vt = videoTasks[i];
    if (sb && typeof sb.videoUrl === 'string' && sb.videoUrl.trim() && sb.videoIsCurrent !== false && vt?.isCurrent !== false) readyCount++;
  }
  return {
    totalCount,
    readyCount,
    canEnterEdit: readyCount >= 1,
  };
}

function applyOp(proj: any, body: any): { edl: Edl; storyboards: any[] | null; error?: string } {
  const edl = ensureEdl(proj);
  const sbs: any[] = Array.isArray(proj?.storyboards) ? [...proj.storyboards] : [];
  let sbsTouched = false;

  // ⚠️ 一次性 normalize：老 timeline 里可能已经存了用错误 sumGroupDuration 写下的
  // duration / outPoint（按 shots 累加 = 5），但实际视频是 10s。每次 mutation 前
  // 用真实视频时长（sb.videoDurationSec）纠正一遍，让陈旧数据自动愈合落盘。
  // 只动 inPoint=0 的段，避免覆盖用户已手动 trim 的范围。
  for (const seg of edl.timeline) {
    if (!seg || seg.groupIdx == null) continue;
    const sb = sbs[seg.groupIdx];
    if (!sb) continue;
    const realDur = Number(sb.videoDurationSec) || 0;
    if (!realDur) continue;
    const curDur = Number(seg.duration) || 0;
    if (Math.abs(curDur - realDur) < 0.05) continue;
    const inP = Number(seg.inPoint) || 0;
    if (inP === 0) {
      seg.duration = realDur;
      seg.outPoint = realDur;
    }
  }

  const op = String(body?.op || '');
  switch (op) {
    case 'import-group': {
      const idx = Number(body?.groupIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= sbs.length) {
        return { edl, storyboards: null, error: '非法 groupIdx' };
      }
	      const sb = sbs[idx] || {};
	      const vt = Array.isArray(proj?.videoTasks) ? proj.videoTasks[idx] : null;
	      if (!sb.videoUrl || sb.videoIsCurrent === false || vt?.isCurrent === false) {
	        return { edl, storyboards: null, error: '该片段还没有视频，无法导入' };
      }
      sbs[idx] = { ...sb, importedToEdit: true };
      sbsTouched = true;
      const exists = edl.timeline.some((e: any) => e && e.groupIdx === idx);
      if (!exists) {
        const dur = sumGroupDuration(proj, idx);
        edl.timeline.push({
          groupIdx: idx,
          videoUrl: sb.videoUrl,
          inPoint: 0,
          outPoint: dur,
          duration: dur,
          transitionIn: { type: 'cut', duration: 0 },
        });
        edl.timeline.sort((a: any, b: any) => (a.groupIdx || 0) - (b.groupIdx || 0));
      }
      break;
    }
    case 'remove-group': {
      const idx = Number(body?.groupIdx);
      if (!Number.isInteger(idx) || idx < 0) {
        return { edl, storyboards: null, error: '非法 groupIdx' };
      }
      if (sbs[idx]) {
        sbs[idx] = { ...sbs[idx], importedToEdit: false };
        sbsTouched = true;
      }
      edl.timeline = edl.timeline.filter((e: any) => !(e && e.groupIdx === idx));
      break;
    }
    case 'set-edl': {
      const next = body?.edl;
      if (!next || typeof next !== 'object') {
        return { edl, storyboards: null, error: '缺 edl' };
      }
      edl.timeline = Array.isArray(next.timeline) ? next.timeline : [];
      edl.bgm = next.bgm && typeof next.bgm === 'object' ? next.bgm : null;
      // importedToEdit 跟着 timeline 走：在 timeline 里出现过 groupIdx 的 sb 都视为已导入
      const inTl = new Set<number>();
      for (const e of edl.timeline) {
        if (e && Number.isInteger(e.groupIdx)) inTl.add(e.groupIdx);
      }
      for (let i = 0; i < sbs.length; i++) {
        const want = inTl.has(i);
        if (sbs[i] && !!sbs[i].importedToEdit !== want) {
          sbs[i] = { ...sbs[i], importedToEdit: want };
          sbsTouched = true;
        }
      }
      break;
    }
    case 'reorder': {
      const from = Number(body?.fromIdx);
      const to = Number(body?.toIdx);
      if (
        !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < 0 ||
        from >= edl.timeline.length || to >= edl.timeline.length
      ) {
        return { edl, storyboards: null, error: '非法 reorder 索引' };
      }
      const item = edl.timeline.splice(from, 1)[0];
      edl.timeline.splice(to, 0, item);
      break;
    }
    case 'trim': {
      const segIdx = Number(body?.segIdx);
      if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= edl.timeline.length) {
        return { edl, storyboards: null, error: '非法 segIdx' };
      }
      const seg = edl.timeline[segIdx];
      if (!seg) return { edl, storyboards: null, error: '片段不存在' };
      const inP = body?.inPoint;
      const outP = body?.outPoint;
      if (typeof inP === 'number') seg.inPoint = inP;
      if (typeof outP === 'number') seg.outPoint = outP;
      const a = Number(seg.inPoint) || 0;
      const b = typeof seg.outPoint === 'number' ? seg.outPoint : (Number(seg.duration) || 5);
      seg.duration = Math.max(0.1, b - a);
      break;
    }
    case 'transition': {
      const segIdx = Number(body?.segIdx);
      if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= edl.timeline.length) {
        return { edl, storyboards: null, error: '非法 segIdx' };
      }
      const seg = edl.timeline[segIdx];
      if (!seg) return { edl, storyboards: null, error: '片段不存在' };
      const type = String(body?.type || 'cut');
      const dur = type === 'cut' ? 0 : Math.max(0, Number(body?.duration ?? 0.5));
      seg.transitionIn = { type, duration: dur };
      break;
    }
    case 'bgm-select': {
      const trackId = body?.trackId == null ? null : String(body.trackId);
      const prev = (edl.bgm && typeof edl.bgm === 'object') ? edl.bgm : null;
      edl.bgm = { trackId, offsetTime: (prev && typeof prev.offsetTime === 'number') ? prev.offsetTime : 0 };
      break;
    }
    case 'bgm-offset': {
      const offset = Number(body?.offsetTime);
      if (!Number.isFinite(offset)) {
        return { edl, storyboards: null, error: '非法 offsetTime' };
      }
      const prev = (edl.bgm && typeof edl.bgm === 'object') ? edl.bgm : { trackId: null };
      edl.bgm = { trackId: prev.trackId ?? null, offsetTime: offset };
      break;
    }
    case 'add-media': {
      const entry = body?.entry;
      if (!entry || typeof entry !== 'object') {
        return { edl, storyboards: null, error: '缺 entry' };
      }
      // 基础 schema 校验：防止前端塞任意大 JSON / 非数值字段
      const clipId = typeof entry.clipId === 'string' ? entry.clipId.slice(0, 100) : '';
      const mediaId = typeof entry.mediaId === 'string' ? entry.mediaId.slice(0, 100) : '';
      if (!clipId && !mediaId && !entry.videoUrl) {
        return { edl, storyboards: null, error: 'entry 必须带 clipId / mediaId / videoUrl 之一' };
      }
      if (Array.isArray(edl.timeline) && edl.timeline.length >= 500) {
        return { edl, storyboards: null, error: '时间线条目超过上限（500 条）' };
      }
      const sanitized: Record<string, any> = {
        clipId: clipId || undefined,
        mediaId: mediaId || undefined,
        videoUrl: typeof entry.videoUrl === 'string' ? entry.videoUrl.slice(0, 2000) : undefined,
        inPoint: Number.isFinite(Number(entry.inPoint)) ? Number(entry.inPoint) : 0,
        outPoint: Number.isFinite(Number(entry.outPoint)) ? Number(entry.outPoint) : undefined,
        duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : undefined,
        groupIdx: Number.isInteger(Number(entry.groupIdx)) ? Number(entry.groupIdx) : null,
        transitionIn: entry.transitionIn && typeof entry.transitionIn === 'object'
          ? { type: String((entry.transitionIn as any).type || 'cut').slice(0, 32) }
          : (typeof entry.transitionIn === 'string' ? { type: entry.transitionIn.slice(0, 32) } : undefined),
      };
      // 去除 undefined 键
      const cleaned = Object.fromEntries(Object.entries(sanitized).filter(([, v]) => v !== undefined));
      edl.timeline.push(cleaned);
      break;
    }
    default:
      return { edl, storyboards: null, error: '未知 op: ' + op };
  }

  edl.version = (Number(edl.version) || 0) + 1;
  return { edl, storyboards: sbsTouched ? sbs : null };
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id) as any;
  if (!proj) return jsonError('项目不存在', 404);
  const edl = ensureEdl(proj);
  return jsonOk({ edl, readiness: computeReadiness(proj), serverVersion: edl.version || 0 });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = body?.projectId;
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id) as any;
  if (!proj) return jsonError('项目不存在', 404);

  const { edl, storyboards, error } = applyOp(proj, body);
  if (error) return jsonError(error, 400);

  const editData = { ...(proj.editData || {}), edl };
  const patch: any = { editData };
  if (storyboards) patch.storyboards = storyboards;

  updateProjectForUser(projectId, user.id, patch);
  try {
    syncEditProjectClips({ ownerId: user.id, projectId, timeline: edl.timeline || [] });
  } catch (clipError) {
    console.warn('[edit/timeline] pinned clip sync skipped:', clipError);
  }

  // readiness 用最新 storyboards 计算
  const finalProj = storyboards ? { ...proj, storyboards } : proj;
  return jsonOk({
    ok: true,
    edl,
    readiness: computeReadiness(finalProj),
    serverVersion: edl.version || 0,
  });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const projectId = body.projectId;
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  const timeline = body.timeline ?? { tracks: body.tracks || [], clips: body.clips || [], duration: body.duration || 0 };
  updateProjectForUser(projectId, user.id, { timeline });
  return jsonOk({ ok: true, timeline });
}
