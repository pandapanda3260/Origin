import assert from 'node:assert/strict';
import {
  cleanStaleRunningComposeRuns,
  getComposeBootTs,
  hasActiveComposeRun,
  markExportFailureInEditData,
} from '../lib/edit-auto-compose-state';

const now = Date.now();
const staleIso = new Date(now - 11 * 60 * 1000).toISOString();
const freshIso = new Date(now - 60 * 1000).toISOString();

const stale = cleanStaleRunningComposeRuns({
  composeRuns: [{
    runId: 'stale-run',
    status: 'running',
    phase: 'export',
    heartbeatAt: staleIso,
    partial: false,
    skippedReasons: [],
    segmentFingerprint: 'seg-a',
    warnings: [],
    createdAt: staleIso,
    updatedAt: staleIso,
  }],
});

assert.equal(stale.changed, true);
assert.equal(stale.editData.composeRuns[0].status, 'failed');
assert.equal(stale.editData.composeRuns[0].errorCode, 'STALE_RUNNING_CLEANED');
assert.equal(hasActiveComposeRun(stale.editData), false);

const fresh = cleanStaleRunningComposeRuns({
  composeRuns: [{
    runId: 'fresh-run',
    status: 'running',
    phase: 'export',
    heartbeatAt: freshIso,
    partial: false,
    skippedReasons: [],
    segmentFingerprint: 'seg-b',
    warnings: [],
    createdAt: freshIso,
    updatedAt: freshIso,
  }],
});

assert.equal(fresh.changed, false);
assert.equal(hasActiveComposeRun(fresh.editData), true);

const failedExport = markExportFailureInEditData({
  exportTaskId: 'export-1',
  exportUrl: '',
  composeRuns: [{
    runId: 'run-export-1',
    status: 'running',
    phase: 'export',
    exportTaskId: 'export-1',
    heartbeatAt: freshIso,
    partial: false,
    skippedReasons: [],
    segmentFingerprint: 'seg-c',
    warnings: [],
    createdAt: freshIso,
    updatedAt: freshIso,
  }],
}, {
  exportTaskId: 'export-1',
  errorCode: 'EXPORT_TASK_MISSING',
  errorMessage: '导出任务记录消失',
});

assert.equal(failedExport.exportTaskId, '');
assert.equal(failedExport.composeRuns[0].status, 'failed');
assert.equal(failedExport.composeRuns[0].errorCode, 'EXPORT_TASK_MISSING');
assert.equal(hasActiveComposeRun(failedExport), false);

// ── 重启孤儿（bootTs）：心跳"新鲜"但早于本次进程启动 → 立即判孤儿，不等 10 分钟 ──
function makeRunningRun(runId: string, iso: string) {
  return {
    runId,
    status: 'running',
    phase: 'analyze',
    heartbeatAt: iso,
    partial: false,
    skippedReasons: [],
    segmentFingerprint: 'seg-boot',
    warnings: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

// 心跳 1 分钟前（未超 10 分钟窗口），但进程"刚刚"启动（bootTs = 30 秒前）→ 孤儿
const bootAfterHeartbeat = now - 30 * 1000;
const orphan = cleanStaleRunningComposeRuns(
  { composeRuns: [makeRunningRun('orphan-run', freshIso)] },
  undefined,
  bootAfterHeartbeat,
);
assert.equal(orphan.changed, true);
assert.equal(orphan.editData.composeRuns[0].status, 'failed');
assert.equal(orphan.editData.composeRuns[0].errorCode, 'ORPHANED_BY_RESTART');
assert.equal(hasActiveComposeRun(orphan.editData), false);

// 心跳晚于 bootTs（本进程内活任务）→ 不动
const bootBeforeHeartbeat = now - 5 * 60 * 1000;
const alive = cleanStaleRunningComposeRuns(
  { composeRuns: [makeRunningRun('alive-run', freshIso)] },
  undefined,
  bootBeforeHeartbeat,
);
assert.equal(alive.changed, false);
assert.equal(hasActiveComposeRun(alive.editData), true);

// 不传 bootTs：保持旧行为（只看 10 分钟窗口）
const legacyFresh = cleanStaleRunningComposeRuns(
  { composeRuns: [makeRunningRun('legacy-fresh-run', freshIso)] },
);
assert.equal(legacyFresh.changed, false);

// 超龄 + bootTs 之后：仍按超时清理（错误码走 STALE 而非 ORPHANED）
const staleButAfterBoot = cleanStaleRunningComposeRuns(
  { composeRuns: [makeRunningRun('stale-after-boot', staleIso)] },
  undefined,
  now - 20 * 60 * 1000,
);
assert.equal(staleButAfterBoot.changed, true);
assert.equal(staleButAfterBoot.editData.composeRuns[0].errorCode, 'STALE_RUNNING_CLEANED');

// getComposeBootTs：进程内单例且稳定
const boot1 = getComposeBootTs();
const boot2 = getComposeBootTs();
assert.equal(boot1, boot2);
assert.ok(Number.isFinite(boot1) && boot1 <= Date.now());

console.log('edit auto-compose state tests passed');
