import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { patchProjectForUser } from '@/lib/projects-db';
import { buildSignedImageUrl } from '@/lib/signed-asset-url';
import { mutateCharacterLock } from '@/lib/character-consistency';
import { getDataDir } from '@/lib/runtime-paths';
import { createAssetRecord, hashFile, localAssetUri } from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;       // 20 MB
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 1 * 1024 * 1024;

const ALLOWED_MIME_PREFIX = ['image/'];

function parseCharacterIndex(form: FormData, assetRef: string): number {
  const direct = form.get('charIdx') ?? form.get('idx') ?? form.get('characterIndex');
  if (direct !== null && direct !== '') {
    const n = Number(String(direct));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const m = /characters\[(\d+)\]/.exec(assetRef);
  return m ? Number(m[1]) : -1;
}

function withUploadedReference(character: any, url: string) {
  const next = {
    ...(character || {}),
    realPhotoUrl: url,
    rawUrl: url,
    imageUrl: url,
    pencilUrl: url,
  };
  delete next._pencilFailed;
  return next;
}

/**
 * 用户上传一张自定义角色照片做参考图。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(`文件过大：请求体超过上限 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB`, 413);
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = (form.get('projectId') || '').toString();
    const assetRef = (form.get('assetRef') || '').toString();
    const charIdx = parseCharacterIndex(form, assetRef);

    if (!file) return jsonError('没有上传文件', 400);
    const mime = (file as any).type || 'image/jpeg';
    if (!ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) {
      return jsonError('仅支持图片文件', 415);
    }
    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大：最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大：最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const id = randomUUID();
    const dir = join(IMAGES_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const ext = guessExt(mime);
    const filename = `${id}.${ext}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, buf);

    const db = getDb();
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, 'character', ?, ?, ?, ?, 0, 0, '[uploaded]', null)`,
    ).run(
      id,
      user.id,
      projectId || null,
      assetRef || null,
      filename,
      mime,
      buf.length,
    );
    createAssetRecord({
      assetId: id,
      ownerId: user.id,
      projectId: projectId || null,
      assetKind: 'image',
      source: 'uploaded',
      stage: 'asset_character',
      fileUri: localAssetUri('images', user.id, filename),
      thumbUri: `/api/images/file/${id}`,
      fileHash: hashFile(fullPath),
      byteSize: buf.length,
      width: 0,
      height: 0,
      makeCurrent: !!projectId,
    });

    const url = `/api/images/file/${id}`;
    const signed = buildSignedImageUrl(id, user.id);
    if (projectId && charIdx >= 0) {
      patchProjectForUser(projectId, user.id, (fresh) => {
        if (!fresh) return null;
        const assets = { ...((fresh as any).assets || {}) };
        const chars = Array.isArray(assets.characters) ? [...assets.characters] : [];
        const top = Array.isArray((fresh as any).characters) ? [...(fresh as any).characters] : [];
        const currentChar = chars[charIdx] || top[charIdx];
        if (!currentChar) return null;

        chars[charIdx] = withUploadedReference(currentChar, url);
        top[charIdx] = withUploadedReference(top[charIdx] || chars[charIdx], url);
        assets.characters = chars;

        const patch: any = { assets, characters: top.length ? top : chars };
        const nextChar = chars[charIdx] || top[charIdx];
        const mutation = mutateCharacterLock(
          { ...(fresh as any), ...patch },
          nextChar.characterId || nextChar.id || nextChar.name || `characters[${charIdx}]`,
          {
            referenceLock: {
              sheetUrl: url,
              sourceImageId: id,
              referenceStatus: 'ready',
            },
          },
          { source: 'user_upload' },
        );
        return { ...patch, consistency: mutation.project.consistency };
      });
    }
    return jsonOk({
      ok: true,
      id,
      assetId: id,
      url,
      signedUrl: signed.url,
      signedTtl: signed.ttl,
      signedExpiresAt: signed.expiresAt,
      message: '上传成功',
    });
  } catch (e: any) {
    return jsonError('上传失败：' + (e?.message || String(e)), 400);
  }
}

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}
