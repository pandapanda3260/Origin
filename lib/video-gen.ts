/**
 * 视频生成统一封装。
 *
 * 真接 OpenAI Sora：
 *   1) POST /v1/videos                   → { id, status:'queued' }
 *   2) GET  /v1/videos/{id}              → { id, status:'in_progress'|'completed'|'failed', progress }
 *   3) GET  /v1/videos/{id}/content      → 二进制 mp4
 * 协议参考：https://platform.openai.com/docs/api-reference/videos
 *
 * 兼容其他 OpenAI 风格中转/Seedance 的话，通过 settings.models.video.{baseUrl,apiKey,model} 切走。
 *
 * fake 兜底：调 ffmpeg 生成一段 4s 黑场（带 440Hz 提示音）的 mp4，
 *   保证前端 <video> 能正常播放并展示进度条 / 封面。
 */

import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig } from './llm';
import { getDb } from './db';
import type { UserRow } from './db';
import { makeBlackVideo, extractCover } from './ffmpeg';
import { generateImage } from './image-gen';

export type VideoGenInput = {
  prompt: string;
  size?: '1080x1920' | '1920x1080' | '1024x1024';
  /** 画面比例，如 "16:9" / "9:16" / "1:1"，优先级高于 size */
  ratio?: string;
  durationSec?: number;
  projectId?: string;
  groupIdx?: number;
  /** 角色台词（必须严格按此演绎/配音）。grok-video 支持音画同出。 */
  dialogue?: string;
  /** 用于 fake 模式做封面的素材描述 */
  coverHint?: string;
};

/**
 * 把"视频提示词页"生成的长结构化中文 prompt（含"运镜系统/角色/场景/0-Ns/基调/约束/音障"）
 * 压缩成 grok-video 友好的简洁单段描述。
 *
 * grok-video 对长 prompt 控制力差，>500 字基本只会抓最显著的关键词（如"叹气"），
 * 忽略大部分场景/角色细节。压缩后只保留视觉相关段落、限到 ~250 字以内。
 */
export function compressForGrokVideo(rawPrompt: string, maxChars = 320): string {
  if (!rawPrompt) return '';
  const txt = rawPrompt.replace(/\r/g, '');
  // 把整段按"段落标题/时间标签"切成 K→V
  const SECTION_HEADERS = ['运镜系统', '角色', '场景', '基调', '约束', '音障'];
  const TIME_RE = /^\s*\d+(?:\.\d+)?\s*[-–~～至到]\s*\d+(?:\.\d+)?\s*s?\s*$/;
  const lines = txt.split(/\n+/);
  const sections: Array<{ key: string; body: string }> = [];
  let currentKey: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (currentKey && buf.length) {
      sections.push({ key: currentKey, body: buf.join(' ').trim() });
    }
    buf = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (SECTION_HEADERS.includes(t) || TIME_RE.test(t)) {
      flush();
      currentKey = t;
    } else if (currentKey) {
      buf.push(t);
    }
  }
  flush();

  // 抽出关键段
  const get = (k: string) => sections.find(s => s.key === k)?.body || '';
  const scene = get('场景');
  const character = get('角色');
  const camera = get('运镜系统');
  const timeline = sections.find(s => TIME_RE.test(s.key))?.body || '';

  // 拼接顺序：镜头运镜 → 场景 → 角色外形 → 时间轴动作（去掉⟦⟧装饰）
  const cleanTimeline = timeline.replace(/[⟦⟧【】「」]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [camera, scene, character, cleanTimeline].filter(Boolean);
  let combined = parts.join('。').replace(/[。；][。；]+/g, '。');
  combined = combined.replace(/[⟦⟧【】]/g, '').replace(/\s+/g, ' ').trim();

  // 完全没切到段：直接截断原文
  if (!combined) combined = txt.replace(/\s+/g, ' ').slice(0, maxChars);

  if (combined.length > maxChars) {
    // 在 maxChars 附近找一个标点截断，避免半句话+省略号让模型迷糊
    const cut = combined.slice(0, maxChars);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
    combined = lastPunct > maxChars * 0.6 ? cut.slice(0, lastPunct + 1) : cut;
  }
  return combined;
}

/** 把 ratio 字符串规范成统一格式 + size 映射 */
function normalizeRatio(ratio?: string): { ratio: string; size: '1080x1920' | '1920x1080' | '1024x1024' } {
  const r = (ratio || '').trim();
  if (r === '16:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '9:16') return { ratio: '9:16', size: '1080x1920' };
  if (r === '1:1') return { ratio: '1:1', size: '1024x1024' };
  // 4:3 / 3:4 / 21:9 等 grok 暂不支持，回退到 16:9 横版
  if (r === '4:3' || r === '21:9') return { ratio: '16:9', size: '1920x1080' };
  if (r === '3:4') return { ratio: '9:16', size: '1080x1920' };
  // 没传 ratio 时按 size 反推
  return { ratio: '16:9', size: '1920x1080' };
}

export type VideoGenResult = {
  taskId: string;
  status: 'completed' | 'failed';
  url: string;
  coverUrl: string | null;
  durationSec: number;
  mode: 'real' | 'fake';
};

const DATA_DIR = join(process.cwd(), 'data');
const VIDEOS_DIR = join(DATA_DIR, 'videos');
mkdirSync(VIDEOS_DIR, { recursive: true });

/**
 * 主入口：生成 + 落 DB + 返回封装结果。
 *
 * 调用方决定是否轮询（这里内部是同步等到完成后才返回；
 * 上层一般在 batch executor 里，不会阻塞 HTTP 请求线程）。
 */
export async function generateVideo(
  user: UserRow,
  input: VideoGenInput,
  onProgress?: (pct: number, hint?: string) => void,
): Promise<VideoGenResult> {
  const cfg = resolveLLMConfig(user, 'video');
  const taskId = randomUUID();
  const ownerDir = join(VIDEOS_DIR, String(user.id));
  mkdirSync(ownerDir, { recursive: true });
  const filename = `${taskId}.mp4`;
  const fullPath = join(ownerDir, filename);
  // 选择适配器（提前算，决定时长）
  const cfgIsGrok = /^grok-video/i.test(cfg.model || '');
  // grok 模型时长策略：
  //   grok-video-3-10s → 固定 10 秒
  //   grok-video-3-Ns  → 固定 N 秒
  //   grok-video-3     → 默认 5 秒（中转站默认）
  const grokFixedDur = cfgIsGrok
    ? (/-(\d+)s$/i.test(cfg.model) ? Number(RegExp.$1) : 5)
    : null;
  const dur = grokFixedDur ?? input.durationSec ?? 4;
  // ratio 优先；没传 ratio 时尊重 size，否则按 size 反推
  const sizeArgPresent = !!input.size;
  const { ratio: aspectRatio, size: sizeFromRatio } = normalizeRatio(
    input.ratio || (input.size === '1080x1920' ? '9:16' : input.size === '1920x1080' ? '16:9' : input.size === '1024x1024' ? '1:1' : '16:9'),
  );
  const size = (sizeArgPresent && !input.ratio ? input.size! : sizeFromRatio) as '1080x1920' | '1920x1080' | '1024x1024';
  console.log(`[video-gen] resolved ratio=${aspectRatio} size=${size} dur=${dur}s model=${cfg.model}`);

  let mode: 'real' | 'fake' = 'real';

  // 入库登记
  const db = getDb();
  db.prepare(
    `INSERT INTO video_tasks (id, owner_id, project_id, group_idx, prompt, provider, status, progress, filename, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
  ).run(
    taskId,
    user.id,
    input.projectId || null,
    input.groupIdx ?? null,
    input.prompt.slice(0, 4000),
    cfg.mode === 'fake' ? 'fake' : (cfg.model || 'openai'),
    filename,
    dur,
  );

  // 选择适配器：grok（中转） / 火山引擎 Seedance / OpenAI Sora / fake
  const isVolcano = /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl) || /seedance|doubao/i.test(cfg.model);
  const isGrok = cfgIsGrok;

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    onProgress?.(20, '[fake] 生成黑场视频…');
    await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
    onProgress?.(80, '[fake] 提取封面…');
    mode = 'fake';
  } else if (isGrok) {
    // ---- Grok video 适配（yungpt 中转）----
    // 提交：POST {base}/video/create
    // 轮询：GET  {base}/videos/{id}     （含 progress、video_id 字段）
    //       GET  {base}/video/query?id={id}（兜底，含 video_url）
    // 失败时直接抛错（**不 fallback 黑场视频**），上层 batch executor 会把这条任务标 failed
    try {
      // grok-video 对长 prompt 理解力差，压缩后只保留视觉关键信息（视觉部分留 240 字）
      const compressedVisual = compressForGrokVideo(input.prompt, 240);
      // 拼上必须严格演绎的台词（如有）。这一段不计入压缩预算，确保不被截断
      let finalPrompt = compressedVisual || input.prompt.slice(0, 240);
      if (input.dialogue && input.dialogue.trim()) {
        const cleanDialogue = input.dialogue.trim().replace(/\s+/g, ' ').slice(0, 220);
        finalPrompt =
          finalPrompt +
          `。【角色对白】必须严格、完整、清晰地按以下原文演绎并配音，不得自由发挥、不得即兴增删字句：「${cleanDialogue}」`;
      }
      console.log(`[video-gen][grok] prompt: visual=${compressedVisual.length}c dialogue=${input.dialogue ? input.dialogue.length : 0}c total=${finalPrompt.length}c`);
      console.log(`[video-gen][grok] final prompt = ${finalPrompt}`);

      // 关键：grok-video-3 提交参数兼容
      //   - grok-video-3-Ns（带数字后缀）：模型已锁时长，传 duration 是冗余但 OK
      //   - grok-video-3（无后缀）：实测同时传 aspect_ratio + duration 会让中转 60s 超时
      //                            → 所以无后缀模型只传 aspect_ratio
      const hasDurationSuffix = /-\d+s$/i.test(cfg.model);
      const submitBody: any = {
        model: cfg.model,
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
      };
      if (hasDurationSuffix) submitBody.duration = dur;
      console.log(`[video-gen][grok] submit body keys = ${Object.keys(submitBody).join(',')}`);
      onProgress?.(5, `提交 Grok 视频任务（${cfg.model}, ${dur}s, ${aspectRatio}）…`);

      const submit: any = await retryFetch(
        `${cfg.baseUrl}/video/create`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(submitBody),
        },
        '[grok submit]',
      );
    console.log('[video-gen][grok] submit response:', JSON.stringify(submit).slice(0, 400));
    const remoteId = submit.id || submit.task_id;
    if (!remoteId) throw new Error('Grok API 返回缺 id：' + JSON.stringify(submit).slice(0, 200));
    console.log('[video-gen][grok] remoteId =', remoteId);
    db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

    const isTerminalStatus = (s: string) =>
      /^(succeeded|success|completed|complete|finished|done|ok|ready)$/i.test(s);
    const isFailureStatus = (s: string) =>
      /^(failed|fail|error|cancelled|canceled|timeout)$/i.test(s);

    const deadline = Date.now() + 10 * 60 * 1000; // 10 分钟超时
    let status = (submit.status || 'processing').toLowerCase();
    let videoUrl = '';
    let providerProgress = 0;
    let pollCount = 0;

    while (!isTerminalStatus(status) && !isFailureStatus(status) && !videoUrl) {
      if (Date.now() > deadline) throw new Error('Grok 视频生成超时（10 分钟）');
      await sleep(8000);
      pollCount++;

      // 主端点：GET /videos/{id}（progress 更细）
      let j: any = null;
      try {
        j = await retryFetch(
          `${cfg.baseUrl}/videos/${encodeURIComponent(remoteId)}`,
          { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
          `[grok poll #${pollCount}]`,
        );
      } catch (eMain: any) {
        console.warn(`[video-gen][grok] poll #${pollCount} /videos/{id} failed: ${eMain?.message || eMain}, fallback to /video/query`);
        try {
          j = await retryFetch(
            `${cfg.baseUrl}/video/query?id=${encodeURIComponent(remoteId)}`,
            { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
            `[grok poll #${pollCount} fallback]`,
          );
        } catch (eAlt: any) {
          console.warn(`[video-gen][grok] poll #${pollCount} fallback also failed: ${eAlt?.message || eAlt}`);
          // 单次失败不致命，下一轮继续
          continue;
        }
      }

      status = (j.status || '').toString().toLowerCase();
      videoUrl = j.video_url || j.url || videoUrl;
      providerProgress = Number.isFinite(j.progress) ? Number(j.progress) : providerProgress;
      const stageHint = Math.min(85, Math.max(20 + pollCount * 4, providerProgress));
      onProgress?.(stageHint, `Grok 状态：${status || '生成中'}（${providerProgress}%）`);
      db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
      console.log(`[video-gen][grok] poll #${pollCount} status=${status} progress=${providerProgress} videoUrl=${videoUrl ? 'yes' : 'no'}`);
    }

    if (isFailureStatus(status)) throw new Error(`Grok 任务结束状态: ${status}`);
    if (!videoUrl) throw new Error('Grok 完成但没返回 video_url（最后状态: ' + status + '）');
    console.log(`[video-gen][grok] succeeded after ${pollCount} polls, url=${videoUrl.slice(0, 100)}…`);

    onProgress?.(90, '下载视频…');
      const buf = await retryDownload(videoUrl);
      require('node:fs').writeFileSync(fullPath, buf);
      console.log(`[video-gen][grok] downloaded ${buf.length} bytes to ${fullPath}`);
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.warn('[video-gen][grok] generation failed:', msg);
      console.warn('[video-gen][grok] full error:', String(e?.stack || e).slice(0, 800));
      // 残留文件清理
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      // 标 video_tasks 失败（**不写假视频**）
      db.prepare(
        `UPDATE video_tasks SET status='failed', error_msg=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(msg.slice(0, 1000), taskId);
      // 往上抛 → batch executor 会把对应 batch_task 标 failed，前端能"重试"
      throw new Error('Grok 视频生成失败：' + msg.slice(0, 200));
    }
  } else if (isVolcano) {
    // ---- 火山引擎 Seedance 适配 ----
    try {
      onProgress?.(5, '提交火山 Seedance 任务…');
      const submit: any = await retryFetch(
        `${cfg.baseUrl}/contents/generations/tasks`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model || 'doubao-seedance-2-0-260128',
            content: [
              { type: 'text', text: `${input.prompt} --ratio ${aspectRatio} --duration ${dur}` },
            ],
          }),
        },
        '[seedance submit]',
      );
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Seedance API 返回缺 id');
      console.log(`[video-gen][seedance] task created id=${remoteId}`);
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

      const deadline = Date.now() + 10 * 60 * 1000;
      let status = (submit.status || '').toLowerCase();
      let videoUrl = '';
      let pollCount = 0;
      while (!['succeeded', 'failed', 'cancelled'].includes(status)) {
        if (Date.now() > deadline) throw new Error('视频生成超时（10 分钟）');
        await sleep(6000);
        pollCount++;
        const j: any = await retryFetch(
          `${cfg.baseUrl}/contents/generations/tasks/${remoteId}`,
          { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
          `[seedance poll #${pollCount}]`,
        );
        status = (j.status || '').toLowerCase();
        videoUrl = j?.content?.video_url || j?.video_url || videoUrl;
        const stageHint = status === 'queued' ? 20 : status === 'running' || status === 'in_progress' ? Math.min(70, 30 + pollCount * 3) : 85;
        onProgress?.(stageHint, `Seedance 状态：${status}`);
        db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
      }
      if (status !== 'succeeded') throw new Error(`Seedance 任务结束状态: ${status}`);
      if (!videoUrl) throw new Error('Seedance 完成但没返回 video_url');
      console.log(`[video-gen][seedance] succeeded after ${pollCount} polls, url=${videoUrl.slice(0, 80)}…`);

      onProgress?.(90, '下载视频…');
      const buf = await retryDownload(videoUrl);
      require('node:fs').writeFileSync(fullPath, buf);
      console.log(`[video-gen][seedance] downloaded ${buf.length} bytes to ${fullPath}`);
    } catch (e: any) {
      console.warn('[video-gen][seedance] fallback to placeholder:', e?.message || e);
      console.warn('[video-gen][seedance] full error:', String(e?.stack || e).slice(0, 500));
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
      mode = 'fake';
      db.prepare('UPDATE video_tasks SET error_msg=? WHERE id=?').run(String(e?.message || e).slice(0, 1000), taskId);
    }
  } else {
    // ---- OpenAI Sora 适配 ----
    try {
      onProgress?.(5, '提交 Sora 任务…');
      const submitResp = await fetch(`${cfg.baseUrl}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model || 'sora-2',
          prompt: input.prompt,
          size,
          seconds: String(dur),
        }),
      });
      if (!submitResp.ok) {
        const t = await submitResp.text();
        throw new Error(`Video submit ${submitResp.status}: ${t.slice(0, 400)}`);
      }
      const submit: any = await submitResp.json();
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Video API 返回缺 id');
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

      const deadline = Date.now() + 6 * 60 * 1000;
      let status = submit.status || 'queued';
      let progress = 0;
      while (status !== 'completed' && status !== 'failed') {
        if (Date.now() > deadline) throw new Error('视频生成超时（6 分钟）');
        await sleep(5000);
        const r = await fetch(`${cfg.baseUrl}/videos/${remoteId}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`Video poll ${r.status}: ${t.slice(0, 400)}`);
        }
        const j: any = await r.json();
        status = j.status || 'queued';
        progress = j.progress ?? progress;
        onProgress?.(Math.max(progress, 10), `远端状态：${status} (${progress}%)`);
        db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(progress, taskId);
      }
      if (status === 'failed') throw new Error('远端视频任务 failed');

      onProgress?.(90, '下载视频…');
      const dl = await fetch(`${cfg.baseUrl}/videos/${remoteId}/content`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      if (!dl.ok) throw new Error(`下载 ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      require('node:fs').writeFileSync(fullPath, buf);
    } catch (e: any) {
      console.warn('[video-gen][sora] fallback to placeholder:', e?.message);
      try { require('node:fs').unlinkSync(fullPath); } catch (_) {}
      await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
      mode = 'fake';
      db.prepare('UPDATE video_tasks SET error_msg=? WHERE id=?').run(String(e?.message || e).slice(0, 1000), taskId);
    }
  }

  // 自动出封面（直接抽第一帧）
  onProgress?.(95, '提取封面…');
  let coverImageId: string | null = null;
  let coverUrl: string | null = null;
  try {
    const coverPath = join(ownerDir, `${taskId}.cover.png`);
    await extractCover({ videoPath: fullPath, outputPath: coverPath });
    // 把封面也写入 images 表（这样跟 storyboard / asset 图同样的访问路径）
    coverImageId = randomUUID();
    const stat = statSync(coverPath);
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, 'other', ?, ?, 'image/png', ?, 1080, 1920, ?, 'video-cover')`,
    ).run(
      coverImageId,
      user.id,
      input.projectId || null,
      `video-cover/${taskId}`,
      `${taskId}.cover.png`,
      stat.size,
      input.prompt.slice(0, 200),
    );
    coverUrl = `/api/images/file/${coverImageId}`;
    db.prepare('UPDATE video_tasks SET cover_image_id=? WHERE id=?').run(coverImageId, taskId);
  } catch (e: any) {
    console.warn('[video-gen] extract cover failed:', e?.message);
  }

  db.prepare(
    `UPDATE video_tasks SET status='completed', progress=100,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  ).run(taskId);

  onProgress?.(100, '完成');

  return {
    taskId,
    status: 'completed',
    url: `/api/videos/file/${taskId}`,
    coverUrl,
    durationSec: dur,
    mode,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带重试的 fetch + JSON 解析（Volcano 偶尔抖一下，重试 3 次）。
 */
async function retryFetch(url: string, init: any, label: string, retries = 3): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        const t = await resp.text();
        if (resp.status >= 500 && i < retries - 1) {
          console.warn(`${label} status=${resp.status}, retrying...`);
          await sleep(2000 * (i + 1));
          continue;
        }
        throw new Error(`${label} HTTP ${resp.status}: ${t.slice(0, 300)}`);
      }
      return await resp.json();
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (i < retries - 1) {
        console.warn(`${label} attempt ${i + 1}/${retries} failed: ${msg}, retrying...`);
        await sleep(2000 * (i + 1));
        continue;
      }
      throw new Error(`${label} 失败（${retries} 次重试后）: ${msg}`);
    }
  }
  throw lastErr;
}

/**
 * 带重试的下载（视频 URL 是 CDN，可能抖一下）。
 */
async function retryDownload(url: string, retries = 3): Promise<Buffer> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const dl = await fetch(url);
      if (!dl.ok) throw new Error(`下载 HTTP ${dl.status}`);
      return Buffer.from(await dl.arrayBuffer());
    } catch (e: any) {
      lastErr = e;
      if (i < retries - 1) {
        console.warn(`[video-gen] download retry ${i + 1}/${retries}:`, e?.message || e);
        await sleep(3000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export function getVideoTaskMeta(id: string, ownerId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM video_tasks WHERE id = @id AND owner_id = @uid')
    .get({ id, uid: ownerId });
  if (!row) return null;
  return {
    ...row,
    fullPath: join(VIDEOS_DIR, String(row.owner_id), row.filename || ''),
  };
}
