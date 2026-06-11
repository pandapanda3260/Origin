# ============================================================================
# VevDemo 部署指南
# ============================================================================

## 概述

VevDemo 是火山引擎提供的视频剪辑 Web SDK 演示应用，需要联系火山技术支持获取源码。

## 本地端口约定

| 名称 | 地址 | 说明 |
| --- | --- | --- |
| Origin App | `http://127.0.0.1:3000` | Origin 页面、API 与在线精修承载页 |
| VevDemo Editor | `http://127.0.0.1:8084` | VevDemo 前端编辑器，Origin 通过 iframe 加载 |
| VevDemo API | `http://127.0.0.1:3002` | VevDemo Node/Koa 后端，负责调用火山接口 |

## 获取 VevDemo

1. 联系火山引擎技术支持，获取 VevDemo 源码
2. 或者从火山控制台「视频剪辑」→「开发者工具」下载

## 部署步骤

### 1. 放置源码

当前本机约定是将 VevDemo 源码放在 Origin 项目内部，但由 Git、TypeScript 和 Next dev watch 隔离：

```bash
cd /Users/mark/Documents/origin
# VevDemo 目录应为：
test -d /Users/mark/Documents/origin/vevdemo-1.0.6
```

### 2. 配置环境变量边界

火山密钥不写入 VevDemo 内部目录。Origin 和 VevDemo 后端共用外部环境变量文件：

```bash
/Users/mark/Documents/key/origin.env.local
```

其中至少包含。`VEVDEMO_EDITOR_URL / VEVDEMO_API_URL` 是推荐新名；旧的
`VEVDEMO_FRONTEND_URL / VEVDEMO_BACKEND_URL` 仍兼容：

```bash
VEVDEMO_EDITOR_URL="http://127.0.0.1:8084"
VEVDEMO_API_URL="http://127.0.0.1:3002"
VEVDEMO_BACKEND_PORT="3002"
VITE_VEVDEMO_API_BASE="http://127.0.0.1:3002"
VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID="06853553c4d3402698a17ff5dff87fd7"
```

VevDemo 后端目录下不应放置本地 dotenv 密钥文件；后端启动时会直接读取外部
`/Users/mark/Documents/key/origin.env.local`。VevDemo 前端需要 Vite 在构建时读取公开变量，因此只从外部配置源同步公开 `VITE_*` 到前端本地 env：

```bash
cd /Users/mark/Documents/origin
npm run sync:vevdemo-env
```

该命令只生成：

- `/Users/mark/Documents/origin/vevdemo-1.0.6/fe/.env.local`：只包含 `VITE_*` 公开变量，是生成物，不要手工维护。

不要把 `VOLC_*`、`SECRET`、`ACCESS_KEY`、`TOKEN`、`PASSWORD`、`API_KEY` 等密钥写入 VevDemo 内部任何前端或后端 env 文件。外部 `/Users/mark/Documents/key/origin.env.local` 是唯一权威配置源。

### 3. 安装依赖

不要复制旧目录的 `node_modules`。在迁入后的目录内重新安装：

```bash
cd /Users/mark/Documents/origin/vevdemo-1.0.6/nodejs
npm ci --replace-registry-host=always

cd /Users/mark/Documents/origin/vevdemo-1.0.6/fe
npm ci --replace-registry-host=always
```

如果本机 npm 低于 10，`--replace-registry-host=always` 不可用。此时可改用 `npm install --registry=https://registry.npmjs.org/`，但会改写 VevDemo 的 lockfile，应单独记录。

### 4. 启动后端

```bash
cd /Users/mark/Documents/origin/vevdemo-1.0.6/nodejs
npm run dev
# 监听 http://127.0.0.1:3002
```

VevDemo 后端通过 `nodejs/utils/load-env.js` 读取 `/Users/mark/Documents/key/origin.env.local`；火山密钥只维护在这一份外部文件。

> 注意：如果 VOD 控制台没有配置 H.264/AAC 转码工作流，VevDemo 上传出来的 HEVC MP4 可能只有素材卡片和雪碧图，没有 `MainPlayUrl` / 可编辑转码产物，表现为视频素材无法拖入时间线。此时仅修改 Origin 代码无效，需要先在火山 VOD 控制台创建并开通对应工作流。
>
> 该配置只影响后续新上传的视频。历史 HEVC 素材不会自动重转码，需要删除后重新上传，或另行调用火山 VOD 工作流对存量 Vid 重新处理。上传后工作流是异步执行的，请等火山控制台显示转码完成，再运行素材可剪辑性审计脚本或回到 VevDemo 测试拖入轨道。
>
> 另外，VOD Space 必须配置有效的播放域名。若 `GetPlayInfo` 返回 `ResourceNotFound.NoAvailableDomain`，即使上传和转码已经成功，`MainPlayUrl` 仍为空，视频仍无法拖入时间线。这一步需要在火山 VOD 控制台绑定/启用播放域名与 CNAME，无法通过 Origin 代码自动补齐。

### 5. 启动前端

```bash
cd /Users/mark/Documents/origin/vevdemo-1.0.6/fe
npm run dev
# 监听 http://127.0.0.1:8084
```

### 6. 本地守护启动

本机开发时推荐让 watchdog 同时守住 VevDemo 后端和前端，避免在线精修页里的 iframe 因 `8084` 停掉而变成 `127.0.0.1 拒绝连接`：

```bash
cd /Users/mark/Documents/origin
npm run dev:vevdemo
```

watchdog 会：

- 按 `/Users/mark/Documents/key/origin.env.local` 同步公开 `VITE_*` 到 `vevdemo-1.0.6/fe/.env.local`
- 确保 VevDemo API 监听 `127.0.0.1:3002`
- 确保 VevDemo Editor 监听 `127.0.0.1:8084`
- 当服务停掉或健康检查失败时自动重启，但不会接管被其他项目占用的端口

日志位置：

- `/tmp/vevdemo-watchdog.log`
- `/tmp/vevdemo-backend.log`
- `/tmp/vevdemo-frontend.log`

当前机器还可以像 Origin 一样通过 macOS LaunchAgent 常驻运行，plist 路径约定为：

```bash
~/Library/LaunchAgents/com.origin.vevdemo-watchdog.plist
```

### 7. 验证部署

访问 http://127.0.0.1:8084，确认视频剪辑编辑器正常加载。

### 8. 配置 Origin

Origin 侧 VevDemo 配置以 `/Users/mark/Documents/key/origin.env.local` 为准，不再在 `origin/.env.local` 中维护第二份 `VEVDEMO_*`。关键项：

```bash
ONLINE_EDITOR_ENABLED=true
ONLINE_EDITOR_OPEN_MODE=iframe

VEVDEMO_EDITOR_URL=http://127.0.0.1:8084
VEVDEMO_API_URL=http://127.0.0.1:3002
VEVDEMO_BACKEND_PORT=3002
```

重启 Origin 服务后，进入「在线精修剪辑器」页面即可使用。

进入在线精修页时，Origin 会通过 `/api/online-editor/project-binding` 为当前
Origin 项目创建或复用一个 VevDemo 工程，并把 `vevProjectId / vevGroupId` 发送给
iframe。VevDemo bridge 收到后会重建编辑器实例并切到对应工程，避免多个 Origin
项目共用同一个 VevDemo 时间线。

---

## 架构说明

```
┌─────────────────────────────────────────┐
│  Origin (你的应用)                       │
│  ├── 后端 API: /api/volcengine/*        │
│  ├── 工程绑定: /api/online-editor/project-binding │
│  └── 前端: iframe -> VevDemo            │
└────────────────┬────────────────────────┘
                 │ postMessage
                 ▼
┌─────────────────────────────────────────┐
│  VevDemo (需单独部署)                   │
│  ├── VevDemo Editor（前端）: 127.0.0.1:8084 │
│  └── VevDemo API（后端）: 127.0.0.1:3002    │
└────────────────┬────────────────────────┘
                 │ SDK Token
                 ▼
┌─────────────────────────────────────────┐
│  火山引擎 API (云端)                     │
└─────────────────────────────────────────┘
```

## 常见问题

### Q: VevDemo 无法加载
检查：
1. VevDemo API（后端）是否运行在 127.0.0.1:3002
2. VevDemo Editor（前端）是否运行在 127.0.0.1:8084
3. `/Users/mark/Documents/key/origin.env.local` 是否包含 `VEVDEMO_*` 和 `VITE_*`
4. 是否已运行 `npm run sync:vevdemo-env` 生成 `vevdemo-1.0.6/fe/.env.local`

### Q: 素材无法导入
检查：
1. projectId 和 groupId 是否正确
2. `/Users/mark/Documents/key/origin.env.local` 中的火山 AccessKey/SecretKey 是否有权限
3. VOD Space 是否配置有效播放域名。`ResourceNotFound.NoAvailableDomain` 会导致视频有转码文件但无 `MainPlayUrl`，仍无法拖入轨道。

### Q: 点击「同步素材」到底做了什么

当前 Origin 的同步入口已经不是单纯检测 URL。主路径如下：

1. Origin `POST /api/volcengine/import` 接收当前项目的 `video_task` id。
2. 如果该视频已有 `data/vevdemo-material-bindings.json` 绑定，直接返回 `vevEditMid` / `vid://...`。
3. 如果没有绑定，Origin 后端会把本地 MP4 上传到 VOD，等待 H.264 播放流可用，再创建或查找 VevDemo EditMaterial。
4. VevDemo bridge 收到 `vevEditMid` 时直接复用该素材，不重复创建。

因此，真正能拖进 VevDemo 时间线的前提是：

- 视频是已完成的 `video_task`；
- VOD 上传、发布、H.264 转码和播放域名都正常；
- VevDemo EditMaterial 创建或复用成功。

`uploads` 表中的本地上传文件、需要 Origin cookie 的私有 URL，以及没有 `vid://` /
`mid://` / `tos://` / `directurl://` 来源的素材，在当前阶段仍然不能自动注册为可拖拽素材。

### Q: 如何手动注册单个 Origin 视频用于排查

自动同步失败时，可以先用脚本验证单条链路。脚本会读取外部
`/Users/mark/Documents/key/origin.env.local`，并写入
`data/vevdemo-material-bindings.json`：

```bash
cd /Users/mark/Documents/origin
npx tsx scripts/register-origin-video-vevdemo.cjs <video_task_id> --owner <owner_id>
```

成功后再次进入在线精修页点击「同步素材」，对应素材应返回已绑定的 `vevEditMid`。

### Q: 不同 Origin 项目会不会互相污染时间线

当前主路径会为每个 Origin 项目维护一条 VevDemo 工程绑定：

- 绑定文件：`data/vevdemo-project-bindings.json`
- 新建工程：Origin 后端调用火山 `CreateProject`
- 切换工程：Origin 发送 `origin:setProject`，VevDemo bridge 重建编辑器实例
- 素材注册：`data/vevdemo-material-bindings.json` 里的素材绑定会记录目标
  `vevProjectId`，不同 VevDemo 工程会分别创建或复用自己的 EditMaterial

素材绑定的新写入 key 使用 `resourceType:resourceId:vevProjectId`，允许同一个 Origin
视频在多个 VevDemo 工程下拥有不同的 `vevEditMid`。历史
`resourceType:resourceId` key 仍兼容：只有当它没有 `vevProjectId`，或它的
`vevProjectId` 与当前目标工程一致时才会被读取。

这解决了本地开发和单实例部署下的项目级隔离。生产多 worker / 多副本部署时，
当前 JSON 文件与进程内锁仍不是最终形态，后续应迁到数据库锁和表结构。

### Q: 导出失败
检查：
1. 火山云存储是否配置
2. 导出回调 URL 是否可访问

### Q: 导出完成后 Origin 如何记录结果

当前有两条入口，底层写入同一张 `exports` 表：

- 浏览器会话路径：Origin 父页面收到 `vevdemo:exportComplete` 后调用
  `/api/online-editor/export-complete`。这条路径依赖当前登录用户的
  `Authorization`，用于 iframe 内编辑器的 P0 闭环。
- 外部 webhook 路径：VevDemo 后端或火山云端回调
  `/api/volcengine/export-callback`。生产环境必须携带 HMAC 头，不允许把
  callback secret 放进前端。HMAC webhook 没有 Origin 登录态，请在 body 里提供
  `projectId`（Origin 会从项目归属推导 owner）或显式 `ownerId`。

两条路径都会把远程 MP4 地址写入 `exports.edl_json.vevDemo`。只有下载队列把远程
MP4 落到 `data/exports/<owner>/...` 后，`exports.filename` 才会被置位。
