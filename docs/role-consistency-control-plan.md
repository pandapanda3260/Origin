# 生成逻辑 P0：角色一致性完整控制方案

## 1. 背景与目标

当前 Origin 的生产链路已经具备完整的视频生成闭环：

1. 剧本生成：`script/workflow/*`
2. 风格圣经提取：`SP_STYLE_BIBLE`
3. 资产抽取：角色、场景、道具三段式抽取
4. 角色参考图生成：`asset_images` executor，角色图生成后切分 `headshot/front/side/back` panel
5. 镜头设计：`SP_SHOTS_GENERATE`
6. 分镜 / 首帧生成：`storyboard_prompts`、`storyboard_images`
7. 视频提示词生成：`SP_VIDEO_PROMPT_GENERATE`
8. 视频片段生成：`video_segments` executor，向 Seedance 注入台词、声音 roster、前后片段衔接、多参考图规则
9. 相邻连续性检查：`/api/continuity/check-adjacent`

现有系统已经有角色一致性的若干基础能力，例如：

- 资产抽取阶段有 `appearance / clothing / equipment / temperament / actionTraits / entityType`。
- 角色参考图强制真人四栏或非人三栏设定图。
- 生成角色图后会切分 panel，视频阶段可按镜头意图选择 headshot/front/side/back。
- Seedance prompt runtime 已有“角色声音/形象锁”“独立多参考图编号”“非人角色不能画成人”等硬规则。
- 相邻片段连续性检查已覆盖角色服装、位置、动作状态、手持物突变。

P0 的目标不是重做链路，而是在现有链路上建立一套“角色主档 + 生成门控 + 提示词注入 + 生成后质检 + 变更传播”的闭环，让同一角色在剧本、资产、分镜、首帧、视频提示词、视频片段中保持稳定。

## 2. 当前代码现状判断

### 2.1 已有能力地图

| 能力 | 当前落点 | 现状判断 |
| --- | --- | --- |
| 角色结构化抽取 | `app/api/assets/extract/route.ts`、`SP_ASSET_CHARACTERS_EXTRACT` | 已有 `role / identity / entityType / appearance / clothing / equipment / temperament / actionTraits / imagePrompt`，字段足够支撑角色主档。 |
| 角色参考图强约束 | `lib/image-gen.ts` 的 `forceStyleSuffix(kind="character")` | 真人四栏、非人三栏已经有强规则，是角色视觉锁的底座。 |
| 角色 panel 切分 | `lib/character-panels.ts`、`app/api/assets/split-character-panels/route.ts` | 已能从角色设定图切出 `headshot/front/side/back`，可用于按镜头景别选参考。 |
| 镜头角色识别 | `SP_SHOTS_GENERATE`、`buildShotsMessages` | `shots[].characters` 已存在，但目前主要是名字数组，缺少稳定 id 和别名归一。 |
| 按镜头选择角色参考 | `lib/panel-selection.ts` | 已按特写/全身/侧面/背面/群像选择 panel，但匹配基于 name/role，缺少 characterId 与版本记录。 |
| 视频提示词引用资产 | `buildVideoPromptMessages`、`app/api/video-prompt/generate/route.ts` | 已把角色、场景、道具传给 LLM，也会保存 `videoReferenceManifest`，但角色描述仍是临时拼接，不是权威主档。 |
| 视频生成参考图 | `lib/batch-executors.ts` 的 `video_segments` | 已接入首帧、场景图、角色图/角色 panel、道具图、独立多图 reference，是视频一致性的关键入口。 |
| 台词与声音锁 | `lib/video-prompt-runtime.ts` | 已有 dialogueBlock 和 voiceBlock，能避免说话人名字被念出，并要求同名角色跨片段声音一致。 |
| 相邻连续性检查 | `app/api/continuity/check-adjacent/route.ts` | 已检查相邻片段的场景、角色、道具、镜头突变，但结果还没有成为生成前的统一门控。 |
| stale / obsolete | `app/api/orchestration/compute-stale/route.ts`、`detect-obsolete/route.ts` | 目前仍返回空数组，是角色修改后下游不可靠的主要缺口。 |

### 2.2 核心缺口

当前问题不是“没有提示词规则”，而是“规则没有一个统一权威源”。具体表现：

- 角色身份靠 `name` / `role` 字符串串联，缺少稳定 `characterId`，一旦出现别名、改名、同名，后续匹配会漂。
- `assets.characters[]` 既是用户编辑态，又被下游当生成权威态使用；缺少“锁定版本”和“当前编辑版本”的边界。
- 角色参考图、panel、视频 prompt、视频片段没有记录“使用了哪个角色版本”，所以无法判断是否过期。
- 视频提示词生成时虽然传了资产，但没有强制“本组所有出场角色必须完整进入角色段”。
- Seedance final prompt 有声音锁和参考图锁，但没有独立的 `characterLockBlock`，角色权重会被用户 prompt 或模型联想稀释。
- 相邻连续性检查是事后/独立能力，尚未和批量视频生成前的 blocker 体系打通。
- stale 传播未实现，用户改角色后，系统无法准确提示哪些分镜、提示词、视频必须重生。

### 2.3 设计原则

角色一致性方案必须遵守四个原则：

- **一个权威源**：所有下游只认 `CharacterLock`，不再临时从剧本、prompt、参考图描述里重造角色。
- **每步可追溯**：分镜、videoPrompt、videoSegment 都要记录使用过的 `characterId + 分维版本`。
- **高成本前阻断**：视频生成前必须做本地一致性门控，blocker 不过不提交视频任务。
- **允许创作变化，但要显式声明**：换装、变身、时间跳跃可以存在，但必须形成新版本或剧情变化记录，而不是悄悄漂移。

## 3. P0 范围

### 3.1 必须解决的问题

P0 只处理会直接破坏成片观感和可用性的角色一致性问题：

- 同一角色外貌、脸型、年龄、体型在不同镜头漂移。
- 服装、配饰、手持物在无剧情依据时突然变化。
- 非人 / 拟人角色被画成真人，或体型比例明显失控。
- 视频提示词遗漏角色主档信息，导致模型自行重塑角色。
- 同名角色跨片段声音、性别、年龄段、语气不稳定。
- 镜头角色列表、台词说话人、画面实际角色不一致。
- 用户修改角色后，下游分镜、视频提示词、视频没有被正确标记为需更新。

### 3.2 暂不进入 P0 的问题

- 复杂表演连续性，例如每一帧手势完全承接。
- 多季 / 多项目 IP 级角色资产库。
- 基于视觉模型的真实视频画面人脸比对。
- 自动重生失败片段的完整工作流编排。
- 多角色声音克隆或固定 voice id 接入。

## 4. 总体方案

建立 `Character Consistency Ledger`，简称角色一致性账本。账本不是新业务页面，而是挂在项目 JSON 内的一层结构化控制数据，由现有流程读写。

核心原则：

- 角色一旦进入资产阶段，就生成稳定 `characterId`，后续所有镜头、台词、参考图、视频 prompt 都用该 id 关联。
- `assets.characters[]` 仍是用户可编辑的业务资产，`consistency.characters[]` 是生成控制层的“锁定版主档”。
- 下游生成只能引用角色主档，不允许从剧本文本里临时重新发明角色。
- 用户每次修改角色外貌、服装、装备、物种类型，都必须提升对应分维版本并标记下游 stale。
- 每个生成环节都输出可审计的 consistency diagnostic，说明用了哪些角色锁、跳过了哪些锁、原因是什么。

## 5. 数据结构设计

建议在项目 JSON 顶层增加：

```ts
type ProjectConsistency = {
  schema: 'origin-consistency-v1';
  updatedAt: string;
  characters: CharacterLock[];
  diagnostics?: ConsistencyDiagnostic[];
};

type CharacterLock = {
  characterId: string;
  sourceAssetId?: string;
  canonicalName: string;
  aliases: string[];
  versions: {
    identityVersion: number;    // 名字、身份、entityType、species 等影响角色是谁
    visualVersion: number;      // 外貌、服装、装备、比例、参考图等影响画面
    performanceVersion: number; // 气质、动作习惯、表演倾向等影响 prompt，不要求重画角色图
    voiceVersion: number;       // 音色、年龄段、口音、语气等影响配音
    resolverVersion: number;    // aliases / mention 解析规则，不直接让画面 stale
  };
  status: 'draft' | 'locked' | 'needs_review';

  identityLock: {
    role: string;
    identity: string;
    entityType: 'human' | 'non-human';
    species?: string;
    gender?: string;
    ageBand?: string;
  };

  visualLock: {
    appearance: string;
    clothing: string;
    equipment: string;
    scaleRule?: string;
    negativeRules: string[];
    signatureColors?: string[];
    canonicalPrompt: string;
    visualSignatureHash: string;
  };

  performanceLock: {
    temperament: string;
    actionTraits: string;
    gestureRules: string[];
    performanceSignatureHash: string;
  };

  voiceLock: {
    voiceGender?: string;
    voiceAge?: string;
    timbre?: string;
    speechStyle?: string;
    accent?: string;
    negativeRules: string[];
    voiceSignatureHash: string;
  };

  referenceLock: {
    sheetUrl?: string;
    headshotUrl?: string;
    frontUrl?: string;
    sideUrl?: string;
    backUrl?: string;
    sourceImageId?: string;
    referenceStatus: 'missing' | 'ready' | 'degraded';
    qualityScore?: number;
    referenceVersion: number;
  };
};

type ConsistencyDiagnostic = {
  stage: 'assets' | 'shots' | 'storyboard' | 'video_prompt' | 'video_segment' | 'continuity';
  target: string;
  characterId?: string;
  severity: 'info' | 'warn' | 'block';
  code: string;
  message: string;
  createdAt: string;
};
```

### 5.1 字段来源

| 字段 | 来源 |
| --- | --- |
| `canonicalName / aliases` | 资产抽取角色名 + 剧本中别称 + 用户手动编辑 |
| `identityLock` | `SP_ASSET_CHARACTERS_EXTRACT` 输出 |
| `visualLock` | `appearance / clothing / equipment / entityType` + 图像 prompt 兜底规则 |
| `performanceLock` | `temperament / actionTraits` |
| `voiceLock` | 由角色身份、年龄、气质自动推断，用户后续可编辑 |
| `referenceLock` | `asset_images` 生成结果 + `splitCharacterPanels` 输出 |
| `visualSignatureHash / performanceSignatureHash / voiceSignatureHash` | 分维度 canonical 后稳定 hash 生成 |

### 5.2 版本维度与 stale 语义

不能使用单一 `lockVersion`。角色字段变化的语义不同，下游依赖也不同：

| 版本 | 触发字段 | 影响范围 |
| --- | --- | --- |
| `identityVersion` | `canonicalName / role / identity / entityType / species / gender / ageBand` | mention 解析、镜头角色表、视频提示词、非人/真人硬规则；`entityType/species` 变化会同时触发 visual stale。 |
| `visualVersion` | `appearance / clothing / equipment / scaleRule / signatureColors / negativeRules / referenceLock.referenceVersion` | 角色参考图、首帧、分镜参考、videoPrompt 角色段、videoSegment。 |
| `performanceVersion` | `temperament / actionTraits / gestureRules` | 只影响 videoPrompt 和 videoSegment，不要求重画角色参考图。 |
| `voiceVersion` | `voiceGender / voiceAge / timbre / speechStyle / accent` | 只影响 videoSegment 的配音与口型规则，通常不影响首帧和角色图。 |
| `resolverVersion` | `aliases`、人工别名、mention case 库规则 | 只影响解析和诊断缓存；不直接让已有视觉产物 stale。 |

下游产物必须声明依赖哪些版本。例如：

- 角色参考图依赖 `identityVersion + visualVersion`。
- 分镜 / 首帧依赖 `identityVersion + visualVersion`。
- 视频提示词依赖 `identityVersion + visualVersion + performanceVersion + resolverVersion`。
- 视频片段依赖 `identityVersion + visualVersion + performanceVersion + voiceVersion + referenceVersion`。
- aliases 单独变化只清 mention cache，不标记视频 stale；除非重新解析后发现 group 角色映射发生变化。

### 5.3 signatureHash canonical 规则

hash 只用于判断语义版本，不允许因为换行、空格、标点微调造成全链路过期。生成 hash 前必须 canonicalize：

- 字段按固定白名单取值，不 hash 整个对象。
- 字符串执行 `trim`、连续空白折叠为单空格、全角标点归一到半角或统一中文标点。
- 数组去空、去重、排序；对象按 key 排序。
- 中文不做小写转换；英文 token 小写。
- 不纳入 `updatedAt`、UI 展示字段、diagnostics、临时错误、图片 URL 查询参数。
- visual hash 只纳入 `appearance / clothing / equipment / scaleRule / signatureColors / visual negativeRules`。
- performance hash 只纳入 `temperament / actionTraits / gestureRules`。
- voice hash 只纳入 `voiceGender / voiceAge / timbre / speechStyle / accent / voice negativeRules`。

### 5.4 下游版本记录

除了顶层 `consistency.characters`，每个下游产物都要记录本次使用的角色版本维度：

```ts
type CharacterUsage = {
  characterId: string;
  canonicalName: string;
  versions: {
    identityVersion: number;
    visualVersion?: number;
    performanceVersion?: number;
    voiceVersion?: number;
    resolverVersion?: number;
    referenceVersion?: number;
  };
  usedRefs: Array<{
    kind: 'sheet' | 'headshot' | 'front' | 'side' | 'back' | 'first_frame' | 'text_only';
    url?: string;
  }>;
  source: 'shot' | 'dialogue' | 'visual' | 'manual';
};

type StoryboardConsistencyMeta = {
  characterUsages: CharacterUsage[];
  consistencyScore?: number;
  diagnostics?: ConsistencyDiagnostic[];
};

type VideoPromptConsistencyMeta = {
  characterUsages: CharacterUsage[];
  referenceManifestVersion: string;
  consistencyScore?: number;
  diagnostics?: ConsistencyDiagnostic[];
};

type VideoSegmentConsistencyMeta = {
  characterUsages: CharacterUsage[];
  seedanceRuleBlockHash: string;
  consistencyScore?: number;
  diagnostics?: ConsistencyDiagnostic[];
};
```

建议写入位置：

- `storyboards[groupIdx].consistency.storyboard`
- `storyboards[groupIdx].consistency.videoPrompt`
- `videoTasks[groupIdx].consistency.videoSegment`

### 5.5 元数据仲裁顺序

同一个 group 现在可能同时有 `videoReferenceManifest`、`storyboards[groupIdx].consistency`、`videoTasks[groupIdx].consistency`。必须写死权威顺序：

1. `project.consistency.characters` 是角色事实的唯一权威。
2. `storyboards[groupIdx].consistency.*.characterUsages` 是该阶段“使用了哪些角色版本”的审计记录，只能引用主档，不能覆盖主档。
3. `videoReferenceManifest` 是“本次给模型传了哪些图片”的 I/O manifest，只负责图片编号和用途，不负责定义角色事实。
4. `videoTasks[groupIdx].consistency.videoSegment` 是最终视频任务审计快照，用于判断成片是否过期。
5. 冲突时，以 `project.consistency.characters` 为准；manifest 或阶段快照只能触发 `diagnostic_conflict`，不能改写角色主档。

### 5.6 引用状态语义

P0 后系统里有两类容易混淆的引用状态，UI 和诊断必须分开展示：

- `asset.reference.status` 描述资产主图是否可用。角色 sheet、场景图、道具图生成成功时为 `ready`；新生成失败但有旧图可用时为 `degraded`；无可用图时为 `missing/failed`。
- `CharacterLock.referenceLock.referenceStatus` 描述角色分面引用是否可用。角色 sheet 可用但 panel split 失败时，资产主图仍是 `ready`，角色分面引用应为 `degraded`，视频可降级使用整张 sheet 但要给出 warning。
- `storyboards[groupIdx].firstFrame.status` 描述视频首帧是否可用于 i2v。`ready` 是彩色首帧；`degraded` 是 last known good 彩色首帧；`legacy_sketch_only` 只表示黑白分镜稿可观测，不能作为视频首帧通过 gate。

因此 UI 不应写成“角色参考 ready/degraded”这种混合文案，而应写成“资产图 ready；角色分面 degraded”或“首帧仅有手稿，需要重生成彩色首帧”。

### 5.7 首次确认入口

旧项目或新抽取资产在未显式确认前，`ensureProjectConsistency({ source: 'migration' })` 会推导出 `needs_review`。这是预期行为：系统不能把旧数据自动锁成权威。所有生成前 gate 的错误文案必须明确告诉用户：

- 去「资产库」确认角色锁。
- 非人角色缺 `species` 时先补物种。
- 如果 UI 支持自动修复，可以由用户点击“确认并继续生成”，但仍必须是显式用户动作。

## 6. 流程控制点

### 6.1 剧本生成后：角色候选约束

目标：减少资产抽取前的角色命名漂移。

控制策略：

- 在 `SP_STYLE_BIBLE.characters` 中保留角色初始 `name / appearance / clothing`，作为资产抽取阶段的辅助上下文。
- 剧本修改、扩写、续写后，如果出现新角色名，需要在资产确认前标记 `needs_role_sync`。
- Agent patch 剧本时，若修改了角色称谓，要输出“角色别名建议”，进入 `aliases` 候选。

验收规则：

- 资产抽取前，剧本内主要说话人能映射到候选角色。
- 同一个角色不应被抽成两个资产，例如“老板 / 老周”重复。

### 6.2 资产抽取后：创建角色主档

目标：把 LLM 抽取结果转成后续生成的唯一权威数据。

控制策略：

- 在 `/api/assets/extract` 完成后调用 `buildCharacterLocks(project)`。
- 为每个角色补齐：
  - `characterId`：优先沿用 asset id，否则生成 `char_<stable_hash>`。
  - `aliases`：至少包含 `name`、`role`、常见简称。
  - `canonicalPrompt`：由 `appearance + clothing + equipment + entityType + negativeRules` 生成。
  - `voiceLock`：按身份和气质推断一版初始声音锁。
- 若 `entityType=non-human`，必须生成非人专属负向规则：
  - 不得变成人类。
  - 必须保留物种 anatomy。
  - 体型不得无理由巨型化。
  - 服装只能是轻量拟人配件，不能变成完整人类职业装。

硬门控：

- `canonicalName` 空：阻断进入角色参考图生成。
- `appearance` 空：阻断进入角色参考图生成。
- `entityType` 缺失：阻断进入角色参考图生成。
- 非人角色缺少 species 或 anatomy 描述：阻断或标记 `needs_review`。

### 6.3 角色参考图生成前：主档注入

目标：让角色图成为稳定资产，而不是一次性插画。

控制策略：

- `asset_images` 生成角色图时，prompt 末尾追加 `CHARACTER CONSISTENCY LOCK`。
- 该 lock 的优先级高于 `imagePrompt`，用于覆盖旧 prompt 或用户编辑前的冲突描述。
- 角色图生成完成后，必须执行 panel split；失败不阻断整体流程，但 `referenceStatus=degraded`。

建议 prompt 块：

```text
=== CHARACTER CONSISTENCY LOCK ===
Canonical character: {canonicalName}
Identity: {role}; {identity}
Entity type: {entityType}; species/anatomy: {species}
Appearance lock: {appearance}
Clothing lock: {clothing}
Equipment lock: {equipment}
Signature posture/temperament: {temperament}; {actionTraits}
Negative rules: {negativeRules}
This character must keep the same identity, face/body/species, clothing, equipment and scale across all generated assets in this project.
```

### 6.4 镜头设计阶段：角色引用校验

目标：保证 `shots[].characters` 与台词说话人、画面描述一致。

控制策略：

- `buildShotsMessages` 继续传入 `assets`，但额外传 `consistency.characters` 的精简版。
- LLM 输出后做一次本地校验，校验不能只靠字符串包含，而要走独立的 `CharacterMentionResolver`：
  - 从 `dialogue` 解析说话人。
  - 从 `visual` 扫描角色别名。
  - 对“他 / 她 / 它 / 周哥 / 老板 / 队长”等跨句指代做局部消解。
  - 与 `shots[].characters` 对齐。
- 自动修复低风险问题：
  - 台词说话人不在 `characters` 中：补入该角色。
  - `visual` 出现 canonicalName 但 `characters` 漏写：补入。
  - 使用 alias：规范化为 canonicalName。
- 高风险问题先给 warning，不直接 block：
  - 说话人无法映射到任何角色。
  - 画面出现未登记角色。
  - 角色名与道具 / 场景名冲突。

#### 6.4.1 CharacterMentionResolver 子任务

`resolveCharacterMention` 不能只是 `lib/character-consistency.ts` 里的一个工具函数。它要作为 P0 独立子任务交付：

- 输入：`script`、`shots[]`、`consistency.characters[]`、局部上下文窗口。
- 输出：`MentionResolution[]`，每条包含 `textSpan / canonicalName / characterId / confidence / source / reason`。
- 解析层级：
  1. 精确命中 `canonicalName`。
  2. 命中 `aliases`，例如“老板 / 周哥 / 老周”。
  3. 台词 speaker anchor，例如 `老板：`。
  4. 局部指代消解，例如上一句刚出现“老周”，下一句“他转身”。
  5. 低置信 fallback：保留原文名，输出 warning，不做自动归一。
- 置信度策略：
  - `confidence >= 0.9`：可自动归一。
  - `0.65 <= confidence < 0.9`：可作为 warning 和 UI 建议，不阻断。
  - `< 0.65`：不归一，不 block，标记 `mention_ambiguous`。
- case 库必须覆盖：
  - 同角色多称谓：老周 / 老板 / 周哥。
  - 同名冲突：两个角色都叫“小王”或一个角色名与场景/道具同名。
  - 非人角色简称：帝王蟹队长 / 队长 / 蟹队。
  - 多人连续对白后“他/她/它”指代。
  - 旁白描述里只出现身份不出现姓名。
- 初始准确率目标不要拍 98%。P0 自动归一 precision 目标 `>= 95%`，recall 目标 `>= 85%`；低置信退 warning，不能为了召回乱 block。

### 6.5 分镜 / 首帧阶段：参考图选择

目标：根据镜头类型选择最合适的角色 panel。

现有 `selectCharacterReferencePanels` 已具备基础能力，P0 需要强化：

- 按 `characterId` 选择，而不是只按 name/role 字符串匹配。
- 将选择结果写入 `storyboards[groupIdx].characterRefs`，便于审计。
- 当镜头是特写 / 表情 / 眼神，优先 `headshot`。
- 当镜头是动作 / 全景 / 中景，优先 `front`。
- 当镜头是侧脸 / 侧身，优先 `side`。
- 当镜头是背影 / 转身，优先 `back`。
- 多角色镜头最多 4 个参考位，按“说话人 > visual 点名 > shot.characters 顺序”排序。

门控策略：

- 关键角色没有任何 reference：允许生成分镜，但标记 `reference_missing`。
- 独立多图视频模式下，缺少首帧 `firstFrameUrl` 已经会阻断视频生成；P0 保持该策略。

### 6.6 视频提示词阶段：角色锁强制进入 prompt

目标：视频 prompt 不能只写“老周站着说话”，必须包含角色主档的稳定描述。

控制策略：

- `buildVideoPromptMessages` 的“角色”段改为从 `CharacterLock` 生成。
- 输出 prompt 中每个出场角色必须包含：
  - 名字
  - 身份
  - 外貌核心
  - 服装核心
  - 关键装备
  - 非人角色物种规则
  - 当前画面状态
- prompt refine 阶段禁止修改角色主档字段；若用户明确要改外貌 / 服装，应转为资产修改并触发 stale。

建议修正：

- `SP_VIDEO_PROMPT_REFINE` 当前写“英文提示词”，而主生成要求中文。这是独立 bug，应立即修正为中文结构化视频提示词口径，不能等 P0。

### 6.7 视频生成阶段：Seedance 硬规则注入

目标：把角色一致性作为视频生成的最高优先级前置规则。

现有 `buildSeedancePromptParts` 已有 `voiceBlock`、`styleOverrideBlock`、`independentReferenceBlock`。P0 不应在 `voiceBlock` 外再叠一个重复的角色主档块，而是把旧 `voiceBlock` 替换为统一的 `characterLockBlock`：

```text
【角色一致性主档 - 最高优先级】
以下角色信息是本项目的权威设定。视频画面、配音、口型、服装、物种、体型、表演习惯必须遵守：
- {canonicalName}（{characterId}）
  身份：{role}/{identity}
  外貌：{appearance}
  服装：{clothing}
  装备：{equipment}
  表演：{temperament}; {actionTraits}
  声音：{voiceGender}/{voiceAge}/{timbre}/{speechStyle}
  禁止：{negativeRules}
```

注入优先级建议：

1. 台词系统规则
2. 角色一致性主档（视觉 + 表演 + 声音，替代旧 `voiceBlock`）
3. 前后片段衔接
4. 独立参考图编号
5. 开场动态
6. 风格 / 参考图负向约束
7. 用户视频 prompt

实现约束：

- `buildSeedancePromptParts` 中保留 `dialogueBlock`，删除或废弃单独 `voiceBlock`。
- `ruleBlocks` 中只暴露一个 `character-lock`，避免 UI 和日志里出现两个互相覆盖的角色规则。
- `characterLockBlock` 的 hash 写入 `videoTasks[groupIdx].consistency.videoSegment.seedanceRuleBlockHash`，用于判断成片是否依赖过期角色版本。

### 6.8 生成前 / 生成后质检：角色一致性评分

P0 先做文本 + 元数据级质检；视觉级 drift 由 P0 前的自动 diagnosis 负责抽样/全量分析。

检查维度：

| 维度 | 规则 | 严重级别 |
| --- | --- | --- |
| 角色映射 | shot 说话人无法映射角色主档 | block |
| 角色遗漏 | 视频 prompt 的角色段缺少本组关键角色 | block |
| 形象冲突 | prompt 中出现与 clothing/equipment 矛盾描述 | warn/block |
| 非人保护 | 非人角色 prompt 中出现 human worker / man / woman 等冲突词 | block |
| 声音冲突 | 同一角色 voiceLock 在不同片段描述不一致 | warn |
| 参考缺失 | 关键角色无 reference image 或 panel | warn |
| 变更滞后 | 角色分维版本高于 storyboard/videoPrompt/videoTask 记录版本 | block |

输出一个 `consistencyScore`：

```ts
type TargetConsistencyReport = {
  targetType: 'shot' | 'storyboard' | 'videoPrompt' | 'videoSegment';
  targetId: string;
  score: number; // 0-100
  blockers: ConsistencyDiagnostic[];
  warnings: ConsistencyDiagnostic[];
  characterVersions: Record<string, {
    identityVersion: number;
    visualVersion?: number;
    performanceVersion?: number;
    voiceVersion?: number;
    resolverVersion?: number;
    referenceVersion?: number;
  }>;
};
```

score 公式：

- blocker 一票否决：只要有 blocker，`allowed=false`，score 仍计算但不允许生成。
- 初始满分 100。
- warning 扣分：
  - `mention_ambiguous`：每个 -8，最多 -24。
  - `reference_missing`：关键说话人 -15，非关键角色 -8。
  - `visual_soft_conflict`：每项 -12。
  - `voice_soft_conflict`：每项 -10。
  - `manifest_conflict`：每项 -10。
  - `stale_nonblocking`：每项 -10。
- score floor 为 0；同一 code 同一 character 同一 target 只扣一次。

阈值先作为工程门控默认值，后续由 diagnosis 结果校准：

- `score >= 90` 且无 blocker：绿色，允许生成。
- `75 <= score < 90` 且无 blocker：黄色，允许生成但展示原因。
- `score < 75` 或存在 blocker：红色，阻断视频生成。
- 两个 warning 示例：`mention_ambiguous + reference_missing(非关键)` 得分 `84`，黄色；`reference_missing(关键说话人) + visual_soft_conflict` 得分 `73`，红色但若无 blocker 可允许用户强制继续。

## 7. 变更传播与 stale 策略

当前 `compute-stale`、`detect-obsolete` 仍是空实现。P0 应优先补齐角色相关 stale：

### 7.1 触发条件

按字段语义提升对应版本，不使用单一 `lockVersion`：

- `canonicalName / role / identity / entityType / species / gender / ageBand` → `identityVersion`。
- `appearance / clothing / equipment / scaleRule / signatureColors / visual negativeRules` → `visualVersion`。
- `temperament / actionTraits / gestureRules` → `performanceVersion`。
- `voiceLock` 字段 → `voiceVersion`。
- `aliases / resolver case rules` → `resolverVersion`，只清 mention cache，不直接让视频 stale。
- 角色参考图或 panel 重新生成 → `referenceLock.referenceVersion`，并触发依赖 reference 的产物 stale。

特殊规则：

- `entityType` 从 `human` 改为 `non-human` 或反向变化时，同时 bump `identityVersion + visualVersion + referenceVersion`。
- `aliases` 修改后要重新跑 mention resolver；只有当某个 group 的角色映射结果变化，才对该 group 标记下游 stale。
- `temperament/actionTraits` 变化只影响 videoPrompt / videoSegment，不要求重画角色参考图和首帧，除非用户明确要求表演姿态体现在新参考图里。

### 7.2 影响范围

角色变更后，按依赖向下标记：

- `identityVersion` 变化：相关 `shots`、`storyboards`、`videoPrompt`、`videoSegment` 均 stale；如果只是 `canonicalName` 展示变化且 resolver 映射不变，可降级为 warning。
- `visualVersion` 变化：相关角色参考图、首帧 / 分镜参考、`videoPrompt`、`videoSegment` stale。
- `performanceVersion` 变化：相关 `videoPrompt`、`videoSegment` stale，不标记角色图 stale。
- `voiceVersion` 变化：相关 `videoSegment` stale，不标记 videoPrompt / 首帧 stale，除非 prompt 中显式写了声音描述。
- `resolverVersion` 变化：先重新解析 mention；映射变化的 group 才 stale。
- `referenceVersion` 变化：用到旧 reference 的 `storyboards`、`videoPrompt`、`videoSegment` stale。

### 7.3 用户体验

UI 中不要只显示“需更新”，要显示原因：

- “老周服装已更新，3 个分镜首帧需要重生。”
- “帝王蟹队长从 human 改为 non-human，5 个视频提示词需要重新生成。”
- “老周气质标签已更新，只需重新生成相关视频提示词，不需要重画角色图。”
- “新增别名‘周哥’只影响角色识别，当前没有发现下游映射变化。”
- “角色参考图版本高于当前视频片段版本，建议重新生成视频。”

## 8. 接口与模块落点

### 8.1 后端新增 / 调整模块

建议新增：

- `lib/character-consistency.ts`
  - `buildCharacterLocks(project)`
  - `syncCharacterLocks(project, changedAssets)`
  - `buildCharacterLockPromptBlock(project, characterIds)`
  - `validateCharacterConsistency(target, project)`
  - `computeCharacterStale(project, changedCharacterIds)`
- `lib/character-mention-resolver.ts`
  - `resolveCharacterMentions(project, text, context)`
  - `buildMentionCaseSet(project)`
  - `evaluateMentionResolver(cases)`
- `scripts/diagnose-character-consistency.ts`
  - 全量扫描项目产物，导出 drift case。
  - 聚合 `stage × drift_type × character` 维度，用于重排 P0。

建议调整：

- `app/api/assets/extract/route.ts`
  - 抽取完成后写入 `project.consistency.characters`。
- `lib/batch-executors.ts`
  - `asset_images` 读取 CharacterLock 注入 prompt。
  - `storyboard_images` 写入实际使用的 `characterRefs`。
  - `video_segments` 调用 `buildCharacterLockPromptBlock`，并在生成前执行 blocker 检查。
- `lib/prompts.ts`
  - `buildShotsMessages` 增加角色主档上下文。
  - `buildVideoPromptMessages` 用 CharacterLock 生成角色段。
  - 修正 `SP_VIDEO_PROMPT_REFINE` 语言口径。
- `lib/video-prompt-runtime.ts`
  - 用 `characterLockBlock` 替换旧 `voiceBlock`，避免重复注入。
- `app/api/orchestration/compute-stale/route.ts`
  - 按分维版本实现角色变更传播。
- `app/api/continuity/check-adjacent/route.ts`
  - 继续保留相邻检查，并读取 `CharacterLock` 提高角色维度判断。

### 8.2 前端展示建议

P0 前端只做轻量提示，不做复杂新页面：

- 角色卡增加状态：
  - 已锁定
  - 待补全
  - 参考图缺失
  - 已变更，下游需更新
- 视频提示词页增加角色一致性检查结果：
  - 本组角色锁：已命中几个角色
  - 参考图：首帧 / 场景 / 角色 panel 是否齐全
  - 阻断项：说话人无法映射、非人角色风险等
- 批量生成视频前增加统一预检：
  - blocker 为 0 才允许一键生成。
  - warning 可继续，但提示可能影响一致性。

## 9. P0 前置：自动 diagnosis

在正式排 P0 milestone 前，先做一次自动 diagnosis。目标不是手工采样，而是让当前项目库告诉我们 drift 主要发生在哪一层。

### 9.1 诊断输入

脚本扫描现有所有项目，按 `character × stage × group` 导出：

- `assets.characters[]` 原始角色字段。
- 角色参考图和 panel：`sheet/headshot/front/side/back`。
- 分镜 / 首帧：`storyboards[groupIdx].url / firstFrameUrl / debugSketchUrl`。
- 视频提示词：`storyboards[groupIdx].videoPrompt`。
- 视频片段抽帧：每段取 `0s / 50% / 末尾前 0.5s` 三帧，避免只看封面。
- reference manifest：`videoReferenceManifest`。
- 关联镜头：`shotIndices`、`shots[].characters`、`dialogue`、`visual`。

### 9.2 诊断方法

先做可自动化的两层：

1. 视觉相似度矩阵：
   - 真人角色：用 face embedding（如 InsightFace，本地可选依赖）比对角色参考图、首帧、视频抽帧。
   - 非真人 / 无脸角色：先不强依赖 face embedding，转入属性 judge。
   - 输出 `similarity_matrix`，低于阈值的样本进入 drift case。
2. 属性漂移 judge：
   - 用 vision LLM 对参考图、首帧、视频抽帧做结构化判断。
   - 只输出 JSON：`{characterId, stage, drifted_attrs, score, evidence}`。
   - 属性范围固定为：`face/body/species/clothing/equipment/color/scale/voice_hint/reference_missing`。

### 9.3 聚类输出

诊断脚本输出：

```ts
type CharacterDriftSummary = {
  totalCases: number;
  byStage: Record<'asset' | 'storyboard' | 'first_frame' | 'video_prompt' | 'video_segment', number>;
  byDriftType: Record<string, number>;
  byEntityType: Record<'human' | 'non-human', number>;
  topCharacters: Array<{ characterId: string; count: number; dominantDrift: string }>;
  recommendedMilestoneOrder: string[];
};
```

重排规则：

- 如果 `video_segment` 占比最高且 prompt/reference 都正确，优先做 reference 质量、首帧和视频生成前门控，而不是继续堆 prompt。
- 如果 `non-human → human` 占比最高，P0 缩小为 entityType 硬规则、负向词检查、非人参考图补齐。
- 如果 `mention_ambiguous / wrong_character_mapping` 占比最高，`CharacterMentionResolver` 提前到第一个工作包。
- 如果 `stale_reference` 占比最高，优先做分维版本和 stale 传播。
- 如果 `video_prompt_missing_character` 占比最高，再优先做 `buildVideoPromptMessages` 和 `characterLockBlock`。

### 9.4 诊断验收

- 能扫描所有本地项目，不破坏项目数据。
- 每个 drift case 能回链到 `projectId / groupIdx / characterId / stage / sourceUrl`。
- 至少输出 stage 聚类、drift type 聚类、推荐 milestone 顺序。
- 没装 face embedding 时，脚本降级为属性 judge，不阻塞诊断。
- 诊断输出作为 P0 排期依据，不能只保存在日志里。

## 10. 实施优先级

下面不是固定顺序，而是候选工作包。正式顺序由自动 diagnosis 重排。

### Work Package A：角色主档生成

交付：

- 新增 `project.consistency.characters`。
- 资产抽取完成后自动生成 CharacterLock。
- 用户修改角色资产后同步分维版本。

验收：

- 每个角色都有稳定 `characterId`。
- 同一角色别名进入 resolver case 库。
- 非人角色自动带负向规则。

### Work Package B：CharacterMentionResolver

交付：

- 独立 `lib/character-mention-resolver.ts`。
- 覆盖别名、speaker、局部指代、同名冲突。
- 带 case 库和评估脚本。

验收：

- 自动归一 precision `>= 95%`。
- recall `>= 85%`。
- 低置信不 block，输出 warning。

### Work Package C：生成前门控与 score

交付：

- 镜头、视频提示词、视频片段生成前执行角色一致性校验。
- 按 6.8 的公式输出 score、blocker、warning。
- 缺少关键字段时阻断高成本视频生成。

验收：

- 说话人低置信映射不直接 block。
- 非人角色疑似真人化时 block。
- 角色分维版本过期时按依赖维度判断能否复用旧产物。

### Work Package D：提示词锁注入

交付：

- 角色图、首帧、视频提示词、Seedance final prompt 均注入 CharacterLock。
- `characterLockBlock` 替换 `voiceBlock`。
- `video_segments` 记录本次使用的角色分维版本。

验收：

- 任意视频片段都能追溯使用了哪些角色锁。
- 同一角色跨片段 prompt 中的外貌 / 服装 / 声音描述一致。
- 不出现 `characterLockBlock` 与 `voiceBlock` 双重重复注入。

### Work Package E：stale 传播

交付：

- `compute-stale` 支持角色分维变更影响范围计算。
- 前端显示具体需更新原因。
- 一键生成跳过或阻断过期下游产物。

验收：

- 修改 `temperament` 后只标记 prompt / video，不标记角色图。
- 修改 aliases 后只重新解析；映射不变则不标记视频 stale。
- 修改服装后，相关分镜 / 视频 prompt / 视频均显示需更新。
- 未涉及该角色的片段不被误标。

### Work Package F：一致性报告

交付：

- 每个 group 生成 `TargetConsistencyReport`。
- UI 可展示 score、warnings、blockers。
- 连续性检查与角色主档联动。

验收：

- 生成前能看到角色一致性分数。
- 批量视频生成失败原因可定位到具体角色 / 片段 / 字段。
- score 的绿/黄/红状态能解释具体扣分项。

## 11. 风险与兜底

| 风险 | 表现 | 兜底 |
| --- | --- | --- |
| LLM 仍然改写角色 | prompt 里出现冲突外貌 | 本地文本检查 + block 高风险词 |
| 角色参考图切 panel 失败 | 无法按景别选参考 | 降级使用整张 sheet，标记 degraded |
| 用户故意换装 | 被 stale 阻断 | 提供“这是剧情换装”确认，生成新的 visual/story-state 分支 |
| 多角色镜头参考位不够 | 只能传 4 张参考 | 说话人和主视觉角色优先，其余进入文本锁 |
| 旧项目无 consistency 字段 | 老数据无法直接进入门控 | 首次打开或生成前自动 migration |
| 成本增加 | 每步多校验 | P0 以本地规则为主，LLM 只用于相邻连续性和必要修复建议 |

## 12. P0 验收指标

建议用 10 个覆盖样例做回归：

- 真人主角单人连续 5 段。
- 两个真人角色对话。
- 真人 + 非人拟人角色同场。
- 多个非人海鲜角色群像。
- 中途用户修改服装。
- 中途用户上传角色图。
- 角色有别名，例如“老板 / 老周”。
- 长台词多说话人。
- 特写、侧面、背影三类镜头。
- 场景转场但角色不变。

量化指标：

- mention resolver 自动归一 precision >= 95%，recall >= 85%，低置信退 warning。
- 关键角色 videoPrompt 覆盖率 = 100%。
- 非人角色真人化 blocker 命中率 >= 95%。
- 用户修改角色后，分维 stale 命中率 = 100%。
- 无关片段 stale 误报率 <= 10%。
- 角色参考图缺失时，高成本视频生成阻断率 = 100%。

## 13. 最小实现路径

若只做最短 P0，建议按以下顺序：

0. 跑自动 diagnosis，产出 `stage × drift_type` 聚类和推荐 work package 顺序。
1. 先做 diagnosis 排出来的第一大类问题；如果没有明显倾斜，默认从 `CharacterMentionResolver + CharacterLock` 开始。
2. 新增 `lib/character-consistency.ts`，实现 CharacterLock 构建、分维版本、prompt block 生成。
3. 新增 `lib/character-mention-resolver.ts`，实现 mention 解析、case 库、低置信 warning。
4. `/api/assets/extract` 写入 `project.consistency.characters`。
5. `video_segments` 生成前根据 groupShotIndices 找角色锁，并用 `characterLockBlock` 替换旧 `voiceBlock`。
6. `buildVideoPromptMessages` 的角色段改为 CharacterLock。
7. 实现角色分维 stale：按 identity / visual / performance / voice / resolver / reference 精确标记下游。
8. 前端先展示 warning / blocker 文案，不做大 UI 改造。

这样能用数据先确认主要漂移来源，再覆盖“角色长相、服装、非人属性、声音、说话人”五个 P0 风险点，并复用现有多参考图、panel selection、continuity check 能力。
