import assert from 'node:assert/strict';
import {
  attachExpectedShotBindingsToTargets,
  buildExpectedShotBinding,
  readExpectedShotBinding,
  shouldAttachExpectedShotBinding,
  writeGroupSlot,
} from '../lib/group-slot-write-guard';

const project = {
  shots: [
    { shotUid: 'shot-a', idx: 1 },
    { shotUid: 'shot-b', idx: 2 },
    { shotUid: 'shot-c', idx: 3 },
  ],
  storyboards: [
    { idx: 0, shotIndices: [0, 1] },
    { idx: 1, shotIndices: [2] },
  ],
};

assert.equal(shouldAttachExpectedShotBinding('video_prompts'), true);
assert.equal(shouldAttachExpectedShotBinding('storyboard_prompts'), true);
assert.equal(shouldAttachExpectedShotBinding('asset_images'), false);
assert.equal(shouldAttachExpectedShotBinding('shots'), false);

const binding = buildExpectedShotBinding(project, 0, { groupIdx: 0 });
assert.deepEqual(binding, {
  version: 1,
  groupIdx: 0,
  shotIndicesAtStart: [0, 1],
  shotUidsAtStart: ['shot-a', 'shot-b'],
  primaryShotUid: 'shot-a',
});

const enriched = attachExpectedShotBindingsToTargets(project, 'video_prompts', [{ groupIdx: 0 }, { groupIdx: 1 }]);
assert.equal(enriched.length, 2);
assert.deepEqual(readExpectedShotBinding(enriched[0]), binding);
assert.equal(readExpectedShotBinding(enriched[1])?.primaryShotUid, 'shot-c');

const assetTargets = [{ type: 'scene', idx: 0 }];
assert.equal(
  attachExpectedShotBindingsToTargets(project, 'asset_images', assetTargets),
  assetTargets,
  'asset_images targets must not be enriched or cloned',
);

let applied = false;
const appliedResult = writeGroupSlot({
  fresh: project,
  groupIdx: 0,
  storyboard: project.storyboards[0],
  expectedBinding: binding,
  mismatchPolicy: 'abortPatch',
  mutator: ({ shotIndices, firstShot }) => {
    applied = true;
    assert.deepEqual(shotIndices, [0, 1]);
    assert.equal(firstShot.shotUid, 'shot-a');
    return 'ok';
  },
});
assert.equal(applied, true);
assert.equal(appliedResult.status, 'applied');

const regrouped = {
  ...project,
  storyboards: [
    { idx: 0, shotIndices: [0] },
    { idx: 1, shotIndices: [1, 2] },
  ],
};
const skipped = writeGroupSlot({
  fresh: regrouped,
  groupIdx: 0,
  storyboard: regrouped.storyboards[0],
  expectedBinding: binding,
  mismatchPolicy: 'skip',
  mutator: () => {
    throw new Error('mutator should not run for skipped mismatches');
  },
});
assert.deepEqual(skipped, { status: 'skipped', reason: 'shot_binding_mismatch' });

const aborted = writeGroupSlot({
  fresh: regrouped,
  groupIdx: 0,
  storyboard: regrouped.storyboards[0],
  expectedBinding: binding,
  mismatchPolicy: 'abortPatch',
  mutator: () => {
    throw new Error('mutator should not run for aborted mismatches');
  },
});
assert.deepEqual(aborted, { status: 'aborted', reason: 'shot_binding_mismatch' });

console.log('test-group-slot-write-guard: ok');
