# 在线精修 iframe 保活方案（待批，未动码）

2026-06-10 · 状态：方案待 Vasily 批准 · 预计改动：main.js 2 处 + online_editor.js 内部 · 不碰壳层 fe/index.js

## 一、问题是什么（大白话）

现在的做法：只要离开"在线精修"页（切到剪辑页、镜头页、任何页），Origin 就把整个剪辑器 iframe 拆掉扔了；下次再进来，从零重新走一遍"加载 VevDemo 前端 → SDK 初始化 → 项目绑定握手 → 自动同步检查"，全程 5~15 秒的"连接中"。

打个比方：每次离开房间就把电视砸了，回来重买一台重新装机。用户在剪辑页和精修页之间来回对照素材时，这个等待感最强。

代码位置就一行：`main.js:1725`

```js
if (page !== "onlineEditor") destroyOnlineEditor();
```

保活 = 切页时电视不砸，开着静音放那；回来直接接着看。iframe 本来就挂在 `pageOnlineEditor` 容器里，页面 hidden 时它天然活着——是我们主动拆的。

## 二、为什么之前说"串台高危"

担心的是：你出门期间换了套房（**切换了项目**），回来电视里放的还是旧房子的节目——用户在项目 B 里打开精修页，看到的却是项目 A 的时间线和素材。这是素材隔离红线（此前 VevDemo 素材涌入问题就是这个性质）。

还有一个隐蔽口子：旧项目的 iframe 在后台还能发消息回来（比如导出完成回调）。如果此时前台已经切到项目 B，回调里的状态就可能写进 B 的导出状态卡——跨项目写状态，也是串台。

## 三、方案：同项目保活，跨项目必杀

一句话：**保活的安全边界严格限定在"同一个项目内切页"。项目一换，立刻销毁，跨项目行为和现状完全一致。**

三个改动点：

### 1. 切页不销毁（main.js:1725）

删掉 `if (page !== "onlineEditor") destroyOnlineEditor();` 这一行。切页后 iframe 留在 hidden 的页面容器里，消息监听不摘除。

附带收益：导出进行中切到别的页，导出完成回调照常收到、状态卡照常更新（现状是 destroy 后消息全丢，回来靠轮询慢慢恢复）。同项目内这是 feature 不是 bug。

### 2. 切项目必杀（堵串台口子）

`online_editor.js` 新增一个同步钩子：

```js
function syncOnlineEditorProject(nextProject) {
  const nextId = String(nextProject?.id || '').trim();
  const boundId = String(_vevDemoBoundOriginProjectId || '').trim();
  if (_vevFrame && boundId && nextId !== boundId) {
    console.log('[OnlineEditor] 项目已切换，销毁保活的 VevDemo iframe:', boundId, '->', nextId);
    _destroyVevDemoFrame();
  }
}
```

挂到 `main.js` 的 `_syncProjectModules(nextProject)` 收口里（main.js:985，与 syncEditProject 等并排加一行）。这个收口是 409 回拉修复时建立的权威同步点，所有项目对象替换都走它。

关键安全性：**同项目** 409 回拉时 `nextId === boundId` → 不销毁，不误杀；**跨项目**时第一时间销毁，旧 iframe 连"后台发消息"的机会都没有，导出回调串台口子直接焊死。

### 3. 进页面时 ping 对账（防"假活"）

保活的 iframe 可能已经死了（vevdemo dev server 被 watchdog 重启过、页面崩了）。不能盲信，进页面时诚实对账：

`onOnlineEditorPageEnter()` 里：若 `_vevFrame` 存在 → 发 `origin:ping`，3 秒内收到 `pong`（壳层现成逻辑，bridge 已实现）→ 复用；超时 → `_destroyVevDemoFrame()` + 重新 `mountOnlineEditor()`，走正常重连。

`mountOnlineEditor()` 现有守卫 `if (_connectStarted || _vevFrame || _isVevDemoReady) return;` 天然支持复用路径，不用改。

## 四、明确不做的

- 不做多项目多 iframe 缓存池（内存不可控，VevDemo SDK 很重）。永远最多 1 个活 iframe。
- 不改壳层 fe/index.js、不改绑定握手协议（动握手会死锁，有前科）。
- 不做老项目兼容逻辑（无持久化状态，纯运行时行为）。

## 五、风险与兜底

| 风险 | 兜底 |
|---|---|
| 跨项目看到旧时间线 | 切项目即杀（_syncProjectModules 收口），不存在窗口 |
| 旧 iframe 后台回调写新项目状态 | 同上，切项目瞬间销毁，消息源没了 |
| iframe 假活（dev server 重启过） | 进页 ping 对账，3 秒超时重建 |
| 内存常驻（SDK 重） | 单 iframe 上限；切项目/手动退出即释放；桌面端可接受 |
| 快速来回切页重复绑定 | 现有 `_messageListenerBound` / `_connectStarted` 守卫已覆盖 |

## 六、版本与测试

- 动码时：online_editor.js v9→v10，main.js v327→v328（import 现场 + html 标签同步），跑 `npm run test:cache-busting`。
- 新增契约测试建议：`test:online-editor-keepalive`，锁三条行为——切页不调 `_destroyVevDemoFrame`；`syncOnlineEditorProject` 跨项目销毁、同项目不销毁；ping 超时走重建。

## 七、手测验收清单

1. 同项目：精修页 → 剪辑页 → 精修页，应**秒回**，无"连接中"。
2. 精修页发起导出 → 切去剪辑页等 1 分钟 → 回来：状态卡正常（应比现状更实时）。
3. 项目 A 进过精修页 → 切项目 B → 进精修页：**必须**重建，时间线绝不能出现 A 的内容。
4. 手动杀掉 vevdemo dev server → 进精修页：3 秒内发现死 iframe 并走重连提示，不白屏挂死。
5. 快速连续切页 5 次：console 无重复绑定/重复 mount 日志。
