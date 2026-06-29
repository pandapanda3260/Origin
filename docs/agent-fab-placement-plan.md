# Agent FAB 单一定位管理器 — 完整落地方案（Final，待执行）

> 状态：方案已定稿，**尚未改任何代码**。本文件用于直接交付 Codex / Claude Code 执行。
> 所有行号/版本号均按当前仓库实测值，执行前若文件又被他人改动，需以 §1 的"识别锚点"（函数名/选择器文本）为准重新定位。

---

## 0. 决策摘要（已拍板，无可选项）

- 做成 **单一 JS 定位管理器** `syncAgentFabPlacement()`，统一管理 FAB/Panel 的显隐、停靠、resize、面板跟随。
- **不引** Floating UI 等外部依赖；面板碰撞用本地 `offset + flip` 规则（按 dock 象限确定方向，**不测量隐藏面板尺寸**，靠视口边缘锚定 + CSS `max-*` 兜底）。
- **不做** `safe-area-inset-*`。
- 路由隐藏从 CSS 迁到 JS：删除 board 专用隐藏块、摘掉 online-editor 组里的 FAB/Panel 两行；显隐统一用 `el.hidden`（依赖 styles.css:119 的 `[hidden]{display:none!important}`，已确认能压过 `.agent-fab/.agent-panel` 的 `display:flex`）。
- 持久化废弃裸坐标 `sw_agent_fab_pos_v2`，改为 dock 语义 `sw_agent_fab_pos_v3`，**不迁移**旧值。
- 四个合法 dock：`top-start / top-end / bottom-start / bottom-end`，默认 `bottom-end`。
- 版本号固定升 **6 处**：`styles.css 261→262`、`main.js 369→370`，含 2 个测试里的版本锁。

---

## 1. 现状锚点（已扫码确认）

| 位置 | 当前事实 | 识别锚点（防行号漂移） |
|---|---|---|
| `public/workspace.html:1812` | `#navAgent` 全局按钮，挂在 `</main>` 外 | `id="navAgent"` |
| `public/workspace.html:1832-1839` | panel header 右侧按钮组：`agentClearBtn` + `agentCloseBtn` | `id="agentClearBtn"` |
| `public/workspace.html:83` | `styles.css?v=261` | `styles.css?v=` |
| `public/workspace.html:1916` | `<script type="module" src="main.js?v=369">` | `main.js?v=` |
| `public/main.js:6935` | `AGENT_FAB_POS_KEY = _uPrefix + "sw_agent_fab_pos_v2"` | `sw_agent_fab_pos_v2` |
| `public/main.js:6937-6983` | 旧裸坐标助手 `_agentFabBounds/_clampAgentFabPos/_applyAgentFabPos/_readAgentFabPos/_saveAgentFabPos` | 函数名 |
| `public/main.js:6985-7045` | `_wireAgentFabDrag()`，**内含** resize handler（7038-7044，re-read/apply/save） | `function _wireAgentFabDrag` |
| `public/main.js:7047-7062` | `toggleAgentPanel()`，先 `panel.hidden=!_agentOpen` | `function toggleAgentPanel` |
| `public/main.js:2083-2101` | `_syncFixedWorkbenchRoute(page)`，切 class + `boardRoot.hidden` + `_syncBoardNavigationState()` | `function _syncFixedWorkbenchRoute` |
| `public/main.js:7795-7813` | `_wireAgentEvents()` 调 `_wireAgentFabDrag` + 绑 close/clear | `function _wireAgentEvents` |
| `public/main.js:8693` | 启动期调用 `_wireAgentEvents()` | `_wireAgentEvents();` |
| `public/styles.css:22-23` | `--top-announcement-height:32px; --sidebar-width:256px;` 真实存在 | 变量名 |
| `public/styles.css:119` | `[hidden] { display: none !important; }` 全局 | `[hidden]` |
| `public/styles.css:1176-1182` | online-editor 混合组（含 `.agent-fab/.agent-panel`） | `is-online-editor-page #sidebar` |
| `public/styles.css:1184-1189` | board 专用 `.agent-fab/.agent-panel` 隐藏块 | `is-board-workbench-page .agent-fab` |
| `public/styles.css:10161-10181` | `.agent-fab` 基础规则（`display:flex; right:24; bottom:24`） | `.agent-fab {` |
| `public/styles.css:10222-10245` | `.agent-panel`（`right:3rem; bottom:7rem`）+ `agentPanelIn` keyframe | `.agent-panel {` |
| `public/styles.css:20660,20664` | `is-board-workbench-page` 的 board 布局规则（**保留**） | — |
| `scripts/test-board-routing-contract.mjs:85-87` | 锁 `main.js?v=369` / `styles.css?v=261` / board 隐藏 CSS | — |
| `scripts/test-shot-plan-dialog-contract.mjs:67,73` | 锁整条 main script 标签 `v=369` / `styles.css?v=261` | — |
| `package.json:11` | `verify:frontend` 链含 board-routing 与 shot-plan-dialog 两测试 | — |

---

## 2. 常量与命名（拍板）

在 Agent 模块顶部（替换 `AGENT_FAB_POS_KEY` 那一行）声明：

```js
var AGENT_FAB_DOCK_KEY = _uPrefix + "sw_agent_fab_pos_v3";
var AGENT_FAB_ANCHORS = ["top-start", "top-end", "bottom-start", "bottom-end"];
var AGENT_FAB_MARGIN = 24;   // 与 .agent-fab 默认 right/bottom:24 对齐
var AGENT_PANEL_GAP = 12;    // 面板与 FAB 的间距
```

持久化结构（只存逻辑停靠）：

```json
{ "version": 3, "anchor": "bottom-end", "updatedAt": "<ISO>" }
```

---

## 3. main.js —— 删除与新增（一次性替换，不零散打补丁）

### 3.1 删除
- 删除 `AGENT_FAB_POS_KEY` 行及旧裸坐标助手：`_agentFabBounds`、`_clampAgentFabPos`、`_applyAgentFabPos`、`_readAgentFabPos`、`_saveAgentFabPos`（当前 6935-6983）。
- 删除旧 `_wireAgentFabDrag()` 整体（当前 6985-7045，含旧 resize handler）。
- 执行前先 `grep -n "_applyAgentFabPos\|_readAgentFabPos\|_saveAgentFabPos\|sw_agent_fab_pos_v2" public/main.js` 确认无其他调用方（当前扫描：仅本块内使用）。

### 3.2 新增管理器（放在 Agent 模块内，紧接常量之后）

```js
function _agentFabElements() {
  return { fab: $("navAgent"), panel: $("agentPanel") };
}

function _agentCssPx(name, fallback) {
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  } catch (_) { return fallback; }
}

function _agentSafeRect() {
  var m = AGENT_FAB_MARGIN;
  var sidebar = _agentCssPx("--sidebar-width", 256);
  var topBar = _agentCssPx("--top-announcement-height", 32);
  return {
    left: sidebar + m,
    top: topBar + m,
    right: window.innerWidth - m,
    bottom: window.innerHeight - m,
  };
}

function _readAgentDock() {
  try {
    var raw = localStorage.getItem(AGENT_FAB_DOCK_KEY);
    if (!raw) return null;
    var d = JSON.parse(raw);
    if (d && AGENT_FAB_ANCHORS.indexOf(d.anchor) >= 0) return d.anchor;
  } catch (_) {}
  return null;
}

function _saveAgentDock(anchor) {
  if (AGENT_FAB_ANCHORS.indexOf(anchor) < 0) anchor = "bottom-end";
  try {
    localStorage.setItem(AGENT_FAB_DOCK_KEY, JSON.stringify({
      version: 3, anchor: anchor, updatedAt: new Date().toISOString(),
    }));
  } catch (_) {}
}

function _resolveAgentFabPoint(anchor, rect, size) {
  var isEnd = anchor.indexOf("-end") >= 0;
  var isBottom = anchor.indexOf("bottom") === 0;
  return {
    left: isEnd ? (rect.right - size) : rect.left,
    top: isBottom ? (rect.bottom - size) : rect.top,
  };
}

function _nearestAgentAnchor(center, rect) {
  var midX = (rect.left + rect.right) / 2;
  var midY = (rect.top + rect.bottom) / 2;
  return (center.y < midY ? "top" : "bottom") + "-" + (center.x < midX ? "start" : "end");
}

// 路由策略：与 _syncFixedWorkbenchRoute 中的判定保持同口径
function _agentFabRoutePolicy(page) {
  if (page === "onlineEditor") return { visible: false };
  if (isBoardEnabled() && page === "shots") return { visible: false };
  return { visible: true, defaultAnchor: "bottom-end" };
}

// 面板跟随 FAB：按 dock 象限锚定到视口边缘，不测量隐藏面板尺寸
function _syncAgentPanelPlacement() {
  var els = _agentFabElements();
  var fab = els.fab, panel = els.panel;
  if (!fab || !panel) return;
  var anchor = fab.dataset.anchor || _readAgentDock() || "bottom-end";
  var r = fab.getBoundingClientRect();
  var gap = AGENT_PANEL_GAP;
  var isEnd = anchor.indexOf("-end") >= 0;
  var isBottom = anchor.indexOf("bottom") === 0;

  panel.style.left = "auto";
  panel.style.right = "auto";
  panel.style.top = "auto";
  panel.style.bottom = "auto";

  // 水平：与 FAB 共享同一水平边
  if (isEnd) panel.style.right = Math.max(0, window.innerWidth - r.right) + "px";
  else panel.style.left = Math.max(0, r.left) + "px";

  // 垂直：朝远离 FAB 的方向展开（FAB 在下→面板在上；FAB 在上→面板在下）
  if (isBottom) panel.style.bottom = Math.max(0, window.innerHeight - r.top + gap) + "px";
  else panel.style.top = Math.max(0, r.bottom + gap) + "px";

  panel.style.setProperty("--agent-panel-origin", (isBottom ? "bottom " : "top ") + (isEnd ? "right" : "left"));
  panel.style.setProperty("--agent-panel-enter-y", isBottom ? "16px" : "-16px");
}

// 唯一入口：显隐 + 停靠 + 面板跟随
function syncAgentFabPlacement(reason, page) {
  var els = _agentFabElements();
  var fab = els.fab, panel = els.panel;
  if (!fab) return; // helper 必须能在元素缺失时 no-op
  var pg = page || activePage || "";
  var policy = _agentFabRoutePolicy(pg);

  if (!policy.visible) {
    _agentOpen = false;
    fab.classList.remove("is-open");
    fab.hidden = true;
    if (panel) panel.hidden = true;
    return;
  }

  fab.hidden = false;
  var anchor = _readAgentDock() || policy.defaultAnchor || "bottom-end";
  var size = fab.offsetWidth || 52;
  var pt = _resolveAgentFabPoint(anchor, _agentSafeRect(), size);
  fab.style.left = pt.left + "px";
  fab.style.top = pt.top + "px";
  fab.style.right = "auto";
  fab.style.bottom = "auto";
  fab.dataset.anchor = anchor;

  if (_agentOpen && panel) _syncAgentPanelPlacement();
}
```

### 3.3 新 `_wireAgentFabDrag()`（拖拽只做临时移动；松手吸附最近 dock；收编唯一 resize）

```js
function _wireAgentFabDrag(fab) {
  if (!fab || fab.dataset.dragBound === "1") return;
  fab.dataset.dragBound = "1";

  var drag = null;

  function clampToSafe(x, y, size) {
    var r = _agentSafeRect();
    return {
      x: Math.min(r.right - size, Math.max(r.left, x)),
      y: Math.min(r.bottom - size, Math.max(r.top, y)),
    };
  }

  function finishDrag(e) {
    if (!drag) return;
    try { fab.releasePointerCapture(drag.pointerId); } catch (_) {}
    fab.classList.remove("is-dragging");
    if (drag.moved) {
      var rect = fab.getBoundingClientRect();
      var center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      _saveAgentDock(_nearestAgentAnchor(center, _agentSafeRect()));
      syncAgentFabPlacement("drag-end");
      _agentFabSuppressClick = true;
      setTimeout(function () { _agentFabSuppressClick = false; }, 180);
      if (e) { e.preventDefault(); e.stopPropagation(); }
    }
    drag = null;
  }

  fab.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    var rect = fab.getBoundingClientRect();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top, moved: false };
    fab.classList.add("is-dragging");
    try { fab.setPointerCapture(e.pointerId); } catch (_) {}
  });

  fab.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    var size = fab.offsetWidth || 52;
    var p = clampToSafe(drag.left + dx, drag.top + dy, size);
    fab.style.left = p.x + "px";
    fab.style.top = p.y + "px";
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    e.preventDefault();
  });

  fab.addEventListener("pointerup", finishDrag);
  fab.addEventListener("pointercancel", finishDrag);

  // 唯一 resize 入口（dragBound 保证只注册一次）
  window.addEventListener("resize", function () { syncAgentFabPlacement("resize"); });
}
```

### 3.4 `toggleAgentPanel()` 改造（打开前先写位置与动画方向）

```js
function toggleAgentPanel(forceState) {
  var els = _agentFabElements();
  var panel = els.panel, fab = els.fab;
  if (!panel) return;
  if (forceState !== undefined) _agentOpen = forceState;
  else _agentOpen = !_agentOpen;
  if (fab) fab.classList.toggle("is-open", _agentOpen);
  if (_agentOpen) {
    _syncAgentPanelPlacement();   // 必须在 panel 可见前写入 left/top + CSS vars
    panel.hidden = false;
    var ta = $("agentInput");
    if (ta) setTimeout(function () { ta.focus(); }, 100);
  } else {
    panel.hidden = true;
  }
}
```

### 3.5 `_syncFixedWorkbenchRoute(page)` 接入（统一入口，无闪烁/可恢复）

在函数末尾 `_syncBoardNavigationState();` 之后追加一行：

```js
syncAgentFabPlacement("route", page);
```

### 3.6 `_wireAgentEvents()` 接线（dock 按钮 + 初始放置）

在绑定 `agentCloseBtn` 附近追加：

```js
var dockBtn = $("agentDockBtn");
if (dockBtn) dockBtn.addEventListener("click", function () {
  _saveAgentDock("bottom-end");
  syncAgentFabPlacement("reset");
});
```

并在 `_wireAgentEvents()` 末尾追加初始放置：

```js
syncAgentFabPlacement("init");
```

---

## 4. workspace.html

1. **第 1812 行**：给 `#navAgent` 加初始 `hidden`（防 boot/路由恢复前闪到错误位置）：
   ```html
   <button type="button" id="navAgent" class="agent-fab" hidden title="AI 视频助手（可拖动）" aria-label="AI 视频助手（可拖动）">
   ```
2. **第 1832-1839 行按钮组**：在 `agentClearBtn` **之前**插入"停靠到右下角"按钮：
   ```html
   <button type="button" id="agentDockBtn" class="w-9 h-9 rounded-full hover:bg-on-background/5 flex items-center justify-center transition-colors" title="停靠到右下角">
     <span class="material-symbols-outlined text-base text-on-background/40">south_east</span>
   </button>
   ```
3. **版本号**：第 83 行 `styles.css?v=261 → 262`；第 1916 行 `main.js?v=369 → 370`。

---

## 5. styles.css

1. **第 1176-1182 online-editor 组**：仅删除 `body.is-online-editor-page .agent-fab,` 与 `body.is-online-editor-page .agent-panel,` 两行，保留 `#sidebar / #announceBanner / #maintenanceBanner`。
2. **第 1184-1189 board 隐藏块**：整段删除。
3. **`.agent-panel`（10222 起）**：删除 `right: 3rem;` 与 `bottom: 7rem;`；新增 `max-width: calc(100vw - 32px);`（窄屏防溢出，`width: 420px` 保留）。位置由 JS 写 `left/top` 或 `right/bottom`。
4. **第 10239 行** `transform-origin: bottom right;` → `transform-origin: var(--agent-panel-origin, bottom right);`
5. **keyframe `agentPanelIn`（10242-10245）** 的 `from`：`translateY(16px)` → `translateY(var(--agent-panel-enter-y, 16px))`。
6. **不改** `.agent-fab` 基础块（保留 `display:flex; right:24; bottom:24`，JS 用 `right/bottom:auto + left/top` 覆盖；初始 `hidden` 由 styles.css:119 的 `[hidden]{display:none!important}` 兜住）。

---

## 6. 版本同步（固定 6 处，全部 261→262 / 369→370）

| 文件 | 行 | 改动 |
|---|---|---|
| `public/workspace.html` | 83 | `styles.css?v=261 → 262` |
| `public/workspace.html` | 1916 | `main.js?v=369 → 370` |
| `scripts/test-board-routing-contract.mjs` | 85 | 正则 `369 → 370` |
| `scripts/test-board-routing-contract.mjs` | 86 | 正则 `261 → 262` |
| `scripts/test-shot-plan-dialog-contract.mjs` | 67 | 整条标签 `main.js?v=369 → 370`（含 `type="module"`，逐字匹配） |
| `scripts/test-shot-plan-dialog-contract.mjs` | 73 | `styles.css?v=261 → 262` |

> 注意：`test:cache-busting` 只校验"带 `?v=`"，**不会**抓"该升没升"，所以以上 6 处必须人工逐一对齐。

---

## 7. 测试改造

### 7.1 改 `scripts/test-board-routing-contract.mjs:87`
把"必须存在 board 隐藏 CSS"的断言换成**限定在单个选择器组内**的"已移除"断言（避免贪婪 `[\s\S]*` 因 `.agent-fab` 基础规则与 20660 的 board 布局规则残留而假阳性）：

```js
assert.doesNotMatch(styles, /is-board-workbench-page[^{}]*\.agent-fab/, 'board route no longer hides FAB via CSS (JS-owned)');
assert.doesNotMatch(styles, /is-board-workbench-page[^{}]*\.agent-panel/, 'board route no longer hides panel via CSS (JS-owned)');
```

### 7.2 新增 `scripts/test-agent-fab-placement-contract.mjs`

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../public/workspace.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open + 1, i); }
  }
  throw new Error(`${name} body did not close`);
}

// 管理器存在 + 单一入口
assert.match(main, /function syncAgentFabPlacement\s*\(/, 'syncAgentFabPlacement defined');
assert.match(main, /function _syncAgentPanelPlacement\s*\(/, 'panel placement defined');
assert.match(main, /function _agentFabRoutePolicy\s*\(/, 'route policy defined');

// dock v3 取代裸坐标 v2
assert.match(main, /sw_agent_fab_pos_v3/, 'uses v3 dock key');
assert.doesNotMatch(main, /sw_agent_fab_pos_v2/, 'v2 key removed');
assert.doesNotMatch(main, /_readAgentFabPos|_saveAgentFabPos|_applyAgentFabPos/, 'legacy absolute-coord helpers removed');

// route 接入
assert.match(functionBody(main, '_syncFixedWorkbenchRoute'), /syncAgentFabPlacement\(\s*["']route["']\s*,\s*page\s*\)/, 'route calls placement');

// resize 只走统一入口
assert.match(main, /addEventListener\(\s*["']resize["'][\s\S]{0,80}syncAgentFabPlacement\(\s*["']resize["']/, 'resize routes to placement');

// 面板打开前写位置
assert.match(functionBody(main, 'toggleAgentPanel'), /_syncAgentPanelPlacement\(\)/, 'open path syncs panel');

// 动画方向用 CSS vars
assert.match(styles, /transform-origin:\s*var\(--agent-panel-origin/, 'panel uses variable transform-origin');
assert.match(styles, /translateY\(var\(--agent-panel-enter-y/, 'panel enter direction via var');

// 路由隐藏已从 CSS 移除
assert.doesNotMatch(styles, /is-board-workbench-page[^{}]*\.agent-fab/, 'board FAB CSS hide removed');
assert.doesNotMatch(styles, /is-online-editor-page[^{}]*\.agent-fab/, 'online-editor FAB CSS hide removed');
// online-editor 仍隐藏 sidebar/banner
assert.match(styles, /is-online-editor-page #sidebar/, 'online-editor still hides sidebar');
assert.match(styles, /is-online-editor-page #maintenanceBanner/, 'online-editor still hides maintenance banner');

// HTML：初始 hidden + dock 按钮
assert.match(workspace, /<button[^>]*id="navAgent"[^>]*\bhidden\b/, 'navAgent starts hidden');
assert.match(workspace, /id="agentDockBtn"/, 'dock-to-corner button present');

console.log('✓ agent fab placement contract passed');
```

### 7.3 `package.json:11` 接线
在 `node scripts/test-board-routing-contract.mjs` **之后**插入：
```
&& node scripts/test-agent-fab-placement-contract.mjs
```

---

## 8. 验证

### 8.1 命令（固定顺序）
```bash
npm run test:cache-busting
node scripts/test-board-routing-contract.mjs
node scripts/test-shot-plan-dialog-contract.mjs
node scripts/test-agent-fab-placement-contract.mjs
npm run verify:frontend
```

### 8.2 浏览器手测（当前 Chrome，逐页）
- `overview/script/style/assets/batch/edit/library/toolbox`：FAB 可见，默认右下。
- 拖到任意位置松手：吸附到最近角（四角之一）。
- 刷新：按 v3 dock 恢复，不复用旧裸坐标。
- `shots`(board on)：FAB 隐藏、panel 关闭。
- 画板 → 普通页：FAB 恢复。
- `onlineEditor`：FAB 隐藏，sidebar/banner/maintenance 仍隐藏。
- onlineEditor → 普通页：FAB 恢复。
- 打开 panel 后 resize：FAB 与 panel 一起重定位。
- FAB 在左上/右上时开 panel：位置与动画 origin 正确。
- 点 header "停靠到右下角"：FAB 立即回 `bottom-end`。
- 控制台无 error/warn。

### 8.3 验收标准
- 不再用全局裸 `x/y` 跨页持久化 FAB；route/resize/drag-end/panel-open/reset 全走 `syncAgentFabPlacement`。
- board/onlineEditor 显隐由 JS 策略控制，离开后可恢复。
- panel 跟随 FAB，动画 origin 与打开方向一致。
- 不引依赖、不做 safe-area、不新增页面级隐藏 CSS。
- onlineEditor 的 sidebar/banner/maintenance 隐藏不回退。
- 现有 `test-board-routing-contract.mjs` 不再锁旧 board 隐藏 CSS。

---

## 9. 范围边界（不做）

- 不引 Floating UI / 任何外部库。
- 不做 `safe-area-inset-*`。
- 不改 `.agent-fab` 基础视觉、不动 panel 内部结构（仅加一个 header 按钮）。
- 不为旧 `sw_agent_fab_pos_v2` 做迁移/兼容。
- 不动 board 布局相关的 `is-board-workbench-page`（20660/20664）等无关规则。
```

