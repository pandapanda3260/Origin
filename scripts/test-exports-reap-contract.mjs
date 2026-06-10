/**
 * 契约：导出任务不许永久卡在"导出中"，剪辑页状态不许跨项目串台。
 *
 * 背景（2026-06-10 实锤 4674f962）：
 *   1. doExport 跑在 web 进程 setImmediate 里，进程死掉/ffmpeg 挂死后
 *      exports 行永久 running → /api/tasks/[id]/stream 永远轮到 running →
 *      前端永远"导出中 50%"。dev 默认 recoveryEnabled=true → reapOnStart=false，
 *      把 reapOrphanExports 一并关掉了 → exports 没有任何收尸通道。
 *   2. 剪辑页动作锁/遮罩/导出 SSE 订阅是模块级+共享静态 DOM，切项目不收口，
 *      A 项目的"导出中 N%"会画进 B 项目页面，回调还可能把 A 的
 *      exportTaskId/exportUrl 写进 B 的内存 editData。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 后端：exports 收尸通道独立于 reapOnStart ────────────────────────────────
const init = read('../lib/init-executors.ts');
assert.match(
  init,
  /__qd_exports_reaped__/,
  'init-executors: exports reap 必须有独立的 globalThis 防重 key',
);
assert.match(
  init,
  /!workerProcess && !externalWorkerExpected && !\(globalThis as any\)\[exportsReapKey\]/,
  'init-executors: 单进程形态必须无条件回收孤儿导出（不依赖 reapOnStart/recoveryEnabled）',
);
assert.match(
  init,
  /startExportsStaleReaper\(\)/,
  'init-executors: 必须启动停滞导出周期回收（兜 ffmpeg 挂死）',
);
const reapBlock = init.slice(init.indexOf('const exportsReapKey'));
assert.ok(
  !/reapOnStart/.test(reapBlock.slice(0, reapBlock.indexOf('}'))),
  'init-executors: exports reap 块不得引用 reapOnStart（那正是当年把它关掉的开关）',
);

const reap = read('../lib/exports-reap.ts');
assert.match(reap, /export function reapStaleExports/, 'exports-reap: 必须提供 stale 回收');
assert.match(
  reap,
  /STALE_EXPORT_MAX_AGE_MS = 30 \* 60 \* 1000/,
  'exports-reap: stale 阈值 30 分钟（阶段间隔正常是秒~分钟级）',
);
assert.match(
  reap,
  /updated_at < @cutoff/,
  'exports-reap: stale 判定必须基于 updated_at（doExport 每个 setProg 节点都会刷）',
);
assert.match(
  reap,
  /markExportFailureInEditData/,
  'exports-reap: 判死时必须同步清理 editData（exportTaskId/composeRuns），否则前端胶囊不解锁',
);

// ── 前端：切项目收口 + 纪元守卫 ────────────────────────────────────────────
const edit = read('../public/modules/edit.js');
assert.match(edit, /var _editUiEpoch = 0;/, 'edit.js: 必须有项目级 UI 纪元');
assert.match(
  edit,
  /function _teardownProjectScopedEditUi\(\)[\s\S]*?_editUiEpoch\+\+[\s\S]*?_exportStreamHandle\.close\(\)/,
  'edit.js: 切项目必须作废纪元并关闭导出流订阅',
);
assert.match(
  edit,
  /syncEditProject\(p\)[\s\S]{0,400}_teardownProjectScopedEditUi\(\)/,
  'edit.js: syncEditProject 在项目 id 变化时必须收口',
);
// 导出流四个回调 + 成片流回调都必须有纪元守卫
const guardCount = (edit.match(/epoch !== _editUiEpoch/g) || []).length;
assert.ok(
  guardCount >= 10,
  `edit.js: 纪元守卫数量 ${guardCount} >= 10（导出流回调/成片流回调/await 尾巴都要守）`,
);
assert.match(
  edit,
  /_resyncEditDataFromServer\(\)\s*\{\s*if \(!project \|\| !project\.id\) return;\s*var pid = String\(project\.id\);/,
  'edit.js: _resyncEditDataFromServer 必须按发起时 pid 守卫，防止把旧项目数据灌进新项目',
);

// ── importmap：edit.js 已 bump 到含修复的版本 ──────────────────────────────
const html = read('../public/workspace.html');
const m = html.match(/edit\.js\?v=(\d+)/);
assert.ok(m && Number(m[1]) >= 140, 'importmap: edit.js 版本 >= 140（含切项目收口修复）');

console.log('exports reap / edit cross-project contract tests passed');
