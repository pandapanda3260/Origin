# 方案三 · 分镜首帧候选模型 v2.6（执行定稿）

> 本版是把 v1 → v2.5 的全部评审结论合并、去补丁化后的完整执行方案。所有决策已拍板，不留选项。
> 行号是 2026-06-29 当前工作树扫描结果，**执行前对每个锚点再 `rg` 一次**（工作树是脏的，行号可能漂移）。
> 未经确认不得改代码；本文件只是给 Codex / Claude Code 的执行蓝本。

---

## 0. 目标、边界、全局决策

### 0.1 目标
把"片段 group 级一张段首首帧"升级为"片段内每个镜头各自拥有候选首帧、显式选中、生成/上传/编辑只追加不覆盖"：

```js
storyboards[g].shotFrames[shotUid] = {
  candidates: [ /* ShotFrameCandidate */ ],
  selectedCandidateId: "ff_xxx"
}
```

### 0.2 边界（本方案明确不做）
- 不做老项目持久迁移，只做读时投影。
- 不让视频消费"每镜头多关键帧"（那是方案四）；视频侧仍只吃**段首** selected 候选的兼容字段。
- 不做局部 mask 编辑（方案二），FFE 整图重生只追加 `source:"edit"` 候选。
- 不退役旧 storyboard 页 UI；flag off 完全保持现状。

### 0.3 全局决策（拍板清单，执行不得偏离）
1. `shotUid` 是唯一数据主键，**前后端统一只认 `shot.shotUid ?? shot.shot_uid`**；`id/uid/shotId/shot-N` 一律不得作为 `shotFrames` 读写 key。
2. 候选**追加不覆盖**；`selectedCandidateId` 是唯一选中权威，绝不依赖 DOM 顺序。
3. 每个 shot 候选上限 `MAX_SHOT_FRAME_CANDIDATES = 12`；裁剪永远保留 selected。
4. 重元数据（planSummary/safetyAudit/consistencyCheck 等）只保留在 **selected + 最近 3 个候选**，其余压缩为轻字段。
5. `resolveStoryboardFirstFrameUrl(storyboard)` **不改签名**、不读 `shotFrames`；段首兼容字段全部由服务端 mirror helper 写回。
6. mirror helper **直写** legacy 字段，**禁止调用 `markFirstFrameReady`**，不写 `firstFrame.history` / `imageHistory`。
7. 段首 effective anchor（`url + mode`）变化时，服务端**两侧都标 outdated**：storyboard 走 `markStoryboardVideoOutdated`、`videoTasks[g]` 走 `markVideoTaskOutdated`，并**扩展 reason 联合类型**新增 `'first_frame_candidate_changed'`。
8. active overlap 对 `storyboard_images` 升级为按 `(groupIdx, shotUid)` 判断。
9. staleness 采用**上下文感知 per-shot hash**：solo 段只脏自己，合并段任一 shot 改动则全段候选脏（不做会漏报的单 shot-only hash）。
10. 逐镜头生成必须在 `batch/start` 展开成 per-shot targets，**严禁 executor 内部暗循环 N 张**（否则计费/进度/退款按 group 少算）。
11. 候选上限 + 元数据压缩 + 视频失效 + mirror 必须在 **Phase 3-0** 完成，不能等 UI。

---

## 1. 当前代码锚点（已扫描）

| 事实 | 位置 | 对方案的意义 |
|---|---|---|
| 前端 `shotUidOf` 用 `uid/id` 优先 | `public/modules/board_state.js:56` | 必须统一到后端口径 |
| board 已有 `shotRows` + 段首占位候选 | `board_state.js:116/121/124` | 候选行 UI 落点 |
| 后端 canonical shotUid 只认 `shotUid/shot_uid` | `lib/shot-plan-normalize.ts:86`、`lib/group-slot-write-guard.ts:43` | 候选 key 权威源 |
| `id/uid` 不在 INTERNAL_KEYS、会透传 | `shot-plan-normalize.ts:17` + `:214` | 不能用 `id/uid` 兜底 key |
| 首帧读取咽喉只读三源链 | `lib/visual-reference-state.ts:41` + `public/modules/frameRecommendations.js:7` | 读侧不改，靠写侧 mirror |
| `markFirstFrameReady` 会 push history 并裁到 20 | `visual-reference-state.ts:117`（slice 在 `:124`） | mirror 禁调它；候选要自带帽子 |
| executor 现在经 `markFirstFrameReady` 写 firstFrame | `lib/batch-executors.ts:1960`（整块写在 `1953-1988`） | mirror 复用字段形状但直写 |
| 尾帧门控读 `firstFrameMode`+`frames.first.status` | `visual-reference-state.ts:377-389`、`frameRecommendations.js:21` | mirror 必须写 mode/status |
| `storyboard_images` executor 一 task 写一 group 单图 | `batch-executors.ts:1740` | 扩成 per-shot |
| 生成计划 first_frame 固定取段首 | `lib/frame-image-plan.ts:463` + `primaryPos` `:479` | 加 primaryShotUid/Idx 输入 |
| active overlap 只按 groupIdx | `lib/batches.ts:568`（canReuse `:621`，label `:561`） | 升级 `(groupIdx, shotUid)` |
| batch total=targets.length、image 单价按 task | `batches.ts:788`、`lib/batch-task-accounting.ts:4` | per-shot 展开后计费自然正确 |
| group 级首帧 hash | `lib/frame-workflow-state.ts:230`（+`:275`），stale key `storyboard_${g}` 在 `:940` | 新增 per-shot 上下文 hash |
| 视频失效权威 helper（双侧） | `lib/video-prompt-state.ts:139`（reason 联合 `:141`，artifact 闸 `:145`）、`:160`（`:162`） | candidate 路径复用，扩 reason |
| 前端视频失效双写 sb+videoTasks | `public/modules/videoPrompts.js:89-100` | 服务端要同样两侧都写 |
| 前端首帧变化失效是增量 patch 钩子 | `storyboard.js:1154`；reload 是整包替换 `public/main.js:8251` | candidate 服务端路由不经此钩子 |
| board 视频状态只读持久 flag（OR vt.isCurrent） | `board_state.js:42` | 必须服务端写 `videoIsCurrent=false` |
| upload 首帧覆盖单值 + history slice(0,20) | `app/api/frames/upload/route.ts:181`（slice `:206`） | flag on 改追加候选 |
| frames/delete 只放尾帧 | `app/api/frames/delete/route.ts:62` | 首帧候选删除走新端点 |
| 项目已有 `_MAX_IMAGE_HISTORY=20` 惯例 | `public/modules/project.js:29`（裁剪 `:933`） | 候选上限 12 有先例支撑 |
| board ctx 注入点 | `main.js:8218` 的 `initBoard({...})`；`BOARD_CTX_KEYS` 在 `board.js:8` | 扩 board 能力改这里 |
| `generateStoryboardSheet` 来源 | `storyboard.js:7594`，`main.js:45` 已 import | 一键全生成复用它 |
| board 图片/相机契约被测试锁定 | `board.js:33`(并发6)/`:84`(shouldLoadThumb)/`:128`(observer)/`:572`(applyCamera)；契约 `scripts/test-board-readonly-contract.mjs:60` | 候选图必须复用现机制 |
| import map | `public/workspace.html:1868`（`board.js?v=5`/`board_state.js?v=3`） | 改模块按现行版本继续 bump |
| merge 测试文件在、缺 npm script | `scripts/test-frame-workflow-merge.ts` 存在；`package.json:47` 只有 `test:frame-workflow-state` | 补 npm script |

---

## 2. 数据模型与常量

```ts
// lib/visual-reference-state.ts
export const MAX_SHOT_FRAME_CANDIDATES = 12;
export const SHOT_FRAME_FULL_METADATA_KEEP_RECENT = 3;

export type ShotFrameCandidate = {
  // 轻字段（永远保留，压缩时不动）
  id: string;                 // 'ff_' + randomUUID()，服务端生成，前端不得自造
  url: string;
  source: 'gen' | 'upload' | 'edit';
  mode: 'structured_v1' | 'multi_ref_v1' | 'uploaded' | 'history_restore';
  status: 'ready';            // 只存成功候选
  createdAt: string;
  sourceHash?: string;
  taskId?: string;
  prompt?: string;
  // 重字段（只在 selected + 最近 3 个候选上保留）
  metadataTier?: 'full' | 'compact';
  originalPrompt?: string;
  assetId?: string;
  generatedAt?: string;
  planSummary?: unknown;
  safetyAudit?: unknown;
  consistencyCheck?: unknown;
  consistencyAttempts?: number;
  consistencyStatus?: string;
  visualAnchorDescription?: string;
};

export type ShotFrameState = {
  candidates: ShotFrameCandidate[];
  selectedCandidateId?: string;
};
// storyboards[g].shotFrames: Record<shotUid, ShotFrameState>
```

规则：
- `candidates[]` 是新模型唯一图片历史来源；`firstFrame.history` / `imageHistory` 不再被新模型写入（只作旧数据读时投影源）。
- 失败不入 `candidates`。
- 生成/上传/编辑都 `append` 并默认选中最新。

---

## 3. 候选归一化 / 裁剪 / 压缩（Phase 3-0 必交付）

### 3.1 新增 helper（`lib/visual-reference-state.ts`）
```ts
normalizeShotFrameState(state: ShotFrameState): ShotFrameState
appendShotFrameCandidate(state: ShotFrameState, c: ShotFrameCandidate): ShotFrameState
compactShotFrameCandidate(c: ShotFrameCandidate): ShotFrameCandidate  // 剥重字段，置 metadataTier:'compact'
getSelectedShotFrameCandidate(state): ShotFrameCandidate | null
```

### 3.2 拍板规则（每条都要有测试锁）
- **入口收敛**：append / select / reorder / delete 四类操作后，都必须调用 `normalizeShotFrameState`，禁止任一路径绕过。
- **选中兜底**：`selectedCandidateId` 缺失或指向不存在候选时，默认选 `createdAt` 最新的候选。
- **裁剪**：`candidates.length > 12` 时，按 `createdAt` 升序删除**最旧的非 selected 候选**直到 12；**selected 永不裁**。
- **顺序**：裁剪只删不重排，保留下来的候选维持原有 UI 顺序。
- **压缩**：保留全量元数据的集合 = `{selected} ∪ {按 createdAt 最新的 3 个}`；不在此集合的候选用 `compactShotFrameCandidate` 剥掉 `planSummary/safetyAudit/consistencyCheck/consistencyAttempts/visualAnchorDescription/originalPrompt`，置 `metadataTier:'compact'`。
- **选中 compact 候选**：mirror 时只写轻字段，并**清掉 legacy 上旧候选残留的 heavy metadata**（见 §4 清理规则），不报错。

---

## 4. mirror helper（Phase 3-0 必交付）

### 4.1 签名与职责
```ts
// lib/visual-reference-state.ts
mirrorSelectedFirstFrameToLegacyFields(fresh: any, groupIdx: number): {
  storyboardsPatched: boolean;
  videoInvalidated: boolean;
}
```
在 `patchProjectForUser` 的 mutator 内（executor / candidate / upload-edit 都已持有 `fresh`）调用，直接改 `fresh.storyboards[groupIdx]` 与（必要时）`fresh.videoTasks[groupIdx]`。

### 4.2 段首 shotUid 解析
段首 = `storyboardShotIndices(fresh, groupIdx, sb, {mode:'single-shot-strict'})` 的第一个下标 → `fresh.shots[firstIdx].shotUid ?? shot_uid`。读 `sb.shotFrames[段首Uid].selectedCandidateId` 对应候选作为镜像源。

### 4.3 字段清单（直写，禁经 `markFirstFrameReady`）
顶层：`url / imageUrl / rawUrl / firstFrameUrl / firstFrameMode / firstFrameSourceHash / firstFramePrompt / imagePrompt / firstFramePlanSummary / firstFrameSafetyAudit / firstFrameConsistencyCheck / firstFrameConsistencyStatus / effectiveVisualDescription`

`firstFrame.*`：`currentUrl / rawUrl / status:'ready' / source / lastKnownGoodUrl / sourceHash / safetyAudit / visualAnchorDescription / consistencyCheck / consistencyStatus`（**不写 `history`**）

`frames.first.*`：`url / status:'ready' / source / mode / sourceHash / prompt / originalPrompt / planSummary / safetyAudit / visualAnchorDescription / consistencyCheck / consistencyAttempts / consistencyStatus / generatedAt / shotIndices`

### 4.4 mode 映射
`gen → structured_v1`（生成结果显式给更具体 mode 则用其值）、`upload → uploaded`、`edit → multi_ref_v1`、老数据投影保留原 `firstFrameMode || frames.first.mode`。

### 4.5 清理规则
- selected 候选缺 safety/consistency/planSummary 时，清掉 legacy 上对应字段（避免旧候选脏值残留）。
- 段首无候选时，清掉首帧输出字段，但保留 `shotIndices`、edit draft、backup 等用户态字段；并清 `firstFrameLastError / firstFrameFailedAt`（candidates 只存 ready）。

### 4.6 视频失效（mirror 内的副作用，单点触发）
mirror 在写入前后比较段首 anchor `(url, mode)`：
- anchor **变化**且该段**有视频 artifact**（复用 `hasStoryboardVideoArtifact` 判断）时：
  - `fresh.storyboards[g] = markStoryboardVideoOutdated(sb, 'first_frame_candidate_changed')`
  - `fresh.videoTasks[g] = markVideoTaskOutdated(fresh.videoTasks[g], 'first_frame_candidate_changed')`
  - **两侧都写**，对齐 `videoPrompts.js:89-100` 的双写语义；只写 sb 一侧会让任务列表/overview 仍显示 current → 分裂态。
- **前置改动**：在 `lib/video-prompt-state.ts` 把 `markStoryboardVideoOutdated` 与 `markVideoTaskOutdated` 的 `reason` 联合类型扩为
  `'video_prompt_regeneration' | 'video_prompt_failed' | 'first_frame_candidate_changed'`。
- 不删旧视频 url/taskId，只标 outdated。
- 非段首候选变化、reorder 未改 selected → **不**触发失效。
- 尾帧不自动 stale（沿用现有"尾帧用户主动重做"原则，`frame-workflow-state.ts:943` 一带）。

---

## 5. staleness（Phase 3-0 必交付）

新增 `lib/frame-workflow-state.ts: computeFirstFrameSourceHashForShot(project, groupIdx, primaryShotIdx)`：
```js
hash({
  frameType: 'first_frame',
  shotIndices,          // 该段全部下标
  primaryShotIdx,
  primaryShotUid,
  shots: segmentShots,  // 段内全部 shot（含 context）
  styleBible,
  worldHash,
})
```
理由：首帧计划本来就吃段内 context（`frame-image-plan.ts` 的 `contextShots`），只 hash 单 shot 会漏报。
- 候选保存自己的 `sourceHash`；判定时 selected 候选 `sourceHash` ≠ 当前 shot hash → 该 shot 脏。
- 外部 `_staleFlags` 继续用 `storyboard_${g}`（沿用 `:940`），内部聚合 per-shot 明细，不扩散全仓 key。
- 验收：solo 段只脏自己；合并段任一 shot 改动 → 全段候选脏。

---

## 6. 后端落地

### 6.1 feature flag（`lib/feature-flags.ts`，仿 `:38` 范式）
`isPerShotFirstFrameEnabled()` 读 env `ORIGIN_PER_SHOT_FIRST_FRAME`，默认 **off**。
`app/api/config/client/route.ts:27` 的 `features` 增 `perShotFirstFrame`。**前端 flag 只控显示，服务端始终自校验，不依赖前端门控。**

### 6.2 服务端 shotUid guard（所有写入口）
`batch/start` 展开 / `storyboard_images` executor / `frames/candidate` / `frames/upload` / FFE-edit 写回：每处都校验 `shotUid` 非空且 ∈ 当前 group 的 shotUids；非法则路由 400 / executor abort。**legacy 项目（shots 无 shotUid）禁止写候选，只读投影。**

### 6.3 `batch/start`（`app/api/batch/start/route.ts`）
flag on + `batchType==='storyboard_images'` 时，把 group target 展开为 per-shot：
```js
{ groupIdx, shotUid, shotIndex, shotIndices }
```
- 读 `project.shots[shotIndices].shotUid` 生成；跳过无 shotUid 的 shot；若某 group 全无 shotUid → 明确报错（legacy 不可用 per-shot），不静默写空 key。
- 单镜重生前端直接传 `{groupIdx, shotUid}`（已是 per-shot，不再展开）。
- preflight warning/block 按 group 去重（避免同段 N 份重复提示）。
- `createBatch.total = targets.length` 不动（计费/进度自然按 N）。
- 复用现有 `attachExpectedShotBindingsToTargets`（`group-slot-write-guard.ts:77`）给 target 挂 binding。

### 6.4 active overlap（`lib/batches.ts`）
`_findActiveGroupBatchOverlap`（`:568`）对 `storyboard_images` 特判：
- 提取 target 的 `(groupIdx, shotUid)` 而非仅 groupIdx；`requested` 改为 (group,shot) 元组集合。
- SQL `groupExpr` 增提 `$.shotUid`，按 (group,shot) 求覆盖。
- `canReuse`（`:621`）= 同 (group,shot) 完全覆盖且单批次。
- `ActiveVideoBatchConflictError` payload 同步携带 shotUid（UI 可仍聚合成 group 展示）。
- 验收：同 group 不同 shot 可并发；单镜重生不被整段运行批次吞掉。

### 6.5 `storyboard_images` executor（`lib/batch-executors.ts:1740`）
flag on：
- 每个 task 只处理 `ctx.target.shotUid` 一个候选；写回前再次确认 shotUid ∈ 解析出的 shotIndices。
- `frame-image-plan.ts` 增 `primaryShotUid/primaryShotIdx` 输入；first_frame 不再固定 `primaryPos=0`，用 target shot 作 primary、段内其他作 context。
- 生成成功 → 构造 `ShotFrameCandidate`（id=`ff_`+randomUUID，全量元数据，mode 按 §4.4）→ `appendShotFrameCandidate` → 默认 selected。
- 通过 `writeGroupSlot` + binding guard（`group-slot-write-guard.ts:110`）写回，防 group 重排误写。
- 段首则调 `mirrorSelectedFirstFrameToLegacyFields`；**不调 `markFirstFrameReady`**。
- 进度：同 group 的 N 个 per-shot task 在前端按段聚合显示（见 §7.4）。

flag off：保持现 group 单图写法（`:1953` 整块不变）。

### 6.6 `frames/candidate`（新建 `app/api/frames/candidate/route.ts`）
```http
POST /api/frames/candidate
{ action: 'select'|'reorder'|'delete', projectId, groupIdx, shotUid, candidateId?, orderedIds? }
```
- 经 `patchProjectForUser` + `writeGroupSlot`(`mismatchPolicy:'abortPatch'`) 写回。
- 校验 shotUid ∈ group、candidate ∈ shot。
- `select`：改 `selectedCandidateId` → normalize → 段首则 mirror。
- `reorder`：按 `orderedIds` 重排；拖到最右同时 select → normalize → 段首变 selected 则 mirror。
- `delete`：删候选；若删的是 selected 回退相邻（normalize 兜底最新）；**回退后必 mirror**；删空且段首则 mirror 清 legacy。
- anchor 变化时 §4.6 双侧失效。**不依赖** `storyboard.js:1154`。不走整包 PUT。

### 6.7 upload / edit
`frames/upload`（`:181`）：flag on + shotUid 合法 → append `source:'upload', mode:'uploaded'` 候选 → 默认 selected → normalize → 段首 mirror；flag off 保持旧覆盖。
FFE/edit：append `source:'edit', mode:'multi_ref_v1'` → 默认 selected → normalize → 段首 mirror；不覆盖旧候选。edit draft 暂沿用现有 group 级草稿作用于段首 shot（per-shot 草稿隔离不在本版，列为后续）。
`set-current-from-history`：保留旧模型，新候选切换不走它。

---

## 7. 前端落地

### 7.1 `board_state.js`
- `shotUidOf`（`:56`）改成只取 `text(shot.shotUid ?? shot.shot_uid)`，无则返回空。
- `shotRows`（`:116/121`）从 `sb.shotFrames[shotUid].candidates` + `selectedCandidateId` 读；无新模型时仅段首投影一个 readonly legacy 候选（保持现 `segment-cover-placeholder` 语义）。
- 缺 canonical `shotUid` 的 row 标 `readOnlyReason`，不出生成/上传/编辑写入口；DOM 标识可用 shotIdx 兜底，但**数据 key 一律不许用 shotIdx/id**。

### 7.2 board ctx（`main.js:8218` 的 `initBoard`）
注入 `safeWriteBack`、`reloadProjectFromServer`、`generateStoryboardSheet`、候选动作 API helper、受保护图解析能力；同步扩 `board.js:8` 的 `BOARD_CTX_KEYS`。这些都是现成能力（`_safeWriteBack`/`reloadProjectFromServer` 已是 ctx 注入范式，`generateStoryboardSheet` `main.js:45` 已 import）。

### 7.3 候选行 UI（新增 `public/modules/board_candidates.js` + `board_actions.js`，改 `board.js`）
- 每 shot 一行横向候选卡；selected 高亮；空状态显示生成/上传。
- 卡操作：选中、重新生成（发 `{groupIdx, shotUid}` 单镜 target）、上传、编辑、删除、下载。
- 片段"一键全部生成"复用 `generateStoryboardSheet(gIdx)`，后端展开 per-shot；段内所有 shot 都有候选后该按钮隐藏。
- 拖序：新建候选行拖序（**不复用** `storyboard.js:7135` 的 `_initGalleryDrag`），拖到最右 = `reorder + select`，数据权威仍是 `selectedCandidateId`。

### 7.4 board 图片/相机契约（不得破，`test-board-readonly-contract.mjs:60` 锁定）
候选图必须复用：`data-board-src` 懒加载、`IntersectionObserver`、`BOARD_IMAGE_CONCURRENCY=6`、`shouldLoadThumb` 的 LOD+近视口、节点移除前 `unobserveBoardImages`、增量刷新不重置 camera、`applyCamera` 等有效 fit 后再 ready。候选图数量暴增（N shot × ≤12），懒加载/并发限/清理只会更关键。
进度聚合：storyboard 段进度条要把该 group 的 N 个 per-shot task 汇总展示（现有按 group 的进度假设要改成"段内 task 求和"）。

### 7.5 import map（`workspace.html:1868`）
新增 `board_candidates.js`/`board_actions.js` 条目并 bump，`board.js`/`board_state.js` 各 +1；改 `main.js` 按 HTML script 标签现行版本 bump。改完跑 `npm run verify:frontend`（cache-busting 哨兵会卡漏 bump）。

---

## 8. 分期与 file-level 交付物

### Phase 3-0：基础不变量（无 UI 大改、不改生成行为）
- `board_state.js`：`shotUidOf` 口径统一。
- `lib/visual-reference-state.ts`：常量 + `normalize/append/compact/getSelected` + `mirrorSelectedFirstFrameToLegacyFields`（含双侧视频失效）。
- `lib/video-prompt-state.ts`：reason 联合类型加 `first_frame_candidate_changed`。
- `lib/frame-workflow-state.ts`：`computeFirstFrameSourceHashForShot`。
- `lib/batches.ts`：active overlap 升 `(groupIdx, shotUid)`。
- 服务端各写入口 shotUid guard。
- `package.json`：补 `"test:frame-workflow-merge": "tsx scripts/test-frame-workflow-merge.ts"`。
- 验收：候选键只用 shotUid；单镜重生不被吞；段首 selected 删除后 legacy 三源链指向回退候选；候选超 12 正确裁剪且不丢 selected；mirror 不写 history、不调 markFirstFrameReady；段首 anchor 变 → sb+videoTasks 双侧 outdated。

### Phase 3-1：模型 + 端点 + 读投影（生成仍可保持旧 group 单图）
- `frames/candidate` 路由（select/reorder/delete）。
- `board_state.js` 读真实 `shotFrames`；老数据只读投影。
- 验收：追加不覆盖；select/reorder/delete 刷新后不丢/不串；老项目不被写迁移字段；下游视频仍读段首 legacy。

### Phase 3-2：逐镜头生成（flag on 才生效）
- `batch/start` per-shot 展开 + preflight 去重。
- `frame-image-plan.ts` primaryShot 输入；`batch-executors.ts` per-shot 写候选 + mirror。
- `frames/upload` / FFE-edit 追加候选。
- 验收：flag off 一段一张、flag on 一段 N 张、计费/进度/退款按 N；group 重排 guard 拒错写；合并段 staleness 全段脏。

### Phase 3-3：候选行 UI
- `board_candidates.js` / `board_actions.js` / `board.js` 候选行完整交互 + 进度聚合 + import map bump。
- 验收：候选图无 401 黑图；图多不卡死、相机不重置；readonly contract 通过。

---

## 9. 测试矩阵

新增（每条对应一个拍板规则）：
- `test:shotuid-canonical-contract` — 前后端同口径；`id/uid` 不得成候选 key；缺 shotUid 禁写。
- `test:storyboard-image-overlap-pershot` — 同 group 异 shot 并发；同 (group,shot) 才复用/冲突。
- `test:shot-frame-candidates` — 追加不覆盖、默认选最新、select/reorder/delete、删 selected 回退 + re-mirror。
- `test:shot-frame-candidate-cap` — 超 12 裁剪、selected 不裁、顺序不乱、selected 丢失回最新。
- `test:shot-frame-candidate-compact-metadata` — selected+最近3 留重字段、其余压缩、选 compact 候选清 legacy heavy。
- `test:first-frame-mirror-fields` — 写 mode/`frames.first.status='ready'`、不写 history、不调 markFirstFrameReady。
- `test:first-frame-candidate-video-invalidation` — 段首 anchor 变 → sb+videoTasks 双侧 `isCurrent=false`+reason；非段首/纯 reorder 不失效；无 artifact 不误标。
- `test:first-frame-compat-mirror` — 新模型/老数据/flag off 三态 `resolveStoryboardFirstFrameUrl` 正确；视频 payload 不缺首帧。
- `test:per-shot-frame-gen` — flag on N target/计费 N；flag off 一段一张。
- `test:first-frame-stale-pershot` — solo 段只脏自己；合并段全段脏。
- `test:board-candidate-ui-contract` — `data-board-src`/IntersectionObserver/并发6/unobserve/camera 不重置。
- 补 `test:frame-workflow-merge` npm script。

回归（必跑）：
`npm run verify:frontend`、`test:cache-busting`、`test:frame-workflow-state`、`test:frame-workflow-merge`、`test:group-slot-write-guard`、`test:frame-image-plan`、`test:batch-preflight`、`test:project-dependency-state`、`test:visual-reference-state`、`test:tail-frame-delete-no-resurrect`、`node scripts/test-board-projection.mjs`、`node scripts/test-board-readonly-contract.mjs`。

---

## 10. 最终验收清单
- flag off：旧首帧/上传/历史恢复/视频/尾帧行为完全不变。
- flag on：每个 `shotUid` 有独立候选集；一段 N 镜 = N task = N 计费。
- `id/uid` 不会导致候选 key 错位；缺 shotUid 项目只读。
- 单镜重生不被同 group 运行批次吞掉。
- 生成/上传/编辑只追加；selected 刷新/删除/重排后不丢不串。
- 每 shot 候选 ≤ 12；裁剪不丢 selected；compact 候选不带重 blob。
- 段首 selected 改变后 legacy URL/mode/status/prompt/safety/consistency 全同步；mirror 不写 history。
- 段首 anchor 改变后 sb + videoTasks **两侧** 持久化 outdated；尾帧不自动 stale。
- 尾帧按钮 / 服务端 preflight 不因 mode/status 缺失回归。
- 合并段 staleness 不漏报。
- board 候选图懒加载/并发/unobserve/camera 契约通过。
- 老项目无持久迁移；新模型不维护 history 双轨。
- 新增测试 + `npm run verify:frontend` 全绿。

---

## 11. 给执行方（Codex / Claude Code）的硬约束
1. 先做 Phase 3-0，禁止跳 UI。
2. 不改 `resolveStoryboardFirstFrameUrl` 签名、不读 `shotFrames`。
3. 不用 `id/uid/shotId/shot-N` 作候选 key。
4. 不允许 executor 内暗循环 N 张而 target 仍是 group。
5. 任何写候选的路径都必须过 `normalizeShotFrameState`，且段首变更必须过 mirror helper。
6. mirror 直写、禁调 `markFirstFrameReady`、禁写 `firstFrame.history`/`imageHistory`。
7. 视频失效必须 sb + videoTasks 两侧都写，且复用 `markStoryboardVideoOutdated`/`markVideoTaskOutdated`（先扩 reason 联合类型）。
8. 候选 UI 禁 eager 加载图片、禁重置 camera。
9. 每阶段测试落地后再进入下一阶段；改前端模块必 bump import map 并跑 `verify:frontend`。
10. 执行前对本文件每个行号锚点重新 `rg` 校准。

## 12. 明确不做（范围红线）
- 不做老项目候选迁移。
- 不做视频多关键帧消费（方案四）。
- 不做局部 mask 编辑（方案二）。
- 不做 per-shot edit draft 隔离（本版沿用 group 级草稿作用于段首）。
- 不退役旧 storyboard 页。
