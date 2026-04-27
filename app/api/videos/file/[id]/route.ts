import { NextRequest } from 'next/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 提供生成视频文件的下载/预览。
 * 鉴权策略与图片一致：本机/开发模式直接 public read（生产请改签名 URL）。
 *
 * 支持 Range 请求（HTML5 video 原地拖动需要）。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM video_tasks WHERE id = @id').get({ id });
  if (!row || !row.filename) return new Response('not found', { status: 404 });

  const fullPath = join(process.cwd(), 'data', 'videos', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : total - 1;
      const chunkSize = end - start + 1;
      const buf = readFileSync(fullPath);
      const slice = buf.subarray(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
        },
      });
    }
  }

  const buf = readFileSync(fullPath);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
