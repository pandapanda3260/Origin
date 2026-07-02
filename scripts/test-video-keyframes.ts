import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'origin-video-keyframes-'));
process.env.ORIGIN_DATA_DIR = root;
process.env.DB_PATH = join(root, 'qd.sqlite');

const ownerId = 7;
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

async function main() {
  const [{ getDb }, { collectSelectedShotKeyframes }] = await Promise.all([
    import('../lib/db'),
    import('../lib/video-keyframes'),
  ]);
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, display_name, password_hash)
    VALUES (@id, @username, @displayName, @passwordHash)
  `).run({
    id: ownerId,
    username: 'video-keyframes-test',
    displayName: 'video-keyframes-test',
    passwordHash: 'x',
  });

  const imageDir = join(root, 'images', String(ownerId));
  mkdirSync(imageDir, { recursive: true });
  ids.slice(0, 2).forEach((id) => writeFileSync(join(imageDir, `${id}.png`), Buffer.from('png')));
  ids.forEach((id) => {
    db.prepare(`
      INSERT OR REPLACE INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt)
      VALUES (@id, @ownerId, @projectId, 'storyboard', NULL, @filename, 'image/png', 3, 1, 1, '')
    `).run({
      id,
      ownerId,
      projectId: 'project-keyframes',
      filename: `${id}.png`,
    });
  });

  const project = {
    shots: [
      { shotUid: 'shot-a', duration: 3 },
      { shotUid: 'shot-b', duration: 5 },
      { shotUid: 'shot-c', duration: 7 },
    ],
  };
  const storyboard = {
    shotIndices: [0, 1, 2],
    shotFrames: {
      'shot-a': {
        candidates: [{ id: 'a1', url: `/api/images/file/${ids[0]}`, status: 'ready', createdAt: '2026-06-30T00:00:00.000Z' }],
        selectedCandidateId: 'a1',
      },
      'shot-b': {
        candidates: [{ id: 'b1', url: `/api/images/file/${ids[1]}`, status: 'ready', createdAt: '2026-06-30T00:01:00.000Z' }],
        selectedCandidateId: 'b1',
      },
      'shot-c': {
        candidates: [{ id: 'c1', url: `/api/images/file/${ids[2]}`, status: 'ready', createdAt: '2026-06-30T00:02:00.000Z' }],
        selectedCandidateId: 'c1',
      },
    },
  };

  const result = collectSelectedShotKeyframes({
    project,
    storyboard,
    shots: project.shots,
    groupShotIndices: [0, 1, 2],
    ownerId,
    durationSec: 20,
  });

  assert.equal(result.keyframes.length, 2, 'only resolvable selected candidates become keyframes');
  assert.deepEqual(
    result.keyframes.map((item) => ({ shotUid: item.shotUid, orderIndex: item.orderIndex, atSecHint: item.atSecHint, candidateId: item.candidateId })),
    [
      { shotUid: 'shot-a', orderIndex: 0, atSecHint: 0, candidateId: 'a1' },
      { shotUid: 'shot-b', orderIndex: 1, atSecHint: 3, candidateId: 'b1' },
    ],
    'keyframes preserve shot order and timing hints',
  );
  assert.deepEqual(
    result.dropped.map((item) => ({ shotUid: item.shotUid, reason: item.reason })),
    [{ shotUid: 'shot-c', reason: 'file_unresolvable' }],
    'unresolvable selected candidate is reported as dropped',
  );

  console.log('test-video-keyframes: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  rmSync(root, { recursive: true, force: true });
});
