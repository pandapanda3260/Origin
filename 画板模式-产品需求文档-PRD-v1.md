# 画板模式（受约束流程图）产品需求文档 PRD v1

> 范围：把 origin 中段"镜头设计 + 视频创作"两页升级为一块**受约束的有序流程图画板**，承载 参考图 → 镜头计划 → 分镜首帧 → 视频片段 的全流程。剧本/风格/资产保留流水线（在画板之前），剪辑独立成页（在画板之后）。
> 原则：效果优先 / 稳定性优先 / 可维护性优先 / 根因修复优先；不接受表面补丁；前端先行、后端跟进，但**数据模型先定义清楚再两端对齐**。
> 本 PRD 所有"现状"均扣过真实代码（带文件路径+行号），不靠推断。落地由 Codex 执行、我审查验收。

---

## 0. 两个已确认的根本决策（Vasily 拍板）

1. **片段-镜头-视频基数**：`片段(segment) = 1 段最终视频`，内含**多个镜头**，**每个镜头一行、行内多张图 = 该镜头首帧的多个候选**（最右 = 选用）；片段级 1 张尾帧、1 段最终视频，用"首帧 + 多参"把片段内各镜头首帧合成该片段的 1 段视频。
   → 后端要从当前"**合并片段只有一张段首首帧**"扩成"**片段内每个镜头各一张首帧（含候选）**"。这是本次唯一必须的后端数据模型演进，详见 §3。
2. **局部修改 V1 不做**：图片局部编辑能力当前未落地（实测 gpt-image-2 的 mask 不做区域重绘，方案 v2 仍在排查，大概率换 Flux Fill/Bria）。画板 V1 只做"**改提示词重生 → 右侧加新卡**"；局部修改等能力就绪后，用**完全相同**的"右侧加新卡 + 最右=选用"语义无缝接入，不为它预留特殊结构。

---

## 1. 总体产品形态与信息架构

### 1.1 形态：受约束的有序流程图（不是自由画布、不是节点连线 DAG）

画板是一块**固定拓扑、自动连线、对齐锁定**的横向流程图（参考飞书文档内嵌流程图的"每个模块指引下一环节"，但更收窄）：

```
[参考图节点] ──→ [镜头计划节点] ──┬──→ [片段1：镜头网格] ──→ [片段1：视频区]
                                  ├──→ [片段2：镜头网格] ──→ [片段2：视频区]
                                  └──→ [片段3：镜头网格] ──→ [片段3：视频区]
```

**明确不做**（对齐 Vasily 的取舍）：
- ❌ 自由无限画布、节点任意摆放：分镜区图片**必须横纵对齐**，位置由布局引擎算，用户不能乱拖（只能在"同一镜头行内"拖候选）。
- ❌ 用户自己连线（LibTV/Drawflow/ComfyUI 式 DAG）：连线由拓扑**自动生成**，用户不画线。
- ❌ 给用户开放模型/参数自由编排：在我约定的框架内一步步走。

画板的定位（Vasily 原话）：**让复杂的页面和生成流程更容易被理解、并集中在一起展示**。它是"把一长串向导页压成一张可缩放的流程图"，不是创作沙盒。

### 1.2 四个核心节点 + 一个出口

| 节点 | 对应设计稿 | 承载内容 | 取代现有 |
|---|---|---|---|
| ① 参考图 | 图2/7/8 | 角色/场景/道具参考图（来自资产页产物，只读导入）+ 触发"生成镜头计划" | 资产页产物的入口视图 |
| ② 镜头计划 | 图9 + 弹窗图10/15 | Shot-Plan 卡（3 步闸门）+ "打开脚本节点"→镜头计划弹窗（增删改镜头、每镜头参数下拉） | shots.js 镜头表 |
| ③ 分镜首帧 | 图3/11/12 | 片段-镜头网格；每镜头一行首帧候选；每片段"一键全部生成"；**主流程默认无尾帧**（首尾帧过渡退高级菜单） | storyboard.js 分镜图工作区 |
| ④ 视频片段 | 图4/13 | 每片段视频多候选；Radio 单选最终视频；"生成新视频" | videoPrompts.js + videoTasks.js |
| 出口 | 右上角 | "确认视频，进入下一步"→ 选中视频导入剪辑页 | 现有 import-to-edit 链路 |

### 1.3 与前后阶段的边界

- **画板之前**：剧本 → 风格 → 资产 三页保留流水线（不动）。资产页产出角色/场景/道具参考图，画板①节点**只读导入**这些资产；若要改资产，回资产页改（画板不承担资产生成/编辑）。
- **画板之后**：剪辑页 `edit.js`（223KB，自带 EDL/langgraph/VevDemo SDK）保持独立，不动。画板出口走现有 `import-to-edit` 把选中视频铺进剪辑时间线。

---

## 2. 技术选型与渲染架构（前端）

### 2.1 选型结论：自建 transform 视口 + 绝对定位 HTML 节点 + SVG 连线层

现状前端 = 原生 ESM 模块 + import map 单源，无框架、无构建期组件、无任何画布基建（前轮扫描坐实：`canvas` 命中全是像素装饰，零自由布局/拖拽/缩放/连线）。

行业对照后**否决三类现成库**，选**自建**：
- ❌ **Drawflow**（vanilla 节点编辑器）：为"用户自由连线 + 库自带节点 DOM 模型"设计，正好是 Vasily 否决的范式；且会和 origin 复杂卡片 DOM（图片卡/视频卡/下拉/进度）打架。
- ❌ **React Flow / xyflow / JointJS / JsPlumb**：绑 React 或重型，origin 无 React，引入框架 = 比画板本身更大的 blast radius。
- ❌ **Konva / canvas 渲染**：画布渲染会丢掉 DOM 卡片（要复用现有大量 HTML 卡片组件 + 事件），不可接受。
- ✅ **自建**：一个 `world` 容器用 CSS `transform: translate() scale()` 做平移缩放（屏幕坐标↔画板坐标双系统），节点是**绝对定位的 HTML**（复用现有卡片渲染），连线是覆盖在上方的 **SVG 贝塞尔层**（按拓扑自动画）。这正是 React Flow 底层套路，只是纯 vanilla、且拓扑固定不让用户连线 —— 既要效果又最可控，符合"受约束"诉求。

### 2.2 新模块边界（避免补丁上打补丁）

新建 `public/modules/board.js`（画板壳 + 流程编排 + 视口/连线/缩放），**接管**中段页面级编排；**复用**底层成熟子件，不重写它们：

| 复用（不重写） | 来源 | 用途 |
|---|---|---|
| 下拉三件套 `_buildSelectOptions` / `_shotFieldCurrent` / `_applyShotFieldValue`（已 export） | shots.js:526/595/616 | 镜头计划弹窗参数下拉（图15） |
| 镜头参数枚举 | shotSchema.js | 下拉取值 |
| 首帧卡渲染 / 单组生成 `generateStoryboardSheet(gIdx)` | storyboard.js:7594 | 分镜首帧卡 + 每片段生成 |
| 尾帧建议判定 `tailFrameGenerationIntentForGroup` 等 | frameRecommendations.js:66-295 | 尾帧"建议但不自动" |
| 视频卡 / 批次 / set-current `_markGroupVideoCurrent` | videoTasks.js | 视频候选 + 选中 |
| 视频历史 `getVideoCreationHistoryForGroup` | lib/video-creation/history.ts | 片段视频多候选 |
| 导入剪辑 `importVideoGroupToEdit` | lib/video-creation/import-to-edit.ts:114 | 出口 |
| 四类进度 ETA（见 §5.5） | shots/storyboard/videoPrompts/videoTasks | 进度监控落位 |

**退役**：`shots.js`、`videoPrompts.js` 的**页面级编排**在画板达到对等后退役；`storyboard.js`/`videoTasks.js` 的**渲染/生成子函数**抽出复用、页面级壳退役。像当年退役 images/batch 页一样，**画板达对等后才摘旧页**，期间旧页可兜底。

### 2.3 视口能力（图14 功能区对应实现）

- 平移：拖空白处 / 抓手工具 / 滚轮（trackpad 双指）。
- 缩放：滚轮+修饰键 / 右下角 ±；缩放围绕光标锚点（屏幕点↔画板点不变）。
- 撤销/恢复：画板**结构性操作**（候选拖序、删/插镜头、选中切换）入 undo 栈；生成类不可撤销（已扣费）。
- 菜单：缩放至 100% / 全览(fit) / 缩放到选中。
- 性能：节点用视口裁剪（只渲染可视 + 缓冲区），大项目（>50 片段）避免全量重排；沿用全局 `scroll_anchor_guard` 的思路防跳变。

---

## 3. 数据模型（现状 → 目标）

### 3.1 现状（扣代码）

`project.data_json` 整体透传写盘（`projects-db.ts:73,910`，**加字段零迁移、零 schema 校验**）。关键数组：

- `project.shots[]`：镜头，字段权威 builder = `lib/shot-plan-normalize.ts:178-230`（idx/duration/pace/shotType/angle/lens/focus/light/composition/camera/visual/dialogue/audio/emotion/intensity/characters/tailFrameSignals…）。
- `project.storyboards[]`：**片段(group)**，`{ idx, shotIndices[], firstFrame{currentUrl,history[]≤20}, frames{first,tail}, tailFrameHistory[], videoPrompt, videoUrl, videoTaskId, videoIsCurrent, importedToEdit }`。
- `project.videoTasks[]`：每片段当前视频任务（单选中）。
- DB `video_tasks` 表：每 `group_idx` **多行历史**（已是视频多候选底座）。

**关键差距**：当前一个 `storyboards[group]` 只有**一张段首首帧**（合并段语义）；首帧多候选只在 `firstFrame.history[]`（语义是"含失败/归档的纵向留痕"，非用户策展的候选）。

### 3.2 目标数据模型（支撑 §0 决策1）

在 `storyboards[group]` 内引入**片段内每镜头一张首帧 + 候选有序列表**（migration-free，老项目不迁移）：

```
storyboards[groupIdx] = {
  idx, shotIndices: [s0, s1, ...],        // 片段含哪些镜头（已存在）
  shotFrames: {                            // 【新】按镜头存首帧候选
    [shotIdx]: {
      candidates: [                        // 【新】有序候选，最右=末位=选用
        { url, source:'gen'|'edit'|'upload', prompt, at, status, pinned? }
      ],
      activeIndex: <int>                    // 默认 = candidates.length-1（最右）；显式拖动/选择可改
    }
  },
  tail: { url, status, source, history[] },// 片段级 1 张尾帧（沿用现 frames.tail/tailFrameHistory）
  video: {                                 // 片段级最终视频（沿用现 videoUrl/videoTaskId/videoIsCurrent/importedToEdit）
    currentTaskId, currentUrl, isCurrent, importedToEdit
  }
}
```

设计要点：
- **"最右 = 选用"**：`activeIndex` 默认指向末位；用户拖动重排或在卡上显式选择会更新 `activeIndex`。下游（生视频）取每镜头 `candidates[activeIndex].url`。
- **候选来源统一**：生成 / 改提示词重生 / （未来）局部修改 → 一律 `candidates.push(右侧)`；与现有 `firstFrame.history` 的"含失败留痕"分开（候选只收成功图；失败仍走现有错误态，不进候选）。
- **写盘走窄写入，不整包 PUT**：候选增删/重排/选中用**专用动作端点**（参考视频侧 set-current 避免整包覆盖的教训 `videoTasks.js:1649`、镜头计划弹窗方案的 423 互斥闸），规避 TOCTOU/409 丢改动。
- **稳定镜头身份**：启用仓内已存在但未填充的 `shotUid`（`lib/asset-library.ts` 已有 `shot_uid` 列 + uid↔idx 重连），替代当前"按数组位置重排 `shot.id`"的 3 处死写法（shots.js:1599、main.js:7468-7471/7482-7485）。`shotFrames` 用 `shotUid` 索引而非易变的 idx，根治串位/复活。（与《镜头计划编辑器》方案 D3/D4 同源，复用其结论。）

### 3.3 片段→1 段视频的生成（首帧+多参）

后端已天然偏向这条路：`first_frame_multi_ref` 是 payload 一等公民、默认开、**合并段恒走多参**（`lib/video-payload-decision.ts:226-228`），参考图上限 9（`lib/video-reference-manifest.ts:6`）。目标：**片段内首镜头 `activeIndex` 首帧 = 起始帧（role:first_frame），其余镜头 activeIndex 首帧 = 参考图（role:reference_image）**，喂 Seedance 出该片段 1 段视频。
> 此条是后端跟进项；前端先按此模型铺 UI（每镜头首帧槽 + 片段视频区），后端把"段首单帧"扩成"按镜头取 activeIndex 帧序列"。

---

## 4. 逐节点 PRD

### 4.1 参考图节点（图2/7/8）

- **初始态（图7）**：画板只显示一个 `点击导入参考图 →` 按钮（黑底胶片图标）。
- **导入后（图2/8）**：出现虚线"参考图"框，分组列出 角色/场景/道具（名称 + 主图 + 该资产的参考内容堆叠卡 + "参考内容 +"）；这些**只读引用资产页产物**（角色/场景/道具来自 assets，跨项目角色来自全局自定义库）。右侧出现蓝色 `生成镜头计划` 按钮。
- **交互**：点 `生成镜头计划` → 触发现有 shots 执行器（batchType=`shots`）→ 进入②。生成中此节点头部显示镜头计划进度（§5.5）。
- **拍板**：参考图节点不做资产增删改（回资产页改）；"参考内容 +"= 给某资产补参考图，复用资产页能力的轻量入口（V1 可先只读，补充入口列为 P2）。

### 4.2 镜头计划节点（图9）+ 镜头计划弹窗（图10/15）

#### 节点卡（图9）
- 卡面：标题"镜头计划 Shot-Plan" + 三步闸门进度（① 确认镜头 → ② 准备资产 → ③ 合成提示词）+ `打开脚本节点 →` 按钮。三步态来自现有审批位/一致性闸门。
- 点 `打开脚本节点` → 弹出镜头计划弹窗（图10）。

#### 弹窗（图10 + 图15 参数）—— 对齐已有方案，避免重复造
**已有落地方案** `镜头计划编辑器-修改镜头计划弹窗-落地方案.md`（D1–D6，待审批未落地）就是这块的权威设计，本 PRD **直接采纳并叠加图15参数**：
- 形态（D1）：表格式**就地编辑 + 即时保存**（blur 即走 `_applyShotFieldValue→markStale→saveProject`），**否决**草稿/确认两段式。
- 每行 = 一个镜头；列 = 序号(只读) / 时长 / 画面描述(textarea) / 景别 / 光影 / 对白(textarea) / 音效(textarea) / 运镜 / **最终提示词(只读，取 `storyboards[idx].videoPrompt`，无则"未生成")** / 行操作(上移/下移/删除/下方插入)。
- **图15 参数并入**：把分镜板那排下拉（时长/节奏/景别/运镜/角度/焦距/景深/光线/构图）做成**每个镜头行的可展开参数区**，复用现成下拉组件 `_buildSelectOptions` + 取值/写入三件套（全已 export），取值源 `shotSchema.js`（SHOT_TYPES/ANGLES/LENSES/FOCUS_OPTIONS/LIGHT_PRESETS/COMPOSITION_PRESETS/CAMERA_MOVES + shots.js 的 SHOT_PACE_OPTIONS）。
  - **UI 建议（回答 Vasily "不知道怎么设计好看"）**：每行默认只显示高频 4 项（时长/景别/运镜/光线）为紧凑 chip 下拉；行尾 `▸ 更多参数` 展开第二排（节奏/角度/焦距/景深/构图），与现有"◁◁◁ 收起"一致的展开/收起范式（图15 底部已有此控件）。chip 用浅底圆角、label+值同行、hover 显完整值，避免一排九个下拉撑爆行宽。
- 增删改：全部复用现有 delete-shot / addShot / `_syncSingleShotSlots*` 链路；删除已有首帧/视频/进剪辑的镜头时弹**消费提示型 confirm**（披露后果不硬拦，符合 Vasily"不硬拦用户主动行为"）。
- 重排：V1 相邻上移/下移（弹窗内）；画板分镜区的"行内候选拖动"是另一回事（§4.3）。
- 后端：几乎零新接口（走通用 `PUT /api/projects/[id]` + If-Match）；唯一新增 = PUT 层"结构变更 vs 活跃批次"互斥守卫，命中返 **423**（避免边生成边改结构）。
- **前置硬约束**：该方案 Phase 1 安全闸（稳定 shotUid + executor 写回身份守卫 + 423 互斥）**必须先于** UI，否则增删镜头会串位/复活。本 PRD 把它并入画板③④的后端前置。
- 顶部"1/3 完成后可批量生视频"、底部"→ 下一步：准备资产"沿用。

### 4.3 分镜首帧区域（图3/11/12）

#### 结构（图11）：片段-镜头网格
- 镜头计划生成后，每个**片段**展开为一列纵向镜头行：`镜头1 / 镜头2 / … / 镜头x（增加镜头/分镜图，可选）`，行尾片段级"片段尾帧图"槽。
- **每片段一个 `一键全部生成` 按钮**（图11，放片段右侧合适位置）：生成该片段下**所有镜头**首帧；也支持逐行点卡生成；**该片段全部首帧就绪后按钮自动消失**。
  - 现状差距：现在是**全局单按钮** `btnGenAllImages`（workspace.html:900）；后端**单组生成 `generateStoryboardSheet(gIdx)` 已具备**。改造 = 前端把全局按钮拆成每片段一个 + 完成消失；并把"每片段一张段首首帧"扩成"片段内每镜头一张首帧"（§3.2/后端跟进）。

#### 每镜头行：首帧候选（图3）—— 核心交互
- 行内从左到右是该镜头首帧的**候选卡序列**；**最右 = 当前选用**（进视频生成）。
- 新增候选：①点卡"生成图片"/"上传图片"出首张；②改提示词重生 → **右侧加新卡**；③（V1 不做）局部修改重生 → 右侧加新卡。
- **行内拖动重排**：同一行候选可左右拖动；用户把想用的拖到最右即"选用"。拖动只在**本行内**（不能跨镜头、不能纵向乱放，保持对齐）。
- 数据：写 `shotFrames[shotUid].candidates[]` + `activeIndex`（§3.2），走窄写入动作端点。
- 空态卡：占位图 + `上传图片` / `生成图片` 两按钮（图11 样式）。

#### 片段尾帧（图12）：从主流程移除，退为高级菜单的"首尾帧过渡"
**决策调整（Vasily 2026-06-25，行业核验见 §6）**：主流程**不再有尾帧**这一步。
- **画板默认不展示尾帧按钮/尾帧槽**：分镜区每个片段的行尾**不再**出现"片段尾帧图"槽（图12 那个槽默认不画）。
- **系统不再主动建议"生成尾帧"**：现有"尾帧逐镜头自动续链"（storyboard.js v154，首帧 ready 即自动排尾帧）**关掉自动触发**（事件四入口 + 回页兜底扫描全部停用，不再入排程）；`tailFrameGenerationIntentForGroup` 的"建议横幅"也**不再展示**（不主动劝用户生尾帧）。`test:tail-chain` 改为断言"主流程不自动起尾帧"。
- **仅高级菜单保留「首尾帧过渡」**：左键详情面板（§5.1）的"高级/特殊镜头"区提供"首尾帧过渡"开关；用户对**特定镜头**显式开启后，才为该片段露出尾帧槽 + 走首尾帧生视频。适用：变身、转场、物体变化、明确需要 A→B 过渡的镜头。
- **后端能力暂留不删**：现有 `tail_frame_images` 执行器、`frames.tail`/`tailFrameHistory` 字段、首尾帧 payload 分支**全部保留**，避免破坏旧数据与已有生成链路；等新候选模型（§3.2）稳定后再决定是否物理删除（列入后续待议，不在本期删）。

### 4.4 视频片段区域（图4/13）

- **粒度**：视频按**片段(group)** 生成，一个片段 = 1 段视频（合并片段把内部镜头首帧用首帧+多参合成一段）。
- **空态（图13）**：片段视频区显示 `+ 生成新视频` 卡。
- **多候选排列（图4）**：每次"生成新视频" = **另起一行**；在已有视频上改（调提示词 / 未来局部修改）= 在该视频**右侧加新卡**。候选历史来自 DB `video_tasks`（按 group 多行，已具备）。
- **选中（Radio）**：每个视频卡右上角单选；**一个片段只能选一个**。选中 = 该片段最终视频（写 `videoIsCurrent` / set-current）。
- **生成中**：卡显播放占位 + 进度（§5.5 视频生成进度）。
- 失败：卡显失败态 + 重试（复用现有失败横幅/重试）。

---

## 5. 通用交互层

### 5.1 左键点击卡片 → 详情/参考编辑面板（图5）

左键分镜卡或视频卡 → 展开详情面板。面板 = **图片预览 + 生视频参考/提示词编辑区**（现有 videoPrompts 的"全能参考"编辑能力是其内核）。
- **Origin 真实支持、保留**：全能参考/图片参考输入；参考图（角色库/资产，≤9）；提示词编辑（含 AI 改写指令）；时长/画幅/分辨率等 Seedance 参数；运镜。（"首尾帧"输入移到高级区，见下）
- **图5 顶部工具条按钮的取舍（拍板）**：那条"720全景 / 多角度 / 打光 / 九宫格 / 高清 / 宫格切分"大量是 **LibTV 能力，Origin 没有**。V1：
  - 保留 Origin 已有：高清（若已接）、宫格切分（六视图/分格相关，若复用）、下载/全屏。
  - **标灰/移除**：720全景、多角度、打光（这些属维度7"可控性工具"，单独立项，不在画板范围）。
- **拍板（模式暴露）**：主路径"首帧+多参"对用户无感，面板**默认不暴露**"文生/图生/首尾帧"模式单选（现状主线本就不暴露、后端 `resolveVideoPayloadDecision` 自动决策）。**唯一例外**：面板内设"高级 / 特殊镜头"折叠区，提供 **「首尾帧过渡」** 开关（§4.3）；仅供变身 / 转场 / 物体变化 / 明确 A→B 过渡的镜头显式启用，启用后才为该片段露出尾帧槽并走首尾帧 payload。其余模式一律不暴露。

### 5.2 右键点击卡片 → 上下文菜单（图6）

设计稿图6 是 **LibTV 的菜单**，Origin 要给**与自身能力匹配的子集**（拍板）：
- **保留**：保存到我的资产、复制图片、创建副本（= 复制为新候选卡）、删除（候选/视频）、复制到剪贴板、复制 TaskId、（视频）合规校验提示（若有）。
- **去掉/标future**：创建主体/主体库（Origin 无模型原生主体库，属维度5，未做）、进入全景预览（无）、优化工作流布局（自由画布概念，不符受约束定位）、复制节点/粘贴节点（不让用户拼图，去掉）。

### 5.3 右下角功能区（图14）

固定浮层：`撤销 / 恢复 | 抓手(拖动画布) | − 缩小 / 比例% / + 放大 | ?帮助`；比例点击出菜单：缩放至 100% / 全览 / 缩放到选中（§2.3）。

### 5.4 右上角"确认视频，进入下一步"

- 点击 → 把**所有片段已选中(current)** 的视频走现有 `importVideoGroupToEdit`（`import-to-edit.ts:114`）批量导入剪辑：置 `importedToEdit=true` + 往 `edl.timeline` push（按 groupIdx 排序）+ `edl.version+1` → 跳剪辑页走正常自动铺轨/成片逻辑。
- **拍板（导入时机）**：Radio 选中只标记"该片段最终视频(current)"，**不即时导入**；**显式点"确认视频，进入下一步"才批量导入**（避免每次选都写时间线）。若某片段未选视频 → 该按钮提示"片段 N 还没选定视频"，不硬拦其余（可只导已选）。
  - 注：现状 set-current 与 import-to-edit 是两个独立 API；画板把"确认下一步"实现为"对所有 current 片段批量 import"，复用现成字段与铺轨逻辑，不新造引擎。

### 5.5 进度监控落位（保留四类，复用现有 ETA）

四类进度**全部保留**，从旧页头迁到画板对应节点头部 + 一个全局状态条；**复用现有实现**（统一"吞吐ETA + snapshot.createdAt 跨刷新锚定 + 单调钳制"，`_fmtMinSec` 各模块自持勿合并）：

| 类别 | 落位 | 现有实现 |
|---|---|---|
| 镜头计划 | ②节点头 | `_setShotsProgress` shots.js:1081 / `_shotsEtaSuffix` :1047（历史中位数估时） |
| 关键帧/首帧 | ③每片段头 | `_showKeyframeHeaderProgress` storyboard.js:135（"生成中… 5/9，约剩 x分x秒"） |
| 视频提示词 | ②→③过渡 / 面板 | `_syncVideoPromptsHeaderHint` videoPrompts.js:210 / `_promptEtaSuffix` :1847 |
| 视频生成 | ④每片段头 | `_batchTaskProgress` / `_batchRemainingText` videoTasks.js:1610/1619 |

文案沿用：待生成 0/9 → 生成中 5/9 约剩 x分x秒 → 生成完成 8/8。

---

## 6. 视频生成策略（收口"首帧+多参"为主路径）

**行业依据（2026-06 核验）**：主流模型都把"首帧 / 参考图 + 运动提示词"作为主路径，start/end frame 是专门的转场 / morph 能力——Runway Gen-4 输入图即输出视频首帧、参考图保角色一致；Google Veo 3.1（2026-01 更新）"Ingredients to Video"支持最多 4 张参考图保一致；Luma Ray3.14 与 Kling 的 start-end frame 官方定位都是"两张相似图做精确过渡"。故 origin 短剧主流程收口到"首帧+多参"，首尾帧退为特殊镜头能力。

- **首帧硬前置**：无首帧直接 hardFail（`video-payload-decision.ts:215`）。
- **主路径 = first_frame_multi_ref**：首镜头首帧 role:first_frame，其余镜头首帧 role:reference_image，≤9 张（manifest budget）。合并段已恒走此路。
- **首尾帧 = 退出主流程、仅高级触发**：主流程**默认不走**首尾帧；只有用户在高级区对特定镜头开"首尾帧过渡"才走（§4.3/§5.1）。改 `resolveVideoPayloadDecision`：auto 分支**不再因尾帧 ready 就走首尾帧**，默认收口到 `reference_images`（首帧+多参）；首尾帧仅当高级开关把 `submitMode` 显式置为 `first_last_frame` 时走。**后端 `tail_frame_images` 链路与首尾帧 payload 分支全部保留不删**（避免破坏旧数据与既有链路），等新候选模型稳定后再议是否物理删除。
- **文生视频**：工作流主线本就无纯 text2video 路径，"淘汰"是伪命题，无需动。
- toolbox（首页自由生成工具箱）是**另一套**，与画板无关，不要混改。

---

## 7. 死代码 / 已废弃逻辑清理清单（Vasily 要求注掉无用逻辑）

| 项 | 位置 | 处理 |
|---|---|---|
| 旧版多镜头分镜归档 `legacyStoryboardArchive` 全套 | project.js:89-199 / shots.js:308-318 / navLegacyStoryboardArchive | 画板不继承，注掉/移除（老项目迁移残留） |
| `images` 页空壳 | workspace.html:1019 `#pageImages` | 并入画板后移除 |
| `batch` 片段页（已 hidden retired） | navBatch / #pageBatch | 并入画板后移除 |
| 全局单按钮 `btnGenAllImages` | workspace.html:900 | 拆成每片段按钮后移除 |
| 字幕系统残留 | subtitle_format.js 孤立函数 | 已拆链路，清孤儿 |
| `legacy_pencil` 旧铅笔稿模式 | frameRecommendations.js:149 等 | 新流程用 multi_ref_v1/structured_v1，清判定分支 |
| 按位置重排 `shot.id` 三处 | shots.js:1599 / main.js:7468-7485 | 用 shotUid 取代（§3.2） |
| addShot 塞的非 schema 字段 | main.js:7462-7466（imageUrl/videoStatus 等） | 被 storyboard 体系取代，清理 |
| 各 deprecated no-op | project.js:540-542 等 | 清理 |
| reference-site/modules/* 死副本 | reference-site/ | 勿当活代码（活文件在 public/modules/） |

> 原则：清理**只针对画板范围内**确认无用的逻辑，不做无关重写。

---

## 8. 实施路线（前端先行 → 后端跟进 + 必要重构）

每期可独立验证；前端先按目标视图模型铺，后端逐期补齐数据真值。遵循前端版本制度（import map 单源、bump 条目、`verify:frontend`）。

| 期 | 内容 | 前端 | 后端 | 产出 |
|---|---|---|---|---|
| **P0** | 本 PRD → 你审 → 我出文件级落地清单（模块边界/版本/测试锁） | — | — | 落地清单 |
| **P1 画布骨架** | 新建 board.js：transform 视口 + SVG 自动连线 + 四节点壳 + 平移缩放 + 功能区(图14)；按**现有**数据**只读投影**渲染（参考图/镜头计划/分镜/视频），与旧页并存 | 大 | 无 | 可缩放流程图能看 |
| **P2 镜头计划弹窗** | 落《镜头计划编辑器》方案：先 Phase1 安全闸（shotUid + 写回守卫 + 423 互斥），再弹窗 UI + 图15 参数行 | 中 | 中（安全闸） | 增删改镜头稳态 |
| **P3 首帧候选模型** | `shotFrames[shotUid].candidates[]+activeIndex`；行内多候选卡 + 拖序 + 取最右 + 改提示词重生加卡；每片段"一键全部生成"+完成消失；尾帧改"只建议" | 大 | 中（候选窄写入端点 + 片段内每镜头首帧 + 尾帧自动→建议） | 分镜区达目标态 |
| **P4 视频 + 出口** | 视频多候选行 + Radio 单选 + 生成新视频；首帧+多参收口；右上角"确认下一步"批量导入剪辑；四类进度落位 | 中 | 中（多参 payload 收口；set-current/import 串联） | 全链路打通 |
| **P5 收尾** | 左键面板(图5 取舍)/右键菜单(图6 子集)；死代码清理；退役 shots/videoPrompts/storyboard/videoTasks 旧页壳；性能(视口裁剪) | 中 | 小 | 旧页退役、上线 |

**必要重构（best-effect，非补丁）**：
- 首帧从"段首单帧 + history 留痕"重构为"按镜头候选数组 + activeIndex"（根因修复"多候选/取最右"，不在 history 上打补丁）。
- 镜头身份从"位置重排 id"重构为 shotUid（根治串位）。
- 三处"设为当前"语义（首帧候选 / 视频 set-current / 尾帧）统一为**显式 set-current 窄动作**，不整包 PUT。
- 中段页面级编排从 4 个巨型模块（storyboard 406KB/videoTasks 201KB/videoPrompts 114KB/shots 65KB）**抽编排到 board.js**，旧模块降级为可复用子件库。

---

## 9. 已替你拍板 + 仍需你点头的开放项

**已拍板（如无异议即按此落地）**：
1. 技术=自建 transform 视口 + HTML 节点 + SVG 自动连线（非 Drawflow/React Flow/canvas）。
2. 受约束固定拓扑、自动连线、对齐锁定；候选只在行内拖。
3. 首帧候选用新 `shotFrames.candidates[]`，最右=选用，migration-free。
4. 视频 Radio 只标记 current，**显式"确认下一步"才导入剪辑**。
5. 尾帧自动→只建议；首尾帧降级保留（不删尾帧链路）；首帧+多参为主路径、模式对用户无感。
6. 图6 右键菜单取 Origin 能力子集；图5 工具条砍掉全景/多角度/打光（维度7 另立）。
7. 参考图节点只读导入资产，资产编辑回资产页。
8. 死代码清单 §7 按范围清理。

**仍需你点头（影响中等，想确认再落地）**：
- **A. 片段边界怎么定**：片段=多镜头视频单元，那"哪些镜头归一个片段"由什么决定？建议 = 镜头计划阶段按**场景(sceneId)** 或现有合并逻辑成片段，弹窗里可调整片段归属。要不要在镜头计划弹窗加"片段分组"列？
- **B. "参考内容 +"V1 范围**：参考图节点里给每个资产补参考图，V1 只读还是给补充入口？（建议 V1 只读，补充入口 P5）
- **C. 一个片段允许几段"最终视频"**：你说"一个片段只有一个选中"，确认**最终进剪辑就是每片段 1 段**（不存在一个片段进剪辑多段）？
- **D. 撤销范围**：结构操作(拖序/删插/选中)入 undo；生成类不可撤销（已扣费）——可接受？

---

## Sources

代码（本地，行号见正文）：`public/workspace.html`、`public/modules/{board(新),shots,storyboard,videoPrompts,videoTasks,shotSchema,frameRecommendations}.js`、`lib/shot-plan-normalize.ts`、`lib/batch-executors.ts`、`lib/video-payload-decision.ts`、`lib/video-reference-manifest.ts`、`lib/video-gen.ts`、`lib/video-creation/{history,current-video,import-to-edit}.ts`、`lib/projects-db.ts`、`lib/asset-library.ts`、`lib/frame-image-plan.ts`；既有方案 `镜头计划编辑器-修改镜头计划弹窗-落地方案.md`、`SEGMENT_VIDEO_HISTORY_PLAN.md`、`docs/image-local-edit-plan.md`、`尾帧逐镜头自动续链-方案.md`。

行业资料：
- 受约束流程图/用户流交互: https://www.justinmind.com/ux-design/flowchart ，https://www.feishu.cn/hc/en-US/articles/980918978289-insert-flowcharts-and-uml-diagrams-in-docs
- vanilla 无限画布 平移缩放（CSS transform + HTML 节点 + SVG 连线）: https://www.sandromaglione.com/articles/infinite-canvas-html-with-zoom-and-pan ，https://www.steveruiz.me/posts/zoom-ui
- 节点流库对照（为何不用现成）: https://github.com/jerosoler/Drawflow ，https://reactflow.dev/ ，https://xyflow.com/
- LTX Studio（分镜板+逐卡生成参照）: https://ltx.io/studio
