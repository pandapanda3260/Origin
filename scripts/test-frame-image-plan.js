/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 测试 lib/frame-image-plan.ts 的当前行为:
 *   - buildFrameImageGenerationPlan 对 first_frame / tail_frame 都产出稳定结构;
 *   - referenceManifest 的 slot 是候选序号 (含所有候选), imageNo 是实际提交图片
 *     的 1-based 连续编号 (仅 delivery='image' 才有), 与 renderer 里 "Image N"
 *     和 image[] 数组下标严格对齐;
 *   - multiRefImageCap 控制有多少候选走 image, 其余走 text_only 兜底;
 *   - finalPrompt 含固定结构段（任务/画面目标/主镜头/构图规则/
 *     参考图/锁定段/硬性禁止等），不再渲染上下文镜头、用户原文约束、
 *     世界观硬事实或历史漂移防护段；相同输入 promptHash 一致;
 *   - tail_frame: primaryShot = 组内最末 shot, selfFirstFrame 作为 slot 1 锚点;
 *   - shotConstraintText 覆盖 visual/description/desc/dialogue/scriptRef/keyInfo/
 *     imagePrompt 字段供审计/计划使用，但不再进入 finalPrompt 的用户约束区;
 *   - 未知 frameType 抛错。
 *
 * 约定与其它 test:xxx 脚本一致, 用 ts.transpileModule + vm.runInNewContext 注入依赖。
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
        resolveJsonModule: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadContentSanitize() {
  const compiled = compileTs('lib/content-sanitize.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    compiled.code,
    { require, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function makeCharacterConsistencyStub() {
  return {
    ensureProjectConsistency: (project) => ({
      ...project,
      consistency: { characters: [] },
    }),
    renderCharacterLockRosterLine: () => '',
  };
}

function loadFramePromptHelpers({ contentSanitize, characterConsistency }) {
  const compiled = compileTs('lib/frame-prompt-helpers.ts');
  const moduleObj = { exports: {} };
	  function localRequire(id) {
	    if (id === './content-sanitize') return contentSanitize;
	    if (id === './character-consistency') return characterConsistency;
	    if (id === './character-lock-authority') {
	      return {
	        buildAssetAuthoritativeCharacterLock: () => null,
	        resolveCharacterAssetForEntity: () => null,
	      };
	    }
	    if (id === './crowd-character') {
	      return {
	        isAnonymousCrowdAsset: (asset) => {
	          if (!asset) return false;
	          if (Object.prototype.hasOwnProperty.call(asset, 'isCrowd')) return asset.isCrowd === true;
	          return /群像|人群|群众|群演|路人|背景人|crowd|extras|background people|group/i.test([
	            asset.name,
	            asset.role,
	            asset.identity,
	            asset.description,
	            asset.appearance,
	            asset.category,
	            asset.tags,
	            asset.crowdSize,
	          ].flat().filter(Boolean).join(' '));
	        },
	        isLegacyCrowdText: (value) => /群像|人群|群众|群演|路人|背景人|crowd|extras|background people|group/i.test(String(value || '')),
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

function makeImageGenStub(localPathByUrl) {
  return {
    resolveLocalImagePath: (url) => (localPathByUrl && localPathByUrl[url]) || null,
  };
}

function makeSceneSelectionStub(sceneToReturn) {
  return {
    pickSceneForShots: () => ({
      scene: sceneToReturn || null,
      matchReason: sceneToReturn ? 'sceneName' : 'none',
    }),
  };
}

function makePanelSelectionStub(imageGen) {
  const textForShots = (shots) => shots.map((shot) => [
    shot && shot.visual,
    shot && shot.description,
    shot && Array.isArray(shot.characters) ? shot.characters.join(' ') : '',
  ].filter(Boolean).join(' ')).join(' ');
  return {
    selectCharacterReferencePanels: (opts) => {
      const shots = Array.isArray(opts.shots) ? opts.shots : [];
      const text = textForShots(shots);
      const chars = [
        ...((opts.project && opts.project.assets && opts.project.assets.characters) || []),
        ...((opts.project && opts.project.characters) || []),
      ].slice().sort((a, b) => {
        const an = String(a.name || a.role || '').trim();
        const bn = String(b.name || b.role || '').trim();
        const ai = text.indexOf(an);
        const bi = text.indexOf(bn);
        return (ai < 0 ? 10000 : ai) - (bi < 0 ? 10000 : bi);
      });
      const out = [];
      for (const ch of chars) {
        const name = String(ch.name || ch.role || '').trim();
        if (!name || (!text.includes(name) && !ch.storyboardMaterialRole)) continue;
        const panels = ch.panels || {};
        const panelPairs = opts.mode === 'frame'
          ? [
            ['sheet', panels.sheetUrl || ch.imageUrl || ch.rawUrl],
            ['headshot', panels.headshotUrl],
            ['front', panels.frontUrl],
          ]
          : [['sheet', panels.sheetUrl || ch.imageUrl || ch.rawUrl]];
        for (const [panel, url] of panelPairs) {
          const path = url && imageGen.resolveLocalImagePath(url, opts.ownerId);
          if (!path) continue;
          out.push({
            assetId: ch.characterId || ch.id || name,
            characterName: name,
            panel,
            entityType: ch.entityType || 'human',
            url,
            path,
            intent: 'body',
            priority: 1,
            reason: `test:${panel}`,
          });
          if (out.length >= (opts.maxSlots || 4)) return out;
        }
      }
      return out;
    },
  };
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

function loadFrameImagePlan({
  contentSanitize,
  characterConsistency,
  imageGen,
  sceneSelection,
  frameHelpers,
  referenceRoles,
}) {
  const compiled = compileTs('lib/frame-image-plan.ts');
  const moduleObj = { exports: {} };
  function localRequire(id) {
    if (id === './content-sanitize') return contentSanitize;
    if (id === './character-consistency') return characterConsistency;
	    if (id === './image-gen') return imageGen;
	    if (id === './panel-selection') return makePanelSelectionStub(imageGen);
    if (id === './scene-selection') return sceneSelection;
	    if (id === './frame-prompt-helpers') return frameHelpers;
		    if (id === './reference-roles') return referenceRoles;
    if (id === './crowd-character') {
      return {
        isAnonymousCrowdAsset: (asset) => {
          if (!asset) return false;
          if (Object.prototype.hasOwnProperty.call(asset, 'isCrowd')) return asset.isCrowd === true;
          return /群像|人群|群众|群演|路人|背景人|crowd|extras|background people|group/i.test([
            asset.name,
            asset.role,
            asset.identity,
            asset.description,
            asset.appearance,
            asset.category,
            asset.tags,
            asset.crowdSize,
          ].flat().filter(Boolean).join(' '));
        },
      };
    }
    if (id === './project-dependency-state') {
      return {
        computeWorldHash: (project) => JSON.stringify({
          selectedWorldTemplateId: project && project.selectedWorldTemplateId || '',
          worldTemplateSnapshot: project && project.worldTemplateSnapshot || null,
        }),
      };
    }
    if (id === './world-template-context') {
      return {
        projectWorldContextForStage: (_stage, snapshot) => {
          if (!snapshot) return undefined;
          return {
            worldRules: snapshot.worldRules || [],
            forbiddenRules: snapshot.forbiddenRules || [],
            terminology: snapshot.terminology || undefined,
          };
        },
        formatWorldContextForPrompt: (ctx) => {
          if (!ctx) return '';
          const parts = [];
          if (ctx.worldRules && ctx.worldRules.length) parts.push(`世界规则：${ctx.worldRules.join('；')}`);
          if (ctx.forbiddenRules && ctx.forbiddenRules.length) parts.push(`世界观禁忌：${ctx.forbiddenRules.join('；')}`);
          if (ctx.terminology && Object.keys(ctx.terminology).length) parts.push(`术语/称谓：${JSON.stringify(ctx.terminology)}`);
          return parts.join('\n');
        },
      };
    }
		    if (id === './shot-plan-normalize') {
	      return {
	        resolveShotFieldsForPrompt: (shot) => ({
	          shotType: shot?.shotType || shot?.framing || '中景',
	          framing: shot?.shotType || shot?.framing || '中景',
	          angle: shot?.angle || (shot?.shotType === '俯拍' ? '俯拍' : '平视'),
	          lens: shot?.lens || '标准50',
	          focus: shot?.focus || '中等景深',
	          light: shot?.light || '侧光·柔光·中性·低反差',
	          composition: shot?.composition || '三分法',
	          camera: shot?.camera || shot?.movement || '固定镜头',
	          movement: shot?.camera || shot?.movement || '固定镜头',
	        }),
	      };
	    }
	    if (id === './visual-reference-state') {
      return {
        resolveAssetReferenceState: (asset) => ({
          currentUrl: asset?.reference?.currentUrl || asset?.imageUrl || asset?.rawUrl || '',
          lastKnownGoodUrl: asset?.reference?.lastKnownGoodUrl || '',
          status: asset?.reference?.status || (asset?.reference?.currentUrl || asset?.imageUrl || asset?.rawUrl ? 'ready' : 'missing'),
          effectiveDescription: asset?.description || asset?.features || asset?.appearance || '',
        }),
        isBlockingReferenceStatus: (status) => status === 'missing' || status === 'failed' || status === 'legacy_sketch_only',
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
        return ref.currentUrl || ref.lastKnownGoodUrl || scene.imageUrl || scene.rawUrl || scene.pencilUrl || scene.realPhotoUrl || scene.coverUrl || '';
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
    return require(id);
  }
  vm.runInNewContext(
    compiled.code,
    { require: localRequire, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function loadAll({ imageGen, sceneSelection, characterConsistency }) {
  const contentSanitize = loadContentSanitize();
  const cc = characterConsistency || makeCharacterConsistencyStub();
  const frameHelpers = loadFramePromptHelpers({ contentSanitize, characterConsistency: cc });
  const referenceRoles = loadReferenceRoles();
  return loadFrameImagePlan({
    contentSanitize,
    characterConsistency: cc,
    imageGen,
    sceneSelection,
    frameHelpers,
    referenceRoles,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assert failed: ${message}\n  actual:   ${a}\n  expected: ${e}`);
}

// ---------- fixtures ----------

function makeFixtureProject() {
  return {
    id: 'proj-1',
    styleOptions: {
      aspectRatio: '9:16',
    },
    styleBible: {
      visualStyle: 'gritty noir',
      colorPalette: 'teal + amber',
      mood: 'tense',
      lighting: 'low-key rim light',
      compositionGuidance: 'Keep the detective framed in a vertical portrait composition.',
    },
    selectedWorldTemplateId: 'world-noir-city',
    worldTemplateSnapshot: {
      id: 'world-noir-city',
      worldRules: ['The city gate must stay closed at night'],
      forbiddenRules: ['Never show magic resurrection'],
      terminology: { Gatekeeper: 'licensed night guard' },
    },
    shots: [
      {
        idx: 1,
        shotType: 'wide',
        camera: 'dolly in',
        visual: 'Alice stands at the doorway, rain pouring behind her',
        dialogue: '——',
        characters: ['Alice'],
      },
      {
        idx: 2,
        shotType: 'close-up',
        camera: 'static',
        visual: 'Alice clutches the lantern tightly',
        dialogue: 'Alice: I will not turn back.',
        characters: ['Alice'],
      },
    ],
    assets: {
      characters: [
        {
          characterId: 'c-alice',
          name: 'Alice',
          identity: 'detective',
          appearance: 'dark hair, green eyes',
          clothing: 'trench coat',
          imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000a1',
        },
      ],
      props: [
        {
          propId: 'p-lantern',
          name: 'lantern',
          description: 'brass oil lantern with cracked glass',
          imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000b1',
        },
      ],
    },
  };
}

function makeFixtureScene() {
  return {
    id: 's-doorway',
    name: 'Rainy Doorway',
    location: 'old tenement doorway',
    description: 'narrow stone doorway under driving rain',
    lighting: 'cold street lamp',
    atmosphere: 'ominous',
    imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000c1',
  };
}

function makeQualityPackProject() {
  const propNames = ['lantern', 'map', 'coin', 'sword', 'cup', 'key', 'orb'];
  return {
    id: 'proj-quality-pack',
    styleBible: {
      visualStyle: 'premium cinematic realism',
      colorPalette: 'deep red and gold',
      mood: 'ceremonial tension',
    },
    shots: [
      {
        idx: 1,
        shotType: 'medium',
        camera: 'slow push',
        visual: 'Bob raises the orb while Alice watches; Charlie waits near the lantern, map, coin, sword, cup, and key.',
        imagePrompt: 'Bob must hold the glowing orb in the foreground.',
        dialogue: 'Bob: Keep the orb safe.',
        characters: ['Bob', 'Alice'],
      },
      {
        idx: 2,
        shotType: 'wide',
        camera: 'pan left',
        visual: 'Alice and Charlie move behind Bob as the lantern and map remain visible.',
        dialogue: 'Alice: Charlie, guard the map.',
        characters: ['Alice', 'Charlie'],
      },
    ],
    assets: {
      characters: [
        {
          characterId: 'c-alice',
          name: 'Alice',
          identity: 'strategist',
          appearance: 'silver hair',
          clothing: 'blue robe',
          imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000101',
        },
        {
          characterId: 'c-bob',
          name: 'Bob',
          identity: 'guardian',
          appearance: 'broad shoulders',
          clothing: 'red armor',
          imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000102',
        },
        {
          characterId: 'c-charlie',
          name: 'Charlie',
          identity: 'scout',
          appearance: 'short black hair',
          clothing: 'green cloak',
          imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000103',
        },
      ],
      props: propNames.map((name, idx) => ({
        propId: `p-${name}`,
        name,
        description: `${name} reference prop`,
        imageUrl: `/api/images/file/00000000-0000-0000-0000-00000000020${idx + 1}`,
      })),
    },
  };
}

function makeQualityPackScene() {
  return {
    id: 's-hall',
    name: 'Rainy Hall',
    location: 'ceremonial stone hall',
    description: 'wet stone floor, tall pillars, red banners',
    lighting: 'golden overhead lamps',
    imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000301',
  };
}

const MODEL_SNAPSHOT_CAP1 = {
  provider: 'zerail_images',
  model: 'doubao-seedream-4-5',
  baseUrl: 'https://example.test',
  quality: 'medium',
  multiRefImageCap: 1,
};

// ---------- tests ----------

async function testFirstFrameFullyResolved() {
  const scene = makeFixtureScene();
  const imageGen = makeImageGenStub({
    [scene.imageUrl]: '/local/scene.png',
    '/api/images/file/00000000-0000-0000-0000-0000000000a1': '/local/alice.png',
    '/api/images/file/00000000-0000-0000-0000-0000000000b1': '/local/lantern.png',
  });
  const mod = loadAll({ imageGen, sceneSelection: makeSceneSelectionStub(scene) });

  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });

  assertEqual(plan.primaryShotIdx, 0, 'primaryShotIdx should be first of shotIndices');
  assert(plan.contextShots.length === 1, 'contextShots should be shotIndices[1:]');
  assertEqual(
    plan.characters.map((c) => c.name),
    ['Alice'],
    'Alice should be picked as used character',
  );
  assert(plan.scene && plan.scene.name === 'Rainy Doorway', 'scene picked');
  assertEqual(plan.props.map((p) => p.name), ['lantern'], 'lantern picked');

  // manifest: character (slot 1) → scene (slot 2) → prop (slot 3), 角色一致性优先
  const roles = plan.referenceManifest.map((r) => r.role);
  assertEqual(roles, ['character', 'scene', 'prop'], 'manifest order');
  const slots = plan.referenceManifest.map((r) => r.slot);
  assertEqual(slots, [1, 2, 3], 'manifest slot is 1-based contiguous');

  // cap=1: 只有第一个 ref 走 image, 其余 text_only (over_capacity)
  const deliveries = plan.referenceManifest.map((r) => r.delivery);
  assertEqual(deliveries, ['image', 'text_only', 'text_only'], 'cap=1 delivery pattern');
  const reasons = plan.referenceManifest.map((r) => r.droppedReason || null);
  assertEqual(reasons, [null, 'over_capacity', 'over_capacity'], 'droppedReason pattern');
  assertEqual(plan.referenceManifest[0].localPath, '/local/alice.png', 'character localPath resolved');

  // finalPrompt 必含核心生成段和锁定段; 不再包含上下文/原文/世界观/漂移段。
  const p = plan.finalPrompt;
	  for (const marker of [
    '【任务】',
    '【画面目标】',
    '【主镜头】',
    '【参考图】',
    '【构图规则】',
    '【硬性禁止】',
    '【项目风格锁定】',
  ]) {
    assert(p.includes(marker), `finalPrompt should contain ${marker}`);
  }
  for (const marker of [
    '【上下文镜头】',
    '【用户原文约束】',
    '【世界观硬事实】',
    'OBSERVED DRIFT GUARDRAILS',
  ]) {
    assert(!p.includes(marker), `finalPrompt should not contain ${marker}`);
  }
  // reference 描述中应点名 character 的 assetName
  assert(p.includes('Image 1 = 角色'), 'Image 1 = 角色 line present');
  assert(!p.includes('Image 2 = 场景'), 'scene slot is over_capacity so not shown as Image 2');
  assert(p.includes('目标画幅比例：9:16'), 'prompt should include target aspect ratio');
  assert(!p.includes('The city gate must stay closed at night'), 'prompt should not render projected world rule');
  assert(plan.worldHash.includes('world-noir-city'), 'plan records world hash input');
  // 顺序要求(用户): 前三段为 任务 → 画面目标 → 构图规则, 且都排在主镜头之前。
  assert(p.indexOf('【任务】') < p.indexOf('【画面目标】'), '任务 应在画面目标之前');
  assert(p.indexOf('【画面目标】') < p.indexOf('【构图规则】'), '画面目标 应在构图规则之前');
  assert(p.indexOf('【构图规则】') < p.indexOf('【主镜头】'), '构图规则 应在主镜头之前');

  // summary
  const summary = mod.summarizePlanForAudit(plan);
  assert(summary.worldHash.includes('world-noir-city'), 'summary records world hash');
  assertEqual(summary.aspectRatio, '9:16', 'summary aspect ratio');
  assertEqual(summary.sentReferences.length, 1, 'summary sent = 1');
  assertEqual(summary.textOnlyReferences.length, 2, 'summary text_only = 2');
  assertEqual(summary.droppedReferences.length, 0, 'summary dropped = 0');
  assert(typeof summary.finalPromptHash === 'string' && summary.finalPromptHash.length === 64, 'hash is sha256');
}

async function testDegradedCharacterReferenceStillUsable() {
  const scene = makeFixtureScene();
  const project = makeFixtureProject();
  const charUrl = '/api/images/file/00000000-0000-0000-0000-0000000000a1';
  project.assets.characters[0].reference = {
    status: 'degraded',
    currentUrl: charUrl,
    lastKnownGoodUrl: charUrl,
  };
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [charUrl]: '/local/alice.png',
      [scene.imageUrl]: '/local/scene.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000b1': '/local/lantern.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  const characterRef = plan.referenceManifest.find((r) => r.role === 'character');
  assert(characterRef, 'character ref should be present');
  assertEqual(characterRef.delivery, 'image', 'degraded character reference remains image-usable');
  assertEqual(characterRef.localPath, '/local/alice.png', 'degraded character localPath resolved');
}

async function testImagePromptPriorityAndBlankFallback() {
  const scene = makeFixtureScene();
  const mod = loadAll({
    imageGen: makeImageGenStub({ [scene.imageUrl]: '/local/scene.png' }),
    sceneSelection: makeSceneSelectionStub(scene),
  });

  const project = makeFixtureProject();
  project.shots[0].imagePrompt = 'User-directed opening frame: Alice raises the brass lantern to eye level.';
  const firstPlan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  assert(
    firstPlan.finalPrompt.includes('- 画面：User-directed opening frame: Alice raises the brass lantern to eye level.'),
    'first_frame primary visual should prefer shot.imagePrompt over shot.visual',
  );

  const blankProject = makeFixtureProject();
  blankProject.shots[0].imagePrompt = '   ';
  const blankPlan = mod.buildFrameImageGenerationPlan({
    project: blankProject,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  assert(
    blankPlan.finalPrompt.includes('- 画面：Alice stands at the doorway, rain pouring behind her'),
    'blank imagePrompt should fall back to shot.visual',
  );

  const tailProject = makeFixtureProject();
  tailProject.shots[1].imagePrompt = 'User-directed closing frame: Alice lowers the lantern beside a soaked warning sign.';
  const tailPlan = mod.buildFrameImageGenerationPlan({
    project: tailProject,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'tail_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  assert(
    tailPlan.finalPrompt.includes('- 画面：User-directed closing frame: Alice lowers the lantern beside a soaked warning sign.'),
    'tail_frame primary visual should prefer shot.imagePrompt over shot.visual',
  );
}

async function testPromptDeterminism() {
  const scene = makeFixtureScene();
  const opts = {
    imageGen: makeImageGenStub({ [scene.imageUrl]: '/local/scene.png' }),
    sceneSelection: makeSceneSelectionStub(scene),
  };
  const modA = loadAll(opts);
  const modB = loadAll(opts);
  const planA = modA.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  const planB = modB.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  const sumA = modA.summarizePlanForAudit(planA);
  const sumB = modB.summarizePlanForAudit(planB);
  assertEqual(sumA.finalPromptHash, sumB.finalPromptHash, 'same input → same prompt hash');
  assertEqual(sumA.sentReferences, sumB.sentReferences, 'same sentReferences');
}

async function testNoImagesAvailable() {
  const imageGen = makeImageGenStub({});
  const mod = loadAll({ imageGen, sceneSelection: makeSceneSelectionStub(null) });

  const project = makeFixtureProject();
  // 去掉角色/道具的 imageUrl, 模拟 "只有文字资产"
  project.assets.characters[0].imageUrl = undefined;
  project.assets.props[0].imageUrl = undefined;

  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });

  // 没有 scene → scene candidate 不入 manifest
  const roles = plan.referenceManifest.map((r) => r.role);
  assertEqual(roles, ['character', 'prop'], 'no scene → manifest starts with character');
  const deliveries = plan.referenceManifest.map((r) => r.delivery);
  assertEqual(deliveries, ['text_only', 'text_only'], 'no image available → all text_only');
  const reasons = plan.referenceManifest.map((r) => r.droppedReason);
  assertEqual(reasons, ['no_image_available', 'no_image_available'], 'reason = no_image_available');

  // prompt 不含 【参考图】 段
  assert(!plan.finalPrompt.includes('【参考图】'), 'no image refs → no Reference images section');
  // 但 character lock / prop lock 段仍然存在 (text fallback)
  assert(plan.finalPrompt.includes('【角色锁定】'), 'character lock present as text');
  assert(plan.finalPrompt.includes('【道具锁定】'), 'prop lock present as text');
}

async function testTailFramePlanBasic() {
  const scene = makeFixtureScene();
  const mod = loadAll({
    imageGen: makeImageGenStub({ [scene.imageUrl]: '/local/scene.png' }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'tail_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  // primaryShot = 最末 shot
  assertEqual(plan.primaryShotIdx, 1, 'tail_frame primaryShotIdx should be last of shotIndices');
  assertEqual(plan.contextShotIndices, [0], 'contextShotIndices should be all except primary');
  assert(plan.contextShots.length === 1, 'contextShots.length === 1');
  assert(plan.frameType === 'tail_frame', 'plan.frameType is tail_frame');
  // 没传 selfFirstFrame, 所以 manifest 不应含 self_first_frame
  const roles = plan.referenceManifest.map((r) => r.role);
  assert(!roles.includes('self_first_frame'), 'no selfFirstFrame input → no self_first_frame slot');
  assertEqual(roles[0], 'character', 'without self_first_frame, slot 1 is primary character');
  // prompt 必含尾帧目标; 未传 selfFirstFrame 时应走独立尾帧语义,
  // 不再强制按首帧连续性生成。
  assert(plan.finalPrompt.includes('结束节拍'), 'tail prompt mentions closing beat');
  assert(plan.finalPrompt.includes('【尾帧目标】'), 'tail prompt includes explicit tail frame target');
  assert(plan.finalPrompt.includes('不要求沿用首帧构图'), 'tail prompt uses independent ending-frame wording');
  assert(!plan.finalPrompt.includes('Image 1 / 首帧之后'), 'tail prompt does not force first-frame reference without selfFirstFrame');
  // contextShots 仍保留在 plan 内部供审计/决策使用, 但不再渲染到图像模型 prompt。
  assert(!plan.finalPrompt.includes('【上下文镜头】'), 'tail prompt should not render context shot section');
  assert(!plan.finalPrompt.includes('镜头 1：'), 'tail prompt should not render context shot details');
}

async function testTailFrameWithSelfFirstFrame() {
  const scene = makeFixtureScene();
  const firstFrameUrl = '/api/images/file/00000000-0000-0000-0000-0000000000ff';
  const firstFrameLocal = '/local/this-segment-first.png';
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      [firstFrameUrl]: firstFrameLocal,
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'tail_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
    selfFirstFrame: { remoteUrl: firstFrameUrl, localPath: firstFrameLocal },
  });
  const manifest = plan.referenceManifest;
  // slot 1 强制是 self_first_frame, 且 delivery=image (cap=1 恰好耗在它上面)
  assertEqual(manifest[0].role, 'self_first_frame', 'slot 1 = self_first_frame');
  assertEqual(manifest[0].slot, 1, 'slot 1');
  assertEqual(manifest[0].delivery, 'image', 'self_first_frame consumes the image budget');
  assertEqual(manifest[0].localPath, firstFrameLocal, 'self_first_frame localPath preserved via preResolved path');
  // scene / char / prop 降级 text_only 因为 cap 已用完
  const sceneRef = manifest.find((r) => r.role === 'scene');
  assert(sceneRef && sceneRef.delivery === 'text_only' && sceneRef.droppedReason === 'over_capacity', 'scene falls to text_only due to cap');
  // summary sent 只含 1 项 = self_first_frame
  const summary = mod.summarizePlanForAudit(plan);
  assertEqual(summary.sentReferences.length, 1, 'exactly 1 image sent');
  assertEqual(summary.sentReferences[0].role, 'self_first_frame', 'the sent ref is self_first_frame');
  assertEqual(summary.frameType, 'tail_frame', 'summary frameType');
  // prompt 应描述 Image 1 = 本片段首帧
  assert(plan.finalPrompt.includes('Image 1 = 本片段首帧'), 'prompt labels Image 1 as this segment first frame');
  assert(plan.finalPrompt.includes('不是构图复制目标'), 'self first frame is not treated as a composition copy target');
  assert(plan.finalPrompt.includes('相比 Image 1 必须有可见差异'), 'tail prompt requires visible difference from first frame');
  for (const marker of [
    '【上下文镜头】',
    '【用户原文约束】',
    '【世界观硬事实】',
    'OBSERVED DRIFT GUARDRAILS',
  ]) {
    assert(!plan.finalPrompt.includes(marker), `tail finalPrompt should not contain ${marker}`);
  }
}

async function testShotFieldsPreserveUserConstraints() {
  // shotConstraintText 要覆盖所有用户可能写剧本约束的字段; 在任一字段写
  // 用户约束仍进入 plan 供审计/计划使用, 但不再渲染到 finalPrompt 的用户原文约束区。
  const fields = [
    'visual',
    'description',
    'desc',
    'dialogue',
    'scriptRef',
    'keyInfo',
    'imagePrompt',
  ];
  for (const field of fields) {
    const scene = makeFixtureScene();
    const mod = loadAll({
      imageGen: makeImageGenStub({ [scene.imageUrl]: '/local/scene.png' }),
      sceneSelection: makeSceneSelectionStub(scene),
    });
    const project = makeFixtureProject();
    // 清空所有可被扫描的 shot 字段, 只保留当前被测字段写用户约束,
    // 确保命中的只能来自当前字段而不是 fixture 默认的 visual。
    for (const f of fields) {
      delete project.shots[0][f];
    }
    project.shots[0][field] = '不要补光灯';

    const plan = mod.buildFrameImageGenerationPlan({
      project,
      groupIdx: 0,
      shotIndices: [0, 1],
      ownerId: 42,
      frameType: 'first_frame',
      modelSnapshot: MODEL_SNAPSHOT_CAP1,
    });
    assert(
      plan.shotConstraintText.includes('不要补光灯'),
      `shotConstraintText should preserve the original user constraint from shot.${field}`,
    );
    assert(!plan.finalPrompt.includes('【用户原文约束】'), 'finalPrompt should not render user original constraint section');
    if (field === 'keyInfo') {
      assert(
        !plan.finalPrompt.includes('不要补光灯'),
        'keyInfo-only constraint should not leak into finalPrompt after user original constraint section removal',
      );
    } else {
      assert(
        plan.finalPrompt.includes('不要补光灯'),
        `active primary shot field should still render in finalPrompt for shot.${field}`,
      );
    }
    assert(
      !/硬性负向约束：禁止补光灯/.test(plan.finalPrompt),
      `finalPrompt should not inject fill-light hard constraint for shot.${field}`,
    );
  }
}

async function testFramePromptIncludesStructuredShotFields() {
  const scene = makeFixtureScene();
  const mod = loadAll({
    imageGen: makeImageGenStub({ [scene.imageUrl]: '/local/scene.png' }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const project = makeFixtureProject();
  project.shots[0] = {
    ...project.shots[0],
    shotType: '近景',
    angle: '过肩',
    lens: '中长焦85',
    focus: '浅景深',
    light: '侧逆光·硬光·冷色·高反差',
    composition: '前景框架、视线方向',
    camera: '固定镜头',
  };
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: MODEL_SNAPSHOT_CAP1,
  });
  assert(plan.finalPrompt.includes('角度/视点：过肩'), 'finalPrompt should include angle/viewpoint');
  assert(plan.finalPrompt.includes('焦距：中长焦85'), 'finalPrompt should include lens');
  assert(plan.finalPrompt.includes('景深/焦点：浅景深'), 'finalPrompt should include focus');
  assert(plan.finalPrompt.includes('光线组合：侧逆光·硬光·冷色·高反差'), 'finalPrompt should include light');
  assert(plan.finalPrompt.includes('构图组合：前景框架、视线方向'), 'finalPrompt should include composition');
}

async function testImageNoContinuity() {
  // 验证 slot 和 imageNo 拆分: scene 无图 → text_only 占 slot 1 不占 imageNo,
  // character 和 prop 有图 → imageNo 连续 1, 2 (不是跟着 slot 跳到 2, 3)。
  const scene = makeFixtureScene();
  // scene 故意没有可解析到本地的图
  const charUrl = '/api/images/file/00000000-0000-0000-0000-0000000000a1';
  const propUrl = '/api/images/file/00000000-0000-0000-0000-0000000000b1';
  const mod = loadAll({
    imageGen: makeImageGenStub({
      // 注意: 不 map scene.imageUrl, 模拟 scene 有 remoteUrl 但无法解析本地
      [charUrl]: '/local/alice.png',
      [propUrl]: '/local/lantern.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  // 设 cap=2 让两张图都进 image delivery
  const cap2Snapshot = { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 2 };
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: cap2Snapshot,
  });

  const manifest = plan.referenceManifest;
  // character 先占 slot 1; scene slot 2 因 local 解析失败降级 text_only, 不占 imageNo。
  assertEqual(manifest[0].role, 'character', 'slot 1 = character (by candidate order)');
  assertEqual(manifest[0].slot, 1, 'slot 1');
  assertEqual(manifest[0].delivery, 'image', 'character is image');
  assertEqual(manifest[0].imageNo, 1, 'character imageNo = 1 (first image)');
  assertEqual(manifest[1].role, 'scene', 'slot 2 = scene');
  assertEqual(manifest[1].slot, 2, 'slot 2');
  assertEqual(manifest[1].delivery, 'text_only', 'scene text_only because local unresolvable');
  assert(manifest[1].imageNo === undefined, 'scene (text_only) has no imageNo');
  // prop 是 slot 3, imageNo=2
  assertEqual(manifest[2].role, 'prop', 'slot 3 = prop');
  assertEqual(manifest[2].slot, 3, 'slot 3');
  assertEqual(manifest[2].delivery, 'image', 'prop is image');
  assertEqual(manifest[2].imageNo, 2, 'prop imageNo = 2 (second image)');

  // prompt 的 "Image N" 必须连续从 1 编, 不能跳号
  const p = plan.finalPrompt;
  assert(p.includes('Image 1 = 角色'), 'prompt labels Image 1 = character');
  assert(p.includes('Image 2 = 道具'), 'prompt labels Image 2 = prop');
  assert(!p.includes('Image 3 '), 'no Image 3 should appear (only 2 images sent)');

  // summary 里 sentReferences 带 imageNo
  const summary = mod.summarizePlanForAudit(plan);
  assertEqual(summary.sentReferences.length, 2, '2 images sent');
  assertEqual(summary.sentReferences[0].imageNo, 1, 'summary imageNo 1');
  assertEqual(summary.sentReferences[0].role, 'character', 'first sent = character');
  assertEqual(summary.sentReferences[1].imageNo, 2, 'summary imageNo 2');
  assertEqual(summary.sentReferences[1].role, 'prop', 'second sent = prop');
}

async function testPlanCapThreeAllImages() {
  // cap=3 且 3 个候选 (scene/char/prop) 都有可解析本地图 → 全部 image delivery,
  // imageNo 1/2/3 连续, prompt 含 Image 1/2/3。
  const scene = makeFixtureScene();
  const charUrl = '/api/images/file/00000000-0000-0000-0000-0000000000a1';
  const propUrl = '/api/images/file/00000000-0000-0000-0000-0000000000b1';
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      [charUrl]: '/local/alice.png',
      [propUrl]: '/local/lantern.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const cap3 = { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 3 };
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: cap3,
  });
  const manifest = plan.referenceManifest;
  assertEqual(manifest.length, 3, '3 candidates in manifest');
  assertEqual(manifest.map((r) => r.delivery), ['image', 'image', 'image'], 'all 3 go as image at cap=3');
  assertEqual(manifest.map((r) => r.imageNo), [1, 2, 3], 'imageNo 1/2/3 contiguous');
  assertEqual(manifest.map((r) => r.slot), [1, 2, 3], 'slot 1/2/3 contiguous too');
  for (const marker of ['Image 1 = 角色', 'Image 2 = 场景', 'Image 3 = 道具']) {
    assert(plan.finalPrompt.includes(marker), `prompt should mention ${marker}`);
  }
  const summary = mod.summarizePlanForAudit(plan);
  assertEqual(summary.sentReferences.length, 3, 'summary sent=3');
  assertEqual(summary.sentReferences.map((r) => r.imageNo), [1, 2, 3], 'summary imageNo 1/2/3');
  assertEqual(summary.textOnlyReferences.length, 0, 'nothing falls to text_only when cap accommodates all');
}

async function testPlanCapFiveCandidatesThree() {
  // cap=5 但候选只有 3 个 → 3 个 image delivery + imageNo 1/2/3, 不会凭空占位
  // 多出来的 image slot, 也不会因为 cap>候选而把 text_only 弄错。
  const scene = makeFixtureScene();
  const charUrl = '/api/images/file/00000000-0000-0000-0000-0000000000a1';
  const propUrl = '/api/images/file/00000000-0000-0000-0000-0000000000b1';
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      [charUrl]: '/local/alice.png',
      [propUrl]: '/local/lantern.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const cap5 = { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 5 };
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: cap5,
  });
  const manifest = plan.referenceManifest;
  assertEqual(manifest.length, 3, 'only 3 actual candidates exist');
  assertEqual(manifest.map((r) => r.delivery), ['image', 'image', 'image'], 'all 3 image');
  assertEqual(manifest.map((r) => r.imageNo), [1, 2, 3], 'imageNo max = 3, no phantom 4/5');
  // 提交时调用方 filter delivery==='image' 拿到 3 张, 正好对应 image[] 下标 0/1/2
  const paths = manifest.filter((r) => r.delivery === 'image').map((r) => r.localPath);
  assertEqual(paths.length, 3, '3 local paths');
  assert(paths.every((p) => typeof p === 'string' && p.length > 0), 'all paths resolved');
}

async function testFirstFrameBalancedTwelveImageQualityPack() {
  const project = makeQualityPackProject();
  const scene = makeQualityPackScene();
  const localMap = {
    [scene.imageUrl]: '/local/scene-hall.png',
  };
  for (const ch of project.assets.characters) localMap[ch.imageUrl] = `/local/${ch.name}.png`;
  for (const prop of project.assets.props) localMap[prop.imageUrl] = `/local/${prop.name}.png`;
  const mod = loadAll({
    imageGen: makeImageGenStub(localMap),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 14 },
  });

  const sent = plan.referenceManifest.filter((r) => r.delivery === 'image');
  assert(sent.length <= 12, 'business budget sends no more than 12 refs');
  assert(sent.length > 4, 'raised business budget can send more than the old 4 refs');
  assertEqual(sent.map((r) => r.imageNo), sent.map((_, idx) => idx + 1), 'imageNo is contiguous');
  assert(sent.filter((r) => r.role === 'character').length <= 6, 'character refs stay within max 6');
  assert(sent.filter((r) => r.role !== 'character').length <= 6, 'non-character refs stay within max 6');
  assert(sent.some((r) => r.role === 'scene' && r.assetName === 'Rainy Hall'), 'scene reference survives larger character set');
  assert(sent.filter((r) => r.role === 'prop').length >= 2, 'key props are kept as first-class references');
  assert(sent[0].role === 'character', 'first submitted image remains a character identity anchor');
  assert(sent[1].role === 'scene', 'scene is promoted before secondary character overflow');

  const textOnly = plan.referenceManifest.filter((r) => r.delivery === 'text_only');
  assert(textOnly.every((r) => String(r.textFallback || '').trim().length > 0), 'all text_only refs keep textFallback');
}

async function testManualStoryboardMaterialsFirst() {
  const project = makeFixtureProject();
  project.assets.scenes = [{
    id: 'manual-scene',
    name: 'Manual Scene',
    imageUrl: '/api/images/file/manual-scene',
    storyboardMaterialRole: 'scene',
    storyboardMaterialGroupIdx: 0,
    description: 'manual scene reference',
  }];
  project.assets.characters.push({
    id: 'manual-character',
    name: 'Manual Character',
    imageUrl: '/api/images/file/manual-character',
    storyboardMaterialRole: 'character',
    storyboardMaterialGroupIdx: 0,
    appearance: 'manual character reference',
  });
  project.assets.props.push({
    id: 'manual-prop',
    name: 'Manual Prop',
    imageUrl: '/api/images/file/manual-prop',
    storyboardMaterialRole: 'prop',
    storyboardMaterialGroupIdx: 0,
    description: 'manual prop reference',
  });
  const localMap = {
    '/api/images/file/manual-scene': '/local/manual-scene.png',
    '/api/images/file/manual-character': '/local/manual-character.png',
    '/api/images/file/manual-prop': '/local/manual-prop.png',
    '/api/images/file/00000000-0000-0000-0000-0000000000a1': '/local/alice.png',
    '/api/images/file/00000000-0000-0000-0000-0000000000b1': '/local/lantern.png',
  };
  const mod = loadAll({
    imageGen: makeImageGenStub(localMap),
    sceneSelection: makeSceneSelectionStub(makeFixtureScene()),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 4 },
  });
  const sent = plan.referenceManifest.filter((r) => r.delivery === 'image');
  assertEqual(
    sent.map((r) => `${r.role}:${r.assetName}`),
    [
      'character:Manual Character',
      'scene:Manual Scene',
      'character:Alice',
      'prop:Manual Prop',
    ],
    'manual storyboard materials are prioritized ahead of text fallback candidates',
  );
}

async function testPropShortNameMatchesCanonicalAsset() {
  const project = makeFixtureProject();
  project.shots[0].visual = 'Alice turns toward the 灵犀屏 glowing on the table.';
  project.shots[0].dialogue = '';
  project.assets.props = [{
    propId: 'p-lingxi-screen',
    name: '移动灵犀屏',
    description: 'black narrow-bezel smart display with pale support stand',
    imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000d1',
  }];
  const scene = makeFixtureScene();
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000a1': '/local/alice.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000d1': '/local/lingxi-screen.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 6 },
  });

  assertEqual(plan.props.map((p) => p.name), ['移动灵犀屏'], 'short mention 灵犀屏 should match canonical prop 移动灵犀屏');
  assert(
    plan.referenceManifest.some((r) => r.role === 'prop' && r.assetName === '移动灵犀屏' && r.delivery === 'image'),
    'matched canonical prop should be submitted as image reference',
  );
  assert(plan.finalPrompt.includes('屏幕类道具只能改变屏幕内容/反光/视角'), 'prop lock includes screen-specific continuity rule');
}

async function testPropTopViewSelectedForOverheadFrame() {
  const project = makeFixtureProject();
  project.shots[0].angle = '俯拍';
  project.shots[0].visual = '俯拍看到 Alice 将 lantern 放在桌面中央。';
  project.assets.props = [{
    propId: 'p-lantern',
    name: 'lantern',
    description: 'brass oil lantern with cracked glass',
    imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000b1',
    views: {
      front: { role: 'front', imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000b1' },
      top: { role: 'top', imageUrl: '/api/images/file/00000000-0000-0000-0000-0000000000b2' },
    },
  }];
  const scene = makeFixtureScene();
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000a1': '/local/alice.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000b2': '/local/lantern-top.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project,
    groupIdx: 0,
    shotIndices: [0],
    ownerId: 42,
    frameType: 'first_frame',
    modelSnapshot: { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 6 },
  });
  const propRef = plan.referenceManifest.find((r) => r.role === 'prop' && r.assetName === 'lantern');
  assert(propRef, 'lantern prop reference should be present');
  assertEqual(propRef.remoteUrl, '/api/images/file/00000000-0000-0000-0000-0000000000b2', 'overhead frame should use top prop view');
  assertEqual(propRef.propViewRole, 'top', 'propViewRole should record selected top view');
  assert(plan.finalPrompt.includes('top视图'), 'final prompt should mention selected prop view');
}

async function testTailFrameUnresolvableSelfFirstFrameShiftsImageNo() {
  const scene = makeFixtureScene();
  const firstFrameUrl = '/api/images/file/00000000-0000-0000-0000-0000000000ff';
  const mod = loadAll({
    imageGen: makeImageGenStub({
      [scene.imageUrl]: '/local/scene.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000a1': '/local/alice.png',
      '/api/images/file/00000000-0000-0000-0000-0000000000b1': '/local/lantern.png',
    }),
    sceneSelection: makeSceneSelectionStub(scene),
  });
  const plan = mod.buildFrameImageGenerationPlan({
    project: makeFixtureProject(),
    groupIdx: 0,
    shotIndices: [0, 1],
    ownerId: 42,
    frameType: 'tail_frame',
    modelSnapshot: { ...MODEL_SNAPSHOT_CAP1, multiRefImageCap: 4 },
    selfFirstFrame: { remoteUrl: firstFrameUrl },
  });
  const manifest = plan.referenceManifest;
  assertEqual(manifest[0].role, 'self_first_frame', 'self_first_frame remains slot 1 candidate');
  assertEqual(manifest[0].delivery, 'text_only', 'unresolvable self_first_frame falls back to text_only');
  assert(manifest[0].imageNo === undefined, 'unresolvable self_first_frame does not consume imageNo');
  const sent = manifest.filter((r) => r.delivery === 'image');
  assertEqual(sent[0].role, 'character', 'primary character shifts to Image 1');
  assertEqual(sent[0].imageNo, 1, 'Image 1 is assigned to first real submitted image');
}

async function testTailFrameUnknownTypeRejected() {
  const mod = loadAll({
    imageGen: makeImageGenStub({}),
    sceneSelection: makeSceneSelectionStub(null),
  });
  let thrown;
  try {
    mod.buildFrameImageGenerationPlan({
      project: makeFixtureProject(),
      groupIdx: 0,
      shotIndices: [0, 1],
      ownerId: 42,
      frameType: 'bogus',
      modelSnapshot: MODEL_SNAPSHOT_CAP1,
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown && /unknown frameType/i.test(thrown.message), 'unknown frameType should throw');
}

async function main() {
  const tests = [
    ['first_frame fully-resolved plan', testFirstFrameFullyResolved],
    ['degraded character reference remains usable', testDegradedCharacterReferenceStillUsable],
    ['imagePrompt priority and blank fallback', testImagePromptPriorityAndBlankFallback],
    ['prompt determinism', testPromptDeterminism],
    ['no images available → text_only', testNoImagesAvailable],
	    ['tail_frame plan basic (no self_first_frame)', testTailFramePlanBasic],
	    ['tail_frame with self_first_frame slot 1', testTailFrameWithSelfFirstFrame],
	    ['shot constraint fields preserve user text without fill-light injection', testShotFieldsPreserveUserConstraints],
	    ['frame prompt includes structured shot fields', testFramePromptIncludesStructuredShotFields],
	    ['imageNo continuity when scene skipped', testImageNoContinuity],
    ['plan cap=3 → all 3 candidates as image, imageNo 1/2/3', testPlanCapThreeAllImages],
    ['plan cap=5 candidates=3 → no phantom imageNo beyond 3', testPlanCapFiveCandidatesThree],
	    ['first_frame balanced 12-image quality pack with 6/6 role caps', testFirstFrameBalancedTwelveImageQualityPack],
    ['manual storyboard materials before fallback', testManualStoryboardMaterialsFirst],
    ['prop short name matches canonical asset', testPropShortNameMatchesCanonicalAsset],
    ['prop top view selected for overhead frame', testPropTopViewSelectedForOverheadFrame],
    ['tail_frame unresolvable self_first_frame shifts imageNo', testTailFrameUnresolvableSelfFirstFrameShiftsImageNo],
    ['unknown frameType rejected', testTailFrameUnknownTypeRejected],
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      pass += 1;
    } catch (err) {
      console.error(`FAIL  ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n${pass}/${tests.length} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
