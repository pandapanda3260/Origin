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

  if (cfg.mode !== 'real' || !cfg.apiKey) {
    console.warn(
      '[check-image-routing] image primary is not configured. Set IMAGE_PROVIDER, IMAGE_API_BASE, IMAGE_API_KEY, and IMAGE_MODEL in the external env file.',
    );
    process.exitCode = 2;
    return;
  }

  if (!cfg.baseUrl || !cfg.model || !cfg.provider || cfg.provider === 'fake') {
    console.warn(
      '[check-image-routing] image primary resolved to an incomplete provider/model/baseUrl tuple.',
    );
    process.exitCode = 2;
    return;
  }

  const fallback = cfg.fallbackConfigs?.[0];
  if (fallback && !fallback.apiKey) {
    console.warn('[check-image-routing] image fallback exists but has no API key.');
    process.exitCode = 2;
    return;
  }

  console.log('[check-image-routing] image routing is ready for the current external env');
}

main();
