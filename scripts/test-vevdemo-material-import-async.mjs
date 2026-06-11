import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const braceStart = source.indexOf('{', start);
  assert.ok(braceStart >= 0, `${name} must have a body`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`failed to extract ${name}`);
}

const route = read('app/api/volcengine/import/route.ts');
const statusRoutePath = 'app/api/volcengine/import/jobs/[id]/route.ts';
const statusRoute = read(statusRoutePath);
const jobsLib = read('lib/vevdemo-material-import-jobs.ts');
const materialRegistration = read('lib/vevdemo-material-registration.ts');
const onlineEditor = read('public/modules/online_editor.js');
const main = read('public/main.js');

assert.ok(existsSync(join(ROOT, statusRoutePath)), 'job status route must exist');

assert.match(route, /body\.async === true \|\| body\.background === true/, 'POST must support async/background import');
assert.ok(route.includes('getOrStartVevDemoMaterialImportJob'), 'async import must use the job registry');
assert.ok(route.includes('run: () => runVevDemoMaterialImport(reqContext, user, body)'), 'background job must reuse the same import implementation');
assert.ok(route.includes('serializeVevDemoMaterialImportJob(job)'), 'async start must return serialized job status');

assert.ok(statusRoute.includes('getVevDemoMaterialImportJob'), 'status route must read import jobs');
assert.ok(statusRoute.includes('job.ownerId !== user.id'), 'status route must enforce owner scoping');
assert.ok(statusRoute.includes('noStoreHeaders'), 'status route must be no-store for polling');

assert.ok(jobsLib.includes('globalThis'), 'job registry must survive route module reloads in the same Node process');
assert.ok(jobsLib.includes('jobIdByKey'), 'job registry must dedupe repeated starts by idempotency key');
assert.ok(jobsLib.includes("existing.status !== 'failed'"), 'failed jobs must be retryable on the next start');
assert.ok(jobsLib.includes("job.status = 'running'"), 'job must transition to running before the long import starts');
assert.ok(jobsLib.includes("job.status = 'completed'"), 'job must persist completed result for later page re-entry');

assert.ok(materialRegistration.includes('function readEditMaterialSource'), 'material registration must normalize edit-material Source fields');
assert.ok(materialRegistration.includes('result.MaterialSet?.MaterialInfos'), 'material registration must read nested MaterialSet material lists');
assert.ok(materialRegistration.includes('readEditMaterialSource(item) === vevSource'), 'material registration must reuse existing edit materials by Source before creating');
assert.ok(materialRegistration.includes('function readEditMaterialMid'), 'material registration must normalize edit material id fields when reusing');

assert.ok(onlineEditor.includes('_postMaterialImportAsync'), 'frontend must have async import client');
assert.ok(onlineEditor.includes('/api/volcengine/import/jobs/'), 'frontend must poll job status');
assert.ok(onlineEditor.includes('素材同步已在后台继续'), 'frontend must treat long-running background sync as pending, not failed');
const importFn = extractFunction(onlineEditor, 'importMaterialsToVevDemo');
assert.ok(importFn.includes('_postMaterialImportAsync'), 'manual/auto material sync must use background import job');
assert.ok(!importFn.includes('const payload = await _postMaterialImport({'), 'material sync must not use the old long POST path');

assert.ok(main.includes('apiGet: (url, options) => apiGet(url, options)'), 'online editor apiGet must pass polling options');

console.log('test-vevdemo-material-import-async: ok');
