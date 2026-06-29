import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { patchProjectForUser } from '@/lib/projects-db';
import { maybeAssertStoryboardsAlignedWithShots } from '@/lib/frame-workflow-state';
import { applyShotFrameCandidateAction } from '@/lib/shot-frame-candidates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = cleanText(body?.projectId);
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const shotUid = cleanText(body?.shotUid);
  const action = cleanText(body?.action);
  const candidateId = cleanText(body?.candidateId);
  const orderedIds = Array.isArray(body?.orderedIds) ? body.orderedIds.map(cleanText).filter(Boolean) : [];

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (!shotUid) return jsonError('缺 shotUid', 400);
  if (action !== 'select' && action !== 'reorder' && action !== 'delete') return jsonError('不支持的候选动作', 400);
  if ((action === 'select' || action === 'delete') && !candidateId) return jsonError('缺 candidateId', 400);
  if (action === 'reorder' && !orderedIds.length) return jsonError('缺 orderedIds', 400);

  try {
    let result: any = null;
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const input = action === 'reorder'
        ? { action, groupIdx, shotUid, orderedIds } as const
        : { action, groupIdx, shotUid, candidateId } as const;
      result = applyShotFrameCandidateAction(fresh, input);
      maybeAssertStoryboardsAlignedWithShots(result.project, 'first-frame-candidate-action');
      return {
        storyboards: result.project.storyboards,
        videoTasks: result.project.videoTasks,
      };
    });
    if (!updated) return jsonError('项目不存在', 404);
    return jsonOk({
      ok: true,
      projectId,
      groupIdx,
      shotUid,
      action,
      selectedCandidateId: result?.state?.selectedCandidateId || null,
      candidates: result?.state?.candidates || [],
      videoInvalidated: !!result?.videoInvalidated,
      serverVersion: Number((updated as any)?.version) || undefined,
    });
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    return jsonError(err?.message || '候选操作失败', status);
  }
}
