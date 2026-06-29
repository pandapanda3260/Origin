import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const boardSrc = readFileSync(new URL('../public/modules/board.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');

function functionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${name} body did not close`);
}

assert.match(boardSrc, /data-board-src/, 'candidate images must reuse board lazy image hydration');
assert.match(boardSrc, /data-board-action="candidate-select"/, 'candidate select action exists');
assert.match(boardSrc, /boardIconButton\('candidate-delete'/, 'candidate delete action exists');
assert.match(boardSrc, /data-board-action="candidate-generate"/, 'candidate generate action exists');
assert.match(boardSrc, /data-board-action="candidate-upload"/, 'candidate upload action exists');
assert.match(boardSrc, /draggable="true"/, 'real candidate cards are draggable');
assert.match(boardSrc, /const allReady = shotRows\.length > 0 && readyCount === shotRows\.length;/, 'segment generate-all hides when every shot has candidates');
assert.match(boardSrc, /\(allReady \? '' : '<button type="button" class="board-btn" data-board-control data-board-action="segment-generate-all"/, 'generate-all button is gated by allReady');
assert.doesNotMatch(boardSrc, /\bapiPost\b|\bapiUpload\b|\bfetch\s*\(/, 'board.js must not call network APIs directly');

const runAction = functionBody(boardSrc, 'runBoardAction');
assert.match(runAction, /_ctx\.selectShotFrameCandidate/, 'select uses ctx');
assert.match(runAction, /_ctx\.deleteShotFrameCandidate/, 'delete uses ctx');
assert.match(runAction, /_ctx\.generateShotFrameCandidate/, 'per-shot generate uses ctx');
assert.match(runAction, /_ctx\.uploadShotFrameCandidate/, 'upload uses ctx');
assert.match(runAction, /_ctx\.generateStoryboardSheet/, 'segment generate-all uses ctx');
assert.match(functionBody(boardSrc, 'onCandidateDrop'), /_ctx\.reorderShotFrameCandidates/, 'drag reorder uses ctx');
assert.match(functionBody(boardSrc, 'onCandidateDrop'), /orderedIds/, 'drag reorder sends orderedIds');

const initBoardIdx = mainSrc.indexOf('initBoard({');
assert.ok(initBoardIdx >= 0, 'main initBoard exists');
const initBoardEnd = mainSrc.indexOf('uPrefix: _uPrefix', initBoardIdx);
assert.ok(initBoardEnd > initBoardIdx, 'main initBoard block includes uPrefix terminator');
const initBoardBlock = mainSrc.slice(initBoardIdx, initBoardEnd);
assert.match(initBoardBlock, /apiPost\('\/api\/frames\/candidate'[\s\S]*action: 'select'/, 'main injects select via frames/candidate');
assert.match(initBoardBlock, /apiPost\('\/api\/frames\/candidate'[\s\S]*action: 'delete'/, 'main injects delete via frames/candidate');
assert.match(initBoardBlock, /apiPost\('\/api\/frames\/candidate'[\s\S]*action: 'reorder'[\s\S]*orderedIds: payload\.orderedIds/, 'main injects reorder via frames/candidate orderedIds');
assert.match(initBoardBlock, /apiPost\('\/api\/batch\/start'[\s\S]*batchType: 'storyboard_images'[\s\S]*shotUid: payload\.shotUid/, 'main injects per-shot generation via batch/start shotUid target');
assert.match(initBoardBlock, /form\.append\('shotUid'/, 'main injects first-frame upload with shotUid');
assert.match(initBoardBlock, /apiUpload\('\/api\/frames\/upload'/, 'main uploads candidate through frames/upload');
assert.doesNotMatch(initBoardBlock, /saveProject\s*\(/, 'board candidate actions must not use debounced project save');

console.log('test-board-candidate-actions: ok');
