# 后端复刻 · 分阶段路线图

| 阶段 | 范围 | 状态 | 是否需要 API Key |
| --- | --- | --- | --- |
| **一** | 用户系统 + 项目持久化 + 设置/创作偏好保存 | ✅ **已完成** | 不需要 |
| **二** | AI 剧本生成 + 资产抽取 + 镜头设计 + 视频提示词 + Agent 对话 | ✅ **已完成** | 需要 1 个 LLM Key（OpenAI / DeepSeek 任选） |
| **三** | AI 角色参考图 + 分镜图 + 批量任务调度 + 文件存储 | ✅ **已完成** | 需要图像生成 Key（gpt-image-1 / DALL-E-3 / 兼容服务） |
| 四 | AI 视频生成 + 智能剪辑（FFmpeg） | ⏳ 待做 | 需要视频模型 Key（Seedance / 可灵） |
| 五 | 套餐积分 + 真支付（微信/支付宝/Stripe） + 管理面板真数据 | ⏳ 待做 | 看是否真接支付 |

---

## 阶段一已交付（你现在能用的）

### 真用户系统
- 注册新账号：邮箱 + 用户名 + 密码（本地 OTP 验证码任意 6-8 位数字）
- 真登录：账号密码错就登录失败，对了发 JWT token
- 工作台访问：没 token 自动踢回登录页（真鉴权）
- 默认账号：`pokerman` / `joker0606`（admin，首次启动自动创建）

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

## 阶段四预告：AI 视频生成 + FFmpeg 智能剪辑

下一阶段要做：

1. 在 `lib/video-gen.ts` 里封装视频模型调用（Seedance / 可灵 / Sora 等）
2. 重写 `/api/video/submit` 真生成视频片段，用 batch 调度（新加 `video_segments` batchType）
3. 真实现 `/api/edit/generate-edl` —— 调用 LLM 给出剪辑决策表
4. 接 FFmpeg 做真剪辑：合并片段 + 加 BGM + 字幕
5. `/api/edit/export` 真渲染 mp4 文件，存到 `data/videos/`

### 进入阶段四需要准备

视频模型 API（任选其一）：
- **A. Sora**（最贵但最好，OpenAI 平台访问）
- **B. 即梦 / Seedance**（字节，国内可用）
- **C. 可灵**（快手，国内可用）
- **D. 自部署 ComfyUI + AnimateDiff**（零成本但慢）

外加：本机要装 ffmpeg（`brew install ffmpeg`）。

---

## 调试小贴士

- 看数据库里有什么：装一下 [DB Browser for SQLite](https://sqlitebrowser.org/) 然后打开 `data/qd.sqlite`
- 直接命令行查看：`sqlite3 data/qd.sqlite 'SELECT * FROM users;'`
- 重置全部数据：删除 `data/qd.sqlite*` 三个文件，重启服务器即可（会自动重建并重新种默认账号）
