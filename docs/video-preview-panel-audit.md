# 「当前视频」预览面板（#videoResultCard）前端交互自查

> 范围：视频创作页右侧「当前视频」卡片——预览 video、播放/重新生成/历史/更多 按钮、更多菜单（下载/导入剪辑/删除）。
> 状态：仅自查 + 方向建议，未动代码。结论均扣真实代码（标 file:line）+ 行业标准对照。

## 核心判断（先看这条）

仓库里**已经有一套完整的预览播放交互**：总览页的 `_ovBindPreviewVideoUx`（main.js:2918-2930，绑 waiting/playing/canplay/pause/ended/error → 加载圈 + 播放钮同步）+ 加载遮罩 + 播放图标 SVG。
而本卡片的 `_hydrateVideoResultPlayback`（main.js:2875-2885）**只塞了 video.src，没接这套 UX**，等于把成熟实现晾在一边、自己用了个缩水版。
所以多数问题的"不叠补丁"解法是**同一个方向：把卡片预览收敛到已有的那套 helper**，而不是在卡片上再单独贴 spinner/状态补丁。

---

## P0 · 影响可用性（建议优先）

### 1. 播放按钮状态永远是"播放"，播放中不变
- **实证**：渲染固定 `play_arrow + 播放`（videoPrompts.js:1370-1371）；点击 handler 只 `video.play()/pause()`（main.js:8530-8539），**从不更新按钮、也没给卡片 video 绑 play/pause/ended**。
- **后果**：点了在播，按钮还写"播放"；想暂停不知道点哪；屏读不播报状态。
- **行业**：play/pause 是 toggle，须视觉同步 + `aria-pressed` 让屏读播报 Play↔Pause（accessible.org / deque）。
- **方向（不叠补丁）**：卡片复用 `_ovBindPreviewVideoUx` 同款事件绑定，按钮图标/文案/`aria-pressed` 跟 video 真实状态走。

### 2. 点播放后黑屏等待，无任何加载反馈
- **实证**：卡片 video 无 `poster`、无 loading 态；签名地址走 `_ovResolvePlayableVideoUrl`→`apiGet`（main.js:2838-2861）异步解析 + metadata 缓冲期间**全程无 spinner/骨架**。
- **佐证**：memory `project_overview_preview_signed_url` 记的"点了播放黑屏一阵不知道在干嘛"——**总览页已修，本卡片漏修**。
- **行业**：用户约 2 秒 buffering 即开始流失；应 skeleton / spinner / 静帧过渡，杜绝黑白屏（LogRocket、Mux）。
- **方向**：同 #1，收敛到已有 loading 遮罩；并给 video 上首帧 poster（已有 `_ovApplyPreviewPoster`，main.js:2901-2915，卡片同样没用）。

---

## P1 · 可访问性 / 交互缺口

### 3. 「更多」菜单是半残 ARIA menu（键盘不可用）
- **实证**：标了 `role="menu"`/`role="menuitem"`/`aria-haspopup`/`aria-expanded`（videoPrompts.js:1380-1386），但事件层（main.js:8503-8570）**只有鼠标 click**：无 Enter/Space 开+聚焦首项、无 ↑↓ 导航、无 Esc 关+回焦、无 Home/End、无 typeahead、开菜单不移焦。
- **后果**：声明了键盘契约却没兑现，键盘/屏读用户进不去也出不来。
- **行业**：WAI-ARIA Menu Button 明确要求上述键盘集（W3C APG）。
- **方向（二选一，别在 click 上贴补丁）**：① 补齐键盘契约；或 ② 降级为 disclosure（保留 `aria-expanded`，去掉 menu/menuitem role，当普通按钮列表）。轻量优先 ②。

### 4. 预览无 seek/时间/全屏（只有一个播放 toggle）
- **实证**：`<video playsinline preload="metadata">` 无 `controls`（videoPrompts.js:1348）。9:16 竖版挤在 ~260px 窄卡里，**拉不动进度、看不到时长、不能放大**。
- **行业**：自定义播放器最常缺 seek（应 `role="slider"`+`aria-valuetext` 报时间）。
- **方向**：最小=给原生 `controls`；或加「放大/全屏」按钮，点开复用已有总览播放器（main.js 已有完整控件那套），不另造轮子。

### 5. 键盘焦点不可见（缺 :focus-visible）
- **实证**：全仓 `:focus-visible` 覆盖 oe-vev/vtd/style-* 十余处，**唯独 `.video-result-action / .video-result-icon-action / .more-menu button` 没有**；只有 `:hover`（styles.css:4658-4662）。
- **后果**：Tab 到这些钮无焦点环 → 违反 WCAG 2.4.7，且与仓库自身约定不一致。
- **方向**：补一条与现有约定同款的 `:focus-visible` 规则（单条共享，不逐钮加）。

---

## P2 · 健壮性 / 打磨

### 6. 禁用按钮不给原因
`_disabledAttr` 置灰 play/download/delete 时无 title/说明，用户不知"为何点不动"（如未生成不能播）。方向：禁用态加一句 title。

### 7. 重生成/删除二次点击防抖待确认
handler 是 async（main.js:8541-8563），靠 re-render 翻状态，点击→`generating` 之间有窗口。`data-write-action` 经查**不是**在途 disable 守卫（全仓无消费者，疑似维护期只读用途）。**需确认** `generateVideoForGroup/deleteVideoForGroup` 是否自带 stage-inflight 守卫，否则快速双击可能双发/双扣。

### 8. 切片段时预览闪烁
切 group 重渲卡片 → video 重新 hydrate + 异步签名，首帧前可能黑底闪一下。与 #2 同源，修了 #2 即缓解。

---

## 建议优先级 & 落地方向

| 级别 | 项 | 一句话方向 |
|---|---|---|
| P0 | 1 播放状态同步 / 2 加载反馈 | **收敛到已有 `_ovBindPreviewVideoUx` + 加载遮罩 + poster**，一处统一两条都解 |
| P1 | 3 菜单键盘 | 降级 disclosure 或补齐 APG 键盘契约（二选一）|
| P1 | 4 seek/全屏 | 原生 `controls` 或「放大」复用总览播放器 |
| P1 | 5 focus-visible | 补一条共享焦点环规则 |
| P2 | 6/7/8 | 禁用原因、双击守卫确认、闪烁（随 #2 一并） |

**不叠补丁主线**：P0+P1#4 都指向"复用总览那套已成熟的预览播放 helper"，避免卡片独立维护第二套播放逻辑——这本身也消掉了现状的重复。

> 这是方向盘点，未写落地方案。你圈定要做哪几条（或调整优先级），我再按选中的项出最小改动实施方案 + 分步落地。

---

## 来源
- [Menu Button Pattern — W3C ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)
- [Accessible multimedia — MDN](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/Multimedia)
- [Video Player Accessibility Best Practices — Accessible.org](https://accessible.org/video-player-accessibility-best-practices/)
- [Accessible ARIA buttons — Deque](https://www.deque.com/blog/accessible-aria-buttons/)
- [Skeleton loading & perceived performance — LogRocket](https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/)
- 仓库内既有实现：`main.js:2918` `_ovBindPreviewVideoUx`、`main.js:2901` `_ovApplyPreviewPoster`
