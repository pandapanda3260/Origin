import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRow } from './db';
import { getDb } from './db';
import { addBgm, burnSubtitles, concatClips, mixTransitionSfx, probeDurationSec } from './ffmpeg';
import { storyboardShotIndices } from './frame-workflow-state';
import { CREDIT_PRICES, chargeCredits, refundCredits, InsufficientCreditsError } from './credits';
import { patchProjectForUser } from './projects-db';
import { buildKnowledgeContextForStage } from './knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from './knowledge/context-db';
import { getDataDir } from './runtime-paths';
import { isExportEnabled } from './system-config';
import { projectHiddenContentReferences } from './content-flags';

const DATA_DIR = getDataDir();
const EXPORTS_DIR = join(DATA_DIR, 'exports');
const VIDEOS_DIR = join(DATA_DIR, 'videos');
const BGM_DIR = join(DATA_DIR, 'bgm');

export class EditExportError extends Error {
  status: number;
  payload?: any;

  constructor(message: string, status = 500, payload?: any) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function extractVideoTaskIdFromUrl(value: any): string {
  if (typeof value !== 'string') return '';
  const m = /\/api\/videos\/file\/([a-zA-Z0-9-]+)/.exec(value);
  return m ? m[1] : '';
}

function currentClipIdForGroup(proj: any, groupIdx: number): string {
  const storyboards = Array.isArray(proj?.storyboards) ? proj.storyboards : [];
  const videoTasks = Array.isArray(proj?.videoTasks) ? proj.videoTasks : [];
  const sb = storyboards[groupIdx];
  if (!sb) return '';
  try {
    storyboardShotIndices(proj, groupIdx, sb, { mode: 'single-shot-strict' });
  } catch {
    return '';
  }
  const vt = videoTasks[groupIdx];
  return String(
    sb?.videoTaskId ||
    vt?.taskId ||
    vt?.serverTaskId ||
    vt?.id ||
    extractVideoTaskIdFromUrl(sb?.videoUrl) ||
    extractVideoTaskIdFromUrl(sb?._originVideoUrl) ||
    extractVideoTaskIdFromUrl(vt?.url) ||
    extractVideoTaskIdFromUrl(vt?.videoUrl) ||
    extractVideoTaskIdFromUrl(vt?.protectedUrl) ||
    '',
  ).trim();
}

function fmtSrtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function splitDialogueLines(raw: string): string[] {
  if (!raw) return [];
  const SPEAKER_RE = /([^：:\s「『""''""''『」』]{1,12})[：:]/g;
  const anchors: Array<{ speaker: string; textStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = SPEAKER_RE.exec(raw)) !== null) {
    anchors.push({ speaker: m[1].trim(), textStart: m.index + m[0].length });
  }
  if (!anchors.length) {
    const t = raw
      .trim()
      .replace(/^["'""'「『]+/, '')
      .replace(/["'""'」』]+$/, '')
      .trim();
    return t ? [t] : [];
  }
  const out: string[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    const nextStart =
      i + 1 < anchors.length
        ? anchors[i + 1].textStart - anchors[i + 1].speaker.length - 1
        : raw.length;
    let text = raw.slice(cur.textStart, nextStart).trim();
    text = text
      .replace(/^["'""'「『]+/, '')
      .replace(/["'""'」』]+$/, '')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

function buildSrt(items: { groupIdx: number | null; inSec: number; outSec: number }[], project: any, clipDurations: number[]): string {
  const sbs: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots: any[] = Array.isArray(project?.shots) ? project.shots : [];

  function dialogueForGroup(gIdx: number): string[] {
    const sb = sbs[gIdx];
    const shotIndex = storyboardShotIndices(project, gIdx, sb, { mode: 'single-shot-strict' })[0];
    const lines: string[] = [];
    const prompt: string = (sb && sb.videoPrompt) || '';
    if (prompt) {
      const Q = '\u201C\u201D\u2018\u2019\u0022\u0027\u300C\u300D\u300E\u300F';
      const DIALOG_RE = new RegExp(
        '[\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9\\u00B7]{0,11}[\\uFF1A:]\\s*[' + Q + ']([^' + Q + '\\n]{1,80}?)[' + Q + ']',
        'g',
      );
      let m: RegExpExecArray | null;
      while ((m = DIALOG_RE.exec(prompt)) !== null) {
        const t = (m[1] || '').trim();
        const cleaned = t.replace(/[，。,.]/g, '').trim();
        if (cleaned) lines.push(cleaned);
      }
    }
    if (!lines.length) {
      const sh = shots[shotIndex];
      const raw = String(sh?.dialogue || '').trim();
      if (raw && raw !== '——' && raw !== '-' && raw !== '无') {
        const pieces = splitDialogueLines(raw);
        for (const p of pieces) {
          const cleaned = p.replace(/[，。,.]/g, '').trim();
          if (cleaned) lines.push(cleaned);
        }
      }
    }
    return lines.filter(Boolean);
  }

  const cues: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const segDur = clipDurations[i] || Math.max(0.5, (it.outSec || 0) - (it.inSec || 0)) || 4;
    const segStart = cursor;
    const segEnd = cursor + segDur;
    cursor = segEnd;
    if (it.groupIdx == null) continue;
    const lines = dialogueForGroup(it.groupIdx);
    if (!lines.length) continue;
    const usable = Math.max(0.5, segDur - 0.3);
    const each = usable / lines.length;
    for (let k = 0; k < lines.length; k++) {
      const start = segStart + 0.15 + k * each;
      const end = Math.min(segEnd - 0.05, start + each - 0.05);
      cues.push({ start, end, text: lines[k] });
    }
  }
  if (!cues.length) return '';
  return cues.map((c, idx) =>
    `${idx + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`,
  ).join('\n');
}

function normalizeExportItems(project: any, rawEdl: any) {
  let timeline: any[] = [];
  let bgmIdFromEdl: string | undefined;
  if (Array.isArray(rawEdl)) {
    timeline = rawEdl;
  } else if (rawEdl && Array.isArray(rawEdl.timeline)) {
    timeline = rawEdl.timeline;
    if (rawEdl.bgm && rawEdl.bgm.trackId) bgmIdFromEdl = String(rawEdl.bgm.trackId);
  }
  if (!timeline.length) {
    throw new EditExportError('EDL 不能为空（时间线上没有素材）', 400);
  }

  type ExportItem = {
    clipId: string;
    inSec: number;
    outSec: number;
    groupIdx: number | null;
    transitionInType: string;
  };
  const items: ExportItem[] = [];
  for (const e of timeline) {
    let clipId = String(e?.clipId || '').trim();
    if (!clipId && typeof e?.videoUrl === 'string') clipId = extractVideoTaskIdFromUrl(e.videoUrl);
    if (!clipId && Number.isInteger(Number(e?.groupIdx))) clipId = currentClipIdForGroup(project, Number(e.groupIdx));
    if (!clipId) continue;

    const inSec = Math.max(0, Number(e?.inPoint ?? e?.in ?? 0));
    let outSec = Number(e?.outPoint ?? e?.out);
    if (!Number.isFinite(outSec) || outSec <= inSec) {
      outSec = Number(e?.duration) > 0 ? inSec + Number(e.duration) : 0;
    }
    items.push({
      clipId,
      inSec,
      outSec,
      groupIdx: Number.isInteger(Number(e?.groupIdx)) ? Number(e.groupIdx) : null,
      transitionInType: String(e?.transitionIn?.type || e?.transitionIn || 'cut').toLowerCase(),
    });
  }
  if (!items.length) {
    throw new EditExportError('没找到任何可用的视频片段（请先生成视频，或确认时间线已有素材）', 400);
  }
  return { items, bgmIdFromEdl };
}

function chooseBgmId(project: any, bgmId: string | undefined) {
  if (bgmId) return bgmId;
  const editData = (project.editData as any) || {};
  const suggested = editData?.segmentTags?.suggestedBGMCategory as string | undefined;
  if (!suggested || !existsSync(BGM_DIR)) return undefined;
  const audioFiles = readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
  let pick = audioFiles.find((f) => f.toLowerCase().startsWith(suggested.toLowerCase() + '_'));
  if (!pick) {
    try {
      const meta = JSON.parse(readFileSync(join(BGM_DIR, '_meta.json'), 'utf-8') || '{}');
      pick = audioFiles.find((f) => meta[f]?.category === suggested);
    } catch (_) {}
  }
  return pick;
}

export function markExportTaskIgnored(args: {
  userId: number;
  taskId: string;
  reason?: string;
}) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) return false;
  const info = getDb().prepare(
    `UPDATE exports
     SET status='cancelled', error_msg=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=? AND owner_id=? AND status IN ('queued','running')`,
  ).run((args.reason || 'replaced by retry').slice(0, 1000), taskId, args.userId);
  if (info.changes > 0) {
    try {
      refundCredits({
        userId: args.userId,
        amount: CREDIT_PRICES.export,
        reason: `edit.export.cancelled:${String(args.reason || 'replaced').slice(0, 120)}`,
        refId: taskId,
      });
    } catch (e) {
      console.error('[export] cancel refund failed:', taskId, e);
    }
  }
  return info.changes > 0;
}

export async function startEditExport(args: {
  user: UserRow;
  projectId: string;
  project: any;
  edl: any;
  bgmId?: string;
  edlVersion?: number;
  composeMeta?: any;
  filenameSuffix?: string;
}) {
  if (!isExportEnabled()) {
    throw new EditExportError('导出功能暂时关闭，请稍后再试', 503);
  }

  const projectId = String(args.projectId || '');
  if (!projectId) throw new EditExportError('缺 projectId', 400);
  if (!args.project) throw new EditExportError('项目不存在', 404);

  const hiddenRefs = projectHiddenContentReferences(args.project);
  if (hiddenRefs.length) {
    throw new EditExportError('项目包含已隐藏内容，无法导出', 409, {
      detail: '项目包含已隐藏内容，无法导出',
      errorCode: 'HIDDEN_CONTENT_BLOCKED',
      hiddenSources: hiddenRefs.slice(0, 20),
    });
  }

  const { items, bgmIdFromEdl } = normalizeExportItems(args.project, args.edl);
  const bgmId = chooseBgmId(args.project, args.bgmId || bgmIdFromEdl);
  const explicitVersion = Number(args.edlVersion);
  const inferredVersion = Number(args.edl?.version ?? args.project?.editData?.edl?.version);
  const edlVersion = Number.isFinite(explicitVersion)
    ? explicitVersion
    : (Number.isFinite(inferredVersion) ? inferredVersion : null);
  const exportId = randomUUID();

  try {
    chargeCredits({
      userId: args.user.id,
      amount: CREDIT_PRICES.export,
      kind: 'export',
      reason: 'edit.export',
      refId: exportId,
    });
  } catch (e: any) {
    if (e instanceof InsufficientCreditsError) {
      throw new EditExportError(e.message, 402, {
        detail: e.message,
        errorCode: 'INSUFFICIENT_CREDITS',
        required: e.required,
        balance: e.balance,
      });
    }
    throw new EditExportError(e?.message || String(e), 500);
  }

  const db = getDb();
  const refundOnFailure = (reason: string) => {
    try {
      refundCredits({
        userId: args.user.id,
        amount: CREDIT_PRICES.export,
        reason: `edit.export.failed:${reason}`,
        refId: exportId,
      });
    } catch (refErr) {
      console.error('[export] refund failed:', exportId, refErr);
    }
  };

  const ownerDir = join(EXPORTS_DIR, String(args.user.id));
  let fullPath: string;
  try {
    mkdirSync(ownerDir, { recursive: true });
    const suffix = args.filenameSuffix ? `-${String(args.filenameSuffix).replace(/[^a-z0-9_-]/gi, '').slice(0, 32)}` : '';
    const filename = `${exportId}${suffix}.mp4`;
    fullPath = join(ownerDir, filename);

    db.prepare(
      `INSERT INTO exports (id, owner_id, project_id, status, progress, filename, edl_json, edl_version, bgm_id)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    ).run(
      exportId,
      args.user.id,
      projectId,
      filename,
      JSON.stringify({ items, bgmId: bgmId || null, composeMeta: args.composeMeta || null }),
      edlVersion,
      bgmId || null,
    );
    try {
      patchProjectForUser(projectId, args.user.id, (current) => {
        const editData = { ...(current.editData || {}) };
        editData.exportTaskId = exportId;
        editData.exportUrl = '';
        return { editData };
      });
    } catch (e) {
      console.warn('[export] failed to persist exportTaskId:', exportId, e);
    }
    try {
      const context = buildKnowledgeContextForStage({
        ownerId: args.user.id,
        project: {
          ...(args.project || {}),
          id: projectId,
        },
        stage: 'export',
        stageTarget: {
          itemCount: items.length,
          clipIds: items.map((item) => item.clipId),
          bgmId: bgmId || null,
          edlVersion,
          hasComposeMeta: !!args.composeMeta,
        },
      });
      recordKnowledgeContextBestEffort({ ownerId: args.user.id, projectId, context, runId: exportId });
    } catch (e) {
      console.warn('[export] knowledge context audit skipped:', e);
    }
  } catch (e: any) {
    refundOnFailure('sync-setup');
    throw new EditExportError('导出准备失败：' + (e?.message || String(e)), 500);
  }

  setImmediate(async () => {
    try {
      await doExport({ exportId, userId: args.user.id, projectId, items, bgmId, outputPath: fullPath, project: args.project, edlVersion });
      const cur = getDb().prepare<{ id: string }, any>('SELECT status FROM exports WHERE id = @id').get({ id: exportId });
      if (cur?.status === 'failed') refundOnFailure('doExport-set-failed');
    } catch (e) {
      console.error('[export]', exportId, e);
      const cur = getDb().prepare<{ id: string }, any>('SELECT status FROM exports WHERE id = @id').get({ id: exportId });
      if (cur?.status !== 'cancelled') refundOnFailure('doExport-throw');
    }
  });

  return { ok: true, taskId: exportId, status: 'queued' };
}

async function doExport(opts: {
  exportId: string;
  userId: number;
  projectId: string;
  items: { clipId: string; inSec: number; outSec: number; groupIdx: number | null; transitionInType: string }[];
  bgmId?: string;
  outputPath: string;
  project: any;
  edlVersion: number | null;
}) {
  const { exportId, userId, projectId, items, bgmId, outputPath, project, edlVersion } = opts;
  const db = getDb();
  const isCancelled = () => {
    const cur = db.prepare<{ id: string }, any>('SELECT status FROM exports WHERE id = @id').get({ id: exportId });
    return cur?.status === 'cancelled';
  };
  const setProg = (p: number) => {
    db.prepare(
      `UPDATE exports SET progress=?, status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=? AND status IN ('queued','running')`,
    ).run(p, exportId);
  };

  setProg(5);
  if (isCancelled()) return;

  try {
    const clips: { path: string; inSec: number; outSec: number; transitionIn?: string; transitionInDuration?: number }[] = [];
    const clipDurations: number[] = [];
    const transitionTimes: { time: number; type: string }[] = [];
    let cumTime = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const v = db.prepare<{ id: string }, any>('SELECT * FROM video_tasks WHERE id = @id').get({ id: it.clipId });
      if (!v || !v.filename) continue;
      const path = join(VIDEOS_DIR, String(v.owner_id), v.filename);
      if (!existsSync(path)) continue;

      let fullDur = Number(v.duration_sec) || 0;
      if (!fullDur) fullDur = await probeDurationSec(path);
      if (!fullDur) fullDur = 5;

      let outSec = it.outSec || 0;
      if (!outSec || outSec <= it.inSec) outSec = fullDur;
      if (outSec > fullDur) outSec = fullDur;
      const inSec = Math.max(0, Math.min(it.inSec, outSec - 0.1));
      const segDur = outSec - inSec;

      const tType = i === 0 ? 'cut' : (it.transitionInType || 'cut').toLowerCase();
      const tDur = tType === 'cut' ? 0.04
                 : tType === 'dissolve' ? 1.0
                 : (tType === 'wipe' || tType === 'wipeleft' || tType === 'wiperight') ? 0.7
                 : 0.8;

      clips.push({ path, inSec, outSec, transitionIn: tType, transitionInDuration: tDur });
      clipDurations.push(segDur);
      if (i > 0 && tType !== 'cut') {
        transitionTimes.push({ time: Math.max(0, cumTime - tDur / 2), type: tType });
      }
      cumTime += segDur - (i > 0 ? tDur : 0);
    }
    if (!clips.length) throw new Error('没找到任何可用的视频片段');

    setProg(20);
    if (isCancelled()) return;

    const concatPath = join(EXPORTS_DIR, String(userId), `${exportId}.concat.mp4`);
    await concatClips({ clips, outputPath: concatPath });
    setProg(50);
    if (isCancelled()) return;

    let workingVideo = concatPath;
    const srt = buildSrt(items.map((it) => ({ groupIdx: it.groupIdx, inSec: it.inSec, outSec: it.outSec })), project, clipDurations);
    let srtPath = '';
    if (srt.trim()) {
      srtPath = join(EXPORTS_DIR, String(userId), `${exportId}.srt`);
      writeFileSync(srtPath, srt, 'utf-8');
      const subbed = join(EXPORTS_DIR, String(userId), `${exportId}.subbed.mp4`);
      try {
        await burnSubtitles({ videoPath: concatPath, srtPath, outputPath: subbed });
        workingVideo = subbed;
      } catch (e) {
        console.warn('[export] burnSubtitles failed, keep raw concat:', (e as any)?.message || e);
        workingVideo = concatPath;
      }
    }
    setProg(65);
    if (isCancelled()) return;

    let withSfx = workingVideo;
    if (transitionTimes.length) {
      const sfxOut = join(EXPORTS_DIR, String(userId), `${exportId}.sfx.mp4`);
      try {
        await mixTransitionSfx({ videoPath: workingVideo, sfxTimes: transitionTimes, outputPath: sfxOut });
        withSfx = sfxOut;
      } catch (e) {
        console.warn('[export] mixTransitionSfx failed, skip SFX:', (e as any)?.message || e);
        withSfx = workingVideo;
      }
    }
    setProg(80);
    if (isCancelled()) return;

    if (bgmId) {
      const bgmPath = join(BGM_DIR, bgmId);
      if (existsSync(bgmPath)) {
        await addBgm({
          videoPath: withSfx,
          bgmPath,
          outputPath,
          bgmVolume: 0.32,
          keepOriginal: true,
          duckBgm: true,
        });
      } else {
        renameSync(withSfx, outputPath);
      }
    } else {
      renameSync(withSfx, outputPath);
    }

    for (const f of [
      concatPath,
      srtPath,
      join(EXPORTS_DIR, String(userId), `${exportId}.subbed.mp4`),
      join(EXPORTS_DIR, String(userId), `${exportId}.sfx.mp4`),
    ]) {
      if (f && f !== outputPath && existsSync(f)) { try { unlinkSync(f); } catch (_) {} }
    }

    if (isCancelled()) return;
    const stat = statSync(outputPath);
    const updateInfo = db.prepare(
      `UPDATE exports SET status='completed', progress=100,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','running')`,
    ).run(exportId);
    if (updateInfo.changes > 0) {
      try {
        patchProjectForUser(projectId, userId, (current) => {
          const editData = { ...(current.editData || {}) };
          const currentTaskId = String(editData.exportTaskId || '');
          if (currentTaskId && currentTaskId !== exportId) return { editData };
          editData.exportTaskId = exportId;
          editData.exportUrl = `/api/edit/export-file/${exportId}`;
          if (Number.isFinite(Number(edlVersion))) {
            editData.exportedEdlVersion = Number(edlVersion);
          }
          return { editData };
        });
      } catch (e) {
        console.warn('[export] failed to persist completed export metadata:', exportId, e);
      }
    }
    console.log(
      '[export]', exportId, 'completed,', stat.size, 'bytes',
      bgmId ? `bgm=${bgmId}` : 'no-bgm',
      srt ? 'subs=on' : 'subs=off',
      `sfx=${transitionTimes.length}`,
      `xfades=${clips.filter((c, i) => i > 0 && c.transitionIn !== 'cut').length}`,
    );
  } catch (e: any) {
    const msg = e?.message || String(e);
    const cur = db.prepare<{ id: string }, any>('SELECT status FROM exports WHERE id = @id').get({ id: exportId });
    if (cur?.status === 'cancelled') return;
    const updateInfo = db.prepare(
      `UPDATE exports SET status='failed', error_msg=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status != 'cancelled'`,
    ).run(msg.slice(0, 1000), exportId);
    if (updateInfo.changes > 0) {
      try {
        patchProjectForUser(projectId, userId, (current) => {
          const editData = { ...(current.editData || {}) };
          if (String(editData.exportTaskId || '') === exportId && !editData.exportUrl) {
            editData.exportTaskId = '';
          }
          return { editData };
        });
      } catch (patchErr) {
        console.warn('[export] failed to clear failed exportTaskId:', exportId, patchErr);
      }
    }
    console.error('[export]', exportId, 'failed:', msg);
  }
}
