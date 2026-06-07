import assert from 'node:assert/strict';
import {
  resolveGroupImportDurationSec,
  resolveTrustedActualDurationSec,
} from '../lib/edit-duration-runtime';

{
  const project = {
    storyboards: [{ videoDurationSec: 7.2, videoTaskId: 'task-a', videoIsCurrent: true }],
    videoTasks: [{ taskId: 'task-a', status: 'completed', isCurrent: true, durationSec: 6 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 7.2);
  assert.equal(resolveGroupImportDurationSec(project, 0), 7.2);
}

{
  const project = {
    storyboards: [{ videoTaskId: 'task-a', videoIsCurrent: true }],
    videoTasks: [{ taskId: 'task-a', status: 'completed', isCurrent: true, duration_sec: 8 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 8);
  assert.equal(resolveGroupImportDurationSec(project, 0), 8);
}

{
  const project = {
    storyboards: [{ videoTaskId: 'task-a', videoIsCurrent: true, plannedDurationSec: 6 }],
    videoTasks: [{ taskId: 'task-b', status: 'completed', isCurrent: true, durationSec: 9 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 0);
  assert.equal(resolveGroupImportDurationSec(project, 0), 6);
}

{
  const project = {
    storyboards: [{ videoTaskId: 'task-a', videoIsCurrent: true, plannedDurationSec: 6 }],
    videoTasks: [{ taskId: 'task-a', status: 'running', isCurrent: true, durationSec: 9 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 0);
  assert.equal(resolveGroupImportDurationSec(project, 0), 6);
}

{
  const project = {
    storyboards: [{ durationSec: 4.5, shotIndices: [0, 1] }],
    shots: [{ durationSec: 1 }, { duration: 2 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 0);
  assert.equal(resolveGroupImportDurationSec(project, 0), 4.5);
}

{
  const project = {
    storyboards: [{ shotIndices: [0, 1] }],
    shots: [{ durationSec: 1 }, { duration: 2 }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 0);
  assert.equal(resolveGroupImportDurationSec(project, 0), 3);
}

{
  const project = {
    storyboards: [{ shots: [{ durationSec: 1 }, { duration: 2 }] }],
  };
  assert.equal(resolveTrustedActualDurationSec(project, 0), 0);
  assert.equal(resolveGroupImportDurationSec(project, 0), 3);
}

{
  assert.equal(resolveTrustedActualDurationSec({ storyboards: [] }, 0), 0);
  assert.equal(resolveGroupImportDurationSec({ storyboards: [] }, 0), 5);
}

console.log('test-edit-duration-runtime: ok');
