import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  if (!user.is_admin) return jsonError('forbidden', 403);

  const db = getDb();
  const totalUsers = (db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM users').get() || { c: 0 }).c;
  const totalProjects = (db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM projects').get() || { c: 0 }).c;

  // 在线 = 最近 5 分钟内 user_credits.updated_at 变化过的（最简近似）
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const onlineRows = db
    .prepare<{ since: string }, any>(
      `SELECT u.id AS userId, u.username, COALESCE(c.updated_at, u.updated_at) AS lastActive
       FROM users u
       LEFT JOIN user_credits c ON c.user_id = u.id
       WHERE COALESCE(c.updated_at, u.updated_at) > @since
       ORDER BY lastActive DESC`,
    )
    .all({ since: fiveMinAgo });

  // 付费 = 有付款订单（status=paid 且 amount > 0）
  const paidUsersRow = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(DISTINCT user_id) AS c FROM billing_orders WHERE status='paid' AND amount_cents > 0`,
    )
    .get();
  const paidUsers = paidUsersRow?.c || 0;

  // 已入账金额（按 currency 分组）
  const paidAmounts = db
    .prepare<[], { currency: string; total: number }>(
      `SELECT currency, SUM(amount_cents) AS total FROM billing_orders WHERE status='paid' GROUP BY currency`,
    )
    .all()
    .map((r: any) => ({ amountCents: r.total || 0, currency: r.currency || 'CNY' }));

  // 用量统计：从 credit_ledger 按用户聚合
  const usage = db
    .prepare<[], any>(
      `SELECT
         u.username,
         COUNT(l.id) AS totalCalls,
         SUM(CASE WHEN l.amount < 0 THEN -l.amount ELSE 0 END) AS totalTokens,
         SUM(CASE WHEN l.kind = 'text' THEN 1 ELSE 0 END) AS textCalls,
         0 AS multimodalCalls,
         SUM(CASE WHEN l.kind = 'image' THEN 1 ELSE 0 END) AS imageCalls,
         SUM(CASE WHEN l.kind = 'video' THEN 1 ELSE 0 END) AS videoCalls
       FROM users u
       LEFT JOIN credit_ledger l ON l.user_id = u.id
       GROUP BY u.id, u.username
       HAVING totalCalls > 0
       ORDER BY totalCalls DESC
       LIMIT 100`,
    )
    .all();

  // 最近注册
  const recentUsers = db
    .prepare<[], any>(
      `SELECT id, username, display_name AS displayName, created_at AS createdAt FROM users
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all();

  return jsonOk({
    totalUsers,
    totalProjects,
    onlineCount: onlineRows.length,
    onlineUsers: onlineRows,
    paidUsers,
    paidAmounts,
    userUsage: usage.map((u: any) => ({
      username: u.username,
      totalCalls: u.totalCalls || 0,
      totalTokens: u.totalTokens || 0,
      textCalls: u.textCalls || 0,
      multimodalCalls: u.multimodalCalls || 0,
      imageCalls: u.imageCalls || 0,
      videoCalls: u.videoCalls || 0,
    })),
    recentUsers,
  });
}
