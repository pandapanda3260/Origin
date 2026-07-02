import type { UserRow } from './db';
import { getJson } from './kv-db';
import { getExternalEnvValue, loadExternalEnv } from './env';
import { recordObservabilityEvent } from './observability-events';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';

export type ModelSlot = 'text' | 'image' | 'video' | 'storyboard';
export type TextModelRole =
  | 'brain'
  | 'structured'
  | 'styleBible'
  | 'projectClassifier'
  | 'styleClassifier'
  | 'profileDerive'
  | 'continuity'
  | 'frameConsistencyCheck'
  | 'visionExtract'
  | 'legacy';
export type ProviderKind =
  | 'openai_chat'
  | 'openai_responses'
  | 'packy_responses'
  | 'packy_messages'
  | 'packy_images'
  | 'code80_messages'
  | 'code80_images'
  | 'zerail_messages'
  | 'zerail_responses'
  | 'zerail_images'
  | 'volcengine_chat'
  | 'volcengine_seedream'
  | 'seedance'
  | 'fake';

export type ModelConfigSource = 'user-settings' | 'env' | 'fallback';

/**
 * 图像模型的多图参考能力 (P3a)。
 *   - multiRefImage: 作为参考图同时传给 provider 的最大数量。1 = 只单图; 0 = 不支持参考图。
 *   - transport: 具体装配格式。由 scripts/probe-multi-ref-*.js 实测定型, 先以 'unverified_*'
 *     占位, probe 跑完后改成 'verified_*'。业务代码 (image-gen.ts) 根据 transport 选择分支。
 * 默认值在 inferImageCapabilities() 里按 provider 推断; env IMAGE_MULTI_REF_CAP 可 override
 * multiRefImage (1-16)。
 */
export type ImageTransport =
  | 'single_image'
  | 'unverified_seedream_array'
  | 'verified_seedream_array'
  | 'unverified_openai_multipart_repeat'
  | 'verified_openai_multipart_repeat'
  | 'verified_openai_multipart_bracket'
  | 'verified_openai_multipart_image_files';

export type ImageModelCapabilities = {
  multiRefImage: number;
  transport: ImageTransport;
};

export type ModelCapabilities = {
  image?: ImageModelCapabilities;
};

export function listKnownVideoModelIds(): string[] {
  return [
    // Fallback video model id used when no real video provider is configured.
    'sora',
    // Volcengine Seedance models that the product can route to via VIDEO_MODEL / MODEL_VIDEO_PRIMARY.
    // The 2.5 id is provisional; replace it with the official ModelArk id when published.
    'doubao-seedance-2-5',
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-1-5-pro-251215',
  ];
}

export type ResolvedModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  mode: 'real' | 'fake';
  source: ModelConfigSource;
  provider: ProviderKind;
  endpoint?: string;
  role?: TextModelRole;
  reasoningEffort?: string;
  tier?: string;
  imageGenerationEndpoint?: string;
  imageEditEndpoint?: string;
  imageQuality?: string;
  imageSize?: string;
  imageResponseFormat?: string;
  imageWatermark?: boolean;
  seedreamSequentialImageGeneration?: string;
  seedreamOptimizePromptMode?: string;
  timeoutMs?: number;
  minDurationSec?: number;
  capabilities?: ModelCapabilities;
  disableResponseStorage?: boolean;
  fallbackOf?: string;
  fallbackConfigs?: ResolvedModelConfig[];
};

export function resolveTextModelConfig(
  user: UserRow | null,
  role: TextModelRole = 'brain',
): ResolvedModelConfig {
  loadExternalEnv();

  if (role === 'brain') {
    const key = env('CLAUDE_API_KEY') || env('TEXT_API_KEY');
    if (key) {
      const cfg = real({
        baseUrl: env('CLAUDE_API_BASE') || env('TEXT_API_BASE') || 'https://gateway.zerail.com/v1',
        apiKey: key,
        model: env('CLAUDE_MODEL') || env('MODEL_PRIMARY_BRAIN') || 'claude-opus-4-8',
        provider: inferProvider(env('CLAUDE_PROVIDER') || 'zerail_messages', 'text'),
        endpoint: env('CLAUDE_API_ENDPOINT') || '/messages',
        role,
        source: 'env',
        tier: env('CLAUDE_TIER') || env('MODEL_PRIMARY_BRAIN_TIER') || undefined,
      });
      return attachTextFallbackConfigs(cfg, role);
    }
  }

  if (role === 'projectClassifier' || role === 'styleClassifier') {
    const disabled = ['0', 'false', 'off', 'no'].includes(
      firstEnv('PROJECT_CLASSIFIER_ENABLED', 'STYLE_CLASSIFIER_ENABLED').toLowerCase(),
    );
    if (disabled) return fake('text', role);

    const key =
      secretEnv('PROJECT_CLASSIFIER_API_KEY') ||
      secretEnv('STYLE_CLASSIFIER_API_KEY') ||
      secretEnv('ARK_API_KEY') ||
      secretEnv('VOLCENGINE_ARK_API_KEY') ||
      secretEnv('DOUBAO_API_KEY');
    if (!key) return fake('text', role);

    return real({
      baseUrl: firstEnv('PROJECT_CLASSIFIER_API_BASE', 'STYLE_CLASSIFIER_API_BASE', 'ARK_API_BASE') || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: key,
      model:
        env('PROJECT_CLASSIFIER_MODEL') ||
        env('STYLE_CLASSIFIER_MODEL') ||
        env('DOUBAO_PROJECT_CLASSIFIER_MODEL') ||
        env('DOUBAO_STYLE_CLASSIFIER_MODEL') ||
        env('ARK_MODEL') ||
        'doubao-seed-2-0-pro-260215',
      provider: inferProvider(firstEnv('PROJECT_CLASSIFIER_PROVIDER', 'STYLE_CLASSIFIER_PROVIDER', 'ARK_PROVIDER') || 'volcengine_chat', 'text'),
      endpoint: firstEnv('PROJECT_CLASSIFIER_API_ENDPOINT', 'STYLE_CLASSIFIER_API_ENDPOINT', 'ARK_API_ENDPOINT') || '/chat/completions',
      role,
      source: 'env',
      reasoningEffort: firstEnv('PROJECT_CLASSIFIER_REASONING_EFFORT', 'STYLE_CLASSIFIER_REASONING_EFFORT') || 'none',
    });
  }

  if (role === 'structured' || role === 'styleBible' || role === 'profileDerive' || role === 'continuity' || role === 'frameConsistencyCheck' || role === 'visionExtract') {
    const prefix = roleEnvPrefix(role);
    const key = prefixedEnv(prefix, 'API_KEY') || env('TEXT_API_KEY') || env('OPENAI_API_KEY');
    if (key) {
      const baseUrl = prefixedEnv(prefix, 'API_BASE') || env('TEXT_API_BASE') || env('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
      const provider = inferResponsesProvider(prefixedEnv(prefix, 'PROVIDER') || env('TEXT_PROVIDER'), baseUrl);
      const cfg = real({
        baseUrl,
        apiKey: key,
        model: prefixedEnv(prefix, 'MODEL') || env('TEXT_MODEL') || env('OPENAI_MODEL') || env('MODEL_STRUCTURED_WORKER') || 'gpt-5.5',
        provider,
        endpoint: prefixedEnv(prefix, 'API_ENDPOINT') || env('TEXT_API_ENDPOINT') || '/responses',
        role,
        source: 'env',
        reasoningEffort: prefixedEnv(prefix, 'REASONING_EFFORT') || (role === 'continuity' || role === 'frameConsistencyCheck' || role === 'visionExtract' ? 'none' : env('TEXT_REASONING_EFFORT') || undefined),
      });
      return attachTextFallbackConfigs(cfg, role);
    }
  }

  const legacy = resolveLegacyOpenAIConfig(user, 'text', role);
  if (legacy.mode === 'real') return legacy;

  if (role === 'brain') {
    const structured = resolveTextModelConfig(user, 'structured');
    if (structured.mode === 'real') return { ...structured, role: 'brain' };
  }

  return fake('text', role);
}

export function resolveSlotModelConfig(
  user: UserRow | null,
  slot: ModelSlot = 'text',
): ResolvedModelConfig {
  loadExternalEnv();

  if (slot === 'text') return resolveTextModelConfig(user, 'brain');

  if (slot === 'image') {
    const provider = inferProvider(env('IMAGE_PROVIDER'), 'image');
    const isSeedream = provider === 'volcengine_seedream';
    const key = isSeedream
      ? env('IMAGE_SEEDREAM_API_KEY') || env('IMAGE_API_KEY')
      : env('IMAGE_API_KEY');
    if (key) {
      const cfg = real({
        baseUrl: env('IMAGE_API_BASE') || (isSeedream ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://gateway.zerail.com/v1'),
        apiKey: key,
        model: env('IMAGE_MODEL') || env('MODEL_IMAGE_PRIMARY') || (isSeedream ? 'doubao-seedream-4-5-251128' : 'gpt-image-2'),
        provider,
        endpoint: env('IMAGE_GENERATIONS_ENDPOINT') || '/images/generations',
        imageGenerationEndpoint: env('IMAGE_GENERATIONS_ENDPOINT') || '/images/generations',
        imageEditEndpoint: env('IMAGE_EDITS_ENDPOINT') || '/images/edits',
        imageQuality: env('IMAGE_QUALITY') || undefined,
        imageSize: env('IMAGE_SEEDREAM_SIZE') || undefined,
        imageResponseFormat: env('IMAGE_SEEDREAM_RESPONSE_FORMAT') || undefined,
        imageWatermark: envBool('IMAGE_SEEDREAM_WATERMARK'),
        seedreamSequentialImageGeneration: env('IMAGE_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION') || undefined,
        seedreamOptimizePromptMode: env('IMAGE_SEEDREAM_OPTIMIZE_PROMPT_MODE') || undefined,
        timeoutMs: secondsToMs(env('IMAGE_TIMEOUT_SECONDS')),
        source: 'env',
      });
      return attachImageFallbackConfigs(cfg);
    }
  }

  if (slot === 'video') {
    const key = env('VIDEO_API_KEY');
    if (key) {
      return real({
        baseUrl: env('VIDEO_API_BASE') || 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: key,
        model: env('VIDEO_MODEL') || env('MODEL_VIDEO_PRIMARY') || 'doubao-seedance-2-0-260128',
        provider: 'seedance',
        minDurationSec: positiveInt(env('VIDEO_MIN_DURATION_SECONDS')),
        source: 'env',
      });
    }
  }

  if (slot === 'storyboard') {
    const imageCfg = resolveSlotModelConfig(user, 'image');
    if (imageCfg.mode === 'real') {
      return { ...imageCfg, model: env('STORYBOARD_MODEL') || imageCfg.model };
    }
  }

  const userCfg = readUserSlotConfig(user, slot);
  if (userCfg) return userCfg;

  const legacy = resolveLegacyOpenAIConfig(user, slot, 'legacy');
  if (legacy.mode === 'real') return legacy;
  return fake(slot, 'legacy');
}

export function getModelRoutingStatus(user: UserRow | null) {
  return {
    brain: redactConfig(resolveTextModelConfig(user, 'brain')),
    structured: redactConfig(resolveTextModelConfig(user, 'structured')),
    styleBible: redactConfig(resolveTextModelConfig(user, 'styleBible')),
    projectClassifier: redactConfig(resolveTextModelConfig(user, 'projectClassifier')),
    styleClassifier: redactConfig(resolveTextModelConfig(user, 'styleClassifier')),
    profileDerive: redactConfig(resolveTextModelConfig(user, 'profileDerive')),
    continuity: redactConfig(resolveTextModelConfig(user, 'continuity')),
    frameConsistencyCheck: redactConfig(resolveTextModelConfig(user, 'frameConsistencyCheck')),
    visionExtract: redactConfig(resolveTextModelConfig(user, 'visionExtract')),
    image: redactConfig(resolveSlotModelConfig(user, 'image')),
    video: redactConfig(resolveSlotModelConfig(user, 'video')),
    env: {
      ...loadExternalEnv(),
      keys: loadExternalEnv().keys,
    },
  };
}

export function recordModelCallEvent(args: {
  cfg: Pick<ResolvedModelConfig, 'provider' | 'model' | 'source' | 'role' | 'mode'> & { fallbackOf?: string };
  slot?: string;
  status: 'ok' | 'failed' | 'error' | 'rate_limited' | string;
  statusCode?: number | null;
  errorCode?: string | null;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  traceName?: string;
  message?: string;
  meta?: Record<string, unknown>;
}) {
  const slot = args.slot || args.cfg.role || 'text';
  recordObservabilityEvent({
    type: 'model_call',
    slot,
    provider: args.cfg.provider,
    model: args.cfg.model,
    status: args.status,
    statusCode: args.statusCode ?? null,
    errorCode: args.errorCode || null,
    latencyMs: args.latencyMs ?? null,
    fallbackUsed: args.fallbackUsed || !!args.cfg.fallbackOf || args.cfg.mode === 'fake' || args.cfg.source === 'fallback',
    message: args.message || args.traceName || '',
    meta: {
      traceName: args.traceName || null,
      source: args.cfg.source,
      role: args.cfg.role || null,
      ...(args.meta || {}),
    },
  });
}

function resolveLegacyOpenAIConfig(
  user: UserRow | null,
  slot: ModelSlot,
  role: TextModelRole,
): ResolvedModelConfig {
  const userCfg = slot === 'text' ? readUserSlotConfig(user, slot) : null;
  if (userCfg) return { ...userCfg, role };

  const key = env('OPENAI_API_KEY');
  if (key) {
    return real({
      baseUrl: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
      apiKey: key,
      model: env('OPENAI_MODEL') || defaultModel(slot),
      provider: 'openai_chat',
      endpoint: '/chat/completions',
      source: 'env',
      role,
    });
  }
  return fake(slot, role);
}

function readUserSlotConfig(user: UserRow | null, slot: ModelSlot): ResolvedModelConfig | null {
  if (!user) return null;
  try {
    const settings: any = getJson('user_settings', user.id, MOCK_USER_SETTINGS);
    const slotCfg = (settings && settings.models && settings.models[slot]) || {};
    const key = String(slotCfg.apiKey || slotCfg.key || '').trim();
    if (!key) return null;
    return real({
      baseUrl: String(slotCfg.baseUrl || slotCfg.base || '').trim() || 'https://api.openai.com/v1',
      apiKey: key,
      model: String(slotCfg.model || '').trim() || defaultModel(slot),
      provider: inferProvider(slotCfg.provider || slotCfg.adapter || '', slot),
      endpoint: '/chat/completions',
      source: 'user-settings',
    });
  } catch (_) {
    return null;
  }
}

type RealModelInput = Omit<ResolvedModelConfig, 'mode' | 'contextWindow' | 'maxOutputTokens'> &
  Partial<Pick<ResolvedModelConfig, 'contextWindow' | 'maxOutputTokens'>>;

function real(input: RealModelInput): ResolvedModelConfig {
  const capacity = resolveModelCapacity(input);
  return {
    ...input,
    ...capacity,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    endpoint: input.endpoint ? normalizeEndpoint(input.endpoint) : input.endpoint,
    imageGenerationEndpoint: input.imageGenerationEndpoint
      ? normalizeEndpoint(input.imageGenerationEndpoint)
      : input.imageGenerationEndpoint,
    imageEditEndpoint: input.imageEditEndpoint ? normalizeEndpoint(input.imageEditEndpoint) : input.imageEditEndpoint,
    capabilities: input.capabilities || inferDefaultCapabilities(input.provider),
    mode: 'real',
  };
}

/**
 * 按 provider 推断默认能力。env IMAGE_MULTI_REF_CAP 可 override multiRefImage (1-16)。
 * OpenAI image edit 官方支持最多 16 张输入图; Seedream 官方文档写明最多 14 张。
 * 多图装配的实际格式依赖 probe 结论, 在 lib/image-gen.ts 按 transport 分支处理。
 */
function inferDefaultCapabilities(provider: ProviderKind): ModelCapabilities {
  const envCapRaw = process.env.IMAGE_MULTI_REF_CAP;
  const envCap = Number(envCapRaw);
  const envCapValid = Number.isFinite(envCap) && envCap >= 1 ? Math.min(Math.floor(envCap), 16) : null;

  if (provider === 'volcengine_seedream') {
    // Seedream 4.0/4.5/5.0-lite 官方文档写明最多 14 张参考图;
    // 本地 probe 已验证当前 env 模型的 2/3/4 图 image:string[] 形态可用。
    return {
      image: {
        multiRefImage: envCapValid != null ? Math.min(envCapValid, 14) : 14,
        transport: 'verified_seedream_array',
      },
    };
  }
  if (provider === 'zerail_images' || provider === 'code80_images' || provider === 'packy_images') {
    // OpenAI GPT image edit 官方上限 16, 多图 multipart 使用 image[] 字段。
    return {
      image: {
        multiRefImage: envCapValid ?? 16,
        transport: 'verified_openai_multipart_bracket',
      },
    };
  }
  // 其它 provider 回退单图, transport=single_image 时 image-gen 走旧的 referenceImagePath 路径。
  return {
    image: {
      multiRefImage: 1,
      transport: 'single_image',
    },
  };
}

function fake(slot: ModelSlot, role: TextModelRole): ResolvedModelConfig {
  const model = defaultModel(slot);
  const capacity = fallbackCapacityForModel(model);
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model,
    ...capacity,
    mode: 'fake',
    source: 'fallback',
    provider: 'fake',
    role,
  };
}

function redactConfig(cfg: ResolvedModelConfig): Record<string, unknown> {
  const fallbackConfigs: Record<string, unknown>[] | undefined = cfg.fallbackConfigs?.map(redactConfig);
  return {
    ...cfg,
    apiKey: cfg.apiKey ? '[configured]' : '',
    ...(fallbackConfigs?.length ? { fallbackConfigs } : {}),
  };
}

function inferProvider(provider: string, slot: ModelSlot): ProviderKind {
  const p = provider.toLowerCase();
  if (p.includes('seedream') || (slot === 'image' && p.includes('volcengine'))) return 'volcengine_seedream';
  if (p.includes('ark') || p.includes('volcengine') || p.includes('doubao')) return 'volcengine_chat';
  if (p.includes('seedance')) return 'seedance';
  if (p.includes('packy') && p.includes('image')) return 'packy_images';
  if (p.includes('packy') && (p.includes('message') || p.includes('claude'))) return 'packy_messages';
  if (p.includes('code80') && p.includes('image')) return 'code80_images';
  if (p.includes('code80') && (p.includes('message') || p.includes('claude'))) return 'code80_messages';
  if (p.includes('image')) return 'zerail_images';
  if (p.includes('packy') && p.includes('response')) return 'packy_responses';
  if (p.includes('openai') && p.includes('response')) return 'openai_responses';
  if (p.includes('response')) return 'zerail_responses';
  if (p.includes('message') || p.includes('claude')) return 'zerail_messages';
  if (slot === 'image') return 'zerail_images';
  if (slot === 'video') return 'openai_chat';
  return 'openai_chat';
}

function defaultModel(slot: ModelSlot): string {
  if (slot === 'image') return 'gpt-image-1';
  if (slot === 'video') return 'sora';
  return 'gpt-4o-mini';
}

function inferResponsesProvider(provider: string, baseUrl: string): ProviderKind {
  const p = provider.toLowerCase();
  if (p.includes('packy')) return 'packy_responses';
  if (p.includes('openai') && p.includes('response')) return 'openai_responses';
  if (p.includes('code80')) return 'openai_responses';
  if (p.includes('zerail') && p.includes('response')) return 'zerail_responses';
  if (baseUrl.toLowerCase().includes('packyapi.com')) return 'packy_responses';
  return baseUrl.toLowerCase().includes('api.openai.com') ? 'openai_responses' : 'zerail_responses';
}

function attachTextFallbackConfigs(cfg: ResolvedModelConfig, role: TextModelRole): ResolvedModelConfig {
  const fallbackConfigs = [
    ...(role === 'brain' ? resolveBrainTextFallbackConfigs(cfg) : []),
    ...resolveCode80TextFallbackConfigs(cfg, role),
  ];
  const deduped = dedupeFallbackConfigs(fallbackConfigs);
  return deduped.length ? { ...cfg, fallbackConfigs: deduped } : cfg;
}

function dedupeFallbackConfigs(configs: ResolvedModelConfig[]): ResolvedModelConfig[] {
  const seen = new Set<string>();
  const out: ResolvedModelConfig[] = [];
  for (const cfg of configs) {
    const key = [
      cfg.provider,
      normalizeBaseUrl(cfg.baseUrl),
      normalizeEndpoint(cfg.endpoint || ''),
      cfg.model,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cfg);
  }
  return out;
}

function resolveBrainTextFallbackConfigs(primary: ResolvedModelConfig): ResolvedModelConfig[] {
  if (env('BRAIN_FALLBACK_ENABLED').toLowerCase() === 'false') return [];

  const apiKey =
    env('BRAIN_FALLBACK_API_KEY') ||
    env('TEXT_API_KEY') ||
    env('OPENAI_API_KEY');
  if (!apiKey) return [];

  const baseUrl =
    env('BRAIN_FALLBACK_API_BASE') ||
    env('TEXT_API_BASE') ||
    env('OPENAI_BASE_URL') ||
    primary.baseUrl;
  const endpoint = env('BRAIN_FALLBACK_API_ENDPOINT') || env('TEXT_API_ENDPOINT') || '/responses';
  const provider = inferResponsesProvider(env('BRAIN_FALLBACK_PROVIDER') || env('TEXT_PROVIDER'), baseUrl);
  const model =
    env('BRAIN_FALLBACK_MODEL') ||
    env('TEXT_MODEL') ||
    env('OPENAI_MODEL') ||
    env('MODEL_STRUCTURED_WORKER') ||
    'gpt-5.5';

  const sameAsPrimary =
    primary.provider === provider &&
    normalizeBaseUrl(primary.baseUrl) === normalizeBaseUrl(baseUrl) &&
    normalizeEndpoint(primary.endpoint || '') === normalizeEndpoint(endpoint) &&
    primary.model === model;
  if (sameAsPrimary) return [];

  return [
    real({
      baseUrl,
      apiKey,
      model,
      provider,
      endpoint,
      role: 'brain',
      source: 'env',
      reasoningEffort: env('BRAIN_FALLBACK_REASONING_EFFORT') || env('TEXT_REASONING_EFFORT') || undefined,
      disableResponseStorage: envBool('BRAIN_FALLBACK_DISABLE_RESPONSE_STORAGE') ?? envBool('TEXT_DISABLE_RESPONSE_STORAGE'),
      fallbackOf: `${primary.provider}:${primary.model}`,
    }),
  ];
}

function attachImageFallbackConfigs(cfg: ResolvedModelConfig): ResolvedModelConfig {
  if (cfg.provider === 'volcengine_seedream') return cfg;
  if (env('IMAGE_FALLBACK_ENABLED').toLowerCase() === 'false') return cfg;

  const fallback = resolveImageFallbackConfig(cfg);
  return fallback ? { ...cfg, fallbackConfigs: [fallback] } : cfg;
}

function resolveImageFallbackConfig(primary: ResolvedModelConfig): ResolvedModelConfig | null {
  const provider = inferProvider(env('IMAGE_FALLBACK_PROVIDER') || 'volcengine_seedream', 'image');
  const isSeedream = provider === 'volcengine_seedream';
  const apiKey =
    env('IMAGE_FALLBACK_API_KEY') ||
    env('IMAGE_FALLBACK_SEEDREAM_API_KEY') ||
    (isSeedream ? env('IMAGE_SEEDREAM_API_KEY') : '');
  if (!apiKey) return null;

  const generationEndpoint =
    env('IMAGE_FALLBACK_GENERATIONS_ENDPOINT') ||
    env('IMAGE_FALLBACK_GENERATION_ENDPOINT') ||
    env('IMAGE_FALLBACK_ENDPOINT') ||
    '/images/generations';
  const editEndpoint =
    env('IMAGE_FALLBACK_EDITS_ENDPOINT') ||
    env('IMAGE_FALLBACK_EDIT_ENDPOINT') ||
    '/images/edits';

  return real({
    baseUrl: env('IMAGE_FALLBACK_API_BASE') || (isSeedream ? 'https://ark.cn-beijing.volces.com/api/v3' : primary.baseUrl),
    apiKey,
    model:
      env('IMAGE_FALLBACK_MODEL') ||
      env('IMAGE_FALLBACK_SEEDREAM_MODEL') ||
      (isSeedream ? 'doubao-seedream-4-5-251128' : primary.model),
    provider,
    endpoint: generationEndpoint,
    imageGenerationEndpoint: generationEndpoint,
    imageEditEndpoint: editEndpoint,
    imageQuality: env('IMAGE_FALLBACK_QUALITY') || undefined,
    imageSize: env('IMAGE_FALLBACK_SEEDREAM_SIZE') || env('IMAGE_SEEDREAM_SIZE') || undefined,
    imageResponseFormat: env('IMAGE_FALLBACK_SEEDREAM_RESPONSE_FORMAT') || env('IMAGE_SEEDREAM_RESPONSE_FORMAT') || undefined,
    imageWatermark: envBool('IMAGE_FALLBACK_SEEDREAM_WATERMARK') ?? envBool('IMAGE_SEEDREAM_WATERMARK'),
    seedreamSequentialImageGeneration:
      env('IMAGE_FALLBACK_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION') ||
      env('IMAGE_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION') ||
      undefined,
    seedreamOptimizePromptMode:
      env('IMAGE_FALLBACK_SEEDREAM_OPTIMIZE_PROMPT_MODE') ||
      env('IMAGE_SEEDREAM_OPTIMIZE_PROMPT_MODE') ||
      undefined,
    timeoutMs: secondsToMs(env('IMAGE_FALLBACK_TIMEOUT_SECONDS') || env('IMAGE_TIMEOUT_SECONDS')),
    source: 'env',
    fallbackOf: `${primary.provider}:${primary.model}`,
  });
}

function resolveCode80TextFallbackConfigs(primary: ResolvedModelConfig, role: TextModelRole): ResolvedModelConfig[] {
  if (env('TEXT_FALLBACK_ENABLED').toLowerCase() === 'false') return [];
  const apiKey = env('CODE80_API_KEY') || env('TEXT_FALLBACK_API_KEY');
  if (!apiKey) return [];

  const prefix = roleEnvPrefix(role);
  const roleFallbackPrefix = prefix ? `${prefix}_FALLBACK` : '';
  const baseUrl = env('CODE80_API_BASE') || env('TEXT_FALLBACK_API_BASE') || 'https://code.ai80.vip';
  const provider = inferResponsesProvider(env('CODE80_PROVIDER') || env('TEXT_FALLBACK_PROVIDER') || 'code80', baseUrl);
  const endpoint = env('CODE80_API_ENDPOINT') || env('TEXT_FALLBACK_API_ENDPOINT') || '/responses';
  const model =
    prefixedEnv(roleFallbackPrefix, 'MODEL') ||
    env('CODE80_MODEL') ||
    env('TEXT_FALLBACK_MODEL') ||
    env('CODE80_REVIEW_MODEL') ||
    'gpt-5.4';
  const reasoningEffort =
    prefixedEnv(roleFallbackPrefix, 'REASONING_EFFORT') ||
    env('CODE80_REASONING_EFFORT') ||
    env('TEXT_FALLBACK_REASONING_EFFORT') ||
    primary.reasoningEffort;

  return [
    real({
      baseUrl,
      apiKey,
      model,
      provider,
      endpoint,
      role,
      source: 'env',
      reasoningEffort,
      contextWindow: positiveInt(env('CODE80_CONTEXT_WINDOW')) || positiveInt(env('TEXT_FALLBACK_CONTEXT_WINDOW')) || undefined,
      maxOutputTokens: positiveInt(env('CODE80_MAX_OUTPUT_TOKENS')) || positiveInt(env('TEXT_FALLBACK_MAX_OUTPUT_TOKENS')) || undefined,
      disableResponseStorage: envBool('CODE80_DISABLE_RESPONSE_STORAGE') ?? envBool('TEXT_FALLBACK_DISABLE_RESPONSE_STORAGE'),
      fallbackOf: `${primary.provider}:${primary.model}`,
    }),
  ];
}

function resolveModelCapacity(input: RealModelInput): Pick<ResolvedModelConfig, 'contextWindow' | 'maxOutputTokens'> {
  const fallback = fallbackCapacityForModel(input.model);
  return {
    contextWindow: input.contextWindow || capacityEnvInt(input, 'CONTEXT_WINDOW') || fallback.contextWindow,
    maxOutputTokens: input.maxOutputTokens || capacityEnvInt(input, 'MAX_OUTPUT_TOKENS') || fallback.maxOutputTokens,
  };
}

function capacityEnvInt(input: RealModelInput, suffix: 'CONTEXT_WINDOW' | 'MAX_OUTPUT_TOKENS'): number | undefined {
  for (const name of capacityEnvNames(input, suffix)) {
    const value = positiveInt(env(name));
    if (value) return value;
  }
  return undefined;
}

function capacityEnvNames(input: RealModelInput, suffix: 'CONTEXT_WINDOW' | 'MAX_OUTPUT_TOKENS'): string[] {
  const names: string[] = [];
  const role = input.role;
  const provider = input.provider;

  if (role === 'styleBible') names.push(`STYLE_BIBLE_${suffix}`);
  else if (role === 'projectClassifier') names.push(`PROJECT_CLASSIFIER_${suffix}`, `STYLE_CLASSIFIER_${suffix}`);
  else if (role === 'styleClassifier') names.push(`STYLE_CLASSIFIER_${suffix}`, `PROJECT_CLASSIFIER_${suffix}`);
  else if (role === 'profileDerive') names.push(`PROFILE_DERIVE_${suffix}`);
  else if (role === 'continuity') names.push(`CONTINUITY_${suffix}`);
  else if (role === 'frameConsistencyCheck') names.push(`FRAME_CONSISTENCY_CHECK_${suffix}`);
  else if (role === 'visionExtract') names.push(`VISION_EXTRACT_${suffix}`);
  else if (role === 'structured') names.push(`STRUCTURED_${suffix}`);
  else if (role === 'brain') names.push(`BRAIN_${suffix}`, `CLAUDE_${suffix}`);

  if (provider === 'zerail_messages' || provider === 'code80_messages' || provider === 'packy_messages') names.push(`CLAUDE_${suffix}`);
  if (provider === 'openai_chat' || provider === 'openai_responses' || provider === 'packy_responses' || provider === 'zerail_responses') {
    names.push(`TEXT_${suffix}`, `OPENAI_${suffix}`);
  }
  if (provider === 'volcengine_chat') names.push(`PROJECT_CLASSIFIER_${suffix}`, `STYLE_CLASSIFIER_${suffix}`, `TEXT_${suffix}`);
  if (provider === 'zerail_images' || provider === 'code80_images' || provider === 'packy_images') names.push(`IMAGE_${suffix}`);
  if (provider === 'volcengine_seedream') names.push(`IMAGE_${suffix}`);
  if (provider === 'seedance') names.push(`VIDEO_${suffix}`);

  names.push(`LLM_${suffix}`);
  return Array.from(new Set(names));
}

function fallbackCapacityForModel(model: string): Pick<ResolvedModelConfig, 'contextWindow' | 'maxOutputTokens'> {
  const m = (model || '').toLowerCase();
  if (m.includes('doubao-seed-2-0-pro') || m.includes('doubao-seed-2.0-pro')) {
    return { contextWindow: 256_000, maxOutputTokens: 32_768 };
  }
  if (m.includes('gpt-5.5')) return { contextWindow: 400_000, maxOutputTokens: 32_768 };
  if (m.includes('gpt-5')) return { contextWindow: 400_000, maxOutputTokens: 32_768 };
  if (m.includes('claude')) return { contextWindow: 200_000, maxOutputTokens: 32_000 };
  if (m.includes('gpt-4o')) return { contextWindow: 128_000, maxOutputTokens: 16_384 };
  if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return { contextWindow: 128_000, maxOutputTokens: 32_768 };
  if (m.includes('gemini')) return { contextWindow: 1_000_000, maxOutputTokens: 32_768 };
  return { contextWindow: 128_000, maxOutputTokens: 8_192 };
}

function env(name: string): string {
  return (getExternalEnvValue(name) ?? process.env[name] ?? '').trim();
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return '';
}

function secretEnv(name: string): string {
  const value = env(name);
  if (!value) return '';
  if (/^(replace-with|your-|填入|请填|xxx|todo)/i.test(value)) return '';
  return value;
}

function roleEnvPrefix(role: TextModelRole): string {
  if (role === 'styleBible') return 'STYLE_BIBLE';
  if (role === 'projectClassifier') return 'PROJECT_CLASSIFIER';
  if (role === 'styleClassifier') return 'STYLE_CLASSIFIER';
  if (role === 'profileDerive') return 'PROFILE_DERIVE';
  if (role === 'continuity') return 'CONTINUITY';
  if (role === 'frameConsistencyCheck') return 'FRAME_CONSISTENCY_CHECK';
  if (role === 'visionExtract') return 'VISION_EXTRACT';
  return '';
}

function prefixedEnv(prefix: string, suffix: string): string {
  return prefix ? env(`${prefix}_${suffix}`) : '';
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  return endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
}

function secondsToMs(value: string): number | undefined {
  const n = positiveInt(value);
  return n ? n * 1000 : undefined;
}

function positiveInt(value: string): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function envBool(name: string): boolean | undefined {
  const value = env(name).toLowerCase();
  if (!value) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return undefined;
}
