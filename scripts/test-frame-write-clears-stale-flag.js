#!/usr/bin/env node
/**
 * 验证「图新标记旧」孤儿 stale flag 修复（服务端侧）。
 *
 * 跑法:
 *   node scripts/test-frame-write-clears-stale-flag.js
 *
 * 背景（proj_1780898501082 / storyboard_10 误拦案例）:
 *   _staleFlags.storyboard_N 的清除此前只存在于前端"亲历 task_completed"的回调里；
 *   服务端 executor / 上传 route 落图 + 落新 sourceHash 时从不清 flag。页面刷新/重连
 *   窗口内完成的重生成会留下孤儿标记，导致"确认分镜图"被误拦。
 *
 * 修复后约定（本测试守护）:
 *   1. batch-executors.ts 首帧写盘点：落图同时清 storyboard_${groupIdx}；
 *   2. batch-executors.ts 尾帧写盘点：落图同时清 tail_frame_${groupIdx}；
 *   3. app/api/frames/upload：上传首/尾帧同时清对应 flag；
 *   4. storyboard.js confirmImages：拦截前先调 /api/orchestration/compute-stale
 *      权威重算，mirror 清残留；真 stale 的 toast 点名镜头号；
 *   5. main.js 注入 applyServerStaleFlags 且 storyboard.js 版本号两处一致；
 *   6. patchProjectForUser 能把 { storyboards, _staleFlags } 形态的 patch
 *      真实落库（_staleFlags 下划线键持久化 + 版本号 +1）——这是 1/2/3 依赖的机制。
 *
 * 不依赖已有 data/qd.sqlite —— 用 mkdtemp 起临时 DB，跑完不污染本地数据。
 */
const { mkdtempSync } = require('node:fs');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const ROOT = join(__dirname, '..');

let failed = 0;
let passed = 0;
function record(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok - ' + name);
  } catch (e) {
    failed += 1;
    console.error('  FAIL - ' + name);
    console.error('    ' + ((e && e.message) || e));
  }
}

/* ============================================================
 * Part A: 源码契约断言（无依赖，任何环境可跑）
 * ============================================================ */
console.log('Part A: 源码契约断言');

const executorsSrc = readFileSync(join(ROOT, 'lib/batch-executors.ts'), 'utf8');
const uploadSrc = readFileSync(join(ROOT, 'app/api/frames/upload/route.ts'), 'utf8');
const storyboardSrc = readFileSync(join(ROOT, 'public/modules/storyboard.js'), 'utf8');
const mainSrc = readFileSync(join(ROOT, 'public/main.js'), 'utf8');
const workspaceHtml = readFileSync(join(ROOT, 'public/workspace.html'), 'utf8');

record('首帧 executor 写盘点清 storyboard_${groupIdx} 并随 storyboards 一起返回 _staleFlags patch', () => {
  const anchor = executorsSrc.indexOf("'storyboard-image-writeback'");
  assert.ok(anchor > 0, '找不到 storyboard-image-writeback 锚点');
	  const seg = executorsSrc.slice(anchor, anchor + 1200);
	  assert.match(seg, /delete nextStaleFlags\[`storyboard_\$\{groupIdx\}`\]/);
	  assert.match(seg, /return \{ (storyboards|\.\.\.basePatch), _staleFlags: nextStaleFlags \}/);
	});

record('尾帧 executor 写盘点清 tail_frame_${groupIdx}', () => {
  const anchor = executorsSrc.indexOf("'tail-frame-image-writeback'");
  assert.ok(anchor > 0, '找不到 tail-frame-image-writeback 锚点');
  const seg = executorsSrc.slice(anchor, anchor + 1200);
  assert.match(seg, /delete nextStaleFlags\[`tail_frame_\$\{groupIdx\}`\]/);
  assert.match(seg, /return \{ storyboards: sbs, _staleFlags: nextStaleFlags \}/);
});

record('frames/upload 上传写盘点按 isTail 清对应 flag', () => {
	  assert.match(uploadSrc, /const staleKey = isTail \? `tail_frame_\$\{groupIdx\}` : `storyboard_\$\{groupIdx\}`/);
	  assert.match(uploadSrc, /delete nextStaleFlags\[staleKey\]/);
	  assert.match(uploadSrc, /return \{ (storyboards|\.\.\.basePatch), _staleFlags: nextStaleFlags \}/);
	});

record('confirmImages 拦截前调 compute-stale 权威重算并 mirror storyboard_ 前缀', () => {
  const anchor = storyboardSrc.indexOf('export async function confirmImages');
  assert.ok(anchor > 0);
  const seg = storyboardSrc.slice(anchor, anchor + 4000);
  const computeAt = seg.indexOf('/api/orchestration/compute-stale');
  const toastAt = seg.indexOf('张分镜图已过期');
  assert.ok(computeAt > 0, 'confirmImages 里找不到 compute-stale 调用');
  assert.ok(toastAt > computeAt, '权威重算必须发生在"已过期"拦截 toast 之前');
  assert.ok(seg.indexOf('_applyServerStaleFlags(["storyboard_"]') > 0, '应按 storyboard_ 前缀 mirror');
  assert.ok(seg.indexOf('"镜头" + sis.map') > 0, '真 stale 拦截应点名镜头号');
});

record('main.js 注入 applyServerStaleFlags 且从 assets.js 导入 mirror 函数', () => {
  assert.match(mainSrc, /_applyServerStaleFlagsToProject,/);
  assert.match(mainSrc, /applyServerStaleFlags: \(prefixes, serverFlags\) => _applyServerStaleFlagsToProject\(project, prefixes, serverFlags\)/);
});

record('storyboard.js 版本号由 workspace.html importmap 承载，若 main.js 有显式 import 则必须一致', () => {
  const mainVer = (mainSrc.match(/\.\/modules\/storyboard\.js\?v=(\d+)/) || [])[1];
  const mapVer = (workspaceHtml.match(/"\/modules\/storyboard\.js":\s*"\/modules\/storyboard\.js\?v=(\d+)"/) || [])[1];
  assert.ok(mapVer, 'workspace.html importmap 找不到 storyboard.js 版本号');
  if (mainVer) assert.equal(mainVer, mapVer, `双实例风险: main.js 用 v=${mainVer}, importmap 用 v=${mapVer}`);
});

/* ============================================================
 * Part B: patchProjectForUser 行为验证（需要 better-sqlite3）
 * ============================================================ */
console.log('Part B: patchProjectForUser { storyboards, _staleFlags } 落库行为');

let sqliteOk = true;
try {
  // 仅 require 不够：JS 包装总能加载，原生 .node 是按平台编译的，实例化才见真章。
  const BetterSqlite3 = require('better-sqlite3');
  new BetterSqlite3(':memory:').close();
} catch (e) {
  sqliteOk = false;
  console.log('  SKIP - better-sqlite3 原生模块在本机不可用（请在 Mac 上跑本脚本补全 Part B）');
}

if (sqliteOk) {
  const TMP_DIR = mkdtempSync(join(tmpdir(), 'origin-stale-clear-it-'));
  process.env.ORIGIN_DATA_DIR = TMP_DIR;
  process.env.DB_PATH = join(TMP_DIR, 'qd.sqlite');
  process.env.FRAME_WORKFLOW_ASSERT_ALIGNMENT = '0';
  process.env.NODE_ENV = 'test';

  require('./_ts-require-hook.js');
  const { getDb } = require('../lib/db.ts');
  const projectsDb = require('../lib/projects-db.ts');

  const db = getDb();
  const info = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES (?, ?, ?, ?, 1)`,
  ).run('stale-clear-it', 'stale-clear-it@example.com', 'Tester', 'fake-hash');
  const userId = Number(info.lastInsertRowid);

  const created = projectsDb.createProjectForUser(userId, { title: 'stale-clear-it' });
  const projectId = created.id;
  projectsDb.patchProjectForUser(projectId, userId, () => ({
    shots: [{ idx: 1, visual: 'shot-0' }, { idx: 2, visual: 'shot-1' }],
    storyboards: [
      { idx: 0, shotIndices: [0], imageUrl: '/api/images/file/x0', firstFrameUrl: '/api/images/file/x0' },
      { idx: 1, shotIndices: [1], imageUrl: '/api/images/file/x1', firstFrameUrl: '/api/images/file/x1' },
    ],
    _staleFlags: { storyboard_0: true, storyboard_1: true, tail_frame_0: true, assets: true },
  }));

  record('种子 _staleFlags（下划线键）能写入并读回', () => {
    const p = projectsDb.getProjectByIdForUser(projectId, userId);
    assert.equal(p._staleFlags.storyboard_0, true);
    assert.equal(p._staleFlags.assets, true);
  });

  record('patch { storyboards, _staleFlags } 与 executor 同形态：删一个键、其余保留、版本 +1', () => {
    const before = projectsDb.getProjectByIdForUser(projectId, userId);
    const beforeVersion = Number(before.version) || 0;
    // 与 batch-executors.ts 首帧写盘点完全相同的 patch 形态
    projectsDb.patchProjectForUser(projectId, userId, (fresh) => {
      const storyboards = Array.isArray(fresh.storyboards) ? [...fresh.storyboards] : [];
      const prevStaleFlags = fresh._staleFlags;
      if (prevStaleFlags && typeof prevStaleFlags === 'object' && prevStaleFlags['storyboard_0']) {
        const nextStaleFlags = { ...prevStaleFlags };
        delete nextStaleFlags['storyboard_0'];
        return { storyboards, _staleFlags: nextStaleFlags };
      }
      return { storyboards };
    });
    const after = projectsDb.getProjectByIdForUser(projectId, userId);
    assert.equal(after._staleFlags.storyboard_0, undefined, 'storyboard_0 应被清除');
    assert.equal(after._staleFlags.storyboard_1, true, '其他 storyboard flag 应保留');
    assert.equal(after._staleFlags.tail_frame_0, true, 'tail flag 应保留');
    assert.equal(after._staleFlags.assets, true, 'assets flag 应保留');
    assert.ok(Number(after.version) > beforeVersion, 'version 应递增');
  });

  record('无 flag 时返回 { storyboards } 不破坏 _staleFlags', () => {
    projectsDb.patchProjectForUser(projectId, userId, (fresh) => {
      const storyboards = Array.isArray(fresh.storyboards) ? [...fresh.storyboards] : [];
      const prevStaleFlags = fresh._staleFlags;
      if (prevStaleFlags && typeof prevStaleFlags === 'object' && prevStaleFlags['storyboard_0']) {
        const nextStaleFlags = { ...prevStaleFlags };
        delete nextStaleFlags['storyboard_0'];
        return { storyboards, _staleFlags: nextStaleFlags };
      }
      return { storyboards };
    });
    const after = projectsDb.getProjectByIdForUser(projectId, userId);
    assert.equal(after._staleFlags.storyboard_1, true);
    assert.equal(after._staleFlags.assets, true);
  });
}

console.log('');
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
