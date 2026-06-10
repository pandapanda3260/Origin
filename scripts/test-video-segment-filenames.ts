import assert from 'node:assert/strict';
import {
  buildVideoSegmentContentDisposition,
  buildVideoSegmentNames,
  buildVideoSegmentNamesForRow,
  videoSegmentNameInputFromProject,
} from '../lib/video-segment-names';

const project = {
  id: 'proj_1',
  title: '第一章/混沌:圣地 收徒',
  currentEpisodeIdx: 0,
  episodes: [{ title: '第 1 集' }],
};

const names = buildVideoSegmentNames({
  ...videoSegmentNameInputFromProject(project),
  taskId: 'b487e6e0-74c2-4a29-af34-2edd3ca71453',
  groupIdx: 0,
});
assert.equal(
  names.displayName,
  '片段1_第1集_第一章混沌圣地 收徒',
);
assert.equal(names.filename, `${names.displayName}.mp4`);
assert.equal(names.downloadFilename, names.filename);

const copyNames = buildVideoSegmentNames({
  ...videoSegmentNameInputFromProject(project),
  taskId: 'b487e6e0-74c2-4a29-af34-2edd3ca71453',
  groupIdx: 0,
  copyIndex: 2,
});
assert.equal(
  copyNames.displayName,
  '片段1（2）_第1集_第一章混沌圣地 收徒',
);
assert.equal(copyNames.filename, `${copyNames.displayName}.mp4`);

const rowNames = buildVideoSegmentNamesForRow({
  id: 'task-id',
  project_id: 'proj_2',
  group_idx: 11,
  filename: 'task-id.mp4',
  project_title: '项目名',
  project_data_json: JSON.stringify({
    currentEpisodeIdx: 2,
    episodes: [{ title: '第1集' }, { title: '第2集' }, { title: '第三章' }],
  }),
});
assert.equal(rowNames.displayName, '片段12_第3集_项目名');

const storedNames = buildVideoSegmentNamesForRow({
  id: 'task-id',
  project_id: 'proj_2',
  group_idx: 11,
  filename: '片段12（3）_第3集_项目名.mp4',
  project_title: '项目名',
});
assert.equal(storedNames.filename, '片段12（3）_第3集_项目名.mp4');

const fallback = buildVideoSegmentNames({ taskId: 'plain-task' });
assert.equal(fallback.filename, 'plain-task.mp4');
assert.equal(fallback.displayName, 'plain-task');

const cd = buildVideoSegmentContentDisposition(names.downloadFilename, 'attachment');
assert.match(cd, /^attachment; filename="/);
assert.match(cd, /filename\*=UTF-8''/);

console.log('video segment filename tests passed');
