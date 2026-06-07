# 首帧 URL 字段口径对齐方案（待审批）

状态：提案，待 Vasily 拍板后再动代码
日期：2026-06-02
触发：项目「项目 6/2 15:02」(proj_1780383752573) 片段 3 弹出「首帧未就绪，无法生成尾帧」。排查结论是**陈旧提示**（首帧已就绪、实测预检全部 PASS），但顺带暴露一个真实的字段口径不一致，本方案处理后者。

---

## 1. 问题陈述

「首帧图能在界面看到」和「尾帧预检认为首帧就绪」用的不是同一套字段，于是可能出现**图看得到、却报「首帧未就绪」**的错觉。

### 1.1 各消费点字段覆盖

| 消费点 | 位置 | 读取字段 | 用途 |
|---|---|---|---|
| `resolveStoryboardFirstFrameUrl` | `lib/visual-reference-state.ts:23` | `firstFrame.currentUrl` · `frames.first.url` · `firstFrameUrl` · `url` · `imageUrl` · `rawUrl`（6） | 后端通用首帧 URL 解析 |
| `checkTailFramePreflight` | `lib/visual-reference-state.ts:230` | `firstFrameUrl` · `frames.first.url` · `firstFrame.currentUrl`（3） | 尾帧预检 |
| `_canGenerateTailFrame` | `public/modules/storyboard.js:704` | `firstFrameUrl` · `frames.first.url` · `firstFrame.currentUrl`（3） | 前端尾帧按钮 gate |
| 尾帧 executor 首帧锚 | `lib/batch-executors.ts:1829` | `firstFrameUrl` · `frames.first.url` · `firstFrame.currentUrl`（3） | 实际拿首帧做锚点 |
| `_firstFrameImageUrl` | `public/modules/storyboard.js:722` | `frames.first.url` · `firstFrameUrl` · `rawUrl` · `imageUrl` · `url`（5，**缺** `firstFrame.currentUrl`） | 前端首帧图显示 |

### 1.2 三处不一致

1. **显示读 `url`/`imageUrl`/`rawUrl`，预检/gate/executor 不读** → 「图能看到却报缺首帧」（本次根因）。
2. 预检/gate/executor 读 `firstFrame.currentUrl`，显示函数不读 → 反向 gap（「预检过但显示空」，实测 0 例）。
3. 后端 `resolveStoryboardFirstFrameUrl`（6 字段）与 `checkTailFramePreflight`（3 字段）口径本身就不一致 → 后端内部两套标准。

---

## 2. 字段语义澄清（方案的关键依据）

写入点（`storyboard.js:_applyStoryboardImageFields` 583-585 / `batch-executors.ts`）表明：

- **`url` / `imageUrl` / `rawUrl`**：**任何**分镜图写入都无条件设置（`_applyStoryboardImageFields:583-585`），代表「当前分镜图」，**不保证是合格的彩色首帧**——可能是普通分镜图，也可能是手稿。
- **`firstFrameUrl` / `firstFrame.currentUrl` / `frames.first.url`**：首帧专用字段。但注意 legacy_pencil 手稿路径（`batch-executors.ts:1727-1758`）也会把 `firstFrameUrl` 写成手稿图，靠 `firstFrameMode==='legacy_pencil'` 区分。
- **唯一可靠的「合格彩色首帧」判据** = 三字段有 URL **且** `firstFrameMode ∈ {structured_v1, multi_ref_v1}`（或 `frames.first.status==='ready'` 且非 legacy_pencil）。这正是 `checkTailFramePreflight` 现有逻辑。

**结论：预检逻辑语义是对的。不一致出在 `_firstFrameImageUrl` 显示口径太宽——它把「通用分镜图」也当首帧显示。**

---

## 3. 全库影响面量化（已实跑）

扫描 `data/qd.sqlite` 全部 7 个项目、77 个分镜：

- 显示与预检口径一致：**75**
- 显示有图但预检判缺（★不一致）：**2**（均为 `firstFrameMode=null` 的普通分镜图，**不在当前项目**）
- 反向 gap（预检过但显示空）：**0**
- 当前 legacy_pencil 段：**0**

血量极小（2/77），且当前项目零命中，因此本方案是低风险整改，而非救火。

---

## 4. 方案选项与取舍

### 选项 A（推荐）：收紧显示口径，让「显示 = 预检」
把 `_firstFrameImageUrl` 改为只读 canonical 三字段（`frames.first.url || firstFrameUrl || firstFrame.currentUrl`，并补上漏掉的 `firstFrame.currentUrl`），去掉 `url`/`imageUrl`/`rawUrl` 回退。
- 优点：根治「图能看到却报缺首帧」；改动集中在前端显示一函数。
- 代价：2 段 `mode=null` 普通图首帧位会显示空（届时按提示「请先生成彩色首帧」）。

### 选项 B（可选加强）：抽共享解析器 + 旧数据回填
抽一个 `firstFrameDisplayUrl(sb)` 共享给前后端；对「有 `url` 图但无 `firstFrameUrl`」的旧数据做一次性回填/升级判定。
- 优点：最稳，彻底消除双口径，旧普通图也能被正确归类。
- 代价：工作量大，需设计回填规则与迁移脚本。

### 选项 C（不推荐）：放宽预检读 `url`/`imageUrl`/`rawUrl`
- 否决理由：这些字段可能是普通图甚至手稿，放宽会让尾帧锚在非首帧图上，正好违背预检设计初衷（代码注释明确要排除手稿锚点）。

### 选项 D（正交，治本次事故）：前端清除陈旧就绪提示
本次实际遇到的是陈旧 toast（首帧就绪后提示没刷掉）。让前端在首帧状态变 ready 后自动刷新/清除尾帧就绪提示。
- 优点：低风险，直接消除本次现象；与 A/B 不冲突，可并行。

---

## 5. 推荐

**A + D**：A 对齐「显示 = 预检」根治不一致；D 解决你这次实际撞到的陈旧提示。B 视意愿作为后续加强（若希望保留旧普通图显示，则把 A 的「置空」改为 B 的「回填」）。

不改动 `checkTailFramePreflight` / `_canGenerateTailFrame` / 尾帧 executor —— 它们语义已正确。

---

## 6. 影响面与回归点

影响文件（预计）：
- `public/modules/storyboard.js` — `_firstFrameImageUrl`（A）；尾帧就绪提示刷新逻辑（D）
- （可选 B）`lib/visual-reference-state.ts` — 抽共享 resolver / 收口 `resolveStoryboardFirstFrameUrl`

回归测试点：
- 复跑 `scripts/test-visual-reference-state.js` 现有用例。
- 新增一致性单测：同一 storyboard 下 `_firstFrameImageUrl` 有值 ⟺ `checkTailFramePreflight` 非 `missing_first_frame`。
- 手测：structured_v1 首帧段正常显示且可生成尾帧；`mode=null` 普通图段按拍板行为（置空提示 / 回填）。

---

## 7. 待你拍板的问题

1. 那 2 段 `mode=null` 普通图：**显示置空并提示「请先生成彩色首帧」**（选项 A），还是**回填升级**（选项 B）？
2. 选项 D（首帧就绪后自动清除陈旧尾帧提示）是否一起做？
3. 后端 `resolveStoryboardFirstFrameUrl` 的 6 字段口径，是否要一并收口到与预检一致？（会影响其它后端调用点，需单独评估，默认本期不动。）
