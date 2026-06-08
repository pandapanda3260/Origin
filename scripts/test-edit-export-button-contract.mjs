import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/edit.js', import.meta.url), 'utf8');

assert.match(
  source,
  /function _isComposeRunCoveredByExport\(run, editData\)[\s\S]*?editData\.exportUrl[\s\S]*?runTaskId === currentTaskId/,
  'download state must ignore running compose records already covered by the completed export',
);

assert.match(
  source,
  /AUTO_COMPOSE_RUNNING_STALE_MS = 10 \* 60 \* 1000/,
  'frontend running-state guard should share the 10 minute stale window',
);

assert.match(
  source,
  /setTimeout\(_tryResumeExportStream, 0\)/,
  'auto-compose stream interruptions after export start must resume export status observation',
);

assert.doesNotMatch(
  source,
  /_downloadExportFile\((url|downloadUrl)\);\s*showToast\("成片导出完成/,
  'export stream completion should unlock explicit download instead of auto-downloading',
);

console.log('edit export button contract tests passed');
