export const MOCK_ADMIN_STATS = {
  totalUsers: 12,
  totalProjects: 38,
  onlineCount: 1,
  paidUsers: 3,
  paidAmounts: [
    { amountCents: 297000, currency: 'CNY' },
  ],
  onlineUsers: [
    { userId: 1, username: 'pokerman', lastActive: new Date().toISOString() },
  ],
  userUsage: [
    {
      username: 'pokerman',
      totalCalls: 142,
      totalTokens: 88500,
      textCalls: 80,
      multimodalCalls: 10,
      imageCalls: 38,
      videoCalls: 14,
    },
  ],
  recentUsers: [
    { id: 12, username: 'pokerman', displayName: 'pokerman', createdAt: '2024-12-26T14:21:00Z' },
    { id: 11, username: 'demo_user', displayName: 'demo_user', createdAt: '2024-12-25T09:18:00Z' },
    { id: 10, username: 'creator_a', displayName: 'Creator A', createdAt: '2024-12-22T20:05:00Z' },
  ],
};

export const MOCK_ADMIN_LOGS = {
  file: 'mock-server.log',
  total: 4,
  lines: [
    `[INFO] ${new Date().toISOString()} mock backend started`,
    `[INFO] ${new Date().toISOString()} pokerman logged in`,
    `[INFO] ${new Date().toISOString()} GET /api/billing/me 200`,
    `[WARN] ${new Date().toISOString()} this is a sample warning entry`,
  ],
};
