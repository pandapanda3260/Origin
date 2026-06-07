import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const extractSource = readFileSync(new URL('../app/api/assets/extract/route.ts', import.meta.url), 'utf8');
assert.ok(extractSource.includes('pendingWorldFacts'));
assert.ok(extractSource.includes("schema: 'origin-pending-world-facts-v1'"));
assert.ok(extractSource.includes('worldTemplateSnapshot: worldSnapshotMerge.worldTemplateSnapshot'));
assert.ok(extractSource.includes('pendingWorldFacts: responsePendingWorldFacts || null'));
assert.ok(!extractSource.includes('...(worldSnapshotMerge.changed ? { worldTemplateSnapshot: worldSnapshotMerge.worldTemplateSnapshot } : {})'));

const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
assert.ok(assetsSource.includes('export async function confirmPendingWorldFacts'));
assert.ok(assetsSource.includes('project.worldTemplateSnapshot = snapshot'));
assert.ok(assetsSource.includes('project.pendingWorldFacts = null'));
assert.ok(assetsSource.includes('Object.prototype.hasOwnProperty.call(resp, "pendingWorldFacts")'));
assert.ok(assetsSource.includes('export async function openKnowledgeSnapshot'));
assert.ok(assetsSource.includes('_renderKnowledgePendingWorldFacts'));

const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
assert.ok(mainSource.includes('openKnowledgeSnapshot'));
assert.ok(mainSource.includes('confirmPendingWorldFacts'));
assert.ok(mainSource.includes('btnKnowledgeSnapshot'));
assert.ok(mainSource.includes('btnConfirmPendingWorldFacts'));

const htmlSource = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
assert.ok(htmlSource.includes('btnKnowledgeSnapshot'));
assert.ok(htmlSource.includes('btnConfirmPendingWorldFacts'));

console.log('[test-world-pending-contract] all assertions passed');
