# M1 实现规格 — `lib/scene-views.ts` 场景图解析单源（纯重构，行为不变）

状态：实现规格，待审批后动代码。隶属 `docs/scene-consistency-upgrade-plan.md` 的 M1。
原则：**行为完全不变**。M1 只把"场景图怎么解析/选哪个场景"收口到一个模块，为后续多视图留单一入口。**不**引入多视图、**不**写新字段、**不**碰前端、**不**碰生成、**不**碰角色/道具解析。

---

## 0. 一句话目标
建 `lib/scene-views.ts`，让"取场景图 URL"和"选场景"只有一条路径；现在 3 个场景入口（`sceneUrl` / `assetImageUrl(scene)` / `assetUrl(scene)`）全部 delegate 到它，且输出逐一与今天一致（测试锁死）。

## 1. 现状实锚（读真码，含一处对早期说法的纠正）
**纠正**：不是"三套场景解析器"。实际是——`sceneUrl` 场景专用；`assetImageUrl`、`assetUrl` 是**通用**资产解析器（角色/道具也在用），且二者字段口径本身就不同。M1 只收口"场景入口"，**不动**两个通用函数对角色/道具的行为。

三个场景取图入口的确切口径：

| 函数 | 文件:行 | gate(屏蔽 blocking 状态) | 字段优先级（逐字） | 用途 | 性质 |
|---|---|---|---|---|---|
| `sceneUrl` | scene-selection.ts:41-49 | 否 | `imageUrl ‖ rawUrl ‖ currentUrl(顶层) ‖ realPhotoUrl ‖ coverUrl` | 选场景时 `requireImage` 过滤（:63） | 场景专用 |
| `assetImageUrl` | frame-image-plan.ts:324-335 | 是 | `ref.currentUrl ‖ ref.lastKnownGoodUrl ‖ imageUrl ‖ rawUrl ‖ pencilUrl ‖ realPhotoUrl` | 场景候选/锁文本/plan.scene | 通用(char/scene/prop) |
| `assetUrl` | reference-matcher.ts:76-79 | 是 | `ref.currentUrl ‖ ref.lastKnownGoodUrl ‖ imageUrl ‖ rawUrl ‖ realPhotoUrl ‖ coverUrl` | 视频参考场景候选 | 通用(char/scene/prop) |

差异点：① 是否走 blocking gate（`sceneUrl` 不走）；② `ref.*` 嵌套 vs `currentUrl` 顶层（`sceneUrl` 读顶层 `currentUrl`，另两者读 `reference.currentUrl`）；③ 尾部 `pencilUrl`(assetImageUrl) vs `coverUrl`(assetUrl/sceneUrl)。
实务上场景资产几乎只有 `imageUrl`+`reference.*`，`pencilUrl/coverUrl/顶层currentUrl` 基本不出现——所以三者结果实际一致；但 M1 必须用测试把"一致"钉死，而不是假设。

场景**选择**逻辑（`pickSceneForShots`/`normalizeScenes`/`buildSceneText`）跨仓被三处 import：`frame-image-plan.ts:40`、`reference-matcher.ts:5`、`shot-plan-normalize.ts:1`。

场景取图调用点（M1 要改的）：
- frame-image-plan.ts 的**场景**调用：`:552, :650, :654, :657, :666, :900`（`assetImageUrl(scene/chosenScene)`）。**不改** `:352`(通用 identity)、`:708/:733/:881`(char)、`:765/:909`(prop)。
- reference-matcher.ts 的**场景**调用：`:649, :696, :699`（`assetUrl(scene)`）。**不改** `:106`(通用)、`:580`(char)、`:735`(prop)。

## 2. 新模块 `lib/scene-views.ts` API（M1 版）
```ts
// 视图角色（M1 仅定义类型，运行时只用到 establishing）
export type SceneViewRole = 'establishing' | 'reverse' | 'alt' | 'topdown';

// 单源场景取图。M1 不读 views[]，只复现今天的单图口径。
// gate=true: 走 resolveAssetReferenceState + isBlockingReferenceStatus（复现 assetImageUrl/assetUrl）
// gate=false: 不屏蔽（复现 sceneUrl 在 requireImage 过滤里的行为）
export function resolveSceneImageUrl(scene: any, opts?: { gate?: boolean }): string;

// 选某镜头该用的视图。M1 stub：恒返 establishing（= resolveSceneImageUrl(scene,{gate:true}) + role:'establishing'）。
// 签名先就位，M2/M3 才按 primaryShot.angle 真正分流。
export function pickSceneView(scene: any, primaryShot?: any): { url: string; role: SceneViewRole };

// 场景选择：从 scene-selection.ts 整体迁入（函数体不变）
export function normalizeScenes(input, opts?): NormalizedScene[];
export function pickSceneForShots(input, opts?): SceneSelectionResult;
export function buildSceneText(shots): string;
export type { NormalizedScene, SceneSelectionResult, SceneSelectionSource };
```
- `resolveSceneImageUrl` 内部统一字段顺序（超集，复现三者）：
  `ref.currentUrl ‖ ref.lastKnownGoodUrl ‖ imageUrl ‖ rawUrl ‖ realPhotoUrl ‖ coverUrl ‖ pencilUrl ‖ currentUrl(顶层)`；`gate=true` 时先过 `isBlockingReferenceStatus` 返 ''。
- 复用现成 `resolveAssetReferenceState`/`isBlockingReferenceStatus`（`visual-reference-state.ts`），不复制状态逻辑。

## 3. delegate 改法（精准，按文件:行）
1. **scene-selection.ts → 迁入 scene-views.ts + 留再导出壳**
   - 把 `normalizeScenes`/`pickSceneForShots`/`buildSceneText`/`sceneUrl` 及类型整体移到 `scene-views.ts`（函数体不变）。
   - `sceneUrl` 内部改为 `resolveSceneImageUrl(scene, { gate:false })`。
   - `scene-selection.ts` 改为 `export { pickSceneForShots, normalizeScenes, buildSceneText } from './scene-views'`（连同类型）。→ 三处 import（frame-image-plan / reference-matcher / shot-plan-normalize）**零改动**。
2. **frame-image-plan.ts**：把**场景**调用 `:552,:650,:654,:657,:666,:900` 的 `assetImageUrl(...)` → `resolveSceneImageUrl(..., { gate:true })`（import from scene-views）。`assetImageUrl` 函数保留（仍服务 char/prop 及 `:352` 通用），其它调用点不动。
3. **reference-matcher.ts**：把**场景**调用 `:649,:696,:699` 的 `assetUrl(...)` → `resolveSceneImageUrl(..., { gate:true })`。`assetUrl` 保留（char/prop/通用），其它不动。

## 4. 行为等价保证 + 测试
- 新增 `scripts/test-scene-views.(mjs|js)` + `npm run test:scene-views`，断言：
  - 对一组代表性 scene 形状（只有 imageUrl / 有 reference.currentUrl / reference.status=missing|failed / 只有 rawUrl / 带 coverUrl / 带顶层 currentUrl / 空）——
    - `resolveSceneImageUrl(s,{gate:false})` == 旧 `sceneUrl(s)`；
    - `resolveSceneImageUrl(s,{gate:true})` == 旧 `assetImageUrl(s)` 且 == 旧 `assetUrl(s)`（对**场景**输入）；差异形状（pencilUrl-only / coverUrl-only / 顶层 currentUrl-only）单列断言，确认为有意收敛且不影响真实场景数据。
  - `pickSceneView(s).url` == `resolveSceneImageUrl(s,{gate:true})`，role=='establishing'。
- 扩展（不新建并行套件）：`test:frame-image-plan`、`test:video-reference-manifest` 跑现有用例，断言 referenceManifest / sceneReferencePath **快照不变**（行为不变的硬证据）。
- `npx tsc --noEmit` 通过。

## 5. 风险与边界
- **唯一行为风险**=场景在 `pencilUrl-only / coverUrl-only / 顶层currentUrl-only` 这种极端形状下三函数本就不一致；M1 用超集顺序收敛并以测试证明真实场景数据不受影响。若测试发现真有这种数据，停手单独议。
- 两个通用解析器 `assetImageUrl`/`assetUrl` 彼此口径不同（pencilUrl vs coverUrl）**对 char/prop 依旧存在**——M1 **不**统一它们（会动到非场景行为）。是否统一为另一独立小重构，单列待批，不在 M1。
- `import map`/前端/版本：M1 纯后端，无前端改动，无需 bump。

## 6. M1 明确不做
多视图生成、`views[]`/`viewHistory` 写入、按 angle 选视图、topdown 锚、prompt 改写、计费改动、前端卡片、双写 environments 的新字段——全部 M2+ 再做。M1 只交"单一入口 + 行为不变"。

## 7. 验收
`tsc` 0 错；`test:scene-views` 绿；`test:frame-image-plan` / `test:video-reference-manifest` 快照不变绿；人工抽查若干项目首帧/视频参考的场景图 URL 与改前一致。可独立回滚（删 scene-views.ts、还原三处 delegate、scene-selection.ts 复原）。
