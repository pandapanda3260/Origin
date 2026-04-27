# 后端复刻 · 分阶段路线图

| 阶段 | 范围 | 状态 | 是否需要 API Key |
| --- | --- | --- | --- |
| **一** | 用户系统 + 项目持久化 + 设置/创作偏好保存 | ✅ **已完成** | 不需要 |
| 二 | AI 剧本生成 + 资产抽取 + 镜头设计 + 视频提示词 | ⏳ 待做 | 需要 1 个 LLM Key（OpenAI / DeepSeek 任选） |
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

## 阶段二预告：AI 剧本生成

下一步要做的事：

1. 在 `lib/llm.ts` 里写一个统一的 LLM 调用封装：
   - 根据用户设置（settings 表里存的 provider/baseUrl/apiKey/model），自动选用 OpenAI 兼容、DeepSeek、智谱、Claude 等
2. 重写 `app/api/script/workflow/full-create`：拼提示词 → 调 LLM → 流式或一次性返回剧本
3. 重写 `app/api/script/workflow/expand` / `continue` / `extract-style-bible` 同理
4. 重写 `app/api/assets/extract`、`/api/shots/generate`、`/api/video-prompt/generate`：都是结构化输出，调 LLM 让它返回 JSON
5. 在 `app/api/agent/chat` 里实现 Creative Agent 真对话（对当前项目做局部修改 patch）

### 进入阶段二之前你需要准备

选一个就行，告诉我你选哪个我就按那个写：

- **A. OpenAI**（贵但好用）：去 https://platform.openai.com 充值后拿到 `sk-...` 开头的 key
- **B. DeepSeek**（便宜，国内能直连）：去 https://platform.deepseek.com 注册拿 key
- **C. 智谱 AI**（国内合规）：去 https://bigmodel.cn 注册拿 key
- **D. 国内 OpenAI 中转商**：你自己挑一家，我会按 OpenAI 协议调
- **E. Ollama 本地**（零成本但需要本地 GPU）：装 https://ollama.com/ 装好之后填 `http://localhost:11434/v1`

把 key（和 baseUrl 如果有的话）告诉我，或者你自己登录到 [http://localhost:3000/workspace](http://localhost:3000/workspace) 的"设置"页填进去（设置会保存进数据库）。

---

## 调试小贴士

- 看数据库里有什么：装一下 [DB Browser for SQLite](https://sqlitebrowser.org/) 然后打开 `data/qd.sqlite`
- 直接命令行查看：`sqlite3 data/qd.sqlite 'SELECT * FROM users;'`
- 重置全部数据：删除 `data/qd.sqlite*` 三个文件，重启服务器即可（会自动重建并重新种默认账号）
