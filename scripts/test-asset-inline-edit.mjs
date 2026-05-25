import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return ''; },
  removeItem() {},
};
globalThis.window = {
  prompt() { return null; },
  alert() {},
  location: { href: '' },
  addEventListener() {},
  removeEventListener() {},
};

class FakeClassList {
  constructor(initial = '') {
    this._set = new Set(String(initial).split(/\s+/).filter(Boolean));
  }
  add(name) { this._set.add(name); }
  remove(name) { this._set.delete(name); }
  contains(name) { return this._set.has(name); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList();
    this.textContent = '';
    this.value = '';
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelectorAll() { return []; }
  matches() { return false; }
  focus() { this.focused = true; }
}

const containers = new Map();
globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
  getElementById(id) {
    if (!containers.has(id)) containers.set(id, new FakeElement('div'));
    return containers.get(id);
  },
  addEventListener() {},
  removeEventListener() {},
};

const assets = await import('../public/modules/assets.js');
const {
  handleAssetAction,
  initAssets,
  renderAssetGrid,
  syncAssetsProject,
} = assets;

function makeCtx() {
  const calls = {
    stale: [],
    save: 0,
    agent: [],
    history: 0,
  };
  return {
    calls,
    historyBtnHtml() {
      return '<button type="button" data-action="show-history">历史</button>';
    },
    isStale() { return false; },
    markDownstreamStale(kind, payload) { calls.stale.push([kind, payload]); },
    saveProject() { calls.save += 1; },
    agentInsertRef(typeLabel, name, payload) { calls.agent.push([typeLabel, name, payload]); },
    openHistoryPopover(_btn, _item, cb) {
      calls.history += 1;
      if (typeof cb === 'function') cb({ description: '历史描述' });
    },
    setHistoryAsCurrent() {
      return false;
    },
  };
}

function resetFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push([url, opts]);
    return {
      ok: true,
      status: 200,
      async text() { return '{}'; },
      async json() { return {}; },
      async blob() { return new Blob([]); },
    };
  };
  return calls;
}

function makeClassList(hidden) {
  return new FakeClassList(hidden ? 'hidden' : '');
}

function makeEditCard(type, idx) {
  const textEl = { classList: makeClassList(false), textContent: '' };
  const editEl = {
    classList: makeClassList(true),
    value: '',
    focus() { this.focused = true; },
    onblur: null,
  };
  const wrap = {
    querySelector(selector) {
      if (selector === '.asset-desc-text') return textEl;
      if (selector === '.asset-desc-edit') return editEl;
      return null;
    },
  };
  const card = {
    dataset: { type, idx: String(idx) },
    querySelector(selector) {
      if (selector === '.asset-desc-wrap') return wrap;
      return null;
    },
  };
  const editButton = {
    dataset: { action: 'edit-asset' },
    closest(selector) {
      if (selector === '[data-action]') return editButton;
      if (selector === '[data-type]') return card;
      return null;
    },
  };
  const otherButton = (action) => ({
    dataset: { action },
    closest(selector) {
      if (selector === '[data-action]') return this;
      if (selector === '[data-type]') return card;
      return null;
    },
  });
  return { card, textEl, editEl, editButton, otherButton };
}

function resetProject(project, ctx) {
  initAssets(ctx);
  syncAssetsProject(project);
}

function assertDescContract(html, placeholder) {
  assert.match(html, /class="asset-desc-wrap[^"]*"/);
  assert.match(html, /data-action="edit-asset"/);
  assert.match(html, /asset-desc-text/);
  assert.match(html, /asset-desc-edit hidden/);
  assert.match(html, /<textarea[^>]*rows="3"><\/textarea>/);
  assert.match(html, new RegExp(placeholder));
}

{
  const ctx = makeCtx();
  resetProject({ assets: { characters: [], scenes: [], props: [] } }, ctx);

  const propContainer = document.getElementById('propGrid');
  renderAssetGrid('propGrid', [{ name: '戒指' }], 'prop', '');
  assert.equal(propContainer.children.length, 1);
  assertDescContract(propContainer.children[0].innerHTML, '暂无道具描述');

  const sceneContainer = document.getElementById('sceneGrid');
  renderAssetGrid('sceneGrid', [{ name: '宴会厅' }], 'scene', '');
  assert.equal(sceneContainer.children.length, 1);
  assertDescContract(sceneContainer.children[0].innerHTML, '暂无场景描述');
}

async function assertEditableDescription(type, cat, newValue) {
  const fetchCalls = resetFetch();
  const ctx = makeCtx();
  const item = { name: type === 'prop' ? '戒指' : '宴会厅', description: '旧描述' };
  const project = {
    styleBible: {},
    assets: { characters: [], scenes: [], props: [] },
  };
  project.assets[cat] = [item];
  resetProject(project, ctx);

  const dom = makeEditCard(type, 0);
  handleAssetAction({ target: dom.editButton });
  assert.equal(dom.textEl.classList.contains('hidden'), true, `${type}: text hidden after entering edit`);
  assert.equal(dom.editEl.classList.contains('hidden'), false, `${type}: textarea visible after entering edit`);
  assert.equal(dom.editEl.value, '旧描述');

  dom.editEl.value = newValue;
  dom.editEl.onblur();
  assert.equal(item.description, newValue);
  assert.equal(item._descEdited, true);
  assert.equal(dom.textEl.textContent, newValue);
  assert.deepEqual(ctx.calls.stale[0], ['asset', { type, idx: 0, name: item.name }]);
  assert.equal(ctx.calls.save, 1);
  assert.equal(fetchCalls[0][0], '/api/orchestration/sync-upstream');
}

await assertEditableDescription('prop', 'props', '新道具描述');
await assertEditableDescription('scene', 'scenes', '新场景描述');

{
  const fetchCalls = resetFetch();
  const ctx = makeCtx();
  const item = { name: '戒指', description: '旧描述' };
  const project = { styleBible: {}, assets: { characters: [], scenes: [], props: [item] } };
  resetProject(project, ctx);

  const dom = makeEditCard('prop', 0);
  handleAssetAction({ target: dom.editButton });
  dom.editEl.value = '旧描述';
  dom.editEl.onblur();
  assert.equal(item.description, '旧描述');
  assert.equal(item._descEdited, undefined);
  assert.equal(ctx.calls.stale.length, 0);
  assert.equal(ctx.calls.save, 0);
  assert.equal(fetchCalls.length, 0);
}

{
  const fetchCalls = resetFetch();
  const ctx = makeCtx();
  const item = { name: '角色A', appearance: '旧外貌', clothing: '旧服装', equipment: '旧装备' };
  const project = { styleBible: {}, assets: { characters: [item], scenes: [], props: [] } };
  resetProject(project, ctx);

  const dom = makeEditCard('char', 0);
  handleAssetAction({ target: dom.editButton });
  dom.editEl.value = '外貌 | 服装 | 装备';
  dom.editEl.onblur();
  assert.equal(item.appearance, '外貌');
  assert.equal(item.clothing, '服装');
  assert.equal(item.equipment, '装备');
  assert.equal(item.description, undefined);
  assert.deepEqual(ctx.calls.stale[0], ['asset', { type: 'char', idx: 0, name: '角色A' }]);
  assert.equal(fetchCalls[0][0], '/api/orchestration/sync-upstream');
}

{
  const ctx = makeCtx();
  const item = { name: '戒指', description: '旧描述' };
  const project = { assets: { characters: [], scenes: [], props: [item] } };
  resetProject(project, ctx);
  const dom = makeEditCard('prop', 0);

  handleAssetAction({ target: dom.otherButton('ref-agent') });
  assert.equal(dom.editEl.classList.contains('hidden'), true);
  assert.equal(item.description, '旧描述');
  assert.equal(ctx.calls.agent.length, 1);

  handleAssetAction({ target: dom.otherButton('show-history') });
  assert.equal(dom.editEl.classList.contains('hidden'), true);
  assert.equal(ctx.calls.history, 1);
}

console.log('[test-asset-inline-edit] all assertions passed');
