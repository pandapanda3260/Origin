import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getPlan, getTopupPack } from '@/lib/billing-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 创建订单。返回 orderId + 支付 URL。
 *
 * 三种 provider：
 *   - 'redeem'  → 直接走 /api/billing/redeem 兑换码（不在这里处理）
 *   - 'stripe'  → 创建 Stripe Checkout Session（需要 STRIPE_SECRET_KEY 环境变量）
 *   - 'wechat' / 'alipay' → 暂未实现，返回提示
 *
 * 不传 provider 时默认 stripe。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const provider: string = (body.provider || 'stripe').toString();
  const planCode: string | undefined = body.planCode;
  const packCode: string | undefined = body.packCode;
  const kind: 'subscription' | 'topup' = packCode ? 'topup' : 'subscription';

  let amountCents = 0;
  let credits = 0;
  let title = '';
  if (planCode) {
    const plan = getPlan(planCode);
    if (!plan) return jsonError('未知 plan', 400);
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

  if (provider === 'stripe') {
    // ---- Stripe Checkout（脚手架）----
    // 需要环境变量 STRIPE_SECRET_KEY 和 STRIPE_PRICE_<planCode>。
    // 当前未启用：直接返回"暂未对接，建议用兑换码"
    db.prepare(
      `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
       VALUES (?, ?, ?, ?, 'stripe', ?, ?, 'pending', ?)`,
    ).run(orderId, user.id, kind, planCode || packCode || null, amountCents, credits, JSON.stringify({ title }));
    return jsonOk({
      orderId,
      payUrl: 'about:blank',
      qrCode: '',
      message: '[占位] Stripe 未配置 STRIPE_SECRET_KEY；先用兑换码 QDDEMO-1000 / QDDEMO-5000 / QDDEMO-10000 测试',
    });
  }

  if (provider === 'wechat' || provider === 'alipay') {
    db.prepare(
      `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(orderId, user.id, kind, planCode || packCode || null, provider, amountCents, credits, JSON.stringify({ title }));
    return jsonOk({
      orderId,
      payUrl: 'about:blank',
      qrCode: '',
      message: `[占位] ${provider === 'wechat' ? '微信' : '支付宝'}支付未实现（需要商户号 + 备案）`,
    });
  }

  return jsonError('未知 provider', 400);
}
