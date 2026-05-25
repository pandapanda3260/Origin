import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/frames/rewrite-draft/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /function isFirstFrameRewriteEnabled\(\): boolean \{\s*return false;\s*\}/,
  'first-frame rewrite endpoint must be disabled by default',
);

const disabledGuardIndex = routeSource.indexOf('if (!isFirstFrameRewriteEnabled())');
const modelCallIndex = routeSource.indexOf('chatCompleteJsonWithRetry(');

assert(disabledGuardIndex >= 0, 'rewrite route must guard disabled feature before handling the request');
assert(modelCallIndex >= 0, 'rewrite route should retain the old implementation behind the disabled guard for rollback');
assert(disabledGuardIndex < modelCallIndex, 'disabled feature guard must run before any model call can be made');

assert.match(
  routeSource,
  /code: 'feature_disabled'[\s\S]*?\{ status: 410 \}/,
  'disabled rewrite route must return feature_disabled with HTTP 410',
);

console.log('test-first-frame-rewrite-disabled passed');
