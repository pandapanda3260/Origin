import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/modules/board_viewport.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);

assert.match(src, /const DEFAULT_BUFFER = 640;/, 'viewport keeps explicit culling buffer');
assert.match(src, /export const LOD_OVERVIEW_ENTER = 0\.4;/, 'LOD overview enter threshold is fixed at 0.4');
assert.match(src, /export const LOD_OVERVIEW_EXIT = 0\.45;/, 'LOD overview exit threshold is fixed at 0.45');
assert.match(src, /const MIN_USABLE_VIEWPORT_SIZE = 32;/, 'transitional 1x1 roots are not treated as usable board viewports');
assert.match(src, /new ResizeObserver\(scheduleResize\)/, 'viewport observes root size changes');
assert.match(src, /resizeObserver\.observe\(rootEl\)/, 'ResizeObserver is attached to viewport root');
assert.match(src, /function measuredViewportSize\(rootEl\)/, 'viewport can distinguish hidden zero-size roots from usable roots');
assert.match(src, /function isUsableViewportSize\(size\)[\s\S]*size\.w >= MIN_USABLE_VIEWPORT_SIZE && size\.h >= MIN_USABLE_VIEWPORT_SIZE;/, 'viewport usability has a real minimum size threshold');
assert.match(src, /let hasUsableViewportSize = isUsableViewportSize\(initialMeasuredSize\);/, 'resize center preservation is armed only after a usable viewport size exists');
assert.match(src, /if \(!isUsableViewportSize\(measuredSize\)\)/, 'ResizeObserver ignores hidden or transitional tiny board roots');
assert.match(src, /function fit\(ids\)[\s\S]*!isUsableViewportSize\(measuredSize\)[\s\S]*return false;[\s\S]*return true;/, 'fit refuses hidden or transitional tiny roots instead of fitting against 1x1');
assert.match(src, /screenToWorldPoint\(\{ x: lastViewportSize\.w \/ 2, y: lastViewportSize\.h \/ 2 \}, transform\)/, 'resize preserves the old viewport center');
assert.doesNotMatch(src, /replaceChildren\(\)/, 'setEdges must not rebuild the entire SVG layer');
assert.match(src, /const edgeRecords = new Map\(\);/, 'edge records are keyed for incremental diff');
assert.match(src, /record\.path\.setAttribute\('d', pathInfo\.d\)/, 'existing edges update path.d when endpoints move');
assert.match(src, /getLodLevel:\s*\(\)\s*=>\s*lodLevel/, 'viewport exposes current LOD to the board image layer');

function approx(actual, expected, label, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`);
}

{
  const transform = { k: 1.75, x: 123, y: -45 };
  const world = { x: 320, y: 180 };
  const screen = mod.worldToScreenPoint(world, transform);
  const roundTrip = mod.screenToWorldPoint(screen, transform);
  approx(roundTrip.x, world.x, 'world/screen x round-trip');
  approx(roundTrip.y, world.y, 'world/screen y round-trip');
}

{
  const transform = { k: 0.8, x: 40, y: -30 };
  const cursor = { x: 512, y: 300 };
  const before = mod.screenToWorldPoint(cursor, transform);
  const next = mod.zoomTransformAt(transform, cursor, 1.6);
  const after = mod.screenToWorldPoint(cursor, next);
  approx(after.x, before.x, 'zoom-to-cursor keeps world x');
  approx(after.y, before.y, 'zoom-to-cursor keeps world y');
}

{
  const fit = mod.fitTransformToRect({ x: 100, y: 50, w: 400, h: 200 }, { w: 1000, h: 600 });
  const screen = mod.rectToScreen({ x: 100, y: 50, w: 400, h: 200 }, fit);
  assert.ok(screen.x >= -1e-9, 'fit keeps rect left inside viewport');
  assert.ok(screen.y >= -1e-9, 'fit keeps rect top inside viewport');
  assert.ok(screen.x + screen.w <= 1000 + 1e-9, 'fit keeps rect right inside viewport');
  assert.ok(screen.y + screen.h <= 600 + 1e-9, 'fit keeps rect bottom inside viewport');
}

{
  assert.equal(mod.clampScale(0.001), 0.05, 'scale clamps to minimum');
  assert.equal(mod.clampScale(99), 2.5, 'scale clamps to maximum');
  assert.equal(mod.clampScale(1.25), 1.25, 'scale preserves in-range value');
}

{
  assert.equal(mod.LOD_OVERVIEW_ENTER, 0.4, 'overview enter threshold is exported');
  assert.equal(mod.LOD_OVERVIEW_EXIT, 0.45, 'overview exit threshold is exported');
  assert.equal(mod.lodLevelForScale(0.39, 'detail'), 'overview', 'detail switches to overview below enter threshold');
  assert.equal(mod.lodLevelForScale(0.42, 'overview'), 'overview', 'overview stays active inside hysteresis band');
  assert.equal(mod.lodLevelForScale(0.44, 'detail'), 'detail', 'detail stays active inside hysteresis band');
  assert.equal(mod.lodLevelForScale(0.46, 'overview'), 'detail', 'overview exits above exit threshold');
}

{
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 99, y: 99, w: 20, h: 20 };
  const c = { x: 120, y: 120, w: 20, h: 20 };
  assert.equal(mod.rectsIntersect(a, b), true, 'rect intersection positive case');
  assert.equal(mod.rectsIntersect(a, c), false, 'rect intersection negative case');
}

{
  assert.equal(typeof mod.edgePath, 'function', 'edgePath is exported for geometry tests');
  const source = { x: 120, y: 80, w: 240, h: 180 };
  const target = { x: 620, y: 260, w: 220, h: 140 };
  const path = mod.edgePath(source, target);
  const numbers = String(path.d).match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal(numbers.length, 8, 'edge path contains M and C coordinates');
  approx(numbers[0], source.x + source.w, 'edge source x starts at source right edge');
  approx(numbers[1], source.y + source.h / 2, 'edge source y starts at source vertical midpoint');
  approx(numbers[6], target.x, 'edge target x ends at target left edge');
  approx(numbers[7], target.y + target.h / 2, 'edge target y ends at target vertical midpoint');
}

console.log('✓ board viewport geometry contract passed');
