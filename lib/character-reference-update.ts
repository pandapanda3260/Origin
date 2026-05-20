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
  unusablePanels: string[];
  message?: string;
};

export type CharacterReferenceUpdate = {
  accepted: boolean;
  nextAsset: any;
  referenceLock: {
    sheetUrl?: string;
    headshotUrl?: string;
    frontUrl?: string;
    sideUrl?: string;
    backUrl?: string;
    sourceImageId?: string;
    referenceStatus: 'ready' | 'failed';
    qualityScore?: number;
  };
  lastError?: CharacterReferenceFailureError;
};

const READY_PANEL_CONFIDENCE = 0.85;

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
    unusablePanels: unusablePanelNames(result, entityType),
  };
}

export function isAcceptedCharacterPanelResult(
  result: SplitCharacterPanelsResult | null | undefined,
  entityType: CharacterEntityType,
): result is Extract<SplitCharacterPanelsResult, { ok: true }> {
  if (!result?.ok) return false;
  if (result.panels.cropMethod !== 'pixel-detect') return false;
  if (result.panels.confidence < READY_PANEL_CONFIDENCE) return false;
  return unusablePanelNames(result, entityType).length === 0;
}

function cleanReferenceSuccess(reference: any) {
  if (!reference || typeof reference !== 'object') return reference;
  delete reference.lastAttemptUrl;
  delete reference.lastFailedAt;
  delete reference.lastError;
  return reference;
}

export function deriveCharacterReferenceUpdate(
  prevAsset: any,
  generated: GeneratedImageLike,
  panelResult: SplitCharacterPanelsResult | null | undefined,
  entityType: CharacterEntityType,
  styleMeta: CharacterReferenceStyleMeta = {},
  nowIso = new Date().toISOString(),
): CharacterReferenceUpdate {
  const previous = prevAsset && typeof prevAsset === 'object' ? prevAsset : {};
  const accepted = isAcceptedCharacterPanelResult(panelResult, entityType);
  if (accepted) {
    const withPanels = applyCharacterPanelResult(previous, panelResult, nowIso);
    const reference = cleanReferenceSuccess({
      ...(withPanels.reference || {}),
      currentUrl: generated.url,
      lastKnownGoodUrl: generated.url,
      status: 'ready',
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
    return {
      accepted: true,
      nextAsset,
      referenceLock: {
        sheetUrl: panels.sheetUrl || generated.url,
        headshotUrl: panels.headshotUrl,
        frontUrl: panels.frontUrl,
        sideUrl: panels.sideUrl,
        backUrl: panels.backUrl,
        sourceImageId: panels.sourceImageId || generated.id,
        referenceStatus: 'ready',
        qualityScore: panelResult.panels.confidence,
      },
    };
  }

  const lastError = buildSplitFailureError(panelResult, entityType);
  const reference = {
    ...(previous.reference || {}),
    status: 'failed',
    updatedAt: nowIso,
    styleBibleSignature: styleMeta.styleBibleSignature,
    styleLockVersion: styleMeta.styleLockVersion,
    resolvedBackdropColor: styleMeta.resolvedBackdropColor,
    lastAttemptUrl: generated.url,
    lastFailedAt: nowIso,
    lastError,
  };
  const nextAsset = {
    ...previous,
    reference,
    panelsError: lastError.message || lastError.reason,
    panelsErrorAt: nowIso,
  };
  delete nextAsset.imageLastError;
  delete nextAsset.imageFailedAt;
  return {
    accepted: false,
    nextAsset,
    referenceLock: {
      referenceStatus: 'failed',
    },
    lastError,
  };
}
