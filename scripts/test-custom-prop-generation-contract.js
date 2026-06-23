/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `qd-test-custom-prop-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = dbPath;

require('./_ts-require-hook.js');

const { getDb } = require('../lib/db.ts');
const {
  confirmCustomPropDraft,
  createCustomPropVersion,
  finalizeCustomPropVersion,
  getCustomPropForUser,
  listCustomProps,
  listCustomPropVersions,
  promoteCustomPropVersion,
  serializeCustomPropVersion,
} = require('../lib/custom-prop-db.ts');

function createOwner() {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, email_verified)
    VALUES (@username, @displayName, @passwordHash, 1)
  `).run({
    username: `custom-prop-test-${process.pid}-${Date.now()}`,
    displayName: 'Custom Prop Test',
    passwordHash: 'test-hash',
  });
  return Number(result.lastInsertRowid);
}

function makePropData(name, url) {
  return {
    name,
    propType: '测试道具',
    dimensionality: 'volumetric',
    imageUrl: url,
    rawUrl: url,
    reference: {
      status: 'ready',
      currentUrl: url,
      lastKnownGoodUrl: url,
    },
  };
}

function testDbLifecycleAndConfirmGate() {
  const ownerId = createOwner();
  const projectId = 'custom-prop-contract-project';
  const firstPropData = makePropData('初始道具', 'https://example.test/prop-1.png');

  const firstVersion = createCustomPropVersion({
    ownerId,
    projectId,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'first prompt',
    params: { material: 'metal' },
    propData: firstPropData,
    generationStatus: 'completed',
  });

  let prop = getCustomPropForUser(firstVersion.prop_id, ownerId);
  assert.equal(prop.lifecycle_status, 'draft', 'prop lifecycle must live on parent table');
  assert.equal(prop.current_version_id, firstVersion.id, 'first generated version is current');
  assert.equal(listCustomProps({ ownerId, lifecycleStatus: 'draft' }).length, 1, 'draft list includes draft prop');
  assert.equal(listCustomProps({ ownerId, lifecycleStatus: 'confirmed' }).length, 0, 'confirmed list excludes draft prop');
  assert.equal(serializeCustomPropVersion(firstVersion).displayImageUrl, firstPropData.imageUrl, 'serializer exposes backend displayImageUrl');

  const failedPlaceholder = createCustomPropVersion({
    ownerId,
    projectId,
    propId: prop.id,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'failed regen',
    propData: { name: '失败占位' },
    generationStatus: 'running',
    makeCurrent: false,
  });
  prop = getCustomPropForUser(prop.id, ownerId);
  assert.equal(prop.current_version_id, firstVersion.id, 'makeCurrent:false keeps previous current while regenerating');
  finalizeCustomPropVersion({
    ownerId,
    versionId: failedPlaceholder.id,
    generationStatus: 'failed',
    propData: { name: '失败占位' },
    errorMessage: 'expected failure',
  });
  prop = getCustomPropForUser(prop.id, ownerId);
  assert.equal(prop.current_version_id, firstVersion.id, 'failed regenerate must not replace current version');

  const noImageVersion = createCustomPropVersion({
    ownerId,
    projectId,
    propId: prop.id,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'sheet split failed',
    propData: {
      name: '切片失败道具',
      dimensionality: 'volumetric',
      viewsError: 'not enough usable prop views (0/6)',
    },
    generationStatus: 'completed',
    makeCurrent: false,
  });
  assert.throws(
    () => confirmCustomPropDraft(ownerId, prop.id, noImageVersion.id),
    /没有可用道具图/,
    'confirm gate must reject completed versions without resolvePropImageUrl output',
  );

  const successfulPlaceholder = createCustomPropVersion({
    ownerId,
    projectId,
    propId: prop.id,
    lifecycleStatus: 'draft',
    sourceType: 'prompt',
    prompt: 'successful regen',
    propData: { name: '成功占位' },
    generationStatus: 'running',
    makeCurrent: false,
  });
  const secondPropData = makePropData('重生道具', 'https://example.test/prop-2.png');
  finalizeCustomPropVersion({
    ownerId,
    versionId: successfulPlaceholder.id,
    generationStatus: 'completed',
    propData: secondPropData,
  });
  promoteCustomPropVersion(ownerId, prop.id, successfulPlaceholder.id);
  prop = getCustomPropForUser(prop.id, ownerId);
  assert.equal(prop.current_version_id, successfulPlaceholder.id, 'successful regenerate promotes only after completion');

  const confirmed = confirmCustomPropDraft(ownerId, prop.id, successfulPlaceholder.id, '确认道具');
  assert.equal(confirmed.lifecycle_status, 'confirmed', 'confirm flips parent lifecycle');
  const confirmedVersions = listCustomPropVersions(prop.id, ownerId);
  assert.equal(confirmedVersions.length, 1, 'confirm converges draft history to one version');
  assert.equal(confirmedVersions[0].versionNo, 1, 'confirm resets surviving version number');
  assert.equal(confirmedVersions[0].prompt, '', 'confirm clears draft prompt');
  assert.deepEqual(confirmedVersions[0].params, {}, 'confirm clears draft params');
  assert.deepEqual(confirmedVersions[0].inputRefs, [], 'confirm clears draft input refs');
  assert.equal(listCustomProps({ ownerId, lifecycleStatus: 'confirmed' }).length, 1, 'confirmed list includes displayable confirmed prop');
  assert.equal(listCustomProps({ ownerId, lifecycleStatus: 'draft' }).length, 0, 'draft list excludes confirmed prop');
}

function assertSourceContains(relPath, pattern, message) {
  const source = fs.readFileSync(path.join(root, relPath), 'utf8');
  if (pattern instanceof RegExp) assert.match(source, pattern, message);
  else assert.equal(source.includes(pattern), true, message);
  return source;
}

function tableBlocks(source, tableName) {
  return Array.from(source.matchAll(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([\\s\\S]*?\\n\\s*\\);`, 'g')))
    .map((match) => match[0]);
}

function testStaticContracts() {
  const dbSource = assertSourceContains('lib/db.ts', 'custom_props', 'db schema includes custom_props');
  assert.match(dbSource, /custom_props[\s\S]*lifecycle_status\s+TEXT NOT NULL DEFAULT 'confirmed'/, 'parent prop table owns lifecycle_status');
  assert.match(dbSource, /custom_prop_versions[\s\S]*generation_status\s+TEXT NOT NULL DEFAULT 'completed'/, 'version prop table owns generation_status');
  assert.match(dbSource, /custom_prop_versions[\s\S]*prop_data_json\s+TEXT NOT NULL DEFAULT '\{\}'/, 'version prop table stores prop_data_json');
  const propVersionBlocks = tableBlocks(dbSource, 'custom_prop_versions');
  assert.equal(propVersionBlocks.length >= 1, true, 'db schema declares custom_prop_versions');
  propVersionBlocks.forEach((block) => {
    assert.doesNotMatch(block, /lifecycle_status/, 'version prop table must not own lifecycle_status');
  });
  assert.match(dbSource, /migrateCustomPropTables\(db\)/, 'db startup must register custom prop migration');

  const propDbSource = assertSourceContains('lib/custom-prop-db.ts', 'resolvePropImageUrl', 'prop db uses prop canonical URL helper');
  assert.match(propDbSource, /if \(version\.generation_status !== 'completed'\)/, 'confirm checks completed status');
  assert.match(propDbSource, /displayPropImageUrl\(propData\)/, 'confirm checks displayable prop image');
  assert.match(propDbSource, /DELETE FROM custom_prop_versions[\s\S]*id <> @versionId/, 'confirm deletes unselected draft versions');
  assert.match(propDbSource, /displayImageUrl: displayPropImageUrl/, 'serializer exposes displayImageUrl from backend');

  const promptSource = assertSourceContains('lib/custom-prop-prompt.ts', 'normalizeCustomPropParams', 'custom prop prompt module exists');
  assert.match(promptSource, /dimensionality[\s\S]*flat[\s\S]*volumetric/, 'prop prompt normalizes flat and volumetric modes');
  assert.match(promptSource, /PROP SHEET FORMAT/, 'volumetric prop prompt uses sheet instructions');

  const generationSource = assertSourceContains('lib/custom-prop-generation.ts', "storageStyle: args.isVolumetric ? 'prop-view-sheet' : undefined", 'volumetric prop generation uses prop-view-sheet storage');
  assert.match(generationSource, /splitPropViews\(/, 'custom prop generation calls splitPropViews');
  assert.match(generationSource, /applyPropViewWrite\(/, 'custom prop generation applies prop view writes on successful split');
  assert.match(generationSource, /delete next\.reference\.currentUrl[\s\S]*delete next\.reference\.lastKnownGoodUrl/, 'split failure clears displayable reference URLs');

  const expectedRoutes = [
    'app/api/prop-custom/history/route.ts',
    'app/api/prop-custom/generate/route.ts',
    'app/api/prop-custom/items/[id]/route.ts',
    'app/api/prop-custom/items/[id]/regenerate/route.ts',
    'app/api/prop-custom/items/[id]/image/route.ts',
    'app/api/prop-custom/drafts/[id]/route.ts',
    'app/api/prop-custom/drafts/[id]/confirm/route.ts',
  ];
  expectedRoutes.forEach((relPath) => {
    assert.equal(fs.existsSync(path.join(root, relPath)), true, `${relPath} must exist`);
  });
  assert.equal(fs.existsSync(path.join(root, 'app/api/prop-custom/items/[id]/views/[role]/regenerate/route.ts')), false, 'prop custom must not expose per-view regenerate route');

  ['history', 'items/[id]', 'items/[id]/regenerate', 'items/[id]/image', 'drafts/[id]/confirm'].forEach((route) => {
    assertSourceContains(`app/api/prop-custom/${route}/route.ts`, 'signCustomCharacterImageUrls', `${route} must sign image URLs in route layer`);
  });
  const generateRoute = assertSourceContains('app/api/prop-custom/generate/route.ts', 'generateCustomPropImage', 'generate route uses prop generation orchestration');
  assert.doesNotMatch(generateRoute, /signCustomCharacterImageUrls/, 'generate route follows scene behavior and relies on frontend hydrate');

  const imageRoute = assertSourceContains('app/api/prop-custom/items/[id]/image/route.ts', 'prop_data_json', 'upload route reads prop_data_json');
  assert.match(imageRoute, /VALUES \(\?, \?, \?, 'prop'/, 'upload route stores images.kind=prop');
  assert.match(imageRoute, /stage: 'custom_prop'/, 'upload route stores custom_prop asset stage');
  assert.match(imageRoute, /currentUrl: url[\s\S]*lastKnownGoodUrl: url/, 'upload route rewrites reference URLs to the uploaded image');
  assert.doesNotMatch(imageRoute, /realPhotoUrl|pencilUrl|fields_json|custom_character/, 'upload route must not copy character-only fields or storage names');
}

testDbLifecycleAndConfirmGate();
testStaticContracts();

console.log('[test-custom-prop-generation-contract] all assertions passed');
