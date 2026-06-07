import assert from 'node:assert/strict';

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

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

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
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.id = '';
    this.parentNode = null;
    this.offsetHeight = 420;
    this.offsetWidth = 320;
    this._listeners = {};
    this._sceneFields = {};
    this._sceneButtons = {};
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
    this._sceneFields = {};
    this._sceneButtons = {};
    const inputRe = /<input\b[^>]*data-scene-edit-field="([^"]+)"[^>]*>/g;
    let inputMatch;
    while ((inputMatch = inputRe.exec(this._innerHTML))) {
      const tag = inputMatch[0];
      const valueMatch = tag.match(/\bvalue="([^"]*)"/);
      this._sceneFields[inputMatch[1]] = makeSceneEditorField(decodeHtml(valueMatch ? valueMatch[1] : ''));
    }
    const textareaRe = /<textarea\b[^>]*data-scene-edit-field="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g;
    let textareaMatch;
    while ((textareaMatch = textareaRe.exec(this._innerHTML))) {
      this._sceneFields[textareaMatch[1]] = makeSceneEditorField(decodeHtml(textareaMatch[2]));
    }
    if (this._innerHTML.includes('data-scene-edit-save')) this._sceneButtons.save = new FakeElement('button');
    if (this._innerHTML.includes('data-scene-edit-cancel')) this._sceneButtons.cancel = new FakeElement('button');
  }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((fn) => fn !== handler);
  }
  click() {
    (this._listeners.click || []).forEach((handler) => handler({ target: this, stopPropagation() {} }));
  }
  contains(el) {
    if (el === this) return true;
    return this.children.some((child) => child.contains && child.contains(el));
  }
  querySelector(selector) {
    const fieldMatch = String(selector).match(/\[data-scene-edit-field="([^"]+)"\]/);
    if (fieldMatch) return this._sceneFields[fieldMatch[1]] || null;
    if (selector === '[data-scene-edit-save]') return this._sceneButtons.save || null;
    if (selector === '[data-scene-edit-cancel]') return this._sceneButtons.cancel || null;
    return null;
  }
  querySelectorAll() { return []; }
  matches() { return false; }
  getBoundingClientRect() {
    return this._rect || { left: 820, right: 852, top: 180, bottom: 212, width: 32, height: 32 };
  }
  focus() {
    this.focused = true;
    if (globalThis.document) globalThis.document.activeElement = this;
  }
}

const containers = new Map();
const documentBody = new FakeElement('body');

function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

globalThis.document = {
  activeElement: null,
  body: documentBody,
  documentElement: { clientWidth: 1440, clientHeight: 900 },
  createElement(tag) { return new FakeElement(tag); },
  getElementById(id) {
    const bodyMatch = findById(documentBody, id);
    if (bodyMatch) return bodyMatch;
    for (const el of containers.values()) {
      const found = findById(el, id);
      if (found) return found;
    }
    if (id === 'assetSceneEditPopover' || id === 'sceneContextMenu' || id === 'charContextMenu') return null;
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

function makeSceneEditorField(initial = '') {
  return {
    value: initial,
    focus() {
      this.focused = true;
      document.activeElement = this;
    },
  };
}

function makeEditCard(type, idx) {
  const textEl = { classList: makeClassList(false), textContent: '' };
  const editEl = {
    classList: makeClassList(true),
    value: '',
    focus() {
      this.focused = true;
      document.activeElement = this;
    },
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
    contains(el) { return el === editButton; },
    getBoundingClientRect() {
      return { left: 820, right: 852, top: 180, bottom: 212, width: 32, height: 32 };
    },
    closest(selector) {
      if (selector === '[data-action]') return editButton;
      if (selector === '[data-type]') return card;
      return null;
    },
  };
  const otherButton = (action) => ({
    dataset: { action },
    contains(el) { return el === this; },
    getBoundingClientRect() {
      return { left: 860, right: 892, top: 180, bottom: 212, width: 32, height: 32 };
    },
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

function assertSceneDisplayContract(html, placeholder) {
  assert.match(html, /<div class="asset-desc-wrap">/);
  assert.match(html, /asset-desc-text/);
  assert.match(html, new RegExp(placeholder));
  assert.doesNotMatch(html, /asset-desc-edit/);
  assert.doesNotMatch(html, /data-scene-edit-field/);
}

{
  const ctx = makeCtx();
  resetProject({ assets: { characters: [], scenes: [], props: [] } }, ctx);

  const propContainer = document.getElementById('propGrid');
  renderAssetGrid('propGrid', [{ name: '戒指' }], 'prop', '');
  assert.equal(propContainer.children.length, 1);
  assertDescContract(propContainer.children[0].innerHTML, '暂无道具描述');

  const sceneContainer = document.getElementById('sceneGrid');
  renderAssetGrid('sceneGrid', [{ name: '宴会厅', imageUrl: '/scene.png', location: '旧地点', timeSetting: '夜晚', atmosphere: '安静，冷清' }], 'scene', '');
  assert.equal(sceneContainer.children.length, 1);
  const sceneHtml = sceneContainer.children[0].innerHTML;
  assertSceneDisplayContract(sceneHtml, '暂无场景描述');
  assert.doesNotMatch(sceneHtml, />zoom_in</);
  assert.match(sceneHtml, /data-action="edit-asset" title="编辑"[\s\S]*data-action="scene-more" title="更多"/);
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

{
  const fetchCalls = resetFetch();
  const ctx = makeCtx();
  const item = { name: '宴会厅', description: '旧描述', location: '旧地点', timeSetting: '白天', atmosphere: '明亮，拥挤' };
  const topScene = { name: '宴会厅', description: '旧描述', location: '旧地点', timeSetting: '白天', atmosphere: '明亮，拥挤' };
  const project = {
    styleBible: {},
    environments: [topScene],
    assets: { characters: [], scenes: [item], props: [] },
  };
  resetProject(project, ctx);

  const dom = makeEditCard('scene', 0);
  handleAssetAction({ target: dom.editButton });
  assert.equal(dom.textEl.classList.contains('hidden'), false, 'scene: description text is not replaced inline');
  assert.equal(dom.editEl.classList.contains('hidden'), true, 'scene: legacy textarea remains hidden');
  const popover = document.getElementById('assetSceneEditPopover');
  assert.ok(popover, 'scene: edit popover opened');
  assert.equal(popover.querySelector('[data-scene-edit-field="location"]').value, '旧地点');
  assert.equal(popover.querySelector('[data-scene-edit-field="timeSetting"]').value, '白天');
  assert.equal(popover.querySelector('[data-scene-edit-field="atmosphere"]').value, '明亮，拥挤');
  assert.equal(popover.querySelector('[data-scene-edit-field="description"]').value, '旧描述');

  popover.querySelector('[data-scene-edit-field="location"]').value = '新地点';
  popover.querySelector('[data-scene-edit-field="timeSetting"]').value = '夜晚';
  popover.querySelector('[data-scene-edit-field="atmosphere"]').value = '冷清，机械';
  popover.querySelector('[data-scene-edit-field="description"]').value = '新场景描述';
  popover.querySelector('[data-scene-edit-save]').click();

  assert.equal(item.location, '新地点');
  assert.equal(item.timeSetting, '夜晚');
  assert.equal(item.atmosphere, '冷清，机械');
  assert.equal(item.description, '新场景描述');
  assert.equal(topScene.location, '新地点');
  assert.equal(topScene.timeSetting, '夜晚');
  assert.equal(topScene.atmosphere, '冷清，机械');
  assert.equal(topScene.description, '新场景描述');
  assert.equal(item._descEdited, true);
  assert.equal(document.getElementById('assetSceneEditPopover'), null);
  assert.deepEqual(ctx.calls.stale[0], ['asset', { type: 'scene', idx: 0, name: item.name }]);
  assert.equal(ctx.calls.save, 1);
  assert.equal(fetchCalls[0][0], '/api/orchestration/sync-upstream');
}

{
  const ctx = makeCtx();
  const item = { name: '宴会厅', description: '旧描述' };
  const project = { styleBible: {}, assets: { characters: [], scenes: [item], props: [] } };
  resetProject(project, ctx);

  const dom = makeEditCard('scene', 0);
  handleAssetAction({ target: dom.otherButton('scene-more') });
  const menu = document.getElementById('sceneContextMenu');
  assert.ok(menu, 'scene: more menu opened');
  assert.match(menu.innerHTML, /编辑场景信息/);
  assert.match(menu.innerHTML, /查看历史/);
  assert.match(menu.innerHTML, /引用到 AI 助手/);
}

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
