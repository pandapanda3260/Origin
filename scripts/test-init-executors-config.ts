import assert from 'node:assert/strict';
import { computeExecutorRuntime } from '../lib/executor-runtime';

function runtime(env: Record<string, string | undefined>) {
  return computeExecutorRuntime(env);
}

assert.equal(
  runtime({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_EXPECT_WORKER: '1',
    ORIGIN_BATCH_RECOVERY_ENABLED: '1',
  }).recoveryEnabled,
  false,
);

assert.equal(
  runtime({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'worker',
    ORIGIN_EXPECT_WORKER: '1',
  }).recoveryEnabled,
  true,
);

assert.equal(
  runtime({
    NODE_ENV: 'development',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_EXPECT_WORKER: '0',
    ORIGIN_LOCAL_WORKER_IN_WEB: '1',
  }).recoveryEnabled,
  true,
);

assert.equal(
  runtime({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_EXPECT_WORKER: '1',
    WORKER_ENABLED: '1',
  }).workerProcess,
  true,
);

console.log('[init-executors-config] smoke passed');
