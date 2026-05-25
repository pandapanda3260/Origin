import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { patchProjectForUser } from '@/lib/projects-db';
import {
  maybeAssertStoryboardsAlignedWithShots,
  storyboardShotIndices,
} from '@/lib/frame-workflow-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function cleanUrl(value: unknown): string {
  return String(value || '').trim();
}

function currentFrameUrl(sb: any): string {
  return cleanUrl(sb?.frames?.first?.url || sb?.firstFrameUrl || sb?.imageUrl || sb?.rawUrl || sb?.url);
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const historyUrl = cleanUrl(body?.historyUrl);

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (!historyUrl) return jsonError('缺 historyUrl', 400);

  let restored: any = null;
  try {
  const updated = patchProjectForUser(projectId, user.id, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
    if (groupIdx >= shots.length) throw new Error(`槽位 ${groupIdx + 1} 没有对应镜头`);
    const prev = storyboards[groupIdx] || {};
    const history = Array.isArray(prev.imageHistory) ? prev.imageHistory : [];
    const historyItem = history.find((item: any) => cleanUrl(item?.url) === historyUrl);
    if (!historyItem) {
      const err = new Error('invalid_history_url');
      (err as any).status = 422;
      throw err;
    }

    const now = new Date().toISOString();
    const previousUrl = currentFrameUrl(prev);
    const previousHistoryItem = previousUrl
      ? {
          url: previousUrl,
          at: now,
          source: prev.firstFrameMode || prev.firstFrame?.source || 'current_before_history_restore',
          sourceHash: prev.firstFrameSourceHash || prev.frames?.first?.sourceHash || null,
          prompt: prev.firstFramePrompt || prev.frames?.first?.prompt || '',
          planSummary: prev.firstFramePlanSummary || prev.frames?.first?.planSummary || null,
        }
      : null;
    const nextHistory = [
      ...(previousHistoryItem ? [previousHistoryItem] : []),
      ...history.filter((item: any) => cleanUrl(item?.url) !== historyUrl && cleanUrl(item?.url) !== previousUrl),
    ].slice(0, 30);
    const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' });
    const sourceHash = typeof historyItem.sourceHash === 'string' ? historyItem.sourceHash : null;
    const nextStoryboard = {
      ...prev,
      idx: groupIdx,
      shotIdx: groupIdx + 1,
      shotIndices,
      url: historyUrl,
      imageUrl: historyUrl,
      rawUrl: historyUrl,
      firstFrameUrl: historyUrl,
      firstFrameMode: historyItem.mode || prev.firstFrameMode || 'history_restore',
      firstFrameSourceHash: sourceHash,
      firstFramePrompt: historyItem.prompt || prev.firstFramePrompt || '',
      firstFramePlanSummary: historyItem.planSummary || prev.firstFramePlanSummary || null,
      firstFrameLastError: undefined,
      firstFrameFailedAt: undefined,
      imageHistory: nextHistory,
      firstFrame: {
        ...(prev.firstFrame || {}),
        currentUrl: historyUrl,
        rawUrl: historyUrl,
        status: 'ready',
        source: 'history_restore',
        lastKnownGoodUrl: historyUrl,
        sourceHash,
      },
      frames: {
        ...(prev.frames || {}),
        first: {
          ...(prev.frames?.first || {}),
          url: historyUrl,
          status: 'ready',
          source: 'history_restore',
          mode: historyItem.mode || prev.frames?.first?.mode || 'history_restore',
          generatedAt: historyItem.at || now,
          sourceHash,
          shotIndices,
          prompt: historyItem.prompt || prev.frames?.first?.prompt || '',
          planSummary: historyItem.planSummary || prev.frames?.first?.planSummary || null,
        },
      },
    };
    // 用户原则: 切首帧历史版本不连带 stale 尾帧, 也不删除已生成的 videoTasks。
    storyboards[groupIdx] = nextStoryboard;
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'first-frame-history-restore');
    restored = {
      url: historyUrl,
      sourceHash,
      sourceHashKnown: !!sourceHash,
    };
    return { storyboards };
  });

  return jsonOk({ restored, projectUpdatedAt: (updated as any)?.updatedAt || null });
  } catch (err: any) {
    if (err?.status === 422 || err?.message === 'invalid_history_url') {
      return Response.json(
        { error: 'invalid_history_url', code: 'invalid_history_url', detail: '历史图片不属于当前片段。' },
        { status: 422 },
      );
    }
    return jsonError(err?.message || '恢复历史图片失败', 500);
  }
}
