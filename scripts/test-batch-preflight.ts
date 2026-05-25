import assert from 'node:assert/strict';
import { batchPreflightPayload } from '../lib/batch-preflight';
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

function testBlocksFreshButHashMismatch() {
  const project = projectFixture();
  project.assets = {
    ...project.assets,
    props: [{ id: 'p1', name: '新道具' }],
  };
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, false, 'hash mismatch blocks storyboard_images preflight');
  assert.equal(payload.preflight.blocked[0].reason, 'shot_plan_fresh_but_hash_mismatch');
}

function testBlocksLegacyUnknown() {
  const project = projectFixture();
  delete project.shotPlanStatus;
  delete project.shotPlanSourceHash;
  delete project.shotPlanSourceSnapshot;
  const payload = batchPreflightPayload(project, project.id, 'storyboard_images', targets());
  assert.equal(payload.allowed, false, 'legacy unknown blocks storyboard_images preflight');
  assert.equal(payload.preflight.blocked[0].reason, 'shot_plan_legacy_unknown');
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

testAllowsFirstFrameGenerationWithoutExistingFirstFrame();
testAllowsFirstFrameGenerationForStaleStoryboardSlot();
testBlocksFreshButHashMismatch();
testBlocksLegacyUnknown();
testAllowsVideoPromptGenerationWithoutExistingPrompt();
testBlocksVideoPromptGenerationWithoutFirstFrame();

console.log('test-batch-preflight: ok');
