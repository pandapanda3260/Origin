#!/usr/bin/env node
require('./_ts-require-hook.js');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { detectObsoleteAssets } = require('../lib/obsolete-assets');

const REPO_ROOT = path.resolve(__dirname, '..');

function baseProject() {
  return {
    id: 'proj_obsolete',
    assets: {
      characters: [
        { id: 'c1', name: '萧云' },
        { id: 'c2', name: '接引长老' },
      ],
      scenes: [
        { id: 'e1', name: '圣地山门' },
        { id: 'e2', name: '废弃偏殿' },
      ],
      props: [
        { id: 'p1', name: '青铜令牌', ownership: 'c1' },
        { id: 'p2', name: '失主玉佩', ownership: 'missing-char' },
        { id: 'p3', name: '长老手杖', ownership: null, carriesCharacter: ['接引长老'] },
      ],
    },
    shots: [
      {
        sceneId: 'e1',
        sceneName: '圣地山门',
        visual: '萧云握着青铜令牌站在石阶前。',
        dialogue: '——',
        keyInfo: '山门初见',
        scriptRef: '萧云来到圣地山门',
        description: '',
        characters: ['萧云'],
      },
    ],
  };
}

function byId(items, id) {
  return items.find((item) => item.id === id);
}

function testSceneReferenceUsesAssetIdAndNameOnly() {
  const project = baseProject();
  project.assets.scenes.push({ id: 'e3', name: '试炼广场' });
  project.shots.push({ sceneId: 'e3', sceneName: '', visual: '众人列队。' });
  project.assets.scenes.push({ id: 'e4', name: '藏经阁' });
  project.shots.push({ sceneId: '', sceneName: '藏经阁', visual: '书页翻动。' });

  const obsolete = detectObsoleteAssets(project);
  assert.equal(byId(obsolete, 'e1'), undefined, 'sceneId === scene.id should keep scene');
  assert.equal(byId(obsolete, 'e3'), undefined, 'non-empty shot.sceneId should match scene.id');
  assert.equal(byId(obsolete, 'e4'), undefined, 'non-empty shot.sceneName should match scene.name');
  assert.equal(byId(obsolete, 'e2')?.reasonCodes.includes('no_shot_reference'), true, 'unreferenced scene is obsolete');
}

function testSceneDoesNotUseSceneSceneIdOrUndefinedEquality() {
  const project = {
    assets: {
      characters: [],
      props: [],
      scenes: [
        { id: 'e1', name: '已引用场景' },
        { id: 'e2', name: '未引用场景', sceneId: 'legacy-e2', sceneName: 'legacy-name' },
      ],
    },
    shots: [
      { visual: '这里没有提到目标地点。', sceneId: undefined, sceneName: undefined },
      { visual: '已引用场景在远处出现。', sceneId: '', sceneName: '' },
    ],
  };

  const obsolete = detectObsoleteAssets(project);
  assert.equal(byId(obsolete, 'e1'), undefined, 'text mention should keep scene');
  assert.equal(byId(obsolete, 'e2')?.reasonCodes.includes('no_shot_reference'), true, 'scene.sceneId/scene.sceneName must not keep scene');
}

function testPropReferenceUsesTextAndCarriesCharacter() {
  const project = baseProject();
  const obsolete = detectObsoleteAssets(project);
  assert.equal(byId(obsolete, 'p1'), undefined, 'prop text mention should keep prop');
  assert.equal(byId(obsolete, 'p3'), undefined, 'carriesCharacter pointing to existing character should keep prop');
  const orphan = byId(obsolete, 'p2');
  assert(orphan, 'orphan prop should be obsolete');
  assert.deepEqual(orphan.reasonCodes, ['owner_missing', 'no_shot_reference'], 'orphan prop should report both reasons');
  assert.deepEqual(orphan.reasons, ['归属角色不存在', '无分镜引用'], 'reasons must be readable UI copy');
}

function testOwnerEmptyNullAndStringNullArePublic() {
  const project = {
    assets: {
      characters: [{ id: 'c1', name: '甲' }],
      scenes: [],
      props: [
        { id: 'p1', name: '公共道具1', ownership: '' },
        { id: 'p2', name: '公共道具2', ownership: null },
        { id: 'p3', name: '公共道具3', ownership: 'null' },
      ],
    },
    shots: [],
  };
  assert.deepEqual(detectObsoleteAssets(project), [], 'empty/null/"null" ownership should be public and shots empty skips no_shot_reference');
}

function testShotsEmptySkipsNoShotReferenceButNotOwnerMissing() {
  const project = {
    assets: {
      characters: [{ id: 'c1', name: '甲' }],
      scenes: [{ id: 'e1', name: '空镜场景' }],
      props: [
        { id: 'p1', name: '公共道具', ownership: null },
        { id: 'p2', name: '孤儿道具', ownership: 'c404' },
      ],
    },
    shots: [],
  };
  const obsolete = detectObsoleteAssets(project);
  assert.equal(byId(obsolete, 'e1'), undefined, 'shots empty should not mark scene no_shot_reference');
  assert.equal(byId(obsolete, 'p1'), undefined, 'shots empty should not mark prop no_shot_reference');
  assert.deepEqual(byId(obsolete, 'p2')?.reasonCodes, ['owner_missing'], 'owner_missing still applies without shots');
}

function testLiveArrayIndexes() {
  const project = baseProject();
  project.assets.props.splice(0, 1);
  const obsolete = detectObsoleteAssets(project);
  assert.equal(byId(obsolete, 'p2')?.idx, 0, 'idx should be live array index after deletion/reorder');
}

function testNamelessAssetUsesSyntheticDisplayName() {
  const project = {
    assets: {
      characters: [{ id: 'c1', name: '甲' }],
      scenes: [],
      props: [{ ownership: 'missing-char' }],
    },
    shots: [{ visual: '没有提到任何道具。' }],
  };
  const obsolete = detectObsoleteAssets(project);
  assert.equal(obsolete.length, 1, 'nameless obsolete prop should still be detected');
  assert.equal(obsolete[0].idx, 0, 'nameless obsolete prop should keep live index');
  assert.equal(obsolete[0].name, '道具 1', 'nameless obsolete prop should get a synthetic UI name');
  assert.deepEqual(obsolete[0].reasonCodes, ['owner_missing', 'no_shot_reference']);
}

function testFrontendAndRouteContracts() {
  const route = fs.readFileSync(path.join(REPO_ROOT, 'app/api/orchestration/detect-obsolete/route.ts'), 'utf8');
  const assets = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/assets.js'), 'utf8');
  const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');

  assert(route.includes("import { detectObsoleteAssets }"), 'detect-obsolete route should use obsolete asset detector');
  assert(!route.includes('describeProjectArtifactStatus'), 'detect-obsolete route must not return sentinel artifact decisions');
  assert(assets.includes('function _normalizeObsoleteAssetItems(items)'), 'assets.js should filter obsolete response shape');
  assert(assets.includes('!Number.isFinite(idx)'), 'obsolete response filter should reject non-numeric idx');
  assert(assets.includes('!reasons.length'), 'obsolete response filter should require readable reasons');
  assert(assets.includes('function _syntheticObsoleteAssetName(item)'), 'frontend should recognize backend synthetic display names');
  assert(assets.includes('expectedName === _syntheticObsoleteAssetName(item)'), 'nameless assets with synthetic display names should still match current item');
  assert(assets.includes('export async function _removeObsoleteAssets(items)'), 'obsolete cleanup should be async');
  assert(assets.includes('await _flushAssetsProjectNow();'), 'obsolete cleanup should flush immediately after removal');
  assert(!assets.includes('showToast("已清理 " + toRemove.length + " 个过时资产"'), 'asset cleanup toast must use real removed count');
  assert(main.includes('await _removeObsoleteAssets(toRemove)'), 'cascade cleanup should await removal');
  assert(main.includes('removeResult.removed'), 'cascade cleanup toast should use real removed count');
  assert(!main.includes('showToast("已清理 " + toRemove.length + " 个过时资产"'), 'cascade cleanup must not use checked count');
  assert(workspace.includes('"/modules/assets.js": "/modules/assets.js?v=183"'), 'assets.js import map should be bumped');
  assert(workspace.includes('src="main.js?v=359"'), 'main.js script version should be bumped');
}

testSceneReferenceUsesAssetIdAndNameOnly();
testSceneDoesNotUseSceneSceneIdOrUndefinedEquality();
testPropReferenceUsesTextAndCarriesCharacter();
testOwnerEmptyNullAndStringNullArePublic();
testShotsEmptySkipsNoShotReferenceButNotOwnerMissing();
testLiveArrayIndexes();
testNamelessAssetUsesSyntheticDisplayName();
testFrontendAndRouteContracts();

console.log('[test-obsolete-assets] all assertions passed');
