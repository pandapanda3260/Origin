// ============================================================================
// Legacy API (still used by batch-executors / video-gen / video-prompt-runtime).
// Will be replaced by VideoModelCapability below once callers migrate.
// ============================================================================
export type TargetEndStrategy = 'image' | 'caption' | 'unsupported';

function normalizeStrategy(value: unknown): TargetEndStrategy | null {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'image' || raw === 'caption' || raw === 'unsupported') return raw;
  return null;
}

export function resolveTargetEndStrategy(videoCfg: {
  provider?: string;
  mode?: string;
  model?: string;
  baseUrl?: string;
}): TargetEndStrategy {
  const envStrategy = normalizeStrategy(
    process.env.VIDEO_TARGET_END_STRATEGY ||
      process.env.ORIGIN_VIDEO_TARGET_END_STRATEGY,
  );
  if (envStrategy) return envStrategy;

  const providerText = [
    videoCfg?.provider,
    videoCfg?.mode,
    videoCfg?.model,
    videoCfg?.baseUrl,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/seedance|doubao|volcengine|volces\.com|ark\.cn-/.test(providerText)) {
    return 'image';
  }

  return 'unsupported';
}

// ============================================================================
// Explicit capability registry (new API).
//
// The registry records — per video model id — whether the provider truly
// supports a "first+last frame" image-to-video mode, whether that mode is
// mutually exclusive with multi-reference mode, and the body shape the
// provider expects. Callers must NOT guess capability from provider strings
// or regexes; look up the capability here or fall back to the conservative
// default (everything unsupported / unverified).
//
// verifiedBy / verifiedAt are maintained manually and describe coarse provider
// capability source. Multi-keyframe request schema readiness is tracked
// separately by schemaVerificationStatus.
// ============================================================================
export type VideoModelCapability = {
  firstLastFrameMode: 'supported' | 'unsupported';
  multiReferenceMode: 'supported' | 'unsupported';
  supportsMultiKeyframe: boolean;
  /**
   * When true, a single request body cannot mix first_last_frame inputs with
   * reference_image inputs. Callers must branch payload construction instead
   * of merging lists.
   */
  modesAreMutuallyExclusive: boolean;
  supportsReturnLastFrame: boolean;
  /** Provider hard limit for a single video generation duration. */
  maxSingleGenSec: number;
  /** Auto-segmentation lower target used when creating shot-plan storyboard slots. */
  segmentTargetMinSec: number;
  /** Auto-segmentation upper target used when creating shot-plan storyboard slots. */
  segmentTargetMaxSec: number;
  /** Matcher-side reference image budget; in Builder B this includes the storyboard first frame. */
  referenceBudget: number;
  /** Provider hard limit for all submitted images in one request. */
  maxImages: number;
  bodyShape: 'openai_content_array';
  multiKeyframeBodyShape: 'unsupported' | 'seedance_content_keyframes_adapter';
  schemaVerificationStatus: 'not_applicable' | 'unverified' | 'runtime_verified' | 'official_doc';
  verifiedTaskId?: string;
  verifiedBy: 'runtime_verified' | 'official_doc' | 'public_capability_claim';
  verifiedAt: string;
};

const CAPABILITY_DEFAULT: VideoModelCapability = {
  firstLastFrameMode: 'unsupported',
  multiReferenceMode: 'unsupported',
  supportsMultiKeyframe: false,
  modesAreMutuallyExclusive: true,
  supportsReturnLastFrame: false,
  maxSingleGenSec: 15,
  segmentTargetMinSec: 4,
  segmentTargetMaxSec: 15,
  referenceBudget: 9,
  maxImages: 9,
  bodyShape: 'openai_content_array',
  multiKeyframeBodyShape: 'unsupported',
  schemaVerificationStatus: 'not_applicable',
  verifiedBy: 'official_doc',
  verifiedAt: '',
};

const CAPABILITIES: Record<string, VideoModelCapability> = {
  // OpenAI Sora fallback id is known to model routing, but this product has
  // not verified a compatible first+last-frame submit shape for it.
  sora: {
    firstLastFrameMode: 'unsupported',
    multiReferenceMode: 'unsupported',
    supportsMultiKeyframe: false,
    modesAreMutuallyExclusive: true,
    supportsReturnLastFrame: false,
    maxSingleGenSec: 15,
    segmentTargetMinSec: 4,
    segmentTargetMaxSec: 15,
    referenceBudget: 9,
    maxImages: 9,
    bodyShape: 'openai_content_array',
    multiKeyframeBodyShape: 'unsupported',
    schemaVerificationStatus: 'not_applicable',
    verifiedBy: 'official_doc',
    verifiedAt: '2026-05-19',
  },
  // Volcengine Ark Seedance 2.0 — verified via live API probe
  // (cgt-20260510020416-zrtrs: returned content.last_frame_url when
  // request used role=first_frame/last_frame + top-level
  // ratio/duration/resolution + return_last_frame:true).
  // Verified mutual-exclusion with reference_image per official doc
  // (https://www.volcengine.com/docs/82379/1520757, 2026-05-09 rev).
  'doubao-seedance-2-0-260128': {
    firstLastFrameMode: 'supported',
    multiReferenceMode: 'supported',
    supportsMultiKeyframe: false,
    modesAreMutuallyExclusive: true,
    supportsReturnLastFrame: true,
    maxSingleGenSec: 15,
    segmentTargetMinSec: 4,
    segmentTargetMaxSec: 15,
    referenceBudget: 9,
    maxImages: 9,
    bodyShape: 'openai_content_array',
    multiKeyframeBodyShape: 'unsupported',
    schemaVerificationStatus: 'not_applicable',
    verifiedBy: 'runtime_verified',
    verifiedAt: '2026-05-09',
  },
  // Seedance 2.5 provisional model id. Replace this temporary id with the
  // official ModelArk id once published. Public capability claims cover longer
  // generations and larger multimodal image budgets, but the exact keyframe
  // request schema is not yet runtime-verified in this repo. Keep
  // schemaVerificationStatus='unverified' so callers can derive segment/budget
  // limits while routing C only after the one-order schema probe flips it.
  'doubao-seedance-2-5': {
    firstLastFrameMode: 'supported',
    multiReferenceMode: 'supported',
    supportsMultiKeyframe: true,
    modesAreMutuallyExclusive: false,
    supportsReturnLastFrame: true,
    maxSingleGenSec: 30,
    segmentTargetMinSec: 20,
    segmentTargetMaxSec: 25,
    referenceBudget: 50,
    maxImages: 50,
    bodyShape: 'openai_content_array',
    multiKeyframeBodyShape: 'seedance_content_keyframes_adapter',
    schemaVerificationStatus: 'unverified',
    verifiedBy: 'public_capability_claim',
    verifiedAt: '2026-06-30',
  },
  // Seedance 2.0 fast — official doc lists the same schema; not yet live-verified.
  'doubao-seedance-2-0-fast-260128': {
    firstLastFrameMode: 'supported',
    multiReferenceMode: 'supported',
    supportsMultiKeyframe: false,
    modesAreMutuallyExclusive: true,
    supportsReturnLastFrame: true,
    maxSingleGenSec: 15,
    segmentTargetMinSec: 4,
    segmentTargetMaxSec: 15,
    referenceBudget: 9,
    maxImages: 9,
    bodyShape: 'openai_content_array',
    multiKeyframeBodyShape: 'unsupported',
    schemaVerificationStatus: 'not_applicable',
    verifiedBy: 'official_doc',
    verifiedAt: '2026-05-09',
  },
  // Seedance 1.5 Pro — official doc lists the same schema.
  'doubao-seedance-1-5-pro-251215': {
    firstLastFrameMode: 'supported',
    multiReferenceMode: 'supported',
    supportsMultiKeyframe: false,
    modesAreMutuallyExclusive: true,
    supportsReturnLastFrame: true,
    maxSingleGenSec: 15,
    segmentTargetMinSec: 4,
    segmentTargetMaxSec: 15,
    referenceBudget: 9,
    maxImages: 9,
    bodyShape: 'openai_content_array',
    multiKeyframeBodyShape: 'unsupported',
    schemaVerificationStatus: 'not_applicable',
    verifiedBy: 'official_doc',
    verifiedAt: '2026-05-09',
  },
};

/**
 * Resolve capability for the given video model id. Unknown / unlisted models
 * get CAPABILITY_DEFAULT (all unsupported). Callers decide whether that
 * means "bail out" or "fall back to the multi-reference path".
 */
export function resolveVideoModelCapability(modelId: string | undefined | null): VideoModelCapability {
  const id = String(modelId || '').trim();
  if (!id) return CAPABILITY_DEFAULT;
  return CAPABILITIES[id] || CAPABILITY_DEFAULT;
}

export function isVideoMultiKeyframeSchemaVerified(capability: VideoModelCapability): boolean {
  if (!capability.supportsMultiKeyframe) return false;
  return capability.schemaVerificationStatus === 'runtime_verified' ||
    capability.schemaVerificationStatus === 'official_doc';
}

/**
 * Test-only helper: list the ids that have been registered with an explicit
 * capability row. Used by unit/integration tests to assert coverage.
 */
export function listRegisteredVideoModelIds(): string[] {
  return Object.keys(CAPABILITIES);
}
