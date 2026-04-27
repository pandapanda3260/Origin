export const MOCK_BILLING_PLANS_LIST = [
  {
    code: 'free',
    title: 'Free',
    description: '体验基础功能',
    price_cents: 0,
    billing_cycle: 'month',
    monthly_credits: 100,
    limits: { concurrency: 1, projects: 5, storageGB: 1 },
    features: { models: ['基础模型'], priority: 'normal', support: '社区' },
    isCurrent: true,
    isPopular: false,
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
    isCurrent: false,
    isPopular: true,
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
    isCurrent: false,
    isPopular: false,
  },
];

export const MOCK_TOPUP_PACKS = [
  { code: 'topup_500', title: '500 积分包', credits: 500, price_cents: 1900 },
  { code: 'topup_2000', title: '2000 积分包', credits: 2000, price_cents: 6900 },
  { code: 'topup_10000', title: '10000 积分包', credits: 10000, price_cents: 29900 },
];

export const MOCK_BILLING_ME = {
  user: { id: 1, username: 'pokerman', displayName: 'pokerman' },
  currentPlan: {
    code: 'free',
    title: 'Free',
    monthly_credits: 100,
    expiresAt: null,
    autoRenew: false,
    status: 'active',
  },
  subscription: {
    plan_code: 'free',
    status: 'active',
    current_period_end: null,
    cancel_at_period_end: false,
  },
  balances: {
    totalCredits: 58,
    subscriptionCredits: 42,
    topupCredits: 16,
    bonusCredits: 0,
    expiresAt: null,
  },
  plans: MOCK_BILLING_PLANS_LIST,
  topupPacks: MOCK_TOPUP_PACKS,
  ledger: [],
  orders: [],
};

export const MOCK_BILLING_PLANS = MOCK_BILLING_PLANS_LIST;

export const MOCK_BILLING_LEDGER = {
  items: [],
  total: 0,
};
