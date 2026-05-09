import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { buildVideoReferenceManifest } from '@/lib/reference-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 把分组里出现的角色/场景/道具与已生成的参考图做稳定文本匹配。
 * 业务规则在 lib/reference-matcher.ts 的 pure function 中，route 只负责鉴权和入参整理。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const group = body?.group || {};
  const shots: any[] = Array.isArray(group?.shots)
    ? group.shots
    : Array.isArray(body?.shots)
      ? body.shots
      : [];
  const result = buildVideoReferenceManifest({
    project: body?.project || {},
    assets: body?.project?.assets || body?.assets || {},
    shots,
    groupShotIndices: Array.isArray(group?.shotIndices) ? group.shotIndices : undefined,
    groupIdx: Number.isInteger(body?.groupIdx) ? body.groupIdx : 0,
    ownerId: user.id,
    storyboardImageUrl: body?.storyboardImageUrl || null,
  });

  return jsonOk({
    refs: result.manifest,
    droppedReferences: result.droppedReferences,
    candidates: result.candidates,
    budget: result.budget,
    note: 'P0.1 deterministic pure matcher: shots/assets/storyboardImageUrl only.',
  });
}
