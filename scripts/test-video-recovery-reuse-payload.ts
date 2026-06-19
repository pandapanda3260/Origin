import assert from 'node:assert/strict';
import { buildRecoveredVideoReusePayload } from '../lib/video-gen';

const payload = buildRecoveredVideoReusePayload(
  { id: 42, username: 'tester' } as any,
  {
    id: 'video-task-reused',
    filename: '片段2（12）新项目2.mp4',
    cover_image_id: 'cover-reused',
    duration_sec: 8.25,
  },
  4,
);

assert.equal(payload.protectedUrl, '/api/videos/file/video-task-reused');
assert.equal(payload.filename, '片段2（12）新项目2.mp4');
assert.equal(payload.displayName, '片段2（12）新项目2');
assert.equal(payload.downloadFilename, '片段2（12）新项目2.mp4');
assert.equal(payload.coverUrl, '/api/images/file/cover-reused');
assert.equal(payload.durationSec, 8.25);
assert.equal(payload.mode, 'real');

console.log('[video-recovery-reuse-payload] smoke passed');
