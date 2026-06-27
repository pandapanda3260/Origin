import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/modules/board_viewport.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);

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
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 99, y: 99, w: 20, h: 20 };
  const c = { x: 120, y: 120, w: 20, h: 20 };
  assert.equal(mod.rectsIntersect(a, b), true, 'rect intersection positive case');
  assert.equal(mod.rectsIntersect(a, c), false, 'rect intersection negative case');
}

console.log('✓ board viewport geometry contract passed');
