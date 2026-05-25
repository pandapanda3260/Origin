import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  elapsedGenerationSeconds,
  estimateRecentVideoGenerationSeconds,
} from '../lib/video-generation-estimate';

assert.equal(
  elapsedGenerationSeconds('2026-05-20T00:00:00.000Z', '2026-05-20T00:01:30.000Z'),
  90,
);
assert.equal(elapsedGenerationSeconds('bad', '2026-05-20T00:01:30.000Z'), null);
assert.equal(
  elapsedGenerationSeconds('2026-05-20T00:01:30.000Z', '2026-05-20T00:01:30.000Z'),
  null,
);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE video_tasks (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const insert = db.prepare(`
  INSERT INTO video_tasks (id, owner_id, status, created_at, updated_at)
  VALUES (@id, @ownerId, @status, @createdAt, @updatedAt)
`);

insert.run({
  id: 'older-10s',
  ownerId: 1,
  status: 'completed',
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:10.000Z',
});
insert.run({
  id: 'latest-20s',
  ownerId: 1,
  status: 'completed',
  createdAt: '2026-05-20T00:02:00.000Z',
  updatedAt: '2026-05-20T00:02:20.000Z',
});
insert.run({
  id: 'latest-30s',
  ownerId: 1,
  status: 'completed',
  createdAt: '2026-05-20T00:04:00.000Z',
  updatedAt: '2026-05-20T00:04:30.000Z',
});
insert.run({
  id: 'ignored-failed',
  ownerId: 1,
  status: 'failed',
  createdAt: '2026-05-20T00:05:00.000Z',
  updatedAt: '2026-05-20T00:08:00.000Z',
});
insert.run({
  id: 'ignored-owner',
  ownerId: 2,
  status: 'completed',
  createdAt: '2026-05-20T00:06:00.000Z',
  updatedAt: '2026-05-20T00:16:00.000Z',
});

const estimate = estimateRecentVideoGenerationSeconds(db, 1, 2);
assert.deepEqual(estimate, {
  averageSec: 25,
  sampleSize: 2,
  limit: 2,
  source: 'recent_completed_video_tasks',
});

const empty = estimateRecentVideoGenerationSeconds(db, 3, 10);
assert.equal(empty.averageSec, null);
assert.equal(empty.sampleSize, 0);

console.log('test-video-generation-estimate: ok');
