import type { UserRow } from './db';
import { resolveLLMConfig } from './llm';
import { resolveLocalImagePath, type ImageGenInput } from './image-gen';
import { generateImageWithModerationRecovery } from './safe-image-gen';
import {
  applyPropViewWrite,
  normalizePropDimensionality,
  splitPropViews,
  type SplitPropViewsResult,
} from './prop-views';
import {
  buildCustomPropImagePrompt,
  type CustomPropSourceType,
} from './custom-prop-prompt';

type FailedSplitPropViewsResult = Extract<SplitPropViewsResult, { ok: false }>;

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

function customPropImageInput(args: {
  user: UserRow;
  prompt: string;
  projectId?: string | null;
  assetRef: string;
  isVolumetric: boolean;
  referenceImagePath?: string | null;
  source?: string;
  styleLockContext: ReturnType<typeof buildCustomPropImagePrompt>['styleLockContext'];
}): ImageGenInput {
  return {
    prompt: args.prompt,
    size: args.isVolumetric ? '1536x1024' : '1024x1024',
    style: 'natural',
    kind: 'prop',
    projectId: args.projectId || undefined,
    assetRef: args.assetRef,
    quality: 'medium',
    storageStyle: args.isVolumetric ? 'prop-view-sheet' : undefined,
    referenceImagePath: args.referenceImagePath || undefined,
    styleLockApplied: args.styleLockContext.hasMeaningfulStyle,
    styleBackdropColor: args.styleLockContext.resolvedBackdropColor,
    imageAuditMetadata: {
      styleBibleSignature: args.styleLockContext.signature,
      styleBibleSignatureType: args.styleLockContext.signatureType,
      resolvedBackdropColor: args.styleLockContext.resolvedBackdropColor || null,
      styleLockVersion: args.styleLockContext.styleLockVersion,
      source: args.source || 'custom_prop',
      dimensionality: args.isVolumetric ? 'volumetric' : 'flat',
    },
    assetLibrary: {
      stage: 'custom_prop',
      source: 'generated',
      makeCurrent: false,
    },
  };
}

function failedSplitPropData(existing: any, resultUrl: string, splitResult: FailedSplitPropViewsResult, now = new Date().toISOString()) {
  const next: any = {
    ...(existing || {}),
    views: splitResult.views || undefined,
    viewsError: splitResult.error,
    viewsErrorAt: now,
    reference: {
      ...((existing && existing.reference) || {}),
      status: 'failed',
      source: 'generated_sheet',
      lastAttemptUrl: resultUrl,
      lastFailedAt: now,
      updatedAt: now,
      lastError: {
        reason: 'custom_prop_split_failed',
        message: splitResult.error,
      },
    },
    imageLastError: splitResult.error,
    imageFailedAt: now,
  };
  delete next.imageUrl;
  delete next.rawUrl;
  delete next.originalUrl;
  delete next.displayUrl;
  if (next.reference) {
    delete next.reference.currentUrl;
    delete next.reference.lastKnownGoodUrl;
  }
  return next;
}

export async function generateCustomPropImage(args: {
  user: UserRow;
  fields: any;
  styleBible?: any;
  projectId?: string | null;
  assetRef: string;
  sourceType: CustomPropSourceType;
  referenceImagePath?: string | null;
  version?: number;
}) {
  const { prompt, styleLockContext, dimensionality } = buildCustomPropImagePrompt({
    fields: args.fields,
    styleBible: args.styleBible || {},
    sourceType: args.sourceType,
  });
  const propDimensionality = normalizePropDimensionality(dimensionality, args.fields);
  const isVolumetric = propDimensionality === 'volumetric';
  const result = await generateImageWithModerationRecovery(args.user, customPropImageInput({
    user: args.user,
    prompt,
    projectId: args.projectId,
    assetRef: args.assetRef,
    isVolumetric,
    referenceImagePath: args.referenceImagePath,
    source: 'custom_prop_generate',
    styleLockContext,
  }));
  const basePropData: any = {
    ...(args.fields || {}),
    dimensionality: propDimensionality,
    imagePrompt: prompt,
    submittedImagePrompt: result.submittedPrompt,
    imageSafetyAudit: result.safetyAudit,
    effectiveVisualDescription: result.visualAnchorDescription,
  };

  if (!isVolumetric) {
    const now = new Date().toISOString();
    return {
      result,
      prompt,
      styleLockContext,
      splitResult: null,
      propData: {
        ...basePropData,
        imageUrl: result.url,
        rawUrl: result.url,
        assetId: result.id,
        imageGeneratedAt: now,
        reference: {
          ...((basePropData && basePropData.reference) || {}),
          currentUrl: result.url,
          lastKnownGoodUrl: result.url,
          status: 'ready',
          updatedAt: now,
          styleBibleSignature: styleLockContext.signature,
          styleLockVersion: styleLockContext.styleLockVersion,
          resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
        },
      },
      referenceStatus: 'ready',
      accepted: true,
    };
  }

  const priorVersion = Number(args.fields?.viewsVersion || args.fields?.views?.version || 0);
  const splitResult = await splitPropViews({
    user: args.user,
    projectId: args.projectId,
    assetRef: args.assetRef,
    sourceImageUrl: result.url,
    prompt: result.submittedPrompt,
    version: args.version || (Number.isFinite(priorVersion) ? priorVersion : 0) + 1,
  });
  const propData = splitResult.ok
    ? applyPropViewWrite(basePropData, {
        splitResult,
        sourceImageUrl: result.url,
        imagePrompt: prompt,
        submittedImagePrompt: result.submittedPrompt,
        imageSafetyAudit: result.safetyAudit,
        effectiveVisualDescription: result.visualAnchorDescription,
        styleBibleSignature: styleLockContext.signature,
        styleLockVersion: styleLockContext.styleLockVersion,
        resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
      })
    : failedSplitPropData(basePropData, result.url, splitResult);

  return {
    result,
    prompt,
    styleLockContext,
    splitResult,
    propData,
    referenceStatus: splitResult.ok ? 'ready' : 'split_failed',
    accepted: splitResult.ok,
  };
}

export function referenceImagePathForProp(propData: any, ownerId: number) {
  const url = String(propData?.reference?.currentUrl || propData?.reference?.lastKnownGoodUrl || propData?.imageUrl || propData?.rawUrl || '').trim();
  return resolveLocalImagePath(url, ownerId) || undefined;
}
