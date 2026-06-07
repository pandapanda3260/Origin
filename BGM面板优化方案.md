# 剪辑工作台 · BGM 面板优化方案（v2 · 已按反馈定稿）

## 一、现状与根因

右侧面板（`#editRightPanel`，210px 宽）目前只有「转场控制 Transition」一个分区，「去除 BGM」按钮被塞在转场分区里（`workspace.html:1374`）。除此之外界面上看不到任何 BGM 信息——这正是"只有一个去除按钮"的由来。

**根因**：选曲器 `_renderBgmSelector()`（`edit.js:2651`）开头是 `var container = $("editBgmSelector"); if (!container) return;`，但 **`#editBgmSelector` 容器在 HTML 里根本不存在**。那段写好的选曲 UI（风格标签、时长/BPM、"推荐"徽标、试听、选中高亮）因为挂载点缺失，从来没渲染出来过。

要展示的数据前端都有：`_editState.edl.bgm.trackId`、`_bgmCatalogCache`、`_editState.segmentTags.suggestedBGMCategory`、`CAT_LABELS`。

## 二、定稿设计（已按你 6/3 的反馈确认）

布局：右侧面板新增「背景音乐 BGM」分区，放在转场控制**上方**。

### 1. 一个总开关 + 三态（核心）

顶部一个 BGM 开关，**默认开**，全程不打扰：

- **自动**（开 + 用户没手动选）→ 自动套用 AI 推荐风格的曲子，无需点确认。
- **手动**（开 + 用户选了某首）→ 用用户选的。
- **关**（用户关掉开关）→ 全程无 BGM，导出也无音乐。

用户一旦关掉开关、或手动改选，就以用户操作为准，之后不再自动覆盖。（去掉原先设想的"用推荐"按钮——默认就应用，省一次点击。）

### 2. 状态头部（常驻）

- 开 + 自动：`♪ <推荐曲名> · <风格> · <时长>　[自动]` + 试听 + 换曲。
- 开 + 手动：`♪ <曲名> · <风格> · <时长>　[手动]` + 试听 + 换曲。
- 关：`背景音乐已关闭` + 开关。

### 3. 选曲列表（折叠 / 下拉）

默认折叠，点"换曲"才展开下拉列表，复用现成的 `_renderBgmSelector`（推荐徽标、试听、选中高亮都已具备）。曲库变大后再升级成单独页面（你提的方向，本次先不做）。

### 4. 去掉独立"去除 BGM"按钮

开关 OFF 就等于"无 BGM"，原转场面板里那个"去除 BGM"按钮取消、合进开关。转场控制只管转场，职责更清晰。

## 三、状态怎么存（最小改动）

给 `edl.bgm` 加一个字段 `enabled`（布尔，缺省 = 开）。三态映射：

| 状态 | enabled | trackId |
|---|---|---|
| 自动 | true | 空 → 在落点处解析成推荐曲 |
| 手动 | true | 具体 id |
| 关 | false | — |

- "自动"直接**复用导出端现成的**"没选就按推荐风格自动配"逻辑（`lib/edit-export.ts` 的 `chooseBgmId`），只需让它在 `enabled:false` 时不配乐。
- 前端加 `_resolveEffectiveBgmTrackId()`：关 → null；有手动 id → 用它；否则 → 推荐风格第一首。播放、A1 轨、状态头部都用它（这样"自动"模式真能出声、能显示曲名）。

## 四、改动点与影响面

| 位置 | 改动 | 影响面 |
|---|---|---|
| `workspace.html` | 新增「背景音乐」分区（开关 + `#editBgmStatus` + 补上缺失的 `#editBgmSelector` + 折叠）；删掉转场区里的 `#btnEditClearBgm` | 纯结构，沿用 `edit-hairline-top` 等类 |
| `edit.js` | 新增 `_renderBgmStatus()`、`_resolveEffectiveBgmTrackId()`、开关 wiring；`_syncBgmPlayback` / `_renderBgmTrack` 改用解析后的 id；去掉选曲/清除的成功 toast（少打扰） | 集中在 BGM 函数 |
| `app/api/edit/timeline/route.ts` | `Edl.bgm` 加 `enabled?`；新增 `bgm-toggle` op；`bgm-select` / `bgm-offset` 保留 `enabled` 不被冲掉 | 窄，沿用现有 op 协议 |
| `lib/edit-export.ts` | `chooseBgmId`：`enabled===false` 直接返回无 BGM；其余维持现有自动配 | 一处分支 |
| `styles.css` | 开关 + 状态卡少量样式 | 可选、很小 |

不碰共享 resolver，不重构 timeline 写盘主流程；`buildEdlResult` / `set-edl` 已整体拷贝 `bgm` 对象，`enabled` 会自然带过去。

## 五、两个想先确认的默认（涉及可见行为）

1. **老项目兼容**：之前没配乐的旧项目，在新逻辑下"开关默认 = 开"会被自动配上推荐 BGM（符合你"默认开"的意图，但相当于旧项目悄悄多了背景音）。接受吗？
2. **撤销**：现在选/清 BGM 都进 Undo 栈。开关切换要不要也可撤销？（建议要，跟现有行为一致）

确认后即按此实现（含"把选曲器恢复成可用"）。
