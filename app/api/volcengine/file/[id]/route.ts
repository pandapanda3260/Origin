/**
 * VevDemo 素材文件代理 API
 * 代理访问 uploads 表中的文件，支持视频、图片、音频
 */

import { NextRequest } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { dataPath } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * GET /api/volcengine/file/[id]
 * 获取上传文件（支持 Range 请求）
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
    return new Response('bad id', { status: 400 });
  }

  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>(
    'SELECT * FROM uploads WHERE id = @id',
  ).get({ id });

  if (!row) {
    return new Response('not found', { status: 404 });
  }

  // 检查权限
  if (Number(row.owner_id) !== Number(user.id)) {
    return new Response('forbidden', { status: 403 });
  }

  const fullPath = dataPath('uploads', String(row.owner_id), row.filename);

  if (!existsSync(fullPath)) {
    return new Response('file missing', { status: 404 });
  }

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');

  // 处理 Range 请求
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      let start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }

      const chunkSize = end - start + 1;
      const stream = createReadStream(fullPath, { start, end });
      return new Response(toWebStream(stream), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': getMimeType(row.filename),
        },
      });
    }
  }

  // 完整文件下载
  const stream = createReadStream(fullPath);
  return new Response(toWebStream(stream), {
    status: 200,
    headers: {
      'Content-Length': String(total),
      'Content-Type': getMimeType(row.filename),
      'Accept-Ranges': 'bytes',
    },
  });
}
