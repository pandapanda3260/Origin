export const MOCK_CLIENT_CONFIG = {
  features: {
    enableEdit: true,
    enableEpisodes: true,
    enableAdmin: true,
    enableBilling: true,
    enableMaintenance: false,
    projectActivationGuard: true,
    scriptConsultGuard: true,
  },
  ui: {
    bannerEnabled: true,
    creditWarningThreshold: 10,
  },
  limits: {
    maxProjects: 100,
    maxConcurrentVideoTasks: 4,
    maxAssetCount: 200,
  },
  models: {
    image: ['nano-banana', 'jimeng-image', 'doubao-seedream', 'sd-3.5'],
    video: ['Seedance', 'Seedance Fast', '可灵'],
    text: ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'deepseek-v3'],
  },
};

export const MOCK_MAINTENANCE_BANNER = {
  enabled: false,
  message: '',
  startsAt: null,
  endsAt: null,
};

export const MOCK_ADMIN_KEY_POOL = {
  pools: [
    { name: 'image', total: 6, healthy: 6, exhausted: 0, lastUsed: null },
    { name: 'video', total: 3, healthy: 3, exhausted: 0, lastUsed: null },
    { name: 'text', total: 4, healthy: 4, exhausted: 0, lastUsed: null },
  ],
  updatedAt: new Date().toISOString(),
};
