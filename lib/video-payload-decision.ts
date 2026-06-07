import type { VideoSubmitMode } from './feature-flags';
import { isMultiShotSegmentEnabled } from './feature-flags';

export type TailFrameReferenceStatus =
  | 'missing'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'file_missing';

export type VideoPayloadMode = 'first_last_frame' | 'first_frame_multi_ref';

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
  | 'first_frame_missing';

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
  if (raw === 'missing' || raw === 'pending' || raw === 'ready' || raw === 'failed' || raw === 'file_missing') {
    return raw;
  }
  // 历史数据里残留的 'stale' 值 (旧自动标记逻辑产物) 不再当作独立状态。
  // 落到 URL/path 判断, 文件能解析就当 ready, 不能就 file_missing。
  const hasUrl = !!String(opts.tailFrameUrl || '').trim();
  if (!hasUrl) return 'missing';
  return opts.tailFramePath ? 'ready' : 'file_missing';
}

function hardFail(
  submitMode: VideoSubmitMode,
  reason: VideoPayloadDecisionReason,
  failureCode: string,
  failureMessage: string,
): VideoPayloadDecision {
  return {
    submitMode,
    payloadMode: 'first_frame_multi_ref',
    reason,
    hardFail: true,
    failureCode,
    failureMessage,
  };
}

function strictDecision(
  submitMode: VideoSubmitMode,
  reason: VideoPayloadDecisionReason,
  decisionWarning?: VideoPayloadDecisionWarning,
): VideoPayloadDecision {
  return {
    submitMode,
    payloadMode: 'first_frame_multi_ref',
    reason,
    hardFail: false,
    warning: decisionWarning,
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
  /** 合并段（多镜头一段）：true 时强制参考模式（首帧+参考图），不进首尾帧。 */
  multiShotSegment?: boolean;
}): VideoPayloadDecision {
  const submitMode = normalizeVideoSubmitMode(opts.submitMode, 'auto');
  const firstFramePath = String(opts.firstFramePath || '').trim();
  const tailFramePath = String(opts.tailFramePath || '').trim();
  const tailStatus = normalizeTailFrameReferenceStatus({
    status: opts.tailReferenceStatus,
    tailFrameUrl: opts.tailFrameUrl,
    tailFramePath,
  });

  if (submitMode === 'reference_images') {
    return strictDecision(submitMode, 'reference_images');
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
    return strictDecision(submitMode, 'reference_images');
  }

  if (submitMode === 'strict_first_frame') {
    return strictDecision(submitMode, 'strict_first_frame');
  }

  const explicitFirstLast = submitMode === 'first_last_frame';
  if (!opts.capabilityFirstLastSupported) {
    return strictDecision(submitMode, 'capability_unsupported');
  }

  if (!opts.firstLastFeatureEnabled) {
    return strictDecision(submitMode, 'feature_disabled');
  }

  if (!opts.tailIntentRequested) {
    return strictDecision(submitMode, 'no_tail_intent');
  }

  if (tailStatus === 'ready' && tailFramePath) {
    return {
      submitMode,
      payloadMode: 'first_last_frame',
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

  return strictDecision(submitMode, reason);
}
