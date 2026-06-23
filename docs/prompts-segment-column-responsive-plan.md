# 「片段」栏宽度自适应 + 右间距收窄 优化方案

> 范围：仅「视频创作」页（`#pagePrompts`）左侧「片段」栏。不动其他页、不动共享口径。
> 状态：方案待审批，未动代码。

## 0. 一句话结论

把「片段」栏从写死的 `w-[420px]` 改成**和右栏已有的同一套 `clamp()` 响应式机制对齐**，并把尺寸值从 Tailwind 工具类里收回到 `styles.css` 单源管理。不是新发明，是用本页已经在用的成熟做法。

---

## 1. 现状扫描（扣真实代码，非推断）

| 项 | 现状 | 位置 |
|---|---|---|
| 片段栏宽 | `w-[420px]` 写死 + `shrink-0` 不压缩 | `workspace.html:1047` |
| 片段栏内边距 | `p-12` = 四边各 48px | `workspace.html:1047` |
| 滚动容器内边距 | `padding-left:8px; padding-right:12px;`（`pr-2` 被此 ID 规则覆盖） | `styles.css:4350` |
| 缩略图 | `w-full` 撑满，比例 `aspect-[16/9]`，实际宽 ≈ **304px** | `videoPrompts.js:1287` |
| 缩略图选中态 | `ring-2 ring-primary/30`（向外 2px），容器 `overflow-x:hidden` | `videoPrompts.js:1288` |

**右间距（缩略图右边 → 栏右边界）现状** = 栏 `p-12` 右 48px + 滚动容器右 12px = **约 60px**。

**两个关键发现：**

1. **本页右栏早就是响应式的**：`.video-creation-workspace { grid-template-columns: minmax(0,1fr) clamp(220px,18vw,300px) }` + 一条 `@media (max-width:1320px)` 兜底（`styles.css:4481 / 4722`）。也就是说"列宽用 clamp、结构断点用 media query"这套已经是仓库里的既定约定——只有左侧「片段」栏是漏网的写死值。
2. **Tailwind 是静态预编译**（`workspace-tailwind.css` 是单行压缩产物）。新加一个 `w-[clamp(...)]` 这类没用过的任意值类**会静默失效**。所以响应式宽度必须写进 `styles.css`，正好和上面第 1 点的约定一致。
3. `#promptsNarrativePanel` 目前**没有任何 `styles.css` 规则**（纯 Tailwind 类驱动）。新增一条是干净的"第一条"，不存在补丁叠补丁。

---

## 2. 行业成熟做法（已查证）

主流现代响应式列宽，标准做法是 **`clamp(最小值, 视口比例, 最大值)`**，一行顶替一堆只为调尺寸的 media query：

- 典型范式 `width: clamp(200px, 25vw, 300px)`：小屏不塌、大屏不无限胀、中间随窗口平滑变。
- 浏览器支持齐全（Chrome 79+ / Firefox 75+ / Safari 13.1+ / Edge 79+）。
- 业界共识：**尺寸缩放用 `clamp()`，需要"换布局结构"时才上 media query**。本页右栏正是这么做的，左栏照抄即可。

来源见文末。

---

## 3. 方案（3 处改动，单源、不叠补丁）

设计原则：尺寸值集中到 `styles.css`，HTML 只留语义/布局类；每个方向的间距只保留一个来源。

**改动 1 — `workspace.html:1047`**：从 class 列表里去掉 `w-[420px]` 和 `p-12`（保留 `overflow-hidden flex flex-col gap-10 bg-transparent border-r border-outline-variant/10 shrink-0`）。宽度与内边距交给 CSS。

**改动 2 — `styles.css` 新增一条规则**（紧挨现有 prompts 区块，约 4347 行后）：

```css
#promptsNarrativePanel {
  width: clamp(248px, 22vw, 296px); /* 原 420px 写死 → 顶值 ≈ -30%，随窗口平滑收放 */
  padding: 44px 14px 44px 28px;     /* 原 p-12 四边 48；右内边距 48 → 14 */
}
```

**改动 3 — `styles.css:4350` 收紧滚动容器右内边距**，并删掉 HTML 里冗余的 `pr-2`（`workspace.html:1054`），让右间距只剩一个来源：

```css
#vpStoryboardFrames {
  padding-left: 4px;
  padding-right: 6px;  /* 原 12px；保留 ≥4px 是给选中态 ring-2 留余量，否则被 overflow-x:hidden 切掉 */
  overflow-x: hidden;
}
```

### 改完的目标盒模型（取 clamp 顶值 296px）

| 指标 | 现状 | 改后 | 变化 |
|---|---|---|---|
| 片段栏宽 | 420px 写死 | clamp 248–296，随窗口 | 顶值 **-30%**，且自适应 |
| 右间距（缩略图→栏边界） | ≈ 60px | 14 + 6 = **20px** | **-67%**（远超 -50% 要求）|
| 缩略图宽 | ≈ 304px | 296−28−14−4−6 ≈ **244px** | -20% |
| 左间距 | ≈ 56px | 28 + 4 = 32px | 同步收紧、视觉对称 |

---

## 4. 可调旋钮（审批时直接定数）

- **栏想再窄/更宽**：改 `clamp(248px, 22vw, 296px)` 三个数。第 3 个数 = 大屏顶宽，第 1 个 = 小屏地板，中间 `22vw` 控收放速度。
- **想让缩略图本身也正好 -30%（≈213px）**：把 clamp 顶值降到 ~270，或左/右内边距再加。
- **右间距还想更贴边**：把改动 2 里的右内边距 `14` 往下调（`6` 那层是 ring 余量，别动）。

---

## 5. 风险 & 验证清单

- ✅ **选中态 ring 不被切**：`#vpStoryboardFrames` 左右各保留 ≥4px，覆盖 `ring-2` 的 2px 外扩。
- ✅ **标题对齐**：标题块是栏的直接子元素，跟栏左内边距（28）走，和缩略图保持左对齐。
- ✅ **不踩 Tailwind 静态编译坑**：尺寸值写在 `styles.css`，不新增任意值类（与右栏 `.video-creation-workspace` 同款做法）。
- ✅ **`shrink-0` 保留**：clamp 已带上下限，flex 不会再把它压扁。
- ✅ **单源**：去掉 `w-[420px]`/`p-12`/`pr-2`，每个方向只剩一个尺寸来源——非补丁叠补丁。
- ⚠️ **缓存版本**：改了 `workspace.html` + `styles.css`，按前端版本号制度 bump `styles.css` 版本号，改完跑 `npm run verify:frontend`。
- 验证：1280 / 1440 / 1680 三档窗口各看一眼——栏宽随窗口变、右间距收窄、选中 ring 完整、标题与缩略图对齐。
- （可选）若希望左栏在窄屏和右栏同步"台阶式"收一档，可在现有 `@media (max-width:1320px)` 里给 `#promptsNarrativePanel` 加一行 `width`。clamp 已能平滑处理，非必须。

## 6. 影响面

只动「视频创作」页左栏。无共享 resolver、无字段口径、不碰 `#profileSidebar` 等其他固定栏。回滚 = 还原这 3 处。

---

## 来源

- [clamp() — CSS-Tricks Almanac](https://css-tricks.com/almanac/functions/c/clamp/)
- [Media queries — web.dev](https://web.dev/learn/design/media-queries)
- [Layout Size Clamp Guide (width/height responsive)](https://clampgenerator.com/guides/layout-size-width-height-css-clamp/)
- 仓库内既有范例：`styles.css:4481` `.video-creation-workspace` 的 `clamp(220px,18vw,300px)`
