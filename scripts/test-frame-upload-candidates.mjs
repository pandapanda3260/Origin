import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const uploadSrc = readFileSync(new URL('../app/api/frames/upload/route.ts', import.meta.url), 'utf8');

assert(uploadSrc.includes('isPerShotFirstFrameEnabled'), 'upload route must be gated by ORIGIN_PER_SHOT_FIRST_FRAME');
assert(uploadSrc.includes('computeFirstFrameSourceHashForShot'), 'per-shot upload must compute per-shot sourceHash');
assert(uploadSrc.includes('canonicalShotUid'), 'per-shot upload must validate canonical shotUid membership');
assert(uploadSrc.includes('appendShotFrameCandidate'), 'per-shot upload must append a candidate');
assert(uploadSrc.includes('mirrorSelectedFirstFrameToLegacyFields'), 'leading per-shot upload must mirror legacy first-frame fields');
assert(
  uploadSrc.includes("frameType === 'first_frame' && isPerShotFirstFrameEnabled() && !shotUid"),
  'flag-on first-frame upload must require shotUid',
);
assert(uploadSrc.includes("throw new Error('shot_uid_not_in_group')"), 'upload route must reject shotUid outside the group');

const appendIndex = uploadSrc.indexOf('shotFrames[targetShotUid] = appendShotFrameCandidate');
assert(appendIndex >= 0, 'per-shot upload append statement is missing');
const perShotStart = uploadSrc.lastIndexOf('if (perShotFirstUpload) {', appendIndex);
const legacyBranchStart = uploadSrc.indexOf('} else {', appendIndex);
assert(perShotStart >= 0 && legacyBranchStart > appendIndex, 'per-shot upload block bounds are missing');
const perShotEnd = legacyBranchStart;
const perShotBlock = uploadSrc.slice(perShotStart, perShotEnd);
assert(!perShotBlock.includes('history:'), 'per-shot upload must not write firstFrame.history');
assert(perShotBlock.includes("source: 'upload'"), 'per-shot upload candidate source must be upload');
assert(perShotBlock.includes("mode: 'uploaded'"), 'per-shot upload candidate mode must be uploaded');
assert(perShotBlock.includes('assetId: id'), 'per-shot upload candidate must keep uploaded asset id');

const mirrorIndex = uploadSrc.indexOf('mirrorSelectedFirstFrameToLegacyFields', perShotEnd);
assert(mirrorIndex > appendIndex, 'per-shot upload must mirror after writing shotFrames');
assert(
  uploadSrc.includes('if (videoTasksPatch) basePatch.videoTasks = videoTasksPatch;'),
  'upload route must persist videoTasks invalidation from mirror helper',
);

console.log('test-frame-upload-candidates: ok');
