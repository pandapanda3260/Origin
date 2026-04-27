/**
 * 统一 mock 数据入口（仅供 app/api 内部使用）。
 *
 * 这个文件的存在意义：
 *   把所有"在哪里取假数据"的导入都收敛到这里，将来如果你想改成读真数据库 / 调真后端，
 *   只需要改这一个文件就够了，不用满项目去搜哪个 route.ts 引用了 mocks/。
 *
 * 当前实现：直接 re-export mocks/ 下的常量与函数。
 */

export {
  MOCK_USER,
  MOCK_TOKEN,
} from '@/mocks/user';

export {
  MOCK_BILLING_ME,
  MOCK_BILLING_PLANS,
  MOCK_BILLING_LEDGER,
  MOCK_TOPUP_PACKS,
} from '@/mocks/billing';

export {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
} from '@/mocks/projects';

export {
  MOCK_CLIENT_CONFIG,
  MOCK_MAINTENANCE_BANNER,
  MOCK_ADMIN_KEY_POOL,
} from '@/mocks/config';

export {
  MOCK_ADMIN_STATS,
  MOCK_ADMIN_LOGS,
} from '@/mocks/admin';

export {
  MOCK_LIBRARY_ITEMS,
  MOCK_WORLD_TEMPLATES,
  MOCK_BGM_LIBRARY,
  MOCK_MEDIA_LIBRARY,
} from '@/mocks/library';

export { MOCK_USER_SETTINGS } from '@/mocks/settings';
