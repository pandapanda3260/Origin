import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');

function skipTrivia(text, index) {
  let i = index;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i + 2);
      if (i === -1) return text.length;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function nextStatement(text, index) {
  const start = skipTrivia(text, index);
  const end = text.indexOf(';', start);
  assert.ok(end >= 0, 'next statement must terminate with semicolon');
  return text.slice(start, end + 1).trim();
}

const matches = Array.from(src.matchAll(/\bsyncStoryboardProject\s*\(([^)]*)\)\s*;/g));
assert.equal(matches.length, 9, 'main.js should keep the known 9 syncStoryboardProject call sites');

for (const match of matches) {
  const arg = match[1].trim();
  const expected = `syncBoardProject(${arg});`;
  const actual = nextStatement(src, match.index + match[0].length);
  assert.equal(actual, expected, `syncStoryboardProject(${arg}) must be followed by ${expected}`);
}

console.log('✓ board sync adjacency contract passed');
