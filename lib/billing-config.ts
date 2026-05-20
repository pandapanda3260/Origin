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
    limits: { concurrency: 1, projects: 5, storageGB: 1 },
    features: { models: ['基础模型'], priority: 'normal', support: '社区' },
  },
  {
    code: 'pro',
    title: 'Pro',
    description: '专业创作者',
    price_cents: 9900,
    billing_cycle: 'month',
    monthly_credits: 2000,
    limits: { concurrency: 4, projects: 50, storageGB: 50 },
    features: { models: ['全部模型'], priority: 'fast', support: '邮件' },
  },
  {
    code: 'studio',
    title: 'Studio',
    description: '工作室与团队',
    price_cents: 29900,
    billing_cycle: 'month',
    monthly_credits: 8000,
    limits: { concurrency: 10, projects: 500, storageGB: 500 },
    features: { models: ['全部模型 + 4K'], priority: 'priority', support: '专属客服' },
  },
];

export const TOPUP_PACKS = [
  { code: 'topup_500', title: '500 积分包', credits: 500, price_cents: 1900 },
  { code: 'topup_2000', title: '2000 积分包', credits: 2000, price_cents: 6900 },
  { code: 'topup_10000', title: '10000 积分包', credits: 10000, price_cents: 29900 },
];

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
