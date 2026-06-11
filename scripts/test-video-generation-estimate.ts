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
  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    batch_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE batch_tasks (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE video_tasks (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const insertBatch = db.prepare(`
  INSERT INTO batches (id, owner_id, batch_type, status, created_at, updated_at)
  VALUES (@id, @ownerId, @batchType, @status, @createdAt, @updatedAt)
`);
const insertBatchTask = db.prepare(`
  INSERT INTO batch_tasks (id, batch_id, status, created_at, updated_at)
  VALUES (@id, @batchId, @status, @createdAt, @updatedAt)
`);
const insert = db.prepare(`
  INSERT INTO video_tasks (id, owner_id, status, created_at, updated_at)
  VALUES (@id, @ownerId, @status, @createdAt, @updatedAt)
`);

insertBatch.run({
  id: 'batch-video',
  ownerId: 1,
  batchType: 'video_segments',
  status: 'completed',
  createdAt: '2026-05-20T00:01:00.000Z',
  updatedAt: '2026-05-20T00:03:00.000Z',
});
insertBatchTask.run({
  id: 'batch-task-35s',
  batchId: 'batch-video',
  status: 'completed',
  createdAt: '2026-05-20T00:02:00.000Z',
  updatedAt: '2026-05-20T00:02:35.000Z',
});
insertBatchTask.run({
  id: 'batch-task-45s',
  batchId: 'batch-video',
  status: 'completed',
  createdAt: '2026-05-20T00:04:00.000Z',
  updatedAt: '2026-05-20T00:04:45.000Z',
});
insertBatchTask.run({
  id: 'ignored-batch-outlier',
  batchId: 'batch-video',
  status: 'completed',
  createdAt: '2026-05-20T00:05:00.000Z',
  updatedAt: '2026-05-20T18:05:00.000Z',
});

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
insert.run({
  id: 'ignored-video-outlier',
  ownerId: 4,
  status: 'completed',
  createdAt: '2026-05-20T00:07:00.000Z',
  updatedAt: '2026-05-20T18:07:00.000Z',
});
insert.run({
  id: 'fallback-video-20s',
  ownerId: 4,
  status: 'completed',
  createdAt: '2026-05-20T00:08:00.000Z',
  updatedAt: '2026-05-20T00:08:20.000Z',
});

const estimate = estimateRecentVideoGenerationSeconds(db, 1, 2);
assert.deepEqual(estimate, {
  averageSec: 40,
  sampleSize: 2,
  limit: 2,
  source: 'recent_completed_batch_tasks',
});

const empty = estimateRecentVideoGenerationSeconds(db, 3, 10);
assert.equal(empty.averageSec, null);
assert.equal(empty.sampleSize, 0);

const fallback = estimateRecentVideoGenerationSeconds(db, 4, 10);
assert.deepEqual(fallback, {
  averageSec: 20,
  sampleSize: 1,
  limit: 10,
  source: 'recent_completed_video_tasks',
});

console.log('test-video-generation-estimate: ok');
