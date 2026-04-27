/**
 * 积分系统：余额查询 / 预扣 / 退还 / 入账 / 明细
 *
 * 计费表（单位：积分）：
 *   text       1 积分/请求      （剧本/资产抽取/镜头/EDL/Agent 等所有 LLM 文本）
 *   image      30 积分/张        （角色/场景/道具/分镜图）
 *   video      150 积分/段       （单段视频生成；时长 ≤6s 算一段）
 *   export     5 积分/次         （FFmpeg 导出成片）
 *
 * 这是一份示例计费，可以在这里集中调整。
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db';

export type CreditKind = 'text' | 'image' | 'video' | 'export' | 'topup' | 'redeem' | 'refund' | 'gift' | 'adjust';

export const CREDIT_PRICES: Record<'text' | 'image' | 'video' | 'export', number> = {
  text: 1,
  image: 30,
  video: 150,
  export: 5,
};

export class InsufficientCreditsError extends Error {
  status = 402;
  errorCode = 'INSUFFICIENT_CREDITS';
  required: number;
  balance: number;
  constructor(required: number, balance: number) {
    super(`积分不足：本次需 ${required} 积分，当前余额 ${balance} 积分`);
    this.required = required;
    this.balance = balance;
  }
}

export function getBalance(userId: number): {
  totalCredits: number;
  subscriptionCredits: number;
  topupCredits: number;
  bonusCredits: number;
  planCode: string;
  planStatus: string;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
} {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, any>('SELECT * FROM user_credits WHERE user_id = @uid')
    .get({ uid: userId });
  if (!row) {
    // 自动开户（兜底）
    db.prepare(
      `INSERT INTO user_credits (user_id, total_credits, subscription_credits, plan_code)
       VALUES (?, 100, 100, 'free') ON CONFLICT(user_id) DO NOTHING`,
    ).run(userId);
    return {
      totalCredits: 100,
      subscriptionCredits: 100,
      topupCredits: 0,
      bonusCredits: 0,
      planCode: 'free',
      planStatus: 'active',
      periodEnd: null,
      cancelAtPeriodEnd: false,
    };
  }
  return {
    totalCredits: row.total_credits || 0,
    subscriptionCredits: row.subscription_credits || 0,
    topupCredits: row.topup_credits || 0,
    bonusCredits: row.bonus_credits || 0,
    planCode: row.plan_code || 'free',
    planStatus: row.plan_status || 'active',
    periodEnd: row.period_end,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
  };
}

/**
 * 预扣积分。如果余额不足抛 InsufficientCreditsError。
 * 返回 ledger entry id（可用于失败时退还）。
 */
export function chargeCredits(opts: {
  userId: number;
  amount: number;
  kind: CreditKind;
  reason: string;
  refId?: string;
}): { ledgerId: string; balanceAfter: number } {
  if (opts.amount <= 0) throw new Error('amount 必须大于 0');
  const db = getDb();
  const cur = getBalance(opts.userId);
  if (cur.totalCredits < opts.amount) {
    throw new InsufficientCreditsError(opts.amount, cur.totalCredits);
  }

  // 扣减优先级：bonus > topup > subscription
  let remaining = opts.amount;
  let bonusUse = Math.min(remaining, cur.bonusCredits);
  remaining -= bonusUse;
  let topupUse = Math.min(remaining, cur.topupCredits);
  remaining -= topupUse;
  let subUse = Math.min(remaining, cur.subscriptionCredits);
  remaining -= subUse;
  if (remaining > 0) throw new InsufficientCreditsError(opts.amount, cur.totalCredits);

  const newBonus = cur.bonusCredits - bonusUse;
  const newTopup = cur.topupCredits - topupUse;
  const newSub = cur.subscriptionCredits - subUse;
  const newTotal = newBonus + newTopup + newSub;

  db.prepare(
    `UPDATE user_credits SET
      bonus_credits = ?, topup_credits = ?, subscription_credits = ?, total_credits = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  ).run(newBonus, newTopup, newSub, newTotal, opts.userId);

  const ledgerId = randomUUID();
  db.prepare(
    `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ledgerId, opts.userId, -opts.amount, opts.kind, opts.reason.slice(0, 200), opts.refId || null, newTotal);

  return { ledgerId, balanceAfter: newTotal };
}

/**
 * 退还（生成失败时调用）。amount 应是正数；这里会把它加回 bonus 桶。
 */
export function refundCredits(opts: {
  userId: number;
  amount: number;
  reason: string;
  refId?: string;
}) {
  if (opts.amount <= 0) return;
  const db = getDb();
  const cur = getBalance(opts.userId);
  const newBonus = cur.bonusCredits + opts.amount;
  const newTotal = cur.totalCredits + opts.amount;
  db.prepare(
    `UPDATE user_credits SET bonus_credits = ?, total_credits = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  ).run(newBonus, newTotal, opts.userId);

  db.prepare(
    `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
     VALUES (?, ?, ?, 'refund', ?, ?, ?)`,
  ).run(randomUUID(), opts.userId, opts.amount, opts.reason.slice(0, 200), opts.refId || null, newTotal);
}

/**
 * 入账（兑换码 / 充值 / 订阅生效）。
 */
export function grantCredits(opts: {
  userId: number;
  amount: number;
  kind: 'topup' | 'redeem' | 'gift' | 'adjust';
  reason: string;
  /** 走 subscription 还是 topup 桶 */
  bucket?: 'subscription' | 'topup' | 'bonus';
  refId?: string;
}) {
  if (opts.amount <= 0) return;
  const db = getDb();
  const cur = getBalance(opts.userId);
  const bucket = opts.bucket || (opts.kind === 'redeem' || opts.kind === 'topup' ? 'topup' : 'bonus');

  let newSub = cur.subscriptionCredits;
  let newTop = cur.topupCredits;
  let newBon = cur.bonusCredits;
  if (bucket === 'subscription') newSub += opts.amount;
  else if (bucket === 'topup') newTop += opts.amount;
  else newBon += opts.amount;
  const newTotal = newSub + newTop + newBon;

  db.prepare(
    `UPDATE user_credits SET
      subscription_credits = ?, topup_credits = ?, bonus_credits = ?, total_credits = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`,
  ).run(newSub, newTop, newBon, newTotal, opts.userId);

  db.prepare(
    `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), opts.userId, opts.amount, opts.kind, opts.reason.slice(0, 200), opts.refId || null, newTotal);
}

/**
 * 取明细（最近 N 条）。
 */
export function listLedger(userId: number, limit = 50, offset = 0) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number; lim: number; off: number }, any>(
      `SELECT * FROM credit_ledger WHERE user_id = @uid
       ORDER BY created_at DESC LIMIT @lim OFFSET @off`,
    )
    .all({ uid: userId, lim: limit, off: offset });
  return rows.map((r: any) => ({
    id: r.id,
    amount: r.amount,
    kind: r.kind,
    reason: r.reason,
    refId: r.ref_id,
    balanceAfter: r.balance_after,
    createdAt: r.created_at,
  }));
}
