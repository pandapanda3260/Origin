import assert from 'node:assert/strict';
import { applyBlockerFilterWithWarnings, batchPreflightPayload, formatBatchPreflightBlockedDecision } from '../lib/batch-preflight';
import {
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
} from '../lib/project-dependency-state';

function projectFixture() {
  const project: any = {
    id: 'proj_batch_preflight',
    script: '第一场：雨夜。主角进入大厅。',
    scriptTargetDurationSec: 30,
    styleBible: { mood: '冷峻', lighting: '顶光' },
    assets: {
      characters: [{ id: 'c1', name: '甲', role: '主角', status: 'locked' }],
      scenes: [{ id: 's1', name: '大厅', location: '一楼' }],
      props: [],
    },
    emotions: [{ start: 0, end: 10, label: 'tense' }],
    shots: [
      { id: 'shot_0', idx: 1, visual: '甲推门', imagePromptGenerated: true },
      { id: 'shot_1', idx: 2, visual: '大厅灯亮', imagePromptGenerated: true },
    ],
    storyboards: [
      { idx: 0, shotIdx: 1, shotIndices: [0] },
      { idx: 1, shotIdx: 2, shotIndices: [1] },
    ],
    videoTasks: [],
    _staleFlags: {},
  };
  project.shotPlanStatus = 'ready';
  project.shotPlanSourceSnapshot = computeShotPlanSourceSnapshot(project);
  project.shotPlanSourceHash = computeShotPlanSourceHash(project);
  return project;
}

function targets() {
  return [
    { groupIdx: 0, idx: 0, shotIndices: [0] },
    { groupIdx: 1, idx: 1, shotIndices: [1] },
  ];
}

function avoidCharacterGateFixture(project: any) {
  project.assets = { ...project.assets, characters: [], props: [] };
  project.shots = project.shots.map((shot: any) => ({
    ...shot,
    visual: shot.idx === 1 ? '推门进入大厅' : '大厅灯亮',
    characters: [],
    speaker: '',
    dialogue: '',
  }));
  delete project.consistency;
  project.shotPlanSourceSnapshot = computeShotPlanSourceSnapshot(project);
  project.shotPlanSourceHash = computeShotPlanSourceHash(project);
  return project;
}

function markFirstFramesReady(project: any) {
  project.storyboards = project.storyboards.map((storyboard: any, idx: number) => ({
    ...storyboard,
    firstFrameUrl: `/api/images/file/storyboard-${idx}.png`,
    firstFrame: {
      currentUrl: `/api/images/file/storyboard-${idx}.png`,
      status: 'ready',
      source: 'generated',
      history: [],
    },
    frames: {
      ...(storyboard.frames || {}),
      first: {
        ...(storyboard.frames?.first || {}),
        url: `/api/images/file/storyboard-${idx}.png`,
        status: 'ready',
      },
    },
  }));
  return project;
}

function testAllowsFirstFrameGenerationWithoutExistingFirstFrame() {
  const project = projectFixture();
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, true, 'storyboard_images can generate missing first frames');
  assert.deepEqual(payload.preflight.blocked, [], 'no blocked items for fresh shot plan');
}

function testAllowsFirstFrameGenerationForStaleStoryboardSlot() {
  const project = markFirstFramesReady(projectFixture());
  project._staleFlags = { storyboard_0: true };
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, true, 'storyboard_images can regenerate stale first-frame slots');
  assert.deepEqual(payload.preflight.blocked, [], 'stale storyboard slot is not a producer-path blocker');
}

function testAllowsFreshButHashMismatch() {
  const project = projectFixture();
  project.assets = {
    ...project.assets,
    props: [{ id: 'p1', name: '新道具' }],
  };
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, true, 'hash mismatch no longer blocks storyboard_images preflight');
  assert.deepEqual(payload.preflight.blocked, [], 'hash mismatch is removed from user-facing blockers');
}

function testAllowsLegacyUnknown() {
  const project = projectFixture();
  delete project.shotPlanStatus;
  delete project.shotPlanSourceHash;
  delete project.shotPlanSourceSnapshot;
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, true, 'legacy unknown no longer blocks storyboard_images preflight');
  assert.deepEqual(payload.preflight.blocked, [], 'legacy unknown is removed from user-facing blockers');
}

function testAllowsVideoPromptGenerationWithoutExistingPrompt() {
  const project = markFirstFramesReady(avoidCharacterGateFixture(projectFixture()));
  const payload = batchPreflightPayload(project, project.id, 'video_prompts', targets());
  assert.equal(payload.allowed, true, 'video_prompts can generate missing prompts when first frames are ready');
  assert.deepEqual(payload.preflight.blocked, [], 'missing video prompts must not block their own generation');
}

function testBlocksVideoPromptGenerationWithoutFirstFrame() {
  const project = avoidCharacterGateFixture(projectFixture());
  const payload = batchPreflightPayload(project, project.id, 'video_prompts', targets());
  assert.equal(payload.allowed, false, 'video_prompts require ready first frames');
  assert.equal(payload.preflight.blocked[0].reason, 'first_frame_missing');
}

function testBlockerFilterRemovesNonEssentialReasons() {
  const decision: any = {
    targetArtifact: 'video_segment',
    projectId: 'proj',
    groupIdx: 0,
    usability: 'BLOCKED',
    freshness: 'stale',
    generation: 'idle',
    reasons: ['video_prompt_stale', 'character_consistency_blocked'],
    blockingReasons: ['video_prompt_stale', 'character_consistency_blocked'],
    staleFlagKeys: ['video_prompt_0'],
    consistency: {
      allowed: false,
      score: 40,
      level: 'red',
      blockers: [{ code: 'character_status_not_locked', message: 'not locked' }],
      warnings: [{ code: 'mention_ambiguous', message: 'ambiguous' }],
      characterUsages: [],
    },
    repairActions: [],
  };
  const filtered = applyBlockerFilterWithWarnings(decision);
  assert.equal(filtered.decision.usability, 'USABLE', 'non-essential stale/consistency blockers are removed');
  assert.deepEqual(filtered.decision.blockingReasons, []);
  assert.deepEqual(filtered.warnings, [{
    kind: 'consistency_aggregate',
    message: '角色一致性仍有待优化，已继续生成。',
  }]);
}

function testBlockerFilterKeepsHardReasons() {
  const decision: any = {
    targetArtifact: 'video_segment',
    projectId: 'proj',
    groupIdx: 0,
    usability: 'BLOCKED',
    freshness: 'stale',
    generation: 'missing',
    reasons: ['video_prompt_stale', 'missing_video_prompt', 'character_consistency_blocked'],
    blockingReasons: ['video_prompt_stale', 'missing_video_prompt', 'character_consistency_blocked'],
    staleFlagKeys: ['video_prompt_0'],
    consistency: {
      allowed: false,
      score: 40,
      level: 'red',
      blockers: [{ code: 'character_status_not_locked', message: 'not locked' }],
      warnings: [],
      characterUsages: [],
    },
    repairActions: [],
  };
  const filtered = applyBlockerFilterWithWarnings(decision);
  assert.equal(filtered.decision.usability, 'BLOCKED', 'hard blockers remain blocked');
  assert.deepEqual(filtered.decision.blockingReasons, ['missing_video_prompt']);
  assert.deepEqual(filtered.decision.consistency?.blockers, [], 'filtered consistency details are not shown with hard blockers');
  assert.deepEqual(filtered.decision.consistency?.warnings, [], 'filtered consistency warnings are not shown with hard blockers');
  assert.deepEqual(formatBatchPreflightBlockedDecision(filtered.decision).warnings, [], 'blocked preflight payload does not leak consistency warnings');
  assert.deepEqual(filtered.warnings, [], 'blocked responses do not emit consistency aggregate toasts');
}

function testBlockerFilterHidesWarningOnlyConsistencyOnHardBlock() {
  const decision: any = {
    targetArtifact: 'video_segment',
    projectId: 'proj',
    groupIdx: 0,
    usability: 'BLOCKED',
    freshness: 'fresh',
    generation: 'missing',
    reasons: ['missing_video_prompt'],
    blockingReasons: ['missing_video_prompt'],
    staleFlagKeys: [],
    consistency: {
      allowed: true,
      score: 82,
      level: 'yellow',
      blockers: [],
      warnings: [{ code: 'mention_ambiguous', message: 'ambiguous' }],
      characterUsages: [],
    },
    repairActions: [],
  };
  const filtered = applyBlockerFilterWithWarnings(decision);
  assert.equal(filtered.decision.usability, 'BLOCKED', 'hard blocker remains blocked');
  assert.deepEqual(filtered.decision.consistency?.warnings, [], 'warning-only consistency details are hidden on blocked payloads');
  assert.deepEqual(formatBatchPreflightBlockedDecision(filtered.decision).warnings, [], 'formatted blocked payload hides warning-only consistency details');
  assert.deepEqual(filtered.warnings, [], 'blocked responses do not emit consistency aggregate toasts');
}

testAllowsFirstFrameGenerationWithoutExistingFirstFrame();
testAllowsFirstFrameGenerationForStaleStoryboardSlot();
testAllowsFreshButHashMismatch();
testAllowsLegacyUnknown();
testAllowsVideoPromptGenerationWithoutExistingPrompt();
testBlocksVideoPromptGenerationWithoutFirstFrame();
testBlockerFilterRemovesNonEssentialReasons();
testBlockerFilterKeepsHardReasons();
testBlockerFilterHidesWarningOnlyConsistencyOnHardBlock();

console.log('test-batch-preflight: ok');
