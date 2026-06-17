const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const videoTasks = fs.readFileSync(path.join(root, 'public/modules/videoTasks.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'public/workspace.html'), 'utf8');

function section(src, start, end) {
  const startIdx = src.indexOf(start);
  assert(startIdx >= 0, `missing section start: ${start}`);
  const endIdx = end ? src.indexOf(end, startIdx + start.length) : -1;
  return src.slice(startIdx, endIdx >= 0 ? endIdx : undefined);
}

const helper = section(videoTasks, 'function _dropSupersededGroupTasks', '/* 2026-06');
assert(helper.includes('cleanupTask(t);'), 'superseded group cleanup should remove task cards and handles');
assert(helper.includes("videoState.tasks.splice(i, 1);"), 'superseded group cleanup should remove stale in-memory tasks');
assert(helper.includes("querySelector('[data-group-idx=\"' + n + '\"]')"), 'superseded group cleanup should remove stale mirror rows by group');

const historyBlock = section(videoTasks, '// Step 2: completed history', 'syncTaskListVisibility(); updateBadge(); _updateBatchTotalProgress();');
const cleanupIdx = historyBlock.indexOf('_dropSupersededGroupTasks(gIdx);');
const createIdx = historyBlock.indexOf('var task = createVideoTaskObj("片段 " + (gIdx + 1), false);');
assert(cleanupIdx >= 0, 'history reattach should clear stale group tasks');
assert(cleanupIdx < createIdx, 'history reattach should clear stale tasks before rebuilding the authoritative history task');

const finder = section(videoTasks, 'function _findTaskByGroup', 'async function renderBatchClipList');
assert(finder.includes('task._killed'), '_findTaskByGroup should ignore cleaned tasks');
assert(finder.includes("task._projectId && project && task._projectId !== project.id"), '_findTaskByGroup should ignore tasks from other projects');

assert(workspace.includes('"/modules/videoTasks.js": "/modules/videoTasks.js?v=307"'), 'workspace import map should bump videoTasks.js cache version');

console.log('video task history reattach contract ok');
