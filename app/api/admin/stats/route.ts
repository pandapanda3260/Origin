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

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const onlineRows = db
    .prepare<{ since: string }, any>(
      `SELECT u.id AS userId, u.username, a.last_seen_at AS lastActive
       FROM users u
       JOIN user_activity a ON a.user_id = u.id
       WHERE a.last_seen_at > @since
         AND u.username NOT LIKE '__shadow__%'
       ORDER BY lastActive DESC`,
    )
    .all({ since: fiveMinAgo });

  const paidUsers = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(DISTINCT user_id) AS c FROM billing_orders WHERE status='paid' AND amount_cents > 0`,
    )
    .get()?.c || 0;

  const paidAmounts = db
    .prepare<[], { currency: string; total: number }>(
      `SELECT currency, SUM(amount_cents) AS total FROM billing_orders WHERE status='paid' GROUP BY currency`,
    )
    .all()
    .map((r: any) => ({ amountCents: r.total || 0, currency: r.currency || 'CNY' }));

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
       WHERE u.username NOT LIKE '__shadow__%'
       GROUP BY u.id, u.username
       HAVING totalCalls > 0
       ORDER BY totalCalls DESC
       LIMIT 100`,
    )
    .all();

  const recentUsers = db
    .prepare<[], any>(
      `SELECT id, username, display_name AS displayName, created_at AS createdAt FROM users
       WHERE username NOT LIKE '__shadow__%'
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
