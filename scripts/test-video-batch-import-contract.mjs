import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const videoTasksSource = readFileSync(new URL('../public/modules/videoTasks.js', import.meta.url), 'utf8');

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `${message}: missing ${first}`);
  assert.notEqual(secondIndex, -1, `${message}: missing ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

function extractFunction(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

assert.doesNotMatch(
  videoTasksSource,
  /if \(snap\.completedAt\) return;/,
  'video reattach must not treat completedAt as the only terminal signal',
);

const terminalStatusSource = extractFunction(videoTasksSource, 'isTerminalBatchStatus');
for (const status of ['completed', 'succeeded', 'failed', 'cancelled', 'partial']) {
  assert.match(
    terminalStatusSource,
    new RegExp(`normalized === "${status}"`),
    `isTerminalBatchStatus must cover ${status}`,
  );
}

const runningStatusSource = extractFunction(videoTasksSource, 'isRunningBatchStatus');
for (const status of ['queued', 'running']) {
  assert.match(
    runningStatusSource,
    new RegExp(`normalized === "${status}"`),
    `isRunningBatchStatus must cover ${status}`,
  );
}

assert.match(
  videoTasksSource,
  /already > 0 && skipped === 0 && failed === 0[\s\S]*?所有已生成片段都已导入剪辑工作台/,
  'bulk import must preserve the already-imported toast branch',
);

assertBefore(
  videoTasksSource,
  'showToast("导入失败，请重试或刷新", "warn");',
  'showToast("暂无新的可导入片段，未生成或未就绪的片段已跳过", "warn");',
  'bulk import must report import failures before skipped-not-ready segments',
);

assertBefore(
  videoTasksSource,
  'showToast("片段导入失败，请刷新后重试", "warn");',
  'showToast("还有片段未生成或未就绪，暂不能进入剪辑", "warn");',
  'confirm-enter-edit must report import failures before skipped-not-ready segments',
);

assert.match(
  videoTasksSource,
  /showToast\("暂无可导入片段，请先生成片段视频", "warn"\);/,
  'bulk import must preserve the original empty-state toast',
);

assert.match(
  videoTasksSource,
  /showToast\("暂无可进入剪辑的片段，请先生成片段视频", "warn"\);/,
  'confirm-enter-edit must preserve the original empty-state toast',
);

assert.match(
  videoTasksSource,
  /var batchStatus = b\.status \|\| snap\.status \|\| "";[\s\S]*?if \(isTerminalBatchStatus\(batchStatus\)\) return;[\s\S]*?if \(!isRunningBatchStatus\(batchStatus\)\) return;[\s\S]*?_setBatchStartDisabled\(true\)/,
  'reattach must skip terminal/non-running batches before disabling start controls',
);

assert.match(
  videoTasksSource,
  /if \(isTerminalBatchStatus\(snap\.status\)\)[\s\S]*?_stopReatPoll\(\);[\s\S]*?_setBatchStartDisabled\(false\);/,
  'reattach polling must use the shared terminal batch status helper',
);

assert.match(
  videoTasksSource,
  /if \(isTerminalBatchStatus\(snap\.status\)\)[\s\S]*?_stopPoll\(\);[\s\S]*?_setBatchStartDisabled\(false\);/,
  'start-batch polling must use the shared terminal batch status helper',
);

console.log('test-video-batch-import-contract passed');
