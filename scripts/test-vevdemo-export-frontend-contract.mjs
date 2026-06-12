import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const actions = read('vevdemo-1.0.6/fe/actions.js');
const iframe = read('vevdemo-1.0.6/fe/index.js');
const parent = read('public/modules/online_editor.js');

assert.ok(actions.includes('export const submitEditTaskAsyncRaw'), 'actions must expose raw submit response for side-channel tracking');
assert.match(
  actions,
  /export const submitEditTaskAsync = async[\s\S]+const res = await submitEditTaskAsyncRaw\(params\);[\s\S]+return res\.Result;/,
  'SDK-facing submitEditTaskAsync must still return res.Result',
);
assert.ok(iframe.includes('submitEditTaskAsyncWithOriginTracking'), 'iframe must wrap submit action for Origin tracking');
assert.ok(iframe.includes("postToOrigin('vevdemo:exportSubmitted'"), 'iframe must notify Origin after submit succeeds');
assert.ok(iframe.includes('submitResult: res'), 'iframe must pass full submit response to Origin');
assert.match(
  iframe,
  /submitEditTaskAsync:\s*submitEditTaskAsyncWithOriginTracking/,
  'SDK actions injection must use the tracking wrapper',
);

assert.ok(parent.includes("case 'vevdemo:exportSubmitted'"), 'parent must handle exportSubmitted bridge message');
assert.ok(parent.includes('/api/online-editor/vevdemo-export/submit'), 'parent must call new submit tracking API');
assert.ok(parent.includes('/api/online-editor/vevdemo-export/status?projectId='), 'parent must poll project-scoped task status before exportId exists');
assert.ok(parent.includes('vevSpace: _vevDemoBoundVevSpace'), 'parent must supply vevSpace from project binding');
assert.ok(parent.includes("const OEV_EXPORT_STORAGE_PROJECT_KEY = 'oeLastExportProjectId'"), 'local export recovery must be project-scoped');
assert.match(
  parent,
  /function onOnlineEditorPageEnter\(\)[\s\S]+_restoreExportStateFromServerThenStorage\(\);/,
  'page entry must restore from server before localStorage fallback',
);
assert.match(
  parent,
  /if \(_exportState\.vevExportTaskId \|\| _exportState\.vevProviderTaskId\)[\s\S]+Origin 正在继续查询远端任务/,
  'SDK failed event must be downgraded while backend task polling is active',
);

console.log('test-vevdemo-export-frontend-contract: ok');
