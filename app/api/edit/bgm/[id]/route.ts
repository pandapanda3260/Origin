import { NextRequest } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { getCurrentUser } from '@/lib/auth';
import { dataPath } from '@/lib/runtime-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BGM_DIR = dataPath('bgm');
const BGM_DIR_RESOLVED = resolve(BGM_DIR);

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });

  const raw = decodeURIComponent(params.id || '');
  if (!raw || !/^[A-Za-z0-9._-]+$/.test(raw)) return new Response('bad id', { status: 400 });

  const fullPath = join(BGM_DIR, raw);
  const resolved = resolve(fullPath);
  if (resolved !== join(BGM_DIR_RESOLVED, raw) && !resolved.startsWith(BGM_DIR_RESOLVED + sep)) {
    return new Response('bad id', { status: 400 });
  }
  if (!existsSync(resolved)) return new Response('not found', { status: 404 });

  const stat = statSync(resolved);
  const range = req.headers.get('range');
  const ext = (raw.split('.').pop() || 'mp3').toLowerCase();
  const mime = ext === 'wav' ? 'audio/wav' :
    ext === 'm4a' ? 'audio/mp4' :
    ext === 'aac' ? 'audio/aac' :
    ext === 'ogg' ? 'audio/ogg' :
    'audio/mpeg';

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      let start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : stat.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      }
      const chunkSize = end - start + 1;
      const stream = toWebStream(createReadStream(resolved, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
        },
      });
    }
  }

  const stream = toWebStream(createReadStream(resolved));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
