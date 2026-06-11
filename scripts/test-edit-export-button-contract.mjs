import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/edit.js', import.meta.url), 'utf8');

function section(start, end) {
  const startIdx = source.indexOf(start);
  assert.notEqual(startIdx, -1, `missing section start: ${start}`);
  const endIdx = source.indexOf(end, startIdx);
  assert.notEqual(endIdx, -1, `missing section end: ${end}`);
  return source.slice(startIdx, endIdx);
}

const exportStateSection = section('function _getEditExportState()', 'function _syncEditExportButtonState()');
const exportClickSection = section('function _handleEditExportClick', 'function _attachExportStream');

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

assert.match(
  exportStateSection,
  /state: "not-composed"[\s\S]*label: "下载导出"[\s\S]*sub: "Download"[\s\S]*disabled: true/,
  'download button must stay disabled when the timeline has clips but no completed composed export',
);

assert.doesNotMatch(
  exportStateSection,
  /state: "export"[\s\S]*disabled: false/,
  'download button must not expose an enabled export-start state',
);

assert.match(
  exportClickSection,
  /state\.state === "download"[\s\S]*_downloadExportFile\(editData\.exportUrl, \{ force: true \}\)/,
  'download click must only trigger a real file download when exportUrl is ready',
);

assert.doesNotMatch(
  exportClickSection,
  /_exportEditVideo\(/,
  'download click must not start a background export task',
);

assert.doesNotMatch(
  source,
  /async function _exportEditVideo\(/,
  'manual export starter should not remain wired to the download button module',
);

console.log('edit export button contract tests passed');
