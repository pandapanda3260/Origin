import { jsonError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST() {
  return jsonError(
    'sync-upstream 已下线：上游同步由写入侧依赖补丁和 sentinel guard 负责，请使用 compute-stale 或 detect-obsolete 查询状态。',
    410,
  );
}
