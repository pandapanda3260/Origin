/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 覆盖视频参考图 manifest 的动态分配:
 *   - 视频参考图总预算为 9;
 *   - 首帧硬保底, 场景/角色软保底;
 *   - 角色/场景/道具按本段重要度动态混排;
 *   - 近景/特写里的角色或道具会上浮;
 *   - 场景缺失时后续候选顺延, 候选用完不凑满;
 *   - 普通角色重复命中只进 1 张, 近景主角色可进 sheet+headshot;
 *   - 道具按提及次数降序、首次出现顺序升序稳定排序;
 *   - 资产无可用本地图时记录 asset_missing;
 *   - matcher 调用角色选择器时使用 maxSlots=5/perCharacterLimit=1, 并开启近景主角色双图。
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

function loadReferenceRoles() {
  const compiled = compileTs('lib/reference-roles.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    compiled.code,
    { require, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function loadVideoPromptRuntime() {
  const videoReferenceManifest = loadVideoReferenceManifest();
  const compiled = compileTs('lib/video-prompt-runtime.ts');
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id === 'node:fs') return require('node:fs');
    if (id === './feature-flags') {
      return { isIndependentMultiImageModeEnabled: () => true };
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

function loadPromptsModule() {
  const videoReferenceManifest = loadVideoReferenceManifest();
  const compiled = compileTs('lib/prompts.ts');
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id === './video-reference-manifest') return videoReferenceManifest;
    if (id === './world-template-context') return { formatWorldContextForPrompt: () => '' };
    if (id === './casting-profile') {
      return {
        styleBibleForShotPrompt: () => '',
        styleBibleForVideoPrompt: () => '',
      };
    }
    if (id === './shot-plan-normalize') {
      return {
        resolveShotFieldsForPrompt: (shot) => ({
          shotType: shot?.shotType || '',
          angle: shot?.angle || '',
          lens: shot?.lens || '',
          focus: shot?.focus || '',
          light: shot?.light || '',
          composition: shot?.composition || '',
          camera: shot?.camera || '',
          movement: shot?.movement || '',
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

function makeLoader(pathMap, state) {
  const videoReferenceManifest = loadVideoReferenceManifest();
  const referenceRoles = loadReferenceRoles();
  const compiled = compileTs('lib/reference-matcher.ts');
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id === 'node:path') return require('node:path');
    if (id === './image-gen') {
      return {
        resolveLocalImagePath: (url) => pathMap[url] || null,
      };
    }
    if (id === './runtime-paths') {
      return {
        dataPath: (...parts) => path.join(root, 'data', ...parts),
        getDataDir: () => path.join(root, 'data'),
      };
    }
    if (id === './visual-reference-state') {
      return {
        resolveAssetReferenceState: (asset) => ({
          currentUrl: asset?.reference?.currentUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl || '',
          lastKnownGoodUrl: asset?.reference?.lastKnownGoodUrl || '',
          status: asset?.reference?.status || (asset?.reference?.currentUrl || asset?.imageUrl || asset?.rawUrl || asset?.realPhotoUrl || asset?.coverUrl ? 'ready' : 'missing'),
          effectiveDescription: asset?.description || asset?.visual || asset?.imagePrompt || '',
        }),
        isBlockingReferenceStatus: (status) => status === 'missing' || status === 'failed' || status === 'legacy_sketch_only',
      };
    }
    if (id === './panel-selection') {
      return {
        selectCharacterReferencePanels: (opts) => {
          state.lastPanelOptions = opts;
          const chars = opts.project?.assets?.characters || [];
          const shotNames = [];
          const shots = opts.shots || [];
          for (const shot of opts.shots || []) {
            for (const name of Array.isArray(shot.characters) ? shot.characters : []) {
              if (!shotNames.includes(name)) shotNames.push(name);
            }
          }
          const closeUpName = shotNames.find((name) => {
            if (!opts.enableFocusCharacterPair) return false;
            const ch = chars.find((item) => item.name === name || item.role === name);
            if (!ch?.panels?.sheetUrl || !ch?.panels?.headshotUrl) return false;
            return shots.some((shot) => {
              const shotText = [shot.visual, shot.description, shot.camera, shot.shotType, shot.composition, shot.focus].filter(Boolean).join(' ');
              const hasName = (Array.isArray(shot.characters) && shot.characters.includes(name)) || shotText.includes(name);
              return hasName && /大特写|特写|近景|脸部|面部|表情|眼神|头像|close-up|closeup|face|eyes/.test(shotText);
            });
          });
          const out = [];
          for (const name of shotNames) {
            const ch = chars.find((item) => item.name === name || item.role === name);
            if (!ch) continue;
            if (name === closeUpName) {
              const sheetPath = pathMap[ch.panels?.sheetUrl];
              const headshotPath = pathMap[ch.panels?.headshotUrl];
              if (sheetPath && headshotPath) {
                out.push({
                  characterName: ch.name || ch.role,
                  panel: 'sheet',
                  path: sheetPath,
                  intent: 'face',
                  priority: 100,
                  reason: 'test:focus-pair:sheet',
                  focusPair: true,
                });
                out.push({
                  characterName: ch.name || ch.role,
                  panel: 'headshot',
                  path: headshotPath,
                  intent: 'face',
                  priority: 100,
                  reason: 'test:focus-pair:headshot',
                  focusPair: true,
                });
                continue;
              }
            }
            const panelUrl = ch.panels?.frontUrl;
            const panelPath = panelUrl ? pathMap[panelUrl] : null;
            if (!panelPath) continue;
            out.push({
              characterName: ch.name || ch.role,
              panel: 'front',
              path: panelPath,
              intent: 'body',
              priority: 100 - out.length,
              reason: 'test:front',
            });
          }
          return out.slice(0, (opts.maxSlots || 5) + (closeUpName ? 1 : 0));
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
    if (id === './scene-views') {
      const normalizeRole = (role) => ['establishing', 'reverse', 'alt', 'topdown'].includes(role) ? role : null;
      const viewFor = (scene, role) => Array.isArray(scene?.views)
        ? scene.views.find((view) => normalizeRole(view?.role) === role)
        : null;
      const urlFor = (scene, opts = {}) => {
        if (!scene) return '';
        const role = normalizeRole(opts.viewRole);
        if (role) {
          const view = viewFor(scene, role);
          const ref = view?.reference || {};
          if (['missing', 'failed', 'legacy_sketch_only'].includes(ref.status)) return '';
          return ref.currentUrl || ref.lastKnownGoodUrl || view?.imageUrl || view?.rawUrl || (role === 'establishing' ? urlFor(scene) : '');
        }
        const ref = scene.reference || {};
        if (['missing', 'failed', 'legacy_sketch_only'].includes(ref.status)) return '';
        return ref.currentUrl || ref.lastKnownGoodUrl || scene.imageUrl || scene.rawUrl || scene.realPhotoUrl || scene.coverUrl || '';
      };
      return {
        resolveSceneImageUrl: urlFor,
        pickSceneView: (scene, shot) => {
          const text = [shot?.angle, shot?.shotType, shot?.camera, shot?.composition, shot?.focus].filter(Boolean).join(' ');
          const wanted = /反打|背面|reverse|180/.test(text) ? 'reverse' : /侧|特写|detail|close/.test(text) ? 'alt' : 'establishing';
          const url = urlFor(scene, { viewRole: wanted }) || urlFor(scene, { viewRole: 'establishing' }) || urlFor(scene);
          return { role: urlFor(scene, { viewRole: wanted }) ? wanted : 'establishing', url, view: viewFor(scene, wanted) || viewFor(scene, 'establishing') || undefined };
        },
        pickSceneTopdownAnchor: (scene) => {
          const url = urlFor(scene, { viewRole: 'topdown' });
          return url ? { role: 'topdown', url, view: viewFor(scene, 'topdown') || undefined } : null;
        },
      };
    }
    if (id === './prop-views') {
      const normalizeRole = (role) => ['front', 'side', 'back', 'top', 'hero'].includes(role) ? role : null;
      const urlFor = (prop, opts = {}) => {
        const role = normalizeRole(opts.viewRole);
        if (role) {
          const view = prop?.views?.[role];
          const ref = view?.reference || {};
          if (['missing', 'failed', 'legacy_sketch_only'].includes(ref.status)) return '';
          return ref.currentUrl || ref.lastKnownGoodUrl || view?.imageUrl || view?.rawUrl || '';
        }
        const ref = prop?.reference || {};
        if (['missing', 'failed', 'legacy_sketch_only'].includes(ref.status)) return '';
        return ref.currentUrl || ref.lastKnownGoodUrl || prop?.views?.front?.imageUrl || prop?.views?.hero?.imageUrl || prop?.imageUrl || prop?.rawUrl || '';
      };
      return {
        resolvePropImageUrl: urlFor,
        pickPropView: (prop, shot) => {
          const text = [shot?.angle, shot?.shotType, shot?.camera, shot?.composition, shot?.description, shot?.visual].filter(Boolean).join(' ');
          const name = String(prop?.name || prop?.propName || '').toLowerCase();
          const mentioned = name && text.toLowerCase().includes(name);
          const wanted = /俯拍|top|overhead|from above/.test(text)
            ? 'top'
            : mentioned && /背面|back|rear/.test(text)
              ? 'back'
              : mentioned && /侧面|side|profile/.test(text)
                ? 'side'
                : 'front';
          const roles = wanted === 'front' ? ['front', 'hero', 'side', 'back', 'top'] : [wanted, 'front', 'hero', 'side', 'back', 'top'];
          for (const role of roles) {
            const url = urlFor(prop, { viewRole: role });
            if (url) return { role, url, view: prop?.views?.[role] };
          }
          return { role: 'front', url: urlFor(prop) };
        },
      };
    }
    if (id === './video-reference-manifest') return videoReferenceManifest;
    if (id === './reference-roles') return referenceRoles;
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

function makeCharacter(name, idx, opts = {}) {
  return {
    id: `char-${idx}`,
    name,
    imageUrl: img(`char-sheet-${idx}`),
    panels: {
      sheetUrl: img(`char-sheet-${idx}`),
      ...(opts.withHeadshot ? { headshotUrl: img(`char-headshot-${idx}`) } : {}),
      frontUrl: img(`char-front-${idx}`),
    },
  };
}

function makeProject({ characterCount = 4, propCount = 2, includeScene = true, missingCharacter = false, withCharacterHeadshots = false } = {}) {
  const characters = Array.from({ length: characterCount }, (_, idx) => (
    missingCharacter && idx === 0
      ? { id: 'char-missing', name: '角色缺图' }
      : makeCharacter(`角色${idx + 1}`, idx + 1, { withHeadshot: withCharacterHeadshots })
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
  for (const scene of project.assets.scenes || []) {
    urls.push(scene.imageUrl);
    for (const view of scene.views || []) urls.push(view.imageUrl || view.rawUrl || view.reference?.currentUrl);
  }
  for (const ch of project.assets.characters || []) {
    if (ch.imageUrl) urls.push(ch.imageUrl);
    if (ch.panels?.sheetUrl) urls.push(ch.panels.sheetUrl);
    if (ch.panels?.headshotUrl) urls.push(ch.panels.headshotUrl);
    if (ch.panels?.frontUrl) urls.push(ch.panels.frontUrl);
  }
  for (const prop of project.assets.props || []) {
    urls.push(prop.imageUrl);
    for (const view of Object.values(prop.views || {})) {
      if (view && typeof view === 'object') urls.push(view.imageUrl || view.rawUrl || view.reference?.currentUrl);
    }
  }
  return urls.filter(Boolean);
}

function build(project, firstFrameUrl, state = {}, overrides = {}) {
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
    ...overrides,
  });
}

async function testDynamicPriorityChain() {
  const state = {};
  const project = makeProject({ characterCount: 5, propCount: 2, includeScene: true });
  const result = build(project, img('first-frame'), state);
  assertEqual(result.budget, 9, 'budget = 9');
  assertEqual(state.lastPanelOptions.maxSlots, 5, 'matcher asks panel selector for five character candidates');
  assertEqual(state.lastPanelOptions.perCharacterLimit, 1, 'matcher restricts to one panel per character');
  assertEqual(state.lastPanelOptions.enableFocusCharacterPair, true, 'matcher enables close-up focus character sheet+headshot pair');
  const entries = result.manifest.map((ref) => `${ref.role}:${ref.assetName}`);
  assertEqual(entries[0], 'first_frame:first frame', 'first frame is the hard anchor');
  assert(entries.includes('scene:主场景'), 'scene soft floor is selected');
  for (let idx = 1; idx <= 5; idx++) assert(entries.includes(`character:角色${idx}`), `character ${idx} selected within budget 9`);
  assert(entries.includes('prop:道具1'), 'prop 1 selected within budget 9');
  assert(entries.includes('prop:道具2'), 'prop 2 selected within budget 9');
  assertEqual(result.manifest.length, 9, 'all nine available references are selected');
  assert(
    !result.droppedReferences.some((ref) => ref.reason === 'image_budget_exceeded'),
    'no available candidate is dropped when it fits budget 9',
  );
}

async function testSceneTopdownAnchorSurvivesSelection() {
  const project = makeProject({ characterCount: 5, propCount: 2, includeScene: true });
  project.assets.scenes[0] = {
    ...project.assets.scenes[0],
    imageUrl: img('scene-establishing'),
    views: [
      { role: 'establishing', imageUrl: img('scene-establishing') },
      { role: 'topdown', imageUrl: img('scene-topdown') },
    ],
  };
  const result = build(project, img('first-frame'));
  const sceneRefs = result.manifest.filter((ref) => ref.role === 'scene' && ref.assetName === '主场景');
  assertEqual(sceneRefs.map((ref) => ref.viewRole || 'establishing'), ['establishing', 'topdown'], 'primary scene and topdown anchor both survive scene de-dupe');
  assert(sceneRefs[0].imageNo < sceneRefs[1].imageNo, 'primary camera scene is ordered before topdown anchor');
  assert(sceneRefs[1].referenceBrief.includes('topdown_layout_anchor'), 'topdown anchor receives distinct brief text');
}

async function testCloseUpEntityBoost() {
  const project = makeProject({ characterCount: 2, propCount: 1, includeScene: false });
  project.assets.props = [{ id: 'prop-bell', name: '混沌钟', imageUrl: img('prop-bell'), description: '混沌钟 description' }];
  project.shots = [
    {
      visual: '远景 角色1 站在前景，角色2 在远处',
      description: '',
      dialogue: '',
      shotType: '远景',
      characters: ['角色1', '角色2'],
    },
    {
      visual: '近景 角色2 凝视 混沌钟，混沌钟发出光芒',
      description: '',
      dialogue: '',
      shotType: '近景',
      characters: ['角色2'],
    },
  ];

  const result = build(project, img('first-frame'), {}, {
    shots: project.shots,
    groupShotIndices: [0, 1],
  });
  const names = result.manifest.map((ref) => `${ref.role}:${ref.assetName}`);
  const role2Index = names.indexOf('character:角色2');
  const role1Index = names.indexOf('character:角色1');
  const propIndex = names.indexOf('prop:混沌钟');
  assert(role2Index >= 0 && role1Index >= 0, 'both characters are selected');
  assert(propIndex >= 0, 'close-up prop is selected');
  assert(role2Index < role1Index, 'close-up character outranks wide-shot background character');
}

async function testCloseUpFocusCharacterGetsSheetHeadshotPair() {
  const project = makeProject({ characterCount: 2, propCount: 1, includeScene: true, withCharacterHeadshots: true });
  project.assets.props = [{ id: 'prop-bell', name: '混沌钟', imageUrl: img('prop-bell'), description: '混沌钟 description' }];
  project.shots = [
    {
      visual: '远景 角色2 站在主场景中，混沌钟在背景里',
      description: '',
      dialogue: '',
      shotType: '远景',
      characters: ['角色2'],
    },
    {
      visual: '近景 角色1 凝视 混沌钟，角色1 表情震动',
      description: '',
      dialogue: '角色1: 这就是混沌钟',
      shotType: '近景',
      characters: ['角色1'],
    },
  ];

  const result = build(project, img('first-frame'), {}, {
    shots: project.shots,
    groupShotIndices: [0, 1],
  });
  const entries = result.manifest.map((ref) => `${ref.role}:${ref.assetName}:${ref.panelInfo?.panel || ''}`);
  const sheetIndex = entries.indexOf('character:角色1:sheet');
  const headshotIndex = entries.indexOf('character:角色1:headshot');
  const propIndex = result.manifest.findIndex((ref) => ref.role === 'prop' && ref.assetName === '混沌钟');
  assert(sheetIndex >= 0, 'close-up focus character sheet is selected');
  assert(headshotIndex >= 0, 'close-up focus character headshot is selected');
  assertEqual(headshotIndex, sheetIndex + 1, 'focus character sheet/headshot stay adjacent');
  assert(propIndex > headshotIndex, 'focus face pair is submitted before the close-up prop');
  assertEqual(
    result.manifest.filter((ref) => ref.role === 'character' && ref.assetName === '角色2').length,
    1,
    'ordinary supporting character still gets one reference image',
  );
}

async function testCrowdedSegmentCloseUpOrdering() {
  const project = makeProject({ characterCount: 5, propCount: 4, includeScene: true });
  project.assets.props = [
    { id: 'prop-bell', name: '混沌钟', imageUrl: img('prop-bell'), description: '混沌钟 description' },
    { id: 'prop-sword', name: '长剑', imageUrl: img('prop-sword'), description: '长剑 description' },
    { id: 'prop-token', name: '令牌', imageUrl: img('prop-token'), description: '令牌 description' },
    { id: 'prop-lantern', name: '灯盏', imageUrl: img('prop-lantern'), description: '灯盏 description' },
  ];
  project.shots = [
    {
      visual: '远景 角色1 角色2 角色3 角色4 角色5 站在主场景，长剑 令牌 灯盏 都在背景中',
      description: '',
      dialogue: '',
      shotType: '远景',
      characters: ['角色1', '角色2', '角色3', '角色4', '角色5'],
    },
    {
      visual: '近景 角色5 凝视 混沌钟，混沌钟占据画面中心',
      description: '',
      dialogue: '',
      shotType: '近景',
      characters: ['角色5'],
    },
  ];

  const result = build(project, img('first-frame'), {}, {
    shots: project.shots,
    groupShotIndices: [0, 1],
  });
  const names = result.manifest.map((ref) => `${ref.role}:${ref.assetName}`);
  assertEqual(result.budget, 9, 'crowded segment still uses budget 9');
  assertEqual(names[0], 'first_frame:first frame', 'crowded segment keeps first frame first');
  assert(names.includes('scene:主场景'), 'crowded segment keeps scene soft floor');
  assert(names.includes('character:角色5'), 'close-up character survives crowded budget');
  assert(names.includes('prop:混沌钟'), 'close-up prop survives crowded budget');
  assert(
    names.indexOf('character:角色5') < names.indexOf('character:角色1'),
    'close-up character outranks first wide-shot character in crowded segment',
  );
  assert(
    names.indexOf('prop:混沌钟') < names.indexOf('prop:长剑'),
    'close-up prop outranks background prop in crowded segment',
  );
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

async function testUnresolvableFirstFrameSkipped() {
  const project = makeProject({ characterCount: 1, propCount: 0, includeScene: true });
  const firstFrameUrl = img('missing-first-frame');
  const pathMap = makePathMap(urlsForProject(project, null));
  const mod = makeLoader(pathMap, {});
  const result = mod.buildVideoReferenceManifest({
    project,
    assets: project.assets,
    shots: project.shots,
    groupShotIndices: [0],
    groupIdx: 0,
    ownerId: 7,
    storyboardImageUrl: firstFrameUrl,
  });
  assert(!result.manifest.some((ref) => ref.role === 'first_frame'), 'unresolvable first frame should not enter manifest');
  assertEqual(result.manifest[0].imageNo, 1, 'imageNo starts at 1 for the first resolvable reference');
  assert(result.manifest[0].role === 'scene' || result.manifest[0].role === 'character', 'next resolvable reference is promoted');
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

async function testPropShortNameMatchesCanonicalAsset() {
  const project = makeProject({ characterCount: 1, propCount: 1, includeScene: true });
  project.assets.props = [
    {
      id: 'prop-lingxi-screen',
      name: '移动灵犀屏',
      imageUrl: img('lingxi-screen'),
      description: 'black narrow-bezel smart display with pale support stand',
    },
  ];
  project.shots[0].visual = '角色1 看向桌上的灵犀屏，屏幕亮起柔和冷光';
  project.shots[0].description = '';
  project.shots[0].dialogue = '';
  project.shots[0].characters = ['角色1'];

  const result = build(project, img('first-frame'));
  assert(
    result.manifest.some((ref) => ref.role === 'prop' && ref.assetName === '移动灵犀屏'),
    'short mention 灵犀屏 should match canonical prop 移动灵犀屏',
  );
  const propLine = result.manifest.find((ref) => ref.role === 'prop' && ref.assetName === '移动灵犀屏')?.referenceBrief || '';
  assert(propLine.includes('同一件单实例道具'), 'prop reference brief should lock single-instance identity');
}

async function testPropTopViewSelectedForOverheadVideoReference() {
  const project = makeProject({ characterCount: 1, propCount: 1, includeScene: true });
  project.assets.props = [{
    id: 'prop-lantern',
    name: '灯盏',
    imageUrl: img('prop-lantern-front'),
    description: 'bronze lantern with cracked glass',
    views: {
      front: { role: 'front', imageUrl: img('prop-lantern-front') },
      top: { role: 'top', imageUrl: img('prop-lantern-top') },
    },
  }];
  project.shots[0].angle = '俯拍';
  project.shots[0].visual = '角色1 俯拍检查桌上的灯盏';
  project.shots[0].description = '';
  project.shots[0].dialogue = '';
  project.shots[0].characters = ['角色1'];

  const result = build(project, img('first-frame'));
  const propRef = result.manifest.find((ref) => ref.role === 'prop' && ref.assetName === '灯盏');
  assert(propRef, 'lantern prop reference should be selected');
  assertEqual(propRef.url, img('prop-lantern-top'), 'overhead video reference should use top prop view');
  assertEqual(propRef.propViewRole, 'top', 'manifest carries propViewRole=top');
  assertEqual(propRef.panelInfo?.panel, 'top', 'panelInfo carries selected prop view');
  assert((propRef.referenceBrief || '').includes('top视图'), 'reference brief names selected prop view');
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

async function testGroupShotIndicesScopeFullShotsInput() {
  const state = {};
  const project = makeProject({ characterCount: 2, propCount: 2, includeScene: false });
  project.shots = [
    {
      visual: '角色1 拿起 道具1',
      description: '',
      dialogue: '',
      characters: ['角色1'],
    },
    {
      visual: '角色2 拿起 道具2',
      description: '',
      dialogue: '',
      characters: ['角色2'],
    },
  ];

  const result = build(project, img('first-frame'), state, {
    shots: project.shots,
    groupShotIndices: [1],
    groupIdx: 1,
  });

  assertEqual(state.lastPanelOptions.shots.map((shot) => shot.characters), [['角色2']], 'panel selector receives only scoped shot');
  assertEqual(
    result.manifest.map((ref) => `${ref.role}:${ref.assetName}`),
    ['first_frame:first frame', 'character:角色2', 'prop:道具2'],
    'full shots input is scoped by groupShotIndices',
  );
  assert(!result.manifest.some((ref) => ref.assetName === '角色1' || ref.assetName === '道具1'), 'other shots do not leak into current group');
}

function imageNumberMapping(result) {
  return result.manifest.map((ref) => [
    ref.imageNo,
    ref.assetId || `${ref.role}:${ref.url || ref.assetName || ''}`,
  ]);
}

async function testGenerateAndSubmitManifestMappingsStayAligned() {
  const project = makeProject({ characterCount: 2, propCount: 2, includeScene: false });
  project.shots = [
    {
      visual: '角色1 拿起 道具1',
      description: '',
      dialogue: '',
      characters: ['角色1'],
    },
    {
      visual: '角色2 拿起 道具2',
      description: '',
      dialogue: '',
      characters: ['角色2'],
    },
  ];
  const firstFrameUrl = img('first-frame');
  const pathMap = makePathMap(urlsForProject(project, firstFrameUrl));
  const mod = makeLoader(pathMap, {});

  const generateSide = mod.buildVideoReferenceManifest({
    project,
    assets: project.assets,
    shots: project.shots,
    groupShotIndices: [1],
    groupIdx: 1,
    ownerId: 7,
    storyboardImageUrl: firstFrameUrl,
  });
  const submitSide = mod.buildVideoReferenceManifest({
    project,
    assets: project.assets || {},
    shots: project.shots,
    groupShotIndices: [1],
    groupIdx: 1,
    ownerId: 7,
    storyboardImageUrl: firstFrameUrl,
  });

  assertEqual(
    imageNumberMapping(generateSide),
    imageNumberMapping(submitSide),
    'generate-side and submit-side Image N to asset mapping stay aligned for the same project group',
  );
  assert(
    generateSide.manifest.some((ref) => ref.imageNo === 2 && ref.assetId === 'char-2'),
    'group 2 character keeps the same Image number',
  );
  assert(
    generateSide.manifest.some((ref) => ref.imageNo === 3 && ref.assetId === 'prop-2'),
    'group 2 prop keeps the same Image number',
  );
}

async function testStoryboardMaterialGroupReferences() {
  const project = makeProject({ characterCount: 0, propCount: 0, includeScene: false });
  project.shots[0] = {
    visual: '无明确素材名的镜头',
    description: '',
    dialogue: '',
    characters: [],
  };
  project.assets.scenes = [{
    id: 'manual-scene',
    name: '手动场景',
    imageUrl: img('manual-scene'),
    storyboardMaterialRole: 'scene',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-scene') },
  }];
  project.assets.characters = [{
    id: 'manual-char',
    name: '手动角色',
    imageUrl: img('manual-char'),
    storyboardMaterialRole: 'character',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-char') },
  }];
  project.assets.props = [{
    id: 'manual-prop',
    name: '手动道具',
    imageUrl: img('manual-prop'),
    storyboardMaterialRole: 'prop',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-prop') },
  }, {
    id: 'missing-prop',
    name: '缺失道具',
    imageUrl: img('missing-prop'),
    storyboardMaterialRole: 'prop',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'missing', currentUrl: img('missing-prop') },
  }];

  const result = build(project, img('first-frame'));
  assertEqual(
    result.manifest.map((ref) => `${ref.role}:${ref.assetName}`),
    ['first_frame:first frame', 'scene:手动场景', 'character:手动角色', 'prop:手动道具'],
    'manual storyboard materials are selected by group role even without text mention',
  );
  assert(!result.manifest.some((ref) => ref.assetName === '缺失道具'), 'missing storyboard material is not selected');
}

async function testStoryboardMaterialExclusions() {
  const project = makeProject({ characterCount: 0, propCount: 0, includeScene: false });
  project.shots[0] = {
    visual: '无明确素材名的镜头',
    description: '',
    dialogue: '',
    characters: [],
  };
  project.assets.scenes = [{
    id: 'manual-scene',
    name: '手动场景',
    imageUrl: img('manual-scene'),
    storyboardMaterialRole: 'scene',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-scene') },
  }];
  project.assets.characters = [{
    id: 'manual-char',
    name: '手动角色',
    imageUrl: img('manual-char'),
    storyboardMaterialRole: 'character',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-char') },
  }];
  project.assets.props = [{
    id: 'manual-prop',
    name: '手动道具',
    imageUrl: img('manual-prop'),
    storyboardMaterialRole: 'prop',
    storyboardMaterialGroupIdx: 0,
    reference: { status: 'ready', currentUrl: img('manual-prop') },
  }];
  project.storyboardMaterialExclusions = {
    0: {
      scene: { 'scene:manual-scene': { key: 'scene:manual-scene' } },
      char: { 'char:manual-char': { key: 'char:manual-char' } },
      prop: { 'prop:manual-prop': { key: 'prop:manual-prop' } },
    },
  };

  const result = build(project, img('first-frame'));
  assertEqual(
    result.manifest.map((ref) => `${ref.role}:${ref.assetName}`),
    ['first_frame:first frame'],
    'excluded storyboard materials are not selected by video manifest',
  );
}

async function testReferenceBriefExplainsCharacterSheetHeadshotPair() {
  const { buildReferenceManifestPromptBlock } = loadVideoReferenceManifest();
  const refs = [
    {
      imageNo: 3,
      role: 'character',
      assetName: '萧云',
      label: '萧云 character reference (sheet)',
      url: img('xiao-sheet'),
      useFor: [],
      immutable: [],
      panelInfo: { panel: 'sheet', intent: 'face' },
    },
    {
      imageNo: 4,
      role: 'character',
      assetName: '萧云',
      label: '萧云 character reference (headshot)',
      url: img('xiao-headshot'),
      useFor: [],
      immutable: [],
      panelInfo: { panel: 'headshot', intent: 'face' },
    },
  ];
  const block = buildReferenceManifestPromptBlock(refs);
  assert(block.includes('四个视图都是萧云'), 'sheet brief says all views are the same character');
  assert(block.includes('不是四个人'), 'sheet brief forbids treating sheet as four people');
  assert(block.includes('不是分镜'), 'sheet brief forbids treating sheet as storyboard panels');
  assert(block.includes('不作为构图'), 'sheet brief forbids using sheet as composition');
  assert(block.includes('近景脸以 Image 4 为主'), 'sheet brief points close-up face to headshot image');
  assert(block.includes('萧云脸部近景主参考'), 'headshot brief names the face close-up purpose');
  assert(block.includes('与 Image 3 是同一人'), 'headshot brief links back to sheet image');
}

async function testSeedanceReferenceBlockRenumbersSheetHeadshotPair() {
  const { buildIndependentReferencePromptBlock } = loadVideoPromptRuntime();
  const block = buildIndependentReferencePromptBlock([
    {
      role: 'character',
      path: '/tmp/xiao-sheet.png',
      label: '萧云 character reference (sheet)',
      assetName: '萧云',
      panelInfo: { panel: 'sheet', intent: 'face' },
    },
    {
      role: 'character',
      path: '/tmp/xiao-headshot.png',
      label: '萧云 character reference (headshot)',
      assetName: '萧云',
      panelInfo: { panel: 'headshot', intent: 'face' },
    },
  ]);
  assert(block.includes('Image 1 | character | 萧云 sheet'), 'runtime starts sheet at final Image 1');
  assert(block.includes('近景脸以 Image 2 为主'), 'runtime sheet line points to renumbered headshot');
  assert(block.includes('Image 2 | character | 萧云 headshot'), 'runtime emits headshot as final Image 2');
  assert(block.includes('与 Image 1 是同一人'), 'runtime headshot line points to renumbered sheet');
  assert(block.includes('如果下方可编辑正文里的 Image 编号与本块冲突'), 'runtime tells model to ignore stale editable-body Image bindings');
  assert(block.includes('当前角色绑定：萧云=Image 1 角色设定 + Image 2 脸部近景。'), 'runtime emits merged current character binding');
}

async function testVisibleBindingMergesSameCharacterPanels() {
  const { buildReferenceBindingSummary } = loadPromptsModule();
  const summary = buildReferenceBindingSummary([
    {
      imageNo: 1,
      role: 'first_frame',
      assetName: 'first frame',
      label: 'segment first frame',
      url: img('first-frame'),
      useFor: [],
      immutable: [],
    },
    {
      imageNo: 3,
      role: 'scene',
      viewRole: 'establishing',
      assetName: '雨夜大厅',
      label: '雨夜大厅 establishing scene reference',
      url: img('scene-establishing'),
      useFor: [],
      immutable: [],
    },
    {
      imageNo: 4,
      role: 'scene',
      viewRole: 'topdown',
      assetName: '雨夜大厅',
      label: '雨夜大厅 topdown layout anchor',
      url: img('scene-topdown'),
      useFor: [],
      immutable: [],
    },
    {
      imageNo: 5,
      role: 'character',
      assetName: '萧云',
      label: '萧云 character reference (sheet)',
      url: img('xiao-sheet'),
      useFor: [],
      immutable: [],
      panelInfo: { panel: 'sheet', intent: 'face' },
    },
    {
      imageNo: 6,
      role: 'character',
      assetName: '萧云',
      label: '萧云 character reference (headshot)',
      url: img('xiao-headshot'),
      useFor: [],
      immutable: [],
      panelInfo: { panel: 'headshot', intent: 'face' },
    },
  ]);
  assert(summary.includes('萧云（Image 5 角色设定，Image 6 脸部近景）'), 'visible binding merges sheet/headshot for the same character');
  assert(!summary.includes('萧云（Image 5 角色设定）；萧云（Image 6 脸部近景）'), 'visible binding does not split same character panels into duplicate roles');
  assert(summary.includes('雨夜大厅（Image 4 俯视空间锚）'), 'visible binding labels topdown scene as layout anchor');
}

async function run() {
  const tests = [
    ['dynamic priority chain', testDynamicPriorityChain],
    ['scene topdown anchor survives selection', testSceneTopdownAnchorSurvivesSelection],
    ['close-up entity boost', testCloseUpEntityBoost],
    ['close-up focus character sheet headshot pair', testCloseUpFocusCharacterGetsSheetHeadshotPair],
    ['crowded segment close-up ordering', testCrowdedSegmentCloseUpOrdering],
    ['missing scene compacts image numbers', testMissingSceneCompactsImageNumbers],
    ['unresolvable first frame skipped', testUnresolvableFirstFrameSkipped],
    ['three characters no props keeps third character', testThreeCharactersNoPropsKeepsThirdCharacter],
    ['duplicate character only once', testDuplicateCharacterOnlyOnce],
    ['prop sort uses mentions then text order', testPropSortUsesMentionsThenTextOrder],
    ['prop short name matches canonical asset', testPropShortNameMatchesCanonicalAsset],
    ['prop top view selected for overhead video reference', testPropTopViewSelectedForOverheadVideoReference],
    ['asset missing reason', testAssetMissingReason],
    ['groupShotIndices scopes full shots input', testGroupShotIndicesScopeFullShotsInput],
    ['generate and submit manifest mappings stay aligned', testGenerateAndSubmitManifestMappingsStayAligned],
    ['storyboard material group references', testStoryboardMaterialGroupReferences],
    ['storyboard material exclusions', testStoryboardMaterialExclusions],
    ['reference brief explains character sheet headshot pair', testReferenceBriefExplainsCharacterSheetHeadshotPair],
    ['seedance reference block renumbers sheet headshot pair', testSeedanceReferenceBlockRenumbersSheetHeadshotPair],
    ['visible binding merges same character panels', testVisibleBindingMergesSameCharacterPanels],
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
