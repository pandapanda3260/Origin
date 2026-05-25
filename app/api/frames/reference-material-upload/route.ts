import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getDataDir } from '@/lib/runtime-paths';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  buildFirstFrameMaterialPanel,
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  nextFirstFrameReferenceMaterialsVersion,
  normalizeFirstFrameReferenceMaterials,
  type FirstFrameMaterialTileRole,
  type FirstFrameReferenceMaterial,
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

function conflictResponse(message: string, code: string, firstFrameMaterialPanel: unknown) {
  return Response.json(
    { error: message, code, firstFrameMaterialPanel },
    { status: 409 },
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
      return conflictResponse('参考素材已变更，请刷新后继续。', 'reference_source_changed', preflightPanel);
    }
    if (baseSelectionVersion && baseSelectionVersion !== preflightPanel.selectionVersion) {
      return conflictResponse('参考素材状态已更新，请确认后重试。', 'reference_selection_changed', preflightPanel);
    }

    const mime = (file as any).type || 'image/jpeg';
    if (!mime.startsWith('image/')) return jsonError('仅支持图片文件', 415);
    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[first-frame-reference-material-upload]', null)`,
    ).run(
      imageId,
      user.id,
      projectId,
      'frame_first_reference',
      `projects.${projectId}.firstFrameReferenceMaterials`,
      filename,
      mime,
      buf.length,
    );

    const uploadedAt = new Date().toISOString();
    const material: FirstFrameReferenceMaterial = {
      id: `upload:${imageId}`,
      imageId,
      role,
      name: cleanFileBaseName(file) || '上传参考图',
      url: `/api/images/file/${imageId}`,
      thumbUrl: `/api/images/file/${imageId}`,
      uploadedAt,
      uploadedBy: user.id,
    };

    let sourceHash: string | null = null;
    let firstFrameMaterialPanel: unknown = null;
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const preview = buildFirstFramePlanPreview({ project: fresh, groupIdx, ownerId: user.id, user });
      sourceHash = preview.sourceHash;
      const { draft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const existing = normalizeFirstFrameReferenceMaterials(fresh);
      const nextMaterials = [
        material,
        ...existing.filter((item) => item.id !== material.id && item.imageId !== material.imageId),
      ];
      const nextFresh = {
        ...fresh,
        firstFrameReferenceMaterials: nextMaterials,
        firstFrameReferenceMaterialsVersion: nextFirstFrameReferenceMaterialsVersion(),
      };
      firstFrameMaterialPanel = buildFirstFrameMaterialPanel({
        project: nextFresh,
        userId: user.id,
        plan: preview.plan,
        draft,
        sourceHash,
      });
      return {
        firstFrameReferenceMaterials: nextMaterials,
        firstFrameReferenceMaterialsVersion: (nextFresh as any).firstFrameReferenceMaterialsVersion,
      };
    });

    return jsonOk({
      ok: true,
      material,
      sourceHash,
      firstFrameMaterialPanel,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    return jsonError('上传参考素材失败: ' + (err?.message || String(err)), 400);
  }
}
