# 首帧失败不再用「分镜原图」冒充 — 执行方案（逐行）

状态：可执行 / 手动改写
日期：2026-06-08
决策：D1 旧污染数据不处理（只防以后复现）｜D2 复用现有硬阻断闸，不新增拦截

---

## 0. 目标与适用范围
- **要达成**：首帧生成失败/缺失时 →（显示）面板显示「生成失败、无图」；（视频）被现有闸硬阻断，绝不拿分镜原图当 first_frame 喂下游。
- **适用**：**以后的新失败**。已污染的旧记录（如当前镜头10）**不回溯修复**（见 §5）。

## 1. 根因（一句话）
后端 `resolveStoryboardFirstFrameUrl` 口径太宽（含 `url`/`imageUrl`/`rawUrl` 这三个「通用分镜图」字段）。首帧失败时 `normalizeFirstFrameState` 用它 seed `firstFrame.currentUrl`，把分镜原图写进了 canonical 字段 → 状态被标 `degraded` 而非 `failed`，于是显示借图、视频闸（`degraded` 只告警不拦）被骗开。

实测证据（`data/qd.sqlite` · `proj_1780831509375` · `storyboards[8]`）：`firstFrame.history` 空、`firstFrameMode` null、`firstFrame.currentUrl === storyboard.url === storyboard.imageUrl`（同一张 `fcbc3d5f…`）。

---

## 2. 改动清单

### ✅ 改动 1（必改 · 核心）— 收窄后端中心 resolver
**文件**：`lib/visual-reference-state.ts`（约 23–32 行）

**改前**
```ts
export function resolveStoryboardFirstFrameUrl(storyboard: any): string {
  return cleanUrl(
    storyboard?.firstFrame?.currentUrl ||
      storyboard?.frames?.first?.url ||
      storyboard?.firstFrameUrl ||
      storyboard?.url ||
      storyboard?.imageUrl ||
      storyboard?.rawUrl,
  );
}
```

**改后**
```ts
export function resolveStoryboardFirstFrameUrl(storyboard: any): string {
  // 只认首帧专用字段。url/imageUrl/rawUrl 是「通用分镜图」(分镜原图/草图)，
  // 不保证是合格彩色首帧——纳入会让失败首帧借分镜原图冒充(显示 + 喂视频)。
  return cleanUrl(
    storyboard?.firstFrame?.currentUrl ||
      storyboard?.frames?.first?.url ||
      storyboard?.firstFrameUrl,
  );
}
```

**连锁效果（这一处就够覆盖两条主路径）**
- `normalizeFirstFrameState:38` 不再 seed 原图 → `markFirstFrameFailed` `hasFallback=false` → `status='failed'`、`currentUrl=undefined`。
- 前端 `firstFrameImageUrl`（已是 canonical）读不到 url → 面板显示「生成失败、无图」。
- 单图视频 `video/submit` → `resolveVideoPayloadDecision:157` `!firstFramePath` → hardFail「请先生成首帧」。
- 批量视频 → `deriveFirstFrameReadiness` `status='failed'` → `canStart=false` → `assertVideoPromptReadyForGroups` 在 `batch-executors:2400` `throw` / `batch/start:427` 返回 400。**根本走不到** `batch-executors:2524` 的草图兜底。

### ✅ 改动 2（必改 · 前端镜像）— 失败时不再乐观借原图
**文件**：`public/modules/storyboard.js:769`（函数 `_clearFailedStoryboardLocally`）

**改前**
```js
    var fallbackUrl = (sb.firstFrame && (sb.firstFrame.currentUrl || sb.firstFrame.lastKnownGoodUrl)) || sb.firstFrameUrl || sb.url || sb.imageUrl || sb.rawUrl || "";
```

**改后**
```js
    // 与后端 resolveStoryboardFirstFrameUrl 口径对齐：只认首帧专用字段，
    // 不再用分镜原图(url/imageUrl/rawUrl)兜底，否则失败瞬间客户端会乐观把原图塞进 currentUrl 并标 degraded。
    var fallbackUrl = (sb.firstFrame && (sb.firstFrame.currentUrl || sb.firstFrame.lastKnownGoodUrl)) || (sb.frames && sb.frames.first && sb.frames.first.url) || sb.firstFrameUrl || "";
```
**别忘了**：按你的缓存规则在 `workspace.html` 给 storyboard.js 链路 bump `?v`。

### 🟡 改动 3（建议一并 · 口径一致）— hash 不再把原图算进去
**文件**：`lib/video-prompt-lifecycle.ts:281`

**改前**
```ts
  const firstFrameUrl = cleanUrlForHash(resolveStoryboardFirstFrameUrl(sb) || sb?.firstFrameUrl || sb?.imageUrl || sb?.rawUrl || sb?.url);
```

**改后**
```ts
  const firstFrameUrl = cleanUrlForHash(resolveStoryboardFirstFrameUrl(sb));
```
（`resolveStoryboardFirstFrameUrl` 已含 `firstFrameUrl`；去掉 `imageUrl/rawUrl/url` 防止原图进 source-hash。）

---

## 3. 明确「不动」清单（最小影响面）
- `lib/batch-executors.ts:2524`、`lib/video-prompt-audit.ts:155` 的 `sb.rawUrl||sb.url||sb.imageUrl` 兜底：role 标的是 `storyboard_sketch`（非 first_frame），且失败/缺首帧镜头已被 §2 改动1 的上游闸（`batch-executors:2400`/`batch/start:427`）拦死，执行不到。保留 = 不破坏旧项目草图回退。
- `app/api/frames/set-current-from-history/route.ts:28`、`app/api/frames/plan/route.ts:33`、`public/modules/project.js:43`、各列表/缩略图：分别是历史恢复取值、帧规划、封面缩略图，**不在**「首帧显示 / 喂视频首帧」主路径。本期不动；若日后要彻底统一口径再单列。

---

## 4. 不需要的改动（已确认现状即正确）
- **不新增视频阻断**：硬阻断闸本就存在且语义正确（`resolveVideoPayloadDecision:157` + `deriveFirstFrameReadiness`）。当前失效纯因被原图骗开；改动1 让它们自动恢复。

## 5. ⚠️ 旧数据后果（D1 的直接结果，先说清）
- 镜头10（`storyboards[8]`）的 `firstFrame.currentUrl` 已持久化成分镜原图。`normalizeFirstFrameState:38/47` 是 `existing.currentUrl || …` / `existing.status || …`，旧值有就保留 → **改后这条旧记录仍会显示那张图、视频仍可能取到它**。
- 想让镜头10 也立刻正确：**成功生成一次首帧** 或 **删除该镜头**。本方案保证的是「以后新失败不复现」，不是回溯修旧数据。

---

## 6. 测试

**新增用例**（建议加进 `scripts/test-visual-reference-state.js`）：构造「无 canonical 首帧字段、只有 `url`/`imageUrl`、带 `firstFrameLastError`」的 sb：
- `resolveStoryboardFirstFrameUrl(sb) === ''`
- `markFirstFrameFailed(sb, {message:'x'}).status === 'failed'` 且 `.currentUrl === undefined`
- `deriveFirstFrameReadiness(sb, 0)` → `canStart === false`、`reason === 'first_frame_failed'`
- `resolveVideoPayloadDecision({ submitMode:'auto', firstLastFeatureEnabled:false, capabilityFirstLastSupported:false, firstFramePath:'', tailIntentRequested:false }).hardFail === true`、`failureCode === 'preflight_missing_first_frame'`
- **反向不误伤**：`{ firstFrame:{ currentUrl:'/x', status:'ready' } }` → `resolveStoryboardFirstFrameUrl` 非空、`deriveFirstFrameReadiness.canStart === true`

**复跑（都已存在）**
```
node scripts/test-visual-reference-state.js
node scripts/test-first-frame-display-preflight-consistency.js
node scripts/test-video-payload-decision.js
node scripts/test-tail-frame-no-auto-stale.js
```

## 7. 手测验证 checklist
1. 让一个首帧被安全拦 → 失败后面板显示「生成失败 + 无图」（不再借分镜原图）。
2. 对该失败镜头点生成视频：单图报「片段缺少可用首帧」；批量被 `video_segment_preflight_failed` 拦。
3. 正常已生成首帧的镜头：显示与生视频均不受影响（回归）。
