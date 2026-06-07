# 片段历史视频弹窗 — 方案

## 目标
在片段工作台「已完成」行的操作区，删除（🗑）图标**左侧**加一个历史图标（`history`）。点击弹出一个弹窗：
- **左侧**：1:1 视频播放框，中间一个播放按钮，点击播放当前选中的视频。
- **右侧**：该片段的历史视频列表，每张卡片显示「视频名称、生成时间、替换按钮」。点击「替换」把当前片段视频及关联信息换成该历史视频，被替换掉的当前视频留在历史列表里。

## 已确认的产品口径
1. **历史范围**：仅显示与当前镜头匹配的记录（下方「过滤语义」有说明）。
2. **视频名称**：`片段名 + 时间`，如 `03_片段_特写 · 05-27 15:16`。
3. **失败记录**：不显示，只列出有可播放视频的成功记录。

## 现状（已核对代码）
- 每个片段的「当前视频」存在 `project.storyboards[gIdx]`（`videoUrl / _originVideoUrl / videoTaskId / videoDurationSec / videoIsCurrent …`）和并行的 `project.videoTasks[gIdx]`（`url / taskId / durationSec / isCurrent …`）。设当前视频的统一入口是 `_markGroupVideoCurrent(gIdx, url, opts)`（videoTasks.js）。
- 数据库 `video_tasks` 表**本来就为每个 group_idx 存了多条历史**（重试/重生成都留痕，带 `created_at / prompt / cover_image_id / duration_sec`）。
- 但现有 `GET /api/tasks/video-by-project` 为了「刷新补绑」只**每组保留最新一条**（`seen` 去重）。所以要做历史列表，后端必须新增一个「返回整组历史」的读法。
- 操作按钮（播放 / 重新生成 / 🗑 / ⋮）由 videoTasks.js 的 live-row 模板在「已完成」分支拼出；删除是 `mirror-delete-btn`。**历史图标插在 `deleteBtnHtml` 之前**即可，单点插入。

## 改动点

### 1) 后端 `app/api/tasks/video-by-project/route.ts`
- **GET 增加整组历史模式**：`?projectId=X&groupIdx=N&history=1`
  - 查询：`WHERE owner_id AND project_id AND group_idx=@gi AND status∈(succeeded/done/completed) AND filename NOT NULL ORDER BY created_at DESC`，**不做 `seen` 去重**。
  - 每条返回 `task_id / url(signed) / protected_url / cover_url / duration_sec / created_at / is_current`（`is_current` = 与当前 `storyboards[gi].videoTaskId / videoUrl` 比对）。
  - **过滤语义（对应「仅匹配当前镜头」）**：整组先过一次 `storyboardShotIndices(project, gi, sb, {single-shot-strict})`——当前 slot 还是合法单镜头才返回该组历史，否则返回空。即「当前镜头没被改散，就展示它的全部成功生成历史」。默认 GET（不带 `groupIdx`）行为保持不变，避免影响刷新补绑。
- **POST 新增「设为当前」动作**：`{ action:'set-current', projectId, groupIdx, taskId }`
  - 服务端校验该 `taskId` 属于该 group 且成功，写回 `storyboards[gIdx]` + `videoTasks[gIdx]` 指向它（复用现有 current/clear 逻辑），并**同步剪辑时间线**（沿用 DELETE 里的 `editData.edl` 更新 + `syncEditProjectClips`），避免替换后剪辑里仍是旧片。返回新的 `readiness / serverVersion`。
  - 选这种「专用动作」而非前端 `_markGroupVideoCurrent + saveProject` 全量 PUT，是为了和现有删除一样避免整包覆盖（videoTasks.js:1649 已有此教训）。

### 2) 前端 `public/modules/videoTasks.js`
- live-row「已完成」分支：在 `deleteBtnHtml` 前加 `historyBtnHtml`（`history` 图标，`data-action="open-video-history"`，带 `data-group-idx`）。
- 事件委托加 `open-video-history` 分支：拉 `GET ...history=1` → 打开弹窗。
- 替换：点卡片「替换」→ `POST set-current` → 成功后刷新该片段卡片（复用现有 `_markGroupVideoCurrent` 更新本地态 + 重渲染），toast 提示；被替换的旧视频自然仍在历史列表里。
- 左侧播放：复用现有内联播放器的取流方式（signed/protected URL → `<video controls autoplay>`），默认用 `cover_url` 作为 1:1 框的封面 + 居中播放按钮；点卡片切换「选中」并载入左侧，点播放按钮播放。
- 弹窗 DOM 动态构建后 append 到 body（和内联播放器一样不写死在 HTML），ESC / 点遮罩关闭。

### 3) 样式 `public/styles.css`
- 新增弹窗遮罩 + 两栏布局（左 1:1 播放框、右列表滚动）、历史卡片、选中态、替换按钮等。复用现有色板与 `.batch-row-icon-action` 图标按钮风格。

## 交互细节 / 边界
- 打开弹窗默认选中「当前视频」（列表里标 `当前` 徽标，其「替换」按钮置灰）。
- 替换默认**不二次确认**（旧视频不丢，只是不再是当前），仅 toast。如需确认可加。
- 该片段尚无任何成功生成时，历史图标不显示（无意义）。
- 仅成功且有 `filename` 的记录入列；签名 URL 复用 `buildSignedVideoUrl`。

## 工作量 / 风险
- 后端：~1 个文件，GET 加分支 + POST 加 handler，复用现有 helper，风险低。
- 前端：videoTasks.js 加按钮 + 事件 + 弹窗渲染（~150 行），styles.css 加弹窗样式。
- 主要风险点：替换后的剪辑时间线同步（已规划复用 DELETE 的同步逻辑）；「仅匹配当前镜头」的过滤语义需你确认是否就按上面的「整组合法 slot → 展示全部成功历史」理解。

---
**请确认**：以上「仅匹配当前镜头」的过滤语义、`set-current` 走专用后端动作、替换不二次确认这几点 OK 的话，我就按此实现。
