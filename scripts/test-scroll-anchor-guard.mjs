/**
 * 滚动锚定守卫接线契约测试
 *
 * 锁定"长列表整重建滚动跳变"的根治机制不被退化：
 *   1. 守卫模块存在且关键机制齐全（连续锚定 / MutationObserver / 用户让位 / settle）
 *   2. main.js 正确初始化（context = activePage + project.id）
 *   3. 旧的局部补丁（shots.js 内 _captureShotScrollAnchor）已移除且不得回潮
 *      —— 双机制并存会互相争抢滚动位置
 *   4. importmap 注册了守卫模块
 *
 * 跑法：npm run test:scroll-anchor-guard
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const guard = read("public/modules/scroll_anchor_guard.js");
const main = read("public/main.js");
const shots = read("public/modules/shots.js");
const html = read("public/workspace.html");

let failed = 0;
const assert = (cond, msg) => {
  if (cond) { console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
};

console.log("[1] 守卫模块机制完整性");
assert(guard.includes("export function initScrollAnchorGuard"), "导出 initScrollAnchorGuard");
assert(guard.includes("new MutationObserver"), "用 MutationObserver 监听 DOM 重建");
assert(/childList:\s*true,\s*subtree:\s*true/.test(guard), "观察 childList+subtree");
assert(guard.includes('addEventListener("scroll"'), "监听 window scroll 做连续锚定");
assert(/\["wheel",\s*"touchstart",\s*"mousedown",\s*"keydown"\]/.test(guard), "监听四类用户输入做让位");
assert(/userDriven/.test(guard) && /INPUT_FRESH_MS/.test(guard), "只跟随用户发起的滚动（钳制滚动不更新锚点）");
assert(/RESTORE_THRESHOLD/.test(guard) && /SETTLE_TICKS/.test(guard), "带恢复阈值 + 有限次 settle 校正");
assert(/_lastInputTs\s*>\s*startedAt/.test(guard), "settle 期间用户输入立即接管");
assert(/shots:\s*\{\s*selector:\s*"\.shot-workbench-card\[data-shot-idx\]"/.test(guard), "注册镜头页锚点 scope");
assert(/batch:\s*\{\s*selector:\s*"#batchTaskListWrap\s*>\s*\[data-group-idx\]"/.test(guard), "注册片段页锚点 scope");

console.log("[2] main.js 接线");
assert(/import\s*\{\s*initScrollAnchorGuard\s*\}\s*from\s*'\/modules\/scroll_anchor_guard\.js'/.test(main), "main.js 通过 import-map specifier 导入守卫");
assert(/initScrollAnchorGuard\(\{\s*\n?\s*getContext:/.test(main), "main.js 初始化守卫并传 getContext");
assert(/getContext:\s*\(\)\s*=>\s*activePage\s*\+\s*"\|"\s*\+\s*\(project\s*&&\s*project\.id/.test(main), "context 同时含页面与项目 id（切页/切项目锚点作废）");

console.log("[3] 旧局部补丁已移除（防双机制并存）");
assert(!shots.includes("_captureShotScrollAnchor"), "shots.js 不再有 _captureShotScrollAnchor");
assert(!shots.includes("_scheduleShotScrollRestore"), "shots.js 不再有 _scheduleShotScrollRestore");
assert(shots.includes("scroll_anchor_guard.js"), "shots.js 留有指向全局守卫的注释路标");

console.log("[4] importmap 注册");
assert(html.includes('"/modules/scroll_anchor_guard.js": "/modules/scroll_anchor_guard.js?v='), "workspace.html importmap 含守卫条目");

if (failed) {
  console.error("\n✗ 滚动锚定守卫契约不通过（" + failed + " 处）");
  process.exit(1);
}
console.log("\n✓ 滚动锚定守卫契约通过");
