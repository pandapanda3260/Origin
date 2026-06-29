import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function dataModuleUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const frameSrc = readFileSync(new URL('../public/modules/frameRecommendations.js', import.meta.url), 'utf8');
const frameUrl = dataModuleUrl(frameSrc);
let stateSrc = readFileSync(new URL('../public/modules/board_state.js', import.meta.url), 'utf8');
stateSrc = stateSrc.replace("from '/modules/frameRecommendations.js';", `from ${JSON.stringify(frameUrl)};`);
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
  const vm = boardState.buildBoardViewModel(project, { groups: [{ gIdx: 0, shotIndices: [0, 1] }] });
  assert.equal(vm.reference.empty, false, 'reference is non-empty with one character');
  assert.equal(vm.shotPlan.shotCount, 2, 'shot plan counts shots');
  assert.equal(vm.segments.length, 1, 'one segment is projected');
  assert.equal(vm.segments[0].shotRows.length, 2, 'segment contains two shot rows');
  assert.ok(
    vm.segments[0].shotRows.every((row) => row.candidates[0]?.kind === 'segment-cover-placeholder'),
    'segment first-frame candidates are explicitly marked as cover placeholders before per-shot model exists',
  );
  assert.ok(
    vm.segments[0].shotRows.every((row) => row.candidates[0]?.label === '片段封面占位'),
    'segment placeholder candidates carry the UI label',
  );
  assert.deepEqual(
    vm.edges.map((edge) => `${edge.from}->${edge.to}`),
    ['reference->shot-plan', 'shot-plan->segment:0', 'segment:0->video:0'],
    'board topology is reference -> plan -> segment -> video',
  );
  assert.ok(vm.nodes.find((node) => node.id === 'reference'), 'reference node exists');
  assert.ok(vm.nodes.find((node) => node.id === 'video:0'), 'video node exists');
}

console.log('✓ board projection contract passed');
