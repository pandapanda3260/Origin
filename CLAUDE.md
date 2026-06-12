# Origin Agent Notes

Before changing model calls, reasoning effort, providers, endpoints, API keys, image quality, video settings, or related routing, read:

- [Model Configuration Governance](docs/model-config-governance.md)

Model-call parameters should be controlled through `.env.local`, the external env file, and `lib/model-routing.ts`; business routes should generally choose a `modelRole` instead of hardcoding tunable settings.

## 管理后台纪律（2026-06 瘦身定版）

改 `app/admin` / `app/api/admin` 前先读 [后台指标口径登记表](docs/admin-metrics-registry.md)，三条硬规则：

1. 页面（route.ts 的 HTML/JS）禁止出现业务口径：不许在前端 JS 里 sum/filter 出新指标，所有数字由 API 给成品值；
2. 一个指标只许一条计算路径，新指标先登记再上页面；任务 reason 字段一律走 `lib/admin-task-sql.ts`，前端工具一律走壳层 `adminUi.*` 与 `adm-*` 组件类；
3. 有盲区的统计必须页头声明（文案由 API notes 单源下发，不在页面写死）。

后台结构为 7 页（问题队列/客服检索/财务积分/用量统计/系统与安全/内容审核/知识库），新增导航页需先过方案审批。改完跑 `npm run test:admin-metrics`。
