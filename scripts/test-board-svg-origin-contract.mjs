import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/modules/board.js', import.meta.url), 'utf8');

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

const body = functionBody(src, 'setSurfaceBounds');

assert.match(body, /const\s+pad\s*=\s*400\s*;/, 'setSurfaceBounds defines a single pad value');
assert.match(
  body,
  /const\s+w\s*=\s*Math\.max\(\s*1600\s*,\s*Math\.ceil\(\s*\(\s*bounds\s*&&\s*bounds\.w\s*\)\s*\|\|\s*0\s*\)\s*\+\s*pad\s*\*\s*2\s*\)/,
  'width preserves Math.max/Math.ceil and adds pad * 2',
);
assert.match(
  body,
  /const\s+h\s*=\s*Math\.max\(\s*1000\s*,\s*Math\.ceil\(\s*\(\s*bounds\s*&&\s*bounds\.h\s*\)\s*\|\|\s*0\s*\)\s*\+\s*pad\s*\*\s*2\s*\)/,
  'height preserves Math.max/Math.ceil and adds pad * 2',
);

for (const target of ['_surfaceEl', '_edgesEl']) {
  assert.match(
    body,
    new RegExp(`${target.replace('$', '\\$')}\\.style\\.left\\s*=\\s*-pad\\s*\\+\\s*['"]px['"]`),
    `${target} left edge uses -pad`,
  );
  assert.match(
    body,
    new RegExp(`${target.replace('$', '\\$')}\\.style\\.top\\s*=\\s*-pad\\s*\\+\\s*['"]px['"]`),
    `${target} top edge uses -pad`,
  );
}

assert.match(
  body,
  /_edgesEl\.setAttribute\(\s*['"]width['"]\s*,\s*String\(\s*w\s*\)\s*\)/,
  'SVG width attribute uses w',
);
assert.match(
  body,
  /_edgesEl\.setAttribute\(\s*['"]height['"]\s*,\s*String\(\s*h\s*\)\s*\)/,
  'SVG height attribute uses h',
);
assert.match(
  body,
  /_edgesEl\.setAttribute\(\s*['"]viewBox['"]\s*,\s*`\$\{\s*-pad\s*\}\s+\$\{\s*-pad\s*\}\s+\$\{\s*w\s*\}\s+\$\{\s*h\s*\}`\s*\)/,
  'viewBox origin uses the same -pad and dimensions use the same w/h',
);

assert.doesNotMatch(body, /['"]-400\s+-400\s+/, 'viewBox must not keep a hard-coded -400 origin');

console.log('✓ board SVG origin contract passed');
