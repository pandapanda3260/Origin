import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { buildSeedanceMultiKeyframeBody } from '../lib/video-gen';

const root = mkdtempSync(join(tmpdir(), 'origin-video-mk-builder-'));

function imagePath(name: string, color: string): string {
  const canvas = createCanvas(320, 320);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 320, 320);
  const file = join(root, `${name}.png`);
  writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}

async function main() {
  const k1 = imagePath('k1', '#ff0000');
  const k2 = imagePath('k2', '#00ff00');
  const k3 = imagePath('k3', '#0000ff');
  const r1 = imagePath('r1', '#ffff00');
  const r2 = imagePath('r2', '#ff00ff');

  const body = await buildSeedanceMultiKeyframeBody({
    model: 'seedance-2-5-test',
    prompt: '测试多关键帧',
    keyframes: [
      { role: 'keyframe', path: k1, url: '/api/images/file/k1', shotUid: 'shot-a', shotIdx: 0, orderIndex: 0, candidateId: 'a', atSecHint: 0 },
      { role: 'keyframe', path: k2, url: '/api/images/file/k2', shotUid: 'shot-b', shotIdx: 1, orderIndex: 1, candidateId: 'b', atSecHint: 4 },
      { role: 'keyframe', path: k3, url: '/api/images/file/k3', shotUid: 'shot-c', shotIdx: 2, orderIndex: 2, candidateId: 'c', atSecHint: 8 },
    ],
    references: [
      { role: 'scene', path: k1, label: 'duplicate first keyframe', assetName: 'duplicate' },
      { role: 'scene', path: r1, label: 'scene reference', assetName: 'scene' },
      { role: 'prop', path: r2, label: 'prop reference', assetName: 'prop' },
    ],
    ratio: '9:16',
    durationSec: 12,
    resolution: '720p',
    generateAudio: true,
    referenceBudget: 50,
    maxImages: 4,
  });

  assert.equal(body.content.length, 5, 'text + 3 keyframes + 1 reference, capped by maxImages');
  assert.deepEqual(body.content.slice(1).map((item: any) => item.role), ['keyframe', 'keyframe', 'keyframe', 'reference_image']);
  assert.deepEqual(body.content.slice(1, 4).map((item: any) => item.at_sec), [0, 4, 8], 'keyframe timing hints are preserved');
  assert.equal(body.__submittedImages.keyframes.length, 3, 'all keyframes submitted first');
  assert.equal(body.__submittedImages.references.length, 1, 'only remaining image slot is used for references');
  assert.equal(body.__submittedImages.references[0].ref.path, r1, 'duplicate first keyframe is not re-submitted as a reference');
  assert.equal(body.__submittedImages.droppedReferenceCount, 2, 'duplicate and overflow references are counted as dropped');
  assert.equal(body.__submittedImages.adapterVersion, 'seedance_multi_keyframe_v1_unverified');

  console.log('test-video-multi-keyframe-builder: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  rmSync(root, { recursive: true, force: true });
});
