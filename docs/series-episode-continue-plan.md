# 续写下一集（部—集逻辑）方案 v1.2

状态：**P0 已落地（2026-06-10），待浏览器手测**。v1 于 2026-06-10 出稿；v1.1 同日按 Vasily 四条反馈修订；v1.2 同日按配额绑会员拍板修订（记录见 §8）；落地记录见 §9。

---

## 1. 一句话结论

方向定版：**一集 = 一个任务，一部剧 = 一串任务 + 共享世界观**（Sudowrite 同款架构）。续写入口保持在剧本页分集标签区原位置，行为替换为"新建下一集任务"弹窗。需补齐"部"的身份字段、集数规则、字段继承、配额真修四件配套。

---

## 2. 行业怎么做（调研结论）

| 产品 | 模型 | 可借鉴点 |
| --- | --- | --- |
| [Sudowrite Series Support](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/series-support/3vfbZPCB1ANLm75FXmJf28)（AI 小说，系列写作标杆） | **一本书 = 一个独立项目**，放进 Series 文件夹成为"一部"；[Story Bible](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC)（角色/世界观）升到**系列级共享** | 和本方案方向一致：集独立成项目，世界观系列级共享 |
| [Sudowrite Chapter Continuity](https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/chapter-continuity/4KL8gFeLZQ6GSBjDWtSbV6) | 文档**链成前后顺序**，AI 续写自动回看最多 25 个前置文档 / 2 万词 | "前情链"是设定之外的第二根支柱，P0 存 prevProjectId、P1 消费 |
| [NovelAI Lorebook](https://docs.novelai.net/en/text/lorebook/) | 世界设定条目按关键词**自动注入**上下文，跨章节保一致 | 对应 Origin 世界观注入链路，机制已具备 |
| [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama)（开源 AI 短剧工作流，最近同行） | 一部剧 = 一个工程，内含分集 + **剧级角色/场景/道具库**，"加入本集"一键复用 | 证明"剧级资源库 + 集级复用"是短剧刚需（对应我们 P1 资产继承） |
| [海马轻帆](https://www.36kr.com/p/1280446375505925)（剧本工具） | 小说转剧本 + 续写规划为核心能力 | "按原文逐集转写"是真实主流工作流，"空白剧本页等用户贴原文"成立 |

三层共同骨架：**① 剧级共享层**（世界观/角色设定/视觉风格）**② 集级生产层**（剧本→分镜→成片，互相隔离）**③ 前情链**（续写携带前集剧情）。

---

## 3. 现状盘点（代码实锤）

**项目内已有一套分集系统**，与本方案是两条路线：

- `episodes[]` 按集镜像 18 个字段（idea/script/assets/shots/storyboards/videoPrompts/narrations/emotionSegments/scriptTimeline/currentStep 等，`public/modules/episode_fields.js:1-20`），切集整组换入换出（`episodes.js:46-85`）。
- 剧本页分集标签区有"+续写"按钮（`episodes.js:124`），弹窗调 `/api/script/workflow/episode-create`，AI 基于前集剧本自动生成续集（`episodes.js:188-201`）。
- **但 editData（剪辑）和 videoTasks 不在镜像里** → 多集共用一套剪辑/视频任务互相覆盖；任务列表阶段胶囊是项目级，多集挤一个任务进度失真。

对新方案有利的现状：

- 创建白名单默认开启（`lib/system-config.ts:83-85`），`POST /api/projects` **创建时可直接带** `selectedWorldTemplateId` / `worldTemplateSnapshot` / `clientRequestId`（`lib/projects-db.ts:637-661`）→ 后端几乎零改动。
- 风格页选中态读 `project.selectedWorldTemplateId`（`assets.js:4468`），应用模板的现成逻辑拉全量模板构造快照（`assets.js:5915-5921`）→ "风格页默认显示世界观"基本自动成立。
- 世界观模板独立表 + 完整 API（`GET /api/world-templates`），启动已 prime 缓存（`main.js:7882`）→ 弹窗下拉数据现成。
- 新建任务流程含 `clientRequestId` 防重 + 409 处理（`main.js:1392-1464`）→ 确认逻辑直接复用。
- 世界观快照带角色/地点/道具设定库（`lib/world-templates-db.ts:228-230`）→ 跨集设定一致性有底。

**配额现状（v1.1/v1.2 查实）**：所谓配额 = "最多保存 N 个项目"的上限。现状**四处脱节**——① 前端本地默认 `MAX_PROJECTS = 10`（`main.js:1270`），启动后从 `/api/config/client` 读 `limits.maxProjects` 覆盖；② 该接口返回的是 **mock 配置**（`app/api/config/client/route.ts:9` 摊开 `MOCK_CLIENT_CONFIG`，`mocks/config.ts:16` 写死 100）；③ **后端创建接口完全不拦**（全仓 grep 无 `project_quota_exceeded` 生成点，main.js:1443 的 409 处理是从参考站继承的死代码）；④ **会员体系里其实早就定义了按档项目限额**——`lib/billing-config.ts` 的 PLANS（free/plus/pro）各自带 `limits.projects`（现值 5/50/500，行 16/26/36），但同样是从未被任何代码消费的死配置。即：唯一实际生效的是前端按 mock 100 的拦截，会员档位与配额完全没接上。当前生效套餐取法已有现成链路：`getBalance(user.id).planCode`（含过期订阅惰性降级 `settleExpiredSubscription`，见 `app/api/billing/me/route.ts:16-21`）。

缺的：**没有任何 seriesId / episodeNumber 字段**；任务列表平铺按 createdAt 倒序，无分组。

---

## 4. 原三点诉求逐条评估

**第 1 点（弹窗）：可行。** 入口按拍板保持在**剧本页分集标签区原位置**（`episodes.js:122-126` 的"+续写"按钮），不新增导航栏入口。续写左侧标签显示当前集号"第 N 集"（接新字段 episodeNumber）。弹窗内容按你的描述：标题"续写下一集"、名称输入框（默认"基础名 第x集"）、单选「新建空白任务｜选择世界观模板+下拉」、取消/确认、右上 X。下拉默认值 = 当前项目正在用的世界观（有则默认选模板项，无则默认空白项）。

**第 2 点（确认→创建→跳转）：可行。** 创建时一次性带名称+世界观快照+继承字段（白名单已支持），成功后 `switchToProject`（loading 遮罩 Phase0 已就位），新任务 currentStep=1 落在空白剧本页。clientRequestId 防双击，409 走真配额（见 §6.5）。

**第 3 点（风格页默认显示）：基本自动成立**，创建时快照已写入，风格页读的就是这两个字段。实测两点：选中态渲染；freshness 横幅不误报（创建即带世界观属于良性路径，比"先建后补"更稳）。

---

## 5. 方向定论与旧系统处置

**一集 = 一个任务**，理由（按分量）：剪辑/视频任务在旧分集模型里不分集，多集互踩，结构性缺陷；镜像换入换出是惯性 bug 源（"导入第二章变第一集"、oneSentence 镜像皆出于此）；阶段胶囊/SSE 恢复/积分/导出全是项目维度，一集一任务全链路零适配；Sudowrite 行业验证。

**代价（已认）**：跨集资产成品不共享，每集重新抽取/选角/生成（缓解：角色定制库本就用户级全局，世界观模板兜底设定一致；P1 做资产继承）。

**旧系统处置（v1.1 拍板更新）**：

- "+续写"按钮**原位置保留，行为替换**——点击打开新的"续写下一集（新建任务）"弹窗，不再调 episode-create。
- 标签区渲染改造：当前任务标签显示"第 {episodeNumber} 集"（无该字段的独立任务沿用 episodes[0].title 即"第 1 集"）。
- **AI 自动续写剧本确认删除**（拍板：伪命题，写剧本与做视频是两类用户；未来独立的写剧本工作流另行立项，不进本工作台）：旧弹窗 `_openNewEpisodeDialog`/`_createNewEpisode`（episodes.js:129-224）与 `/api/script/workflow/episode-create` 路由同批摘除，契约测试锁防回归（风格转绘层摘除同款打法）。episodes[] 字段保留兼容读，不迁移老项目。
- 旧弹窗的"剧本未确认不让续写"硬拦（episodes.js:132-135）**不带入新弹窗**：随时可续写，当前集剧本未确认时弹窗内显示一行可无视的提示。

---

## 6. P0 必做配套（与弹窗同批）

1. **部的身份字段**：`seriesId`（= 第一集项目 id）+ `episodeNumber` + `prevProjectId`，进 `EMPTY_DATA`、`NEW_PROJECT_ALLOWED_PAYLOAD_KEYS`、`rowToSummary`（projects-db.ts，影响面窄）。首次续写时回填源项目 seriesId=自身 id、episodeNumber=1（现有 PUT，不改名）。靠名字串部是脆的，一改名就断。
2. **第 x 集计算**：同 seriesId 下 `max(episodeNumber)+1`（删中间集不补号）；默认名 = "基础名 第x集"，基础名 = 源项目名去尾部"第n集"后缀（防"XX 第2集 第3集"）。
3. **标签区改造**：当前集标签接 episodeNumber 显示；"+续写"handler 替换为新弹窗。
4. **继承字段**（除世界观外）：`scriptTargetDurationSec`（集时长一致）、`styleOptions.aspectRatio`（**一部剧画幅必须一致**，否则剪辑/导出口径乱）、`selectedStyleTemplateId`+`styleTemplateSnapshot`（规则见下框）。剧本/资产/分镜/视频一律空白。

   > **风格继承 vs 世界观 preferredStyleTemplateId 不重复**（v1.1 答疑）：两字段语义不同。`preferredStyleTemplateId` 是**保存世界观模板那一刻**从项目实际选择回填的"推荐默认"（`assets.js:4600-4607`，source 即叫 `project_style_selection`）；`selectedStyleTemplateId` 是本集**实际选择**。常态下两者相同，继承=零额外成本；但若上一集手改了风格没回存世界观模板，preferred 就是旧的，只有继承"实际值"才保部内视觉一致（手改优先原则的延伸）。实现上只写 selected 一份，不动世界观字段；若弹窗里换了世界观导致两者不一致，风格页 freshness 横幅会诚实对比提示，不拦。
5. **配额真修 = 绑会员档**（v1.2 拍板）：数值真相源就用现成的 `PLANS[].limits.projects`（billing-config.ts），改为 **Free 100 / Plus 1000 / Pro 5000**，不再另设 system-config 键。三处接电：
   - **后端权威拦截**：`POST /api/projects` 创建前先 `settleExpiredSubscription(user.id)` 惰性结算（照抄 billing/me 的打法，防过期 Plus 还按 1000 算）→ `getBalance(user.id).planCode` → `getPlan().limits.projects` → 计数比较，超限返回 409 `{error:'project_quota_exceeded', max, plan}`。前端 409 处理代码现成（main.js:1440-1460），等于激活死代码。
   - **前端下发**：`/api/config/client` 改为用户感知（前端本来就带 auth 头调它，main.js:1274）：解析当前用户 → 按 planCode 下发真实 `limits.maxProjects`；未登录/解析失败回退 Free 值。前端 main.js:1279-1280 已会读，**前端零改动**，列表页"X/N 个项目"计数（main.js:2200）自动按档显示。mocks/config.ts 里的 maxProjects:100 同批清理防误导。
   - **降级规则**：套餐到期降档后存量任务超限，**不删不锁存量，只拦新建**（删到限额下或升级后恢复）。409 文案带升级引导（"Free 最多 100 个任务，升级会员可扩容"，会员升级入口已有 ovBillingRechargeBtn）。
   - concurrency/storageGB 两个同样未接电的限额字段本次不动，单独议。
6. **防双击**：clientRequestId + 确认按钮置灰"创建中…"。
7. **版本 bump**：workspace.html 里 main.js(现 305)/styles.css(现 234)/episodes.js 及涉及 modules。

### P1（下一批）

- 任务列表**按部分组**：同 seriesId 折叠成"部"卡片，部内按 episodeNumber 排序（summary 已带字段，纯前端）。
- **分集标签升级为整部剧切换器**：标签区列出 seriesId 下所有集，点击直接切任务（入口位置不变，体验自然延伸）。
- **继承上一集资产/选角**：弹窗加可选项，复制上集 assets 角色绑定。
- **前情提要**：自动生成上集剧情梗概，注入新集剧本生成上下文（消费 P0 存好的 prevProjectId）。

### P2（以后）

- 整部剧合并导出 / 连播预览。
- ~~AI 基于前集自动续写移植~~（已拍板删除；独立写剧本工作流另立项）。

---

## 7. P0 改动清单（批准后细化动码）

| 位置 | 改什么 |
| --- | --- |
| `lib/projects-db.ts` | EMPTY_DATA / 白名单 / rowToSummary 增加 seriesId、episodeNumber、prevProjectId |
| `lib/billing-config.ts` + `app/api/config/client/route.ts` + `app/api/projects/route.ts` | PLANS.limits.projects 改 100/1000/5000；config/client 用户感知下发；创建前惰性结算+权威 409（mocks/config.ts 清理 maxProjects） |
| `public/modules/episodes.js` | 标签显示 episodeNumber；"+续写"handler 换新弹窗；旧弹窗两函数删除 |
| `public/main.js`（或新 module `continue_episode.js`） | 新弹窗 + 确认时拉 `/api/world-templates/{id}` 全量 → 复用 assets.js:5915 一带快照构造（抽共享函数）→ POST /api/projects → 回填源项目 → switchToProject |
| `app/api/script/workflow/episode-create/` | 路由摘除 + 契约测试锁 |
| `public/workspace.html` | 版本 bump |

不动：世界观注入链路、共享 resolver、风格页代码（零改动验证自动工作）。

**测试点**：带世界观创建→风格页选中态+推荐正常、freshness 不误报；空白创建→风格页空白；双击只建一个；配额三档各自真拦（free 第 101 个 409）+ 文案带升级引导；过期 Plus 惰性降级后按 Free 拦；降级后存量超限不锁存量、仅拦新建；config/client 按档下发、列表计数显示正确；改名后续写序号仍正确（靠字段）；删中间集再续写序号正确；标签显示第 N 集；episode-create 路由 404（摘除生效）；旧多集项目打开不崩（episodes 兼容读）。

---

## 8. 拍板记录（2026-06-10，Vasily）

1. **配额**：不许"文案绕过"，真修且**绑会员档**（v1.2）——Free 100 / Plus 1000 / Pro 5000，写进现成的 PLANS.limits.projects 并三处接电（§6.5）。
2. **入口**：不挪位置，保留分集标签区；标签显示第几集。原"隐藏旧入口"改为"原位替换行为"。
3. **AI 自动续写**：删除，不移植。写剧本是独立工作流、目标用户不同，另行立项，不进本工作台。
4. **风格模板继承**：确认继承，与世界观 preferredStyleTemplateId 不重复（推荐 vs 实际两层，见 §6.4）。

5. **配额数值（v1.2 补拍板）**：与会员绑定，Free 100 / Plus 1000 / Pro 5000。

**待定项：无。已批准执行。**

---

## 9. P0 落地记录（2026-06-10）

**已改文件**：

| 文件 | 内容 |
| --- | --- |
| `lib/projects-db.ts` | EMPTY_DATA/白名单/buildNewProjectData/rowToSummary 增 seriesId、episodeNumber、prevProjectId；新增 `cleanEpisodeNumber`、`countProjectsForUser` |
| `lib/billing-config.ts` | PLANS.limits.projects → 100/1000/5000 |
| `app/api/projects/route.ts` | POST 创建前惰性结算 + 按档权威拦截，409 `project_quota_exceeded`（带 max/used/plan/detail 升级引导文案） |
| `app/api/config/client/route.ts` | 用户感知：按 planCode 下发 limits.maxProjects，未登录按 Free 兜底 |
| `mocks/config.ts` | 移除写死的 maxProjects:100 |
| `public/modules/episodes.js`（v103） | 旧 AI 续写弹窗/调用删除；新"续写下一集=新建任务"弹窗（名称默认基础名+第x集、空白/世界观模板单选+下拉默认当前世界观、X/遮罩关闭、防双击、409 配额提示）；集号按 seriesId 扫列表 max+1；继承时长/画幅/风格模板；世界观快照复用 `snapshotWorldTemplate`；创建后回填源任务 seriesId/episodeNumber=1；标签显示"第 N 集"（单集任务接 episodeNumber，老多集项目沿用原标题）；剧本未确认仅被动提示不硬拦 |
| `public/main.js`（v313） | 抽取 `_finalizeCreatedProject`（新建/续写共用收尾）；episodes ctx 增 finalizeCreatedProject/newClientRequestId；episodes import pin 对齐 v103 并移除 `_createNewEpisode` |
| `app/api/script/workflow/episode-create/` | **整目录删除** |
| `scripts/test-episode-create-contract.ts` | 重写为摘除锁+新契约锁（顺带修正旧测试已过期的 scriptTimeline 字段与版本断言） |
| `scripts/test-project-quota.ts`（新增） | 三档数值锁 + countProjectsForUser + 三字段创建/摘要/脏值清洗 |
| `package.json` | 注册 `test:episode-continue-contract`、`test:project-quota` |
| `public/workspace.html` | episodes.js v102→103、main.js v312→313 |

**验证状态**：`tsc --noEmit` 零错误；`test:episode-continue-contract` 全断言绿；episodes.js/main.js ESM 语法检查过。**沙盒跑不了 DB 类测试**（node_modules 是 macOS 的，better-sqlite3/esbuild 平台二进制不匹配）——以下两条需在本机跑：`npm run test:project-quota`、`npx tsx scripts/test-project-create-sanitization.ts`。

**浏览器手测清单**：①带世界观续写→新任务风格页选中态+推荐正常、freshness 不误报；②空白续写→风格页空白；③双击确认只建一个；④Free 第 101 个任务 409 文案+列表计数"X/100"；⑤改名后再续写序号正确、删中间集再续写不补号；⑥标签显示第 N 集；⑦老多集项目打开不崩、切集正常；⑧/api/script/workflow/episode-create 返回 404。
