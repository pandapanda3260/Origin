import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = join(process.cwd(), 'data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = (form.get('projectId') || '').toString() || null;
    if (!file) return jsonError('没有上传文件', 400);

    const buf = Buffer.from(await file.arrayBuffer());
    const id = randomUUID();
    const dir = join(UPLOADS_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });

    const mime = (file as any).type || 'application/octet-stream';
    const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
    const ext = guessExt(mime);
    const filename = `${id}.${ext}`;
    writeFileSync(join(dir, filename), buf);

    const db = getDb();
    db.prepare(
      `INSERT INTO uploads (id, owner_id, project_id, kind, filename, mime, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, projectId, kind, filename, mime, buf.length);

    return jsonOk({
      ok: true,
      mediaId: id,
      url: `/api/edit/media/${id}`,
      kind,
      filename,
      sizeBytes: buf.length,
    });
  } catch (e: any) {
    return jsonError('上传失败：' + (e?.message || String(e)), 400);
  }
}

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mov')) return 'mov';
  if (m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return 'bin';
}
