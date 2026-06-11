import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/storyboard.js', import.meta.url), 'utf8');
const materialPanelSource = readFileSync(new URL('../public/modules/material_image_panel.js', import.meta.url), 'utf8');
const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

assert.match(
  source,
  /fetchMaterialPanels[\s\S]*?getMaterialPanel[\s\S]*?renderMaterialImagePanelHtml[\s\S]*?setMaterialPanelProject/,
  'storyboard must import shared material panel renderer and state helpers',
);

assert.match(
  source,
  /function _storyboardAssetsHtml\(group\)[\s\S]*?is-role-picker-open[\s\S]*?shot-material-panel-slot[\s\S]*?_shotMaterialPanelInnerHtml\(gIdx\)/,
  'shot-page material area must render through the shared material panel slot',
);

assert.doesNotMatch(
  source,
  /function _storyboardAssetsHtml\(group\)[\s\S]*?_storyboardAssetRowHtml\('scene'[\s\S]*?_storyboardAssetRowHtml\('char'[\s\S]*?_storyboardAssetRowHtml\('prop'/,
  'shot-page material area must not keep the old three-row candidate-pool UI',
);

assert.doesNotMatch(
  source,
  /_storyboardAssetThumbHtml|_storyboardAssetRowHtml|_storyboardAssetAddBoxHtml|asset-add-image|asset-delete-image|download-shot-materials|asset-lightbox/,
  'storyboard module must not retain the old shot material UI actions or helpers',
);

assert.doesNotMatch(
  styles,
  /\.sb-material-row|\.sb-material-thumb-grid/,
  'stylesheet must not retain old three-row shot material grid rules',
);

assert.match(
  source,
  /function _ensureShotMaterialPanels\(groups\)[\s\S]*?shouldRefreshMaterialPanel\(group\.groupIdx\)[\s\S]*?fetchMaterialPanels\(project\.id\)[\s\S]*?_refreshMaterialPanelSlots/,
  'shot-page material panels must fetch the lightweight batch panel endpoint with cache/TTL guards',
);

assert.match(
  source,
  /async function _ensureMaterialPanelsForChecks\(groups, groupIdxs\)[\s\S]*?!getMaterialPanel\(gIdx\) \|\| shouldRefreshMaterialPanel\(gIdx\)[\s\S]*?fetchMaterialPanels\(project\.id/,
  'generation entrypoints must be able to prefetch material panels before checking invalid state',
);

assert.match(
  source,
  /export async function generateStoryboardSheet\(gIdx, opts\)[\s\S]*?await _ensureMaterialPanelsForChecks\(groups, \[gIdx\]\)[\s\S]*?_materialLimitBlockMessage\(groups, \[gIdx\]\)/,
  'single first-frame generation must prefetch the target material panel before checking material blockers',
);

assert.match(
  source,
  /export async function generateAllImages\(\)[\s\S]*?await _ensureMaterialPanelsForChecks\(groups\)[\s\S]*?_materialLimitBlockMessage\(groups\)[\s\S]*?_syncRefs\(\)[\s\S]*?await _ensureMaterialPanelsForChecks\(groups\)[\s\S]*?_materialLimitBlockMessage\(groups\)/,
  'batch first-frame generation must prefetch material panels before both blocker checks',
);

assert.match(
  source,
  /function _syncFirstFrameEditorMaterialPanelFromCache\(groupIdx\)[\s\S]*?_firstFrameEditor\.payload\.firstFrameMaterialPanel = panel[\s\S]*?_firstFrameEditor\.payload\.plan\.firstFrameMaterialPanel = panel/,
  'material panel refresh must keep an open first-frame editor payload in sync',
);

assert.match(
  source,
  /export function refreshStoryboardMaterialPanels\(opts\)[\s\S]*?fetchMaterialPanels\(project\.id\)[\s\S]*?_refreshMaterialPanelSlots/,
  'asset mutations must be able to force-refresh visible storyboard material panel slots',
);

assert.match(
  assetsSource,
  /import \{ invalidateAllMaterialPanels \} from '\/modules\/material_image_panel\.js';[\s\S]*?function _invalidateMaterialPanelsAfterAssetChange\(\)[\s\S]*?invalidateAllMaterialPanels\(\)[\s\S]*?refreshStoryboardMaterialPanels/,
  'asset module mutations must invalidate shared material panel cache and request visible slot refresh',
);

assert.match(
  assetsSource,
  /function _saveAssetsProject\(\)[\s\S]*?_invalidateMaterialPanelsAfterAssetChange\(\)[\s\S]*?_ctx\.saveProject/,
  'asset saves must route through the material-panel invalidating save wrapper',
);

assert.match(
  mainSource,
  /refreshStoryboardMaterialPanels[\s\S]*?initAssets\([\s\S]*?refreshStoryboardMaterialPanels: \(opts\) => refreshStoryboardMaterialPanels\(opts\)/,
  'main must pass storyboard material refresh callback into assets module',
);

assert.match(
  source,
  /var assetPanel = card\.querySelector\("\.shot-material-panel-slot"\)/,
  'shot layout extraction must move the whole shared material slot, not only the inner panel',
);

assert.match(
  source,
  /async function _handleMaterialPanelAction\(ev\)[\s\S]*?closest\('\[data-material-action\]'\)[\s\S]*?stopImmediatePropagation\(\)[\s\S]*?ctx\.scope !== 'shot'/,
  'shared material actions must be handled by a dedicated data-material-action handler scoped to shot panels',
);

assert.match(
  source,
  /function _ensureShotMaterialPickerRoot\(\)[\s\S]*?root\.id = 'shotMaterialPickerRoot'[\s\S]*?document\.body\.appendChild\(root\)/,
  'shot material picker root must be mounted at document.body level',
);

assert.match(
  source,
  /function _renderShotMaterialPickerOverlay\(\)[\s\S]*?root\.innerHTML = renderMaterialPickerHtml\([\s\S]*?scope: 'shot'[\s\S]*?actionAttr: 'data-material-action'/,
  'shot material picker modal must render into the body-level portal with shot-scoped material actions',
);

assert.match(
  source,
  /function _applyMaterialMutationPanel\(groupIdx, panel, sourceHash\)[\s\S]*?_rerenderMaterialPanelSlot\(groupIdx\)[\s\S]*?_renderShotMaterialPickerOverlay\(\)/,
  'editor-side material mutations must also rerender the shot-page slot from the shared cache',
);

assert.match(
  styles,
  /\.shot-material-panel-slot\.is-role-picker-open[\s\S]*?z-index:\s*10030[\s\S]*?overflow:\s*visible !important/,
  'shot role picker must lift its card above adjacent shot cards and allow overflow',
);

assert.match(
  source,
  /document\.addEventListener\('click', _handleMaterialPanelAction\);\s*document\.addEventListener\('click', _handleFirstFrameEditorClick\);/,
  'material action handler must register before the first-frame editor handler',
);

assert.match(
  source,
  /source: 'shot'[\s\S]*?_persistMaterialReferenceSelection/,
  'shot-page material add/remove actions must use the shared selection mutation with shot scope',
);

assert.match(
  source,
  /function _materialLimitBlockMessage\(groups, groupIdxs\)[\s\S]*?getMaterialPanel\(gIdx\)[\s\S]*?panel && panel\.invalid && panel\.invalid\.message/,
  'shot generation material blocking must use the backend material panel invalid message',
);

assert.doesNotMatch(
  source,
  /function _materialLimitBlockMessage\(groups, groupIdxs\)[\s\S]{0,300}_firstMaterialLimitIssue/,
  'shot generation material blocking must not use the old frontend candidate-pool limit issue',
);

assert.match(
  materialPanelSource,
  /function rolePickerHtml\(opts\)[\s\S]*?panelScopeAttrs\(opts\)[\s\S]*?export function renderMaterialPickerHtml\(opts\)[\s\S]*?ffe-material-picker-backdrop[\s\S]*?panelScopeAttrs\(opts\)/,
  'shared role picker and material picker must carry surface/group scope for data-material-action handling',
);

console.log('test-storyboard-material-panel-contract passed');
