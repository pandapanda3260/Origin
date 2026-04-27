import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getImageMeta } from '@/lib/image-gen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 这个路由按原站契约保留（前端某些路径会拼接 /api/asset/<id>），
 * 阶段三里只用于"已生成图的元数据查询"和"删除"。
 *
 * 真正的"生成参考图"流程走 /api/batch/start + /api/batch/[id]/stream。
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const meta = getImageMeta(params.id, user.id);
  if (!meta) return jsonError('图片不存在', 404);
  return jsonOk({
    id: meta.id,
    url: meta.publicUrl,
    width: meta.width,
    height: meta.height,
    kind: meta.kind,
    assetRef: meta.asset_ref,
    prompt: meta.prompt,
    createdAt: meta.created_at,
  });
}

export async function PUT() {
  // 修改图本身在阶段四（视频）才会涉及，这里先占位
  return jsonOk({ ok: true });
}

export async function DELETE() {
  // 真删除留到下个阶段做软删除流程；目前只返回 ok
  return jsonOk({ ok: true });
}
