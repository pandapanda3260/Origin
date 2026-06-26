# 画板模式（受约束流程图）产品需求文档 PRD v2（合并定版）

> 本版 = 我的 PRD v1 + Codex《画板替代镜头页/视频页落地方案》合并定稿，**取代 v1**。范围：只出方案不改代码。
> 目标：用一块**受约束的有序流程图画板**直接替代当前 `镜头设计 shots` + `视频创作 prompts` 两页，把 镜头计划 / 首帧候选 / 提示词 / 视频候选 / 最终片段选择 集中到一个顺序清晰的工作面。
> 原则：效果优先 / 稳定性优先 / 可维护性优先 / 根因修复优先；不接受表面补丁；前端先行、后端跟进；数据模型先定义清楚再两端对齐。所有"现状"均扣真实代码（带路径+行号）。落地由 Codex 执行、我审查验收。

---

## 0. 已确认的根本决策（Vasily 已拍板）

1. **片段-镜头-视频基数**：`片段(segment/group) = 1 段最终视频`，内含**多个镜头**；**每个镜头一行、行内多张图 = 该镜头首帧的多个候选**；片段级 1 张最终视频，用"首帧+多参"把片段内各镜头首帧合成。→ 后端要从"合并片段只有一张段首首帧"扩成"**片段内每个镜头各一张首帧（含候选）**"（§4）。
2. **局部修改 V1 不做**：图片局部编辑能力未落地（gpt-image-2 mask 实测不可用，方案 v2 排查中，大概率换 Flux Fill/Bria）。V1 只做"改提示词重生 → 右侧加新卡"；局部修改就绪后用**完全相同**的"右侧加新卡 + 显式选中"语义接入。
3. **尾帧退出主流程**（2026-06-25 行业核验，§7/§8）：片段尾帧从产品端移除、不主动建议；旧"首尾帧判断逻辑"删除；A→B 转场镜头改由关键帧模型"补一张结束关键帧"表达（见决策4）；后端 `tail_frame_images` 暂留不删。
4. **视频生成升级为"关键帧+参考图"模型 + 片段"20-25 秒发车"**（依赖 Seedance 2.5：2026-06-23 发布预览、约 7 月初公测；已核验原生支持 30s 单次生成 + 多关键帧 + 最多 50 路多模态参考）：每个镜头的选中首帧 = 一个**关键帧**；片段内多关键帧（按镜头时序）+ 角色/道具/场景**参考图** + 提示词 → 生成该片段 1 段视频。**删除**原【首帧+参考】【首尾帧】两套模式及其"何时用首尾帧"的判断逻辑；A→B 转场镜头改由"给该镜头补一张结束关键帧"表达。片段时长规则从"4 秒发车"改为"**20-25 秒发车**"（不低于 20、不高于 25 秒）。**本项受 Seedance 2.5 公测 GA 制约，单列「方案四」落地，不阻塞前端。**

---

## 0.5 对 Codex 版的采纳与纠正（评审结论）

**采纳（Codex 比 v1 更优或更具体的点）**：
- **路由入口复用**：画板直接接管 `workspacePage=shots` 入口，减少路由迁移成本；`prompts` 导航隐藏 + hash 重定向（§2）。v1 没具体到这层。
- **前端模块四拆**：`board.js / board_state.js / board_candidates.js / board_actions.js / shotPlanDialog.js`，比 v1 单一 board.js 更清晰（§3.2）。
- **选中态以显式 id 为数据权威、不靠 DOM 位置**：这是对 v1"最右=选用(按 activeIndex 位置)"的**关键纠正**——用 `selected*CandidateId` 当唯一真相，"拖到最右"只是设置该 id 的便捷操作（§6）。根治刷新后/增删后串位。
- **`confirmSegmentsAndEnterEdit()` 复用**：已核实存在（videoTasks.js:829，批量导入所有 current 片段→切 edit），画板"确认进剪辑"直接复用，不新写导入逻辑（§9.4）。
- **验收标准 + 风险清单**：补入 §12/§13。
- **字段→后端名映射 + 页面命名**：补入 §5.2/§2。

**纠正（Codex 的错误，按已确认结构修正）**：
- ❗ **图片候选粒度**：Codex 把 `imageCandidates` 挂在**片段(group)级**（`storyboards[groupIdx].imageCandidates`）。但 §0 已确认是"片段内**每镜头**各一张首帧"，必须挂**镜头级**：`storyboards[groupIdx].shotFrames[shotUid].candidates[]`（§4.2）。视频候选才是片段(group)级。
- ⚠️ **老数据兼容**：Codex §9 的"为老数据合成默认候选"——按 Vasily"不为老项目做兼容"的既定原则，**只允许 P1/P2 的读时投影**（ViewModel 渲染时把现有 `frames.first`/`videoTaskId` 当一个默认候选显示），**不写持久化迁移**；老项目可直接弃用（§4.3）。
- 技术选型 Codex 只说"第一期不引入 React Flow/tldraw"，v1 给了完整的自建方案与行业依据，保留 v1（§3.1）。

---

## 1. 产品形态与信息架构

### 1.1 形态：受约束的有序流程图（非自由 DAG、非无限白板）

横向固定拓扑、自动连线、对齐锁定（参考飞书文档内嵌流程图"每模块指引下一环节"，但更收窄）：

```
[参考图] ─→ [镜头计划] ─┬─→ [片段1: 镜头×首帧候选网格] ─→ [片段1: 视频候选]
                        ├─→ [片段2: 镜头×首帧候选网格] ─→ [片段2: 视频候选]
                        └─→ [片段3: 镜头×首帧候选网格] ─→ [片段3: 视频候选]
                                                              └─→ [右上角: 确认视频进入剪辑]
```

核心原则（Vasily + Codex 共识）：
- 镜头天然有顺序，布局**必须横纵对齐**；连线由拓扑**自动生成**，用户不画线。
- 用户可拖候选卡，但**不能破坏片段/镜头结构**（候选只在本镜头行内拖）。
- 图片和视频都必须有**显式选中态**（数据权威，见 §6）。
- 尾帧退出主流程，仅作高级能力（§7）。
- 旧 `shots/prompts` 页面级 UI **不再打补丁**，由新画板模块接管（§3.2）。

画板定位（Vasily 原话）：让复杂页面与生成流程**更易理解、集中展示**；它是"把一长串向导页压成一张可缩放流程图"，不是创作沙盒。

### 1.2 四区域 + 一出口

| 区域 | 设计稿 | 承载 | 取代 |
|---|---|---|---|
| ① 参考图 | 图2/7/8 | 角色/场景/道具参考图（只读引用资产页产物）+「生成镜头计划」 | 资产产物入口视图 |
| ② 镜头计划 | 图9 + 弹窗图10/15 | Shot-Plan 卡（确认镜头/准备资产/合成提示词三步）+「打开脚本节点」→深色弹窗 | shots.js 镜头表 |
| ③ 分镜首帧 | 图3/11/12 | 片段→镜头行→首帧候选；每片段「一键全部生成」；**主流程无尾帧** | storyboard.js 分镜区 |
| ④ 视频片段 | 图4/13 | 每片段视频候选；Radio 单选最终视频；「生成新视频」 | videoPrompts.js + videoTasks.js |
| 出口 | 右上角 | 「确认视频，进入下一步」→ 选中视频导入剪辑 | confirmSegmentsAndEnterEdit() |

### 1.3 边界
- **之前**：剧本→风格→资产 保留流水线（不动）；①只读引用资产产物，改资产回资产页。
- **之后**：剪辑页 `edit.js` 独立不动；出口走现有导入链路铺进剪辑时间线。

---

## 2. 入口与路由（采纳 Codex）

- 左侧导航「镜头设计」→ 改名 **「画板」**；**继续用 `workspacePage=shots` 作画板入口**（减少路由迁移）。
- `prompts` 导航**隐藏**；历史 hash 访问 `prompts` → 重定向到画板并**定位到视频区域**。
- `images`、`batch` 保持退役，不恢复入口。
- 命名：页面标题 **`画板`**；副标题 **`镜头计划、首帧、提示词与视频片段统一工作区`**。

---

## 3. 技术选型与前端模块

### 3.1 渲染选型：自建 transform 视口 + 绝对定位 HTML 节点 + SVG 连线层（保留 v1，行业依据充分）

现状前端 = 原生 ESM + import map 单源 + workspace.html + 静态 Tailwind，无框架、无画布基建。**否决现成库、选自建**：
- ❌ Drawflow（vanilla 节点编辑器）：为"用户自由连线 + 库自带节点 DOM"设计，正是被否决的范式，且与现有复杂卡片 DOM 打架。
- ❌ React Flow/xyflow/JointJS/JsPlumb：绑 React 或重型，origin 无 React，引框架 blast radius 比画板本身还大。
- ❌ Konva/canvas 渲染：会丢掉要复用的 HTML 卡片与事件。
- ✅ **自建**：`world` 容器用 CSS `transform: translate() scale()` 平移缩放（屏幕↔画板双坐标），节点是**绝对定位 HTML**（复用现有卡片渲染），连线是上层 **SVG 贝塞尔**（按拓扑自动画，用户不连）。即 React Flow 底层套路、纯 vanilla、拓扑固定。第一期不引入任何重型画布库（与 Codex 一致）。

### 3.2 模块拆分（采纳 Codex，新建独立模块、不在旧大模块堆 UI）

| 新模块 | 职责 |
|---|---|
| `public/modules/board.js` | 画板主编排、区域渲染、视口（缩放/拖动/裁剪）、节点定位、SVG 连线 |
| `public/modules/board_state.js` | 把 `project.shots/storyboards/videoTasks` 投影成画板 ViewModel（读时投影，含老数据默认候选，§4.3） |
| `public/modules/board_candidates.js` | 图片/视频候选的选中态、排序态、id 权威（§6） |
| `public/modules/board_actions.js` | 调用现有生成/重生/导入/历史替换/删除/下载能力（不重写底层） |
| `public/modules/shotPlanDialog.js` | 深色镜头计划弹窗（§5.2） |

旧模块降级为**能力层**，页面级 UI 逐步退役：
- `shots.js`：保留镜头字段更新、镜头计划生成；页面 UI 退役。
- `storyboard.js`：保留首帧生成 `generateStoryboardSheet`、首帧历史、素材面板、preflight；UI 卡让位画板。
- `videoPrompts.js`：保留提示词草稿/commit/preflight/当前视频卡能力；页面 UI 退役。
- `videoTasks.js`：保留视频生成、历史视频、`confirmSegmentsAndEnterEdit`、播放 URL 处理。

复用的已 export 子件：下拉三件套 `_buildSelectOptions/_shotFieldCurrent/_applyShotFieldValue`（shots.js:526/595/616）、参数枚举 `shotSchema.js`、首帧建议 `frameRecommendations.js`、视频历史 `getVideoCreationHistoryForGroup`（lib/video-creation/history.ts）、导入 `importVideoGroupToEdit`（lib/video-creation/import-to-edit.ts:114，被 `confirmSegmentsAndEnterEdit` 调用）。

### 3.3 视口能力（图14 功能区）
右下角浮层：撤销 / 恢复 | 抓手(拖画布) | − 缩小 / 比例% / + 放大 | ?帮助；比例菜单：缩放至 100% / 全览(fit) / 缩放到选中。缩放围绕光标锚点。撤销栈只收**结构性操作**（候选拖序/选中切换/删插镜头），生成类不可撤销（已扣费）。大项目用视口裁剪（只渲可视+缓冲），沿用 `scroll_anchor_guard` 思路防跳变。

---

## 4. 数据模型（现状 → 目标）

### 4.1 现状（扣代码）
`project.data_json` 整体透传写盘（projects-db.ts:73,910，加字段零迁移零校验）。`storyboards[groupIdx] = { idx, shotIndices[], firstFrame{currentUrl,history[]≤20}, frames{first,tail}, videoUrl, videoTaskId, videoIsCurrent, importedToEdit }`；DB `video_tasks` 表每 group 多行历史（视频多候选底座已具备）。**差距**：一个 group 只有一张段首首帧；`imageCandidates/selected*CandidateId` 全仓零命中（新增）。

### 4.2 目标数据模型（支撑 §0 决策1，含 Codex 纠正后的粒度）

```
storyboards[groupIdx] = {
  idx,
  shotIndices: [s0, s1, ...],              // 片段含哪些镜头（已存在）

  // 【新·镜头级】每个镜头各一组首帧候选 —— 纠正 Codex 的 group 级错误
  shotFrames: {
    [shotUid]: {
      candidates: [
        { id, url, source:'gen'|'edit'|'upload', prompt, createdAt, status, taskId }
      ],
      selectedImageCandidateId                // 显式选中（数据权威，非 DOM 位置）
    }
  },

  // 【新·片段级】视频候选（与 Codex 一致）
  videoCandidates: [
    { id, taskId, url, protectedUrl, prompt, createdAt, status, durationSec }
  ],
  selectedVideoCandidateId,                   // 显式选中（Radio）

  // 兼容字段保留（尾帧/旧选中仍读，但新画板以 selected* 为权威）
  frames:{first,tail}, tailFrameHistory[], videoTaskId, videoUrl, videoIsCurrent, importedToEdit
}
```

要点：
- **镜头身份用 `shotUid`**（仓内 `lib/asset-library.ts` 已有 `shot_uid` 列 + uid↔idx 重连），取代当前"按数组位置重排 `shot.id`"3 处死写法（shots.js:1599、main.js:7468-7485）。`shotFrames` 用 uid 索引，根治串位/复活。
- **写盘走窄写入动作端点**（候选增删/重排/选中），不整包 PUT；规避 TOCTOU/409 丢改动（参考视频 set-current 经验 videoTasks.js:1649）。
- 视频候选源用 DB `video_tasks` 历史（已多行），无需重存。

### 4.3 老数据：读时投影，不做迁移（纠正 Codex）
- **允许**：P1/P2 的 ViewModel 渲染时，若无 `shotFrames`/`videoCandidates`，用现有 `frames.first`/`firstFrame.currentUrl` 与 `videoTaskId`/`videoTasks[groupIdx]` **读时合成一个默认候选**显示（让画板能渲染过渡期项目）。
- **不允许**：写持久化迁移 / 长期兼容 shim。按 Vasily 既定原则，老项目可直接弃用。P3 引入新模型后，新项目一律走新结构。

### 4.4 片段→1 段视频（首帧+多参，后端跟进）
后端已偏向此路（first_frame_multi_ref 默认开、合并段恒走多参，video-payload-decision.ts:226-228，参考图 ≤9 video-reference-manifest.ts:6）。目标：片段内**首镜头 selected 首帧 = 起始帧(role:first_frame)，其余镜头 selected 首帧 = 参考图(role:reference_image)**，出该片段 1 段视频。前端先铺 UI，后端把"段首单帧"扩成"按镜头取 selected 帧序列"。

---

## 5. 逐节点 PRD

### 5.1 参考图（图2/7/8）
- 初始（图7）：只显示 `点击导入参考图 →`。
- 导入后（图2/8）：虚线"参考图"框，分组列 角色/场景/道具（名称+主图+参考内容堆叠卡+"参考内容 +"）；只读引用资产产物。右侧出现蓝色 `生成镜头计划`。
- 点 `生成镜头计划` → 触发 `batchType=shots` → 进入②；生成中②头显镜头计划进度（§9.5）。
- 拍板：①不做资产增删改（回资产页）；"参考内容 +" V1 只读，补充入口列 P4。

### 5.2 镜头计划节点 + 深色弹窗（图9/10/15）
**节点卡（图9）**：标题"镜头计划 Shot-Plan" + 三步闸门（确认镜头→准备资产→合成提示词）+ `打开脚本节点 →`。
**深色弹窗（shotPlanDialog.js）**：表格式**就地编辑+即时保存**（blur 即 `_applyShotFieldValue→markStale→save`，否决草稿/确认两段式），对齐既有《镜头计划编辑器》方案 D1–D6。字段→后端名（采纳 Codex 映射）：

| 列 | 后端字段 | 形态 |
|---|---|---|
| 镜号 | idx | 只读 |
| 时长 | duration | chip 下拉 |
| 节奏 | pace | chip 下拉 |
| 画面描述 | visual | textarea |
| 景别 | shotType | chip 下拉 |
| 运镜 | camera | chip 下拉 |
| 角度 | angle | chip 下拉 |
| 焦距 | lens | chip 下拉 |
| 景深 | focus | chip 下拉 |
| 光线 | light | chip 下拉 |
| 构图 | composition | chip 下拉 |
| 对白/旁白 | dialogue | textarea |
| 音效 | audio | textarea |
| 最终提示词 | storyboards[idx].videoPrompt | **只读查看入口**，不在此编辑 |

- **图15 参数 UI（答 Vasily "不知道怎么设计好看"）**：每行默认显示高频 4 项（时长/景别/运镜/光线）紧凑 chip 下拉；行尾 `▸ 更多参数` 展开第二排（节奏/角度/焦距/景深/构图），与图15 底部"◁◁◁ 收起"同范式。chip 浅底圆角、label+值同行、hover 显全值，避免一排九下拉撑爆行宽。
- **片段分组列 + 20-25 秒发车规则**：弹窗加一列"片段分组"，镜头计划阶段按 `sceneId`/现有合并逻辑成片段，用户可在此列调整某镜头的片段归属。分组规则从旧"4 秒发车 / 最短时间原则"升级为"**20-25 秒发车**"：按镜头时序累加时长，达 20-25 秒即闭合为一个片段（不低于 20、不高于 25），与 Seedance 2.5 的 30s 能力留余量（决策4/§8）。
- 支持新增/删除/插入/上下移镜头、改字段、查看提示词；删除有消费的镜头弹**披露型 confirm**（不硬拦）。
- **结构性改动受批次运行锁保护**（命中返 **423**），避免生成中改镜头致 `groupIdx` 串位（Codex/我共识，§13 #1 风险）。前置安全闸（稳定 shotUid + executor 写回身份守卫 + 423 互斥）**必须先于** UI。

### 5.3 分镜首帧（图3/11/12）
- **结构（图11）**：每片段展开为纵向镜头行 `镜头1/2/…/x`；**每片段一个 `一键全部生成`**（生成该片段所有镜头首帧；也可逐行点卡生成；**该片段全就绪后按钮自动消失**）。现状是全局单按钮 `btnGenAllImages`（workspace.html:900）+ 单组 `generateStoryboardSheet(gIdx)` 已具备 → 改为每片段一个。
- **每镜头行候选（图3）**：左→右候选卡序列；**显式选中态**（§6）。新生成/改提示词重生 → 右侧加新卡并**自动选中**；行内可左右拖（仅本行）。空态卡=占位图+`上传图片`/`生成图片`。
- **无尾帧**（§7）：行尾不画尾帧槽。

### 5.4 视频片段（图4/13）
- 粒度=片段(group)，一片段=1 段视频。空态（图13）：`+ 生成新视频`。
- 多候选（图4）：每次"生成新视频"=另起一行；基于已有视频改=同行右侧加新卡；历史来自 DB `video_tasks`。
- **Radio 单选**：每片段右上角单选，一个片段**有且仅有 1 条**选中视频 = 进剪辑时间线的最终片段。**未选中的视频不丢弃**：作为该片段可选素材进入剪辑页素材库（复用 VevDemo 素材导入链路），剪辑时可替换。生成中显播放占位+进度；失败显重试。

---

## 6. 候选选择规则（数据权威 = 显式 id，非 DOM；采纳 Codex 核心纠正）

**图片候选（镜头级）**：
- 每个镜头有一个 `selectedImageCandidateId`（权威）。
- 新生成图片**默认选中**。
- 用户切换：点卡上的选中按钮 / 把卡**拖到最右**（拖到最右 = 便捷设为选中，同时更新该 id）——"拖到最右"只是快捷排序，**不是唯一数据依据**。
- 生视频读取**显式选中的图片候选 id**，绝不读 DOM 位置（根治刷新/增删后串位）。

**视频候选（片段级）**：
- 每片段一个 `selectedVideoCandidateId`（权威）。
- 新生成视频默认选中；可从历史或当前候选切换。
- 被选中视频自动成为进剪辑的 source；`确认视频，进入下一步` 复用 `confirmSegmentsAndEnterEdit()`（§9.4）。

---

## 7. 尾帧策略（v2：退出主流程，仅高级保留）

行业核验（§8）后定调——主流程**不再有尾帧**：
- 画板**默认不展示**"增加尾帧图"按钮 / 尾帧槽（图12 槽默认不画）。
- 系统**不再自动建议**生成尾帧：关掉"尾帧逐镜头自动续链"自动触发（storyboard.js v154 四入口+回页兜底全停用、不入排程）；`tailFrameGenerationIntentForGroup` 建议横幅不再展示。`test:tail-chain` 改断言"主流程不自动起尾帧"。
- **转场/A→B 由关键帧表达，不再有独立"首尾帧模式"**：升级到"关键帧+参考图"后（决策4/§8），原"首尾帧判断逻辑"删除；需要 A→B 的特殊镜头（转场、变身、物体变化）改由左键面板"高级/特殊镜头"区"**给该镜头补一张结束关键帧**"实现，即 2 个关键帧驱动该镜头，**无需片段级尾帧**。
- **后端 `tail_frame_images` 执行器 / `frames.tail`/`tailFrameHistory` / 首尾帧 payload 分支全部保留不删**，避免破坏旧数据、历史与测试链路；等新候选模型稳定再议物理删除。

---

## 8. 视频生成策略（升级为"关键帧+参考图"，接 Seedance 2.5）

**行业依据（2026-06 核验）**：主流都以"关键帧/参考图 + 运动提示词"为主、start/end frame 只是转场专用——Runway Gen-4 输入图即首帧、参考图保一致；Veo 3.1 "Ingredients" 多参考图；Luma/Kling start-end 是"两张相似图精确过渡"。**Seedance 2.5（2026-06-23 预览、约 7 月初公测）原生支持 30s 单次生成 + 多关键帧 + 最多 50 路多模态参考**，正好直给"关键帧+参考图"。

- **目标模型 = 关键帧 + 参考图 + 提示词**（决策4）：片段内每镜头选中首帧 = 一个关键帧（按时序排列）；角色/道具/场景资产图 = 参考图；+ 提示词 → 1 段视频。关键帧表达时序/构图，参考图锁身份一致。
- **删除**原【首帧+参考】【首尾帧】两套模式与"何时用首尾帧"的判断逻辑（`video-payload-decision.ts` 的 `first_last_frame` 分支与 auto 判断在产品侧不再走）；A→B 转场镜头 = 给该镜头补一张结束关键帧（2 关键帧），不是片段尾帧。
- **关键帧硬前置**：片段至少要有可用关键帧才能生视频（沿用现 hardFail 思路，video-payload-decision.ts:215）。
- **预算**：现 `VIDEO_REFERENCE_IMAGE_BUDGET=9` 需随 Seedance 2.5（≤50）上调，并在数据/接口上**区分"关键帧"与"参考图"两类输入**（方案四细化）。
- **GA 制约**：本节落地等 Seedance 2.5 公测，单列**方案四**；前端先按"每镜头关键帧 + 资产参考"铺 UI，不空等。
- 文生视频：主线本无纯 text2video，无需动。toolbox（首页自由工具箱）另一套，不混改。

---

## 9. 通用交互层

### 9.1 左键卡片 → 详情/参考编辑面板（图5）
图片预览 + 生视频参考/提示词编辑区（videoPrompts"全能参考"内核）。保留 Origin 真实支持：全能参考/图片参考输入、参考图(≤9)、提示词编辑(含 AI 改写)、时长/画幅/分辨率/运镜。
- 图5 顶部工具条取舍：保留 Origin 已有（高清/宫格切分/下载/全屏）；**标灰/移除** 720全景/多角度/打光（属维度7，另立）。
- **模式暴露拍板**：主路径"首帧+多参"对用户无感、默认不暴露模式单选；**唯一例外**=高级/特殊镜头区的 **「首尾帧过渡」** 开关（§7）。

### 9.2 右键卡片 → 上下文菜单（图6 取 Origin 子集）
保留：保存到我的资产、复制图片、创建副本(=复制为新候选卡)、删除、复制到剪贴板、复制 TaskId、（视频）合规校验提示。
去掉/标 future：创建主体/主体库（维度5未做）、进入全景预览、优化工作流布局、复制/粘贴节点（不让拼图）。

### 9.3 右下角功能区（图14）：见 §3.3。

### 9.4 右上角「确认视频，进入下一步」
复用 `confirmSegmentsAndEnterEdit()`（videoTasks.js:829，已核实）：`importAllGeneratedSegments` 批量导入所有 current 片段（置 `importedToEdit` + 推 `edl.timeline` + version+1）→ `switchPage("edit")`。
- 拍板（时机）：Radio 选中只标记该片段最终视频(current)，**不即时导入**；显式点"确认下一步"才批量导入。未选片段提示"片段 N 还没选定视频"，不硬拦其余。
- **选中→时间线，未选→素材库**：每片段选中的 1 条进 `edl.timeline`；同片段其余成功视频登记为剪辑页**素材库可选素材**（不进时间线、可手动替换）。需扩 `confirmSegmentsAndEnterEdit`/导入链路：除 import current 外，把同 group 其他成功视频注册进素材库（走 VevDemo 素材链路 `ensureVevDemoBindingForUpload` 一带）。

### 9.5 进度监控落位（四类全保留，复用现有 ETA）
统一"吞吐 ETA + snapshot.createdAt 跨刷新锚定 + 单调钳制"，`_fmtMinSec` 各模块自持：镜头计划 `_setShotsProgress`(shots.js:1081)→②头；首帧 `_showKeyframeHeaderProgress`(storyboard.js:135)→③每片段头；提示词 `_syncVideoPromptsHeaderHint`(videoPrompts.js:210)→面板；视频 `_batchTaskProgress/_batchRemainingText`(videoTasks.js:1610/1619)→④每片段头。文案沿用：待生成/生成中 N/M 约剩 x分x秒/完成 N/N/失败。

---

## 10. 死代码清理（只清画板范围内确认无用的，不做无关重写）

| 项 | 位置 | 处理 |
|---|---|---|
| 旧多镜头分镜归档 legacyStoryboardArchive | project.js:89-199 / shots.js:308-318 / navLegacyStoryboardArchive | 注掉/移除 |
| images 空壳 / batch 退役页 | #pageImages(wsHtml:1019) / navBatch / #pageBatch | 并入画板后移除 |
| 全局单按钮 btnGenAllImages | workspace.html:900 | 拆每片段后移除 |
| 字幕系统孤儿 | subtitle_format.js | 清孤儿 |
| legacy_pencil 旧铅笔稿 | frameRecommendations.js:149 等 | 清分支 |
| 按位置重排 shot.id 三处 | shots.js:1599 / main.js:7468-7485 | 改 shotUid |
| addShot 塞非 schema 字段 | main.js:7462-7466 | 清理 |
| reference-site/modules/* 死副本 | reference-site/ | 勿当活代码 |

---

## 11. 实施分期（前端先行 → 后端跟进；P0–P4 合并）

| 期 | 内容 | 前端 | 后端 |
|---|---|---|---|
| **P0** | 本 PRD → 你审 → 我出文件级落地清单（模块边界/版本/测试锁） | — | — |
| **P1 画板替代入口（只读/半交互）** | board.js 浅色布局 + 视口/缩放/拖动 + SVG 连线；参考图区、镜头计划卡、首帧候选展示、视频候选展示（**读时投影**现有数据）；右上角确认按钮；导航改名 + prompts 重定向。**不改后端模型** | 大 | 无 |
| **P2 生成动作接管** | 接生成镜头计划/每片段一键全生成/单卡重生/生成提示词/生成视频/历史替换/下载/删除/进剪辑；shotPlanDialog（**先落 Phase1 安全闸**：shotUid+写回守卫+423 锁，再 UI + 图15 参数）。旧 shots/prompts UI 留 fallback | 大 | 中(安全闸) |
| **P3 候选数据模型升级** | 补 `shotFrames[shotUid].candidates+selectedImageCandidateId`（镜头级）/ `videoCandidates+selectedVideoCandidateId`（片段级）；拖序+刷新一致性+历史恢复；候选窄写入端点 + 片段内每镜头首帧 + 首帧+多参生视频 | 大 | 中-大 |
| **P4 旧页退役 + 收尾** | 隐藏 shots/prompts 页面级 UI（留底层函数+兼容路由）；左键面板/右键菜单定版；死代码清理；视口裁剪性能 | 中 | 小 |

**必要重构（best-effect，非补丁）**：首帧从"段首单帧+history 留痕"重构为"镜头级候选数组+显式 selectedId"；镜头身份位置 id → shotUid；三处"设为当前"统一为显式 set-current 窄动作；中段页面级编排从 4 大模块抽到 board.js，旧模块降为能力层。

---

## 12. 验收标准（采纳 Codex + 增补）

- 新项目初始只显示「导入参考图」按钮。
- 导入参考图后出现参考图区 + 「生成镜头计划」。
- 镜头计划生成后可打开深色弹窗增删改 + 查看提示词。
- 首帧按 片段/镜头 对齐展示，候选可**显式选中**；生视频读 selectedId 非 DOM。
- 视频候选每片段只能选一个。
- 右下角缩放/拖动画布可用；右上角确认能把选中视频导入剪辑。
- **尾帧不出现在主流程**（仅高级菜单可触发首尾帧过渡）。
- 进度仍显示 待生成/生成中/完成/失败/约剩时间。
- 不出现"旧页与新画板状态不同步"。
- `npm run verify:frontend` 通过 + 补画板契约测试（候选选中权威、groupIdx 不串位、确认进剪辑）。

---

## 13. 主要风险（采纳 Codex + 增补）

1. **`groupIdx` / 候选状态串位（最大风险）**：选中态必须做成**数据权威**（显式 id），不能靠 DOM 顺序/最右位置；结构改动受 423 批次锁。
2. **旧模块体量大**：不在 storyboard.js(406KB)/videoTasks.js(201KB)/videoPrompts.js(114KB) 继续堆页面 UI；新建画板模块，旧模块只供能力。
3. **尾帧旧逻辑残留**：前端彻底隐藏尾帧入口，后端能力先留，避免破坏旧数据/测试。
4. **（增补）片段内每镜头首帧的后端缺口**：这是 §0 决策1 必须的后端演进，P1 前端可投影渲染、真正生成依赖 P3 后端；排期别让前端空等。
5. **（增补）自建视口性能**：大项目用视口裁剪 + 防跳变，避免全量重排卡顿。

---

## 14. 开放项（已全部拍板 2026-06-25）

- **A. 片段边界**：镜头计划阶段按 `sceneId`/合并逻辑成片段，弹窗加"片段分组"列可调归属；规则 = **20-25 秒发车**（§5.2/决策4）。✅
- **B. 每片段 1 段最终视频**：是，有且仅 1 条进剪辑时间线；其余未选视频进剪辑页素材库当可选素材（§5.4/§9.4）。✅
- **C. 撤销范围**：结构操作可撤、生成类不可撤（已扣费）。✅
- **D. "参考内容 +"**：V1 只读，补充入口放后续期。✅

---

## 15. 落地拆分：总纲 + 系列方案（回应"是否该分阶段 / 画板要不要单独方案"）

**结论：分。本 PRD v2 = 总纲 / 北极星（定"做什么"，长期维护）；落地拆成一串各自独立评审、独立上线的「方案」（定"怎么做"）。** 一份统一大方案确实会粗糙，且本次有外部依赖（Seedance 2.5 公测）不该阻塞前端——分开正合适。

| 方案 | 范围 | 依赖 | 性质 |
|---|---|---|---|
| **方案一 · 画板引擎**（建议最先做，独立证明"画板能力"） | 自建 transform 视口 + SVG 自动连线 + 节点布局 + 缩放/平移/功能区 + **只读投影**渲染真实项目数据 | 无（纯前端、不改后端） | 前端基建；里程碑1 = 能拖能缩能连、能渲真数据 |
| 方案二 · 镜头计划弹窗 + 片段分组/发车 | shotPlanDialog（**安全闸 shotUid+423 锁先行**）+ 图15 参数 + 片段分组列 + 20-25s 发车 | 方案一 | 前端为主 + 轻后端 |
| 方案三 · 分镜首帧候选模型 | 镜头级 `shotFrames[shotUid].candidates + selectedImageCandidateId` + 选中权威 + 拖序 + 每片段一键全生成 | 方案一/二 | 前端 + 中后端 |
| 方案四 · 关键帧+参考图生视频升级 | payload 从首尾帧判断升级为关键帧+参考；尾帧产品移除；接 Seedance 2.5（30s/多关键帧/≤50 参考）；预算上调 | **Seedance 2.5 公测 GA（约 7 月初）** | 后端重头，GA 后落地 |
| 方案五 · 视频候选 + 进剪辑 + 素材库 + 退役 | 片段级视频候选 + Radio 单选进时间线 + 未选进素材库 + 旧页退役 + 死代码清理 | 方案一~四 | 前端 + 集成 |

每个方案我单独出 md、你单独审、Codex 单独执行、单独验收上线；不一次性铺开。**关于"画板能力能不能做"**：自建视口是有界、成熟的模式（即 React Flow 的底层套路、纯 vanilla 实现，约数百行：transform 数学 + 指针事件 + SVG 路径 + 命中测试），不是探索性难题；风险在打磨/性能而非可行性。**正确的去风险方式 = 方案一先把画板引擎当独立交付物做出可跑原型（真数据只读渲染 + 平移缩放连线）作为里程碑1 闸门，过了再压业务逻辑。**

---

## Sources

代码（本地，行号见正文）：`public/workspace.html`、`public/main.js`、`public/modules/{board*,shots,storyboard,videoPrompts,videoTasks,shotSchema,frameRecommendations}.js`、`lib/shot-plan-normalize.ts`、`lib/batch-executors.ts`、`lib/video-payload-decision.ts`、`lib/video-reference-manifest.ts`、`lib/video-gen.ts`、`lib/video-creation/{history,current-video,import-to-edit}.ts`、`lib/projects-db.ts`、`lib/asset-library.ts`；既有方案 `镜头计划编辑器-修改镜头计划弹窗-落地方案.md`、`SEGMENT_VIDEO_HISTORY_PLAN.md`；Codex《画板替代镜头页/视频页落地方案》（本次合并对象）。

行业资料：
- 主流视频模型首帧/参考/转场定位: https://help.runwayml.com/hc/en-us/articles/Gen-4 ，https://deepmind.google/models/veo/ ，https://lumalabs.ai/learning-center/articles/luma-video-models-field-guide ，https://kling.ai/quickstart/ai-video-start-end-frames
- 受约束流程图/用户流交互: https://www.justinmind.com/ux-design/flowchart ，https://www.feishu.cn/hc/en-US/articles/980918978289
- vanilla 无限画布平移缩放（CSS transform + HTML 节点 + SVG 连线）: https://www.sandromaglione.com/articles/infinite-canvas-html-with-zoom-and-pan ，https://www.steveruiz.me/posts/zoom-ui
- 节点流库对照（为何不用现成）: https://github.com/jerosoler/Drawflow ，https://reactflow.dev/ ，https://xyflow.com/
