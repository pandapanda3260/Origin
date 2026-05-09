export type ReferenceStatus = 'ready' | 'degraded' | 'missing' | 'failed' | 'legacy_sketch_only';

export type FirstFrameHistoryItem = {
  url: string;
  at: string;
  source: 'generated' | 'last_known_good';
};

export type FirstFrameState = {
  currentUrl?: string;
  rawUrl?: string;
  status: ReferenceStatus;
  source: 'generated' | 'last_known_good';
  lastKnownGoodUrl?: string;
  lastError?: any;
  history: FirstFrameHistoryItem[];
};

function cleanUrl(value: any): string {
  return String(value || '').trim();
}

export function resolveStoryboardFirstFrameUrl(storyboard: any): string {
  return cleanUrl(
    storyboard?.firstFrame?.currentUrl ||
      storyboard?.firstFrameUrl ||
      storyboard?.url ||
      storyboard?.imageUrl ||
      storyboard?.rawUrl,
  );
}

export function normalizeFirstFrameState(storyboard: any): FirstFrameState {
  const existing = storyboard?.firstFrame && typeof storyboard.firstFrame === 'object'
    ? storyboard.firstFrame
    : {};
  const currentUrl = cleanUrl(existing.currentUrl || resolveStoryboardFirstFrameUrl(storyboard));
  const lastKnownGoodUrl = cleanUrl(existing.lastKnownGoodUrl || currentUrl);
  const legacyError = storyboard?.firstFrameLastError
    ? {
        message: storyboard.firstFrameLastError,
        failedAt: storyboard.firstFrameFailedAt,
      }
    : undefined;
  const lastError = existing.lastError || legacyError;
  const status: ReferenceStatus = existing.status ||
    (currentUrl ? (lastError ? 'degraded' : 'ready') : (lastError ? 'failed' : 'missing'));
  const history = Array.isArray(existing.history)
    ? existing.history.filter((item: any) => cleanUrl(item?.url))
    : Array.isArray(storyboard?.imageHistory)
      ? storyboard.imageHistory
          .map((item: any) => ({
            url: cleanUrl(item?.url),
            at: item?.at ? new Date(item.at).toISOString() : new Date(0).toISOString(),
            source: 'generated' as const,
          }))
          .filter((item: FirstFrameHistoryItem) => cleanUrl(item.url))
      : [];

  return {
    currentUrl: currentUrl || undefined,
    rawUrl: cleanUrl(existing.rawUrl || storyboard?.rawUrl) || undefined,
    status,
    source: existing.source === 'last_known_good' ? 'last_known_good' : 'generated',
    lastKnownGoodUrl: lastKnownGoodUrl || undefined,
    lastError,
    history,
  };
}

export function markFirstFrameReady(storyboard: any, url: string, rawUrl = url): FirstFrameState {
  const prev = normalizeFirstFrameState(storyboard);
  const at = new Date().toISOString();
  const generatedItem: FirstFrameHistoryItem = { url, at, source: 'generated' };
  const history: FirstFrameHistoryItem[] = [
    generatedItem,
    ...prev.history.filter((item) => item.url !== url),
  ].slice(0, 20);
  return {
    currentUrl: url,
    rawUrl,
    status: 'ready',
    source: 'generated',
    lastKnownGoodUrl: url,
    lastError: undefined,
    history,
  };
}

export function markFirstFrameFailed(storyboard: any, error: any): FirstFrameState {
  const prev = normalizeFirstFrameState(storyboard);
  const hasFallback = !!(prev.currentUrl || prev.lastKnownGoodUrl);
  return {
    ...prev,
    currentUrl: prev.currentUrl || prev.lastKnownGoodUrl,
    status: hasFallback ? 'degraded' : 'failed',
    source: hasFallback ? 'last_known_good' : prev.source,
    lastError: error,
  };
}

export function resolveAssetReferenceState(asset: any): {
  currentUrl?: string;
  lastKnownGoodUrl?: string;
  status: ReferenceStatus;
  effectiveDescription?: string;
} {
  const reference = asset?.reference && typeof asset.reference === 'object' ? asset.reference : {};
  const currentUrl = cleanUrl(reference.currentUrl || asset?.imageUrl || asset?.rawUrl);
  const lastKnownGoodUrl = cleanUrl(reference.lastKnownGoodUrl || currentUrl);
  const rawStatus = cleanUrl(reference.status);
  const status: ReferenceStatus =
    rawStatus === 'ready' || rawStatus === 'degraded' || rawStatus === 'missing' || rawStatus === 'failed'
      ? rawStatus
      : currentUrl
        ? 'ready'
        : 'missing';
  const effectiveDescription = cleanUrl(
    asset?.effectiveVisualDescription?.effectiveText ||
      asset?.visualAnchorDescription?.effectiveText ||
      asset?.description ||
      asset?.features ||
      asset?.appearance,
  );
  return {
    currentUrl: currentUrl || undefined,
    lastKnownGoodUrl: lastKnownGoodUrl || undefined,
    status,
    effectiveDescription: effectiveDescription || undefined,
  };
}

export function isBlockingReferenceStatus(status: ReferenceStatus): boolean {
  return status === 'missing' || status === 'failed' || status === 'legacy_sketch_only';
}
