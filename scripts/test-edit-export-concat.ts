import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { normalizeVideoAspectRatio, resolveVideoAspectRatio } from '../lib/aspect-ratio';
import {
  burnSubtitles,
  concatClips,
  extractCover,
  makeBlackVideo,
  probeMediaStreamDurations,
  probeVideoDimensions,
} from '../lib/ffmpeg';

function assertAspectRatioHelpers() {
  assert.deepEqual(
    normalizeVideoAspectRatio('1:1'),
    { ratio: '1:1', size: '1024x1024', width: 1024, height: 1024 },
  );
  assert.deepEqual(
    normalizeVideoAspectRatio('3:4'),
    { ratio: '9:16', size: '1080x1920', width: 1080, height: 1920 },
  );
  assert.deepEqual(
    normalizeVideoAspectRatio('21:9'),
    { ratio: '16:9', size: '1920x1080', width: 1920, height: 1080 },
  );
  assert.deepEqual(
    normalizeVideoAspectRatio('4:3'),
    { ratio: '16:9', size: '1920x1080', width: 1920, height: 1080 },
  );
  assert.equal(
    resolveVideoAspectRatio({ styleBibleGenerationContext: { aspectRatio: '16:9' } }),
    '9:16',
  );
  assert.equal(
    resolveVideoAspectRatio({ styleOptions: { aspectRatio: '1:1' }, styleBible: { aspectRatio: '16:9' } }),
    '1:1',
  );
  assert.equal(
    resolveVideoAspectRatio({ styleOptions: { aspectRatio: '1:1' } }, '3:4'),
    '3:4',
  );
}

async function assertMixedCutFadeConcat(tempDir: string) {
  const clipCount = 12;
  const clipDurationSec = 1.5;
  const fadeDurationSec = 0.5;
  const clipPaths: string[] = [];

  for (let i = 0; i < clipCount; i++) {
    const outputPath = join(tempDir, `clip-${i}.mp4`);
    await makeBlackVideo({
      outputPath,
      durationSec: clipDurationSec,
      width: 320,
      height: 180,
      color: i % 2 === 0 ? 'black' : '0x101010',
      withTone: true,
    });
    clipPaths.push(outputPath);
  }

  const outputPath = join(tempDir, 'mixed-cut-fade.mp4');
  await concatClips({
    clips: clipPaths.map((path, i) => ({
      path,
      inSec: 0,
      outSec: clipDurationSec,
      transitionIn: i === 5 ? 'fade' : 'cut',
      transitionInDuration: i === 5 ? fadeDurationSec : 0,
    })),
    outputPath,
    width: 320,
    height: 180,
    fps: 24,
  });

  const durations = await probeMediaStreamDurations(outputPath);
  const expectedDuration = clipCount * clipDurationSec - fadeDurationSec;
  const videoDrift = Math.abs(durations.videoSec - expectedDuration);
  const audioDrift = Math.abs(durations.audioSec - expectedDuration);
  const streamDrift = Math.abs(durations.videoSec - durations.audioSec);

  assert.ok(
    videoDrift < 0.25,
    `video duration drift too high: expected=${expectedDuration}, got=${durations.videoSec}`,
  );
  assert.ok(
    audioDrift < 0.25,
    `audio duration drift too high: expected=${expectedDuration}, got=${durations.audioSec}`,
  );
  assert.ok(
    streamDrift < 0.25,
    `audio/video duration mismatch: video=${durations.videoSec}, audio=${durations.audioSec}`,
  );

  return { outputPath, durations, expectedDuration };
}

async function assertVerticalConcat(tempDir: string) {
  const clipPaths: string[] = [];
  for (let i = 0; i < 2; i++) {
    const outputPath = join(tempDir, `vertical-clip-${i}.mp4`);
    await makeBlackVideo({
      outputPath,
      durationSec: 0.7,
      width: 1080,
      height: 1920,
      color: i === 0 ? 'black' : '0x101010',
      withTone: true,
    });
    clipPaths.push(outputPath);
  }

  const outputPath = join(tempDir, 'vertical-concat.mp4');
  await concatClips({
    clips: clipPaths.map((path) => ({ path, inSec: 0, outSec: 0.7, transitionIn: 'cut', transitionInDuration: 0 })),
    outputPath,
    width: 1080,
    height: 1920,
    fps: 24,
  });

  const dimensions = await probeVideoDimensions(outputPath);
  assert.deepEqual(dimensions, { width: 1080, height: 1920 });
  return { outputPath, dimensions };
}

function countBrightPixels(ctx: any, region: { x: number; y: number; width: number; height: number }) {
  const image = ctx.getImageData(region.x, region.y, region.width, region.height);
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    const a = image.data[i + 3];
    if (a > 120 && r > 180 && g > 180 && b > 180) count += 1;
  }
  return count;
}

function findBrightBounds(ctx: any, region: { x: number; y: number; width: number; height: number }) {
  const image = ctx.getImageData(region.x, region.y, region.width, region.height);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const i = (y * region.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      if (a > 120 && r > 180 && g > 180 && b > 180) {
        minX = Math.min(minX, region.x + x);
        minY = Math.min(minY, region.y + y);
        maxX = Math.max(maxX, region.x + x);
        maxY = Math.max(maxY, region.y + y);
      }
    }
  }
  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

async function assertSubtitleSafeArea(tempDir: string) {
  const inputPath = join(tempDir, 'subtitle-input.mp4');
  const srtPath = join(tempDir, 'subtitle.srt');
  const outputPath = join(tempDir, 'subtitle-output.mp4');
  const framePath = join(tempDir, 'subtitle-frame.png');

  await makeBlackVideo({ outputPath: inputPath, durationSec: 2, width: 1080, height: 1920 });
  writeFileSync(
    srtPath,
    [
      '1',
      '00:00:00,000 --> 00:00:01,800',
      '一届不如一届我混沌圣地真要亡在我手上了又怎能就此认输继续向前',
      '',
    ].join('\n'),
    'utf-8',
  );

  await burnSubtitles({ videoPath: inputPath, srtPath, outputPath, width: 1080, height: 1920 });
  const dimensions = await probeVideoDimensions(outputPath);
  assert.deepEqual(dimensions, { width: 1080, height: 1920 });

  await extractCover({ videoPath: outputPath, outputPath: framePath });
  const frame = await loadImage(framePath);
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(frame, 0, 0);

  const leftEdgeBright = countBrightPixels(ctx, { x: 0, y: 1300, width: 70, height: 500 });
  const rightEdgeBright = countBrightPixels(ctx, { x: 1010, y: 1300, width: 70, height: 500 });
  const centerBright = countBrightPixels(ctx, { x: 80, y: 1300, width: 920, height: 500 });
  const brightBounds = findBrightBounds(ctx, { x: 80, y: 0, width: 920, height: 1920 });

  assert.equal(leftEdgeBright, 0, `subtitle leaked into left safety edge: ${leftEdgeBright} bright pixels`);
  assert.equal(rightEdgeBright, 0, `subtitle leaked into right safety edge: ${rightEdgeBright} bright pixels`);
  assert.ok(centerBright > 20, `subtitle did not render in active center area: ${centerBright} bright pixels`);
  assert.ok(brightBounds, 'subtitle did not produce measurable bright text bounds');
  assert.ok(
    brightBounds!.minY >= 1920 * 0.7 && brightBounds!.minY <= 1920 * 0.75,
    `portrait subtitle top is outside 70-75% band: ${brightBounds!.minY}`,
  );

  return { outputPath, dimensions, centerBright, brightBounds };
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'origin-edit-export-concat-'));
  try {
    assertAspectRatioHelpers();
    const concat = await assertMixedCutFadeConcat(tempDir);
    const vertical = await assertVerticalConcat(tempDir);
    const subtitles = await assertSubtitleSafeArea(tempDir);

    console.log(JSON.stringify({ ok: true, concat, vertical, subtitles }));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
