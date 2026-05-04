import type { UserRow } from './db';
import { getJson } from './kv-db';
import { loadExternalEnv } from './env';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';

export type ModelSlot = 'text' | 'image' | 'video' | 'storyboard';
export type TextModelRole = 'brain' | 'structured' | 'styleBible' | 'profileDerive' | 'legacy';
export type ProviderKind =
  | 'openai_chat'
  | 'openai_responses'
  | 'zerail_messages'
  | 'zerail_responses'
  | 'zerail_images'
  | 'seedance'
  | 'fake';

export type ModelConfigSource = 'user-settings' | 'env' | 'fallback';

export type ResolvedModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
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

  if (role === 'structured' || role === 'styleBible' || role === 'profileDerive') {
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
        reasoningEffort: prefixedEnv(prefix, 'REASONING_EFFORT') || env('TEXT_REASONING_EFFORT') || undefined,
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
    const key = env('IMAGE_API_KEY');
    if (key) {
      return real({
        baseUrl: env('IMAGE_API_BASE') || 'https://gateway.zerail.com/v1',
        apiKey: key,
        model: env('IMAGE_MODEL') || env('MODEL_IMAGE_PRIMARY') || 'gpt-image-2',
        provider: 'zerail_images',
        endpoint: env('IMAGE_GENERATIONS_ENDPOINT') || '/images/generations',
        imageGenerationEndpoint: env('IMAGE_GENERATIONS_ENDPOINT') || '/images/generations',
        imageEditEndpoint: env('IMAGE_EDITS_ENDPOINT') || '/images/edits',
        imageQuality: env('IMAGE_QUALITY') || undefined,
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

function real(input: Omit<ResolvedModelConfig, 'mode'>): ResolvedModelConfig {
  return {
    ...input,
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
  return {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: defaultModel(slot),
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

function env(name: string): string {
  return (process.env[name] || '').trim();
}

function roleEnvPrefix(role: TextModelRole): string {
  if (role === 'styleBible') return 'STYLE_BIBLE';
  if (role === 'profileDerive') return 'PROFILE_DERIVE';
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
