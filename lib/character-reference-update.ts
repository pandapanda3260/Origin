import {
  applyCharacterPanelResult,
  type CharacterEntityType,
  type PanelName,
  type SplitCharacterPanelsResult,
} from './character-panels';

type GeneratedImageLike = {
  url: string;
  id?: string;
};

export type CharacterReferenceStyleMeta = {
  styleBibleSignature?: string;
  styleLockVersion?: number;
  resolvedBackdropColor?: string;
};

export type CharacterReferenceFailureError = {
  reason: 'character_panel_split_failed';
  cropMethod?: string;
  confidence?: number;
  quality?: Record<string, unknown>;
  unusablePanels: string[];
  message?: string;
};

export type CharacterReferenceStatus = 'ready' | 'degraded' | 'failed';

export type CharacterReferenceLockUpdate = {
  sheetUrl?: string;
  headshotUrl?: string;
  frontUrl?: string;
  sideUrl?: string;
  backUrl?: string;
  sourceImageId?: string;
  referenceStatus: CharacterReferenceStatus;
  qualityScore?: number;
};

type PreviousReferenceLockLike = Partial<Omit<CharacterReferenceLockUpdate, 'referenceStatus'>> & {
  referenceStatus?: CharacterReferenceStatus | 'missing';
};

export type CharacterReferenceUpdate = {
  accepted: boolean;
  referenceStatus: CharacterReferenceStatus;
  nextAsset: any;
  referenceLock?: CharacterReferenceLockUpdate;
  lastError?: CharacterReferenceFailureError;
};

export const READY_PANEL_CONFIDENCE = 0.85;

function requiredPanelNames(entityType: CharacterEntityType): PanelName[] {
  return entityType === 'non-human'
    ? ['front', 'side', 'back']
    : ['headshot', 'front', 'side', 'back'];
}

function unusablePanelNames(result: SplitCharacterPanelsResult | null | undefined, entityType: CharacterEntityType): string[] {
  if (!result?.ok) return requiredPanelNames(entityType);
  const quality = result.panels.quality || {};
  return requiredPanelNames(entityType).filter((name) => !quality[name]?.usable);
}

function buildSplitFailureError(
  result: SplitCharacterPanelsResult | null | undefined,
  entityType: CharacterEntityType,
): CharacterReferenceFailureError {
  if (!result) {
    return {
      reason: 'character_panel_split_failed',
      unusablePanels: requiredPanelNames(entityType),
      message: 'missing panel split result',
    };
  }
  if (!result.ok) {
    return {
      reason: 'character_panel_split_failed',
      unusablePanels: requiredPanelNames(entityType),
      message: result.error,
    };
  }
  return {
    reason: 'character_panel_split_failed',
    cropMethod: result.panels.cropMethod,
    confidence: result.panels.confidence,
    quality: result.panels.quality || {},
    unusablePanels: unusablePanelNames(result, entityType),
  };
}

export function isAcceptedCharacterPanelResult(
  result: SplitCharacterPanelsResult | null | undefined,
  _entityType: CharacterEntityType,
): result is Extract<SplitCharacterPanelsResult, { ok: true }> {
  return result?.ok === true;
}

function classifyCharacterPanelResult(
  result: SplitCharacterPanelsResult | null | undefined,
  _entityType: CharacterEntityType,
): 'ready' | 'failed' {
  return result?.ok === true ? 'ready' : 'failed';
}

function cleanReferenceSuccess(reference: any) {
  if (!reference || typeof reference !== 'object') return reference;
  delete reference.lastAttemptUrl;
  delete reference.lastFailedAt;
  delete reference.lastError;
  return reference;
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function hasUrl(value: unknown): boolean {
  return !!cleanText(value);
}

function firstCleanUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const url = cleanText(value);
    if (url) return url;
  }
  return undefined;
}

function hasAnyPanelUrl(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  return ['sheetUrl', 'headshotUrl', 'frontUrl', 'sideUrl', 'backUrl'].some((key) => hasUrl(value[key]));
}

function normalizeEntityType(value: unknown): CharacterEntityType | undefined {
  const text = cleanText(value).toLowerCase();
  if (!text) return undefined;
  if (text === 'non-human' || text === 'nonhuman' || text.includes('非人')) return 'non-human';
  if (text === 'human' || text.includes('人物') || text.includes('人类')) return 'human';
  return undefined;
}

function panelSchemaEntityType(value: any): CharacterEntityType | undefined {
  const schema = cleanText(value?.schema).toLowerCase();
  if (!schema) return undefined;
  if (schema.includes('non-human') || schema.includes('nonhuman')) return 'non-human';
  if (schema.includes('human-character')) return 'human';
  return undefined;
}

function reusableReferenceLock(previousReferenceLock?: PreviousReferenceLockLike): PreviousReferenceLockLike | undefined {
  if (!previousReferenceLock || !hasAnyPanelUrl(previousReferenceLock)) return undefined;
  if (previousReferenceLock.referenceStatus === 'missing' || previousReferenceLock.referenceStatus === 'failed') return undefined;
  return previousReferenceLock;
}

function canReusePreviousCharacterReference(previous: any, entityType: CharacterEntityType): boolean {
  const previousEntity = normalizeEntityType(previous?.entityType || previous?.identityLock?.entityType);
  if (previousEntity && previousEntity !== entityType) return false;
  const schemaEntity = panelSchemaEntityType(previous?.panels);
  if (schemaEntity && schemaEntity !== entityType) return false;
  const referenceStatus = previous?.reference?.status;
  if (referenceStatus === 'missing' || referenceStatus === 'failed') return false;
  return true;
}

function oldGoodReferenceUrl(previous: any, previousReferenceLock?: PreviousReferenceLockLike): string | undefined {
  const reference = previous?.reference || {};
  const panels = previous?.panels || {};
  return firstCleanUrl(
    reference.lastKnownGoodUrl,
    reference.currentUrl,
    previous?.imageUrl,
    previous?.rawUrl,
    previous?.realPhotoUrl,
    previous?.pencilUrl,
    panels.sheetUrl,
    previousReferenceLock?.sheetUrl,
    panels.headshotUrl,
    panels.frontUrl,
    panels.sideUrl,
    panels.backUrl,
    previousReferenceLock?.headshotUrl,
    previousReferenceLock?.frontUrl,
    previousReferenceLock?.sideUrl,
    previousReferenceLock?.backUrl,
  );
}

function hasOldGoodReference(previous: any, previousReferenceLock?: PreviousReferenceLockLike): boolean {
  const reference = previous?.reference || {};
  return hasUrl(reference.lastKnownGoodUrl)
    || hasUrl(reference.currentUrl)
    || hasUrl(previous?.imageUrl)
    || hasUrl(previous?.rawUrl)
    || hasUrl(previous?.realPhotoUrl)
    || hasUrl(previous?.pencilUrl)
    || hasAnyPanelUrl(previous?.panels)
    || hasAnyPanelUrl(previousReferenceLock);
}

function inferPreservedReferenceStatus(previous: any, previousReferenceLock?: PreviousReferenceLockLike): Extract<CharacterReferenceStatus, 'ready' | 'degraded'> {
  const lockStatus = previousReferenceLock?.referenceStatus;
  if (lockStatus === 'ready' || lockStatus === 'degraded') return lockStatus;
  const refStatus = previous?.reference?.status;
  if (refStatus === 'ready' || refStatus === 'degraded') return refStatus;
  const score = Number(
    previousReferenceLock?.qualityScore ??
    previous?.panels?.confidence ??
    previous?.reference?.qualityScore,
  );
  if (Number.isFinite(score) && score >= READY_PANEL_CONFIDENCE) return 'ready';
  return 'degraded';
}

function repairedReferenceLock(
  previousReferenceLock: PreviousReferenceLockLike | undefined,
  preservedStatus: Extract<CharacterReferenceStatus, 'ready' | 'degraded'>,
): CharacterReferenceLockUpdate | undefined {
  if (!previousReferenceLock || !hasAnyPanelUrl(previousReferenceLock)) return undefined;
  if (previousReferenceLock.referenceStatus === 'ready' || previousReferenceLock.referenceStatus === 'degraded') {
    return undefined;
  }
  return {
    sheetUrl: previousReferenceLock.sheetUrl,
    headshotUrl: previousReferenceLock.headshotUrl,
    frontUrl: previousReferenceLock.frontUrl,
    sideUrl: previousReferenceLock.sideUrl,
    backUrl: previousReferenceLock.backUrl,
    sourceImageId: previousReferenceLock.sourceImageId,
    referenceStatus: preservedStatus,
    qualityScore: previousReferenceLock.qualityScore,
  };
}

export function deriveCharacterReferenceUpdate(
  prevAsset: any,
  generated: GeneratedImageLike,
  panelResult: SplitCharacterPanelsResult | null | undefined,
  entityType: CharacterEntityType,
  styleMeta: CharacterReferenceStyleMeta = {},
  nowIso = new Date().toISOString(),
  previousReferenceLock?: PreviousReferenceLockLike,
): CharacterReferenceUpdate {
  const previous = prevAsset && typeof prevAsset === 'object' ? prevAsset : {};
  const referenceStatus = classifyCharacterPanelResult(panelResult, entityType);
  const accepted = referenceStatus !== 'failed';
  if (accepted) {
    const okPanelResult = panelResult as Extract<SplitCharacterPanelsResult, { ok: true }>;
    const withPanels = applyCharacterPanelResult(previous, okPanelResult, nowIso);
    const reference = cleanReferenceSuccess({
      ...(withPanels.reference || {}),
      currentUrl: generated.url,
      lastKnownGoodUrl: generated.url,
      status: referenceStatus,
      updatedAt: nowIso,
      styleBibleSignature: styleMeta.styleBibleSignature,
      styleLockVersion: styleMeta.styleLockVersion,
      resolvedBackdropColor: styleMeta.resolvedBackdropColor,
    });
    const panels = withPanels.panels || {};
    const nextAsset = {
      ...withPanels,
      imageUrl: generated.url,
      rawUrl: generated.url,
      realPhotoUrl: generated.url,
      pencilUrl: generated.url,
      skippedStylize: true,
      reference,
      imageGeneratedAt: nowIso,
    };
    delete nextAsset.imageLastError;
    delete nextAsset.imageFailedAt;
    delete nextAsset.panelsError;
    delete nextAsset.panelsErrorAt;
    return {
      accepted: true,
      referenceStatus,
      nextAsset,
      referenceLock: {
        sheetUrl: panels.sheetUrl || generated.url,
        headshotUrl: panels.headshotUrl,
        frontUrl: panels.frontUrl,
        sideUrl: panels.sideUrl,
        backUrl: panels.backUrl,
        sourceImageId: panels.sourceImageId || generated.id,
        referenceStatus,
        qualityScore: okPanelResult.panels.confidence,
      },
    };
  }

  const lastError = buildSplitFailureError(panelResult, entityType);
  const previousReusable = canReusePreviousCharacterReference(previous, entityType);
  const lockReusable = reusableReferenceLock(previousReferenceLock);
  const preservedUrl = previousReusable ? oldGoodReferenceUrl(previous, lockReusable) : undefined;
  const oldGoodAvailable = previousReusable && (!!preservedUrl || hasOldGoodReference(previous, lockReusable));
  const preservedStatus = oldGoodAvailable
    ? inferPreservedReferenceStatus(previous, lockReusable)
    : 'failed';
  const preservedLockUpdate = oldGoodAvailable && preservedStatus !== 'failed'
    ? repairedReferenceLock(lockReusable, preservedStatus)
    : undefined;
  const reference = {
    ...(previous.reference || {}),
    status: preservedStatus,
    updatedAt: nowIso,
    styleBibleSignature: styleMeta.styleBibleSignature,
    styleLockVersion: styleMeta.styleLockVersion,
    resolvedBackdropColor: styleMeta.resolvedBackdropColor,
    lastAttemptUrl: generated.url,
    lastFailedAt: nowIso,
    lastError,
  };
  if (preservedUrl) {
    if (!hasUrl(reference.currentUrl)) reference.currentUrl = preservedUrl;
    if (!hasUrl(reference.lastKnownGoodUrl)) reference.lastKnownGoodUrl = preservedUrl;
  } else if (!oldGoodAvailable) {
    delete reference.currentUrl;
    delete reference.lastKnownGoodUrl;
  }
  const nextAsset = {
    ...previous,
    reference,
  };
  if (oldGoodAvailable) {
    if (preservedUrl) {
      if (!hasUrl(nextAsset.imageUrl)) nextAsset.imageUrl = preservedUrl;
      if (!hasUrl(nextAsset.rawUrl)) nextAsset.rawUrl = preservedUrl;
      if (!hasUrl(nextAsset.realPhotoUrl)) nextAsset.realPhotoUrl = preservedUrl;
    }
    delete nextAsset.panelsError;
    delete nextAsset.panelsErrorAt;
  } else {
    delete nextAsset.imageUrl;
    delete nextAsset.rawUrl;
    delete nextAsset.realPhotoUrl;
    delete nextAsset.pencilUrl;
    delete nextAsset.originalUrl;
    delete nextAsset.displayUrl;
    delete nextAsset.thumbUrl;
    delete nextAsset.pencilOriginalUrl;
    delete nextAsset.pencilDisplayUrl;
    delete nextAsset.pencilThumbUrl;
    delete nextAsset.panels;
    nextAsset.panelsError = lastError.message || lastError.reason;
    nextAsset.panelsErrorAt = nowIso;
  }
  delete nextAsset.imageLastError;
  delete nextAsset.imageFailedAt;
  return {
    accepted: false,
    referenceStatus: preservedStatus,
    nextAsset,
    referenceLock: oldGoodAvailable ? preservedLockUpdate : { referenceStatus: 'failed' },
    lastError,
  };
}
