/**
 * 分析型 SSE 任务 in-flight 登记表 + 刷新续接链路 契约测试
 *
 * 锁三层：
 * 1. lib/stage-inflight.ts（经 assets 薄壳）状态机行为（防重 / 进度 / 结束 / 过期兜底）。
 * 2. 资产提取与剧本生成三路由的关键接线不被后续改动悄悄删掉。
 * 3. shots 批次防重（batch/start 复用 + shots.js 跟踪守卫）。
 *
 * 运行：npm run test:asset-extract-inflight
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  beginAssetExtract,
  progressAssetExtract,
  endAssetExtract,
  getAssetExtractState,
} from '../lib/assets-extract-inflight';
import { beginStageRun, getStageRun, SCRIPT_GENERATE_STAGE } from '../lib/stage-inflight';

let failed = 0;
function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ── 1. 状态机 ──────────────────────────────────────────────────────
console.log('[inflight] state machine');
const OWNER = 9527; // 数字 ownerId（getCurrentUser 返回的 user.id 是 number）
const PROJ = 'proj_test_inflight';

const b1 = beginAssetExtract(OWNER, PROJ);
assert(b1.ok, 'begin: 首次登记成功');
const b2 = beginAssetExtract(OWNER, PROJ);
assert(!b2.ok && b2.existing?.status === 'running', 'begin: running 期间重复登记被拒（防双跑双扣费）');
assert(beginAssetExtract(OWNER, 'proj_other').ok, 'begin: 其它项目不受影响');
assert(beginAssetExtract('user_b', PROJ).ok, 'begin: 其它用户同名项目不受影响');

progressAssetExtract(OWNER, PROJ, '正在识别场景与道具…', 60);
let st = getAssetExtractState(OWNER, PROJ);
assert(st?.status === 'running' && st.step === '正在识别场景与道具…' && st.pct === 60, 'progress: 步骤与进度可查');
assert(getAssetExtractState(String(OWNER), PROJ)?.pct === 60, 'key: ownerId 数字/字符串同键');

endAssetExtract(OWNER, PROJ, 'done');
st = getAssetExtractState(OWNER, PROJ);
assert(st?.status === 'done' && st.pct === 100 && !!st.endedAt, 'end(done): 完成态保留可补课');
progressAssetExtract(OWNER, PROJ, '不该生效', 1);
assert(getAssetExtractState(OWNER, PROJ)?.pct === 100, 'end 后 progress 不再生效');
assert(beginAssetExtract(OWNER, PROJ).ok, 'begin: done 之后允许发起新一轮');

endAssetExtract(OWNER, PROJ, 'error', '资产抽取失败：测试');
st = getAssetExtractState(OWNER, PROJ);
assert(st?.status === 'error' && (st.error || '').includes('测试'), 'end(error): 失败原因可查');

// 过期兜底：running 条目长时间无更新 → 查询时翻成 error（罕见后处理抛错的自愈路径）
const b3 = beginAssetExtract(OWNER, 'proj_stale');
assert(b3.ok, 'stale: 登记成功');
const staleSt = getAssetExtractState(OWNER, 'proj_stale')!;
(staleSt as any).updatedAt = Date.now() - 16 * 60 * 1000;
st = getAssetExtractState(OWNER, 'proj_stale');
assert(st?.status === 'error' && !!st.endedAt, 'stale: 超过 15 分钟无心跳自动翻 error');
assert(beginAssetExtract(OWNER, 'proj_stale').ok, 'stale: 翻 error 后允许重新发起');

// ── 1.5 stage 维度隔离 ─────────────────────────────────────────────
console.log('[inflight] stage isolation');
const sProj = 'proj_stage_iso';
assert(beginAssetExtract(OWNER, sProj).ok, 'stage: 资产提取登记成功');
assert(beginStageRun(OWNER, sProj, SCRIPT_GENERATE_STAGE, { meta: { mode: 'adapt' } }).ok,
  'stage: 同项目剧本生成与资产提取互不阻塞（不同 stage）');
assert(!beginStageRun(OWNER, sProj, SCRIPT_GENERATE_STAGE).ok,
  'stage: 同项目剧本生成第二路被拒（full-create/expand/confirm 共用 stage）');
assert(getStageRun(OWNER, sProj, SCRIPT_GENERATE_STAGE)?.meta?.mode === 'adapt', 'stage: meta.mode 可查');

// ── 2. 源码接线断言 ────────────────────────────────────────────────
console.log('[inflight] source wiring');
const root = path.resolve(__dirname, '..');
const routeSrc = readFileSync(path.join(root, 'app/api/assets/extract/route.ts'), 'utf8');
assert(routeSrc.includes("from '@/lib/assets-extract-inflight'"), 'route: 引入 inflight 模块');
assert(routeSrc.includes('beginAssetExtract(user.id, projectId!)'), 'route: 开始时登记');
assert(routeSrc.includes('已在后台进行中'), 'route: 重复提取有防重拒绝');
assert(routeSrc.includes("endInflight('done')"), 'route: 成功路径标记 done');
assert((routeSrc.match(/endInflight\('error'/g) || []).length >= 2, 'route: LLM 失败与写库失败都标记 error');
assert(routeSrc.indexOf("endInflight('done')") < routeSrc.indexOf('writer.done({'), 'route: done 标记先于 SSE done');

const statusSrc = readFileSync(path.join(root, 'app/api/assets/extract/status/route.ts'), 'utf8');
assert(statusSrc.includes('getAssetExtractState'), 'status route: 读 inflight 状态');

const assetsJs = readFileSync(path.join(root, 'public/modules/assets.js'), 'utf8');
assert(assetsJs.includes('_maybeResumeAssetExtract'), 'assets.js: 有刷新续接入口');
assert(assetsJs.includes('/api/assets/extract/status'), 'assets.js: 轮询 status 接口');
assert(assetsJs.includes('reloadProjectFromServer'), 'assets.js: 完成后拉服务器权威项目');
assert(assetsJs.indexOf('_maybeResumeAssetExtract()') < assetsJs.indexOf('if (hasAssets && hasAssetItems)'),
  'assets.js: refreshAssetsPage 挂了续接检查');
assert(assetsJs.includes('已在后台进行中'), 'assets.js: 防重命中时续接而非报错');

// 剧本生成三路由共用 script_generate stage 的接线
for (const routePath of [
  'app/api/script/workflow/full-create/route.ts',
  'app/api/script/workflow/expand/route.ts',
  'app/api/script/workflow/consult/confirm/route.ts',
]) {
  const src = readFileSync(path.join(root, routePath), 'utf8');
  const short = routePath.split('/').slice(-2)[0];
  assert(src.includes('SCRIPT_GENERATE_STAGE'), `script route(${short}): 共用 script_generate stage`);
  assert(src.includes('已在后台进行中'), `script route(${short}): 有防重拒绝`);
  assert(src.includes("endInflight('done')"), `script route(${short}): 成功路径标记 done`);
  assert((src.match(/endInflight\('error'/g) || []).length >= 2, `script route(${short}): 失败路径标记 error（≥2 处）`);
}
const scriptStatusSrc = readFileSync(path.join(root, 'app/api/script/workflow/generate-status/route.ts'), 'utf8');
assert(scriptStatusSrc.includes('SCRIPT_GENERATE_STAGE'), 'script status route: 读 script_generate 状态');

const scriptJs = readFileSync(path.join(root, 'public/modules/script.js'), 'utf8');
assert(scriptJs.includes('_maybeResumeScriptGenerate'), 'script.js: 有刷新续接入口');
assert(scriptJs.includes('/api/script/workflow/generate-status'), 'script.js: 轮询 generate-status 接口');
assert(scriptJs.indexOf('_maybeResumeScriptGenerate()') < scriptJs.indexOf('if (project.script) {'),
  'script.js: refreshScriptPage 挂了续接检查');
assert((scriptJs.match(/_isBackgroundScriptGenError\(e\)/g) || []).length >= 3,
  'script.js: 三条生成路径的 catch 都转续接（generate/revise/confirm）');

// shots 批次防重：服务端复用 + 前端跟踪守卫
const batchStartSrc = readFileSync(path.join(root, 'app/api/batch/start/route.ts'), 'utf8');
assert(batchStartSrc.includes('findActiveBatchForType'), 'batch/start: shots 查活跃批次');
assert(batchStartSrc.includes('reused: true'), 'batch/start: shots 命中后复用而非新建');
const batchesLib = readFileSync(path.join(root, 'lib/batches.ts'), 'utf8');
assert(batchesLib.includes('export function findActiveBatchForType'), 'lib/batches: 防重查询 helper 在位');
const shotsJs = readFileSync(path.join(root, 'public/modules/shots.js'), 'utf8');
assert(shotsJs.includes('_trackingShotsBatchByProject'), 'shots.js: 本会话批次跟踪表在位');
assert(shotsJs.indexOf('_trackingShotsBatchByProject.get(_trackKey)') < shotsJs.indexOf('"/api/batch/start"'),
  'shots.js: 跟踪守卫先于 batch/start 调用');
assert(shotsJs.includes('_trackingShotsBatchByProject.delete(_trackKey)'), 'shots.js: finish 时清理跟踪');

const wsHtml = readFileSync(path.join(root, 'public/workspace.html'), 'utf8');
const mainJs = readFileSync(path.join(root, 'public/main.js'), 'utf8');
for (const mod of ['assets', 'script', 'shots']) {
  const mainVer = (mainJs.match(new RegExp(`modules/${mod}\\.js\\?v=(\\d+)`)) || [])[1];
  const mapVer = (wsHtml.match(new RegExp(`"/modules/${mod}\\.js\\?v=(\\d+)"`)) || [])[1];
  assert(!!mainVer && mainVer === mapVer,
    `cache: main.js 与 importmap 的 ${mod}.js 版本一致 (main=${mainVer}, map=${mapVer})`);
}

if (failed) {
  console.error(`[test-asset-extract-inflight] ${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log('[test-asset-extract-inflight] all assertions passed');
