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

type AssetUploadTarget = {
  type: 'char' | 'scene' | 'prop';
  idx: number;
  cat: 'characters' | 'scenes' | 'props';
  topKey: 'characters' | 'environments' | 'props';
  kind: 'character' | 'scene' | 'prop';
  stage: 'asset_character' | 'asset_scene' | 'asset_prop';
  assetRef: string;
};

function normalizeAssetUploadType(value: unknown, assetRef: string): AssetUploadTarget['type'] {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'scene' || raw === 'scenes' || raw === 'environment' || raw === 'environments') return 'scene';
  if (raw === 'prop' || raw === 'props') return 'prop';
  if (/^(scenes|environments)\[\d+\]/.test(assetRef)) return 'scene';
  if (/^props\[\d+\]/.test(assetRef)) return 'prop';
  return 'char';
}

function parseAssetIndex(form: FormData, assetRef: string): number {
  const direct = form.get('idx') ?? form.get('assetIdx') ?? form.get('charIdx') ?? form.get('characterIndex');
  if (direct !== null && direct !== '') {
    const n = Number(String(direct));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const m = /(?:characters|scenes|environments|props)\[(\d+)\]/.exec(assetRef);
  return m ? Number(m[1]) : -1;
}

function buildAssetUploadTarget(form: FormData, assetRef: string): AssetUploadTarget {
  const type = normalizeAssetUploadType(form.get('assetType') ?? form.get('type') ?? form.get('kind'), assetRef);
  const idx = parseAssetIndex(form, assetRef);
  const cat = type === 'char' ? 'characters' : type === 'scene' ? 'scenes' : 'props';
  const topKey = type === 'char' ? 'characters' : type === 'scene' ? 'environments' : 'props';
  const kind = type === 'char' ? 'character' : type === 'scene' ? 'scene' : 'prop';
  const stage = type === 'char' ? 'asset_character' : type === 'scene' ? 'asset_scene' : 'asset_prop';
  return {
    type,
    idx,
    cat,
    topKey,
    kind,
    stage,
    assetRef: assetRef || `${cat}[${idx >= 0 ? idx : 0}]`,
  };
}

function withUploadedReference(asset: any, url: string, imageId: string, type: AssetUploadTarget['type']) {
  const next = {
    ...(asset || {}),
    rawUrl: url,
    imageUrl: url,
    assetId: imageId,
    imageGeneratedAt: new Date().toISOString(),
    reference: {
      ...((asset && asset.reference) || {}),
      currentUrl: url,
      lastKnownGoodUrl: url,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    },
  };
  if (type === 'char') {
    next.realPhotoUrl = url;
    next.pencilUrl = url;
  }
  delete next.imageLastError;
  delete next.imageFailedAt;
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
    const target = buildAssetUploadTarget(form, assetRef);

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[uploaded]', null)`,
    ).run(
      id,
      user.id,
      projectId || null,
      target.kind,
      target.assetRef || null,
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
      stage: target.stage,
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
    if (projectId && target.idx >= 0) {
      patchProjectForUser(projectId, user.id, (fresh) => {
        if (!fresh) return null;
        const assets = { ...((fresh as any).assets || {}) };
        const list = Array.isArray(assets[target.cat]) ? [...assets[target.cat]] : [];
        const top = Array.isArray((fresh as any)[target.topKey]) ? [...(fresh as any)[target.topKey]] : [];
        const currentAsset = list[target.idx] || top[target.idx];
        if (!currentAsset) return null;

        list[target.idx] = withUploadedReference(currentAsset, url, id, target.type);
        top[target.idx] = withUploadedReference(top[target.idx] || list[target.idx], url, id, target.type);
        assets[target.cat] = list;

        const patch: any = { assets, [target.topKey]: top.length ? top : list };
        if (target.type !== 'char') return patch;

        const nextChar = list[target.idx] || top[target.idx];
        const mutation = mutateCharacterLock(
          { ...(fresh as any), ...patch },
          nextChar.characterId || nextChar.id || nextChar.name || `characters[${target.idx}]`,
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
