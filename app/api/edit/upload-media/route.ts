import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getDataDir } from '@/lib/runtime-paths';
import { createAssetRecord, hashFile, localAssetUri } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = getDataDir();
const UPLOADS_DIR = join(DATA_DIR, 'uploads');

// 单文件上限：视频 / 音频 200 MB，图片 20 MB
const MAX_AV_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// 请求体总上限（稍微宽松：给 form 字段留点余量）
const MAX_REQUEST_BYTES = MAX_AV_BYTES + 1 * 1024 * 1024;

const ALLOWED_MIME_PREFIX = ['video/', 'audio/', 'image/'];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  // 先看 content-length，阻止超大请求把整个 body 读进内存
  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(`文件过大：请求体 ${Math.round(contentLength / 1024 / 1024)} MB 超过上限 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB`, 413);
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = (form.get('projectId') || '').toString() || null;
    const purpose = (form.get('purpose') || '').toString().trim();
    if (!file) return jsonError('没有上传文件', 400);

    const mime = (file as any).type || 'application/octet-stream';
    if (!ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) {
      return jsonError('不支持的文件类型：' + mime, 415);
    }
    const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'image';
    if (purpose === 'edit_timeline' && kind !== 'video') {
      return jsonError('剪辑页目前仅支持上传视频素材', 415);
    }
    const perFileLimit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_AV_BYTES;
    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > perFileLimit) {
      return jsonError(`文件过大：${kind} 最大 ${Math.round(perFileLimit / 1024 / 1024)} MB`, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > perFileLimit) {
      return jsonError(`文件过大：${kind} 最大 ${Math.round(perFileLimit / 1024 / 1024)} MB`, 413);
    }

    const id = randomUUID();
    const dir = join(UPLOADS_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const ext = guessExt(mime);
    const filename = `${id}.${ext}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, buf);

    const db = getDb();
    db.prepare(
      `INSERT INTO uploads (id, owner_id, project_id, kind, filename, mime, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, projectId, kind, filename, mime, buf.length);
    if (kind === 'image' || kind === 'video') {
      createAssetRecord({
        assetId: id,
        ownerId: user.id,
        projectId,
        assetKind: kind,
        source: 'uploaded',
        stage: kind === 'image' ? 'edit_upload_image' : 'edit_upload_video',
        fileUri: localAssetUri('uploads', user.id, filename),
        thumbUri: `/api/edit/media/${id}`,
        fileHash: hashFile(fullPath),
        byteSize: buf.length,
        makeCurrent: false,
      });
    }

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
