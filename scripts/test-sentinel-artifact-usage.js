#!/usr/bin/env node
const assert = require('node:assert/strict');
const {
  describeArtifactStatus,
  describeProjectArtifactStatus,
  evaluateShotPlanDimension,
} = require('../lib/sentinel');
const {
  computeShotPlanSourceHash,
  computeShotPlanSourceSnapshot,
} = require('../lib/project-dependency-state.ts');

function projectFixture() {
  const project = {
    id: 'proj_sentinel',
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
      {
        idx: 0,
        shotIdx: 1,
        shotIndices: [0],
        imageUrl: '/images/storyboard.png',
        videoPrompt: 'Camera follows the door opening.',
        videoPromptStatus: 'ready',
      },
    ],
    videoTasks: [{ taskId: 'v1', status: 'completed', isCurrent: true }],
    _staleFlags: {},
  };
  project.shotPlanStatus = 'ready';
  project.shotPlanSourceSnapshot = computeShotPlanSourceSnapshot(project);
  project.shotPlanSourceHash = computeShotPlanSourceHash(project);
  return project;
}

function testShotPlanSubDecision() {
  const project = projectFixture();
  const decision = evaluateShotPlanDimension(project);
  assert.equal(decision.usable, true, 'ready matching shot plan is usable');
  assert.equal(decision.freshness, 'fresh', 'matching shot plan is fresh');

  const flagDrift = { ...project, _staleFlags: { shotPlan: true } };
  const driftDecision = evaluateShotPlanDimension(flagDrift);
  assert.equal(driftDecision.usable, false, 'shotPlan stale flag blocks even if status is ready');
  assert(driftDecision.reasons.includes('shot_plan_stale'), 'stale flag reason is preserved');
  const driftArtifactDecision = describeArtifactStatus(flagDrift, {
    projectId: project.id,
    targetArtifact: 'shot_plan',
  });
  assert(driftArtifactDecision.staleFlagKeys.includes('shotPlan'), 'shotPlan stale flag key is surfaced');

  const hashMismatch = { ...project, script: `${project.script} 新增一句。`, _staleFlags: {} };
  const mismatchDecision = evaluateShotPlanDimension(hashMismatch);
  assert.equal(mismatchDecision.usable, false, 'hash mismatch blocks');
  assert.equal(mismatchDecision.freshness, 'fresh_but_hash_mismatch', 'hash mismatch keeps diagnostic freshness');

  const generatingMismatch = {
    ...project,
    script: `${project.script} 生成途中改动。`,
    shotPlanStatus: 'generating',
    shotPlanGenerationSourceHash: project.shotPlanSourceHash,
    shotPlanGenerationSourceSnapshot: project.shotPlanSourceSnapshot,
  };
  const generatingDecision = describeArtifactStatus(generatingMismatch, {
    projectId: project.id,
    targetArtifact: 'shot_plan',
  });
  assert.equal(generatingDecision.usability, 'BLOCKED', 'generating hash mismatch blocks before completion');
  assert.equal(generatingDecision.generation, 'generating', 'generation state remains visible');
  assert.equal(generatingDecision.freshness, 'stale', 'generating mismatch is stale');
  assert(generatingDecision.blockingReasons.includes('upstream_changed_during_generation'), 'generating mismatch reason is preserved');

  const failedWithoutHash = { ...project, shotPlanStatus: 'failed' };
  delete failedWithoutHash.shotPlanSourceHash;
  delete failedWithoutHash.shotPlanSourceSnapshot;
  const failedDecision = evaluateShotPlanDimension(failedWithoutHash);
  assert.equal(failedDecision.generation, 'failed', 'failed generation state is visible');
  assert.equal(failedDecision.freshness, 'legacy_unknown', 'failed shot plan without source hash is legacy unknown');
}

function testVideoPromptStaleFlagBlocks() {
  const project = {
    ...projectFixture(),
    _staleFlags: { video_prompt_0: true },
  };
  const decision = describeArtifactStatus(project, {
    projectId: project.id,
    targetArtifact: 'video_segment',
    groupIdx: 0,
  });
  assert.equal(decision.usability, 'BLOCKED', 'video_prompt stale flag blocks video segment');
  assert(decision.blockingReasons.includes('video_prompt_stale'), 'video prompt stale reason is blocking');
  assert.deepEqual(decision.staleFlagKeys, ['video_prompt_0'], 'decision records matched stale key');
}

function testGroupShotPromptFlagsBlock() {
  const project = {
    ...projectFixture(),
    _staleFlags: { shot_prompt_1: true },
  };
  const decision = describeArtifactStatus(project, {
    projectId: project.id,
    targetArtifact: 'storyboard_image',
    groupIdx: 0,
    shotIndices: [0, 1],
  });
  assert.equal(decision.usability, 'BLOCKED', 'any group shot prompt stale flag blocks storyboard image');
  assert(decision.blockingReasons.includes('shot_prompt_stale'), 'shot prompt stale reason is blocking');
  assert.deepEqual(decision.staleFlagKeys, ['shot_prompt_1'], 'matched shot prompt flag is recorded');
}

function testStoryboardImageFirstFrameBlocks() {
  const missing = projectFixture();
  missing.storyboards = [{
    idx: 0,
    shotIdx: 1,
    shotIndices: [0],
    videoPrompt: 'Camera follows the door opening.',
    videoPromptStatus: 'ready',
  }];
  const missingDecision = describeArtifactStatus(missing, {
    projectId: missing.id,
    targetArtifact: 'storyboard_image',
    groupIdx: 0,
  });
  assert.equal(missingDecision.usability, 'BLOCKED', 'missing first frame blocks storyboard image use');
  assert(missingDecision.blockingReasons.includes('first_frame_missing'), 'missing first frame reason is blocking');

  const failed = projectFixture();
  failed.storyboards = [{
    idx: 0,
    shotIdx: 1,
    shotIndices: [0],
    firstFrame: { status: 'failed', lastError: { message: 'generation failed' } },
    videoPrompt: 'Camera follows the door opening.',
    videoPromptStatus: 'ready',
  }];
  const failedDecision = describeArtifactStatus(failed, {
    projectId: failed.id,
    targetArtifact: 'storyboard_image',
    groupIdx: 0,
  });
  assert.equal(failedDecision.usability, 'BLOCKED', 'failed first frame blocks storyboard image use');
  assert(failedDecision.blockingReasons.includes('first_frame_failed'), 'failed first frame reason is blocking');
}

function testStoryboardImageGenerationAllowsMissingFirstFrame() {
  const project = projectFixture();
  project.storyboards = [{
    idx: 0,
    shotIdx: 1,
    shotIndices: [0],
    videoPrompt: 'Camera follows the door opening.',
    videoPromptStatus: 'ready',
  }];
  const decision = describeArtifactStatus(project, {
    projectId: project.id,
    targetArtifact: 'storyboard_image_generation',
    groupIdx: 0,
  });
  assert.equal(decision.usability, 'USABLE', 'first-frame generation does not require an existing first frame');
  assert(!decision.blockingReasons.includes('first_frame_missing'), 'generation path does not block on first_frame_missing');
}

function testStoryboardImageGenerationStillBlocksStaleInputs() {
  const promptStale = {
    ...projectFixture(),
    _staleFlags: { shot_prompt_0: true },
  };
  promptStale.storyboards = [{ idx: 0, shotIdx: 1, shotIndices: [0] }];
  const promptDecision = describeArtifactStatus(promptStale, {
    projectId: promptStale.id,
    targetArtifact: 'storyboard_image_generation',
    groupIdx: 0,
    shotIndices: [0],
  });
  assert.equal(promptDecision.usability, 'BLOCKED', 'first-frame generation still blocks stale shot prompts');
  assert(promptDecision.blockingReasons.includes('shot_prompt_stale'), 'shot prompt stale reason is preserved');

  const storyboardStale = {
    ...projectFixture(),
    _staleFlags: { storyboard_0: true },
  };
  storyboardStale.storyboards = [{ idx: 0, shotIdx: 1, shotIndices: [0] }];
  const storyboardDecision = describeArtifactStatus(storyboardStale, {
    projectId: storyboardStale.id,
    targetArtifact: 'storyboard_image_generation',
    groupIdx: 0,
  });
  assert.equal(storyboardDecision.usability, 'BLOCKED', 'first-frame generation still blocks stale storyboard slots');
  assert(storyboardDecision.blockingReasons.includes('storyboard_stale'), 'storyboard stale reason is preserved');
}

function testStoryboardImageGenerationStillBlocksShotPlanStates() {
  const cases = [
    ['stale', 'shot_plan_stale'],
    ['legacy_unknown', 'shot_plan_legacy_unknown'],
    ['generating', 'shot_plan_generating'],
    ['failed', 'shot_plan_failed'],
  ];
  for (const [status, reason] of cases) {
    const project = projectFixture();
    project.shotPlanStatus = status;
    const decision = describeArtifactStatus(project, {
      projectId: project.id,
      targetArtifact: 'storyboard_image_generation',
      groupIdx: 0,
    });
    assert.equal(decision.usability, 'BLOCKED', `first-frame generation blocks shot plan status ${status}`);
    assert(decision.blockingReasons.includes(reason), `reason ${reason} is preserved`);
  }
}

function testVideoTaskOutdatedBlocks() {
  const project = projectFixture();
  project.videoTasks = [{ taskId: 'v1', status: 'completed', outdated: true, outdatedReason: 'shot_plan_changed' }];
  const decision = describeArtifactStatus(project, {
    projectId: project.id,
    targetArtifact: 'video_segment',
    groupIdx: 0,
  });
  assert.equal(decision.usability, 'BLOCKED', 'outdated video task blocks video segment use');
  assert(decision.blockingReasons.includes('video_task_outdated'), 'outdated reason is blocking');
}

function testPropagatedReasonsSurface() {
  const project = projectFixture();
  project._staleFlags = { storyboard_0: true };
  project.storyboards = [{ ...project.storyboards[0], staleSource: 'shot_plan', staleSourceReasons: ['emotion_changed'] }];
  const decision = describeArtifactStatus(project, {
    projectId: project.id,
    targetArtifact: 'video_prompt',
    groupIdx: 0,
  });
  assert.equal(decision.usability, 'BLOCKED', 'storyboard stale flag blocks video prompt');
  assert(decision.reasons.includes('propagated_from_shot_plan'), 'propagation reason is surfaced');
  assert.deepEqual(decision.upstreamStaleReasons, ['emotion_changed'], 'structured upstream reasons are preserved');
}

function testProjectArtifactStatusFiltering() {
  const project = {
    ...projectFixture(),
    _staleFlags: { video_prompt_0: true },
  };
  const blockedOnly = describeProjectArtifactStatus(project, project.id, {
    includeUsable: false,
    consumerOperation: 'compute_stale',
  });
  assert(blockedOnly.length > 0, 'blocked-only project status returns obsolete artifacts');
  assert(blockedOnly.every((decision) => decision.usability === 'BLOCKED'), 'blocked-only project status excludes usable decisions');
  assert(blockedOnly.some((decision) => decision.targetArtifact === 'video_prompt'), 'blocked video prompt decision is included');

  const withUsable = describeProjectArtifactStatus(project, project.id, {
    includeUsable: true,
    consumerOperation: 'compute_stale',
  });
  assert(withUsable.length > blockedOnly.length, 'includeUsable=true keeps usable decisions for expanded views');

  const obsolete = describeProjectArtifactStatus(project, project.id, {
    includeUsable: false,
    consumerOperation: 'detect_obsolete',
  });
  assert(obsolete.every((decision) => decision.usability === 'BLOCKED'), 'detect-obsolete helper returns only blocked decisions');
}

testShotPlanSubDecision();
testVideoPromptStaleFlagBlocks();
testGroupShotPromptFlagsBlock();
testStoryboardImageFirstFrameBlocks();
testStoryboardImageGenerationAllowsMissingFirstFrame();
testStoryboardImageGenerationStillBlocksStaleInputs();
testStoryboardImageGenerationStillBlocksShotPlanStates();
testVideoTaskOutdatedBlocks();
testPropagatedReasonsSurface();
testProjectArtifactStatusFiltering();

console.log('test-sentinel-artifact-usage: ok');
