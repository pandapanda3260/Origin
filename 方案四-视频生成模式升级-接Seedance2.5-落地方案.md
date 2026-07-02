# 方案四 · 视频生成模式升级（全能参考 / 智能多帧 / 首尾帧）— 接 Seedance 2.5

> 《画板模式 PRD v2》落地拆分第 4 个方案。**只出方案不改代码**。后端重头。
> 全程扣真实代码（路径+行号）。执行：Codex；审查/验收：本人。
> **策略（Vasily 2026-06-25 拍板）：不等 2.5，现在按已公开规则全做、上线当天切参数。** Seedance 2.5 已公开：30s + 50 张多模态参考 + **帧参考（指定关键帧出现在视频指定时间点）**。按这套规则现在就把数据流/manifest/Builder C/发车/预算**全部写完**，数字做成"跟模型走"的能力派生（默认仍 2.0 的 9/15，切 2.5 自动 50/30/发车 20-25）。**唯一残留**：2.5 官方还没贴"关键帧请求字段名"，故 Builder C 现在按已知规则 + 最佳猜测写 + 留适配层，**上线当天发一条测试单对齐字段名**（10 行内微调、2 分钟，非拦路）；万一当天没对上，智能多帧先走现成"首帧+多参考图(吃满 50)"兜底、不阻塞上线。**依赖**：方案三 `shotFrames` 已落库。

---

## 0. 范围与依赖

**做**（视频生成后端，三模式）：
- **全能参考** = `auto`（默认）：`resolveVideoPayloadDecision` 升格为默认用户模式，按输入自动选最合适。
- **智能多帧** = 关键帧+参考图（**本方案核心、全新**）：片段内每镜头选中首帧作**多关键帧（按时序）** + 角色/道具/场景**参考图** + 提示词 → 1 段视频，接 Seedance 2.5（30s/多关键帧/≤50 参考）。
- **首尾帧** = `first_last_frame`（保留）：2 帧转场模式。
- 配套：发车值翻转（4/15→20-25，能力派生）、参考预算上调（9→≤50）、放宽"首尾帧 vs 参考图"硬互斥（仅对 2.5）、加 2.5 model id + capability 行。

**不做**：视频卡模式选择器 UI（方案五已定稿，本方案只接后端语义）；首帧候选模型（方案三）；toolbox。

**与方案五的衔接**：方案五已把模式选择器 UI + `submitMode` 透传铺好，且 2.0 上"智能多帧"= `reference_images`（首帧+多参）。**本方案把"智能多帧"在 2.5 上升级为真正的多关键帧**——同一个用户模式，行为随模型能力升级，UI 不变。

---

## 0.5 关键现状（扣码，决定方案形态）

| # | 事实（file:line） | 影响 |
|---|---|---|
| ① | **全仓零 keyframe 概念**：视频 payload 只有 3 个 API role `first_frame`/`last_frame`/`reference_image`（video-gen.ts 的 content 数组元素 `{type:'image_url',image_url:{url},role}`）；内部 `VideoReferenceRole`=first_frame/target_end/scene/character/prop（video-reference-manifest.ts:11）。**"段内每镜头按时序一帧"现无字段可表达**。 | 智能多帧需新增 `keyframe` role + 新 payloadMode + 新 Builder。 |
| ② | **两 Builder 硬互斥**：A 首尾帧（buildSeedanceFirstLastFrameBody video-gen.ts:2113，content=[text,first_frame,last_frame]，**禁任何 reference_image** :162/:2110）；B 首帧+多参（:1345，所有参考降为 `reference_image`，丢 role 区分）。`modesAreMutuallyExclusive:true`（video-provider-capabilities.ts:61）。 | 智能多帧要"多关键帧 + 参考图同请求"，需对 2.5 放宽互斥。 |
| ③ | **payloadMode 仅 2 值** `first_last_frame`/`first_frame_multi_ref`（video-payload-decision.ts:11）；`firstLastFrameMode` 容器只装 2 张（:52）。决策 `resolveVideoPayloadDecision`(:207)：firstFramePath 硬前置(:229)，合并段恒走参考(:240)，tail_ready 唯一进首尾帧(:280)。 | 加第 3 个 payloadMode（多关键帧列表，非 2 张容器）。 |
| ④ | **预算 9**：`VIDEO_REFERENCE_IMAGE_BUDGET=9`（video-reference-manifest.ts:6，含首帧）；override `Math.min(budget,9)`（reference-matcher.ts:539）。 | 2.5 ≤50，需对 2.5 上调；关键帧 vs 参考图的 50 拆分=探针未知。 |
| ⑤ | **无 15s 代码 clamp**！duration 仅 `min 4`（video-reference-manifest.ts:207）+ 绝对 `min(120)`（:147）；"15"只是轮询超时 15min（video-gen.ts:1179）。2.0 的 ~15s 是模型自身约束，非代码。 | 翻 20-25/30 干净——clamp（120）放得下，只需对齐段总时长口径。 |
| ⑥ | **model 路由**：`VIDEO_MODEL` env → 兜底 `doubao-seedance-2-0-260128`，provider `seedance`（model-routing.ts:231/232）；白名单 :68-70；capability 行 video-provider-capabilities.ts:78，2.0 探针 `cgt-20260510020416-zrtrs`(:91)。 | 加 2.5 model id + capability 行（含 keyframe 能力/时长/参考上限）。 |
| ⑦ | **executor 读段级单首帧**：video_segments executor `resolveStoryboardFirstFrameUrl(sb)`（batch-executors.ts:2938，段级一张）→ manifest `addFirstFrameCandidate`（reference-matcher.ts:385，只塞一张 first_frame）。`resolveStoryboardFirstFrameUrl`（visual-reference-state.ts:41）只读 storyboard 级字段。 | 智能多帧要改成遍历 `groupShotIndices`(:2872) 取各镜头 `shotFrames` 选中候选（方案三）作多关键帧。 |
| ⑧ | **Seedance 2.5 能力（已核验）**：30s 单次、多关键帧、≤50 多模态参考、单次扩散无拼接（the-decoder/GIGAZINE，2026-06-23 预览，约 7 月初公测）。**但官方多关键帧 API 规格未公开**（本轮检索：仅非官方客户端；2.0 是 ≤12 参考、Reference-to-Video 端点 role=subject/environment/motion/audio）。 | 多关键帧 content 形状是**唯一必须 GA 实测的未知**（§6），其余可先做。 |

---

## 1. 三模式后端语义（mode → submitMode → payloadMode）

| 用户模式（视频卡，方案五） | submitMode（透传，video-payload-decision.ts:61） | payloadMode | Builder | 2.0 行为 | 2.5 行为（本方案） |
|---|---|---|---|---|---|
| 全能参考(默认) | `auto` | 自动选 | A/B/C 之一 | auto(首帧+多参/首尾帧) | auto，有每镜头帧时选智能多帧 |
| 智能多帧 | `reference_images`（沿用）或新值 | `first_frame_multi_ref`→**新 `multi_keyframe_multi_ref`** | B → **新 C** | 首帧+多参 | **多关键帧+参考图** |
| 首尾帧 | `first_last_frame`(+tailFrameIntent) | `first_last_frame` | A | 2 帧转场 | 2 帧转场（不变） |

要点：
- **"智能多帧"行为随模型能力升级**：2.0=B(reference_images)，2.5=C(多关键帧)。决策点：capability 标记该模型支持多关键帧时，`reference_images`/`auto` 路由到新 payloadMode C；否则退回 B。**同一 submitMode、按 capability 分流**，不新增用户可见模式。
- 全能参考(auto)在 2.5 + 有每镜头选中帧时优先选智能多帧 C；缺帧/2.0 退 B/A。

---

## 2. 智能多帧 payload 设计（核心，Builder C 待探针定形）

按 Agent 扣出的 9 点改动落地（除 Builder C 字段名待 §6 探针）：

1. **新 payloadMode** `multi_keyframe_multi_ref`（video-payload-decision.ts:11）；新容器 `multiKeyframeMode:{ keyframes:[{path, shotUid, orderIndex, atSecHint?}], references:[…] }`（替代只装 2 张的 `firstLastFrameMode`）。
2. **新 `keyframe` role**（video-reference-manifest.ts:11 `VideoReferenceRole` + video-prompt-runtime.ts:13）；`buildReferenceBriefLine`(:272) 加 keyframe 分支（"Image N = 第 k 镜关键帧，约在第 t 秒"）。
3. **executor 读每镜头选中候选帧**（batch-executors.ts:2938 改）：遍历 `groupShotIndices`(:2872) → 对每 shotUid 取 `shotFrames[shotUid].selectedCandidateId` 对应 candidate.url（方案三结构，shot-frame-candidates.ts），**按镜头时序排序**成 keyframe 列表；段首镜头帧仍兼容写 `frames.first`（方案三垫片）保 auto/B/A 路径。
4. **manifest 接受 keyframe 列表**（reference-matcher.ts:385 `addFirstFrameCandidate` → 扩为 `addKeyframeCandidates`，各占 budget 名额、按序 imageNo）+ 资产参考图（character/scene/prop）照旧并入。
5. **Builder C**（video-gen.ts 新增，参考 A :2113 的 body 形状）：现在就按已公开规则（多关键帧 content + 参考图，帧参考带时间点）写好；**字段名按最佳已知形拼 + 留一层适配映射（§6 列了 3 种候选形）**，上线当天一单对齐微调；对不上时该模式临时降级走现成 Builder B（首帧+多参、吃满 50）兜底。
6. **放宽互斥 + 提升 budget（仅对 2.5 model id）**：capability 行给 2.5 设 `modesAreMutuallyExclusive:false`、`referenceBudget:50`、`supportsMultiKeyframe:true`；2.0 不变。
7. **duration**：确认 30 在 clamp（120）内（是）；段 duration = 合并段内多镜头总时长（对齐方案二发车 20-25）。
8. **prompt 块加时序锚点说明**（video-reference-manifest.ts:324 / video-prompt-runtime.ts:150）：告诉模型"Image k 是第 k 镜关键帧、按编号顺序推进"。
9. **首帧硬前置语义**沿用：智能多帧要求"段内至少首镜头有选中候选帧"（等价现 firstFramePath 必填，video-payload-decision.ts:229）。

---

## 3. 发车值翻转（能力派生，2.5 GA 自动生效）

- 方案二已把 `planSegments` 目标窗参数化、源自"激活视频模型能力"。本方案在 **video-provider-capabilities.ts** 给每个 model 声明 `maxSingleGenSec`（2.0=15、2.5=30），`planSegments` 的 `{targetMin,targetMax,hardMax}` 由它派生：
  - 2.0（15s）→ `{4,15}`（现状，零变化）。
  - 2.5（30s）→ `{20,25,25}`（留 5s 余量）。
- **翻转 = 切换激活视频模型到 2.5 时自动发生**（capability 派生），无需手改 segment-planning 常量。同步 `test:segment-planning` 参数化断言（方案二已铺）。
- 注意：发车变 20-25 → 合并段镜头更多 → 智能多帧关键帧数更多（每镜头一帧），与 §2 的 keyframe 列表天然对齐。

---

## 4. 预算上调 + 互斥放宽（仅对 2.5）

- `VIDEO_REFERENCE_IMAGE_BUDGET`（video-reference-manifest.ts:6）从硬常量改为**能力派生**：读激活模型 capability 的 `referenceBudget`（2.0=9、2.5=≤50）。override 点 reference-matcher.ts:539 的 `Math.min(budget,9)` 同步改为 `Math.min(budget, capBudget)`。
- **关键帧 vs 参考图的 50 拆分 = 探针未知**（§6）：是"关键帧+参考图合计 ≤50"还是"各自独立配额"未知；落地前按探针结论定 budget 分配。
- 互斥 `modesAreMutuallyExclusive`（video-provider-capabilities.ts:61）对 2.5 设 false（允许多关键帧+参考图同请求）；2.0 保持 true。**严格按 model id 分流**，不全局改（防 2.0 请求被污染）。

---

## 5. model-routing + capability（可先做、不依赖 GA 行为）

- **白名单加 2.5 model id**（model-routing.ts:68-70）+ 允许 `VIDEO_MODEL` 指向它。
- **capability 行加 2.5**（video-provider-capabilities.ts:78）：`{ maxSingleGenSec:30, referenceBudget:50, supportsMultiKeyframe:true, modesAreMutuallyExclusive:false, bodyShape:'openai_content_array'(待探针确认), verifiedBy:<探针taskId>, verifiedAt }`。
- 这层 + §3 发车派生 + §4 预算派生**可先落**（脚手架），不触发 2.5 真实生成，直到 GA 探针确认 Builder C。

---

## 6. 上线当天的"一单收口"（不阻塞现在动手）

现在就按已公开规则把 Builder C 写好（§2.5）；**Seedance 2.5 一公测，发一条测试视频**对齐下列字段细节即可上线（参照 2.0 验证打法，探针 task `cgt-20260510020416-zrtrs`，video-provider-capabilities.ts:91；对齐后把真实形状记入 capability `verifiedBy`）：

1. **多关键帧 content 字段名**：3 种候选形——(a) content 多个 `role:'keyframe'`+时间戳；(b) 复用 first_frame/last_frame + N 个中间帧带 `at_sec`；(c) 顶层 `keyframes:[{url,at}]`。Builder C 先按最可能的一种写 + 适配层，一单测出真名后切。
2. **多关键帧与 reference_image 可否同请求**：2.0 硬互斥；2.5 官方"50 张多模态含帧参考"，**按可同请求设计**，一单确认。
3. **关键帧时间锚点单位**（秒 / 0-1 / 镜头序号）。
4. **≤50 的拆分**（关键帧+参考图合计还是各算）；单图/体字节上限是否随 2.5 变（现 2.0 单图 27MB / 体 57.6MB，video-gen.ts:1984）。
5. **`return_last_frame` / 30s duration 合法区间**。

> 这一单只读 / 零副作用 / 2 分钟。**它是"上线开关"，不是"开工前提"**——上面 5 条都有合理默认值，现在就能把代码写到位。另：方案三落地后 `shotFrames` 的挂载字段即明确，代码侧无残留未知。

---

## 7. 计费（积分口径，需同步）

- 30s 段 + 多关键帧 + ≤50 参考 → 单次成本显著高于 2.0。`usage-billing`/`credits`（1 元=100 分、成功即扣）需评估：每段视频计费是否随 duration/参考数变。本方案**标注需同步定价**，具体口径并入方案五或单独定（不在此拍死，属横切计费）。

---

## 8. 分期

- **Phase 4-1（现在做）**：加 2.5 model id + capability 行（标 30s/50/支持帧参考）+ 发车能力派生（§3）+ 预算能力派生（§4），全 gate 在 capability、默认仍 2.0。
- **Phase 4-2（现在做，依赖方案三）**：新 payloadMode + keyframe role + executor 每镜头读 shotFrames + manifest keyframe 列表 + **Builder C（按已公开 50/30/帧参考规则 + 适配层写好）** + 互斥/预算放宽（仅 2.5）。
- **Phase 4-3（现在做）**：全能参考 auto 在 2.5+有帧时路由智能多帧；发车 20-25 随能力派生（切模型即生效）。
- **上线当天（Seedance 2.5 公测后）**：① 改一个模型名 env（数字/发车/预算自动切 2.5）；② 发一条测试单对齐关键帧字段名（§6，10 行内微调）；③ 万一没对上，智能多帧临时走 Builder B（首帧+多参、吃满 50）兜底。**代码 4-1~4-3 已就绪，当天只切换 + 收口。**
- 顺序：4-1 →(并) 4-2 → 4-3 →（上线当天）切换收口。

---

## 9. 测试
- `test:video-mode-routing`：submitMode×capability → 正确 payloadMode（2.0 智能多帧=B，2.5=C；首尾帧=A；auto 分流）。
- `test:multi-keyframe-payload`：executor 按 groupShotIndices 取各镜头选中候选、按时序排 keyframe 列表；缺帧退化正确；段首兼容写 frames.first。
- `test:capability-derived-budget-segment`：2.0 预算 9/发车 4-15；2.5 预算 50/发车 20-25；切模型自动变。
- `test:mode-mutual-exclusion`：2.0 首尾帧禁参考图（不变）；2.5 多关键帧+参考图可同请求。
- 回归：`test:segment-planning`（参数化）、`test:video-batch-import-contract`、video-payload-decision 既有断言。
- Builder C 单测在探针确认形状后补。

---

## 10. 验收清单
- [ ] 代码 4-1~4-3 现已就绪、默认 2.0 零变化；上线当天改模型名即切 2.5，一单对齐关键帧字段名后记入 capability verifiedBy。
- [ ] 三模式后端语义正确：全能参考=auto 分流、智能多帧 2.5=多关键帧/2.0=多参、首尾帧=2帧。
- [ ] 智能多帧：片段内每镜头选中候选帧按时序作关键帧 + 资产参考图，1 段 ≤30s 视频；段首兼容下游。
- [ ] 发车随激活模型能力派生（2.0=4-15、2.5=20-25），切模型自动生效，无手改常量。
- [ ] 预算/互斥按 model id 分流：2.0 逐字节不变、2.5 ≤50+可多关键帧。
- [ ] 计费口径已同步评估。
- [ ] 2.0 现网路径**零行为变化**（capability gate）；回归全绿。

---

## 11. 风险与规避
| 风险 | 规避 |
|---|---|
| 2.5 关键帧请求字段名官方未贴 | 现在按已公开规则 + 最佳已知形写 Builder C + 适配层；上线当天一单对齐（10 行内）；对不上时智能多帧走 Builder B（首帧+多参、吃满 50）兜底，不阻塞上线。 |
| 依赖方案三 shotFrames 未落 | 4-2 硬依赖方案三；4-1 脚手架可先行不阻塞。 |
| 改 budget/互斥污染 2.0 | 一切按 model id/capability 分流，2.0 capability 不动，契约测试锁"2.0 零变化"。 |
| 发车翻转牵动下游 | 能力派生 + 方案二参数化断言；切模型才生效、可回切。 |
| 30s 长片计费/超时 | 计费同步评估（§7）；轮询超时（现 15min video-gen.ts:1179）确认对 30s 够。 |
| 智能多帧退化处理 | 缺每镜头帧/2.0 时 auto 退 B/A，不 hardFail（除段首帧缺=现有硬前置）。 |

---

## 12. 给我审 / 待你点头
- **A. 智能多帧 = "每镜头选中候选帧按时序作关键帧 + 资产参考图"**：确认这个语义（关键帧=镜头帧、参考图=角色/道具/场景）。
- **B. 智能多帧行为随能力升级**：确认同一"智能多帧"模式 2.0=首帧+多参、2.5=多关键帧（UI 不变、capability 分流），不另设用户模式。
- **C. 发车/预算能力派生**：确认 2.5 激活即发车 20-25、预算 50 自动生效（不手翻常量）。
- **D. 计费**：30s/多参成本上升的积分口径，并入方案五还是单独定？

---

## Sources
- 代码（本地，行号见正文）：`lib/video-gen.ts`、`lib/video-payload-decision.ts`、`lib/video-reference-manifest.ts`、`lib/reference-matcher.ts`、`lib/model-routing.ts`、`lib/video-provider-capabilities.ts`、`lib/segment-planning.ts`、`lib/visual-reference-state.ts`、`lib/shot-frame-candidates.ts`、`lib/batch-executors.ts`(video_segments executor)、`lib/feature-flags.ts`、`lib/usage-billing.ts`。
- 行业/接口：Seedance 2.5 能力 https://the-decoder.com/bytedances-seedance-2-5-breaks-the-30-second-barrier-for-ai-video-generation/ ，https://gigazine.net/gsc_news/en/20260624-bytedance-seedance-2-5/ ；Seedance 2.0 API（参考/role/≤12，2.5 官方规格未公开）https://docs.byteplus.com/en/docs/ModelArk/1520757 。
