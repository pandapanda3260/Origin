# 管理后台指标口径登记表

> 制度（2026-06 瘦身定版）：后台每个展示数字在这里登记一行。改任何后台指标前先查此表；
> 发现同名指标第二条计算路径 = bug。页面（route.ts 的 HTML/JS）禁止自行 sum/filter 出新指标，
> 所有数字必须由 API 给成品值。有盲区的统计必须页头声明。
> 锁定测试：`npm run test:admin-metrics`（静态契约，不连库）。

## 一、问题队列（/admin）

| 指标 | 权威来源 | 计算位置 | 口径/盲区 |
|------|----------|----------|-----------|
| 需人工处理 | batch_tasks.status='needs_review' | api/admin/problem-queue（needsReviewTasks，LIMIT 80) | 全量未分页，>80 条时卡片计数封顶 80，去"全部任务"筛 needs_review 看全量 |
| 卡住任务 | batches/batch_tasks/video_tasks/exports，status='running' 且最后信号早于 staleTaskMinutes(15min) | 同上（staleTasks，每源 LIMIT 30 合并截 40) | 只含 running 超时；failed 不在此卡（在"近24h失败"） |
| 近 24h 失败 | batch_tasks/video_tasks/exports，status='failed' 且 updated_at 近 recentFailedHours(24h) | 同上（failedTasks，每源 LIMIT 30 合并截 40) | batches 整批失败不单列（子任务已覆盖）|
| 待复核内容风险 | content_flags.status='pending' | 同上（contentRisks，LIMIT 40) | 按 severity 排序 |
| 异常账户 | user_credits<0 / credit_ledger 退款比 / 高频失败 | 同上（三查询合并截 50) | 阈值见 lib/admin-thresholds.ts |
| Key 池红灯 | model-routing 状态 + 进程内 10min 指标快照 | 同上（keyPoolAlerts） | **进程内存指标，重启清零**；mode!=real 恒红 |
| 用户/项目/在线/付费 KPI | users / projects / user_activity(5min) / billing_orders(status IN paid/applied 且金额>0) | api/admin/stats | 全部 COUNT 权威表；过滤 __shadow__ 用户。**此 API 仅这 4 字段，2026-06 已删 userUsage 等死载荷（其 totalTokens 实为积分，错误标签，禁止恢复）** |
| 全部任务列表 | 四任务表 | api/admin/tasks GET | reason 字段统一走 lib/admin-task-sql.ts |

写路径：单任务动作（取消/重试/强制失败/退款检查）唯一入口 = `POST /api/admin/tasks`（dryRun 两段提交+审计）。
批量重排 needs_review = `POST /api/admin/problem-queue` action=bulk_requeue（幂等键派生）。
problem-queue POST 的单任务分支（requeue/force_fail/cancel）为遗留路径，**UI 已不使用**，保留原因：test:batch-durable 契约测试覆盖；不要给它新增消费方。

## 二、客服检索（/admin/search，已并入原用户管理）

| 指标 | 权威来源 | 计算位置 | 口径/盲区 |
|------|----------|----------|-----------|
| 用户列表/搜索 | users + user_credits + 子查询计数 | api/admin/users GET | 空查询=最近注册 50 条；模糊匹配 id/用户名/手机号/旧邮箱/昵称；过滤 shadow |
| 用户积分/项目数/账本数 | user_credits.total_credits / projects / credit_ledger COUNT | 同上 | 实时子查询，权威 |
| 单据精确检索 | billing_orders/projects/batches/video_tasks/exports | api/admin/search GET | **精确匹配**（id/providerRef/providerTask/externalExportId），每类 LIMIT 10；模糊只对用户生效 |

写路径：禁用/恢复/强制下线 = `POST /api/admin/users`（dryRun+审计+踢 token 缓存）。

## 三、财务积分（/admin/billing）

| 指标 | 权威来源 | 计算位置 | 口径/盲区 |
|------|----------|----------|-----------|
| 现金收入 | billing_orders status IN paid/applied 真实金额 | api/admin/billing | 不含模拟支付为 0 金额的单 |
| 赠送/兑换/调账入账、累计消耗 | credit_ledger | 同上 | 1 元=100 积分口径见 lib/billing-config |
| 余额五桶 | user_credits（sub/topup/bonus/overdraft） | 同上 | 扣减优先级 sub>bonus>topup |
| 成本与价格 tab | credit_ledger.cost_micros + api_price_catalog | 同上 | **成本=按价格表折算的观察值，非账单对账值**；2026-06 起价格表并入此 tab 第二张表 |
| 兑换码 | redeem_codes | 同上 | — |

写路径：人工调账 = `POST /api/admin/billing` action=manual_adjust（大额需 CONFIRM 文本，不可物理撤销）。

## 四、用量统计（/admin/usage-stats，原 Token 统计+时间统计合并）

| tab | 权威来源 | 计算位置 | 口径/盲区 |
|-----|----------|----------|-----------|
| Token 消耗 | **token_usage_events**（Token 唯一账本） | api/admin/token-stats + lib/token-usage.ts | 账本上线后才有数；usage 缺失的调用保留明细不计总量；**Token ≠ 现金成本**（notes 由 API 下发页面动态渲染） |
| 等待时间 | batch_tasks / generation_batches / exports / style_bible_runs 派生 | api/admin/time-stats + lib/time-usage/queries.ts | **V1 盲区（页头警示条常驻，文案以 API notes 为单源）**：不统计剧本直连生成、单次提示词微调、资产抽取、VevDemo 回调端到端；视频段不直接读 video_tasks；成功/失败/取消分开统计不混平均 |

三套账本三个量纲（token/钱/秒）各自权威，禁止互相换算展示。

## 五、系统与安全（/admin/system，原配置+Key池+存储+Admin账号+首页日志合并）

| tab | 权威来源 | 计算位置 | 口径/盲区 |
|-----|----------|----------|-----------|
| 配置开关 | system_config | api/admin/config | 并发上限是进程级共享，非单用户额度 |
| Key 池 | model-routing + 内存指标 | api/admin/key-pool/status | 模型路由热读外部 env；非模型 env 进程缓存需重启 |
| 存储 | 文件系统扫描 | api/admin/storage | **单次扫描/处理硬上限 500 条**（页内已标注），quarantine 两段提交带 candidateHash |
| Admin 账号 | admin_users + admin_audit | api/admin/staff | 不能禁用/重置自己 |
| 系统日志 | 进程日志缓冲 | api/admin/logs（level=warning, 120 行） | 进程内存，重启清零 |

## 六、内容审核（/admin/content）

content_flags 人工复核（隐藏/忽略），api/admin/content。dryRun 预检与提交之间存在内容变化竞态（已知，低频可接受）。

## 七、知识库（/admin/knowledge，单页三 tab）

知识卡/审计/注入预演，api/admin/knowledge + lib/admin-knowledge-page.ts。
审计指标盲区：7 天窗口内每 owner/project/stage 最多 50 条样本，高频 stage 指标有偏差（页内 retentionNote 下发）。

## 八、共享口径工具

- 任务 reason 字段：`lib/admin-task-sql.ts`（batches 无 status_reason/error_msg；video_tasks/exports 无 status_reason，**禁止加列名**）
- 阈值：`lib/admin-thresholds.ts`
- 前端工具：壳层 `adminUi.*`（esc/fmt/fmtDate/fmtMs/emptyRow/setNotice/idemKey），新页面禁止手抄
- 组件类：壳层 `adm-*`（toolbar/field/btn/kpi/tab/empty/pager/note/blind-spot），页面内禁止再写同类控件样式

## 已退役（2026-06 瘦身，禁止悄悄复活）

- /admin/tasks /admin/users /admin/token-stats /admin/time-stats /admin/staff /admin/config /admin/key-pool /admin/storage /admin/knowledge/{audits,dry-run} 十个页面路由
- stats API 的 userUsage / recentUsers / paidAmounts / onlineUsers 死载荷（totalTokens 错误口径）
- RBAC 权限分级：admin 用户 >3 人时再议
