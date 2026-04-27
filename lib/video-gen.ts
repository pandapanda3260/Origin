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
  durationSec?: number;
  projectId?: string;
  groupIdx?: number;
  /** 用于 fake 模式做封面的素材描述 */
  coverHint?: string;
};

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
  const dur = input.durationSec ?? 4;
  const size = input.size ?? '1080x1920';

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

  // 选择适配器：火山引擎 Seedance / OpenAI Sora / fake
  const isVolcano = /volces\.com|volcengine|ark\.cn-/i.test(cfg.baseUrl) || /seedance|doubao/i.test(cfg.model);

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    onProgress?.(20, '[fake] 生成黑场视频…');
    await makeBlackVideo({ outputPath: fullPath, durationSec: dur, withTone: true });
    onProgress?.(80, '[fake] 提取封面…');
    mode = 'fake';
  } else if (isVolcano) {
    // ---- 火山引擎 Seedance 适配 ----
    try {
      onProgress?.(5, '提交火山 Seedance 任务…');
      const submitResp = await fetch(`${cfg.baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model || 'doubao-seedance-1-0-pro-250528',
          content: [
            { type: 'text', text: input.prompt + ` --ratio ${size === '1080x1920' ? '9:16' : size === '1920x1080' ? '16:9' : '1:1'} --duration ${dur}` },
          ],
        }),
      });
      if (!submitResp.ok) {
        const t = await submitResp.text();
        throw new Error(`Seedance submit ${submitResp.status}: ${t.slice(0, 400)}`);
      }
      const submit: any = await submitResp.json();
      const remoteId = submit.id;
      if (!remoteId) throw new Error('Seedance API 返回缺 id');
      db.prepare('UPDATE video_tasks SET provider_task=? WHERE id=?').run(remoteId, taskId);

      const deadline = Date.now() + 8 * 60 * 1000;
      let status = (submit.status || '').toLowerCase();
      let videoUrl = '';
      while (!['succeeded', 'failed', 'cancelled'].includes(status)) {
        if (Date.now() > deadline) throw new Error('视频生成超时（8 分钟）');
        await sleep(5000);
        const r = await fetch(`${cfg.baseUrl}/contents/generations/tasks/${remoteId}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`Seedance poll ${r.status}: ${t.slice(0, 400)}`);
        }
        const j: any = await r.json();
        status = (j.status || '').toLowerCase();
        videoUrl = j?.content?.video_url || j?.video_url || videoUrl;
        const stageHint = status === 'queued' ? 20 : status === 'running' || status === 'in_progress' ? 60 : 80;
        onProgress?.(stageHint, `Seedance 状态：${status}`);
        db.prepare('UPDATE video_tasks SET progress=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(stageHint, taskId);
      }
      if (status !== 'succeeded') throw new Error(`Seedance 任务结束状态: ${status}`);
      if (!videoUrl) throw new Error('Seedance 完成但没返回 video_url');

      onProgress?.(90, '下载视频…');
      const dl = await fetch(videoUrl);
      if (!dl.ok) throw new Error(`下载 ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      require('node:fs').writeFileSync(fullPath, buf);
    } catch (e: any) {
      console.warn('[video-gen][seedance] fallback to placeholder:', e?.message);
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
