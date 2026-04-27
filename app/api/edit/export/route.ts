import { NextRequest } from 'next/server';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { concatClips, addBgm } from '@/lib/ffmpeg';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = join(process.cwd(), 'data');
const EXPORTS_DIR = join(DATA_DIR, 'exports');
const VIDEOS_DIR = join(DATA_DIR, 'videos');
const BGM_DIR = join(DATA_DIR, 'bgm');

/**
 * 启动一次导出（异步）。返回 exportId，前端通过 /api/edit/export-status/<id> 轮询。
 *
 * 入参：
 *   { projectId, edl: [{clipId, in, out, transitionIn, transitionOut}], bgmId?, format? }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string = (body.projectId || '').toString();
  const edl: any[] = Array.isArray(body.edl) ? body.edl : [];
  const bgmId: string | undefined = body.bgmId;
  if (!projectId) return jsonError('缺 projectId', 400);
  if (!edl.length) return jsonError('EDL 不能为空', 400);

  const exportId = randomUUID();
  const ownerDir = join(EXPORTS_DIR, String(user.id));
  mkdirSync(ownerDir, { recursive: true });
  const filename = `${exportId}.mp4`;
  const fullPath = join(ownerDir, filename);

  const db = getDb();
  db.prepare(
    `INSERT INTO exports (id, owner_id, project_id, status, progress, filename, edl_json, bgm_id)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
  ).run(exportId, user.id, projectId, filename, JSON.stringify({ edl }), bgmId || null);

  // 后台异步执行（立即返回 exportId）
  setImmediate(() => doExport(exportId, user.id, edl, bgmId, fullPath).catch((e) => {
    console.error('[export]', exportId, e);
  }));

  return jsonOk({ ok: true, taskId: exportId, status: 'queued' });
}

async function doExport(
  exportId: string,
  userId: number,
  edl: any[],
  bgmId: string | undefined,
  outputPath: string,
) {
  const db = getDb();
  db.prepare(`UPDATE exports SET status='running', progress=10, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(exportId);

  try {
    // 1) 解析 EDL，找到每个 clip 对应的视频文件
    const clipFiles: string[] = [];
    for (const e of edl) {
      const v = db.prepare<{ id: string }, any>('SELECT * FROM video_tasks WHERE id = @id').get({ id: e.clipId });
      if (!v || !v.filename) continue;
      const path = join(VIDEOS_DIR, String(v.owner_id), v.filename);
      if (!existsSync(path)) continue;
      clipFiles.push(path);
    }
    if (!clipFiles.length) throw new Error('没找到任何可用的视频片段');

    db.prepare(`UPDATE exports SET progress=40, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(exportId);

    // 2) 拼接所有片段（暂时简化：忽略每段的 in/out 裁切；阶段五再加 trim 支持）
    const concatPath = bgmId ? outputPath + '.noaudio.mp4' : outputPath;
    await concatClips({ inputPaths: clipFiles, outputPath: concatPath });

    db.prepare(`UPDATE exports SET progress=80, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(exportId);

    // 3) 加 BGM（如果选了）
    if (bgmId) {
      const bgmPath = join(BGM_DIR, bgmId);
      if (existsSync(bgmPath)) {
        await addBgm({ videoPath: concatPath, bgmPath, outputPath, bgmVolume: 0.6 });
        try { require('node:fs').unlinkSync(concatPath); } catch (_) {}
      } else {
        // BGM 文件不存在 → 不加，直接把无音频版本当成果
        require('node:fs').renameSync(concatPath, outputPath);
      }
    }

    const stat = statSync(outputPath);
    db.prepare(
      `UPDATE exports SET status='completed', progress=100,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(exportId);
    console.log('[export]', exportId, 'completed,', stat.size, 'bytes');
  } catch (e: any) {
    const msg = e?.message || String(e);
    db.prepare(
      `UPDATE exports SET status='failed', error_msg=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(msg.slice(0, 1000), exportId);
    console.error('[export]', exportId, 'failed:', msg);
  }
}
