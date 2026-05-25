import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { checkAndRecordFirstFrameRewriteCall } from '../lib/first-frame-rewrite-rate-limit';

function makeDb() {
  return new Database(':memory:');
}

{
  const db = makeDb();
  const env = {
    FIRST_FRAME_REWRITE_MIN_INTERVAL_MS: '8000',
    FIRST_FRAME_REWRITE_DAILY_LIMIT: '10',
  };

  const first = checkAndRecordFirstFrameRewriteCall(
    { userId: 1, projectId: 'project-a', groupIdx: 0 },
    { db, env, now: new Date('2026-05-22T00:00:00.000Z') },
  );
  assert.equal(first.allowed, true);

  const second = checkAndRecordFirstFrameRewriteCall(
    { userId: 1, projectId: 'project-a', groupIdx: 1 },
    { db, env, now: new Date('2026-05-22T00:00:04.000Z') },
  );
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'first_frame_rewrite_interval_limited');
  assert.ok((second.retryAfterMs || 0) >= 3000);

  const third = checkAndRecordFirstFrameRewriteCall(
    { userId: 1, projectId: 'project-a', groupIdx: 0 },
    { db, env, now: new Date('2026-05-22T00:00:09.000Z') },
  );
  assert.equal(third.allowed, true);
  db.close();
}

{
  const db = makeDb();
  const env = {
    FIRST_FRAME_REWRITE_MIN_INTERVAL_MS: '0',
    FIRST_FRAME_REWRITE_DAILY_LIMIT: '2',
  };

  assert.equal(checkAndRecordFirstFrameRewriteCall(
    { userId: 2, projectId: 'project-a', groupIdx: 0 },
    { db, env, now: new Date('2026-05-22T00:00:00.000Z') },
  ).allowed, true);
  assert.equal(checkAndRecordFirstFrameRewriteCall(
    { userId: 2, projectId: 'project-b', groupIdx: 0 },
    { db, env, now: new Date('2026-05-22T00:00:01.000Z') },
  ).allowed, true);

  const limited = checkAndRecordFirstFrameRewriteCall(
    { userId: 2, projectId: 'project-c', groupIdx: 0 },
    { db, env, now: new Date('2026-05-22T00:00:02.000Z') },
  );
  assert.equal(limited.allowed, false);
  assert.equal(limited.code, 'first_frame_rewrite_daily_limited');
  db.close();
}

{
  const warnings: unknown[] = [];
  const result = checkAndRecordFirstFrameRewriteCall(
    { userId: 3, projectId: 'project-a', groupIdx: 0 },
    {
      db: {
        exec() {
          throw new Error('db unavailable');
        },
        prepare() {
          throw new Error('db unavailable');
        },
        transaction(fn: any) {
          return fn;
        },
      },
      logger: {
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      },
    },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.failOpen, true);
  assert.equal(warnings.length, 1);
}

console.log('test-first-frame-rewrite-rate-limit passed');
