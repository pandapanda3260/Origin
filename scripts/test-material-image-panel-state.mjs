import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/material_image_panel.js', import.meta.url), 'utf8');

assert.match(
  source,
  /export const MATERIAL_PANEL_CACHE_TTL_MS = 60000;/,
  'material panel cache must use the agreed 60s stale window',
);

assert.match(
  source,
  /export const materialPanelState = \{[\s\S]*?projectUpdatedAt[\s\S]*?panelsByGroupIdx[\s\S]*?activePicker[\s\S]*?activeRolePicker[\s\S]*?uploadingByKey[\s\S]*?refreshAfterInteraction/,
  'material panel state must keep cache and active-interaction guards in one shared module',
);

assert.match(
  source,
  /export function setMaterialPanelProject\(projectId, projectUpdatedAt\)[\s\S]*?materialPanelState\.projectUpdatedAt[\s\S]*?resetMaterialPanelMaps\(\)/,
  'project updatedAt changes must invalidate cached material panels for the same project id',
);

assert.match(
  source,
  /export function isMaterialPanelInActiveInteraction\(groupIdx\)[\s\S]*?activePicker[\s\S]*?activeRolePicker[\s\S]*?uploadingByKey/,
  'TTL refresh must be able to detect active picker, role picker, and upload interactions',
);

assert.match(
  source,
  /export function shouldRefreshMaterialPanel\(groupIdx, now\)[\s\S]*?isMaterialPanelInActiveInteraction\(key\)[\s\S]*?refreshAfterInteraction\[key\] = true[\s\S]*?MATERIAL_PANEL_CACHE_TTL_MS/,
  'stale refresh must skip active interactions and mark them for post-interaction refresh',
);

assert.match(
  source,
  /export async function fetchMaterialPanels\(projectId, options\)[\s\S]*?pendingByKey[\s\S]*?\/api\/frames\/material-panels\?projectId=[\s\S]*?setMaterialPanelFromEntry/,
  'shared state must fetch lightweight material panels with request de-dupe and cache writes',
);

assert.match(
  source,
  /export function invalidateAllMaterialPanels\(\)[\s\S]*?resetMaterialPanelMaps\(\)/,
  'asset mutations must have a single cache invalidation entrypoint',
);

console.log('test-material-image-panel-state passed');
