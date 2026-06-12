// 管理后台口径契约测试（静态源码检查，不连库）。
// 锁定 2026-06 瘦身的关键决策：死载荷不复活、needs_review 上首页、七页导航、
// 任务 reason SQL 单源、退役页面不回归。配套登记表：docs/admin-metrics-registry.md
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function assert(cond, message) {
  if (cond) { console.log('ok - ' + message); return; }
  failures += 1;
  console.error('FAIL - ' + message);
}
function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}
function stripLineComments(text) {
  return text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
}

// 1. stats API 死载荷保持死亡（totalTokens 曾是积分被错标为 token；警示注释允许提及，代码不允许）
const stats = stripLineComments(read('app/api/admin/stats/route.ts'));
for (const banned of ['userUsage', 'totalTokens', 'recentUsers', 'paidAmounts', 'onlineUsers']) {
  assert(!stats.includes(banned), `stats API 不应包含死载荷字段 ${banned}`);
}
for (const kept of ['totalUsers', 'totalProjects', 'onlineCount', 'paidUsers']) {
  assert(stats.includes(kept), `stats API 应保留 KPI 字段 ${kept}`);
}

// 2. problem-queue 返回 needsReview + failedTasks；reason SQL 走单源工具
const pq = read('app/api/admin/problem-queue/route.ts');
assert(pq.includes('needsReviewTasks'), 'problem-queue 应返回 needsReviewTasks');
assert(pq.includes('failedTasks'), 'problem-queue 应返回 failedTasks（近24h失败）');
assert(pq.includes("from '@/lib/admin-task-sql'"), 'problem-queue 应引用 admin-task-sql 单源');
const tasksApi = read('app/api/admin/tasks/route.ts');
assert(tasksApi.includes("from '@/lib/admin-task-sql'"), 'tasks API 应引用 admin-task-sql 单源');
const rawCoalesce = /COALESCE\([^)]*error/;
assert(!rawCoalesce.test(pq), 'problem-queue 不应再有手写 COALESCE error 口径');
assert(!rawCoalesce.test(tasksApi), 'tasks API 不应再有手写 COALESCE error 口径');

// 3. admin-task-sql 列结构红线（video_tasks/exports 无 status_reason；batches 只有 error_message）
const taskSql = read('lib/admin-task-sql.ts');
const simpleBody = taskSql.split('simpleTaskReasonSql')[1] || '';
assert(!simpleBody.includes('status_reason'), 'simpleTaskReasonSql 不得引用 status_reason（video_tasks/exports 无此列）');
const batchBody = (taskSql.split('batchReasonSql')[1] || '').split('batchTaskReasonSql')[0] || '';
assert(!batchBody.includes('error_msg'), 'batchReasonSql 不得引用 error_msg（batches 无此列）');

// 4. 首页 = 问题队列工作台（needs_review 卡 + 全部任务 + 统一写路径）
const home = read('app/admin/route.ts');
assert(home.includes('id="needsReview"'), '首页应渲染 needs_review 卡片');
assert(home.includes('id="failedTasks"'), '首页应渲染近24h失败卡片');
assert(home.includes('data-task-search="true"'), '首页应包含全部任务工作台');
assert(home.includes("fetch('/api/admin/tasks'"), '首页单任务动作应走 /api/admin/tasks 统一写路径');
assert(home.includes('bulk_requeue'), '首页应保留批量重排（problem-queue bulk_requeue）');

// 5. 导航 = 七页三分组，退役页不回归
const shell = read('lib/admin-shell.ts');
const expectedNav = ['/admin', '/admin/search', '/admin/billing', '/admin/usage-stats', '/admin/system', '/admin/content', '/admin/knowledge'];
for (const href of expectedNav) {
  assert(shell.includes(`href: '${href}'`), `导航应包含 ${href}`);
}
const retiredNav = ['/admin/users', '/admin/tasks', '/admin/token-stats', '/admin/time-stats', '/admin/staff', '/admin/config', '/admin/key-pool', '/admin/storage'];
for (const href of retiredNav) {
  assert(!shell.includes(`href: '${href}'`), `导航不应再包含退役页 ${href}`);
}
const navCount = (shell.match(/href: '\/admin/g) || []).length;
assert(navCount === 7, `导航项应恰为 7 个，实际 ${navCount}`);

// 6. 退役页面路由文件必须不存在
for (const rel of [
  'app/admin/tasks/route.ts',
  'app/admin/users/route.ts',
  'app/admin/token-stats/route.ts',
  'app/admin/time-stats/route.ts',
  'app/admin/staff/route.ts',
  'app/admin/config/route.ts',
  'app/admin/key-pool/route.ts',
  'app/admin/storage/route.ts',
  'app/admin/knowledge/dry-run/route.ts',
  'app/admin/knowledge/audits/route.ts',
]) {
  assert(!existsSync(join(root, rel)), `退役页面不应存在：${rel}`);
}

// 7. 合并页就位且接线正确
const usage = read('app/admin/usage-stats/route.ts');
assert(usage.includes('/api/admin/token-stats') && usage.includes('/api/admin/time-stats'), '用量统计应同时接 token/time 两个 API');
assert(usage.includes('data-tim-blindspot'), '时间 tab 应有口径盲区警示条（文案由 API notes 单源下发）');
const system = read('app/admin/system/route.ts');
for (const marker of ['data-config-banner-enabled', 'data-key-pool-table', 'data-storage-table', 'data-staff-table', 'id="logs"']) {
  assert(system.includes(marker), `系统页应包含合并区块 ${marker}`);
}
const search = read('app/admin/search/route.ts');
assert(search.includes('data-users-table="true"') && search.includes("fetch('/api/admin/users'"), '客服检索应内嵌用户管理（表格+API 接线）');
const knowledge = read('app/admin/knowledge/route.ts');
assert(knowledge.includes("searchParams.get('tab')"), '知识库单页应支持 ?tab= 直达');

// 8. 新写页面不得手抄 esc（统一走壳层 adminUi）
assert(shell.includes('window.adminUi'), '壳层应定义 adminUi 共享工具');
for (const rel of ['app/admin/route.ts', 'app/admin/search/route.ts', 'app/admin/usage-stats/route.ts', 'app/admin/system/route.ts']) {
  const text = read(rel);
  assert(!text.includes('function esc('), `${rel} 不应手抄 esc（用 adminUi.esc）`);
}

// 9. 登记表存在且覆盖七页
const registry = read('docs/admin-metrics-registry.md');
for (const page of ['/admin）', '/admin/search', '/admin/billing', '/admin/usage-stats', '/admin/system', '/admin/content', '/admin/knowledge']) {
  assert(registry.includes(page), `登记表应覆盖 ${page}`);
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\ntest-admin-metrics-registry: 全部通过');
