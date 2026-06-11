import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { patchProjectForUser } from '@/lib/projects-db';
import {
  maybeAssertStoryboardsAlignedWithShots,
  storyboardShotIndices,
} from '@/lib/frame-workflow-state';
import { markTailFrameDeleted } from '@/lib/visual-reference-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function cleanUrl(value: any): string {
  return String(value || '').trim();
}

function routeError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

function hasTailFrameFailureMetadata(sb: any): boolean {
  return !!(
    String(sb?.tailFrameLastError || '').trim() ||
    sb?.tailFrameFailedAt ||
    sb?.tailFrameSafetyAudit ||
    sb?.tailFrameErrorCode ||
    sb?.tailFrameRecoveryHint
  );
}

function isTailFrameAlreadyDeleted(sb: any): boolean {
  const framesTail = sb?.frames && typeof sb.frames === 'object' ? sb.frames.tail : null;
  return (
    String(sb?.tailFrameIntent || '') === 'none' &&
    !framesTail &&
    !cleanUrl(sb?.tailFrameUrl) &&
    !cleanUrl(sb?.tailFramePrompt) &&
    (sb?.tailFrameSourceHash == null || sb?.tailFrameSourceHash === '') &&
    String(sb?.tailFrameReferenceStatus || 'missing') === 'missing' &&
    !hasTailFrameFailureMetadata(sb)
  );
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const frameType = String(body?.frameType || '').trim();

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (frameType !== 'tail_frame') return jsonError('当前仅支持删除尾帧', 400);

  try {
    let tailFrameIntentUpdatedAt: string | null = null;
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) throw routeError(`槽位 ${groupIdx + 1} 没有对应镜头`, 400);

      const prev = storyboards[groupIdx] || {};
      const staleKey = `tail_frame_${groupIdx}`;
      const prevStaleFlags = (fresh as any)._staleFlags;
      const hasStaleFlag = !!(prevStaleFlags && typeof prevStaleFlags === 'object' && prevStaleFlags[staleKey]);
      if (isTailFrameAlreadyDeleted(prev) && !hasStaleFlag) return null;

      const now = new Date().toISOString();
      tailFrameIntentUpdatedAt = now;
      const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' });
      const nextStoryboard = {
        ...markTailFrameDeleted(prev, { at: now }),
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices,
      };
      storyboards[groupIdx] = nextStoryboard;
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'tail-frame-delete');

      if (hasStaleFlag) {
        const nextStaleFlags: Record<string, any> = { ...prevStaleFlags };
        delete nextStaleFlags[staleKey];
        return { storyboards, _staleFlags: nextStaleFlags };
      }
      return { storyboards };
    });

    if (!updated) return jsonError('项目不存在', 404);
    return jsonOk({
      ok: true,
      projectId,
      groupIdx,
      frameType: 'tail_frame',
      tailFrameIntent: 'none',
      tailFrameIntentUpdatedAt,
      serverVersion: Number((updated as any)?.version) || undefined,
    });
  } catch (err: any) {
    return jsonError(err?.message || '删除尾帧失败', Number(err?.status) || 500);
  }
}
