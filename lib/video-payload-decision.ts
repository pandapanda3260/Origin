import type { VideoSubmitMode } from './feature-flags';
import { isMultiShotSegmentEnabled } from './feature-flags';

export type TailFrameReferenceStatus =
  | 'missing'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'file_missing';

export type VideoPayloadMode = 'first_last_frame' | 'first_frame_multi_ref' | 'multi_keyframe_multi_ref';
export type VideoEffectiveStrategy = 'first_last_frame' | 'reference_images' | 'strict_first_frame' | 'multi_keyframe_multi_ref';

export type VideoSubmitInputMode = {
  seedanceImageMode: 'reference_images' | 'strict_first_frame';
  useIndependentReferenceImages: boolean;
};

export type VideoPayloadDecisionReason =
  | 'tail_ready'
  | 'strict_first_frame'
  | 'reference_images'
  | 'no_tail_intent'
  | 'tail_missing'
  | 'tail_pending'
  | 'tail_failed'
  | 'tail_file_missing'
  | 'feature_disabled'
  | 'capability_unsupported'
  | 'first_frame_missing'
  | 'multi_keyframe_ready';

export type VideoPayloadDecisionWarningReason =
  | VideoPayloadDecisionReason
  | 'reference_images_mode';

export type VideoPayloadDecisionWarning = {
  key: string;
  level: 'info' | 'warn';
  reason: VideoPayloadDecisionWarningReason;
  message: string;
};

export type VideoPayloadDecision = {
  submitMode: VideoSubmitMode;
  payloadMode: VideoPayloadMode;
  effectiveStrategy: VideoEffectiveStrategy;
  reason: VideoPayloadDecisionReason;
  hardFail: boolean;
  failureCode?: string;
  failureMessage?: string;
  warning?: VideoPayloadDecisionWarning;
  firstLastFrameMode?: {
    firstFramePath: string;
    lastFramePath: string;
    modeReason: 'tail_ready';
  };
  multiKeyframeMode?: {
    keyframeCount: number;
    referenceBudget: number;
    maxImages: number;
    modeReason: 'multi_keyframe_ready';
  };
};

export function normalizeVideoSubmitMode(value: unknown, fallback: VideoSubmitMode = 'auto'): VideoSubmitMode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'auto' || raw === 'strict_first_frame' || raw === 'first_last_frame' || raw === 'reference_images') {
    return raw;
  }
  return fallback;
}

export function computeFirstLastFeatureEnabled(opts: {
  submitMode?: unknown;
  configuredSubmitMode?: unknown;
  adminAllowsFirstLast: boolean;
}): boolean {
  if (!opts.adminAllowsFirstLast) return false;
  const submitMode = normalizeVideoSubmitMode(opts.submitMode, 'auto');
  const configuredSubmitMode = normalizeVideoSubmitMode(opts.configuredSubmitMode, 'auto');
  if (submitMode === 'strict_first_frame' || submitMode === 'reference_images') return false;
  return submitMode === 'auto' || submitMode === 'first_last_frame' || configuredSubmitMode === 'first_last_frame';
}

let warnedFirstLastConfigIgnored = false;

export function warnIfFirstLastConfigIgnored(opts: {
  configuredSubmitMode?: unknown;
  adminAllowsFirstLast: boolean;
  logger?: Pick<Console, 'warn'>;
}) {
  const logger = opts.logger || console;
  const configuredSubmitMode = normalizeVideoSubmitMode(opts.configuredSubmitMode, 'auto');
  if (opts.adminAllowsFirstLast || configuredSubmitMode !== 'first_last_frame' || warnedFirstLastConfigIgnored) return;
  warnedFirstLastConfigIgnored = true;
  logger.warn("[video-config] VIDEO_SUBMIT_MODE='first_last_frame' ignored because ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=0");
}

export function normalizeTailFrameReferenceStatus(opts: {
  status?: unknown;
  tailFrameUrl?: string | null;
  tailFramePath?: string | null;
}): TailFrameReferenceStatus {
  const raw = String(opts.status || '').trim().toLowerCase();
  const hasUrl = !!String(opts.tailFrameUrl || '').trim();
  if (raw === 'missing' || raw === 'pending' || raw === 'ready' || raw === 'failed' || raw === 'file_missing') {
    if (raw === 'pending' && !hasUrl) return 'missing';
    return raw;
  }
  // 历史数据里残留的 'stale' 值 (旧自动标记逻辑产物) 不再当作独立状态。
  // 落到 URL/path 判断, 文件能解析就当 ready, 不能就 file_missing。
  if (!hasUrl) return 'missing';
  return opts.tailFramePath ? 'ready' : 'file_missing';
}

function hardFail(
  submitMode: VideoSubmitMode,
  reason: VideoPayloadDecisionReason,
  failureCode: string,
  failureMessage: string,
  effectiveStrategy: VideoEffectiveStrategy = 'strict_first_frame',
): VideoPayloadDecision {
  return {
    submitMode,
    payloadMode: 'first_frame_multi_ref',
    effectiveStrategy,
    reason,
    hardFail: true,
    failureCode,
    failureMessage,
  };
}

function firstFrameDecision(
  submitMode: VideoSubmitMode,
  reason: VideoPayloadDecisionReason,
  effectiveStrategy: Exclude<VideoEffectiveStrategy, 'first_last_frame'>,
  decisionWarning?: VideoPayloadDecisionWarning,
): VideoPayloadDecision {
  return {
    submitMode,
    payloadMode: 'first_frame_multi_ref',
    effectiveStrategy,
    reason,
    hardFail: false,
    warning: decisionWarning,
  };
}

function independentMultiImageDisabledWarning(): VideoPayloadDecisionWarning {
  return {
    key: 'independent_multi_image_disabled',
    level: 'warn',
    reason: 'reference_images_mode',
    message: '独立多图通道未开启，已使用严格首帧通道。',
  };
}

function tailUnavailableWarning(
  reason: VideoPayloadDecisionReason,
  independentMultiImageCapable: boolean,
): VideoPayloadDecisionWarning {
  return {
    key: independentMultiImageCapable ? 'tail_frame_reference_images_fallback' : 'tail_frame_strict_first_frame_fallback',
    level: 'warn',
    reason,
    message: independentMultiImageCapable
      ? '尾帧不可用，已改用首帧+多参考图通道；首帧将作为参考图参与，不再使用严格 first_frame 锚定。'
      : '尾帧不可用，独立多图通道未开启，已使用严格首帧通道。',
  };
}

function explicitFirstLastFallbackWarning(reason: VideoPayloadDecisionReason): VideoPayloadDecisionWarning {
  const messages: Partial<Record<VideoPayloadDecisionReason, string>> = {
    capability_unsupported: '已选择首尾帧模式，但当前视频模型不支持首尾帧，已改用严格首帧通道。',
    feature_disabled: '已选择首尾帧模式，但首尾帧视频模式当前未开启，已改用严格首帧通道。',
    no_tail_intent: '已选择首尾帧模式，但片段未标记尾帧意图，已改用严格首帧通道。',
  };
  return {
    key: 'first_last_frame_fallback',
    level: 'warn',
    reason,
    message: messages[reason] || '已选择首尾帧模式，但当前条件不满足，已改用严格首帧通道。',
  };
}

function referenceImagesDecision(
  submitMode: VideoSubmitMode,
  independentMultiImageCapable: boolean,
  reason: VideoPayloadDecisionReason = 'reference_images',
): VideoPayloadDecision {
  return firstFrameDecision(
    submitMode,
    reason,
    independentMultiImageCapable ? 'reference_images' : 'strict_first_frame',
    independentMultiImageCapable ? undefined : independentMultiImageDisabledWarning(),
  );
}

function multiKeyframeDecision(
  submitMode: VideoSubmitMode,
  opts: {
    keyframeCount: number;
    referenceBudget: number;
    maxImages: number;
  },
): VideoPayloadDecision {
  return {
    submitMode,
    payloadMode: 'multi_keyframe_multi_ref',
    effectiveStrategy: 'multi_keyframe_multi_ref',
    reason: 'multi_keyframe_ready',
    hardFail: false,
    multiKeyframeMode: {
      keyframeCount: opts.keyframeCount,
      referenceBudget: opts.referenceBudget,
      maxImages: opts.maxImages,
      modeReason: 'multi_keyframe_ready',
    },
  };
}

export function deriveVideoSubmitInputMode(decision: VideoPayloadDecision): VideoSubmitInputMode {
  if (decision.effectiveStrategy === 'reference_images' || decision.effectiveStrategy === 'multi_keyframe_multi_ref') {
    return {
      seedanceImageMode: 'reference_images',
      useIndependentReferenceImages: true,
    };
  }
  return {
    seedanceImageMode: 'strict_first_frame',
    useIndependentReferenceImages: false,
  };
}

export function resolveVideoPayloadDecision(opts: {
  submitMode?: unknown;
  firstLastFeatureEnabled: boolean;
  capabilityFirstLastSupported: boolean;
  firstFramePath?: string | null;
  tailFramePath?: string | null;
  tailFrameUrl?: string | null;
  tailReferenceStatus?: unknown;
  tailIntentRequested: boolean;
  independentMultiImageCapable: boolean;
  /** 合并段（多镜头一段）：true 时强制参考模式（首帧+参考图），不进首尾帧。 */
  multiShotSegment?: boolean;
  multiKeyframeCapable?: boolean;
  multiKeyframeSchemaVerified?: boolean;
  multiKeyframeCount?: number;
  referenceBudget?: number;
  maxImages?: number;
}): VideoPayloadDecision {
  const submitMode = normalizeVideoSubmitMode(opts.submitMode, 'auto');
  const firstFramePath = String(opts.firstFramePath || '').trim();
  const tailFramePath = String(opts.tailFramePath || '').trim();
  const tailStatus = normalizeTailFrameReferenceStatus({
    status: opts.tailReferenceStatus,
    tailFrameUrl: opts.tailFrameUrl,
    tailFramePath,
  });
  const canUseMultiKeyframe =
    (submitMode === 'auto' || submitMode === 'reference_images') &&
    opts.independentMultiImageCapable &&
    !!opts.multiKeyframeCapable &&
    !!opts.multiKeyframeSchemaVerified &&
    Number(opts.multiKeyframeCount || 0) >= 2;

  if (canUseMultiKeyframe) {
    return multiKeyframeDecision(submitMode, {
      keyframeCount: Math.floor(Number(opts.multiKeyframeCount || 0)),
      referenceBudget: Math.max(1, Math.floor(Number(opts.referenceBudget || 1))),
      maxImages: Math.max(1, Math.floor(Number(opts.maxImages || opts.referenceBudget || 1))),
    });
  }

  if (!firstFramePath) {
    return hardFail(
      submitMode,
      'first_frame_missing',
      'preflight_missing_first_frame',
      '片段缺少可用首帧，请先生成首帧后再生成视频。',
    );
  }

  // 合并段：恒走参考模式（首帧 + 参考图），不进首尾帧 —— 合并段无尾锚点（方案 §3.0）。
  // flag OFF 或非合并段时此分支不触发，行为与历史一致。
  if (opts.multiShotSegment && isMultiShotSegmentEnabled()) {
    return referenceImagesDecision(submitMode, opts.independentMultiImageCapable);
  }

  if (submitMode === 'reference_images') {
    return referenceImagesDecision(submitMode, opts.independentMultiImageCapable);
  }

  if (submitMode === 'strict_first_frame') {
    return firstFrameDecision(submitMode, 'strict_first_frame', 'strict_first_frame');
  }

  const explicitFirstLast = submitMode === 'first_last_frame';
  if (!opts.capabilityFirstLastSupported) {
    return firstFrameDecision(
      submitMode,
      'capability_unsupported',
      'strict_first_frame',
      explicitFirstLast ? explicitFirstLastFallbackWarning('capability_unsupported') : undefined,
    );
  }

  if (!opts.firstLastFeatureEnabled) {
    return firstFrameDecision(
      submitMode,
      'feature_disabled',
      'strict_first_frame',
      explicitFirstLast ? explicitFirstLastFallbackWarning('feature_disabled') : undefined,
    );
  }

  if (!opts.tailIntentRequested) {
    return firstFrameDecision(
      submitMode,
      'no_tail_intent',
      'strict_first_frame',
      explicitFirstLast ? explicitFirstLastFallbackWarning('no_tail_intent') : undefined,
    );
  }

  if (tailStatus === 'ready' && tailFramePath) {
    return {
      submitMode,
      payloadMode: 'first_last_frame',
      effectiveStrategy: 'first_last_frame',
      reason: 'tail_ready',
      hardFail: false,
      firstLastFrameMode: {
        firstFramePath,
        lastFramePath: tailFramePath,
        modeReason: 'tail_ready',
      },
    };
  }

  const statusReason: Record<TailFrameReferenceStatus, VideoPayloadDecisionReason> = {
    missing: 'tail_missing',
    pending: 'tail_pending',
    ready: 'tail_file_missing',
    failed: 'tail_failed',
    file_missing: 'tail_file_missing',
  };
  const reason = statusReason[tailStatus] || 'tail_file_missing';

  if (tailStatus === 'pending') {
    return hardFail(
      submitMode,
      reason,
      explicitFirstLast ? 'first_last_frame_tail_pending' : 'tail_frame_pending',
      '尾帧仍在生成中，请等待尾帧完成后再生成视频。',
    );
  }

  return firstFrameDecision(
    submitMode,
    reason,
    opts.independentMultiImageCapable ? 'reference_images' : 'strict_first_frame',
    tailUnavailableWarning(reason, opts.independentMultiImageCapable),
  );
}
