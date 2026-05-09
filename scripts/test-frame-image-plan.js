/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 测试 lib/frame-image-plan.ts 的 P0 行为:
 *   - buildFrameImageGenerationPlan 在 first_frame 下产出稳定结构;
 *   - referenceManifest 的 slot 顺序 = scene → characters → props, 与 renderer 的
 *     "Image N" 编号一致;
 *   - multiRefImageCap=1 时至多 1 个 ref 走 image, 其余 text_only;
 *   - finalPrompt 含 8 段关键标题; 相同输入 promptHash 一致;
 *   - tail_frame 在 P0 抛 not_implemented。
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

function loadFrameImagePlan({
  contentSanitize,
  characterConsistency,
  imageGen,
  sceneSelection,
  frameHelpers,
}) {
  const compiled = compileTs('lib/frame-image-plan.ts');
  const moduleObj = { exports: {} };
  function localRequire(id) {
    if (id === './content-sanitize') return contentSanitize;
    if (id === './character-consistency') return characterConsistency;
    if (id === './image-gen') return imageGen;
    if (id === './scene-selection') return sceneSelection;
    if (id === './frame-prompt-helpers') return frameHelpers;
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
  return loadFrameImagePlan({
    contentSanitize,
    characterConsistency: cc,
    imageGen,
    sceneSelection,
    frameHelpers,
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
    styleBible: {
      visualStyle: 'gritty noir',
      colorPalette: 'teal + amber',
      mood: 'tense',
      lighting: 'low-key rim light',
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

  // manifest: scene (slot 1) → character (slot 2) → prop (slot 3), 稳定顺序
  const roles = plan.referenceManifest.map((r) => r.role);
  assertEqual(roles, ['scene', 'character', 'prop'], 'manifest order');
  const slots = plan.referenceManifest.map((r) => r.slot);
  assertEqual(slots, [1, 2, 3], 'manifest slot is 1-based contiguous');

  // cap=1: 只有第一个 ref 走 image, 其余 text_only (over_capacity)
  const deliveries = plan.referenceManifest.map((r) => r.delivery);
  assertEqual(deliveries, ['image', 'text_only', 'text_only'], 'cap=1 delivery pattern');
  const reasons = plan.referenceManifest.map((r) => r.droppedReason || null);
  assertEqual(reasons, [null, 'over_capacity', 'over_capacity'], 'droppedReason pattern');
  assertEqual(plan.referenceManifest[0].localPath, '/local/scene.png', 'scene localPath resolved');

  // finalPrompt 必含 8 段关键标题
  const p = plan.finalPrompt;
  for (const marker of [
    '【Task】',
    '【Frame goal】',
    '【Primary shot】',
    '【Reference images】',
    '【Composition rules】',
    '【Hard prohibitions】',
    '【Project style lock】',
  ]) {
    assert(p.includes(marker), `finalPrompt should contain ${marker}`);
  }
  // reference 描述中应点名 character 的 assetName
  assert(p.includes('Image 1 = scene'), 'Image 1 = scene line present');
  assert(!p.includes('Image 2 = character'), 'character slot is over_capacity so not shown as Image 2');

  // summary
  const summary = mod.summarizePlanForAudit(plan);
  assertEqual(summary.sentReferences.length, 1, 'summary sent = 1');
  assertEqual(summary.textOnlyReferences.length, 2, 'summary text_only = 2');
  assertEqual(summary.droppedReferences.length, 0, 'summary dropped = 0');
  assert(typeof summary.finalPromptHash === 'string' && summary.finalPromptHash.length === 64, 'hash is sha256');
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

  // prompt 不含 【Reference images】 段
  assert(!plan.finalPrompt.includes('【Reference images】'), 'no image refs → no Reference images section');
  // 但 character lock / prop lock 段仍然存在 (text fallback)
  assert(plan.finalPrompt.includes('【Character lock】'), 'character lock present as text');
  assert(plan.finalPrompt.includes('【Prop lock】'), 'prop lock present as text');
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
  assertEqual(roles[0], 'scene', 'without self_first_frame, slot 1 is scene');
  // prompt 必含 closing + continuity 语言
  assert(plan.finalPrompt.includes('closing beat'), 'tail prompt mentions closing beat');
  assert(plan.finalPrompt.includes('Maintain continuity with the opening frame'), 'tail prompt enforces continuity with opening frame');
  // context shot 段按绝对 index 引用
  assert(plan.finalPrompt.includes('Shot 1:'), 'context shot 1 rendered by absolute index');
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
  // prompt 应描述 Image 1 = this segment first frame
  assert(plan.finalPrompt.includes('Image 1 = this segment first frame'), 'prompt labels Image 1 as this segment first frame');
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
    ['prompt determinism', testPromptDeterminism],
    ['no images available → text_only', testNoImagesAvailable],
    ['tail_frame plan basic (no self_first_frame)', testTailFramePlanBasic],
    ['tail_frame with self_first_frame slot 1', testTailFrameWithSelfFirstFrame],
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
