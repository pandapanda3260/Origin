/* eslint-disable @typescript-eslint/no-var-requires */
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

function loadFrameWorkflowState() {
  const compiled = compileTs('lib/frame-workflow-state.ts');
  const moduleObj = { exports: {} };
  function localRequire(id) {
    if (id === './image-gen') {
      return { resolveLocalImagePath: () => null };
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

function assert(condition, message) {
  if (!condition) throw new Error(`assert failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assert failed: ${message}\n  actual:   ${a}\n  expected: ${e}`);
}

function makeShots(count) {
  return Array.from({ length: count }, (_, idx) => ({
    id: `shot_${idx + 1}`,
    idx: idx + 1,
    visual: `shot ${idx + 1}`,
  }));
}

async function testMigrationArchivesMultiShotAndMovesSingleShotTask() {
  const mod = loadFrameWorkflowState();
  const project = {
    frameWorkflowSchemaVersion: 2,
    shots: makeShots(6),
    storyboards: [
      {
        idx: 0,
        shotIdx: 1,
        shotIndices: [0, 1, 2],
        imageUrl: '/api/images/file/multi',
        videoUrl: '/api/videos/file/vt-multi',
      },
      {
        idx: 1,
        shotIdx: 4,
        shotIndices: [3],
        imageUrl: '/api/images/file/single',
        videoUrl: '/api/videos/file/vt-single',
      },
    ],
    videoTasks: [
      { groupIdx: 0, taskId: 'vt-multi', status: 'completed' },
      { groupIdx: 1, taskId: 'vt-single', status: 'completed' },
    ],
  };

  const patch = mod.buildFrameWorkflowNormalizationPatch(project, 1);
  assert(patch, 'migration patch should exist');
  assertEqual(patch.frameWorkflowSchemaVersion, 3, 'schema version');
  assertEqual(patch.storyboards.length, 6, 'storyboards length follows shots');
  assertEqual(patch.storyboards[3].shotIndices, [3], 'single old slot moves by shotIndices, not old group index');
  assertEqual(patch.storyboards[3].imageUrl, '/api/images/file/single', 'single old slot keeps image');
  assertEqual(patch.videoTasks[3].taskId, 'vt-single', 'single old task moves with storyboard');
  assertEqual(patch.videoTasks[3].groupIdx, 3, 'moved task groupIdx is rewritten');
  assert(patch.legacyStoryboardArchive.some((x) => x.oldGroupIdx === 0 && x.videoTask.taskId === 'vt-multi'), 'multi-shot slot is archived with task');
  mod.assertStoryboardsAlignedWithShots({ ...project, ...patch }, 'test-migration');
}

async function testInvalidMixedShotIndicesDoNotInherit() {
  const mod = loadFrameWorkflowState();
  const project = {
    frameWorkflowSchemaVersion: 2,
    shots: makeShots(2),
    storyboards: [
      {
        idx: 0,
        shotIdx: 1,
        shotIndices: [0, 999],
        imageUrl: '/api/images/file/invalid-mixed',
      },
    ],
    videoTasks: [{ groupIdx: 0, taskId: 'vt-invalid' }],
  };
  const patch = mod.buildFrameWorkflowNormalizationPatch(project, 1);
  assertEqual(patch.storyboards[0].imageUrl, undefined, 'invalid mixed slot is not inherited after filtering');
  assert(patch.legacyStoryboardArchive.some((x) => x.oldGroupIdx === 0), 'invalid mixed slot archived');
  assertEqual(patch.videoTasks[0], undefined, 'invalid mixed task is not reused');
}

async function testDuplicateSingleShotIsArchived() {
  const mod = loadFrameWorkflowState();
  const project = {
    frameWorkflowSchemaVersion: 2,
    shots: makeShots(3),
    storyboards: [
      { idx: 0, shotIdx: 2, shotIndices: [1], imageUrl: '/api/images/file/first' },
      { idx: 1, shotIdx: 2, shotIndices: [1], imageUrl: '/api/images/file/duplicate' },
    ],
    videoTasks: [
      { groupIdx: 0, taskId: 'vt-first' },
      { groupIdx: 1, taskId: 'vt-duplicate' },
    ],
  };
  const patch = mod.buildFrameWorkflowNormalizationPatch(project, 1);
  assertEqual(patch.storyboards[1].imageUrl, '/api/images/file/first', 'first single-shot slot wins');
  assertEqual(patch.videoTasks[1].taskId, 'vt-first', 'first single-shot task wins');
  const duplicate = patch.legacyStoryboardArchive.find((x) => x.oldGroupIdx === 1);
  assert(duplicate, 'duplicate slot archived');
  assert(/duplicate_single_shot/.test(duplicate.archiveReason || ''), 'duplicate archive reason is explicit');
  assertEqual(duplicate.videoTask.taskId, 'vt-duplicate', 'duplicate task archived');
}

async function testEditDataRemapsAndArchivesDroppedGroups() {
  const mod = loadFrameWorkflowState();
  const project = {
    frameWorkflowSchemaVersion: 2,
    shots: makeShots(5),
    storyboards: [
      { idx: 0, shotIdx: 1, shotIndices: [0, 1, 2], videoUrl: '/api/videos/file/multi' },
      { idx: 1, shotIdx: 4, shotIndices: [3], videoUrl: '/api/videos/file/single' },
    ],
    videoTasks: [
      { groupIdx: 0, taskId: 'vt-multi' },
      { groupIdx: 1, taskId: 'vt-single' },
    ],
    editData: {
      version: 7,
      edl: {
        version: 2,
        timeline: [
          { groupIdx: 0, duration: 8 },
          { groupIdx: 1, duration: 4 },
          { clipId: 'external', duration: 2 },
        ],
      },
      segmentTags: {
        segments: [
          { groupIdx: 0, plotRole: 'setup' },
          { groupIdx: 1, plotRole: 'climax' },
        ],
      },
    },
  };
  const patch = mod.buildFrameWorkflowNormalizationPatch(project, 1);
  assertEqual(
    patch.editData.edl.timeline,
    [{ groupIdx: 3, duration: 4 }, { clipId: 'external', duration: 2 }],
    'edl timeline remaps inherited group and drops archived group',
  );
  assertEqual(patch.editData.edl.version, 3, 'edl version bumps');
  assertEqual(
    patch.editData.segmentTags.segments,
    [{ groupIdx: 3, plotRole: 'climax' }],
    'segment tags remap inherited group and drop archived group',
  );
  assert(patch.legacyTimelineArchive && patch.legacyTimelineArchive.length === 1, 'legacy timeline archived');
  assertEqual(patch.legacyTimelineArchive[0].droppedTimelineCount, 1, 'dropped timeline count');
  assertEqual(patch.legacyTimelineArchive[0].droppedSegmentTagCount, 1, 'dropped segment tag count');
}

async function testMigrationIsIdempotentAfterV3() {
  const mod = loadFrameWorkflowState();
  const project = {
    frameWorkflowSchemaVersion: 2,
    shots: makeShots(2),
    storyboards: [
      { idx: 0, shotIdx: 1, shotIndices: [0], imageUrl: '/api/images/file/a' },
      { idx: 1, shotIdx: 2, shotIndices: [1], imageUrl: '/api/images/file/b' },
    ],
  };
  const patch = mod.buildFrameWorkflowNormalizationPatch(project, 1);
  const migrated = { ...project, ...patch };
  assertEqual(mod.buildFrameWorkflowNormalizationPatch(migrated, 1), null, 'v3 migration is not repeated');
  mod.assertStoryboardsAlignedWithShots(migrated, 'idempotent-migration');
}

async function testStrictShotResolverRejectsWrongSlot() {
  const mod = loadFrameWorkflowState();
  const project = {
    shots: makeShots(2),
    storyboards: [
      { idx: 0, shotIdx: 1, shotIndices: [1] },
      { idx: 1, shotIdx: 2, shotIndices: [1] },
    ],
  };
  let threw = false;
  try {
    mod.storyboardShotIndices(project, 0, project.storyboards[0], { mode: 'single-shot-strict' });
  } catch {
    threw = true;
  }
  assert(threw, 'strict resolver rejects storyboards[0].shotIndices=[1]');
  assertEqual(
    mod.storyboardShotIndices(project, 1, project.storyboards[1], { mode: 'single-shot-strict' }),
    [1],
    'strict resolver accepts matching slot',
  );
}

async function testSingleShotSlotFactoryAndInvariant() {
  const mod = loadFrameWorkflowState();
  const project = {
    shots: makeShots(3),
    storyboards: mod.makeSingleShotStoryboardSlots(makeShots(3)),
    videoTasks: [],
  };
  assertEqual(project.storyboards.map((sb) => sb.shotIndices), [[0], [1], [2]], 'factory creates one slot per shot');
  mod.assertStoryboardsAlignedWithShots(project, 'factory');
}

async function testTailFrameStaleMarkPreservesExistingStaleAt() {
  const mod = loadFrameWorkflowState();
  const existingStaleAt = '2026-05-19T10:00:00.000Z';
  const attemptedRefreshAt = '2026-05-19T10:05:00.000Z';
  const next = mod.markTailFrameStaleForFirstFrameChange({
    tailFrameUrl: '/api/images/file/tail',
    tailFrameIntent: 'requested',
    tailFrameReferenceStatus: 'stale',
    tailFrameStaleAt: existingStaleAt,
    tailFrameStaleReason: 'first_frame_changed',
    frames: {
      tail: {
        url: '/api/images/file/tail',
        referenceStatus: 'stale',
        staleAt: existingStaleAt,
        staleReason: 'first_frame_changed',
      },
    },
  }, { staleAt: attemptedRefreshAt });
  assertEqual(next.tailFrameStaleAt, existingStaleAt, 'repeated stale mark keeps original storyboard staleAt');
  assertEqual(next.frames.tail.staleAt, existingStaleAt, 'repeated stale mark keeps original frame staleAt');
}

async function main() {
  const tests = [
    ['migration archives multi-shot and moves single-shot task', testMigrationArchivesMultiShotAndMovesSingleShotTask],
    ['invalid mixed shotIndices do not inherit', testInvalidMixedShotIndicesDoNotInherit],
    ['duplicate single-shot slot is archived', testDuplicateSingleShotIsArchived],
    ['editData timeline and tags remap during migration', testEditDataRemapsAndArchivesDroppedGroups],
    ['migration is idempotent after v3', testMigrationIsIdempotentAfterV3],
    ['strict resolver rejects wrong slot', testStrictShotResolverRejectsWrongSlot],
    ['single-shot slot factory and invariant', testSingleShotSlotFactoryAndInvariant],
    ['tail stale marker preserves existing staleAt', testTailFrameStaleMarkPreservesExistingStaleAt],
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
