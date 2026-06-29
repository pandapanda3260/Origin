import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function dataModuleUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const displaySrc = readFileSync(new URL('../public/modules/asset_display_state.js', import.meta.url), 'utf8');
const assetsSrc = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
const boardStateSrc = readFileSync(new URL('../public/modules/board_state.js', import.meta.url), 'utf8');
const workspaceSrc = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
const display = await import(dataModuleUrl(displaySrc));

assert.match(assetsSrc, /from '\/modules\/asset_display_state\.js'/, 'assets.js must consume the shared asset display module');
assert.match(assetsSrc, /return _deriveAssetCardStateBase\(item, idx, \{ project: project, imageVariantUrl: imageVariantUrl \}\)/, 'assets deriveAssetCardState delegates to the shared module with current project context');
assert.match(boardStateSrc, /from '\/modules\/asset_display_state\.js'/, 'board_state.js must consume the shared asset display module');
assert.doesNotMatch(boardStateSrc, /function normalizeCharacterEntityType|function canUseCharacterFallback|function panelSchemaEntityType/, 'board_state.js must not keep its own character image resolver rules');
assert.doesNotMatch(boardStateSrc, /export function resolveCharacterImageUrl|export function resolveSceneImageUrl|export function resolvePropImageUrl/, 'board_state.js must re-export shared image resolvers instead of redefining them');
assert.match(workspaceSrc, /"\/modules\/asset_display_state\.js": "\/modules\/asset_display_state\.js\?v=1"/, 'workspace import map must cache-bust the shared asset display module');

{
  const project = {
    characters: [{ name: 'Ava', entityType: 'human', panels: { sheetUrl: '/top-sheet.png' } }],
    consistency: { characters: [] },
  };
  assert.equal(
    display.resolveCharacterImageUrl(project, { name: 'Ava', entityType: 'human' }, 0),
    '/top-sheet.png',
    'shared resolver keeps top-level compatible character fallback',
  );
}

{
  const project = {
    characters: [{ name: 'Crab', imageUrl: '/legacy-human.png', panels: { schema: 'human-character-sheet-v1' } }],
    consistency: { characters: [] },
  };
  assert.equal(
    display.resolveCharacterImageUrl(project, { name: 'Crab', entityType: 'non-human' }, 0),
    '',
    'shared resolver keeps non-human identity gate for legacy human fallbacks',
  );
}

{
  const state = display.deriveAssetCardState({
    imageUrl: '/main.png',
    reference: {
      status: 'failed',
      lastAttemptUrl: '/failed.png',
      lastError: { reason: 'character_panel_split_failed' },
    },
  }, 0, {
    imageVariantUrl(url, opts) {
      return `${url}?w=${opts.w}`;
    },
  });
  assert.equal(state.status, 'failed');
  assert.equal(state.mainImageUrl, '/main.png?w=1024');
  assert.equal(state.previewImageUrl, '/failed.png?w=1024');
  assert.equal(state.previewOriginalUrl, '/failed.png?w=0');
}

{
  const scene = {
    reference: { currentUrl: '/top-scene.png' },
    views: [{ role: 'establishing', reference: { currentUrl: '/view-scene.png' } }],
  };
  assert.equal(display.resolveSceneImageUrl(scene), '/view-scene.png', 'shared scene resolver prefers establishing view reference');
}

{
  const prop = {
    reference: { currentUrl: '/top-prop.png' },
    views: { slots: { front: { reference: { currentUrl: '/front-prop.png' } } } },
  };
  assert.equal(display.resolvePropImageUrl(prop), '/front-prop.png', 'shared prop resolver prefers canonical front view');
}

console.log('✓ asset display state contract passed');
