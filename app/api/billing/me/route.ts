import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getBalance, listLedger } from '@/lib/credits';
import { PLANS, TOPUP_PACKS, getPlan } from '@/lib/billing-config';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const bal = getBalance(user.id);
  const plan = getPlan(bal.planCode) || PLANS[0];

  // 标记当前套餐
  const plansWithCurrent = PLANS.map((p) => ({ ...p, isCurrent: p.code === bal.planCode }));

  // 最近订单（最多 5 条）
  const db = getDb();
  const orders = db
    .prepare<{ uid: number }, any>(
      `SELECT id, kind, plan_code, provider, amount_cents, currency, credits_added, status, created_at
       FROM billing_orders WHERE user_id = @uid ORDER BY created_at DESC LIMIT 5`,
    )
    .all({ uid: user.id });

  return jsonOk({
    user: { id: user.id, username: user.username, displayName: user.display_name },
    currentPlan: {
      code: plan.code,
      title: plan.title,
      monthly_credits: plan.monthly_credits,
      expiresAt: bal.periodEnd,
      autoRenew: !bal.cancelAtPeriodEnd,
      status: bal.planStatus,
    },
    subscription: {
      plan_code: bal.planCode,
      status: bal.planStatus,
      current_period_end: bal.periodEnd,
      cancel_at_period_end: bal.cancelAtPeriodEnd,
    },
    balances: {
      totalCredits: bal.totalCredits,
      subscriptionCredits: bal.subscriptionCredits,
      topupCredits: bal.topupCredits,
      bonusCredits: bal.bonusCredits,
      expiresAt: bal.periodEnd,
    },
    plans: plansWithCurrent,
    topupPacks: TOPUP_PACKS,
    ledger: listLedger(user.id, 10).map(simplifyLedger),
    orders: orders.map((o: any) => ({
      id: o.id,
      kind: o.kind,
      planCode: o.plan_code,
      provider: o.provider,
      amountCents: o.amount_cents,
      currency: o.currency,
      creditsAdded: o.credits_added,
      status: o.status,
      createdAt: o.created_at,
    })),
  });
}

function simplifyLedger(l: any) {
  return { id: l.id, amount: l.amount, kind: l.kind, reason: l.reason, balanceAfter: l.balanceAfter, createdAt: l.createdAt };
}
