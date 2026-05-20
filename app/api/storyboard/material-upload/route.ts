import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import {
  storeStoryboardMaterialImage,
  StoryboardMaterialImageError,
} from '@/lib/storyboard-material-images';
import { normalizeStoryboardMaterialRole } from '@/lib/reference-roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 1 * 1024 * 1024;

function parseGroupIdx(raw: unknown): number | null {
  const n = Number(String(raw || '').trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(
      `图片过大: 请求体超过上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
      413,
    );
  }

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const projectId = String(form.get('projectId') || '').trim();
    const groupIdx = parseGroupIdx(form.get('groupIdx'));
    const role = normalizeStoryboardMaterialRole(form.get('role'));
    const materialId = String(form.get('materialId') || '').trim();

    if (!file) return jsonError('没有上传文件', 400);
    if (!projectId) return jsonError('缺少 projectId', 400);
    if (groupIdx == null) return jsonError('缺少 groupIdx (非负整数)', 400);
    if (!role) return jsonError('素材类型无效', 400);
    if (!materialId) return jsonError('缺少 materialId', 400);

    const project = getDb()
      .prepare('SELECT id FROM projects WHERE id = ? AND owner_id = ? LIMIT 1')
      .get(projectId, user.id);
    if (!project) return jsonError('项目不存在或无权访问', 403);

    const declaredSize = Number((file as any).size || 0);
    if (declaredSize && declaredSize > MAX_IMAGE_BYTES) {
      return jsonError(`图片过大: 最大 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const stored = await storeStoryboardMaterialImage({
      ownerId: user.id,
      projectId,
      groupIdx,
      role,
      materialId,
      buffer,
    });

    return jsonOk({ ok: true, ...stored });
  } catch (error: any) {
    if (error instanceof StoryboardMaterialImageError) {
      return NextResponse.json(
        { detail: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error('[storyboard/material-upload] failed:', error);
    return NextResponse.json(
      { detail: '素材上传失败', code: 'material_upload_failed' },
      { status: 500 },
    );
  }
}
