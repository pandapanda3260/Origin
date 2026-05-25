# LLM System Prompt / Rule Inventory

本清单覆盖 `app/` 与 `lib/` 下所有文本 LLM 调用里的 `role: "system"` 内容，以及图像/视频生成前会被强制拼入模型 prompt 的“系统级硬规则”。检索口径：`chatComplete`、`chatStream`、`chatCompleteJsonWithRetry`、`role: "system"`、`const SP_`、图像/视频生成 prompt override。

## 通用规则与调用治理

| 规则/位置 | 生效环节 | 内容/作用 |
|---|---|---|
| `docs/model-config-governance.md` | 所有大模型调用配置治理 | 业务路由只选择 `modelRole`，不要硬编码 `model/provider/baseUrl/endpoint/apiKey/reasoningEffort/timeout/quality/tier`；实际配置由 `.env*` 与 `lib/model-routing.ts` 统一解析。 |
| `lib/model-routing.ts` | 所有文本/图像/视频模型路由 | 文本角色：`brain` 创意推理与剧本、`structured` JSON/抽取、`styleBible` 风格圣经、`profileDerive` 用户画像、`legacy` 兼容；图像/视频走 `image`/`video` slot。 |
| `lib/prompts.ts:14` `COMMON_RULES` | `lib/prompts.ts` 中大多数 `SP_*` 的共同系统规则 | QD INFINITY AI 创作引擎；默认中文；有 JSON schema 时只能输出 JSON；禁止 JSON 外解释/Markdown；禁止泄露 `<think>`/`<thinking>`、英文/中文自言自语推理开场；最终输出必须是干净成品。 |
| `lib/llm.ts:711` `chatCompleteJsonWithRetry` | 风格圣经、情绪、资产、镜头、剪辑等结构化 JSON 调用 | 强制 `responseFormat: "json_object"`，默认 `modelRole: "structured"`，最多 3 次重试；遇到输出截断会提高 `maxTokens` 后重试。 |
| `lib/llm.ts:910` `chatStream` / `lib/llm.ts:68` `chatComplete` | 所有文本流式/非流式调用 | 按 provider 分发到 Chat Completions / Responses / Claude Messages；统一 token budget；统一剥离 `<think>`/`<thinking>`。 |
| `lib/llm.ts:1185` `makeThinkStripper` / `stripThinkBlocks` | 所有文本输出后处理 | 即使模型无视系统规则输出思考标签，也会在流式和非流式层面剥掉。 |

## 集中式 System Prompts: `lib/prompts.ts`

| System prompt | 作用环节/入口 | 调用方式 | 系统提示词内容摘要 |
|---|---|---|---|
| `SP_SCRIPT_CONSULT` `lib/prompts.ts:32` | 剧本顾问多轮对话；`app/api/script/workflow/consult/turn/route.ts` | `chatStream`，`modelRole: brain` | 短视频编剧助手；严格 3 步：先确认剧情/核心冲突，再一次性问目标人群+时长，最后输出带 `[READY]` 的大纲；每轮 1-3 句；禁止 XML 标签、套话、过早 `[READY]`。 |
| `SP_SCRIPT_FULL_CREATE` `lib/prompts.ts:140` | 一句话/确认大纲生成完整剧本；`full-create`、`consult/confirm` | `chatStream`，`modelRole: brain` | 工业级短视频编剧/导演；内置 Aristotle、McKee、Save the Cat、Show-don't-tell、对白三层次、短视频节奏等规则；输出五段式 `铺垫/升温/高潮/回落/余韵`；对白必须 `角色名："台词"`；禁止标签/Markdown/解释/思考泄露。 |
| `SP_SCRIPT_REVISE` `lib/prompts.ts:281` | 基于已有剧本修改；`full-create` 的 `mode=revise` | `chatStream`，`modelRole: brain` | 按“原剧本+修改指令”返回完整五段式新剧本；保留未受影响内容；严格遵循修改指令；直接以 `铺垫：` 开头，禁止解释、Markdown、XML、思考标签。 |
| `SP_STYLE_BIBLE` `lib/prompts.ts:356` | 风格圣经提取；`extract-style-bible`、剧本生成后自动提取 | `chatCompleteJsonWithRetry`，`modelRole: styleBible` | 视觉风格指导；从剧本提取 `visualStyle/colorPalette/era/mood/cameraStyle/worldRules/characters` 严格 JSON；颜色必须 6 个中文色名+hex；角色外貌/服装要服务后续画面生成。 |
| `SP_RETAG_EMOTIONS` `lib/prompts.ts:414` | 剧本情绪标记；`retag-emotions`、剧本生成后自动打标 | `chatCompleteJsonWithRetry`，`modelRole: structured` | 将剧本切为五段式情绪曲线，输出 `emotions` JSON；字段含 `emotion/intensity/pacing/paragraphStart/paragraphEnd/note`；严格 5 段、固定英文枚举。 |
| `SP_ASSET_CHARACTERS_EXTRACT` `lib/prompts.ts:613` | 资产抽取第 1 步：角色；`app/api/assets/extract/route.ts` | `chatCompleteJsonWithRetry`，`modelRole: structured` | 只抽角色；输出 3-5 个角色 JSON；必填 `role/identity/entityType/appearance/clothing/equipment/temperament/actionTraits/imagePrompt`；非人角色必须保留真实物种/形态。 |
| `SP_ASSET_SCENES_EXTRACT` `lib/prompts.ts:646` | 资产抽取第 2 步：场景；`app/api/assets/extract/route.ts` | `chatCompleteJsonWithRetry`，`modelRole: structured` | 只抽环境；输出 2-3 个场景，至少 1 主 1 副；场景必须带 `location/timeSetting/weather/lighting/atmosphere/baseSceneRef/imagePrompt`。 |
| `SP_ASSET_PROPS_EXTRACT` `lib/prompts.ts:680` | 资产抽取第 3 步：道具；`app/api/assets/extract/route.ts` | `chatCompleteJsonWithRetry`，`modelRole: structured` | 只抽道具；输出 2-5 个道具；`ownership` 只能引用已识别角色 id 或 null；imagePrompt 必须是中文且不能为空。 |
| `SP_SHOTS_GENERATE` `lib/prompts.ts:737` | 镜头表生成；`app/api/shots/generate/route.ts`、`lib/batch-executors.ts` | `chatCompleteJsonWithRetry`，`modelRole: structured` | 资深导演拆镜；输出 6-14 个镜头 JSON；`duration` 是导演计划秒数；台词字数按约 4 字/秒匹配 duration；固定镜头占比 ≥40%、相邻同情绪运镜兼容、景别/运镜枚举、visual 细节、scriptRef 原文定位。 |
| `SP_VIDEO_PROMPT_GENERATE` `lib/prompts.ts:904` | 按 storyboard group 生成视频模型 prompt；`video-prompt/generate`、`video_prompts` batch | `chatStream` 或 `chatComplete`，`modelRole: brain/structured` | 中文视频提示词工程；必须输出 `运镜系统/角色/场景/计划时间段/基调/约束/音障`；时间段逐段匹配 shot.duration 累计时间轴；禁止英文 shot/camera 键值对和参考图编号；台词逐字完整保留。 |
| `SP_VIDEO_PROMPT_REFINE` `lib/prompts.ts:1129` | 单个视频提示词微调；`app/api/video-prompt/refine/route.ts` | `chatStream`，`modelRole: brain` | 按用户修改意图微调现有中文视频提示词；不能改时间轴、运镜、角色 ID、参考图编号；直接输出新 prompt。 |
| `SP_AGENT_CHAT` `lib/prompts.ts:1148` | Creative Agent 项目对话；`app/api/agent/chat/route.ts` | `chatStream`，`modelRole: brain` | 了解当前项目状态，基于用户引用元素给出建议或补丁；回复 ≤200 字；可追加 `[PATCH] target=... action=... payload=<JSON>` 协议。 |

## 内联 System Prompts

| System prompt | 位置 | 作用环节/入口 | 调用方式 | 系统提示词内容摘要 |
|---|---|---|---|---|
| `SP_PATCH` | `app/api/agent/patch-script/route.ts:10` | Agent 直接改剧本 | `chatComplete`，`modelRole: brain` | 剧本编辑助手；输入原剧本+修改意图，返回完整剧本；保持五段式和总时长；不解释、不用 Markdown。 |
| `SP_REBUILD` | `app/api/assets/rebuild-prompt/route.ts:16` | 单卡资产重新生成 imagePrompt | `chatComplete`，`modelRole: brain` | AI 图像生成提示词工程师；为白底写实参考图重写 80-220 字中文 imagePrompt；只描述主体；禁止写风格/光线/背景/三视图/六宫格等，由后端统一加。 |
| `SP_CHECK` | `app/api/assets/check-equipment-change/route.ts:9` | 角色装备/服装连续性检查 | `chatCompleteJsonWithRetry`，`modelRole: structured` | 连续性检查官；对比 before/after 服装装备是否有视觉关键变化；输出 `{changed, items[]}` 严格 JSON。 |
| `SP_SHOT_TO_IMG_PROMPT` | `app/api/storyboard/convert-prompt/route.ts:16` | 单镜头流式转中文分镜图 prompt | `chatStream`，`modelRole: brain` | 分镜手稿提示词工程师；输出 80-220 字中文；描述主体、动作、构图、机位、光照、关键道具/场景；禁止照片级、彩色、运镜动词、台词字幕、三视图/白底。 |
| `SP_REBUILD` | `app/api/prompt/rebuild/route.ts:9` | 通用草稿 prompt 重写 | `chatComplete`，`modelRole: brain` | AI 视频/图像生成提示词工程师；把草稿重写得更精准、更结构化；保持语种；视频不超过 800 词、图像不超过 200 词；不解释。 |
| `SP_CONTINUE` | `app/api/script/workflow/continue/route.ts:10` | 剧本续写 | `chatStream`，`modelRole: brain` | 短视频编剧助理；在剧本末尾续写 3-5 句，保持人物/风格/五段式节奏；返回完整剧本（原文+续写）。 |
| `SP_EXPAND` | `app/api/script/workflow/expand/route.ts:10` | 剧本扩充 | `chatStream`，`modelRole: brain` | 短视频编剧助理；把现有剧本加细节、对白、镜头建议；保持五段式和总时长；中文纯文本；禁止 XML/Markdown/方括号注释。 |
| `SP_PERSONA` | `app/api/profile/chat/route.ts:11` | 创作者偏好画像对话 | `chatStream`，`modelRole: brain` | 创作偏好研究员；通过简短对话澄清视觉/叙事/镜头/情绪/提示词习惯；每轮 ≤120 字；自然语言，不输出 XML/JSON/Markdown。 |
| `SP_PERSONA_DERIVE` | `app/api/profile/chat/route.ts:15` | 从偏好对话提炼画像 | `chatComplete`，`modelRole: profileDerive`，`responseFormat: json_object` | 根据最近对话历史提炼 `visualStyle/narrativeStyle/cameraStyle/moodStyle/promptHabits` 严格 JSON；证据不足填空字符串。 |
| `SP_EDIT_ANALYZE` | `app/api/edit/analyze/route.ts:28` | 剪辑工作台 AI 分析 | `chatStream`，`modelRole: structured`，JSON | 后期剪辑顾问；输出故事弧线、BGM 类别、逐 segment 标签；segments 必须与输入 1:1 对应；要求五段式弧线、情绪强度、关键动作、角色名。 |
| `SP_GENERATE_EDL` | `app/api/edit/generate-edl/route.ts:20` | 剪辑工作台生成 EDL | `chatStream`，`modelRole: structured`，JSON | 工业级 AI 剪辑师；按 Walter Murch 剪辑六原则生成 EDL；含对白片段必须完整保留 `in=0/out=durationSec`；默认 cut，非 cut 全片最多 1 处；输出 `{edl,duration,narrative,pacingPlan}`。 |
| `SP_SHOT_TO_IMG_PROMPT` | `lib/batch-executors.ts:355` | 批量 `storyboard_prompts`：镜头转中文分镜图 prompt | `chatComplete`，`modelRole: structured` | 与单镜头转换类似，输出中文分镜图 prompt；批量版同步包含强非人/拟人角色规则：必须保留物种本体，禁止画成真人员工；群像按点名物种逐个画；体型必须接近现实物种且小于/不高于人类角色。 |
| 无 system prompt | `app/api/settings/test/route.ts:58` | 文本模型连通性测试 | `chatComplete`，`modelRole: brain/structured` | 只发 user 消息 `ping，回复 pong 即可。`，没有 system role。 |

## 非 `role=system` 但实际会拼入模型 Prompt 的硬规则

| 规则块 | 位置 | 生效环节 | 内容/作用 |
|---|---|---|---|
| `PENCIL_PREFIX` / `PENCIL_SUFFIX` | `lib/image-gen.ts:87` | `generateImage(... style: "pencil")` 分镜图生成 | 在图像 API prompt 前后强制加入专业黑白铅笔+针管笔分镜风格；禁止彩色、照片、3D、动漫、卡通、水彩、边框、文字、水印、草稿涂鸦感。 |
| `forceStyleSuffix(kind="character", entityType="human")` | `lib/image-gen.ts:333` | 真人角色参考图生成 | 强制白底写实摄影；一张图四栏：大头部特写 + 正面全身 + 严格 90 度侧面 + 背面；同一人物同脸同衣；禁止插画/动漫/3D/文字/水印/侧面 3/4。 |
| `forceStyleSuffix(kind="character", entityType="non-human")` | `lib/image-gen.ts:310` | 非人/拟人角色参考图生成 | 强制白底写实生物/物体摄影；三栏正/严格侧/背；保留非人 anatomy，禁止改成人类或加人脸/人体；禁止头部特写。 |
| `forceStyleSuffix(kind="scene")` | `lib/image-gen.ts:353` | 场景参考图生成 | 强制写实摄影六宫格场景参考图；同一地点六个不同角度/焦段；禁止人物、插画、3D、文字、水印；必须可见 6 panel。 |
| `forceStyleSuffix(kind="prop")` | `lib/image-gen.ts:375` | 道具参考图生成 | 强制白底写实产品摄影，物体居中占 70%，只允许软投影；禁止插画/动漫/3D/文字/水印。 |
| `PROJECT STYLE BIBLE LOCK` | `lib/batch-executors.ts:29` | 场景资产出图前追加 | 从 styleBible 提取视觉风格、色板、时代、mood、cameraStyle、worldRules，要求所有场景共享同一 DP/调色体系。 |
| `SCENE METADATA` / `MAIN-SCENE LOCK` / `REFERENCE IMAGE NOTE` | `lib/batch-executors.ts:198`、`:230`、`:281` | 场景/副场景资产出图前追加 | 强制场景反映 location/time/weather/lighting/atmosphere；副场景必须是主场景同一物理地点的另一角度，材质、灯具、色温、建筑风格保持一致；有主场景参考图时把它声明为同一地点视觉锚点。 |
| `CHARACTER METADATA` | `lib/batch-executors.ts:246` | 角色资产出图前追加 | 把用户编辑后的外貌/服装/装备/气质/动作特征作为 authoritative override 追加，覆盖旧 imagePrompt 冲突。 |
| Seedance `dialogueBlock` / `voiceBlock` / `continuityBlock` / `motionOpeningBlock` / `styleOverrideBlock` | `lib/video-gen.ts:606`-`:718` | 火山 Seedance 视频生成 | 在用户 videoPrompt 前追加硬规则：台词只读 `台词内容`、说话人不能念出；同名角色跨片段声音/形象一致；承接上一片段/留出下一片段衔接；第 0 帧必须动态；有彩色场景/角色资产参考时最终视频必须全彩电影质感，分镜草图只作构图参考，非人角色不能画成人。 |

## 主要流程映射

| 工作流阶段 | System prompt / rule |
|---|---|
| 创意咨询 | `SP_SCRIPT_CONSULT` |
| 生成/修改剧本 | `SP_SCRIPT_FULL_CREATE`、`SP_SCRIPT_REVISE`、内联 `SP_PATCH`、`SP_CONTINUE`、`SP_EXPAND` |
| 剧本后处理 | `SP_STYLE_BIBLE`、`SP_RETAG_EMOTIONS` |
| 资产抽取 | `SP_ASSET_CHARACTERS_EXTRACT`、`SP_ASSET_SCENES_EXTRACT`、`SP_ASSET_PROPS_EXTRACT` |
| 资产图提示词/出图 | 内联资产 `SP_REBUILD`；`forceStyleSuffix`；`PROJECT STYLE BIBLE LOCK`；`SCENE/CHARACTER METADATA`；`MAIN-SCENE LOCK` |
| 镜头设计 | `SP_SHOTS_GENERATE` |
| 分镜图提示词 | `app/api/storyboard/convert-prompt` 的 `SP_SHOT_TO_IMG_PROMPT`；batch 版 `SP_SHOT_TO_IMG_PROMPT` |
| 分镜图出图 | `PENCIL_PREFIX` / `PENCIL_SUFFIX` |
| 视频提示词生成/微调 | `SP_VIDEO_PROMPT_GENERATE`、`SP_VIDEO_PROMPT_REFINE` |
| 视频生成 | Grok 直接使用 `input.prompt`；Seedance 台词/声音/连续性/开场动态/风格覆盖块；Sora 直接使用 `input.prompt` |
| 剪辑分析/剪辑决策 | `SP_EDIT_ANALYZE`、`SP_GENERATE_EDL` |
| 项目 Agent | `SP_AGENT_CHAT` |
| 创作者偏好画像 | `SP_PERSONA`、`SP_PERSONA_DERIVE` |

## 梳理时值得注意的口径差异

| 问题 | 位置 | 建议 |
|---|---|---|
| 用户可编辑 prompt 的语种要求需要保持一致。 | `lib/prompts.ts`、`app/api/storyboard/convert-prompt/route.ts`、`lib/batch-executors.ts` | 资产 imagePrompt、分镜图 prompt、视频 prompt 统一以中文生成；系统字段、JSON key、固定枚举和 provider 硬规则可保留英文。 |
| 单条分镜 prompt 与批量分镜 prompt 有两份 `SP_SHOT_TO_IMG_PROMPT`，批量版多了非人/拟人物种保护。 | `app/api/storyboard/convert-prompt/route.ts:16` vs `lib/batch-executors.ts:355` | 建议抽到同一处，并把非人规则同步给单条生成。 |
