import assert from 'node:assert/strict';
import { expandStoryboardImageTargetsForPerShot } from '../lib/shot-frame-candidates';
import { isPerShotFirstFrameEnabled } from '../lib/feature-flags';

const previousFlag = process.env.ORIGIN_PER_SHOT_FIRST_FRAME;

try {
  process.env.ORIGIN_PER_SHOT_FIRST_FRAME = '0';
  assert.equal(isPerShotFirstFrameEnabled(), false, 'per-shot first frame flag defaults off when env is 0');
  process.env.ORIGIN_PER_SHOT_FIRST_FRAME = '1';
  assert.equal(isPerShotFirstFrameEnabled(), true, 'per-shot first frame flag reads env on');

  const project = {
    shots: [
      { shotUid: 'shot-a', id: 'wrong-a' },
      { shot_uid: 'shot-b', uid: 'wrong-b' },
      { shotUid: 'shot-c' },
    ],
    storyboards: [
      { idx: 0, shotIndices: [0, 1] },
      { idx: 1, shotIndices: [2] },
    ],
  };

  const expanded = expandStoryboardImageTargetsForPerShot(project, [{ groupIdx: 0, idx: 0, shotIndices: [0, 1] }]);
  assert.deepEqual(
    expanded.map((target) => ({ groupIdx: target.groupIdx, shotIdx: target.shotIdx, shotUid: target.shotUid, shotIndices: target.shotIndices })),
    [
      { groupIdx: 0, shotIdx: 0, shotUid: 'shot-a', shotIndices: [0, 1] },
      { groupIdx: 0, shotIdx: 1, shotUid: 'shot-b', shotIndices: [0, 1] },
    ],
    'group target expands into one target per canonical shotUid while keeping segment context shotIndices',
  );

  const single = expandStoryboardImageTargetsForPerShot(project, [{ groupIdx: 0, shotUid: 'shot-b' }]);
  assert.equal(single.length, 1, 'shotUid target stays single-shot');
  assert.equal(single[0].shotIdx, 1, 'shotUid target resolves its shot index inside the group');
  assert.deepEqual(single[0].shotIndices, [0, 1], 'single-shot target keeps group context shotIndices');

  assert.throws(
    () => expandStoryboardImageTargetsForPerShot(project, [{ groupIdx: 0, shotUid: 'wrong-b' }]),
    /shot_uid_not_in_group/,
    'id/uid fallback cannot be used as per-shot target identity',
  );

  assert.throws(
    () => expandStoryboardImageTargetsForPerShot({ shots: [{ id: 'legacy-only' }], storyboards: [{ shotIndices: [0] }] }, [{ groupIdx: 0 }]),
    /missing_shot_uid/,
    'legacy shots without canonical shotUid cannot write per-shot candidates',
  );

  console.log('test-batch-start-pershot-targets: ok');
} finally {
  if (previousFlag == null) delete process.env.ORIGIN_PER_SHOT_FIRST_FRAME;
  else process.env.ORIGIN_PER_SHOT_FIRST_FRAME = previousFlag;
}
