import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>('SELECT plan_code, period_end FROM user_credits WHERE user_id = @uid')
    .get({ uid: user.id });
  // 免费档没有可取消的订阅。
  if (!row || !row.plan_code || row.plan_code === 'free') {
    return jsonError('免费套餐无需取消订阅', 400);
  }
  // 取消即落定截止日期（对齐 Stripe cancel_at：立即解析成确定时间戳，避免"到期日"无依据，
  // 也让到期降级 settleExpiredSubscription 有 period_end 可比）。已有未来到期日则沿用。
  db.prepare(
    `UPDATE user_credits SET
       cancel_at_period_end = 1,
       period_end = COALESCE(period_end, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 month')),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  ).run(user.id);
  return jsonOk({ ok: true, message: '已设置：本周期到期后停止续订' });
}
