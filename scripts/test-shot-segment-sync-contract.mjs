import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/shots.js', import.meta.url), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`export function ${name}`);
  assert(start >= 0, `${name} must exist`);
  const next = source.indexOf('\nexport function ', start + 20);
  return source.slice(start, next > 0 ? next : undefined);
}

const afterDelete = functionBody('_syncSingleShotSlotsAfterDelete');
const afterInsert = functionBody('_syncSingleShotSlotsAfterInsert');
const swapAdjacent = functionBody('_swapAdjacentShotSlots');

assert.match(source, /function _segmentSlot\(/, 'segment-aware slot helper must exist');
assert.doesNotMatch(afterDelete, /_singleShotSlot\(/, 'delete sync must not flatten groups into 1:1 slots');
assert.doesNotMatch(afterInsert, /_singleShotSlot\(/, 'insert sync must not flatten groups into 1:1 slots');
assert.match(afterDelete, /groupIdxRemap/, 'delete sync must remap group-indexed edit data');
assert.match(afterInsert, /groupIdxRemap/, 'insert sync must remap group-indexed edit data');
assert.match(afterDelete, /_archiveStoryboardSlot/, 'delete sync must keep storyboard archive semantics');
assert.match(swapAdjacent, /_remapEditDataGroups/, 'adjacent swap must remap group-indexed edit data when slots move');
assert.match(swapAdjacent, /segment_boundary/, 'adjacent swap must refuse unsafe multi-shot boundary swaps');
assert.doesNotMatch(swapAdjacent, /_singleShotSlot\(/, 'adjacent swap must not flatten groups into 1:1 slots');

console.log('test-shot-segment-sync-contract: ok');
