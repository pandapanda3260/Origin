import type { UserRow } from './db';
import { resolveLLMConfig } from './llm';
import { resolveLocalImagePath, type ImageGenInput } from './image-gen';
import { generateImageWithModerationRecovery } from './safe-image-gen';
import {
  applySceneViewWrite,
  resolveSceneImageUrl,
  type SceneViewRole,
} from './scene-views';
import {
  buildSceneViewQualityRetryPrompt,
  evaluateSceneViewQuality,
  SCENE_VIEW_QUALITY_MAX_RETRIES,
  shouldEvaluateSceneViewQuality,
  type SceneViewQualityCheckResult,
  type SceneViewQualityRole,
} from './scene-view-quality';
import {
  buildCustomSceneImagePrompt,
  sceneQualityMetadata,
  type CustomSceneSourceType,
} from './custom-scene-prompt';
import type { TokenUsageContext } from './token-usage';

export function supportsReferenceImageGeneration(cfg: any): boolean {
  const provider = String(cfg?.provider || '');
  const model = String(cfg?.model || '').toLowerCase();
  return provider === 'volcengine_seedream' || model.includes('gpt-image') || model.includes('dall-e-2');
}

export function assertReferenceImageGenerationSupported(user: UserRow) {
  const cfg = resolveLLMConfig(user, 'image');
  if (cfg.mode === 'real' && supportsReferenceImageGeneration(cfg)) return;
  const provider = String(cfg?.provider || cfg?.mode || 'unknown');
  const model = String(cfg?.model || 'unknown');
  throw new Error(`当前图片模型不支持参考图生成：${provider}/${model}。请切换为 gpt-image、dall-e-2 或 Seedream 图片模型后重试`);
}

export type SceneCustomReferencePlan = {
  referenceImagePath?: string;
  referenceImagePaths?: string[];
  sceneViewReferenceRoles: string[];
  sceneViewReferenceDependency?: string;
};

export function sceneCustomReferencePathsForRole(sceneData: any, role: SceneViewRole, ownerId: number): SceneCustomReferencePlan {
  if (role === 'establishing') {
    return {
      sceneViewReferenceRoles: [],
      sceneViewReferenceDependency: 'none',
    };
  }
  const urls: string[] = [];
  const establishingUrl = resolveSceneImageUrl(sceneData, {
    strategy: 'videoManifest',
    gate: true,
    viewRole: 'establishing',
  });
  if (establishingUrl) urls.push(establishingUrl);
  if (role === 'reverse' || role === 'alt') {
    const topdownUrl = resolveSceneImageUrl(sceneData, {
      strategy: 'videoManifest',
      gate: true,
      viewRole: 'topdown',
    });
    if (topdownUrl && topdownUrl !== establishingUrl) urls.push(topdownUrl);
  }
  const referenceImagePaths = urls
    .map((url) => resolveLocalImagePath(url, ownerId) || '')
    .filter(Boolean);
  const referenceImagePath = referenceImagePaths[0] || undefined;
  const sceneViewReferenceRoles = referenceImagePath ? ['establishing'] : [];
  let sceneViewReferenceDependency: string | undefined;
  if (role === 'reverse' || role === 'alt') {
    if (referenceImagePaths[1]) {
      sceneViewReferenceRoles.push('topdown');
      sceneViewReferenceDependency = 'topdown_ready';
    } else {
      sceneViewReferenceDependency = 'degraded_no_topdown';
    }
  } else {
    sceneViewReferenceDependency = referenceImagePath ? 'establishing_only' : undefined;
  }
  return {
    referenceImagePath,
    referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
    sceneViewReferenceRoles,
    sceneViewReferenceDependency,
  };
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

function errorSceneViewQualitySummary(viewRole: SceneViewQualityRole, err: any, attempt: number) {
  return {
    attempt,
    status: 'error',
    decision: 'accept',
    score: null,
    threshold: null,
    reasons: [`场景副视图一致性评分失败：${String(err?.message || err).slice(0, 220)}`],
    retryPromptHint: undefined,
    model: undefined,
    provider: undefined,
    checkedAt: new Date().toISOString(),
    imageUrl: undefined,
    viewRole,
  };
}

function sceneViewQualityAuditFromAttempts(
  viewRole: SceneViewRole,
  attempts: Array<ReturnType<typeof sceneViewQualityAttemptSummary> | ReturnType<typeof errorSceneViewQualitySummary>>,
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

function customSceneImageInput(args: {
  user: UserRow;
  prompt: string;
  role: SceneViewRole;
  projectId?: string | null;
  assetRef: string;
  referencePlan?: SceneCustomReferencePlan;
  source?: string;
  styleLockContext: ReturnType<typeof buildCustomSceneImagePrompt>['styleLockContext'];
}): ImageGenInput {
  const referencePlan = args.referencePlan || { sceneViewReferenceRoles: [] };
  return {
    prompt: args.prompt,
    size: '1536x1024',
    style: 'natural',
    kind: 'scene',
    sceneViewRole: args.role,
    projectId: args.projectId || undefined,
    assetRef: args.assetRef,
    quality: 'medium',
    storageStyle: 'scene-view',
    referenceImagePath: referencePlan.referenceImagePath,
    referenceImagePaths: referencePlan.referenceImagePaths,
    styleLockApplied: args.styleLockContext.hasMeaningfulStyle,
    styleBackdropColor: args.styleLockContext.resolvedBackdropColor,
    imageAuditMetadata: {
      styleBibleSignature: args.styleLockContext.signature,
      styleBibleSignatureType: args.styleLockContext.signatureType,
      resolvedBackdropColor: args.styleLockContext.resolvedBackdropColor || null,
      styleLockVersion: args.styleLockContext.styleLockVersion,
      sceneViewReferenceCount: referencePlan.referenceImagePaths?.length || (referencePlan.referenceImagePath ? 1 : 0),
      sceneViewReferenceRoles: referencePlan.sceneViewReferenceRoles,
      sceneViewReferenceDependency: referencePlan.sceneViewReferenceDependency,
      source: args.source || 'custom_scene',
    },
    assetLibrary: {
      stage: 'custom_scene',
      source: 'generated',
      makeCurrent: false,
    },
  };
}

export async function generateCustomSceneEstablishing(args: {
  user: UserRow;
  fields: any;
  styleBible?: any;
  projectId?: string | null;
  assetRef: string;
  sourceType: CustomSceneSourceType;
  referenceImagePath?: string | null;
}) {
  const { prompt, styleLockContext } = buildCustomSceneImagePrompt({
    fields: args.fields,
    styleBible: args.styleBible || {},
    viewRole: 'establishing',
    sourceType: args.sourceType,
  });
  const referenceImagePath = args.referenceImagePath || undefined;
  const referencePlan: SceneCustomReferencePlan = {
    referenceImagePath,
    referenceImagePaths: referenceImagePath ? [referenceImagePath] : undefined,
    sceneViewReferenceRoles: referenceImagePath ? ['uploaded_reference'] : [],
    sceneViewReferenceDependency: referenceImagePath ? 'uploaded_reference' : 'none',
  };
  const result = await generateImageWithModerationRecovery(args.user, customSceneImageInput({
    user: args.user,
    prompt,
    role: 'establishing',
    projectId: args.projectId,
    assetRef: args.assetRef,
    referencePlan,
    source: 'custom_scene_establishing',
    styleLockContext,
  }));
  const sceneData = applySceneViewWrite(args.fields || {}, {
    role: 'establishing',
    imageUrl: result.url,
    rawUrl: result.url,
    imagePrompt: prompt,
    submittedImagePrompt: result.submittedPrompt,
    referenceStatus: 'ready',
    assetId: result.id,
    imageSafetyAudit: result.safetyAudit,
    effectiveVisualDescription: result.visualAnchorDescription,
    styleBibleSignature: styleLockContext.signature,
    styleLockVersion: styleLockContext.styleLockVersion,
    resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
    invalidateOtherViews: true,
  });
  return { result, sceneData, prompt, styleLockContext, referencePlan };
}

export async function generateCustomSceneFollowupView(args: {
  user: UserRow;
  sceneData: any;
  role: SceneViewQualityRole;
  styleBible?: any;
  projectId?: string | null;
  assetRef: string;
  tokenContext?: TokenUsageContext | null;
}) {
  const referencePlan = sceneCustomReferencePathsForRole(args.sceneData, args.role, args.user.id);
  if (!referencePlan.referenceImagePath) throw new Error(`scene_view_missing_establishing:custom_scene.views.${args.role}`);
  const { prompt, styleLockContext } = buildCustomSceneImagePrompt({
    fields: args.sceneData,
    styleBible: args.styleBible || {},
    viewRole: args.role,
    sourceType: 'image_prompt',
  });
  const imageInput = customSceneImageInput({
    user: args.user,
    prompt,
    role: args.role,
    projectId: args.projectId,
    assetRef: args.assetRef,
    referencePlan,
    source: 'custom_scene_followup',
    styleLockContext,
  });
  let result = await generateImageWithModerationRecovery(args.user, imageInput);
  const attempts: Array<ReturnType<typeof sceneViewQualityAttemptSummary> | ReturnType<typeof errorSceneViewQualitySummary>> = [];
  let qualityAudit: ReturnType<typeof sceneViewQualityAuditFromAttempts> | undefined;

  if (shouldEvaluateSceneViewQuality('scene', args.role)) {
    const evaluateCandidate = async (
      candidate: Awaited<ReturnType<typeof generateImageWithModerationRecovery>>,
      attempt: number,
    ): Promise<SceneViewQualityCheckResult> => {
      const candidateImagePath = resolveLocalImagePath(candidate.url, args.user.id) || undefined;
      return evaluateSceneViewQuality({
        user: args.user,
        viewRole: args.role,
        establishingImagePath: referencePlan.referenceImagePath,
        layoutAnchorImagePath: args.role === 'reverse' || args.role === 'alt' ? referencePlan.referenceImagePaths?.[1] : undefined,
        candidateImagePath,
        sceneName: args.sceneData?.name,
        scenePrompt: prompt,
        sceneMetadata: sceneQualityMetadata(args.sceneData),
        attempt,
        tokenContext: {
          ownerId: args.user.id,
          usernameSnapshot: args.user.phone || args.user.display_name || args.user.username || null,
          projectId: args.projectId || undefined,
          routeName: 'scene-custom.view-regenerate',
          moduleKey: 'assets',
          moduleLabel: '资产生成',
          featureKey: 'custom_scene_view_quality',
          featureLabel: '定制场景副视图一致性评分',
          callItemType: 'custom_scene_view',
          callItemId: args.assetRef,
          callItemLabel: `${args.sceneData?.name || 'custom_scene'}.views.${args.role}`,
          operationKey: `custom-scene:${args.assetRef}:scene-view-quality:${args.role}:${attempt}`,
          operationLabel: '定制场景副视图一致性评分',
          meta: {
            viewRole: args.role,
            attempt,
          },
          ...(args.tokenContext || {}),
        },
      });
    };

    try {
      const firstCheck = await evaluateCandidate(result, 0);
      attempts.push(sceneViewQualityAttemptSummary(0, firstCheck, result.url));
      if (firstCheck.decision === 'retry' && SCENE_VIEW_QUALITY_MAX_RETRIES >= 1) {
        try {
          const retryPrompt = buildSceneViewQualityRetryPrompt(prompt, firstCheck);
          const retryResult = await generateImageWithModerationRecovery(args.user, {
            ...imageInput,
            prompt: retryPrompt,
          });
          const retryCheck = await evaluateCandidate(retryResult, 1);
          attempts.push(sceneViewQualityAttemptSummary(1, retryCheck, retryResult.url));
          const firstScore = typeof firstCheck.score === 'number' ? firstCheck.score : -1;
          const retryScore = typeof retryCheck.score === 'number' ? retryCheck.score : Number.POSITIVE_INFINITY;
          if (retryCheck.status !== 'checked' || retryScore >= firstScore) result = retryResult;
        } catch (retryErr: any) {
          attempts.push(errorSceneViewQualitySummary(args.role, retryErr, 1));
        }
      }
    } catch (qualityErr: any) {
      attempts.push(errorSceneViewQualitySummary(args.role, qualityErr, 0));
    }
    qualityAudit = sceneViewQualityAuditFromAttempts(args.role, attempts, result.url);
  }

  const sceneData = applySceneViewWrite(args.sceneData || {}, {
    role: args.role,
    imageUrl: result.url,
    rawUrl: result.url,
    imagePrompt: prompt,
    submittedImagePrompt: result.submittedPrompt,
    referenceStatus: 'ready',
    assetId: result.id,
    imageSafetyAudit: result.safetyAudit,
    effectiveVisualDescription: result.visualAnchorDescription,
    styleBibleSignature: styleLockContext.signature,
    styleLockVersion: styleLockContext.styleLockVersion,
    resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
    qualityAudit,
  });
  return { result, sceneData, prompt, styleLockContext, referencePlan, qualityAudit };
}
