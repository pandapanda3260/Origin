#!/usr/bin/env node
const assert = require('node:assert/strict');
const {
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
}

function testAutoMatrix() {
  const cases = [
    ['missing', null, { payloadMode: 'first_frame_multi_ref', reason: 'tail_missing', hardFail: false }],
    ['pending', '/tmp/tail.png', { payloadMode: 'first_frame_multi_ref', reason: 'tail_pending', hardFail: true, failureCode: 'tail_frame_pending' }],
    ['ready', '/tmp/tail.png', { payloadMode: 'first_last_frame', reason: 'tail_ready', hardFail: false, hasFirstLast: true }],
    ['failed', '/tmp/tail.png', { payloadMode: 'first_frame_multi_ref', reason: 'tail_failed', hardFail: false }],
    ['file_missing', '', { payloadMode: 'first_frame_multi_ref', reason: 'tail_file_missing', hardFail: false }],
  ];
  for (const [status, tailFramePath, expected] of cases) {
    const got = pick(decision({ tailReferenceStatus: status, tailFramePath }));
    eq(
      {
        payloadMode: got.payloadMode,
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
      reason: 'tail_ready',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: true,
      warningReason: undefined,
    },
    'explicit first-last ready uses first-last payload',
  );
  const cases = [
    ['missing', null, false, undefined],
    ['pending', '/tmp/tail.png', true, 'first_last_frame_tail_pending'],
    ['failed', '/tmp/tail.png', false, undefined],
    ['file_missing', '', false, undefined],
  ];
  for (const [status, tailFramePath, hardFail, failureCode] of cases) {
    const got = pick(decision({ submitMode: 'first_last_frame', tailReferenceStatus: status, tailFramePath }));
    eq(
      { payloadMode: got.payloadMode, reason: got.reason, hardFail: got.hardFail, failureCode: got.failureCode },
      { payloadMode: 'first_frame_multi_ref', reason: status === 'missing' ? 'tail_missing' : status === 'file_missing' ? 'tail_file_missing' : `tail_${status}`, hardFail, failureCode },
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
      reason: 'capability_unsupported',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: undefined,
    },
    'explicit capability unsupported silently falls back',
  );
  eq(pick(decision({ firstLastFeatureEnabled: false })).reason, 'feature_disabled', 'feature disabled reason');
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
      reason: 'no_tail_intent',
      hardFail: false,
      failureCode: undefined,
      hasFirstLast: false,
      warningReason: undefined,
    },
    'auto without tail intent stays strict-first-frame',
  );
  eq(
    pick(decision({ submitMode: 'first_last_frame', tailIntentRequested: false })).hardFail,
    false,
    'explicit first-last without tail intent silently falls back',
  );
}

function testOtherModes() {
  eq(pick(decision({ submitMode: 'strict_first_frame' })).reason, 'strict_first_frame', 'strict_first_frame mode');
  eq(pick(decision({ submitMode: 'reference_images', firstFramePath: '' })).reason, 'reference_images', 'reference_images remains explicit debug mode');
  eq(
    {
      warning: decision({ submitMode: 'reference_images', tailReferenceStatus: 'pending' }).warning,
      hardFail: decision({ submitMode: 'reference_images', tailReferenceStatus: 'pending' }).hardFail,
    },
    {
      warning: undefined,
      hardFail: false,
    },
    'reference_images with pending tail stays quiet',
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

console.log('test-video-payload-decision: ok');
