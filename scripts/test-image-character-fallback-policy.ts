import assert from 'node:assert/strict';
import { isCharacterImageInput, shouldAllowImageProviderFallback } from '../lib/image-gen';

const original = process.env.IMAGE_CHARACTER_FALLBACK_ENABLED;

try {
  delete process.env.IMAGE_CHARACTER_FALLBACK_ENABLED;
  assert.equal(isCharacterImageInput({ kind: 'character' }), true);
  assert.equal(isCharacterImageInput({ kind: 'other', assetRef: 'characters[0]' }), true);
  assert.equal(isCharacterImageInput({ kind: 'other', assetLibrary: { stage: 'asset_character' } }), true);
  assert.equal(isCharacterImageInput({ kind: 'scene', assetRef: 'scenes[0]' }), false);

  assert.equal(shouldAllowImageProviderFallback({ kind: 'character' }), false);
  assert.equal(shouldAllowImageProviderFallback({ kind: 'other', assetRef: 'characters[2]' }), false);
  assert.equal(shouldAllowImageProviderFallback({ kind: 'scene', assetRef: 'scenes[0]' }), true);

  process.env.IMAGE_CHARACTER_FALLBACK_ENABLED = 'true';
  assert.equal(shouldAllowImageProviderFallback({ kind: 'character' }), true);

  process.env.IMAGE_CHARACTER_FALLBACK_ENABLED = '0';
  assert.equal(shouldAllowImageProviderFallback({ kind: 'character' }), false);
} finally {
  if (original === undefined) delete process.env.IMAGE_CHARACTER_FALLBACK_ENABLED;
  else process.env.IMAGE_CHARACTER_FALLBACK_ENABLED = original;
}

console.log('[test-image-character-fallback-policy] all assertions passed');
