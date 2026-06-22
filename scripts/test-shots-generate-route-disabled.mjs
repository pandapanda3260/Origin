#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(resolve(__dirname, '..', 'app', 'api', 'shots', 'generate', 'route.ts'), 'utf8');
const shotsJs = readFileSync(resolve(__dirname, '..', 'public', 'modules', 'shots.js'), 'utf8');

assert.match(routeSrc, /status:\s*410/, 'legacy /api/shots/generate must return 410');
assert.match(routeSrc, /replacement:\s*['"]\/api\/batch\/start['"]/, 'legacy route must name /api/batch/start as replacement');
assert.doesNotMatch(routeSrc, /chatCompleteJsonWithRetry|chatCompleteJsonViaBackground|parseJsonLoose/, 'legacy route must not call LLM JSON generation');
assert.doesNotMatch(routeSrc, /updateProjectForUser|patchProjectForUser|sseResponse/, 'legacy route must not mutate projects or stream generation');
assert.match(shotsJs, /\/api\/batch\/start/, 'shots UI must use batch/start');
assert.doesNotMatch(
  shotsJs.replace(/从 apiPostStream\("\/api\/shots\/generate"\) 换成 POST \/api\/batch\/start/g, ''),
  /\/api\/shots\/generate/,
  'shots UI must not actively call legacy /api/shots/generate',
);

console.log('test-shots-generate-route-disabled: ok');
