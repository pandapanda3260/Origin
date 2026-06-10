import assert from 'node:assert/strict';

/**
 * 真行为测试：跑真实的 storyboard.js confirmImages()，验证孤儿 stale flag 修复（前端侧）。
 *
 * 跑法:
 *   node scripts/test-confirm-images-stale-revalidation.mjs
 *
 * 场景（对应 proj_1780898501082 / storyboard_10 误拦案例）:
 *   A. 本地有残留 flag，服务端权威重算为空 → 自动清残留并放行（进入 prompts）；
 *   B. 真 stale（权威也认定）→ 拦截，toast 点名镜头号（含合并组"镜头2-3"形态）；
 *   C. 权威重算请求失败 → 保守按本地标记拦截；
 *   D. 本地无 flag → 不发 compute-stale 请求，直接走原流程放行。
 */

/* ---------- DOM / 浏览器环境 stub ---------- */
const toastLog = [];
function makeFakeEl() {
  const el = {
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    querySelector() { return makeFakeEl(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    parentElement: null,
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); if (html) toastLog.push(html); },
  });
  return el;
}
globalThis.localStorage = { getItem() { return ''; }, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, setInterval() { return 0; }, clearInterval() {}, location: { href: '' } };
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById() { return null; },
  createElement() { return makeFakeEl(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: makeFakeEl(),
  visibilityState: 'visible',
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

/* ---------- fetch stub：按 URL 路由 ---------- */
const fetchHits = [];
let computeStaleBehavior = { staleFlags: {} }; // 每个场景覆写；设为 'reject' 模拟失败
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchHits.push(u);
  if (u.includes('/api/orchestration/compute-stale')) {
    if (computeStaleBehavior === 'reject') return jsonResponse({ error: 'boom' }, 500);
    return jsonResponse({ ok: true, ...computeStaleBehavior });
  }
  if (u.includes('/api/batch/preflight')) {
    return jsonResponse({ ok: true, allowed: true });
  }
  return jsonResponse({ ok: true });
};

/* ---------- 加载真实模块 ---------- */
const { initStoryboard, syncStoryboardProject, confirmImages } = await import('../public/modules/storyboard.js');
const { _applyServerStaleFlagsToProject } = await import('../public/modules/assets.js');

/* ---------- 测试夹具 ---------- */
let project = null;
const spies = { saveProjectCalls: 0, switchPageCalls: [] };

initStoryboard({
  getProject: () => project,
  saveProject: () => { spies.saveProjectCalls += 1; },
  flushServerSave: async () => (spies.flushImpl ? spies.flushImpl() : { ok: true }),
  safeWriteBack: (id, fn) => { if (project && project.id === id) { fn(project); return true; } return false; },
  switchPage: (p) => { spies.switchPageCalls.push(p); },
  markDownstreamStale: () => {},
  isStale: (key) => !!(project && project._staleFlags && project._staleFlags[key]),
  applyServerStaleFlags: (prefixes, serverFlags) => _applyServerStaleFlagsToProject(project, prefixes, serverFlags),
  acceptShotPlanForStoryboard: async () => true,
  checkAndSuggest: () => {},
  diagnoseApiError: (m) => m,
  sleep: () => Promise.resolve(),
});

function makeProject(opts) {
  const shots = [];
  for (let i = 0; i < opts.shotCount; i += 1) shots.push({ idx: i + 1, visual: 'shot-' + i, emotion: 'general' });
  return {
    id: 'proj_test_' + opts.name,
    currentStep: 4,
    shots,
    storyboards: opts.storyboards,
    _staleFlags: opts.staleFlags || {},
  };
}
function sb(url, shotIndices) {
  return { imageUrl: url, firstFrameUrl: url, rawUrl: url, shotIndices };
}
function resetScenario(p, behavior) {
  project = p;
  syncStoryboardProject(project);
  computeStaleBehavior = behavior;
  spies.saveProjectCalls = 0;
  spies.switchPageCalls.length = 0;
  spies.flushImpl = null;
  fetchHits.length = 0;
  toastLog.length = 0;
}
const computeHits = () => fetchHits.filter((u) => u.includes('compute-stale')).length;
const toastText = () => toastLog.join('\n');

let failed = 0;
let passed = 0;
async function scenario(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok - ' + name);
  } catch (e) {
    failed += 1;
    console.error('  FAIL - ' + name);
    console.error('    ' + ((e && e.stack) || e));
  }
}

/* ---------- 场景 A：残留 flag + 权威为空 → 清残留并放行 ---------- */
await scenario('A. 残留 flag 被权威重算清掉并放行进入 prompts', async () => {
  resetScenario(makeProject({
    name: 'a',
    shotCount: 2,
    storyboards: [sb('/api/images/file/a0', [0]), sb('/api/images/file/a1', [1])],
    staleFlags: { storyboard_1: true, assets: true },
  }), { staleFlags: {} });

  await confirmImages();

  assert.equal(computeHits(), 1, '应发起一次权威重算');
  assert.equal(project._staleFlags.storyboard_1, undefined, '残留 storyboard_1 应被清除');
  assert.equal(project._staleFlags.assets, true, '非 storyboard_ 前缀的 flag 不受影响');
  assert.ok(spies.saveProjectCalls >= 1, '清残留后应保存');
  assert.deepEqual(spies.switchPageCalls, ['prompts'], '应放行进入 prompts');
  assert.equal(project.imagesApproved, true);
});

/* ---------- 场景 B：真 stale（合并组）→ 拦截并点名镜头号 ---------- */
await scenario('B. 真 stale 拦截且 toast 点名"镜头2-3"', async () => {
  resetScenario(makeProject({
    name: 'b',
    shotCount: 3,
    storyboards: [sb('/api/images/file/b0', [0]), sb('/api/images/file/b1', [1, 2])],
    staleFlags: { storyboard_1: true },
  }), { staleFlags: { storyboard_1: true } });

  await confirmImages();

  assert.equal(computeHits(), 1);
  assert.equal(project._staleFlags.storyboard_1, true, '真 stale flag 应保留');
  assert.equal(spies.switchPageCalls.length, 0, '不应放行');
  assert.ok(toastText().includes('1 张分镜图已过期'), 'toast 应说明数量, got: ' + toastText().slice(0, 300));
  assert.ok(toastText().includes('镜头2-3'), 'toast 应点名合并组镜头号, got: ' + toastText().slice(0, 300));
});

/* ---------- 场景 C：权威重算失败 → 保守按本地标记拦截 ---------- */
await scenario('C. compute-stale 失败时保守拦截、不丢本地 flag', async () => {
  resetScenario(makeProject({
    name: 'c',
    shotCount: 2,
    storyboards: [sb('/api/images/file/c0', [0]), sb('/api/images/file/c1', [1])],
    staleFlags: { storyboard_0: true },
  }), 'reject');

  await confirmImages();

  assert.equal(computeHits(), 1);
  assert.equal(project._staleFlags.storyboard_0, true, '重算失败不得清 flag');
  assert.equal(spies.switchPageCalls.length, 0, '重算失败不得放行');
  assert.ok(toastText().includes('张分镜图已过期'), '应给出拦截提示');
});

/* ---------- 场景 D：无 flag → 不发 compute-stale，直接放行 ---------- */
await scenario('D. 无本地 flag 时不发权威重算请求，直接放行', async () => {
  resetScenario(makeProject({
    name: 'd',
    shotCount: 2,
    storyboards: [sb('/api/images/file/d0', [0]), sb('/api/images/file/d1', [1])],
    staleFlags: {},
  }), { staleFlags: {} });

  await confirmImages();

  assert.equal(computeHits(), 0, '无 flag 不应发 compute-stale');
  assert.deepEqual(spies.switchPageCalls, ['prompts']);
});

/* ---------- 场景 E：在飞守卫，连点只跑一条确认链 ---------- */
await scenario('E. 在飞守卫：确认链未结束时连点被吞掉，只跳一次页', async () => {
  resetScenario(makeProject({
    name: 'e',
    shotCount: 2,
    storyboards: [sb('/api/images/file/e0', [0]), sb('/api/images/file/e1', [1])],
    staleFlags: {},
  }), { staleFlags: {} });

  let release;
  const gate = new Promise((r) => { release = r; });
  spies.flushImpl = async () => { await gate; return { ok: true }; };

  const p1 = confirmImages();
  const p2 = confirmImages(); // 第一条链还卡在 flush 上，这次点击应被守卫直接忽略
  // 等 p1 走到 flush 的 gate 上（preflight 已发出），此时统计确认链的 preflight：
  // 注意要在 release 之前断言——链结束后的 checkImagesConfirm 会另发一次
  // 按钮态 preflight（_getFirstFramePreflightState），不属于确认链。
  await new Promise((r) => setTimeout(r, 0));
  const preflightHitsInFlight = fetchHits.filter((u) => u.includes('/api/batch/preflight')).length;
  assert.equal(preflightHitsInFlight, 1, '连点不应跑出第二次确认链 preflight');
  release();
  await Promise.all([p1, p2]);

  assert.deepEqual(spies.switchPageCalls, ['prompts'], '只允许一次跳转');

  // 链结束后守卫应释放：再点一次可以正常走通
  spies.switchPageCalls.length = 0;
  await confirmImages();
  assert.deepEqual(spies.switchPageCalls, ['prompts'], '守卫释放后再点应可正常确认');
});

/* ---------- 场景 F：flush 409(stale) → 新副本重打标记重试一次后放行 ---------- */
await scenario('F. flush 遇 409 整包重载后，重打确认标记重试一次并放行', async () => {
  resetScenario(makeProject({
    name: 'f',
    shotCount: 2,
    storyboards: [sb('/api/images/file/f0', [0]), sb('/api/images/file/f1', [1])],
    staleFlags: {},
  }), { staleFlags: {} });

  let flushCalls = 0;
  spies.flushImpl = async () => {
    flushCalls += 1;
    if (flushCalls === 1) {
      // 模拟 _serverSave 的 409 路径：内存被服务器最新整包替换（新对象、新 version），
      // 本次 PUT 丢弃 → 确认标记没落盘。
      project = makeProject({
        name: 'f-reloaded',
        shotCount: 2,
        storyboards: [sb('/api/images/file/f0', [0]), sb('/api/images/file/f1', [1])],
        staleFlags: {},
      });
      project.version = 99;
      syncStoryboardProject(project);
      return { ok: false, stale: true, serverVersion: 99 };
    }
    return { ok: true };
  };

  await confirmImages();

  assert.equal(flushCalls, 2, '409 后应自动重试一次 flush');
  assert.equal(project.imagesApproved, true, '确认标记应重打在重载后的新副本上');
  assert.equal(project.shotsApproved, true);
  assert.ok(Number(project.currentStep) >= 5, 'currentStep 应推进到 5');
  assert.deepEqual(spies.switchPageCalls, ['prompts'], '重试成功应放行');
  assert.ok(!toastText().includes('确认失败'), '不应弹"确认失败", got: ' + toastText().slice(0, 200));
});

/* ---------- 场景 G：连续两次 409 → 回滚 + 失败提示，不跳页 ---------- */
await scenario('G. flush 二连 409 才按真失败回滚，不跳页', async () => {
  resetScenario(makeProject({
    name: 'g',
    shotCount: 2,
    storyboards: [sb('/api/images/file/g0', [0]), sb('/api/images/file/g1', [1])],
    staleFlags: {},
  }), { staleFlags: {} });

  spies.flushImpl = async () => {
    project = makeProject({
      name: 'g-reloaded',
      shotCount: 2,
      storyboards: [sb('/api/images/file/g0', [0]), sb('/api/images/file/g1', [1])],
      staleFlags: {},
    });
    syncStoryboardProject(project);
    return { ok: false, stale: true };
  };

  await confirmImages();

  assert.equal(spies.switchPageCalls.length, 0, '二连失败不得跳页');
  assert.ok(toastText().includes('确认失败'), '应弹确认失败提示');
  assert.ok(!project.imagesApproved, '确认标记应回滚（当前内存副本上不残留 true）');
});

console.log('');
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
