import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import {
  getCurrentCustomPropVersion,
  getCustomPropForUser,
  serializeCustomPropVersion,
  updateCurrentCustomPropVersionData,
} from '@/lib/custom-prop-db';
import { getDataDir } from '@/lib/runtime-paths';
import { buildSignedImageUrl } from '@/lib/signed-asset-url';
import { createAssetRecord, hashFile, localAssetUri } from '@/lib/asset-library';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 1024 * 1024;

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

function parsePropData(json: string | null | undefined) {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const prop = getCustomPropForUser(params.id, user.id);
  if (!prop) return jsonError('道具不存在', 404);
  if (prop.lifecycle_status !== 'confirmed') return jsonError('只有已添加的道具才能上传图片', 409);

  const currentVersion = getCurrentCustomPropVersion(prop);
  if (!currentVersion) return jsonError('道具还没有可更新的当前版本', 409);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(`文件过大：请求体超过上限 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB`, 413);
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return jsonError('没有上传文件', 400);

    const mime = (file as any).type || 'image/jpeg';
    if (!mime.startsWith('image/')) return jsonError('仅支持图片文件', 415);

    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大：最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大：最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const imageId = randomUUID();
    const dir = join(IMAGES_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const filename = `${imageId}.${guessExt(mime)}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, buf);

    const projectId = prop.project_id || null;
    const assetRef = `custom-prop/${prop.id}/manual-upload`;
    getDb().prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, 'prop', ?, ?, ?, ?, 0, 0, '[custom-prop-upload]', null)`,
    ).run(imageId, user.id, projectId, assetRef, filename, mime, buf.length);

    createAssetRecord({
      assetId: imageId,
      ownerId: user.id,
      projectId,
      assetKind: 'image',
      source: 'uploaded',
      stage: 'custom_prop',
      fileUri: localAssetUri('images', user.id, filename),
      thumbUri: `/api/images/file/${imageId}`,
      fileHash: hashFile(fullPath),
      byteSize: buf.length,
      width: 0,
      height: 0,
      makeCurrent: false,
    });

    const now = new Date().toISOString();
    const url = `/api/images/file/${imageId}`;
    const propData = parsePropData(currentVersion.prop_data_json);
    const nextPropData: any = {
      ...propData,
      imageUrl: url,
      rawUrl: url,
      assetId: imageId,
      reference: {
        status: 'ready',
        source: 'manual_upload',
        sourceImageId: imageId,
        currentUrl: url,
        lastKnownGoodUrl: url,
        updatedAt: now,
      },
      uploadedImageId: imageId,
      uploadedImageAt: now,
    };
    delete nextPropData.views;
    delete nextPropData.viewsVersion;
    delete nextPropData.viewHistory;
    delete nextPropData.viewsError;
    delete nextPropData.viewsErrorAt;
    delete nextPropData.imageFailedAt;
    delete nextPropData.imageLastError;

    const updated = updateCurrentCustomPropVersionData({
      ownerId: user.id,
      propId: prop.id,
      propData: nextPropData,
      resultImageId: imageId,
      title: nextPropData.name || prop.title,
    });
    const signed = buildSignedImageUrl(imageId, user.id);

    return jsonOk(signCustomCharacterImageUrls({
      ok: true,
      propId: prop.id,
      imageId,
      url,
      signedUrl: signed.url,
      signedTtl: signed.ttl,
      signedExpiresAt: signed.expiresAt,
      version: serializeCustomPropVersion(updated),
    }, user.id));
  } catch (e: any) {
    return jsonError('上传失败：' + (e?.message || String(e)), 400);
  }
}
