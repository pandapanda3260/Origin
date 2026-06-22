/**
 * 批量任务的 3 个执行器（与原站 batchType 对齐）：
 *   1. asset_images       —— 给角色/场景/道具生成参考图
 *   2. storyboard_prompts —— 把镜头描述转成图像生成提示词（纯文本 LLM）
 *   3. storyboard_images  —— 给每个分镜组生成手稿风格分镜图
 *
 * 注册时机：lib/init-executors.ts 在 app 启动时调用一次。
 */

import { registerExecutor, aliasExecutor, type BatchExecCtx } from './batches';
import { recordBatchTaskProviderSubmission } from './provider-recovery';
import { resolveLocalImagePath, type ImageGenInput } from './image-gen';
import { generateImageWithModerationRecovery } from './safe-image-gen';
import {
  generateVideo,
  VideoGenerationError,
  classifyVideoFailureStage,
  normalizeGenerateAudio,
  normalizeSeedanceResolution,
  type VideoReferenceImage,
  type VideoGenInput,
} from './video-gen';
import { chatComplete, chatCompleteJsonViaBackground, chatCompleteJsonWithRetry, parseJsonLoose, resolveLLMConfig } from './llm';
import { buildShotsMessages, buildVideoPromptMessages } from './prompts';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';
import {
  isFirstLastFrameVideoModeEnabled,
  isIndependentMultiImageModeEnabled,
  isMultiRefVideoModeEnabled,
  isTailFrameCaptionFallbackEnabled,
  getVideoSubmitMode,
} from './feature-flags';
import {
  computeFirstLastFeatureEnabled,
  deriveVideoSubmitInputMode,
  normalizeVideoSubmitMode,
  resolveVideoPayloadDecision,
  warnIfFirstLastConfigIgnored,
  type VideoPayloadDecision,
} from './video-payload-decision';
import {
  buildVideoPromptAttemptMessages,
  videoPromptTemperatureForAttempt,
  VIDEO_PROMPT_MAX_ATTEMPTS,
} from './video-prompt-attempts';
import {
  existingPanelVersion,
  inferEntityTypeFromCharacter,
  splitCharacterPanels,
  type SplitCharacterPanelsResult,
} from './character-panels';
import { deriveCharacterReferenceUpdate, deriveCrowdReferenceUpdate } from './character-reference-update';
import { buildAssetStyleLock, type AssetStyleType } from './asset-style-lock';
import {
  appendCharacterCastingPrompt,
  styleBibleForScenePrompt,
  styleBibleForShotPrompt,
  styleBibleForVideoPrompt,
} from './casting-profile';
import type { CharacterReferencePanel } from './panel-selection';
import {
  ensureProjectConsistency,
  mutateCharacterLock,
  renderCharacterLockRosterLine,
  type CharacterLock,
} from './character-consistency';
import { buildAssetAuthoritativeCharacterLock } from './character-lock-authority';
import { characterAssetModeFor, isAnonymousCrowdAsset } from './crowd-character';
import { buildVideoReferenceManifest } from './reference-matcher';
import {
  applySceneViewWrite,
  isPrimarySceneRef,
  normalizeSceneViewRole,
  resolveSceneImageUrl,
  type SceneViewRole,
} from './scene-views';
import {
  applyPropViewWrite,
  normalizePropDimensionality,
  resolvePropImageUrl,
  splitPropViews,
  type SplitPropViewsResult,
} from './prop-views';
import { sanitizePromptObject } from './content-sanitize';
import {
  cleanDialogueCharCount,
  buildReferenceBriefLine,
  hashString,
  plannedTimelineGroupsFromProject,
  plannedTimelineStartFromGroups,
  resolveGenerationDurationSec,
  VIDEO_REFERENCE_IMAGE_BUDGET,
  type DialoguePolicy,
  type DroppedReference,
  type ReferenceManifestItem,
  type VideoGenerationPlan,
  type VideoReferenceRole,
} from './video-reference-manifest';
import {
  assertVideoPromptReadyForGroups,
  markStoryboardVideoOutdated,
  markVideoTaskOutdated,
  type VideoPromptFailureStage,
} from './video-prompt-state';
import { logVideoPromptTrace, summarizePromptForTrace } from './video-prompt-observability';
import {
  applyVideoPromptWrite,
  computeVideoPromptSourceHash,
  normalizeVideoPromptContent,
} from './video-prompt-lifecycle';
import { buildSeedanceFirstLastFramePromptParts, buildSeedancePromptParts } from './video-prompt-runtime';
import {
  buildEffectiveShotPlanForDuration,
  buildSegmentShotPlan,
  buildTailRushedWarning,
  collectSegmentDialoguePairs,
  computeSegmentTempoBudget,
  plannedDurationForSegment,
  TAIL_RUSHED_WARNING_MESSAGE,
  type SegmentTempoBudget,
} from './video-segment-runtime';
import { validateCharacterConsistencyForGroup } from './character-consistency-gate';
import { dataPath } from './runtime-paths';
import { buildFirstFrameRecord, markFirstFrameReady, normalizeFirstFrameState, resolveStoryboardFirstFrameUrl, checkTailFramePreflight, formatTailFramePreflightError } from './visual-reference-state';
import { buildFrameImageGenerationPlan, summarizePlanForAudit, type FrameImageGenerationPlan } from './frame-image-plan';
import {
  buildFrameConsistencyRetryDecision,
  checkFrameVisualConsistency,
  type FrameConsistencyCheckResult,
} from './frame-consistency-check';
import {
  buildSceneViewQualityRetryPrompt,
  errorSceneViewQualityResult,
  evaluateSceneViewQuality,
  shouldEvaluateSceneViewQuality,
  type SceneViewQualityCheckResult,
} from './scene-view-quality';
import { inferTailFrameDependencyForShots } from './tail-frame-dependency';
import {
  applyFirstFrameDraftToPlan,
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  reconcileFirstFramePromptStateInPatch,
  validateAndNormalizeFirstFrameDraft,
  FirstFrameDraftValidationException,
} from './first-frame-edit-draft';
import {
  currentTailFrameEditDraft,
  nextTailFrameHistory,
  reconcileTailFramePromptStateInPatch,
  tailFrameDraftFingerprint,
  tailFrameHistoryItemFromCurrent,
  validateAndNormalizeTailFrameDraft,
  TailFrameDraftValidationException,
} from './tail-frame-edit-draft';
import { buildCharacterLockRoster, joinPromptValues } from './frame-prompt-helpers';
import { resolveTargetEndStrategy, resolveVideoModelCapability } from './video-provider-capabilities';
import { captionTailFrameForVideo, hashImageFileContent, type TailFrameCaption } from './image-caption';
import {
  completeShotPlanGenerationPatch,
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
} from './project-dependency-state';
import { formatWorldContextForPrompt, projectWorldContextForStage } from './world-template-context';
import { normalizeGeneratedShotPlan, resolveShotFieldsForPrompt } from './shot-plan-normalize';
import {
  computeFirstFrameSourceHashForShotIndices,
  makeSingleShotStoryboardSlots,
  maybeAssertStoryboardsAlignedWithShots,
  storyboardShotIndices,
} from './frame-workflow-state';
import { buildKnowledgeContextForStage } from './knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from './knowledge/context-db';
import type { KnowledgeStage } from './knowledge/types';
import {
  describeArtifactStatus,
  type ArtifactUsageDecision,
  type TargetArtifact,
} from './sentinel';
import { applyBlockerFilter } from './batch-preflight';
import { resolveVideoAspectRatio } from './aspect-ratio';

const DEFAULT_PROJECT_ASPECT_RATIO = '9:16';
const PROJECT_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
const FRAME_CONSISTENCY_MAX_RETRIES = 2;

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  if (raw == null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveFrameImageQualityForCall(
  configuredQuality: string | undefined,
  context: { frameType: 'first_frame' | 'tail_frame'; projectId: string; groupIdx: number },
): NonNullable<ImageGenInput['quality']> {
  const plannedQuality = (configuredQuality || 'medium') as NonNullable<ImageGenInput['quality']>;
  if (envFlag('IMAGE_QUALITY_STRICT', false)) return plannedQuality;
  const actualQuality = 'medium' as NonNullable<ImageGenInput['quality']>;
  if (plannedQuality !== actualQuality) {
    console.warn('[frame-image-quality-gate] IMAGE_QUALITY_STRICT is off; keeping actual image quality at medium', {
      frameType: context.frameType,
      projectId: context.projectId,
      groupIdx: context.groupIdx,
      plannedQuality,
      actualQuality,
    });
  }
  return actualQuality;
}

async function generateFrameImageWithConsistencyCheck(args: {
  ctx: BatchExecCtx;
  plan: FrameImageGenerationPlan;
  prompt: string;
  imageInput: Omit<ImageGenInput, 'prompt'>;
  progressMode: 'first_frame' | 'tail_frame';
  groupIdx: number;
}): Promise<{
  result: Awaited<ReturnType<typeof generateImageWithModerationRecovery>>;
  consistencyCheck: FrameConsistencyCheckResult;
  consistencyAttempts: Array<{
    attempt: number;
    grade: FrameConsistencyCheckResult['grade'];
    status: FrameConsistencyCheckResult['status'];
    reasons: string[];
    retry: boolean;
  }>;
}> {
  let promptForAttempt = args.prompt;
  let result: Awaited<ReturnType<typeof generateImageWithModerationRecovery>> | null = null;
  let consistencyCheck: FrameConsistencyCheckResult | null = null;
  const consistencyAttempts: Array<{
    attempt: number;
    grade: FrameConsistencyCheckResult['grade'];
    status: FrameConsistencyCheckResult['status'];
    reasons: string[];
    retry: boolean;
  }> = [];

  for (let attempt = 1; attempt <= FRAME_CONSISTENCY_MAX_RETRIES + 1; attempt += 1) {
    if (attempt > 1) {
      args.ctx.progress({
        stage: 'calling_image_api',
        mode: args.progressMode,
        groupIdx: args.groupIdx,
        attempt,
        hint: '重新生成首尾帧以修正视觉一致性偏差…',
      });
    }
    result = await generateImageWithModerationRecovery(args.ctx.user, {
      ...args.imageInput,
      prompt: promptForAttempt,
    });

    const generatedImagePath = resolveLocalImagePath(result.url, args.ctx.user.id) || undefined;
    args.ctx.progress({
      stage: 'checking_frame_consistency',
      mode: args.progressMode,
      groupIdx: args.groupIdx,
      attempt,
      hint: '检查首尾帧与角色、场景、道具参考图的一致性…',
    });
    consistencyCheck = await checkFrameVisualConsistency({
      user: args.ctx.user,
      plan: { ...args.plan, finalPrompt: promptForAttempt },
      generatedImagePath,
      tokenContext: {
        ownerId: args.ctx.user.id,
        usernameSnapshot: args.ctx.user.phone || args.ctx.user.display_name || args.ctx.user.username || null,
        projectId: args.ctx.projectId,
        routeName: `batch.${args.progressMode}`,
        moduleKey: 'image',
        moduleLabel: '图片生成',
        featureKey: 'frame_consistency_check',
        featureLabel: '首尾帧一致性校验',
        callItemType: 'batch_task',
        callItemId: args.ctx.taskId,
        callItemLabel: `${args.progressMode} #${args.groupIdx + 1}`,
        batchId: args.ctx.batchId,
        taskId: args.ctx.taskId,
        operationKey: `batch:${args.ctx.batchId}:task:${args.ctx.taskId}:frame-consistency:${attempt}`,
        operationLabel: '首尾帧一致性校验',
        meta: {
          groupIdx: args.groupIdx,
          attempt,
          progressMode: args.progressMode,
        },
      },
    });
    const decision = buildFrameConsistencyRetryDecision({
      basePrompt: args.prompt,
      check: consistencyCheck,
      attempt,
      maxRetries: FRAME_CONSISTENCY_MAX_RETRIES,
    });
    consistencyAttempts.push({
      attempt,
      grade: consistencyCheck.grade,
      status: consistencyCheck.status,
      reasons: consistencyCheck.reasons,
      retry: decision.shouldRetry,
    });
    if (!decision.shouldRetry) break;
    promptForAttempt = decision.nextPrompt;
  }

  if (!result || !consistencyCheck) throw new Error('首尾帧生成或一致性校验未返回结果');
  return { result, consistencyCheck, consistencyAttempts };
}

function shouldDeferSeedanceProviderPolling() {
  // Batch video generation must not depend on the submitting process staying
  // alive until Seedance finishes. Persist the provider task id and let the
  // provider poller complete/download it; the env flag is an emergency escape.
  return envFlag('DEFER_SEEDANCE_PROVIDER_POLLING', true);
}

function isPlanReferenceRole(role: string): role is VideoReferenceRole {
  return role === 'first_frame' || role === 'target_end' || role === 'scene' || role === 'character' || role === 'prop';
}

function resolveProjectAspectRatio(project: any): '16:9' | '9:16' | '1:1' {
  const raw =
    project?.styleOptions?.aspectRatio ||
    project?.styleBible?.aspectRatio ||
    project?.videoAspectRatio ||
    DEFAULT_PROJECT_ASPECT_RATIO;
  const value = String(raw || DEFAULT_PROJECT_ASPECT_RATIO);
  return PROJECT_ASPECT_RATIOS.has(value) ? (value as '16:9' | '9:16' | '1:1') : DEFAULT_PROJECT_ASPECT_RATIO;
}

function frameImageSizeForAspectRatio(project: any): ImageGenInput['size'] {
  const ratio = resolveProjectAspectRatio(project);
  if (ratio === '9:16') return '1024x1536';
  if (ratio === '1:1') return '1024x1024';
  return '1536x1024';
}

function recordBatchKnowledgeAudit(opts: {
  ctx: BatchExecCtx;
  project: any;
  stage: KnowledgeStage;
  stageTarget: Record<string, unknown>;
  provider?: string | null;
}) {
  try {
    const context = buildKnowledgeContextForStage({
      ownerId: opts.ctx.user.id,
      project: {
        ...(opts.project || {}),
        id: opts.ctx.projectId,
      },
      stage: opts.stage,
      stageTarget: opts.stageTarget,
      provider: opts.provider,
      runId: opts.ctx.taskId,
    });
    recordKnowledgeContextBestEffort({
      ownerId: opts.ctx.user.id,
      projectId: opts.ctx.projectId,
      context,
      runId: opts.ctx.taskId,
    });
  } catch (error) {
    console.warn(`[batch:${opts.stage}] knowledge context audit skipped:`, error);
  }
}

function findCharacterLock(project: any, character: any): CharacterLock | null {
  const withConsistency = ensureProjectConsistency(project || {}, { source: 'migration' });
  const locks: CharacterLock[] = Array.isArray(withConsistency.consistency?.characters) ? withConsistency.consistency.characters : [];
  const ids = new Set(
    [
      character?.characterId,
      character?.id,
      character?.name,
      character?.role,
    ].filter(Boolean).map((v) => String(v)),
  );
  return locks.find((lock) => (
    ids.has(lock.characterId) ||
    (lock.sourceAssetId && ids.has(lock.sourceAssetId)) ||
    ids.has(lock.canonicalName) ||
    lock.aliases.some((alias) => ids.has(alias))
  )) || null;
}

function referenceDefaults(role: VideoReferenceRole): Pick<ReferenceManifestItem, 'useFor' | 'immutable' | 'promptHint'> {
  if (role === 'first_frame') {
    return {
      useFor: ['锁定第 0 帧开场构图', '光照', '主体位置', '画面比例', '色调基准'],
      immutable: ['构图', '光照方向', '主体站位', '画面比例'],
      promptHint: '角色身份由 character reference 锁定，场景细节由 scene reference 锁定。',
    };
  }
  if (role === 'target_end') {
    return {
      useFor: ['锁定视频结尾构图', '结尾角色位置', '结尾动作状态', '结尾光照氛围'],
      immutable: ['最终构图', '主体落点', '动作结束状态', '光照方向'],
      promptHint: '视频必须从 first frame 自然运动，并在结尾逐步接近 target ending frame。',
    };
  }
  if (role === 'scene') {
    return {
      useFor: ['锁定环境布局', '空间结构', '材质', '氛围'],
      immutable: ['场景类型', '道路/地形结构', '主色调', '主要空间关系'],
    };
  }
  if (role === 'character') {
    return {
      useFor: ['锁定角色脸部', '体型', '服装', '物种特征'],
      immutable: ['脸型', '毛发/发色', '服装颜色', '身体类型'],
    };
  }
  return {
    useFor: ['锁定道具材质', '颜色', '尺度', '识别特征'],
    immutable: ['核心形状', '主色', '材质', '用途'],
  };
}

function collectRuntimeHardConstraints(prompt: string): Array<{ id: string; text: string; source: 'runtime' }> {
  const lines = String(prompt || '').match(/(?:HARD USER NEGATIVE CONSTRAINT|硬性负向约束)[^\n]+/g) || [];
  return lines.map((text, idx) => ({
    id: `runtime_hard_${idx + 1}`,
    text,
    source: 'runtime' as const,
  }));
}

function compactManifestSignature(refs: any[]): string {
  if (!Array.isArray(refs)) return '';
  return refs
    .map((ref: any) => [
      ref?.imageNo,
      ref?.role,
      ref?.url,
      ref?.label,
      ref?.assetName,
      ref?.panelInfo?.panel,
      ref?.panelInfo?.intent,
    ].map((v) => String(v || '')).join('|'))
    .join('\n');
}

function manifestsDiffer(a: any[], b: any[]): boolean {
  return compactManifestSignature(a) !== compactManifestSignature(b);
}

function dedupeDroppedReferences(refs: any[]): DroppedReference[] {
  const out: DroppedReference[] = [];
  const seen = new Set<string>();
  for (const ref of refs || []) {
    if (!ref || !ref.role) continue;
    const role = String(ref.role);
    if (role !== 'scene' && role !== 'character' && role !== 'prop') continue;
    const assetName = String(ref.assetName || ref.label || '').trim();
    const rawReason = String(ref.reason || 'image_budget_exceeded');
    const reason: DroppedReference['reason'] =
      rawReason === 'missing_file'
        ? 'asset_missing'
        : ([
            'image_budget_exceeded',
            'asset_missing',
            'url_lookup_failed',
            'filtered_constraint',
          ].includes(rawReason)
            ? rawReason as DroppedReference['reason']
            : 'image_budget_exceeded');
    const viewRole = role === 'scene' ? normalizeSceneViewRole(ref.viewRole) || undefined : undefined;
    const key = `${role}|${viewRole || ''}|${assetName.toLowerCase()}|${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: role as DroppedReference['role'],
      viewRole,
      assetName: assetName || undefined,
      reason,
    });
  }
  return out;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorWithFailureStage(message: string, failureStage: VideoPromptFailureStage): Error & { failureStage: VideoPromptFailureStage } {
  const err = new Error(message) as Error & { failureStage: VideoPromptFailureStage };
  err.failureStage = failureStage;
  return err;
}

function errorWithRecoveryHint(
  message: string,
  errorCode: string,
  recoveryHint: string,
): Error & { errorCode: string; recoveryHint: string } {
  const err = new Error(message) as Error & { errorCode: string; recoveryHint: string };
  err.errorCode = errorCode;
  err.recoveryHint = recoveryHint;
  return err;
}

function sentinelBlockedMessage(decision: ArtifactUsageDecision) {
  const groupLabel = decision.groupIdx == null ? '当前项目' : `片段 ${decision.groupIdx + 1}`;
  const reason = decision.blockingReasons[0] || decision.reasons[0] || 'artifact_usage_blocked';
  if (reason === 'shot_plan_generating') return '镜头计划仍在生成中，请等待完成后再进入下游生成。';
  if (reason === 'shot_plan_failed') return '镜头计划生成失败，请先重新生成镜头计划。';
  if (reason === 'shot_plan_legacy_unknown') return '当前镜头计划来自旧版本，请先确认旧镜头仍可用或重新生成。';
  if (reason === 'shot_plan_stale' || reason === 'shot_plan_fresh_but_hash_mismatch') {
    return '镜头计划所依赖的剧本/风格/资产已变化，请先确认旧镜头仍可用或重新生成。';
  }
  if (reason === 'storyboard_stale') return `${groupLabel} 分镜图已过期，请先重新生成分镜图。`;
  if (reason === 'first_frame_missing' || reason === 'missing_first_frame') return `${groupLabel} 缺少可用首帧，请先生成首帧图。`;
  if (reason === 'first_frame_failed') return `${groupLabel} 首帧生成失败，请先重新生成首帧图。`;
  if (reason === 'legacy_sketch_only') return `${groupLabel} 只有旧版黑白分镜，缺少可用于下游生成的彩色首帧。`;
  if (reason === 'shot_prompt_stale') return `${groupLabel} 分镜提示词已过期，请先重新生成提示词。`;
  if (reason === 'video_prompt_stale') return `${groupLabel} 视频提示词已过期，请先重新生成视频提示词。`;
  if (reason === 'missing_video_prompt') return `${groupLabel} 缺少视频提示词，请先生成视频提示词。`;
  if (reason === 'video_prompt_generating') return `${groupLabel} 视频提示词仍在生成中，请等待完成。`;
  if (reason === 'video_prompt_failed') return `${groupLabel} 视频提示词生成失败，请先重新生成。`;
  if (reason === 'video_task_outdated' || reason === 'video_task_stale' || reason === 'storyboard_video_not_current') {
    return `${groupLabel} 已有视频片段与当前上游不一致，请重新生成视频。`;
  }
  if (reason === 'character_consistency_blocked') {
    const message = decision.consistency?.blockers?.[0]?.message;
    return message ? `${groupLabel} 角色一致性未通过：${message}` : `${groupLabel} 角色一致性未通过。`;
  }
  return `${groupLabel} 产物一致性检查未通过：${reason}`;
}

function assertArtifactUsable(
  project: any,
  ctx: BatchExecCtx,
  targetArtifact: TargetArtifact,
  opts: { groupIdx?: number; shotIndices?: number[]; batchType?: string } = {},
) {
  const decision = applyBlockerFilter(describeArtifactStatus(project, {
    projectId: ctx.projectId,
    targetArtifact,
    groupIdx: opts.groupIdx,
    shotIndices: opts.shotIndices,
    batchType: opts.batchType,
    consumerOperation: `batch_executor:${targetArtifact}`,
  }));
  if (decision.usability === 'BLOCKED') {
    const err = errorWithFailureStage(sentinelBlockedMessage(decision), 'preflight_video_prompt_not_ready') as Error & {
      code?: string;
      sentinelDecision?: ArtifactUsageDecision;
    };
    err.code = 'artifact_usage_blocked';
    err.sentinelDecision = decision;
    throw err;
  }
  return decision;
}

function consistencyFromDecision(decision: ArtifactUsageDecision) {
  return decision.consistency || {
    allowed: true,
    score: 100,
    level: 'green' as const,
    blockers: [],
    warnings: [],
    characterUsages: [],
  };
}

function videoPromptGateMessage(gate: any) {
  return gate?.blockers?.map((b: any) => b?.message).filter(Boolean).join('；') ||
    gate?.warnings?.map((w: any) => w?.message).filter(Boolean).join('；') ||
    '角色一致性检查未通过';
}

function commitVideoPromptDraftForSegment(args: {
  project: any;
  projectId: string;
  userId: number;
  groupIdx: number;
  explicitShotIndices?: number[];
}) {
  const storyboards = Array.isArray(args.project?.storyboards) ? [...args.project.storyboards] : [];
  const sb = storyboards[args.groupIdx] || {};
  const draft = sb.videoPromptEditDraft || null;
  if (!draft || typeof draft.content !== 'string') return { project: args.project, committed: false };
  const content = normalizeVideoPromptContent(draft.content);
  if (!content) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿为空，已阻止视频生成。`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    throw err;
  }

  const shotIndices = storyboardShotIndices(args.project, args.groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: args.explicitShotIndices,
  });
  const currentSourceHash = computeVideoPromptSourceHash({
    project: args.project,
    groupIdx: args.groupIdx,
    ownerId: args.userId,
  });
  const gateStoryboards = [...storyboards];
  gateStoryboards[args.groupIdx] = { ...sb, videoPrompt: content };
  const gate = validateCharacterConsistencyForGroup(
    { ...args.project, storyboards: gateStoryboards },
    { groupIdx: args.groupIdx, shotIndices, target: 'videoPrompt' },
  );
  if (gate.blockers?.length) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿提交失败：${videoPromptGateMessage(gate)}`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string; gate?: any };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    err.gate = gate;
    throw err;
  }

  const result = applyVideoPromptWrite({
    projectId: args.projectId,
    userId: args.userId,
    groupIdx: args.groupIdx,
    prompt: content,
    sourceHash: currentSourceHash,
    ownership: 'takeover',
    writeKind: 'commit_draft',
    shotIndices,
    consistency: {
      characterUsages: gate.characterUsages,
      score: gate.score,
      level: gate.level,
      warnings: gate.warnings,
    },
  });
  if (!result.applied) {
    const err = errorWithFailureStage(
      `片段 ${args.groupIdx + 1} 视频提示词草稿提交失败：${result.skippedReason || 'write_not_applied'}`,
      'preflight_video_prompt_not_ready',
    ) as Error & { errorCode?: string; skippedReason?: string };
    err.errorCode = 'VIDEO_PROMPT_DRAFT_COMMIT_FAILED';
    err.skippedReason = result.skippedReason;
    throw err;
  }
  return { project: result.project || args.project, committed: true };
}

function isTransientNetworkError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /socket hang up|secure TLS|TLS connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|network|aborted/i.test(msg);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function planReferencesFromManifest(refs: ReferenceManifestItem[]): ReferenceManifestItem[] {
  const mapped = refs
    .filter((ref) => isPlanReferenceRole(ref.role))
    .map((ref, idx) => {
      const role = ref.role as VideoReferenceRole;
      const defaults = referenceDefaults(role);
      return {
        ...ref,
        imageNo: idx + 1,
        role,
        label: ref.label || `${role} reference`,
        useFor: Array.isArray(ref.useFor) && ref.useFor.length ? ref.useFor : defaults.useFor,
        immutable: Array.isArray(ref.immutable) && ref.immutable.length ? ref.immutable : defaults.immutable,
        promptHint: ref.promptHint || defaults.promptHint,
      };
    });
  return mapped.map((ref) => ({
    ...ref,
    referenceBrief: ref.referenceBrief || buildReferenceBriefLine(ref, mapped),
  }));
}

function planReferencesFromAuditRefs(refs: any[]): ReferenceManifestItem[] {
  const mapped = (refs || [])
    .filter((ref) => isPlanReferenceRole(ref.role))
    .map((ref, idx) => {
      const role = ref.role as VideoReferenceRole;
      const defaults = referenceDefaults(role);
      return {
        imageNo: idx + 1,
        role,
        viewRole: ref.viewRole,
        assetId: ref.assetId,
        assetName: ref.assetName,
        label: ref.label || `${role} reference`,
        url: ref.sourceUrl || ref.path,
        localPath: ref.path,
        useFor: Array.isArray(ref.useFor) && ref.useFor.length ? ref.useFor : defaults.useFor,
        immutable: Array.isArray(ref.immutable) && ref.immutable.length ? ref.immutable : defaults.immutable,
        promptHint: ref.promptHint || defaults.promptHint,
        panelInfo: ref.panelInfo,
        referenceBrief: ref.referenceBrief,
      };
	    });
  return mapped.map((ref) => ({
    ...ref,
    referenceBrief: ref.referenceBrief || buildReferenceBriefLine(ref, mapped),
  }));
}

function videoWarningsFromAuditRefs(refs: any[]): any[] {
  const warnings: any[] = [];
  (refs || []).forEach((ref) => {
    (Array.isArray(ref?.warnings) ? ref.warnings : []).forEach((warning: any) => {
      const message = String(warning?.message || '').trim();
      if (!message) return;
      warnings.push({
        key: `${warning?.code || 'submit_image_warning'}:${ref?.role || 'reference'}`,
        code: warning?.code || 'submit_image_warning',
        role: ref?.role,
        message,
        level: 'warn',
      });
    });
  });
  return warnings;
}

const REFERENCE_IMAGE_SUBMIT_WARNING = '参考图提交失败，请检查图片或重试';

function videoFallbackWarnings(fallbackReason?: string): any[] {
  if (!fallbackReason) return [];
  return [{
    key: `reference_image_submit_failed:${fallbackReason}`,
    code: 'reference_image_submit_failed',
    reason: fallbackReason,
    level: 'warn',
    message: REFERENCE_IMAGE_SUBMIT_WARNING,
  }];
}

function compactVideoAuditReferenceImages(refs: any[]): any[] {
  return (Array.isArray(refs) ? refs : []).map((ref) => ({
    role: ref?.role,
    viewRole: ref?.viewRole,
    path: ref?.path,
    label: ref?.label,
    sourceUrl: ref?.sourceUrl,
    assetId: ref?.assetId,
    assetName: ref?.assetName,
    promptHint: ref?.promptHint,
    useFor: ref?.useFor,
    immutable: ref?.immutable,
    panelInfo: ref?.panelInfo,
    referenceBrief: ref?.referenceBrief,
    apiRole: ref?.apiRole,
    apiContentIndex: ref?.apiContentIndex,
    submittedWidth: ref?.submittedWidth,
    submittedHeight: ref?.submittedHeight,
    submittedMime: ref?.submittedMime,
    warnings: ref?.warnings,
  }));
}

function mergeVideoWarnings(...groups: any[][]): any[] {
  const seen = new Set<string>();
  const merged: any[] = [];
  groups.flat().forEach((warning: any) => {
    if (!warning) return;
    const message = String(warning?.message || warning?.key || warning).trim();
    if (!message) return;
    const key = String(warning?.key || `${warning?.code || 'warning'}:${message}`);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(typeof warning === 'object' ? { ...warning, message } : { message });
  });
  return merged;
}

function buildVideoPlanSnapshot(opts: {
  projectId: string;
  groupIdx: number;
  groupShotIndices: number[];
  submitMode?: VideoGenerationPlan['submitMode'];
  payloadMode?: VideoGenerationPlan['payloadMode'];
  modeReason?: VideoGenerationPlan['modeReason'];
  planAuditPayloadModeMismatch?: boolean;
  tempoBudget?: SegmentTempoBudget;
  videoPromptSource: VideoGenerationPlan['promptAudit']['sourcePrompt']['source'];
  sanitizedFor: string[];
  finalPrompt: { preview: string; hash: string; length: number };
  dialoguePolicy: DialoguePolicy;
  dialoguePolicyNotes?: string;
  references: ReferenceManifestItem[];
  droppedReferences: DroppedReference[];
  prompt: string;
  userRatio: string;
  resolution?: string;
  generateAudio?: boolean;
  durationSec: number;
  plannedDurationSec?: number;
  videoWarnings: any[];
  dialogueChars: number;
  status: 'submitting' | 'completed' | 'failed';
  modelSnapshot?: VideoGenerationPlan['modelSnapshot'];
  failureStage?: VideoPromptFailureStage;
  errorMsg?: string;
}): VideoGenerationPlan {
  return {
    version: 'video_plan_v1',
    projectId: opts.projectId,
    groupIdx: opts.groupIdx,
    shotIndices: opts.groupShotIndices,
    submitMode: opts.submitMode,
    payloadMode: opts.payloadMode,
    modeReason: opts.modeReason,
    plannedReferenceRoles: opts.references.map((ref) => ref.role),
    planAuditPayloadModeMismatch: opts.planAuditPayloadModeMismatch || undefined,
    tempoBudget: opts.tempoBudget,
    promptAudit: {
      sourcePrompt: {
        source: opts.videoPromptSource,
        sanitizedFor: opts.sanitizedFor,
      },
      finalPrompt: opts.finalPrompt,
      dialoguePolicy: opts.dialoguePolicy,
      dialoguePolicyNotes: opts.dialoguePolicyNotes,
    },
    references: opts.references,
    droppedReferences: dedupeDroppedReferences(opts.droppedReferences),
    constraints: {
      hard: [
        ...collectRuntimeHardConstraints(opts.prompt),
      ],
      negative: [],
    },
    params: {
      ratio: opts.userRatio,
      resolution: opts.resolution,
      durationSec: opts.durationSec,
      plannedDurationSec: opts.plannedDurationSec,
      subtitles: 'none',
      audioMode: opts.generateAudio === false ? 'none' : 'seedance_dialogue_audio',
    },
    audit: {
      status: opts.status,
      referenceCount: opts.references.length,
      dialogueChars: opts.dialogueChars,
      warnings: opts.videoWarnings.map((warning: any) => warning?.message || String(warning)).filter(Boolean),
      failureStage: opts.failureStage,
      errorMsg: opts.errorMsg,
    },
    modelSnapshot: opts.modelSnapshot,
  };
}

function videoPlanAuditPayloadMismatch(
  planPayloadMode: VideoGenerationPlan['payloadMode'],
  auditPayloadMode?: string | null,
): boolean {
  return !!(planPayloadMode && auditPayloadMode && planPayloadMode !== auditPayloadMode);
}

function warnVideoPlanAuditPayloadMismatch(opts: {
  projectId: string;
  groupIdx: number;
  planned?: string;
  actual?: string | null;
  phase: 'completed' | 'failed';
}) {
  if (!opts.planned || !opts.actual || opts.planned === opts.actual) return;
  console.warn(
    `[video-plan] payload mode mismatch project=${opts.projectId} groupIdx=${opts.groupIdx} phase=${opts.phase} plan=${opts.planned} audit=${opts.actual}`,
  );
}

/* ============================================================
   helper：根据 target.{type, idx} 找到对应资产 + 构造提示词
   ============================================================ */

/**
 * 把 styleBible 转成一段固定的英文 "STYLE BIBLE LOCK"——同一个项目下的
 * **每一张场景图**都拼上完全相同的这段，从 prompt 层面强行让所有场景共享
 * 同一套色调 / 灯光 / 风格关键字，避免场景参考图和后续镜头参考割裂。
 *
 * 注意：这段会作为权威约束放在 prompt 末尾，覆盖前面 imagePrompt 里可能写
 * 出来的局部冲突。如果 styleBible 缺失就返回空串，不强加约束。
 */
function buildSceneStyleLock(styleBible: any): string {
  styleBible = styleBibleForScenePrompt(styleBible);
  if (!styleBible || typeof styleBible !== 'object') return '';
  const parts: string[] = [];
  // 视觉风格关键词（治愈系 / 王家卫怀旧 等）
  const vs = styleBible.visualStyle || styleBible.vision;
  if (vs) parts.push(`Project visual style: ${vs}.`);
  if (styleBible.visualStyleDesc) parts.push(`Style detail: ${styleBible.visualStyleDesc}`);
  // 色板：6 个 hex+中文名拼成英文友好的 list
  if (Array.isArray(styleBible.colorPalette) && styleBible.colorPalette.length) {
    const palette = styleBible.colorPalette
      .filter((c: any) => c && (c.hex || c.name))
      .map((c: any) => `${c.hex || ''}${c.name ? ` (${c.name})` : ''}`.trim())
      .join(', ');
    if (palette) parts.push(`Project color palette (the image's overall color must come from this palette, NOT from the model's default white-balance guess): ${palette}.`);
  }
  // 时代/世界观（决定材质 / 道具风格 / 整体光线倾向）
  if (styleBible.era) parts.push(`Era & setting: ${styleBible.era}`);
  if (styleBible.mood || styleBible.tone) parts.push(`Overall mood: ${styleBible.mood || styleBible.tone}`);
  // 镜头风格（决定景别偏好 / 构图）
  if (styleBible.cameraStyle) parts.push(`Camera language: ${styleBible.cameraStyle}`);
  if (styleBible.lighting) parts.push(`Lighting rules: ${styleBible.lighting}`);
  if (styleBible.texture) parts.push(`Texture rules: ${styleBible.texture}`);
  if (styleBible.editingRhythm) parts.push(`Editing rhythm: ${styleBible.editingRhythm}`);
  if (styleBible.additionalPrompt) parts.push(`Additional positive style prompt: ${styleBible.additionalPrompt}`);
  if (styleBible.negativePrompt || styleBible.videoNegativePrompt) {
    parts.push(`Negative style constraints: ${styleBible.negativePrompt || styleBible.videoNegativePrompt}`);
  }
  // worldRules 太长会挤掉别的提示，截到 240 字
  if (styleBible.worldRules) {
    const wr = String(styleBible.worldRules).slice(0, 240);
    parts.push(`World rules: ${wr}`);
  }
  if (!parts.length) return '';
  return [
    '=== PROJECT STYLE BIBLE LOCK (every scene image in this project MUST share this exact look) ===',
    ...parts,
    'CRITICAL: do NOT introduce colors, lighting temperatures, or material styles outside the project palette above. All scenes in this project must look like they came from the same DP and the same color grading session.',
  ].join('\n');
}

function resolveAssetTarget(project: any, target: any) {
  const type: 'char' | 'scene' | 'prop' = target.type;
  const idx: number = target.idx;
  const cat = type === 'char' ? 'characters' : type === 'scene' ? 'scenes' : 'props';
  const item =
    project?.assets?.[cat]?.[idx] ??
    (cat === 'characters' ? project?.characters?.[idx] :
     cat === 'scenes' ? project?.environments?.[idx] :
     project?.props?.[idx]);
  return { item, type, idx, cat };
}

/**
 * 当 LLM 没写 imagePrompt 时的兜底 prompt。
 * 注意：风格统一（白底 + 写实摄影 + 三视图）已经在 image-gen.ts 的
 * forceStyleSuffix() 里强制兜底了，这里只描述"主体"，不再写风格。
 */
function buildAssetPrompt(asset: any, type: string, _styleBible: any): string {
  if (type === 'char') {
    const traits = [asset.temperament, asset.actionTraits, ...(asset.tags || [])]
      .filter(Boolean)
      .join(', ');
    return [
      `Subject: ${asset.name || 'unnamed character'}.`,
      asset.detail || asset.intro || '',
      traits && `Traits: ${traits}.`,
      asset.appearance && `Appearance: ${asset.appearance}.`,
      asset.clothing && `Clothing: ${asset.clothing}.`,
    ].filter(Boolean).join('\n');
  }
  if (type === 'scene') {
    const parts: string[] = [`Subject: ${asset.name || 'unnamed scene'}.`];
    if (asset.location) parts.push(`Located in: ${asset.location}.`);
    if (asset.description) parts.push(asset.description);
    if (asset.timeSetting) parts.push(`Shot at: ${asset.timeSetting}.`);
    if (asset.weather) parts.push(`Weather: ${asset.weather}.`);
    if (asset.lighting) parts.push(`Lighting: ${asset.lighting}.`);
    if (asset.atmosphere) parts.push(`Atmosphere: ${asset.atmosphere}.`);
    if (Array.isArray(asset.elements) && asset.elements.length) parts.push(`Key elements: ${asset.elements.join(', ')}.`);
    return parts.filter(Boolean).join('\n');
  }
  return [
    `Subject: ${asset.name || 'unnamed prop'}.`,
    asset.features && `Appearance: ${asset.features}.`,
    asset.propType && `Type: ${asset.propType}.`,
  ].filter(Boolean).join('\n');
}

function sceneQualityMetadata(asset: any): string {
  const parts: string[] = [];
  if (asset?.location) parts.push(`Location context: ${asset.location}.`);
  if (asset?.timeSetting) parts.push(`Time of day: ${asset.timeSetting}.`);
  if (asset?.weather) parts.push(`Weather: ${asset.weather}.`);
  if (asset?.lighting) parts.push(`Lighting style: ${asset.lighting}.`);
  if (asset?.atmosphere) parts.push(`Atmosphere / mood: ${asset.atmosphere}.`);
  if (Array.isArray(asset?.elements) && asset.elements.length) parts.push(`Key elements: ${asset.elements.join(', ')}.`);
  if (asset?.description) parts.push(`Description: ${asset.description}.`);
  return parts.join('\n');
}

function sceneViewQualityAttemptSummary(attempt: number, check: SceneViewQualityCheckResult, imageUrl?: string) {
  return {
    attempt,
    status: check.status,
    decision: check.decision,
    score: check.score,
    threshold: check.threshold,
    reasons: check.reasons,
    retryPromptHint: check.retryPromptHint,
    model: check.model,
    provider: check.provider,
    checkedAt: check.checkedAt,
    imageUrl,
  };
}

function sceneViewQualityAuditFromAttempts(
  viewRole: SceneViewRole,
  attempts: Array<ReturnType<typeof sceneViewQualityAttemptSummary>>,
  acceptedImageUrl?: string,
) {
  if (!attempts.length) return undefined;
  const accepted =
    attempts.find((attempt) => acceptedImageUrl && attempt.imageUrl === acceptedImageUrl) ||
    attempts[attempts.length - 1];
  const checkedAttempts = attempts.filter((attempt) => attempt.status === 'checked');
  const status = checkedAttempts.length
    ? 'checked'
    : attempts.some((attempt) => attempt.status === 'error')
      ? 'error'
      : 'skipped';
  const reasons = accepted?.reasons?.length
    ? accepted.reasons
    : attempts.flatMap((attempt) => attempt.reasons || []).slice(0, 6);
  return {
    schemaVersion: 1,
    viewRole,
    status,
    decision: 'accept',
    score: typeof accepted?.score === 'number' ? accepted.score : null,
    threshold: accepted?.threshold,
    acceptedAttempt: typeof accepted?.attempt === 'number' ? accepted.attempt : attempts.length - 1,
    acceptedImageUrl: acceptedImageUrl || accepted?.imageUrl || null,
    attemptCount: attempts.length,
    attempts,
    reasons,
    evaluatedAt: new Date().toISOString(),
  };
}

/* ============================================================
   imageHistory archiving helper — keep old image+info snapshots
   on the asset itself so polling/reload from server preserves them.
   ============================================================ */
const ASSET_IMG_HISTORY_FIELDS: Record<'char' | 'scene' | 'prop', string[]> = {
  char: ['name','role','identity','appearance','clothing','equipment','temperament','actionTraits','entityType','castingOverride','imagePrompt','description','tags'],
  scene: ['name','description','location','timeSetting','weather','lighting','atmosphere','elements','imagePrompt','views','viewsQuality','viewsVersion','viewHistory'],
  prop: ['name','propType','features','material','dimensionality','imagePrompt','views','viewsVersion','viewHistory'],
};
const MAX_ASSET_IMAGE_HISTORY = 10;

function sceneViewRoleForTarget(target: any): SceneViewRole {
  return normalizeSceneViewRole(target?.viewRole) || 'establishing';
}

function _captureAssetImageSnapshot(
  existing: any,
  type: 'char' | 'scene' | 'prop',
  source: string,
): Record<string, any> | null {
  if (!existing || typeof existing !== 'object') return null;
  const snap: Record<string, any> = {};
  if (existing.imageUrl) snap.url = existing.imageUrl;
  if (existing.rawUrl && existing.rawUrl !== snap.url) snap.rawUrl = existing.rawUrl;
  if (existing.realPhotoUrl && existing.realPhotoUrl !== snap.url) snap.realPhotoUrl = existing.realPhotoUrl;
  if (existing.pencilUrl) snap.pencilUrl = existing.pencilUrl;
  if (!snap.url && !snap.rawUrl && !snap.realPhotoUrl && !snap.pencilUrl) return null;
  const mainUrl = snap.url || snap.rawUrl || snap.realPhotoUrl || snap.pencilUrl;
  if (typeof mainUrl === 'string' && mainUrl.startsWith('blob:')) return null;
  const fields = ASSET_IMG_HISTORY_FIELDS[type];
  const info: Record<string, any> = {};
  fields.forEach((f) => {
    info[f] = existing[f] === undefined ? null : existing[f];
  });
  snap.info = info;
  snap.at = Date.now();
  snap.source = source;
  return snap;
}

function _withArchivedImageHistory(
  existing: any,
  next: any,
  type: 'char' | 'scene' | 'prop',
  source: string,
): any {
  const snap = _captureAssetImageSnapshot(existing, type, source);
  const prior = Array.isArray(existing?.imageHistory) ? existing.imageHistory : [];
  if (!snap) {
    // 没有旧图（首次生成）—— 直接保留已有的 history（来自 extract 时的归档）
    return prior.length ? { ...next, imageHistory: prior } : next;
  }
  const top = prior[0];
  const isDup = top && top.url === snap.url && top.rawUrl === snap.rawUrl &&
                top.pencilUrl === snap.pencilUrl && top.realPhotoUrl === snap.realPhotoUrl;
  const nextHistory = isDup ? prior.slice(0, MAX_ASSET_IMAGE_HISTORY) : [snap, ...prior].slice(0, MAX_ASSET_IMAGE_HISTORY);
  return { ...next, imageHistory: nextHistory };
}

/* ============================================================
   1. asset_images executor
   ============================================================ */
registerExecutor('asset_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const { item, type, idx, cat } = resolveAssetTarget(proj, ctx.target);
  if (!item) throw new Error(`找不到 ${cat}[${idx}]`);
  const isCrowdCharacterAsset = type === 'char' && isAnonymousCrowdAsset(item);
  const sceneViewRole: SceneViewRole | undefined = type === 'scene' ? sceneViewRoleForTarget(ctx.target) : undefined;
  const propDimensionality = type === 'prop' ? normalizePropDimensionality(item?.dimensionality, item) : undefined;
  const isVolumetricProp = type === 'prop' && propDimensionality === 'volumetric';

  ctx.progress({ stage: 'building_prompt' });
  const rawStyleBible = (proj as any).styleBible || {};
  const reusablePrompt = item.imagePrompt || buildAssetPrompt(item, type, rawStyleBible);
  let prompt = reusablePrompt;
  const assetStyleType = type as AssetStyleType;
  const styleBibleForAsset = type === 'char' ? rawStyleBible : styleBibleForScenePrompt(rawStyleBible);
  const styleLockContext = buildAssetStyleLock(styleBibleForAsset, assetStyleType);

  // 场景元数据注入：原网站效果之所以好看，是因为它把"时段/天气/灯光/氛围/位置"
  // 这些场景级参数也喂进了图像 prompt（不光显示在卡上）。我们的 LLM 现在会抽
  // 这些字段（参考资产场景抽取规则），这里在出图前拼一段"SCENE METADATA"
  // 段落让图像模型必须 reflect 出来。即便 imagePrompt 已经写过部分氛围，
  // 这段也作为权威约束追加到末尾。
  if (type === 'scene') {
    const sceneMeta: string[] = [];
    if (item.location) sceneMeta.push(`Location context: ${item.location}.`);
    if (item.timeSetting) sceneMeta.push(`Time of day: ${item.timeSetting} — lighting and shadows must match this time.`);
    if (item.weather) sceneMeta.push(`Weather: ${item.weather}.`);
    if (item.lighting) sceneMeta.push(`Lighting style: ${item.lighting}.`);
    if (item.atmosphere) sceneMeta.push(`Atmosphere / mood keywords (the image must feel like these): ${item.atmosphere}.`);
    if (Array.isArray(item.elements) && item.elements.length) sceneMeta.push(`Key elements that must appear: ${item.elements.join(', ')}.`);
    if (sceneMeta.length) {
      prompt = `${prompt}\n\n=== SCENE METADATA (must reflect in image, override conflicting hints above) ===\n${sceneMeta.join('\n')}`;
    }

    // ----- 项目级色调锁定 -----
    // 场景资产现在只生成一张主环境参考图；这里从 styleBible 抽出 color
    // palette / visualStyle / mood / era，让这张图稳定承载全片环境质感。
    if (styleLockContext.prompt) {
      prompt = `${prompt}\n\n${styleLockContext.prompt}`;
    }
  }

  // 角色元数据注入：把用户当前编辑过的外貌/服装/道具放到末尾作为权威覆盖，
  // 避免旧 imagePrompt 或重写 LLM 把这些细节弱化。气质/动作特征也影响表演
  // 气场（皱眉/手插腰），同样要求图像模型反映出来。
  if (type === 'char') {
    const rawLock = findCharacterLock(proj as any, item);
    const lock = rawLock && !isCrowdCharacterAsset ? buildAssetAuthoritativeCharacterLock(rawLock, item) : null;
    if (lock) {
      prompt = `${prompt}\n\n=== CHARACTER CONSISTENCY LOCK (authoritative, must match exactly) ===\n${renderCharacterLockRosterLine(lock, 'en')}`;
    } else {
      const charMeta: string[] = [];
      if (item.appearance) charMeta.push(`${isCrowdCharacterAsset ? 'Current group appearance' : 'Current appearance'} (authoritative override): ${item.appearance}.`);
      if (item.clothing) charMeta.push(`${isCrowdCharacterAsset ? 'Current group clothing system' : 'Current clothing'} (authoritative override): ${item.clothing}.`);
      if (isCrowdCharacterAsset && item.crowdSize) charMeta.push(`Approximate crowd size: ${item.crowdSize}.`);
      if (item.equipment) charMeta.push(`Holding / wearing: ${item.equipment}.`);
      if (item.temperament) charMeta.push(`${isCrowdCharacterAsset ? 'Group temperament distribution' : 'Temperament keywords'} (must show in face/posture): ${item.temperament}.`);
      if (item.actionTraits) charMeta.push(`${isCrowdCharacterAsset ? 'Shared action/posture traits' : 'Signature gestures (pose hints for the front view)'}: ${item.actionTraits}.`);
      if (charMeta.length) {
        prompt = `${prompt}\n\n=== CHARACTER METADATA (must reflect in image, override conflicting hints above) ===\n${charMeta.join('\n')}`;
      }
    }
    prompt = appendCharacterCastingPrompt(prompt, item, rawStyleBible, { script: (proj as any).script || (proj as any).scriptDraft || '' });
    if (styleLockContext.prompt) {
      prompt = `${prompt}\n\n${styleLockContext.prompt}`;
    }
  } else if (type === 'prop' && styleLockContext.prompt) {
    prompt = `${prompt}\n\n${styleLockContext.prompt}`;
  }

  ctx.progress({ stage: 'calling_image_api' });
  // 尺寸策略：
  //   - 真人角色：1536×1024（宽图），三视图横向排开
  //   - 非人角色（拟人海鲜/机甲/动物）：1536×1024 也用三视图（前/侧/背）
  //   - 场景：1536×1024 establishing shot
  //   - 立体道具：1536×1024 六视图 sheet（3×2，每格正方）
  //   - 平面道具：1024×1024 白底 product shot
  const entityType: 'human' | 'non-human' =
    type === 'char' ? inferEntityTypeFromCharacter(item) : 'human';

  const styleReferenceMeta = {
    styleBibleSignature: styleLockContext.signature,
    styleLockVersion: styleLockContext.styleLockVersion,
    resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
  };

  let referenceImagePath: string | undefined;
  if (type === 'scene' && sceneViewRole && sceneViewRole !== 'establishing') {
    const establishingUrl = resolveSceneImageUrl(item, {
      strategy: 'videoManifest',
      gate: true,
      viewRole: 'establishing',
    });
    referenceImagePath = establishingUrl ? (resolveLocalImagePath(establishingUrl, ctx.user.id) || undefined) : undefined;
    if (!referenceImagePath) {
      throw new Error(`scene_view_missing_establishing:${cat}[${idx}].views.${sceneViewRole}`);
    }
  }

  const imageInput: ImageGenInput = {
    prompt,
    size: type === 'char' ? '1536x1024' : type === 'scene' ? '1536x1024' : isVolumetricProp ? '1536x1024' : '1024x1024',
    style: 'natural',
    kind: type === 'char' ? 'character' : type === 'scene' ? 'scene' : 'prop',
    entityType: type === 'char' ? entityType : undefined,
    sceneViewRole,
    propDimensionality,
    characterAssetMode: type === 'char' ? characterAssetModeFor(item) : undefined,
    projectId: ctx.projectId,
    assetRef: type === 'scene' && sceneViewRole ? `${cat}[${idx}].views.${sceneViewRole}` : `${cat}[${idx}]`,
    // 角色参考图和场景主环境图细节多，低画质会糊掉脸和场景纹理；
    // 立体道具六视图 sheet 也需要更高细节；平面道具保留 low 单图。
    quality: type === 'prop' && !isVolumetricProp ? 'low' : 'medium',
    storageStyle: type === 'scene' ? 'scene-view' : isVolumetricProp ? 'prop-view-sheet' : undefined,
    referenceImagePath,
    styleLockApplied: type === 'char' && styleLockContext.hasMeaningfulStyle,
    styleBackdropColor: type === 'char' ? styleLockContext.resolvedBackdropColor : undefined,
    imageAuditMetadata: {
      styleBibleSignature: styleReferenceMeta.styleBibleSignature,
      styleBibleSignatureType: styleLockContext.signatureType,
      resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor || null,
      styleLockVersion: styleReferenceMeta.styleLockVersion,
    },
  };
  let result = await generateImageWithModerationRecovery(ctx.user, imageInput);
  let sceneViewQualityAttempts: Array<ReturnType<typeof sceneViewQualityAttemptSummary>> = [];
  let sceneViewQualityAudit: ReturnType<typeof sceneViewQualityAuditFromAttempts> | undefined;

  if (sceneViewRole && shouldEvaluateSceneViewQuality(type, sceneViewRole)) {
    const evaluateCandidate = async (
      candidate: Awaited<ReturnType<typeof generateImageWithModerationRecovery>>,
      attempt: number,
    ): Promise<SceneViewQualityCheckResult> => {
      const candidateImagePath = resolveLocalImagePath(candidate.url, ctx.user.id) || undefined;
      ctx.progress({
        stage: 'checking_scene_view_quality',
        viewRole: sceneViewRole,
        attempt,
        hint: '检查场景副视图是否贴合主视角空间布局…',
      });
      return evaluateSceneViewQuality({
        user: ctx.user,
        viewRole: sceneViewRole,
        establishingImagePath: referenceImagePath,
        candidateImagePath,
        sceneName: item?.name,
        scenePrompt: reusablePrompt,
        sceneMetadata: sceneQualityMetadata(item),
        attempt,
        tokenContext: {
          ownerId: ctx.user.id,
          usernameSnapshot: ctx.user.phone || ctx.user.display_name || ctx.user.username || null,
          projectId: ctx.projectId,
          routeName: 'batch.asset_images',
          moduleKey: 'image',
          moduleLabel: '图片生成',
          featureKey: 'scene_view_quality_check',
          featureLabel: '场景副视图一致性评分',
          callItemType: 'batch_task',
          callItemId: ctx.taskId,
          callItemLabel: `${cat}[${idx}].views.${sceneViewRole}`,
          batchId: ctx.batchId,
          taskId: ctx.taskId,
          operationKey: `batch:${ctx.batchId}:task:${ctx.taskId}:scene-view-quality:${sceneViewRole}:${attempt}`,
          operationLabel: '场景副视图一致性评分',
          meta: {
            type,
            cat,
            idx,
            viewRole: sceneViewRole,
            attempt,
          },
        },
      });
    };

    const firstCheck = await evaluateCandidate(result, 0);
    sceneViewQualityAttempts.push(sceneViewQualityAttemptSummary(0, firstCheck, result.url));

    if (firstCheck.decision === 'retry') {
      try {
        ctx.progress({
          stage: 'calling_image_api',
          viewRole: sceneViewRole,
          attempt: 1,
          hint: '重新生成场景副视图以修正空间一致性…',
        });
        const retryPrompt = buildSceneViewQualityRetryPrompt(prompt, firstCheck);
        const retryResult = await generateImageWithModerationRecovery(ctx.user, {
          ...imageInput,
          prompt: retryPrompt,
        });
        const retryCheck = await evaluateCandidate(retryResult, 1);
        sceneViewQualityAttempts.push(sceneViewQualityAttemptSummary(1, retryCheck, retryResult.url));
        const firstScore = typeof firstCheck.score === 'number' ? firstCheck.score : -1;
        const retryScore = typeof retryCheck.score === 'number' ? retryCheck.score : Number.POSITIVE_INFINITY;
        if (retryCheck.status !== 'checked' || retryScore >= firstScore) {
          result = retryResult;
        }
      } catch (retryErr: any) {
        const retryError = errorSceneViewQualityResult(sceneViewRole, retryErr);
        sceneViewQualityAttempts.push(sceneViewQualityAttemptSummary(1, retryError));
        console.warn(
          `[asset_images] scene view quality retry failed for ${cat}[${idx}].views.${sceneViewRole}; accepting first candidate: ` +
          String(retryErr?.message || retryErr).slice(0, 300),
        );
      }
    }
    sceneViewQualityAudit = sceneViewQualityAuditFromAttempts(sceneViewRole, sceneViewQualityAttempts, result.url);
  }

  let panelResult: SplitCharacterPanelsResult | null = null;
  if (type === 'char' && !isCrowdCharacterAsset) {
    ctx.progress({ stage: 'splitting_character_panels' });
    panelResult = await splitCharacterPanels({
      user: ctx.user,
      projectId: ctx.projectId,
      assetRef: `${cat}[${idx}]`,
      sourceImageUrl: result.url,
      entityType,
      prompt: result.submittedPrompt,
      version: existingPanelVersion(item) + 1,
    });
    if (!panelResult.ok) {
      console.warn(`[asset_images] character panel split failed for ${cat}[${idx}]: ${panelResult.error}`);
    }
  }
  let propViewResult: SplitPropViewsResult | null = null;
  if (isVolumetricProp) {
    ctx.progress({ stage: 'splitting_prop_views' });
    const priorVersion = Number(item?.viewsVersion || item?.views?.version || 0);
    propViewResult = await splitPropViews({
      user: ctx.user,
      projectId: ctx.projectId,
      assetRef: `${cat}[${idx}]`,
      sourceImageUrl: result.url,
      prompt: result.submittedPrompt,
      version: (Number.isFinite(priorVersion) ? priorVersion : 0) + 1,
    });
    if (!propViewResult.ok) {
      console.warn(`[asset_images] prop view split failed for ${cat}[${idx}]: ${propViewResult.error}`);
    }
  }
  const eventReferenceUpdate = type === 'char'
    ? isCrowdCharacterAsset
      ? deriveCrowdReferenceUpdate(item, result, styleReferenceMeta)
      : deriveCharacterReferenceUpdate(item, result, panelResult, entityType, styleReferenceMeta, undefined, findCharacterLock(proj, item)?.referenceLock)
    : null;
  const eventPropAsset = type === 'prop'
    ? isVolumetricProp && propViewResult
      ? applyPropViewWrite(item, {
          splitResult: propViewResult,
          sourceImageUrl: result.url,
          imagePrompt: reusablePrompt,
          submittedImagePrompt: result.submittedPrompt,
          imageSafetyAudit: result.safetyAudit,
          effectiveVisualDescription: result.visualAnchorDescription,
          styleBibleSignature: styleReferenceMeta.styleBibleSignature,
          styleLockVersion: styleReferenceMeta.styleLockVersion,
          resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor,
        })
      : {
          ...item,
          dimensionality: propDimensionality,
          imageUrl: result.url,
          rawUrl: result.url,
        }
    : null;
  const eventPropUrl = eventPropAsset
    ? resolvePropImageUrl(eventPropAsset, { strategy: 'selection', gate: false })
    : '';

  // 写回项目：把 imageUrl + rawUrl + imagePrompt 落到资产对象
  // 注意：写入 imageUrl + rawUrl 两个字段，因为前端不同卡片读不同字段（兼容历史）
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const assets = (fresh as any).assets || { characters: [], scenes: [], props: [] };
    if (!assets[cat]) assets[cat] = [];
    if (!assets[cat][idx]) assets[cat][idx] = {};
    const baseAsset = {
      ...assets[cat][idx],
      imagePrompt: reusablePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
    };
    const assetReferenceLock = type === 'char' ? findCharacterLock(fresh, baseAsset)?.referenceLock : undefined;
    const charAssetUpdate = type === 'char'
      ? isAnonymousCrowdAsset(baseAsset)
        ? deriveCrowdReferenceUpdate(baseAsset, result, styleReferenceMeta)
        : deriveCharacterReferenceUpdate(baseAsset, result, panelResult, entityType, styleReferenceMeta, undefined, assetReferenceLock)
      : null;
    let nextAsset = charAssetUpdate
      ? charAssetUpdate.nextAsset
      : type === 'scene' && sceneViewRole
        ? applySceneViewWrite(baseAsset, {
            role: sceneViewRole,
            imageUrl: result.url,
            rawUrl: result.url,
            imagePrompt: reusablePrompt,
            submittedImagePrompt: result.submittedPrompt,
            imageSafetyAudit: result.safetyAudit,
            effectiveVisualDescription: result.visualAnchorDescription,
            styleBibleSignature: styleReferenceMeta.styleBibleSignature,
            styleLockVersion: styleReferenceMeta.styleLockVersion,
            resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor,
            qualityAudit: sceneViewQualityAudit,
          })
        : type === 'prop' && isVolumetricProp && propViewResult
          ? applyPropViewWrite(baseAsset, {
              splitResult: propViewResult,
              sourceImageUrl: result.url,
              imagePrompt: reusablePrompt,
              submittedImagePrompt: result.submittedPrompt,
              imageSafetyAudit: result.safetyAudit,
              effectiveVisualDescription: result.visualAnchorDescription,
              styleBibleSignature: styleReferenceMeta.styleBibleSignature,
              styleLockVersion: styleReferenceMeta.styleLockVersion,
              resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor,
            })
        : {
            ...baseAsset,
            ...(type === 'prop' ? { dimensionality: propDimensionality } : {}),
            imageUrl: result.url,
            rawUrl: result.url,
            reference: {
              ...assets[cat][idx].reference,
              currentUrl: result.url,
              lastKnownGoodUrl: result.url,
              status: 'ready',
              updatedAt: new Date().toISOString(),
              styleBibleSignature: styleLockContext.signature,
              styleLockVersion: styleLockContext.styleLockVersion,
              resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
            },
            imageGeneratedAt: new Date().toISOString(),
          };
    const propViewSplitFailed = type === 'prop' && isVolumetricProp && propViewResult && !propViewResult.ok;
    if (type !== 'char' && !propViewSplitFailed) {
      delete (nextAsset as any).imageLastError;
      delete (nextAsset as any).imageFailedAt;
      if (nextAsset.reference) delete (nextAsset.reference as any).lastError;
    }
    // 把旧图 + 旧信息归档进 imageHistory（前端 polling/reload 后也能看到）
    const archivedAsset = type === 'scene' && sceneViewRole !== 'establishing'
      ? nextAsset
      : _withArchivedImageHistory(assets[cat][idx], nextAsset, type, 'regen');
    assets[cat][idx] = archivedAsset;
    // 顶层 characters/environments/props 也同步（前端两种结构都读）
    const topKey = cat === 'characters' ? 'characters' : cat === 'scenes' ? 'environments' : 'props';
    const top = (fresh as any)[topKey] || [];
    if (!top[idx]) top[idx] = {};
    const baseTop = {
      ...top[idx],
      imagePrompt: reusablePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
    };
    const topReferenceLock = type === 'char' ? findCharacterLock(fresh, baseTop)?.referenceLock : undefined;
    const charTopUpdate = type === 'char'
      ? isAnonymousCrowdAsset(baseTop)
        ? deriveCrowdReferenceUpdate(baseTop, result, styleReferenceMeta)
        : deriveCharacterReferenceUpdate(baseTop, result, panelResult, entityType, styleReferenceMeta, undefined, topReferenceLock)
      : null;
    let nextTop = charTopUpdate
      ? charTopUpdate.nextAsset
      : type === 'scene' && sceneViewRole
        ? applySceneViewWrite(baseTop, {
            role: sceneViewRole,
            imageUrl: result.url,
            rawUrl: result.url,
            imagePrompt: reusablePrompt,
            submittedImagePrompt: result.submittedPrompt,
            imageSafetyAudit: result.safetyAudit,
            effectiveVisualDescription: result.visualAnchorDescription,
            styleBibleSignature: styleReferenceMeta.styleBibleSignature,
            styleLockVersion: styleReferenceMeta.styleLockVersion,
            resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor,
            qualityAudit: sceneViewQualityAudit,
          })
        : type === 'prop' && isVolumetricProp && propViewResult
          ? applyPropViewWrite(baseTop, {
              splitResult: propViewResult,
              sourceImageUrl: result.url,
              imagePrompt: reusablePrompt,
              submittedImagePrompt: result.submittedPrompt,
              imageSafetyAudit: result.safetyAudit,
              effectiveVisualDescription: result.visualAnchorDescription,
              styleBibleSignature: styleReferenceMeta.styleBibleSignature,
              styleLockVersion: styleReferenceMeta.styleLockVersion,
              resolvedBackdropColor: styleReferenceMeta.resolvedBackdropColor,
            })
        : {
            ...baseTop,
            ...(type === 'prop' ? { dimensionality: propDimensionality } : {}),
            imageUrl: result.url,
            rawUrl: result.url,
            reference: {
              ...top[idx].reference,
              currentUrl: result.url,
              lastKnownGoodUrl: result.url,
              status: 'ready',
              updatedAt: new Date().toISOString(),
              styleBibleSignature: styleLockContext.signature,
              styleLockVersion: styleLockContext.styleLockVersion,
              resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
            },
          };
    if (type !== 'char' && !propViewSplitFailed) {
      delete (nextTop as any).imageLastError;
      delete (nextTop as any).imageFailedAt;
      if (nextTop.reference) delete (nextTop.reference as any).lastError;
    }
    // 顶层也归档一份（保持 assets.* 和 top.* 两路镜像一致）
    nextTop = type === 'scene' && sceneViewRole !== 'establishing'
      ? nextTop
      : _withArchivedImageHistory(top[idx], nextTop, type, 'regen');
    top[idx] = nextTop;
    const patch: any = { assets, [topKey]: top };
    if (type === 'char' && !isAnonymousCrowdAsset(nextAsset)) {
      const mutation = mutateCharacterLock(
        { ...(fresh as any), ...patch },
        nextAsset.characterId || nextAsset.id || nextAsset.name || `characters[${idx}]`,
        {
          referenceLock: charAssetUpdate?.referenceLock,
        },
        { source: 'asset_image' },
      );
      patch.consistency = mutation.project.consistency;
      patch.assets = mutation.project.assets;
      patch[topKey] = mutation.project[topKey];
    }
    return patch;
  });

  // task_completed 事件 payload：前端 onTaskCompleted 读 extra.rawUrl / extra.pencilUrl
  // 来实时更新卡片 UI（不刷新就能看到图）。之前我们漏发这两个字段，所以图必须
  // 刷新页面才显示——这里补上。
  const emittedImageUrl = type === 'prop' && isVolumetricProp ? eventPropUrl : result.url;
  const emittedImagePrompt = reusablePrompt;
  return {
    resultUrl: emittedImageUrl || undefined,
    patch: {
      type: 'asset_image',
      cat,
      idx,
      value: type === 'char' && eventReferenceUpdate && !eventReferenceUpdate.accepted ? undefined : emittedImageUrl || undefined,
      imageUrl: type === 'char' && eventReferenceUpdate && !eventReferenceUpdate.accepted ? undefined : emittedImageUrl || undefined,
      imagePrompt: emittedImagePrompt,
    },
    extra: {
      type,
      idx,
      viewRole: sceneViewRole,
      rawUrl: type === 'char' && eventReferenceUpdate && !eventReferenceUpdate.accepted ? undefined : emittedImageUrl || undefined,
      pencilUrl: type === 'char' && (!eventReferenceUpdate || eventReferenceUpdate.accepted) ? emittedImageUrl || undefined : undefined,
      skippedStylize: type === 'char' && (!eventReferenceUpdate || eventReferenceUpdate.accepted) ? true : undefined,
      mode: result.mode,
      width: result.width,
      height: result.height,
      sourceSheetUrl: type === 'prop' && isVolumetricProp ? result.url : undefined,
      dimensionality: type === 'prop' ? propDimensionality : undefined,
      referenceStatus: eventReferenceUpdate?.referenceStatus,
      lastAttemptUrl: eventReferenceUpdate && !eventReferenceUpdate.accepted ? result.url : undefined,
      lastError: eventReferenceUpdate && !eventReferenceUpdate.accepted ? eventReferenceUpdate.lastError : undefined,
      views: type === 'prop' && isVolumetricProp && propViewResult?.ok ? propViewResult.views : undefined,
      viewsError: type === 'prop' && isVolumetricProp && propViewResult && !propViewResult.ok ? propViewResult.error : undefined,
      panels: eventReferenceUpdate?.accepted
        ? isCrowdCharacterAsset
          ? eventReferenceUpdate.nextAsset?.panels
          : panelResult?.ok ? panelResult.panels : undefined
        : undefined,
      panelsError: eventReferenceUpdate && !eventReferenceUpdate.accepted
        ? (eventReferenceUpdate.lastError?.message || eventReferenceUpdate.lastError?.reason)
        : undefined,
      imageSafetyAudit: result.safetyAudit,
      sceneViewQuality: sceneViewQualityAudit,
      styleBibleSignature: styleLockContext.signature,
      styleLockVersion: styleLockContext.styleLockVersion,
      resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
    },
  };
});

/* ============================================================
   2. storyboard_prompts executor —— 把单个镜头描述转成图像生成提示词
   ============================================================ */
const SP_SHOT_TO_IMG_PROMPT = `你是分镜手稿（pre-production storyboard）提示词工程师。把"短视频镜头"整理成中文画面提示词，最终会被画成**黑白铅笔分镜稿**（不是成片！不是照片！）。

【硬性要求】
- 中文为主输出，不要 markdown，不要 ["..."] 围栏
- 80-220 字
- 描述对象就是一张分镜稿，所以只描写：①主体（人物名 + 服装外观 + 表情/姿态）②动作（只描述这一帧定格的动作）③ 构图与景别（可保留 wide shot / medium / close-up / over-shoulder 等少量术语）④ 机位（可保留 low angle / high angle / eye-level / POV 等少量术语）⑤ 光照方向 ⑥ 关键道具与场景元素
- 如果给了角色描述，必须保留外观/服装一致性（同一角色多个镜头里穿同样的衣服）

【非人/拟人角色规则 —— 极其重要】
- 如果角色被标记为 "非人/拟人"（NON-HUMAN），或者画面描述里出现了拟人化的海鲜 / 动物 / 机甲 / AI 生物（例如"帝王蟹队长 / 龙虾 / 生蚝 / 三文鱼 / 扇贝 / 章鱼 / 机甲战士"等），**必须保留它们的物种本体**，例如帝王蟹要有蟹壳和蟹钳，龙虾要有虾壳和触须，生蚝要保留贝壳形态。
- **绝对禁止把这些非人角色画成穿围裙的真人员工**。如果同一画面里同时有人类老板和拟人海鲜，那么人类只画给定的人类角色，其余成员必须是对应物种的拟人形态（壳、鳃、触手、眼柄、钳等清晰可辨）。
- 对于群像（"一排员工 / 一群成员 / 后厨工会"等），必须按画面描述里点名的物种逐个画出，例如画面中心是举起大钳的帝王蟹，后方依次是龙虾、生蚝、三文鱼、扇贝，不要写成一排穿围裙的人类员工。
- **体型必须接近现实物种 + 至多到人类肩膀高**：拟人海鲜是"小员工尺寸"，不是巨型怪兽。请在描述里显式写"帝王蟹约到人类肩膀高"、"小龙虾尺寸的拟人龙虾后肢站立"、"手掌大小的拟人生蚝"，并明确"比人类角色更矮 / 人类老板是画面里最高的角色"。绝不能让蟹钳比人脸还大、海鲜覆盖整个画面；如果一定要给中近景，描述时也要保持人类比海鲜更高的比例。

【禁止】
- 不要写 "photorealistic / cinematic film / 35mm / film grain / hyper-real / 4K / vivid color / teal-orange / saturated"——这些会破坏手稿风
- 不要写 "color palette / warm color tone"，分镜稿是黑白
- 不要写"运镜动词"作为单独陈述（如"镜头缓慢推进"），改成静止构图描述，例如"构图暗示纵深推进感"
- 不要写台词或字幕
- 不要写 "three-view" 或 "white background"（那是资产图，不是分镜图）
- 不要把任何拟人化的非人角色降级成真人员工
- 不要解释，不要复述输入，不要写"提示词："前缀，直接输出中文 prompt 段落`;

registerExecutor('storyboard_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');
  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? ctx.seq;
  const allShots = Array.isArray((proj as any).shots) ? (proj as any).shots : [];
  const sbForGroup = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards[groupIdx] : undefined;
  const shotIndices = storyboardShotIndices(proj as any, groupIdx, sbForGroup, {
    mode: 'single-shot-strict',
    explicitShotIndices: ctx.target.shotIndices,
  });
  // idx 收敛到"段首镜头"= 该段首帧图来源（合并段只有段首出首帧图）。
  // 1:1 时 shotIndices=[groupIdx]，idx 仍 = 旧值，下游读写完全等价。
  const idx: number = shotIndices[0] ?? groupIdx;
  assertArtifactUsable(proj as any, ctx, 'storyboard_prompt', { shotIndices });
  const shot = allShots[idx];
  if (!shot) throw new Error(`找不到段 ${groupIdx} 的段首镜头 shots[${idx}]`);

  ctx.progress({ stage: 'building_prompt' });
  const styleBible = styleBibleForShotPrompt((proj as any).styleBible || {});
  const styleHint = joinPromptValues([
    styleBible.vision || styleBible.visualStyle,
    styleBible.colorPalette,
    styleBible.cameraStyle,
    styleBible.mood || styleBible.tone,
    styleBible.lighting,
    styleBible.texture,
    styleBible.editingRhythm,
    styleBible.additionalPrompt && `正向增强:${styleBible.additionalPrompt}`,
    (styleBible.negativePrompt || styleBible.videoNegativePrompt) && `禁止:${styleBible.negativePrompt || styleBible.videoNegativePrompt}`,
  ]);

  // 兼容新老字段。旧 shotType=俯拍/主观/过肩 会在这里读成 angle，shotType 回落到景别。
  const shotFields = resolveShotFieldsForPrompt(shot, styleBible);
  const shotType = shotFields.shotType;
  const angle = shotFields.angle;
  const lens = shotFields.lens;
  const focus = shotFields.focus;
  const light = shotFields.light;
  const composition = shotFields.composition;
  const camera = shotFields.camera;
  const visual = shot.visual || shot.description || shot.desc || '';
  const dialogue = shot.dialogue || shot.dialog || '';
  const characters: string[] = Array.isArray(shot.characters) ? shot.characters : [];
  const keyInfo = shot.keyInfo || '';

  // 拼角色上下文（保持跨镜头服装/外观一致性 + 非人物种保护）
  const allChars = ((proj as any).assets?.characters || []) as any[];
  let charContext = '';
  if (characters.length) {
    charContext = characters
      .map((nm) => allChars.find((c: any) => c.name === nm || c.role === nm))
      .filter(Boolean)
      .map((c: any) => {
        const desc = c.appearance || c.description || c.detail || '';
        const cloth = c.clothing ? `, clothing: ${c.clothing}` : '';
        const ent = c.entityType === 'non-human' ? ' [NON-HUMAN / 拟人化，必须保留物种形态]' : '';
        return `${c.name || c.role}${ent}: ${desc}${cloth}`.trim();
      })
      .join(' | ');
  }

  // 兜底：扫一遍画面描述，把项目里登记过的非人角色名字都列出来，
  // 防止 shot.characters 漏写时 LLM 把"帝王蟹队长"画成真人。
  const nonHumanMentions: string[] = [];
  if (visual && allChars.length) {
    for (const c of allChars) {
      if (c.entityType !== 'non-human') continue;
      const nm = c.name || c.role;
      if (!nm) continue;
      if (visual.includes(nm) && !characters.includes(nm)) {
        const desc = c.appearance || c.description || c.detail || '';
        nonHumanMentions.push(`${nm} [NON-HUMAN]: ${desc}`.trim());
      }
    }
  }

  const worldContext = projectWorldContextForStage('storyboard_sketch_prompt', (proj as any).worldTemplateSnapshot, {
    project: proj,
    target: { groupIdx, shotIndices },
  });
  const worldText = formatWorldContextForPrompt(worldContext);

	  const userMsg = [
	    `镜头序号：${shot.idx ?? idx + 1}`,
	    shotType && `景别：${shotType}`,
	    angle && `角度/视点：${angle}`,
	    lens && `焦距：${lens}`,
	    focus && `景深/焦点：${focus}`,
	    light && `光线组合：${light}`,
	    composition && `构图组合：${composition}`,
	    camera && `运镜：${camera}`,
    visual && `画面描述：${visual}`,
    dialogue && dialogue !== '——' && `台词/旁白：${dialogue}`,
    keyInfo && `主题词：${keyInfo}`,
    charContext && `本镜头角色（必须保留外观/服装一致性）：${charContext}`,
    nonHumanMentions.length && `画面中提及的其它非人/拟人角色（绝对不能画成真人）：${nonHumanMentions.join(' | ')}`,
    worldText && `分镜稿参考的世界观事实与软默认：\n${worldText}`,
    styleHint && `整体视觉风格：${styleHint}`,
  ].filter(Boolean).join('\n');

  ctx.progress({ stage: 'calling_llm' });
  const prompt = await chatComplete(
    ctx.user,
    [
      { role: 'system', content: SP_SHOT_TO_IMG_PROMPT },
      { role: 'user', content: userMsg },
    ],
    {
      temperature: 0.5,
      maxTokens: 600,
      modelRole: 'structured',
      traceName: 'storyboard.image_prompt',
      tokenContext: {
        projectId: ctx.projectId,
        requestPath: 'batch_executor:storyboard_image_generation',
        routeName: 'batch.storyboard-image-generation',
        moduleKey: 'assets',
        moduleLabel: '资产生成',
        featureKey: 'storyboard_image_prompt',
        featureLabel: '分镜图提示词生成',
        callItemType: 'batch_task',
        callItemId: ctx.taskId,
        callItemLabel: `镜头 ${shot.idx ?? idx + 1}`,
        batchId: ctx.batchId,
        taskId: ctx.taskId,
      },
    },
  );
  const cleaned = prompt.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) throw new Error('AI 没有返回提示词');

  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const shots = Array.isArray((fresh as any).shots) ? [...(fresh as any).shots] : [];
    if (shots[idx]) {
      shots[idx] = { ...shots[idx], imagePrompt: cleaned, imagePromptGenerated: true };
      return { shots };
    }
    return null;
  });

  recordBatchKnowledgeAudit({
    ctx,
    project: proj,
    stage: 'storyboard_sketch_prompt',
    stageTarget: {
      idx,
      shotIdx: shot.idx ?? idx + 1,
      shotType,
      camera,
      visualHash: hashString(visual || ''),
      hasCharacterContext: !!charContext,
    },
  });

  return {
    patch: { type: 'shot_prompt', idx, imagePrompt: cleaned },
    extra: { tokens: Math.ceil(cleaned.length / 2), shotIdx: idx, imagePrompt: cleaned },
  };
});

/* ============================================================
   3. storyboard_images executor —— 给一个分镜 group 生成手稿风分镜图
   ============================================================ */
registerExecutor('storyboard_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const shots = (proj as any).shots || [];
  const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: ctx.target.shotIndices,
  });
  assertArtifactUsable(proj as any, ctx, 'storyboard_image_generation', { groupIdx, shotIndices });

  const groupShots = shotIndices.map((i) => shots[i]);

  ctx.progress({ stage: 'building_prompt' });

  if (isMultiRefVideoModeEnabled()) {
    // P0: 用结构化的 FrameImageGenerationPlan 统一组织首帧输入。
    //   - prompt / 参考图清单 / 资产锁 / 模型能力快照都通过 plan 产出;
    //   - P3a: multiRefImageCap 从 provider capabilities.image.multiRefImage 读;
    //     env IMAGE_MULTI_REF_CAP 可覆盖默认值; OpenAI image edit 默认按官方 16 张能力建模。
    const imgCfg = resolveLLMConfig(ctx.user, 'image');
    const capMulti = Math.max(1, Math.floor(imgCfg.capabilities?.image?.multiRefImage ?? 1));
    const generationState: { finalPlan: FrameImageGenerationPlan | null } = { finalPlan: null };
    let appliedEditDraft = false;
    let appliedDraftForFingerprint: any = null;
    let committedBasePrompt = '';
    let generationShotIndices = shotIndices;
    let firstFrameSourceHashForInput = computeFirstFrameSourceHashForShotIndices(proj, shotIndices);
    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
      if (!fresh) return null;
      const promptState = reconcileFirstFramePromptStateInPatch({
        project: fresh,
        user: ctx.user,
        groupIdx,
        explicitShotIndices: shotIndices,
      });
      const { draft } = currentFirstFrameEditDraft(fresh, groupIdx);
      let nextPlan = {
        ...promptState.plan,
        finalPrompt: promptState.firstFrameBasePrompt.content,
      };
      let slotPatch: Record<string, any> = { ...(promptState.slotPatch || {}) };
      if (ctx.options?.applyEditDraft === true && draft) {
        try {
          validateAndNormalizeFirstFrameDraft({
            project: fresh,
            groupIdx,
            userId: ctx.user.id,
            input: draft,
            plan: promptState.plan,
          });
        } catch (err) {
          if (err instanceof FirstFrameDraftValidationException) {
            throw new Error(err.errors.map((item) => item.message).join('; ') || '首帧草稿校验失败');
          }
          throw err;
        }
        nextPlan = applyFirstFrameDraftToPlan({
          project: fresh,
          userId: ctx.user.id,
          plan: promptState.plan,
          draft,
        });
        appliedEditDraft = true;
        appliedDraftForFingerprint = draft;
        slotPatch = {
          ...slotPatch,
          firstFrameBasePrompt: {
            content: nextPlan.finalPrompt,
            sourceHash: promptState.sourceHash,
            updatedAt: nowIso(),
            updatedBy: ctx.user.id,
            origin: 'draft_commit',
          },
          firstFrameEditDraft: undefined,
        };
      }
      generationState.finalPlan = nextPlan;
      committedBasePrompt = nextPlan.finalPrompt;
      generationShotIndices = promptState.shotIndices;
      firstFrameSourceHashForInput = computeFirstFrameSourceHashForShotIndices(fresh, promptState.shotIndices);
      if (!Object.keys(slotPatch).length) return {};
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      const nextSlot = { ...prev, ...slotPatch };
      if (slotPatch.firstFrameEditDraft === undefined) delete nextSlot.firstFrameEditDraft;
      storyboards[groupIdx] = nextSlot;
      return { storyboards };
    });
    const finalPlan = generationState.finalPlan;
    if (!finalPlan) throw new Error('首帧生成计划初始化失败');
    const basePrompt = finalPlan.finalPrompt;
    const imageRefs = finalPlan.referenceManifest.filter((r) => r.delivery === 'image');
    const referenceImagePaths = imageRefs
      .map((r) => r.localPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    const referenceImagePath = referenceImagePaths[0];
    const frameImageSize = frameImageSizeForAspectRatio(proj);
    const imageQuality = resolveFrameImageQualityForCall(imgCfg.imageQuality, {
      frameType: 'first_frame',
      projectId: ctx.projectId,
      groupIdx,
    });
    const imageStyle = 'photographic' as const;
    const planSummary = {
      ...summarizePlanForAudit(finalPlan),
      appliedEditDraft,
      actualImageInput: {
        quality: imageQuality,
        size: frameImageSize,
        style: imageStyle,
        referenceImageCount: referenceImagePaths.length,
        draftFingerprint: firstFrameDraftFingerprint(appliedDraftForFingerprint),
      },
    };

    ctx.progress({
      stage: 'calling_image_api',
      shotCount: groupShots.length,
      mode: 'first_frame',
      hint: '调用图像 API 生成彩色视频首帧…',
    });
	    const frameGeneration = await generateFrameImageWithConsistencyCheck({
	      ctx,
	      plan: finalPlan,
	      prompt: basePrompt,
	      progressMode: 'first_frame',
	      groupIdx,
	      imageInput: {
	      size: frameImageSize,
	      style: imageStyle,
	      kind: 'storyboard',
	      projectId: ctx.projectId,
	      assetRef: `storyboards[${groupIdx}].firstFrame`,
	      quality: imageQuality,
	      referenceImagePath,
	      referenceImagePaths,
	      },
	    });
	    const { result, consistencyCheck, consistencyAttempts } = frameGeneration;
	    (planSummary as any).consistencyCheck = consistencyCheck;
	    (planSummary as any).consistencyAttempts = consistencyAttempts;
	    (planSummary as any).consistencyStatus = consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade;

    // P1: storyboards[g].frames.first 作为新的结构化对外容器, 与旧的 firstFrameUrl /
    // firstFramePrompt / firstFrameMode / firstFrameSafetyAudit / firstFramePlanSummary
    // 并行输出, 方便 P2 尾帧以同一形状落到 frames.tail。旧字段保留做兼容。
    const generatedAt = nowIso();
    const firstFrameSourceHash = firstFrameSourceHashForInput;
    const frameFirst = {
      url: result.url,
      prompt: result.submittedPrompt,
      originalPrompt: basePrompt,
      mode: 'structured_v1' as const,
      status: 'ready' as const,
      planSummary,
	      safetyAudit: result.safetyAudit,
	      visualAnchorDescription: result.visualAnchorDescription,
	      consistencyCheck,
	      consistencyAttempts,
	      consistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	      generatedAt,
      shotIndices: generationShotIndices,
      sourceHash: firstFrameSourceHash,
    };

    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
      if (!fresh) return null;
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
      if (groupIdx >= shots.length) return null;
      const prev = storyboards[groupIdx] || {};
      const freshShotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
        mode: 'single-shot-strict',
        explicitShotIndices: generationShotIndices,
      });
      const firstShotForWrite = shots[freshShotIndices[0]];
      const firstFramePlanSummaryForWrite = {
        ...planSummary,
        shotIndices: freshShotIndices,
      };
      const frameFirstForWrite = {
        ...frameFirst,
        planSummary: firstFramePlanSummaryForWrite,
        shotIndices: freshShotIndices,
      };
      const {
        videoUrl: _oldVideoUrl,
        videoTaskId: _oldVideoTaskId,
        videoDurationSec: _oldVideoDurationSec,
        videoCoverUrl: _oldVideoCoverUrl,
        videoStatus: _oldVideoStatus,
        videoMode: _oldVideoMode,
        videoTaskFinishedAt: _oldVideoTaskFinishedAt,
        ...prevWithoutVideo
      } = prev;
      const nextStoryboard = {
        ...prevWithoutVideo,
        url: result.url,
        imageUrl: result.url,
        rawUrl: result.url,
        firstFrameUrl: result.url,
        firstFrame: {
	          ...markFirstFrameReady(prev, result.url, result.url),
	          safetyAudit: result.safetyAudit,
	          visualAnchorDescription: result.visualAnchorDescription,
	          consistencyCheck,
	          consistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	        },
        firstFramePrompt: result.submittedPrompt,
        firstFrameMode: 'structured_v1',
        firstFrameSourceHash,
        firstFrameLastError: undefined,
        firstFrameFailedAt: undefined,
        debugSketchUrl: prev.debugSketchUrl || prev.pencilUrl,
        imagePrompt: result.submittedPrompt,
        originalFirstFramePrompt: committedBasePrompt,
	        firstFrameSafetyAudit: result.safetyAudit,
	        firstFrameConsistencyCheck: consistencyCheck,
	        firstFrameConsistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	        effectiveVisualDescription: result.visualAnchorDescription,
        idx: groupIdx,
        shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
        shotIndices: freshShotIndices,
        firstFramePlanSummary: firstFramePlanSummaryForWrite,
        frames: {
          ...(prev.frames || {}),
          first: {
            ...frameFirstForWrite,
            originalPrompt: committedBasePrompt,
          },
        },
      };
      storyboards[groupIdx] = nextStoryboard;
      // 用户原则: 首帧变了, 尾帧 / 已生成视频任务都保留, 用户自己决定要不要重做。
      // 不再自动 stale 尾帧, 也不再删除 videoTasks[groupIdx]。
      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'storyboard-image-writeback');
      // 首帧已按当前上游输入重新生成并写入新 sourceHash，权威数据侧同步清掉本组的
      // storyboard stale 标记。此前清除只存在于前端"亲历 task_completed"的回调里，
      // 页面刷新/重连窗口内完成的任务会留下孤儿标记，导致"确认分镜图"被残留标记误拦。
      const prevStaleFlags = (fresh as any)._staleFlags;
      if (prevStaleFlags && typeof prevStaleFlags === 'object' && prevStaleFlags[`storyboard_${groupIdx}`]) {
        const nextStaleFlags: Record<string, any> = { ...prevStaleFlags };
        delete nextStaleFlags[`storyboard_${groupIdx}`];
        return { storyboards, _staleFlags: nextStaleFlags };
      }
      return { storyboards };
    });

    recordBatchKnowledgeAudit({
      ctx,
      project: proj,
      stage: 'first_frame_image',
      provider: imgCfg.provider,
      stageTarget: {
        groupIdx,
        shotIndices,
        mode: 'structured_v1',
        referenceCount: finalPlan.referenceManifest.length,
        imageReferenceCount: imageRefs.length,
        planSummary,
      },
    });

    return {
      resultUrl: result.url,
      patch: {
        type: 'storyboard_image',
        idx: groupIdx,
        url: result.url,
        imageUrl: result.url,
        rawUrl: result.url,
        firstFrameUrl: result.url,
        firstFrameMode: 'structured_v1',
        firstFrameSourceHash,
        shotIndices,
        imagePrompt: result.submittedPrompt,
	        firstFrameSafetyAudit: result.safetyAudit,
	        firstFrameConsistencyCheck: consistencyCheck,
	        firstFrameConsistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	        firstFramePlanSummary: planSummary,
        frames: { first: frameFirst },
      },
      extra: {
        mode: result.mode,
        groupIdx,
        url: result.url,
        rawUrl: result.url,
        imageUrl: result.url,
        firstFrameUrl: result.url,
        firstFrameMode: 'structured_v1',
        firstFrameSourceHash,
        shotIndices,
        imagePrompt: result.submittedPrompt,
        originalImagePrompt: basePrompt,
        imageSafetyAudit: result.safetyAudit,
        firstFramePlanSummary: planSummary,
        frames: { first: frameFirst },
        invalidateVideo: true,
      },
    };
  }

  // 单组 prompt 长度上限（临时抬高，优先保留更多镜头信息，真实 provider 限制交给接口返回）
  const MAX_PROMPT_CHARS = 5000;
  // 把组内所有镜头压成精简描述：每段最多 350 字符
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const promptSections: string[] = groupShots.map((sh: any, i: number) => {
    const idx = shotIndices[i] + 1;
    const _shotType = sh.shotType || sh.framing || '';
    const _camera = sh.camera || sh.movement || '';
    const framePrompt = (sh.imagePrompt || '').trim();
    const _visual = sh.visual || sh.description || sh.desc || '';
    const body = framePrompt || _visual;
    const head = `Frame ${idx}` + (_shotType ? ` (${_shotType}${_camera ? ', ' + _camera : ''})` : '');
    return `${head}: ${truncate(body, 350)}`;
  });

  // 多镜头：让模型把它们画成一张多格分镜稿（panel grid）
  // 用户要求 layout 必须是 1×2（2 格）或 2×2（4 格），不要 3 格不规则布局。
  // 所以这里精确告诉模型 panel 数 + 排布方式，并放在 prompt 最前面让权重最高。
  const n = groupShots.length;
  let sheetIntro = '';
  if (n === 1) {
    sheetIntro = 'A SINGLE storyboard frame (NOT a multi-panel sheet) — one full image showing this single beat. ';
  } else if (n === 2) {
    sheetIntro = 'A TWO-PANEL storyboard sheet, layout = 1 row × 2 columns (left panel + right panel, evenly split, thin pencil-line border between panels). Panels are read LEFT to RIGHT in time order. ';
  } else if (n === 3) {
    // 上游分组算法已经基本不会输出 3，但万一冒出来 (用户手动 groupBoundary)，
    // 走 2x2 布局把第 4 格留空 / 收尾镜头，避免 1×3 难看。
    sheetIntro = 'A FOUR-PANEL storyboard sheet, layout = 2 rows × 2 columns (top-left, top-right, bottom-left, bottom-right, evenly sized, thin pencil-line borders between panels). Use the first 3 panels for the 3 shots in time order; the 4th (bottom-right) panel must be a recap close-up of the most important visual element from the previous 3 panels. ';
  } else if (n === 4) {
    sheetIntro = 'A FOUR-PANEL storyboard sheet, layout = 2 rows × 2 columns (top-left → top-right → bottom-left → bottom-right, evenly sized, thin pencil-line borders between panels). Panels are read in this Z-order in time. ';
  } else {
    sheetIntro = `A storyboard sheet with ${n} sequential panels showing different beats of the same scene. `;
  }
  let basePrompt = sheetIntro + promptSections.join(' | ');
  if (basePrompt.length > MAX_PROMPT_CHARS) {
    basePrompt = basePrompt.slice(0, MAX_PROMPT_CHARS) + '…';
  }
  // 在末尾再加一段硬性 layout 约束，避免模型自由发挥成 1×3 或 3×1
  if (n > 1) {
    basePrompt += '\n\n=== LAYOUT LOCK (must follow) ===\n';
    if (n === 2) {
      basePrompt += 'EXACTLY 2 panels, side by side (1 row × 2 columns). NEVER stack vertically. NEVER split into 3 panels. NEVER add a tiny inset panel.\n';
    } else if (n === 3 || n === 4) {
      basePrompt += 'EXACTLY 4 panels in a 2×2 grid (top row 2 panels, bottom row 2 panels, all four panels evenly sized). NEVER 1×3, NEVER 3×1, NEVER 1×4, NEVER irregular layout.\n';
    }
    basePrompt += 'All panels share ONE consistent pencil-sketch line style; same character look across panels (same person = same face/clothes everywhere).';
  }

  // 非人/拟人角色保险丝：扫描这一组所有镜头，如果文本里出现任何拟人化的非人角色，
  // 在 prompt 末尾追加一条强约束，避免 gpt-image 把蟹/虾/三文鱼默认画成真人。
  try {
    const projChars: any[] = ((proj as any).assets?.characters || []) as any[];
    const nonHumanSpeciesUsed = new Set<string>();
    for (const sh of groupShots) {
      const text = [
        sh.imagePrompt || '',
        sh.visual || sh.description || sh.desc || '',
        Array.isArray(sh.characters) ? sh.characters.join(' ') : '',
      ].join(' ');
      for (const c of projChars) {
        if (c?.entityType !== 'non-human') continue;
        const nm = c.name || c.role;
        if (!nm) continue;
        if (text.includes(nm)) {
          const appearance = String(c.appearance || c.description || '').slice(0, 120);
          nonHumanSpeciesUsed.add(`${nm} (${appearance || 'anthropomorphic creature, keep species body'})`);
        }
      }
    }
    if (nonHumanSpeciesUsed.size) {
      basePrompt +=
        '\n\n=== NON-HUMAN CHARACTER LOCK (must follow) ===\n' +
        'The following characters are anthropomorphic NON-HUMAN creatures and MUST be drawn with their actual species body (carapace / shell / fins / tentacles / pincers / etc.), NEVER as ordinary human workers in aprons:\n' +
        Array.from(nonHumanSpeciesUsed).map((s) => '- ' + s).join('\n') +
        '\nIf a panel shows a group of "employees / staff / union members" that includes any of the above, draw each one as its correct anthropomorphic species — DO NOT replace any of them with humans.' +
        // 体型约束：不能画成"巨型海鲜怪兽" / 与人类对比悬殊。
        // 用户反馈："海鲜个头太大了 不像正常海鲜那么大"——所以这里强制要求：
        //   · 拟人海鲜的总高度 ≈ 人类员工的肩膀高 - 头顶（即 0.6×~1.0× 人类身高）
        //   · 不能让蟹钳比人脸还大、蟹腿覆盖整个画面
        //   · 物种保留特征但比例服从"小员工"设定（拟人小怪 ≠ kaiju 巨兽）
        '\n\n=== NON-HUMAN CHARACTER SCALE LOCK (must follow) ===\n' +
        'These anthropomorphic seafood/animal characters are SMALL EMPLOYEE-SCALE creatures, NOT giant kaiju monsters:\n' +
        '- Total body height of each non-human character must be roughly the same as a real-world version of that species (a king crab ≈ 60-80cm tall standing on hind legs, a lobster ≈ 50-70cm, an oyster ≈ 20-30cm, a salmon ≈ 60-90cm), or at most up to a human worker\'s shoulder/chest height.\n' +
        '- They must NEVER tower over the human character — if a human boss is in the same frame, the human is the TALLEST figure.\n' +
        '- Pincers / claws / shells must be proportionate to the character\'s small size — a crab\'s pincer should NOT be bigger than a human face.\n' +
        '- They stand or pose at human-friendly scale (like small mascots / kitchen staff), NOT as monstrous giants.\n' +
        'If any non-human character ends up taller than a human character in the same frame, the image is REJECTED.';
    }
  } catch {}

  const storyboardImageSize = frameImageSizeForAspectRatio(proj);

  ctx.progress({
    stage: 'calling_image_api',
    shotCount: groupShots.length,
    hint: `调用图像 API 中（gpt-image-1 单张约 30-60 秒）…`,
  });
  const result = await generateImageWithModerationRecovery(ctx.user, {
    prompt: basePrompt,
    size: storyboardImageSize,
    style: 'pencil', // 手稿风格
    kind: 'storyboard',
    projectId: ctx.projectId,
    assetRef: `storyboards[${groupIdx}]`,
    // 多格分镜把面部 / 道具 / 透视都压在一张图里，low 画质会糊脸
    quality: 'medium',
  });

  // 写回 project.storyboards[groupIdx]：注意 imageUrl + url 都写，前端两边都会读
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
    if (groupIdx >= shots.length) return null;
    const prev = storyboards[groupIdx] || {};
    const freshShotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
      mode: 'single-shot-strict',
      explicitShotIndices: shotIndices,
    });
    const firstShotForWrite = shots[freshShotIndices[0]];
    const prevFirstFrame = normalizeFirstFrameState(prev);
    const at = new Date().toISOString();
    const frameFirst = buildFirstFrameRecord(prev, {
      url: result.url,
      prompt: result.submittedPrompt,
      originalPrompt: basePrompt,
      mode: 'legacy_pencil',
      status: 'legacy_sketch_only',
      source: 'generated',
      generatedAt: at,
      sourceHash: null,
      shotIndices: freshShotIndices,
      safetyAudit: result.safetyAudit,
      visualAnchorDescription: result.visualAnchorDescription,
    });
    storyboards[groupIdx] = {
      ...prev,
      url: result.url,
      imageUrl: result.url,
      rawUrl: result.url,
      pencilUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrame: {
        currentUrl: result.url,
        rawUrl: result.url,
        status: 'legacy_sketch_only',
        source: 'generated',
        lastKnownGoodUrl: result.url,
        lastError: undefined,
        history: [
          { url: result.url, at, source: 'generated' as const },
          ...prevFirstFrame.history.filter((item) => item.url !== result.url),
        ].slice(0, 20),
        safetyAudit: result.safetyAudit,
        visualAnchorDescription: result.visualAnchorDescription,
      },
      imagePrompt: result.submittedPrompt,
      originalImagePrompt: basePrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
      firstFrameLastError: undefined,
      firstFrameFailedAt: undefined,
      idx: groupIdx,
      shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
      shotIndices: freshShotIndices,
      frames: {
        ...(prev.frames || {}),
        first: frameFirst,
      },
    };
    // 用户原则: 首帧变化 (含 legacy_pencil 路径) 不再连带删除 videoTasks[groupIdx],
    // 由用户自己决定要不要重做视频。
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards }, 'legacy-storyboard-image-writeback');
    return { storyboards };
  });

  recordBatchKnowledgeAudit({
    ctx,
    project: proj,
    stage: 'first_frame_image',
    stageTarget: {
      groupIdx,
      shotIndices,
      mode: 'legacy_pencil',
      shotCount: groupShots.length,
      promptHash: hashString(basePrompt),
    },
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'storyboard_image',
      idx: groupIdx,
      url: result.url,
      pencilUrl: result.url,
      imageUrl: result.url,
      rawUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrameStatus: 'legacy_sketch_only',
    },
    extra: {
      mode: result.mode,
      groupIdx,
      url: result.url,
      rawUrl: result.url,
      imageUrl: result.url,
      firstFrameUrl: result.url,
      firstFrameMode: 'legacy_pencil',
      firstFrameStatus: 'legacy_sketch_only',
      imagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      invalidateVideo: true,
    },
  };
});

/* ============================================================
   3.5 tail_frame_images executor —— 给每个分镜组生成彩色视频尾帧
   ============================================================ */
registerExecutor('tail_frame_images', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const shots = (proj as any).shots || [];

  // Preflight: 只有脚本/镜头计划判定尾帧依赖首帧时, 才要求彩色首帧作为连续性锚点。
  const storyboards = (proj as any).storyboards || [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: ctx.target.shotIndices,
  });
  const groupShots = shotIndices.map((i) => shots[i]).filter(Boolean);
  const tailFrameDependency = inferTailFrameDependencyForShots(groupShots, sb);
  assertArtifactUsable(proj as any, ctx, 'storyboard_image', { groupIdx, shotIndices, batchType: 'tail_frame_images' });
  const preflightErr = checkTailFramePreflight(sb, { dependency: tailFrameDependency });
  if (preflightErr) {
    throw new Error(formatTailFramePreflightError(groupIdx, preflightErr));
  }
  const firstFrameUrl: string =
    sb.firstFrameUrl || sb.frames?.first?.url || sb.firstFrame?.currentUrl;

  // 依赖首帧时, 首帧图必须能解析为本地文件; 独立尾帧不提交首帧参考图。
  const selfFirstFrameLocal = tailFrameDependency === 'requires_first_frame'
    ? (resolveLocalImagePath(firstFrameUrl, ctx.user.id) || undefined)
    : undefined;
  if (tailFrameDependency === 'requires_first_frame' && !selfFirstFrameLocal) {
    throw errorWithRecoveryHint(
      '首帧图片文件不可解析，无法生成尾帧。',
      'first_frame_file_unresolvable',
      '请重新生成首帧，或点击“上传”重新上传一张首帧图后，再生成尾帧。',
    );
  }

  ctx.progress({ stage: 'building_prompt' });

  const imgCfg = resolveLLMConfig(ctx.user, 'image');
  const generationState: { finalPlan: FrameImageGenerationPlan | null } = { finalPlan: null };
  let appliedEditDraft = false;
  let appliedDraftForFingerprint: any = null;
  let committedTailFrameBasePromptContent = '';
  let generationShotIndices = shotIndices;
  let tailFrameSourceHashForInput: string | null = null;
  let previousTailFrameHistoryItem: ReturnType<typeof tailFrameHistoryItemFromCurrent> = null;
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const originalStoryboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    previousTailFrameHistoryItem = tailFrameHistoryItemFromCurrent(originalStoryboards[groupIdx] || {}, {
      at: nowIso(),
      source: 'current_before_tail_frame_regenerate',
    });
    const promptState = reconcileTailFramePromptStateInPatch({
      project: fresh,
      user: ctx.user,
      groupIdx,
      explicitShotIndices: shotIndices,
    });
    if (!promptState.plan || !promptState.tailFrameBasePrompt?.content) {
      const code = promptState.preflight.code || 'tail_frame_prompt_unready';
      throw errorWithRecoveryHint(
        promptState.preflight.message || '尾帧提示词状态未就绪，无法生成尾帧。',
        code,
        code === 'first_frame_file_unresolvable'
          ? '请重新生成首帧，或点击“上传”重新上传一张首帧图后，再生成尾帧。'
          : '请先完成彩色视频首帧，再生成尾帧。',
      );
    }
    let nextPlan = {
      ...promptState.plan,
      finalPrompt: promptState.tailFrameBasePrompt.content,
    };
    let slotPatch: Record<string, any> = { ...(promptState.slotPatch || {}) };
    const { draft } = currentTailFrameEditDraft(fresh, groupIdx);
    if (ctx.options?.applyEditDraft === true && draft) {
      let normalizedDraft: ReturnType<typeof validateAndNormalizeTailFrameDraft>;
      try {
        normalizedDraft = validateAndNormalizeTailFrameDraft({
          input: draft,
          sourceHash: promptState.sourceHash,
          userId: ctx.user.id,
        });
      } catch (err) {
        if (err instanceof TailFrameDraftValidationException) {
          throw new Error(err.errors.map((item) => item.message).join('; ') || '尾帧草稿校验失败');
        }
        throw err;
      }
      if (!normalizedDraft.content) {
        throw new Error('尾帧草稿为空，无法提交生成');
      }
      nextPlan = {
        ...promptState.plan,
        finalPrompt: normalizedDraft.content,
      };
      appliedEditDraft = true;
      appliedDraftForFingerprint = normalizedDraft;
      slotPatch = {
        ...slotPatch,
        tailFrameBasePrompt: {
          content: nextPlan.finalPrompt,
          sourceHash: promptState.sourceHash,
          updatedAt: nowIso(),
          updatedBy: ctx.user.id,
          origin: 'draft_commit',
        },
        tailFrameEditDraft: undefined,
      };
    }
    generationState.finalPlan = nextPlan;
    committedTailFrameBasePromptContent = nextPlan.finalPrompt;
    generationShotIndices = promptState.shotIndices;
    tailFrameSourceHashForInput = promptState.sourceHash;
    if (!Object.keys(slotPatch).length) return {};
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    while (storyboards.length <= groupIdx) storyboards.push({});
    const prev = storyboards[groupIdx] || {};
    const nextSlot = { ...prev, ...slotPatch };
    if (slotPatch.tailFrameEditDraft === undefined) delete nextSlot.tailFrameEditDraft;
    storyboards[groupIdx] = nextSlot;
    return { storyboards };
  });
  const plan = generationState.finalPlan;
  if (!plan) throw new Error('尾帧生成计划初始化失败');
  const tailFrameBasePromptContent = committedTailFrameBasePromptContent || plan.finalPrompt;
  const imageRefs = plan.referenceManifest.filter((r) => r.delivery === 'image');
  const referenceImagePaths = imageRefs
    .map((r) => r.localPath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const referenceImagePath = referenceImagePaths[0];
  const frameImageSize = frameImageSizeForAspectRatio(proj);
  const imageQuality = resolveFrameImageQualityForCall(imgCfg.imageQuality, {
    frameType: 'tail_frame',
    projectId: ctx.projectId,
    groupIdx,
  });
  const imageStyle = 'photographic' as const;
  const planSummary = {
    ...summarizePlanForAudit(plan),
    appliedEditDraft,
    actualImageInput: {
      quality: imageQuality,
      size: frameImageSize,
      style: imageStyle,
      referenceImageCount: referenceImagePaths.length,
      draftFingerprint: tailFrameDraftFingerprint(appliedDraftForFingerprint),
    },
  };

  ctx.progress({
    stage: 'calling_image_api',
    shotCount: generationShotIndices.length,
    mode: 'tail_frame',
    hint: '调用图像 API 生成彩色视频尾帧…',
  });

	  const frameGeneration = await generateFrameImageWithConsistencyCheck({
	    ctx,
	    plan,
	    prompt: tailFrameBasePromptContent,
	    progressMode: 'tail_frame',
	    groupIdx,
	    imageInput: {
	    size: frameImageSize,
	    style: imageStyle,
	    kind: 'storyboard',
	    projectId: ctx.projectId,
	    assetRef: `storyboards[${groupIdx}].tailFrame`,
	    quality: imageQuality,
	    referenceImagePath,
	    referenceImagePaths,
	    },
	  });
	  const { result, consistencyCheck, consistencyAttempts } = frameGeneration;
	  (planSummary as any).consistencyCheck = consistencyCheck;
	  (planSummary as any).consistencyAttempts = consistencyAttempts;
	  (planSummary as any).consistencyStatus = consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade;

  const generatedAt = nowIso();
  const tailFrameSourceHash = tailFrameSourceHashForInput;
  const frameTail = {
    url: result.url,
    prompt: result.submittedPrompt,
    originalPrompt: tailFrameBasePromptContent,
    mode: 'structured_v1' as const,
    status: 'ready' as const,
	    planSummary,
	    safetyAudit: result.safetyAudit,
	    visualAnchorDescription: result.visualAnchorDescription,
	    consistencyCheck,
	    consistencyAttempts,
	    consistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	    generatedAt,
    shotIndices: generationShotIndices,
    sourceHash: tailFrameSourceHash,
    referenceStatus: 'ready' as const,
  };

  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const sbs = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    while (sbs.length <= groupIdx) sbs.push({});
    const prev = sbs[groupIdx] || {};
    const freshShots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
    const freshShotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
      mode: 'single-shot-strict',
      explicitShotIndices: generationShotIndices,
    });
    const firstShotForWrite = freshShots[freshShotIndices[0]];
    const tailFramePlanSummaryForWrite = {
      ...planSummary,
      shotIndices: freshShotIndices,
    };
    const frameTailForWrite = {
      ...frameTail,
      planSummary: tailFramePlanSummaryForWrite,
      shotIndices: freshShotIndices,
    };
    sbs[groupIdx] = {
      ...prev,
      idx: groupIdx,
      shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
      shotIndices: freshShotIndices,
      tailFrameHistory: nextTailFrameHistory(prev.tailFrameHistory, previousTailFrameHistoryItem, {
        excludeUrls: [result.url],
      }),
      tailFrameUrl: result.url,
      tailFramePrompt: result.submittedPrompt,
      originalTailFramePrompt: tailFrameBasePromptContent,
      tailFrameMode: 'structured_v1',
	      tailFrameSafetyAudit: result.safetyAudit,
	      tailFrameConsistencyCheck: consistencyCheck,
	      tailFrameConsistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
		      tailFramePlanSummary: tailFramePlanSummaryForWrite,
      tailFrameLastError: undefined,
      tailFrameFailedAt: undefined,
      tailFrameIntent: 'requested',
      tailFrameIntentUpdatedAt: generatedAt,
      tailFrameSourceHash,
      tailFrameReferenceStatus: 'ready',
      frames: { ...(prev.frames || {}), tail: frameTailForWrite },
    };
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards: sbs }, 'tail-frame-image-writeback');
    // 与首帧写盘点同理：尾帧已按当前输入重新生成并写入新 sourceHash，
    // 权威数据侧同步清掉本组的 tail_frame stale 标记，避免孤儿标记。
    const prevStaleFlags = (fresh as any)._staleFlags;
    if (prevStaleFlags && typeof prevStaleFlags === 'object' && prevStaleFlags[`tail_frame_${groupIdx}`]) {
      const nextStaleFlags: Record<string, any> = { ...prevStaleFlags };
      delete nextStaleFlags[`tail_frame_${groupIdx}`];
      return { storyboards: sbs, _staleFlags: nextStaleFlags };
    }
    return { storyboards: sbs };
  });

  recordBatchKnowledgeAudit({
    ctx,
    project: proj,
    stage: 'tail_frame_image',
    provider: imgCfg.provider,
    stageTarget: {
      groupIdx,
      shotIndices: generationShotIndices,
      mode: 'structured_v1',
      referenceCount: plan.referenceManifest.length,
      imageReferenceCount: imageRefs.length,
      hasSelfFirstFrame: plan.referenceManifest.some((ref) => ref.role === 'self_first_frame' && ref.delivery === 'image'),
      planSummary,
    },
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'tail_frame_image',
      idx: groupIdx,
      url: result.url,
      tailFrameUrl: result.url,
      tailFrameMode: 'structured_v1',
      shotIndices: generationShotIndices,
      tailFramePrompt: result.submittedPrompt,
	      tailFrameSafetyAudit: result.safetyAudit,
	      tailFrameConsistencyCheck: consistencyCheck,
	      tailFrameConsistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	      tailFramePlanSummary: planSummary,
      tailFrameIntent: 'requested',
      tailFrameIntentUpdatedAt: generatedAt,
      tailFrameSourceHash,
      tailFrameReferenceStatus: 'ready',
      frames: { tail: frameTail },
    },
    extra: {
      mode: result.mode,
      groupIdx,
      url: result.url,
      tailFrameUrl: result.url,
      tailFrameMode: 'structured_v1',
      shotIndices: generationShotIndices,
      tailFramePrompt: result.submittedPrompt,
      originalTailFramePrompt: tailFrameBasePromptContent,
	      tailFrameSafetyAudit: result.safetyAudit,
	      tailFrameConsistencyCheck: consistencyCheck,
	      tailFrameConsistencyStatus: consistencyCheck.grade === 'fail' ? 'needs_review' : consistencyCheck.grade,
	      tailFramePlanSummary: planSummary,
      tailFrameIntent: 'requested',
      tailFrameIntentUpdatedAt: generatedAt,
      tailFrameSourceHash,
      tailFrameReferenceStatus: 'ready',
      frames: { tail: frameTail },
    },
  };
});

/* ============================================================
   4. video_segments executor —— 给每个分镜组生成视频片段
   ============================================================ */
registerExecutor('video_segments', async (ctx: BatchExecCtx) => {
  let proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? ctx.seq;
  let storyboards = (proj as any).storyboards || [];
  let sb = storyboards[groupIdx];
  if (!sb) throw new Error(`找不到 storyboards[${groupIdx}]`);
  if (sb.videoPromptEditDraft && typeof sb.videoPromptEditDraft.content === 'string') {
    const commitResult = commitVideoPromptDraftForSegment({
      project: proj as any,
      projectId: ctx.projectId,
      userId: ctx.user.id,
      groupIdx,
      explicitShotIndices: ctx.target.shotIndices,
    });
    if (commitResult.committed) {
      proj = commitResult.project || getProjectByIdForUser(ctx.projectId, ctx.user.id);
      if (!proj) throw new Error('项目不存在');
      storyboards = (proj as any).storyboards || [];
      sb = storyboards[groupIdx];
      if (!sb) throw new Error(`找不到 storyboards[${groupIdx}]`);
    }
  }
  const segmentDecision = assertArtifactUsable(proj as any, ctx, 'video_segment', { groupIdx, shotIndices: ctx.target.shotIndices });
  const segmentGate = consistencyFromDecision(segmentDecision);
	  const promptReadiness = assertVideoPromptReadyForGroups(proj as any, [groupIdx], 'videoSegment', { skipConsistency: true });
	  if (!promptReadiness.ok) {
	    const blocked = promptReadiness.blocked[0];
	    throw errorWithFailureStage(
	      `片段 ${groupIdx + 1} 视频提示词未就绪（${blocked?.reason || 'not_ready'}），` +
	        `已阻止视频生成。请先重新生成并确认该片段的视频提示词。`,
	      'preflight_video_prompt_not_ready',
	    );
	  }

  // 提示词来源优先：sb.videoPrompt（视频提示词页生成的）→ shot.imagePrompt → shot.visual
  const shots = (proj as any).shots || [];
  // 段首镜头作为代表镜头/视觉兜底；合并段 shots[groupIdx] 不是本段镜头，按 sb.shotIndices[0] 取段首。1:1 等价。
  const _firstShotIdxForSeg = Array.isArray(sb?.shotIndices) && sb.shotIndices.length ? Number(sb.shotIndices[0]) : groupIdx;
  const shot = shots[_firstShotIdxForSeg] || {};
  const _shotVisual = shot.visual || shot.description || shot.desc || '';
  let videoPromptSource: VideoGenerationPlan['promptAudit']['sourcePrompt']['source'] = sb.videoPrompt
    ? 'storyboard.videoPrompt'
    : (sb.firstFramePrompt || sb.imagePrompt || shot.imagePrompt)
      ? 'shot.imagePrompt'
      : 'shot.visual';
  let prompt =
    sb.videoPrompt ||
    sb.firstFramePrompt ||
    sb.imagePrompt ||
    shot.imagePrompt ||
    _shotVisual ||
    `Video segment for shot ${groupIdx + 1}`;

  const groupShotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: ctx.target.shotIndices,
  });
  // P4#5：合并段（一段含多镜头）恒走参考模式、无尾锚点。显式短路尾帧/结尾约束，
  // 不再依赖"恰好没生成尾帧"的间接规避，防 slot 残留或手动尾帧泄漏出结尾约束。
  // length>1 只在 flag ON 时才可能出现（合并 slot 仅 flag ON 建），故无需再查 flag。
  const isMergedSegment = Array.isArray(groupShotIndices) && groupShotIndices.length > 1;
	  if (!sb.videoPrompt) {
	    const firstGroupShot = shots[groupShotIndices[0]] || shot || {};
	    const firstGroupVisual = firstGroupShot.visual || firstGroupShot.description || firstGroupShot.desc || '';
	    videoPromptSource = (sb.firstFramePrompt || sb.imagePrompt || firstGroupShot.videoPrompt || firstGroupShot.imagePrompt)
	      ? 'shot.imagePrompt'
	      : 'shot.visual';
	    prompt =
      sb.firstFramePrompt ||
      sb.imagePrompt ||
      firstGroupShot.videoPrompt ||
      firstGroupShot.imagePrompt ||
	      firstGroupVisual ||
	      prompt;
	  }
	  const sanitizedFor: string[] = [];

	  const plannedDurationSec = plannedDurationForSegment(shots, groupShotIndices);
	  let shotPlan = buildSegmentShotPlan(shots, groupShotIndices);
	  const videoCfg = resolveLLMConfig(ctx.user, 'video');
  const videoCfgIsGrok = /^grok-video/i.test(videoCfg.model || '');
  const videoCfgIsVolcano =
    /volces\.com|volcengine|ark\.cn-/i.test(videoCfg.baseUrl || '') ||
    /seedance|doubao/i.test(videoCfg.model || '');

  // durationSec 是给视频模型的请求时长：源头来自镜头表计划时长，只做模型固定时长/
  // 供应商最小时长适配，不再按台词字数压到 5s / 10s 档位。
  // 后续 tempoBudget.safeDurationSec 只影响生成请求，不进入剪辑时间线。
	  let durationSec = resolveGenerationDurationSec({
	    plannedDurationSec,
	    model: videoCfg.model,
	    baseUrl: videoCfg.baseUrl,
	    minDurationSec: videoCfg.minDurationSec,
	  });

	  // 收集本组所有 shot 的台词（dialogue / scriptRef），强制传给视频模型。
	  // 共享解析器只拆 speaker/text，不截断、不改写台词。
	  const dialoguePairs = collectSegmentDialoguePairs(shots, groupShotIndices);
	  const dialogueCharSum = cleanDialogueCharCount(dialoguePairs);
	  const videoWarnings: any[] = [];

  // 前端 batchOpts.ratio：'16:9' / '9:16' / '1:1' / '21:9' / '4:3' / '3:4'
  const userRatio = resolveVideoAspectRatio(proj, (ctx.options as any)?.ratio);
  const videoResolution = normalizeSeedanceResolution((ctx.options as any)?.resolution || (ctx.options as any)?.quality);
  const generateAudio = normalizeGenerateAudio((ctx.options as any)?.generateAudio ?? (ctx.options as any)?.genAudio, true);

  // 用户反馈："前面有场景彩色图和人物角色彩色图，不能单一参考分镜图"
  // —— 之前只把黑白分镜草图当 i2v 主参考，前面"资产"步骤生成的彩色场景图和
  // 角色三视图全没传过来，等于让视频模型基于黑白调凭空想象彩色画面。
  //
  // 这里把整条工作流串起来：
  //   1) 分镜草图 (storyboardPath)：给镜头构图/景别参考
  //   2) **彩色场景图 (sceneReferencePath)**：定环境、色调、光照、材质
  //   3) **彩色角色图 (characterReferencePaths[])**：定角色外形、服装、物种
  // video-gen 会把三者合成成一张"视觉圣经参考图"再送 Seedance。

  // ① 视频主参考图本地路径
  // 新模式：firstFrameUrl 是彩色视频首帧，作为 i2v 主参考。
  // 旧模式/旧项目：继续使用原 storyboard 黑白草图，保证可回退。
  const resolvedFirstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
  const hasFirstFrame = !!resolvedFirstFrameUrl;
  const multiRefMode = isMultiRefVideoModeEnabled();
  const configuredVideoSubmitMode = getVideoSubmitMode();
  const requestedVideoSubmitMode = normalizeVideoSubmitMode((ctx.options as any)?.submitMode, configuredVideoSubmitMode);
  const independentMultiImageCapable = multiRefMode && isIndependentMultiImageModeEnabled();
  let independentMultiImageMode = false;
  const adminAllowsFirstLast = isFirstLastFrameVideoModeEnabled();
  warnIfFirstLastConfigIgnored({ configuredSubmitMode: configuredVideoSubmitMode, adminAllowsFirstLast });
  const firstLastFrameVideoEnabled = computeFirstLastFeatureEnabled({
    submitMode: requestedVideoSubmitMode,
    configuredSubmitMode: configuredVideoSubmitMode,
    adminAllowsFirstLast,
  });
  const rawTargetEndStrategy = resolveTargetEndStrategy(videoCfg);
  const targetEndStrategy =
    isMergedSegment
      ? 'unsupported'
      : rawTargetEndStrategy === 'caption' && !isTailFrameCaptionFallbackEnabled()
      ? 'unsupported'
      : rawTargetEndStrategy;
  console.log(
    `[video_segments] group ${groupIdx} flags: ` +
      `multiRef=${multiRefMode} independentMultiImageCapable=${independentMultiImageCapable} ` +
      `hasFirstFrame=${hasFirstFrame} submitMode=${requestedVideoSubmitMode} ` +
      `envIndependent=${String(process.env.ORIGIN_INDEPENDENT_MULTI_IMAGE_MODE || '') || 'default'}`,
  );
  let referenceImagePath: string | undefined;
  const sbImageUrl: string = hasFirstFrame
    ? resolvedFirstFrameUrl
    : (sb.rawUrl || sb.url || sb.imageUrl || '');
  const sbMatch = /\/api\/images\/file\/([0-9a-f-]{36})/.exec(sbImageUrl);
  if (sbMatch) {
    referenceImagePath = dataPath('images', String(ctx.user.id), `${sbMatch[1]}.png`);
  }
  const referenceImageRole: 'first_frame' | 'storyboard_sketch' = multiRefMode && hasFirstFrame ? 'first_frame' : 'storyboard_sketch';
  let storyboardReferencePath: string | undefined;
  if (referenceImageRole === 'first_frame') {
    const sketchUrl = sb.debugSketchUrl || sb.pencilUrl || '';
    const sketchMatch = /\/api\/images\/file\/([0-9a-f-]{36})/.exec(sketchUrl);
    if (sketchMatch) {
      storyboardReferencePath = dataPath('images', String(ctx.user.id), `${sketchMatch[1]}.png`);
    }
  }

  let sceneReferencePath: string | undefined;
  let sceneReferenceLabel = '';
  let sceneReferenceHint = '';

  const allChars: any[] = [
    ...((proj as any).assets?.characters || []),
    ...((proj as any).characters || []),
  ];
  const charNames = new Set<string>();
  for (const si of groupShotIndices) {
    const sh = shots[si];
    if (Array.isArray(sh?.characters)) {
      for (const cn of sh.characters) {
        if (typeof cn === 'string' && cn.trim()) charNames.add(cn.trim());
      }
    }
  }
  let characterReferencePaths: string[] = [];
  let characterReferencePanels: CharacterReferencePanel[] = [];
  let propReferencePaths: string[] = [];
  let targetEndUnsupportedReason: string | undefined;
  const tailFrameUrl = isMergedSegment ? '' : String(sb?.frames?.tail?.url || sb?.tailFrameUrl || '').trim();
  const tailFrameLocalPath = tailFrameUrl ? (resolveLocalImagePath(tailFrameUrl, ctx.user.id) || undefined) : undefined;
  const tailCaption = sb?.frames?.tail?.caption;
  let targetEndCaption =
    targetEndStrategy === 'caption' && tailCaption && typeof tailCaption.text === 'string'
      ? String(tailCaption.text || '').trim()
      : undefined;
  let refreshedTailCaption: TailFrameCaption | null = null;
  if (tailFrameLocalPath && targetEndStrategy === 'caption') {
    try {
      const currentTailHash = hashImageFileContent(tailFrameLocalPath);
      const cachedHash = String(tailCaption?.imageContentHash || '');
      if (!targetEndCaption || cachedHash !== currentTailHash) {
        refreshedTailCaption = await captionTailFrameForVideo(ctx.user, tailFrameLocalPath, {
          ownerId: ctx.user.id,
          usernameSnapshot: ctx.user.phone || ctx.user.display_name || ctx.user.username || null,
          projectId: ctx.projectId,
          projectTitleSnapshot: (proj as any)?.title || null,
          routeName: 'batch.video_segments',
          moduleKey: 'video',
          moduleLabel: '视频生成',
          featureKey: 'tail_frame_caption',
          featureLabel: '尾帧 Caption',
          callItemType: 'batch_task',
          callItemId: ctx.taskId,
          callItemLabel: `片段 ${groupIdx + 1} 尾帧 Caption`,
          batchId: ctx.batchId,
          taskId: ctx.taskId,
          operationKey: `batch:${ctx.batchId}:task:${ctx.taskId}:tail-caption`,
          operationLabel: '尾帧 Caption',
          meta: {
            groupIdx,
            targetEndStrategy,
            tailFrameHash: currentTailHash,
          },
        });
        targetEndCaption = refreshedTailCaption.text;
      }
    } catch (captionErr: any) {
      targetEndCaption = undefined;
      targetEndUnsupportedReason = 'tail_frame_caption_failed';
      console.warn(
        `[video_segments] group ${groupIdx} target_end caption failed: ` +
          String(captionErr?.message || captionErr).slice(0, 300),
      );
    }
  }

  const referenceImages: VideoReferenceImage[] = [];
  let referenceImageBudget = VIDEO_REFERENCE_IMAGE_BUDGET;
  const addReferenceImage = (ref: VideoReferenceImage) => {
    if (!independentMultiImageMode || !ref.path) return;
    if (referenceImages.some((item) => item.path === ref.path)) return;
    if (referenceImages.length >= referenceImageBudget) return;
    referenceImages.push(ref);
  };

  const canonicalRefs = buildVideoReferenceManifest({
    project: proj,
    assets: (proj as any).assets || {},
    shots,
    groupShotIndices,
    groupIdx,
    ownerId: ctx.user.id,
    storyboardImageUrl: resolvedFirstFrameUrl || null,
  });
  referenceImageBudget = canonicalRefs.budget || VIDEO_REFERENCE_IMAGE_BUDGET;
  let manifestInImageOrder = [...canonicalRefs.manifest].sort((a, b) => a.imageNo - b.imageNo);
  const canonicalFirstFrame = manifestInImageOrder.find((ref) => ref.role === 'first_frame');
  if (refreshedTailCaption) {
    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
      if (!fresh) return null;
      const sbs = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      if (!sbs[groupIdx]) return null;
      const frames = { ...(sbs[groupIdx].frames || {}) };
      frames.tail = {
        ...(frames.tail || {}),
        caption: refreshedTailCaption,
      };
      sbs[groupIdx] = {
        ...sbs[groupIdx],
        frames,
      };
      return { storyboards: sbs };
    });
  }
  const persistedManifest = Array.isArray(sb.videoReferenceManifest) ? sb.videoReferenceManifest : [];
  const manifestChanged = persistedManifest.length > 0 && manifestsDiffer(persistedManifest, manifestInImageOrder);
  if (persistedManifest.length === 0 && canonicalRefs.manifest.length > 0) {
    videoWarnings.push({
      key: 'reference_manifest_rebuilt_in_executor',
      level: 'info',
      message: '该片段无视频提示词阶段持久化的参考图清单，已按当前项目资产重建 canonical manifest。',
    });
  }
  if (manifestChanged) {
    console.warn(`[video_segments] group ${groupIdx} reference manifest changed between video prompt and video generation`);
    videoWarnings.push({
      key: 'manifest_changed_between_prompt_and_video',
      level: 'warn',
      message: '视频提示词阶段看到的参考图清单与本次视频生成实际参考图不同，已使用最新首帧/资产重新生成 canonical manifest。',
    });
  }

  const firstFrameItem = manifestInImageOrder.find((ref) => ref.role === 'first_frame' && ref.localPath);
  if (firstFrameItem?.localPath) referenceImagePath = firstFrameItem.localPath;
  const videoCapability = resolveVideoModelCapability(videoCfg.model);
  const payloadDecision: VideoPayloadDecision = resolveVideoPayloadDecision({
    submitMode: requestedVideoSubmitMode,
    firstLastFeatureEnabled: firstLastFrameVideoEnabled,
    tailIntentRequested: sb?.tailFrameIntent === 'requested',
    capabilityFirstLastSupported: videoCapability.firstLastFrameMode === 'supported',
    firstFramePath: referenceImagePath,
    tailFramePath: tailFrameLocalPath,
    tailFrameUrl,
    tailReferenceStatus: String(sb?.tailFrameReferenceStatus || '').toLowerCase(),
    independentMultiImageCapable,
    multiShotSegment: groupShotIndices.length > 1,
  });
  if (payloadDecision.hardFail) {
    throw errorWithFailureStage(
      payloadDecision.failureMessage || '视频生成前置条件不满足。',
      payloadDecision.failureCode === 'preflight_missing_first_frame'
        ? 'preflight_missing_first_frame'
        : 'preflight_video_prompt_not_ready',
    );
  }
  const firstLastFrameMode = payloadDecision.firstLastFrameMode;
  const payloadModeDecision = payloadDecision.payloadMode;
  const payloadModeReason = payloadDecision.reason;
  const submitInputMode = deriveVideoSubmitInputMode(payloadDecision);
  independentMultiImageMode = submitInputMode.useIndependentReferenceImages;
  if (payloadDecision.warning) videoWarnings.push(payloadDecision.warning);
  if (independentMultiImageMode && !canonicalFirstFrame?.localPath) {
    throw errorWithFailureStage(
      `片段 ${groupIdx + 1} 首帧参考图缺失或无法解析为本地文件，已阻止视频生成。` +
        `请先重新生成该片段首帧，再生成视频。`,
      'preflight_missing_first_frame',
    );
  }
  if (tailFrameUrl && targetEndStrategy === 'image' && !independentMultiImageMode) {
    targetEndUnsupportedReason = 'independent_multi_image_mode_disabled';
  } else if (tailFrameUrl && targetEndStrategy === 'image' && !tailFrameLocalPath) {
    targetEndUnsupportedReason = 'tail_frame_file_unresolvable';
  } else if (tailFrameUrl && targetEndStrategy === 'caption' && !tailFrameLocalPath) {
    targetEndUnsupportedReason = targetEndUnsupportedReason || 'tail_frame_file_unresolvable';
  } else if (tailFrameUrl && targetEndStrategy === 'caption' && !targetEndCaption) {
    targetEndUnsupportedReason = targetEndUnsupportedReason || 'tail_frame_caption_missing';
	  } else if (tailFrameUrl && targetEndStrategy === 'unsupported') {
	    targetEndUnsupportedReason = 'provider_target_end_unsupported';
	  }
	  const tempoBudget = computeSegmentTempoBudget({
	    dialoguePairs,
	    plannedDurationSec,
	    durationSec,
	    shotPlan,
	    payloadMode: payloadModeDecision,
	    payloadModeReason,
	    tailReferenceStatus: String(sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus || ''),
	  });
		  const requestedDurationSec = durationSec;
		  // safeDurationSec 是生成请求保护值；剪辑导入仍以真实 videoDurationSec / EDL 为准。
		  durationSec = tempoBudget.safeDurationSec;
	  shotPlan = buildEffectiveShotPlanForDuration(shotPlan, durationSec);
	  console.log(
	    `[video_segments] group ${groupIdx} 计划 ${plannedDurationSec}s，台词 ${dialogueCharSum} 字 → ` +
	      `请求 ${durationSec}s 视频（原始 ${requestedDurationSec}s，预算 ${tempoBudget.requiredRawSec}s，${dialoguePairs.length} 句台词）`,
	  );
		  const sceneItem = manifestInImageOrder.find((ref) => isPrimarySceneRef(ref) && ref.localPath);
  sceneReferencePath = sceneItem?.localPath || undefined;
  sceneReferenceLabel = sceneItem?.assetName || sceneItem?.label || sceneReferenceLabel;
  sceneReferenceHint = sceneItem?.promptHint || sceneReferenceHint;
  characterReferencePaths = manifestInImageOrder
    .filter((ref) => ref.role === 'character' && ref.localPath)
    .map((ref) => ref.localPath as string);
  characterReferencePanels = manifestInImageOrder
    .filter((ref) => ref.role === 'character' && ref.localPath && ref.panelInfo)
    .map((ref: any) => ({
      characterName: ref.assetName || ref.label,
      panel: ref.panelInfo.panel,
      path: ref.localPath,
      intent: ref.panelInfo.intent,
      priority: Number(ref.score || ref.priority || 0),
      reason: ref.matchReason || `manifest:${ref.panelInfo.panel}`,
    }));
  propReferencePaths = manifestInImageOrder
    .filter((ref) => ref.role === 'prop' && ref.localPath)
    .map((ref) => ref.localPath as string);

  referenceImages.length = 0;
  for (const ref of manifestInImageOrder) {
    if (!ref.localPath) continue;
    addReferenceImage({
	      role: ref.role,
	      viewRole: ref.viewRole,
	      path: ref.localPath,
      sourceUrl: ref.url,
      assetId: ref.assetId,
      assetName: ref.assetName,
      label: ref.label,
      promptHint: ref.promptHint,
      useFor: ref.useFor,
      immutable: ref.immutable,
      panelInfo: ref.panelInfo,
      referenceBrief: ref.referenceBrief || buildReferenceBriefLine(ref, manifestInImageOrder),
      priority: ref.priority || ref.score,
    });
  }

  // ===== 角色一致性主档（跨片段保持形象、表演和声音一致） =====
  const characterLockContextText = [
    prompt,
    ...groupShotIndices.map((si) => {
      const sh = shots[si] || {};
      return [
        sh.characters,
        sh.speaker,
        sh.visual,
        sh.description,
        sh.desc,
        sh.dialogue,
        sh.scriptRef,
        sh.keyInfo,
      ].flat().filter(Boolean).join(' ');
    }),
  ].join('\n');
  const characterLockRoster = buildCharacterLockRoster(proj as any, charNames, 'zh', characterLockContextText);
  const characterLockBlockHash = characterLockRoster ? hashString(characterLockRoster) : undefined;

  // ===== 前后片段衔接信息（避免镜头硬切 / 角色姿态突变） =====
  // 用户反馈："有些镜头前后连不上 因为每条是独立生成的"——这里把上一组终幅
  // 镜头的 visual 描述、本组首幅、下一组首幅都简短摘出来给模型，让 Seedance
  // 能"知道镜头衔接到哪里来 / 要去哪里"。
  const allSb: any[] = (proj as any).storyboards || [];
  const _summarizeShot = (sh: any): string => {
    if (!sh) return '';
    const st = sh.shotType ? `【${sh.shotType}】` : '';
    const cm = sh.camera ? `【${sh.camera}】` : '';
	    const v = String(sh.visual || sh.description || '').slice(0, 120);
    return `${st}${cm}${v}`.trim();
  };
  const _firstShotIdxOf = (gi: number): number | null => {
    const t = allSb[gi];
    if (!t) return null;
    if (Array.isArray(t.shotIndices) && t.shotIndices.length) return t.shotIndices[0];
    return gi; // 兜底
  };
  const _lastShotIdxOf = (gi: number): number | null => {
    const t = allSb[gi];
    if (!t) return null;
    if (Array.isArray(t.shotIndices) && t.shotIndices.length) {
      return t.shotIndices[t.shotIndices.length - 1];
    }
    return gi;
  };
  let prevTailSummary = '';
  let nextHeadSummary = '';
  if (groupIdx > 0) {
    const prevLastIdx = _lastShotIdxOf(groupIdx - 1);
    if (prevLastIdx != null) prevTailSummary = _summarizeShot(shots[prevLastIdx]);
  }
  if (groupIdx < allSb.length - 1) {
    const nextFirstIdx = _firstShotIdxOf(groupIdx + 1);
    if (nextFirstIdx != null) nextHeadSummary = _summarizeShot(shots[nextFirstIdx]);
  }
  console.log(
    `[video_segments] group ${groupIdx} refs: scene=${!!sceneReferencePath} ` +
      `panels=${characterReferencePanels.length} chars=${characterReferencePaths.length} sb=${!!referenceImagePath} ` +
      `props=${propReferencePaths.length} refRole=${referenceImageRole} ` +
      `independentRefs=${referenceImages.length} ` +
      `dialoguePairs=${dialoguePairs.length} prev=${!!prevTailSummary} next=${!!nextHeadSummary}`,
  );

	  const seedanceImageMode: VideoGenInput['seedanceImageMode'] = submitInputMode.seedanceImageMode;

	  const videoInput = {
	    prompt,
	    ratio: userRatio,
	    resolution: videoResolution,
		    generateAudio,
			    durationSec,
	        shotPlan,
	        tempoBudget,
			    projectId: ctx.projectId,
	    groupIdx,
    videoPromptSourceHash: String(sb?.videoPromptSourceHash || '') || null,
	    idempotencyKey: ctx.idempotencyKey,
    deferProviderPolling: videoCfgIsVolcano && shouldDeferSeedanceProviderPolling(),
    onProviderTaskCreated: (info: Parameters<NonNullable<VideoGenInput['onProviderTaskCreated']>>[0]) => {
      recordBatchTaskProviderSubmission({
        batchTaskId: ctx.taskId,
        provider: info.provider,
        providerTaskId: info.providerTaskId,
        idempotencyKey: info.idempotencyKey,
        localVideoTaskId: info.localVideoTaskId,
        transitionToUpstreamPending: info.deferProviderPolling,
      });
    },
	    dialoguePairs,
	    characterLockRoster: characterLockRoster || undefined,
    prevTailSummary: prevTailSummary || undefined,
    nextHeadSummary: nextHeadSummary || undefined,
    referenceImagePath,
    referenceImageRole,
    storyboardReferencePath,
    sceneReferencePath,
    characterReferencePaths,
    characterReferencePanels,
    propReferencePaths,
	    referenceImages: independentMultiImageMode ? referenceImages : undefined,
      seedanceImageMode,
    targetEndStrategy,
    targetEndCaption: targetEndCaption || undefined,
    targetEndUnsupportedReason,
    payloadModeReason,
    firstLastFrameMode,
  };
	  // planned prompt 必须与实际提交同 builder：first_last_frame 时真实提交走
	  // buildSeedanceFirstLastFramePromptParts（无 --ratio/--duration 尾缀、含
	  // 首尾帧约束块），用多参 builder 预览会造成 planned vs videoAudit hash 永不一致。
	  const plannedFinalPrompt = videoCfgIsVolcano
    ? (firstLastFrameMode
      ? buildSeedanceFirstLastFramePromptParts({
          ...videoInput,
          tailReserveSec: tempoBudget.endingReserveSec,
        }).finalPrompt
      : buildSeedancePromptParts({
          ...videoInput,
          tailReserveSec: tempoBudget.endingReserveSec,
        }).finalPrompt)
    : prompt;
  let videoPlan: VideoGenerationPlan = buildVideoPlanSnapshot({
    projectId: ctx.projectId,
    groupIdx,
    groupShotIndices,
    submitMode: requestedVideoSubmitMode,
	    payloadMode: payloadModeDecision,
	    modeReason: payloadModeReason,
	    tempoBudget,
	    videoPromptSource,
    sanitizedFor,
    finalPrompt: {
      preview: plannedFinalPrompt.slice(0, 500),
      hash: hashString(plannedFinalPrompt),
      length: plannedFinalPrompt.length,
    },
    dialoguePolicy: 'budget_check_only',
    references: planReferencesFromManifest(manifestInImageOrder),
    droppedReferences: [
      ...(Array.isArray(sb.videoReferenceDropped) ? sb.videoReferenceDropped : []),
      ...canonicalRefs.droppedReferences,
    ],
    prompt,
	    userRatio,
      resolution: videoResolution,
      generateAudio,
	    durationSec,
	    plannedDurationSec,
	    videoWarnings,
    dialogueChars: cleanDialogueCharCount(dialoguePairs),
    status: 'submitting',
    modelSnapshot: {
      modelRole: 'video',
      provider: videoCfg.provider || (videoCfgIsGrok ? 'grok' : videoCfgIsVolcano ? 'seedance' : videoCfg.mode),
      model: videoCfg.model,
      filledAfterCall: false,
	    },
	  });

	  if (tempoBudget.exceedsMaxDuration) {
	    const blockedWarnings = mergeVideoWarnings(videoWarnings, [buildTailRushedWarning(tempoBudget)]);
	    videoPlan = buildVideoPlanSnapshot({
	      projectId: ctx.projectId,
	      groupIdx,
	      groupShotIndices,
	      submitMode: requestedVideoSubmitMode,
	      payloadMode: payloadModeDecision,
	      modeReason: payloadModeReason,
	      tempoBudget,
	      videoPromptSource,
	      sanitizedFor,
	      finalPrompt: {
	        preview: plannedFinalPrompt.slice(0, 500),
	        hash: hashString(plannedFinalPrompt),
	        length: plannedFinalPrompt.length,
	      },
	      dialoguePolicy: 'budget_check_only',
	      references: planReferencesFromManifest(manifestInImageOrder),
	      droppedReferences: [
	        ...(Array.isArray(sb.videoReferenceDropped) ? sb.videoReferenceDropped : []),
	        ...canonicalRefs.droppedReferences,
	      ],
	      prompt,
	      userRatio,
	      resolution: videoResolution,
	      generateAudio,
	      durationSec,
	      plannedDurationSec,
	      videoWarnings: blockedWarnings,
	      dialogueChars: cleanDialogueCharCount(dialoguePairs),
	      status: 'failed',
	      failureStage: 'preflight_video_prompt_not_ready',
	      errorMsg: TAIL_RUSHED_WARNING_MESSAGE,
	      modelSnapshot: {
	        modelRole: 'video',
	        provider: videoCfg.provider || (videoCfgIsGrok ? 'grok' : videoCfgIsVolcano ? 'seedance' : videoCfg.mode),
	        model: videoCfg.model,
	        filledAfterCall: false,
	      },
	    });
	    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
	      if (!fresh) return null;
	      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
	      if (groupIdx >= shots.length) return null;
	      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	      const sb = storyboards[groupIdx] || {};
		      const freshShotIndices = storyboardShotIndices(fresh, groupIdx, sb, {
		        mode: 'single-shot-strict',
		        explicitShotIndices: groupShotIndices,
		      });
		      const firstShotForWrite = shots[freshShotIndices[0]];
		      videoTasks[groupIdx] = {
		        ...(videoTasks[groupIdx] || {}),
		        groupIdx,
		        shotIndices: freshShotIndices,
		        status: 'failed',
	        errorCode: 'video_duration_budget_blocked',
	        errorMsg: TAIL_RUSHED_WARNING_MESSAGE,
	        durationSec,
	        plannedDurationSec,
	        tempoBudget,
	        prompt,
	        warnings: blockedWarnings,
	        videoPlan,
	        isCurrent: false,
	      };
	      storyboards[groupIdx] = {
		        ...sb,
		        idx: groupIdx,
		        shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
		        shotIndices: freshShotIndices,
	        videoWarnings: blockedWarnings,
	        videoIsCurrent: false,
	      };
	      maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-segment-budget-blocked');
	      return { videoTasks, storyboards };
	    });
	    const err = errorWithFailureStage(TAIL_RUSHED_WARNING_MESSAGE, 'preflight_video_prompt_not_ready') as Error & {
	      errorCode?: string;
	      groupIdx?: number;
	      videoWarnings?: any[];
	    };
	    err.errorCode = 'video_duration_budget_blocked';
	    err.groupIdx = groupIdx;
	    err.videoWarnings = blockedWarnings;
	    throw err;
	  }

	  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
    if (groupIdx >= shots.length) return null;
    const storyboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
    const freshShotIndices = storyboardShotIndices(fresh, groupIdx, storyboards[groupIdx], {
      mode: 'single-shot-strict',
      explicitShotIndices: groupShotIndices,
    });
	    videoTasks[groupIdx] = {
	      ...(videoTasks[groupIdx] || {}),
	      groupIdx,
	      shotIndices: freshShotIndices,
	      status: 'submitting',
		      prompt,
			      durationSec,
			      plannedDurationSec,
			      tempoBudget,
			      warnings: videoWarnings,
	      videoPlan,
	      consistency: {
	        ...((videoTasks[groupIdx] || {}).consistency || {}),
	        videoSegment: {
	          ...(((videoTasks[groupIdx] || {}).consistency || {}).videoSegment || {}),
	          characterLockBlockHash,
	          characterUsages: segmentGate.characterUsages,
	          score: segmentGate.score,
	          level: segmentGate.level,
	          warnings: segmentGate.warnings,
	        },
	      },
	      isCurrent: true,
	    };
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, videoTasks }, 'video-segment-submit-writeback');
    return { videoTasks };
  });

	  ctx.progress({ stage: 'submitting', durationSec, plannedDurationSec, videoWarnings });

  recordBatchKnowledgeAudit({
    ctx,
    project: proj,
    stage: 'video_submit',
    provider: videoPlan.modelSnapshot?.provider || videoCfg.provider || videoCfg.mode,
    stageTarget: {
      groupIdx,
      shotIndices: groupShotIndices,
      durationSec,
      plannedDurationSec,
      resolution: videoResolution,
      generateAudio,
      ratio: userRatio,
      promptHash: hashString(prompt),
      finalPromptHash: hashString(plannedFinalPrompt),
      dialoguePairs: dialoguePairs.length,
      referenceCount: referenceImages.length,
      manifestCount: manifestInImageOrder.length,
      submitMode: requestedVideoSubmitMode,
      payloadMode: payloadModeDecision,
      requestPath: 'batch_video_segments',
    },
  });

		  let result;
		  try {
		    result = await generateVideo(
		      ctx.user,
		      videoInput,
		      (pct, hint) => ctx.progress({ stage: 'gen', pct, hint }),
			    );
	        if (result.status === 'upstream_pending') {
	          const pendingVideoWarnings = mergeVideoWarnings(
	            videoWarnings,
	            videoWarningsFromAuditRefs(result.videoAudit?.referenceImages || []),
	            videoFallbackWarnings(result.videoAudit?.fallbackReason),
	          );
	          return {
	            extra: {
	              upstreamPending: true,
		              provider: result.provider,
	              providerTaskId: result.providerTaskId,
	              taskId: result.taskId,
		              filename: result.filename,
		              displayName: result.displayName,
		              downloadFilename: result.downloadFilename,
		              groupIdx,
		              durationSec: result.durationSec,
		              plannedDurationSec,
		              tempoBudget,
		              videoWarnings: pendingVideoWarnings,
	            },
	          };
	        }
		  } catch (e: any) {
		    const vgErr = e instanceof VideoGenerationError ? e : null;
		    const failureStage: VideoPromptFailureStage = vgErr?.failureStage || classifyVideoFailureStage(e);
		    const failureAudit = vgErr?.videoAudit;
        const planAuditPayloadModeMismatch = videoPlanAuditPayloadMismatch(payloadModeDecision, failureAudit?.payloadMode);
        warnVideoPlanAuditPayloadMismatch({
          projectId: ctx.projectId,
          groupIdx,
          planned: payloadModeDecision,
          actual: failureAudit?.payloadMode,
          phase: 'failed',
        });
			    const errMsg = e?.message || String(e);
			    const failureReferences = failureAudit?.referenceImages?.length
			      ? planReferencesFromAuditRefs(failureAudit.referenceImages)
			      : videoPlan.references;
			    const mergedVideoWarnings = mergeVideoWarnings(
			      videoWarnings,
			      videoWarningsFromAuditRefs(failureAudit?.referenceImages || []),
			      videoFallbackWarnings(failureAudit?.fallbackReason),
			    );
			    videoPlan = buildVideoPlanSnapshot({
		      projectId: ctx.projectId,
		      groupIdx,
		      groupShotIndices,
          submitMode: requestedVideoSubmitMode,
	          payloadMode: payloadModeDecision,
	          modeReason: payloadModeReason,
	          planAuditPayloadModeMismatch,
	          tempoBudget,
			      videoPromptSource,
		      sanitizedFor,
		      finalPrompt: {
		        preview: failureAudit?.finalPromptPreview || videoPlan.promptAudit.finalPrompt.preview,
		        hash: failureAudit?.finalPromptHash || videoPlan.promptAudit.finalPrompt.hash,
		        length: failureAudit?.finalPromptLength || videoPlan.promptAudit.finalPrompt.length,
		      },
		      dialoguePolicy: failureAudit?.dialoguePolicy || 'budget_check_only',
		      dialoguePolicyNotes: failureAudit?.dialoguePolicyNotes,
		      references: failureReferences,
		      droppedReferences: videoPlan.droppedReferences,
		      prompt,
				      userRatio,
              resolution: videoResolution,
              generateAudio,
				      durationSec,
			      plannedDurationSec,
				      videoWarnings: mergedVideoWarnings,
		      dialogueChars: cleanDialogueCharCount(dialoguePairs),
		      status: 'failed',
		      failureStage,
		      errorMsg: errMsg.slice(0, 500),
		      modelSnapshot: {
		        modelRole: 'video',
		        provider: failureAudit?.provider || videoPlan.modelSnapshot?.provider,
		        model: failureAudit?.model || videoPlan.modelSnapshot?.model,
		        providerTaskId: failureAudit?.providerTaskId,
		        filledAfterCall: !!failureAudit,
		      },
		    });
		    patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
		      if (!fresh) return null;
		      const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
		      const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
		      if (groupIdx >= shots.length) return null;
			      const storyboards = Array.isArray((fresh as any).storyboards) ? (fresh as any).storyboards : [];
			      const freshShotIndices = storyboardShotIndices(fresh, groupIdx, storyboards[groupIdx], {
			        mode: 'single-shot-strict',
			        explicitShotIndices: groupShotIndices,
			      });
			      videoTasks[groupIdx] = {
			        ...(videoTasks[groupIdx] || {}),
			        groupIdx,
			        shotIndices: freshShotIndices,
			        taskId: vgErr?.taskId || videoTasks[groupIdx]?.taskId,
			        status: 'failed',
			        errorMsg: errMsg.slice(0, 500),
				        durationSec,
				        plannedDurationSec,
				        tempoBudget,
				        prompt,
			        warnings: mergedVideoWarnings,
		        videoPlan,
		        videoAudit: failureAudit
		          ? {
		              payloadMode: failureAudit.payloadMode,
		              modeReason: failureAudit.modeReason,
		              capabilityVerifiedAt: failureAudit.capabilityVerifiedAt,
		              referenceImages: compactVideoAuditReferenceImages(failureAudit.referenceImages || []),
		            }
		          : undefined,
		        isCurrent: true,
		      };
		      maybeAssertStoryboardsAlignedWithShots({ ...fresh, videoTasks }, 'video-segment-failure-writeback');
		      return { videoTasks };
		    });
		    throw e;
		  }

		  const dialoguePolicy: DialoguePolicy = result.videoAudit?.dialoguePolicy || 'budget_check_only';
		  const actualAuditRefs = result.videoAudit?.referenceImages || [];
      const planAuditPayloadModeMismatch = videoPlanAuditPayloadMismatch(payloadModeDecision, result.videoAudit?.payloadMode);
      warnVideoPlanAuditPayloadMismatch({
        projectId: ctx.projectId,
        groupIdx,
        planned: payloadModeDecision,
        actual: result.videoAudit?.payloadMode,
        phase: 'completed',
      });
			  const sentPaths = new Set(actualAuditRefs.map((ref) => ref.path).filter(Boolean));
				  const planReferences: ReferenceManifestItem[] = actualAuditRefs.length
				    ? planReferencesFromAuditRefs(actualAuditRefs)
				    : planReferencesFromManifest(manifestInImageOrder);
		      const mergedVideoWarnings = mergeVideoWarnings(
		        videoWarnings,
		        videoWarningsFromAuditRefs(actualAuditRefs),
		        videoFallbackWarnings(result.videoAudit?.fallbackReason),
		        result.videoWarnings || [],
		      );
			  videoPlan = buildVideoPlanSnapshot({
		    projectId: ctx.projectId,
		    groupIdx,
		    groupShotIndices,
        submitMode: requestedVideoSubmitMode,
	        payloadMode: payloadModeDecision,
	        modeReason: payloadModeReason,
	        planAuditPayloadModeMismatch,
	        tempoBudget,
			    videoPromptSource,
		    sanitizedFor,
		    finalPrompt: {
		      preview: result.videoAudit?.finalPromptPreview || plannedFinalPrompt.slice(0, 500),
		      hash: result.videoAudit?.finalPromptHash || hashString(plannedFinalPrompt),
		      length: result.videoAudit?.finalPromptLength || plannedFinalPrompt.length,
		    },
		    dialoguePolicy,
		    dialoguePolicyNotes: result.videoAudit?.dialoguePolicyNotes,
		    references: planReferences,
		    droppedReferences: [
		      ...(Array.isArray(sb.videoReferenceDropped) ? sb.videoReferenceDropped : []),
		      ...canonicalRefs.droppedReferences,
		      ...referenceImages
		        .filter((ref) => isPlanReferenceRole(ref.role) && ref.role !== 'first_frame' && ref.path && !sentPaths.has(ref.path))
		        .map((ref) => ({
		          role: ref.role as Exclude<VideoReferenceRole, 'first_frame'>,
		          viewRole: ref.viewRole,
		          assetName: ref.assetName || ref.label,
		          reason: 'filtered_constraint' as const,
		        })),
		    ],
			    prompt,
				    userRatio,
            resolution: videoResolution,
            generateAudio,
					      durationSec: result.durationSec,
				      plannedDurationSec,
						      videoWarnings: mergedVideoWarnings,
		    dialogueChars: cleanDialogueCharCount(dialoguePairs),
		    status: 'completed',
		    modelSnapshot: result.videoAudit
		      ? {
		          modelRole: 'video',
		          provider: result.videoAudit.provider,
		          model: result.videoAudit.model,
		          providerTaskId: result.videoAudit.providerTaskId,
		          filledAfterCall: true,
		        }
		      : videoPlan.modelSnapshot,
		  });

	  // 写回 project.videoTasks 数组（前端 batch 页读这里）
	  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    const shots = Array.isArray((fresh as any).shots) ? (fresh as any).shots : [];
    if (groupIdx >= shots.length) return null;
    const sbs = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const sb = sbs[groupIdx];
	    const freshShotIndices = storyboardShotIndices(fresh, groupIdx, sb, {
	      mode: 'single-shot-strict',
	      explicitShotIndices: groupShotIndices,
	    });
	    const firstShotForWrite = shots[freshShotIndices[0]];
			    videoTasks[groupIdx] = {
			      groupIdx,
			      shotIndices: freshShotIndices,
				      taskId: result.taskId,
			      status: 'completed',
			      url: result.protectedUrl,
			      filename: result.filename,
			      displayName: result.displayName,
			      downloadFilename: result.downloadFilename,
			      coverUrl: result.coverUrl,
					      durationSec: result.durationSec,
					      plannedDurationSec,
					      tempoBudget,
					      prompt,
					      warnings: mergedVideoWarnings,
			      videoPlan,
		      videoAudit: result.videoAudit
		        ? {
		            payloadMode: result.videoAudit.payloadMode,
		            modeReason: result.videoAudit.modeReason,
			            capabilityVerifiedAt: result.videoAudit.capabilityVerifiedAt,
			            submittedLastFrameContentHash: result.videoAudit.submittedLastFrameContentHash,
			            returnedLastFrameUrl: result.videoAudit.returnedLastFrameUrl,
			            returnedLastFrameContentHash: result.videoAudit.returnedLastFrameContentHash,
			            referenceImages: compactVideoAuditReferenceImages(result.videoAudit.referenceImages || []),
			          }
			        : undefined,
		      consistency: {
		        ...((videoTasks[groupIdx] || {}).consistency || {}),
		        videoSegment: {
		          ...(((videoTasks[groupIdx] || {}).consistency || {}).videoSegment || {}),
		          characterLockBlockHash,
		          characterUsages: segmentGate.characterUsages,
		          score: segmentGate.score,
		          level: segmentGate.level,
		          warnings: segmentGate.warnings,
		        },
		      },
		      isCurrent: true,
			    };
    // 同时挂到 storyboards[groupIdx].videoUrl，方便编辑页直接读
	    // videoDurationSec 是真实生成文件时长；plannedDurationSec 是镜头表计划时长。
	    // 剪辑工作台优先用真实文件时长，避免生成结果比计划略长时出现时间线错位。
	    sbs[groupIdx] = {
		      ...sb,
		      idx: groupIdx,
		      shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
		      shotIndices: freshShotIndices,
		      videoUrl: result.protectedUrl,
		      videoTaskId: result.taskId,
		      videoFilename: result.filename,
		      videoDisplayName: result.displayName,
		      videoDownloadFilename: result.downloadFilename,
			      videoDurationSec: result.durationSec,
		      plannedDurationSec,
		      videoWarnings: mergedVideoWarnings,
	      videoIsCurrent: true,
	      videoInvalidatedAt: undefined,
	      videoInvalidatedReason: undefined,
	    };
    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards: sbs, videoTasks }, 'video-segment-complete-writeback');
    return { videoTasks, storyboards: sbs };
  });

  return {
    resultUrl: result.url,
    patch: {
      type: 'video_segment',
      groupIdx,
      url: result.url,
	      coverUrl: result.coverUrl,
	      filename: result.filename,
	      displayName: result.displayName,
	      downloadFilename: result.downloadFilename,
		      durationSec: result.durationSec,
	      plannedDurationSec,
	      taskId: result.taskId,
    },
    extra: {
      mode: result.mode,
      groupIdx,
	      durationSec: result.durationSec,
		      plannedDurationSec,
		      protectedUrl: result.protectedUrl,
		      filename: result.filename,
		      displayName: result.displayName,
		      downloadFilename: result.downloadFilename,
	      tempoBudget,
	      videoWarnings: mergedVideoWarnings,
	    },
	  };
});

/* ============================================================
   5. shots executor —— 把剧本拆成 6-15 个镜头（一次 LLM 调用）
   ============================================================
   前端 generateShots() 的 stage hint 命名约定：
     prepare → planning → reasoning → writing → parsing → assembling
   这里我们没法精细拆 LLM 内部阶段，但能在调用前后发几个粗粒度
   stage 让进度条至少动起来。
   返回 patch.value = shots 数组，前端 onTaskCompleted 直接读。
   ============================================================ */
registerExecutor('shots', async (ctx: BatchExecCtx) => {
  const { script, styleBible, assets, durationSec } = (ctx.options || {}) as {
    script?: string;
    styleBible?: any;
    assets?: any;
    durationSec?: number | null;
  };
  if (!script || !script.trim()) {
    throw new Error('当前没有剧本，请先生成剧本再做镜头设计');
  }

  ctx.progress({ stage: 'prepare', percent: 8, hint: '正在准备剧本与资产上下文…' });

  // 把资产瘦身：只发名字 + 简短描述给 LLM，避免上下文炸掉
  const slimAssets = (() => {
    if (!assets) return null;
    const trim = (a: any) => a && {
      id: a.id,
      name: a.name,
      role: a.role,
      identity: a.identity,
      description: a.description || a.appearance || '',
    };
    return {
      characters: (assets.characters || []).map(trim),
      scenes: (assets.scenes || assets.environments || []).map(trim),
      props: (assets.props || []).map(trim),
    };
  })();

	  ctx.progress({ stage: 'planning', percent: 18, hint: 'AI 正在分析剧本结构…' });
  const projectForWorld = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  const worldContext = projectWorldContextForStage('shots_generate', (projectForWorld as any)?.worldTemplateSnapshot, {
    project: projectForWorld,
    scriptText: script,
  });
  const messages = buildShotsMessages({
    script,
    styleBible,
    assets: slimAssets,
    totalDurationSec: durationSec || undefined,
    worldContext,
  });

  ctx.progress({ stage: 'writing', percent: 45, hint: 'AI 正在生成镜头表（这一步比较慢，请耐心等）…' });

  // 用 background 模式跑: shots-generate 推理重 + 输出长, 同步通道易被中转站
  // 60-300s 超时掐断 (504)。background 模式 submit + poll, 单次 HTTP 连接不会长留,
  // 中转站超时无法触达。chatCompleteJsonViaBackground 在 provider 不是 Responses API
  // 系时会自动回退到 chatCompleteJsonWithRetry, 行为对其它 provider 透明。
  let parsed: any;
  try {
    parsed = await chatCompleteJsonViaBackground(
      ctx.user,
      messages,
      // 镜头表可能很长（10+ 镜头），给足 token
      {
        temperature: 0.6,
        maxTokens: 4000,
        modelRole: 'structured',
        tokenContext: {
          projectId: ctx.projectId,
          requestPath: 'batch_executor:shots_generate',
          routeName: 'batch.shots-generate',
          moduleKey: 'shots',
          moduleLabel: '镜头规划',
          featureKey: 'batch_shots_generate',
          featureLabel: '批量镜头表生成',
          callItemType: 'batch_task',
          callItemId: ctx.taskId,
          callItemLabel: '批量镜头表生成',
          batchId: ctx.batchId,
          taskId: ctx.taskId,
        },
      },
      (raw) => parseJsonLoose(raw),
      'shots-generate',
    );
  } catch (e: any) {
    throw new Error('镜头设计失败：' + (e?.message || String(e)));
  }

  ctx.progress({ stage: 'parsing', percent: 88, hint: '正在整理镜头表…' });

  let shotsArr: any[] = Array.isArray(parsed?.shots) ? parsed.shots : [];
  if (!shotsArr.length && Array.isArray(parsed)) shotsArr = parsed;
  if (!shotsArr.length) {
    throw new Error('AI 未返回有效镜头列表（shots 字段为空）');
  }

  const sceneSelectionAssets = slimAssets || assets || {};
  const generatedAt = nowIso();
  const normalizedPlan = normalizeGeneratedShotPlan(shotsArr, {
    assets: sceneSelectionAssets,
    styleBible,
    generatedAt,
  });
  shotsArr = normalizedPlan.shots;
  const planMeta = normalizedPlan.planMeta;
  const planValidation = normalizedPlan.validation;

  if (!shotsArr.length) {
    throw new Error('AI 返回的镜头都没有内容，请稍后重试或换个剧本');
  }
  if (planValidation && (!planValidation.ok || planValidation.warnings?.length)) {
    console.warn('[shots] shot-plan validation signals:', {
      projectId: ctx.projectId,
      batchId: ctx.batchId,
      errors: planValidation.errors,
      warnings: planValidation.warnings,
    });
  }

  ctx.progress({ stage: 'assembling', percent: 95, hint: '正在保存镜头表…' });

  const storyboards = makeSingleShotStoryboardSlots(shotsArr);
  maybeAssertStoryboardsAlignedWithShots(
    { shots: shotsArr, storyboards, videoTasks: [] },
    'shots-batch-executor',
  );

  const sourceSnapshot = ctx.options?.shotPlanSourceSnapshot || computeShotPlanSourceSnapshot({
    script,
    styleBible,
    assets,
    scriptTargetDurationSec: durationSec,
    emotions: ctx.options?.emotionSegments,
  });
  const sourceHash = ctx.options?.shotPlanSourceHash || computeShotPlanSourceHash({
    script,
    styleBible,
    assets,
    scriptTargetDurationSec: durationSec,
    emotions: ctx.options?.emotionSegments,
  });

  let completionApplied = false;
  let completionStaleReasons: string[] = [];
  patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
    if (!fresh) return null;
    const completion = completeShotPlanGenerationPatch(fresh, {
      batchId: ctx.batchId,
      shots: shotsArr,
      planMeta,
      storyboards,
      sourceSnapshot,
      sourceHash,
      now: generatedAt,
    });
    if (!completion.ok) {
      console.warn('[shots] skipped stale shot-plan completion write:', {
        projectId: ctx.projectId,
        batchId: ctx.batchId,
        reason: completion.reason,
        currentBatchId: (fresh as any)?.shotPlanBatchId || null,
        currentStatus: (fresh as any)?.shotPlanStatus || null,
      });
      return null;
    }
    maybeAssertStoryboardsAlignedWithShots(
      { ...fresh, ...completion.patch },
      'shots-batch-executor-complete',
    );
    completionApplied = true;
    completionStaleReasons = completion.staleReasons || [];
    return completion.patch;
  });

  if (!completionApplied) {
    throw new Error('镜头计划写回失败：生成状态已变化，请刷新后重试');
  }

  return {
    patch: { type: 'shots', value: shotsArr },
    extra: {
      count: shotsArr.length,
      planMeta,
      shotPlanValidation: planValidation,
      shotPlanStaleReasons: completionStaleReasons,
    },
  };
});

/* ============================================================
   6. video_prompts executor —— 给一个分镜组生成视频生成模型用的中文 prompt
   ============================================================
   前端 generateAllVideoPrompts 启动 batchType: 'video_prompts'，
   targets 里每条带 { groupIdx, shotIndices, totalGroups }。
   返回到前端的 extra：{ groupIdx, videoPrompt, narrationsUsed }
   ============================================================ */
registerExecutor('video_prompts', async (ctx: BatchExecCtx) => {
  const proj = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  if (!proj) throw new Error('项目不存在');

  const groupIdx: number = ctx.target.groupIdx ?? ctx.target.idx ?? 0;
  const totalGroups: number = ctx.target.totalGroups || 1;
  const shots = (proj as any).shots || [];
  const storyboards = Array.isArray((proj as any).storyboards) ? (proj as any).storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const shotIndices = storyboardShotIndices(proj as any, groupIdx, sb, {
    mode: 'single-shot-strict',
    explicitShotIndices: ctx.target.shotIndices,
  });
  const promptDecision = assertArtifactUsable(proj as any, ctx, 'video_prompt_generation', { groupIdx, shotIndices });
  const promptGate = consistencyFromDecision(promptDecision);
		  const promptRunId = ctx.batchId;
	  const promptStartedAt = nowIso();
	  let previousStatusForTrace: unknown = null;
	  let previousRunIdForTrace: unknown = null;
	  let startDecision = 'allow';
	  const markedProject = patchProjectForUser(ctx.projectId, ctx.user.id, (fresh) => {
	    if (!fresh) return null;
	    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	    const prev = storyboards[groupIdx] || {};
	    previousStatusForTrace = prev.videoPromptStatus || null;
	    previousRunIdForTrace = prev.videoPromptRunId || null;
	    if (prev.videoPromptRunId && prev.videoPromptRunId !== promptRunId) {
	      startDecision = 'run_taken_by_other';
	      return null;
	    }
		    const freshShotIndices = storyboardShotIndices(fresh, groupIdx, prev, {
		      mode: 'single-shot-strict',
		      explicitShotIndices: shotIndices,
		    });
		    const firstShotForWrite = shots[freshShotIndices[0]];
		    storyboards[groupIdx] = {
		      ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', promptStartedAt),
		      idx: groupIdx,
		      shotIdx: firstShotForWrite?.idx ?? freshShotIndices[0] + 1,
		      shotIndices: freshShotIndices,
	      videoPromptStatus: 'generating',
	      videoPromptRunId: promptRunId,
	      videoPromptStartedAt: promptStartedAt,
	      videoPromptLastError: undefined,
	      videoPromptFailedAt: undefined,
	    };
	    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	    if (videoTasks.length > groupIdx && videoTasks[groupIdx]) {
	      videoTasks[groupIdx] = markVideoTaskOutdated(videoTasks[groupIdx], 'video_prompt_regeneration', promptStartedAt);
	    }
	    maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-prompt-batch-generating');
	    return { storyboards, videoTasks };
	  });
	  const markedSb = Array.isArray((markedProject as any)?.storyboards)
	    ? (markedProject as any).storyboards[groupIdx] || {}
	    : {};
	  logVideoPromptTrace('batch_executor_status_marked', {
	    projectId: ctx.projectId,
	    batchId: ctx.batchId,
	    taskId: ctx.taskId,
	    seq: ctx.seq,
	    groupIdx,
	    previousStatus: previousStatusForTrace,
	    previousRunId: previousRunIdForTrace,
	    newRunId: promptRunId,
	    decision: startDecision,
	    applied: markedSb.videoPromptStatus === 'generating' && markedSb.videoPromptRunId === promptRunId,
	    storedStatus: markedSb.videoPromptStatus || null,
	    storedRunId: markedSb.videoPromptRunId || null,
	  }, startDecision === 'allow' ? 'info' : 'warn');
	  if (startDecision === 'run_taken_by_other') {
	    const error = new Error(
	      `视频提示词任务已被更新请求接管：片段 ${groupIdx + 1} 当前任务为 ${String(previousRunIdForTrace || '')}`,
	    ) as Error & { failureStage?: string; errorCode?: string };
	    error.failureStage = 'persist';
	    error.errorCode = 'VIDEO_PROMPT_RUN_TAKEN_BY_OTHER';
	    throw error;
	  }

	  const groupShots = shotIndices.map((i) => shots[i]);
	  const promptGroupShots = sanitizePromptObject(groupShots);
	  const timelineStartSec = plannedTimelineStartFromGroups(plannedTimelineGroupsFromProject(proj), groupIdx);
	  const styleBible = (proj as any).styleBible || {};
	  const assets = (proj as any).assets || {};
	  const promptStyleBible = sanitizePromptObject(styleBibleForVideoPrompt(styleBible));
	  const promptAssets = sanitizePromptObject(assets);
	  const narrations: any[] = Array.isArray((proj as any).narrations) ? (proj as any).narrations : [];
  const referenceBuild = buildVideoReferenceManifest({
    project: proj,
    assets,
    shots,
    groupShotIndices: shotIndices,
    groupIdx,
    ownerId: ctx.user.id,
    storyboardImageUrl: resolveStoryboardFirstFrameUrl(sb) || null,
  });
  const referenceManifest = referenceBuild.manifest;
  const droppedReferences = referenceBuild.droppedReferences;

  ctx.progress({ stage: 'preparing', percent: 10, hint: '准备镜头与资产上下文…' });

	  const messages = buildVideoPromptMessages({
		    shots: promptGroupShots,
		    styleBible: promptStyleBible,
		    assets: promptAssets,
		    narrations,
			    referenceManifest,
			    groupIdx,
			    totalGroups,
			    timelineStartSec,
			    planMeta: sanitizePromptObject((proj as any).planMeta || null),
        worldContext: projectWorldContextForStage('video_prompt', (proj as any).worldTemplateSnapshot, {
          project: proj,
          target: { groupIdx, shotIndices },
        }),
			  });

  ctx.progress({ stage: 'calling_llm', percent: 35, hint: 'AI 正在写视频提示词…' });

  // 检测 LLM 是否偷懒输出了老格式 / 含禁止词
  const looksLikeOldFormat = (text: string): boolean => {
    const t = text || '';
    if (/\[(CAMERA|STYLE|CONSTRAINTS|AUDIO)\]/i.test(t)) return true;
    if (/\bshot\s*\d+\s*:/i.test(t)) return true;
    // "参考图X" 引用是用户明确不要的
    if (/参考图\s*\d+/.test(t)) return true;
    // 看起来 80% 以上是英文
    const cnChars = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enChars = (t.match(/[a-zA-Z]/g) || []).length;
    if (cnChars + enChars > 100 && cnChars / (cnChars + enChars) < 0.4) return true;
    return false;
  };

  // 兜底清洗：把 "（参考图N）" / "(参考图N)" / "参考图N" 直接擦掉
  const stripRefMarkers = (text: string): string =>
    text
      .replace(/[（(]\s*参考图\s*\d+\s*[)）]/g, '')
      .replace(/参考图\s*\d+/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*([，。；：])[ \t]*/g, '$1');

  let prompt = '';
  let attempt = 0;
  const NETWORK_MAX_ATTEMPTS = envInt('VIDEO_PROMPT_NETWORK_MAX_ATTEMPTS', 4, 1, 8);
  const MAX_ATTEMPTS = Math.max(VIDEO_PROMPT_MAX_ATTEMPTS, NETWORK_MAX_ATTEMPTS);
  const RETRY_DEADLINE_MS = envInt('VIDEO_PROMPT_RETRY_DEADLINE_MS', 90_000, 10_000, 600_000);
  const retryDeadlineAt = Date.now() + RETRY_DEADLINE_MS;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const remaining = retryDeadlineAt - Date.now();
      if (remaining <= 0) {
        throw new Error('retry_deadline_exceeded：视频提示词网络/模型重试超过总预算');
      }
      // 第二次重试时压低 temperature 并在 user message 末尾追加强提示
      const retryMessages = buildVideoPromptAttemptMessages(messages, attempt);
      const temp = videoPromptTemperatureForAttempt(attempt);
      prompt = await chatComplete(
        ctx.user,
        retryMessages,
        {
          temperature: temp,
          modelRole: 'structured',
          traceName: 'video-prompts',
          traceAttempt: attempt,
          traceMaxAttempts: MAX_ATTEMPTS,
          requestTimeoutMs: Math.min(remaining, 600_000),
          tokenContext: {
            projectId: ctx.projectId,
            requestPath: 'batch_executor:video_prompts',
            routeName: 'batch.video-prompts',
            moduleKey: 'video_prompt',
            moduleLabel: '视频提示词',
            featureKey: 'batch_video_prompt_generate',
            featureLabel: '批量视频提示词生成',
            callItemType: 'batch_task',
            callItemId: ctx.taskId,
            callItemLabel: `分镜组 ${groupIdx + 1}`,
            batchId: ctx.batchId,
            taskId: ctx.taskId,
          },
        },
      );
      if (!looksLikeOldFormat(prompt)) break;
      console.warn(`[video_prompts] attempt ${attempt} produced old format, retrying…`);
    } catch (e: any) {
      const isNetwork = isTransientNetworkError(e);
      const maxAttemptsForThisError = isNetwork ? NETWORK_MAX_ATTEMPTS : VIDEO_PROMPT_MAX_ATTEMPTS;
      if (attempt >= maxAttemptsForThisError) {
        throw new Error('视频提示词生成失败：' + (e?.message || String(e)));
      }
      const delay = isNetwork
        ? Math.min(60_000, 10_000 * Math.pow(2, attempt - 1))
        : 1500 * attempt;
      if (Date.now() + delay > retryDeadlineAt) {
        throw new Error('视频提示词生成失败：retry_deadline_exceeded；最后错误：' + (e?.message || String(e)));
      }
      console.warn(
        `[video_prompts] attempt ${attempt}/${maxAttemptsForThisError} failed, ` +
          `retrying in ${Math.round(delay / 1000)}s: ${e?.message || String(e)}`,
      );
      await sleep(delay);
    }
  }

  let cleaned = prompt.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!cleaned) throw new Error('AI 没有返回提示词');
  // 即使 LLM 漏写了"参考图X"，最后再做一次引用标记清理（不破坏其他内容）
  cleaned = stripRefMarkers(cleaned);
  if (looksLikeOldFormat(cleaned)) {
    // 两次都失败：抛错让前端显示"重试"按钮，比保存一份乱码好
    throw new Error('AI 输出格式不符（旧英文格式或仍含参考图编号），请点击重新生成（已自动重试 2 次仍失败）');
  }
  ctx.progress({ stage: 'saving', percent: 92, hint: '正在保存…' });

  // 写回 storyboards[groupIdx].videoPrompt
  const beforeWriteProject = getProjectByIdForUser(ctx.projectId, ctx.user.id);
  const beforeWriteSb = Array.isArray((beforeWriteProject as any)?.storyboards)
    ? (beforeWriteProject as any).storyboards[groupIdx] || {}
    : {};
  const currentRunBeforeWrite: unknown = beforeWriteSb.videoPromptRunId || null;
  const currentStatusBeforeWrite: unknown = beforeWriteSb.videoPromptStatus || null;
  const writeResult = applyVideoPromptWrite({
    projectId: ctx.projectId,
    userId: ctx.user.id,
    groupIdx,
    prompt: cleaned,
    runId: promptRunId,
    ownership: 'same-run',
    writeKind: 'system_generated',
    narrationsUsed: narrations,
    referenceManifest,
    droppedReferences,
    shotIndices,
    consistency: {
      characterUsages: promptGate.characterUsages,
      score: promptGate.score,
      level: promptGate.level,
      warnings: promptGate.warnings,
    },
  });
  const writeDecision = writeResult.applied
    ? 'allow'
    : writeResult.skippedReason === 'run_taken_by_other'
      ? 'run_mismatch'
      : (writeResult.skippedReason || 'write_not_applied');
  if (writeDecision === 'run_mismatch') {
    console.warn(
      `[video_prompts] ignored stale write project=${ctx.projectId} group=${groupIdx} ` +
        `run=${promptRunId} currentRun=${String(currentRunBeforeWrite || writeResult.storedRunId || '')}`,
    );
  }
  const patchedProject = writeResult.project;
  const patchedSb = Array.isArray((patchedProject as any)?.storyboards)
    ? (patchedProject as any).storyboards[groupIdx] || {}
    : {};
  const writeApplied =
    patchedSb.videoPromptStatus === 'ready' &&
    patchedSb.videoPromptRunId === promptRunId &&
    String(patchedSb.videoPrompt || '').trim() === cleaned;
  logVideoPromptTrace('batch_executor_writeback_result', {
    projectId: ctx.projectId,
    batchId: ctx.batchId,
    taskId: ctx.taskId,
    seq: ctx.seq,
    groupIdx,
    incomingRunId: promptRunId,
    currentRunBeforeWrite,
    currentStatusBeforeWrite,
    decision: writeDecision,
    applied: writeApplied,
    storedStatus: patchedSb.videoPromptStatus || null,
    storedRunId: patchedSb.videoPromptRunId || null,
    promptSummary: summarizePromptForTrace(cleaned),
    referenceCount: referenceManifest.length,
    droppedReferenceCount: droppedReferences.length,
  }, writeApplied ? 'info' : 'warn');
  if (!writeApplied) {
    const error = new Error(
	      writeDecision === 'run_mismatch'
        ? `视频提示词写回被拒：片段 ${groupIdx + 1} 已属于其他生成任务`
        : `视频提示词写回失败：片段 ${groupIdx + 1} 未保存到项目`,
    ) as Error & { failureStage?: string; errorCode?: string };
    error.failureStage = 'persist';
    error.errorCode = writeDecision === 'run_mismatch'
      ? 'VIDEO_PROMPT_RUN_MISMATCH'
      : 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED';
    throw error;
  }

  return {
    patch: {
      type: 'video_prompt',
      idx: groupIdx,
      value: cleaned,
      videoReferenceManifest: referenceManifest,
      videoReferenceDropped: droppedReferences,
    },
    extra: {
      groupIdx,
      videoPrompt: cleaned,
	      videoPromptStatus: 'ready',
	      videoPromptRunId: promptRunId,
	      videoPromptSourceHash: writeResult.sourceHash || null,
	      narrationsUsed: narrations,
      referenceManifest,
      droppedReferences,
      videoReferenceManifest: referenceManifest,
      videoReferenceDropped: droppedReferences,
      shotIndices: writeResult.shotIndices || shotIndices,
      invalidateVideo: true,
    },
  };
});

/* ============================================================
   batchType 别名：历史前端提交 batchType="videos"，
   当前前端提交 batchType="video_segments"；旧任务继续复用同一 executor
   ============================================================ */
aliasExecutor('video_segments', 'videos');
