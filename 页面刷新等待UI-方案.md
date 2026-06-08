# 统一页面刷新等待 UI — 方案 v4（工程化定稿，基于真实代码扫描，待确认后执行）

> 本版整合你提的 8 条落地修正，整篇重写（非补丁）。所有锚点已逐个扫码核实，决策全部拍死、无选择项。
> 边界（保留 v3，已确认正确）：只动 `public/`；不做小游戏；不做横幅 / 顶部进度条；静态 loading 节点写进 `workspace.html` 解决预启动闪屏；4 页灰度；不动后端 / 字段 / schema / `readyForEdit` / reattach / 导入逻辑。
> **本阶段不改任何代码，等你确认后再执行。** 产出可直接交 Codex / Claude Code。

---

## 0. 一句话方案

4 个重灾页（资产 / 镜头 / 片段 / 剪辑）各放一个**默认可见、绝对定位、带局部 stacking context 的页面内像素加载层**，由 `main.js` 一个**独立 `_swLoadToken` 驱动的权威加载态**统一显隐；启动 `done` 在 **boot 最终 `switchPage(forceRefresh)` 之后**触发，切项目 `begin` 在 **`_activateProjectContext` 开始处**触发，失败显式判定进 error+retry。

---

## 1. 扫码核实结论（逐条对应你的 8 点，带真实行号）

| # | 你的修正 | 扫码核实（file:line） | 处理 |
|---|---|---|---|
| 1 | done 不能放 loadProject 末尾 | `init()`(main.js:6962) 里 `await loadProject()`(7078) **早于** `syncEditProject(project)`(7469) 与各页事件接线；boot 期 `switchPage` 刷新被 `_appBootstrapping`(164) 延后(1778-1779)，真正可见刷新在 `_appBootstrapping=false`(7588) 后的 `switchPage(bootTargetPage,{forceRefresh:true})`(7590) | ✅ 启动 `done` 改到 **7590 之后**由 main.js 触发 |
| 2 | `_projectActivationToken` 不能复用 | 它只在 `_activateProjectContext` 里 `++`(899)；硬刷新走 `loadProject()` 不经过它 | ✅ 新建独立 `_swLoadToken`，begin/done/error **同时**接 `loadProject` 路径与 `_activateProjectContext` |
| 3 | 切项目 begin 太晚 | `_activateProjectContext`(896) 在 `fetchProjectByIdShared`(920) **之后**才 `_resetProjectRuntime`(928)；fetch 期间旧内容仍在 | ✅ begin 提到 `_activateProjectContext` 开始处(紧挨 `_setProjectActivating(true)` 907)，成功 refresh(938) 后 done，catch 进 error |
| 4 | skeleton no-op 不能无条件 | `_showProjectSkeleton(on)`(1113)：`on=true` 建/显，`on=false` 走隐藏+清 watchdog | ✅ 只在 `on===true` 且 active∈4页 时 `return`；`on===false` 必须照常清理 |
| 5 | loadFailed 要显式 | `loadProject` 列表失败被吞→`serverList=[]`(327/350/352)，`targetId` 随后被清空(356-360)；目标项目 fetch 失败仅 console.warn(401-403) | ✅ 显式记 `listOk` / `targetFetchFailed`：listOk 且 0 项=ready/empty；listOk=false 或 targetFetchFailed=true 才 error |
| 6 | batch loader 避开 children 计数 | `syncTaskListVisibility()` 用 `clipList.children.length` 判 `hasPlanRows`(videoTasks.js:1314)；`renderBatchClipList` 的 `list.innerHTML=""`(2999) 会删子节点 | ✅ region loader 挂到外层 `.batch-workbench-scroll`(workspace.html:1200，含 `#batchClipList`1201)，绝对定位、**不作 `#batchClipList` 子节点**；`try/finally` + `renderSeq` 防旧 render 误关 |
| 7 | 遮罩 z 要高于剪辑层 | edit 时间线 `#editTimelineArea` 是 `relative z-[50]`(workspace.html:1370) | ✅ 4 页容器 `isolation:isolate` 建局部 stacking context，loading 层 `z-index:60`（页内最高） |
| 8 | 版本号按现状 | importmap 已 `project.js?v=104`(workspace.html:1749)、`videoTasks.js?v=118`(1763)；但 `main.js:18` 是相对 `./modules/project.js?v=103`（绕过 importmap），`main.js:27` 是裸 `/modules/videoTasks.js`（走 importmap） | ✅ 见 §6：project.js→105（importmap+main.js:18 两处）；videoTasks.js→119（只 importmap，main.js:27 裸 import 自动解析）；不写 `?v=1` |

---

## 2. 决策清单（全部拍死，无选项；不同意可否单条）

1. **加载视觉**：页面内绝对定位遮罩 `.sw-page-loading`，默认可见（治预启动闪），内含像素「O」环 + 「加载中…」。
2. **像素动效**：纯 CSS 像素方块拼 Origin「O」环按序淡入循环；单色随主题文字色；~44px；零依赖、无 canvas。
3. **权威态归 main.js**：`_swLoad = { projectId, token, status }`，独立计数器 `_swLoadToken`；`_isSwLoadCurrent(t)=t===_swLoadToken`；done/error 过期回调丢弃。各页不加 loaded 标志。
4. **启动 done 时机**：boot 最终 `switchPage(...forceRefresh)`(7590) 之后由 main.js settle（§3.2）。
5. **切项目 begin 时机**：`_activateProjectContext` 开始处(907 附近)。
6. **error/retry**：`loadProject` 顶层 `listOk`/`targetFetchFailed` 显式判定；retry = 重新 `loadProject()`。
7. **batch region loader**：挂 `.batch-workbench-scroll`，绝对定位，非 `#batchClipList` 子节点，`try/finally`+`renderSeq`。
8. **z 层级**：4 页容器 `isolation:isolate` + loading 层 `z-index:60`。
9. **skeleton 处置**：`_showProjectSkeleton` 仅在 `on===true` 且 active∈{assets,shots,batch,edit} 时 no-op；其余照常。
10. **版本**：§6 唯一版本号统一 bump；新 `loading.js` 走 importmap 绝对路径（与 edit/videoTasks 同款），不用相对 `?v`。
11. **loading.js 注入**：仅 main.js import 一次，控制器经各页现有 `initXxx(ctx)` 下发；batch 的 region loader 经 `initVideoTasks` ctx 注入。

---

## 3. 状态机与时序（精确到行）

### 3.1 权威态（main.js）
```
_swLoadToken = 0
_swLoad = { projectId:'', token:0, status:'loading' }      // 初始即 loading，与遮罩默认可见一致
_swStartupLoadFailed = false                               // loadProject 回填

swLoadBegin(projectId)  : _swLoad={projectId, token:++_swLoadToken, status:'loading'}; 显 4 页遮罩
swLoadDone(token)       : if(token!==_swLoadToken)return; _swLoad.status='ready'; 隐 4 页遮罩(淡出)
swLoadError(token)      : if(token!==_swLoadToken)return; _swLoad.status='error'; 4 页遮罩切 error+retry
```

### 3.2 启动时序（硬刷新）
```
HTML 解析 → boot CSS 显示记忆页(workspace.html:40-69) → 该页 .sw-page-loading 默认可见  ← 预启动不闪
init()(6962):
  switchPage(initialBootTargetPage)(6974) — boot 期刷新被延后(1778)
  initVideoTasks(7003) / initProject(7050) …
  swLoadBegin(startup) ← main.js 在 `await loadProject()`(7078) 前调；记 startupToken
  await loadProject()(project.js:319) → 回填 _swStartupLoadFailed（§4.5），期间不 done
  initEdit(7445)/syncEditProject(7469)/各页事件接线 …
  boot finalize: _appBootstrapping=false(7588); switchPage(bootTargetPage,{forceRefresh:true})(7590) ← 真实渲染
  settleStartup(): _swStartupLoadFailed ? swLoadError(startupToken) : swLoadDone(startupToken)   ← done 在这里
```

### 3.3 切项目时序
```
_activateProjectContext(projId)(896):
  _setProjectActivating(true)(907) → swLoadBegin(projId)   ← begin 提前到 fetch 之前
  [若 project.id===projId 直接 return(913)] → swLoadDone(token) 后返回（无加载）
  await fetchProjectByIdShared(920) → 失败/抛错 → catch → swLoadError(token)
  _resetProjectRuntime(928) / _syncProjectModules(935) / refreshAllPages(938) / _restoreVideoTasks(939)
  成功落地后 → swLoadDone(token)
  [stale token 的 return(917/924/945) 不 settle —— 新 token 已接管，旧回调天然被丢弃]
```

---

## 4. 改动清单（file-by-file，可执行）

> Phase 0 触达 6 文件：`workspace.html`、`styles.css`、新 `modules/loading.js`、`main.js`、`project.js`、`videoTasks.js`。**不动** edit.js / shots.js / storyboard.js / assets.js 的 render。

### 4.1 `public/workspace.html`
- 4 个页容器各加**默认可见**遮罩（该页第一个子节点）：`#pageAssets` / `#pageShots` / `#pageBatch` / `#pageEdit`：
  `<div class="sw-page-loading" data-loading-for="assets" role="status" aria-live="polite"><span class="sw-pixel-o" aria-hidden="true"></span><span class="sw-load-text">加载中…</span></div>`
- importmap(1739-1766)：`project.js?v=104→105`、`videoTasks.js?v=118→119`、新增 `"/modules/loading.js":"/modules/loading.js?v=1"`。
- 顶部样式版本：`styles.css?v=182→183`(:73)。
- 入口脚本：`main.js?v=246→247`(:1769)。

### 4.2 `public/styles.css`（bump v183）
- `#pageAssets,#pageShots,#pageBatch,#pageEdit{position:relative;isolation:isolate;}`（建局部 stacking context，配合 §点7）。
- `.batch-workbench-scroll{position:relative;}`（承载 batch region loader）。
- `.sw-page-loading{position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:<工作区页面背景同款变量，禁止硬编码色>;transition:opacity .18s ease;}`
  `.sw-page-loading.is-hiding{opacity:0;pointer-events:none;}` `.sw-page-loading[hidden]{display:none;}`
- `.sw-region-loading{position:absolute;inset:0;z-index:30;...同款像素，缩小;}`（batch 列表区用）。
- 像素「O」环 keyframes（方块按序淡入循环）。

### 4.3 `public/modules/loading.js`（新增，importmap v1）
- 工厂导出：`createSwLoading({ pageLayerSelector })` → `{ showPage(id), hidePage(id), errorPage(id,onRetry), showRegion(el), hideRegion(el), pixelEl() }`。
- 只操作传入节点；error 态用同一遮罩切文案+「重试」按钮；零依赖。

### 4.4 `public/main.js`（bump v247）
- 顶部 import：`import { createSwLoading } from '/modules/loading.js';`（绝对路径走 importmap）；`./modules/project.js?v=103` → `?v=105`(:18)。
- 新增 `_swLoadToken`/`_swLoad`/`_swStartupLoadFailed` 与 `swLoadBegin/Done/Error`/`_isSwLoadCurrent`/`settleStartup`（§3.1-3.2）。
- `_pageUsesInlineLoader(p){return p==='assets'||p==='shots'||p==='batch'||p==='edit';}`。
- `_showProjectSkeleton(on)`(1113) 开头：`if (on === true && _pageUsesInlineLoader(activePage)) return;`（**仅拦 on=true**）。
- `await loadProject()`(7078) **前** `swLoadBegin('')`（startup）；boot finalize `switchPage(...forceRefresh)`(7590) **后**加 `settleStartup()`。
- `_activateProjectContext`(896)：`_setProjectActivating(true)`(907) 后 `swLoadBegin(projId)`；同项目早返回前 `swLoadDone`；成功(938 后) `swLoadDone(token)`；catch `swLoadError(token)`。
- `initProject` ctx(7050)：加 `setStartupLoadOutcome:(failed)=>{_swStartupLoadFailed=failed;}`（与 `showProjectSkeleton` 并列）。
- `initVideoTasks` ctx(7003)：注入 `swRegion:{show,hide}`（指向 `.batch-workbench-scroll`）。

### 4.5 `public/modules/project.js`（bump v105：importmap+main.js:18）
- `loadProject()`(319)：
  - 列表请求：`var listOk=false;` 仅在 `resp.ok`(335) 置 `listOk=true`；非 ok / catch 不置。
  - 目标项目：`var targetFetchFailed=false;` 当 `targetId` 存在但 `fetchProjectFromServer` 返回 null(401-403) → `targetFetchFailed=true`。
  - 末尾（refreshActivePage 之后 417）：`var failed = (!listOk && !_getProject()) || targetFetchFailed;`（listOk 且 0 项 → failed=false=ready）。`_ctx.setStartupLoadOutcome && _ctx.setStartupLoadOutcome(failed);`
  - **不**在此调 done/hide（启动 done 由 main.js settleStartup 管）。

### 4.6 `public/modules/videoTasks.js`（bump v119：仅 importmap，main.js:27 裸 import 自动解析）
- `renderBatchClipList()`(2961)：函数体 `var seq = ++_batchRenderSeq;`；**prefetch await 之前**(2975 上) `_ctx.swRegion && _ctx.swRegion.show();`；`try{ …原逻辑… } finally { if(seq===_batchRenderSeq) _ctx.swRegion && _ctx.swRegion.hide(); }`。**仅包裹，不改原逻辑**；loader 不进 `#batchClipList`，不影响 `list.innerHTML=""`(2999) 与 `children.length`(1314)。
- `refreshBatchPage()`(2845) 不改。

---

## 5. 不碰清单
- `readyForEdit`、批次 reattach、导入剪辑下一步、`hasLiveRow`/任务镜像、`syncTaskListVisibility` 的 `children.length` 判据、`project_edit_readiness` 字段口径。
- 共享 resolver / 字段 schema；`reference-site/`、后端、`lib/model-routing`、`CLAUDE.md` 治理项。
- edit.js / shots.js / storyboard.js / assets.js 的 render 逻辑（遮罩在其之上集中托管）。
- 不做老数据迁移 / 兼容。

---

## 6. 版本 bump 清单（按当前文件现状）
| 模块 | importmap(workspace.html) | main.js import | 备注 |
|---|---|---|---|
| project.js | 1749：`?v=104→105` | :18 相对 `?v=103→105` | 两处都改（相对 import 绕过 importmap） |
| videoTasks.js | 1763：`?v=118→119` | :27 裸 `/modules/videoTasks.js`（不动） | 裸 import 走 importmap，自动取 v119 |
| loading.js（新） | 新增 `?v=1` | :顶部 `import … from '/modules/loading.js'` | 绝对路径走 importmap |
| styles.css | — | workspace.html:73 `?v=182→183` | |
| main.js | — | workspace.html:1769 `?v=246→247` | |

沉淀规则：以后改 `loading.js`/`videoTasks.js` 只 bump importmap 版本；改 `project.js` 记得 importmap + main.js:18 两处同步（直到把 :18 也改成裸 import 走 importmap，本期先对齐版本号不重构）。

---

## 7. 分期
- **Phase 0（本次审批范围）**：§4 全部，仅 assets/shots/batch/edit。产出 = 预启动不闪 + 统一页面内像素加载 + 启动/切项目时机正确 + error/retry + 片段 async 不漏 loading + z 层级正确。
- **Phase 1**：铺到其余流水线页；按需给 shots/images/assets 加 region loader；像素动效与空/错态文案定稿。

---

## 8. 验收清单（可实跑）
1. 硬刷新进 4 页：JS ready 前也只见像素加载层，不闪 guard/空态（Slow 3G / 首帧断点验证）。
2. 启动 done 时机：遮罩在 boot 最终 `forceRefresh`(7590) 渲染后才淡出，资产/镜头/剪辑无"先露旧 guard 再变"的二次跳。
3. 切项目：点切换的**那一刻**起遮罩就在（fetch 期间不露旧项目）；成功 ready / 失败 error；过期回调不误关。
4. 接口失败（断网/500/列表挂）：4 页「加载失败 · 重试」，重试重走 loadProject；listOk 且 0 项仍正常显示空态（不误判 error）。
5. `_showProjectSkeleton(false)` 仍能正常关闭（其余页 skeleton 不卡死）。
6. 片段页：prefetch 期间 `.batch-workbench-scroll` 有 region loading；`syncTaskListVisibility` 的 `children.length` 判据不被污染；批次 reattach/导入/任务镜像无回归；旧 render 不误关新 loader。
7. 剪辑页遮罩盖得住时间线（z-50 之上）。
8. 镜头页 shots+images 两区都被覆盖，不闪 `imagesNeedShots`。

---

## 9. 交给 Codex / Claude Code 的执行顺序
1. `styles.css`：4 页 `position:relative;isolation:isolate`、`.batch-workbench-scroll{position:relative}`、`.sw-page-loading`/`.sw-region-loading`/像素 keyframes（bump 工作区背景变量，勿硬编码色）。
2. `workspace.html`：注入 4 个 `.sw-page-loading` 静态节点；importmap bump（project 105 / videoTasks 119 / 新增 loading 1）；`styles.css?v=183`、`main.js?v=247`。
3. 新建 `modules/loading.js`。
4. `main.js`：`_swLoad*` 状态 + begin/done/error + settleStartup + `_pageUsesInlineLoader`；`_showProjectSkeleton` 仅拦 on=true；`loadProject` 前 begin、7590 后 settleStartup；`_activateProjectContext` begin/done/error；ctx 注入（setStartupLoadOutcome、swRegion、loading 控制器）；import 改 project.js?v=105 + 新增 loading.js。
5. `project.js`：`listOk`/`targetFetchFailed` + `setStartupLoadOutcome`。
6. `videoTasks.js`：`renderBatchClipList` 包 `swRegion.show/hide` + `renderSeq` try/finally。
7. 自测：`npm run typecheck`（如涉及）、手动跑 §8 全清单、Slow 3G 录屏 before/after、切项目与断网两条专项。

> 确认这版即可进入实现；本阶段未改任何代码。
