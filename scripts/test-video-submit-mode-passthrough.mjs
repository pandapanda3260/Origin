import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function functionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `${name} has body`);
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

const videoTasksSrc = readFileSync(new URL('../public/modules/videoTasks.js', import.meta.url), 'utf8');
const workspaceSrc = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
const boardSrc = readFileSync(new URL('../public/modules/board.js', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
const startRunsSrc = readFileSync(new URL('../lib/video-creation/start-runs.ts', import.meta.url), 'utf8');
const batchExecutorsSrc = readFileSync(new URL('../lib/batch-executors.ts', import.meta.url), 'utf8');

assert.match(videoTasksSrc, /function _normalizeVideoSubmitMode\(value\)/, 'videoTasks normalizes submitMode on the frontend');
assert.match(functionBody(videoTasksSrc, 'createWorkflowVideoTask'), /var submitMode = _normalizeVideoSubmitMode\(opts\.submitMode\);/, 'single segment generation reads submitMode from opts');
assert.match(functionBody(videoTasksSrc, 'createWorkflowVideoTask'), /submitMode: submitMode,/, 'single segment generation sends submitMode in start options');
const batchDefaults = functionBody(videoTasksSrc, '_getDefaultBatchOpts');
for (const retiredId of ['batchSubmitMode', 'batchRatio', 'batchQuality', 'batchAudio', 'batchWatermark', 'batchAutoImport']) {
  assert.doesNotMatch(batchDefaults, new RegExp(retiredId), `batch defaults must not read retired ${retiredId} DOM`);
}
assert.doesNotMatch(batchDefaults, /videoState\.form\.submitMode|form\.submitMode/, 'bulk video generation must not inherit a hidden global submitMode');
assert.match(batchDefaults, /submitMode:\s*"auto"/, 'retired bulk video defaults keep submitMode fixed to auto');
assert.match(functionBody(videoTasksSrc, 'startBatchGeneration'), /submitMode: _normalizeVideoSubmitMode\(batchOpts\.submitMode\),/, 'batch generation sends normalized submitMode');
assert.match(functionBody(videoTasksSrc, 'generateVideoForGroup'), /regenSingleClip\(gIdx, opts\)/, 'generateVideoForGroup accepts optional submitMode opts');
assert.match(functionBody(videoTasksSrc, 'regenSingleClip'), /Object\.assign\(\{\}, _getDefaultBatchOpts\(\), batchOpts \|\| \{\}, \{ _videoGroupLockHeld: true \}\)/, 'single regen merges caller opts without breaking old defaults');

assert.doesNotMatch(workspaceSrc, /id="batchSubmitMode"/, 'retired batch page no longer exposes submitMode select');
assert.doesNotMatch(mainSrc, /batch-switch-status|batchAudio|batchWatermark/, 'runtime no longer wires retired batch switch controls');
assert.doesNotMatch(mainSrc, /btnStartBatch|btnGenerateAllSegments|btnImportAllSegments/, 'runtime no longer wires retired batch page buttons');

assert.match(boardSrc, /\['auto', '自动'\]/, 'board mode selector exposes auto');
assert.match(boardSrc, /\['reference_images', '智能多帧'\]/, 'board mode selector exposes reference_images');
assert.match(boardSrc, /\['first_last_frame', '首尾帧'\]/, 'board mode selector exposes first_last_frame');
assert.match(functionBody(boardSrc, 'runBoardAction'), /submitMode: videoSubmitModeForGroup\(payload\.groupIdx\)/, 'board generate sends selected submitMode');
assert.match(mainSrc, /generateVideoForGroup\(gIdx, \{ submitMode: payload && payload\.submitMode \}\)/, 'main passes board submitMode into videoTasks');
assert.match(startRunsSrc, /tailIntentRequested:\s*sb\?\.tailFrameIntent === 'requested' \|\| submitMode === 'first_last_frame'/, 'video start treats explicit first_last_frame as tail-frame intent');
assert.match(batchExecutorsSrc, /tailIntentRequested:\s*sb\?\.tailFrameIntent === 'requested' \|\| requestedVideoSubmitMode === 'first_last_frame'/, 'batch executor treats explicit first_last_frame as tail-frame intent');

console.log('✓ video submitMode passthrough contract passed');
