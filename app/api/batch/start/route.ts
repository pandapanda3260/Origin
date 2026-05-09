import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { ActiveVideoBatchConflictError, createBatch } from '@/lib/batches';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { validateCharacterConsistencyForGroup } from '@/lib/character-consistency-gate';
import { assertVideoPromptReadyForGroups } from '@/lib/video-prompt-state';
import '@/lib/init-executors'; // 副作用：注册所有 executor

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function nextActionForConsistencyBlocker(blocker: { code?: string; subReason?: string }): string {
  if (blocker.code === 'character_status_not_locked') return 'confirm_character_lock';
  if (blocker.code === 'nonhuman_species_missing') return 'fill_species';
  if (blocker.code === 'critical_reference_missing') {
    const subReason = String(blocker.subReason || '');
    if (subReason.startsWith('prop:')) return 'regenerate_prop_reference';
    if (subReason.startsWith('character:')) return 'regenerate_character_reference';
    if (subReason.startsWith('scene:')) return 'regenerate_scene_reference';
    if (subReason.startsWith('firstFrame:')) return 'regenerate_first_frame';
    return 'review_reference_image';
  }
  return 'review_character_consistency';
}

function nextActionsForVideoPreflightReason(reason: string): string[] {
  if (reason === 'missing_first_frame' || reason === 'first_frame_failed' || reason === 'legacy_sketch_only') return ['regenerate_first_frame'];
  if (reason === 'first_frame_degraded') return ['continue_with_last_known_good_reference', 'regenerate_first_frame'];
  if (reason === 'missing_video_prompt' || reason === 'video_prompt_failed') return ['regenerate_video_prompt'];
  if (reason === 'video_prompt_generating') return ['wait_video_prompt'];
  return ['review_video_readiness'];
}

function videoPreflightMessage(item: any): string {
  const groupLabel = `片段 ${Number(item?.groupIdx ?? 0) + 1}`;
  const reason = String(item?.reason || '');
  if (reason === 'missing_first_frame') return `${groupLabel} 缺少彩色首帧，请先重新生成首帧。`;
  if (reason === 'first_frame_failed') return `${groupLabel} 首帧生成失败，请先重新生成首帧。`;
  if (reason === 'legacy_sketch_only') return `${groupLabel} 只有黑白手稿分镜，缺少可用于视频的彩色首帧，请重新生成首帧。`;
  if (reason === 'first_frame_degraded') return `${groupLabel} 正在使用 last known good 首帧，可继续但建议重新生成最新首帧。`;
  if (reason === 'missing_video_prompt') return `${groupLabel} 缺少视频提示词，请先生成视频提示词。`;
  if (reason === 'video_prompt_failed') return `${groupLabel} 视频提示词生成失败，请先重新生成视频提示词。`;
  if (reason === 'video_prompt_generating') return `${groupLabel} 视频提示词仍在生成中，请等待完成。`;
  return `${groupLabel} 视频生成前检查未通过：${reason || 'not_ready'}`;
}

function formatVideoPreflightBlockedItem(item: any) {
  if (item?.consistency) {
    const gate = item.consistency;
    return {
      groupIdx: gate.groupIdx,
      status: item.status,
      reason: item.reason,
      score: gate.score,
      level: gate.level,
      blockers: gate.blockers,
      warnings: gate.warnings,
      nextActions: Array.from(new Set((gate.blockers || []).map(nextActionForConsistencyBlocker))),
    };
  }
  const reason = String(item?.reason || 'not_ready');
  return {
    groupIdx: item.groupIdx,
    status: item.status,
    reason,
    url: item.url,
    blockers: [{
      code: reason,
      subReason: String(item?.status || ''),
      message: videoPreflightMessage(item),
    }],
    warnings: [],
    nextActions: nextActionsForVideoPreflightReason(reason),
  };
}

function formatVideoPreflightWarningItem(item: any) {
  const reason = String(item?.reason || 'warning');
  return {
    groupIdx: item.groupIdx,
    status: item.status,
    reason,
    url: item.url,
    message: videoPreflightMessage(item),
    nextActions: nextActionsForVideoPreflightReason(reason),
  };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const batchType: string = (body.batchType || '').toString();
  const projectId: string = (body.projectId || '').toString();
  const options: any = body.options || {};
  let videoPreflightWarnings: any[] = [];

  if (!batchType) return jsonError('缺 batchType', 400);
  if (!projectId) return jsonError('缺 projectId', 400);

  // targets 兼容：
  //   1. 标准：body.targets = [{...}, ...]
  //   2. videoTasks.js 老协议：body.storyboardIndices = [0, 2, 3]
  //      → 自动展开成 [{ groupIdx, idx, storyboardIdx }]
  let targets: any[] = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length && Array.isArray(body.storyboardIndices)) {
    targets = body.storyboardIndices
      .map((v: any) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n >= 0)
      .map((n: number) => ({ groupIdx: n, idx: n, storyboardIdx: n }));
  }

  if (!targets.length) return jsonError('targets 不能为空', 400);

  if (batchType === 'video_prompts') {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    const blocked = targets
      .map((target: any) => {
        const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
        const groupIdx = Number(rawGroupIdx);
        if (!Number.isFinite(groupIdx) || groupIdx < 0) return null;
        const shotIndices = Array.isArray(target?.shotIndices)
          ? target.shotIndices.filter((idx: any) => Number.isInteger(idx) && idx >= 0)
          : undefined;
        const gate = validateCharacterConsistencyForGroup(proj as any, {
          groupIdx: Math.floor(groupIdx),
          shotIndices,
          target: 'videoPrompt',
        });
        return gate.allowed ? null : gate;
      })
      .filter(Boolean) as ReturnType<typeof validateCharacterConsistencyForGroup>[];

    if (blocked.length) {
      const first = blocked[0];
      const reason = first.blockers.map((b) => b.message).join('；') || '角色一致性未通过';
      return Response.json(
        {
          detail: `视频提示词生成前检查未通过：片段 ${first.groupIdx + 1} ${reason}`,
          code: 'video_prompt_preflight_failed',
          preflight: {
            allowed: false,
            blocked: blocked.map((gate) => ({
              groupIdx: gate.groupIdx,
              score: gate.score,
              level: gate.level,
              blockers: gate.blockers,
              warnings: gate.warnings,
              nextActions: Array.from(new Set(gate.blockers.map(nextActionForConsistencyBlocker))),
            })),
          },
        },
        { status: 409 },
      );
    }
  }

  if (batchType === 'videos' || batchType === 'video_segments') {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    const groupIdxs = Array.from(
      new Set(
        targets
          .map((target: any) => Number(target?.groupIdx ?? target?.storyboardIdx ?? target?.idx))
          .filter((n: number) => Number.isFinite(n) && n >= 0)
          .map((n: number) => Math.floor(n)),
      ),
    );
    const readiness = assertVideoPromptReadyForGroups(proj as any, groupIdxs);
    const warningItems = (readiness.warnings || []).map(formatVideoPreflightWarningItem);
    if (!readiness.ok) {
      const blockedItems = readiness.blocked.map(formatVideoPreflightBlockedItem);
      const labels = blockedItems.map((item) => `${item.groupIdx + 1}(${item.reason})`).join('、');
      return Response.json(
        {
          error: `视频生成前检查未通过：片段 ${labels}`,
          code: 'video_segment_preflight_failed',
          detail: `视频生成前检查未通过：片段 ${labels}`,
          preflight: {
            allowed: false,
            blocked: blockedItems,
            warnings: warningItems,
          },
        },
        { status: 409 },
      );
    }
    if (warningItems.length && options?.ackPreflightWarnings !== true) {
      const labels = warningItems.map((item) => `${item.groupIdx + 1}(${item.reason})`).join('、');
      return Response.json(
        {
          error: `视频生成前检查有警告：片段 ${labels}`,
          code: 'video_segment_preflight_warning',
          detail: `视频生成前检查有警告：片段 ${labels}`,
          preflight: {
            allowed: true,
            blocked: [],
            warnings: warningItems,
          },
        },
        { status: 409 },
      );
    }
    if (warningItems.length) videoPreflightWarnings = warningItems;
  }

  try {
    const { batchId, total, reused, duplicateGroupIdxs } = createBatch({ user, batchType, projectId, targets, options });
    return jsonOk({
      batchId,
      total,
      status: reused ? 'running' : 'queued',
      reused: !!reused,
      duplicateGroupIdxs: duplicateGroupIdxs || [],
      preflight: videoPreflightWarnings.length
        ? { allowed: true, blocked: [], warnings: videoPreflightWarnings }
        : undefined,
    });
  } catch (e: any) {
    if (e instanceof ActiveVideoBatchConflictError) {
      return jsonError(e.message, 409);
    }
    return jsonError('创建 batch 失败：' + (e?.message || String(e)), 500);
  }
}
