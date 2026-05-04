import { NextRequest } from 'next/server';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BGM_DIR = join(process.cwd(), 'data', 'bgm');
const META_FILE = join(BGM_DIR, '_meta.json');

/**
 * 剪辑工作台 BGM 库。
 *
 * 协议：
 *   返回 { tracks: [{ id, name, category, bpm, duration, file: true, url }] }，
 *   兼容老调用同时回 items。前端 _loadBgmLibrary 读 resp.tracks。
 *
 * 数据来源：
 *   1) data/bgm/ 下所有 mp3/wav/m4a/aac/ogg 文件——管理员可以直接拖音乐进去。
 *   2) data/bgm/_meta.json：每个文件对应的 { category, bpm, name } 元数据。
 *      没匹配到时按文件名前缀（如 calm_01.mp3 → category=calm）猜，再不行就归到 calm。
 *   3) 如果整个目录还没任何音频文件，**首次访问时自动调 ffmpeg 合成 8 段不同情绪基调
 *      的简易 BGM**（程序化生成的氛围 pad，不会和真专业 BGM 一样好听，但可用），
 *      避免新部署时剪辑导出永远没背景音乐。
 */

/**
 * 每个种子轨 = 一组和弦进行（4 个和弦×7s = 28s 循环）+ bass 律动 + 高音 arpeggio。
 * 比上一版静态三和弦"嗡嗡响"听起来更像真音乐。
 *
 * chords: [[freq1,freq2,freq3], ...]  四组三音和弦（已按情绪调好色彩）
 * bassFreq: 每拍打一下的 bass 根音
 * arpFreqs: 4 个高音 arpeggio 音（按拍子轮播）
 * beatSec: bass / arp 的间隔（秒），≈ 60/bpm
 */
type SeedTrack = {
  category: string;
  bpm: number;
  name: string;
  chords: number[][];
  bassFreq: number;
  arpFreqs: number[];
  beatSec: number;
};

const SEED_TRACKS: SeedTrack[] = [
  // C - G - Am - F：经典励志进行
  { category: 'hopeful', bpm: 90, name: '希望 · 晨光', beatSec: 0.667,
    chords: [[261.63, 329.63, 392.0], [196.0, 246.94, 293.66], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63]],
    bassFreq: 65.41, arpFreqs: [523.25, 659.25, 783.99, 659.25] },
  // Am - F - C - G：内省 + 温柔
  { category: 'calm', bpm: 60, name: '平静 · 海面', beatSec: 1.0,
    chords: [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [261.63, 329.63, 392.0], [196.0, 246.94, 293.66]],
    bassFreq: 110.0, arpFreqs: [440.0, 523.25, 659.25, 523.25] },
  // Dm - Bb - F - C：浪漫
  { category: 'romantic', bpm: 75, name: '浪漫 · 旧木屋', beatSec: 0.8,
    chords: [[293.66, 349.23, 440.0], [233.08, 293.66, 349.23], [349.23, 440.0, 523.25], [261.63, 329.63, 392.0]],
    bassFreq: 73.42, arpFreqs: [587.33, 698.46, 880.0, 698.46] },
  // Em - C - D - Em：紧张 / 焦虑
  { category: 'tense', bpm: 110, name: '紧张 · 追逐', beatSec: 0.545,
    chords: [[164.81, 196.0, 246.94], [130.81, 164.81, 196.0], [146.83, 185.0, 220.0], [164.81, 196.0, 246.94]],
    bassFreq: 82.41, arpFreqs: [329.63, 392.0, 493.88, 392.0] },
  // E5 - A5 - D5 - E5：动作（power chords，五度堆叠）
  { category: 'action', bpm: 130, name: '动作 · 高速', beatSec: 0.462,
    chords: [[164.81, 246.94, 329.63], [220.0, 329.63, 440.0], [146.83, 220.0, 293.66], [164.81, 246.94, 329.63]],
    bassFreq: 82.41, arpFreqs: [329.63, 440.0, 587.33, 493.88] },
  // Am - Em - F - Dm：忧伤
  { category: 'sad', bpm: 56, name: '悲伤 · 雨夜', beatSec: 1.07,
    chords: [[220.0, 261.63, 329.63], [164.81, 196.0, 246.94], [174.61, 220.0, 261.63], [146.83, 174.61, 220.0]],
    bassFreq: 73.42, arpFreqs: [349.23, 440.0, 523.25, 440.0] },
  // C - Em - F - G：史诗
  { category: 'epic', bpm: 100, name: '史诗 · 旷野', beatSec: 0.6,
    chords: [[130.81, 164.81, 196.0], [82.41, 123.47, 164.81], [87.31, 130.81, 174.61], [98.0, 146.83, 196.0]],
    bassFreq: 49.0, arpFreqs: [261.63, 329.63, 392.0, 493.88] },
  // F#m - D - A - E：神秘
  { category: 'mysterious', bpm: 80, name: '神秘 · 雾林', beatSec: 0.75,
    chords: [[185.0, 220.0, 277.18], [146.83, 185.0, 220.0], [220.0, 277.18, 329.63], [164.81, 207.65, 246.94]],
    bassFreq: 92.5, arpFreqs: [369.99, 440.0, 554.37, 440.0] },
];

const CHORD_DUR = 7;          // 每个和弦持续 7s
const PROGRESSION_DUR = CHORD_DUR * 4; // 28s 一轮和弦进行

function ffmpegPath(): string { return process.env.FFMPEG_PATH || 'ffmpeg'; }

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); if (stderr.length > 50_000) stderr = stderr.slice(-25_000); });
    child.on('error', (e) => reject(new Error(`spawn ffmpeg failed: ${e.message}`)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-1500)}`)));
  });
}

/**
 * 渲一段 BGM：4 个和弦顺序播放（chord pad）+ bass pluck on each beat + 高音 arpeggio
 */
async function seedOneTrack(t: SeedTrack, outPath: string) {
  const { chords, bassFreq, arpFreqs, beatSec } = t;
  const totalDur = PROGRESSION_DUR;

  const inputs: string[] = ['-y'];
  // 12 个 sine 输入：4 chord × 3 voice
  for (let cIdx = 0; cIdx < 4; cIdx++) {
    for (let vIdx = 0; vIdx < 3; vIdx++) {
      inputs.push('-f', 'lavfi', '-t', String(CHORD_DUR), '-i', `sine=frequency=${chords[cIdx][vIdx]}:sample_rate=48000`);
    }
  }
  // bass pluck（每拍一下，exp 包络让它有"叮"的感觉）
  // 注意：aevalsrc 第一个位置参数叫 exprs（不是 expr），filter graph 里 ',' 必须 \, 转义。
  inputs.push(
    '-f', 'lavfi', '-t', String(totalDur), '-i',
    `aevalsrc=exprs=0.55*sin(2*PI*${bassFreq}*t)*exp(-3*mod(t\\,${beatSec})):sample_rate=48000`,
  );
  // 高音 arpeggio：4 个音轮播（i = floor(mod(t, 4*beat)/beat)，用 if 嵌套切换频率）
  const f = arpFreqs;
  const m4 = (4 * beatSec).toFixed(4);
  const m1 = (1 * beatSec).toFixed(4);
  const m2 = (2 * beatSec).toFixed(4);
  const m3 = (3 * beatSec).toFixed(4);
  const env = (beatSec / 2).toFixed(4);
  const arpExpr =
    `if(lt(mod(t\\,${m4})\\,${m1})\\,sin(2*PI*${f[0]}*t)\\,` +
    `if(lt(mod(t\\,${m4})\\,${m2})\\,sin(2*PI*${f[1]}*t)\\,` +
    `if(lt(mod(t\\,${m4})\\,${m3})\\,sin(2*PI*${f[2]}*t)\\,sin(2*PI*${f[3]}*t))))`;
  inputs.push(
    '-f', 'lavfi', '-t', String(totalDur), '-i',
    `aevalsrc=exprs=0.28*${arpExpr}*exp(-5*mod(t\\,${env})):sample_rate=48000`,
  );

  // 滤镜：每个和弦 = 3 voice amix（带轻 LFO 模拟弦乐颤音），4 个和弦 acrossfade 连成进行
  const parts: string[] = [];
  for (let cIdx = 0; cIdx < 4; cIdx++) {
    const v0 = cIdx * 3;
    parts.push(
      `[${v0}:a][${v0 + 1}:a][${v0 + 2}:a]amix=inputs=3:weights=1 0.7 0.55,` +
        `tremolo=f=4:d=0.15,` +
        `volume=0.32,` +
        `afade=t=in:st=0:d=0.4,afade=t=out:st=${CHORD_DUR - 0.4}:d=0.4[c${cIdx}]`,
    );
  }
  parts.push(`[c0][c1]acrossfade=d=0.4:c1=tri:c2=tri[c01]`);
  parts.push(`[c01][c2]acrossfade=d=0.4:c1=tri:c2=tri[c012]`);
  parts.push(`[c012][c3]acrossfade=d=0.4:c1=tri:c2=tri[chordpad]`);

  // bass 和 arpeggio 的索引：12 个 chord 输入 + 1 bass + 1 arp = idx 12, 13
  parts.push(`[12:a]volume=1.0,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[bass]`);
  parts.push(`[13:a]volume=0.6,aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000[arp]`);
  parts.push(
    `[chordpad][bass][arp]amix=inputs=3:duration=first:weights=1 1 0.7,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,` +
      `afade=t=in:st=0:d=1.5,afade=t=out:st=${totalDur - 1.5}:d=1.5,` +
      `loudnorm=I=-20:TP=-2:LRA=11[a]`,
  );

  const args = [
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[a]',
    '-t', String(totalDur),
    '-c:a', 'libmp3lame', '-b:a', '160k',
    outPath,
  ];
  await runFfmpeg(args);
}

async function ensureSeedBgm() {
  if (!existsSync(BGM_DIR)) mkdirSync(BGM_DIR, { recursive: true });
  // 进程级互斥：多个请求并发进入时只让第一个真正跑 seed，其他 await 同一个 Promise。
  // 不然会同时 spawn 8 个 ffmpeg × N 请求，CPU 打满且 _meta.json 互相覆盖。
  const g = globalThis as any;
  if (g.__qd_bgm_seed_inflight__) return g.__qd_bgm_seed_inflight__;
  g.__qd_bgm_seed_inflight__ = (async () => {
    try {
      await seedBgmImpl();
    } finally {
      g.__qd_bgm_seed_inflight__ = null;
    }
  })();
  return g.__qd_bgm_seed_inflight__;
}

async function seedBgmImpl() {
  const existingFiles = new Set(
    readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f))
  );

  // 旧版只在"完全空目录"时 seed —— 一旦上一次 seed 全失败 + meta 写成 {}，
  // 下次访问看到 _meta.json 但目录还是空的还会再走一次空查询然后什么都没有。
  // 现在改成：按 SEED_TRACKS 一个一个 check，缺哪个补哪个，写 meta 时合并已有。
  let meta: Record<string, any> = {};
  try { if (existsSync(META_FILE)) meta = JSON.parse(readFileSync(META_FILE, 'utf-8') || '{}'); } catch (_) { meta = {}; }

  let seededAny = false;
  let firstErr: Error | null = null;
  for (const t of SEED_TRACKS) {
    const id = `${t.category}_seed.mp3`;
    const path = join(BGM_DIR, id);
    if (existingFiles.has(id)) {
      // 已有文件直接补 meta（防止 meta 漏 entry 导致 name/bpm 全 undefined）
      if (!meta[id]) meta[id] = { category: t.category, bpm: t.bpm, name: t.name };
      continue;
    }
    try {
      await seedOneTrack(t, path);
      meta[id] = { category: t.category, bpm: t.bpm, name: t.name };
      seededAny = true;
      console.log('[bgm seed]', id, 'ok');
    } catch (e: any) {
      console.warn('[bgm seed] failed:', id, (e && e.message) || e);
      if (!firstErr) firstErr = e;
    }
  }
  try { writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8'); } catch (_) {}

  // 如果一首都没 seed 成功（典型场景：服务器 PATH 找不到 ffmpeg），把第一个 error 抛出去，
  // 让外层 GET handler 把消息回给前端 toast 而不是返回空 list 让用户摸不着头脑。
  if (!seededAny && readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)).length === 0) {
    throw firstErr || new Error('seed produced no files');
  }
}

function loadMeta(): Record<string, any> {
  try {
    if (!existsSync(META_FILE)) return {};
    return JSON.parse(readFileSync(META_FILE, 'utf-8') || '{}');
  } catch { return {}; }
}

function guessCategory(filename: string): string {
  const m = /^([a-z]+)[_\-]/i.exec(filename);
  const allowed = ['calm', 'tense', 'action', 'romantic', 'sad', 'epic', 'mysterious', 'hopeful'];
  if (m && allowed.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  return 'calm';
}

async function probeDuration(path: string): Promise<number> {
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
      resolve(Number.isFinite(n) ? n : 0);
    });
  });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  if (!existsSync(BGM_DIR)) mkdirSync(BGM_DIR, { recursive: true });

  // 没文件就 seed 一批程序化 BGM；缺一部分也补齐
  let firstScan = readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
  let seedErr: any = null;
  if (firstScan.length < SEED_TRACKS.length) {
    try {
      await ensureSeedBgm();
    } catch (e: any) {
      seedErr = e;
      console.warn('[bgm-library] seed failed:', (e && e.message) || e);
    }
    firstScan = readdirSync(BGM_DIR).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f));
  }

  // 如果 seed 完依旧空 → 把错误回给前端，前端可以 toast 提示
  if (!firstScan.length) {
    return jsonError(
      'BGM 库为空且自动生成失败：' + (seedErr?.message || '未知错误') +
        '。请把任意 mp3 / wav 放进 data/bgm/ 目录，或手动安装 ffmpeg。',
      500
    );
  }

  const meta = loadMeta();
  const tracks: any[] = [];
  for (const f of firstScan) {
    const path = join(BGM_DIR, f);
    const stat = statSync(path);
    const m = meta[f] || {};
    const dur = await probeDuration(path);
    tracks.push({
      id: f,
      name: String(m.name || f.replace(/\.[^.]+$/, '')),
      category: String(m.category || guessCategory(f)),
      bpm: Number(m.bpm) || 90,
      duration: Math.round(dur),
      file: true,
      url: `/api/edit/bgm/${encodeURIComponent(f)}`,
      sizeBytes: stat.size,
    });
  }

  // 排序：与剧情曲线适配的 hopeful/calm 优先，紧张/动作其次，悲伤/史诗最后
  const order = ['hopeful', 'calm', 'romantic', 'mysterious', 'tense', 'action', 'epic', 'sad'];
  tracks.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));

  return jsonOk({ tracks, items: tracks, total: tracks.length });
}
