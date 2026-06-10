import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getPlan, getTopupPack, isDevAutopayEnabled } from '@/lib/billing-config';
import { fulfillPaidOrder, FulfillError } from '@/lib/billing-fulfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 创建订单。
 *
 * 模拟支付（BILLING_DEV_AUTOPAY，方向B 2026-06-10 拍板）开启时：建单后立即视为
 * 支付成功，同步走 lib/billing-fulfill.ts 统一到账（积分包→topup 桶；订阅→升档+
 * 订阅桶重置），返回 status='applied'，前端直接刷新余额，不跳支付页。
 *
 * 关闭时（生产默认）：保留 pending 订单 + 占位提示。真支付网关接入后，
 * 这里改为返回真实支付地址，fulfill 挪到回调里调用。
 *
 * provider：'stripe' | 'wechat' | 'alipay'（不传默认 stripe；兑换码走 /api/billing/redeem 不经这里）。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const provider: string = (body.provider || 'stripe').toString();
  if (provider !== 'stripe' && provider !== 'wechat' && provider !== 'alipay') {
    return jsonError('未知 provider', 400);
  }
  const planCode: string | undefined = body.planCode;
  const packCode: string | undefined = body.packCode;
  const kind: 'subscription' | 'topup' = packCode ? 'topup' : 'subscription';

  let amountCents = 0;
  let credits = 0;
  let title = '';
  if (planCode) {
    const plan = getPlan(planCode);
    if (!plan) return jsonError('未知 plan', 400);
    if (!Number(plan.price_cents)) return jsonError('免费档无需订阅', 400);
    amountCents = plan.price_cents;
    credits = plan.monthly_credits;
    title = `订阅 ${plan.title}`;
  } else if (packCode) {
    const pack = getTopupPack(packCode);
    if (!pack) return jsonError('未知 pack', 400);
    amountCents = pack.price_cents;
    credits = pack.credits;
    title = `购买 ${pack.title}`;
  } else {
    return jsonError('需提供 planCode 或 packCode', 400);
  }

  const orderId = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(orderId, user.id, kind, planCode || packCode || null, provider, amountCents, credits, JSON.stringify({ title }));

  if (isDevAutopayEnabled()) {
    try {
      const r = fulfillPaidOrder({ userId: user.id, orderId, via: '模拟支付' });
      return jsonOk({
        orderId,
        status: 'applied',
        creditsAdded: r.creditsAdded,
        message:
          kind === 'subscription'
            ? `[模拟支付] ${title} 已生效，订阅积分已重置为 ${r.creditsAdded}`
            : `[模拟支付] ${title} 已到账 ${r.creditsAdded} 积分（永久）`,
      });
    } catch (e: any) {
      const status = e instanceof FulfillError ? e.status : 500;
      return jsonError(e?.message || '模拟支付到账失败', status);
    }
  }

  // 占位分支（生产默认）：支付通道未接，订单保持 pending。不再向用户展示测试兑换码。
  return jsonOk({
    orderId,
    payUrl: 'about:blank',
    qrCode: '',
    message: '支付通道维护中，暂未开通在线支付；可在下方使用兑换码到账。',
  });
}
