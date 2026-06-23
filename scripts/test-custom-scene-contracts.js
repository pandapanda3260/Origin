/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `qd-test-custom-scene-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = dbPath;

require('./_ts-require-hook.js');

const { getDb } = require('../lib/db.ts');
const {
  confirmCustomSceneDraft,
  createCustomSceneVersion,
  finalizeCustomSceneVersion,
  getCustomSceneForUser,
  listCustomScenes,
  listCustomSceneVersions,
  promoteCustomSceneVersion,
  updateCurrentCustomSceneVersionData,
} = require('../lib/custom-scene-db.ts');
const { applySceneViewWrite } = require('../lib/scene-views.ts');

function createOwner() {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, email_verified)
    VALUES (@username, @displayName, @passwordHash, 1)
  `).run({
    username: `custom-scene-test-${process.pid}-${Date.now()}`,
    displayName: 'Custom Scene Test',
    passwordHash: 'test-hash',
  });
  return Number(result.lastInsertRowid);
}

function makeEstablishingScene(name, url) {
  return applySceneViewWrite({ name, location: `${name} location` }, {
    role: 'establishing',
    imageUrl: url,
    rawUrl: url,
    imagePrompt: `${name} prompt`,
    submittedImagePrompt: `${name} submitted prompt`,
  });
}

function testDbLifecycleAndVersionContracts() {
  const ownerId = createOwner();
  const projectId = 'custom-scene-contract-project';
  const firstSceneData = makeEstablishingScene('初始场景', 'https://example.test/scene-1.png');

  const firstVersion = createCustomSceneVersion({
    ownerId,
    projectId,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'first prompt',
    params: { weather: 'rain' },
    sceneData: firstSceneData,
    generationStatus: 'completed',
  });

  let scene = getCustomSceneForUser(firstVersion.scene_id, ownerId);
  assert.equal(scene.lifecycle_status, 'draft', 'scene lifecycle must live on parent table');
  assert.equal(scene.current_version_id, firstVersion.id, 'first generated version is current');
  assert.equal(listCustomScenes({ ownerId, lifecycleStatus: 'draft' }).length, 1, 'draft list includes draft scene');
  assert.equal(listCustomScenes({ ownerId, lifecycleStatus: 'confirmed' }).length, 0, 'confirmed list excludes draft scene');

  const failedPlaceholder = createCustomSceneVersion({
    ownerId,
    projectId,
    sceneId: scene.id,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'failed regen',
    sceneData: { name: '失败占位' },
    generationStatus: 'running',
    makeCurrent: false,
  });
  scene = getCustomSceneForUser(scene.id, ownerId);
  assert.equal(scene.current_version_id, firstVersion.id, 'makeCurrent:false keeps previous current while regenerating');
  finalizeCustomSceneVersion({
    ownerId,
    versionId: failedPlaceholder.id,
    generationStatus: 'failed',
    sceneData: { name: '失败占位' },
    errorMessage: 'expected failure',
  });
  scene = getCustomSceneForUser(scene.id, ownerId);
  assert.equal(scene.current_version_id, firstVersion.id, 'failed regenerate must not replace current version');

  const successfulPlaceholder = createCustomSceneVersion({
    ownerId,
    projectId,
    sceneId: scene.id,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'successful regen',
    sceneData: { name: '成功占位' },
    generationStatus: 'running',
    makeCurrent: false,
  });
  const secondSceneData = makeEstablishingScene('重生场景', 'https://example.test/scene-2.png');
  finalizeCustomSceneVersion({
    ownerId,
    versionId: successfulPlaceholder.id,
    generationStatus: 'completed',
    sceneData: secondSceneData,
  });
  promoteCustomSceneVersion(ownerId, scene.id, successfulPlaceholder.id);
  scene = getCustomSceneForUser(scene.id, ownerId);
  assert.equal(scene.current_version_id, successfulPlaceholder.id, 'successful regenerate promotes only after completion');

  const beforeViewVersions = listCustomSceneVersions(scene.id, ownerId);
  const topdownSceneData = applySceneViewWrite(secondSceneData, {
    role: 'topdown',
    imageUrl: 'https://example.test/scene-topdown.png',
    rawUrl: 'https://example.test/scene-topdown.png',
    imagePrompt: 'topdown prompt',
  });
  const updatedCurrent = updateCurrentCustomSceneVersionData({
    ownerId,
    sceneId: scene.id,
    sceneData: topdownSceneData,
  });
  const afterViewVersions = listCustomSceneVersions(scene.id, ownerId);
  assert.equal(afterViewVersions.length, beforeViewVersions.length, 'per-view regenerate updates current version in place');
  assert.equal(updatedCurrent.id, successfulPlaceholder.id, 'per-view regenerate must keep current version id');
  const updatedCurrentSceneData = JSON.parse(updatedCurrent.scene_data_json || '{}');
  assert.equal(updatedCurrentSceneData.views.some((view) => view.role === 'topdown'), true, 'per-view update accumulates topdown on current scene_data');

  const confirmed = confirmCustomSceneDraft(ownerId, scene.id, successfulPlaceholder.id, '确认场景');
  assert.equal(confirmed.lifecycle_status, 'confirmed', 'confirm flips parent lifecycle');
  const confirmedVersions = listCustomSceneVersions(scene.id, ownerId);
  assert.equal(confirmedVersions.length, 1, 'confirm converges draft history to one version');
  assert.equal(confirmedVersions[0].versionNo, 1, 'confirm resets surviving version number');
  assert.equal(confirmedVersions[0].prompt, '', 'confirm clears draft prompt');
  assert.deepEqual(confirmedVersions[0].params, {}, 'confirm clears draft params');
  assert.deepEqual(confirmedVersions[0].inputRefs, [], 'confirm clears draft input refs');
  assert.equal(listCustomScenes({ ownerId, lifecycleStatus: 'confirmed' }).length, 1, 'confirmed list includes confirmed scene');
  assert.equal(listCustomScenes({ ownerId, lifecycleStatus: 'draft' }).length, 0, 'draft list excludes confirmed scene');
}

function assertSourceContains(relPath, pattern, message) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8');
  if (pattern instanceof RegExp) assert.match(source, pattern, message);
  else assert.equal(source.includes(pattern), true, message);
  return source;
}

function testStaticContracts() {
  const dbSource = assertSourceContains('lib/db.ts', 'custom_scenes', 'db schema includes custom_scenes');
  assert.match(dbSource, /custom_scenes[\s\S]*lifecycle_status\s+TEXT NOT NULL DEFAULT 'confirmed'/, 'parent scene table owns lifecycle_status');
  assert.match(dbSource, /custom_scene_versions[\s\S]*generation_status\s+TEXT NOT NULL DEFAULT 'completed'/, 'version scene table owns generation_status');
  assert.doesNotMatch(dbSource, /custom_scene_versions[\s\S]{0,700}lifecycle_status/, 'version scene table must not own lifecycle_status');

  const promptSource = assertSourceContains('lib/custom-scene-prompt.ts', "return 'image';", 'source_type supports pure image input');
  assert.match(promptSource, /sourceType === 'image_prompt'[\s\S]*用户未填写补充提示词/, 'image_prompt and image-only inputs use distinct vision extraction instructions');

  const generationSource = assertSourceContains('lib/custom-scene-generation.ts', 'referenceImagePaths,', 'followup generation passes plural referenceImagePaths');
  assert.match(generationSource, /viewRole: 'establishing'[\s\S]*urls\.push\(establishingUrl\)/, 'followup views reference establishing view first');
  assert.match(generationSource, /const topdownUrl = resolveSceneImageUrl[\s\S]*urls\.push\(topdownUrl\)/, 'reverse and alt include topdown when available');
  assert.match(generationSource, /firstCheck\.decision === 'retry'/, 'quality retry is gated by retry decision');

  assertSourceContains('app/api/scene-custom/generate/route.ts', 'assertReferenceImageGenerationSupported(user)', 'image-only generation checks vision support');
  assertSourceContains('app/api/scene-custom/items/[id]/regenerate/route.ts', 'makeCurrent: false', 'establishing regenerate creates non-current placeholder');
  assertSourceContains('app/api/scene-custom/items/[id]/regenerate/route.ts', 'promoteCustomSceneVersion', 'establishing regenerate promotes after success');
  assertSourceContains('app/api/scene-custom/items/[id]/views/[role]/regenerate/route.ts', 'updateCurrentCustomSceneVersionData', 'per-view regenerate updates current version in place');

  const sceneModule = assertSourceContains('public/modules/scene_custom.js', "['topdown', 'reverse', 'alt']", 'frontend fills secondary views in fixed order');
  assert.match(sceneModule, /\/api\/scene-custom\/items\/[^`]*\/views\/[^`]*\/regenerate/, 'frontend calls per-view regenerate route');

  const assetsSource = assertSourceContains('public/modules/assets.js', 'data-scene-menu="replace-custom-scene"', 'asset scene menu exposes custom scene replacement');
  assert.match(assetsSource, /project\.environments\[idx\] = _deepClonePlain\(next\)/, 'asset scene replacement updates environments mirror');
  assert.match(assetsSource, /customSceneId: item\.id \|\| ""/, 'asset scene replacement stamps customSceneId');
  assert.match(assetsSource, /_clearAllSceneViewStaleFlags\(idx\)/, 'asset scene replacement clears scene view stale flags');
}

testDbLifecycleAndVersionContracts();
testStaticContracts();

console.log('custom scene contracts passed');
