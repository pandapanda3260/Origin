import assert from 'node:assert/strict';
import { getProductionRuntimeGuardSummary } from '../lib/runtime-health';

function violations(env: Record<string, string | undefined>) {
  return getProductionRuntimeGuardSummary(env).violations;
}

assert.deepEqual(
  violations({
    NODE_ENV: 'development',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_BATCH_RECOVERY_ENABLED: '1',
  }),
  [],
);

assert.ok(
  violations({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_EXPECT_WORKER: '1',
    ORIGIN_BATCH_RECOVERY_ENABLED: '1',
  }).includes('ORIGIN_BATCH_RECOVERY_ENABLED must be worker-only in production'),
);

assert.ok(
  violations({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'web',
    ORIGIN_EXPECT_WORKER: '1',
    BATCH_RECOVERY_ENABLED: '1',
  }).includes('ORIGIN_BATCH_RECOVERY_ENABLED must be worker-only in production'),
);

assert.ok(
  !violations({
    NODE_ENV: 'production',
    ORIGIN_PROCESS_ROLE: 'worker',
    ORIGIN_EXPECT_WORKER: '1',
    ORIGIN_BATCH_RECOVERY_ENABLED: '1',
  }).includes('ORIGIN_BATCH_RECOVERY_ENABLED must be worker-only in production'),
);

console.log('[runtime-health-guards] smoke passed');
