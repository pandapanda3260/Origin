import assert from 'node:assert/strict';
import {
  cleanStaleRunningComposeRuns,
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

console.log('edit auto-compose state tests passed');
