# 道具图升级"六视图设定板" — 可行性评估 + 方案（决策已锁定）

状态：评估 + 方案，**本轮不改代码**。HEAD `bec9b64`。日期：2026-06-20。
目标：提升道具在成片里的**还原度**（长得像、细节够）和**一致性**（同一道具跨镜头不变形）。
姊妹方案：场景走 `docs/scene-consistency-upgrade-plan.md`（场景选了 N 独立图，原因见 §3）；本方案的行业实证大量复用它（Seedream 探针、九宫格机制裁决）。

---

## 0. 一句话结论（拍板）

**做，但不是"裸出一张六宫格图"，而是把角色已经跑通的"设定板→切分→单视图→按镜选图"那套管线泛化到道具上。**
即：道具也出一张**多视图设定板**（一次生成、六视图互相一致）→ 程序**切成 6 张干净单视图**入库 → 首帧/视频按本镜头角度**只挑 1 张匹配视图**注入。这条路价值真实、与角色同构、可去补丁化，是唯一推荐解。直接"把网格图当参考喂下去"是错的（§3 会致道具在画面里被复制成多件）。

---

## 1. 可行性评估（全部代码实锤，非推断）

### 1.1 道具现状 = 单角度产品图，一致性天生薄弱
- 生成：`asset_images` executor（`batch-executors.ts:1019`）对道具走 `kind:'prop'`、`size 1024×1024`、`quality:'low'`（`:1107/:1116`）。提示词 `forceStyleSuffix` 道具分支（`image-gen.ts:1032-1041`）= 纯白底 + 物体居中占 70% 的**单张 product shot**，**单一角度**。
- 切分：`asset_images` 里只有 `type==='char'` 才触发 `splitCharacterPanels`（`:1128-1141`），道具不切、不分视图。
- 存储：道具只存一个 `imageUrl`；图像历史字段 `prop: name/propType/features/material/imagePrompt`（`:965-969`）。
- **病根**：道具只有正面一张。镜头里道具一旦转角度，模型没见过它的背/侧/顶，只能**每镜各脑补一次** → 同一个杯子这镜一个样、下镜又一个样。这正是"还原度/一致性"差的直接原因，与"身份只锁外观、视角允许变"在视频清单里写死的口径吻合（`video-reference-manifest.ts:281-282`：prop "允许视角变化"但"锁外形/材质/尺度/识别符号"——可现状根本没给它多视角的真相）。

### 1.2 关键发现：角色已经有一整套"多视图设定板"基建，可直接泛化
角色就是本方案要复刻的范式，且**已在线上跑通**：
- 出一张多格设定板（真人 4 格 头/正/侧/背、非人 3 格 正/侧/背，`image-gen.ts:899-1013`）。
- `splitCharacterPanels`（`character-panels.ts:332`）把设定板**切成独立小图**、逐格质检（`panelQuality:210`）、写 `images` 表（`style='character-panel'`）、带 `version + panelHistory(≤5)`（`:508-544`）。
- 下游 `panel-selection.ts:selectCharacterReferencePanels` 按本镜头意图（`ShotPanelIntent='face|body|profile|back|group'`）**只挑该镜头要的那张视图**，经 `reference-matcher.ts` 写进 manifest 的 `panelInfo`（`:321/:532-560`），视频阶段 `batch-executors.ts:2807-2819` 据此注入选中视图。
- **道具要做的，就是把这条"sheet→split→panel→按镜选"从"角色专用"泛化成"带视图的资产通用"，让道具成为第二个消费者。**——这是去补丁化的本体（§7）。

### 1.3 切分对道具反而更稳（比角色还简单）
- 角色切分用的是**墨迹密度找白缝**（`detectPanelBoundaries:130-192`），因为角色板宽度不均（头像 40% + 三视图各 20%）。
- 道具六宫格是**等分 2×3 规则网格**，切分用**固定等分 + 逐格白边收缩**即可，比墨迹检测更确定（角色的 `percentFallbackBoundaries:194-208` 升成 2D 版就够）。**不动、也不需要那套易错的墨迹检测器。**

### 1.4 provider 能力实锤支持（栈里就用 Seedream + Seedance）
- **Seedream 4.5**（栈内 `doubao-seedream-4-5`）官方定位"多图一致性专家"，有 **Cross-Image Consistency Module**，明确支持"**同一产品多角度参考 / 一次出多视图**"，最多 14 张参考。出六视图设定板它本来就会。
- 约束沿用场景探针实锤：**最小出图 ≥4MP**、无 ControlNet 控制通道、多参考 cap 14（见姊妹方案 §A）。→ 六宫格画布必须走 `resolveSeedreamSize`（≥4MP），禁裸传小尺寸。
- **Seedance**（视频侧）多参考能力："给同一主体多个视图 → 跨片段保持一致"。→ 道具多视图注入视频阶段，正是它擅长的输入。

**可行性结论**：技术风险低、基建已存在、provider 友好。主要工作量在"把角色管线泛化 + 道具视图的按镜选取"，不是从零造。

---

## 2. 优势 vs 弊端（诚实）

| | 内容 |
|---|---|
| **优势** | ① 还原度：从 low 单图 → medium 多视图 + ¾ hero/细节格，物体更faithful；多视图给下游"真相"，少脑补。② 一致性：六视图**一次生成、互相一致**，每镜取对应面 → 背/侧跨镜头不再各画各的。③ 复用角色基建（切分/质检/版本/按镜选），不新造轮子。④ provider 顺路（Seedream 多角度产品参考 + Seedance 多参考）。⑤ 成本可控：仍是**每道具一次生成**（非六次）。 |
| **弊端/代价** | ① 成本上升：道具从 low 单图 → medium 设定板，单价≈从低档涨到 30 积分/张（`credits.ts:16`）档位；但仍一次生成。② 切分不保证 6 格都可用（行业实锤"生成 10-20 张挑最好"）→ 必须逐格质检 + 失败回落，不能假设满格。③ 扁平道具（画/相框/文件/屏幕/招牌）没有 6 个有意义的面，强出六视图是浪费。④ 下游要新增"道具视图选取"，reference-matcher/manifest 要接线（中等改动）。⑤ 参考预算挤占：每帧道具仍 cap 6（`frame-image-plan.ts:593`），多视图**只能按镜选 1 张/道具**，不能把 6 张全塞（否则触发 §3 的复制）。 |

---

## 3. 关键架构决策：为什么"切分+按镜选 1 张"，而不是另外两条路

三条路只有第 2 条对：

1. **整张六宫格当参考喂下去（最省事）** —— ❌**否决**。行业实锤：把网格/多格图当参考，模型会"误读分屏"→ 在成片画面里**把道具复制成多件 / 渲染出网格**（OpenAI 社区"unintended multi-panel layout"；本仓库空间一致性方案也把"多参考→主体复制"列为已知故障）。场景 `forceStyleSuffix` 明令"NO grid，避免视频模型误读分屏"正是这个原因。**裸喂网格 = 制造重复 bug。**
2. **六视图设定板 → 切成 6 张单视图 → 按镜选 1 张注入（角色同款）** —— ✅**采纳**。单视图干净不触发复制；按角度选对面；一次生成保证六面互相一致；复用角色管线。
3. **N 张独立图互相参考（场景那条路）** —— ❌**道具否决**。场景被迫走 N 独立，是因为场景满画幅没白底、切不开（姊妹方案 §0/§2.1 实锤 `detectPanelBoundaries` 必失配）。道具是**白底物体、天然可切**，且物体能塞进一张画布——单张设定板"一次出六面、天然互相一致"，比六次独立生成更省、漂移更小（六次独立各掷各的）。**N 独立图是场景的无奈，不是道具的优解。**

> 一句话：道具更像角色（白底、可切、单画布六面），不像场景（满画幅、不可切）。所以抄角色，不抄场景。

---

## 4. 数据流改动（上游→存储→下游）

```
[抽取] asset_prop_extract（不动）→ props[] 元数据(name/propType/features/material)
       新增一个轻量维度标记 dimensionality: 'volumetric'(默认) | 'flat'
[生成] asset_images executor (batch-executors.ts:1019)
       volumetric → forceStyleSuffix 新 prop 多视图分支：2×3 六视图设定板，≥4MP，quality 升 medium
       flat       → 维持现状单图（画/相框/文件/屏幕/招牌）
[切分] 新 splitPropViews（泛化自 character-panels）：固定 2×3 等分 + 逐格白边收缩 + 逐格质检
       → 6 张单视图写 images 表 (kind='prop', style='prop-view', asset_ref='props[idx].views.<role>')
[存储] prop.views{...} + prop.viewsVersion + prop.viewHistory(≤5)；prop.imageUrl 继续=hero格URL(旧读不崩)
[消费] A)首帧 frame-image-plan：按镜头角度挑 1 张视图(缺则 hero)，仍 cap 6 道具
       B)视频 reference-matcher/manifest：道具走 panelInfo 选视图(同角色)，注入选中面
       C)空间/连续性：只读元数据，不受影响
```

**六视图角色集（volumetric 固定）**：`hero(¾ 主图，= 身份格，类比角色 headshot) / front / back / left / right / top`。
- `hero` 即 `imageUrl`，旧读取点零改。扁平道具 `flat` 只有 `hero`（=现状那张）。

---

## 5. Schema（新增，不做老兼容 —— 符合既定纪律）

```
prop.dimensionality: 'volumetric' | 'flat'        // 抽取阶段给，默认 volumetric
prop.views: {
  hero:  { role, imageUrl, rawUrl, imagePrompt, quality, generatedAt },
  front, back, left, right, top: 同结构（缺格则不写该键）
}
prop.viewsVersion: number
prop.viewHistory: Array<{version, viewImageIds[], deprecatedAt}>   // 仿 panelHistory(≤5)
prop.imageUrl 继续 = hero 视图 URL（§4 旧读取点零改；无 views 时回落单图）
```
- `ASSET_IMG_HISTORY_FIELDS['prop']`（`batch-executors.ts:968`）补 `views/dimensionality`。
- images 表新增 `style='prop-view'` 记录，同构 `character-panels.ts:449-465`。

---

## 6. 全变更表（文件:行 → 改法 → 阶段）

| 文件:行 | 现状 | 改法 | 阶段 |
|---|---|---|---|
| **lib/asset-views.ts（新）** | 无 | 单源：泛化角色切分/质检/版本为"带视图资产"通用模块；`splitPropViews` + `pickPropView` | M1 |
| lib/character-panels.ts | 角色专用切分 | 抽出与角色无关的"canvas 切/质检/写库/版本"到 asset-views，角色 delegate（纯重构、行为不变） | M1 |
| lib/image-gen.ts:1032-1041 | prop 单图后缀 | 加 prop **多视图分支**（2×3 六视图、白底、禁文字、物体一致只换角度），flat 走旧单图 | M2 |
| lib/batch-executors.ts:1107/1116 | prop 1024²/low | volumetric→ `resolveSeedreamSize(≥4MP)` + quality medium；flat 不变 | M2 |
| lib/batch-executors.ts:1128-1141 | 仅 char 切分 | prop(volumetric) 也调 `splitPropViews` | M2 |
| lib/batch-executors.ts:965-969 | 历史字段 | prop 补 `views/dimensionality` | M2 |
| prompts.ts 道具抽取 | 无维度 | 抽取时判 `dimensionality`（卷轴/画/屏=flat，其余 volumetric） | M2 |
| lib/panel-selection.ts:345 | 角色按镜选 panel | 加 `selectPropViews`（按 shotType/角度→front/side/back/hero） | M3 |
| lib/reference-matcher.ts:393/407 | prop 单图候选 | prop 候选带 `panelInfo`，URL 走选中视图 | M3 |
| lib/video-reference-manifest.ts:281 | prop 单图 useFor | prop 支持 `panelInfo`（同角色），promptHint 带视图意图 | M3 |
| lib/frame-image-plan.ts:580-598 | prop 取 imageUrl | 按镜头角度挑视图（缺回 hero），仍 cap 6 | M3 |
| lib/batch-executors.ts:2820-2822 | propReferencePaths 单图 | 取选中视图 localPath | M3 |
| 前端 assets.js 道具卡 | 1 图槽 | 6 视图槽（仿场景/角色卡），import map bump + verify:frontend | M3 |

---

## 7. 去补丁化清单（核心约束）

- **不新造道具专用多视图分支挂在旁边**：切分/质检/版本/按镜选**全部泛化复用角色管线**（asset-views 单源），角色与道具共一套。这是"别打补丁上打补丁"的本体。
- **URL 取图收口**：道具视图选取集中到 `pickPropView`（仿 `pickSceneView`/`selectCharacterReferencePanels`），不在各下游各写一段。
- **计费复用**：每道具仍一次 `asset_images` 任务，复用 `credits.ts:16` image=30 幂等扣费/退款链，不新增计费类型。
- **状态门复用**：任一视图 ready 即道具 ready；hero 缺才 blocking（仿场景 establishing）。
- **版本/缓存/测试复用**：import map 单源 bump、`verify:frontend`/`test:cache-busting`、扩展现有 `test:` 契约，不另起体系。
- **不写老数据迁移**（既定纪律）：老道具无 `views` 时按 `imageUrl` 单图回落，不回填。

---

## 8. 分期 / 验收 / 回滚

| 里程碑 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **M1** asset-views 单源（纯重构） | 把角色切分/质检/版本抽成资产通用模块，角色 delegate、行为不变 | 角色出图/切分快照不变 + tsc 0 错 + 现有角色测试绿 | 还原 delegate |
| **M2** 道具六视图生成+切分 | prompt 多视图分支、≥4MP、medium、splitPropViews、schema+存储、dimensionality 抽取 | 一个 volumetric 道具出 6 视图、逐格质检入库；flat 道具仍单图；hero=imageUrl | flag 关多视图回单图 |
| **M3** 下游按镜选视图 | pickPropView 接首帧/视频；manifest panelInfo；前端 6 视图卡 | 不同角度镜头引用对应道具视图；同道具跨镜头更稳；每帧道具仍 cap 6 不超预算 | 选图恒回 hero |

实施建议：先 M1 纯重构（零风险、可立即动手）→ M2 出图（注意 ≥4MP / 逐格质检 / 不假设满格）→ M3 接线。每步独立验收、可回滚。先用同一道具跑 2-3 条前后对比（转角度镜头是否更稳）再放量。

---

## 9. 风险与边界

1. **切分不保证满 6 格**（行业实锤"挑最好"）：必须逐格质检 + 失败回落到可用视图，永不硬拦（符合"不硬拦用户主动行为"纪律）。
2. **裸喂网格会致复制**：所以只走"切分+按镜选 1 张"，绝不把网格/多张全塞（§3）。
3. **Seedream ≥4MP**：六宫格画布必须走 `resolveSeedreamSize`，禁裸传小尺寸（探针实锤）。
4. **扁平道具无意义六面**：用 `dimensionality='flat'` 维持单图，别强出。
5. **预算挤占**：每帧道具 cap 6 不变，多视图只换"每道具注入哪张"，不增注入张数。
6. **成本上升**：low→medium、单图→设定板，单价升一档（仍一次生成）；按既定"积分无上限"口径接受。
7. **M1 行为等价**：抽取角色逻辑到通用模块若测出真实角色数据快照漂移，停手单独议。

---

## 10. 来源（行业实证）

- 多视图设定板=物体一致性标准做法 / "identity 单角度易仿、多角度难保持"：[OpenCreator 角色参考表](https://opencreator.io/blog/ai-character-reference-sheet)·[Scenario turnarounds](https://www.scenario.com/blog/generate-character-turnarounds-scenario)·[Apatero 2026 指南](https://apatero.com/blog/ai-character-turnaround-sheet-generation-guide-2026)
- Seedream 4.5 多角度产品参考 / Cross-Image Consistency / 14 参考：[MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5)·[WaveSpeed 指南](https://wavespeed.ai/blog/posts/seedream-4-5-complete-guide-2026/)·[官方](https://seed.bytedance.com/en/seedream4_5)
- Nano Banana Pro 多视图/多角度（对照，栈未用）：[Apiyi 对比](https://help.apiyi.com/en/seedream-4-5-vs-nano-banana-pro-deep-comparison-en.html)
- Seedance 多参考"多视图→跨片段一致"：[Atlas Cloud I2V 指南](https://www.atlascloud.ai/blog/guides/ai-image-to-video-models-compared)
- 网格图当参考致"unintended multi-panel/复制"：[OpenAI 社区](https://community.openai.com/t/stable-single-character-anime-prompt-template-avoids-multi-panel-issues/1379868)
- turnaround 自动切单图为标准工序：[Stable Diffusion Art 多视角](https://stable-diffusion-art.com/consistent-character-view-angle/)
- 内部姊妹方案（Seedream 探针/九宫格机制裁决）：`docs/scene-consistency-upgrade-plan.md`
- 内部相关：`空间一致性-人物道具场景方位-方案.md`（多参考→复制故障、方位 vs 身份）
