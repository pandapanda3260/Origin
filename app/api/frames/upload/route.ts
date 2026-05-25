import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { patchProjectForUser } from '@/lib/projects-db';
import { buildSignedImageUrl } from '@/lib/signed-asset-url';
import { getDataDir } from '@/lib/runtime-paths';
import { createAssetRecord, hashFile, localAssetUri } from '@/lib/asset-library';
import {
  computeFirstFrameSourceHash,
  computeTailFrameSourceHash,
  maybeAssertStoryboardsAlignedWithShots,
  storyboardShotIndices,
} from '@/lib/frame-workflow-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 1 * 1024 * 1024;
const ALLOWED_MIME_PREFIX = ['image/'];

type FrameKind = 'first_frame' | 'tail_frame';

function parseFrameKind(raw: unknown): FrameKind | null {
  const v = String(raw || '').trim();
  if (v === 'first_frame' || v === 'tail_frame') return v;
  return null;
}

function parseIntOrNull(raw: unknown): number | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

/**
 * 用户上传自定义首帧/尾帧图 (P2.5b.T1)。
 * 独立于 upload-char-image (后者是角色参考图专用, 会 mutate character lock)。
 * 这里只落 storyboards[groupIdx] 的 frame* 字段和 frames.{first,tail}.source='uploaded'.
 *
 * 支持首帧/尾帧手动上传。只落当前 storyboard frame 字段, 不触碰角色/场景资产锁。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(
      `文件过大: 请求体超过上限 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB`,
      413,
    );
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = (form.get('projectId') || '').toString();
    const frameType = parseFrameKind(form.get('frameType'));
    const groupIdx = parseIntOrNull(form.get('groupIdx'));

    if (!file) return jsonError('没有上传文件', 400);
    if (!frameType) return jsonError("frameType 必须是 'first_frame' 或 'tail_frame'", 400);
    if (!projectId) return jsonError('缺少 projectId', 400);
    if (groupIdx == null) return jsonError('缺少 groupIdx (非负整数)', 400);

    const mime = (file as any).type || 'image/jpeg';
    if (!ALLOWED_MIME_PREFIX.some((p) => mime.startsWith(p))) {
      return jsonError('仅支持图片文件', 415);
    }
    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const id = randomUUID();
    const dir = join(IMAGES_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const ext = guessExt(mime);
    const filename = `${id}.${ext}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, buf);

    const isTail = frameType === 'tail_frame';
    const kindDb = isTail ? 'frame_tail' : 'frame_first';
    const assetRef = isTail ? `storyboards[${groupIdx}].tailFrame` : `storyboards[${groupIdx}].firstFrame`;

    const db = getDb();
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[uploaded]', null)`,
    ).run(id, user.id, projectId, kindDb, assetRef, filename, mime, buf.length);
    createAssetRecord({
      assetId: id,
      ownerId: user.id,
      projectId,
      legacyShotId: `shot_${groupIdx}`,
      assetKind: 'image',
      source: 'uploaded',
      stage: isTail ? 'tail_frame' : 'first_frame',
      fileUri: localAssetUri('images', user.id, filename),
      thumbUri: `/api/images/file/${id}`,
      fileHash: hashFile(fullPath),
      byteSize: buf.length,
      width: 0,
      height: 0,
      makeCurrent: true,
    });

    const url = `/api/images/file/${id}`;
    const signed = buildSignedImageUrl(id, user.id);
    const generatedAt = new Date().toISOString();
    let uploadedTailFrameSourceHash: string | null = null;
    let uploadedFirstFrameSourceHash: string | null = null;

    patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards)
        ? [...(fresh as any).storyboards]
        : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) {
        throw new Error(`槽位 ${groupIdx + 1} 没有对应镜头`);
      }
      const prev = storyboards[groupIdx] || {};
      const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' });
      const prevFrames =
        prev.frames && typeof prev.frames === 'object' ? prev.frames : {};
      const tailFrameSourceHash = isTail ? computeTailFrameSourceHash(fresh, user.id, groupIdx) : null;
      const firstFrameSourceHash = !isTail ? computeFirstFrameSourceHash(fresh, user.id, groupIdx) : null;
      if (isTail) uploadedTailFrameSourceHash = tailFrameSourceHash;
      else uploadedFirstFrameSourceHash = firstFrameSourceHash;
      const nextStoryboard = isTail
        ? {
          ...prev,
          idx: groupIdx,
          shotIdx: groupIdx + 1,
          shotIndices,
          tailFrameUrl: url,
          tailFrameMode: 'uploaded',
          tailFrameLastError: undefined,
          tailFrameFailedAt: undefined,
          tailFrameIntent: 'requested',
          tailFrameIntentUpdatedAt: generatedAt,
          tailFrameSourceHash,
          tailFrameReferenceStatus: 'ready',
          frames: {
            ...prevFrames,
            tail: {
              url,
              status: 'ready',
              source: 'uploaded',
              mode: 'uploaded',
              generatedAt,
              sourceHash: tailFrameSourceHash,
              referenceStatus: 'ready',
              shotIndices,
            },
          },
        }
        : {
          ...prev,
          idx: groupIdx,
          shotIdx: groupIdx + 1,
          shotIndices,
          url,
          imageUrl: url,
          rawUrl: url,
          firstFrameUrl: url,
          firstFrameMode: 'uploaded',
          firstFrameSourceHash,
          firstFrameLastError: undefined,
          firstFrameFailedAt: undefined,
          firstFrame: {
            currentUrl: url,
            rawUrl: url,
            status: 'ready',
            source: 'uploaded',
            lastKnownGoodUrl: url,
            history: [{
              url,
              at: generatedAt,
              source: 'uploaded',
            }].concat(Array.isArray(prev.firstFrame?.history)
              ? prev.firstFrame.history.filter((item: any) => item && item.url && item.url !== url)
              : []).slice(0, 20),
          },
          frames: {
            ...prevFrames,
            first: {
              url,
              status: 'ready',
              source: 'uploaded',
              mode: 'uploaded',
              generatedAt,
              sourceHash: firstFrameSourceHash,
              shotIndices,
            },
          },
        };
      // 用户原则: 首帧变化不连带 stale 尾帧, 用户自决重做。
      storyboards[groupIdx] = nextStoryboard;
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'frame-upload');
      return { storyboards };
    });

    return jsonOk({
      ok: true,
      id,
      url,
      signedUrl: signed.url,
      signedTtl: signed.ttl,
      signedExpiresAt: signed.expiresAt,
      frameType,
      groupIdx,
      tailFrameIntent: isTail ? 'requested' : undefined,
      tailFrameIntentUpdatedAt: isTail ? generatedAt : undefined,
      tailFrameSourceHash: isTail ? uploadedTailFrameSourceHash : undefined,
      tailFrameReferenceStatus: isTail ? 'ready' : undefined,
      firstFrameSourceHash: !isTail ? uploadedFirstFrameSourceHash : undefined,
      message: '上传成功',
    });
  } catch (e: any) {
    return jsonError('上传失败: ' + (e?.message || String(e)), 400);
  }
}
