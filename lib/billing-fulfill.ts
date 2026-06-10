/**
 * 统一到账（fulfill）：订单从"已支付"到"权益生效"的唯一入口。
 *
 * 当前由模拟支付（BILLING_DEV_AUTOPAY，方向B，2026-06-10 拍板）在 /api/billing/checkout
 * 内同步调用；真支付网关接入后，支付回调验签成功调同一个函数——到账规则不变，
 * 只换触发器（docs/billing-pricing-and-card-display-plan.md §3）。
 *
 * 规则：
 *   - topup 订单 → 积分进 topup 桶（永久积分，立即生效，不过期）；
 *   - subscription 订单 → activatePlanSubscription：plan_code 升档 + 订阅桶覆盖重置
 *     为 monthly_credits + period_end = +1 月（"每月重置"语义）；
 *   - 幂等：订单行 pending→applied 条件 UPDATE 原子占有，重复调用返回 alreadyApplied，
 *     绝不双发积分；占有与入账同事务，入账抛错则占有一并回滚。
 */
import { getDb } from './db';
import { getPlan, getTopupPack } from './billing-config';
import { grantCredits, activatePlanSubscription } from './credits';

export class FulfillError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function fulfillPaidOrder(opts: {
  userId: number;
  orderId: string;
  /** 流水 reason 前缀里的支付方式标识，如 '模拟支付' */
  via: string;
}): { alreadyApplied: boolean; creditsAdded: number; kind: 'topup' | 'subscription'; periodEnd?: string } {
  const db = getDb();
  const txn = db.transaction(() => {
    const row = db
      .prepare<{ id: string; uid: number }, any>(
        'SELECT * FROM billing_orders WHERE id = @id AND user_id = @uid',
      )
      .get({ id: opts.orderId, uid: opts.userId });
    if (!row) throw new FulfillError('订单不存在', 404);
    if (row.status === 'applied') {
      return {
        alreadyApplied: true,
        creditsAdded: Number(row.credits_added || 0),
        kind: row.kind as 'topup' | 'subscription',
      };
    }
    // 原子占有：仅 pending 可被到账；并发第二个请求在这里 409。
    const claim = db
      .prepare(
        `UPDATE billing_orders SET status = 'applied',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
      )
      .run(opts.orderId, opts.userId);
    if (claim.changes !== 1) throw new FulfillError('订单状态冲突，请刷新后重试', 409);

    const code = String(row.plan_code || '');
    if (row.kind === 'topup') {
      const pack = getTopupPack(code);
      const credits = Number(row.credits_added || pack?.credits || 0);
      if (!Number.isInteger(credits) || credits <= 0) throw new FulfillError('订单积分数无效', 400);
      grantCredits({
        userId: opts.userId,
        amount: credits,
        kind: 'topup',
        bucket: 'topup',
        refId: opts.orderId,
        reason: `[${opts.via}] 购买 ${pack?.title || code}（永久积分）`,
      });
      return { alreadyApplied: false, creditsAdded: credits, kind: 'topup' as const };
    }
    if (row.kind === 'subscription') {
      const plan = getPlan(code);
      if (!plan || !Number(plan.price_cents)) throw new FulfillError('未知订阅档位：' + code, 400);
      const r = activatePlanSubscription(opts.userId, code, {
        reasonPrefix: `[${opts.via}] `,
        refId: opts.orderId,
      });
      return {
        alreadyApplied: false,
        creditsAdded: r.creditsSet,
        kind: 'subscription' as const,
        periodEnd: r.periodEnd,
      };
    }
    throw new FulfillError('未知订单类型：' + String(row.kind), 400);
  });
  return txn.immediate();
}
