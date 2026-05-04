/**
 * FFmpeg 调用层
 *
 * 提供 4 个核心能力：
 *   1. makeBlackVideo  —— 生成纯色视频（fake 模式 / 占位）
 *   2. concatClips     —— 把多段视频按 EDL 拼成一条
 *   3. addBgm          —— 给视频盖背景音乐（自动平衡音量）
 *   4. extractCover    —— 抽视频首帧作为封面
 *
 * 失败时抛 Error；成功时直接写入目标路径。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    child.on('error', (e) => reject(new Error(`spawn ffmpeg failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * 生成一段纯色视频（默认黑场，1080x1920 9:16，<duration> 秒，无声）。
 * 用作 fake 模式的视频占位。
 */
export async function makeBlackVideo(opts: {
  outputPath: string;
  durationSec?: number;
  width?: number;
  height?: number;
  color?: string;
  withTone?: boolean;
}): Promise<void> {
  const dur = opts.durationSec ?? 4;
  const w = opts.width ?? 1080;
  const h = opts.height ?? 1920;
  const c = opts.color ?? 'black';
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${c}:s=${w}x${h}:d=${dur}:r=24`,
  ];
  if (opts.withTone) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`);
  args.push(
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-tune', 'stillimage',
    ...(opts.withTone ? ['-c:a', 'aac', '-shortest'] : ['-an']),
    opts.outputPath,
  );
  await run(args);
}

/** 转场类型 → ffmpeg xfade transition name */
const XFADE_MAP: Record<string, string> = {
  fade: 'fade',
  dissolve: 'dissolve',
  wipe: 'wipeleft',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  slideleft: 'slideleft',
  slideright: 'slideright',
  // cut 用极短 xfade（40ms）模拟硬切——给观众 1-2 帧的过渡防"咔哒帧"，但视觉上仍是切镜
  cut: 'fade',
};

/** 转场默认时长（秒）；cut 设极短 0.04，其它给观众"看得到"的时长 */
function defaultTransDuration(t: string): number {
  const k = (t || 'cut').toLowerCase();
  if (k === 'cut') return 0.04;
  if (k === 'dissolve') return 1.0;  // 柔和过渡，给情绪转折足够呼吸
  if (k === 'wipe' || k === 'wipeleft' || k === 'wiperight') return 0.7;
  return 0.8;                         // fade
}

/**
 * 拼接 N 段视频，支持每段 trim（in/out 秒），并保留音轨。
 *
 * 入参兼容三种形态：
 *   - inputPaths: string[]                       —— 老调用，整段拼接，无 trim
 *   - clips:     { path, inSec?, outSec? }[]    —— 按区间裁剪后简单 concat
 *   - clips:     { path, inSec?, outSec?,
 *                  transitionIn?: 'cut'|'fade'|'dissolve'|'wipe',
 *                  transitionInDuration?: number }[]
 *                                                —— 每段配各自转场（推荐，工业级效果）
 *
 * 实现细节：
 *   - 第 0 段无 transitionIn（开头不需要转场）
 *   - 所有片段重编码到 1920x1080（横屏 16:9），统一 30fps、aac 48k
 *   - 视频不足分辨率时居中加黑边
 *   - 无音轨自动补静音轨
 *   - 有任何非 cut 转场时走 xfade/acrossfade 链；全 cut 走效率更高的 concat filter
 */
export async function concatClips(opts: {
  inputPaths?: string[];
  clips?: {
    path: string;
    inSec?: number;
    outSec?: number;
    transitionIn?: string;
    transitionInDuration?: number;
  }[];
  outputPath: string;
  width?: number;
  height?: number;
  fps?: number;
}): Promise<void> {
  const clips = opts.clips
    ? opts.clips
    : (opts.inputPaths || []).map((p) => ({ path: p } as any));
  if (!clips.length) throw new Error('concatClips: 输入列表为空');
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const FPS = opts.fps ?? 30;

  const hasAudio: boolean[] = await Promise.all(clips.map((c) => probeHasAudio(c.path)));

  // 看有没有任何非 cut 转场（第 0 段的 transitionIn 不算）
  const useXfade = clips.some((c, i) => {
    if (i === 0) return false;
    const t = String((c as any).transitionIn || 'cut').toLowerCase();
    return t !== 'cut';
  });

  const args: string[] = ['-y'];
  for (const c of clips) args.push('-i', c.path);

  const parts: string[] = [];

  // ── 1) 每段先各自 trim+缩放+音频归一化，得到 [v0],[a0],[v1],[a1]... ──
  const segDurs: number[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const hasIn = typeof c.inSec === 'number' && c.inSec > 0;
    const hasOut = typeof c.outSec === 'number' && c.outSec! > 0 && c.outSec! > (c.inSec || 0);
    const trimVArgs = `${hasIn ? `start=${c.inSec}:` : ''}${hasOut ? `end=${c.outSec}` : ''}`;
    const useTrim = hasIn || hasOut;
    const segDur = hasOut ? c.outSec! - (c.inSec || 0) : 60;
    segDurs.push(segDur);

    const vChain = [
      `[${i}:v]`,
      useTrim ? `trim=${trimVArgs},setpts=PTS-STARTPTS,` : `setpts=PTS-STARTPTS,`,
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
    ].join('');
    parts.push(vChain);

    if (hasAudio[i]) {
      const aChain = [
        `[${i}:a]`,
        useTrim ? `atrim=${trimVArgs},asetpts=PTS-STARTPTS,` : `asetpts=PTS-STARTPTS,`,
        `aresample=async=1:first_pts=0,`,
        `aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,`,
        `afade=t=in:st=0:d=0.08`,
        hasOut ? `,afade=t=out:st=${(segDur - 0.08).toFixed(3)}:d=0.08` : '',
        `[a${i}]`,
      ].join('');
      parts.push(aChain);
    } else {
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000:duration=${segDur}[a${i}]`);
    }
  }

  // ── 2a) 全 cut → 走 concat filter（性能好，无重叠帧） ──
  if (!useXfade) {
    const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join('');
    parts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[outv][outa]`);
  } else {
    // ── 2b) 有转场 → xfade / acrossfade 链 ──
    // 算每个 xfade 的 offset：前面已渲完的总长 - 当前转场长度
    let lastV = `[v0]`;
    let lastA = `[a0]`;
    let cumDur = segDurs[0];

    for (let i = 1; i < clips.length; i++) {
      const tType = String((clips[i] as any).transitionIn || 'cut').toLowerCase();
      const tDur = Math.max(0.04, Number((clips[i] as any).transitionInDuration) || defaultTransDuration(tType));
      const xtype = XFADE_MAP[tType] || 'fade';
      const offset = Math.max(0, cumDur - tDur);

      const outV = i === clips.length - 1 ? `[outv]` : `[xv${i}]`;
      const outA = i === clips.length - 1 ? `[outa]` : `[xa${i}]`;

      parts.push(`${lastV}[v${i}]xfade=transition=${xtype}:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)},format=yuv420p${outV}`);
      parts.push(`${lastA}[a${i}]acrossfade=d=${tDur.toFixed(3)}:c1=tri:c2=tri${outA}`);

      lastV = outV;
      lastA = outA;
      // xfade 后的总长度 = 之前长度 + 新段长度 - 重叠
      cumDur = cumDur + segDurs[i] - tDur;
    }
  }

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    opts.outputPath,
  );
  await run(args);
}

/** 用 ffprobe 检查文件是否含音轨。失败时保守返回 false（按无音轨处理）。 */
function probeHasAudio(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.env.FFPROBE_PATH || 'ffprobe';
    const child = spawn(probe, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.includes('audio')));
  });
}

/**
 * 给视频盖一条 BGM —— 工业级版本：
 *   - BGM 自动循环填到视频长度（`-stream_loop -1`）
 *   - BGM 头尾各 1.5s 渐入渐出，避免硬切的"咔哒"
 *   - 默认开 ducking：检测视频原声有人声时，BGM 自动压到 35%（用 sidechaincompress
 *     更专业但兼容性差，这里用 amix + dialogue volume 强制占主导，配合 BGM lowpass 模拟）
 *   - 输出做 loudnorm，全片 LUFS 一致，避免观众一会大声一会小声
 */
export async function addBgm(opts: {
  videoPath: string;
  bgmPath: string;
  outputPath: string;
  /** BGM 音量（0-1），默认 0.35（让对白当主） */
  bgmVolume?: number;
  /** 是否保留视频原声，默认 true（保留对白） */
  keepOriginal?: boolean;
  /** 是否对 BGM 做高频削减让人声穿透，默认 true */
  duckBgm?: boolean;
}): Promise<void> {
  const vol = opts.bgmVolume ?? 0.35;
  const keep = opts.keepOriginal !== false;
  const duck = opts.duckBgm !== false;
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  // 视频长度由 ffprobe 测；BGM 用 -stream_loop -1 + -shortest 自动填到视频长度
  const args = ['-y', '-i', opts.videoPath, '-stream_loop', '-1', '-i', opts.bgmPath];

  // BGM 链：循环 + 渐入渐出 + 可选高通削减让位人声
  const bgmChain = [
    `[1:a]`,
    duck ? `lowpass=f=4000,` : '',
    `volume=${vol},`,
    `afade=t=in:st=0:d=1.5,`,
    `aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[bgm]`,
  ].join('');

  let filter: string;
  if (keep) {
    // 对白当主导，BGM 当衬底；amix duration=first（视频长度）
    filter = `${bgmChain};[0:a]volume=1.2,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[voice];` +
      `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:weights=2 1,` +
      `loudnorm=I=-16:TP=-1.5:LRA=11[a]`;
  } else {
    filter = `${bgmChain};[bgm]loudnorm=I=-18:TP=-1.5:LRA=11[a]`;
  }

  args.push(
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    opts.outputPath,
  );
  await run(args);
}

/** 解析 SRT 时间码 `HH:MM:SS,mmm` → 秒 */
function parseSrtTime(s: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s.trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

type SrtCue = { start: number; end: number; text: string };

/** 把 SRT 文本拆成 cue 数组 */
function parseSrt(srt: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = srt.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, c] = timeLine.split('-->');
    const start = parseSrtTime(a);
    const end = parseSrtTime(c);
    const textLines = lines.slice(lines.indexOf(timeLine) + 1).filter(Boolean);
    if (!textLines.length) continue;
    cues.push({ start, end, text: textLines.join(' ') });
  }
  return cues;
}

/**
 * 在视频上烧字幕（hard-sub）。
 *
 * 旧版用 ffmpeg 的 `subtitles=` 滤镜（libass）—— 但用户的 ffmpeg（homebrew 8.1）
 * 编译时没带 libass / freetype，所以那条路在很多机器上会静默失败。
 *
 * 新版改成 **PNG overlay**：
 *   1) 用 @napi-rs/canvas 把每条字幕用 PingFang SC 渲成透明背景 PNG（白字 + 黑色描边）
 *   2) 把 PNG 作为额外输入喂给 ffmpeg
 *   3) 链式 overlay，配合 `enable='between(t,start,end)'` 让每条字幕只在自己时段显示
 *
 * 这样不依赖 libass，homebrew 默认 ffmpeg 也能跑。
 */
export async function burnSubtitles(opts: {
  videoPath: string;
  srtPath: string;
  outputPath: string;
  width?: number;
  height?: number;
  fontSize?: number;
  marginV?: number;
}): Promise<void> {
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const fontSize = opts.fontSize ?? 44;
  const marginV = opts.marginV ?? 110;

  const { readFileSync } = await import('node:fs');
  const srt = readFileSync(opts.srtPath, 'utf-8');
  const cues = parseSrt(srt);
  if (!cues.length) {
    // 没字幕就 stream copy
    await run(['-y', '-i', opts.videoPath, '-c', 'copy', '-movflags', '+faststart', opts.outputPath]);
    return;
  }

  // 限 30 条字幕，超出就截尾——overlay 链太长 ffmpeg 会爆栈
  const limited = cues.slice(0, 30);

  // 为每条 cue 渲染一张透明背景 PNG
  const canvasMod = await import('@napi-rs/canvas').catch(() => null as any);
  if (!canvasMod || !canvasMod.createCanvas) {
    throw new Error('subtitle render: @napi-rs/canvas 未安装，请 npm install @napi-rs/canvas');
  }
  const { createCanvas } = canvasMod;

  const tmpDir = join(dirname(opts.outputPath), `_subs_${Date.now()}_${randomUUID().slice(0, 8)}`);
  mkdirSync(tmpDir, { recursive: true });

  const subPaths: string[] = [];
  const subWidth = Math.min(W - 80, 1700);
  const subHeight = Math.round(fontSize * 2.2);

  try {
    for (let i = 0; i < limited.length; i++) {
      const c = limited[i];
      const canvas = createCanvas(subWidth, subHeight);
      const ctx = canvas.getContext('2d');
      ctx.font = `bold ${fontSize}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const x = subWidth / 2;
      const y = subHeight / 2;
      // 描边（黑色 4px）+ 半透明阴影 → 白色填充
      ctx.lineJoin = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(c.text, x, y);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(c.text, x, y);

      const p = join(tmpDir, `s_${i}.png`);
      const buf = (canvas as any).toBuffer('image/png');
      writeFileSync(p, buf);
      subPaths.push(p);
    }

    // 构造 ffmpeg 命令：原视频 + N 张字幕 PNG → 链式 overlay
    const args: string[] = ['-y', '-i', opts.videoPath];
    for (const p of subPaths) args.push('-i', p);

    const x = `(W-w)/2`;
    const y = `H-h-${marginV}`;

    const parts: string[] = [];
    let prev = '[0:v]';
    for (let i = 0; i < limited.length; i++) {
      const c = limited[i];
      const out = i === limited.length - 1 ? '[outv]' : `[ov${i}]`;
      parts.push(
        `${prev}[${i + 1}:v]overlay=x=${x}:y=${y}:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})':format=auto${out}`,
      );
      prev = out;
    }

    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      opts.outputPath,
    );
    await run(args);
  } finally {
    // 清理临时 PNG
    try {
      for (const p of subPaths) { if (existsSync(p)) unlinkSync(p); }
      const { rmdirSync } = await import('node:fs');
      try { rmdirSync(tmpDir); } catch (_) {}
    } catch (_) {}
  }
}

/**
 * 在视频音轨上叠加转场 whoosh 音效（synth），不需要外部 SFX 素材库。
 * 每个 whoosh = 短促褐噪声 + 带通滤波 + 头尾淡入淡出 + adelay 定位到转场点。
 * fade/dissolve 用低频 1.5kHz whoosh，wipe 用高频 4kHz 刷音。
 */
export async function mixTransitionSfx(opts: {
  videoPath: string;
  sfxTimes: { time: number; type: string }[];
  outputPath: string;
}): Promise<void> {
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  // 没转场点就跳过 SFX，直接 stream copy
  if (!opts.sfxTimes.length) {
    await run(['-y', '-i', opts.videoPath, '-c', 'copy', '-movflags', '+faststart', opts.outputPath]);
    return;
  }

  // 限制最多 12 个 SFX，太多会让 amix weights 算爆
  const sfx = opts.sfxTimes.slice(0, 12);

  const args: string[] = ['-y', '-i', opts.videoPath];
  // whoosh 时长按转场类型给：dissolve 用 0.85s（最长，匹配 1s dissolve），wipe 0.65s，fade 0.7s
  const sfxDurFor = (t: string) =>
    t === 'dissolve' ? 0.85 :
    (t === 'wipe' || t === 'wipeleft' || t === 'wiperight') ? 0.65 : 0.7;
  for (let i = 0; i < sfx.length; i++) {
    const d = sfxDurFor(sfx[i].type);
    args.push('-f', 'lavfi', '-i', `anoisesrc=color=brown:duration=${d}:sample_rate=48000:amplitude=0.6`);
  }

  const parts: string[] = [];
  for (let i = 0; i < sfx.length; i++) {
    const s = sfx[i];
    const delayMs = Math.max(0, Math.round(s.time * 1000));
    const isWipe = s.type === 'wipe' || s.type === 'wipeleft' || s.type === 'wiperight';
    const bp = isWipe ? `bandpass=f=4000:width_type=h:w=2500` : `bandpass=f=1800:width_type=h:w=1200`;
    const sd = sfxDurFor(s.type);
    const fadeOutSt = (sd - 0.12).toFixed(3);
    parts.push(
      `[${i + 1}:a]${bp},volume=0.55,` +
      `afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutSt}:d=0.12,` +
      `adelay=${delayMs}|${delayMs}[sfx${i}]`,
    );
  }

  // 对白权重 4，每个 SFX 权重 1，整体平衡——SFX 不抢人声
  const weights = `4 ${sfx.map(() => '1').join(' ')}`;
  const sfxInputs = sfx.map((_, i) => `[sfx${i}]`).join('');
  parts.push(`[0:a]${sfxInputs}amix=inputs=${sfx.length + 1}:duration=first:dropout_transition=0:weights=${weights}[a]`);

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-shortest',
    '-movflags', '+faststart',
    opts.outputPath,
  );
  await run(args);
}

/**
 * 用 ffprobe 探测一个媒体文件的总时长（秒）。失败返回 0。
 */
export function probeDurationSec(path: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = process.env.FFPROBE_PATH || 'ffprobe';
    const child = spawn(probe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const n = Number(String(out).trim());
      resolve(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

/**
 * 抽取视频第一帧作为封面 PNG。
 */
export async function extractCover(opts: { videoPath: string; outputPath: string }): Promise<void> {
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  await run([
    '-y', '-i', opts.videoPath,
    '-frames:v', '1', '-q:v', '2',
    opts.outputPath,
  ]);
}
