# 首帧"生成中"一等状态 + `_imagesGenerating` 超时兜底 — 落地方案

> 目标:让"生成中"成为分镜卡片的**数据驱动一等状态**,toast / 守卫 / 卡片画面来自同一真相源;并给 `_imagesGenerating` 加看门狗,防 SSE 断连卡死。**不动后端 / 不写老项目兼容**。

## 一、根因回顾(已扣真实代码)

1. 点"生成首帧"= 派发 `regen-sb`,首行守卫早退:
   `storyboard.js:7967` → `if (_imagesGenerating) { showToast("正在生成中，请稍候","warn"); return; }`
   命中即 `return`,**根本没走到 `generateStoryboardSheet`,也没 `updateStoryboardCard(gIdx,"loading")`** → 图片区不切 spinner,继续显示旧的"生成失败"。
2. 图片区结构上显示不了"生成中":`.sb-frame-loading` 永远写死 `hidden`(`storyboard.js:2601`),占位符只从数据推 待生成/已生成/失败(`2452–2478`);spinner 只能靠 `renderStoryboardFrameCard(...,'loading')` 命令式揭开(`render_hooks.js:189`)。**它是一次性覆盖层,不是持久状态**,任何 `renderImageGrid` 整渲都会打回 hidden。
3. `_imagesGenerating` 只在批量生命周期回调里复位(`227/314/324/7418/7503/7536/7551`),**无任何超时兜底**;SSE 断而 `onClose` 没触发 → 卡死在 true → 之后每次点单帧都被这条 toast 挡住。

→ toast(全局布尔)与卡片画面(每卡数据+命令式覆盖层)是**两套不同步机制**,这才是"提示一回事、画面另一回事"的根。

## 二、改动点(全部在 `public/` 前端,blast radius 收在一个子系统)

### 1. 新增按卡"生成中"登记表(瞬态,不入库)
`storyboard.js` 顶部(~`45` 行,与 `_imagesGenerating` 并列):
```js
var _frameGenerating = { first: new Set(), tail: new Set() }; // 仅前端态，不 saveProject
function _isFrameGenerating(gIdx, kind){ return _frameGenerating[kind==='tail'?'tail':'first'].has(gIdx); }
function _markFrameGenerating(gIdx, kind, on){ var s=_frameGenerating[kind==='tail'?'tail':'first']; on?s.add(gIdx):s.delete(gIdx); }
```
镜像现有 `_imagesGenerating` 的"模块级瞬态"惯例;**故意不挂到 `project.storyboards[gIdx]`**,避免被 `saveProject()` 的 debounced PUT 推到服务器(符合"不污染库 / 不做老兼容")。

### 2. 在唯一漏斗里置位/复位
`updateStoryboardCard`(`storyboard.js:6284`)是所有状态切换的唯一入口:
- `loading` → `_markFrameGenerating(gIdx,'first',true)`
- `done / ready / success / error` → `_markFrameGenerating(gIdx,'first',false)`

这样**单帧 / 批量 / 刷新恢复三条路径自动登记**(它们最终都调 `updateStoryboardCard`),无需各处单独加。尾帧在 `renderStoryboardFrameCard(...,'tail', done/error)` 处做对称清除。

### 3. `_storyboardFramePanelHtml` 增加 generating 分支(`storyboard.js:2451–2608`)
数据驱动,优先级 **generating > failed > 有图 > 无图**:
```js
var generating = _isFrameGenerating(gIdx, kind);
```
- 状态徽标/占位文案:generating 时走"生成中…"。
- `.sb-frame-loading`:把写死的 `hidden` 改成 `generating ? '' : ' hidden'`。
- `errorHtml`:generating 时强制 hidden(即便 `firstFrameFailed`)。

**核心收益**:任何整体 re-render 都会据 `_frameGenerating` 重新渲出 spinner,不再丢。CSS 无需新增——`.sb-frame-loading` / spinner / text 在 `styles.css:2957–2995` 已齐,去掉 `hidden` 即生效。

### 4. 守卫改成"诚实反馈"(`storyboard.js:7967`)
命中 `_imagesGenerating`(批量真在跑)时:
- 仍不并发(不启动新 batch),但反馈改明确:**"正在批量生成,完成后再单独重试"**;可顺手把该卡主按钮置灰 + tooltip。
- **不**给这张卡打 generating(它确实没在生成,是被批量挡住)——此时画面如实显示"失败/可重试",toast 也如实说明被批量挡住,而非含糊的"正在生成中"。

### 5. `_imagesGenerating` 超时兜底(防卡死泄漏)
把散落的 9 处裸赋值收敛到一个 setter(机械替换,低风险):
```js
var _imagesGeneratingWatchdog = null;
var IMAGES_GENERATING_CAP_MS = 10*60*1000; // 无任何进度上限，保守
function _setImagesGenerating(on){
  _imagesGenerating = on;
  if(_imagesGeneratingWatchdog){ clearTimeout(_imagesGeneratingWatchdog); _imagesGeneratingWatchdog=null; }
  if(on){ _imagesGeneratingWatchdog = setTimeout(function(){
    _imagesGenerating=false; /* + 复位按钮/hint */
  }, IMAGES_GENERATING_CAP_MS); }
}
```
- 替换 `232/7342` 置位、`227/314/324/7418/7503/7536/7551` 复位为 `_setImagesGenerating(...)`。
- 批量每有进度(`onSnapshot/onTaskStarted/onTaskCompleted/onTaskFailed`)就 `_setImagesGenerating(true)` 续命看门狗。
- 这是"给标志唯一 owner + 自愈",不是补丁。

### 6. 缓存版本号 bump
改了 `public/modules/storyboard.js`、`render_hooks.js` → 必须在 `workspace.html` bump 对应 `?v=`,否则浏览器跑旧 ESM 缓存。

## 三、验证(对齐现有契约测试)
- 新增 `scripts/test-first-frame-generating-state.mjs`,源码正则断言:
  (a) panel 有 generating 分支且 `.sb-frame-loading` 不再永远 hidden;
  (b) `updateStoryboardCard` 在 loading/done/error 切换 `_frameGenerating`;
  (c) 存在 `_setImagesGenerating` 看门狗。
  跑法同既有:`node scripts/test-first-frame-generating-state.mjs`。
- 手动复测:单帧生成→出现持久 spinner;中途触发一次 `renderImageGrid` spinner 不丢;完成→换图;批量进行中点单帧→如实提示;模拟 SSE 断→看门狗到点自动解锁,可再次生成。

## 四、不做(守范围)
- 不动后端 batch executor / projects-db schema;不写老项目迁移。
- 尾帧只做与首帧对称的最小同步,不扩尾帧逻辑。
- `_imagesStarting`(启动中)暂不并入守卫,可单列待议。

## 五、改动文件清单
| 文件 | 改动 |
|---|---|
| `public/modules/storyboard.js` | 顶部登记表 + helper;`updateStoryboardCard` 置/复位;panel generating 分支;守卫诚实反馈;9 处标志收敛进 `_setImagesGenerating` + 看门狗 |
| `public/modules/render_hooks.js` | 尾帧 done/error 处对称清除 `_frameGenerating` |
| `public/workspace.html` | bump `?v=` |
| `scripts/test-first-frame-generating-state.mjs` | 新增契约测试 |
