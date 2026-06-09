# 统一页面刷新等待 UI — 方案 v5（工程化定稿，待确认即进 Phase 0）

> 整合你第 5 轮 6 条修正，整篇重写（非补丁）。所有锚点已扫码核实，决策全部拍死、无选择项。
> 边界（v4 已确认正确，保留）：只动 `public/`；不做小游戏 / 横幅 / 顶部进度条；静态 loading 节点写进 `workspace.html`；4 页灰度；独立 `_swLoadToken`；`_showProjectSkeleton(true)` 仅这 4 页 no-op；batch region loader 放 `.batch-workbench-scroll` 而非 `#batchClipList`；不碰后端 / 字段 / schema / `readyForEdit` / reattach / 导入逻辑。
> **本阶段不改任何代码，等你确认后再执行。** 产出可直接交 Codex / Claude Code。

---

## 0. 一句话方案

4 个重灾页（资产/镜头/片段/剪辑）各放一个**默认可见、绝对定位、带局部 stacking context**的页面内像素加载层，由 `main.js` 一个**独立 `_swLoadToken` 权威态**统一显隐。**所有 begin/done/error 收口都在 `main.js`**：启动在 `_markWorkspaceBootReady()` 之后下一帧 settle，切项目在 `_activateProjectContext` 内 begin/done、catch 里 `swLoadError` 后**续抛**，错误态重试走 `main.js` 包装流程（非裸 `loadProject`）。

---

## 1. 扫码核实结论（逐条对应你第 5 轮的 6 点，带真实行号）

| # | 你的修正 | 扫码核实（file:line） | 处理 |
|---|---|---|---|
| 1 | 重试不能裸调 `loadProject()` | `loadProject()`(project.js:319) 只管加载/刷新，不含全局 loader begin/done；它在 `init()` 内被 `await`(main.js:7078) | ✅ 重试 = `main.js` 包装 `_retryActiveLoad()`：begin→loadProject→`switchPage(forceRefresh)`→done/error（§3.4） |
| 2 | `_activateProjectContext` 错误不能吞 | 它(main.js:896) 是 **try/finally 无 catch**，错误向上抛；`switchToProject`(1005) 的 catch 弹「切换项目失败」toast(1015-1018) | ✅ 新增 catch：`swLoadError(swT)` 后 **`throw e` 续抛**，保留 toast/返回行为 |
| 3 | 版本号过期 | `styles.css?v=185`(workspace.html:73)（不是 182）；`main.js?v=246`(:1769)；importmap `project.js?v=104`/`videoTasks.js?v=118`；`main.js:18` 相对 `project.js?v=103` | ✅ styles.css **185→186**；其余见 §6 |
| 4 | CSS 背景要真实变量 | `styles.css:8 --bg-main:#ECEFF1`（页面主背景变量真实存在） | ✅ 遮罩 `background: var(--bg-main);`，不留占位 |
| 5 | 收口放 bootReady 之后 | 最终 `switchPage(...forceRefresh)`(main.js:7590) **紧接** `_markWorkspaceBootReady()`(7591)；该函数(209) 释放 boot CSS | ✅ settle 放 `_markWorkspaceBootReady()` **之后 + `requestAnimationFrame` 下一帧**，避免 loader 已隐藏但 boot CSS 未释放的空窗 |
| 6 | `renderSeq` 要先声明模块变量 | `videoTasks.js` 模块状态区在 16-39 行（`let _ctx`/`let project`/`var _videoInFlightGroups` 等），**无 `_batchRenderSeq`** | ✅ 模块状态区补 `var _batchRenderSeq = 0;`，否则 `++_batchRenderSeq` ReferenceError |

---

## 2. 决策清单（全部拍死，无选项）

1. **加载视觉**：页面内绝对定位遮罩 `.sw-page-loading`，默认可见（治预启动闪），内含像素「O」环 + 「加载中…」。
2. **像素动效**：纯 CSS 像素方块拼 Origin「O」环按序淡入循环；单色随主题文字色；~44px；零依赖、无 canvas。
3. **权威态**：`main.js` 持 `_swLoadToken`/`_swLoad{projectId,token,status}`/`_swActiveLoadFailed`；`_isSwLoadCurrent(t)=t===_swLoadToken`；过期回调丢弃。各页不加 loaded 标志。
4. **begin/done/error 全在 main.js 收口**；`loadProject` 只回填结果（`setActiveLoadOutcome`），不直接 done/hide。
5. **启动 settle**：`_markWorkspaceBootReady()`(7591) 之后 `requestAnimationFrame` 内按结果 done/error。
6. **切项目**：begin 放在 `_activateProjectContext` 的**同项目早返回(913)之后、fetch(920)之前**（同项目 no-op 不闪 loader）；成功(refreshAllPages 938 后)done；catch `swLoadError` 后 **续抛**。
7. **错误重试**：`_retryActiveLoad()`（§3.4），绑到遮罩 error 态的「重试」按钮；不裸调 `loadProject`。
8. **skeleton**：`_showProjectSkeleton(on)` 仅 `on===true` 且 active∈{assets,shots,batch,edit} 时 `return`；`on===false` 照常清理。
9. **batch region loader**：挂 `.batch-workbench-scroll`，绝对定位、非 `#batchClipList` 子节点；`var _batchRenderSeq=0` 模块变量 + `try/finally`。
10. **z 层级**：4 页容器 `isolation:isolate` + 遮罩 `z-index:60`（盖住时间线 `z-[50]`）。
11. **背景**：`.sw-page-loading{background:var(--bg-main)}`。
12. **版本**：§6；新 `loading.js` 走 importmap 绝对路径。

---

## 3. 状态机与时序（精确到行 + 契约伪码）

### 3.1 main.js 权威态
```js
var _swLoadToken = 0;
var _swLoad = { projectId:'', token:0, status:'loading' };  // 初始 loading，与遮罩默认可见一致
var _swActiveLoadFailed = false;                             // loadProject 经 ctx 回填
var _swStartupToken = 0;
var _swLoadingUI = createSwLoading({ pages:['assets','shots','batch','edit'] }); // loading.js
function _isSwLoadCurrent(t){ return t === _swLoadToken; }
function _pageUsesInlineLoader(p){ return p==='assets'||p==='shots'||p==='batch'||p==='edit'; }
function swLoadBegin(projectId){ _swLoad={projectId:projectId||'',token:++_swLoadToken,status:'loading'}; _swLoadingUI.showAll(); return _swLoad.token; }
function swLoadDone(t){ if(!_isSwLoadCurrent(t))return; _swLoad.status='ready'; _swLoadingUI.hideAll(); }
function swLoadError(t){ if(!_isSwLoadCurrent(t))return; _swLoad.status='error'; _swLoadingUI.errorAll(_retryActiveLoad); }
```

### 3.2 启动时序（硬刷新）
```
HTML 解析 → boot CSS 显示记忆页(workspace.html:40-69) → .sw-page-loading 默认可见   ← 预启动不闪
init()(6962):
  initVideoTasks(7003)/initProject(7050)…
  _swStartupToken = swLoadBegin('')          ← 在 await loadProject()(7078) 之前
  await loadProject()                        ← 内部经 ctx 回填 _swActiveLoadFailed（§4.5），不 done
  initEdit(7445)/syncEditProject(7469)/各页接线…
  _appBootstrapping=false(7588); switchPage(bootTargetPage,{forceRefresh:true})(7590); _markWorkspaceBootReady()(7591)
  requestAnimationFrame(()=> _swActiveLoadFailed ? swLoadError(_swStartupToken) : swLoadDone(_swStartupToken))  ← settle 在 bootReady 之后下一帧
```

### 3.3 切项目时序
```
_activateProjectContext(projId)(896):
  var swT = 0;
  ++_projectActivationToken(899); _setProjectActivating(true)(907); [useSkeleton→_showProjectSkeleton(true)(910，4页 no-op)]
  try {
    if (project.id === projId) return project;        // 同项目 no-op，不 begin、不闪 loader
    swT = swLoadBegin(projId);                          // begin：同项目守卫之后、flush/fetch 之前
    [flush(915) / fetchProjectByIdShared(920) / stale token return null(917/924/945，不 settle)]
    if(!p||!p.id) throw "项目数据为空"(925);
    _resetProjectRuntime(928)/_syncProjectModules(935)/refreshAllPages(938)/_restoreVideoTasks(939)…
    swLoadDone(swT); return project(951);               // 成功
  } catch (e) { swLoadError(swT); throw e; }            // ← 续抛，保留 switchToProject(1015) 的 toast
  finally { /* 原 abort/skeleton/_setProjectActivating(false) 不变(952-959) */ }
```

### 3.4 错误重试（main.js 包装，§点1）
```js
async function _retryActiveLoad(){
  var t = swLoadBegin(_swLoad.projectId || '');     // 重新进入 loading
  _swActiveLoadFailed = false;
  try { await loadProject(); } catch(_) {}
  switchPage(activePage, { forceRefresh:true, skipAnimation:true });  // 重渲当前页
  _swActiveLoadFailed ? swLoadError(t) : swLoadDone(t);              // 收口
}
```

---

## 4. 改动清单（file-by-file，可执行）

> Phase 0 触达 6 文件；**不动** edit.js / shots.js / storyboard.js / assets.js 的 render。

### 4.1 `public/workspace.html`
- 4 页容器(`#pageAssets`/`#pageShots`/`#pageBatch`/`#pageEdit`)各加默认可见遮罩（首子节点）：
  `<div class="sw-page-loading" data-loading-for="assets" role="status" aria-live="polite"><span class="sw-pixel-o" aria-hidden="true"></span><span class="sw-load-text">加载中…</span></div>`
- importmap(1739-1766)：`project.js?v=104→105`、`videoTasks.js?v=118→119`、新增 `"/modules/loading.js":"/modules/loading.js?v=1"`。
- `styles.css?v=185→186`(:73)；`main.js?v=246→247`(:1769)。

### 4.2 `public/styles.css`（bump v186）
- `#pageAssets,#pageShots,#pageBatch,#pageEdit{position:relative;isolation:isolate;}`
- `.batch-workbench-scroll{position:relative;}`
- `.sw-page-loading{position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--bg-main);transition:opacity .18s ease;}`
  `.sw-page-loading.is-hiding{opacity:0;pointer-events:none;}` `.sw-page-loading[hidden]{display:none;}`
- `.sw-region-loading{position:absolute;inset:0;z-index:30;background:var(--bg-main);…像素缩小版;}`
- 像素「O」环 keyframes（方块按序淡入循环）；error 态样式（文案 + `.sw-load-retry` 按钮）。

### 4.3 `public/modules/loading.js`（新增，importmap v1）
- `export function createSwLoading({pages})` → `{ showAll(), hideAll(), errorAll(onRetry), showRegion(el), hideRegion(el) }`。
- 按 `[data-loading-for]` 找 4 页遮罩；`errorAll` 把遮罩切「加载失败 + 重试」，按钮 click→`onRetry`；零依赖。

### 4.4 `public/main.js`（bump v247）
- import：新增 `import { createSwLoading } from '/modules/loading.js';`；`./modules/project.js?v=103`→`?v=105`(:18)。
- 新增 §3.1 权威态 + `_retryActiveLoad`(§3.4)。
- `_showProjectSkeleton(on)`(1113) 开头：`if (on === true && _pageUsesInlineLoader(activePage)) return;`（仅拦 on=true）。
- `init()`：`await loadProject()`(7078) 前 `_swStartupToken = swLoadBegin('')`；`_markWorkspaceBootReady()`(7591) 后 `requestAnimationFrame(settleStartup)`（§3.2）。
- `_activateProjectContext`(896)：按 §3.3 加 `var swT=0` / 同项目守卫后 `swLoadBegin` / 成功 `swLoadDone(swT)` / **新增 catch `swLoadError(swT); throw e;`**（finally 不变）。
- ctx 注入：`initProject`(7050) 加 `setActiveLoadOutcome:(failed)=>{_swActiveLoadFailed=failed;}`；`initVideoTasks`(7003) 加 `swRegion:{show:()=>_swLoadingUI.showRegion($(' .batch-workbench-scroll')), hide:()=>_swLoadingUI.hideRegion(...)}`。

### 4.5 `public/modules/project.js`（bump v105：importmap + main.js:18 两处）
- `loadProject()`(319)：`var listOk=false`（仅 `resp.ok`(335) 置真）；`var targetFetchFailed=false`（targetId 存在但 `fetchProjectFromServer` 返回 null 401-403 → 置真）。
- 末尾(refreshActivePage 417 之后)：`var failed=(!listOk && !_getProject())||targetFetchFailed;`（listOk 且 0 项→failed=false）；`_ctx.setActiveLoadOutcome && _ctx.setActiveLoadOutcome(failed);`。**不**在此 done/hide。

### 4.6 `public/modules/videoTasks.js`（bump v119：仅 importmap）
- 模块状态区(16-39)补 `var _batchRenderSeq = 0;`。
- `renderBatchClipList()`(2961)：`var seq=++_batchRenderSeq; _ctx.swRegion&&_ctx.swRegion.show();` 在 prefetch await(2975) 之前；`try{…原逻辑含 list.innerHTML=""(2999)…}finally{ if(seq===_batchRenderSeq) _ctx.swRegion&&_ctx.swRegion.hide(); }`。仅包裹，不改原逻辑、不进 `#batchClipList`。

---

## 5. 不碰清单
- `readyForEdit`、批次 reattach、导入剪辑下一步、`hasLiveRow`/任务镜像、`syncTaskListVisibility` 的 `children.length` 判据(videoTasks.js:1314)、`project_edit_readiness` 字段口径。
- `switchToProject` 失败 toast 行为（靠 catch 续抛保留）。
- 共享 resolver / 字段 schema；`reference-site/`、后端、`lib/model-routing`、`CLAUDE.md` 治理项。
- edit.js / shots.js / storyboard.js / assets.js 的 render 逻辑。

---

## 6. 版本 bump 清单（按当前文件现状）
| 模块 | importmap(workspace.html) | main.js | 备注 |
|---|---|---|---|
| project.js | 1749：`?v=104→105` | :18 相对 `?v=103→105` | 两处都改（相对 import 绕过 importmap） |
| videoTasks.js | 1763：`?v=118→119` | :27 裸 import 不动 | 裸 `/modules/videoTasks.js` 走 importmap，自动取 119 |
| loading.js（新） | 新增 `?v=1` | 顶部 `import … from '/modules/loading.js'` | 绝对路径走 importmap |
| styles.css | — | workspace.html:73 `?v=185→186` | |
| main.js | — | workspace.html:1769 `?v=246→247` | |

---

## 7. 分期
- **Phase 0（本次审批范围）**：§4 全部，仅 assets/shots/batch/edit。
- **Phase 1**：铺到其余流水线页；按需给 shots/images/assets 加 region loader；像素动效与文案定稿。

---

## 8. 验收清单（可实跑）
1. 硬刷新进 4 页：JS ready 前只见像素加载层，不闪 guard/空态（Slow 3G / 首帧断点）。
2. 启动 settle：遮罩在 `_markWorkspaceBootReady()` 后下一帧才淡出，无"loader 隐藏但页面还空"的空窗、无二次跳。
3. **错误重试**：断网时 4 页显示「加载失败 · 重试」，点重试**重新进入 loading**（不是静默），成功 ready / 仍失败回 error。
4. **切项目失败**：`_activateProjectContext` 失败时遮罩进 error，且 `switchToProject` 的「切换项目失败」toast **仍照常弹**（续抛未被吞）。
5. 切项目成功：点切换那一刻起遮罩就在（fetch 期间不露旧项目），refreshAllPages 后 ready；同项目点击不闪 loader。
6. listOk 且 0 项：正常显示空态，不误判 error。
7. `_showProjectSkeleton(false)` 仍能正常关闭其余页 skeleton。
8. 片段页：prefetch 期间 `.batch-workbench-scroll` 有 region loading；`children.length` 判据不被污染；旧 render 不误关新 loader（`renderSeq`）；reattach/导入/镜像无回归。
9. 剪辑页遮罩盖住时间线(`z-[50]`)；镜头页 shots+images 两区都覆盖。

---

## 9. 交给 Codex / Claude Code 的执行顺序
1. `styles.css`(v186)：4 页 `position:relative;isolation:isolate`、`.batch-workbench-scroll{position:relative}`、`.sw-page-loading`(`background:var(--bg-main)`,`z-index:60`)、`.sw-region-loading`、像素 keyframes、error 态样式。
2. `workspace.html`：注入 4 个 `.sw-page-loading`；importmap bump（project 105 / videoTasks 119 / 新 loading 1）；`styles.css?v=186`、`main.js?v=247`。
3. 新建 `modules/loading.js`。
4. `main.js`(v247)：权威态 + `swLoadBegin/Done/Error` + `_retryActiveLoad` + `_pageUsesInlineLoader`；`_showProjectSkeleton` 仅拦 on=true；`init` 内 startup begin + bootReady 后 rAF settle；`_activateProjectContext` begin/done + **catch swLoadError 续抛**；ctx 注入 `setActiveLoadOutcome` / `swRegion` / loading 控制器；import 改 project.js?v=105 + 新增 loading.js。
5. `project.js`(v105)：`listOk`/`targetFetchFailed` + `setActiveLoadOutcome`。
6. `videoTasks.js`(v119)：补 `var _batchRenderSeq=0`；`renderBatchClipList` 包 `swRegion.show/hide` + `try/finally` renderSeq。
7. 自测：`npm run typecheck`、§8 全清单、Slow 3G 录屏 before/after、断网重试与切项目失败两条专项。

> 确认即进 Phase 0；本阶段未改任何代码。
