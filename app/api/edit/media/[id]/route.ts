import { NextRequest } from 'next/server';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getDb } from '@/lib/db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return new Response('unauthorized', { status: 401 });

  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>('SELECT * FROM uploads WHERE id = @id').get({ id });
  if (!row) return new Response('not found', { status: 404 });
  if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });

  const fullPath = join(process.cwd(), 'data', 'uploads', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const range = req.headers.get('range');

  if (range && row.kind !== 'image') {
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
      const stream = toWebStream(createReadStream(fullPath, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': row.mime,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
        },
      });
    }
  }

  // 图片走非流式小缓冲，其它走流式
  if (row.kind === 'image') {
    return new Response(readFileSync(fullPath), {
      status: 200,
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }
  const stream = toWebStream(createReadStream(fullPath));
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': row.mime,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, any>(
      'SELECT * FROM uploads WHERE id = @id AND owner_id = @uid',
    )
    .get({ id: params.id, uid: user.id });
  if (row) {
    const fullPath = join(process.cwd(), 'data', 'uploads', String(row.owner_id), row.filename);
    try { if (existsSync(fullPath)) unlinkSync(fullPath); } catch (_) {}
  }
  db.prepare('DELETE FROM uploads WHERE id = ? AND owner_id = ?').run(params.id, user.id);
  return jsonOk({ ok: true });
}
