/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function compileTs(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    sourcePath,
    code: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadSceneViews() {
  const compiled = compileTs('lib/scene-views.ts');
  const moduleObj = { exports: {} };
  function localRequire(id) {
    if (id === './visual-reference-state') {
      return {
        isBlockingReferenceStatus: (status) => status === 'missing' || status === 'failed',
        resolveAssetReferenceState: (asset) => ({
          status: asset?.reference?.status || 'ready',
          currentUrl: asset?.reference?.currentUrl || '',
          lastKnownGoodUrl: asset?.reference?.lastKnownGoodUrl || '',
        }),
      };
    }
    return require(id);
  }
  vm.runInNewContext(
    compiled.code,
    { require: localRequire, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

const sceneViews = loadSceneViews();

function testLegacyUrlStrategies() {
  const scene = {
    imageUrl: 'image',
    rawUrl: 'raw',
    currentUrl: 'top-current',
    realPhotoUrl: 'real',
    coverUrl: 'cover',
    pencilUrl: 'pencil',
    reference: {
      currentUrl: 'ref-current',
      lastKnownGoodUrl: 'ref-last',
      status: 'ready',
    },
  };
  assert.equal(sceneViews.resolveSceneImageUrl(scene, { strategy: 'selection', gate: false }), 'image');
  assert.equal(sceneViews.resolveSceneImageUrl({ rawUrl: 'raw', currentUrl: 'top-current' }, { strategy: 'selection', gate: false }), 'raw');
  assert.equal(sceneViews.resolveSceneImageUrl(scene, { strategy: 'framePlan', gate: true }), 'ref-current');
  assert.equal(sceneViews.resolveSceneImageUrl({ rawUrl: 'raw', pencilUrl: 'pencil', reference: { status: 'ready' } }, { strategy: 'framePlan', gate: true }), 'raw');
  assert.equal(sceneViews.resolveSceneImageUrl({ pencilUrl: 'pencil', reference: { status: 'ready' } }, { strategy: 'framePlan', gate: true }), 'pencil');
  assert.equal(sceneViews.resolveSceneImageUrl(scene, { strategy: 'videoManifest', gate: true }), 'ref-current');
  assert.equal(sceneViews.resolveSceneImageUrl({ pencilUrl: 'pencil', coverUrl: 'cover', reference: { status: 'ready' } }, { strategy: 'videoManifest', gate: true }), 'cover');
}

function testViewSelectionAndKeys() {
  const scene = {
    imageUrl: 'est-top',
    views: [
      { role: 'establishing', imageUrl: 'est' },
      { role: 'reverse', imageUrl: 'rev' },
      { role: 'alt', imageUrl: 'alt' },
      { role: 'topdown', imageUrl: 'top' },
    ],
  };
  assert.equal(sceneViews.pickSceneView(scene, { angle: 'reverse 180 degree' }).role, 'reverse');
  assert.equal(sceneViews.pickSceneView(scene, { shotType: 'side close-up' }).role, 'alt');
  assert.equal(sceneViews.pickSceneTopdownAnchor(scene).url, 'top');
  assert.equal(sceneViews.sceneViewStaleKey(2), 'asset_img_scene_2');
  assert.equal(sceneViews.sceneViewStaleKey(2, 'topdown'), 'asset_img_scene_2_topdown');
  assert.equal(sceneViews.isPrimarySceneRef({ role: 'scene', viewRole: 'reverse' }), true);
  assert.equal(sceneViews.isTopdownSceneRef({ role: 'scene', viewRole: 'topdown' }), true);
  assert.equal(sceneViews.isPrimarySceneRef({ role: 'scene', viewRole: 'topdown' }), false);

  const uploaded = sceneViews.applySceneViewWrite({
    name: '旧大厅',
    imageUrl: 'old-main',
    rawUrl: 'old-main',
    views: [
      { role: 'establishing', imageUrl: 'old-main' },
      { role: 'reverse', imageUrl: 'old-reverse' },
      { role: 'topdown', imageUrl: 'old-top' },
    ],
    viewsVersion: 3,
  }, {
    role: 'establishing',
    imageUrl: 'uploaded-main',
    rawUrl: 'uploaded-main',
    assetId: 'upload-asset',
    invalidateOtherViews: true,
  });
  assert.equal(uploaded.imageUrl, 'uploaded-main', 'establishing write mirrors top-level imageUrl');
  assert.equal(uploaded.assetId, 'upload-asset', 'establishing upload mirrors top-level assetId');
  assert.equal(JSON.stringify(uploaded.views.map((view) => view.role)), JSON.stringify(['establishing']), 'upload invalidates secondary scene views');
  assert.equal(uploaded.views[0].imageUrl, 'uploaded-main', 'establishing view receives uploaded image');
  assert.equal(uploaded.viewsVersion, 4, 'scene view write increments version');
  assert.equal(uploaded.viewHistory[0].version, 3, 'previous view set is archived before invalidation');
}

testLegacyUrlStrategies();
testViewSelectionAndKeys();
console.log('[test-scene-views] all assertions passed');
