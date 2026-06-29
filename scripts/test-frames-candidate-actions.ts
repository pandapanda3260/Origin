import assert from 'node:assert/strict';
import { applyShotFrameCandidateAction, normalizeShotFrameState, type ShotFrameCandidate } from '../lib/shot-frame-candidates';

function candidate(id: string, day: number, url = `/img/${id}.png`): ShotFrameCandidate {
  return {
    id,
    url,
    source: 'gen',
    mode: 'structured_v1',
    status: 'ready',
    createdAt: `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    prompt: `prompt ${id}`,
    sourceHash: `hash-${id}`,
  };
}

function projectFixture() {
  return {
    shots: [{ shotUid: 'shot-a' }, { shotUid: 'shot-b' }],
    storyboards: [{
      idx: 0,
      shotIndices: [0, 1],
      firstFrameUrl: '/old.png',
      firstFrameMode: 'structured_v1',
      videoUrl: '/video.mp4',
      videoIsCurrent: true,
      shotFrames: {
        'shot-a': normalizeShotFrameState({
          candidates: [candidate('a1', 1, '/a1.png'), candidate('a2', 2, '/a2.png'), candidate('a3', 3, '/a3.png')],
          selectedCandidateId: 'a1',
        }),
        'shot-b': normalizeShotFrameState({
          candidates: [candidate('b1', 1, '/b1.png')],
          selectedCandidateId: 'b1',
        }),
      },
    }],
    videoTasks: [{ taskId: 'video-task', isCurrent: true }],
  };
}

{
  const result = applyShotFrameCandidateAction(projectFixture(), {
    action: 'select',
    groupIdx: 0,
    shotUid: 'shot-a',
    candidateId: 'a2',
  });
  const sb = result.project.storyboards[0];
  assert.equal(result.state.selectedCandidateId, 'a2', 'select updates selected candidate');
  assert.equal(sb.firstFrameUrl, '/a2.png', 'leading shot select mirrors legacy first frame');
  assert.equal(sb.videoIsCurrent, false, 'leading shot select invalidates storyboard video');
  assert.equal(result.project.videoTasks[0].isCurrent, false, 'leading shot select invalidates video task');
}

{
  const result = applyShotFrameCandidateAction(projectFixture(), {
    action: 'reorder',
    groupIdx: 0,
    shotUid: 'shot-a',
    orderedIds: ['a2', 'a1', 'a3'],
  });
  assert.deepEqual(result.state.candidates.map((item) => item.id), ['a2', 'a1', 'a3'], 'reorder preserves requested display order');
  assert.equal(result.state.selectedCandidateId, 'a3', 'dragging to the right selects the last candidate');
}

{
  const result = applyShotFrameCandidateAction(projectFixture(), {
    action: 'delete',
    groupIdx: 0,
    shotUid: 'shot-a',
    candidateId: 'a1',
  });
  assert.equal(result.state.selectedCandidateId, 'a2', 'deleting selected candidate falls back to adjacent candidate');
  assert.equal(result.project.storyboards[0].firstFrameUrl, '/a2.png', 'delete fallback is re-mirrored');
}

{
  const result = applyShotFrameCandidateAction(projectFixture(), {
    action: 'select',
    groupIdx: 0,
    shotUid: 'shot-b',
    candidateId: 'b1',
  });
  assert.equal(result.project.storyboards[0].firstFrameUrl, '/old.png', 'non-leading shot action does not mirror legacy first frame');
  assert.equal(result.project.storyboards[0].videoIsCurrent, true, 'non-leading shot action does not invalidate storyboard video');
  assert.equal(result.project.videoTasks[0].isCurrent, true, 'non-leading shot action does not invalidate video task');
}

assert.throws(
  () => applyShotFrameCandidateAction(projectFixture(), {
    action: 'select',
    groupIdx: 0,
    shotUid: 'wrong-id',
    candidateId: 'a1',
  }),
  /shot_uid_not_in_group/,
  'server-side guard rejects shotUid outside the group',
);

assert.throws(
  () => applyShotFrameCandidateAction(projectFixture(), {
    action: 'reorder',
    groupIdx: 0,
    shotUid: 'shot-a',
    orderedIds: ['a1', 'a2'],
  }),
  /invalid_candidate_order/,
  'reorder must include the complete candidate set',
);

console.log('test-frames-candidate-actions: ok');
