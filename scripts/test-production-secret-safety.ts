import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isPlaceholderSecret, isProductionSecretUsable } from '../lib/secret-safety';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-prod-secret-safety-'));
const emptyEnv = join(tempDir, 'empty.env');
writeFileSync(emptyEnv, '');

function setNodeEnv(value: string) {
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = value;
}

setNodeEnv('production');
process.env.ORIGIN_ENV_FILE = emptyEnv;
process.env.ORIGIN_DATA_DIR = join(tempDir, 'data');
process.env.DB_PATH = join(tempDir, 'data', 'qd.sqlite');
process.env.ORIGIN_EXPECT_WORKER = '0';
process.env.ONLINE_EDITOR_ENABLED = '0';
process.env.BILLING_DEV_AUTOPAY = '0';

assert.equal(isPlaceholderSecret('replace-with-at-least-32-random-bytes'), true);
assert.equal(isPlaceholderSecret('dev-jwt-secret-please-change-me-32-bytes-long'), true);
assert.equal(isProductionSecretUsable('replace-with-at-least-32-random-bytes'), false);
assert.equal(isProductionSecretUsable('0123456789abcdef0123456789abcdef'), true);

async function main() {
  const { getRuntimeHealth } = await import('../lib/runtime-health');

  process.env.JWT_SECRET = 'replace-with-at-least-32-random-bytes';
  process.env.ADMIN_JWT_SECRET = 'replace-with-different-at-least-32-random-bytes';
  process.env.ASSET_URL_SECRET = 'replace-with-different-at-least-32-random-bytes';

  let health = getRuntimeHealth();
  const placeholderSecretChecks = new Map(health.checks.map((check) => [check.name, check]));
  assert.equal(placeholderSecretChecks.get('secrets.jwt')?.status, 'fail');
  assert.equal(placeholderSecretChecks.get('secrets.adminJwt')?.status, 'fail');
  assert.equal(placeholderSecretChecks.get('secrets.assetUrl')?.status, 'fail');

  process.env.JWT_SECRET = 'user-0123456789abcdef0123456789abcdef';
  process.env.ADMIN_JWT_SECRET = 'admin-0123456789abcdef0123456789abcdef';
  process.env.ASSET_URL_SECRET = 'asset-0123456789abcdef0123456789abcdef';

  health = getRuntimeHealth();
  const validSecretChecks = new Map(health.checks.map((check) => [check.name, check]));
  assert.equal(validSecretChecks.get('secrets.jwt')?.status, 'ok');
  assert.equal(validSecretChecks.get('secrets.adminJwt')?.status, 'ok');
  assert.equal(validSecretChecks.get('secrets.adminJwtDistinct')?.status, 'ok');
  assert.equal(validSecretChecks.get('secrets.assetUrl')?.status, 'ok');
  assert.equal(validSecretChecks.get('secrets.assetUrlDistinct')?.status, 'ok');

  process.env.ADMIN_JWT_SECRET = process.env.JWT_SECRET;
  health = getRuntimeHealth();
  const duplicateSecretChecks = new Map(health.checks.map((check) => [check.name, check]));
  assert.equal(duplicateSecretChecks.get('secrets.adminJwtDistinct')?.status, 'fail');

  process.env.ADMIN_JWT_SECRET = 'admin-0123456789abcdef0123456789abcdef';
  process.env.ASSET_URL_SECRET = process.env.JWT_SECRET;
  health = getRuntimeHealth();
  const duplicateAssetSecretChecks = new Map(health.checks.map((check) => [check.name, check]));
  assert.equal(duplicateAssetSecretChecks.get('secrets.assetUrlDistinct')?.status, 'fail');

  delete process.env.ASSET_URL_SECRET;
  health = getRuntimeHealth();
  const missingAssetSecretChecks = new Map(health.checks.map((check) => [check.name, check]));
  assert.equal(missingAssetSecretChecks.get('secrets.assetUrl')?.status, 'fail');

  console.log('test-production-secret-safety: all assertions passed');
}

main().catch((error) => {
  console.error('[test-production-secret-safety] failed:', error?.message || error);
  process.exit(1);
});
