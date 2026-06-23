# 图片局部修改（gpt-image-2 mask edit）— 方案 v2

状态：v2 方案 + V1 探针结果（见 §I）。**V1 实锤：Zerail 通道 gpt-image-2 的 mask 不做区域 inpainting；Mode① 引擎大概率改 mask 原生模型，待 V1.1 排除 transport 混淆**。仅方案，不改代码。HEAD `f9775cc`。日期 2026-06-23。
方向决策来源：Vasily 拍板「完整档（brush + 智能点选 SAM）+ 全 5 环节 + 一期不强保框外；双模式弹窗；编辑结果自动设为当前+可回退；帧用独立共享弹窗；翻转进弹窗」。
分工：**Codex 执行（探针 + 开发），Claude 制定/审查方案 + 验收结果**。

---

## 已锁定决策
1. 模型 = `gpt-image-2` 的 `/images/edits` + **mask**。**复用现有 `image` 模型角色，零新角色**（governance L50 该角色本就含 "Image generation/editing"，L107 `IMAGE_EDITS_ENDPOINT` 是既定生产配置）。**⚠ V1 更新（§I）：此通道 mask 不生效；Mode① 引擎待定（大概率换 mask 原生模型），但仍复用 `image` 角色框架——换的是 model-routing 里的 provider/model 配置，不动架构。**
2. 一期范围 = **完整档**：brush 涂抹 + 智能点选（SAM）+ **全 5 环节**（角色 / 场景 / 道具 / 首帧 / 尾帧）都有入口。
3. 框外保真 = **一期不强保**，直接用模型 edits 结果；"服务端 mask 贴回合成"列为二期增强（M5）。
4. 架构 = **统一一个"局部修改服务"（共享后端 + 共享弹窗）+ 每环节一个极薄 adapter**；**不统一历史**。
5. 编辑结果 = **一张新图，自动归档旧图 → 设为当前 → 新图同时在历史可回退**（你的点 4）。
6. 弹窗 = **双模式**：①涂抹/点选「局部 mask 改」 ②整图「文字描述改」（无 mask，≈ 现有 `useEdit` 路径，覆盖你借鉴的"文字"）。
7. 帧（首/尾帧）= **用独立共享弹窗**，与其余环节体验一致；FFE 维持原样管"重新生成 / AI 重写 / 参考选择"。
8. 翻转（左右/上下）= 进**同一弹窗当快捷动作**，走服务端纯 **transform op（无模型调用、不计费）**，产出新图入历史。
9. 编辑通道**禁用 Seedream fallback**（Seedream mask 路径未知，回退会忽略 mask）；只在 gpt-image edit 通道内重试。
10. 全功能挂 **`IMAGE_EDIT_ENABLED`** 开关，分阶段放量。
11. `adapter.getHistory()` 把三套异构历史**归一成统一展示态** `{url, at, label}` 喂弹窗右栏；写回仍各走各的。
12. 不做老兼容（沿用你一贯原则）。

---

## A. 实证结论（已读真实代码，替代一切推断）

### A.1 图片生成早就是统一模块——"每环节加一遍"的担忧不存在
五环节最终都走唯一入口 `lib/image-gen.ts › generateImage()`（L196）→ `generateRealImageBuffer()`（L403），零重复。
- 角色/场景/道具：`asset_images` executor（`lib/batch-executors.ts:1048`）
- 首帧/分镜：`storyboard_images`（`batch-executors.ts:1739`）
- 尾帧：`tail_frame_images`（`batch-executors.ts:2267`）
**新功能照此模式做即可。**

### A.2 "局部修改"的后端管线已经接了一半（核心利好）
`image-gen.ts:540-565` 已有 `useEdit` 分支：把参考图用 multipart 发到 `cfg.imageEditEndpoint || '/images/edits'`，默认模型就是 `gpt-image-2`。
- `useEdit = 有参考图 && 模型支持`（`editSupported` = model 含 `gpt-image` / `dall-e-2`，L433-437）✅ gpt-image-2 命中。
- **缺的就一处**：FormData 里只 `append` 了 `model/prompt/size/n/quality/image`（L551-559），**没有 `mask` 字段**。加 mask = 在 L559 后多 append 一个 mask blob。
- `model-routing.ts` 已认 `imageEditEndpoint`（governance L107 `IMAGE_EDITS_ENDPOINT="/images/edits"`）。

### A.3 历史是三套异构结构 + 两套"设为当前"机制——**不要去统一**
| 环节 | 历史字段 | 快照内容 | 设为当前 | 前端历史 UI |
|---|---|---|---|---|
| 资产（角色/场景/道具） | `item.imageHistory`（≤20，`project.js:_archiveOldImage`≈891） | 多 URL + `info` 字段快照 | `_setHistoryAsCurrent`（`main.js:438`）→ 整包 PUT | 全屏模态 `_openAssetHistoryModal`（`main.js:621`） |
| 首帧 | `firstFrame.history`(+`frames.first.history` 镜像，≤20) | URL + prompt/mode/sourceHash 元数据 | `/api/frames/set-current-from-history` | 无独立入口（仅在 FFE 内） |
| 尾帧 | `tailFrameHistory`（无上限） | 仅 URL | `/api/frames/set-current-from-history`（`frameType:'tail_frame'`） | 浮窗 `show-tail-history`（`storyboard.js:3384`） |

强行合并 = 高风险大改，违背"不动共享口径"。**正解：统一"编辑"，不统一"历史"**（见 §C）。

### A.4 首帧编辑器（FFE）可直接复用为弹窗壳
- 入口按钮：`data-action="edit-first-frame"`（`storyboard.js:3383`，icon `tune`）→ `_openFirstFrameEditor(gIdx)`（5756）→ `GET /api/frames/plan` → `_renderFirstFrameEditor`。
- 三栏壳 `_ffeModalHtml()`（4196-4240）：**左**=生成上下文/参考图，**中**=图片预览 + 操作按钮（下载/恢复初始/重新生成）+ 提示词 + AI 重写，**右**=历史列表。
- 关闭 `_closeFirstFrameEditor()`（5718）带自动保存 flush + 锁页滚动。
- 局部修改弹窗 = 套这个三栏壳，**把中栏换成 mask 画布**。

### A.5 前端零画布——需从零做
全仓无任何 canvas/brush/mask 绘制 UI（已确认 storyboard.js / *_custom.js / 全模块）。
图片显示走 `hydrateProtectedImageElements()`（`utils.js:1137`）处理签名 URL + Bearer，避免 401——画布载入 source 图直接复用。

### A.6 计费 / 存储 / 签名全可复用
`generateImage` 内已闭环：落盘 `data/images/{uid}/{id}.png` + `images` 表 INSERT + `createAssetRecord()` + `recordUsageEventAndSettleCharge()`（`consumptionType:'image_count'`，**成功才扣、失败不扣**，1 元=100 分向上取整）。签名 `buildSignedImageUrl()`（`signed-asset-url.ts:45`，HMAC）。

### A.7 服务端已装 `@napi-rs/canvas`
`lib/video-gen.ts:391` 的 face-mask + Seedream 参考图预处理都在用。→ **二期 mask 贴回合成 / mask 尺寸规格化无需新依赖**。

---

## B. 行业事实（已查证，替代推断）

- **B.1** `gpt-image-2`（2026-04-21 发布）`/images/edits` 支持 mask 局部编辑 + outpainting；接受「一或多张图 + prompt + mask」。
- **B.2** mask 规格：PNG、**须与原图同尺寸**、<4MB；多图时作用于第一张。OpenAI 官方口径=**透明区(alpha=0)=要编辑区**，其余保留；三方文档另有"白=改/黑=留"的反向描述——**以探针 V2 实测为准**。
- **B.3** gpt-image 的 mask 是**软蒙版**（prompt 引导，非像素级硬替换），实测会顺手改动框外光照/纹理/他物，不保证逐像素——这正是"一期不贴回"的已知代价（M5 兜底）。
- **B.4** 点选选区 = 分割模型（SAM2 / MobileSAM）。生产标准做法：**图载入时算一次 image embedding，点击时跑轻量 decoder 实时出 mask**（可客户端 ONNX+WebGPU，或服务端）。
- **B.5** 边缘最干净的是 mask 原生模型（Flux Fill / Ideogram，mask 直接进模型）——列为后续 provider 备选，`model-routing` 切换成本低。

---

## C. 架构：统一编辑，不统一历史

```
卡片"局部修改"按钮(每环节)
      │  传入该环节 adapter
      ▼
[共享] 局部修改弹窗 image_patch_editor.js  ── 套 FFE 三栏壳
   左: 原图+上下文   中: mask 画布(mask_canvas.js)+提示词   右: 该环节历史(adapter 读)
      │  source 图 + mask(PNG, 编辑区 alpha=0) + prompt
      ▼
[共享] POST /api/images/edit ─► lib/image-gen.ts editImage()
   = useEdit 分支 + fd.append('mask', blob)  → /images/edits (gpt-image-2)
   → 落库 images + createAssetRecord + 签名 + 计费(image_count, feature='image_edit')
      │  返回 {id, signedUrl} = 一张新图
      ▼
[每环节] adapter.onEdited(newImage)
   资产 → _archiveOldImage + imageHistory + 设为当前
   首/尾帧 → /api/frames/set-current-from-history
      ▼
   弹窗右栏历史刷新（新图已在列，可再切回）
```

### C.1 共享后端（一份）
- 新路由 `app/api/images/edit/route.ts`（POST）：入参 `{ sourceImageId | sourceUrl, maskPngBase64, prompt, context:{ env, projectId, entityRef } }` → 出参 `{ id, signedUrl }`。
- `lib/image-gen.ts` 新增 `editImage(user, input)`（或给 `generateImage` 加 `maskPath`）：复用 `useEdit` 分支，source 图作唯一 ref，在 L559 后 `fd.append('mask', new Blob([maskBuf],{type:'image/png'}), 'mask.png')`；走 moderation recovery（`safe-image-gen`）、落库、签名、计费。
- **复用 `image` 角色**（`IMAGE_*`），业务码只认 `modelRole`，**零硬编码 model/endpoint/key**（合规 governance §Change Workflow）。
- 编辑通道**禁用 Seedream fallback**（mask 路径未知，回退会忽略 mask）；全功能挂 **`IMAGE_EDIT_ENABLED`** 开关。
- 翻转走同路由的 **transform op**（server `@napi-rs/canvas` 翻转，无模型调用、**不计费**）。
- **尺寸约束（V3 验证）**：mask 必须 = source 尺寸；gpt-image 出图尺寸受限（1024² / 1024×1536 / 1536×1024 / auto）。需把 source 归一到受支持尺寸再发，mask 同步缩放。

### C.2 适配层（每环节 ~十几行）
统一 adapter 接口（参数化弹窗）：
```ts
interface PatchAdapter {
  env: 'character'|'scene'|'prop'|'first_frame'|'tail_frame';
  entityRef: string;
  getCurrent(): { imageUrl: string; width: number; height: number; contextSummary: string };
  getHistory(): Snapshot[];          // 读该环节自己的历史
  buildPromptContext(): string;       // 该环节风格/参考上下文
  onEdited(newImage): Promise<void>;  // 调该环节现成归档→入历史→设为当前
}
```
- 资产 adapter → `_archiveOldImage` + `_setHistoryAsCurrent` + `imageHistory`
- 首帧 adapter → `firstFrame.history` + `/api/frames/set-current-from-history`
- 尾帧 adapter → `tailFrameHistory` + `/api/frames/set-current-from-history`

→ **一套弹窗 + 五份十几行适配**，blast radius 最小。

### C.3 共享弹窗 + 画布（新模块）
- `public/modules/image_patch_editor.js`：弹窗，套 FFE 三栏壳。
- `public/modules/mask_canvas.js`：brush / 橡皮 / 画板缩放平移 / 清除 / 撤销；导出与 source **同尺寸** PNG（编辑区 alpha=0）。
- `public/modules/smart_select.js`：SAM 层（懒加载，见 §D），点选→mask 注入 `mask_canvas`。
- 卡片按钮：各环节加 `data-action="patch-image"`（首帧紧挨 `edit-first-frame`@3383；资产卡按钮/菜单区；尾帧按钮区）。
- 左右/上下翻转：见 §C.4（走服务端 transform op，不计费），**不与 mask 编辑塞进同一次提交**。

### C.4 弹窗两种模式 + 翻转 + 结果落地（自动设为当前）
- 模式①「局部 mask 改」：涂抹/点选出 mask → `POST /api/images/edit`（带 mask）。
- 模式②「整图文字改」：不画 mask、纯文字 → 同路由不带 mask（≈ 现有 `useEdit`），整图按文字重绘。
- 翻转：客户端预览即时翻，提交走 `/api/images/edit` 的 **transform op**（server `@napi-rs/canvas` 翻转，无模型调用、不计费），产出新图。
- 结果落地（自动设为当前）：出新图后 `adapter.onEdited` 统一执行「**归档旧图 → 设新图为当前 → 新图入历史可回退**」。
  - 资产：`_archiveOldImage`(当前) + 写 `imageUrl` 等 + push `imageHistory`。
  - 帧：现有 `/api/frames/set-current-from-history` 是"从历史选"；**把全新 URL 设为当前**需确认/补一个入口（或复用 regen 的归档落点）——Codex M2 落地时确认。

---

## D. SAM 智能点选（一期最重，独立可插拔）
- 设计成 brush **之上的"选区生成器"**：点选只负责产出一张 mask 注入画布，brush 仍可二次修整。→ **工程上 brush 先跑通，SAM 后插，不阻塞主线**。
- 推荐路径：SAM2 / MobileSAM，图载入时算一次 embedding，点击 decoder 实时出 mask。
- **基建三选一（V4 先定才排期 M4）**：
  1. 客户端 ONNX + WebGPU（MobileSAM）——零服务端 GPU，依赖浏览器算力；
  2. 托管分割 API（fal / Replicate SAM2）——按次计费，最省事；
  3. 服务端自跑——需 GPU（Origin 现全 API 化、未见自有 GPU，成本最高）。
- 兜底：若 M4 基建未就绪，brush + 全环节先上线，SAM 作为同弹窗内紧跟增强（不改方向，纯加层）。

---

## E. 分阶段落地清单
- **M1 后端编辑能力**（不动前端）：`editImage` + `/api/images/edit` + mask append + 翻转 transform op（不计费）；禁 Seedream fallback；`IMAGE_EDIT_ENABLED` 开关；计费 `image_edit`（复用 `image_count` 价）；moderation；source 尺寸归一。契约测试 `test:image-edit`（multipart 含 mask / 失败不扣 / 返回签名 URL）。
- **M2 共享弹窗 + brush 画布**（含双模式切换 + 翻转；先挂 1 个环节=首帧，因 FFE 最近）：`image_patch_editor` + `mask_canvas` + 首帧 adapter；import map 加条目。
- **M3 全环节铺开**：资产×3 + 尾帧 adapter + 五处卡片按钮。
- **M4 SAM 智能点选**：按 V4 定的基建路径接 `smart_select.js`。
- **M5（二期）**：服务端 mask 贴回合成（`@napi-rs/canvas` 羽化）作为"框外保真"开关。

---

## F. 待验证探针（动手前，实测优先；沿用 feedback_vasily_verify_against_real_code）
- **V1** Zerail 中转是否把 mask 透传给 gpt-image-2（行业有网关静默吞 mask 的前科）——真图打一发带 mask 的 `/images/edits`，看框外是否响应。**这是整个方案的总闸，先验。**
- **V2** mask alpha 约定实测（透明=改 vs 白=改），以实测覆盖文档。
- **V3** 出图尺寸：source 各尺寸（如 1080×1440）能否原样 edit，还是必须归一到 1024×1536；mask 同步缩放是否对齐。
- **V4** SAM 基建三选一（§D）——定了才动 M4。
- **V5** 计费口径：`image_edit` 复用 `image_count` 价 vs 单列消费类型（按 CLAUDE.md 后台纪律，先登记 `docs/admin-metrics-registry.md` 再上页）。

---

## G. 落地纪律（沿用现有制度）
- 前端：新模块裸 import + import map 单源加 `?v`；改 `main.js` bump html 标签；改完 `npm run verify:frontend`。
- 模型：复用 `image` 角色；跑 governance §Hardcode Scan + `npx tsc --noEmit`，业务路由不硬编码 model/endpoint/key。
- 后台：若新增 `image_edit` 计量口径，先登记 `docs/admin-metrics-registry.md` + `npm run test:admin-metrics`。
- 不写老数据迁移 / 兼容；最小 blast radius（不动 `generateImage` 既有签名行为、不统一历史口径）。

---

## H. 工作量 / 风险一句话
- 最确定、最快：**M1 后端**（地基已半成，加 mask + 计费即可）。
- 最重 / 最不确定：**M4 SAM 基建**（V4 未定前别排期）。
- 最大产品风险：**软蒙版框外被动**（一期接受，M5 兜底）。**← 已被 §I 超越：实测 mask 根本不做区域编辑，风险升级为"引擎换型"。**

---

## I. V1 探针结果与方向修正（2026-06-23，已验收看真图）
探针 `scripts/probe-image-edit-mask.js`，产物 `tmp/probe-image-edit/2026-06-23T09-30-19-270Z/`。我已扣脚本 + 逐张看真图验收。

**实测（gpt-image-2 / Zerail `/images/edits` / `image[]` transport / 看图坐实）**：
- mask 被接受（A/B/C 全 HTTP 200，无 unknown parameter），但**不做区域 inpainting**：mask A（右半透明=应编辑区）的输出 = 左半被画上鸭子、**右半整块变黑**（透明区被当 alpha 抠图销毁，不是"在此重绘"）；B（黑白不透明）≈ 无 mask 的 C。
- 框外不仅没保护，A 左半 diff 45.71 反而高于对照 C 的 32.77（1.39x）。
- **结论：mask 在这条通道上不可直接用于局部编辑。**

**验收发现一个混淆变量（须先排除再下定论）**：探针把 source 当 `image[]`（Origin 多参考的 bracket 传输）发，**不是** OpenAI mask 语义期望的单 `image` 字段。"透明区变黑、编辑落在不透明区"高度像 image/mask 错配。→ **V1.1：改单 `image` 字段重跑**（探针已支持 `--image-field image`）先排除。

**好消息**：① 整图无 mask 编辑（Mode ②「文字改」）工作正常；② 竖图 1024×1536 原生 200、出图同尺寸无报错（V3 竖图基本解决，1080×1440 归一到 1024×1536 即可）。

**方向修正（大概率）**：结合行业实测（gpt-image 系列 mask 本就软/不可靠），即便 V1.1 排除混淆，Mode① 精确局部编辑**大概率要把引擎从 gpt-image-2 换成 mask 原生模型**（Flux Fill / Bria / SDXL-inpaint，经 fal/Replicate）。**关键：这只换 `image` 角色下的 provider/model（model-routing 一处），共享编辑服务 + adapter + 弹窗 + 画布 + SAM 架构全不受影响**；Mode② 继续用 gpt-image-2。
→ **M1 暂缓**；先做 V1.1，必要时 V1.2 探一条 mask 原生通道（需 Vasily 提供 fal/Replicate/直连 OpenAI 其一的 key）。
