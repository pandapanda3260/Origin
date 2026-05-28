import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { patchProjectForUser } from '@/lib/projects-db';
import {
  maybeAssertStoryboardsAlignedWithShots,
  storyboardShotIndices,
} from '@/lib/frame-workflow-state';
import {
  nextTailFrameHistory,
  tailFrameHistoryItemFromCurrent,
} from '@/lib/tail-frame-edit-draft';

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

function historySubmittedPrompt(item: any, fallback: unknown): string {
  return String(item?.submittedPrompt ?? item?.prompt ?? fallback ?? '').trim();
}

function historyBasePrompt(item: any, fallback: unknown): string {
  return String(item?.firstFrameBasePrompt ?? item?.originalPrompt ?? item?.prompt ?? fallback ?? '').trim();
}

function currentBasePrompt(sb: any): string {
  return String(
    sb?.firstFrameBasePrompt?.content
    || sb?.originalFirstFramePrompt
    || sb?.frames?.first?.originalPrompt
    || '',
  ).trim();
}

function tailHistorySubmittedPrompt(item: any, fallback: unknown): string {
  return String(item?.submittedPrompt ?? item?.prompt ?? fallback ?? '').trim();
}

function tailHistoryBasePrompt(item: any, fallback: unknown): string {
  return String(item?.tailFrameBasePrompt ?? item?.originalPrompt ?? item?.prompt ?? fallback ?? '').trim();
}

function currentTailBasePrompt(sb: any): string {
  return String(
    sb?.tailFrameBasePrompt?.content
    || sb?.originalTailFramePrompt
    || sb?.frames?.tail?.originalPrompt
    || '',
  ).trim();
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const historyUrl = cleanUrl(body?.historyUrl);
  const frameType = String(body?.frameType || 'first_frame').trim();

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (!historyUrl) return jsonError('缺 historyUrl', 400);
  if (frameType !== 'first_frame' && frameType !== 'tail_frame') return jsonError('不支持的 frameType', 400);

  let restored: any = null;
  try {
    if (frameType === 'tail_frame') {
      const updated = patchProjectForUser(projectId, user.id, (fresh) => {
        if (!fresh) return null;
        const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
        const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
        if (groupIdx >= shots.length) throw new Error(`槽位 ${groupIdx + 1} 没有对应镜头`);
        const prev = storyboards[groupIdx] || {};
        const history = Array.isArray(prev.tailFrameHistory) ? prev.tailFrameHistory : [];
        const historyItem = history.find((item: any) => cleanUrl(item?.url) === historyUrl);
        if (!historyItem) {
          const err = new Error('invalid_history_url');
          (err as any).status = 422;
          throw err;
        }

        const now = new Date().toISOString();
        const previousHistoryItem = tailFrameHistoryItemFromCurrent(prev, {
          at: now,
          source: 'current_before_tail_history_restore',
        });
        const nextHistory = nextTailFrameHistory(
          history.filter((item: any) => cleanUrl(item?.url) !== historyUrl),
          previousHistoryItem,
          { excludeUrls: [historyUrl] },
        );
        const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' });
        const sourceHash = typeof historyItem.sourceHash === 'string' ? historyItem.sourceHash : null;
        const submittedPrompt = tailHistorySubmittedPrompt(
          historyItem,
          prev.tailFramePrompt || prev.frames?.tail?.prompt || '',
        );
        const basePrompt = tailHistoryBasePrompt(
          historyItem,
          currentTailBasePrompt(prev) || submittedPrompt,
        );
        const rawUrl = cleanUrl(historyItem.rawUrl) || historyUrl;
        const mode = historyItem.mode || prev.tailFrameMode || prev.frames?.tail?.mode || 'history_restore';
        const planSummary = historyItem.planSummary || prev.tailFramePlanSummary || prev.frames?.tail?.planSummary || null;
        const safetyAudit = historyItem.safetyAudit || prev.tailFrameSafetyAudit || prev.frames?.tail?.safetyAudit || null;
        const nextStoryboard = {
          ...prev,
          idx: groupIdx,
          shotIdx: groupIdx + 1,
          shotIndices,
          tailFrameUrl: historyUrl,
          tailFrameMode: mode,
          tailFrameSourceHash: sourceHash,
          tailFramePrompt: submittedPrompt,
          originalTailFramePrompt: basePrompt,
          tailFrameBasePrompt: {
            content: basePrompt,
            sourceHash,
            updatedAt: now,
            updatedBy: user.id,
            origin: 'history_restore',
          },
          tailFramePlanSummary: planSummary,
          tailFrameSafetyAudit: safetyAudit,
          tailFrameLastError: undefined,
          tailFrameFailedAt: undefined,
          tailFrameIntent: 'requested',
          tailFrameIntentUpdatedAt: now,
          tailFrameReferenceStatus: 'ready',
          tailFrameHistory: nextHistory,
          frames: {
            ...(prev.frames || {}),
            tail: {
              ...(prev.frames?.tail || {}),
              url: historyUrl,
              rawUrl,
              status: 'ready',
              source: 'history_restore',
              mode,
              generatedAt: historyItem.at || now,
              sourceHash,
              shotIndices,
              prompt: submittedPrompt,
              originalPrompt: basePrompt,
              planSummary,
              safetyAudit,
              referenceStatus: 'ready',
            },
          },
        };
        delete nextStoryboard.tailFrameEditDraft;
        storyboards[groupIdx] = nextStoryboard;
        maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'tail-frame-history-restore');
        restored = {
          url: historyUrl,
          sourceHash,
          sourceHashKnown: !!sourceHash,
        };
        return { storyboards };
      });

      return jsonOk({ restored, projectUpdatedAt: (updated as any)?.updatedAt || null });
    }

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
    const previousBasePrompt = currentBasePrompt(prev);
    const previousSubmittedPrompt = prev.firstFramePrompt || prev.frames?.first?.prompt || prev.imagePrompt || '';
    const previousHistoryItem = previousUrl
      ? {
          url: previousUrl,
          ...(prev.rawUrl && prev.rawUrl !== previousUrl ? { rawUrl: prev.rawUrl } : {}),
          at: now,
          source: prev.firstFrameMode || prev.firstFrame?.source || 'current_before_history_restore',
          mode: prev.firstFrameMode || prev.frames?.first?.mode || 'structured_v1',
          sourceHash: prev.firstFrameSourceHash || prev.frames?.first?.sourceHash || null,
          firstFrameBasePrompt: previousBasePrompt,
          submittedPrompt: previousSubmittedPrompt,
          planSummary: prev.firstFramePlanSummary || prev.frames?.first?.planSummary || null,
        }
      : null;
    const nextHistory = [
      ...(previousHistoryItem ? [previousHistoryItem] : []),
      ...history.filter((item: any) => cleanUrl(item?.url) !== historyUrl && cleanUrl(item?.url) !== previousUrl),
    ].slice(0, 30);
    const shotIndices = storyboardShotIndices(fresh, groupIdx, prev, { mode: 'single-shot-strict' });
    const sourceHash = typeof historyItem.sourceHash === 'string' ? historyItem.sourceHash : null;
    const basePrompt = historyBasePrompt(historyItem, currentBasePrompt(prev));
    const submittedPrompt = historySubmittedPrompt(historyItem, prev.firstFramePrompt || prev.frames?.first?.prompt || '');
    const rawUrl = cleanUrl(historyItem.rawUrl) || historyUrl;
    const nextStoryboard = {
      ...prev,
      idx: groupIdx,
      shotIdx: groupIdx + 1,
      shotIndices,
      url: historyUrl,
      imageUrl: historyUrl,
      rawUrl,
      firstFrameUrl: historyUrl,
      firstFrameMode: historyItem.mode || prev.firstFrameMode || 'history_restore',
      firstFrameSourceHash: sourceHash,
      firstFramePrompt: submittedPrompt,
      imagePrompt: submittedPrompt,
      originalFirstFramePrompt: basePrompt,
      firstFrameBasePrompt: {
        content: basePrompt,
        sourceHash,
        updatedAt: now,
        updatedBy: user.id,
        origin: 'history_restore',
      },
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
          prompt: submittedPrompt,
          originalPrompt: basePrompt,
          planSummary: historyItem.planSummary || prev.frames?.first?.planSummary || null,
        },
      },
    };
    delete nextStoryboard.firstFrameEditDraft;
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
