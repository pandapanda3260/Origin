# 套餐/积分包定价与卡片展示调整方案（v1.1 已拍板，P0+P1 已落地待手测）

2026-06-10 · 基于当日代码实扫。v1.0 出方案 → Vasily 拍板：**P0 照执行；P1 选方向 B（模拟支付）；"永久有效"文案改为"永久积分"** → 同日落地。

## 0. 背景与结论

"之前出过的方案"是配额三档那份（docs/series-episode-continue-plan.md §6.5，已落地）：任务上限 Free 100 / Plus 1000 / Pro 5000 已在代码里，与本次目标一致，零改动。本文档覆盖：定价数值、卡片展示精简、购买到账链路（模拟支付）。

实扫关键结论（v1.0 发现，落地前状态）：支付三通道全是占位，订单永远 pending；无任何代码入账积分/升档/按月发放，"每月重置"只是文案；唯一真实到账路径是兑换码。所以"充值立即生效"必须新建整段"支付成功→权益生效"逻辑，即本次 P1。

## 1. 现状实扫（v1.0 记录，已按此修改）

### 1.1 数值：旧值 vs 新值

真相源 `lib/billing-config.ts` + 镜像 `mocks/billing.ts`（lib/api.ts mock 层用），双源同改。

| 项 | 旧值 | 新值（已落地） |
|---|---|---|
| Free | ¥0 · 100积分/月 · 100任务 | 不变 |
| Plus | ¥99 · 2,000积分/月 | **¥1,599（159900分）· 80,000积分/月** |
| Pro | ¥299 · 8,000积分/月 | **¥7,999（799900分）· 400,000积分/月** |
| 积分包 | topup_500/2000/10000（¥19/¥69/¥299） | **topup_basic 基础包 40,000/¥1,000 · topup_advanced 进阶包 120,000/¥3,000 · topup_enterprise 企业包 2,000,000/¥40,000**（永久，进 topup 桶不过期；旧 code 直接删不留兼容） |

任务上限消费点（零改动）：`app/api/config/client/route.ts`（按档下发 maxProjects）、`app/api/projects/route.ts`（创建前权威 409）。

### 1.2 展示（旧四条目 → 新两条目）

旧卡片四条目（billing.js `_derivePlanFeatureItems`）：积分/每月重置、并发/任务调度上限、项目+存储/项目与素材空间、模型+支持。并发字段从未接任何后端逻辑；models/support 仅展示。

### 1.3 购买链路（旧状态，P1 的依据）

checkout 三 provider 全占位（只建 pending 订单 + "[占位]"文案，且把测试兑换码 QDDEMO 展示给用户）；全库无支付回调/markPaid；订阅生效逻辑不存在（无升档、无 period_end 设置、无月度发放，订阅桶只在开户灌 100）；`settleExpiredSubscription` 只管"申请取消+到期→降 free"。前端 `waitForOrderApplied` 等的 'applied' 无人写（兑换码留痕订单是 'paid'）。

### 1.4 扣减优先级（旧 → 新）

旧：bonus > topup > subscription（credits.ts 与 usage-billing.ts 两份实现）。月度重置落地后该顺序会先烧用户花钱买的永久积分、留着会过期的订阅积分——已随 P1 反转为 **subscription > bonus > topup**（两处同步改）。退款仍按原扣费 buckets_json 比例回桶，不受顺序影响。

## 2. P0 落地记录（数值 + 展示）

- `lib/billing-config.ts` / `mocks/billing.ts`：按 §1.1 新值双源同改。
- `public/modules/billing.js`：
  - `_derivePlanFeatureItems()` 重写为恒两条：①`bolt` "N 积分 / 每月重置" ②`inventory_2` "N 个任务上限 / 项目与素材空间"（小字标题保留）；并发、模型支持、`hi` 兜底块整体删除；孤儿 `_priorityLabel` 一并删。trial 体验包死分支不动（后端无 trial 包，永不渲染）。
  - 积分包卡 meta：`¥1,000 · 40,000 积分 · 永久积分`（拍板文案"永久积分"）。
  - `_formatMoney()` 千分位：¥1,599 / ¥7,999 / ¥40,000。
- 版本 bump：main.js 内 billing.js pin → **v113**；workspace.html main.js → **v324**（并发会话当日已占 112/323，故再进一档）。
- 不动项：顶部余额三小卡、支付方式切换、兑换码区、流水区、styles.css、配额拦截、`limits.concurrency/storageGB` 字段保留仅不展示。

## 3. P1 落地记录（方向 B：模拟支付 + 月度重置）

### 3.1 开关

`lib/billing-config.ts` `isDevAutopayEnabled()`：默认关闭；`BILLING_DEV_AUTOPAY=1` 仅允许非生产环境临时打开，`=0` 明确关闭；`NODE_ENV=production` 硬关闭，即使误设 `BILLING_DEV_AUTOPAY=1` 也不会到账。**红线：模拟支付不能在生产免费送积分。**

### 3.2 统一到账 `lib/billing-fulfill.ts`（新建）

`fulfillPaidOrder({userId, orderId, via})` 是"支付成功→权益生效"唯一入口，真支付网关接入后回调验签成功调同一函数，只换触发器：

- 幂等：订单 pending→applied 条件 UPDATE 原子占有，重复调用返回 alreadyApplied 不双发；占有与入账同事务（嵌套 savepoint），入账抛错占有一并回滚。
- topup 订单 → `grantCredits` 进 topup 桶（永久积分，立即生效），流水 reason "[模拟支付] 购买 基础积分包（永久积分）"。
- subscription 订单 → `activatePlanSubscription`（见 3.3）。

### 3.3 订阅生效与"每月重置"语义（lib/credits.ts 新增）

- `activatePlanSubscription(userId, planCode)`：plan_code 升档 + 订阅桶**覆盖重置**为 monthly_credits（不叠加；换档同理，反向换档同样覆盖）+ `period_end = 现在+1月` + 清取消标记；topup/bonus/overdraft 桶不动；流水 kind='adjust' 记桶差额。月份算术用 setUTCMonth（1/31→3/2 一类月末滚动可接受，真网关接入以网关账期为准）。
- `renewDueSubscription(userId)`：惰性续费，**仅模拟支付开关开启时生效**——付费档、未申请取消、period_end 已过 → 视为自动扣款成功：订阅桶覆盖重置 + period_end 按月顺延到未来（跨多月只重置一次不叠发）。与 settleExpiredSubscription 按 cancel 标记互斥分流。挂载点与 settle 相同三处读取入口：`/api/billing/me`、`/api/config/client`、`POST /api/projects`，不进扣费路径。开关关闭时到期不续也不降级（该状态只能由开关曾开启产生，归真网关接入时一并定）。

### 3.4 checkout 路由改造

统一建单（provider 白名单 stripe/wechat/alipay）→ 开关开：同步 fulfill，返回 `{status:'applied', creditsAdded, message:'[模拟支付] …已到账/已生效'}`；开关关：保留 pending + 占位提示，**不再向用户展示 QDDEMO 测试兑换码**。

### 3.5 前端（billing.js startCheckout）

收到 `status==='applied'` → 不走支付跳转，直接 `loadBillingSummary()` 整页刷新（余额/档位徽章/流水）+ 成功 toast。原占位/真网关跳转分支保持不变。

## 4. 验证

已跑（沙箱）：`node --check` billing.js/main.js 绿；`tsc --noEmit` 绿；旧 `test:usage-billing` 只用 bonus 单桶，不受优先级反转影响。

**待 Vasily 本机**：

1. `npm run test:billing-autopay`（新增 scripts/test-billing-autopay.ts，临时库跑，脚本内置红线拦截不许碰 data/qd.sqlite）：锁新定价数值、积分包到账+幂等不双发、订阅升档+覆盖重置、扣减优先级 subscription>bonus>topup、惰性续费/取消分流、开关开关语义、free 不可订阅。
2. `npm run test:project-quota`（确认配额链路未被波及）。
3. 浏览器手测清单：
   - 套餐卡：三张恒两条目（"N 积分/每月重置"、"N 个任务上限/项目与素材空间"），价格 ¥1,599/¥7,999 千分位，无并发/模型条目；
   - 积分包：三张新卡 "¥1,000 · 40,000 积分 · 永久积分"；
   - 点"升级此套餐"（Plus）：toast "[模拟支付] 订阅 Plus 已生效…"，顶部当前套餐变 PLUS、体验/订阅积分变 80,000，流水多一条"订阅 Plus 生效"；
   - 点积分包：常规购买积分 +40,000，流水"[模拟支付] 购买 基础积分包（永久积分）"；
   - 取消套餐订阅 → 卡片 CTA 变"恢复自动续订" + 到期降级提示（原逻辑回归）；
   - 兑换码照常到账（回归）；
   - 生成消耗一次 → 流水扣的是订阅桶（subscription 优先）。

## 5. 真支付网关接入时的归属点（备忘）

checkout 返回真实支付地址；fulfillPaidOrder 挪到回调验签后调用；renewDueSubscription 由续费扣款回调替代（开关关掉即停）；月末账期对齐网关；占位文案删除。兑换码种子（QDDEMO 最大 1 万分）量级与新价格体系（最小包 4 万分）上线前重定。
