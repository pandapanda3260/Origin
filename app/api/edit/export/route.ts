import { NextRequest } from 'next/server';
import { mkdirSync, existsSync, statSync, writeFileSync, readdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { concatClips, addBgm, burnSubtitles, probeDurationSec, mixTransitionSfx } from '@/lib/ffmpeg';
import { getDb } from '@/lib/db';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { CREDIT_PRICES, chargeCredits, refundCredits, InsufficientCreditsError } from '@/lib/credits';
import { storyboardShotIndices } from '@/lib/frame-workflow-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = join(process.cwd(), 'data');
const EXPORTS_DIR = join(DATA_DIR, 'exports');
const VIDEOS_DIR = join(DATA_DIR, 'videos');
const BGM_DIR = join(DATA_DIR, 'bgm');

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

/**
 * 启动一次导出（异步）。返回 { taskId } 给前端，前端通过 /api/tasks/<id>/stream 订阅，
 * 或退化到 /api/edit/export-status/<id> 轮询。
 *
 * 工业级渲染流水线（按顺序执行，全部 ffmpeg 真渲染，没有 mock）：
 *
 *   1) concat   ：每段按 inPoint/outPoint 真切，统一 1920x1080@30fps，
 *                 stereo 48k 音轨；段间 80ms 微淡防咔哒声。
 *   2) 烧字幕   ：从 project.shots[*].dialogue 生成 SRT，按"段累计起点 + 段长"算时间码，
 *                 ffmpeg `subtitles=` 滤镜烧入画面（白字黑边、底部居中、PingFang SC）。
 *   3) 盖 BGM   ：用户没指定时按 segmentTags.suggestedBGMCategory 自动选；BGM 自动循环
 *                 到视频长度，头尾 1.5s 渐入渐出，4kHz 低通让出语音频段，对白和 BGM
 *                 用 amix weights 加权（对白 2 / BGM 1），整片走 loudnorm 拉到 -16 LUFS。
 *
 * 入参兼容两种 edl 形态：
 *   - 数组：[{clipId, in, out, transitionIn:string|{type}, ...}]
 *   - 对象：{ timeline: [{groupIdx, videoUrl, inPoint, outPoint, ...}], bgm: {trackId} }
 */
export async function POST(req: NextRequest) {
  try {
    return await _exportPost(req);
  } catch (err: any) {
    // 兜底：任何意料之外的同步抛异常都包成 500 + 文本，不让 Next.js 返回 HTML 页面，
    // 否则前端只能看到通用的"服务暂时不可用"完全没线索。
    console.error('[export] unhandled error:', err?.stack || err?.message || err);
    return jsonError('导出失败：' + (err?.message || String(err)), 500);
  }
}

async function _exportPost(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string = (body.projectId || '').toString();
  if (!projectId) return jsonError('缺 projectId', 400);

  const proj = getProjectByIdForUser(projectId, user.id) as any;
  if (!proj) return jsonError('项目不存在', 404);

  // ── 1) 解析 edl ─────────────────────────────────────────────
  const rawEdl = body.edl;
  let timeline: any[] = [];
  let bgmIdFromEdl: string | undefined;
  if (Array.isArray(rawEdl)) {
    timeline = rawEdl;
  } else if (rawEdl && Array.isArray(rawEdl.timeline)) {
    timeline = rawEdl.timeline;
    if (rawEdl.bgm && rawEdl.bgm.trackId) bgmIdFromEdl = String(rawEdl.bgm.trackId);
  }
  let bgmId: string | undefined = (body.bgmId && String(body.bgmId)) || bgmIdFromEdl;

  if (!timeline.length) return jsonError('EDL 不能为空（时间线上没有素材）', 400);

  // ── 2) 规范化 timeline → items（含 clipId / 区间 / groupIdx） ────────
  const db = getDb();
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
    if (!clipId && typeof e?.videoUrl === 'string') {
      clipId = extractVideoTaskIdFromUrl(e.videoUrl);
    }
    if (!clipId && Number.isInteger(Number(e?.groupIdx))) {
      clipId = currentClipIdForGroup(proj, Number(e.groupIdx));
    }
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
  if (!items.length) return jsonError('没找到任何可用的视频片段（请先生成视频，或确认时间线已有素材）', 400);

  // ── 3) BGM 自动选：用户没指定 → 按 suggestedBGMCategory 命中第一条 ──────
  if (!bgmId) {
    const editData = (proj.editData as any) || {};
    const suggested = editData?.segmentTags?.suggestedBGMCategory as string | undefined;
    if (suggested && existsSync(BGM_DIR)) {
      const audioFiles = readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
      // 同名前缀匹配优先，否则匹配 _meta.json 里 category 一致的
      let pick = audioFiles.find((f) => f.toLowerCase().startsWith(suggested.toLowerCase() + '_'));
      if (!pick) {
        try {
          const meta = JSON.parse(readFileSync(join(BGM_DIR, '_meta.json'), 'utf-8') || '{}');
          pick = audioFiles.find((f) => meta[f]?.category === suggested);
        } catch (_) {}
      }
      if (pick) bgmId = pick;
    }
  }

  try {
    chargeCredits({
      userId: user.id,
      amount: CREDIT_PRICES.export,
      kind: 'export',
      reason: 'edit.export',
      refId: projectId,
    });
  } catch (e: any) {
    if (e instanceof InsufficientCreditsError) {
      return new Response(
        JSON.stringify({ detail: e.message, errorCode: 'INSUFFICIENT_CREDITS', required: e.required, balance: e.balance }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return jsonError(e?.message || String(e), 500);
  }

  const exportId = randomUUID();
  const refundOnFailure = (reason: string) => {
    try {
      refundCredits({
        userId: user.id,
        amount: CREDIT_PRICES.export,
        reason: `edit.export.failed:${reason}`,
        refId: exportId,
      });
    } catch (refErr) {
      console.error('[export] refund failed:', exportId, refErr);
    }
  };

  const ownerDir = join(EXPORTS_DIR, String(user.id));
  let filename: string;
  let fullPath: string;
  try {
    mkdirSync(ownerDir, { recursive: true });
    filename = `${exportId}.mp4`;
    fullPath = join(ownerDir, filename);

    db.prepare(
      `INSERT INTO exports (id, owner_id, project_id, status, progress, filename, edl_json, bgm_id)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(exportId, user.id, projectId, filename, JSON.stringify({ items, bgmId: bgmId || null }), bgmId || null);
  } catch (e: any) {
    // 同步路径失败（建目录/写表）：一定要退款，否则用户积分直接消失
    refundOnFailure('sync-setup');
    return jsonError('导出准备失败：' + (e?.message || String(e)), 500);
  }

  // 异步执行
  setImmediate(async () => {
    try {
      await doExport({ exportId, userId: user.id, items, bgmId, outputPath: fullPath, project: proj });
      const cur = getDb().prepare<{ id: string }, any>('SELECT status FROM exports WHERE id = @id').get({ id: exportId });
      if (cur?.status === 'failed') refundOnFailure('doExport-set-failed');
    } catch (e) {
      console.error('[export]', exportId, e);
      refundOnFailure('doExport-throw');
    }
  });

  return jsonOk({ ok: true, taskId: exportId, status: 'queued' });
}

/** 把秒转成 SRT 时间码 `HH:MM:SS,mmm` */
function fmtSrtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** 从 dialogue 串里去掉"角色名："前缀，留干净的台词正文 */
function stripSpeaker(line: string): string {
  return String(line || '')
    .replace(/^\s*[^：:]{1,12}\s*[：:]\s*/, '')
    .replace(/^["'""'「『]+|["'""'」』]+$/g, '')
    .trim();
}

/** 把"老板：xxx 帝王蟹：yyy"形式的多句对白拆成每条独立的 text 数组。
 * stripSpeaker 只能剥头一段，碰到多 speaker 时第二句开始的"角色名:"会留在字幕里
 *（用户截图：「家人们…" 帝王蟹队长："先别…」），所以这里走 anchor 切。 */
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

/** 根据 EDL items 和项目 storyboards/shots 构造 SRT；返回 srt 字符串（空串表示无字幕） */
function buildSrt(items: { groupIdx: number | null; inSec: number; outSec: number }[], project: any, clipDurations: number[]): string {
  const sbs: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots: any[] = Array.isArray(project?.shots) ? project.shots : [];

  // 取每段的对白：优先从 sb.videoPrompt 抓 `角色：「台词」` —— 这是 AI 真正
  // "说了什么"的权威源（一段视频可能合并 2-3 个 shot 的台词）。
  // 抓不到才退回 shots[].dialogue。
  function dialogueForGroup(gIdx: number): string[] {
    const sb = sbs[gIdx];
    const shotIndex = storyboardShotIndices(project, gIdx, sb, { mode: 'single-shot-strict' })[0];
    const lines: string[] = [];
    const prompt: string = (sb && sb.videoPrompt) || '';
    if (prompt) {
      // 引号字符必须用 \u 转义，否则编辑/序列化过程会把中文引号统一成 ASCII 双引号，
      // 字符类退化为 [""...] 完全失效，永远抓不到 sb.videoPrompt 里的台词。
      const Q = '\u201C\u201D\u2018\u2019\u0022\u0027\u300C\u300D\u300E\u300F';
      const DIALOG_RE = new RegExp(
        '[\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9\\u00B7]{0,11}[\\uFF1A:]\\s*[' + Q + ']([^' + Q + '\\n]{1,80}?)[' + Q + ']',
        'g'
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

    // 对白均匀切分到本段时间内；预留头 0.15s 入场、尾 0.15s 留白
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

async function doExport(opts: {
  exportId: string;
  userId: number;
  items: { clipId: string; inSec: number; outSec: number; groupIdx: number | null; transitionInType: string }[];
  bgmId?: string;
  outputPath: string;
  project: any;
}) {
  const { exportId, userId, items, bgmId, outputPath, project } = opts;
  const db = getDb();
  const setProg = (p: number) => db.prepare(`UPDATE exports SET progress=?, status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(p, exportId);

  setProg(5);

  try {
    // 1) 物理文件 + 真实时长 + 转场配置
    const clips: { path: string; inSec: number; outSec: number; transitionIn?: string; transitionInDuration?: number }[] = [];
    const clipDurations: number[] = [];
    const transitionTimes: { time: number; type: string }[] = []; // 用来合成 whoosh SFX
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

      // 转场（第 0 段忽略）；时长与 lib/ffmpeg.ts defaultTransDuration 保持一致
      const tType = i === 0 ? 'cut' : (it.transitionInType || 'cut').toLowerCase();
      const tDur = tType === 'cut' ? 0.04
                 : tType === 'dissolve' ? 1.0
                 : (tType === 'wipe' || tType === 'wipeleft' || tType === 'wiperight') ? 0.7
                 : 0.8; // fade

      clips.push({ path, inSec, outSec, transitionIn: tType, transitionInDuration: tDur });
      clipDurations.push(segDur);

      // 记录转场点（用于 SFX whoosh）：在切到本段那一刻 = 前面累计时长 - tDur/2
      if (i > 0 && tType !== 'cut') {
        transitionTimes.push({ time: Math.max(0, cumTime - tDur / 2), type: tType });
      }
      cumTime += segDur - (i > 0 ? tDur : 0);
    }
    if (!clips.length) throw new Error('没找到任何可用的视频片段');

    setProg(20);

    // 2) concat → 临时 mp4（带对白原音 + 转场特效 xfade/acrossfade）
    const concatPath = join(EXPORTS_DIR, String(userId), `${exportId}.concat.mp4`);
    await concatClips({ clips, outputPath: concatPath });
    setProg(50);

    // 3) 烧字幕（如果项目里有对白）
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

    // 3.5) 转场 SFX：在 fade/dissolve/wipe 转场点上叠 whoosh 音效
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

    // 4) 盖 BGM（如果选了 / 自动选到了）
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

    // 清理中间文件
    for (const f of [
      concatPath,
      srtPath,
      join(EXPORTS_DIR, String(userId), `${exportId}.subbed.mp4`),
      join(EXPORTS_DIR, String(userId), `${exportId}.sfx.mp4`),
    ]) {
      if (f && f !== outputPath && existsSync(f)) { try { unlinkSync(f); } catch (_) {} }
    }

    const stat = statSync(outputPath);
    db.prepare(
      `UPDATE exports SET status='completed', progress=100,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(exportId);
    console.log(
      '[export]', exportId, 'completed,', stat.size, 'bytes',
      bgmId ? `bgm=${bgmId}` : 'no-bgm',
      srt ? 'subs=on' : 'subs=off',
      `sfx=${transitionTimes.length}`,
      `xfades=${clips.filter((c, i) => i > 0 && c.transitionIn !== 'cut').length}`,
    );
  } catch (e: any) {
    const msg = e?.message || String(e);
    db.prepare(
      `UPDATE exports SET status='failed', error_msg=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(msg.slice(0, 1000), exportId);
    console.error('[export]', exportId, 'failed:', msg);
  }
}
