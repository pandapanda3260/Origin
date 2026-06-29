import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

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

function positionsOf(source, needle) {
  const positions = [];
  let i = source.indexOf(needle);
  while (i >= 0) {
    positions.push(i);
    i = source.indexOf(needle, i + needle.length);
  }
  return positions;
}

function rangeOfFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const body = functionBody(source, name);
  return { start, end: start + marker.length + body.length + 2 };
}

const helper = functionBody(main, '_refreshShotsSurface');
assert.match(helper, /isBoardEnabled\(\)/, '_refreshShotsSurface is flag-aware');
assert.match(helper, /syncBoardProject\(project\)/, '_refreshShotsSurface syncs board project when enabled');
assert.match(helper, /refreshBoardPage\(\)/, '_refreshShotsSurface refreshes board when enabled');
assert.match(helper, /refreshShotsPage\(\)/, '_refreshShotsSurface preserves legacy shots refresh when disabled');
assert.match(helper, /refreshImagesPage\(\)/, '_refreshShotsSurface preserves legacy images refresh when disabled');
assert.doesNotMatch(helper, /is-board-workbench-page|boardRoot|\.hidden|setBoardActive/, '_refreshShotsSurface must not own route activation');

const helperRange = rangeOfFunction(main, '_refreshShotsSurface');
for (const needle of ['refreshShotsPage(', 'refreshImagesPage(']) {
  const positions = positionsOf(main, needle);
  assert.ok(positions.length >= 1, `${needle} appears`);
  for (const pos of positions) {
    assert.ok(pos >= helperRange.start && pos <= helperRange.end, `${needle} must only be called inside _refreshShotsSurface`);
  }
}

const refreshAll = functionBody(main, 'refreshAllPages');
assert.match(refreshAll, /_refreshShotsSurface\(\)/, 'refreshAllPages uses board-aware shots refresh');

const refreshActive = functionBody(main, '_refreshPageForActiveRoute');
assert.match(refreshActive, /page === "shots"[\s\S]*_refreshShotsSurface\(\)/, '_refreshPageForActiveRoute uses board-aware shots refresh');

const fixed = functionBody(main, '_syncFixedWorkbenchRoute');
assert.match(fixed, /isBoardRoute\s*=\s*isBoardEnabled\(\)\s*&&\s*page === "shots"/, 'board route is flag-gated');
assert.match(fixed, /is-fixed-workbench-page"[\s\S]*locked/, 'fixed workbench class remains route-owned');
assert.match(fixed, /is-board-workbench-page"[\s\S]*isBoardRoute/, 'board class is route-owned');
assert.match(fixed, /boardRoot\.hidden\s*=\s*!isBoardRoute/, 'boardRoot hidden state is route-owned');

const runtimeFlag = functionBody(main, 'isBoardEnabled');
assert.match(runtimeFlag, /value === "1"[\s\S]*return true/, 'runtime originBoard=1 forces board on');
assert.match(runtimeFlag, /value === "0"[\s\S]*return false/, 'runtime originBoard=0 keeps local rollback');
assert.match(runtimeFlag, /host === "localhost"[\s\S]*host === "127\.0\.0\.1"[\s\S]*host === "::1"/, 'runtime enables board by default on local development hosts');

const prebootFlag = functionBody(workspace, 'boardEnabled');
assert.match(prebootFlag, /value === "1"[\s\S]*return true/, 'preboot originBoard=1 forces board on');
assert.match(prebootFlag, /value === "0"[\s\S]*return false/, 'preboot originBoard=0 keeps local rollback');
assert.match(prebootFlag, /host === "localhost"[\s\S]*host === "127\.0\.0\.1"[\s\S]*host === "::1"/, 'preboot enables board by default on local development hosts');

assert.match(workspace, /if \(page === "images"\) page = "shots";\s*if \(page === "prompts" && boardEnabled\(\)\) page = "shots";/, 'preboot keeps images->shots unconditional and gates prompts->shots');
assert.match(workspace, /data-board-boot/, 'workspace preboot marks board boot');
assert.match(workspace, /id="boardRoot" hidden/, 'workspace contains hidden boardRoot');
assert.match(workspace, /main\.js\?v=368/, 'workspace bumps main.js after runtime flag change');
assert.match(workspace, /styles\.css\?v=258/, 'workspace bumps styles.css after board route chrome change');
assert.match(styles, /is-board-workbench-page[\s\S]*\.agent-fab[\s\S]*\.agent-panel[\s\S]*display:\s*none !important;/, 'board route hides global agent chrome');

console.log('✓ board routing contract passed');
