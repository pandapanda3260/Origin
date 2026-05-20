import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-image-routing-'));
process.env.ORIGIN_ENV_FILE = join(tempDir, 'empty.env');
writeFileSync(process.env.ORIGIN_ENV_FILE, '');

const IMAGE_ENV_KEYS = [
  'IMAGE_PROVIDER',
  'IMAGE_API_BASE',
  'IMAGE_API_KEY',
  'IMAGE_MODEL',
  'MODEL_IMAGE_PRIMARY',
  'IMAGE_GENERATIONS_ENDPOINT',
  'IMAGE_EDITS_ENDPOINT',
  'IMAGE_QUALITY',
  'IMAGE_TIMEOUT_SECONDS',
  'IMAGE_FALLBACK_ENABLED',
  'IMAGE_FALLBACK_PROVIDER',
  'IMAGE_FALLBACK_API_BASE',
  'IMAGE_FALLBACK_API_KEY',
  'IMAGE_FALLBACK_SEEDREAM_API_KEY',
  'IMAGE_FALLBACK_MODEL',
  'IMAGE_FALLBACK_SEEDREAM_MODEL',
  'IMAGE_FALLBACK_GENERATIONS_ENDPOINT',
  'IMAGE_FALLBACK_EDITS_ENDPOINT',
  'IMAGE_FALLBACK_TIMEOUT_SECONDS',
  'IMAGE_FALLBACK_SEEDREAM_SIZE',
  'IMAGE_FALLBACK_SEEDREAM_RESPONSE_FORMAT',
  'IMAGE_FALLBACK_SEEDREAM_WATERMARK',
  'IMAGE_FALLBACK_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION',
  'IMAGE_FALLBACK_SEEDREAM_OPTIMIZE_PROMPT_MODE',
  'IMAGE_SEEDREAM_API_KEY',
  'IMAGE_SEEDREAM_SIZE',
  'IMAGE_SEEDREAM_RESPONSE_FORMAT',
  'IMAGE_SEEDREAM_WATERMARK',
  'IMAGE_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION',
  'IMAGE_SEEDREAM_OPTIMIZE_PROMPT_MODE',
];

function resetImageEnv() {
  for (const key of IMAGE_ENV_KEYS) delete process.env[key];
}

async function main() {
  const { resolveSlotModelConfig } = await import('../lib/model-routing');

  resetImageEnv();
  process.env.IMAGE_PROVIDER = 'zerail_images';
  process.env.IMAGE_API_BASE = 'https://gateway.zerail.com/v1';
  process.env.IMAGE_API_KEY = 'zerail-test-key';
  process.env.IMAGE_MODEL = 'gpt-image-2';
  process.env.IMAGE_SEEDREAM_API_KEY = 'seedream-test-key';
  process.env.IMAGE_SEEDREAM_SIZE = '4K';
  const cfg = resolveSlotModelConfig(null, 'image');
  assert.equal(cfg.mode, 'real');
  assert.equal(cfg.provider, 'zerail_images');
  assert.equal(cfg.baseUrl, 'https://gateway.zerail.com/v1');
  assert.equal(cfg.model, 'gpt-image-2');
  assert.equal(cfg.fallbackConfigs?.length, 1);
  assert.equal(cfg.fallbackConfigs?.[0]?.provider, 'volcengine_seedream');
  assert.equal(cfg.fallbackConfigs?.[0]?.model, 'doubao-seedream-4-5-251128');
  assert.equal(cfg.fallbackConfigs?.[0]?.apiKey, 'seedream-test-key');
  assert.equal(cfg.fallbackConfigs?.[0]?.fallbackOf, 'zerail_images:gpt-image-2');
  assert.equal(cfg.fallbackConfigs?.[0]?.imageSize, '4K');

  resetImageEnv();
  process.env.IMAGE_PROVIDER = 'zerail_images';
  process.env.IMAGE_API_KEY = 'zerail-test-key';
  process.env.IMAGE_MODEL = 'gpt-image-2';
  process.env.IMAGE_SEEDREAM_API_KEY = 'seedream-test-key';
  process.env.IMAGE_FALLBACK_ENABLED = 'false';
  const disabled = resolveSlotModelConfig(null, 'image');
  assert.equal(disabled.provider, 'zerail_images');
  assert.equal(disabled.fallbackConfigs, undefined);

  resetImageEnv();
  process.env.IMAGE_PROVIDER = 'volcengine_seedream';
  process.env.IMAGE_SEEDREAM_API_KEY = 'seedream-test-key';
  const seedreamPrimary = resolveSlotModelConfig(null, 'image');
  assert.equal(seedreamPrimary.provider, 'volcengine_seedream');
  assert.equal(seedreamPrimary.fallbackConfigs, undefined);

  console.log('[test-image-provider-routing] all assertions passed');
}

main()
  .finally(() => {
    rmSync(tempDir, { recursive: true, force: true });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
