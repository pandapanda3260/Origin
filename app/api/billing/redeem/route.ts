import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { grantCredits } from '@/lib/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 兑换码兑换：用户输入一个 code，立即入账积分。
 * 内置 3 个测试码（在 lib/db.ts seedDefaultRedeemCodes）：
 *   QDDEMO-1000 / QDDEMO-5000 / QDDEMO-10000
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const code: string = (body.code || '').toString().trim().toUpperCase();
  if (!code) return jsonError('请输入兑换码', 400);

  const db = getDb();
  const row = db.prepare<{ code: string }, any>('SELECT * FROM redeem_codes WHERE code = @code').get({ code });
  if (!row) return jsonError('兑换码无效', 404);
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return jsonError('兑换码已过期', 410);
  }
  if (row.used_count >= row.max_uses) {
    return jsonError('兑换码次数已用完', 410);
  }

  // 同一用户对同一码不能重复兑换
  const dup = db
    .prepare<{ uid: number; code: string }, any>(
      `SELECT id FROM credit_ledger WHERE user_id = @uid AND kind = 'redeem' AND ref_id = @code LIMIT 1`,
    )
    .get({ uid: user.id, code });
  if (dup) return jsonError('你已兑换过这个码', 409);

  const credits = Number(row.credits || 0);
  if (credits <= 0) return jsonError('兑换码无效（无积分）', 400);

  // 入账 + 落订单
  grantCredits({
    userId: user.id,
    amount: credits,
    kind: 'redeem',
    reason: `兑换码 ${code}`,
    refId: code,
    bucket: 'topup',
  });

  const orderId = randomUUID();
  db.prepare(
    `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
     VALUES (?, ?, 'topup', ?, 'redeem', 0, ?, 'paid', ?)`,
  ).run(orderId, user.id, row.plan_code || null, credits, JSON.stringify({ code }));

  // used_count++
  db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?').run(code);

  return jsonOk({
    ok: true,
    orderId,
    creditsAdded: credits,
    message: `兑换成功！+${credits} 积分`,
  });
}
