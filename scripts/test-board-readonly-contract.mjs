import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = [
  'public/modules/board.js',
  'public/modules/board_state.js',
  'public/modules/board_viewport.js',
];

const forbidden = [
  /\bsaveProject\b/,
  /\bsafeWriteBack\b/,
  /\bapiPost\b/,
  /\bapiGet\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bgetVideoResultState\b/,
  /\bswitchPage\b/,
];

for (const file of files) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const pattern of forbidden) {
    assert.equal(pattern.test(src), false, `${file} must not contain ${pattern}`);
  }
}

const boardSrc = readFileSync(new URL('../public/modules/board.js', import.meta.url), 'utf8');

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

const whitelistMatch = boardSrc.match(/export const BOARD_CTX_KEYS = \[([^\]]+)\]/);
assert.ok(whitelistMatch, 'board.js exports BOARD_CTX_KEYS');
const keys = Array.from(whitelistMatch[1].matchAll(/'([^']+)'/g)).map((match) => match[1]);
assert.deepEqual(
  keys,
  ['getProject', 'getStoryboardGroups', 'hydrateProtectedImageElements', 'showToast', 'uPrefix'],
  'board ctx whitelist stays read-only',
);
assert.equal(/export function setBoardActive\b/.test(boardSrc), false, 'board.js must not own route activation');
assert.equal(/is-board-workbench-page/.test(boardSrc), false, 'board.js must not toggle route classes');

assert.match(boardSrc, /function shouldLoadThumb\(img\)\s*\{\s*return currentLodLevel\(\) !== 'overview' && isImageNearViewport\(img\);/, 'board image loading shares LOD and viewport-near predicate');
assert.match(boardSrc, /new IntersectionObserver/, 'board image hydration uses IntersectionObserver');
assert.match(boardSrc, /const BOARD_IMAGE_CONCURRENCY = 6;/, 'board image hydration is concurrency-limited');
assert.equal(/resolveProtectedImageBlobUrl/.test(functionBody(boardSrc, 'hydrateBoardImages')), false, 'hydrateBoardImages must not eagerly fetch protected images while walking the tree');
assert.match(functionBody(boardSrc, 'applyCamera'), /else if \(_viewport\.fit\(\)\) \{\s*_cameraReadyProjectId = projectId;/, 'camera readiness waits for a successful visible fit');
assert.match(boardSrc, /function unobserveBoardImages\(root\)/, 'board image observers are cleaned up when nodes leave the board');
assert.match(functionBody(boardSrc, 'removeStaleNodes'), /unobserveBoardImages\(_nodeEls\.get\(id\)\)/, 'stale nodes unobserve board images before DOM removal');
assert.match(functionBody(boardSrc, 'renderSegmentNode'), /const badgeText = placeholderCount \? '封面占位 ' \+ placeholderCount \+ '\/' \+ shotRows\.length : '首帧 0\/' \+ shotRows\.length;/, 'segment header badge must not present reused covers as per-shot first frames');
assert.match(functionBody(boardSrc, 'renderSegmentNode'), /const frameLabel = isPlaceholder \? '片段封面占位'/, 'segment rows label reused covers as placeholders');
assert.match(boardSrc, /data-board-minimap/, 'board renders a native minimap surface');
assert.match(boardSrc, /function updateMiniMap\(vm\)/, 'board updates minimap from the current view model');
assert.match(boardSrc, /function updateMiniMapViewport\(\)/, 'board keeps the minimap viewport rectangle in sync with camera changes');
assert.match(boardSrc, /function onMiniMapPointerDown\(event\)/, 'board minimap supports click-to-center navigation');
assert.match(boardSrc, /function clampMiniMapViewRect\(rect, metrics\)/, 'board minimap clamps the visible viewport rectangle');
assert.match(functionBody(boardSrc, 'onMiniMapPointerDown'), /clampValue\(metrics\.bounds\.x \+ \(px - metrics\.ox\) \/ metrics\.scale/, 'minimap click target clamps to board bounds');
assert.match(boardSrc, /data-board-help/, 'board renders an inline help panel');
assert.match(boardSrc, /function toggleBoardHelp\(force\)/, 'board help is toggled in-place');
assert.doesNotMatch(functionBody(boardSrc, 'onToolClick'), /showToast/, 'board help must not be a placeholder toast');

console.log('✓ board readonly contract passed');
