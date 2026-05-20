import assert from 'node:assert/strict';
import {
  STYLE_LOCK_VERSION,
  assetStyleSignature,
  buildAssetStyleLock,
  computeAssetStyleStaleFlags,
  isWhiteSafeBackdrop,
} from '../lib/asset-style-lock';
import { composeFinalImagePrompt } from '../lib/image-gen';

const noirBible = {
  visualStyle: '冷峻都市/霓虹雨夜/真人黑色电影/婚礼反差/荒诞悬疑',
  visualStyleDesc: 'cold city noir with absurd suspense',
  mood: '克制、危险、反差',
  lighting: '高反差冷光，霓虹反射，雨夜氛围',
  texture: '胶片颗粒、湿冷金属',
  cameraStyle: 'low angle anamorphic',
  era: 'near future',
  worldRules: 'wedding objects can appear as ironic contrast',
  colorPalette: [
    { name: 'ink black', hex: '#101820' },
    { name: 'neon cyan', hex: '#08D9D6' },
  ],
  negativePrompt: 'plastic skin, CG look, overexposed skin',
  additionalPrompt: 'subtle film grain',
};

const animationBible = {
  visualStyle: '2D 动画',
  mood: '明快',
  lighting: '柔和',
  texture: '平涂',
};

const watercolorBible = {
  visualStyle: '水彩',
  mood: '安静',
  lighting: '自然漫射光',
  texture: '纸张纤维',
};

function assertIncludes(haystack: string, needle: string) {
  assert.ok(haystack.includes(needle), `expected prompt to include: ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string) {
  assert.ok(!haystack.includes(needle), `expected prompt not to include: ${needle}`);
}

function finalCharacterPrompt(styleBible: any, entityType: 'human' | 'non-human' = 'human') {
  const lock = buildAssetStyleLock(styleBible, 'char');
  const finalPrompt = composeFinalImagePrompt({
    prompt: `Subject: Test character.\n\n${lock.prompt}`,
    style: 'natural',
    kind: 'character',
    entityType,
    styleLockApplied: lock.hasMeaningfulStyle,
    styleBackdropColor: lock.resolvedBackdropColor,
  });
  return { lock, finalPrompt };
}

assert.equal(STYLE_LOCK_VERSION, 3, 'style lock version should bump when the character style contract changes');

assert.equal(isWhiteSafeBackdrop('#F4F6F8'), true, 'cold backdrop must satisfy splitter-safe threshold');
assert.equal(isWhiteSafeBackdrop('#FAF8F4'), true, 'warm backdrop must satisfy splitter-safe threshold');
assert.equal(isWhiteSafeBackdrop('#F4F1ED'), false, 'old warm candidate must remain rejected');
assert.equal(isWhiteSafeBackdrop('#EEF1F4'), false, 'near-threshold colors should not be accepted');

const noir = finalCharacterPrompt(noirBible, 'human');
assert.equal(noir.lock.resolvedBackdropColor, '#FFFFFF', 'character backdrop metadata should be pure white in v3');
assert.equal(noir.lock.signatureType, 'char');
assert.equal(noir.lock.signature.length, 64);
assertIncludes(noir.lock.prompt, 'PROJECT CHARACTER STYLE LOCK');
assertIncludes(noir.lock.prompt, noirBible.visualStyle);
assertIncludes(noir.lock.prompt, 'Lighting hint');
assertIncludes(noir.lock.prompt, 'apply ONLY to the character body');
assertIncludes(noir.lock.prompt, 'Additional character-only style hint');
assertNotIncludes(noir.lock.prompt, 'Project color palette:');
assertNotIncludes(noir.lock.prompt, '#101820');
assertNotIncludes(noir.lock.prompt, 'Reference-sheet backdrop color:');
assertIncludes(noir.lock.prompt, noirBible.lighting);
assertIncludes(noir.lock.prompt, noirBible.negativePrompt);
assertNotIncludes(noir.lock.prompt, noirBible.cameraStyle);
assertNotIncludes(noir.lock.prompt, noirBible.worldRules);
assert.equal((noir.finalPrompt.match(/Background:/g) || []).length, 1, 'character final prompt should have one background authority');
assertIncludes(noir.finalPrompt, 'Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop');
assertIncludes(noir.finalPrompt, 'NO readable hex codes or color names rendered as text INSIDE THE IMAGE');
assertIncludes(noir.finalPrompt, 'follows the PROJECT CHARACTER STYLE LOCK above');
assertNotIncludes(noir.finalPrompt, 'resolved color #F4F6F8');
assertNotIncludes(noir.finalPrompt, 'photorealistic photography, professional studio headshot quality');

const noirNonHuman = finalCharacterPrompt(noirBible, 'non-human');
assert.equal((noirNonHuman.finalPrompt.match(/Background:/g) || []).length, 1);
assertIncludes(noirNonHuman.finalPrompt, 'Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop');
assertIncludes(noirNonHuman.finalPrompt, 'keep the subject\'s actual non-human anatomy');

const animation = finalCharacterPrompt(animationBible, 'human');
assert.equal(animation.lock.resolvedBackdropColor, '#FFFFFF', 'animation character backdrop should remain pure white');
assertIncludes(animation.finalPrompt, '2D 动画');
assertIncludes(animation.finalPrompt, 'Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop');
assertNotIncludes(animation.finalPrompt, 'STRICTLY NOT allowed: illustration, anime, cartoon, 3D render, painting, sketch, stylized art.');

const watercolor = finalCharacterPrompt(watercolorBible, 'human');
assert.equal(watercolor.lock.resolvedBackdropColor, '#FFFFFF', 'watercolor character backdrop should remain pure white');
assertIncludes(watercolor.finalPrompt, '水彩');
assertNotIncludes(watercolor.finalPrompt, 'photorealistic photography, professional studio headshot quality');

const warm = buildAssetStyleLock({ visualStyle: '婚礼暖调', lighting: '烛光和金色夕阳' }, 'char');
assert.equal(warm.resolvedBackdropColor, '#FFFFFF', 'warm character styles still use pure white backdrop');

const paletteFirst = buildAssetStyleLock({
  visualStyle: 'brand reference',
  colorPalette: [{ name: 'brand pearl', hex: '#F8F9FA' }, { name: 'dark', hex: '#111111' }],
}, 'char');
assert.equal(paletteFirst.resolvedBackdropColor, '#FFFFFF', 'palette no longer changes character backdrop color');

const empty = buildAssetStyleLock({}, 'char');
assert.equal(empty.hasMeaningfulStyle, false, 'empty styleBible should not emit prompt');
assert.equal(empty.prompt, '');
assert.equal(empty.resolvedBackdropColor, '#FFFFFF');
assert.equal(empty.signature.length, 64);

const negativeA = assetStyleSignature({ negativePrompt: 'plastic skin, CG look' }, 'char');
const negativeB = assetStyleSignature({ negativePrompt: 'CG look plastic skin!' }, 'char');
assert.equal(negativeA, negativeB, 'negativePrompt punctuation/order normalization should keep signature stable');

const currentSig = buildAssetStyleLock(noirBible, 'char').signature;
const staleFlags = computeAssetStyleStaleFlags({
  styleBible: noirBible,
  assets: {
    characters: [
      { reference: { currentUrl: '/ok.png', styleBibleSignature: currentSig } },
      { reference: { currentUrl: '/legacy.png' } },
      { reference: { currentUrl: '/old.png', styleBibleSignature: assetStyleSignature(animationBible, 'char') } },
      { reference: {} },
    ],
    scenes: [],
    props: [],
  },
});
assert.equal(staleFlags.asset_img_char_0, undefined, 'matching scalar signature should not be stale');
assert.equal(staleFlags.asset_img_char_1, true, 'legacy image without signature should be style-stale');
assert.equal(staleFlags.asset_img_char_2, true, 'changed style signature should be style-stale');
assert.equal(staleFlags.asset_img_char_3, undefined, 'image-less draft should not be style-stale');

const sceneLock = buildAssetStyleLock(noirBible, 'scene');
assertIncludes(sceneLock.prompt, noirBible.cameraStyle);
assertIncludes(sceneLock.prompt, noirBible.worldRules);

const propLock = buildAssetStyleLock(noirBible, 'prop');
assertIncludes(propLock.prompt, '#101820');
assertNotIncludes(propLock.prompt, noirBible.cameraStyle);

console.log('[test-asset-style-lock] all assertions passed');
