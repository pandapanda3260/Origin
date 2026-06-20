# 场景一致性升级 — 完整方案 v4（最终版 · 场景多视图 + 俯视空间锚 + 参考强注入）

状态：v4，决策全锁定、关键约束全实证（含 Seedream 活体探针）。仅方案，不改代码。HEAD `9046c9f`。
配套：M1 实现规格见 `docs/scene-views-m1-refactor-spec.md`。
日期：2026-06-19

## 已锁定决策
1. 多视图 = **N 张独立图 + 互为参考**（不拼版切割）。
2. 视图集 = **establishing / reverse / alt + topdown（俯视/平面锚）共 4 张**。
3. "A（元素位置）" = **软贴合**（俯视锚当参考 + prompt 约束），**不追求逐像素硬锁**；depth/seg 重型派生不做。
4. A 绑 Seedream，但**全程不阻拦、非必要不提示**（同现有资产锁 UX）。
5. 积分**无上限**。
6. 先做 **M1 纯重构**（统一场景取图入口、行为不变），再上多视图。

## A. 实证结论（全部已验证，替代一切假设）

### A.1 Seedream 开放 API 无 ControlNet 控制通道——**活体探针实锤**
用真 key 对 `doubao-seedream-4-5-251128` `/images/generations` 实跑（Codex 只读执行）：
- 有效尺寸下，baseline 200；`control_image / controlnet / condition / controls / structure_image / control_strength / image+control_mode` **全部 200，被服务端静默忽略（不报错也不生效）**，无任何字段返回 `InvalidParameter/unknown`。
- 结合字节 Seed 官方博客（"canny/depth/mask 原生内化、**不像传统走外部 ControlNet**"；调用形态=结构图当普通 `image` 参考 + prompt 写"贴合布局"）→ **确认：开放 API 不存在可用的结构控制参数；发控制字段是 no-op。**
- **工程含义**：① 不要发任何 `control_*` 字段（无效）；② 锁位置的唯一原生路径 = 把"结构/俯视锚图"当普通 `image` 参考 + prompt 强约束（软贴合，无强度旋钮、不保证逐像素）。

### A.2 新硬约束：Seedream 最小出图尺寸（探针副产物）
- 探针发现：`size` 必须 **≥ 3,686,400 像素（≈1920×1920 / 4MP）**，`1024×1024` 被拒（`InvalidParameter: image size must be at least 3686400 pixels`）。
- 现有 `generateImage` 经 `resolveSeedreamSize(cfg.imageSize, input.size)` 映射（env `IMAGE_SEEDREAM_SIZE` 默认 4K），所以现状不受影响。**多视图生成必须沿用该路径**，禁止裸传低于 4MP 的尺寸；topdown 锚图若用方形也需 ≥4MP。

### A.3 竞品"720度/九宫格/多机位"= 同类扩散机制，无几何代差
- 小云雀"720度全景"=单图脑补全景再裁切角度存资产库 `@` 引用（机制 全景+参考）。
- LibTV（哩布哩布，≠LTX）"九宫格/三视图"=一次扩散拼版大图再切分（机制 a）；"15点位多角度"=母图条件重画（机制 b）；官方 GitHub 实锤后端只是"提示词→图 URL"，无 3D/相机/深度接口。
- 连 Qwen 多角度也是 GS 渲染图训练、推理纯扩散、无在线 3D。
- **裁决**：9宫格/720度与本方案 4 视图同一类机制，**无代差、非真几何**。竞品真正强在两点工作流——**视角图资产化 + 每分镜强注入同组参考** & **俯视图/平面图当空间锚**。本方案正是抄这两点（见 §2、§3），不追格子数量。

## B. 一句话澄清（九宫格）
场景图从 Phase3 至今一直单张 1536×1024，**从未九宫格**；九宫格只在分镜稿拼版（`batch-executors.ts:1809-1817`）与竞品对比 svg。无旧代码可恢复。

## 0. 设计总原则（去补丁化）
"取场景图 URL / 选场景"收口到唯一模块 `lib/scene-views.ts`，所有入口 delegate（细节见 M1 规格）。**纠正**：三个场景取图入口里只有 `sceneUrl`(scene-selection.ts) 是场景专用；`assetImageUrl`(frame-image-plan)、`assetUrl`(reference-matcher) 是**通用**(角色/道具也用)且彼此口径不同（pencilUrl vs coverUrl）。M1 只收口**场景入口**，不动两个通用函数对角色/道具的行为（统一它们=另一独立待批小重构）。

## 1. 数据流全景（上游→存储→下游）
```
[抽取] SP_ASSET_SCENES_EXTRACT (prompts.ts:1169-1205) → environments[] 元数据
[生成] asset_images executor (batch-executors.ts:1019-1248)
   prompt = imagePrompt + SCENE METADATA(1040-1051) + STYLE BIBLE LOCK(1055-1060)
   forceStyleSuffix(kind='scene') 现强制单张连续图 (image-gen.ts:1019-1030)
   generateImage → resolveSeedreamSize(≥4MP) → 现【1 张】
[存储] 双写 assets.scenes[idx] + environments[idx] 镜像 (1194-1234)
[消费] A)首尾帧 frame-image-plan(context预算6)  B)视频 reference-matcher→sceneReferencePath(预算9)→video-gen.ts:130  C)连续性(只读元数据)
```
升级 = 1 张 →「establishing/reverse/alt + topdown」4 视图；下游按机位选视图 + 把 topdown 锚随每镜头强注入 + prompt 贴合约束。

## 2. 场景多视图 + 俯视空间锚（核心）

### 2.1 视图集
`scene.views[].role ∈ { establishing(主，= 现有那张，imageUrl 仍指它), reverse(反打180°), alt(侧角/细节), topdown(俯视/平面"空间定海神针"=位置一致性杠杆) }`。
- N 张独立图，establishing 先出、作为后续视图的 `referenceImagePath`（Seedream 多参考 cap 14）。
- **不复用角色像素切割**（场景满画幅无白底间隙，`character-panels.ts:detectPanelBoundaries` 必失配）。
- topdown 用 forceStyleSuffix 新分支生成"top-down floor-plan-like view, consistent with establishing"；它就是 §3 软贴合的载体。

### 2.2 Schema（新增，不做老兼容）
```
scene.views: Array<{ role, angleHint, imageUrl, rawUrl, imagePrompt, submittedImagePrompt,
                     reference{currentUrl,lastKnownGoodUrl,status,updatedAt,styleBibleSignature,styleLockVersion},
                     generatedAt }>
scene.viewsVersion: number
scene.viewHistory: Array<{version, viewImageIds[], deprecatedAt}>   // 仿 panelHistory(≤5)
scene.imageUrl 继续 = establishing URL（§5 旧读取点零改不崩；无 views[] 时按单图回落）
```
`ASSET_IMG_HISTORY_FIELDS['scene']`(batch-executors.ts:965-970) 补 `views`；双写 environments[] 同步。

### 2.3 生成编排（每视图一个 task，复用现成幂等扣费）
- establishing（= 现有出图）→ 以其本地图为 `referenceImagePath` 出 reverse/alt/topdown；forceStyleSuffix 增 `kind='scene'` 多视图分支（每 role 一段角度/俯视指令，单张连续图、禁拼版）。**所有视图走 generateImage→resolveSeedreamSize，满足 ≥4MP（§A.2）。**
- **每视图 = 一个 asset_images target/task**：各自扣 30 积分、各自幂等/重试/退款，复用 `durable-tasks.ts:250`，**不改** `costForBatchType`。establishing 失败=该 scene 失败；其余视图失败只缺该视图，下游回落 establishing。
- 存储：每视图写 `images` 表（`kind='scene'`, `style='scene-view'`, `asset_ref='scenes[idx].views.<role>'`），同构 `character-panels.ts:449-465`。

### 2.4 下游接入（统一走 scene-views.ts）
- `pickSceneView(scene, primaryShot)`：按 `primaryShot.angle/shotType` 选 establishing/reverse/alt；缺则回落 establishing。
- **强注入空间锚（关键升级）**：首尾帧与视频生成时，除"选中视角图"外**默认再注入 topdown 锚图**（1 张），prompt 加结构贴合约束（"保持与俯视图一致的空间布局/家具站位/朝向，不要镜像"——照搬 Seedream 官方户型图措辞）。
- 预算：首尾帧 context=6（frame-image-plan.ts:211）默认给"选中视角 1 + 锚 1"，留 4 护道具/角色；视频预算 9 同理。
- `sceneReferencePath`/`video-gen.ts:130` **接口不动**（取选中视角 localPath）。
- 状态门（visual-reference-state.ts）：任一视图 ready 即 scene ready；establishing missing 才 blocking。

### 2.5 前端（被动、不阻拦）
- 卡片 `assets.js:_renderSceneCards(1594)`：1 图槽→4 视图槽；`render_hooks.js:renderAssetCard(33)`+`_updateCardImageInPlace(319)` 按 role 多图就地更新。重生成仍走 `generateAllAssetImages→/api/batch/start{asset_images}`(`assets.js:2535/2576`)，targets 带 role。
- **不阻拦 UX**：缺视图/锚不报错不弹框；最多复用 `upstream-stale-banner`(assets.js:705-712) / `priority_high/info` 图标(assets.js:738-755) 做被动提示。
- 版本：import map bump `assets.js`(175→)/`render_hooks.js`(301→)/`material_image_panel.js`(105→ 若用)，新增 `scene_views.js` 条目；跑 `verify:frontend`/`test:cache-busting`。

## 3. "A"（元素位置）= 俯视锚 + prompt 约束（探针实锤后的最终形态）
- **不建控制图通道、不做 depth/seg(onnx) 派生**（§A.1 实锤 API 消费不了，发了也是 no-op）。
- 落地 = topdown 锚图（§2.1 生成）作为每镜头额外**普通 `image` 参考**注入（§2.4）+ renderFramePrompt 场景段加结构贴合约束句。
- **诚实边界**：软贴合，比单图/无锚好，但**不保证逐像素锁位**。要真硬锁需换 FLUX/SDXL+ControlNet 栈——**单列、暂缓，不在本期**。
- depth/线稿若以后想要，只是"多生成一张结构参考图"，非控制通道、不需 onnx——可选，本期不做。

## 4. 全字段变更表
| 位置 | 字段 | 变更 | 文件:行 |
|---|---|---|---|
| scene 资产 | `views[]`（含 topdown） | 新增 | 写入 batch-executors.ts:1150-1248 |
| scene 资产 | `viewsVersion`/`viewHistory[]` | 新增（仿 panelHistory） | 同上 |
| scene 资产 | `imageUrl` | 语义=establishing URL（兼容旧读） | — |
| 历史快照 | `ASSET_IMG_HISTORY_FIELDS['scene']` | 补 `views` | batch-executors.ts:965-970 |
| images 表 | `style='scene-view'` 记录 | 新增写入 | 仿 character-panels.ts:449-465 |
| 控制图相关 | — | **不新增**（探针实锤无通道） | — |

## 5. 全调用关系变更表
| 文件:行 | 现状 | 改法 | 阶段 |
|---|---|---|---|
| **lib/scene-views.ts（新）** | 无 | 单源：场景选择迁入 + resolveSceneImageUrl({gate}) + pickSceneView | M1 |
| scene-selection.ts | 场景选择+sceneUrl | 迁入 scene-views，留再导出壳（三处 import 零改） | M1 |
| frame-image-plan.ts 场景调用 :552,650,654,657,666,900 | assetImageUrl(scene) | → resolveSceneImageUrl(scene,{gate:true})；assetImageUrl 保留给 char/prop | M1 |
| reference-matcher.ts 场景调用 :649,696,699 | assetUrl(scene) | → resolveSceneImageUrl；assetUrl 保留 | M1 |
| frame-image-plan.ts:539-571,645-669 | 选 1 场景单图 | 按 angle 选视图 + 注入 topdown 锚 | M3 |
| frame-image-plan.ts:785-803 | context 预算 | 场景占"视角1+锚1"，护道具 | M3 |
| reference-matcher.ts:622-694 | 视频场景候选 | URL 走 pickSceneView + 锚 | M3 |
| batch-executors.ts:2681-2684 | sceneReferencePath 单图 | 取选中视角 localPath | M3 |
| batch-executors.ts:1019-1248 | 出 1 张 scene | 出 4 视图（每视图一 task，≥4MP） | M2 |
| image-gen.ts:1019-1030 forceStyleSuffix | scene 强制单图 | 加多视图 + topdown 分支 | M2 |
| renderFramePrompt 场景段 | 文字锁 | 加"贴合俯视图布局"约束句 | M3 |
| video-gen.ts:130 | sceneReferencePath 单图 | **不改** | — |

## 6. 分期、验收、回滚
| 里程碑 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **M1** scene-views 单源（详见 `docs/scene-views-m1-refactor-spec.md`） | 建模块、三处场景入口 delegate、纯重构 | test:scene-views 等价绿 + test:frame-image-plan/video-reference-manifest 快照不变 + tsc 0 错 | 删模块/还原 delegate |
| **M2** 多视图+锚生成 | asset_images 出 4 视图（每视图一 task，≥4MP），schema+存储+双写+前端卡片 | 一场景出 4 图(含俯视)，积分=4×30，前端可见 | flag 关多视图回单图 |
| **M3** 下游接线+锚强注入 | pickSceneView 按 angle 接首帧/视频；注入 topdown + prompt 约束；预算护道具 | 反打/特写引用对应视角；同场景跨镜头空间更稳（软贴合） | 选图恒回 establishing、不注入锚 |
| （可选·暂缓） 几何增强 | 轨道视频抽帧(机制f) 或 换 ControlNet 栈 | 另立项 | — |

## 7. 测试计划（扩展现有契约）
新增 `test:scene-views`（解析等价 + pickSceneView + 状态聚合 + 锚默认注入）；扩展 `test:frame-image-plan`（视角槽位+按 angle+锚预算）、`test:video-reference-manifest`（选中视角+预算9不溢）、`test:assets-stale-flags`（asset_img_scene_0 覆盖各 role）；`test:cache-busting` 锁版本。

## 8. 计费
image=30/张按 task 幂等扣（credits.ts:14 / durable-tasks.ts:250）。4 视图=120 积分/场景。失败不扣、退款链复用。无上限。

## 9. 风险与边界
1. **软贴合非硬锁**（API 实锤无控制通道）：俯视锚+prompt 改善位置一致但不保逐像素；硬锁=换栈，本期不做。
2. **Seedream ≥4MP**：多视图生成必须走 resolveSeedreamSize，勿裸传小尺寸（探针实锤）。
3. **多视图互不几何一致**：N 独立图仍可能彼此对不齐；锚图缓解非根治。
4. **context 预算=6**：默认"视角1+锚1"，留 4 护道具/角色。
5. **角色切割器不可套用**（已决策 N 独立图规避）。
6. **M1 行为等价**：场景在极端字段形状(pencilUrl/coverUrl/顶层currentUrl-only)下三函数本就不一致，M1 用超集顺序收敛 + 测试证明真实数据不受影响；若测出真有此类数据，停手单独议。

## 10. 去补丁化清单
URL 解析：场景入口→`lib/scene-views.ts` 单源（仅场景，不动通用 char/prop 解析）；视图选择/锚注入集中单点；计费复用每-task 幂等账；状态门复用 visual-reference-state；版本/测试/UX 复用 import map 单源、扩展现有 test:、复用 upstream-stale-banner。

## 11. 执行顺序（下一步）
1. **M1**（不依赖任何外部，可立即动手）：按 `docs/scene-views-m1-refactor-spec.md` 建 scene-views 单源、行为不变。
2. **M2**：多视图+俯视锚生成（注意 ≥4MP、每视图一 task）。
3. **M3**：下游 pickSceneView + topdown 强注入 + prompt 约束。
每步独立验收、可回滚。

## 12. 来源（实证）
探针：本仓 `scripts/probe-seedream-control-param.js` 真 key 实跑——控制字段全 200 静默忽略 + min-size 3,686,400px。
文档：[字节Seed博客(原生内化非ControlNet)](https://seed.bytedance.com/en/blog/seedream-4-0-officially-released-beyond-drawing-into-imagination)·[Seedream4.0技报](https://arxiv.org/abs/2509.20427)。
竞品：[小云雀720全景(腾讯实测)](https://news.qq.com/rain/a/20260528A07MOU00)·[LibTV(量子位)](https://www.qbitai.com/2026/03/390320.html)·[LibTV官方GitHub](https://github.com/libtv-labs/libtv-skills)·[Qwen多角度=扩散非3D](https://qwen.ai/blog?id=qwen-image-edit-2511)。
