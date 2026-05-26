import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatClips, makeBlackVideo, probeMediaStreamDurations } from '../lib/ffmpeg';

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), 'origin-edit-export-concat-'));
  try {
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

    console.log(JSON.stringify({ ok: true, outputPath, durations, expectedDuration }));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
