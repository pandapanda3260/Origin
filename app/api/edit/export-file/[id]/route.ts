import { NextRequest } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { verifySignedExportUrl } from '@/lib/signed-asset-url';
import { dataPath } from '@/lib/runtime-paths';
import {
  buildEditExportContentDisposition,
  buildEditExportDownloadFilename,
  editExportNameInputFromProject,
  sanitizeEditExportDownloadFilename,
} from '@/lib/edit-export-filename';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream<Uint8Array>;
}

function parseJsonObject(value: unknown): any {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function resolveDownloadFilename(row: any): string {
  const edlMeta = parseJsonObject(row?.edl_json);
  const projectData = parseJsonObject(row?.project_data_json) || {};
  const project = {
    ...projectData,
    id: row?.project_id || projectData.id,
    title: row?.project_title || projectData.title,
  };
  const fallback = buildEditExportDownloadFilename(editExportNameInputFromProject(project, row?.project_id));
  return sanitizeEditExportDownloadFilename(edlMeta?.downloadFilename, fallback);
}

/**
 * 下载/预览导出的成片 mp4。支持 Range 请求，流式返回。
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return new Response('bad id', { status: 400 });

  const db = getDb();
  const row = db.prepare<{ id: string }, any>(
    `SELECT e.*, p.title AS project_title, p.data_json AS project_data_json
       FROM exports e
       LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.id = @id`,
  ).get({ id });
  if (!row || !row.filename || row.status !== 'completed') return new Response('not ready', { status: 404 });

  // 鉴权：登录用户（必须是属主）或带有效签名的地址。后者用于 <video src>/<a download>
  // 这类带不了 Authorization 头的场景（任务页右侧预览播放/下载合成片）。
  const user = await getCurrentUser(req);
  if (user) {
    if (Number(row.owner_id) !== Number(user.id)) return new Response('forbidden', { status: 403 });
  } else {
    const u = new URL(req.url);
    const signedOk = verifySignedExportUrl({
      exportId: id,
      ownerId: Number(row.owner_id),
      exp: u.searchParams.get('exp'),
      sig: u.searchParams.get('sig'),
    });
    if (!signedOk) return new Response('unauthorized', { status: 401 });
  }

  const fullPath = dataPath('exports', String(row.owner_id), row.filename);
  if (!existsSync(fullPath)) return new Response('file missing', { status: 404 });

  const stat = statSync(fullPath);
  const total = stat.size;
  const range = req.headers.get('range');
  const contentDisposition = buildEditExportContentDisposition(resolveDownloadFilename(row));

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
