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

/**
 * 用 concat demuxer 拼接 N 段视频。
 * 注意：所有片段必须有相同分辨率/帧率/编码，否则需要先 normalize。
 * 这里我们假定都是 ffmpeg 自己生成或来自同一个模型，编码一致；
 * 不一致时退回 -filter_complex concat 路线（更慢但更稳）。
 */
export async function concatClips(opts: {
  inputPaths: string[];
  outputPath: string;
  /** 强制重编码（兼容性更好），默认 true */
  reencode?: boolean;
}): Promise<void> {
  if (!opts.inputPaths.length) throw new Error('concatClips: 输入列表为空');
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  if (opts.reencode === false) {
    // 老式 concat demuxer
    const listFile = opts.outputPath + '.list';
    const list = opts.inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    writeFileSync(listFile, list);
    try {
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', opts.outputPath]);
    } finally {
      try { unlinkSync(listFile); } catch (_) {}
    }
    return;
  }

  // filter_complex：所有片段都重编码到同一规格
  const args: string[] = ['-y'];
  for (const p of opts.inputPaths) args.push('-i', p);
  const n = opts.inputPaths.length;
  const filter = Array.from({ length: n }, (_, i) =>
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`,
  ).join(';') + ';' + Array.from({ length: n }, (_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[outv]`;
  args.push(
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
    opts.outputPath,
  );
  await run(args);
}

/**
 * 给视频盖一条 BGM。视频原音可选保留（混音）或丢弃（直接换）。
 */
export async function addBgm(opts: {
  videoPath: string;
  bgmPath: string;
  outputPath: string;
  /** BGM 音量（0-1），默认 0.6 */
  bgmVolume?: number;
  /** 是否保留视频原声，默认 false（直接换 BGM） */
  keepOriginal?: boolean;
}): Promise<void> {
  const vol = opts.bgmVolume ?? 0.6;
  mkdirSync(dirname(opts.outputPath), { recursive: true });
  const args = ['-y', '-i', opts.videoPath, '-i', opts.bgmPath];
  if (opts.keepOriginal) {
    // 混音：原声 + BGM
    args.push(
      '-filter_complex',
      `[1:a]volume=${vol}[bgm];[0:a][bgm]amix=inputs=2:duration=shortest:dropout_transition=2[a]`,
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-shortest',
      opts.outputPath,
    );
  } else {
    args.push(
      '-filter_complex', `[1:a]volume=${vol}[a]`,
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-shortest',
      opts.outputPath,
    );
  }
  await run(args);
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
