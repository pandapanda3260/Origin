import { NextRequest } from 'next/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BGM_DIR = join(process.cwd(), 'data', 'bgm');

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || '');
  // 防 path traversal
  if (!id || id.includes('/') || id.includes('..')) return new Response('bad id', { status: 400 });
  const fullPath = join(BGM_DIR, id);
  if (!existsSync(fullPath)) return new Response('not found', { status: 404 });

  const stat = statSync(fullPath);
  const range = req.headers.get('range');
  const ext = (id.split('.').pop() || 'mp3').toLowerCase();
  const mime = ext === 'wav' ? 'audio/wav' :
    ext === 'm4a' ? 'audio/mp4' :
    ext === 'aac' ? 'audio/aac' :
    ext === 'ogg' ? 'audio/ogg' :
    'audio/mpeg';

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      const buf = readFileSync(fullPath).subarray(start, end + 1);
      return new Response(buf, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(buf.length),
        },
      });
    }
  }

  return new Response(readFileSync(fullPath), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
