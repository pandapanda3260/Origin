import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { generateVideo, normalizeGenerateAudio, type VideoReferenceImage } from '@/lib/video-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { resolveLLMConfig } from '@/lib/llm';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { shortKnowledgeHash } from '@/lib/knowledge/hash';
import { isVideoGenerationEnabled } from '@/lib/system-config';
import {
  getVideoSubmitMode,
  isFirstLastFrameVideoModeEnabled,
  isIndependentMultiImageModeEnabled,
  isMultiRefVideoModeEnabled,
} from '@/lib/feature-flags';
import { resolveLocalImagePath } from '@/lib/image-gen';
import {
  computeFirstLastFeatureEnabled,
  normalizeVideoSubmitMode,
  resolveVideoPayloadDecision,
  warnIfFirstLastConfigIgnored,
} from '@/lib/video-payload-decision';
import { resolveStoryboardFirstFrameUrl } from '@/lib/visual-reference-state';
import { resolveVideoModelCapability } from '@/lib/video-provider-capabilities';
import { buildVideoReferenceManifest } from '@/lib/reference-matcher';
import { buildReferenceBriefLine, resolveGenerationDurationSec } from '@/lib/video-reference-manifest';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from '@/lib/frame-workflow-state';
import {
  buildEffectiveShotPlanForDuration,
  buildSegmentShotPlan,
  buildTailRushedWarning,
  collectSegmentDialoguePairs,
  computeSegmentTempoBudget,
  plannedDurationForSegment,
  TAIL_RUSHED_WARNING_MESSAGE,
  type SegmentDialoguePair,
  type SegmentShotPlanItem,
  type SegmentTempoBudget,
} from '@/lib/video-segment-runtime';
import { artifactUsageBlockedPayload, describeArtifactStatus } from '@/lib/sentinel';
import { applyBlockerFilterWithWarnings } from '@/lib/batch-preflight';
import { InsufficientCreditsError } from '@/lib/credits';
import { assertCanStartPaidOperation } from '@/lib/usage-billing';
import {
  AssetQuotaError,
  assertCanStartAssetGeneration,
  createGenerationBatch,
  finishGenerationBatch,
  recordGenerationFailure,
} from '@/lib/asset-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function codedError(code: string, detail: string, status = 400) {
  return NextResponse.json({ code, detail }, { status });
}

function shotUidForGroup(project: any, groupIdx: number) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const sb = storyboards[groupIdx] || {};
  const shot = shots[groupIdx] || {};
  return String(sb.shotUid || sb.shot_uid || sb.uid || sb.id || shot.shotUid || shot.shot_uid || shot.uid || shot.id || `shot_${groupIdx}`).trim();
}

/**
 * 单视频同步生成（不走 batch）。
 * 接口契约 1:1：返回 { ok, taskId, status, url, coverUrl, durationSec, mode }
 */
export async function POST(req: NextRequest) {
  if (!isVideoGenerationEnabled()) {
    return jsonError('视频生成暂时关闭，请稍后再试', 503);
  }

  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = body.projectId ? String(body.projectId) : '';
  const groupIdxRaw = body.groupIdx;
  const hasGroupIdx = groupIdxRaw !== undefined && groupIdxRaw !== null && groupIdxRaw !== '';
  const groupIdx = Number(groupIdxRaw);
  const submitMode = normalizeVideoSubmitMode(body.submitMode, getVideoSubmitMode());
  const hasProjectContext = !!projectId || hasGroupIdx;

  if (hasProjectContext && (!projectId || !Number.isInteger(groupIdx) || groupIdx < 0)) {
    return codedError(
      'project_context_requires_group_idx',
      '项目上下文视频提交必须同时提供 projectId + groupIdx。',
      400,
    );
  }

  if (!hasProjectContext && submitMode === 'first_last_frame') {
    return codedError(
      'submit_mode_requires_project_context',
      '首尾帧模式必须搭配 projectId + groupIdx 提交。',
      400,
    );
  }

  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  if (projectId && !project) return jsonError('项目不存在', 404);

  let prompt: string = (body.prompt || body.videoPrompt || '').toString().trim();
  let firstLastFrameMode: any;
  let referenceImagePath: string | undefined;
  let referenceImageRole: 'first_frame' | 'storyboard_sketch' | undefined;
  let seedanceImageMode: 'strict_first_frame' | 'reference_images' = submitMode === 'reference_images' ? 'reference_images' : 'strict_first_frame';
  let payloadModeReason: string | undefined;
  let referenceImages: VideoReferenceImage[] | undefined;
  let sceneReferencePath: string | undefined;
  let characterReferencePaths: string[] | undefined;
  let propReferencePaths: string[] | undefined;
  let assetBatchId: string | null = null;
  let assetShotUid: string | null = null;
  let videoPromptSourceHash: string | null | undefined;
  let plannedDurationSec = Number(body.durationSec) || 4;
  let durationSec = Number(body.durationSec) || 4;
	  let shotPlan: SegmentShotPlanItem[] | undefined;
	  let dialoguePairs: SegmentDialoguePair[] | undefined;
	  let tempoBudget: SegmentTempoBudget | undefined;
	  let projectGroupShotIndices: number[] | undefined;

  if (hasProjectContext) {
    const sentinel = applyBlockerFilterWithWarnings(describeArtifactStatus(project as any, {
      projectId,
      targetArtifact: 'video_segment',
      groupIdx,
      consumerOperation: 'video_submit',
    })).decision;
    if (sentinel.usability === 'BLOCKED') {
      return Response.json(artifactUsageBlockedPayload(sentinel), { status: 409 });
    }
    if ((body.prompt || body.videoPrompt) && String(body.prompt || body.videoPrompt).trim()) {
      return codedError(
        'project_context_prompt_override_not_allowed',
        '项目上下文视频提交使用已保存的视频提示词，不允许在请求体覆盖 prompt。',
        400,
      );
    }
    const storyboards = Array.isArray((project as any)?.storyboards) ? (project as any).storyboards : [];
    const shots = Array.isArray((project as any)?.shots) ? (project as any).shots : [];
	    const sb = storyboards[groupIdx];
	    if (!sb) return codedError('storyboard_not_found', `找不到片段 ${groupIdx + 1}。`, 404);
	    const groupShotIndices = storyboardShotIndices(project as any, groupIdx, sb, { mode: 'single-shot-strict' });
	    projectGroupShotIndices = groupShotIndices;
    assetShotUid = shotUidForGroup(project, groupIdx);
    prompt = String(sb.videoPrompt || '').trim();
    videoPromptSourceHash = String(sb.videoPromptSourceHash || '') || null;
    if (!prompt) return codedError('missing_video_prompt', '缺少视频提示词，请先生成视频提示词。', 400);

    const firstFrameUrl = resolveStoryboardFirstFrameUrl(sb);
    const canonicalRefs = buildVideoReferenceManifest({
      project,
      assets: (project as any).assets || {},
      shots,
      groupShotIndices,
      groupIdx,
      ownerId: user.id,
      storyboardImageUrl: firstFrameUrl || null,
    });
    const manifestInImageOrder = [...canonicalRefs.manifest].sort((a, b) => a.imageNo - b.imageNo);
    const firstFrameItem = manifestInImageOrder.find((ref) => ref.role === 'first_frame' && ref.localPath);
    referenceImagePath = firstFrameItem?.localPath || (resolveLocalImagePath(firstFrameUrl, user.id) || undefined);
    referenceImageRole = referenceImagePath ? 'first_frame' : undefined;
    sceneReferencePath = manifestInImageOrder.find((ref) => ref.role === 'scene' && ref.localPath)?.localPath;
    characterReferencePaths = manifestInImageOrder
      .filter((ref) => ref.role === 'character' && ref.localPath)
      .map((ref) => ref.localPath as string);
    propReferencePaths = manifestInImageOrder
      .filter((ref) => ref.role === 'prop' && ref.localPath)
      .map((ref) => ref.localPath as string);
    const tailFrameUrl = String(sb?.frames?.tail?.url || sb?.tailFrameUrl || '').trim();
    const tailFramePath = tailFrameUrl ? (resolveLocalImagePath(tailFrameUrl, user.id) || undefined) : undefined;
    const cfg = resolveLLMConfig(user, 'video');
    const capability = resolveVideoModelCapability(cfg.model);
    const configuredSubmitMode = getVideoSubmitMode();
    const adminAllowsFirstLast = isFirstLastFrameVideoModeEnabled();
    warnIfFirstLastConfigIgnored({ configuredSubmitMode, adminAllowsFirstLast });
    const featureEnabled = computeFirstLastFeatureEnabled({
      submitMode,
      configuredSubmitMode,
      adminAllowsFirstLast,
    });
    const decision = resolveVideoPayloadDecision({
      submitMode,
      firstLastFeatureEnabled: featureEnabled,
      capabilityFirstLastSupported: capability.firstLastFrameMode === 'supported',
      firstFramePath: referenceImagePath,
      tailFramePath,
      tailFrameUrl,
      tailReferenceStatus: sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus,
      tailIntentRequested: sb?.tailFrameIntent === 'requested',
      multiShotSegment: groupShotIndices.length > 1,
    });
    if (decision.hardFail) {
      return codedError(
        decision.failureCode || 'video_preflight_failed',
        decision.failureMessage || '视频生成前置条件不满足。',
        400,
      );
    }
    firstLastFrameMode = decision.firstLastFrameMode;
    payloadModeReason = decision.reason;
    const effectiveSubmitStrategy =
      groupShotIndices.length > 1 && decision.reason === 'reference_images'
        ? 'reference_images'
        : submitMode;
    seedanceImageMode = effectiveSubmitStrategy === 'reference_images' ? 'reference_images' : 'strict_first_frame';
    const independentMultiImageMode =
      isMultiRefVideoModeEnabled() &&
      isIndependentMultiImageModeEnabled() &&
      effectiveSubmitStrategy === 'reference_images';
	    referenceImages = independentMultiImageMode
	      ? manifestInImageOrder
	          .filter((ref) => ref.localPath)
          .map((ref) => ({
            role: ref.role,
            path: ref.localPath as string,
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
	          }))
	      : undefined;
	    plannedDurationSec = plannedDurationForSegment(shots, groupShotIndices);
	    durationSec = resolveGenerationDurationSec({
	      plannedDurationSec,
	      model: cfg.model,
	      baseUrl: cfg.baseUrl,
	      minDurationSec: cfg.minDurationSec,
	    });
	    shotPlan = buildSegmentShotPlan(shots, groupShotIndices);
	    dialoguePairs = collectSegmentDialoguePairs(shots, groupShotIndices);
	    tempoBudget = computeSegmentTempoBudget({
	      dialoguePairs,
	      plannedDurationSec,
	      durationSec,
	      shotPlan,
	      payloadMode: decision.payloadMode,
	      payloadModeReason: decision.reason,
	      tailReferenceStatus: String(sb?.tailFrameReferenceStatus || sb?.frames?.tail?.referenceStatus || ''),
	    });
	    durationSec = tempoBudget.safeDurationSec;
	    shotPlan = buildEffectiveShotPlanForDuration(shotPlan, durationSec);
	    if (tempoBudget.exceedsMaxDuration) {
	      const warnings = [buildTailRushedWarning(tempoBudget)];
	      patchProjectForUser(projectId, user.id, (fresh) => {
	        if (!fresh) return null;
	        const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	        const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	        const currentSb = storyboards[groupIdx] || {};
		        const freshShotIndices = storyboardShotIndices(fresh, groupIdx, currentSb, {
		          mode: 'single-shot-strict',
		          explicitShotIndices: projectGroupShotIndices,
		        });
	        videoTasks[groupIdx] = {
	          ...(videoTasks[groupIdx] || {}),
	          groupIdx,
	          status: 'failed',
	          errorCode: 'video_duration_budget_blocked',
	          errorMsg: TAIL_RUSHED_WARNING_MESSAGE,
	          durationSec,
	          plannedDurationSec,
	          tempoBudget,
	          prompt,
	          warnings,
	          isCurrent: false,
	        };
	        storyboards[groupIdx] = {
	          ...currentSb,
	          idx: groupIdx,
	          shotIdx: groupIdx + 1,
	          shotIndices: freshShotIndices,
	          videoWarnings: warnings,
	          videoIsCurrent: false,
	        };
	        maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-submit-budget-blocked');
	        return { videoTasks, storyboards };
	      });
	      return codedError('video_duration_budget_blocked', TAIL_RUSHED_WARNING_MESSAGE, 400);
	    }
	  } else {
	    if (!prompt) return jsonError('缺 prompt', 400);
	  }

	  try {
	    try {
	      assertCanStartAssetGeneration(user.id);
        assertCanStartPaidOperation(user.id);
	    } catch (error: any) {
	      if (error instanceof AssetQuotaError) return jsonError(error.message, error.status);
        if (error instanceof InsufficientCreditsError) return jsonError(error.message, 402);
	      throw error;
	    }
    assetBatchId = createGenerationBatch({
      ownerId: user.id,
      projectId: projectId || null,
      shotUid: assetShotUid,
      legacyShotId: hasProjectContext ? `shot_${groupIdx}` : null,
      stage: projectId ? 'video_segment' : 'toolbox_video',
      requestedCount: 1,
      contextSnapshot: {
        route: 'api_video_submit',
        projectId: projectId || null,
	        groupIdx: hasProjectContext ? groupIdx : null,
	        submitMode,
	        payloadModeReason,
	        durationSec,
	        plannedDurationSec,
	        size: body.size || '1080x1920',
	      },
      source: projectId ? 'project' : 'toolbox',
    });
    if (projectId && project) {
      try {
        const cfg = resolveLLMConfig(user, 'video');
        const context = buildKnowledgeContextForStage({
          ownerId: user.id,
          project: {
            ...(project as any),
            id: projectId,
          },
          stage: 'video_submit',
          provider: cfg.provider || cfg.mode,
	          stageTarget: {
	            groupIdx: Number.isInteger(groupIdx) ? groupIdx : null,
	            durationSec,
	            plannedDurationSec,
	            size: body.size || '1080x1920',
            resolution: body.resolution || body.quality || null,
            promptHash: shortKnowledgeHash(prompt),
            submitMode,
            payloadModeReason,
            requestPath: 'api_video_submit',
          },
        });
        recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context });
      } catch (error) {
	        console.warn('[video/submit] knowledge context audit skipped:', error);
	      }
	    }
	    if (projectId && project && tempoBudget) {
	      patchProjectForUser(projectId, user.id, (fresh) => {
	        if (!fresh) return null;
	        const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	        videoTasks[groupIdx] = {
	          ...(videoTasks[groupIdx] || {}),
	          groupIdx,
	          status: 'submitting',
	          durationSec,
	          plannedDurationSec,
	          tempoBudget,
	          prompt,
	          warnings: [],
	          isCurrent: true,
	        };
	        return { videoTasks };
	      });
	    }
	    const result = await generateVideo(user, {
	      prompt,
	      size: body.size || '1080x1920',
	      resolution: body.resolution || body.quality,
	      generateAudio: normalizeGenerateAudio(body.generateAudio ?? body.genAudio, true),
		      durationSec,
		      shotPlan,
		      dialoguePairs,
		      tempoBudget,
		      projectId: projectId || undefined,
	      groupIdx: hasProjectContext ? groupIdx : undefined,
	      videoPromptSourceHash,
	      referenceImagePath,
      referenceImageRole,
      sceneReferencePath,
      characterReferencePaths,
      propReferencePaths,
      referenceImages,
      seedanceImageMode,
      payloadModeReason,
      firstLastFrameMode,
      assetLibrary: {
        batchId: assetBatchId,
        stage: projectId ? 'video_segment' : 'toolbox_video',
        source: projectId ? 'generated' : 'toolbox',
        shotUid: assetShotUid,
        legacyShotId: hasProjectContext ? `shot_${groupIdx}` : null,
        makeCurrent: !!projectId,
      },
    });
	    const referenceWarnings = result.videoAudit?.fallbackReason
	      ? [{ message: '参考图提交失败，请检查图片或重试' }]
	      : [];
	    const returnedWarnings = 'videoWarnings' in result ? (result.videoWarnings || []) : [];
	    const warnings = [...referenceWarnings, ...returnedWarnings];
	    if (result.status === 'upstream_pending') {
	      return jsonOk({
        ok: true,
        taskId: result.taskId,
        status: result.status,
        provider: result.provider,
	        providerTaskId: result.providerTaskId,
	        durationSec: result.durationSec,
	        mode: result.mode,
	        plannedDurationSec,
	        tempoBudget,
	        warnings,
	      });
	    }
	    if (projectId && project && tempoBudget) {
	      patchProjectForUser(projectId, user.id, (fresh) => {
	        if (!fresh) return null;
	        const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
	        const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
	        const currentSb = storyboards[groupIdx] || {};
		        const freshShotIndices = storyboardShotIndices(fresh, groupIdx, currentSb, {
		          mode: 'single-shot-strict',
		          explicitShotIndices: projectGroupShotIndices,
		        });
	        videoTasks[groupIdx] = {
	          ...(videoTasks[groupIdx] || {}),
	          groupIdx,
	          taskId: result.taskId,
	          status: result.status === 'completed' ? 'completed' : 'failed',
	          url: result.protectedUrl,
	          coverUrl: result.coverUrl,
	          durationSec: result.durationSec,
	          plannedDurationSec,
	          tempoBudget,
	          prompt,
	          warnings,
	          isCurrent: result.status === 'completed',
	        };
	        storyboards[groupIdx] = {
	          ...currentSb,
	          idx: groupIdx,
	          shotIdx: groupIdx + 1,
	          shotIndices: freshShotIndices,
	          videoUrl: result.protectedUrl,
	          videoTaskId: result.taskId,
	          videoDurationSec: result.durationSec,
	          plannedDurationSec,
	          videoWarnings: warnings,
	          videoIsCurrent: result.status === 'completed',
	        };
	        maybeAssertStoryboardsAlignedWithShots({ ...fresh, storyboards, videoTasks }, 'video-submit-complete-writeback');
	        return { videoTasks, storyboards };
	      });
	    }
	    return jsonOk({
      ok: true,
      taskId: result.taskId,
      status: result.status,
      url: result.url,
	      coverUrl: result.coverUrl,
	      durationSec: result.durationSec,
	      plannedDurationSec,
	      tempoBudget,
	      mode: result.mode,
	      warnings,
	    });
  } catch (e: any) {
    if (assetBatchId) {
      recordGenerationFailure({
        batchId: assetBatchId,
        ownerId: user.id,
        failureReason: 'provider_error',
        errorMessage: e?.message || String(e),
      });
      finishGenerationBatch(assetBatchId, user.id, 'failed');
    }
    const status = Number(e?.status || e?.statusCode || 502);
    return jsonError('视频生成失败：' + (e?.message || String(e)), Number.isFinite(status) ? status : 502);
  }
}
