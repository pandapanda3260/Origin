import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.localStorage = {
  getItem() { return ''; },
  removeItem() {},
};
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  prompt() { return null; },
  alert() {},
  location: { href: '' },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.document = {
  body: { children: [], appendChild() {}, removeChild() {} },
  documentElement: { clientWidth: 1440, clientHeight: 900 },
  createElement() {
    return {
      classList: { add() {}, remove() {}, contains() { return false; } },
      style: {},
      dataset: {},
      children: [],
      appendChild() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    };
  },
  createTextNode(text) { return { nodeType: 3, textContent: String(text || '') }; },
  getElementById() { return null; },
  addEventListener() {},
  removeEventListener() {},
};

function browserModuleImportUrl(entry) {
  const srcDir = fileURLToPath(new URL('../public/modules/', import.meta.url));
  const tmpDir = mkdtempSync(join(tmpdir(), 'origin-browser-modules-'));
  process.on('exit', () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(join(srcDir, name), 'utf8')
      .replace(/(from\s+['"])\/modules\//g, '$1./')
      .replace(/(import\s*\(\s*['"])\/modules\//g, '$1./');
    writeFileSync(join(tmpDir, name), src);
  }

  return pathToFileURL(join(tmpDir, entry)).href;
}

const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
const rebuildPromptRouteSource = readFileSync(new URL('../app/api/assets/rebuild-prompt/route.ts', import.meta.url), 'utf8');
const {
  _rebuildAssetImagePrompt,
  syncAssetsProject,
} = await import(browserModuleImportUrl('assets.js'));

function mockFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([url, opts]);
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify(response); },
      async json() { return response; },
    };
  };
  return calls;
}

{
  syncAssetsProject({ styleBible: { visualStyle: '东方玄幻' } });
  const calls = mockFetch({ imagePrompt: '半透明冰蓝系统面板，鎏金文字悬浮，矩形光框' });
  const prompt = await _rebuildAssetImagePrompt('prop', {
    name: '脑海系统面板',
    propType: '标志物',
    features: '半透明虚拟界面，冰蓝光框，鎏金文字',
    function: '提示萧云完成任务与获得三次顿悟奖励',
  });
  assert.equal(prompt, '半透明冰蓝系统面板，鎏金文字悬浮，矩形光框');
  assert.equal(calls.length, 1, 'prop without description but with prop fields must call rebuild-prompt');
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.type, 'prop');
  assert.match(payload.description, /标志物/);
  assert.match(payload.description, /半透明虚拟界面/);
  assert.match(payload.description, /提示萧云完成任务/);
}

{
  syncAssetsProject({ styleBible: {} });
  const calls = mockFetch({ imagePrompt: '古旧殿堂空间，石柱环绕' });
  await _rebuildAssetImagePrompt('scene', {
    name: '试炼殿',
    description: '古旧殿堂空间，石柱环绕',
    location: '混沌圣地',
    timeSetting: '夜晚',
    atmosphere: '压迫',
    elements: ['石柱', '云雾'],
  });
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.description, '古旧殿堂空间，石柱环绕', 'scene description seed must stay description-only');
  assert.equal(payload.location, '混沌圣地');
  assert.equal(payload.timeSetting, '夜晚');
  assert.equal(payload.atmosphere, '压迫');
  assert.deepEqual(payload.elements, ['石柱', '云雾']);
}

assert.match(
  assetsSource,
  /return _joinPublicDesc\(\[item\.propType, item\.material, item\.features, item\.function, item\.ownership\]\)/,
  'prop rebuild seed must stay aligned with existing public prop description fields',
);
assert.doesNotMatch(
  assetsSource,
  /else if \(item\.imagePrompt\) \{[\s\S]{0,220}?item\.imagePrompt = ""/,
  'failed prompt rebuild must not clear an existing imagePrompt',
);
assert.match(
  assetsSource,
  /item\._imagePromptRebuildError = \(e && e\.message\) \|\| String\(e \|\| ""\)/,
  'rebuild API errors must be preserved for the user-facing toast',
);
assert.match(
  assetsSource,
  /showToast\(rebuildError \|\| _assetTypeLabel\(type\) \+ "缺少可生成的提示词", "warn"\)/,
  'prompt rebuild API errors must not be collapsed into missing-prompt warnings',
);
assert.match(
  rebuildPromptRouteSource,
  /maxTokens:\s*1200/,
  'asset prompt rebuild must have enough output budget for current Responses models',
);
assert.match(
  rebuildPromptRouteSource,
  /reasoningEffort:\s*'none'/,
  'asset prompt rebuild must use the existing no-reasoning setting so short rewrites do not exhaust max_output_tokens',
);

console.log('[test-asset-prop-rebuild-prompt-contract] all assertions passed');
