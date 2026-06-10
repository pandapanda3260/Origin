/**
 * backend_stream.js 降级轮询契约测试（2026-06 SSE 断流自愈）
 *
 * 行为级验证（mock EventSource + fetch，真实跑 public/modules/backend_stream.js）：
 *   T1 subscribeBatch：SSE 重连额度耗尽 → 自动降级 5s 轮询 GET /api/batch/:id，
 *      合成 task_completed（与 lib/batches._emit 帧同构）→ 终态合成
 *      batch_completed + onClose + 停轮询；层内按 taskId 去重不双发
 *   T2 重连计数清零：收到任何事件后 retries=0 —— 事件后还能再扛 3 次断线
 *      才进降级（旧实现是终身 3 次额度）
 *   T3 subscribeTask：降级轮询 GET /api/tasks/:id，completed 合成
 *      onCompleted({resultUrl, extra:{protectedUrl,...}})
 *   T4 轮询连续 404 × 3 → 放弃 + onClose（不误报成功/失败）
 *   T5 caller close() → SSE 与降级轮询全停
 *   T6 SSE 正常终态 → 不进降级轮询
 * 外加静态契约：main.js 全局唤醒对账接线 / assets.js reattach 防重 /
 * videoTasks.js reconcileVideoTasksOnWake / workspace.html 版本号已 bump。
 *
 * 跑法：node scripts/test-backend-stream-fallback-contract.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── 时间加速：退避(1s/2s/4s)与轮询(5s)缩到 ≤20ms，测试 <5s 跑完 ──────────
const _origSetTimeout = globalThis.setTimeout;
const _origSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...a) => _origSetTimeout(fn, Math.min(Number(ms) || 0, 20), ...a);
globalThis.setInterval = (fn, ms, ...a) => _origSetInterval(fn, Math.min(Number(ms) || 0, 20), ...a);
const sleep = (ms) => new Promise((r) => _origSetTimeout(r, ms));

// ── 浏览器 globals stub（utils.js 顶层副作用需要）─────────────────────────
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { href: '', pathname: '/workspace.html' },
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  visibilityState: 'visible', hidden: false,
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: () => 'test-token', setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
  value: { sendBeacon: () => true, onLine: true }, configurable: true,
});

// ── EventSource mock ──────────────────────────────────────────────────────
class MockEventSource {
  constructor(url) {
    this.url = String(url);
    this.listeners = Object.create(null);
    this.closed = false;
    this.onerror = null;
    MockEventSource.instances.push(this);
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(name, payload) {
    (this.listeners[name] || []).forEach((fn) =>
      fn({ data: JSON.stringify({ data: payload, ts: Date.now() }) }));
  }
  fail() { if (this.onerror) this.onerror(); }
}
MockEventSource.instances = [];
globalThis.EventSource = MockEventSource;
const esFor = (frag) => MockEventSource.instances.filter((e) => e.url.includes(frag));
const lastEs = (frag) => esFor(frag)[esFor(frag).length - 1];
// SSE 死透：连发 error 直到不再产生新实例（耗尽重连额度 → 降级轮询启动）
async function killSse(frag) {
  for (let i = 0; i < 12; i++) {
    const n = esFor(frag).length;
    lastEs(frag).fail();
    await sleep(60);
    if (esFor(frag).length === n) return; // 没有新实例了 → 已降级
  }
  throw new Error('SSE for ' + frag + ' never exhausted retries');
}

// ── fetch mock：按前缀路由，记录调用 ─────────────────────────────────────
const fetchLog = [];
const routes = []; // [prefix, handler]
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  fetchLog.push(u);
  for (const [prefix, fn] of routes) {
    if (u.includes(prefix)) return fn(u, opts);
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
const jsonResp = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});
const countFetch = (frag) => fetchLog.filter((u) => u.includes(frag) && !u.includes('/stream')).length;

// ── 被测模块 ─────────────────────────────────────────────────────────────
const { subscribeBatch, subscribeTask } = await import('../public/modules/backend_stream.js');

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

// ════ T1: batch 降级轮询 + 帧同构 + 去重 + 终态收口 ══════════════════════
{
  let polls = 0;
  const t1Task = {
    taskId: 't1', seq: 0, status: 'completed', target: { idx: 0 },
    result: { resultUrl: 'https://img/u1.png', patch: { type: 'x', value: 'u1' }, extra: { groupIdx: 0 }, serverVersion: 7 },
  };
  routes.push(['/api/batch/b1', () => {
    polls++;
    return jsonResp(polls === 1
      ? { batchId: 'b1', status: 'running', total: 2, succeeded: 1, failed: 0, tasks: [t1Task] }
      : { batchId: 'b1', status: 'completed', total: 2, succeeded: 2, failed: 0, tasks: [t1Task, { taskId: 't2', seq: 1, status: 'failed', target: { idx: 1 }, errorMsg: 'boom' }] });
  }]);

  const got = { completed: [], failed: [], batchDone: 0, closed: 0 };
  subscribeBatch('b1', {
    onTaskCompleted: (d) => got.completed.push(d),
    onTaskFailed: (d) => got.failed.push(d),
    onBatchCompleted: () => got.batchDone++,
    onClose: () => got.closed++,
  });
  await sleep(50);
  assert.equal(countFetch('/api/batch/b1'), 0, 'SSE 活着时不应轮询');
  await killSse('/api/batch/b1');
  await sleep(250);

  assert.equal(got.completed.length, 1, 't1 只应投递一次（层内去重）');
  const frame = got.completed[0];
  assert.equal(frame.taskId, 't1');
  assert.equal(frame.targetSeq, 0, '合成帧必须带 targetSeq（调用方 seqToIdx 反查依赖它）');
  assert.equal(frame.resultUrl, 'https://img/u1.png');
  assert.equal(frame.extra.groupIdx, 0);
  assert.equal(frame.serverVersion, 7, '合成帧必须带 serverVersion（_safeWriteBack 乐观锁用）');
  assert.deepEqual(frame.patch, { type: 'x', value: 'u1' });
  assert.equal(got.failed.length, 1);
  assert.equal(got.failed[0].errorMsg, 'boom');
  assert.equal(got.failed[0].reason, 'boom');
  assert.equal(got.batchDone, 1, '终态只合成一次 batch_completed');
  assert.equal(got.closed, 1, '终态后触发 onClose');
  const n = countFetch('/api/batch/b1');
  await sleep(150);
  assert.equal(countFetch('/api/batch/b1'), n, '终态后轮询必须停止');
  ok('T1 batch 降级轮询：帧同构 + 去重 + 终态停轮询 + onClose');
}

// ════ T2: 收到事件后重连额度清零 ═════════════════════════════════════════
{
  routes.push(['/api/batch/b2', () => jsonResp({ batchId: 'b2', status: 'completed', total: 0, succeeded: 0, failed: 0, tasks: [] })]);
  const got = { closed: 0 };
  subscribeBatch('b2', { onClose: () => got.closed++ });
  await sleep(30);
  // 烧掉 2 次重连额度
  lastEs('/api/batch/b2').fail(); await sleep(60);
  lastEs('/api/batch/b2').fail(); await sleep(60);
  assert.equal(esFor('/api/batch/b2').length, 3, '前置：已重连 2 次');
  // 流上来了一个事件 → 额度应清零
  lastEs('/api/batch/b2').emit('task_progress', { taskId: 'x' });
  // 此后应当还能再扛 3 次断线（共 3 个新实例），第 4 次才降级
  lastEs('/api/batch/b2').fail(); await sleep(60);
  lastEs('/api/batch/b2').fail(); await sleep(60);
  lastEs('/api/batch/b2').fail(); await sleep(60);
  assert.equal(esFor('/api/batch/b2').length, 6, '事件后额度清零：又重连了 3 次（旧实现这里只剩 1 次）');
  assert.equal(countFetch('/api/batch/b2'), 0, '额度未耗尽前不轮询');
  lastEs('/api/batch/b2').fail(); await sleep(120);
  assert.ok(countFetch('/api/batch/b2') >= 1, '第 4 次断线才降级轮询');
  await sleep(80);
  assert.equal(got.closed, 1);
  ok('T2 重连计数随事件清零（修终身 3 次额度）');
}

// ════ T3: 单任务降级轮询（GET /api/tasks/:id 平铺字段 → SSE 帧形状）══════
{
  let polls = 0;
  routes.push(['/api/tasks/v1', () => {
    polls++;
    return jsonResp(polls === 1
      ? { taskId: 'v1', status: 'running', progress: 42 }
      : { taskId: 'v1', status: 'completed', progress: 100, url: 'https://v/sig.mp4', protectedUrl: '/api/videos/file/v1', filename: 'f.mp4', displayName: '片段1', durationSec: 5 });
  }]);
  const got = { progress: [], completed: [], failed: [], closed: 0 };
  subscribeTask('v1', {
    onProgress: (d) => got.progress.push(d),
    onCompleted: (d) => got.completed.push(d),
    onFailed: (d) => got.failed.push(d),
    onClose: () => got.closed++,
  });
  await sleep(30);
  await killSse('/api/tasks/v1');
  await sleep(250);
  assert.equal(got.completed.length, 1);
  assert.equal(got.completed[0].resultUrl, 'https://v/sig.mp4');
  assert.equal(got.completed[0].videoUrl, 'https://v/sig.mp4');
  assert.equal(got.completed[0].extra.protectedUrl, '/api/videos/file/v1');
  assert.equal(got.completed[0].extra.filename, 'f.mp4');
  assert.ok(got.progress.some((p) => p.progress === 42), '轮询期间转发 progress');
  assert.equal(got.failed.length, 0);
  assert.equal(got.closed, 1);
  ok('T3 task 降级轮询：平铺字段映射为 SSE 帧形状');
}

// ════ T4: 连续 404 放弃（exports 等不可查任务 → 等价旧 onClose 语义）═════
{
  routes.push(['/api/tasks/gone', () => jsonResp({ error: 'not found' }, 404)]);
  const got = { completed: 0, failed: 0, closed: 0 };
  subscribeTask('gone', {
    onCompleted: () => got.completed++,
    onFailed: () => got.failed++,
    onClose: () => got.closed++,
  });
  await sleep(30);
  await killSse('/api/tasks/gone');
  await sleep(300);
  assert.equal(got.closed, 1, '404×3 后放弃并 onClose');
  assert.equal(got.completed, 0, '404 不得误报完成');
  assert.equal(got.failed, 0, '404 不得误报失败');
  ok('T4 轮询连续 404 → 放弃 + onClose，不误报');
}

// ════ T5: caller close() 全停 ════════════════════════════════════════════
{
  routes.push(['/api/batch/b5', () => jsonResp({ batchId: 'b5', status: 'running', total: 1, succeeded: 0, failed: 0, tasks: [] })]);
  const got = { closed: 0 };
  const handle = subscribeBatch('b5', { onClose: () => got.closed++ });
  await sleep(30);
  await killSse('/api/batch/b5');
  await sleep(120);
  assert.ok(countFetch('/api/batch/b5') >= 1, '前置：降级轮询已启动');
  handle.close();
  const n = countFetch('/api/batch/b5');
  await sleep(150);
  assert.equal(countFetch('/api/batch/b5'), n, 'close() 后轮询停止');
  assert.equal(got.closed, 0, '调用方主动 close 不触发 onClose（维持旧语义）');
  ok('T5 close() 停 SSE + 停降级轮询');
}

// ════ T6: SSE 正常终态不进降级轮询 ═══════════════════════════════════════
{
  const got = { batchDone: 0, closed: 0 };
  subscribeBatch('b6', { onBatchCompleted: () => got.batchDone++, onClose: () => got.closed++ });
  await sleep(30);
  lastEs('/api/batch/b6').emit('batch_completed', { status: 'completed' });
  await sleep(120);
  assert.equal(got.batchDone, 1);
  assert.equal(got.closed, 1);
  assert.equal(countFetch('/api/batch/b6'), 0, '正常终态不应有任何兜底轮询');
  assert.ok(lastEs('/api/batch/b6').closed, '终态后 EventSource 已关闭');
  ok('T6 SSE 正常终态：直接收口，零轮询');
}

// ════ 静态契约：接线与版本号 ═════════════════════════════════════════════
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const bs = read('../public/modules/backend_stream.js');
  assert.match(bs, /retries = 0;/, 'backend_stream: 事件清零重连计数');
  assert.match(bs, /FALLBACK_POLL_INTERVAL_MS = 5000/);
  assert.match(bs, /_startFallbackPoll\(\)/);

  const main = read('../public/main.js');
  assert.match(main, /_registerGlobalBatchReconciler/);
  assert.match(main, /reconcileVideoTasksOnWake/);
  assert.match(main, /addEventListener\("online"/, 'main: online 网络恢复对账');

  const vt = read('../public/modules/videoTasks.js');
  assert.match(vt, /function reconcileVideoTasksOnWake/);
  assert.match(vt, /reconcileVideoTasksOnWake,/, 'videoTasks: 已导出');
  assert.match(vt, /activeTaskCount\(\) > 0\) return;/, 'videoTasks: 活跃闭包守卫');

  const as = read('../public/modules/assets.js');
  assert.match(as, /_reattachedBatchKeys/, 'assets: reattach 防重注册表');

  const html = read('../public/workspace.html');
  assert.match(html, /backend_stream\.js\?v=101/, 'importmap: backend_stream 已 bump');
  assert.match(html, /videoTasks\.js\?v=122/, 'importmap: videoTasks 已 bump');
  assert.match(html, /assets\.js\?v=163/, 'importmap: assets 已 bump');
  ok('静态契约：模块接线 + importmap 版本号');
}

console.log('\n[backend-stream-fallback] ' + passed + ' 组断言全部通过');
process.exit(0);
