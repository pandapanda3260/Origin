import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { ActiveVideoBatchConflictError, createBatch } from '@/lib/batches';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { assertVideoPromptReadyForGroups, markStoryboardVideoOutdated, markVideoTaskOutdated } from '@/lib/video-prompt-state';
import { resolveLLMConfig } from '@/lib/llm';
import { getVideoSubmitMode, isFirstLastFrameVideoModeEnabled } from '@/lib/feature-flags';
import { resolveLocalImagePath } from '@/lib/image-gen';
import { resolveStoryboardFirstFrameUrl } from '@/lib/visual-reference-state';
import {
  computeFirstLastFeatureEnabled,
  normalizeVideoSubmitMode,
  resolveVideoPayloadDecision,
  warnIfFirstLastConfigIgnored,
} from '@/lib/video-payload-decision';
import { resolveVideoModelCapability } from '@/lib/video-provider-capabilities';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from '@/lib/frame-workflow-state';
import { buildFirstFramePlanPreview, currentFirstFrameEditDraft, isFirstFrameEditDraftStale } from '@/lib/first-frame-edit-draft';
import {
  beginShotPlanGeneration,
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
  type ShotPlanSourceSnapshot,
} from '@/lib/project-dependency-state';
import { logVideoPromptTrace } from '@/lib/video-prompt-observability';
import {
  describeArtifactStatus,
  artifactUsageBlockedPayload,
  type ArtifactUsageDecision,
  type TargetArtifact,
} from '@/lib/sentinel';
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
  if (reason === 'reference_images_mode') return [];
  if (reason === 'missing_first_frame' || reason === 'first_frame_failed' || reason === 'legacy_sketch_only') return ['regenerate_first_frame'];
  if (reason === 'first_frame_degraded') return ['continue_with_last_known_good_reference', 'regenerate_first_frame'];
  if (reason === 'missing_video_prompt' || reason === 'video_prompt_failed') return ['regenerate_video_prompt'];
  if (reason === 'video_prompt_generating') return ['wait_video_prompt'];
  if (reason === 'tail_pending' || reason === 'tail_frame_pending' || reason === 'first_last_frame_tail_pending') return ['wait_tail_frame'];
  if (reason === 'tail_failed' || reason === 'tail_file_missing' || reason === 'tail_missing') return ['regenerate_tail_frame', 'switch_to_strict_first_frame'];
  if (reason === 'capability_unsupported' || reason === 'first_last_frame_capability_unsupported') return ['switch_video_model', 'switch_to_strict_first_frame'];
  if (reason === 'feature_disabled' || reason === 'first_last_frame_feature_disabled') return ['switch_to_strict_first_frame'];
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
  if (reason === 'tail_pending' || reason === 'tail_frame_pending' || reason === 'first_last_frame_tail_pending') return `${groupLabel} 尾帧仍在生成中，请等待尾帧完成后再生成视频。`;
  if (reason === 'tail_failed') return `${groupLabel} 尾帧生成失败，请重新生成尾帧或改用仅首帧模式。`;
  if (reason === 'tail_file_missing') return `${groupLabel} 尾帧文件不可解析，请重新生成尾帧或改用仅首帧模式。`;
  if (reason === 'tail_missing') return `${groupLabel} 缺少可用尾帧，已改用仅首帧模式。`;
  if (reason === 'capability_unsupported' || reason === 'first_last_frame_capability_unsupported') return `${groupLabel} 当前视频模型不支持首尾帧模式，请切换模型或改用仅首帧模式。`;
  if (reason === 'feature_disabled' || reason === 'first_last_frame_feature_disabled') return `${groupLabel} 首尾帧视频模式当前未开启，请改用仅首帧模式。`;
  if (reason === 'reference_images_mode') return `${groupLabel} 当前为多参考图模式，尾帧不会作为 last_frame 参与本次视频生成。`;
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

function formatVideoPayloadPreflightItem(item: any) {
  const reason = String(item?.reason || 'video_payload_preflight_failed');
  return {
    groupIdx: item.groupIdx,
    status: item.status || 'blocked',
    reason,
    url: item.url,
    blockers: [{
      code: item.code || reason,
      subReason: item.subReason || reason,
      message: item.message || videoPreflightMessage(item),
    }],
    warnings: [],
    nextActions: nextActionsForVideoPreflightReason(reason),
    submitMode: item.submitMode,
    payloadMode: item.payloadMode,
  };
}

function targetArtifactForBatch(batchType: string): TargetArtifact | null {
  if (batchType === 'storyboard_prompts') return 'storyboard_prompt';
  if (batchType === 'storyboard_images') return 'storyboard_image_generation';
  if (batchType === 'tail_frame_images') return 'storyboard_image';
  if (batchType === 'video_prompts') return 'video_prompt_generation';
  if (batchType === 'video_segments' || batchType === 'videos') return 'video_segment';
  return null;
}

function sentinelMessage(decision: ArtifactUsageDecision) {
  const groupLabel = decision.groupIdx == null ? '当前项目' : `片段 ${decision.groupIdx + 1}`;
  const reason = decision.blockingReasons[0] || decision.reasons[0] || 'artifact_usage_blocked';
  if (reason === 'shot_plan_generating') return '镜头计划仍在生成中，请等待完成后再进入下游生成。';
  if (reason === 'shot_plan_failed') return '镜头计划生成失败，请先重新生成镜头计划。';
  if (reason === 'shot_plan_stale' || reason === 'shot_plan_fresh_but_hash_mismatch') {
    return '镜头计划所依赖的剧本/风格/资产已变化，请先确认旧镜头仍可用或重新生成。';
  }
  if (reason === 'shot_plan_legacy_unknown') return '当前镜头计划来自旧版本，请先确认旧镜头仍可用或重新生成。';
  if (reason === 'storyboard_stale') return `${groupLabel} 分镜图已过期，请先重新生成分镜图。`;
  if (reason === 'shot_prompt_stale') return `${groupLabel} 分镜提示词已过期，请先重新生成提示词。`;
  if (reason === 'video_prompt_stale') return `${groupLabel} 视频提示词已过期，请先重新生成视频提示词。`;
  if (reason === 'video_task_outdated' || reason === 'video_task_stale' || reason === 'storyboard_video_not_current') {
    return `${groupLabel} 已有视频片段与当前上游不一致，请重新生成视频。`;
  }
  if (reason === 'character_consistency_blocked') {
    const first = decision.consistency?.blockers?.[0]?.message;
    return first ? `${groupLabel} 角色一致性未通过：${first}` : `${groupLabel} 角色一致性未通过。`;
  }
  return `${groupLabel} 产物一致性检查未通过：${reason}`;
}

function formatSentinelBlockedDecision(decision: ArtifactUsageDecision) {
  const reason = decision.blockingReasons[0] || decision.reasons[0] || 'artifact_usage_blocked';
  return {
    groupIdx: decision.groupIdx ?? 0,
    status: decision.generation || 'blocked',
    reason,
    blockers: (decision.consistency?.blockers?.length ? decision.consistency.blockers : [{
      code: reason,
      subReason: decision.upstreamStaleReasons?.join(',') || '',
      message: sentinelMessage(decision),
    }]),
    warnings: decision.consistency?.warnings || [],
    nextActions: decision.repairActions.map((action) => action.kind),
    decision,
  };
}

function sentinelPreflightForBatch(project: any, projectId: string, batchType: string, targets: any[]) {
  const targetArtifact = targetArtifactForBatch(batchType);
  if (!targetArtifact) return [] as ArtifactUsageDecision[];
  return targets
    .map((target: any, seq: number) => {
      const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
      const groupIdx = Number(rawGroupIdx);
      const shotIndices = Array.isArray(target?.shotIndices)
        ? target.shotIndices.filter((idx: any) => Number.isInteger(idx) && idx >= 0)
        : targetArtifact === 'storyboard_prompt'
          ? [Number.isFinite(groupIdx) ? Math.floor(groupIdx) : seq]
          : undefined;
      return describeArtifactStatus(project, {
        projectId,
        targetArtifact,
        groupIdx: Number.isFinite(groupIdx) && groupIdx >= 0 ? Math.floor(groupIdx) : undefined,
        shotIndices,
        batchType,
        consumerOperation: 'batch_start',
      });
    })
    .filter((decision) => decision.usability === 'BLOCKED');
}

function normalizeTargetGroupIdx(target: any): number | null {
  const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const groupIdx = Number(rawGroupIdx);
  if (!Number.isFinite(groupIdx) || groupIdx < 0) return null;
  return Math.floor(groupIdx);
}

function isShotPlanDependentBatchType(batchType: string) {
  return [
    'storyboard_prompts',
    'storyboard_images',
    'tail_frame_images',
    'video_prompts',
    'video_segments',
    'videos',
  ].includes(batchType);
}

function markVideoPromptBatchTargetsStarted(opts: {
  projectId: string;
  userId: number;
  batchId: string;
  targets: any[];
}) {
  const startedAt = new Date().toISOString();
  const seen = new Set<number>();
  const normalizedTargets = opts.targets
    .map((target, seq) => ({ target, seq, groupIdx: normalizeTargetGroupIdx(target) }))
    .filter((item): item is { target: any; seq: number; groupIdx: number } => item.groupIdx != null)
    .filter((item) => {
      if (seen.has(item.groupIdx)) return false;
      seen.add(item.groupIdx);
      return true;
    });

  const previousByGroup = new Map<number, { status: unknown; runId: unknown; hasPrompt: boolean }>();
  const patchedProject = patchProjectForUser(opts.projectId, opts.userId, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    normalizedTargets.forEach(({ target, groupIdx }) => {
      const prev = storyboards[groupIdx] || {};
      previousByGroup.set(groupIdx, {
        status: prev.videoPromptStatus || null,
        runId: prev.videoPromptRunId || null,
        hasPrompt: !!String(prev.videoPrompt || '').trim(),
      });
      const explicitShotIndices = Array.isArray(target?.shotIndices)
        ? target.shotIndices.filter((idx: any) => Number.isInteger(idx) && idx >= 0)
        : undefined;
      const freshShotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices,
      });
      storyboards[groupIdx] = {
        ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', startedAt),
        idx: groupIdx,
        shotIdx: groupIdx + 1,
        shotIndices: freshShotIndices,
        videoPromptStatus: 'generating',
        videoPromptRunId: opts.batchId,
        videoPromptStartedAt: startedAt,
        videoPromptLastError: undefined,
        videoPromptFailedAt: undefined,
      };
      if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
        videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', startedAt);
      }
    });
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-prompt-batch-prestart');
    return { storyboards, videoTasks };
  });

  const patchedStoryboards = Array.isArray((patchedProject as any)?.storyboards)
    ? (patchedProject as any).storyboards
    : [];
  const failedGroups: number[] = [];
  normalizedTargets.forEach(({ groupIdx, seq }) => {
    const sb = patchedStoryboards[groupIdx] || {};
    const prev = previousByGroup.get(groupIdx);
    const applied = sb.videoPromptStatus === 'generating' && sb.videoPromptRunId === opts.batchId;
    if (!applied) failedGroups.push(groupIdx);
    logVideoPromptTrace('batch_start_status_marked', {
      projectId: opts.projectId,
      batchId: opts.batchId,
      seq,
      groupIdx,
      previousStatus: prev?.status || null,
      previousRunId: prev?.runId || null,
      previousHasPrompt: !!prev?.hasPrompt,
      storedStatus: sb.videoPromptStatus || null,
      storedRunId: sb.videoPromptRunId || null,
      applied,
    }, applied ? 'info' : 'warn');
  });
  if (failedGroups.length) {
    throw new Error(`视频提示词批次启动状态写入失败：片段 ${failedGroups.map((idx) => idx + 1).join('、')}`);
  }
}

function markShotPlanBatchStarted(opts: {
  projectId: string;
  userId: number;
  batchId: string;
  sourceHash: string;
  sourceSnapshot: ShotPlanSourceSnapshot;
}) {
  patchProjectForUser(opts.projectId, opts.userId, (fresh) => {
    if (!fresh) return null;
    return beginShotPlanGeneration(fresh, {
      batchId: opts.batchId,
      sourceHash: opts.sourceHash,
      sourceSnapshot: opts.sourceSnapshot,
      archive: true,
    });
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const batchType: string = (body.batchType || '').toString();
  const projectId: string = (body.projectId || '').toString();
  const options: any = body.options || {};
  let batchOptions: any = options;
  const applyEditDraft = body.applyEditDraft === true || options?.applyEditDraft === true;
  const allowStaleEditDraft = body.allowStaleEditDraft === true || options?.allowStaleEditDraft === true;
  let videoPreflightWarnings: any[] = [];
  let shotPlanStartContext: null | { sourceHash: string; sourceSnapshot: ShotPlanSourceSnapshot } = null;

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

  if (isShotPlanDependentBatchType(batchType)) {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    const blockedDecisions = sentinelPreflightForBatch(proj as any, projectId, batchType, targets);
    if (blockedDecisions.length) {
      const blockedItems = blockedDecisions.map(formatSentinelBlockedDecision);
      const first = blockedDecisions[0];
      return Response.json(
        {
          error: sentinelMessage(first),
          code: 'artifact_usage_blocked',
          detail: sentinelMessage(first),
          preflight: {
            allowed: false,
            blocked: blockedItems,
            warnings: [],
          },
          sentinel: artifactUsageBlockedPayload(first),
        },
        { status: 409 },
      );
    }
  }

  if (batchType === 'storyboard_images' && applyEditDraft) {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    for (const target of targets) {
      const groupIdx = normalizeTargetGroupIdx(target);
      if (groupIdx == null) continue;
      const { draft } = currentFirstFrameEditDraft(proj as any, groupIdx);
      if (!draft) {
        return Response.json(
          { error: 'no_edit_draft', code: 'no_edit_draft', detail: '当前片段没有已保存的首帧编辑草稿。' },
          { status: 400 },
        );
      }
      const currentHash = buildFirstFramePlanPreview({
        project: proj as any,
        groupIdx,
        ownerId: user.id,
        user,
      }).sourceHash;
      if (isFirstFrameEditDraftStale(draft.sourceHash, currentHash) && !allowStaleEditDraft) {
        return Response.json(
          {
            error: 'stale_edit_draft',
            code: 'stale_edit_draft',
            groupIdx,
          },
          { status: 409 },
        );
      }
    }
    batchOptions = {
      ...(batchOptions || {}),
      applyEditDraft: true,
      allowStaleEditDraft,
    };
  }

  if (batchType === 'shots') {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    const sourceSnapshot = computeShotPlanSourceSnapshot(proj as any);
    const sourceHash = computeShotPlanSourceHash(proj as any);
    shotPlanStartContext = { sourceHash, sourceSnapshot };
    batchOptions = {
      ...(options || {}),
      shotPlanSourceHash: sourceHash,
      shotPlanSourceSnapshot: sourceSnapshot,
    };
  }

  if (batchType === 'video_prompts') {
    const proj = getProjectByIdForUser(projectId, user.id);
    if (!proj) return jsonError('项目不存在', 404);
    if (!(proj as any).imagesApproved) {
      return jsonError('请先确认分镜图，再生成视频提示词。', 409);
    }
    const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
    targets.forEach((target: any, seq: number) => {
      const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
      const groupIdx = Number(rawGroupIdx);
      const sb = Number.isFinite(groupIdx) ? storyboards[Math.floor(groupIdx)] || {} : {};
      logVideoPromptTrace('batch_start_target_observed', {
        projectId,
        seq,
        groupIdx: Number.isFinite(groupIdx) ? Math.floor(groupIdx) : null,
        previousStatus: sb?.videoPromptStatus || null,
        previousRunId: sb?.videoPromptRunId || null,
        hasPrompt: !!String(sb?.videoPrompt || '').trim(),
      });
    });
  }

  if (batchType === 'video_segments' || batchType === 'videos') {
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
    const readiness = assertVideoPromptReadyForGroups(proj as any, groupIdxs, 'videoSegment', { skipConsistency: true });
    const warningItems = [
      ...videoPreflightWarnings,
      ...(readiness.warnings || []).map(formatVideoPreflightWarningItem),
    ];
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
    const submitMode = normalizeVideoSubmitMode(options?.submitMode, getVideoSubmitMode());
    const configuredSubmitMode = getVideoSubmitMode();
    const videoCfg = resolveLLMConfig(user, 'video');
    const capability = resolveVideoModelCapability(videoCfg.model);
    const storyboards = Array.isArray((proj as any)?.storyboards) ? (proj as any).storyboards : [];
    const adminAllowsFirstLast = isFirstLastFrameVideoModeEnabled();
    warnIfFirstLastConfigIgnored({ configuredSubmitMode, adminAllowsFirstLast });
    const firstLastFeatureEnabled = computeFirstLastFeatureEnabled({
      submitMode,
      configuredSubmitMode,
      adminAllowsFirstLast,
    });
    const payloadBlocked: any[] = [];
    const payloadWarnings: any[] = [];
    groupIdxs.forEach((groupIdx) => {
      const sb = storyboards[groupIdx] || {};
      const firstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
      const firstFramePath = firstFrameUrl ? (resolveLocalImagePath(firstFrameUrl, user.id) || undefined) : undefined;
      const tailFrameUrl = String(sb?.frames?.tail?.url || sb?.tailFrameUrl || '').trim();
      const tailFramePath = tailFrameUrl ? (resolveLocalImagePath(tailFrameUrl, user.id) || undefined) : undefined;
      const decision = resolveVideoPayloadDecision({
        submitMode,
        firstLastFeatureEnabled,
        capabilityFirstLastSupported: capability.firstLastFrameMode === 'supported',
        firstFramePath,
        tailFramePath,
        tailFrameUrl,
        tailReferenceStatus: sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus,
        tailIntentRequested: sb?.tailFrameIntent === 'requested',
      });
      if (decision.hardFail) {
        payloadBlocked.push(formatVideoPayloadPreflightItem({
          groupIdx,
          reason: decision.reason,
          code: decision.failureCode,
          message: decision.failureMessage,
          status: 'blocked',
          submitMode: decision.submitMode,
          payloadMode: decision.payloadMode,
        }));
      } else if (decision.warning) {
        payloadWarnings.push({
          groupIdx,
          status: 'warning',
          reason: decision.warning.reason,
          message: decision.warning.message,
          nextActions: nextActionsForVideoPreflightReason(decision.warning.reason),
          submitMode: decision.submitMode,
          payloadMode: decision.payloadMode,
        });
      }
    });
    if (payloadBlocked.length) {
      const labels = payloadBlocked.map((item) => `${item.groupIdx + 1}(${item.reason})`).join('、');
      return Response.json(
        {
          error: `视频生成前检查未通过：片段 ${labels}`,
          code: 'video_segment_preflight_failed',
          detail: `视频生成前检查未通过：片段 ${labels}`,
          preflight: {
            allowed: false,
            blocked: payloadBlocked,
            warnings: [...warningItems, ...payloadWarnings],
          },
        },
        { status: 409 },
      );
    }
    warningItems.push(...payloadWarnings);
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
    const { batchId, total, reused, duplicateGroupIdxs } = createBatch({
      user,
      batchType,
      projectId,
      targets,
      options: batchOptions,
      beforeStart: batchType === 'video_prompts'
        ? (createdBatchId) => markVideoPromptBatchTargetsStarted({
          projectId,
          userId: user.id,
          batchId: createdBatchId,
          targets,
        })
        : batchType === 'shots' && shotPlanStartContext
          ? (createdBatchId) => markShotPlanBatchStarted({
            projectId,
            userId: user.id,
            batchId: createdBatchId,
            sourceHash: shotPlanStartContext!.sourceHash,
            sourceSnapshot: shotPlanStartContext!.sourceSnapshot,
          })
        : undefined,
    });
    if (batchType === 'video_prompts') {
      logVideoPromptTrace('batch_start_created', {
        projectId,
        batchId,
        total,
        reused: !!reused,
        duplicateGroupIdxs: duplicateGroupIdxs || [],
      });
    }
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
