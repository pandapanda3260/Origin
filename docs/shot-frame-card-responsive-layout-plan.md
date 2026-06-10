# 镜头页「分镜板·首帧/尾帧」卡片自适应布局方案

状态：**已审批并落地**（2026-06-10）。实际版本号与 5.3 略有出入：落地时仓库并行改动已把版本推前，最终为 styles.css?v=224、storyboard.js?v=139（main.js 直接 import 与 import map 两处）、main.js?v=282；契约测试 test-storyboard-index-rail-contract.js 的钉值已同步。静态验证全过（node --check、CSS 括号配平、4 个相关契约测试），浏览器宽度扫线实测待做（见 §7）。
日期：2026-06-10
范围：`public/styles.css` 中 sb-frame 组件族 + `public/modules/storyboard.js` 一处 6 行以内的小改

---

## 1. 问题是什么、发生在哪

屏幕（窗口）缩到中等宽度时，镜头页每张镜头卡里的「分镜板·首帧」区域出现两类问题：

1. **图片展示列溢出**：右侧"图片展示"灰色区域和底部按钮行被推出白色面板边框，按钮文字被裁切（截图里"生成首帧"只剩"生成首"）。
2. **参考素材缩略图不缩反胀**：屏幕越窄，缩略图反而越大（从一行 3 张 64px 变成一行 2 张 ~100px），垂直方向也跟着变高（1:1 方块），挤占中间列空间。

这不是某一条样式写错，而是**布局的"地基"用错了参照物**——下面先把宽度链路摆出来。

### 1.1 宽度链路（逐层扣实际代码）

从窗口宽度到"分镜板"内容区，每一层都要扣掉固定开销：

| 层级 | 代码位置 | 占宽 |
|---|---|---|
| 左侧导航 `aside#sidebar` | workspace.html:158（`w-72`）、337（main `ml-72`） | 288px |
| 页面壳 `.shots-dashboard-shell` | styles.css:9473 | max-width 1540，左右 padding 28×2 |
| 双栏 `.shots-two-col`（主列+剧本原文栏） | styles.css:13085 | 主列 `minmax(700px,1fr)`，右栏 `minmax(248px,300px)`，gap 18；≤1600 时 680/236–292/16（13179）；≤1320 收成单列（13757） |
| 镜头卡 `.shot-workbench-card` | styles.css:13785 | padding 26×2（≤1600 时 20×2，13184） |
| 分镜槽 `.shot-storyboard-slot` | styles.css:3365 | border-left 1px + padding-left 16px |
| 帧面板 `.sb-frame-panel` | styles.css:14031 | border 1px×2，**overflow:hidden** |
| 三列网格 `.sb-frame-layout` | styles.css:14124 | **见下** |

`.sb-frame-layout`（styles.css:14124）是问题核心：

```css
grid-template-columns: minmax(168px, 0.66fr) minmax(214px, 0.84fr) minmax(300px, 1.2fr);
gap: 16px; padding: 16px;
```

三列各有**像素下限**（168/214/300），加 gap 和 padding，这个网格的硬下限是 **746px**（≤1500 的变体是 696px，14475）。CSS Grid 的 `minmax` 下限是不可压缩的：容器不够宽时，网格不会再缩，而是直接**撑破容器**。面板上的 `overflow:hidden` 把撑出去的部分裁掉——这就是按钮被切、灰色区压线的直接机制。

### 1.2 为什么现有断点救不了：参照物错了

现在所有 sb-frame 的自适应规则都是 **viewport 媒体查询**（@media，看的是窗口宽度）：≤1500 微调列宽（14475）、≤900 收单列（14482）。但分镜板的真实可用宽度不等于窗口宽度——中间隔着导航 288 + 壳 padding 56 + 右栏 236~300 + 卡 padding + 槽 padding，共 **约 600px 的"层层抽水"**，而且右栏在 ≤1320 时还会整体消失，可用宽度反而回弹。

把数字代进去（≤1600 档，CSS 像素）：

| 窗口宽 | 分镜板实际可用宽 | 需要 ≥696 | 结果 |
|---|---|---|---|
| 1440 | ≈729 | ✓ | 正常 |
| 1400 | ≈689 | ✗ 差 7px | 开始溢出 |
| 1366（最常见笔记本） | ≈655 | ✗ 差 41px | 明显溢出 |
| 1321 | ≈621 | ✗ 差 75px | 严重溢出（截图状态） |
| 1320 及以下 | 右栏掉下去，≈917 | ✓ | 又正常了 |

也就是说存在一条 **约 1320–1410px 的"死区"**：右栏还在、媒体查询不收列、网格下限又塞不下。≤900 的单列断点在这套结构里**永远轮不到生效**（双栏在 1320 就先收了）。窗口缩放、浏览器 zoom（80%/67%）都会路过这条死区带。

这也解释了为什么历史上已经为它打过 6 个媒体查询补丁（1800/1600/1500/1320/1000/900）还是漏：每个补丁都在猜"窗口多宽时卡片多宽"，而这个换算关系随右栏收放、壳 max-width 封顶、padding 档位变化而变，**猜不全**。继续沿这条路加断点就是补丁上打补丁。

### 1.3 缩略图"越缩越大"的机制

`.ffe-material-strip`（styles.css:15665）：

```css
grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
```

`auto-fill + minmax(64px, 1fr)` 的行为是：按 64px 下限算一行塞几列，**塞不下就减一列，剩下的列平分整行宽（1fr 无上限拉伸）**。中间列 ~214px 时一行 3 列、每张 ~65px；列宽掉到 ~205px 时跳变成一行 2 列、每张 ~98px。配合缩略图 `aspect-ratio:1/1`（13504），宽高一起膨胀。这正是"屏幕缩小、缩略图反而变大挤占空间"的来源——缺一个**尺寸上限**。

### 1.4 图片展示高度的参照物也错了

`.sb-frame-preview-stage`（styles.css:14385）：

```css
height: clamp(210px, 16vw, 276px);
```

高度看的是 **16vw（窗口宽度）**，和它所在列的宽度、和项目画幅都无关。列被挤窄时高度不跟着缩；项目画幅是 9:16/1:1 时黑底上下留大块空白（图片用 object-contain 缩在里面）。项目画幅在数据里是现成的（`project.styleOptions.aspectRatio`，main.js:4098；分镜计划里也有 `plan.aspectRatio`，storyboard.js:3363），但 stage 没用它。

---

## 2. 行业调研结论

针对"组件要适配的是**所在容器**而不是窗口"这个问题，行业已有定型答案：

1. **CSS 容器查询（Container Queries）**：2023 年起全主流浏览器 Baseline 支持，State of CSS 2025 中 41% 开发者已在用。共识用法是：**页面宏观布局用媒体查询，组件内部布局用容器查询**（[LogRocket 2026](https://blog.logrocket.com/container-queries-2026/)、[freeCodeCamp](https://www.freecodecamp.org/news/media-queries-vs-container-queries/)、[web.dev](https://web.dev/learn/css/container-queries)）。要点：父元素声明 `container-type: inline-size`，子元素用 `@container (width < 720px) {...}` 切布局；本仓库 FFE 弹窗已用过 `container-type: size`（styles.css:17384），技术上有先例。已知坑（调研确认，方案里已规避）：容器不能查询自己、grid item 直接当容器要谨慎、查询条件里不能用 CSS 变量。
2. **缩略图网格的防御性写法**：`minmax(X, 1fr)` 的 1fr 拉伸正是"少一列就变大"的根源；行业建议给 tile 设**上限**（`minmax(56px, 84px)` 这类）或干脆固定尺寸，让"每行张数"变、"每张尺寸"基本不变（[CSS-Tricks auto-fill vs auto-fit](https://css-tricks.com/auto-sizing-columns-css-grid-auto-fill-vs-auto-fit/)、[Defensive CSS](https://defensivecss.dev/tip/auto-fit-fill/)、[CSS-Tricks minmax+min()](https://css-tricks.com/intrinsically-responsive-css-grid-with-minmax-and-min/)）。
3. **预览区用 `aspect-ratio` 驱动**：媒体预览框的标准做法是"宽度跟列、高度由 `aspect-ratio` 推导、再给最大高度兜底"，而不是 vw/固定高（[web.dev aspect-ratio](https://web.dev/articles/aspect-ratio)、[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_box_sizing/Understanding_aspect-ratio)）。
4. **JS ResizeObserver 方案**：能做但属于下策——多一套 JS 状态、首帧渲染有布局抖动，纯 CSS 能力已覆盖本场景（LogRocket 同文）。

---

## 3. 方案对比与定论

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 继续加媒体查询断点 | 在 1410/1320 之间再插一档列宽 | **否**。参照物仍是窗口，右栏收放/zoom/壳封顶任一变化就再漏，正是"补丁上打补丁" |
| B. 容器查询组件自适应（**推荐**） | sb-frame 面板自己量自己的宽度，按宽度档位切 3列/2列/1列；同步把缩略图加上限、stage 改 aspect-ratio | 一次把参照物纠正过来；镜头卡、合并片段卡（sb-sheet）、旧挂载点三处复用同一组件的场景**全部自动受益**；纯 CSS，无运行时成本 |
| C. JS ResizeObserver 算宽切 class | 监听面板宽度加类名 | 否。多一套状态和抖动，能力上不比 B 多 |

**定论：B。** 理由：它消灭的是错误参照物本身而不是某个症状；死区不再存在（无论右栏在不在、zoom 多少，面板只看自己多宽）；且 `_storyboardFramePanelHtml` 渲染的所有挂载场景统一修好。环境上本项目跑在本机 Chrome，容器查询 Chrome 105+（2022）即支持，仓库已有使用先例，无兼容顾虑（也符合"不为老环境做兼容"的原则）。

---

## 4. 推荐方案详细设计

### 4.1 容器声明与三档布局

`.sb-frame-panel` 声明为查询容器（`container: sb-frame / inline-size`）。它是 `.sb-frame-stack`（纵向 flex）里的拉伸子项，宽度由父级决定、与自身内容无关，符合容器查询的安全使用条件。

`.sb-frame-layout` 按**面板宽度**分三档，用 `grid-template-areas` 排区块（纯 CSS 重排，不动 DOM、不动 JS）：

**宽档（≥720px）— 维持现状三列**

```
[ 画面描述 ] [ 参考素材+对白 ] [ 图片展示+按钮 ]
```

列定义改为 `minmax(0, 0.66fr) minmax(0, 0.84fr) minmax(0, 1.2fr)`——视觉比例不变，但**去掉像素下限**（168/214/300）。档位切换保证每列不会真的太窄，`minmax(0,…)` 是防御性兜底：任何边界时刻都不再可能撑破容器。

**中档（480–719px）— 两列，图片展示占右列通高**

```
[ 画面描述   ] [ 图片展示 ]
[ 参考素材+对白 ] [ （含按钮） ]
```

理由：这一档正是现在的死区带。图片是分镜板的主对象，保住它 ~52% 列宽不缩成邮票；描述和素材在左列上下叠，文本列天生耐窄。

**窄档（<480px）— 单列，图片优先**

```
[ 图片展示+按钮 ]
[ 画面描述 ]
[ 参考素材+对白 ]
```

理由：窄环境下用户的高频动作是"看结果 + 点生成/重生成"，把图和按钮放最上；编辑长描述是宽屏行为。这与移动端媒体卡"图在上"的通行式一致。若你不认可这个顺序，改一行 `grid-template-areas` 即可换成"描述在上"，成本为零，先按图优先做。

随档位联动的小项：中/窄档下 `.sb-frame-prompt-editor` 的 `min-height` 从 18 行降到 10 行（现 14237 的 `calc(18*1.75em+14px)` ≈ 360px，窄屏太霸道）；窄档 `.sb-frame-actions` 允许换行（`flex-wrap: wrap`，按钮 `flex:1 1 calc(50% - 4px)` 成 2×2），不再依赖裁切。

### 4.2 图片展示 stage：画幅驱动，废除 16vw

```css
.sb-frame-preview-stage {
  width: 100%;
  aspect-ratio: var(--sb-stage-ar, 9 / 16);
  max-height: 460px;   /* 防止 9:16 在宽列下无限长高 */
  height: auto;        /* 废除 clamp(210px,16vw,276px) */
}
```

`--sb-stage-ar` 由 JS 在渲染面板时写在 style 上（见 5.2），取值链：`sb.aspectRatio || plan.aspectRatio || project.styleOptions.aspectRatio`，缺省 9:16（与 main.js:4099 的项目默认一致）。效果：1:1 项目得到方形 stage、16:9 得到宽幅、9:16 得到受 460px 封顶的竖幅；列多宽 stage 就多宽，**高度永远从列宽推导**，黑边大幅减少。≤900 媒体查询里的 `height: min(62vw,360px)`（14493）一并废除。

### 4.3 参考素材缩略图：加上限，越窄越小而不是越大

只动镜头卡作用域（`.sb-frame-context-col .ffe-material-strip`），FFE 弹窗的固定 tile 版（17271）不受影响：

```css
grid-template-columns: repeat(auto-fill, minmax(min(52px, 100%), 84px));
justify-content: start;
```

行为变化：每张缩略图被夹在 52–84px 之间，列变窄时**先减尺寸再换行**，永远不会膨胀到 ~100px；`min(52px,100%)` 防极端窄容器溢出。删除按钮 18px 在 52px tile 上仍可点。同步把 `.sb-frame-context-col .sb-material-thumb-image` 的 `min-height:58px`（14377）撤掉（与上限 84px 的 tile 冲突且已无必要）。"添加素材"框跟随同一轨道尺寸，自动一致。

### 4.4 交互不变项（明确不碰）

折叠/展开（is-collapsed）、缩略图 hover 放大与删除角标、stage hover 1.05 缩放、lightbox、角色下拉（role picker）、按钮的语义与禁用逻辑——全部保持原样。本方案只改"东西摆在哪、多大"，不改"点了发生什么"。

---

## 5. 改动清单（按文件）

### 5.1 public/styles.css（唯一主战场，集中在 14031–14496 一个区域）

| 位置 | 动作 |
|---|---|
| 14031 `.sb-frame-panel` | 加 `container: sb-frame / inline-size` |
| 14124 `.sb-frame-layout` | 列定义去像素下限 → `minmax(0,…)`；新增 `grid-template-areas` 三档 `@container sb-frame` 规则块（约 +60 行，写在同区域） |
| 14385 `.sb-frame-preview-stage` | `height: clamp(...)` → `aspect-ratio: var(--sb-stage-ar, 9/16) + max-height: 460px` |
| 14377 | 删 `.sb-frame-context-col .sb-material-thumb-image/.sb-material-add-box` 的 `min-height:58px` |
| 14374 区域 | `.sb-frame-context-col .ffe-material-strip` 覆写 tile 轨道为 `minmax(min(52px,100%), 84px)` |
| 14426 `.sb-frame-actions` | 窄档容器查询内放开 `flex-wrap` |
| 14475–14479 | 删该 ≤1500 块里的 `.sb-frame-layout` 规则（同块的 `.shot-card-head` 等规则**保留**） |
| 14482–14496 | 整块删除（≤900 的三条全是 sb-frame 规则，已被容器档位取代） |

**不动**：`.shots-two-col` 全部断点（1800/1600/1320，页面宏观布局，媒体查询本来就是对的工具）、`.shot-workbench-card`、FFE 弹窗全部样式、`.sb-sheet`、≤1000 块。

### 5.2 public/modules/storyboard.js（约 6 行）

`_storyboardFramePanelHtml`（3134 附近）给 `.sb-frame-preview-stage` 加内联 `style="--sb-stage-ar: 1 / 1"`：新增一个 ~4 行的映射小函数（'1:1'→`1 / 1`，'16:9'→`16 / 9`，其余→`9 / 16`），取值链见 4.2。不触任何数据层、不触共享 resolver。

### 5.3 public/workspace.html（1 行）

`styles.css?v=220` → `?v=221`；若 storyboard.js 改动落地，模块版本号同步 bump（前端缓存规则）。

### 5.4 顺带收益（零额外成本）

合并片段卡（sb-sheet 内的只读首/尾帧面板）和旧挂载 `#imageGrid` 渲染的是同一个 `_storyboardFramePanelHtml` + 同一套 CSS——容器查询按各自实际宽度生效，这两处长期同病的挤压问题一起被修复，无需单独处理。

---

## 6. 风险与回退

| 风险 | 评估与对策 |
|---|---|
| flex 子项做查询容器的塌缩坑（调研提到） | `.sb-frame-panel` 宽度来自纵向 flex 的 stretch，与内容无关，不在坑的触发条件内。万一实测异常：在 panel 内加一层 wrapper 当容器，5 分钟兜底 |
| `inline-size` 容器附带 layout containment，影响绝对定位后代 | 面板内唯一的绝对定位弹层是 role picker，它锚在自带 `position:relative` 的 `.ffe-material-add-wrap` 上，不受影响；列入验收必测项 |
| 9:16 默认画幅在宽档让 stage 偏高 | 已用 `max-height:460px` 封顶；具体数值实测后可调 |
| 老项目无 `styleOptions.aspectRatio` | 取值链兜底到 9:16，不写迁移（按"不为老项目做兼容"原则） |
| 视觉回归（宽屏下三列比例变化） | 宽档保留原 fr 比例，仅去像素下限，1440px 以上视觉应无可感知差异；验收对比截图确认 |

回退方式：纯 CSS 区域性改动 + 1 个 JS 内联变量，git revert 单提交即可整体回退，无数据迁移、无接口变更。

## 7. 验收清单（实施后实测，不是逻辑自查）

1. 窗口宽度扫线：1280 / 1320±5 / 1366 / 1400 / 1440 / 1600 / 1920，每档检查：无横向溢出、按钮文字完整、缩略图 ≤84px、stage 不压线。重点死区 1320–1410。
2. 浏览器 zoom 67% / 80% / 110% 重复上述抽查。
3. 三种画幅项目各开一个（1:1 / 16:9 / 9:16），确认 stage 形状随画幅、黑边显著小于现状。
4. 交互回归：折叠展开、缩略图删除/添加、role picker 弹层不被裁、lightbox、尾帧面板、合并片段卡只读面板、首帧生成中 loading 遮罩对位。
5. 对照组不受影响：FFE 编辑弹窗、剪辑页、资产页（grep 确认无选择器外溢）。

---

## 附：调研来源

- [LogRocket — Container queries in 2026](https://blog.logrocket.com/container-queries-2026/)（用法、坑、媒体查询分工）
- [freeCodeCamp — Media Queries vs Container Queries](https://www.freecodecamp.org/news/media-queries-vs-container-queries/)
- [web.dev — Container queries](https://web.dev/learn/css/container-queries) / [aspect-ratio](https://web.dev/articles/aspect-ratio)
- [CSS-Tricks — auto-fill vs auto-fit](https://css-tricks.com/auto-sizing-columns-css-grid-auto-fill-vs-auto-fit/) / [minmax + min()](https://css-tricks.com/intrinsically-responsive-css-grid-with-minmax-and-min/)
- [Defensive CSS — auto-fit vs auto-fill](https://defensivecss.dev/tip/auto-fit-fill/)
- [MDN — Using container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using) / [aspect-ratio](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_box_sizing/Understanding_aspect-ratio)
