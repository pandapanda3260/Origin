import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/projects/[id]/knowledge-snapshot/route.ts', import.meta.url), 'utf8');
assert.ok(routeSource.includes('function publicConsistencyMeta'));
assert.ok(routeSource.includes('consistency: publicConsistencyMeta(project.consistency)'));
assert.ok(routeSource.includes("episode_create: '分集续写'"));

const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
assert.ok(assetsSource.includes('function _renderKnowledgeConsistencyAlerts'));
assert.ok(assetsSource.includes('世界观 / 角色一致性待复核'));
assert.ok(assetsSource.includes('world_template_conflict:'));

const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
assert.ok(/\.\/modules\/assets\.js\?v=\d+/.test(mainSource));
assert.ok(/\.\/modules\/character_custom\.js\?v=\d+/.test(mainSource));

const characterCustomSource = readFileSync(new URL('../public/modules/character_custom.js', import.meta.url), 'utf8');
assert.ok(/\.\/assets\.js\?v=\d+/.test(characterCustomSource));

const workspaceSource = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
assert.ok(/\/modules\/assets\.js\?v=\d+/.test(workspaceSource));
assert.ok(/main\.js\?v=\d+/.test(workspaceSource));

console.log('[test-knowledge-consistency-contract] all assertions passed');
