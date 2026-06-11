/**
 * 套餐 / 积分包静态配置（集中维护）
 *
 * 修改这里 → 前端 billing modal 自动反映新方案。
 * monthly_credits 是订阅按月发放的积分；topup credits 是单次买的"次数包"。
 */

export const PLANS = [
  {
    code: 'free',
    title: 'Free',
    description: '体验基础功能',
    price_cents: 0,
    billing_cycle: 'month',
    monthly_credits: 100,
    // projects = 任务数上限，后端 POST /api/projects 权威拦截 + /api/config/client 按档下发
    //（docs/series-episode-continue-plan.md §6.5，2026-06-10 拍板 Free100/Plus1000/Pro5000）
    limits: { concurrency: 1, projects: 100, storageGB: 1 },
    features: { models: ['基础模型'], priority: 'normal', support: '社区' },
  },
  {
    code: 'plus',
    title: 'Plus',
    description: '专业创作者',
    price_cents: 159900,
    billing_cycle: 'month',
    monthly_credits: 80000,
    limits: { concurrency: 4, projects: 1000, storageGB: 50 },
    features: { models: ['全部模型'], priority: 'fast', support: '邮件' },
  },
  {
    code: 'pro',
    title: 'Pro',
    description: '工作室与团队',
    price_cents: 799900,
    billing_cycle: 'month',
    monthly_credits: 400000,
    limits: { concurrency: 10, projects: 5000, storageGB: 500 },
    features: { models: ['全部模型 + 4K'], priority: 'priority', support: '专属客服' },
  },
];

// 积分包（永久积分，进 topup 桶不过期）。2026-06-10 新定价拍板，旧 topup_500/2000/10000 直接删不留兼容。
export const TOPUP_PACKS = [
  { code: 'topup_basic', title: '基础积分包', credits: 40000, price_cents: 100000 },
  { code: 'topup_advanced', title: '进阶积分包', credits: 120000, price_cents: 300000 },
  { code: 'topup_enterprise', title: '企业积分包', credits: 2000000, price_cents: 4000000 },
];

/**
 * 模拟支付开关（2026-06-10 Vasily 拍板方向 B）：
 * 开启时 /api/billing/checkout 视为支付成功，立即统一到账（lib/billing-fulfill.ts），
 * 订阅续费也按"自动扣款成功"惰性重置（lib/credits.ts renewDueSubscription）。
 * 规则：默认关闭；BILLING_DEV_AUTOPAY=1 仅允许非生产环境临时打开。
 * 红线：生产环境硬关闭，即使误设 BILLING_DEV_AUTOPAY=1 也不能免费送积分。
 */
export function isDevAutopayEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const flag = String(process.env.BILLING_DEV_AUTOPAY || '').trim();
  return flag === '1';
}

export const ADMIN_MANUAL_ADJUST_LIMITS = {
  secondConfirmAbove: 10_000,
  absoluteBlockAbove: 100_000,
  dailyAdminAbsCap: 50_000,
};

export function getPlan(code: string) {
  return PLANS.find((p) => p.code === code);
}
export function getTopupPack(code: string) {
  return TOPUP_PACKS.find((p) => p.code === code);
}
