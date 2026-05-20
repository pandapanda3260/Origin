import { resolveSlotModelConfig } from '../lib/model-routing';

function redactConfig(cfg: ReturnType<typeof resolveSlotModelConfig>) {
  return {
    mode: cfg.mode,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    generationEndpoint: cfg.imageGenerationEndpoint || cfg.endpoint || null,
    editEndpoint: cfg.imageEditEndpoint || null,
    hasApiKey: !!cfg.apiKey,
    fallbackOf: cfg.fallbackOf || null,
    fallbacks: (cfg.fallbackConfigs || []).map((fallback) => ({
      mode: fallback.mode,
      provider: fallback.provider,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
      generationEndpoint: fallback.imageGenerationEndpoint || fallback.endpoint || null,
      editEndpoint: fallback.imageEditEndpoint || null,
      hasApiKey: !!fallback.apiKey,
      fallbackOf: fallback.fallbackOf || null,
    })),
  };
}

function main() {
  const cfg = resolveSlotModelConfig(null, 'image');
  const status = redactConfig(cfg);
  console.log(JSON.stringify(status, null, 2));

  if (cfg.provider !== 'zerail_images' || !/gpt-image-2/i.test(cfg.model || '')) {
    console.warn(
      '[check-image-routing] image primary is not Zerail GPT-image-2. Set IMAGE_PROVIDER=zerail_images, IMAGE_API_KEY, and IMAGE_MODEL=gpt-image-2.',
    );
    process.exitCode = 2;
    return;
  }

  const fallback = cfg.fallbackConfigs?.[0];
  if (!fallback || fallback.provider !== 'volcengine_seedream' || !fallback.apiKey) {
    console.warn(
      '[check-image-routing] Seedream fallback is not configured. Keep IMAGE_SEEDREAM_API_KEY or set IMAGE_FALLBACK_API_KEY.',
    );
    process.exitCode = 2;
    return;
  }

  console.log('[check-image-routing] image primary/fallback routing is ready');
}

main();
