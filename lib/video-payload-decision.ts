import type { VideoSubmitMode } from './feature-flags';

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

function warning(reason: VideoPayloadDecisionReason, message: string): VideoPayloadDecisionWarning {
  return { key: 'first_last_mode_degraded', level: 'info', reason, message };
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
    const hasTailSignal =
      opts.tailIntentRequested ||
      !!String(opts.tailFrameUrl || '').trim() ||
      !!String(opts.tailReferenceStatus || '').trim();
    return strictDecision(
      submitMode,
      'reference_images',
      hasTailSignal
        ? {
            key: 'target_end_not_used',
            level: 'info',
            reason: 'reference_images_mode',
            message: '当前为多参考图模式，尾帧不会作为 last_frame 参与本次视频生成。',
          }
        : undefined,
    );
  }

  if (!firstFramePath) {
    return hardFail(
      submitMode,
      'first_frame_missing',
      'preflight_missing_first_frame',
      '片段缺少可用首帧，请先生成首帧后再生成视频。',
    );
  }

  if (submitMode === 'strict_first_frame') {
    return strictDecision(submitMode, 'strict_first_frame');
  }

  const explicitFirstLast = submitMode === 'first_last_frame';
  if (!opts.capabilityFirstLastSupported) {
    if (explicitFirstLast) {
      return hardFail(
        submitMode,
        'capability_unsupported',
        'first_last_frame_capability_unsupported',
        '当前视频模型不支持首尾帧模式，请切换到 Seedance 2.0 或改用 auto / strict_first_frame。',
      );
    }
    return strictDecision(
      submitMode,
      'capability_unsupported',
      warning('capability_unsupported', '当前视频模型未标记支持首尾帧，已使用仅首帧模式。'),
    );
  }

  if (!opts.firstLastFeatureEnabled) {
    if (explicitFirstLast) {
      return hardFail(
        submitMode,
        'feature_disabled',
        'first_last_frame_feature_disabled',
        '首尾帧视频模式已被系统管理员禁用，请使用 auto 或 strict_first_frame 模式。',
      );
    }
    return strictDecision(
      submitMode,
      'feature_disabled',
      warning('feature_disabled', '首尾帧视频模式未开启，已使用仅首帧模式。'),
    );
  }

  if (!opts.tailIntentRequested) {
    if (explicitFirstLast) {
      return hardFail(
        submitMode,
        'no_tail_intent',
        'first_last_frame_requires_tail_intent',
        '该片段尚未确认使用尾帧，请先生成或确认尾帧后再使用首尾帧模式。',
      );
    }
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

  if (explicitFirstLast) {
    return hardFail(
      submitMode,
      reason,
      `first_last_frame_${reason}`,
      '尾帧不可用，请重新生成尾帧或切换到仅首帧模式。',
    );
  }

  const messageByReason: Record<VideoPayloadDecisionReason, string> = {
    tail_missing: '该片段没有尾帧，已使用仅首帧模式。',
    tail_failed: '尾帧生成失败，已使用仅首帧模式。',
    tail_file_missing: '尾帧文件不可解析，已使用仅首帧模式。',
    tail_pending: '尾帧仍在生成中，请等待尾帧完成后再生成视频。',
    tail_ready: '',
    strict_first_frame: '',
    reference_images: '',
    no_tail_intent: '',
    feature_disabled: '',
    capability_unsupported: '',
    first_frame_missing: '',
  };
  return strictDecision(submitMode, reason, warning(reason, messageByReason[reason] || '尾帧不可用，已使用仅首帧模式。'));
}
