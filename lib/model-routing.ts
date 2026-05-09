import type { UserRow } from './db';
import { getJson } from './kv-db';
import { loadExternalEnv } from './env';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';

export type ModelSlot = 'text' | 'image' | 'video' | 'storyboard';
export type TextModelRole = 'brain' | 'structured' | 'styleBible' | 'profileDerive' | 'continuity' | 'legacy';
export type ProviderKind =
  | 'openai_chat'
  | 'openai_responses'
  | 'zerail_messages'
  | 'zerail_responses'
  | 'zerail_images'
  | 'volcengine_seedream'
  | 'seedance'
  | 'fake';

export type ModelConfigSource = 'user-settings' | 'env' | 'fallback';

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
};

export function resolveTextModelConfig(
  user: UserRow | null,
  role: TextModelRole = 'brain',
): ResolvedModelConfig {
  loadExternalEnv();

  if (role === 'brain') {
    const key = env('CLAUDE_API_KEY') || env('TEXT_API_KEY');
    if (key) {
      return real({
        baseUrl: env('CLAUDE_API_BASE') || env('TEXT_API_BASE') || 'https://gateway.zerail.com/v1',
        apiKey: key,
        model: env('CLAUDE_MODEL') || env('MODEL_PRIMARY_BRAIN') || 'claude-opus-4-7',
        provider: 'zerail_messages',
        endpoint: env('CLAUDE_API_ENDPOINT') || '/messages',
        role,
        source: 'env',
        tier: env('CLAUDE_TIER') || env('MODEL_PRIMARY_BRAIN_TIER') || undefined,
      });
    }
  }

  if (role === 'structured' || role === 'styleBible' || role === 'profileDerive' || role === 'continuity') {
    const prefix = roleEnvPrefix(role);
    const key = prefixedEnv(prefix, 'API_KEY') || env('TEXT_API_KEY') || env('OPENAI_API_KEY');
    if (key) {
      const baseUrl = prefixedEnv(prefix, 'API_BASE') || env('TEXT_API_BASE') || env('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
      const provider = inferResponsesProvider(prefixedEnv(prefix, 'PROVIDER') || env('TEXT_PROVIDER'), baseUrl);
      return real({
        baseUrl,
        apiKey: key,
        model: prefixedEnv(prefix, 'MODEL') || env('TEXT_MODEL') || env('OPENAI_MODEL') || env('MODEL_STRUCTURED_WORKER') || 'gpt-5.5',
        provider,
        endpoint: prefixedEnv(prefix, 'API_ENDPOINT') || env('TEXT_API_ENDPOINT') || '/responses',
        role,
        source: 'env',
        reasoningEffort: prefixedEnv(prefix, 'REASONING_EFFORT') || (role === 'continuity' ? 'none' : env('TEXT_REASONING_EFFORT') || undefined),
      });
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
      ? env('IMAGE_SEEDREAM_API_KEY') || env('VIDEO_API_KEY') || env('IMAGE_API_KEY')
      : env('IMAGE_API_KEY');
    if (key) {
      return real({
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
    profileDerive: redactConfig(resolveTextModelConfig(user, 'profileDerive')),
    continuity: redactConfig(resolveTextModelConfig(user, 'continuity')),
    image: redactConfig(resolveSlotModelConfig(user, 'image')),
    video: redactConfig(resolveSlotModelConfig(user, 'video')),
    env: {
      ...loadExternalEnv(),
      keys: loadExternalEnv().keys,
    },
  };
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
    mode: 'real',
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

function redactConfig(cfg: ResolvedModelConfig) {
  return {
    ...cfg,
    apiKey: cfg.apiKey ? '[configured]' : '',
  };
}

function inferProvider(provider: string, slot: ModelSlot): ProviderKind {
  const p = provider.toLowerCase();
  if (p.includes('seedream') || p.includes('volcengine')) return 'volcengine_seedream';
  if (p.includes('seedance')) return 'seedance';
  if (p.includes('image')) return 'zerail_images';
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
  if (p.includes('openai') && p.includes('response')) return 'openai_responses';
  if (p.includes('zerail') && p.includes('response')) return 'zerail_responses';
  return baseUrl.toLowerCase().includes('api.openai.com') ? 'openai_responses' : 'zerail_responses';
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
  else if (role === 'profileDerive') names.push(`PROFILE_DERIVE_${suffix}`);
  else if (role === 'continuity') names.push(`CONTINUITY_${suffix}`);
  else if (role === 'structured') names.push(`STRUCTURED_${suffix}`);
  else if (role === 'brain') names.push(`BRAIN_${suffix}`, `CLAUDE_${suffix}`);

  if (provider === 'zerail_messages') names.push(`CLAUDE_${suffix}`);
  if (provider === 'openai_chat' || provider === 'openai_responses' || provider === 'zerail_responses') {
    names.push(`TEXT_${suffix}`, `OPENAI_${suffix}`);
  }
  if (provider === 'zerail_images') names.push(`IMAGE_${suffix}`);
  if (provider === 'volcengine_seedream') names.push(`IMAGE_${suffix}`);
  if (provider === 'seedance') names.push(`VIDEO_${suffix}`);

  names.push(`LLM_${suffix}`);
  return Array.from(new Set(names));
}

function fallbackCapacityForModel(model: string): Pick<ResolvedModelConfig, 'contextWindow' | 'maxOutputTokens'> {
  const m = (model || '').toLowerCase();
  if (m.includes('gpt-5.5')) return { contextWindow: 400_000, maxOutputTokens: 32_768 };
  if (m.includes('gpt-5')) return { contextWindow: 400_000, maxOutputTokens: 32_768 };
  if (m.includes('claude')) return { contextWindow: 200_000, maxOutputTokens: 32_000 };
  if (m.includes('gpt-4o')) return { contextWindow: 128_000, maxOutputTokens: 16_384 };
  if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return { contextWindow: 128_000, maxOutputTokens: 32_768 };
  if (m.includes('gemini')) return { contextWindow: 1_000_000, maxOutputTokens: 32_768 };
  return { contextWindow: 128_000, maxOutputTokens: 8_192 };
}

function env(name: string): string {
  return (process.env[name] || '').trim();
}

function roleEnvPrefix(role: TextModelRole): string {
  if (role === 'styleBible') return 'STYLE_BIBLE';
  if (role === 'profileDerive') return 'PROFILE_DERIVE';
  if (role === 'continuity') return 'CONTINUITY';
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
