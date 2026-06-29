/**
 * 在线精修 iframe 保活 + 剪辑器桥接增强 契约测试
 *
 * 背景（2026-06-10，方案：在线精修iframe保活-方案.md）：
 *   A. iframe 保活：切页不销毁 VevDemo iframe（省 5-15s 重连），安全边界 =
 *      同项目保活 / 跨项目在 _syncProjectModules 收口必杀 / 进页 ping 对账防假活。
 *      任何一条退化都可能重新引入"跨项目看到旧时间线"串台或假活白屏。
 *   B. 壳层桥接增强：vevdemo-1.0.6/fe/index.js 是未跟踪手改文件，vendor 重同步
 *      会把快捷键分发(dispatchEditorShortcut)/外壳按键转发(origin:editorShortcut)/
 *      素材同步进度(import-progress)静默冲掉——本测试当哨兵，冲掉即红。
 *
 * 运行：node scripts/test-online-editor-keepalive.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

const mainJs = read('public/main.js');
const oeJs = read('public/modules/online_editor.js');
const shellJs = read('vevdemo-1.0.6/fe/index.js');

// ── A1. 切页不销毁 ───────────────────────────────────────────────
assert(
  !/if\s*\(page\s*!==\s*["']onlineEditor["']\)\s*destroyOnlineEditor\(\)/.test(mainJs),
  'main.js 不应再有"切页即 destroyOnlineEditor"（保活被回滚）',
);

// ── A2. 跨项目必杀：收口接线 ─────────────────────────────────────
const syncModulesBlock = mainJs.match(/function _syncProjectModules\(nextProject, options\)\s*\{[\s\S]*?\n  \}/);
assert(syncModulesBlock, 'main.js 应存在 _syncProjectModules 收口');
assert(
  syncModulesBlock && syncModulesBlock[0].includes('if (options.onlineEditor !== false) syncOnlineEditorProject(nextProject);'),
  '_syncProjectModules 收口必须默认调用 syncOnlineEditorProject(nextProject)，且允许 reload/apply 显式跳过以保活 iframe',
);
assert(
  (mainJs.match(/_syncProjectModules\(null\)/g) || []).length >= 2,
  'main.js 两个"删光项目"分支都应走 _syncProjectModules(null)，由收口统一清理 online editor',
);
assert(
  (mainJs.match(/_syncProjectModules\(project, \{ onlineEditor: false \}\);/g) || []).length >= 5,
  '同项目 reload/apply 回拉必须显式跳过 onlineEditor 同步，避免误杀保活 iframe',
);

// ── A3. 守卫钩子语义：同项目不杀 / 跨项目杀 ──────────────────────
const guardBlock = oeJs.match(/function syncOnlineEditorProject\(nextProject\)\s*\{[\s\S]*?\n\}/);
assert(guardBlock, 'online_editor.js 应存在 syncOnlineEditorProject');
assert(
  guardBlock && /if\s*\(boundId\s*&&\s*nextId\s*===\s*boundId\)\s*return/.test(guardBlock[0]),
  'syncOnlineEditorProject 必须"同项目(含409回拉)不销毁"——误杀会让保活失效',
);
assert(
  guardBlock && guardBlock[0].includes('_destroyVevDemoFrame()'),
  'syncOnlineEditorProject 跨项目分支必须销毁 iframe——退化即串台红线',
);

// ── A4. 进页 ping 对账 ───────────────────────────────────────────
assert(
  /function onOnlineEditorPageEnter\(\)\s*\{[\s\S]*?_verifyKeptAliveFrame\(\)/.test(oeJs),
  'onOnlineEditorPageEnter 必须调用 _verifyKeptAliveFrame（防假活）',
);
const verifyBlock = oeJs.match(/function _verifyKeptAliveFrame\(\)\s*\{[\s\S]*?\n\}/);
assert(verifyBlock, 'online_editor.js 应存在 _verifyKeptAliveFrame');
assert(
  verifyBlock && verifyBlock[0].includes("'origin:ping'"),
  '_verifyKeptAliveFrame 必须发 origin:ping',
);
assert(
  verifyBlock && verifyBlock[0].includes('_rebuildKeptAliveFrame'),
  '_verifyKeptAliveFrame 超时/发送失败必须走 _rebuildKeptAliveFrame',
);
const rebuildBlock = oeJs.match(/function _rebuildKeptAliveFrame\(\)\s*\{[\s\S]*?\n\}/);
assert(
  rebuildBlock && rebuildBlock[0].includes('_destroyVevDemoFrame()') && rebuildBlock[0].includes('mountOnlineEditor()'),
  '_rebuildKeptAliveFrame 必须 destroy + mount 重建',
);
assert(
  /status\s*===\s*'pong'/.test(oeJs),
  '_onVevDemoStatus 必须有 pong 分支回执对账',
);
assert(
  /function _destroyVevDemoFrame\(\)\s*\{[\s\S]{0,200}_clearKeepAlivePing\(\)/.test(oeJs),
  '_destroyVevDemoFrame 必须清理保活 ping 定时器（防销毁后残留 timer 重建）',
);

// ── B. 壳层桥接增强哨兵（vendor 重同步冲掉即红） ─────────────────
assert(
  shellJs.includes('function dispatchEditorShortcut'),
  '壳层 fe/index.js 丢失 dispatchEditorShortcut（快捷键分发被 vendor 重同步冲掉？）',
);
assert(
  shellJs.includes("case 'origin:editorShortcut'"),
  '壳层 bridge 丢失 origin:editorShortcut case（外壳按键转发失效）',
);
assert(
  shellJs.includes("case 'origin:togglePlayback'"),
  '壳层 bridge 丢失 origin:togglePlayback case',
);
assert(
  shellJs.includes("status: 'import-progress'"),
  '壳层丢失素材同步 import-progress 上报',
);
assert(
  oeJs.includes('_handleHostEditorKeydown') && oeJs.includes("'origin:editorShortcut'"),
  'online_editor.js 丢失外壳按键转发',
);
assert(
  /status\s*===\s*'import-progress'/.test(oeJs),
  'online_editor.js 丢失 import-progress 进度分支',
);

// ── 汇总 ─────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`✗ 在线精修保活契约失败 ${failures.length} 条：`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✓ 在线精修 iframe 保活 + 桥接增强契约通过（' + 18 + ' 条断言）');
