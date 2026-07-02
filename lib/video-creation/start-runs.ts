import { ActiveVideoBatchConflictError, createBatch } from '@/lib/batches';
import { InsufficientCreditsError } from '@/lib/credits';
import type { UserRow } from '@/lib/db';
import {
  isFirstLastFrameVideoModeEnabled,
  isIndependentMultiImageModeEnabled,
  isMultiRefVideoModeEnabled,
} from '@/lib/feature-flags';
import { storyboardShotIndices, maybeAssertStoryboardsAlignedWithShots } from '@/lib/frame-workflow-state';
import { resolveLocalImagePath } from '@/lib/image-gen';
import { resolveLLMConfig } from '@/lib/llm';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { artifactUsageBlockedPayload } from '@/lib/sentinel';
import {
  collectBatchPreflight,
  formatBatchPreflightBlockedDecision,
  sentinelMessage,
} from '@/lib/batch-preflight';
import {
  computeFirstLastFeatureEnabled,
  normalizeVideoSubmitMode,
  resolveVideoPayloadDecision,
  warnIfFirstLastConfigIgnored,
} from '@/lib/video-payload-decision';
import { isVideoMultiKeyframeSchemaVerified, resolveVideoModelCapability } from '@/lib/video-provider-capabilities';
import { logVideoPromptTrace } from '@/lib/video-prompt-observability';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from '@/lib/video-prompt-state';
import { getVideoSubmitMode } from '@/lib/feature-flags';
import { readExpectedShotBinding, writeGroupSlot } from '@/lib/group-slot-write-guard';
import { resolveStoryboardFirstFrameUrl } from '@/lib/visual-reference-state';
import { collectSelectedShotKeyframes } from '@/lib/video-keyframes';
import {
  assertVideoCanStart,
  canDraftSatisfyVideoPromptBlock,
  formatVideoPayloadPreflightItem,
  formatVideoPreflightBlockedItem,
  nextActionsForVideoPreflightReason,
} from './prompt-readiness';

export type VideoCreationStartOutcome = {
  status: number;
  body: any;
};

function ok(body: any): VideoCreationStartOutcome {
  return { status: 200, body };
}

function error(detail: string, status = 400): VideoCreationStartOutcome {
  return { status, body: { detail } };
}

function normalizeTargetGroupIdx(target: any): number | null {
  const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const groupIdx = Number(rawGroupIdx);
  if (!Number.isFinite(groupIdx) || groupIdx < 0) return null;
  return Math.floor(groupIdx);
}

function collectVideoCreationArtifactPreflight(args: {
  project: any;
  projectId: string;
  batchType: string;
  targets: any[];
}) {
  const preflight = collectBatchPreflight(args.project, args.projectId, args.batchType, args.targets, { consumerOperation: 'batch_start' });
  let blockedDecisions = preflight.blockedDecisions;
  if (args.batchType === 'video_segments' || args.batchType === 'videos') {
    blockedDecisions = blockedDecisions.filter((decision: any) => {
      const groupIdx = Number(decision?.groupIdx);
      if (!Number.isInteger(groupIdx) || groupIdx < 0) return true;
      return !canDraftSatisfyVideoPromptBlock(args.project, groupIdx, decision.blockingReasons || decision.reasons || []);
    });
  }
  if (blockedDecisions.length) {
    const blockedItems = blockedDecisions.map(formatBatchPreflightBlockedDecision);
    const first = blockedDecisions[0];
    return {
      blocked: {
        status: 409,
        body: {
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
      } satisfies VideoCreationStartOutcome,
      warnings: [],
    };
  }
  return { blocked: null, warnings: preflight.warnings || [] };
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
      writeGroupSlot({
        fresh,
        groupIdx,
        storyboard: prev,
        explicitShotIndices,
        expectedBinding: readExpectedShotBinding(target),
        mismatchPolicy: 'skip',
        mutator: ({ shotIndices: freshShotIndices, firstShot }) => {
          storyboards[groupIdx] = {
            ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', startedAt),
            idx: groupIdx,
            shotIdx: firstShot?.idx ?? freshShotIndices[0] + 1,
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
        },
      });
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

function createVideoCreationBatch(args: {
  user: UserRow;
  batchType: 'video_prompts' | 'video_segments' | 'videos';
  projectId: string;
  targets: any[];
  options?: any;
  warnings?: any[];
  beforeStart?: (batchId: string) => void;
}): VideoCreationStartOutcome {
  try {
    const { batchId, total, reused, duplicateGroupIdxs } = createBatch({
      user: args.user,
      batchType: args.batchType,
      projectId: args.projectId,
      targets: args.targets,
      options: args.options,
      beforeStart: args.beforeStart,
    });
    if (args.batchType === 'video_prompts') {
      logVideoPromptTrace('batch_start_created', {
        projectId: args.projectId,
        batchId,
        total,
        reused: !!reused,
        duplicateGroupIdxs: duplicateGroupIdxs || [],
      });
    }
    return ok({
      batchId,
      total,
      status: reused ? 'running' : 'queued',
      reused: !!reused,
      duplicateGroupIdxs: duplicateGroupIdxs || [],
      preflight: args.warnings && args.warnings.length
        ? { allowed: true, blocked: [], warnings: args.warnings }
        : undefined,
    });
  } catch (e: any) {
    if (e instanceof ActiveVideoBatchConflictError) return error(e.message, 409);
    if (e instanceof InsufficientCreditsError) return error(e.message, 402);
    return error('创建 batch 失败：' + (e?.message || String(e)), 500);
  }
}

export function startVideoPromptRun(args: {
  user: UserRow;
  projectId: string;
  targets: any[];
  options?: any;
}): VideoCreationStartOutcome {
  if (!args.projectId) return error('缺 projectId', 400);
  if (!Array.isArray(args.targets) || !args.targets.length) return error('targets 不能为空', 400);
  const project = getProjectByIdForUser(args.projectId, args.user.id);
  if (!project) return error('项目不存在', 404);
  const artifactPreflight = collectVideoCreationArtifactPreflight({
    project,
    projectId: args.projectId,
    batchType: 'video_prompts',
    targets: args.targets,
  });
  if (artifactPreflight.blocked) return artifactPreflight.blocked;

  const storyboards = Array.isArray((project as any).storyboards) ? (project as any).storyboards : [];
  args.targets.forEach((target: any, seq: number) => {
    const rawGroupIdx = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
    const groupIdx = Number(rawGroupIdx);
    const sb = Number.isFinite(groupIdx) ? storyboards[Math.floor(groupIdx)] || {} : {};
    logVideoPromptTrace('batch_start_target_observed', {
      projectId: args.projectId,
      seq,
      groupIdx: Number.isFinite(groupIdx) ? Math.floor(groupIdx) : null,
      previousStatus: sb?.videoPromptStatus || null,
      previousRunId: sb?.videoPromptRunId || null,
      hasPrompt: !!String(sb?.videoPrompt || '').trim(),
    });
  });

  return createVideoCreationBatch({
    user: args.user,
    batchType: 'video_prompts',
    projectId: args.projectId,
    targets: args.targets,
    options: args.options,
    warnings: artifactPreflight.warnings,
    beforeStart: (createdBatchId) => markVideoPromptBatchTargetsStarted({
      projectId: args.projectId,
      userId: args.user.id,
      batchId: createdBatchId,
      targets: args.targets,
    }),
  });
}

export function startVideoSegmentRun(args: {
  user: UserRow;
  projectId: string;
  batchType?: 'video_segments' | 'videos';
  targets: any[];
  options?: any;
}): VideoCreationStartOutcome {
  const batchType = args.batchType || 'video_segments';
  if (!args.projectId) return error('缺 projectId', 400);
  if (!Array.isArray(args.targets) || !args.targets.length) return error('targets 不能为空', 400);
  const project = getProjectByIdForUser(args.projectId, args.user.id);
  if (!project) return error('项目不存在', 404);

  const artifactPreflight = collectVideoCreationArtifactPreflight({
    project,
    projectId: args.projectId,
    batchType,
    targets: args.targets,
  });
  if (artifactPreflight.blocked) return artifactPreflight.blocked;

  const targetShotIndicesByGroup = new Map<number, number[]>();
  const groupIdxs = Array.from(
    new Set(
      args.targets
        .map((target: any) => {
          const n = Number(target?.groupIdx ?? target?.storyboardIdx ?? target?.idx);
          if (!Number.isFinite(n) || n < 0) return null;
          const groupIdx = Math.floor(n);
          if (Array.isArray(target?.shotIndices) && target.shotIndices.length) {
            targetShotIndicesByGroup.set(
              groupIdx,
              target.shotIndices
                .map((idx: any) => Number(idx))
                .filter((idx: number) => Number.isInteger(idx) && idx >= 0),
            );
          }
          return groupIdx;
        })
        .filter((n: number | null): n is number => n != null),
    ),
  );

  const readiness = assertVideoCanStart(project as any, groupIdxs, 'videoSegment', { skipConsistency: true });
  const warningItems = [...artifactPreflight.warnings];
  const readinessBlocked = readiness.ok
    ? []
    : readiness.blocked.filter((item: any) => !canDraftSatisfyVideoPromptBlock(project as any, Number(item?.groupIdx), [item?.reason]));
  if (readinessBlocked.length) {
    const blockedItems = readinessBlocked.map(formatVideoPreflightBlockedItem);
    const labels = blockedItems.map((item) => `${item.groupIdx + 1}(${item.reason})`).join('、');
    return {
      status: 409,
      body: {
        error: `视频生成前检查未通过：片段 ${labels}`,
        code: 'video_segment_preflight_failed',
        detail: `视频生成前检查未通过：片段 ${labels}`,
        preflight: {
          allowed: false,
          blocked: blockedItems,
          warnings: warningItems,
        },
      },
    };
  }

  const submitMode = normalizeVideoSubmitMode(args.options?.submitMode, getVideoSubmitMode());
  const configuredSubmitMode = getVideoSubmitMode();
  const videoCfg = resolveLLMConfig(args.user, 'video');
  const capability = resolveVideoModelCapability(videoCfg.model);
  const storyboards = Array.isArray((project as any)?.storyboards) ? (project as any).storyboards : [];
  const shots = Array.isArray((project as any)?.shots) ? (project as any).shots : [];
  const adminAllowsFirstLast = isFirstLastFrameVideoModeEnabled();
  warnIfFirstLastConfigIgnored({ configuredSubmitMode, adminAllowsFirstLast });
  const firstLastFeatureEnabled = computeFirstLastFeatureEnabled({
    submitMode,
    configuredSubmitMode,
    adminAllowsFirstLast,
  });
  const payloadBlocked: any[] = [];
  const payloadWarnings: any[] = [];
  const independentMultiImageCapable = isMultiRefVideoModeEnabled() && isIndependentMultiImageModeEnabled();
  groupIdxs.forEach((groupIdx) => {
    const sb = storyboards[groupIdx] || {};
    const shotIndices = storyboardShotIndices(project as any, groupIdx, sb, {
      mode: 'single-shot-strict',
      explicitShotIndices: targetShotIndicesByGroup.get(groupIdx),
    });
    const firstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
    const firstFramePath = firstFrameUrl ? (resolveLocalImagePath(firstFrameUrl, args.user.id) || undefined) : undefined;
    const tailFrameUrl = String(sb?.frames?.tail?.url || sb?.tailFrameUrl || '').trim();
    const tailFramePath = tailFrameUrl ? (resolveLocalImagePath(tailFrameUrl, args.user.id) || undefined) : undefined;
    const selectedKeyframes = collectSelectedShotKeyframes({
      project,
      storyboard: sb,
      shots,
      groupShotIndices: shotIndices,
      ownerId: args.user.id,
    });
    const decision = resolveVideoPayloadDecision({
      submitMode,
      firstLastFeatureEnabled,
      capabilityFirstLastSupported: capability.firstLastFrameMode === 'supported',
      firstFramePath,
      tailFramePath,
      tailFrameUrl,
      tailReferenceStatus: sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus,
      tailIntentRequested: sb?.tailFrameIntent === 'requested' || submitMode === 'first_last_frame',
      independentMultiImageCapable,
      multiShotSegment: shotIndices.length > 1,
      multiKeyframeCapable: capability.supportsMultiKeyframe,
      multiKeyframeSchemaVerified: isVideoMultiKeyframeSchemaVerified(capability),
      multiKeyframeCount: selectedKeyframes.keyframes.length,
      referenceBudget: capability.referenceBudget,
      maxImages: capability.maxImages,
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
    return {
      status: 409,
      body: {
        error: `视频生成前检查未通过：片段 ${labels}`,
        code: 'video_segment_preflight_failed',
        detail: `视频生成前检查未通过：片段 ${labels}`,
        preflight: {
          allowed: false,
          blocked: payloadBlocked,
          warnings: [...warningItems, ...payloadWarnings],
        },
      },
    };
  }
  warningItems.push(...payloadWarnings);

  return createVideoCreationBatch({
    user: args.user,
    batchType,
    projectId: args.projectId,
    targets: args.targets,
    options: args.options,
    warnings: warningItems,
  });
}
