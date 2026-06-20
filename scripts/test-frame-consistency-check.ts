import assert from 'node:assert/strict';
import {
  buildFrameConsistencyRetryDecision,
  normalizeFrameConsistencyCheckResult,
  selectFrameConsistencyReferences,
} from '../lib/frame-consistency-check';
import type { FrameReference } from '../lib/frame-image-plan';

const refs: FrameReference[] = [
  {
    slot: 1,
    imageNo: 1,
    role: 'character',
    assetName: '萧云',
    remoteUrl: '/api/images/file/char',
    localPath: '/tmp/char.png',
    textFallback: '萧云',
    delivery: 'image',
  },
  {
    slot: 2,
    imageNo: 2,
    role: 'scene',
    assetName: '客厅',
    remoteUrl: '/api/images/file/scene',
    localPath: '/tmp/scene.png',
    textFallback: '客厅',
    delivery: 'image',
  },
  {
    slot: 3,
    imageNo: 3,
    role: 'prop',
    assetName: '信封',
    remoteUrl: '/api/images/file/prop',
    localPath: '/tmp/prop.png',
    textFallback: '信封',
    delivery: 'image',
  },
];

{
  const result = normalizeFrameConsistencyCheckResult({
    frameType: 'first_frame',
    referenceManifest: refs,
    raw: {
      grade: 'pass',
      characterScore: 90,
      sceneScore: 82,
      propScore: 80,
    },
  });
  assert.equal(result.grade, 'pass');
}

{
  const result = normalizeFrameConsistencyCheckResult({
    frameType: 'first_frame',
    referenceManifest: refs,
    raw: {
      grade: 'pass',
      characterScore: 72,
      sceneScore: 82,
      propScore: 80,
      reasons: ['脸型略偏'],
    },
  });
  assert.equal(result.grade, 'warn');
  assert.deepEqual(result.reasons, ['脸型略偏']);
}

{
  const result = normalizeFrameConsistencyCheckResult({
    frameType: 'tail_frame',
    referenceManifest: refs,
    raw: {
      grade: 'pass',
      characterScore: 58,
      sceneScore: 82,
      propScore: 80,
      retryPromptHint: '重新锁定萧云脸型和服装。',
    },
  });
  assert.equal(result.grade, 'fail');
  const retry = buildFrameConsistencyRetryDecision({
    basePrompt: 'base prompt',
    check: result,
    attempt: 1,
    maxRetries: 2,
  });
  assert.equal(retry.shouldRetry, true);
  assert.match(retry.nextPrompt, /一致性重试修正/);
  assert.match(retry.nextPrompt, /重新锁定萧云脸型和服装/);
}

{
  const result = normalizeFrameConsistencyCheckResult({
    frameType: 'tail_frame',
    referenceManifest: refs,
    raw: {
      grade: 'warn',
      characterScore: 74,
    },
  });
  const retry = buildFrameConsistencyRetryDecision({
    basePrompt: 'base prompt',
    check: result,
    attempt: 1,
    maxRetries: 2,
  });
  assert.equal(retry.shouldRetry, false, 'warn should not trigger expensive redraw');
}

{
  const result = normalizeFrameConsistencyCheckResult({
    frameType: 'first_frame',
    referenceManifest: refs,
    raw: {
      grade: 'pass',
      severe: true,
      characterScore: 80,
    },
  });
  assert.equal(result.grade, 'fail', 'severe mismatch overrides numeric scores');
}

{
  const expandedRefs: FrameReference[] = [
    {
      slot: 1,
      imageNo: 1,
      role: 'character',
      assetId: 'xiao',
      assetName: '萧云',
      panel: 'sheet',
      entityType: 'human',
      localPath: '/tmp/xiao-sheet.png',
      remoteUrl: '/api/images/file/xiao-sheet',
      textFallback: 'sheet',
      delivery: 'image',
    },
    {
      slot: 2,
      imageNo: 2,
      role: 'character',
      assetId: 'xiao',
      assetName: '萧云',
      panel: 'headshot',
      entityType: 'human',
      localPath: '/tmp/xiao-head.png',
      remoteUrl: '/api/images/file/xiao-head',
      textFallback: 'head',
      delivery: 'image',
    },
    {
      slot: 3,
      imageNo: 3,
      role: 'character',
      assetId: 'xiao',
      assetName: '萧云',
      panel: 'front',
      entityType: 'human',
      localPath: '/tmp/xiao-front.png',
      remoteUrl: '/api/images/file/xiao-front',
      textFallback: 'front',
      delivery: 'image',
    },
    {
      slot: 4,
      imageNo: 4,
      role: 'character',
      assetId: 'support',
      assetName: '配角',
      panel: 'sheet',
      entityType: 'human',
      localPath: '/tmp/support-sheet.png',
      remoteUrl: '/api/images/file/support-sheet',
      textFallback: 'support',
      delivery: 'image',
    },
    {
      slot: 5,
      imageNo: 5,
      role: 'scene',
      assetName: '客厅',
      viewRole: 'establishing',
      localPath: '/tmp/scene.png',
      remoteUrl: '/api/images/file/scene',
      textFallback: 'scene',
      delivery: 'image',
    },
    {
      slot: 6,
      imageNo: 6,
      role: 'scene',
      assetName: '客厅',
      viewRole: 'topdown',
      localPath: '/tmp/scene-topdown.png',
      remoteUrl: '/api/images/file/scene-topdown',
      textFallback: 'topdown',
      delivery: 'image',
    },
    {
      slot: 7,
      imageNo: 7,
      role: 'prop',
      assetName: '信封',
      localPath: '/tmp/prop.png',
      remoteUrl: '/api/images/file/prop',
      textFallback: 'prop',
      delivery: 'image',
    },
    {
      slot: 8,
      imageNo: 8,
      role: 'crowd',
      assetName: '人群',
      localPath: '/tmp/crowd.png',
      remoteUrl: '/api/images/file/crowd',
      textFallback: 'crowd',
      delivery: 'image',
    },
  ];
  const selected = selectFrameConsistencyReferences({
    frameType: 'first_frame',
    referenceManifest: expandedRefs,
  } as any);
  assert.equal(selected.length, 6);
  assert.deepEqual(selected.map((ref) => `${ref.role}:${ref.assetName}:${ref.panel || ''}`), [
    'character:萧云:sheet',
    'character:萧云:headshot',
    'character:萧云:front',
    'scene:客厅:',
    'prop:信封:',
    'crowd:人群:',
  ]);
  assert.equal(selected.some((ref) => ref.role === 'scene' && ref.viewRole === 'topdown'), false, 'topdown layout anchor is not used as a frame consistency image');
}

{
  const selected = selectFrameConsistencyReferences({
    frameType: 'first_frame',
    referenceManifest: [
      {
        slot: 1,
        imageNo: 1,
        role: 'character',
        assetId: 'beast',
        assetName: '机械兽',
        panel: 'sheet',
        entityType: 'non-human',
        localPath: '/tmp/beast-sheet.png',
        remoteUrl: '/api/images/file/beast-sheet',
        textFallback: 'sheet',
        delivery: 'image',
      },
      {
        slot: 2,
        imageNo: 2,
        role: 'character',
        assetId: 'beast',
        assetName: '机械兽',
        panel: 'front',
        entityType: 'non-human',
        localPath: '/tmp/beast-front.png',
        remoteUrl: '/api/images/file/beast-front',
        textFallback: 'front',
        delivery: 'image',
      },
      {
        slot: 3,
        imageNo: 3,
        role: 'character',
        assetId: 'beast',
        assetName: '机械兽',
        panel: 'side',
        entityType: 'non-human',
        localPath: '/tmp/beast-side.png',
        remoteUrl: '/api/images/file/beast-side',
        textFallback: 'side',
        delivery: 'image',
      },
    ],
  } as any);
  assert.deepEqual(selected.map((ref) => ref.panel), ['sheet', 'front', 'side']);
  assert.equal(selected.every((ref) => ref.entityType === 'non-human'), true);
}

console.log('[test-frame-consistency-check] all assertions passed');
