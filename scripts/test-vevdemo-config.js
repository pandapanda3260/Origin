/* eslint-disable @typescript-eslint/no-var-requires */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function loadHelper() {
  const sourcePath = path.join(root, 'lib/vevdemo-config.ts');
  const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const moduleObj = { exports: {} };

  function localRequire(id) {
    if (id === './env') {
      return { getExternalEnvValue: () => undefined };
    }
    return require(id);
  }

  vm.runInNewContext(
    code,
    { require: localRequire, module: moduleObj, exports: moduleObj.exports, process },
    { filename: sourcePath },
  );
  return moduleObj.exports;
}

function readerFrom(values) {
  return (key) => values[key];
}

function assertArrayEqual(actual, expected) {
  assert.deepEqual(Array.from(actual), expected);
}

const {
  readVevDemoApiUrl,
  readVevDemoEditorProjectUrl,
  readVevDemoEditorUrl,
  readVevDemoUrlConfig,
} = loadHelper();

{
  const cfg = readVevDemoUrlConfig(readerFrom({
    VEVDEMO_EDITOR_URL: ' http://127.0.0.1:8084/ ',
    VEVDEMO_API_URL: ' http://127.0.0.1:3002/ ',
  }));
  assert.equal(cfg.editorUrl, 'http://127.0.0.1:8084');
  assert.equal(cfg.apiUrl, 'http://127.0.0.1:3002');
  assert.equal(cfg.editorProjectUrl, 'http://127.0.0.1:8084');
  assertArrayEqual(cfg.missingKeys, []);
  assertArrayEqual(cfg.legacyKeysUsed, []);
}

{
  const cfg = readVevDemoUrlConfig(readerFrom({
    VEVDEMO_FRONTEND_URL: 'http://127.0.0.1:8084/',
    VEVDEMO_BACKEND_URL: 'http://127.0.0.1:3002/',
  }));
  assert.equal(cfg.editorUrl, 'http://127.0.0.1:8084');
  assert.equal(cfg.apiUrl, 'http://127.0.0.1:3002');
  assertArrayEqual(cfg.missingKeys, []);
  assertArrayEqual(cfg.legacyKeysUsed, ['VEVDEMO_FRONTEND_URL', 'VEVDEMO_BACKEND_URL']);
}

{
  const cfg = readVevDemoUrlConfig(readerFrom({
    VEVDEMO_FRONTEND_URL: 'http://127.0.0.1:9999',
    VEVDEMO_BACKEND_URL: 'http://127.0.0.1:3999',
    VEVDEMO_EDITOR_URL: 'http://127.0.0.1:8084',
    VEVDEMO_API_URL: 'http://127.0.0.1:3002',
  }));
  assert.equal(cfg.editorUrl, 'http://127.0.0.1:8084');
  assert.equal(cfg.apiUrl, 'http://127.0.0.1:3002');
  assertArrayEqual(cfg.legacyKeysUsed, []);
}

{
  const legacyProject = readVevDemoEditorProjectUrl(readerFrom({
    VEVDEMO_EDITOR_URL: 'http://127.0.0.1:8084',
    VEVDEMO_IFRAME_PROJECT_URL: 'http://127.0.0.1:8084/?project=legacy',
  }));
  assert.equal(legacyProject, 'http://127.0.0.1:8084/?project=legacy');

  const newProject = readVevDemoEditorProjectUrl(readerFrom({
    VEVDEMO_EDITOR_URL: 'http://127.0.0.1:8084',
    VEVDEMO_EDITOR_PROJECT_URL: 'http://127.0.0.1:8084/?project=new',
  }));
  assert.equal(newProject, 'http://127.0.0.1:8084/?project=new');

  const newBeatsLegacy = readVevDemoEditorProjectUrl(readerFrom({
    VEVDEMO_EDITOR_URL: 'http://127.0.0.1:8084',
    VEVDEMO_IFRAME_PROJECT_URL: 'http://127.0.0.1:8084/?project=legacy',
    VEVDEMO_EDITOR_PROJECT_URL: 'http://127.0.0.1:8084/?project=new',
  }));
  assert.equal(newBeatsLegacy, 'http://127.0.0.1:8084/?project=new');

  const fallback = readVevDemoEditorProjectUrl(readerFrom({
    VEVDEMO_EDITOR_URL: 'http://127.0.0.1:8084',
  }));
  assert.equal(fallback, 'http://127.0.0.1:8084');
}

{
  const cfg = readVevDemoUrlConfig(readerFrom({}));
  assert.equal(readVevDemoEditorUrl(readerFrom({})), '');
  assert.equal(readVevDemoApiUrl(readerFrom({})), '');
  assertArrayEqual(cfg.missingKeys, ['VEVDEMO_EDITOR_URL', 'VEVDEMO_API_URL']);
}

console.log('test-vevdemo-config: ok');
