# 添加素材弹窗（从系统导入）四问题盘点与优化方向

2026-06-11 · 状态：方向待拍板（含 3 个必须实证项）

> 注意：写本文档期间 fe/index.js 正被另一个会话持续修改（4100 行→4391 行，今天 14:52 仍在动）。文中行号以当时快照为准、可能漂移，**定位一律以函数名为锚**；动码前先和并行会话收口。

## 一句话结论

这个弹窗整体是火山 SDK（veveditor.umd.js，CDN 黑盒）画的，**全选、计数、分页布局都不在我们代码里，SDK 1.0.6-rc.0 也没有提供这些能力的配置开关**（已核实）；问题 1/2/3 只能走"桥接层 DOM 增强"，问题 4 的根因大概率在 actions 适配层的一个漏口（mGetMaterial 不认合成 Vid），先做一次 10 分钟探针实证，再按分叉修。

## 背景：弹窗是谁画的，我们能在哪动手

- 弹窗 UI 100% 由 SDK 内部渲染。证据：fe/index.html:13 从 CDN 加载 `veveditor.umd.js 1.0.6-rc.0`；fe/index.js 里只有"按文案探测弹窗 DOM"的代码（197-224 行），没有任何弹窗渲染代码。
- SDK 的样式文件 veveditor.css（CDN 拉回全文核查）：**没有任何 全选/已选计数/pagination 相关类名** → 这些 UI 在 1.0.6-rc.0 里不存在，不是我们没打开开关。
- 官方 demo 原版（fe/dist 构建产物）传的 `config.material` 和我们完全一样（show/enableLocalUpload/uploadAccept/videoAccept/showClassification/defaultClassificationId），没有更多可用配置键。
- 我们的两个合法动手点（既有实锤结论）：
  1. **actions 适配器**：SDK 所有数据读写都走我们注入的 11 个 actions（fe/index.js 编辑器初始化处 `new window.VeVEditor({...actions})`，约 4314-4327，与官方 demo 原版 actions 名单逐一吻合，含 searchVideo/mGetMaterial/getVideoInfo/createEditMaterial）。
  2. **DOM 增强**：MutationObserver 探测弹窗后注入控件/样式（现有先例：本地上传自动确认、今天刚加的分页钉底）。

官方文档对口处：[体验 Demo](https://www.volcengine.com/docs/4/1903024)（本 vevdemo-1.0.6 即官方 demo）、[CreateEditMaterial-向工程添加剪辑素材](https://www.volcengine.com/docs/4/1895479)（确定按钮最终应产生的效果：把 VOD 媒资按 Vid 注册成工程剪辑素材）。SDK 弹窗内部行为无公开文档。

## 四个问题逐个说

### 问题 1：没有全选

- **在哪**：SDK 内部。无配置开关（已核实，见上）。
- **方向（推荐）**：DOM 增强注入"本页全选/取消"按钮，实现方式=逐个触发 SDK 自己的卡片勾选框 click（模拟用户手动路径，不碰 SDK 数据）。
- **注意**：只做"本页全选"，不做跨页全选——SDK 翻页是否保留选中态未实证（见实证项 B），且一次全选 13 个会放大问题 4 的注册耗时，需先把 4 修好。

### 问题 2：翻到第 2 页（只有一行素材）分页控件上移

- **根因**：SDK 弹窗体高度随内容收缩，分页控件跟着上移。
- **现状要紧**：今天上一轮会话已加过钉底补丁（fe/index.js:226-280，min-height 540px + absolute 钉底，4260 行安装）——但它靠 `[class*="pagination"]` 匹配，而 SDK 的 CSS 里根本没有 pagination 字样类名，运行时类名很可能是另一套/哈希名，**补丁可能匹配不上=没生效**（实证项 A）。你的截图现象仍在，与此吻合。
- **方向（推荐）**：实证后修选择器（改为"按分页数字按钮反查共同父容器"的结构定位），并入统一增强模块（见收口原则）。

### 问题 3：选中后没有数量显示，翻页后不知道前页选中还在不在

- **在哪**：SDK 内部，无此 UI（已核实）。SDK 选中态在内部 store，外部读不到。
- **方向（推荐）**：DOM 增强在"确定"按钮左侧注入"已选 N 项"。N 的口径=桥接层自己记账（监听弹窗内每个勾选框变化，按页累计）。
- **依赖实证项 B**：若 SDK 翻页根本不保留前页选中，计数会如实显示掉回——这本身就是要暴露给用户的真相，也直接回答"第一页的选择状态还在不在"。

### 问题 4：选完点确定，素材没出现在素材区（最大问题）

设计上的完整链路（normalizeOriginVideoForSearch 内注释写明意图，fe/index.js:1863 "Keep the searchable Vid synthetic so confirmation always calls getVideoInfo"）：

1. 弹窗列表给 SDK 的是**合成 Vid**（`origin-video-task:<taskId>`，originVideoSyntheticVid:961 / normalizeOriginVideoForSearch:1858）——故意不给真 Vid，逼 SDK 确定时回调我们的 actions；
2. 期望 SDK 调 `getVideoInfo` → 桥接 getOriginAwareVideoInfo（2738）→ 壳层 registerProjectVideo（online_editor.js:1871）→ `POST /api/volcengine/import`（已验证的注册链路，盖 vevProjectId、幂等复用）→ 返回真 Vid+播放地址；
3. SDK 再调 `createEditMaterial(Source: vid://真Vid)` → createOrReuseOriginEditMaterial（930）按 Source 复用 → 素材面板经 searchEditMaterial 刷新显示。

**已定案（2026-06-11 探针实锤，Vasily 实操截图为证）**：

- SDK 确定时**不调 getVideoInfo、也不调 mGetMaterial**，而是对每个勾选项直接并发 `createEditMaterial({Source: 'vid://<列表Vid>', ProjectId: <vev工程>, Type: 'video', Name: <标题>})`——原代码注释"合成 Vid 会逼 SDK 走 getVideoInfo"的假设被推翻。
- 合成 Vid 拼出的 `vid://origin-video-task:<uuid>` 在 VOD 查无此物 → OpenAPI 失败 → Result=undefined（探针记录 3 条 `✓ createEditMaterial ~3.8s undefined`）→ SDK 拿不到 EditMid 静默放弃 → 素材区不出现，全程无报错。
- 顺带定案实证 B：跨第 1/2 页勾的 3 项（片段1/2/13）一次确定全部提交——**SDK 翻页保留选中态**。

**修复（已落地 fe/index.js，待手测）**：createOrReuseOriginEditMaterial 入口识别合成 Source → 新增 extractOriginTaskIdFromVevSource + createEditMaterialViaOriginRegistration：转走已验证的 registerProjectVideo → /api/volcengine/import 注册链（幂等、盖 vevProjectId、已注册则复用），把返回的 vevEditMid 拼成 CreateEditMaterial 兼容形状（EditMid/editMid/MaterialId/Id）还给 SDK；注册没回 EditMid 则抛明确错误（探针可见），不再静默。真实 Source 的既有路径（含字幕 SRT）零改动。备份：index.js.bak-import-probe-20260611。

## 三个实证点的状态（探针=fe/index.js 末尾 IMPORT_DIALOG_PROBE 浮层，定案后整块删）

- **A. 分页钉底补丁是否生效**：**待确认**。弹窗打开时浮层首行会显示 `pagination类名匹配:N 钉底类已挂:N`——下次开弹窗截图即定案（截图时弹窗已关，没采到）。
- **B. SDK 翻页是否保留选中态**：**已定案=保留**（跨页勾选 3 项一次确定全部提交）。问题 3 的计数注入因此可做跨页累计口径；浮层"勾选普查"对 SDK 自绘勾选框计数无效（input/aria 均 0），全选注入时需以卡片点击模拟为准。
- **C. 确定触发的 action**：**已定案**，见上节。Chrome 扩展账号不对连不上，改为探针浮层+Vasily 截图路线，效果等同。

## 收口原则（防补丁上打补丁）

- 弹窗相关 DOM 增强**收口为 fe/index.js 内一个"系统导入弹窗增强模块"**：一个 MutationObserver + 一套选择器常量，统一承载 全选(1)/计数(3)/分页钉底(2)/确定反馈(4b) 四个职责；今天的散装分页补丁并入，不再各自为政。
- actions 层修复（4a）与 DOM 增强彻底分开，互不依赖。
- 不建议升级 SDK 版本来换这些 UI：版本不可控（CDN 列不了目录、文档不列版本），且会动摇全部既有 DOM/actions 适配，影响面太大。
- **红线重提**：fe/index.js 至今未纳入 git（既有记录），本次动它之前必须先纳管，否则 vendor 重同步全部白做。

## 待拍板

1. ~~实证先行~~（已完成：B/C 定案，4 已修待手测；A 差一张弹窗打开时的截图）；
2. 问题 1 的全选：B 已证跨页保留选中，可做"本页全选"或"跨页全选"——建议仍从"本页全选"起步（一次全选 13 个=并发 13 路注册，新素材时等待会拉长）；
3. "预注册全部片段"做不做：修复后未注册素材首次确定仍要等注册（探针实测已注册项 ~4s 回；全新项=VOD 上传，分钟级）。预注册能压到秒级，但会提前产生 VOD 上传。建议手测后看体感再定。
