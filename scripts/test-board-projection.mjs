import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function dataModuleUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const frameSrc = readFileSync(new URL('../public/modules/frameRecommendations.js', import.meta.url), 'utf8');
const frameUrl = dataModuleUrl(frameSrc);
const assetDisplaySrc = readFileSync(new URL('../public/modules/asset_display_state.js', import.meta.url), 'utf8');
const assetDisplayUrl = dataModuleUrl(assetDisplaySrc);
let stateSrc = readFileSync(new URL('../public/modules/board_state.js', import.meta.url), 'utf8');
stateSrc = stateSrc.replace("from '/modules/frameRecommendations.js';", `from ${JSON.stringify(frameUrl)};`);
stateSrc = stateSrc.replaceAll("from '/modules/asset_display_state.js';", `from ${JSON.stringify(assetDisplayUrl)};`);
const boardState = await import(dataModuleUrl(stateSrc));

{
  const project = {
    assets: {
      characters: [
        { name: 'Ava', entityType: 'human' },
        { name: 'Locked Ava', entityType: 'human' },
        { name: 'Robot', entityType: 'non-human' },
      ],
    },
    characters: [
      { name: 'Ava', entityType: 'human', panels: { sheetUrl: '/api/images/file/top-sheet' } },
      null,
      { name: 'Robot', originalUrl: '/api/images/file/wrong-human' },
    ],
    consistency: {
      characters: [
        null,
        {
          canonicalName: 'Locked Ava',
          referenceLock: { sheetUrl: '/api/images/file/locked-ava' },
          sourceAssetId: 'lock-2',
          identityLock: { entityType: 'human' },
        },
      ],
    },
  };
  assert.equal(
    boardState.resolveCharacterImageUrl(project, project.assets.characters[0], 0),
    '/api/images/file/top-sheet',
    'character falls back to top-level character panels.sheetUrl by idx',
  );
  assert.equal(
    boardState.resolveCharacterImageUrl(project, project.assets.characters[1], 1),
    '/api/images/file/locked-ava',
    'character consistency fallback uses matched lock and still passes identity gate',
  );
  assert.equal(
    boardState.resolveCharacterImageUrl(project, project.assets.characters[2], 2),
    '',
    'non-human character does not use top-level fallback without identity evidence',
  );
}

{
  const scene = {
    reference: { currentUrl: '/api/images/file/top-scene' },
    views: [
      { role: 'reverse', imageUrl: '/api/images/file/reverse-scene' },
      { role: 'establishing', reference: { currentUrl: '/api/images/file/view-scene' } },
    ],
  };
  assert.equal(
    boardState.resolveSceneImageUrl(scene),
    '/api/images/file/view-scene',
    'scene establishing view reference wins over top-level reference',
  );
}

{
  const prop = {
    reference: { currentUrl: '/api/images/file/top-prop' },
    views: {
      side: { imageUrl: '/api/images/file/legacy-side' },
      slots: {
        front: { reference: { currentUrl: '/api/images/file/front-prop' } },
      },
    },
  };
  assert.equal(
    boardState.resolvePropImageUrl(prop),
    '/api/images/file/front-prop',
    'prop resolver checks views.slots[slot] before top-level fallback',
  );
}

{
  const project = {
    storyboards: [
      { videoCoverUrl: '/api/images/file/sb-cover', firstFrameUrl: '/api/images/file/first-0' },
      { firstFrameUrl: '/api/images/file/first-1' },
      { firstFrameUrl: '/api/images/file/first-2' },
    ],
    videoTasks: [
      { coverUrl: '/api/images/file/vt-cover-0' },
      { coverUrl: '/api/images/file/vt-cover-1' },
      {},
    ],
  };
  assert.equal(boardState.resolveVideoCoverUrl(project, 0), '/api/images/file/sb-cover', 'storyboard video cover wins first');
  assert.equal(boardState.resolveVideoCoverUrl(project, 1), '/api/images/file/vt-cover-1', 'videoTasks cover is normal generated-video source');
  assert.equal(boardState.resolveVideoCoverUrl(project, 2), '/api/images/file/first-2', 'first frame is cover fallback');
}

{
  const project = {
    storyboards: [
      { videoStatus: 'failed', videoUrl: '/api/videos/file/failed-still-has-url' },
      { videoStatus: 'queued', videoUrl: '/api/videos/file/queued-still-has-url' },
      { videoIsCurrent: false, videoUrl: '/api/videos/file/outdated-still-has-url' },
      {},
      {},
      {},
    ],
    videoTasks: [
      {},
      {},
      {},
      { status: 'completed', filename: 'clip.mp4' },
      { status: 'submitting' },
      { taskId: 'task-without-status' },
    ],
  };
  assert.equal(boardState.resolveVideoStatus(project, 0), 'failed', 'failed short-circuits before URL presence');
  assert.equal(boardState.resolveVideoStatus(project, 1), 'generating', 'queued short-circuits before URL presence');
  assert.equal(boardState.resolveVideoStatus(project, 2), 'outdated', 'outdated short-circuits before URL presence');
  assert.equal(boardState.resolveVideoStatus(project, 3), 'ready', 'completed with filename is ready from project fields');
  assert.equal(boardState.resolveVideoStatus(project, 4), 'missing', 'runtime UI status submitting is not a board persisted state');
  assert.equal(boardState.resolveVideoStatus(project, 5), 'ready', 'taskId presence marks ready after failed/generating/outdated checks');
}

{
  const project = {
    shots: [{ id: 's1' }, { id: 's2' }],
    shotsApproved: true,
    assetsApproved: true,
    videoPromptsApproved: true,
    assets: {
      characters: [{ id: 'c1', name: 'Ava', originalUrl: '/api/images/file/ava' }],
      scenes: [],
      props: [],
    },
    storyboards: [
      { shotIndices: [0, 1], firstFrameUrl: '/api/images/file/seg0' },
    ],
    videoTasks: [
      { coverUrl: '/api/images/file/v0', status: 'completed', filename: 'clip.mp4', taskId: 'vt0' },
    ],
  };
  const vm = boardState.buildBoardViewModel(project, {
    groups: [{ gIdx: 0, shotIndices: [0, 1] }],
    videoHistoriesByGroup: {
      0: [
        {
          task_id: 'vt0',
          cover_url: '/api/images/file/v0-history',
          url: '/api/videos/file/v0',
          protected_url: '/api/videos/protected/v0',
          duration_sec: 6,
          created_at: '2026-06-30T08:00:00.000Z',
          is_current: true,
          prompt: 'current video prompt',
        },
        {
          task_id: 'vt-old',
          cover_url: '/api/images/file/v-old',
          url: '/api/videos/file/v-old',
          duration_sec: 5,
          created_at: '2026-06-29T08:00:00.000Z',
          is_current: true,
          prompt: 'old video prompt',
        },
      ],
    },
  });
  assert.equal(vm.reference.empty, false, 'reference is non-empty with one character');
  assert.equal(vm.shotPlan.shotCount, 2, 'shot plan counts shots');
  assert.equal(vm.segments.length, 1, 'one segment is projected');
  assert.equal(vm.segments[0].shotRows.length, 2, 'segment contains two shot rows');
  assert.equal(
    vm.segments[0].shotRows[0].candidates[0]?.kind,
    'segment-cover-placeholder',
    'legacy segment cover is projected only onto the leading shot row',
  );
  assert.equal(
    vm.segments[0].shotRows[1].candidates.length,
    0,
    'legacy segment cover is not promoted into sibling per-shot candidates',
  );
  assert.ok(
    vm.segments[0].shotRows.every((row) => row.readOnlyReason === 'missing_shot_uid'),
    'rows without canonical shotUid are read-only',
  );
  assert.equal(vm.segments[0].video.selectedTaskId, 'vt0', 'video selectedTaskId comes from project videoTasks current authority');
  assert.equal(vm.segments[0].video.candidates.length, 2, 'video history rows are projected as flat candidates');
  assert.deepEqual(
    {
      taskId: vm.segments[0].video.candidates[0].taskId,
      coverUrl: vm.segments[0].video.candidates[0].coverUrl,
      playbackUrl: vm.segments[0].video.candidates[0].playbackUrl,
      protectedUrl: vm.segments[0].video.candidates[0].protectedUrl,
      durationSec: vm.segments[0].video.candidates[0].durationSec,
      selected: vm.segments[0].video.candidates[0].selected,
    },
    {
      taskId: 'vt0',
      coverUrl: '/api/images/file/v0-history',
      playbackUrl: '/api/videos/file/v0',
      protectedUrl: '/api/videos/protected/v0',
      durationSec: 6,
      selected: true,
    },
    'video history snake_case fields map to board camelCase candidate fields',
  );
  assert.equal(vm.segments[0].video.candidates[1].isCurrent, true, 'history is_current remains available for display/debug');
  assert.equal(vm.segments[0].video.candidates[1].selected, false, 'cached is_current does not override selectedTaskId');
  assert.deepEqual(
    vm.edges.map((edge) => `${edge.from}->${edge.to}`),
    ['reference->shot-plan', 'shot-plan->segment:0', 'segment:0->video:0'],
    'board topology is reference -> plan -> segment -> video',
  );
  assert.ok(vm.nodes.find((node) => node.id === 'reference'), 'reference node exists');
  assert.ok(vm.nodes.find((node) => node.id === 'video:0'), 'video node exists');
}

{
  const project = {
    shots: [
      { id: 'wrong-id-a', uid: 'wrong-uid-a', shotUid: 'shot-a' },
      { id: 'wrong-id-b', shot_uid: 'shot-b' },
    ],
    storyboards: [{
      shotIndices: [0, 1],
      firstFrameUrl: '/api/images/file/legacy-cover',
      shotFrames: {
        'shot-a': {
          selectedCandidateId: 'a2',
          candidates: [
            { id: 'a1', url: '/api/images/file/a1', source: 'gen', mode: 'structured_v1', status: 'ready', metadataTier: 'compact' },
            { id: 'a2', url: '/api/images/file/a2', source: 'upload', mode: 'uploaded', status: 'ready', metadataTier: 'full' },
          ],
        },
        'shot-b': {
          selectedCandidateId: 'b1',
          candidates: [
            { id: 'b1', url: '/api/images/file/b1', source: 'edit', mode: 'multi_ref_v1', status: 'ready' },
          ],
        },
      },
    }],
  };
  const vm = boardState.buildBoardViewModel(project, { groups: [{ gIdx: 0, shotIndices: [0, 1] }] });
  assert.equal(vm.segments[0].shotRows[0].shotUid, 'shot-a', 'board shotUid uses canonical shotUid before id/uid');
  assert.equal(vm.segments[0].shotRows[1].shotUid, 'shot-b', 'board shotUid accepts shot_uid');
  assert.equal(vm.segments[0].shotRows[0].candidates.length, 2, 'shotFrames candidates are projected for the matching shotUid');
  assert.equal(vm.segments[0].shotRows[0].selectedCandidateId, 'a2', 'selectedCandidateId is preserved on the row');
  assert.equal(vm.segments[0].shotRows[0].candidates[1].selected, true, 'selected candidate is marked explicitly');
  assert.equal(vm.segments[0].shotRows[0].candidates[0].kind, undefined, 'real shotFrames candidates are not cover placeholders');
  assert.equal(vm.segments[0].shotRows[1].candidates[0].url, '/api/images/file/b1', 'second shot reads its own shotFrames bucket');
}

console.log('✓ board projection contract passed');
