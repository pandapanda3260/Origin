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

console.log('✓ board readonly contract passed');
