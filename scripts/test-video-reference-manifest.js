/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 覆盖视频参考图 manifest 的 7 图优先级链:
 *   - Image N 顺序: 首帧 → 场景 → 角色1/2/3 → 道具1 → 角色4;
 *   - 第 4 角色优先于第 2 道具, 第 5 角色和第 2 道具被预算挤掉;
 *   - 场景缺失时后续候选顺延, 候选用完不凑满;
 *   - 同一角色重复命中只进 1 张;
 *   - 道具按提及次数降序、首次出现顺序升序稳定排序;
 *   - 资产无可用本地图时记录 asset_missing;
 *   - matcher 调用角色选择器时使用 maxSlots=5/perCharacterLimit=1。
 */

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

function loadVideoReferenceManifest() {
  const compiled = compileTs('lib/video-reference-manifest.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    compiled.code,
    { require, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function makeLoader(pathMap, state) {
  const videoReferenceManifest = loadVideoReferenceManifest();
  const compiled = compileTs('lib/reference-matcher.ts');
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id === 'node:path') return require('node:path');
    if (id === './content-sanitize') {
      return {
        hasFillLightPositiveMention: (value) => /补光灯|fill light/i.test(String(value || '')),
      };
    }
    if (id === './image-gen') {
      return {
        resolveLocalImagePath: (url) => pathMap[url] || null,
      };
    }
    if (id === './visual-reference-state') {
      return {
        resolveAssetReferenceState: (asset) => ({
          currentUrl: asset?.reference?.currentUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl || '',
          lastKnownGoodUrl: asset?.reference?.lastKnownGoodUrl || '',
          effectiveDescription: asset?.description || asset?.visual || asset?.imagePrompt || '',
        }),
      };
    }
    if (id === './panel-selection') {
      return {
        selectCharacterReferencePanels: (opts) => {
          state.lastPanelOptions = opts;
          const chars = opts.project?.assets?.characters || [];
          const shotNames = [];
          for (const shot of opts.shots || []) {
            for (const name of Array.isArray(shot.characters) ? shot.characters : []) {
              if (!shotNames.includes(name)) shotNames.push(name);
            }
          }
          return shotNames
            .map((name) => chars.find((ch) => ch.name === name || ch.role === name))
            .filter(Boolean)
            .slice(0, opts.maxSlots || 5)
            .map((ch, idx) => {
              const panelUrl = ch.panels?.frontUrl;
              const panelPath = panelUrl ? pathMap[panelUrl] : null;
              if (!panelPath) return null;
              return {
                characterName: ch.name || ch.role,
                panel: 'front',
                path: panelPath,
                intent: 'body',
                priority: 100 - idx,
                reason: 'test:front',
              };
            })
            .filter(Boolean);
        },
      };
    }
    if (id === './scene-selection') {
      return {
        pickSceneForShots: ({ assets }) => ({
          scene: (assets?.scenes || []).find((scene) => scene.imageUrl || scene.rawUrl) || null,
          matchReason: 'test-scene',
        }),
      };
    }
    if (id === './video-reference-manifest') return videoReferenceManifest;
    return require(id);
  }

  vm.runInNewContext(
    compiled.code,
    { require: localRequire, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assert failed: ${message}\n  actual:   ${a}\n  expected: ${e}`);
}

function img(id) {
  return `/api/images/file/${id}`;
}

function makePathMap(urls) {
  const out = {};
  urls.forEach((url, idx) => { out[url] = `/tmp/origin-ref-${idx}.png`; });
  return out;
}

function makeCharacter(name, idx) {
  return {
    id: `char-${idx}`,
    name,
    imageUrl: img(`char-sheet-${idx}`),
    panels: {
      sheetUrl: img(`char-sheet-${idx}`),
      frontUrl: img(`char-front-${idx}`),
    },
  };
}

function makeProject({ characterCount = 4, propCount = 2, includeScene = true, missingCharacter = false } = {}) {
  const characters = Array.from({ length: characterCount }, (_, idx) => (
    missingCharacter && idx === 0
      ? { id: 'char-missing', name: '角色缺图' }
      : makeCharacter(`角色${idx + 1}`, idx + 1)
  ));
  const props = Array.from({ length: propCount }, (_, idx) => ({
    id: `prop-${idx + 1}`,
    name: `道具${idx + 1}`,
    imageUrl: img(`prop-${idx + 1}`),
    description: `道具${idx + 1} description`,
  }));
  const scenes = includeScene ? [{
    id: 'scene-1',
    name: '主场景',
    imageUrl: img('scene-1'),
    description: 'main scene',
    isMain: true,
  }] : [];
  const visual = [
    ...characters.map((ch) => ch.name),
    ...props.map((prop) => prop.name),
  ].join(' ');
  return {
    assets: { characters, props, scenes },
    shots: [{
      visual,
      description: visual,
      dialogue: `角色1: 拿起${props[0]?.name || ''}`,
      characters: characters.map((ch) => ch.name),
    }],
  };
}

function urlsForProject(project, firstFrameUrl) {
  const urls = [firstFrameUrl];
  for (const scene of project.assets.scenes || []) urls.push(scene.imageUrl);
  for (const ch of project.assets.characters || []) {
    if (ch.imageUrl) urls.push(ch.imageUrl);
    if (ch.panels?.sheetUrl) urls.push(ch.panels.sheetUrl);
    if (ch.panels?.frontUrl) urls.push(ch.panels.frontUrl);
  }
  for (const prop of project.assets.props || []) urls.push(prop.imageUrl);
  return urls.filter(Boolean);
}

function build(project, firstFrameUrl, state = {}) {
  const pathMap = makePathMap(urlsForProject(project, firstFrameUrl));
  const mod = makeLoader(pathMap, state);
  return mod.buildVideoReferenceManifest({
    project,
    assets: project.assets,
    shots: project.shots,
    groupShotIndices: [0],
    groupIdx: 0,
    ownerId: 7,
    storyboardImageUrl: firstFrameUrl,
  });
}

async function testFullPriorityChain() {
  const state = {};
  const project = makeProject({ characterCount: 5, propCount: 2, includeScene: true });
  const result = build(project, img('first-frame'), state);
  assertEqual(result.budget, 7, 'budget = 7');
  assertEqual(state.lastPanelOptions.maxSlots, 5, 'matcher asks panel selector for five character candidates');
  assertEqual(state.lastPanelOptions.perCharacterLimit, 1, 'matcher restricts to one panel per character');
  assertEqual(
    result.manifest.map((ref) => `${ref.imageNo}:${ref.role}:${ref.assetName}`),
    [
      '1:first_frame:first frame',
      '2:scene:主场景',
      '3:character:角色1',
      '4:character:角色2',
      '5:character:角色3',
      '6:prop:道具1',
      '7:character:角色4',
    ],
    'priority chain order',
  );
  const dropped = result.droppedReferences.map((ref) => `${ref.role}:${ref.assetName}:${ref.reason}`).sort();
  assert(dropped.includes('character:角色5:image_budget_exceeded'), 'character 5 dropped by budget');
  assert(dropped.includes('prop:道具2:image_budget_exceeded'), 'prop 2 dropped by budget after character 4');
}

async function testMissingSceneCompactsImageNumbers() {
  const project = makeProject({ characterCount: 2, propCount: 0, includeScene: false });
  const result = build(project, img('first-frame'));
  assertEqual(
    result.manifest.map((ref) => `${ref.imageNo}:${ref.role}:${ref.assetName}`),
    ['1:first_frame:first frame', '2:character:角色1', '3:character:角色2'],
    'missing scene compacts image numbers and does not fill unused budget',
  );
}

async function testThreeCharactersNoPropsKeepsThirdCharacter() {
  const project = makeProject({ characterCount: 3, propCount: 0, includeScene: true });
  const result = build(project, img('first-frame'));
  assert(result.manifest.some((ref) => ref.role === 'character' && ref.assetName === '角色3'), 'third character should be selected');
}

async function testDuplicateCharacterOnlyOnce() {
  const project = makeProject({ characterCount: 1, propCount: 0, includeScene: false });
  project.shots[0].visual = '角色1 角色1 角色1 close-up';
  project.shots[0].dialogue = '角色1: 角色1必须保持一致';
  const result = build(project, img('first-frame'));
  assertEqual(result.manifest.filter((ref) => ref.role === 'character').length, 1, 'duplicate mentions still select one character image');
}

async function testPropSortUsesMentionsThenTextOrder() {
  const project = makeProject({ characterCount: 1, propCount: 3, includeScene: true });
  project.assets.props = [
    { id: 'prop-early', name: '钥匙', imageUrl: img('prop-early'), description: '钥匙 description' },
    { id: 'prop-many', name: '玉佩', imageUrl: img('prop-many'), description: '玉佩 description' },
    { id: 'prop-late', name: '宝盒', imageUrl: img('prop-late'), description: '宝盒 description' },
  ];
  project.shots[0].visual = '钥匙 宝盒 玉佩 玉佩';
  project.shots[0].description = '';
  project.shots[0].dialogue = '';
  project.shots[0].characters = ['角色1'];

  const result = build(project, img('first-frame'));
  assertEqual(
    result.manifest.filter((ref) => ref.role === 'prop').map((ref) => ref.assetName),
    ['玉佩', '钥匙', '宝盒'],
    'props sort by mention count, then first text occurrence',
  );
}

async function testAssetMissingReason() {
  const project = makeProject({ characterCount: 1, propCount: 0, includeScene: false, missingCharacter: true });
  const result = build(project, img('first-frame'));
  assertEqual(result.manifest.map((ref) => ref.role), ['first_frame'], 'missing character should not be selected');
  assert(
    result.droppedReferences.some((ref) => ref.role === 'character' && ref.assetName === '角色缺图' && ref.reason === 'asset_missing'),
    'missing character records asset_missing',
  );
}

async function run() {
  const tests = [
    ['full priority chain', testFullPriorityChain],
    ['missing scene compacts image numbers', testMissingSceneCompactsImageNumbers],
    ['three characters no props keeps third character', testThreeCharactersNoPropsKeepsThirdCharacter],
    ['duplicate character only once', testDuplicateCharacterOnlyOnce],
    ['prop sort uses mentions then text order', testPropSortUsesMentionsThenTextOrder],
    ['asset missing reason', testAssetMissingReason],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`✓ ${name}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
