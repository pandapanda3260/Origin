import assert from 'node:assert/strict';
import {
  collectSegmentDialoguePairs,
  computeSegmentTempoBudget,
  buildSegmentShotPlan,
  buildEffectiveShotPlanForDuration,
  shouldMarkTailRushedAfterProbe,
} from '../lib/video-segment-runtime';

const shots = [
  {
    duration: 5,
    pace: 'normal',
    emotion: 'rising',
    shotType: '中景',
    camera: '固定镜头',
    dialogue: '接引长老（低声，几乎咬牙）："一届不如一届，难道我混沌圣地真要就此没落……"',
    tailFrameSignals: {
      actionLandingNeed: 2,
      visualTransformationNeed: 1,
      revealNeed: 2,
      endingCompositionNeed: 3,
      emotionPeakNeed: 3,
      isSimpleStaticDialogue: false,
    },
  },
  {
    duration: 5,
    pace: 'slow',
    emotion: 'resolution',
    shotType: '远景',
    camera: '固定镜头',
    dialogue: '旁白（冷冷一句）："那一年，混沌圣地以为自己要没落了。"',
    tailFrameSignals: {
      actionLandingNeed: 3,
      visualTransformationNeed: 2,
      revealNeed: 3,
      endingCompositionNeed: 5,
      emotionPeakNeed: 3,
      isSimpleStaticDialogue: false,
    },
  },
];

const segment5Dialogue = collectSegmentDialoguePairs(shots, [0]);
const segment5Plan = buildSegmentShotPlan(shots, [0]);
const segment5Budget = computeSegmentTempoBudget({
  dialoguePairs: segment5Dialogue,
  shotPlan: segment5Plan,
  plannedDurationSec: 5,
  durationSec: 5,
  payloadMode: 'first_frame_multi_ref',
  payloadModeReason: 'no_tail_intent',
});
assert.equal(segment5Budget.dialogueChars, 21);
assert.equal(segment5Budget.charsPerSecond, 3.2);
assert.equal(segment5Budget.requiredDurationSec, 8);
assert.equal(segment5Budget.safeDurationSec, 8);
assert.equal(segment5Budget.exceedsMaxDuration, false);

const segment9Dialogue = collectSegmentDialoguePairs(shots, [1]);
const segment9Plan = buildSegmentShotPlan(shots, [1]);
const segment9Budget = computeSegmentTempoBudget({
  dialoguePairs: segment9Dialogue,
  shotPlan: segment9Plan,
  plannedDurationSec: 5,
  durationSec: 5,
  payloadMode: 'first_last_frame',
  payloadModeReason: 'tail_ready',
  tailReferenceStatus: 'ready',
});
assert.equal(segment9Budget.dialogueChars, 15);
assert.equal(segment9Budget.charsPerSecond, 3.2);
assert.equal(segment9Budget.requiredDurationSec, 6);
assert.equal(segment9Budget.safeDurationSec, 6);

assert.equal(shouldMarkTailRushedAfterProbe(0, segment5Budget), false);
assert.equal(shouldMarkTailRushedAfterProbe(5.08, segment5Budget), true);
assert.equal(shouldMarkTailRushedAfterProbe(8.02, segment5Budget), false);

const longBudget = computeSegmentTempoBudget({
  dialoguePairs: [{
    speaker: '旁白',
    text: '这是一段非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长非常长的台词……',
  }],
  shotPlan: segment5Plan,
  plannedDurationSec: 15,
  durationSec: 15,
});
assert.equal(longBudget.exceedsMaxDuration, true);
assert.equal(longBudget.safeDurationSec, 15);

const distributedPlan = buildEffectiveShotPlanForDuration([
  { idx: 1, durationSec: 2, dialogueChars: 18, hasDialogue: true, pace: 'normal' },
  { idx: 2, durationSec: 2, pace: 'slow' },
  { idx: 3, durationSec: 2, pace: 'normal' },
], 9);
assert.equal(distributedPlan.reduce((sum, item) => sum + Number(item.durationSec || 0), 0), 9);
assert.ok(Number(distributedPlan[0].durationSec) > 2, 'dialogue-heavy shot should receive extra duration');
assert.ok(Number(distributedPlan[1].durationSec) > 2, 'slow shot should receive extra duration');
assert.equal(distributedPlan[2].durationSec, 2, 'extra duration should not be dumped into the last neutral shot');

const tailReadyOnlyBudget = computeSegmentTempoBudget({
  dialoguePairs: [{ speaker: '甲', text: '今天我们按计划推进项目' }],
  shotPlan: [{
    idx: 1,
    durationSec: 4,
    pace: 'normal',
    tailFrameSignals: {
      actionLandingNeed: 0,
      visualTransformationNeed: 0,
      revealNeed: 0,
      endingCompositionNeed: 0,
      emotionPeakNeed: 0,
      isSimpleStaticDialogue: false,
    },
  }],
  plannedDurationSec: 4,
  durationSec: 4,
  payloadMode: 'first_last_frame',
  payloadModeReason: 'tail_ready',
  tailReferenceStatus: 'ready',
});
assert.equal(tailReadyOnlyBudget.charsPerSecond, 4.0);
assert.equal(tailReadyOnlyBudget.endingReserveSec, 1.0);
assert.equal(tailReadyOnlyBudget.slowMarkers.includes('tail_ready'), false);

const simpleStaticBudget = computeSegmentTempoBudget({
  dialoguePairs: [{ speaker: '甲', text: '今天我们按计划推进项目' }],
  shotPlan: [{
    idx: 1,
    durationSec: 4,
    pace: 'normal',
    tailFrameSignals: {
      actionLandingNeed: 0,
      visualTransformationNeed: 0,
      revealNeed: 0,
      endingCompositionNeed: 0,
      emotionPeakNeed: 0,
      isSimpleStaticDialogue: true,
    },
  }],
  plannedDurationSec: 4,
  durationSec: 4,
});
assert.equal(simpleStaticBudget.charsPerSecond, 4.0);
assert.equal(simpleStaticBudget.slowMarkers.includes('tail_landing_need'), false);

console.log('test-video-segment-runtime: ok');
