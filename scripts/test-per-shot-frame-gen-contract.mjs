import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const executorSrc = readFileSync(new URL('../lib/batch-executors.ts', import.meta.url), 'utf8');

assert(
  executorSrc.includes('isPerShotFirstFrameEnabled'),
  'storyboard_images executor must be gated by ORIGIN_PER_SHOT_FIRST_FRAME',
);
assert(
  executorSrc.includes('findTargetShotIndexForPerShot'),
  'storyboard_images executor must resolve target shotUid on the server',
);
assert(
  executorSrc.includes('per_shot_first_frame_requires_structured_mode'),
  'per-shot first frame must not fall back to legacy_pencil generation',
);
assert(
  executorSrc.includes('generationShotIndices = planShotIndices'),
  'per-shot generation must use primary-first plan shot order',
);
assert(
  executorSrc.includes('explicitShotIndices: perShotTarget ? shotIndices : generationShotIndices'),
  'per-shot write guard must keep original group shotIndices binding',
);
assert(
  executorSrc.includes('appendShotFrameCandidate'),
  'per-shot writeback must append a shotFrames candidate',
);
assert(
  executorSrc.includes('mirrorSelectedFirstFrameToLegacyFields'),
  'per-shot writeback must mirror the selected leading-shot candidate to legacy fields',
);

const appendIndex = executorSrc.indexOf('shotFrames[perShotTarget.shotUid] = appendShotFrameCandidate');
assert(appendIndex >= 0, 'per-shot writeback append statement is missing');
const perShotWriteStart = executorSrc.lastIndexOf('if (perShotTarget) {', appendIndex);
const perShotWriteEnd = executorSrc.indexOf('const {\n', appendIndex);
assert(perShotWriteStart >= 0 && perShotWriteEnd > appendIndex, 'per-shot writeback block bounds are missing');
const perShotWriteWindow = executorSrc.slice(perShotWriteStart, perShotWriteEnd);
assert(
  !perShotWriteWindow.includes('markFirstFrameReady'),
  'per-shot candidate writeback must not call markFirstFrameReady or revive firstFrame.history',
);

const perShotReturnStart = executorSrc.indexOf('if (perShotTarget) {', executorSrc.indexOf('recordBatchKnowledgeAudit'));
assert(perShotReturnStart >= 0, 'per-shot executor return block is missing');
const afterPerShotReturnStart = executorSrc.slice(perShotReturnStart + 1);
const legacyReturnMatch = /return\s*\{\s*resultUrl:\s*result\.url,\s*patch:\s*\{\s*type:\s*'storyboard_image'[\s\S]*?firstFrameUrl:\s*result\.url/.exec(afterPerShotReturnStart);
const legacyReturnStart = legacyReturnMatch ? perShotReturnStart + 1 + legacyReturnMatch.index : -1;
assert(legacyReturnStart > perShotReturnStart, 'legacy return block must remain after per-shot return block');
const perShotReturnBlock = executorSrc.slice(perShotReturnStart, legacyReturnStart);
const firstFrameUrlIndex = perShotReturnBlock.indexOf('perShotPatch.firstFrameUrl');
const leadingIfIndex = perShotReturnBlock.indexOf('if (isLeadingShot) {');
assert(firstFrameUrlIndex >= 0 && leadingIfIndex >= 0, 'leading-shot legacy return guard is missing');
assert(
  firstFrameUrlIndex > leadingIfIndex,
  'per-shot non-leading return must not include legacy firstFrameUrl fields',
);
assert(
  perShotReturnBlock.includes('perShotExtra.perShotFirstFrame') || perShotReturnBlock.includes('perShotFirstFrame: true'),
  'per-shot extra must be explicitly tagged for later UI handling',
);

console.log('test-per-shot-frame-gen-contract: ok');
