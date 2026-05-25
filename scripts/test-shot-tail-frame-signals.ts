import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTailFrameSignals } from '../lib/shot-tail-frame-signals';

function testPreservesAndClampsModelSignals() {
  const signals = normalizeTailFrameSignals(
    {
      tailFrameSignals: {
        actionLandingNeed: 5.4,
        visualTransformationNeed: '4',
        revealNeed: -1,
        endingCompositionNeed: 2.49,
        emotionPeakNeed: 9,
        isSimpleStaticDialogue: false,
      },
    },
    {
      shotType: '大全景',
      camera: '缓慢推进',
      dialogue: '——',
      durationSec: 5,
    },
  );

  assert.deepEqual(signals, {
    actionLandingNeed: 5,
    visualTransformationNeed: 4,
    revealNeed: 0,
    endingCompositionNeed: 2,
    emotionPeakNeed: 5,
    isSimpleStaticDialogue: false,
  });
}

function testDefaultsMissingNeedSignalsToZero() {
  const signals = normalizeTailFrameSignals(
    {},
    {
      shotType: '大全景',
      camera: '缓慢推进',
      dialogue: '——',
      durationSec: 5,
    },
  );

  assert.deepEqual(signals, {
    actionLandingNeed: 0,
    visualTransformationNeed: 0,
    revealNeed: 0,
    endingCompositionNeed: 0,
    emotionPeakNeed: 0,
    isSimpleStaticDialogue: false,
  });
}

function testSimpleStaticDialogueFallback() {
  const signals = normalizeTailFrameSignals(
    {},
    {
      shotType: '特写',
      camera: '固定镜头',
      dialogue: '萧南：我等了三年，也查了三年。今天这句话说完，我就不会再回头，也不会再替任何人沉默。你们欠下的每一笔账，我都会一件一件讨回来。',
      durationSec: 8,
    },
  );

  assert.equal(signals.isSimpleStaticDialogue, true);
}

function testBatchExecutorKeepsSignalsInWriteShape() {
  const source = readFileSync(join(process.cwd(), 'lib/batch-executors.ts'), 'utf8');
  const start = source.indexOf("registerExecutor('shots'");
  const end = source.indexOf('const storyboards = makeSingleShotStoryboardSlots', start);
  assert.ok(start >= 0 && end > start, 'shots executor block should be locatable');
  const block = source.slice(start, end);

  assert.match(block, /tailFrameSignals:\s*normalizeTailFrameSignals\(sh,\s*\{/);
  assert.match(block, /shotType,\s*\n\s*camera,\s*\n\s*dialogue:\s*finalDialogue,\s*\n\s*durationSec:\s*duration/);
}

testPreservesAndClampsModelSignals();
testDefaultsMissingNeedSignalsToZero();
testSimpleStaticDialogueFallback();
testBatchExecutorKeepsSignalsInWriteShape();

console.log('test-shot-tail-frame-signals: ok');
