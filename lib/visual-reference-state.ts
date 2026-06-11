export type ReferenceStatus = 'ready' | 'degraded' | 'missing' | 'failed' | 'legacy_sketch_only';

export type FirstFrameHistoryItem = {
  url: string;
  at: string;
  source: 'generated' | 'last_known_good' | 'uploaded' | 'history_restore';
};

export type FirstFrameState = {
  currentUrl?: string;
  rawUrl?: string;
  status: ReferenceStatus;
  source: 'generated' | 'last_known_good' | 'uploaded' | 'history_restore';
  lastKnownGoodUrl?: string;
  lastError?: any;
  history: FirstFrameHistoryItem[];
};

function cleanUrl(value: any): string {
  return String(value || '').trim();
}

export function resolveStoryboardFirstFrameUrl(storyboard: any): string {
  return cleanUrl(
    storyboard?.frames?.first?.url ||
      storyboard?.firstFrameUrl ||
      storyboard?.firstFrame?.currentUrl,
  );
}

function normalizeFirstFrameSource(value: any): FirstFrameHistoryItem['source'] {
  const raw = cleanUrl(value);
  if (raw === 'last_known_good' || raw === 'uploaded' || raw === 'history_restore') return raw;
  return 'generated';
}

function firstFrameHistoryAt(storyboard: any, existing: any): string {
  const raw = existing?.generatedAt ||
    storyboard?.frames?.first?.generatedAt ||
    storyboard?.firstFrameGeneratedAt ||
    storyboard?.updatedAt;
  if (raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

export function normalizeFirstFrameState(storyboard: any): FirstFrameState {
  const existing = storyboard?.firstFrame && typeof storyboard.firstFrame === 'object'
    ? storyboard.firstFrame
    : {};
  const currentUrl = cleanUrl(resolveStoryboardFirstFrameUrl(storyboard) || existing.currentUrl);
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
            source: normalizeFirstFrameSource(item?.source),
          }))
          .filter((item: FirstFrameHistoryItem) => cleanUrl(item.url))
      : [];
  const currentSource = normalizeFirstFrameSource(
    existing.source ||
      storyboard?.frames?.first?.source ||
      storyboard?.firstFrameMode,
  );
  const historyWithCurrent = currentUrl && !history.some((item: FirstFrameHistoryItem) => cleanUrl(item.url) === currentUrl)
    ? [{
        url: currentUrl,
        at: firstFrameHistoryAt(storyboard, existing),
        source: currentSource,
      }, ...history]
    : history;

  return {
    currentUrl: currentUrl || undefined,
    rawUrl: cleanUrl(existing.rawUrl || storyboard?.rawUrl) || undefined,
    status,
    source: currentSource,
    lastKnownGoodUrl: lastKnownGoodUrl || undefined,
    lastError,
    history: historyWithCurrent,
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

// ---------- Tail frame (P2.5a) ----------

/** 尾帧支持的彩色首帧模式。legacy_pencil (手稿) 被显式排除, 因为它不能作为视频生成的连续性锚点。 */
const VALID_FIRST_FRAME_MODES_FOR_TAIL: ReadonlySet<string> = new Set(['structured_v1', 'multi_ref_v1']);

export type TailFrameSource = 'generated' | 'last_known_good' | 'uploaded';

export type TailFrameState = {
  currentUrl?: string;
  rawUrl?: string;
  status: ReferenceStatus;
  source: TailFrameSource;
  lastKnownGoodUrl?: string;
  lastError?: any;
};

export function resolveStoryboardTailFrameUrl(storyboard: any): string {
  return cleanUrl(storyboard?.frames?.tail?.url || storyboard?.tailFrameUrl);
}

export function normalizeTailFrameState(storyboard: any): TailFrameState {
  const framesTail =
    storyboard?.frames?.tail && typeof storyboard.frames.tail === 'object'
      ? storyboard.frames.tail
      : {};
  const currentUrl = cleanUrl(framesTail.url || resolveStoryboardTailFrameUrl(storyboard));
  const lastKnownGoodUrl = cleanUrl(framesTail.lastKnownGoodUrl || currentUrl);
  const legacyError = storyboard?.tailFrameLastError
    ? {
        message: storyboard.tailFrameLastError,
        failedAt: storyboard.tailFrameFailedAt,
      }
    : undefined;
  const lastError = framesTail.lastError || legacyError;
  const status: ReferenceStatus =
    (framesTail.status as ReferenceStatus) ||
    (currentUrl ? (lastError ? 'degraded' : 'ready') : (lastError ? 'failed' : 'missing'));
  const source: TailFrameSource =
    framesTail.source === 'last_known_good' || framesTail.source === 'uploaded'
      ? framesTail.source
      : 'generated';
  return {
    currentUrl: currentUrl || undefined,
    rawUrl: cleanUrl(framesTail.rawUrl || framesTail.url) || undefined,
    status,
    source,
    lastKnownGoodUrl: lastKnownGoodUrl || undefined,
    lastError,
  };
}

export function markTailFrameReady(
  storyboard: any,
  url: string,
  rawUrl = url,
  source: TailFrameSource = 'generated',
): TailFrameState {
  return {
    currentUrl: url,
    rawUrl,
    status: 'ready',
    source,
    lastKnownGoodUrl: url,
    lastError: undefined,
  };
}

export function markTailFrameFailed(storyboard: any, error: any): TailFrameState {
  const prev = normalizeTailFrameState(storyboard);
  const hasFallback = !!(prev.currentUrl || prev.lastKnownGoodUrl);
  return {
    ...prev,
    currentUrl: prev.currentUrl || prev.lastKnownGoodUrl,
    status: hasFallback ? 'degraded' : 'failed',
    source: hasFallback ? 'last_known_good' : prev.source,
    lastError: error,
  };
}

export function markTailFrameDeleted(storyboard: any, opts?: { at?: string }): any {
  const next = { ...(storyboard || {}) };
  const frames = next.frames && typeof next.frames === 'object' ? { ...next.frames } : {};
  delete frames.tail;
  next.frames = frames;

  next.tailFrameUrl = '';
  next.tailFramePrompt = '';
  next.tailFrameIntent = 'none';
  next.tailFrameIntentUpdatedAt = opts?.at || new Date().toISOString();
  next.tailFrameSourceHash = null;
  next.tailFrameReferenceStatus = 'missing';
  next.tailFrameLastError = '';

  delete next.tailFrameFailedAt;
  delete next.tailFrameSafetyAudit;
  delete next.tailFrameErrorCode;
  delete next.tailFrameRecoveryHint;

  return next;
}

export type TailFramePreflightError = {
  reason: 'missing_first_frame' | 'invalid_first_frame_mode' | 'first_frame_failed';
  firstFrameMode?: string;
  firstFrameStatus?: string;
};

/**
 * 尾帧 executor 的 preflight 检查。返回 null = 通过, 返回 error = 阻止。
 * 要求首帧是彩色视频首帧 (structured_v1 / multi_ref_v1) 或 frames.first.status='ready',
 * 显式排除 legacy_pencil 手稿图, 避免尾帧以手稿为锚点失去意义。
 */
export function checkTailFramePreflight(
  storyboard: any,
  opts?: { dependency?: 'requires_first_frame' | 'independent' },
): TailFramePreflightError | null {
  if (opts?.dependency === 'independent') return null;
  const sb = storyboard || {};
  const firstFrameUrl: string =
    cleanUrl(sb.firstFrameUrl) ||
    cleanUrl(sb.frames?.first?.url) ||
    cleanUrl(sb.firstFrame?.currentUrl);
  if (!firstFrameUrl) {
    return { reason: 'missing_first_frame' };
  }
  const firstFrameMode = String(sb.firstFrameMode || '');
  const framesFirstStatus = String(sb.frames?.first?.status || '');
  // 显式拒 legacy_pencil: 即使有 frames.first.status='ready' 这种混合状态 (旧数据或
  // 手工上传写进 frames.first 的情况), 手稿首帧也不能做尾帧锚点。必须先升级到彩色
  // 首帧 (structured_v1)。
  if (firstFrameMode === 'legacy_pencil') {
    return {
      reason: 'invalid_first_frame_mode',
      firstFrameMode,
      firstFrameStatus: framesFirstStatus || undefined,
    };
  }
  const modeOk = VALID_FIRST_FRAME_MODES_FOR_TAIL.has(firstFrameMode);
  const statusOk = framesFirstStatus === 'ready';
  if (!modeOk && !statusOk) {
    return {
      reason: 'invalid_first_frame_mode',
      firstFrameMode: firstFrameMode || undefined,
      firstFrameStatus: framesFirstStatus || undefined,
    };
  }
  // 首帧显式失败 (即使有 legacy URL fallback), 也阻止尾帧: 尾帧会以失败首帧为锚, drift 概率极高。
  if (sb.frames?.first?.status === 'failed' || sb.firstFrame?.status === 'failed') {
    return { reason: 'first_frame_failed', firstFrameStatus: 'failed' };
  }
  return null;
}

export function formatTailFramePreflightError(groupIdx: number, err: TailFramePreflightError): string {
  const label = `片段 ${groupIdx + 1}`;
  if (err.reason === 'missing_first_frame') {
    return `${label} 首帧未就绪, 无法生成尾帧。请先生成彩色视频首帧后再重试。`;
  }
  if (err.reason === 'first_frame_failed') {
    return `${label} 首帧当前处于失败状态, 无法作为尾帧连续性锚点。请先重新生成首帧。`;
  }
  return (
    `${label} 首帧模式不适合作为尾帧锚点 (mode=${err.firstFrameMode || 'unknown'}, status=${err.firstFrameStatus || 'unknown'})。` +
    `尾帧需要彩色视频首帧 (structured_v1), legacy_pencil 手稿图不适用。请先生成彩色首帧再重试。`
  );
}
