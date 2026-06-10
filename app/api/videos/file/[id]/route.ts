import { NextRequest } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { verifySignedVideoUrl } from '@/lib/signed-asset-url';
import { dataPath } from '@/lib/runtime-paths';
import { buildVideoSegmentContentDisposition, buildVideoSegmentNamesForRow } from '@/lib/video-segment-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

/**
 * 视频文件下载 / 预览。支持 Range 请求，使用 createReadStream 流式返回，
 * 避免把整个 mp4 一次性读进内存。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>(
    `SELECT vt.*, p.title AS project_title, p.data_json AS project_data_json
       FROM video_tasks vt
       LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
      WHERE vt.id = @id`,
  ).get({ id });
  if (!row || !row.filename) return new Response('not found', { status: 404 });

  const user = await getCurrentUser(req);
  if (user) {
    if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });
  } else {
    const url = new URL(req.url);
    const signedOk = verifySignedVideoUrl({
      videoId: id,
      ownerId: Number(row.owner_id),
      exp: url.searchParams.get('exp'),
      sig: url.searchParams.get('sig'),
    });
    if (!signedOk) return new Response('unauthorized', { status: 401 });
  }

  const fullPath = dataPath('videos', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');
  const names = buildVideoSegmentNamesForRow(row);
  const contentDisposition = buildVideoSegmentContentDisposition(names.downloadFilename, 'inline');

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
	          'Content-Disposition': contentDisposition,
	          'Cache-Control': 'private, max-age=3600',
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
	      'Content-Disposition': contentDisposition,
	      'Cache-Control': 'private, max-age=3600',
    },
  });
}
