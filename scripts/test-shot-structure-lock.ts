import assert from 'node:assert/strict';
import {
  hasShotStructureChange,
  SHOT_STRUCTURE_LOCK_BATCH_TYPES,
} from '../lib/shot-structure-lock';

const baseProject = {
  version: 3,
  segmentationMode: 'auto',
  shots: [
    { shotUid: 'shot-a', order: 1, visual: 'A' },
    { shotUid: 'shot-b', order: 2, visual: 'B' },
  ],
  storyboards: [
    { idx: 0, shotIndices: [0], videoPrompt: 'old' },
    { idx: 1, shotIndices: [1], videoPrompt: 'old' },
  ],
};

assert.deepEqual(
  SHOT_STRUCTURE_LOCK_BATCH_TYPES,
  ['shots', 'storyboard_prompts', 'storyboard_images', 'tail_frame_images', 'video_prompts', 'video_segments', 'videos'],
);

assert.equal(
  hasShotStructureChange(baseProject, { title: 'New title' }),
  false,
  'ordinary project fields must not trigger the shot structure lock',
);

assert.equal(
  hasShotStructureChange(baseProject, {
    shots: [
      { shotUid: 'shot-a', order: 1, visual: 'A updated' },
      { shotUid: 'shot-b', order: 2, visual: 'B' },
    ],
  }),
  false,
  'shot field edits with the same shotUid order must not trigger the structure lock',
);

assert.equal(
  hasShotStructureChange(baseProject, {
    shots: [
      { shotUid: 'shot-b', order: 1, visual: 'B' },
      { shotUid: 'shot-a', order: 2, visual: 'A' },
    ],
  }),
  true,
  'shotUid order changes must trigger the structure lock',
);

assert.equal(
  hasShotStructureChange(baseProject, {
    storyboards: [
      { idx: 0, shotIndices: [0], videoPrompt: 'new prompt' },
      { idx: 1, shotIndices: [1], videoPrompt: 'old' },
    ],
  }),
  false,
  'storyboard field edits with unchanged shotIndices must not trigger the structure lock',
);

assert.equal(
  hasShotStructureChange(baseProject, {
    storyboards: [
      { idx: 0, shotIndices: [0, 1] },
    ],
  }),
  true,
  'shotIndices changes must trigger the structure lock',
);

assert.equal(
  hasShotStructureChange(baseProject, { segmentationMode: 'manual' }),
  true,
  'segmentationMode changes must trigger the structure lock',
);

console.log('test-shot-structure-lock: ok');
