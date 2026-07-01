export const MOCK_BILLING_PLANS_LIST = [
  {
    code: 'free',
    title: 'Free',
    description: '体验基础功能',
    price_cents: 0,
    billing_cycle: 'month',
    monthly_credits: 100,
    limits: { concurrency: 1, projects: 100, storageGB: 1 },
    features: { models: ['基础模型'], priority: 'normal', support: '社区' },
    isCurrent: true,
    isPopular: false,
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
    isCurrent: false,
    isPopular: true,
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
    isCurrent: false,
    isPopular: false,
  },
];

export const MOCK_TOPUP_PACKS = [
  { code: 'topup_basic', title: '基础积分包', credits: 4000, price_cents: 10000 },
  { code: 'topup_advanced', title: '进阶积分包', credits: 120000, price_cents: 300000 },
  { code: 'topup_enterprise', title: '企业积分包', credits: 2000000, price_cents: 4000000 },
];

export const MOCK_BILLING_ME = {
  user: { id: 1, username: 'mock_user', phone: '19900000000', displayName: 'Mock User' },
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
