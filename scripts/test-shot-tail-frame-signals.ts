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
      // durationSec 跟产品边界保持一致 (3-7 秒, 见 public/modules/shots.js)。
      // 原值 8 已超出新范围, 测试覆盖意图 (isSimpleStaticDialogue 长台词判断) 用 7 同样能触发。
      durationSec: 7,
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

  assert.match(block, /const normalizedPlan = normalizeGeneratedShotPlan\(shotsArr,\s*\{/);
  assert.match(block, /shotsArr = normalizedPlan\.shots;/);

  const normalizerSource = readFileSync(join(process.cwd(), 'lib/shot-plan-normalize.ts'), 'utf8');
  assert.match(normalizerSource, /tailFrameSignals:\s*normalizeTailFrameSignals\(source,\s*\{/);
  assert.match(normalizerSource, /shotType:\s*fields\.shotType,\s*\n\s*camera:\s*fields\.camera,\s*\n\s*dialogue,\s*\n\s*durationSec:\s*duration/);
}

testPreservesAndClampsModelSignals();
testDefaultsMissingNeedSignalsToZero();
testSimpleStaticDialogueFallback();
testBatchExecutorKeepsSignalsInWriteShape();

console.log('test-shot-tail-frame-signals: ok');
