# 后端复刻 · 分阶段路线图

| 阶段 | 范围 | 状态 | 是否需要 API Key |
| --- | --- | --- | --- |
| **一** | 用户系统 + 项目持久化 + 设置/创作偏好保存 | ✅ **已完成** | 不需要 |
| **二** | AI 剧本生成 + 资产抽取 + 镜头设计 + 视频提示词 + Agent 对话 | ✅ **已完成** | 需要 1 个 LLM Key（OpenAI / DeepSeek 任选） |
| **三** | AI 角色参考图 + 分镜图 + 批量任务调度 + 文件存储 | ✅ **已完成** | 需要图像生成 Key（gpt-image-1 / DALL-E-3 / 兼容服务） |
| **四** | AI 视频生成 + FFmpeg 剪辑导出 + 任务中心 SSE | ✅ **已完成** | 需要视频模型 Key（Sora / Seedance / 可灵） + 本机 ffmpeg |
| **五** | 套餐积分 + 兑换码 + Stripe 脚手架 + 管理面板真数据 + 系统日志 | ✅ **已完成** | 真支付需 Stripe Key（可选） |

---

## 阶段一已交付（你现在能用的）

### 真用户系统
- 注册新账号：邮箱 + 用户名 + 密码（本地 OTP 验证码任意 6-8 位数字）
- 真登录：账号密码错就登录失败，对了发 JWT token
- 工作台访问：没 token 自动踢回登录页（真鉴权）
- 普通开发账号：`pokerman` / `joker0606`（legacy user，首次启动自动创建）
- 后台开发账号：`origin-admin` / `origin-admin-dev-2026!`（独立 admin，首次启动自动创建）

### 真项目持久化
- 每个项目有自己的 UUID，存进 `data/qd.sqlite`
- 多用户隔离：你看不到别人的项目（按 owner_id 过滤）
- 整个项目 JSON（剧本、资产、镜头、分镜、提示词、视频任务等）存在 `data_json` 列里
- 重启服务器、关机重启都不会丢

### 设置和创作偏好持久化
- API 配置（你填的 OpenAI / DeepSeek 等的 Key）存数据库
- 创作偏好（视觉风格、叙事风格等）也存数据库
- 不同用户互不影响

### 关键文件位置

| 路径 | 作用 |
| --- | --- |
| `lib/db.ts` | SQLite 连接 + 自动建表 + 默认账号种子 |
| `lib/auth.ts` | 密码哈希（bcrypt）+ JWT 签发/验证 |
| `lib/projects-db.ts` | 项目 CRUD（按用户隔离） |
| `lib/kv-db.ts` | 通用键值存储（settings / profile 共用） |
| `data/qd.sqlite` | SQLite 数据库文件（被 `.gitignore` 排除，不会提交） |
| `app/api/auth/*` | 真登录 / 注册 / 用户信息接口 |
| `app/api/projects/*` | 真项目 CRUD |
| `app/api/settings` | 真 API 配置存储 |
| `app/api/profile` | 真创作偏好存储 |

### 安全说明

- 密码用 bcrypt 哈希后才存数据库（即使数据库泄露，密码也不会暴露明文）
- JWT 签名密钥默认是开发兜底字符串。**部署到生产环境请务必设置环境变量**：
  ```bash
  export JWT_SECRET="一个至少 32 字节的随机字符串"
  npm run dev
  ```

---

## 阶段二已交付（你现在能用的）

### 真 AI 剧本生成

- **多轮顾问对话**（`/api/script/workflow/consult/turn`）：SSE 流式，AI 询问意图/人群/时长，给到 [READY] 大纲
- **从大纲生成完整剧本**（`/api/script/workflow/consult/confirm`）：流式生成剧本 → 提取风格圣经 → 打情绪标签
- **一句话直接出剧本**（`/api/script/workflow/full-create`）：跳过老问，直接生成五段式剧本
- **扩充剧本** / **续写剧本**：`/expand` 和 `/continue`
- **重新提取风格圣经**：`/extract-style-bible`
- **重新打情绪标签**：`/retag-emotions`
- **确认剧本进入资产**：`/confirm`

### 真 AI 资产抽取

- **抽取角色/场景/道具**（`/api/assets/extract`）：SSE 流式，按用户业务逻辑结构化输出
  - 角色字段：`name / intro / detail / temperament / actionTraits / tags`
  - 场景字段：`name / description / isMain / baseSceneRef / tags`（区分主场景/区域场景）
  - 道具字段：`propType / function / ownership / features`（含关联角色 id）
- **重建资产参考图提示词**：`/api/assets/rebuild-prompt`
- **角色装备变化检测**：`/api/assets/check-equipment-change`

### 真 AI 镜头设计

- **生成镜头表**（`/api/shots/generate`）：6-15 个镜头，每个含 `序号 / 时长 / 景别 / 运镜 / 画面描述 / 台词音效 / 风格关键词`
- 景别枚举：广角全景 / 中景 / 近景 / 特写 / 大特写
- 运镜枚举：固定机位 / 推 / 拉 / 摇 / 跟 / 航拍 / 手持 / 轨道

### 真 AI 视频提示词

- **按 group 流式生成英文提示词**（`/api/video-prompt/generate`）
- 结构化为 `[CAMERA] / [STYLE] / [CONSTRAINTS] / [AUDIO]` 四段
- **微调单个 group 提示词**：`/api/video-prompt/refine`
- **解析 + 敏感词扫描**：`/api/prompt/parse` 和 `/scan-sensitive`
- **分镜图提示词转换**：`/api/storyboard/convert-prompt`

### 真 AI 创作偏好对话

- **Creative Agent 全局对话**（`/api/agent/chat`）：流式回复 + [PATCH] 行表示可执行修改
- **应用对话产生的剧本修改**：`/api/agent/patch-script`
- **创作偏好画像对话**（`/api/profile/chat`）：每 4 轮自动提炼"创作画像"

### 关键架构

| 文件 | 作用 |
| --- | --- |
| `lib/llm.ts` | OpenAI 兼容 LLM 调用（流式 / 非流式 / fake 兜底） |
| `lib/sse.ts` | Next.js Route 端 SSE 响应封装 |
| `lib/prompts.ts` | 全部系统提示词集中目录（便后续调优） |

### 安全/可靠性

- 用户没配 API Key 时自动进 **fake 模式**：所有接口仍能跑通、SSE 协议正常，但内容是占位文本（前端能看到正确的"加载/进度"状态）
- LLM 调用失败时，路由层把错误消息直接通过 SSE `{type:"error"}` 推给前端，前端会展示 toast
- 所有"长生成"路径（剧本/资产/镜头/视频提示词）都是流式，避免被网关超时砍掉

---

## 阶段三已交付（你现在能用的）

### 真 AI 图像生成（OpenAI 兼容协议）

- `lib/image-gen.ts` 统一封装 `/v1/images/generations` 调用
- 支持 OpenAI 官方（gpt-image-1 / dall-e-3）和任意兼容中转
- 输出：图像文件存到 `data/images/<userId>/<imageId>.png`，元数据落 `images` 表
- **fake 兜底**：没配图像 Key 时返 1×1 占位图，UI 流程仍通

### 批量任务调度（与原站契约一致）

- `POST /api/batch/start { batchType, projectId, targets, options }` → 返回 `{ batchId }`，立即响应
- `GET /api/batch/<id>/stream?token=...` → EventSource 流，命名事件：
  - `snapshot`（连接后第一帧）
  - `task_started` / `task_progress` / `task_completed` / `task_failed`
  - `batch_completed` / `batch_cancelled`
- `GET /api/batch/<id>` → 同步状态查询
- 并发度=2，避免触发图像 API 限流
- 状态持久化到 `batches` 和 `batch_tasks` 表（重启可看历史，但不会自动重跑）

### 三个真 executor

| batchType | 说明 |
| --- | --- |
| `asset_images` | 给角色/场景/道具生成参考图（自动拼提示词、按类型选尺寸） |
| `storyboard_prompts` | 把镜头描述转成英文图像生成提示词（LLM） |
| `storyboard_images` | 给每个分镜组生成手稿风分镜图（pencil sketch style 关键词写进 prompt） |

每个 executor 完成后会自动**写回项目对应字段**：
- 角色：`assets.characters[i].imageUrl` + 顶层 `characters[i].imageUrl`
- 场景：`assets.scenes[i].imageUrl` + 顶层 `environments[i].imageUrl`
- 道具：`assets.props[i].imageUrl` + 顶层 `props[i].imageUrl`
- 镜头提示词：`shots[i].imagePrompt`、`imagePromptGenerated=true`
- 分镜图：`storyboards[i].url` 和 `storyboards[i].pencilUrl`（前端 `pencilUrl || url`）

### 单图直生 + 用户上传

- `POST /api/images/submit` —— 同步生成单张图（不走批量）
- `POST /api/assets/upload-char-image` —— 用户上传自定义角色照片做参考
- `GET /api/images/file/<id>` —— 读取生成图（带 long cache header，浏览器自动缓存）

---

## 阶段四已交付（你现在能用的）

### 真 AI 视频生成

- `lib/video-gen.ts` 统一封装 OpenAI Sora 风格的"提交-轮询-下载"三步流程
- 用户没配 Key 时 **fake 兜底**：用本机 ffmpeg 生成 4s 黑场（带 440Hz 提示音），mp4 文件 valid，前端 `<video>` 能播
- 真模式下：POST `/v1/videos` → poll `/v1/videos/{id}` → GET `/v1/videos/{id}/content` → 保存 `data/videos/<userId>/<taskId>.mp4`
- 所有任务记录在 `video_tasks` 表，重启可查询历史

### 视频片段 batch executor

- 新加 `video_segments` batchType，与 storyboard_images 一样接入批量调度
- 前端在 **批量** 页点 "一键生成" → 后端为每个分镜组并发 2 路生视频
- 每个片段完成后**自动抽首帧做封面**（写入 `images` 表），前端 `<video poster="...">` 能用
- 写回 `project.videoTasks[]` 和 `project.storyboards[i].videoUrl`

### FFmpeg 智能剪辑

- `lib/ffmpeg.ts` 4 个核心能力：
  - `makeBlackVideo` 生成纯色视频
  - `concatClips` 拼接多段（filter_complex 同步重编码到 1080×1920）
  - `addBgm` 盖背景音乐（音量可调，可选保留原声）
  - `extractCover` 抽首帧作为封面 PNG
- `/api/edit/generate-edl` 真 LLM 决策剪辑：clipId / in / out / transition × 4 种
  - 对 LLM 返回做严格枚举校验 + 范围 clamp
  - LLM 失败/无效时 fallback 到"原顺序拼接"，永远不会卡住
- `/api/edit/export` 异步导出：返回 exportId 立即响应，后台 spawn ffmpeg 渲染
  - 进度持久化到 `exports` 表
  - 前端轮询 `/api/edit/export-status/<id>`
  - 完成后通过 `/api/edit/export-file/<id>` 流式下载（支持 HTTP Range）

### 任务中心实时推送

- `/api/tasks/all-active` 真 DB 查询：聚合 video_tasks + batches + exports
- `/api/tasks/all-active/stream` EventSource SSE：每 1.5s 轮询 DB 推差量（snapshot / tasks_changed 事件）
- `/api/tasks/[id]` 单任务详情查询
- `/api/tasks/active` / `/api/tasks/video-by-project` / `/api/tasks/register`：全部接 DB

### 剪辑工作台素材库

- `/api/edit/upload-media` 用户上传 mp4/mov/png/mp3 → 存 `data/uploads/<userId>/`
- `/api/edit/media/[id]` 文件读取（带 Range 支持，HTML5 拖动可用）
- `/api/edit/media-library/[scope]` 列素材：scope=project 或 scope=user
  - 自动包含已生成的视频片段 + 用户上传素材

### BGM 库

- `/api/edit/bgm-library` 扫描 `data/bgm/` 目录，自动列出所有 mp3/wav/m4a/aac
- 用户把音乐文件丢到目录就立即可见，无需 DB 注册
- `/api/edit/bgm/[id]` 流式播放（带 Range）

### 时间轴状态

- `/api/edit/timeline` GET / PUT，把整个 timeline 对象保存到 `project.timeline`

### 测试验证

通过完整端到端测试（fake 模式）：
1. 创建项目 + 3 个分镜组
2. video_segments batch 生成 3 段 3s 视频（ffmpeg 黑场 + 提示音）
3. 自动出 3 个封面图
4. /api/edit/generate-edl 给出有效 EDL
5. /api/edit/export 用 ffmpeg 拼接 → 9s 成片
6. ffprobe 验证：mp4 valid，duration=9.0s 正确

---

## 阶段五已交付（你现在能用的）

### 真积分系统

- `lib/credits.ts` 集中管理：余额 / 预扣 / 退还 / 入账 / 明细
- 计费表（在 `CREDIT_PRICES` 集中维护）：
  - text 1 积分/请求（剧本/资产/镜头/EDL 等所有 LLM 文本）
  - image 30 积分/张（角色/场景/道具/分镜图）
  - video 150 积分/段（单段视频）
  - export 5 积分/次（FFmpeg 拼接成片）
- 扣减优先级：bonus → topup → subscription（自动选最便宜的桶）
- 任务失败自动退还（已接 batch executors 和 export 路由）
- 不足时返 `errorCode: INSUFFICIENT_CREDITS` + HTTP 402，前端会跳"购买"弹窗

### 默认账号自动开户

- pokerman 注入 5000 积分（便于测试），新用户 100 积分（免费档）
- 入账记录在 `credit_ledger` 里有 'gift' 类型条目

### 兑换码（替代真支付，立即可用）

- 内置 3 个测试码：
  - `QDDEMO-1000` → +1000 积分
  - `QDDEMO-5000` → +5000 积分
  - `QDDEMO-10000` → +10000 积分
- 每个码每个用户只能兑换一次（防重）
- 通过 `/api/billing/redeem` 兑换，前端"购买积分"流程可直接调用

### Stripe / 微信 / 支付宝 脚手架

- `/api/billing/checkout` 接受 `provider: stripe|wechat|alipay`，落 `billing_orders` 表
- 当前 Stripe / 微信 / 支付宝都返"占位提示"，等用户去申请商户后补真实 SDK 调用
- `/api/billing/orders/[id]` 真订单状态查询（含完整生命周期）
- `/api/billing/subscription/{cancel,resume}` 自动续订开关（修改 `user_credits.cancel_at_period_end`）

### 管理面板真数据

- `/api/auth/admin/stats` 全部从 DB 实时查询：
  - 总用户数 / 总项目数（COUNT）
  - 近 5 分钟在线（基于 `user_credits.updated_at`）
  - 付费用户（来自 `billing_orders` 中 status=paid 且金额>0）
  - 已入账金额（按币种聚合）
  - 用量明细（按用户聚合 credit_ledger，分文本/图片/视频）
  - 最近注册（最近 20 个）
- 仅 admin 用户可访问（403 守卫）

### 系统日志（管理面板看真日志）

- `lib/sys-logs.ts` 内存环形缓冲（最近 1000 条）
- 启动时 hook 进 console.log/info/warn/error，所有日志自动入环
- `/api/auth/admin/logs?level=warning|all&lines=300` 拉日志
- 仅 admin 可访问

### 维护横幅

- `/api/maintenance/banner` GET 公开，PUT 仅 admin
- 启用后前端顶部横幅条会显示告警消息
- 状态存 `system_config` 表

### 设置 Key 池状态

- `/api/admin/key-pool/status` 实时检查 4 个 slot（text/image/video/storyboard）的配置状态
- 返回每个 slot 的 mode（real/fake）、source（user-settings/env/fallback）、model、baseUrl
- admin 可一眼看出哪些 Key 还没配
- 仅 admin 可访问

### 测试通过

- 兑换 QDDEMO-1000 → 余额 +1000
- 重复兑换同一码 → 409 拒绝
- export 失败 → charge + refund 两条 ledger entry，余额回到原状
- /admin/stats 返回真实 DB 计数（2 用户、9 项目、2 在线）
- /admin/logs 显示 console hook 安装记录
- 维护横幅 PUT/GET 双向工作

---

## 后续可选优化（不属于核心 5 阶段）

1. 真实接 Stripe（需注册商户 + 写 webhook）
2. 真实接微信支付/支付宝（需备案 + 商户号 + ICP）
3. 限流：单用户并发任务数（基于 `running` 状态行计数）
4. 集群部署：用 Redis 替代内存事件总线、迁移到 Postgres
5. 实时 SSE 优化：用 EventEmitter 取代轮询
6. 安全：JWT secret 强制环境变量、图片签名 URL、上传文件大小限制
7. 性能：图像 / 视频生成的并发限流、超时配置
8. 监控：接 Sentry / OpenTelemetry

---

## 调试小贴士

- 看数据库里有什么：装一下 [DB Browser for SQLite](https://sqlitebrowser.org/) 然后打开 `data/qd.sqlite`
- 直接命令行查看：`sqlite3 data/qd.sqlite 'SELECT * FROM users;'`
- 重置全部数据：删除 `data/qd.sqlite*` 三个文件，重启服务器即可（会自动重建并重新种默认账号）
