#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const executor = read('lib/batch-executors.ts');
const submitRoute = read('app/api/video/submit/route.ts');
const startRoute = read('app/api/batch/start/route.ts');

assert.match(executor, /deriveVideoSubmitInputMode\s*\(/, 'batch executor must use decision helper');
assert.match(submitRoute, /deriveVideoSubmitInputMode\s*\(/, 'video submit route must use decision helper');
assert.doesNotMatch(
  executor,
  /payloadDecision\.reason\s*===\s*['"]reference_images['"]/,
  'batch executor must not derive submit strategy from payloadDecision.reason',
);
assert.doesNotMatch(
  submitRoute,
  /decision\.reason\s*===\s*['"]reference_images['"]/,
  'video submit route must not derive submit strategy from decision.reason',
);

assert.match(startRoute, /isMultiRefVideoModeEnabled/, 'batch start must read multi-ref capability');
assert.match(startRoute, /isIndependentMultiImageModeEnabled/, 'batch start must read independent multi-image capability');
assert.match(startRoute, /independentMultiImageCapable/, 'batch start must pass independent multi-image capability into decision');

console.log('test-video-effective-strategy-wiring: ok');
