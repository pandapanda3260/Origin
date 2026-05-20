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

/**
 * 下载/预览导出的成片 mp4。支持 Range 请求，流式返回。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM exports WHERE id = @id').get({ id });
  if (!row || !row.filename || row.status !== 'completed') return new Response('not ready', { status: 404 });
  if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });

  const fullPath = dataPath('exports', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');

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
      const stream = toWebStream(createReadStream(fullPath, { start, end }));
      return new Response(stream, {
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

  const stream = toWebStream(createReadStream(fullPath));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${id}.mp4"`,
    },
  });
}
