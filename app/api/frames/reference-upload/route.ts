import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getDataDir } from '@/lib/runtime-paths';
import { createAssetRecord, hashFile, localAssetUri } from '@/lib/asset-library';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  buildFirstFrameDraftWithReferenceAttachment,
  buildFirstFrameMaterialPanel,
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  reconcileFirstFramePromptStateInPatch,
  selectedFirstFrameReferenceTileIds,
  validateAndNormalizeFirstFrameDraft,
  type FirstFrameMaterialTileRole,
  type FirstFrameReferenceAttachment,
  FirstFrameDraftValidationException,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_DIR = getDataDir();
const IMAGES_DIR = join(DATA_DIR, 'images');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 1 * 1024 * 1024;

function parseGroupIdx(raw: unknown): number | null {
  const n = Number(String(raw || '').trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseRole(raw: unknown): FirstFrameMaterialTileRole | null {
  const role = String(raw || '').trim();
  if (role === 'scene' || role === 'char' || role === 'prop') return role;
  if (role === 'character') return 'char';
  return null;
}

function guessExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

function cleanFileBaseName(file: File): string {
  return String((file as any).name || '').replace(/\.[^.]+$/, '').trim().slice(0, 80);
}

function validationResponse(errors: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: errors[0]?.message || 'validation_failed',
      code: 'validation_failed',
      errors,
    },
    { status: 422 },
  );
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(`图片过大: 请求体超过上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = String(form.get('projectId') || '').trim();
    const groupIdx = parseGroupIdx(form.get('groupIdx'));
    const role = parseRole(form.get('role'));
    const baseSourceHash = String(form.get('baseSourceHash') || '').trim();
    const baseSelectionVersion = String(form.get('baseSelectionVersion') || '').trim();

    if (!file) return jsonError('没有上传文件', 400);
    if (!projectId) return jsonError('缺 projectId', 400);
    if (groupIdx == null) return jsonError('缺 groupIdx', 400);
    if (!role) return jsonError('素材类型无效', 400);

    const project = getProjectByIdForUser(projectId, user.id);
    if (!project) return jsonError('项目不存在', 404);

    const mime = (file as any).type || 'image/jpeg';
    if (!mime.startsWith('image/')) return jsonError('仅支持图片文件', 415);
    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const preflightPreview = buildFirstFramePlanPreview({ project, groupIdx, ownerId: user.id, user });
    const { draft: preflightDraft } = currentFirstFrameEditDraft(project, groupIdx);
    const preflightPanel = buildFirstFrameMaterialPanel({
      project,
      userId: user.id,
      plan: preflightPreview.plan,
      draft: preflightDraft,
      sourceHash: preflightPreview.sourceHash,
    });
    if (baseSourceHash && baseSourceHash !== preflightPreview.sourceHash) {
      return Response.json(
        { error: '参考素材已变更，请刷新后继续。', code: 'reference_source_changed', firstFrameMaterialPanel: preflightPanel },
        { status: 409 },
      );
    }
    if (baseSelectionVersion && baseSelectionVersion !== preflightPanel.selectionVersion) {
      return Response.json(
        { error: '参考素材状态已更新，请确认后重试。', code: 'reference_selection_changed', firstFrameMaterialPanel: preflightPanel },
        { status: 409 },
      );
    }
    if (preflightPanel.used >= preflightPanel.cap) {
      return Response.json(
        { error: `参考图已达上限 ${preflightPanel.cap} 张，请先移除一张后再上传。`, code: 'reference_cap_reached' },
        { status: 422 },
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const imageId = randomUUID();
    const dir = join(IMAGES_DIR, String(user.id));
    mkdirSync(dir, { recursive: true });
    const ext = guessExt(mime);
    const filename = `${imageId}.${ext}`;
    const fullPath = join(dir, filename);
    writeFileSync(fullPath, buf);

    const db = getDb();
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[first-frame-reference-upload]', null)`,
    ).run(
      imageId,
      user.id,
      projectId,
      'frame_first_reference',
      `storyboards[${groupIdx}].firstFrameReferenceDraft`,
      filename,
      mime,
      buf.length,
    );
    createAssetRecord({
      assetId: imageId,
      ownerId: user.id,
      projectId,
      legacyShotId: `shot_${groupIdx}`,
      assetKind: 'image',
      source: 'uploaded',
      stage: 'first_frame',
      fileUri: localAssetUri('images', user.id, filename),
      thumbUri: `/api/images/file/${imageId}`,
      fileHash: hashFile(fullPath),
      byteSize: buf.length,
      width: 0,
      height: 0,
      makeCurrent: false,
    });

    const uploadedAt = new Date().toISOString();
    const attachment: FirstFrameReferenceAttachment = {
      id: `upload:${imageId}`,
      imageId,
      role,
      name: cleanFileBaseName(file) || '上传参考图',
      url: `/api/images/file/${imageId}`,
      thumbUrl: `/api/images/file/${imageId}`,
      uploadedAt,
      uploadedBy: user.id,
    };

    let draft: any = null;
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const promptState = reconcileFirstFramePromptStateInPatch({ project: fresh, user, groupIdx });
      sourceHash = promptState.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const panel = buildFirstFrameMaterialPanel({
        project: fresh,
        userId: user.id,
        plan: promptState.plan,
        draft: currentDraft,
        sourceHash,
      });
      if (baseSourceHash && baseSourceHash !== sourceHash) {
        throw Object.assign(new Error('reference_source_changed'), { status: 409, code: 'reference_source_changed', panel });
      }
      if (baseSelectionVersion && baseSelectionVersion !== panel.selectionVersion) {
        throw Object.assign(new Error('reference_selection_changed'), { status: 409, code: 'reference_selection_changed', panel });
      }
      if (panel.used >= panel.cap) {
        throw Object.assign(new Error(`参考图已达上限 ${panel.cap} 张，请先移除一张后再上传。`), {
          status: 422,
          code: 'reference_cap_reached',
        });
      }
      const selectedIds = selectedFirstFrameReferenceTileIds({
        project: fresh,
        userId: user.id,
        plan: promptState.plan,
        draft: currentDraft,
      });
      draft = buildFirstFrameDraftWithReferenceAttachment({
        baseDraft: currentDraft,
        sourceHash,
        userId: user.id,
        attachment,
        includeIds: [...selectedIds, attachment.id],
        project: fresh,
        plan: promptState.plan,
      });
      validateAndNormalizeFirstFrameDraft({
        project: fresh,
        groupIdx,
        userId: user.id,
        input: draft,
        plan: promptState.plan,
      });
      savedDraftFingerprint = firstFrameDraftFingerprint(draft);
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      storyboards[groupIdx] = {
        ...prev,
        ...(promptState.slotPatch || {}),
        firstFrameEditDraft: draft,
      };
      return { storyboards };
    });

    return jsonOk({
      ok: true,
      attachment,
      draft,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof FirstFrameDraftValidationException) return validationResponse(err.errors);
    if (err?.status === 409) {
      return Response.json(
        {
          error: err.code === 'reference_source_changed'
            ? '参考素材已变更，请刷新后继续。'
            : '参考素材状态已更新，请确认后重试。',
          code: err.code || 'reference_selection_changed',
          firstFrameMaterialPanel: err.panel || undefined,
        },
        { status: 409 },
      );
    }
    if (err?.status === 422) {
      return Response.json(
        { error: err.message || 'reference_upload_invalid', code: err.code || 'validation_failed' },
        { status: 422 },
      );
    }
    return jsonError('上传参考图失败: ' + (err?.message || String(err)), 400);
  }
}
