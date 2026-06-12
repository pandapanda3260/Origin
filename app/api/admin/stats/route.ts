import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }

  const db = getDb();
  const visibleUserWhere = "username NOT LIKE '__shadow__%'";
  const totalUsers = (db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM users WHERE ${visibleUserWhere}`).get() || { c: 0 }).c;
  const totalProjects = (db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM projects').get() || { c: 0 }).c;

  // 口径登记：见 docs/admin-metrics-registry.md。
  // 此 API 只返回首页 4 个 KPI 实际消费的字段；历史上的 userUsage/recentUsers/paidAmounts/onlineUsers
  // 死载荷已删除（其中 totalTokens 实为积分口径，属错误标签，禁止恢复）。
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const onlineCount = (db
    .prepare<{ since: string }, { c: number }>(
      `SELECT COUNT(*) AS c
       FROM users u
       JOIN user_activity a ON a.user_id = u.id
       WHERE a.last_seen_at > @since
         AND u.username NOT LIKE '__shadow__%'`,
    )
    .get({ since: fiveMinAgo }) || { c: 0 }).c;

  const paidUsers = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(DISTINCT user_id) AS c
         FROM billing_orders
        WHERE status IN ('paid', 'applied')
          AND amount_cents > 0`,
    )
    .get()?.c || 0;

  return jsonOk({
    totalUsers,
    totalProjects,
    onlineCount,
    paidUsers,
  });
}
