#!/usr/bin/env node
const assert = require('node:assert/strict');
const {
  archiveCurrentShotPlan,
  beginShotPlanGeneration,
  buildShotPlanDependencyPatch,
  completeShotPlanGenerationPatch,
  computeAssetsSemanticHash,
  computeScriptHash,
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
  computeWorldHash,
  confirmCurrentShotPlanStillValid,
  confirmCurrentShotPlanStillValidWithDownstreamSeed,
  detectShotsManualEdit,
  diffShotPlanSourceSnapshots,
  hasDownstreamShotPlanStaleFlags,
  markShotPlanStale,
  markVideoTasksOutdatedForShotPlanChange,
  failShotPlanGenerationPatch,
  seedDownstreamStaleForShotPlan,
  shouldSeedDownstreamStaleOnShotPlanConfirm,
  ShotPlanConfirmInvalidStateError,
} = require('../lib/project-dependency-state.ts');

function projectFixture() {
  return {
    script: '第一场：雨夜。  主角进门。',
    scriptDraft: '这是草稿，不应该影响镜头计划 hash。',
    scriptTargetDurationSec: 42,
    styleBible: {
      lighting: '冷白顶灯',
      mood: '压迫',
      colorPalette: ['blue', 'white'],
    },
    selectedWorldTemplateId: null,
    worldTemplateSnapshot: null,
    assets: {
      characters: [
        { id: 'c2', name: '乙', entityType: 'non-human', imageUrl: '/api/images/file/nope', clothing: '黑衣' },
        { id: 'c1', name: '甲', role: '主角', appearance: '短发', realPhotoUrl: '/old' },
      ],
      scenes: [
        { id: 's1', name: '酒店大厅', location: '一楼', imageUrl: '/api/images/file/scene' },
      ],
      props: [
        { id: 'p1', name: '戒指', material: '银' },
      ],
    },
	    emotions: [{ start: 8, end: 12, label: 'rising', text: '紧张' }],
	    planMeta: { version: 4, shotCount: 1, plannedDurationSec: 4 },
	    shots: [
      { id: 'shot_1', idx: 1, visual: '甲进门', camera: '固定镜头', dialogue: '——', imagePromptGeneratedAt: 'x' },
    ],
  };
}

function testStableHashesIgnoreNoise() {
  const a = projectFixture();
  const b = {
    ...projectFixture(),
    script: ' 第一场：雨夜。\n\n主角进门。 ',
    scriptDraft: '完全不同的草稿',
    assets: {
      ...projectFixture().assets,
      characters: [...projectFixture().assets.characters].reverse().map((item) => ({
        ...item,
        imageUrl: '/api/images/file/changed',
        rawUrl: '/raw/changed',
      })),
    },
  };

  assert.equal(computeScriptHash(a), computeScriptHash(b), 'script hash ignores draft and whitespace noise');
  assert.equal(computeAssetsSemanticHash(a), computeAssetsSemanticHash(b), 'asset semantic hash ignores image urls and ordering');

  const c = projectFixture();
  c.assets.characters[0].clothing = '红衣';
  assert.notEqual(computeAssetsSemanticHash(a), computeAssetsSemanticHash(c), 'semantic field change changes asset hash');
  assert.equal(computeShotPlanSourceHash(a), computeShotPlanSourceHash(projectFixture()), 'source hash is stable');
}

function testSnapshotShape() {
  const snapshot = computeShotPlanSourceSnapshot(projectFixture());
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['assetsHash', 'durationHash', 'emotionHash', 'scriptHash', 'styleBibleHash', 'worldHash'].sort(),
    'snapshot stores sub hashes only',
  );
}

function testWorldHashAndStaleReason() {
  const emptyA = { ...projectFixture(), selectedWorldTemplateId: null, worldTemplateSnapshot: null };
  const emptyB = { ...projectFixture(), selectedWorldTemplateId: '', worldTemplateSnapshot: null };
  assert.equal(computeWorldHash(emptyA), computeWorldHash(emptyB), 'empty world hash is stable');

  const withWorld = {
    ...emptyA,
    selectedWorldTemplateId: 'world_city',
    worldTemplateSnapshot: {
      id: 'world_city',
      updatedAt: '2026-06-05T00:00:00.000Z',
      worldRules: ['城市边界不可离开'],
      terminology: { 巡界人: '负责巡逻边界的人' },
    },
  };
  assert.notEqual(computeWorldHash(emptyA), computeWorldHash(withWorld), 'first world binding changes world hash');
  assert.deepEqual(
    diffShotPlanSourceSnapshots(computeShotPlanSourceSnapshot(emptyA), computeShotPlanSourceSnapshot(withWorld)),
    ['world_changed'],
    'first world binding marks world_changed only',
  );
  assert.deepEqual(
    diffShotPlanSourceSnapshots(computeShotPlanSourceSnapshot(withWorld), computeShotPlanSourceSnapshot(emptyA)),
    ['world_changed'],
    'world unlink marks world_changed',
  );

  const changedWorld = {
    ...withWorld,
    worldTemplateSnapshot: {
      ...withWorld.worldTemplateSnapshot,
      worldRules: ['城市边界不可离开', '夜间不能使用明火'],
    },
  };
  assert.deepEqual(
    diffShotPlanSourceSnapshots(computeShotPlanSourceSnapshot(withWorld), computeShotPlanSourceSnapshot(changedWorld)),
    ['world_changed'],
    'world content change marks world_changed even when style bible is unchanged',
  );
}

function testStaleReasonsAndConfirm() {
  const base = {
    ...projectFixture(),
    storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0], videoPrompt: '旧提示词' }],
    shotPlanStatus: 'ready',
    shotPlanSourceHash: 'old',
  };
  const stale = markShotPlanStale(markShotPlanStale(base, 'script_changed', '2026-05-19T01:00:00.000Z'), 'assets_changed', '2026-05-19T01:01:00.000Z');
  assert.equal(stale.shotPlanStatus, 'stale', 'ready becomes stale');
  assert.deepEqual(stale.shotPlanStaleReasons, ['script_changed', 'assets_changed'], 'reasons accumulate');
  assert.equal(stale._staleFlags.shotPlan, true, 'stale flag is set');
  assert.equal(stale._staleFlags.storyboard_0, true, 'storyboard stale flag is propagated');
  assert.equal(stale._staleFlags.video_prompt_0, true, 'video prompt stale flag is propagated');
  assert.deepEqual(stale.storyboards[0].staleSourceReasons, ['script_changed', 'assets_changed'], 'propagated reasons are preserved');

  const confirmed = confirmCurrentShotPlanStillValid(stale, '2026-05-19T02:00:00.000Z');
  assert.equal(confirmed.shotPlanStatus, 'ready', 'confirm sets ready');
  assert.equal(confirmed._staleFlags.shotPlan, undefined, 'confirm clears only shotPlan flag');
  assert.equal(confirmed._staleFlags.storyboard_0, true, 'confirm does not clear downstream storyboard flag');
  assert.equal(confirmed._staleFlags.video_prompt_0, true, 'confirm does not clear downstream video prompt flag');
  assert.equal(confirmed.shotPlanLastConfirmedAt, '2026-05-19T02:00:00.000Z', 'confirm timestamp recorded');
  assert.equal(confirmed.shotPlanLastConfirmedHash, confirmed.shotPlanSourceHash, 'confirmed hash recorded');

  assert.throws(
    () => confirmCurrentShotPlanStillValid({ ...base, shotPlanStatus: 'generating' }),
    ShotPlanConfirmInvalidStateError,
    'generating cannot be confirmed',
  );
  assert.throws(
    () => confirmCurrentShotPlanStillValid({ ...base, shotPlanStatus: 'ready' }),
    ShotPlanConfirmInvalidStateError,
    'ready cannot be over-confirmed',
  );
}

function testDownstreamSeedHelpers() {
  const project = {
    ...projectFixture(),
    storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0], videoPrompt: '旧提示词' }],
    _staleFlags: {},
  };
  const seeded = seedDownstreamStaleForShotPlan(project, {
    reasons: ['script_changed', 'emotion_changed'],
    now: '2026-05-19T02:10:00.000Z',
  });
  assert.equal(seeded._staleFlags.storyboard_0, true, 'seed helper writes storyboard flag');
  assert.equal(seeded._staleFlags.video_prompt_0, true, 'seed helper writes video prompt flag');
  assert.equal(seeded.storyboards[0].staleSource, 'shot_plan', 'seed helper records stale source');
  assert.deepEqual(seeded.storyboards[0].staleSourceReasons, ['script_changed', 'emotion_changed'], 'seed helper records all reasons');
  assert.equal(seeded.storyboards[0].staleSourceAt, '2026-05-19T02:10:00.000Z', 'seed helper records timestamp');

  assert.equal(hasDownstreamShotPlanStaleFlags(seeded), true, 'downstream flags are detectable');
  assert.equal(shouldSeedDownstreamStaleOnShotPlanConfirm({ ...project, shotPlanStatus: 'legacy_unknown' }), true, 'legacy confirm seeds downstream');
  assert.equal(shouldSeedDownstreamStaleOnShotPlanConfirm({ ...project, shotPlanStatus: 'stale' }), true, 'historical stale without downstream flags seeds downstream');
  assert.equal(shouldSeedDownstreamStaleOnShotPlanConfirm({ ...seeded, shotPlanStatus: 'stale' }), false, 'stale with downstream flags is not widened again');

  const legacyConfirmed = confirmCurrentShotPlanStillValidWithDownstreamSeed({
    ...project,
    shotPlanStatus: 'legacy_unknown',
    _staleFlags: { shotPlan: true },
  }, '2026-05-19T02:20:00.000Z');
  assert.equal(legacyConfirmed.shotPlanStatus, 'ready', 'legacy confirm sets shot plan ready');
  assert.equal(legacyConfirmed._staleFlags.shotPlan, undefined, 'legacy confirm clears shotPlan flag');
  assert.equal(legacyConfirmed._staleFlags.storyboard_0, true, 'legacy confirm seeds storyboard stale flag');
  assert.equal(legacyConfirmed._staleFlags.video_prompt_0, true, 'legacy confirm seeds video prompt stale flag');
  assert.deepEqual(legacyConfirmed.storyboards[0].staleSourceReasons, ['legacy_unknown'], 'legacy confirm keeps downstream explanation');

  const historicalStaleConfirmed = confirmCurrentShotPlanStillValidWithDownstreamSeed({
    ...project,
    shotPlanStatus: 'stale',
    shotPlanStaleReasons: ['script_changed'],
    _staleFlags: { shotPlan: true },
  }, '2026-05-19T02:21:00.000Z');
  assert.equal(historicalStaleConfirmed._staleFlags.storyboard_0, true, 'historical stale confirm seeds missing downstream storyboard flag');
  assert.deepEqual(historicalStaleConfirmed.storyboards[0].staleSourceReasons, ['script_changed'], 'historical stale confirm preserves stale reason');
}

function testGeneratingKeepsStatusButRecordsReason() {
  const project = { ...projectFixture(), shotPlanStatus: 'generating', _staleFlags: {} };
  const next = markShotPlanStale(project, 'assets_changed');
  assert.equal(next.shotPlanStatus, 'generating', 'generating status is preserved for CAS');
  assert.deepEqual(next.shotPlanStaleReasons, ['assets_changed'], 'pending stale reason is preserved');
  assert.equal(next._staleFlags.shotPlan, true, 'stale flag still echoes during generation');
}

function testManualEditDetection() {
	  const oldShots = [{ id: 's1', idx: 1, visual: '甲进门', imagePromptGeneratedAt: 'old' }];
	  const onlyDownstreamPromptChanged = [{ id: 's1', idx: 1, visual: '甲进门', imagePromptGeneratedAt: 'new' }];
	  const visualChanged = [{ id: 's1', idx: 1, visual: '甲冲进门', imagePromptGeneratedAt: 'old' }];
	  const angleChanged = [{ id: 's1', idx: 1, visual: '甲进门', angle: '俯拍', imagePromptGeneratedAt: 'old' }];
	  assert.equal(detectShotsManualEdit(oldShots, onlyDownstreamPromptChanged), false, 'downstream generated fields are ignored');
	  assert.equal(detectShotsManualEdit(oldShots, visualChanged), true, 'shot planning field change is manual edit');
	  assert.equal(detectShotsManualEdit(oldShots, angleChanged), true, 'new shot planning fields are manual edits');
	}

function testArchiveAndVideoOutdated() {
  const project = projectFixture();
  const archived = archiveCurrentShotPlan(project, {
    context: 'pre_regen',
    batchId: 'batch_1',
    now: '2026-05-19T03:00:00.000Z',
  });
  assert.equal(archived.legacyShotPlanArchive.length, 1, 'archive entry created');
	  assert.equal(archived.legacyShotPlanArchive[0].archiveContext, 'pre_regen', 'archive context recorded');
	  assert.deepEqual(archived.legacyShotPlanArchive[0].planMeta, project.planMeta, 'planMeta snapshot is stored');
	  assert.equal(archived.legacyShotPlanArchive[0].shots[0].visual, '甲进门', 'shots snapshot is stored');

  const withTasks = {
    ...project,
    videoTasks: [{ taskId: 'v1', status: 'completed' }, null, { taskId: 'v2', status: 'failed' }],
  };
  const outdated = markVideoTasksOutdatedForShotPlanChange(withTasks, 'shot_plan_regenerated', '2026-05-19T04:00:00.000Z');
  assert.equal(outdated.videoTasks[0].outdated, true, 'existing video task is marked outdated');
  assert.equal(outdated.videoTasks[1], null, 'empty slots are preserved');
  assert.equal(outdated.videoTasks[2].outdatedReason, 'shot_plan_regenerated', 'reason recorded');
}

function testGenerationStateMachine() {
  const source = projectFixture();
  const sourceSnapshot = computeShotPlanSourceSnapshot(source);
  const sourceHash = computeShotPlanSourceHash(source);
  const started = beginShotPlanGeneration(
    { ...source, shotPlanStatus: 'stale', _staleFlags: { shotPlan: true, storyboard_0: true, video_prompt_0: true } },
    {
      batchId: 'batch_shots_1',
      sourceSnapshot,
      sourceHash,
      now: '2026-05-19T06:00:00.000Z',
      archive: true,
    },
  );
  assert.equal(started.shotPlanStatus, 'generating', 'begin marks generating');
  assert.equal(started.shotPlanBatchId, 'batch_shots_1', 'begin records batch id');
  assert.equal(started._staleFlags.shotPlan, undefined, 'begin clears stale flag');
  assert.equal(started.legacyShotPlanArchive.length, 1, 'begin archives previous shots');

  const done = completeShotPlanGenerationPatch(started, {
	    batchId: 'batch_shots_1',
	    shots: [{ id: 'shot_1', idx: 1, visual: '新镜头' }],
	    planMeta: { version: 4, shotCount: 1, plannedDurationSec: 4 },
	    storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0] }],
    autoSegmentPlanSnapshot: {
      version: 1,
      segmentationMode: 'auto',
      modelRole: 'video',
      modelId: 'doubao-seedance-2-0-260128',
      options: { targetMinSec: 4, targetMaxSec: 15, hardMaxSec: 15 },
      createdAt: '2026-05-19T06:01:00.000Z',
    },
    sourceSnapshot,
    sourceHash,
    now: '2026-05-19T06:01:00.000Z',
  });
  assert.equal(done.ok, true, 'completion succeeds under matching CAS');
  assert.equal(done.patch.shotPlanStatus, 'ready', 'completion marks ready when source did not change');
  assert.equal(done.patch._staleFlags.storyboard_0, undefined, 'fresh completion clears old storyboard stale flag');
  assert.equal(done.patch._staleFlags.video_prompt_0, undefined, 'fresh completion clears old video prompt stale flag');
	  assert.equal(done.patch.shotPlanBatchId, undefined, 'active batch id is cleared');
	  assert.deepEqual(done.patch.planMeta, { version: 4, shotCount: 1, plannedDurationSec: 4 }, 'completion writes planMeta');
  assert.deepEqual(
    done.patch.autoSegmentPlanSnapshot.options,
    { targetMinSec: 4, targetMaxSec: 15, hardMaxSec: 15 },
    'completion writes auto segment plan snapshot from opts',
  );
	  assert.equal(done.patch.shotsManuallyEditedAt, null, 'AI full generation clears manual edit marker');

  const staleProject = {
    ...started,
    assets: {
      ...started.assets,
      props: [{ id: 'p1', name: '戒指', material: '金' }],
    },
  };
  const staleDone = completeShotPlanGenerationPatch(staleProject, {
    batchId: 'batch_shots_1',
    shots: [{ id: 'shot_1', idx: 1, visual: '新镜头' }],
    storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0] }],
    sourceSnapshot,
    sourceHash,
    now: '2026-05-19T06:02:00.000Z',
  });
  assert.equal(staleDone.ok, true, 'completion can write generated result after upstream changed');
  assert.equal(staleDone.patch.shotPlanStatus, 'stale', 'completion immediately marks stale after concurrent upstream change');
  assert(staleDone.patch.shotPlanStaleReasons.includes('upstream_changed_during_generation'), 'concurrent reason recorded');
  assert(staleDone.patch.shotPlanStaleReasons.includes('assets_changed'), 'specific diff reason recorded');
  assert.equal(staleDone.patch._staleFlags.storyboard_0, true, 'stale completion propagates storyboard flag');
  assert.equal(staleDone.patch._staleFlags.video_prompt_0, true, 'stale completion propagates video prompt flag');
  assert.deepEqual(
    staleDone.patch.storyboards[0].staleSourceReasons,
    ['upstream_changed_during_generation', 'assets_changed'],
    'stale completion preserves propagation reasons',
  );

  const casMiss = completeShotPlanGenerationPatch({ ...started, shotPlanBatchId: 'other' }, {
    batchId: 'batch_shots_1',
    shots: [],
    storyboards: [],
  });
  assert.equal(casMiss.ok, false, 'completion rejects stale batch id');

  const failed = failShotPlanGenerationPatch(started, {
    batchId: 'batch_shots_1',
    error: 'model timeout',
    now: '2026-05-19T06:03:00.000Z',
  });
  assert.equal(failed.ok, true, 'failure patch succeeds under matching CAS');
  assert.equal(failed.patch.shotPlanStatus, 'failed', 'failure marks failed');
  assert.equal(failed.patch.shotPlanLastError, 'model timeout', 'failure stores error');
}

function testBuildDependencyPatch() {
  const current = {
    ...projectFixture(),
    storyboards: [{ idx: 0, shotIdx: 1, shotIndices: [0], videoPrompt: '旧提示词' }],
    shotPlanStatus: 'ready',
    shotPlanSourceHash: computeShotPlanSourceHash(projectFixture()),
    shotPlanSourceSnapshot: computeShotPlanSourceSnapshot(projectFixture()),
    _staleFlags: { assets: true },
  };
  const candidate = {
    ...current,
    script: `${current.script} 新增一句正式剧本。`,
  };
  const patch = buildShotPlanDependencyPatch({
    current,
    candidate,
    changedPatch: { script: candidate.script },
    now: '2026-05-19T05:00:00.000Z',
  });
  assert.equal(patch.shotPlanStatus, 'stale', 'script change marks shot plan stale');
  assert.deepEqual(patch.shotPlanStaleReasons, ['script_changed'], 'script reason recorded');
  assert.equal(patch._staleFlags.assets, true, 'unrelated stale flag is preserved');
  assert.equal(patch._staleFlags.shotPlan, true, 'shot plan stale flag set');
  assert.equal(patch._staleFlags.storyboard_0, true, 'dependency patch propagates storyboard stale flag');
  assert.equal(patch._staleFlags.video_prompt_0, true, 'dependency patch propagates video prompt stale flag');
  assert.deepEqual(patch.storyboards[0].staleSourceReasons, ['script_changed'], 'dependency patch propagates reason detail');

  const generating = buildShotPlanDependencyPatch({
    current: { ...current, shotPlanStatus: 'generating' },
    candidate: { ...candidate, shotPlanStatus: 'generating' },
    changedPatch: { script: candidate.script },
    now: '2026-05-19T05:01:00.000Z',
  });
  assert.equal(generating.shotPlanStatus, 'generating', 'generating status is preserved by dependency guard');
  assert.deepEqual(generating.shotPlanStaleReasons, ['script_changed'], 'generating still records reason');

  const manualPatch = buildShotPlanDependencyPatch({
    current,
    candidate: { ...current, shots: [{ ...current.shots[0], visual: '手动改画面' }] },
    changedPatch: { shots: [{ ...current.shots[0], visual: '手动改画面' }] },
    now: '2026-05-19T05:02:00.000Z',
  });
  assert.equal(manualPatch.shotsManuallyEditedAt, '2026-05-19T05:02:00.000Z', 'manual shot edit timestamp recorded');

  const clearedShotsPatch = buildShotPlanDependencyPatch({
    current,
    candidate: { ...current, shots: [] },
    changedPatch: { shots: [] },
    now: '2026-05-19T05:02:30.000Z',
  });
  assert.equal(
    !clearedShotsPatch || clearedShotsPatch.shotsManuallyEditedAt == null,
    true,
    'automated shot reset is not treated as manual edit',
  );

  const legacy = buildShotPlanDependencyPatch({
    current: { ...projectFixture(), shotPlanStatus: undefined, shotPlanSourceHash: undefined },
    candidate: { ...projectFixture(), shotPlanStatus: undefined, shotPlanSourceHash: undefined },
    changedPatch: { title: 'rename only' },
    now: '2026-05-19T05:03:00.000Z',
  });
  assert.equal(legacy.shotPlanStatus, 'legacy_unknown', 'old shot plan gets legacy status');
  assert.equal(legacy._staleFlags.shotPlan, true, 'legacy status is echoed for UI banner');
}

testStableHashesIgnoreNoise();
testSnapshotShape();
testWorldHashAndStaleReason();
testStaleReasonsAndConfirm();
testDownstreamSeedHelpers();
testGeneratingKeepsStatusButRecordsReason();
testManualEditDetection();
testArchiveAndVideoOutdated();
testBuildDependencyPatch();
testGenerationStateMachine();

console.log('test-project-dependency-state: ok');
