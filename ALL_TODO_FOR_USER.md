# 你回家要做的所有事

> 这份清单是给你回到家后用的"操作手册"。
> 顺序很重要：先做"必做"，再做"可选"。
> 如果某一步出问题，**记下出错的步骤号 + 报错截图 + 浏览器控制台（F12 → Console）报错** 告诉我即可。

---

## 第 0 部分：环境检查（不用做，看一眼即可）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Node.js | ✅ 已装 | v22.22.2 |
| ffmpeg | ✅ 已装 | v8.1（视频导出需要它） |
| dev 服务器 | ✅ 正在跑 | http://localhost:3000 |
| 默认账号 | ✅ 已建 | `pokerman` / `joker0606`（admin，已发 5000 积分） |
| 测试兑换码 | ✅ 已建 | `QDDEMO-1000` / `QDDEMO-5000` / `QDDEMO-10000` |
| 5 个阶段后端 | ✅ 全部完成 | 见 `BACKEND_PHASES.md` |

---

## 第 1 部分：必做（拿到 OpenAI Key 后做）

### 任务 1.1 · 启动服务器（如果之前关了）

终端打开项目目录，启动：

```bash
cd /Users/linsen/new-project
npm run dev
```

看到 `Ready in xs` 就 OK。**保持这个终端窗口开着**，不要关。

### 任务 1.2 · 浏览器打开 + 登录

地址：[http://localhost:3000/workspace](http://localhost:3000/workspace)

会被踢回登录页 → 在弹窗里输：
- 用户名：`pokerman`
- 密码：`joker0606`

成功登入后能看到工作台。

### 任务 1.3 · 填 OpenAI API Key（最关键的一步）

左下侧边栏点 **设置**（图标是齿轮）。

**3 个区块全部填同一组凭证**（如果是 OpenAI 一个 Key 通吃）：

| 区块 | API 地址 | API Key | 模型 |
| --- | --- | --- | --- |
| **图片生成方式** | `https://api.openai.com/v1` | `sk-...` 你的 Key | `gpt-image-1` |
| **视频生成方式** | `https://api.openai.com/v1` | `sk-...` 你的 Key | `sora-2`（如果开了 Sora），否则留空走 fake 黑场 |
| **文本生成方式**（页面下方） | `https://api.openai.com/v1` | `sk-...` 你的 Key | `gpt-4o-mini` |

> 如果用国内 OpenAI 兼容中转：把 `https://api.openai.com/v1` 换成中转商给的 baseUrl，其他不变。

填完点最下面的 **保存全部配置**。

### 任务 1.4 · 验证 Key 有效

设置页点 **测试连接** 按钮，应该看到 "✓ 连通正常"。如果失败就回 1.3 检查。

### 任务 1.5 · 查看初始余额

回 **总览** 页，左上角应该显示 `Free · 5000 积分`（默认账号礼包）。
左下点头像 / "订阅与积分" 弹窗也能看到余额明细。

### 任务 1.6 · 完整跑通一遍创作流程

**点 "开始新项目"**，然后**按这 13 步顺序**操作。每一步都验证下面"应看到"再继续。

| 步骤 | 操作 | 应看到 | 大约耗时 | 大约花费 |
| --- | --- | --- | --- | --- |
| 1 | 进 **剧本** 页，输入框写 "独居青年雨夜遇到消失多年的旧友" → 发送 | AI 流式问 1-2 个问题 | 10-30s | ~¥0.05 |
| 2 | 回答 AI 的问题，等他出 [READY] 大纲 | 文末出现 [READY] + 大纲 + "确认生成剧本"按钮 | 10s | 已包含 |
| 3 | 点 **确认生成剧本** | 剧本流式打字（铺垫/升温/高潮/回落/余韵） + 右侧风格圣经 6 个字段 | 20-40s | ~¥0.10 |
| 4 | 点 **确认剧本，进入资产库** | 跳转，显示 "AI 正在分析剧本…" | - | - |
| 5 | 等资产抽取完成 | 出 2-4 个角色、2-3 个场景、2-4 个道具卡片 | 20-30s | ~¥0.05 |
| 6 | 点 **生成全部参考图** | 每张卡片陆续出现真图（左上有进度条） | 1-2 分钟 | ~¥4-10 |
| 7 | 点 **确认资产，进入镜头设计** | 跳转 | - | - |
| 8 | 点 **AI 镜头设计** | 镜头表自动生成（6-15 行：序号/时长/景别/运镜/画面/台词） | 20-40s | ~¥0.10 |
| 9 | 点 **确认镜头表，进入分镜图生成** | 跳转 | - | - |
| 10 | 点 **一键生成全部分镜图** | 每个镜头出一张手稿风分镜图 | 1-3 分钟 | ~¥4-8 |
| 11 | 等视频提示词自动生成（流式） | 每组镜头有 [CAMERA]/[STYLE]/[CONSTRAINTS]/[AUDIO] 四段英文 | 20-60s | ~¥0.10 |
| 12 | 点 **确认视频提示词** → 进 **批量** 页 → **一键提交全部** | 任务中心实时显示进度（看左下任务气泡） | Sora 真模式 5-15 分钟，fake 模式 30s | Sora ~¥3-10/段，fake ¥0 |
| 13 | 进 **剪辑** 页 → 点 **AI 分析** → 点 **AI 剪辑** → 点 **导出成片** | ~30s 后能看到 mp4 预览 + 下载按钮 | 30s | ~¥0.20 |

**首次完整跑通**预计：
- 含 Sora 真视频：**¥30-80**
- 不含 Sora（视频走 fake）：**¥10-15**

### 任务 1.7 · 测试积分扣减是否正确

跑完任务 1.6 后，进 **订阅与积分** 弹窗，看 **积分明细** 列表，应该看到一长串扣费记录：
- text 类型：扣 1
- image 类型：扣 30
- video 类型：扣 150（如果用了真 Sora）
- export 类型：扣 5

余额应该 = 5000 − 总扣费。

### 任务 1.8 · 测试兑换码

订阅页 → 找输入兑换码的地方（如果界面没有，直接调 API 测试）：

```bash
# 在另一个终端执行：
curl -X POST http://localhost:3000/api/billing/redeem \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat /Users/linsen/new-project/data/.token 2>/dev/null || echo MISSING)" \
  -d '{"code":"QDDEMO-5000"}'
```

应看到 "兑换成功！+5000 积分"，回订阅页刷新会看到余额涨了 5000。

### 任务 1.9 · 测试管理面板（admin 才能看）

侧边栏点 **管理面板**（齿轮图标右边），应看到：
- 用户总数（至少 1）
- 项目总数（你刚跑的项目数）
- 在线用户数
- 用户用量统计（你的 pokerman 行）
- 错误日志（系统启动日志）

---

## 第 2 部分：质量调优（看完跑通效果再决定）

跑完第 1 部分后，看下面 6 个问题，**有"是"就告诉我**：

| 问题 | 怎么解决 |
| --- | --- |
| 剧本不够带感 / 五段式比例不对？ | 改 `lib/prompts.ts` 里的 `SP_SCRIPT_FULL_CREATE` |
| 资产抽取漏了某些角色？ | 改 `SP_ASSETS_EXTRACT` |
| 镜头表节奏不对？ | 改 `SP_SHOTS_GENERATE` |
| 分镜图风格不像手稿？ | 改 `image-gen.ts` 的 pencil 关键词 |
| 视频提示词缺细节？ | 改 `SP_VIDEO_PROMPT_GENERATE` |
| 自动剪辑顺序怪？ | 改 `generate-edl` 的 `SP_GENERATE_EDL` |

**所有提示词都集中在 `lib/prompts.ts` 一个文件**，调起来很快。把你不满意的具体哪一块告诉我即可。

---

## 第 3 部分：可选高级功能

### 3.1 加 BGM（背景音乐）

把任意 mp3/wav 文件丢到 `/Users/linsen/new-project/data/bgm/` 目录。

刷新剪辑页 BGM 列表就能选了。

### 3.2 接 Stripe 真支付（你想商业化时再做）

我已经搭好脚手架。要启用：
1. 去 https://stripe.com 注册商户账号
2. 拿 `sk_test_...` 测试 Key
3. 在 `lib/billing-config.ts` 加上每个 plan 对应的 Stripe Price ID
4. 改 `app/api/billing/checkout/route.ts`：用 Stripe SDK 创建 Checkout Session
5. 加 webhook：`/api/billing/webhook/stripe` 收到 `checkout.session.completed` 后调 `grantCredits` 入账

我可以帮你做这些，但需要你先把 Stripe 账号搞定。

### 3.3 部署上线

```bash
cd /Users/linsen/new-project
npm run build
npm run start    # 生产模式跑
```

监听端口 3000。如果想给别人访问，要：
1. 买个云服务器（阿里云/腾讯云/Vultr 都行）
2. 装 nginx 反代 3000 端口
3. 申请 SSL 证书（Let's Encrypt 免费）
4. 域名 DNS 指过去

我可以帮你写部署脚本，等你买好服务器再说。

### 3.4 备份你的项目数据

所有数据都在 `/Users/linsen/new-project/data/` 一个目录里：
- `qd.sqlite` 数据库
- `images/<userId>/` 生成的图片
- `videos/<userId>/` 生成的视频
- `exports/<userId>/` 导出的成片
- `uploads/<userId>/` 用户上传素材
- `bgm/` 背景音乐

定期复制这个目录到外置硬盘 / 网盘就行。

---

## 第 4 部分：发现 Bug / 卡住怎么办？

### 状况 A · 浏览器控制台报错
按 F12 → Console，把红色错误消息复制下来发我。

### 状况 B · 某个 API 接口失败
F12 → Network → 找那个失败的请求 → Response 标签页 → 把响应内容复制下来发我。

### 状况 C · 服务器突然挂了
回到运行 `npm run dev` 的终端窗口，看最后几行报错。如果看不出来，直接复制最后 50 行发我。

### 状况 D · 想重置一切（清空 DB 重来）

```bash
# 谨慎：会丢失所有项目和生成结果
cd /Users/linsen/new-project
rm -rf data/qd.sqlite data/qd.sqlite-shm data/qd.sqlite-wal
# 重启服务器后会自动重建 + 重新种 pokerman 账号
```

---

## 第 5 部分：跑完后告诉我以下信息

帮我做下一步决策（调优 vs 商业化 vs 别的）：

1. **跑通了吗？** 哪几步顺利、哪几步卡住？
2. **生成质量怎么样？** 剧本/资产/镜头/分镜/视频 5 块满分 5 分各打几分？
3. **花了多少钱？** OpenAI 后台 Usage 页看一眼
4. **想下一步做什么？**
   - 调优某几块的质量
   - 接 Stripe 真支付准备商业化
   - 部署上线给朋友试用
   - 加新功能（你想到的）
   - 暂时不做，自己玩玩

回我这 4 个问题的答案，我据此规划下一步。

---

## 附录：默认凭证速查

```
默认账号:   pokerman / joker0606  (admin, 5000 积分预存)
测试码:     QDDEMO-1000 / QDDEMO-5000 / QDDEMO-10000
本地地址:   http://localhost:3000
工作台:     http://localhost:3000/workspace
DB 文件:    data/qd.sqlite
日志环:     /api/auth/admin/logs (admin only)
```
