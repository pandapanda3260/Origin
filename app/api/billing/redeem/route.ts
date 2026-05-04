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
 *
 * 并发安全：redeem_codes 的 used_count 用条件 UPDATE（used_count < max_uses）在事务中
 * 完成，避免两个并发请求都读到旧的 used_count 然后双增。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const code: string = (body.code || '').toString().trim().toUpperCase();
  if (!code) return jsonError('请输入兑换码', 400);
  if (code.length > 64) return jsonError('兑换码格式无效', 400);

  const db = getDb();

  // 预读（仅做 404/410 的快速反馈；真正的原子检查在下面的事务里）
  const preRow = db
    .prepare<{ code: string }, any>('SELECT * FROM redeem_codes WHERE code = @code')
    .get({ code });
  if (!preRow) return jsonError('兑换码无效', 404);
  if (preRow.expires_at && new Date(preRow.expires_at) < new Date()) {
    return jsonError('兑换码已过期', 410);
  }
  const credits = Number(preRow.credits || 0);
  if (!Number.isInteger(credits) || credits <= 0) {
    return jsonError('兑换码无效（无积分）', 400);
  }

  const orderId = randomUUID();
  let consumed = false;
  let duplicate = false;
  let expired = false;

  const txn = db.transaction(() => {
    // 同一用户同一码：ledger 唯一
    const dup = db
      .prepare<{ uid: number; code: string }, any>(
        `SELECT id FROM credit_ledger WHERE user_id = @uid AND kind = 'redeem' AND ref_id = @code LIMIT 1`,
      )
      .get({ uid: user.id, code });
    if (dup) {
      duplicate = true;
      return;
    }

    // 原子递增 used_count，且只在 used_count < max_uses 时才生效
    const info = db
      .prepare(
        `UPDATE redeem_codes SET used_count = used_count + 1
         WHERE code = ? AND used_count < max_uses
           AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(code);
    if (info.changes !== 1) {
      // 要么用完了要么过期了——细分一下错误
      const fresh = db
        .prepare<{ code: string }, any>('SELECT used_count, max_uses, expires_at FROM redeem_codes WHERE code = @code')
        .get({ code });
      if (fresh && fresh.expires_at && new Date(fresh.expires_at) < new Date()) {
        expired = true;
      } else {
        consumed = true;
      }
      return;
    }

    grantCredits({
      userId: user.id,
      amount: credits,
      kind: 'redeem',
      reason: `兑换码 ${code}`,
      refId: code,
      bucket: 'topup',
    });

    db.prepare(
      `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
       VALUES (?, ?, 'topup', ?, 'redeem', 0, ?, 'paid', ?)`,
    ).run(orderId, user.id, preRow.plan_code || null, credits, JSON.stringify({ code }));
  });
  txn.immediate();

  if (duplicate) return jsonError('你已兑换过这个码', 409);
  if (expired) return jsonError('兑换码已过期', 410);
  if (consumed) return jsonError('兑换码次数已用完', 410);

  return jsonOk({
    ok: true,
    orderId,
    creditsAdded: credits,
    message: `兑换成功！+${credits} 积分`,
  });
}
