import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { createToolboxItem, serializeToolboxItem } from '@/lib/toolbox-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const uploadId = String(body.uploadId || body.mediaId || '').trim();
  if (!uploadId) return jsonError('缺少 uploadId', 400);

  const upload = getDb()
    .prepare<{ id: string; ownerId: number }, any>(
      `SELECT id, kind, filename, mime FROM uploads
        WHERE id = @id AND owner_id = @ownerId LIMIT 1`,
    )
    .get({ id: uploadId, ownerId: user.id });
  if (!upload) return jsonError('上传素材不存在', 404);
  if (upload.kind !== 'image' && upload.kind !== 'video') {
    return jsonError('工具箱历史仅支持图片或视频上传项', 400);
  }

  const item = createToolboxItem({
    ownerId: user.id,
    toolType: upload.kind,
    mode: 'upload',
    sourceType: 'upload',
    status: 'completed',
    prompt: '',
    params: { uploadKind: upload.kind },
    inputRefs: [],
    resultRefType: 'upload',
    resultRefId: upload.id,
  });

  return jsonOk({ ok: true, item: serializeToolboxItem(item) });
}
