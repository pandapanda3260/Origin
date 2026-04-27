# 后端复刻 · 分阶段路线图

| 阶段 | 范围 | 状态 | 是否需要 API Key |
| --- | --- | --- | --- |
| **一** | 用户系统 + 项目持久化 + 设置/创作偏好保存 | ✅ **已完成** | 不需要 |
| **二** | AI 剧本生成 + 资产抽取 + 镜头设计 + 视频提示词 + Agent 对话 | ✅ **已完成** | 需要 1 个 LLM Key（OpenAI / DeepSeek 任选） |
| 三 | AI 角色参考图 + 分镜图 | ⏳ 待做 | 需要图像生成 Key（nano-banana / 即梦 / SD） |
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

## 阶段三预告：AI 角色参考图 + 分镜图

下一阶段要做：

1. 在 `lib/image-gen.ts` 里写图像生成统一封装：
   - 支持 OpenAI 兼容（gpt-image-1 / dall-e-3）、即梦、SD WebUI、ComfyUI 等
   - 入参：prompt + 参考图（可选） + 尺寸 + 风格
2. 重写 `/api/asset/[id]` 的图像生成 → 调真模型出参考图
3. 实现批量"生成全部参考图"动画
4. 实现 `/api/images/submit` 真生成分镜原图
5. 加一个"分镜图风格化为手稿"步骤（可用 ControlNet 或后期 LUT/postprocess）
6. 把生成的图持久化到 `data/images/` 目录，URL 通过 `/api/images/file/[id]` 提供

### 进入阶段三需要准备

去这几家任选其一拿图像生成 API Key：

- **A. OpenAI gpt-image-1**：和你的 OpenAI Key 同一个（直接复用）
- **B. 即梦 / 字节豆包**：去 https://www.volcengine.com/ 申请
- **C. nano-banana**：第三方 OpenAI 兼容（有些中转商提供）
- **D. ComfyUI 本地**：装一下 ComfyUI 拿到本地接口（要点显卡知识）

---

## 调试小贴士

- 看数据库里有什么：装一下 [DB Browser for SQLite](https://sqlitebrowser.org/) 然后打开 `data/qd.sqlite`
- 直接命令行查看：`sqlite3 data/qd.sqlite 'SELECT * FROM users;'`
- 重置全部数据：删除 `data/qd.sqlite*` 三个文件，重启服务器即可（会自动重建并重新种默认账号）
