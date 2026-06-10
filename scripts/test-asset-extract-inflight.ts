/**
 * 资产提取 in-flight 登记表 + 刷新续接链路 契约测试
 *
 * 锁两层：
 * 1. lib/assets-extract-inflight.ts 状态机行为（防重 / 进度 / 结束 / 过期兜底）。
 * 2. 路由与前端源码里的关键接线不被后续改动悄悄删掉（同仓库其它
 *    test-*-contract 的源码断言风格）。
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

const wsHtml = readFileSync(path.join(root, 'public/workspace.html'), 'utf8');
const mainJs = readFileSync(path.join(root, 'public/main.js'), 'utf8');
const mainAssetsVer = (mainJs.match(/modules\/assets\.js\?v=(\d+)/) || [])[1];
const mapAssetsVer = (wsHtml.match(/"\/modules\/assets\.js\?v=(\d+)"/) || [])[1];
assert(!!mainAssetsVer && mainAssetsVer === mapAssetsVer,
  `cache: main.js 与 importmap 的 assets.js 版本一致 (main=${mainAssetsVer}, map=${mapAssetsVer})`);

if (failed) {
  console.error(`[test-asset-extract-inflight] ${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log('[test-asset-extract-inflight] all assertions passed');
