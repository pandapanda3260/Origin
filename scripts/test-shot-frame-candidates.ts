import assert from 'node:assert/strict';
import {
  MAX_SHOT_FRAME_CANDIDATES,
  appendShotFrameCandidate,
  mirrorSelectedFirstFrameToLegacyFields,
  normalizeShotFrameState,
  type ShotFrameCandidate,
} from '../lib/shot-frame-candidates';

function candidate(id: string, day: number, extra: Partial<ShotFrameCandidate> = {}): ShotFrameCandidate {
  return {
    id,
    url: `/img/${id}.png`,
    source: 'gen',
    mode: 'structured_v1',
    status: 'ready',
    createdAt: `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    prompt: `prompt ${id}`,
    sourceHash: `hash-${id}`,
    taskId: `task-${id}`,
    planSummary: { id, heavy: true },
    safetyAudit: { correlationId: `corr-${id}`, generatedImageId: `image-${id}`, moderationRecovered: false, detail: 'heavy' },
    consistencyCheck: { grade: 'pass', id },
    consistencyAttempts: 1,
    consistencyStatus: 'pass',
    visualAnchorDescription: `anchor ${id}`,
    ...extra,
  };
}

{
  const reordered = [
    candidate('c-newest', 20),
    candidate('c-oldest', 1),
    candidate('c-selected-old', 2),
    ...Array.from({ length: 10 }, (_, idx) => candidate(`c-mid-${idx}`, 3 + idx)),
  ];
  const normalized = normalizeShotFrameState({
    candidates: reordered,
    selectedCandidateId: 'c-selected-old',
  });
  assert.equal(normalized.candidates.length, MAX_SHOT_FRAME_CANDIDATES, 'candidate cap is enforced');
  assert(normalized.candidates.some((item) => item.id === 'c-selected-old'), 'selected candidate is never pruned');
  assert(!normalized.candidates.some((item) => item.id === 'c-oldest'), 'time-oldest unselected candidate is pruned after reorder');
  assert.equal(normalized.candidates[0].id, 'c-newest', 'display order is not re-sorted by time');
}

{
  const state = Array.from({ length: 5 }, (_, idx) => candidate(`c-${idx}`, idx + 1));
  const normalized = normalizeShotFrameState({ candidates: state, selectedCandidateId: 'c-0' });
  const selected = normalized.candidates.find((item) => item.id === 'c-0')!;
  const compact = normalized.candidates.find((item) => item.id === 'c-1')!;
  assert.equal(selected.metadataTier, 'full', 'selected candidate keeps full metadata');
  assert.equal(compact.metadataTier, 'compact', 'older non-selected candidate is compacted');
  assert.equal(compact.planSummary, undefined, 'compact candidate drops heavy plan summary');
  assert.equal(compact.safetyAudit, undefined, 'compact candidate drops heavy safety audit');
  assert.deepEqual(compact.safetyAuditRef, {
    correlationId: 'corr-c-1',
    generatedImageId: 'image-c-1',
    moderationRecovered: false,
  }, 'compact candidate keeps lightweight audit ref');
}

{
  const state = appendShotFrameCandidate(
    { candidates: [candidate('old', 1)], selectedCandidateId: 'old' },
    candidate('new', 2, { source: 'upload', mode: 'uploaded' }),
  );
  assert.equal(state.selectedCandidateId, 'new', 'append selects newest candidate');
  assert.equal(state.candidates.length, 2, 'append does not overwrite prior candidate');
}

{
  const project: any = {
    shots: [{ shotUid: 'shot-a' }],
    storyboards: [{
      idx: 0,
      shotIndices: [0],
      firstFrameUrl: '/old.png',
      firstFrameMode: 'structured_v1',
      firstFrame: { currentUrl: '/old.png', history: [{ url: '/old.png' }] },
      frames: { first: { url: '/old.png', status: 'ready', mode: 'structured_v1' } },
      videoUrl: '/video.mp4',
      videoIsCurrent: true,
      shotFrames: {
        'shot-a': normalizeShotFrameState({
          candidates: [candidate('selected', 1, { url: '/new.png', mode: 'multi_ref_v1' })],
          selectedCandidateId: 'selected',
        }),
      },
    }],
    videoTasks: [{ taskId: 'video-task', isCurrent: true }],
  };
  const result = mirrorSelectedFirstFrameToLegacyFields(project, 0, {
    shotUid: 'shot-a',
    now: '2026-06-29T00:00:00.000Z',
  });
  const sb = result.project.storyboards[0];
  const vt = result.project.videoTasks[0];
  assert.equal(sb.firstFrameUrl, '/new.png', 'mirror updates firstFrameUrl');
  assert.equal(sb.firstFrameMode, 'multi_ref_v1', 'mirror updates firstFrameMode');
  assert.equal(sb.frames.first.status, 'ready', 'mirror writes frames.first.status');
  assert.equal(sb.firstFrame.history, undefined, 'mirror does not revive firstFrame.history');
  assert.equal(sb.videoIsCurrent, false, 'mirror invalidates storyboard video');
  assert.equal(vt.isCurrent, false, 'mirror invalidates video task');
  assert.equal(sb.videoInvalidatedReason, 'first_frame_candidate_changed', 'storyboard invalidation reason is first frame candidate change');
  assert.equal(vt.invalidatedReason, 'first_frame_candidate_changed', 'video task invalidation reason is first frame candidate change');
}

{
  const project: any = {
    shots: [{ shotUid: 'shot-a' }, { shotUid: 'shot-b' }],
    storyboards: [{
      idx: 0,
      shotIndices: [0, 1],
      firstFrameUrl: '/old.png',
      firstFrameMode: 'structured_v1',
      videoUrl: '/video.mp4',
      videoIsCurrent: true,
      shotFrames: {
        'shot-b': normalizeShotFrameState({
          candidates: [candidate('child', 1, { url: '/child.png' })],
          selectedCandidateId: 'child',
        }),
      },
    }],
    videoTasks: [{ taskId: 'video-task', isCurrent: true }],
  };
  const result = mirrorSelectedFirstFrameToLegacyFields(project, 0, { shotUid: 'shot-b' });
  assert.equal(result.project.storyboards[0].firstFrameUrl, '/old.png', 'non-leading shot does not mirror legacy first frame');
  assert.equal(result.project.storyboards[0].videoIsCurrent, true, 'non-leading shot does not invalidate video');
  assert.equal(result.project.videoTasks[0].isCurrent, true, 'non-leading shot does not invalidate video task');
}

console.log('test-shot-frame-candidates: ok');
