# QD INFINITY 1:1 复刻

这是一个对 [https://inf.apiqd.com](https://inf.apiqd.com)（QD INFINITY · 视频Agent）网站的 1:1 复刻。

- 前端：**100% 视觉一致**——直接复用了对方原始的 HTML / CSS / JavaScript / 图片
- 后端：**全套 mock 假数据**——所有 `/api/*` 都由本地 Next.js 接管，返回示例数据

后续接真后端时，只需要替换 `app/api/` 里的 mock 即可，前端代码完全不用动。

---

## 一、第一次启动（小白看这里）

### 1. 装 Node.js（如果还没装）

打开 [Node.js 官网](https://nodejs.org/zh-cn) → 下载 LTS 版本（推荐 v20 或更新）→ 双击安装包，一路下一步即可。

装完后，打开"终端"（Terminal），运行：

```bash
node --version
```

看到 `v20.x.x` 之类的版本号就 OK 了。

### 2. 安装依赖

打开终端，进到这个项目文件夹：

```bash
cd /Users/linsen/new-project
```

然后运行（**第一次需要 1-3 分钟**，下载所有依赖包）：

```bash
npm install
```

### 3. 启动开发服务器

```bash
npm run dev
```

看到这样的输出说明启动成功：

```
▲ Next.js 14.2.x
- Local:        http://localhost:3000
✓ Ready in 4s
```

### 4. 在浏览器打开

打开浏览器，访问：

- 落地页：[http://localhost:3000](http://localhost:3000)
- 工作台：[http://localhost:3000/workspace](http://localhost:3000/workspace)

工作台**会自动登录**（本地开发跳过了登录步骤），打开就能看到所有 13 个页面。

### 5. 怎么停止？

回到终端窗口，按 `Ctrl + C` 即可。

---

## 二、目录结构（你不用全看懂，只看你关心的）

```
new-project/
├── public/                 ← 原站 HTML/CSS/JS 都在这（视觉来源）
│   ├── index.html          落地页
│   ├── workspace.html      工作台（13 个子页面塞在一起）
│   ├── styles.css          原站样式
│   ├── main.js             原站主脚本
│   ├── modules/*.js        原站模块（剧本、资产、剪辑等）
│   ├── logo.png            Logo 图片
│   ├── hero-bg.mp4         首屏背景视频
│   └── showcase-*.{jpg,png} 落地页展示图
│
├── app/api/                ← Mock 后端（你想改业务时改这里）
│   ├── auth/               登录 / 用户信息 / 注册
│   ├── billing/            订阅 / 积分 / 套餐
│   ├── projects/           项目 CRUD
│   ├── script/workflow/    剧本生成各环节
│   ├── assets/             资产工坊
│   ├── shots/              镜头设计
│   ├── images/             分镜图生成
│   ├── video/              视频生成
│   ├── batch/              批量生成
│   ├── edit/               剪辑工作台
│   ├── tasks/              任务中心
│   ├── settings/           API 配置
│   ├── profile/            创作偏好
│   ├── admin/              管理面板
│   └── [...path]/          兜底（所有没列出的 /api/* 路径都进这里）
│
├── mocks/                  ← 假数据来源
│   ├── user.ts             当前用户
│   ├── billing.ts          套餐和积分
│   ├── projects.ts         项目列表
│   ├── config.ts           系统配置
│   ├── admin.ts            管理面板数据
│   ├── library.ts          素材库
│   └── settings.ts         API 配置
│
├── lib/api-helpers.ts      Mock 路由小工具（jsonOk, jsonError）
├── package.json            依赖清单
├── next.config.mjs         Next.js 配置（含 / → index.html 重写规则）
├── tsconfig.json           TypeScript 配置
└── reference-site/         原站参考底稿（不会被部署，只是参考）
    ├── *.html, *.js, *.css 原版下载
    ├── modules/            原版模块
    ├── assets/             原版图片视频
    ├── screenshots/        登录后的真实页面截图（视觉对比用）
    ├── dom/                登录后真实 DOM 快照
    ├── local-screenshots/  我们本地版本的截图（视觉对比用）
    ├── capture.py          抓原站的脚本
    └── verify_local.py     抓本地复刻的脚本
```

---

## 三、常见操作

### 我想改 Logo / 图片

直接替换 `public/` 下面对应的图片文件即可（比如 `public/logo.png`）。刷新浏览器就能看到。

### 我想改积分余额（让自己看起来更"有钱"）

打开 `mocks/billing.ts`，把 `totalCredits: 58` 改成你想要的数字，保存即可（不用重启服务器，自动热更新）。

### 我想看 mock 数据接口返回什么

直接在浏览器访问，比如：

- [http://localhost:3000/api/auth/me](http://localhost:3000/api/auth/me)
- [http://localhost:3000/api/billing/me](http://localhost:3000/api/billing/me)
- [http://localhost:3000/api/projects](http://localhost:3000/api/projects)

### 我想清空浏览器登录态重新看登录流程

浏览器开发者工具 → Application → Storage → Clear site data → 刷新 `http://localhost:3000/workspace`，会自动重新建立 mock 登录态。

要看真实的登录弹窗，访问 [http://localhost:3000/?auth=1](http://localhost:3000/?auth=1)，输任何用户名密码都能登录成功（因为是 mock）。

### 我后续要给业务逻辑、要做真后端，怎么办？

直接把对应的 `app/api/<xxx>/route.ts` 里的 mock 数据换成真接口调用就行。例如：

**Mock 版本**（当前）：

```typescript
export async function GET() {
  return jsonOk({ items: listProjects() });
}
```

**对接真后端版本**（以后）：

```typescript
export async function GET(req: NextRequest) {
  const resp = await fetch('https://你的后端.com/api/projects', {
    headers: { Authorization: req.headers.get('authorization') || '' },
  });
  return resp;
}
```

前端 `public/main.js` 等所有原站代码完全不用改。

---

## 四、本次复刻做了哪些"小动作"？

为了让对方网站在本地能跑起来 + 不被踢回登录页，我们做了 2 处微小改动（其他都是原版）：

1. **`public/workspace.html` 顶部**：加了一段 `<script>`，在 `localhost` 下自动塞 mock token 到 `localStorage`，跳过登录。生产部署/接真后端时删除这段 `<script>` 即可。
2. **所有 `/api/*` 接口**：由本地 Next.js 提供 mock 数据。

剩下的 HTML / CSS / JS / 图片 / 视频，全部是原站下载下来的原版文件。

---

## 五、还能做什么？

| 我想要... | 怎么做 |
| --- | --- |
| 部署到自己的服务器 | `npm run build && npm start`，然后用 nginx 反代 3000 端口 |
| 改 Logo 文字 | 编辑 `public/index.html` 和 `public/workspace.html`，搜 "QD INFINITY" 替换 |
| 改主题色 | `public/styles.css` 和 HTML 文件里 `tailwind.config` 的 colors 段 |
| 加新的 mock 接口 | 在 `app/api/` 下建文件夹和 `route.ts`（参考已有的写法） |
| 看原版长什么样 | `reference-site/screenshots/` 下有完整截图 |
| 看本地长什么样 | `reference-site/local-screenshots/` 下有完整截图（运行 `python3 reference-site/verify_local.py` 重新生成） |

---

## 六、问题排查

- **打不开 http://localhost:3000**：检查终端是否报错；如果端口被占用，改 `package.json` 里的 `next dev -p 3000` 为别的端口（比如 `3001`）。
- **页面长得不太一样**：浏览器 Ctrl + Shift + R 强刷（避免缓存干扰）。
- **某个功能点了没反应**：打开浏览器控制台（F12），看有没有红色报错。如果是某个 `/api/*` 接口返回不对，告诉我接口名，我可以补上更准确的 mock。
