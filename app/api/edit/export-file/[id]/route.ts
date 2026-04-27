import { NextRequest } from 'next/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 下载/预览导出的成片 mp4。支持 Range 请求。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM exports WHERE id = @id').get({ id });
  if (!row || !row.filename || row.status !== 'completed') return new Response('not ready', { status: 404 });

  const fullPath = join(process.cwd(), 'data', 'exports', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : total - 1;
      const buf = readFileSync(fullPath).subarray(start, end + 1);
      return new Response(buf, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(buf.length),
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
      'Content-Disposition': `inline; filename="${id}.mp4"`,
    },
  });
}
