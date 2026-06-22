# LibTV vs Origin：后端逻辑对比 + 可借鉴方向

> 产出范围：只做对比与方向判断，**不改代码**。任何一条"可借鉴方向"要落地，都需另出方案（遵循"设计型升级先出方案"的约定）。
> 结论一句话：**LibTV 是一个"节点图创作引擎/平台"，Origin 是一条"短剧垂直流水线"。** 两者形状不同——LibTV 在"灵活、可组合、Agent 可驱动、模型可挑、可控工具多"上明显领先；Origin 在"垂直流程的质量闸门、任务持久化恢复、世界观一致性、计费"上有真实强项，不该为了像 LibTV 而丢掉。

---

## 0. 信源与方法（避免凭推断）

三方信源交叉验证：

1. **LibTV 飞书《使用指南》全文**（你提供）——LibTV 的权威功能/交互细节。
2. **Origin 真实代码扫描**——`lib/`（约 154 个 .ts）+ `app/api/`（全量路由），关键结论都带文件路径，可复查。
3. **全网行业资料**——LibTV 公开实测、`libtv-labs/libtv-skills`(GitHub 757★) 的 OpenAPI、ComfyUI 节点引擎、LiteLLM/OpenRouter 模型网关。

已扣代码核对的关键事实（本报告所有"Origin 现状"均按此口径）：

- 创作管线 = **7 个写死的执行器**：`lib/batch-executors.ts` 里 `registerExecutor('asset_images'|'storyboard_prompts'|'storyboard_images'|'tail_frame_images'|'video_segments'|'shots'|'video_prompts')` + `aliasExecutor('video_segments','videos')`。顺序由前端向导驱动，后端无图、无分支、无跳过。
- 视频**只接了 Seedance 一家**：`lib/model-routing.ts` 仅 `provider:'seedance'`；grep 全仓无 Kling/Vidu/Wan/海螺/Pixverse 等视频供应商。
- **没有**用户可组合的画布/节点图/工作流层（`canvas` 命中的全是 `@napi-rs/canvas` 图片处理与分格提示词，非用户节点）。
- 但 Origin **已有图引擎依赖**：`lib/edit-edl-graph.ts` 用 `@langchain/langgraph`（StateGraph + sqlite checkpoint + interrupt 人在环路），仅用于剪辑 EDL 决策。
- 已有"部分对等"底子：`lib/asset-library.ts`（跨项目资产库）、`lib/character-mention-resolver.ts`（@角色解析，文本态）、`lib/video-provider-capabilities.ts`（视频能力注册表）、`model-routing.ts` 的 `fallbackConfigs`（主→备链）。

---

## 1. 总体判断：两套系统的"形状"

| 维度 | LibTV | Origin |
|---|---|---|
| 后端范式 | 无限画布 **节点图(DAG)** 引擎，5 种节点(文/图/视/音/脚本)自由连线 | **写死的 8 段线性流水线**(剧本→世界观→镜头→资产→首尾帧→视频提示词→视频→剪辑) |
| 对外暴露 | **API 优先 / Agent 原生**：公开 OpenAPI + OpenClaw Skill，人和 Agent 平权 | 内部 Next.js 路由，**和前端向导绑死**，无对外 API |
| 模型 | 每个节点的"生成器"里可挑：**~35 视频 / ~12 图像 / 4 语言 / 多音频** | env 驱动、每槽位单供应商：**视频仅 Seedance**、图像 Seedream/OpenAI |
| 复用 | 工作流可打组/存为模板/整组执行；资产/主体库跨画布复用 | 世界观/风格有模板；**工作流不可复用**(流程是写死的) |
| 可控工具 | 3D 导演台、720°全景、多角度、打光、运镜库、视频解析… | 以**提示词驱动**为主，少量(六视图/空间一致性方案) |
| 强项 | 灵活、可组合、生态 | **任务持久化恢复、内部依赖失效图、一致性闸门、世界观单一真相源、计费、部-集续写** |

下面逐维度展开。每条结构：**LibTV 做法 → Origin 现状(代码) → 为何更优 → 可借鉴方向(只给方向)**。

---

## 2. 分维度对比

### 维度 1：架构范式——节点图引擎 vs. 写死流水线 ★最大代差

**LibTV**：无限画布上五种节点自由连线即一条"任务工作流"。可"打组(Cmd+G)→创建工作流"存成模板，在左侧"打开工作流/我的工具箱"里随时调出复用；对有前后逻辑的组可"**整组执行**"一键重跑；"**副本**"会**保留连线**，方便基于同一组参考素材并行 fan-out 出多个版本。脚本节点本身就是一条压缩的子管线(见维度 5)。

**Origin 现状**：管线是 7 个写死执行器(上文路径)，顺序靠前端向导调 `/api/batch/start?batchType=...` 串起来；后端没有图、不能重排/跳过/分支，工作流也不能存成可复用资产。值得强调：Origin **内部其实有一张依赖图**——`lib/sentinel/artifact-usage-guard.ts` + `lib/project-dependency-state.ts` 会按内容哈希判定每段产物 usable/blocked/stale 并给 `repairActions`。**它有"图"的内核，只是这张图是固定的、内部的、不可被用户组合、也不对外暴露。**

**为何更优**：节点图带来三件 Origin 现在做不到的事——① 非线性探索(同一素材并行试多个分支)；② 流程复用(把"参考生图→图生视频"存成模板反复跑)；③ 把"改一处→只重跑下游"变成图上的自然操作。

**可借鉴方向**：
- 不必推翻短剧主流程。可在现有 `registerExecutor` 单元之上加一层**图编排**(把执行器当节点、产物当边)，让高级用户/内部运营搭可复用工作流。**关键利好：Origin 已经有 `@langchain/langgraph` 在用**，把它从"只编排剪辑"扩到"编排创作管线"是增量，不是从零。
- 先做"**工作流模板**"这一个小切口(把固定的剧本→分镜→视频流程参数化存成可一键重跑的模板)，性价比最高、blast radius 小。

---

### 维度 2：后端暴露——API 优先 / Agent 原生 vs. GUI 耦合 ★第二大代差

**LibTV**：后端是一套公开 OpenAPI(`libtv-labs/libtv-skills`)——Bearer 鉴权、**会话(session/IM)模型**(`POST /openapi/session` 发自然语言指令如"生一个动漫视频")、**`afterSeq` 增量轮询**(只取新消息)、`change-project`、`file/upload` 到 OSS；遵循 **OpenClaw Skill 规范**，所以 OpenClaw 这类 Agent 能**无人值守**跑完剧本→成片。产品口号"人和 Agent 平权地作为用户"。

**Origin 现状**：业务逻辑和前端向导深度耦合在 Next.js 路由里；`app/api/agent/*` 只有内部的 chat / patch-script，**没有对外 API、没有会话抽象、没有 Skill 包**。外部 Agent 无法驱动 Origin。

**为何更优**：Agent 自动化 + 第三方集成 + 生态(libtv-skills 已 757★)。这也是"交互流畅"的另一面——把"一长串点击"压成"一句话指令 + 增量轮询"。

**可借鉴方向**：
- 抽一层**无头 API**：项目/会话 + 任务提交/查询(Origin 的 `durable-tasks` + `batches` 已是很好的底座，`/api/tasks/[id]/stream` 已有 SSE/轮询)，把它从"前端专用"提升为"对外契约"。
- 之后再封一个 **Skill 包**(同样走 OpenClaw 规范)让 Agent 调。**前置条件**是先把业务逻辑从路由里解耦——这是设计大改，需单独出方案。

---

### 维度 3：模型接入——每节点可选市场(35+) vs. env 单供应商

**LibTV**：每个节点的"生成器"里直接挑模型 + 参数。视频 **~35 个**(Seedance 2.0/1.5、Kling O3/3.0/动作迁移、Wan 2.6、Hailuo、Vidu、Pixverse、Video 3.1…)，图像 ~12，语言 4，音频多个；还有**主体库**(Kling/Vidu 原生主体一致性)、Seedance 2.0 多模态单次 12 个参考。

**Origin 现状**：`model-routing.ts` 是 env 驱动、每槽位单供应商，**视频只有 Seedance**，图像 Seedream/OpenAI。好底子是有的：已有 `fallbackConfigs` 主备链、`video-provider-capabilities.ts` 能力注册表、`recordModelCallEvent` 可观测。

**为何更优**：按镜头/任务挑最合适的模型(成本/质量/能力权衡)，单家故障可切换，能力随行业快速扩。

**可借鉴方向**：
- 走**模型网关**模式(参考 LiteLLM/OpenRouter):统一 OpenAI 格式适配 + **能力注册表**(Origin 已有视频版,扩到图像/语言) + 任务级可选模型 + 重试/降级/冷却。
- 最低成本的第一步:**视频多接 1-2 家**(如 Kling/Vidu),验证 `video-provider-capabilities.ts` 的能力抽象是否够用,再谈"市场"。

---

### 维度 4：增量重算与缓存——节点级 vs. 整段重生成

**行业成熟做法(ComfyUI)**：DAG + 惰性求值 + **内容哈希缓存键**(`IS_CHANGED`/`fingerprint_inputs`)，输入没变就复用缓存，**只重跑变了的节点及其下游**；有 LRU/依赖感知多种缓存策略。**LibTV** 对应：整组执行只跑该组、副本做变体、脚本→生成器组**单向数据流**(生成器里改不回传脚本，刻意避免级联抖动)、"先局部测试再批量全量"。

**Origin 现状**：`ShotPlanSourceSnapshot` 按 script/styleBible/assets/duration/emotion/world 分字段哈希做失效追踪——**这部分已经不错**；但粒度偏**整段**(一段 stale 就整段重生成)，缺细粒度产物缓存复用。注：尾帧续链、逐片段重试已是局部能力，算部分对等。

**为何更优**：少算力 = 少花积分(对 Origin"1 元=100 分、成功即扣"的计费尤其直接)、改一处的等待更短。

**可借鉴方向**：把失效/缓存粒度从"段"下沉到"镜头/单元格"，按内容哈希缓存并复用每镜产物，只重跑变化的镜头。Origin 已有哈希基建，是延伸不是新建。

---

### 维度 5：资产与一致性——资产节点/主体库 vs. 项目态资产 + 一致性闸门

**LibTV**：脚本节点把剧本拆成"内容 + 资产(角色/场景/道具)"，资产是可单独改/换/复用的卡片；shot 表里 **@唤起资产即自动连线**；改一处自动同步到所有相关画面；全局风格锁定；**主体库**借模型原生主体能力(Kling/Vidu)保证跨次一致。

**Origin 现状**：这块 Origin **其实很扎实**——`character-consistency-gate.ts`(角色锁定闸门:未锁/缺参考/非人物种缺失则拦)、`frame-consistency-check.ts`(生成图与参考多模态比对,C 级最多重试 2 次)、`character-mention-resolver.ts`(@角色解析,文本态)、`asset-library.ts`(跨项目)、自定义角色全局库。**Origin 的"闸门 + 重试"在质量管控上比 LibTV 更严。**

**为何各有所长**：LibTV 的可视化连线 + **模型原生主体库**在"身份一致性"上更省心(借力模型而非靠后检重试);Origin 的强制闸门在"批量前不让劣质产物过"上更稳。**这一维 Origin 不落下风,差在"可视化复用"与"模型原生主体"。**

**可借鉴方向**：引入**模型原生主体/角色库**(Seedance 2.0 角色库 / Kling 主体)作为现有一致性校验的补充(模型侧锁身份 + Origin 侧闸门兜底);资产做成可跨项目复用的卡片(已有 `asset-library` 底子)。

---

### 维度 6：人在环路与批量控制——画布选择式 vs. 向导审批式

**LibTV**：脚本节点顶部强制三步闸门(**确认镜头信息 → 整理资产 → 合成最终提示词**)，三步全过才能批量；批量时自由选**范围**(单个/部分/全部) + **类型**(生图/生视频) + **模型**；"确认并创建生成器组"会把资产连线、提示词、模型参数全带进去，仍可逐镜微调；先跑几条测试再全量。

**Origin 现状**：有审批位(scriptApproved/shotsApproved…)、一致性闸门、`batch-preflight`(阻断项/警告项)。但流程是**逐页向导**,不像画布上"任意框选子集 → 批量重跑"那样自由。

**为何更优**：检查 + 选择性批量在**同一个面上**完成,更顺手;"先测试后全量"对短剧几十镜场景省钱省时。

**可借鉴方向**：允许**任意子集选择**做批量重跑;把分散在各页的审批收敛到一个评审面;Origin 的 `batch-preflight` 是好基础。

---

### 维度 7：创作可控性工具——3D 导演台/全景/打光/运镜库 vs. 提示词驱动

**LibTV**(这块 Origin 几乎是空白)：
- **3D 导演台**🔥:用"摆积木"(人体素模/几何体/群众阵列)搭故事空间→多视角截图→喂给 AI 当**构图参考**;支持机位/FOV/注视目标跟随、姿势控制。把"靠提示词赌空间关系"变成"3D 摆好再生成"。
- **720°全景**(实时预览 + 4/12 视角截图)、**多角度**(8 水平+4 垂直+3 景别机位)、**打光**(26 主光+9 轮廓光 3D 光位 / 智能模式)、**摄像机控制**(机型/镜头/焦距/光圈)、**运镜 20+ 预设库**、**视频解析**(把视频拆成 画面/景别/运镜/时长/节奏 表)。

**Origin 现状**:以提示词驱动为主;有 `scene-views`/`prop-views`(六视图)、空间一致性方案,但**无 3D 预演、无全景、无打光、无运镜库**。

**为何更优**:确定性的空间/光线/机位控制 = 少返工、少"抽卡"、一致性更高。

**可借鉴方向**:这些都是**离散可调用的图像/视频服务**,天然贴合节点模型。按杠杆排:**3D 导演台/多角度 > 主体库 > 打光/运镜库**。(只给方向,落地另议。)

---

### 维度 8：媒资与历史复用——全局画布历史 vs. 项目态

**LibTV**:所有生成的图/视/音进**全局历史**,支持批量下载/删除/复用(≤10);"我的资产/工具箱/主体库"跨画布;**跨画布复制带连线**。

**Origin 现状**:状态主要在 `projects.data_json`(单行去规范化 JSON);有跨项目 `asset-library` 与全局自定义角色、逐片段历史(`SEGMENT_VIDEO_HISTORY_PLAN`),但偏项目内。

**可借鉴方向**:做全局媒资/资产历史 + 批量复用;Origin 已有 `asset-library` 全局态,是延伸。

---

## 3. Origin 的真实强项（对比中不应丢）

为避免一边倒,这些是 Origin 后端**比"画布玩具"更硬**的地方,扣代码为证:

- **任务持久化与恢复**:`lib/durable-tasks.ts` + `lib/batches.ts` 的租约(lease)/心跳/CAS 原子转移 + `task_state_history` 全审计 + `provider-recovery.ts` 幂等键防重复提交/重复扣费 + `needs_review` 兜底。崩溃/重启能自愈。
- **内部依赖失效图**:`sentinel/artifact-usage-guard.ts` 统一判定每段产物可用性并给修复动作——这是 LibTV 文档里没体现的严谨度。
- **质量闸门**:角色一致性闸门 + 帧一致性校验重试(维度 5),批量前拦劣质产物。
- **世界观单一真相源**:`lib/world-template-context.ts` 把世界观快照注入**每一个** LLM 阶段,保证整剧术语/设定一致——对**多集短剧**尤其关键。
- **计费内聚**:`usage-billing.ts`/`credits.ts`(1 元=100 分、向上取整、成功即扣、四类积分桶优先级)。
- **部-集续写**:一集一任务的系列化能力。

判断:**不要为了"像 LibTV"把这些垂直能力换成通用画布。** 正确姿势是"垂直流水线为主体 + 选择性吸收 LibTV 的可组合/可控/Agent 化优点"。

---

## 4. 可借鉴方向汇总（按性价比排序，只给方向，落地另出方案）

| # | 方向 | 价值 | 改造范围/blast radius | 现有基础(降成本) | 优先级 |
|---|---|---|---|---|---|
| 1 | **视频多接 1-2 家模型**(Kling/Vidu) | 摆脱 Seedance 单点、按需挑模型 | 中(model-routing/能力注册表) | 已有 `video-provider-capabilities.ts` + `fallbackConfigs` | ⭐⭐⭐ 最高 |
| 2 | **工作流模板**(把固定流程参数化、可一键重跑) | 复用、少重复操作 | 中(管线编排) | 已有 `@langchain/langgraph` + 7 个执行器单元 | ⭐⭐⭐ |
| 3 | **失效/缓存下沉到镜头级**,只重跑变化镜头 | 省积分、改一处更快 | 中(扩 `project-dependency-state` 哈希粒度) | 已有分字段哈希基建 | ⭐⭐⭐ |
| 4 | **模型原生主体库**作为一致性补充 | 身份一致更省心 | 中(接 Seedance2.0/Kling 主体) | 已有一致性闸门兜底 | ⭐⭐ |
| 5 | **无头 API + 会话抽象**(为 Agent/集成铺路) | Agent 自动化、生态 | 大(业务从路由解耦) | `durable-tasks`+SSE 已是底座 | ⭐⭐ |
| 6 | **3D 导演台 / 多角度**等可控性工具 | 确定性构图、少返工 | 大(新前端+新服务) | 几乎空白 | ⭐⭐(高杠杆但工程重) |
| 7 | **节点图创作模式**(高级用户) | 非线性探索、并行分支 | 大(新交互范式) | langgraph 内核可复用 | ⭐(战略级,长线) |
| 8 | 任意子集批量 + 统一评审面 | 交互更顺 | 小-中 | 已有 `batch-preflight` | ⭐⭐ |

> 建议:先吃 #1/#2/#3 这三块"高性价比 + 有现成基础"的,验证收益后再谈 #5/#6/#7 的战略级大改。

---

## 5. 不建议照搬的部分

- **全盘画布化**:会冲淡 Origin 短剧垂直流水线的质量闸门与世界观一致性。画布适合"探索/通用创作",短剧批量生产更要"轨道 + 闸门"。建议**双模式并存**而非替换。
- **社区/发布/分享**:是 LibTV 的平台/增长属性,与 Origin"生产工具"定位关系不大,非后端核心。
- **LibTV 单向数据流**(生成器改不回传脚本):是其取舍。Origin 的**双向 staleness**(上游改→下游失效)在质量上更强,别为"少抖动"退回单向。

---

## 附：LibTV 能力清单速查（来自飞书指南）

- **五节点**:文本/图片/视频/音频/脚本;每节点内置"生成器"(挑模型+参数)。
- **脚本节点(V2)**:剧本拆解→角色/场景/道具资产化→shot 表(单元格可改、@资产自动连线、整行增删改序、颜色标记)→合成最终提示词→确认并创建生成器组(带资产连线+提示词+模型参数)→批量生图/生视频→合成成片。三步闸门:确认镜头/整理资产/合成提示词。
- **工作流**:打组(Cmd+G)→创建工作流(存)→打开工作流/我的工具箱→整组执行;副本保留连线(并行 fan-out)。
- **画布工具**:720°全景、多角度、打光、高清/扩图/重绘/擦除/抠图/裁剪、宫格切分、标注、旋转镜像、分镜组;视频高清/解析/剪辑/合成(20min)/人声分离/分离音视频;音频截取/变速;**3D 导演台**。
- **生成器**:风格库+自定义风格、焦点编辑、镜头聚焦、摄像机控制;视频主体库、运镜 20+ 预设。
- **模型**:视频 ~35(Seedance/Kling/Wan/Hailuo/Vidu/Pixverse/Video3.1/Shot/HappyHorse/OmniHuman/MJ…)、图像 ~12(Lib Image/LibNavo/Seedream/MJ/Niji/Z Image/Qwen)、语言 4(CVLM5.5/GVLM3.1/Flash/Qwen3VL)、音频(Eleven V3/Mureka V8/Minimax 2.8 + 音色克隆)。
- **Agent**:`libtv-skills` OpenAPI——`POST /openapi/session`(建会话/发指令)、`GET /openapi/session/:id?afterSeq=N`(增量轮询)、`change-project`、`file/upload`;OpenClaw 规范。

---

## Sources

- LibTV《使用指南》(飞书云文档,你提供): https://resonate.feishu.cn/wiki/Loxfw6XHziYRk0kKzdjcFfp9nhb
- libtv-skills(Agent OpenAPI/Skill 规范): https://github.com/libtv-labs/libtv-skills
- LibTV 介绍/实测: https://www.aihub.cn/tools/libtv/ ，https://ai-bot.cn/libtv-hands-on-review/
- ComfyUI 节点图执行与缓存: https://deepwiki.com/hiddenswitch/ComfyUI/4.2-graph-execution-and-caching ，https://docs.comfy.org/custom-nodes/v3_migration
- 模型网关(LiteLLM/OpenRouter): https://github.com/BerriAI/litellm ，https://openrouter.ai/blog/insights/llm-gateway/
- Origin 代码(本地,关键路径见正文): `lib/batch-executors.ts`、`lib/batches.ts`、`lib/model-routing.ts`、`lib/video-provider-capabilities.ts`、`lib/sentinel/artifact-usage-guard.ts`、`lib/project-dependency-state.ts`、`lib/edit-edl-graph.ts`、`lib/character-consistency-gate.ts`、`lib/world-template-context.ts`、`lib/usage-billing.ts`
