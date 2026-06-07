# 剪辑 SDK 项目绑定 / 在线精修环境绑定 - 落地方案

> 状态:待审批(方向已锁,代码未动)
> 目标:把"剪辑 SDK / 在线精修"从通用 SDK 页,变成跟当前 Origin 项目绑定的编辑环境——进入即自动同步本项目素材,SDK 内能看到/导入的素材范围一律收口到"本项目",并按 EDL 自动铺轨。

---

## 0. 本次已锁定的口径

1. **"本任务" = 当前 Origin 项目(project_id)+ 当前剪辑页 EDL(editData.edl)**。代码里一切按 `project_id + editData.edl` 组织,没有比 project 更细又稳定的"任务"实体,故采纳。
2. **"项目历史视频" = 同 `project_id` 下所有 `completed` 的 `video_tasks`,含当前不在 EDL/storyboard 里的历史废弃片段**(口径 B)。
3. **视频库收口方式 = 换数据源**:`searchVideo` action 改打 Origin 项目级接口,而不是过滤火山 VOD 结果(过滤会漏掉项目里还没上云的视频)。
4. **自动导入 = 手动导入 = 同一数据源**:都用第 2 条这份"本项目全部 completed 视频"清单。

---

## 1. 现状结论(已扣真实代码,锚点见文件:行)

| 能力 | 现状 | 锚点 |
| --- | --- | --- |
| 项目↔VevDemo 工程绑定 | ✅ 已有,且 bridge 会 destroy+rebuild 真正切工程 | `online_editor.js:1062` `_bindCurrentOriginProjectToVevDemo`;`vevdemo-1.0.6/fe/index.js` `origin:setProject`→`newVeVEditor` |
| 同步素材按钮 | ✅ 手动:收集 EDL video id→`/api/volcengine/import`→自动传 VOD+建 EditMaterial+写 binding | `online_editor.js:1434` `importMaterialsToVevDemo`、`:1508` `_collectCurrentVideoResourceIds` |
| import 支持范围 | ⚠️ 只 completed `video_task`;`uploads` 一律标 unsupported;**BGM 完全没进** | `app/api/volcengine/import/route.ts:144/158` |
| 进入页自动同步 | ❌ 无。`vevdemo:ready` 只做 setProject+ping | `online_editor.js:1042` `_onVevDemoReady` |
| 自动铺轨 | ❌ 无 |  |
| actions 在我们手里 | ✅ `searchVideo`/`searchEditMaterial` 等都是我们注入的 action | `vevdemo-1.0.6/fe/index.js:370` actions、`fe/actions.js` |
| 视频库 = 账号级 | ✅ `searchVideo`→火山 `SearchVideo` 参数透传,**无项目维度** | `fe/actions.js:117`、`nodejs/services/demo.js:93` |
| 素材库 = 项目级 | ✅ `searchEditMaterial({ProjectId,Space})` 天然按工程过滤 | `fe/actions.js:76`、`nodejs/services/demo.js:19` |

**⚠️ 原需求里两处要纠正:**

- **转场词表**:Origin 真实 EDL 只有 `cut / fade / dissolve / wipe`(不是 `crossfade / fade_to_black / fade_from_black`)。结构 `timeline[i].transitionIn/Out = {type, duration}`,时长 cut=0 / fade=0.8 / dissolve=1.0 / wipe=0.7。锚点 `lib/edit-edl.ts:318/396`。
- **EDL 字段**:裁剪点是 `inPoint / outPoint`,另有 `duration`、`groupIdx`、`videoUrl`。锚点 `lib/edit-edl.ts:402`。

---

## 2. 三阶段总览 + 落地顺序

```
阶段1 项目范围收口   → 阶段2 进入自动同步(视频)   → 阶段3 自动铺轨(视频+转场+BGM)
   先做                先做                          第二步(依赖 SDK timeline 结构实测)
```

**第一版交付**:阶段 1 + 阶段 2(仅视频)。BGM 注册 + 自动铺轨放第二步。

---

## 3. 阶段 1:项目范围收口

### 1.1 新数据源:项目级"全部 completed 视频"清单

不新造接口,**扩 `/api/tasks/video-by-project`** 加一个新 mode(如 `?scope=all-completed`):

- 查询:`video_tasks WHERE owner_id AND project_id AND status='completed' AND filename NOT NULL`,**去掉** `rowBelongsToCurrentSlot` 过滤(口径 B 要的就是这些历史)。
- 去重:同一 `group_idx` 可能有多条历史(重试/被替换)。返回需带 `is_current`(是否当前 EDL/storyboard 命中)+ `created_at`,默认按 `group_idx, created_at DESC`,前端可分组展示"当前 / 历史"。
- 字段:复用现有 `?groupIdx=` 历史模式的形状(`task_id / duration_sec / cover_url / prompt / created_at / is_current` + 可播放 url),减少前端改动。锚点参照 `app/api/tasks/video-by-project/route.ts:149`。

### 1.2 `searchVideo` action 换源

把 `fe/actions.js` 的 `searchVideo` 从打 `/api/searchVideo`(VevDemo 后端→火山)**改成打 Origin 上面那个项目接口**,并把返回适配成 SDK 视频库期望的 shape。

> ⚠️ **这是阶段 1 最大的未知,必须先实测,不能猜**(见 1.4):SDK 视频库拿到 `searchVideo` 结果后,选中一条会触发什么调用链(`getVideoInfo`?直接 `createEditMaterial(vid://...)`?需要 `Vid` 还是接受任意 url),决定了:
> - Origin 接口要返回什么字段;
> - **没上云的视频在视频库里怎么处理**:列出但点选时即时触发该单条的 import 注册(推荐),还是只列已注册的。

### 1.3 `searchEditMaterial` 维持

已项目隔离,只需确认 `ProjectId/Space` 取自当前绑定工程(`origin:setProject` 下发的 `vevProjectId/vevSpace`),不再回退到环境变量默认工程。

### 1.4 必先确认(实测项,动代码前做)

1. 抓 SDK 选中"视频库"一条后的实际调用链与期望返回字段(开浏览器 network + 看 VeVEditor 对 `searchVideo` 返回的消费)。
2. 据此定 Origin `searchVideo` 返回 schema + "未上云视频"的点选策略。

### 1.5 验收

进入 A 项目:视频库/素材库都只见 A 的视频;切到 B 看不到 A;"系统导入"只列 A 项目历史(含不在当前 EDL 的 completed)。

---

## 4. 阶段 2:进入 SDK 自动同步(视频)

进入在线精修页后自动同步,不再依赖手点。

- 在 `_onVevDemoReady`(`online_editor.js:1042`)里,`_bindCurrentOriginProjectToVevDemo` 完成后,自动调用一次 `importMaterialsToVevDemo(_collectCurrentVideoResourceIds())`——这两个函数都已存在,基本是"把现成手动流程接到 ready 事件上"。
- **幂等**:复用 `lib/edit-export-signature.ts` 的 EDL 签名 + 注册侧 `registrationLocks`/binding 复用;同 `project + EDL signature` 已同步过则跳过,不重复传/注册。
- "同步素材"按钮保留为手动重试入口,不再是主路径。

### 验收

从剪辑页点"剪辑精修"进入后,当前时间线视频自动出现在 SDK 素材库,无需手点;重复进入不重复上传。

---

## 5. 阶段 3:自动铺轨(视频 / 转场 / BGM)

> 风险最高,**必须先实测 VevDemo timeline 结构**:抓一次 `describeProject` → 手动拖一个视频/音频/转场 → 再抓一次,对比 diff,再写映射。`describeProject/updateProject/getEffectList` 三个 action 已连通(`fe/index.js:370`)。

- **视频**:按 `editData.edl.timeline` 顺序铺主视频轨(V1);`in/out/duration` 用 `inPoint/outPoint/duration`。
- **转场**:`cut/fade/dissolve/wipe` → 用 `getEffectList` 查 SDK 合法 transition id 做映射;**查不到才降级 cut**(别一律硬编码)。
- **BGM**:
  - 源:`editData.edl.bgm = {trackId, enabled, offsetTime}`;文件在 `data/bgm/<trackId>`;全片循环/覆盖语义参照 `lib/edit-export.ts:554`(音量 0.32)。
  - 改动:`import/route.ts` 扩 BGM → 注册成 VevDemo 音频 EditMaterial → 铺到音频轨。
- 最后 `updateProject` 写入 VevDemo 工程结构。

### 验收

进入后时间线自动按 Origin EDL 铺好:视频顺序/裁剪点正确,转场尽量还原(不支持的降级 cut),BGM 在音频轨循环铺满。

---

## 6. 风险与未决

1. **SDK searchVideo 返回 schema / 选中调用链未知** → 阶段 1 前置实测(1.4)。
2. **VevDemo timeline 数据结构未知** → 阶段 3 前置实测(抓 describeProject diff)。
3. **未上云视频在视频库的点选策略** → 待 1.4 结论;倾向"列出 + 点选即时注册单条"。
4. **HEVC / 播放域名前置依赖**:VOD 工作流、播放域名没配好,上传的视频仍无 MainPlayUrl、拖不进轨道——这是火山控制台配置,Origin 代码补不了(`docs/vevdemo/README.md` 已记)。
5. **多 worker/多副本**:当前 binding 用 JSON 文件 + 进程内锁,生产多副本不是终态,后续迁库表锁。

## 7. 不做 / 暂缓

- `uploads` 本地上传文件自动注册(仍按现状拦截)。
- 老项目数据迁移/兼容(按你一贯口径不做)。
- BGM 注册 + 自动铺轨放第一版之后。
