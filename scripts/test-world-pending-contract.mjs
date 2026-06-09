import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const extractSource = readFileSync(new URL('../app/api/assets/extract/route.ts', import.meta.url), 'utf8');
assert.ok(extractSource.includes('injectWorldTemplateIntoAssets'));
assert.ok(extractSource.includes('const injectedCharacterIndexes = new Set<number>()'));
assert.ok(extractSource.includes('if (!injectedCharacterIndexes.has(index)) return character;'));
assert.ok(extractSource.includes('if (!injectedSceneIndexes.has(index)) return scene;'));
assert.ok(extractSource.includes('if (!injectedPropIndexes.has(index)) return prop;'));
assert.ok(extractSource.includes('pendingWorldFacts: null'));
assert.ok(!extractSource.includes('mergeProjectFactsIntoWorldSnapshot'));
assert.ok(!extractSource.includes("schema: 'origin-pending-world-facts-v1'"));
assert.ok(!extractSource.includes('responsePendingWorldFacts'));
assert.ok(!extractSource.includes('worldSnapshotMerge'));

const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
assert.ok(assetsSource.includes('export async function openKnowledgeSnapshot'));
assert.ok(assetsSource.includes('function _flushAssetsProjectNow()'));
assert.ok(assetsSource.includes('if (_ctx.persistWorldTemplateSelection)'));
assert.ok(assetsSource.includes('_ctx.persistWorldTemplateSelection(intent);'));
assert.ok(!assetsSource.includes('export async function confirmPendingWorldFacts'));
assert.ok(!assetsSource.includes('_renderKnowledgePendingWorldFacts'));
assert.ok(!assetsSource.includes('function _pendingWorldFactsSummary'));
assert.ok(!assetsSource.includes('Object.prototype.hasOwnProperty.call(resp, "pendingWorldFacts")'));
assert.ok(!assetsSource.includes('project.worldTemplateSnapshot = snapshot'));

const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
assert.ok(mainSource.includes('openKnowledgeSnapshot'));
assert.ok(mainSource.includes('btnKnowledgeSnapshot'));
assert.ok(mainSource.includes('function _persistStyleWorldIntent(intent)'));
assert.ok(mainSource.includes('return _flushStyleWorldIntent(job, 0);'));
assert.ok(mainSource.includes('if (result && result.stale && attempt < 1)'));
assert.ok(mainSource.includes('_persistStyleWorldIntent({ selectedWorldTemplateId: null, worldTemplateSnapshot: null });'));
assert.ok(mainSource.includes('persistWorldTemplateSelection: (intent) => _persistStyleWorldIntent(intent)'));
assert.ok(!mainSource.includes('confirmPendingWorldFacts'));
assert.ok(!mainSource.includes('btnConfirmPendingWorldFacts'));

const htmlSource = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
assert.ok(htmlSource.includes('btnKnowledgeSnapshot'));
assert.ok(!htmlSource.includes('btnConfirmPendingWorldFacts'));

const knowledgeRouteSource = readFileSync(new URL('../app/api/projects/[id]/knowledge-snapshot/route.ts', import.meta.url), 'utf8');
assert.ok(!knowledgeRouteSource.includes('pendingFacts'));
assert.ok(!knowledgeRouteSource.includes('project.pendingWorldFacts'));

console.log('[test-world-pending-contract] all assertions passed');
