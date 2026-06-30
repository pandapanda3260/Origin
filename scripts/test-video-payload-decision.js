#!/usr/bin/env node
const assert = require('node:assert/strict');
process.env.ORIGIN_MULTI_SHOT_SEGMENT = '1';
const {
  deriveVideoSubmitInputMode,
  resolveVideoPayloadDecision,
  normalizeTailFrameReferenceStatus,
  computeFirstLastFeatureEnabled,
} = require('../lib/video-payload-decision.ts');

function decision(overrides = {}) {
  return resolveVideoPayloadDecision({
    submitMode: 'auto',
    firstLastFeatureEnabled: true,
    capabilityFirstLastSupported: true,
    firstFramePath: '/tmp/first.png',
    tailFramePath: '/tmp/tail.png',
    tailFrameUrl: '/api/images/file/00000000-0000-0000-0000-000000000002',
    tailReferenceStatus: 'ready',
    tailIntentRequested: true,
    independentMultiImageCapable: true,
    ...overrides,
  });
}

function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

function pick(d) {
  return {
    submitMode: d.submitMode,
    payloadMode: d.payloadMode,
    effectiveStrategy: d.effectiveStrategy,
    reason: d.reason,
    hardFail: d.hardFail,
    failureCode: d.failureCode,
    hasFirstLast: !!d.firstLastFrameMode,
    warningReason: d.warning && d.warning.reason,
  };
}

function testNormalizeStatus() {
  eq(normalizeTailFrameReferenceStatus({}), 'missing', 'empty status = missing');
  eq(normalizeTailFrameReferenceStatus({ tailFrameUrl: '/x', tailFramePath: '/tmp/tail.png' }), 'ready', 'legacy url+path = ready');
  eq(normalizeTailFrameReferenceStatus({ tailFrameUrl: '/x' }), 'file_missing', 'legacy url without path = file_missing');
  // 历史脏数据里的 'stale' 状态被剥离: 旧 status='stale' 但 url+path 都正常时落回 ready,
  // 这是"系统不再自动 stale 尾帧"原则的一部分, 让旧数据自然消化。
  eq(normalizeTailFrameReferenceStatus({ status: 'stale', tailFrameUrl: '/x', tailFramePath: '/tmp/tail.png' }), 'ready', 'legacy stale + url + path = ready');
  eq(normalizeTailFrameReferenceStatus({ status: 'stale', tailFrameUrl: '/x' }), 'file_missing', 'legacy stale without path = file_missing');
  eq(normalizeTailFrameReferenceStatus({ status: 'pending' }), 'missing', 'historical pending without url = missing');
  eq(normalizeTailFrameReferenceStatus({ status: 'pending', tailFrameUrl: '/x', tailFramePath: '/tmp/tail.png' }), 'pending', 'pending with url remains pending');
}

function testAutoMatrix() {
  const cases = [
    ['missing', null, { payloadMode: 'first_frame_multi_ref', effectiveStrategy: 'reference_images', reason: 'tail_missing', hardFail: false, warningReason: 'tail_missing' }],
    ['pending', '/tmp/tail.png', { payloadMode: 'first_frame_multi_ref', effectiveStrategy: 'strict_first_frame', reason: 'tail_pending', hardFail: true, failureCode: 'tail_frame_pending' }],
    ['ready', '/tmp/tail.png', { payloadMode: 'first_last_frame', effectiveStrategy: 'first_last_frame', reason: 'tail_ready', hardFail: false, hasFirstLast: true }],
    ['failed', '/tmp/tail.png', { payloadMode: 'first_frame_multi_ref', effectiveStrategy: 'reference_images', reason: 'tail_failed', hardFail: false, warningReason: 'tail_failed' }],
    ['file_missing', '', { payloadMode: 'first_frame_multi_ref', effectiveStrategy: 'reference_images', reason: 'tail_file_missing', hardFail: false, warningReason: 'tail_file_missing' }],
  ];
  for (const [status, tailFramePath, expected] of cases) {
    const got = pick(decision({ tailReferenceStatus: status, tailFramePath }));
    eq(
      {
        payloadMode: got.payloadMode,
        effectiveStrategy: got.effectiveStrategy,
        reason: got.reason,
        hardFail: got.hardFail,
        ...(got.failureCode ? { failureCode: got.failureCode } : {}),
        ...(got.hasFirstLast ? { hasFirstLast: got.hasFirstLast } : {}),
        ...(got.warningReason ? { warningReason: got.warningReason } : {}),
      },
      expected,
      `auto status=${status}`,
    );
  }
}

function testExplicitFirstLastMatrix() {
  eq(
    pick(decision({ submitMode: 'first_last_frame' })),
    {
      submitMode: 'first_last_frame',
      payloadMode: 'first_last_frame',
      effectiveStrategy: 'first_last_frame',
      reason: 'tail_ready',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: true,
      warningReason: undefined,
    },
    'explicit first-last ready uses first-last payload',
  );
  const cases = [
    ['missing', null, 'reference_images', false, undefined, 'tail_missing'],
    ['pending', '/tmp/tail.png', 'strict_first_frame', true, 'first_last_frame_tail_pending', undefined],
    ['failed', '/tmp/tail.png', 'reference_images', false, undefined, 'tail_failed'],
    ['file_missing', '', 'reference_images', false, undefined, 'tail_file_missing'],
  ];
  for (const [status, tailFramePath, effectiveStrategy, hardFail, failureCode, warningReason] of cases) {
    const got = pick(decision({ submitMode: 'first_last_frame', tailReferenceStatus: status, tailFramePath }));
    eq(
      { payloadMode: got.payloadMode, effectiveStrategy: got.effectiveStrategy, reason: got.reason, hardFail: got.hardFail, failureCode: got.failureCode, warningReason: got.warningReason },
      { payloadMode: 'first_frame_multi_ref', effectiveStrategy, reason: status === 'missing' ? 'tail_missing' : status === 'file_missing' ? 'tail_file_missing' : `tail_${status}`, hardFail, failureCode, warningReason },
      `explicit first-last status=${status}`,
    );
  }
}

function testCapabilityAndFeature() {
  eq(
    pick(decision({ capabilityFirstLastSupported: false })),
    {
      submitMode: 'auto',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'capability_unsupported',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: undefined,
    },
    'auto capability unsupported silently falls back',
  );
  eq(
    pick(decision({ submitMode: 'first_last_frame', capabilityFirstLastSupported: false })),
    {
      submitMode: 'first_last_frame',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'capability_unsupported',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: 'capability_unsupported',
    },
    'explicit capability unsupported falls back with a warning',
  );
  eq(pick(decision({ firstLastFeatureEnabled: false })).reason, 'feature_disabled', 'feature disabled reason');
  eq(
    pick(decision({ submitMode: 'first_last_frame', firstLastFeatureEnabled: false })).warningReason,
    'feature_disabled',
    'explicit first-last warns when feature is disabled',
  );
}

function testFirstFrameAndIntent() {
  eq(
    pick(decision({ firstFramePath: '' })).failureCode,
    'preflight_missing_first_frame',
    'missing first frame blocks by default',
  );
  eq(
    pick(decision({ tailIntentRequested: false })),
    {
      submitMode: 'auto',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'no_tail_intent',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: undefined,
    },
    'auto without tail intent stays strict-first-frame',
  );
  eq(
    pick(decision({ submitMode: 'first_last_frame', tailIntentRequested: false })),
    {
      submitMode: 'first_last_frame',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'no_tail_intent',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: 'no_tail_intent',
    },
    'explicit first-last without tail intent falls back with a warning',
  );
}

function testOtherModes() {
  eq(pick(decision({ submitMode: 'strict_first_frame' })).reason, 'strict_first_frame', 'strict_first_frame mode');
  eq(
    pick(decision({ submitMode: 'strict_first_frame' })).effectiveStrategy,
    'strict_first_frame',
    'strict_first_frame effective strategy',
  );
  eq(
    pick(decision({ submitMode: 'reference_images', firstFramePath: '' })),
    {
      submitMode: 'reference_images',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'first_frame_missing',
      hardFail: true,
      failureCode: 'preflight_missing_first_frame',
      hasFirstLast: false,
      warningReason: undefined,
    },
    'reference_images without first frame blocks in decision layer',
  );
  eq(
    {
      warning: decision({ submitMode: 'reference_images', tailReferenceStatus: 'pending' }).warning,
      hardFail: decision({ submitMode: 'reference_images', tailReferenceStatus: 'pending' }).hardFail,
      effectiveStrategy: decision({ submitMode: 'reference_images', tailReferenceStatus: 'pending' }).effectiveStrategy,
    },
    {
      warning: undefined,
      hardFail: false,
      effectiveStrategy: 'reference_images',
    },
    'reference_images with pending tail stays quiet',
  );
  eq(
    pick(decision({ submitMode: 'reference_images', independentMultiImageCapable: false })),
    {
      submitMode: 'reference_images',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'reference_images',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: 'reference_images_mode',
    },
    'reference_images falls back to strict first frame when independent multi-image is disabled',
  );
  eq(
    pick(decision({ multiShotSegment: true })),
    {
      submitMode: 'auto',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'reference_images',
      reason: 'reference_images',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: undefined,
    },
    'merged segment uses reference images when independent multi-image is available',
  );
  eq(
    pick(decision({ multiShotSegment: true, independentMultiImageCapable: false })),
    {
      submitMode: 'auto',
      payloadMode: 'first_frame_multi_ref',
      effectiveStrategy: 'strict_first_frame',
      reason: 'reference_images',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: 'reference_images_mode',
    },
    'merged segment falls back to strict first frame when independent multi-image is disabled',
  );
}

function testSubmitInputModeHelper() {
  eq(
    deriveVideoSubmitInputMode(decision({ tailReferenceStatus: 'missing', tailFramePath: null })),
    {
      seedanceImageMode: 'reference_images',
      useIndependentReferenceImages: true,
    },
    'tail missing with independent multi-image uses reference_images submit input',
  );
  eq(
    deriveVideoSubmitInputMode(decision({ tailReferenceStatus: 'missing', tailFramePath: null, independentMultiImageCapable: false })),
    {
      seedanceImageMode: 'strict_first_frame',
      useIndependentReferenceImages: false,
    },
    'tail missing without independent multi-image uses strict first-frame submit input',
  );
  eq(
    deriveVideoSubmitInputMode(decision()),
    {
      seedanceImageMode: 'strict_first_frame',
      useIndependentReferenceImages: false,
    },
    'first-last payload does not use independent reference image submit input',
  );
}

function testFeatureEnabledTruthTable() {
  const modes = ['auto', 'strict_first_frame', 'first_last_frame', 'reference_images'];
  for (const adminAllowsFirstLast of [false, true]) {
    for (const submitMode of modes) {
      for (const configuredSubmitMode of modes) {
        const actual = computeFirstLastFeatureEnabled({
          submitMode,
          configuredSubmitMode,
          adminAllowsFirstLast,
        });
        const expected =
          adminAllowsFirstLast &&
          (submitMode === 'auto' || submitMode === 'first_last_frame');
        eq(
          actual,
          expected,
          `feature truth table admin=${adminAllowsFirstLast} submit=${submitMode} configured=${configuredSubmitMode}`,
        );
      }
    }
  }
}

testNormalizeStatus();
testFeatureEnabledTruthTable();
testAutoMatrix();
testExplicitFirstLastMatrix();
testCapabilityAndFeature();
testFirstFrameAndIntent();
testOtherModes();
testSubmitInputModeHelper();

console.log('test-video-payload-decision: ok');
